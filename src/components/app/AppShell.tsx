import { useState, useRef, useEffect, forwardRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { platform } from "@/lib/platform";
import { listen } from "@tauri-apps/api/event";
import {
  Server,
  Network,
  Braces,
  KeyRound,
  ClipboardList,
  Plus,
  TerminalSquare,
  Folder,
  X,
  LayoutDashboard,
  LayoutGrid,
  Minus,
  Square,
  Menu,
  Maximize2,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AppTab, Host, SidebarKey, SshKey, TabKind } from "./types";
import { XTerminal } from "./XTerminal";
import {
  isShortcutMatch,
  loadShortcuts,
  shortcutsChangedEvent,
  shortcutsStorageKey,
  type ShortcutMap,
} from "@/lib/shortcuts";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToHorizontalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { VaultGate } from "./VaultGate";
import { vaultStatus, vaultLock } from "@/lib/api/vault";
import type { VaultStatus } from "@/lib/api/vault";
import { EmptyState } from "@/components/shared/modal-primitives";
import { PortForwardingView } from "@/features/port-forwarding/PortForwardingView";
import { SshKeysView } from "@/features/ssh-keys/SshKeysView";
import { HostsView } from "@/features/hosts/HostsView";
import { SftpView } from "@/features/sftp/SftpView";
import { DashboardView } from "@/features/dashboard/DashboardView";
import { SnippetsView } from "@/features/snippets/SnippetsView";

const sidebarItems: { key: SidebarKey; label: string; icon: typeof Server }[] = [
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "hosts", label: "Hosts", icon: Server },
  { key: "port-forwarding", label: "Port Forwarding", icon: Network },
  { key: "snippets", label: "Snippets", icon: Braces },
  { key: "ssh-keys", label: "SSH Keys", icon: KeyRound },
  // { key: "logs", label: "Logs", icon: ClipboardList },
];

export function AppShell() {
  const [tabs, setTabs] = useState<AppTab[]>([
    { id: "t-vaults", kind: "vaults", title: "Hosts", closable: false },
    { id: "t-term", kind: "terminal", title: "Local Terminal", closable: true },
  ]);
  const [activeTab, setActiveTab] = useState("t-term");
  const [activeSidebar, setActiveSidebar] = useState<SidebarKey>("hosts");
  // Cached vault status; the Hosts view is gated by VaultGate until the vault
  // is unlocked, rather than prompting with a modal on app startup.
  const [vaultInfo, setVaultInfo] = useState<{ initialized: boolean; unlocked: boolean } | null>(null);
  const shortcutsRef = useRef<ShortcutMap>(loadShortcuts());
  const newTabRef = useRef<(kind: TabKind) => void>(null!);

  const newTab = (kind: TabKind) => {
    const id = `t-${kind}-${Date.now()}`;
    const title =
      kind === "terminal" ? "Local Terminal" : kind === "sftp" ? "SFTP" : "Hosts";
    setTabs((t) => [...t, { id, kind, title, closable: true }]);
    setActiveTab(id);
  };
  const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const openSshTerminal = async (host: Host) => {
    const id = `t-ssh-${host.id}-${Date.now()}`;
    let keyArg = "";
    if (host.sshKeyId) {
      try {
        const keys = await invoke<SshKey[]>("list_ssh_keys");
        const key = keys.find((item) => item.id === host.sshKeyId);
        if (key?.privateKeyPath) keyArg = ` -i ${shellQuote(key.privateKeyPath)}`;
      } catch {
        /* SSH can still use agent/default keys. */
      }
    }
    const portArg = host.port && host.port !== 22 ? ` -p ${host.port}` : "";
    const readyMarker = `__TERMIFAI_CONNECTED_${Date.now()}__`;
    const cdPart = host.workingDirectory?.trim() ? `cd ${host.workingDirectory.trim()} 2>/dev/null; ` : "";
    const remoteBootstrap = `printf '${readyMarker}\\n'; ${cdPart}exec ` + "${SHELL:-/bin/sh}" + " -i";
    // accept-new: trust a host's key on first contact and record it in the user's
    // known_hosts, but hard-fail if a previously recorded key changes (unlike
    // StrictHostKeyChecking=no, which trusted every connection unconditionally).
    const command = `ssh -v -tt -o StrictHostKeyChecking=accept-new${keyArg}${portArg} ${shellQuote(`${host.user}@${host.hostname}`)} ${shellQuote(remoteBootstrap)}`;

    // Count existing tabs for this host to generate a numbered title
    const baseTitle = host.name || host.hostname;
    setTabs((currentTabs) => {
      const existingCount = currentTabs.filter((t) => t.hostId === host.id).length;
      const title = existingCount > 0 ? `${baseTitle} (${existingCount + 1})` : baseTitle;
      return [
        ...currentTabs,
        {
          id,
          kind: "terminal",
          title,
          closable: true,
          initialCommand: command,
          readyMarker,
          connectionLabel: `${host.user}@${host.hostname}:${host.port}`,
          connectionTitle: host.name || host.hostname,
          hostId: host.id,
        },
      ];
    });
    setActiveTab(id);
  };

  const openSftpSession = (host?: Host) => {
    const id = host ? `t-sftp-${host.id}-${Date.now()}` : `t-sftp-${Date.now()}`;
    const baseTitle = host ? (host.name || host.hostname) : "SFTP";
    setTabs((currentTabs) => {
      const existingCount = host ? currentTabs.filter((t) => t.sftpHostId === host.id).length : 0;
      const title = existingCount > 0 ? `${baseTitle} (${existingCount + 1})` : baseTitle;
      return [
        ...currentTabs,
        {
          id,
          kind: "sftp" as const,
          title,
          closable: true,
          sftpHostId: host?.id,
        },
      ];
    });
    setActiveTab(id);
  };

  const closeTab = (id: string) => {
    const curr = tabsRef.current;
    const tgt = curr.find((t) => t.id === id);
    if (tgt && !tgt.closable) return;

    const next = curr.filter((t) => t.id !== id);
    setTabs(next);

    if (id === activeTabRef.current && next.length) {
      const closedIndex = curr.findIndex((t) => t.id === id);
      const newActive = next[closedIndex - 1] ?? next[next.length - 1];
      setActiveTab(newActive.id);
    }
  };

  const renameTab = (id: string, title: string) => {
    setTabs((curr) => curr.map((t) => (t.id === id ? { ...t, title } : t)));
  };

  const reorderTab = (fromId: string, toId: string) => {
    setTabs((curr) => {
      const from = curr.findIndex((t) => t.id === fromId);
      const to = curr.findIndex((t) => t.id === toId);
      if (from === -1 || to === -1 || from === to) return curr;
      if (!curr[from].closable) return curr;
      const pinnedCount = curr.filter((t) => !t.closable).length;
      if (to < pinnedCount) return curr;
      return arrayMove(curr, from, to);
    });
  };

  const updateTabSession = (tabId: string, sessionId: string) => {
    setTabs((curr) =>
      curr.map((t) =>
        t.id === tabId && t.sessionId !== sessionId ? { ...t, sessionId } : t
      )
    );
  };

  useEffect(() => {
    const refreshVault = () =>
      vaultStatus()
        .then((status: VaultStatus) => {
          setVaultInfo({ initialized: status.initialized, unlocked: status.unlocked });
        })
        .catch(console.error);

    void refreshVault();

    // Backend locks the vault on screen lock (per policy); re-gate immediately.
    const unlistenPromise = listen("vault-locked", () => {
      setVaultInfo((prev) => ({ initialized: prev?.initialized ?? true, unlocked: false }));
    });

    // Fallback: re-check status whenever the window regains focus, so returning
    // from a locked screen re-gates even if the event was missed.
    const onFocus = () => void refreshVault();
    window.addEventListener("focus", onFocus);

    return () => {
      void unlistenPromise.then((un) => un());
      window.removeEventListener("focus", onFocus);
    };
  }, []);


  useEffect(() => {
    newTabRef.current = newTab;
  });

  const activeTabRef = useRef(activeTab);
  const tabsRef = useRef(tabs);
  useEffect(() => {
    activeTabRef.current = activeTab;
    tabsRef.current = tabs;
  });

  useEffect(() => {
    let destroyed = false;
    let unlistenShortcuts: (() => void) | null = null;
    let unlistenMenuNewTerminal: (() => void) | null = null;

    const applyShortcuts = (shortcuts: ShortcutMap) => {
      shortcutsRef.current = shortcuts;
    };
    const onStorageChanged = (event: StorageEvent) => {
      if (event.key === shortcutsStorageKey) {
        applyShortcuts(loadShortcuts());
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isEditable =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      const isXtermInput = Boolean(target?.closest(".xterm"));

      if (isEditable && !isXtermInput) return;

      const shortcuts = shortcutsRef.current;

      if (isShortcutMatch(event, shortcuts["new-terminal"])) {
        event.preventDefault();
        newTabRef.current("terminal");
      } else if (isShortcutMatch(event, shortcuts["close-tab"])) {
        event.preventDefault();
        closeTab(activeTabRef.current);
      } else if (isShortcutMatch(event, shortcuts["next-tab"])) {
        event.preventDefault();
        const index = tabsRef.current.findIndex((item) => item.id === activeTabRef.current);
        const next = tabsRef.current[(index + 1) % tabsRef.current.length];
        if (next) setActiveTab(next.id);
      } else if (isShortcutMatch(event, shortcuts["previous-tab"])) {
        event.preventDefault();
        const index = tabsRef.current.findIndex((item) => item.id === activeTabRef.current);
        const previous = tabsRef.current[(index - 1 + tabsRef.current.length) % tabsRef.current.length];
        if (previous) setActiveTab(previous.id);
      } else if (isShortcutMatch(event, shortcuts["open-settings"])) {
        event.preventDefault();
        invoke("open_settings_window").catch((err) =>
          console.error("open_settings_window failed:", err)
        );
      } else if (isShortcutMatch(event, shortcuts["lock-vault"])) {
        event.preventDefault();
        vaultLock().catch((err) => console.error("vault_lock failed:", err));
      }
    };

    window.addEventListener("storage", onStorageChanged);
    window.addEventListener("keydown", onKeyDown);

    listen<ShortcutMap>(shortcutsChangedEvent, (event) => {
      applyShortcuts(event.payload);
    })
      .then((unlisten) => {
        if (destroyed) { unlisten(); return; }
        unlistenShortcuts = unlisten;
      })
      .catch(() => {});

    listen("menu-new-terminal", () => {
      newTabRef.current("terminal");
    })
      .then((unlisten) => {
        if (destroyed) { unlisten(); return; }
        unlistenMenuNewTerminal = unlisten;
      })
      .catch(() => {});

    return () => {
      destroyed = true;
      window.removeEventListener("storage", onStorageChanged);
      window.removeEventListener("keydown", onKeyDown);
      unlistenShortcuts?.();
      unlistenMenuNewTerminal?.();
    };
  }, []);

  const tab = tabs.find((t) => t.id === activeTab);

  return (
    <div className="flex h-screen w-screen flex-col bg-background text-foreground">
      <TitleBar
        tabs={tabs}
        activeTab={activeTab}
        onSelect={setActiveTab}
        onClose={closeTab}
        onNew={newTab}
        onRename={renameTab}
        onReorder={reorderTab}
        platform={platform}
      />

      <div className="flex min-h-0 flex-1">
        {/* Render all terminal tabs (keep them mounted) */}
        {tabs.map((t) => 
          t.kind === "terminal" ? (
            <div
              key={t.id}
              style={{ display: t.id === activeTab ? "flex" : "none" }}
              className="min-w-0 flex-1"
            >
              <XTerminal
                sessionId={t.sessionId}
                initialCommand={t.initialCommand}
                hostId={t.hostId}
                readyMarker={t.readyMarker}
                connectionLabel={t.connectionLabel}
                connectionTitle={t.connectionTitle}
                isActive={t.id === activeTab}
                onClose={() => closeTab(t.id)}
                onSessionCreated={(sid) => updateTabSession(t.id, sid)}
              />
            </div>
          ) : null
        )}

        {/* Render all tabs but only show the active one */}
        {tabs.map((t) => 
          t.kind !== "terminal" ? (
            <div
              key={t.id}
              style={{ display: t.id === activeTab ? "flex" : "none" }}
              className="min-w-0 flex-1"
            >
            {t.kind === "vaults" && (
              vaultInfo && !vaultInfo.unlocked ? (
                <VaultGate
                  initialized={vaultInfo.initialized}
                  active={t.id === activeTab}
                  onUnlocked={() => setVaultInfo({ initialized: true, unlocked: true })}
                />
              ) : (
                <>
                  <Sidebar active={activeSidebar} onChange={setActiveSidebar} />
                  <main className="flex min-w-0 flex-1 flex-col">
                    {activeSidebar === "dashboard" && <DashboardView />}
                    {activeSidebar === "hosts" && <HostsView onNewTerminal={() => newTab("terminal")} onNewSftp={(host?) => openSftpSession(host)} onConnectHost={(host) => void openSshTerminal(host)} />}
                    {activeSidebar === "port-forwarding" && <PortForwardingView />}
                    {activeSidebar === "snippets" && <SnippetsView />}
                    {activeSidebar === "ssh-keys" && <SshKeysView />}
                    {activeSidebar === "logs" && (
                      <EmptyState icon={ClipboardList} title="Connection logs" subtitle="Audit of recent sessions, transfers and tunnels." />
                    )}
                  </main>
                </>
              )
            )}
            {t.kind === "sftp" && <SftpView tab={t} />}
          </div>
          ) : null
        )}
      </div>

    </div>
  );
}

/* ---------------- Title bar with tabs ---------------- */

function TitleBar({
  tabs,
  activeTab,
  onSelect,
  onClose,
  onNew,
  onRename,
  onReorder,
  platform,
}: {
  tabs: AppTab[];
  activeTab: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: (kind: TabKind) => void;
  onRename: (id: string, title: string) => void;
  onReorder: (fromId: string, toId: string) => void;
  platform: string;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  // On macOS the green zoom button also enters native fullscreen, which hides the
  // traffic lights — collapse their reserved space then so tabs don't sit in a gap.
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    if (platform !== "macos") return;
    const win = getCurrentWindow();
    void win.isFullscreen().then(setIsFullscreen);
    let unlisten: (() => void) | undefined;
    void win.onResized(() => { void win.isFullscreen().then(setIsFullscreen); }).then((fn) => { unlisten = fn; });
    return () => unlisten?.();
  }, [platform]);

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    onReorder(String(active.id), String(over.id));
  };

  const pinnedTabs = tabs.filter((t) => !t.closable);
  const closableTabs = tabs.filter((t) => t.closable);

  return (
    <div className="flex h-11 shrink-0 items-center border-b border-border bg-[var(--color-surface)] select-none" data-tauri-drag-region>
      {/* Space for native macOS traffic lights — collapses in fullscreen, where they hide */}
      {platform === "macos" && (
        <div
          className="h-full shrink-0 flex items-center overflow-hidden transition-[width] duration-200"
          style={{ width: isFullscreen ? 0 : 80 }}
        />
      )}
      {platform !== "macos" && <div className="w-3 h-full shrink-0" />}

      <div className="flex h-full flex-1 items-end gap-1 overflow-x-auto pl-1" data-tauri-drag-region>
        {/* Pinned tabs (Hosts) — outside DnD, immovable */}
        {pinnedTabs.map((t) => (
          <BaseTabChip
            key={t.id}
            tab={t}
            active={t.id === activeTab}
            onClick={() => onSelect(t.id)}
            onClose={() => onClose(t.id)}
            onRename={(title) => onRename(t.id, title)}
          />
        ))}

        {/* Closable tabs — inside DnD, cannot pass Hosts */}
        <div className="flex flex-1 items-end gap-1" data-tauri-drag-region>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToHorizontalAxis, restrictToParentElement]}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={closableTabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
              {closableTabs.map((t) => (
                <SortableTabChip
                  key={t.id}
                  tab={t}
                  active={t.id === activeTab}
                  onClick={() => onSelect(t.id)}
                  onClose={() => onClose(t.id)}
                  onRename={(title) => onRename(t.id, title)}
                />
              ))}
            </SortableContext>
          </DndContext>

          <button
            onClick={() => onNew("terminal")}
            className="ml-1 mb-1 flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-foreground"
            aria-label="New Local Terminal"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Linux/Windows: hamburger app menu + window controls */}
      {platform !== "macos" && (
        <>
          <AppHamburgerMenu onNew={onNew} />
          <WindowControls />
        </>
      )}
    </div>
  );
}

function AppHamburgerMenu({ onNew }: { onNew: (kind: TabKind) => void }) {
  const win = getCurrentWindow();
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    win.isFullscreen().then(setIsFullscreen).catch(() => {});
    win.onResized(() => {
      win.isFullscreen().then(setIsFullscreen).catch(() => {});
    }).then((fn) => { unlisten = fn; }).catch(() => {});
    return () => { unlisten?.(); };
  }, []);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-foreground self-center mr-1"
          aria-label="App menu"
        >
          <Menu className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-48"
        // On Linux, a fullscreen webview can emit a spurious focus-outside event right after
        // the menu opens (GTK/wry focus quirk), which Radix's dismissable layer otherwise reads
        // as "user focused something else" and closes the menu within a frame of opening it.
        // Ignore focus-outside; real outside clicks (pointerDownOutside) still close it.
        onFocusOutside={(e) => e.preventDefault()}
      >
        <DropdownMenuItem onSelect={() => onNew("terminal")}>
          New Terminal
          <span className="ml-auto text-xs text-muted-foreground">Ctrl+T</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void invoke("open_settings_window")}>
          Settings
          <span className="ml-auto text-xs text-muted-foreground">Ctrl+,</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void vaultLock()}>
          Lock Vault
          <span className="ml-auto text-xs text-muted-foreground">Ctrl+Shift+L</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void win.setFullscreen(!isFullscreen)}>
          {isFullscreen ? "Exit Full Screen" : "Full Screen"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void invoke("quit_app")}>
          Quit
          <span className="ml-auto text-xs text-muted-foreground">Alt+F4</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function WindowControls() {
  const win = getCurrentWindow();
  // Fullscreen and "maximized" are separate window states (most visible on Linux/X11+Wayland).
  // toggleMaximize() while fullscreen produces an inconsistent state — e.g. the window ends up
  // maximized underneath but still rendered fullscreen, or fullscreen won't exit cleanly. So
  // this button exits fullscreen first when active, instead of toggling maximize on top of it.
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void win.isFullscreen().then(setIsFullscreen).catch(() => {});
    void win.onResized(() => {
      void win.isFullscreen().then(setIsFullscreen).catch(() => {});
    }).then((fn) => { unlisten = fn; }).catch(() => {});
    return () => { unlisten?.(); };
  }, [win]);

  return (
    <div className="flex items-center h-full shrink-0">
      <button
        onClick={() => void win.minimize()}
        className="flex h-full w-11 items-center justify-center text-muted-foreground outline-none hover:bg-[var(--color-surface-2)] hover:text-foreground focus:outline-none focus-visible:outline-none transition-colors"
        aria-label="Minimize"
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={() => void (isFullscreen ? win.setFullscreen(false) : win.toggleMaximize())}
        className="flex h-full w-11 items-center justify-center text-muted-foreground outline-none hover:bg-[var(--color-surface-2)] hover:text-foreground focus:outline-none focus-visible:outline-none transition-colors"
        aria-label="Maximize"
      >
        <Square className="h-3 w-3" />
      </button>
      <button
        onClick={() => void win.close()}
        className="flex h-full w-11 items-center justify-center text-muted-foreground outline-none hover:bg-red-500 hover:text-white focus:outline-none focus-visible:outline-none transition-colors"
        aria-label="Close"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/* ---------- Base tab chip (no DnD) ---------- */
interface BaseTabChipProps {
  tab: AppTab;
  active: boolean;
  onClick: () => void;
  onClose: () => void;
  onRename: (title: string) => void;
  style?: React.CSSProperties;
  dragAttributes?: any;
  dragListeners?: any;
  setNodeRef?: (node: HTMLElement | null) => void;
}

const BaseTabChip = forwardRef<HTMLDivElement, BaseTabChipProps>(function BaseTabChip(
  { tab, active, onClick, onClose, onRename, style, dragAttributes, dragListeners, setNodeRef },
  ref
) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tab.title);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = () => {
    const v = draft.trim();
    if (v) onRename(v);
    else setDraft(tab.title);
    setEditing(false);
  };

  const icon =
    tab.kind === "terminal" && tab.hostId ? (
      <Server className="h-3.5 w-3.5 text-[var(--color-brand-orange)]" />
    ) : tab.kind === "terminal" ? (
      <TerminalSquare className="h-3.5 w-3.5 text-[var(--color-brand-green)]" />
    ) : tab.kind === "sftp" ? (
      <Folder className="h-3.5 w-3.5 text-[var(--color-brand-cyan)]" />
    ) : (
      <LayoutGrid className="h-3.5 w-3.5 text-muted-foreground" />
    );

  return (
    <div
      ref={(node) => {
        setNodeRef?.(node);
        if (typeof ref === "function") ref(node);
        else if (ref) (ref as React.MutableRefObject<HTMLElement | null>).current = node;
      }}
      style={style}
      {...(dragAttributes ?? {})}
      {...(tab.closable && !editing ? dragListeners : {})}
      onClick={onClick}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (!tab.closable) return;
        setDraft(tab.title);
        setEditing(true);
      }}
      onAuxClick={(e) => {
        if (e.button === 1 && tab.closable) {
          e.preventDefault();
          onClose();
        }
      }}
      className={[
        "group relative flex h-9 cursor-pointer items-center gap-2 rounded-t-md px-3 text-xs font-medium outline-none",
        active
          ? "bg-[var(--color-tab-active)] text-foreground"
          : "bg-[var(--color-tab-inactive)] text-muted-foreground hover:text-foreground",
      ].join(" ")}
    >
      {icon}
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") {
              setDraft(tab.title);
              setEditing(false);
            }
          }}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          className="h-5 w-24 rounded bg-[var(--color-surface-2)] px-1 text-xs text-foreground outline-none ring-1 ring-ring/40"
        />
      ) : (
        <span className="whitespace-nowrap">{tab.title}</span>
      )}
      {tab.closable && (
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className="flex h-4 w-4 items-center justify-center rounded text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-[var(--color-surface-2)] hover:text-foreground"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
});

/* ---------- Sortable tab chip ---------- */
function SortableTabChip(props: Omit<BaseTabChipProps, "style" | "dragAttributes" | "dragListeners" | "setNodeRef">) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: props.tab.id,
    disabled: !props.tab.closable,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform ? { ...transform, y: 0, scaleX: 1, scaleY: 1 } : null),
    transition,
    opacity: isDragging ? 0.6 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  return (
    <BaseTabChip
      {...props}
      style={style}
      dragAttributes={attributes}
      dragListeners={listeners}
      setNodeRef={setNodeRef}
    />
  );
}


/* ---------------- Sidebar ---------------- */

function Sidebar({ active, onChange }: { active: SidebarKey; onChange: (k: SidebarKey) => void }) {
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-sidebar py-3 text-sidebar-foreground">
      <nav className="flex-1 space-y-0.5 px-2">
        {sidebarItems.map((item) => {
          const Icon = item.icon;
          const isActive = active === item.key;
          return (
            <button
              key={item.key}
              onClick={() => onChange(item.key)}
              className={[
                "flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                isActive
                  ? "bg-[var(--color-sidebar-active)] text-foreground"
                  : "text-sidebar-foreground hover:bg-[var(--color-sidebar-active)]/60 hover:text-foreground",
              ].join(" ")}
            >
              <Icon className="h-4 w-4" />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
      <div className="px-3 pt-3 text-[10px] tracking-wider text-muted-foreground">
        v0.1 · Termifai
      </div>
    </aside>
  );
}

