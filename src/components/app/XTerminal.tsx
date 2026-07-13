import { useEffect, useRef, useLayoutEffect, useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import {
  closeSession,
  createSession,
  onConnectionStatus,
  onSessionExited,
  onSessionOutput,
  resizeSession,
  runSnippetScript,
  writeToSession,
} from "@/lib/api/terminal";
import { subscribe, type UnlistenFn } from "@/lib/api/transport";
import { listSnippets } from "@/lib/api/snippets";
import { listHosts } from "@/lib/api/hosts";
import { onSnippetsChanged } from "@/lib/snippets-events";
import { matchesOsTarget } from "@/features/snippets/osTargets";
import {
  ensureTerminalFontLoaded,
  getTerminalFontStack,
  loadTerminalAppearance,
  terminalAppearanceChangedEvent,
  terminalAppearanceStorageKey,
  type TerminalAppearance,
} from "@/lib/terminal-appearance";
import {
  appThemeChangedEvent,
  appThemeStorageKey,
  loadAppTheme,
  type AppTheme,
} from "@/lib/app-theme";
import {
  formatShortcut,
  isShortcutMatch,
  loadShortcuts,
  shortcutsChangedEvent,
  shortcutsStorageKey,
  type ShortcutBinding,
  type ShortcutMap,
} from "@/lib/shortcuts";
import { platform } from "@/lib/platform";
import * as ContextMenu from "@radix-ui/react-context-menu";
import type { OsKind, Snippet, SnippetGroup } from "@/components/app/types";
import { Search } from "lucide-react";

interface Props {
  sessionId?: string;
  initialCommand?: string;
  cwd?: string;
  hostId?: string;
  readyMarker?: string;
  connectionLabel?: string;
  connectionTitle?: string;
  isActive?: boolean;
  onClose?: () => void;
  onSessionCreated?: (sessionId: string) => void;
  /**
   * Quick Terminal glass mode: xterm paints its own opaque background canvas,
   * which would cover the translucent panel — this swaps it for a fully
   * transparent one so the panel's (blurred) backdrop shows through.
   */
  transparentBackground?: boolean;
}

type ConnectionStage = "connecting" | "handshaking" | "authenticating" | "shell";
type ConnectionStatus = "active" | "done" | "failed";

interface ConnectionStatusPayload {
  stage: ConnectionStage;
  status: ConnectionStatus;
  message: string;
  log?: string | null;
}

const connectionSteps: Array<{ key: ConnectionStage; label: string; icon: string }> = [
  { key: "connecting", label: "Connecting", icon: "↗" },
  { key: "handshaking", label: "Handshaking", icon: "👋" },
  { key: "authenticating", label: "Authenticating", icon: "🔐" },
  { key: "shell", label: "Opening shell", icon: ">_" },
];

const initialConnectionStatus: ConnectionStatusPayload = {
  stage: "connecting",
  status: "active",
  message: "Opening TCP connection to SSH server...",
};

// Reconnect after an unexpected host disconnect: 3 attempts with increasing
// backoff, then give up and wait for the user to reconnect manually.
const RECONNECT_DELAYS_SEC = [2, 4, 8];
const MAX_RECONNECT_ATTEMPTS = RECONNECT_DELAYS_SEC.length;

interface ReconnectState {
  phase: "waiting" | "connecting" | "failed";
  attempt: number;
  countdown: number;
}

const menuItemCls =
  "flex cursor-pointer select-none items-center gap-2 rounded px-2.5 py-1.5 text-xs text-foreground outline-none data-[highlighted]:bg-[var(--color-surface-2)] data-[disabled]:pointer-events-none data-[disabled]:opacity-40";

function MenuShortcut({ binding }: { binding?: ShortcutBinding }) {
  if (!binding) return null;
  return <span className="text-[10px] text-muted-foreground">{formatShortcut(binding)}</span>;
}

function EnumDropdown({
  options,
  value,
  onChange,
  onConfirm,
  autoFocus,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
  onConfirm: (selectedValue: string) => void;
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = options.filter((o) =>
    o.toLowerCase().includes(query.toLowerCase())
  );

  useEffect(() => {
    if (autoFocus) searchRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  useEffect(() => {
    const el = listRef.current?.children[activeIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  const confirm = (opt: string) => {
    onChange(opt);
    setQuery("");
    onConfirm(opt);
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5 rounded-md border border-border bg-[var(--color-surface)] px-2">
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, filtered.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)); }
            else if (e.key === "Enter" && filtered[activeIdx]) { e.preventDefault(); confirm(filtered[activeIdx]); }
          }}
          placeholder="Search…"
          className="h-7 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
        />
        {value && <span className="shrink-0 rounded bg-[var(--color-surface-2)] px-1.5 py-0.5 text-xs text-foreground">{value}</span>}
      </div>
      <div ref={listRef} className="max-h-36 overflow-y-auto rounded-md border border-border bg-[var(--color-surface)]">
        {filtered.length === 0 ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">No options</div>
        ) : filtered.map((opt, i) => (
          <button
            key={opt}
            type="button"
            onClick={() => confirm(opt)}
            className={[
              "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition",
              i === activeIdx ? "bg-[var(--color-surface-2)] text-foreground" : "text-foreground hover:bg-[var(--color-surface-2)]/60",
              opt === value ? "font-medium" : "",
            ].join(" ")}
          >
            {opt === value && <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-brand-orange)]" />}
            {opt !== value && <span className="h-1.5 w-1.5" />}
            {opt}
          </button>
        ))}
      </div>
    </div>
  );
}

export function XTerminal({ sessionId, initialCommand, cwd, hostId, readyMarker, connectionLabel, connectionTitle, isActive, onClose, onSessionCreated, transparentBackground }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [isConnecting, setIsConnecting] = useState(Boolean(readyMarker && !sessionId));
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatusPayload>(initialConnectionStatus);
  const [connectionLogs, setConnectionLogs] = useState<string[]>([]);
  const [showConnectionLogs, setShowConnectionLogs] = useState(false);
  const [reconnectState, setReconnectState] = useState<ReconnectState | null>(null);
  const [snippetPalette, setSnippetPalette] = useState(false);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [snippetGroups, setSnippetGroups] = useState<SnippetGroup[]>([]);
  const [snippetQuery, setSnippetQuery] = useState("");
  const [snippetIndex, setSnippetIndex] = useState(0);
  const [variablePrompt, setVariablePrompt] = useState<{ snippet: Snippet; values: Record<string, string>; currentIdx: number } | null>(null);
  // Drives the enabled state of "Copy" in the terminal context menu.
  const [hasSelection, setHasSelection] = useState(false);
  // Resolved once per mount: local terminal tabs have no hostId, so `isLocal`
  // is true; SSH tabs look up the host's OS to gate OS-restricted snippets.
  const osContextRef = useRef<{ isLocal: boolean; hostOs?: OsKind }>({ isLocal: !hostId });
  // keyword -> snippet, for the text-only auto-expand feature. Only snippets
  // with no variables are eligible (mid-line variable prompts would be jarring).
  const keywordSnippetsRef = useRef<Map<string, Snippet>>(new Map());
  // Raw text typed since the last Enter, tracked from keystrokes directly
  // rather than read from the terminal's rendered buffer — the buffer only
  // reflects a keystroke once the PTY echoes it back asynchronously, which
  // isn't done yet at the moment the next keystroke (e.g. the space that
  // triggers a keyword match) arrives. Used both for keyword auto-expand
  // and to gate command/script snippets to "cursor at start of line" (a
  // shell prompt already occupies columns before the cursor, so absolute
  // terminal column can't be used for that either).
  const currentLineRef = useRef("");
  const shortcutsRefLocal = useRef<ShortcutMap>(loadShortcuts());
  const termRef = useRef<Terminal | null>(null);
  const sessionRef = useRef<string | null>(sessionId ?? null);
  const unlistenOutputRef = useRef<UnlistenFn | null>(null);
  const unlistenExitRef = useRef<UnlistenFn | null>(null);
  const unlistenConnectionRef = useRef<UnlistenFn | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const isInitializedRef = useRef(false);
  const mountCountRef = useRef(0);
  const notifiedSessionRef = useRef<string | null>(sessionId ?? null);
  const appearanceRequestRef = useRef(0);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearReconnectTimers = () => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (reconnectIntervalRef.current) {
      clearInterval(reconnectIntervalRef.current);
      reconnectIntervalRef.current = null;
    }
  };

  // Called whenever the PTY session ends unexpectedly. For SSH tabs (hostId
  // present) this kicks off the auto-reconnect flow; local shells just get
  // the old "press any key" message since there's no host to reconnect to.
  const handleDisconnect = () => {
    if (!hostId) {
      termRef.current?.write("\r\n\x1b[38;2;255;207;107m[Shell exited. Press any key to restart.]\x1b[0m\r\n");
      return;
    }
    termRef.current?.write("\r\n\x1b[38;2;255;99;99m[Connection to host lost.]\x1b[0m\r\n");
    reconnectAttemptRef.current = 0;
    scheduleReconnectAttempt();
  };

  const scheduleReconnectAttempt = () => {
    const attempt = reconnectAttemptRef.current + 1;
    reconnectAttemptRef.current = attempt;
    if (attempt > MAX_RECONNECT_ATTEMPTS) {
      clearReconnectTimers();
      setReconnectState({ phase: "failed", attempt: MAX_RECONNECT_ATTEMPTS, countdown: 0 });
      return;
    }

    const delay = RECONNECT_DELAYS_SEC[attempt - 1];
    let remaining = delay;
    setReconnectState({ phase: "waiting", attempt, countdown: remaining });

    clearReconnectTimers();
    reconnectIntervalRef.current = setInterval(() => {
      remaining -= 1;
      setReconnectState((s) => (s && s.phase === "waiting" ? { ...s, countdown: Math.max(remaining, 0) } : s));
    }, 1000);
    reconnectTimeoutRef.current = setTimeout(() => {
      void performReconnect(attempt);
    }, delay * 1000);
  };

  const performReconnect = async (attempt: number) => {
    clearReconnectTimers();
    setReconnectState({ phase: "connecting", attempt, countdown: 0 });
    try {
      const info = await createSession({
        cwd: cwd ?? "",
        initialCommand: initialCommand ?? null,
        hostId: hostId ?? null,
        readyMarker: readyMarker ?? null,
      });
      sessionRef.current = info.id;

      unlistenOutputRef.current?.();
      unlistenExitRef.current?.();
      unlistenOutputRef.current = await onSessionOutput(info.id, (chunk) => {
        termRef.current?.write(chunk);
      });
      unlistenExitRef.current = await onSessionExited(info.id, () => {
        handleDisconnect();
      });

      const term = termRef.current;
      if (term?.cols && term?.rows) {
        await resizeSession(info.id, term.cols, term.rows);
      }

      reconnectAttemptRef.current = 0;
      setReconnectState(null);
      term?.write("\r\n\x1b[38;2;120;220;140m[Reconnected.]\x1b[0m\r\n");
    } catch {
      scheduleReconnectAttempt();
    }
  };

  // Manual reconnect from the "failed" screen, or a manual retry at any point.
  const manualReconnect = () => {
    clearReconnectTimers();
    reconnectAttemptRef.current = 0;
    void performReconnect(1).catch(() => {});
  };

  // ── Terminal clipboard actions (context menu + Windows right-click) ───────
  const copySelection = useCallback(() => {
    const term = termRef.current;
    const selection = term?.getSelection();
    if (term && selection) {
      navigator.clipboard.writeText(selection).catch(() => {});
      term.clearSelection();
    }
  }, []);

  const pasteClipboard = useCallback(() => {
    const sid = sessionRef.current;
    if (!sid) return;
    navigator.clipboard
      .readText()
      .then((text) => {
        if (text) writeToSession(sid, text).catch(() => {});
      })
      .catch(() => {});
  }, []);

  const refocusTerminal = useCallback(() => {
    setTimeout(() => termRef.current?.focus(), 50);
  }, []);

  // Windows terminal convention (VS Code / Windows Terminal default): right
  // click never shows a menu — it copies the selection if there is one,
  // otherwise pastes. macOS/Linux get a context menu instead (see render).
  const handleWindowsRightClick = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      if (termRef.current?.hasSelection()) {
        copySelection();
      } else {
        pasteClipboard();
      }
    },
    [copySelection, pasteClipboard]
  );

  const loadSnippets = useCallback(() => {
    return listSnippets().then((data) => {
      setSnippets(data.snippets);
      setSnippetGroups(data.groups);
      const map = new Map<string, Snippet>();
      for (const s of data.snippets) {
        if (
          s.kind === "text" &&
          s.keyword &&
          (!s.variables || s.variables.length === 0) &&
          matchesOsTarget(s.osTargets, osContextRef.current)
        ) {
          map.set(s.keyword, s);
        }
      }
      keywordSnippetsRef.current = map;
    });
  }, []);

  // Resolve this tab's OS context once, then (re)build the keyword map with it.
  useEffect(() => {
    let cancelled = false;
    if (!hostId) {
      osContextRef.current = { isLocal: true };
      void loadSnippets();
      return;
    }
    listHosts()
      .then(({ hosts }) => {
        if (cancelled) return;
        const host = hosts.find((h) => h.id === hostId);
        osContextRef.current = { isLocal: false, hostOs: host?.os };
        void loadSnippets();
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId]);

  // Refresh the palette + keyword map whenever a snippet is created, edited,
  // removed, or moved — otherwise changes made in the Snippets panel would
  // have no effect on terminals that were already open.
  useEffect(() => {
    const { unlisten } = onSnippetsChanged(() => void loadSnippets());
    return unlisten;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  // Constant per window (the quick-terminal window always passes true).
  const xtermTheme = (theme: AppTheme) =>
    transparentBackground ? { ...theme.xterm, background: "#00000000" } : theme.xterm;

  useLayoutEffect(() => {
    if (!ref.current || isInitializedRef.current) return;
    isInitializedRef.current = true;
    const mountId = ++mountCountRef.current;
    let destroyed = false;
    const appearance = loadTerminalAppearance();
    const appTheme = loadAppTheme();
    let unlistenAppearance: UnlistenFn | null = null;
    let unlistenAppTheme: UnlistenFn | null = null;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: getTerminalFontStack(appearance.fontFamily),
      fontSize: appearance.fontSize,
      lineHeight: appearance.lineHeight,
      theme: xtermTheme(appTheme),
      allowTransparency: true,
      scrollback: 50000,
    });

    const fit = new FitAddon();
    fitAddonRef.current = fit;
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(ref.current);
    termRef.current = term;
    requestAnimationFrame(() => term.focus());

    // Intercept terminal shortcuts before xterm processes them
    term.attachCustomKeyEventHandler((event) => {
      const shortcuts = shortcutsRefLocal.current;

      if (shortcuts["open-snippets"] && isShortcutMatch(event, shortcuts["open-snippets"])) {
        if (event.type === "keydown") {
          event.preventDefault();
          loadSnippets().then(() => {
            setSnippetQuery("");
            setSnippetIndex(0);
            setSnippetPalette(true);
          }).catch(() => {});
        }
        return false;
      }

      if (shortcuts["terminal-copy"] && isShortcutMatch(event, shortcuts["terminal-copy"])) {
        if (event.type === "keydown") {
          const selection = term.getSelection();
          if (selection) {
            navigator.clipboard.writeText(selection).catch(() => {});
            term.clearSelection();
          }
        }
        return false;
      }

      if (shortcuts["terminal-paste"] && isShortcutMatch(event, shortcuts["terminal-paste"])) {
        if (event.type === "keydown") {
          const sid = sessionRef.current;
          if (sid) {
            navigator.clipboard.readText().then((text) => {
              writeToSession(sid, text).catch(() => {});
            }).catch(() => {});
          }
        }
        return false;
      }

      if (shortcuts["clear-terminal"] && isShortcutMatch(event, shortcuts["clear-terminal"])) {
        if (event.type === "keydown") {
          term.clear();
        }
        return false;
      }

      return true;
    });

    // Tabs are never unmounted, just toggled with display:none (see
    // AppShell). A hidden container reports clientWidth/Height 0, and
    // fitting against that shrinks the terminal to bogus cols/rows — which
    // then gets pushed to the backend PTY via onResize below, corrupting
    // how already-written lines reflow once the tab is shown again. Skip
    // fitting whenever the container has no real layout box yet.
    const safeFit = () => {
      const el = ref.current;
      if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
      try {
        fit.fit();
      } catch {
        /* element not visible yet */
      }
    };
    requestAnimationFrame(safeFit);

    const ro = new ResizeObserver(safeFit);
    ro.observe(ref.current);
    const applyAppearance = (nextAppearance: TerminalAppearance) => {
      const requestId = ++appearanceRequestRef.current;

      void ensureTerminalFontLoaded(nextAppearance).then(() => {
        if (requestId !== appearanceRequestRef.current) return;

        term.options.fontFamily = getTerminalFontStack(nextAppearance.fontFamily);
        term.options.fontSize = nextAppearance.fontSize;
        term.options.lineHeight = nextAppearance.lineHeight;
        safeFit();
      });
    };
    const onAppearanceChanged = (event: Event) => {
      applyAppearance((event as CustomEvent<TerminalAppearance>).detail);
    };
    const onStorageChanged = (event: StorageEvent) => {
      if (event.key === terminalAppearanceStorageKey) {
        applyAppearance(loadTerminalAppearance());
      } else if (event.key === appThemeStorageKey) {
        term.options.theme = xtermTheme(loadAppTheme());
      }
    };
    const applyTheme = (theme: AppTheme) => {
      term.options.theme = xtermTheme(theme);
    };
    const onAppThemeChanged = (event: Event) => {
      applyTheme((event as CustomEvent<AppTheme>).detail);
    };
    window.addEventListener(terminalAppearanceChangedEvent, onAppearanceChanged);
    window.addEventListener(appThemeChangedEvent, onAppThemeChanged);
    window.addEventListener("storage", onStorageChanged);
    const onShortcutStorageChanged = (event: StorageEvent) => {
      if (event.key === shortcutsStorageKey) {
        shortcutsRefLocal.current = loadShortcuts();
      }
    };
    window.addEventListener("storage", onShortcutStorageChanged);
    void ensureTerminalFontLoaded(appearance).then(() => {
      term.options.fontFamily = getTerminalFontStack(appearance.fontFamily);
      term.options.fontSize = appearance.fontSize;
      term.options.lineHeight = appearance.lineHeight;
      safeFit();
    });
    void subscribe<TerminalAppearance>(terminalAppearanceChangedEvent, (event) => {
      applyAppearance(event.payload);
    })
      .then((unlisten) => {
        if (destroyed) { unlisten(); return; }
        unlistenAppearance = unlisten;
      })
      .catch(() => {});
    void subscribe<AppTheme>(appThemeChangedEvent, (event) => {
      applyTheme(event.payload);
    })
      .then((unlisten) => {
        if (destroyed) { unlisten(); return; }
        unlistenAppTheme = unlisten;
      })
      .catch(() => {});

    // Send keystrokes to backend PTY
    const dataDisp = term.onData((data) => {
      const sid = sessionRef.current;
      if (!sid) return;

      const send = (payload: string) =>
        writeToSession(sid, payload).catch((err) => console.error("write_to_session failed:", err));

      if (data === "\r") {
        currentLineRef.current = "";
        send(data);
        return;
      }
      if (data === "\x7f") {
        currentLineRef.current = currentLineRef.current.slice(0, -1);
        send(data);
        return;
      }
      if (data.length === 0 || data.startsWith("\x1b")) {
        send(data);
        return;
      }

      currentLineRef.current += data;
      send(data);

      // Immediate keyword match: as soon as the word just typed (tracked
      // locally from raw keystrokes, not read from the terminal's rendered
      // buffer — the buffer only reflects a keystroke once the PTY echoes it
      // back asynchronously) exactly equals a known keyword, expand it right
      // away without waiting for a boundary character. Only eligible on
      // kind === "text" snippets with no variables.
      const match = /(\S+)$/.exec(currentLineRef.current);
      const word = match?.[1];
      const snippet = word ? keywordSnippetsRef.current.get(word) : undefined;
      if (snippet) {
        currentLineRef.current = currentLineRef.current.slice(0, -word!.length);
        const erase = "\x7f".repeat(word!.length);
        send(erase + (snippet.body ?? ""));
      }
    });

    const selectionDisp = term.onSelectionChange(() => {
      setHasSelection(term.hasSelection());
    });

    // Notify backend on resize
    const resizeDisp = term.onResize(({ cols, rows }) => {
      const sid = sessionRef.current;
      if (sid) {
        resizeSession(sid, cols, rows).catch((err) =>
          console.error("resize_session failed:", err)
        );
      }
    });

    // Create PTY session and subscribe to output
    const setup = async () => {
      try {
        if (readyMarker) {
          unlistenConnectionRef.current = await onConnectionStatus<ConnectionStatusPayload>(
            readyMarker,
            (payload) => {
              if (payload.log) {
                setConnectionLogs((logs) => [...logs.slice(-80), payload.log as string]);
              }
              setConnectionStatus({
                stage: payload.stage,
                status: payload.status,
                message: payload.message,
              });
              if (payload.status === "done") {
                setTimeout(() => setIsConnecting(false), 350);
              } else if (payload.status === "failed") {
                setIsConnecting(true);
                setShowConnectionLogs(true);
              }
            }
          );
        }

        let sid = sessionRef.current;
        if (!sid) {
          const info = await createSession({
            cwd: cwd ?? "",
            initialCommand: initialCommand ?? null,
            hostId: hostId ?? null,
            readyMarker: readyMarker ?? null,
          });
          sid = info.id;
          sessionRef.current = sid;
          notifiedSessionRef.current = sid;
          onSessionCreated?.(sid);
        }

        // Listen for PTY output
        unlistenOutputRef.current = await onSessionOutput(sid, (chunk) => {
          if (!readyMarker) setIsConnecting(false);
          term.write(chunk);
        });

        // Listen for shell exit
        unlistenExitRef.current = await onSessionExited(sid, () => {
          if (!readyMarker) setIsConnecting(false);
          handleDisconnect();
        });

        // Do an initial fit + resize notification to backend
        safeFit();
        if (term.cols && term.rows) {
          await resizeSession(sid, term.cols, term.rows);
        }
      } catch (err) {
        setConnectionStatus({
          stage: "connecting",
          status: "failed",
          message: `Failed to start shell: ${err}`,
        });
        setShowConnectionLogs(true);
        term.write(`\r\n\x1b[31mFailed to start shell: ${err}\x1b[0m\r\n`);
      }
    };

    setup();

    return () => {
      if (mountId !== mountCountRef.current) {
        // Strict Mode double-invoke: این mount قدیمیه، فقط clean کن
        destroyed = true;
        ro.disconnect();
        dataDisp.dispose();
        selectionDisp.dispose();
        resizeDisp.dispose();
        isInitializedRef.current = false;
        return;
      }
      destroyed = true;
      clearReconnectTimers();
      appearanceRequestRef.current += 1;
      window.removeEventListener(terminalAppearanceChangedEvent, onAppearanceChanged);
      window.removeEventListener(appThemeChangedEvent, onAppThemeChanged);
      window.removeEventListener("storage", onStorageChanged);
      window.removeEventListener("storage", onShortcutStorageChanged);
      unlistenAppTheme?.();
      unlistenAppearance?.();
      ro.disconnect();
      dataDisp.dispose();
      selectionDisp.dispose();
      resizeDisp.dispose();
      unlistenOutputRef.current?.();
      unlistenExitRef.current?.();
      unlistenConnectionRef.current?.();
      unlistenOutputRef.current = null;
      unlistenExitRef.current = null;
      unlistenConnectionRef.current = null;
      fitAddonRef.current = null;
      termRef.current = null;
      isInitializedRef.current = false;
      term.dispose();
    };
  }, []);

  // Handle sessionId prop changes
  useEffect(() => {
    if (sessionId && sessionId !== sessionRef.current) {
      sessionRef.current = sessionId;
    }
  }, [sessionId]);

  const closeConnection = () => {
    const sid = sessionRef.current;
    if (sid) {
      closeSession(sid).catch(() => {});
    }
    onClose?.();
  };

  const activeIndex = connectionSteps.findIndex((step) => step.key === connectionStatus.stage);
  const safeActiveIndex = activeIndex >= 0 ? activeIndex : 0;
  const failedIndex = connectionStatus.status === "failed" ? safeActiveIndex : -1;
  // Notify parent when session is created
  useEffect(() => {
    const sid = sessionRef.current;
    if (sid && onSessionCreated && notifiedSessionRef.current !== sid) {
      notifiedSessionRef.current = sid;
      onSessionCreated(sid);
    }
  }, [onSessionCreated]);

  // A single requestAnimationFrame after a tab's container flips from
  // display:none to visible isn't reliably enough time for layout to land
  // on slower machines (seen on Intel Macs) — fitting too early measures a
  // stale/zero-size box and corrupts how the terminal reflows. Poll across
  // frames until the container actually has a size, capped so we don't spin
  // forever if it's legitimately hidden.
  const fitWhenLaidOut = useCallback((onDone?: () => void) => {
    let attempts = 0;
    const tick = () => {
      const el = ref.current;
      if (el && el.clientWidth > 0 && el.clientHeight > 0) {
        fitAddonRef.current?.fit();
        onDone?.();
        return;
      }
      if (++attempts < 20) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, []);

  // Re-fit and focus when this tab becomes active
  useEffect(() => {
    if (!isActive || isConnecting) return;
    fitWhenLaidOut(() => requestAnimationFrame(() => termRef.current?.focus()));
  }, [isActive, isConnecting, fitWhenLaidOut]);

  // Focus terminal when connection overlay is dismissed
  useEffect(() => {
    if (!isConnecting && termRef.current) {
      fitWhenLaidOut(() => requestAnimationFrame(() => termRef.current?.focus()));
    }
  }, [isConnecting, fitWhenLaidOut]);

  // ── Snippet Palette Logic ──────────────────────────────────────────────────

  // command/script snippets are only offered when the cursor is at column 0 —
  // if the user has typed anything on the current line, they're hidden.
  const cursorAtLineStart = () => currentLineRef.current.length === 0;

  // Full "Parent › Child" path for a snippet's group, or null when ungrouped —
  // used to cluster the palette by group instead of a flat list.
  const groupPathFor = (groupId: string | null | undefined): string | null => {
    if (!groupId) return null;
    const parts: string[] = [];
    let cur = snippetGroups.find((g) => g.id === groupId);
    while (cur) {
      parts.unshift(cur.name);
      cur = cur.parentId ? snippetGroups.find((g) => g.id === cur!.parentId) : undefined;
    }
    return parts.length > 0 ? parts.join(" › ") : null;
  };

  const filteredSnippets = snippets
    .filter((s) => {
      if (!matchesOsTarget(s.osTargets, osContextRef.current)) return false;
      if ((s.kind === "command" || s.kind === "script") && !cursorAtLineStart()) return false;
      // Filter by search query
      if (!snippetQuery.trim()) return true;
      const q = snippetQuery.toLowerCase();
      const content = s.body || s.command || s.script || "";
      return s.name.toLowerCase().includes(q) || content.toLowerCase().includes(q);
    })
    .sort((a, b) => {
      const pa = groupPathFor(a.groupId);
      const pb = groupPathFor(b.groupId);
      if (pa === pb) return 0;
      if (pa === null) return 1; // ungrouped snippets sort after grouped ones
      if (pb === null) return -1;
      return pa.localeCompare(pb);
    });

  const executeSnippet = useCallback((snippet: Snippet, varValues?: Record<string, string>) => {
    const sid = sessionRef.current;
    if (!sid) return;
    if ((snippet.kind === "command" || snippet.kind === "script") && !cursorAtLineStart()) return;

    const resolveVars = (text: string) => {
      if (!snippet.variables?.length) return text;
      let resolved = text;
      for (const v of snippet.variables) {
        const val = varValues?.[v.name] ?? v.defaultValue ?? "";
        resolved = resolved.replaceAll(`{{${v.name}}}`, val);
        resolved = resolved.replaceAll(`\${${v.name}}`, val);
        resolved = resolved.replaceAll(`{${v.name}}`, val);
      }
      return resolved;
    };

    if (snippet.kind === "text") {
      const body = resolveVars(snippet.body ?? "");
      writeToSession(sid, body).catch(() => {});
    } else if (snippet.kind === "command") {
      const cmd = resolveVars(snippet.command ?? "");
      writeToSession(sid, cmd + "\r").catch(() => {});
    } else if (snippet.kind === "script") {
      const script = resolveVars(snippet.script ?? "");
      // Send script to backend — it writes a temp .sh file, executes it, and cleans up
      // Only title message is shown in terminal, not the script content
      runSnippetScript(sid, snippet.name, script).catch((err) =>
        console.error("run_snippet_script failed:", err)
      );
    }

    setSnippetPalette(false);
    setVariablePrompt(null);
    // Refocus terminal
    setTimeout(() => termRef.current?.focus(), 50);
  }, []);

  const selectSnippet = useCallback((snippet: Snippet) => {
    if (snippet.variables && snippet.variables.length > 0) {
      // Show variable prompt
      const defaults: Record<string, string> = {};
      for (const v of snippet.variables) {
        defaults[v.name] = v.defaultValue ?? (v.type === "enum" ? (v.options?.[0] ?? "") : "");
      }
      setVariablePrompt({ snippet, values: defaults, currentIdx: 0 });
      setSnippetPalette(false);
    } else {
      executeSnippet(snippet);
    }
  }, [executeSnippet]);

  const submitVariables = useCallback(() => {
    if (!variablePrompt) return;
    executeSnippet(variablePrompt.snippet, variablePrompt.values);
  }, [variablePrompt, executeSnippet]);

  // Palette keyboard navigation
  useEffect(() => {
    if (!snippetPalette) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setSnippetPalette(false);
        setTimeout(() => termRef.current?.focus(), 50);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setSnippetIndex((i) => Math.min(i + 1, filteredSnippets.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSnippetIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const selected = filteredSnippets[snippetIndex];
        if (selected) selectSnippet(selected);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [snippetPalette, filteredSnippets, snippetIndex, selectSnippet]);

  // Reset index when query changes
  useEffect(() => { setSnippetIndex(0); }, [snippetQuery]);

  return (
    <div className="relative h-full w-full bg-background">
      {isConnecting && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-background px-4 text-center">
          <div className="w-full max-w-2xl">
            <div className="mb-8 flex items-center gap-3 text-left">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-foreground text-background">
                <span className="font-mono text-sm font-bold">&gt;_</span>
              </div>
              <div>
                <h3 className="text-lg font-bold text-foreground">{connectionTitle ?? "SSH Session"}</h3>
                <p className="mt-0.5 text-sm font-medium text-muted-foreground">{connectionLabel}</p>
              </div>
            </div>

            <div className="mb-7 flex items-center">
              {connectionSteps.map((step, index) => {
                const isDone = index < safeActiveIndex || connectionStatus.status === "done";
                const isActive = index === safeActiveIndex && connectionStatus.status === "active";
                const isFailed = index === failedIndex;
                const lineDone = index < safeActiveIndex && connectionStatus.status !== "failed";
                return (
                  <div key={step.key} className="contents">
                    <div
                      className={[
                        "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold",
                        isFailed
                          ? "bg-red-500 text-white"
                          : isDone
                            ? "bg-[var(--color-brand-green)] text-white"
                            : isActive
                              ? "border-[3px] border-border bg-[var(--color-surface-2)] text-foreground"
                              : "border-[3px] border-border text-muted-foreground",
                      ].join(" ")}
                      title={step.label}
                    >
                      {isFailed ? "!" : isDone ? "✓" : isActive ? <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground border-t-[var(--color-brand-orange)]" /> : step.icon}
                    </div>
                    {index < connectionSteps.length - 1 && (
                      <div className={`h-0.5 flex-1 ${lineDone ? "bg-[var(--color-brand-green)]" : "bg-border"}`} />
                    )}
                  </div>
                );
              })}
            </div>

            <div className="rounded-2xl bg-[var(--color-surface)] px-5 py-4 text-left">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <span className="block text-base font-bold text-foreground">
                    {connectionSteps[safeActiveIndex]?.label ?? "Connecting"}
                  </span>
                  <span className={`mt-1 block text-xs ${connectionStatus.status === "failed" ? "text-red-400" : "text-muted-foreground"}`}>
                    {connectionStatus.message}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setShowConnectionLogs((show) => !show)}
                  className="rounded-md border border-border bg-[var(--color-surface-2)] px-3 py-1 text-xs font-semibold text-muted-foreground hover:text-foreground"
                >
                  {showConnectionLogs ? "Hide Logs" : "Show Logs"}
                </button>
              </div>
              {showConnectionLogs && (
                <div className="mt-3 max-h-28 overflow-auto rounded-lg border border-border bg-background/60 p-2 font-mono text-[10px] leading-4 text-muted-foreground">
                  {connectionLogs.length ? connectionLogs.map((log, index) => <div key={`${index}-${log}`}>{log}</div>) : "Waiting for SSH logs..."}
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={closeConnection}
              className="mt-6 h-9 w-full rounded-md border border-border bg-[var(--color-surface-2)] text-sm font-semibold text-foreground hover:bg-[var(--color-surface)]"
            >
              Close
            </button>
          </div>
        </div>
      )}
      {!isConnecting && reconnectState && (reconnectState.phase === "waiting" || reconnectState.phase === "connecting") && (
        <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between gap-3 border-b border-border bg-[var(--color-surface)]/95 px-4 py-2 text-xs backdrop-blur">
          <div className="flex items-center gap-2">
            <div className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-muted-foreground border-t-red-400" />
            <span className="font-medium text-foreground">
              {reconnectState.phase === "connecting"
                ? `Reconnecting… (attempt ${reconnectState.attempt} of ${MAX_RECONNECT_ATTEMPTS})`
                : `Connection lost — retrying (${reconnectState.attempt}/${MAX_RECONNECT_ATTEMPTS}) in ${reconnectState.countdown}s`}
            </span>
          </div>
          {reconnectState.phase === "waiting" && (
            <button
              type="button"
              onClick={() => { clearReconnectTimers(); void performReconnect(reconnectState.attempt); }}
              className="shrink-0 rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 py-1 text-xs font-semibold text-foreground hover:bg-[var(--color-surface)]"
            >
              Retry now
            </button>
          )}
        </div>
      )}

      {!isConnecting && reconnectState?.phase === "failed" && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-background/95 px-4 text-center backdrop-blur">
          <div className="w-full max-w-sm">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-500/15 text-red-400">
              <span className="text-2xl">⚠</span>
            </div>
            <h3 className="text-base font-bold text-foreground">Connection lost</h3>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Couldn&apos;t reconnect after {MAX_RECONNECT_ATTEMPTS} attempts. Your terminal history is preserved.
            </p>
            <button
              type="button"
              onClick={manualReconnect}
              className="mt-5 h-9 w-full rounded-md bg-[var(--color-brand-orange,oklch(0.75_0.15_55))] text-sm font-semibold text-white hover:opacity-90"
            >
              Connect
            </button>
          </div>
        </div>
      )}

      {platform === "windows" ? (
        <div
          ref={ref}
          className="xterm-wrapper h-full w-full pl-1 pt-1"
          style={{ visibility: isConnecting ? "hidden" : "visible" }}
          onContextMenu={handleWindowsRightClick}
        />
      ) : (
        <ContextMenu.Root>
          <ContextMenu.Trigger asChild>
            <div
              ref={ref}
              className="xterm-wrapper h-full w-full pl-1 pt-1"
              style={{ visibility: isConnecting ? "hidden" : "visible" }}
            />
          </ContextMenu.Trigger>
          <ContextMenu.Portal>
            <ContextMenu.Content
              className="z-50 min-w-[180px] overflow-hidden rounded-lg border border-border bg-popover p-1 shadow-xl"
              onCloseAutoFocus={(e) => {
                e.preventDefault();
                refocusTerminal();
              }}
            >
              <ContextMenu.Item className={menuItemCls} disabled={!hasSelection} onSelect={copySelection}>
                <span className="flex-1">Copy</span>
                <MenuShortcut binding={shortcutsRefLocal.current["terminal-copy"]} />
              </ContextMenu.Item>
              <ContextMenu.Item className={menuItemCls} onSelect={pasteClipboard}>
                <span className="flex-1">Paste</span>
                <MenuShortcut binding={shortcutsRefLocal.current["terminal-paste"]} />
              </ContextMenu.Item>
              <ContextMenu.Item className={menuItemCls} onSelect={() => termRef.current?.selectAll()}>
                <span className="flex-1">Select All</span>
              </ContextMenu.Item>
              <ContextMenu.Separator className="my-1 h-px bg-border" />
              <ContextMenu.Item className={menuItemCls} onSelect={() => termRef.current?.clear()}>
                <span className="flex-1">Clear</span>
                <MenuShortcut binding={shortcutsRefLocal.current["clear-terminal"]} />
              </ContextMenu.Item>
            </ContextMenu.Content>
          </ContextMenu.Portal>
        </ContextMenu.Root>
      )}

      {/* Snippet Palette */}
      {snippetPalette && (
        <div className="absolute inset-0 z-20 flex items-start justify-center pt-12" onClick={() => { setSnippetPalette(false); setTimeout(() => termRef.current?.focus(), 50); }}>
          <div
            className="w-[420px] max-h-[360px] flex flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <svg className="h-4 w-4 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
              <input
                autoFocus
                value={snippetQuery}
                onChange={(e) => setSnippetQuery(e.target.value)}
                placeholder="Search snippets…"
                className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
              />
              <kbd className="rounded border border-border bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[10px] text-muted-foreground">ESC</kbd>
            </div>
            <div className="flex-1 overflow-y-auto">
              {filteredSnippets.length === 0 ? (
                <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                  No snippets found.
                </div>
              ) : (
                filteredSnippets.map((s, i) => {
                  const kindColors: Record<string, string> = { text: "oklch(0.55_0.15_160)", command: "oklch(0.45_0.15_230)", script: "oklch(0.55_0.15_300)" };
                  const kindLabels: Record<string, string> = { text: "Text", command: "Cmd", script: "Script" };
                  const groupPath = groupPathFor(s.groupId);
                  const prevGroupPath = i > 0 ? groupPathFor(filteredSnippets[i - 1].groupId) : undefined;
                  const showGroupHeader = groupPath !== prevGroupPath;
                  return (
                    <div key={s.id}>
                      {showGroupHeader && (
                        <div className="px-3 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 first:pt-1.5">
                          {groupPath ?? "Ungrouped"}
                        </div>
                      )}
                      <div
                        onClick={() => selectSnippet(s)}
                        className={[
                          "flex cursor-pointer items-center gap-3 px-3 py-2 transition",
                          i === snippetIndex ? "bg-[var(--color-surface-2)]" : "hover:bg-[var(--color-surface-2)]/60",
                        ].join(" ")}
                      >
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-[10px] font-bold text-white" style={{ backgroundColor: kindColors[s.kind] || kindColors.command }}>
                          {kindLabels[s.kind]?.[0] || "C"}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-foreground">{s.name}</div>
                          <div className="truncate text-xs text-muted-foreground font-mono">{s.body || s.command || s.script || ""}</div>
                        </div>
                        <span className="shrink-0 rounded bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[10px] text-muted-foreground">{kindLabels[s.kind] || "Command"}</span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* Variable Prompt — wizard: one variable at a time */}
      {variablePrompt && (() => {
        const vars = variablePrompt.snippet.variables ?? [];
        const idx = variablePrompt.currentIdx;
        const v = vars[idx];
        const isLast = idx === vars.length - 1;
        if (!v) return null;

        const goNext = (val: string) => {
          const merged = { ...variablePrompt.values, [v.name]: val };
          if (isLast) {
            executeSnippet(variablePrompt.snippet, merged);
          } else {
            setVariablePrompt((prev) => prev ? { ...prev, values: merged, currentIdx: idx + 1 } : null);
          }
        };

        const goPrev = () => {
          if (idx > 0) setVariablePrompt((prev) => prev ? { ...prev, currentIdx: idx - 1 } : null);
        };

        return (
          <div className="absolute inset-0 z-20 flex items-start justify-center pt-12" onClick={() => { setVariablePrompt(null); setTimeout(() => termRef.current?.focus(), 50); }}>
            <div
              className="w-[400px] flex flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="border-b border-border px-4 py-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-foreground">{variablePrompt.snippet.name}</h3>
                  <span className="text-xs text-muted-foreground">{idx + 1} / {vars.length}</span>
                </div>
                <div className="mt-1.5 flex gap-1">
                  {vars.map((_, i) => (
                    <span key={i} className={["h-1 flex-1 rounded-full transition-colors", i <= idx ? "bg-[var(--color-brand-orange)]" : "bg-border"].join(" ")} />
                  ))}
                </div>
              </div>
              <div className="px-4 py-4">
                <label className="mb-2 block text-xs font-medium text-foreground">{v.label || v.name}</label>
                {v.type === "enum" ? (
                  <EnumDropdown
                    options={v.options ?? []}
                    value={variablePrompt.values[v.name] ?? ""}
                    onChange={(val) => setVariablePrompt((prev) => prev ? { ...prev, values: { ...prev.values, [v.name]: val } } : null)}
                    onConfirm={(val) => goNext(val)}
                    autoFocus
                  />
                ) : (
                  <input
                    autoFocus
                    value={variablePrompt.values[v.name] ?? ""}
                    onChange={(e) => setVariablePrompt((prev) => prev ? { ...prev, values: { ...prev.values, [v.name]: e.target.value } } : null)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") goNext(variablePrompt.values[v.name] ?? "");
                    }}
                    placeholder={v.defaultValue || v.name}
                    className="h-8 w-full rounded-md border border-border bg-[var(--color-surface)] px-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring/40"
                  />
                )}
              </div>
              <div className="flex items-center justify-between border-t border-border px-4 py-2.5">
                <button
                  onClick={() => { setVariablePrompt(null); setTimeout(() => termRef.current?.focus(), 50); }}
                  className="rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-foreground"
                >
                  Cancel
                </button>
                <div className="flex items-center gap-2">
                  {idx > 0 && (
                    <button
                      onClick={goPrev}
                      className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-[var(--color-surface-2)]"
                    >
                      Back
                    </button>
                  )}
                  <button
                    onClick={() => goNext(variablePrompt.values[v.name] ?? "")}
                    className="rounded-md bg-[var(--color-brand-orange,oklch(0.75_0.15_55))] px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
                  >
                    {isLast ? "Execute" : "Next"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
