import { useEffect, useRef, useLayoutEffect, useState } from "react";
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
    </div>
  );
}
