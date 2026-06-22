import { useEffect, useRef, useLayoutEffect, useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
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
  isShortcutMatch,
  loadShortcuts,
  shortcutsChangedEvent,
  shortcutsStorageKey,
  type ShortcutMap,
} from "@/lib/shortcuts";
import type { Snippet } from "@/components/app/types";
import { Search } from "lucide-react";

interface Props {
  sessionId?: string;
  initialCommand?: string;
  initialPassword?: string;
  readyMarker?: string;
  connectionLabel?: string;
  connectionTitle?: string;
  isActive?: boolean;
  onClose?: () => void;
  onSessionCreated?: (sessionId: string) => void;
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

export function XTerminal({ sessionId, initialCommand, initialPassword, readyMarker, connectionLabel, connectionTitle, isActive, onClose, onSessionCreated }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [isConnecting, setIsConnecting] = useState(Boolean(readyMarker && !sessionId));
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatusPayload>(initialConnectionStatus);
  const [connectionLogs, setConnectionLogs] = useState<string[]>([]);
  const [showConnectionLogs, setShowConnectionLogs] = useState(false);
  const [snippetPalette, setSnippetPalette] = useState(false);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [snippetQuery, setSnippetQuery] = useState("");
  const [snippetIndex, setSnippetIndex] = useState(0);
  const [variablePrompt, setVariablePrompt] = useState<{ snippet: Snippet; values: Record<string, string>; currentIdx: number } | null>(null);
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
      theme: appTheme.xterm,
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
          invoke<Snippet[]>("list_snippets").then((data) => {
            setSnippets(data);
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
              invoke("write_to_session", { sessionId: sid, data: text }).catch(() => {});
            }).catch(() => {});
          }
        }
        return false;
      }

      return true;
    });

    const safeFit = () => {
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
        term.options.theme = loadAppTheme().xterm;
      }
    };
    const applyTheme = (theme: AppTheme) => {
      term.options.theme = theme.xterm;
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
    void listen<TerminalAppearance>(terminalAppearanceChangedEvent, (event) => {
      applyAppearance(event.payload);
    })
      .then((unlisten) => {
        if (destroyed) { unlisten(); return; }
        unlistenAppearance = unlisten;
      })
      .catch(() => {});
    void listen<AppTheme>(appThemeChangedEvent, (event) => {
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
      if (sid) {
        invoke("write_to_session", { sessionId: sid, data }).catch((err) =>
          console.error("write_to_session failed:", err)
        );
      }
    });

    // Notify backend on resize
    const resizeDisp = term.onResize(({ cols, rows }) => {
      const sid = sessionRef.current;
      if (sid) {
        invoke("resize_session", { sessionId: sid, cols, rows }).catch((err) =>
          console.error("resize_session failed:", err)
        );
      }
    });

    // Create PTY session and subscribe to output
    const setup = async () => {
      try {
        if (readyMarker) {
          unlistenConnectionRef.current = await listen<ConnectionStatusPayload>(
            `term:${readyMarker}:connection-status`,
            (event) => {
              if (event.payload.log) {
                setConnectionLogs((logs) => [...logs.slice(-80), event.payload.log as string]);
              }
              setConnectionStatus({
                stage: event.payload.stage,
                status: event.payload.status,
                message: event.payload.message,
              });
              if (event.payload.status === "done") {
                setTimeout(() => setIsConnecting(false), 350);
              } else if (event.payload.status === "failed") {
                setIsConnecting(true);
                setShowConnectionLogs(true);
              }
            }
          );
        }

        let sid = sessionRef.current;
        if (!sid) {
          const info = await invoke<{ id: string; label: string }>("create_session", {
            cwd: "",
            initialCommand: initialCommand ?? null,
            initialPassword: initialPassword ?? null,
            readyMarker: readyMarker ?? null,
          });
          sid = info.id;
          sessionRef.current = sid;
          notifiedSessionRef.current = sid;
          onSessionCreated?.(sid);
        }

        // Listen for PTY output
        unlistenOutputRef.current = await listen<string>(
          `term:${sid}:output`,
          (event) => {
            if (!readyMarker) setIsConnecting(false);
            term.write(event.payload);
          }
        );

        // Listen for shell exit
        unlistenExitRef.current = await listen<boolean>(
          `term:${sid}:exited`,
          () => {
            if (!readyMarker) setIsConnecting(false);
            term.write("\r\n\x1b[38;2;255;207;107m[Shell exited. Press any key to restart.]\x1b[0m\r\n");
          }
        );

        // Do an initial fit + resize notification to backend
        safeFit();
        if (term.cols && term.rows) {
          await invoke("resize_session", { sessionId: sid, cols: term.cols, rows: term.rows });
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
        resizeDisp.dispose();
        isInitializedRef.current = false;
        return;
      }
      destroyed = true;
      appearanceRequestRef.current += 1;
      window.removeEventListener(terminalAppearanceChangedEvent, onAppearanceChanged);
      window.removeEventListener(appThemeChangedEvent, onAppThemeChanged);
      window.removeEventListener("storage", onStorageChanged);
      window.removeEventListener("storage", onShortcutStorageChanged);
      unlistenAppTheme?.();
      unlistenAppearance?.();
      ro.disconnect();
      dataDisp.dispose();
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
      invoke("close_session", { sessionId: sid }).catch(() => {});
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

  // Re-fit and focus when this tab becomes active
  useEffect(() => {
    if (!isActive || isConnecting) return;
    requestAnimationFrame(() => {
      fitAddonRef.current?.fit();
      requestAnimationFrame(() => termRef.current?.focus());
    });
  }, [isActive, isConnecting]);

  // Focus terminal when connection overlay is dismissed
  useEffect(() => {
    if (!isConnecting && termRef.current) {
      requestAnimationFrame(() => {
        fitAddonRef.current?.fit();
        requestAnimationFrame(() => termRef.current?.focus());
      });
    }
  }, [isConnecting]);

  // ── Snippet Palette Logic ──────────────────────────────────────────────────

  const filteredSnippets = snippets.filter((s) => {
    // Filter by search query
    if (!snippetQuery.trim()) return true;
    const q = snippetQuery.toLowerCase();
    const content = s.body || s.command || s.script || "";
    return s.name.toLowerCase().includes(q) || content.toLowerCase().includes(q);
  });

  const executeSnippet = useCallback((snippet: Snippet, varValues?: Record<string, string>) => {
    const sid = sessionRef.current;
    if (!sid) return;

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
      invoke("write_to_session", { sessionId: sid, data: body }).catch(() => {});
    } else if (snippet.kind === "command") {
      const cmd = resolveVars(snippet.command ?? "");
      invoke("write_to_session", { sessionId: sid, data: cmd + "\r" }).catch(() => {});
    } else if (snippet.kind === "script") {
      const script = resolveVars(snippet.script ?? "");
      // Send script to backend — it writes a temp .sh file, executes it, and cleans up
      // Only title message is shown in terminal, not the script content
      invoke("run_snippet_script", {
        sessionId: sid,
        title: snippet.name,
        script,
      }).catch((err) => console.error("run_snippet_script failed:", err));
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
      <div
        ref={ref}
        className="xterm-wrapper h-full w-full pl-1 pt-1"
        style={{ visibility: isConnecting ? "hidden" : "visible" }}
      />

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
                  return (
                    <div
                      key={s.id}
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
