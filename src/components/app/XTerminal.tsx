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

interface Props {
  sessionId?: string;
  initialCommand?: string;
  initialPassword?: string;
  readyMarker?: string;
  connectionLabel?: string;
  connectionTitle?: string;
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

export function XTerminal({ sessionId, initialCommand, initialPassword, readyMarker, connectionLabel, connectionTitle, onClose, onSessionCreated }: Props) {
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

    // Intercept Cmd+Shift+S for snippet palette
    term.attachCustomKeyEventHandler((event) => {
      const shortcuts = shortcutsRefLocal.current;
      if (shortcuts["open-snippets"] && isShortcutMatch(event, shortcuts["open-snippets"])) {
        if (event.type === "keydown") {
          event.preventDefault();
          // Load snippets from backend
          invoke<Snippet[]>("list_snippets").then((data) => {
            setSnippets(data);
            setSnippetQuery("");
            setSnippetIndex(0);
            setSnippetPalette(true);
          }).catch(() => {});
        }
        return false; // prevent xterm from processing this key
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

  // Re-fit when container becomes visible (e.g., tab switch)
  useEffect(() => {
    if (!ref.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && fitAddonRef.current) {
        setTimeout(() => {
          fitAddonRef.current?.fit();
          termRef.current?.focus();
        }, 0);
      }
    });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  // Focus terminal when connection overlay is dismissed
  useEffect(() => {
    if (!isConnecting && termRef.current) {
      setTimeout(() => {
        fitAddonRef.current?.fit();
        termRef.current?.focus();
      }, 50);
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

      {/* Variable Prompt */}
      {variablePrompt && (
        <div className="absolute inset-0 z-20 flex items-start justify-center pt-12" onClick={() => { setVariablePrompt(null); setTimeout(() => termRef.current?.focus(), 50); }}>
          <div
            className="w-[400px] flex flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-border px-4 py-3">
              <h3 className="text-sm font-semibold text-foreground">Variables — {variablePrompt.snippet.name}</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">Fill in the variables and press Enter to execute.</p>
            </div>
            <div className="space-y-3 px-4 py-3">
              {variablePrompt.snippet.variables?.map((v, idx) => (
                <div key={v.name} className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">{v.label || v.name}</label>
                  {v.type === "enum" ? (
                    <select
                      autoFocus={idx === 0}
                      value={variablePrompt.values[v.name] ?? ""}
                      onChange={(e) => setVariablePrompt((prev) => prev ? { ...prev, values: { ...prev.values, [v.name]: e.target.value } } : null)}
                      className="h-8 w-full rounded-md border border-border bg-[var(--color-surface)] px-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring/40"
                    >
                      {v.options?.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                    </select>
                  ) : (
                    <input
                      autoFocus={idx === 0}
                      value={variablePrompt.values[v.name] ?? ""}
                      onChange={(e) => setVariablePrompt((prev) => prev ? { ...prev, values: { ...prev.values, [v.name]: e.target.value } } : null)}
                      onKeyDown={(e) => { if (e.key === "Enter") submitVariables(); }}
                      placeholder={v.defaultValue || v.name}
                      className="h-8 w-full rounded-md border border-border bg-[var(--color-surface)] px-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring/40"
                    />
                  )}
                </div>
              ))}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-2.5">
              <button
                onClick={() => { setVariablePrompt(null); setTimeout(() => termRef.current?.focus(), 50); }}
                className="rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-foreground"
              >
                Cancel
              </button>
              <button
                onClick={submitVariables}
                className="rounded-md bg-[var(--color-brand-orange,oklch(0.75_0.15_55))] px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
              >
                Execute
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
