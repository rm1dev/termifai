import { useState, useRef, useEffect, useCallback, forwardRef } from "react";
import { flushSync } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { platform } from "@/lib/platform";
import { listen } from "@tauri-apps/api/event";
import {
  Server,
  Network,
  Braces,
  ShieldCheck,
  KeyRound,
  Clipboard,
  FileUp,
  FileText,
  Eye,
  EyeOff,
  ClipboardList,
  Plus,
  ChevronDown,
  TerminalSquare,
  Search,
  Tag,
  LayoutGrid,
  List,
  ArrowUpDown,
  CalendarClock,
  X,
  Folder,
  FolderPlus,
  ChevronRight,
  PanelRightOpen,
  Clock,
  Trash2,
  Play,
  Info,
  Lock,
  Settings,
  ChevronDown as ChevronDownIcon,
  LayoutDashboard,
  Activity,
  HardDrive,
  Cpu,
  Download,
  Upload,
  ArrowLeft,
  ArrowDownToLine,
  ArrowUpFromLine,
  Container,
  
  Gauge,
  GripVertical,
  Minus,
  Square,
  Menu,
  Maximize2,
  MoreVertical,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
  RadialBar,
  RadialBarChart,
  PolarAngleAxis,
} from "recharts";
import { OsBadge } from "./icons";
import type { AppTab, Host, HostGroup, LocalFileEntry, RemoteFileEntry, SidebarKey, Snippet, SnippetKind, SnippetVariable, SshKey, TabKind, TransferProgress } from "./types";
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
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  horizontalListSortingStrategy,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { toast } from "sonner";
import { SftpContextMenu } from "./SftpContextMenu";
import { SftpRenameDialog } from "./SftpRenameDialog";
import { SftpPermissionsDialog } from "./SftpPermissionsDialog";

const sidebarItems: { key: SidebarKey; label: string; icon: typeof Server }[] = [
  // { key: "dashboard", label: "Dashboard", icon: LayoutDashboard }, // temporarily hidden
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
    const command = `ssh -v -tt -o StrictHostKeyChecking=no${keyArg}${portArg} ${shellQuote(`${host.user}@${host.hostname}`)} ${shellQuote(remoteBootstrap)}`;

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
          initialPassword: host.password,
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
                initialPassword={t.initialPassword}
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

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    onReorder(String(active.id), String(over.id));
  };

  const pinnedTabs = tabs.filter((t) => !t.closable);
  const closableTabs = tabs.filter((t) => t.closable);

  return (
    <div className="flex h-11 shrink-0 items-center border-b border-border bg-[var(--color-surface)] select-none" data-tauri-drag-region>
      {/* Space for native macOS traffic lights */}
      {platform === "macos" && <div className="w-[80px] h-full shrink-0 flex items-center" />}
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
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onSelect={() => onNew("terminal")}>
          New Terminal
          <span className="ml-auto text-xs text-muted-foreground">Ctrl+T</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void invoke("open_settings_window")}>
          Settings
          <span className="ml-auto text-xs text-muted-foreground">Ctrl+,</span>
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
  return (
    <div className="flex items-center h-full shrink-0">
      <button
        onClick={() => void win.minimize()}
        className="flex h-full w-11 items-center justify-center text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-foreground transition-colors"
        aria-label="Minimize"
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={() => void win.toggleMaximize()}
        className="flex h-full w-11 items-center justify-center text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-foreground transition-colors"
        aria-label="Maximize"
      >
        <Square className="h-3 w-3" />
      </button>
      <button
        onClick={() => void win.close()}
        className="flex h-full w-11 items-center justify-center text-muted-foreground hover:bg-red-500 hover:text-white transition-colors"
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

/* ---------------- Dashboard view ---------------- */

function CircularGauge({ value, label }: { value: number; label: string }) {
  const r = 24;
  const c = 2 * Math.PI * r;
  const offset = c - (value / 100) * c;
  const baseColor = label === "RAM" ? "var(--color-brand-yellow)" : "var(--color-brand-cyan)";
  const strokeColor = value >= 90 ? "var(--color-brand-red)" : value >= 80 ? "var(--color-brand-orange)" : baseColor;
  return (
    <div className="flex w-16 flex-col items-center gap-1">
      <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
      <div className="relative flex h-14 w-14 items-center justify-center">
        <svg width="56" height="56" viewBox="0 0 56 56" className="absolute inset-0 -rotate-90">
        <circle cx="28" cy="28" r={r} stroke="var(--color-border)" strokeWidth="5" fill="none" />
        <circle
          cx="28"
          cy="28"
          r={r}
          stroke={strokeColor}
          strokeWidth="5"
          fill="none"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 0.5s ease" }}
        />
      </svg>
        <span className="relative z-10 text-sm font-bold leading-none text-foreground">{value}%</span>
      </div>
    </div>
  );
}

function RingGauge({
  value,
  label,
  gradientId,
  from,
  to,
  size = 56,
  stroke = 6,
}: {
  value: number;
  label: string;
  gradientId: string;
  from: string;
  to: string;
  size?: number;
  stroke?: number;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, value));
  const offset = c - (pct / 100) * c;
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-[9px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </span>
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
          <defs>
            <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor={from} />
              <stop offset="100%" stopColor={to} />
            </linearGradient>
          </defs>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            stroke="color-mix(in oklab, var(--color-border) 70%, transparent)"
            strokeWidth={stroke}
            fill="none"
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            stroke={`url(#${gradientId})`}
            strokeWidth={stroke}
            fill="none"
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={offset}
            style={{ transition: "stroke-dashoffset 0.6s ease" }}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="font-mono text-[13px] font-bold tabular-nums text-foreground">
            {Math.round(pct)}
            <span className="text-[9px] text-muted-foreground">%</span>
          </span>
        </div>
      </div>
    </div>
  );
}

function IoStat({
  label,
  rows,
}: {
  label: string;
  rows: { icon: React.ComponentType<{ className?: string }>; value: string; unit: string; letter?: string }[];
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="text-[9px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </span>
      <div className="flex flex-col gap-0.5">
        {rows.map((r, i) => {
          const Icon = r.icon;
          return (
            <div key={i} className="flex items-center gap-1.5 font-mono tabular-nums">
              {r.letter ? (
                <span className="flex h-3 w-3 items-center justify-center rounded-full border border-border text-[7px] font-bold text-muted-foreground">
                  {r.letter}
                </span>
              ) : (
                <Icon className="h-2.5 w-2.5 text-muted-foreground" />
              )}
              <span className="text-[11px] font-bold text-foreground">{r.value}</span>
              <span className="text-[9px] text-muted-foreground">{r.unit}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}





type ServerStat = {
  id: string;
  name: string;
  status: "online" | "error";
  cores: number;
  ram: string;
  storage: string;
  uptime: string;
  cpu: number;
  ramUsed: number;
  diskUsed: number;
  os: string;
  ip: string;
  netDown: string; netDownUnit: string;
  netUp: string; netUpUnit: string;
  diskRead: string; diskReadUnit: string;
  diskWrite: string; diskWriteUnit: string;
  cpuSamples?: number[];
};

const DASHBOARD_SERVERS: ServerStat[] = [
  { id: "h1", name: "Sentry", status: "online", cores: 8, ram: "126 G", storage: "111 G", uptime: "23 Days", cpu: 14, ramUsed: 40, diskUsed: 52, os: "Ubuntu 22.04 LTS", ip: "10.0.0.11/24", cpuSamples: [4, 22, 9, 31, 6, 18, 11, 12],
    netDown: "151", netDownUnit: "K/s", netUp: "11.1", netUpUnit: "K/s", diskRead: "0", diskReadUnit: "B/s", diskWrite: "0", diskWriteUnit: "B/s" },
  { id: "h2", name: "Ariyapanel Bot", status: "error", cores: 8, ram: "0 B", storage: "0 B", uptime: "0 Minutes", cpu: 0, ramUsed: 0, diskUsed: 0, os: "Debian 11", ip: "—", cpuSamples: [0, 0, 0, 0, 0, 0, 0, 0],
    netDown: "0", netDownUnit: "B/s", netUp: "0", netUpUnit: "B/s", diskRead: "0", diskReadUnit: "B/s", diskWrite: "0", diskWriteUnit: "B/s" },
  { id: "h3", name: "AriyaPanel Monitoring", status: "online", cores: 8, ram: "2.90 G", storage: "26.2 G", uptime: "134 Days", cpu: 68, ramUsed: 74, diskUsed: 60, os: "Debian 11", ip: "192.168.90.198/24", cpuSamples: [82, 47, 91, 55, 73, 38, 88, 70],
    netDown: "31.6", netDownUnit: "K/s", netUp: "9.99", netUpUnit: "K/s", diskRead: "1.30", diskReadUnit: "M/s", diskWrite: "0", diskWriteUnit: "B/s" },
  { id: "h4", name: "AriyaPanel DB", status: "online", cores: 8, ram: "19.6 G", storage: "299 G", uptime: "167 Days", cpu: 23, ramUsed: 82, diskUsed: 71, os: "Ubuntu 20.04", ip: "192.168.90.200/24", cpuSamples: [12, 34, 8, 41, 18, 27, 15, 29],
    netDown: "401", netDownUnit: "K/s", netUp: "165", netUpUnit: "K/s", diskRead: "188", diskReadUnit: "K/s", diskWrite: "380", diskWriteUnit: "K/s" },
  { id: "h5", name: "AriyaPanel Elastic", status: "online", cores: 8, ram: "15.6 G", storage: "92.0 G", uptime: "210 Days", cpu: 53, ramUsed: 63, diskUsed: 86, os: "Debian GNU/Linux 11 (bullseye)", ip: "192.168.90.199/24", cpuSamples: [94, 96, 10, 19, 48, 99, 95, 5],
    netDown: "10.9", netDownUnit: "K/s", netUp: "10.8", netUpUnit: "K/s", diskRead: "0", diskReadUnit: "B/s", diskWrite: "192", diskWriteUnit: "K/s" },
  { id: "h6", name: "AriyaPanel", status: "online", cores: 8, ram: "17.5 G", storage: "44.5 G", uptime: "210 Days", cpu: 37, ramUsed: 21, diskUsed: 44, os: "Ubuntu 22.04", ip: "192.168.90.201/24", cpuSamples: [21, 64, 18, 52, 33, 47, 25, 39],
    netDown: "25", netDownUnit: "K/s", netUp: "07", netUpUnit: "K/s", diskRead: "0", diskReadUnit: "B/s", diskWrite: "8.0", diskWriteUnit: "K/s" },
];

function DashboardView() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = DASHBOARD_SERVERS.find((s) => s.id === selectedId) ?? null;

  if (selected) {
    return <HostDashboardView host={selected} onBack={() => setSelectedId(null)} />;
  }

  const servers = DASHBOARD_SERVERS;
  const total = servers.length;
  const online = servers.filter((s) => s.status === "online").length;
  const offline = servers.filter((s) => s.status === "error").length;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-5">
      {/* Summary stats */}
      <div className="mb-5 grid grid-cols-3 gap-4">
        <div className="rounded-xl border border-border bg-[var(--color-surface)] p-4">
          <div className="text-xs text-muted-foreground">Total Servers</div>
          <div className="mt-1 flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-[oklch(0.65_0.15_230)]" />
            <span className="text-xl font-bold text-foreground">{total}</span>
          </div>
        </div>
        <div className="rounded-xl border border-border bg-[var(--color-surface)] p-4">
          <div className="text-xs text-muted-foreground">Online Servers</div>
          <div className="mt-1 flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-[oklch(0.65_0.18_145)]" />
            <span className="text-xl font-bold text-foreground">{online}</span>
          </div>
        </div>
        <div className="rounded-xl border border-border bg-[var(--color-surface)] p-4">
          <div className="text-xs text-muted-foreground">Offline Servers</div>
          <div className="mt-1 flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-[oklch(0.65_0.2_25)]" />
            <span className="text-xl font-bold text-foreground">{offline}</span>
          </div>
        </div>
      </div>

      {/* Server cards */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {servers.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setSelectedId(s.id)}
            className="rounded-xl border border-border bg-[var(--color-surface)] p-4 text-left transition hover:border-primary/60 hover:bg-[var(--color-surface)]/80 focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            {/* Header */}
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-foreground">{s.name}</span>
              <div className="flex items-center gap-1.5">
                <span className={`h-2 w-2 rounded-full ${s.status === "online" ? "bg-[oklch(0.65_0.18_145)]" : "bg-[oklch(0.65_0.2_25)]"}`} />
                <span className="text-xs text-muted-foreground">{s.status === "online" ? "Online" : "Error"}</span>
              </div>
            </div>

            {/* Specs */}
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1"><Cpu className="h-3 w-3" /> {s.cores} Cores</span>
              <span className="flex items-center gap-1"><Activity className="h-3 w-3" /> {s.ram}</span>
              <span className="flex items-center gap-1"><HardDrive className="h-3 w-3" /> {s.storage}</span>
              <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> {s.uptime}</span>
            </div>

            {/* Gauges & Stats */}
            <div className="mt-4 flex items-start gap-6">
              <CircularGauge value={s.cpu} label="CPU" />
              <CircularGauge value={s.ramUsed} label="RAM" />

              <div className="flex flex-1 flex-col justify-center gap-2 pt-1">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Network</div>
                <div className="flex items-center gap-3 text-[11px] text-foreground">
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-1.5 w-1.5 rounded-full border border-muted-foreground" />
                    {s.netDown} {s.netDownUnit}
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-1.5 w-1.5 rounded-full border border-muted-foreground opacity-50" />
                    {s.netUp} {s.netUpUnit}
                  </span>
                </div>
              </div>

              <div className="flex flex-1 flex-col justify-center gap-2 pt-1">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Disk</div>
                <div className="flex items-center gap-3 text-[11px] text-foreground">
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-1.5 w-1.5 rounded-full border border-muted-foreground" />
                    {s.diskRead} {s.diskReadUnit}
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-1.5 w-1.5 rounded-full border border-muted-foreground opacity-50" />
                    {s.diskWrite} {s.diskWriteUnit}
                  </span>
                </div>
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---------------- Host detail dashboard ---------------- */

function thresholdColor(value: number, base: string) {
  if (value >= 90) return "var(--color-brand-red)";
  if (value >= 80) return "var(--color-brand-orange)";
  return base;
}

function RadialGauge({
  value,
  label,
  color,
  size = 84,
}: {
  value: number;
  label: string;
  color: string;
  size?: number;
}) {
  const displayValue = Math.round(value);
  const fill = thresholdColor(value, color);
  const data = [{ name: label, value: displayValue, fill }];
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative" style={{ width: size, height: size }}>
        <ResponsiveContainer width="100%" height="100%">
          <RadialBarChart
            innerRadius="72%"
            outerRadius="100%"
            barSize={8}
            data={data}
            startAngle={90}
            endAngle={-270}
          >
            <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
            <RadialBar background={{ fill: "hsl(var(--muted) / 0.4)" }} dataKey="value" cornerRadius={8} />
          </RadialBarChart>
        </ResponsiveContainer>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-sm font-bold tabular-nums text-foreground">{displayValue}%</span>
        </div>
      </div>
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
    </div>
  );
}

type CpuCategory = "user" | "system" | "nice" | "iowait" | "steal";
type CpuThread = Record<CpuCategory, number>;

const CPU_CATEGORIES: { key: CpuCategory; label: string; color: string }[] = [
  { key: "user", label: "User", color: "var(--color-brand-cyan)" },
  { key: "system", label: "System", color: "var(--color-brand-red)" },
  { key: "nice", label: "Nice", color: "var(--color-brand-green)" },
  { key: "iowait", label: "IOWait", color: "var(--color-primary)" },
  { key: "steal", label: "Steal", color: "var(--color-brand-orange)" },
];

function buildCpuData(samples: number[], cores: number) {
  const list = Array.from({ length: cores }, (_, i) => samples[i] ?? samples[i % Math.max(samples.length, 1)] ?? 0);
  const threads: CpuThread[] = list.map((p, i) => {
    const total = Math.max(0, Math.min(100, p));
    // deterministic split — mostly user, a touch of system, sparse spikes
    const system = total > 0 ? Math.min(total, Math.round(total * 0.05) + ((i * 7) % 11 === 0 ? 3 : 0)) : 0;
    const iowait = total > 25 && (i * 5) % 17 === 0 ? 1 : 0;
    const steal = 0;
    const nice = 0;
    const user = Math.max(0, total - system - iowait - steal - nice);
    return { user, system, nice, iowait, steal };
  });
  const sum = (k: CpuCategory) => threads.reduce((a, t) => a + t[k], 0) / threads.length;
  const breakdown: Record<CpuCategory, number> = {
    user: sum("user"),
    system: sum("system"),
    nice: sum("nice"),
    iowait: sum("iowait"),
    steal: sum("steal"),
  };
  const total = breakdown.user + breakdown.system + breakdown.nice + breakdown.iowait + breakdown.steal;
  return { threads, breakdown, total };
}

function useColumnCount(blockWidth = 8, gap = 2) {
  const ref = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(60);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      const next = Math.max(10, Math.floor((w + gap) / (blockWidth + gap)));
      setCols(next);
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [blockWidth, gap]);
  return { ref, cols };
}

function CpuThreadRow({ thread }: { thread: CpuThread }) {
  const { ref, cols } = useColumnCount(6, 1);
  const total = thread.user + thread.system + thread.nice + thread.iowait + thread.steal;
  const filled = Math.round((total / 100) * cols);
  // allocate per-category counts using largest-remainder so ordering stays User→System→Nice→IOWait→Steal
  const raw = CPU_CATEGORIES.map((c) => ({ key: c.key, color: c.color, exact: (thread[c.key] / 100) * cols }));
  const counts = raw.map((r) => ({ ...r, n: Math.floor(r.exact), rem: r.exact - Math.floor(r.exact) }));
  let assigned = counts.reduce((a, c) => a + c.n, 0);
  const remainders = [...counts].sort((a, b) => b.rem - a.rem);
  let ri = 0;
  while (assigned < filled && ri < remainders.length) {
    const target = counts.find((c) => c.key === remainders[ri].key)!;
    if (target.exact > 0) target.n += 1;
    assigned += 1;
    ri += 1;
  }
  const blocks: string[] = [];
  for (const c of counts) for (let i = 0; i < c.n; i++) blocks.push(c.color);
  while (blocks.length < filled) blocks.push("var(--color-brand-cyan)");
  blocks.length = Math.min(blocks.length, cols);

  return (
    <div className="flex items-center gap-2">
      <div ref={ref} className="flex flex-1 gap-[1px] overflow-hidden">
        {Array.from({ length: cols }).map((_, i) => (
          <span
            key={i}
            className="h-[10px] w-[6px] shrink-0 rounded-[1px]"
            style={{
              background: i < blocks.length ? blocks[i] : "var(--color-border)",
              opacity: i < blocks.length ? 1 : 0.4,
            }}
          />
        ))}
      </div>
      <span className="w-9 text-right text-[10px] font-semibold tabular-nums text-foreground">
        {Math.round(total)}%
      </span>
    </div>
  );
}

function CpuUsageChart({ samples, cores, model }: { samples: number[]; cores: number; model: string }) {
  const [open, setOpen] = useState(false);
  const data = buildCpuData(samples, cores);
  const { ref, cols } = useColumnCount(6, 1);

  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-[var(--color-surface)] p-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 text-left"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 text-sm font-semibold" style={{ color: "var(--color-brand-cyan)" }}>
          <Cpu className="h-4 w-4" />
          CPU Usage
        </span>
        <ChevronRight
          className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="ml-auto truncate font-mono text-[10px] text-muted-foreground">{model}</span>
      </button>

      <div className="mt-3 flex items-baseline gap-2">
        <span className="text-3xl font-bold tabular-nums leading-none text-foreground">
          {Math.round(data.total)}
        </span>
        <span className="text-sm font-medium text-muted-foreground">%</span>
      </div>

      {/* always-visible single-line overall load bar */}
      <div ref={ref} className="mt-3 flex gap-[1px] overflow-hidden">
        {(() => {
          const raw = CPU_CATEGORIES.map((c) => ({ color: c.color, exact: (data.breakdown[c.key] / 100) * cols }));
          const counts = raw.map((r) => ({ ...r, n: Math.floor(r.exact), rem: r.exact - Math.floor(r.exact) }));
          const filled = Math.round((data.total / 100) * cols);
          let assigned = counts.reduce((a, c) => a + c.n, 0);
          const order = counts.map((_, i) => i).sort((a, b) => counts[b].rem - counts[a].rem);
          let ri = 0;
          while (assigned < filled && ri < order.length) {
            if (counts[order[ri]].exact > 0) counts[order[ri]].n += 1;
            assigned += 1;
            ri += 1;
          }
          const blocks: string[] = [];
          for (const c of counts) for (let i = 0; i < c.n; i++) blocks.push(c.color);
          return Array.from({ length: cols }).map((_, i) => (
            <span
              key={i}
              className="h-[10px] w-[6px] shrink-0 rounded-[1px]"
              style={{
                background: i < blocks.length ? blocks[i] : "var(--color-border)",
                opacity: i < blocks.length ? 1 : 0.4,
              }}
            />
          ));
        })()}
      </div>

      {open && (
        <div className="mt-3 space-y-1 border-t border-border pt-3">
          {data.threads.map((t, i) => (
            <CpuThreadRow key={i} thread={t} />
          ))}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-border pt-3 text-[11px]">
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground">Cores</span>
          <span className="font-mono font-bold tabular-nums text-foreground">{cores}</span>
        </div>
        {CPU_CATEGORIES.map((c) => (
          <div key={c.key} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm" style={{ background: c.color }} />
            <span className="text-muted-foreground">{c.label}</span>
            <span className="font-mono font-bold tabular-nums text-foreground">
              {Math.round(data.breakdown[c.key])}%
            </span>
          </div>
        ))}
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm" style={{ background: "var(--color-border)" }} />
          <span className="text-muted-foreground">Idle</span>
          <span className="font-mono font-bold tabular-nums text-foreground">
            {Math.max(0, Math.round(100 - data.total))}%
          </span>
        </div>
      </div>
    </section>
  );
}

function PanelHeader({
  icon: Icon,
  title,
  color,
  action,
}: {
  icon: typeof Server;
  title: string;
  color: string;
  action?: React.ReactNode;
}) {
  return (
    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
      <CardTitle className="flex items-center gap-2 text-sm font-semibold" style={{ color }}>
        <Icon className="h-4 w-4" />
        {title}
      </CardTitle>
      {action}
    </CardHeader>
  );
}

const loadSeries = Array.from({ length: 32 }).map((_, i) => ({
  t: i,
  m1: 5.4 + Math.sin(i / 3) * 0.6 + Math.random() * 0.2,
  m5: 5.6 + Math.sin(i / 5) * 0.4,
  m15: 5.5 + Math.cos(i / 6) * 0.3,
}));

function MiniGauge({
  value,
  label,
  color,
}: {
  value: number;
  label: string;
  color: string;
}) {
  const display = Math.round(value);
  const fill = thresholdColor(value, color);
  const circumference = 2 * Math.PI * 18;
  const offset = circumference - (display / 100) * circumference;
  return (
    <div className="flex items-center gap-2.5">
      <div className="relative h-11 w-11">
        <svg viewBox="0 0 44 44" className="-rotate-90">
          <circle cx="22" cy="22" r="18" fill="none" stroke="var(--color-border)" strokeWidth="3" opacity="0.5" />
          <circle
            cx="22"
            cy="22"
            r="18"
            fill="none"
            stroke={fill}
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            style={{ transition: "stroke-dashoffset 400ms ease, stroke 200ms" }}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center text-[10px] font-bold tabular-nums text-foreground">
          {display}
        </div>
      </div>
      <div>
        <div className="text-[9px] font-bold uppercase tracking-[0.12em] text-muted-foreground">{label}</div>
        <div className="text-[11px] font-semibold tabular-nums text-foreground">{display}%</div>
      </div>
    </div>
  );
}

function SectionLabel({
  color,
  icon: Icon,
  title,
  subtitle,
  action,
}: {
  color: string;
  icon: typeof Server;
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex items-end justify-between gap-3">
      <div className="flex items-center gap-2.5">
        <span className="h-4 w-[3px] rounded-full" style={{ background: color }} />
        <Icon className="h-3.5 w-3.5" style={{ color }} />
        <h3 className="text-[12px] font-bold uppercase tracking-[0.14em] text-foreground">{title}</h3>
        {subtitle && (
          <span className="text-[10px] font-medium text-muted-foreground">· {subtitle}</span>
        )}
      </div>
      {action}
    </div>
  );
}

function HostDashboardView({ host, onBack }: { host: ServerStat; onBack: () => void }) {
  const processes = [
    { pid: 516654, name: "java", user: "elastic", cpu: 327.0, mem: "498 M" },
    { pid: 1747, name: "node", user: "elastic", cpu: 4.0, mem: "348 M" },
    { pid: 760, name: "dockerd", user: "root", cpu: 1.2, mem: "83.2 M" },
    { pid: 77, name: "kcompactd0", user: "root", cpu: 0.9, mem: "0 B" },
    { pid: 364, name: "jbd2/sda1-8", user: "root", cpu: 0.9, mem: "0 B" },
    { pid: 664, name: "containerd", user: "root", cpu: 0.8, mem: "32.9 M" },
    { pid: 3151640, name: "sshd", user: "root", cpu: 0.3, mem: "8.43 M" },
    { pid: 12, name: "rcu_sched", user: "root", cpu: 0.2, mem: "0 B" },
    { pid: 1, name: "systemd", user: "root", cpu: 0.1, mem: "5.70 M" },
    { pid: 592, name: "vmtoolsd", user: "root", cpu: 0.1, mem: "5.02 M" },
    { pid: 1722, name: "java", user: "elastic", cpu: 0.1, mem: "16.1 M" },
    { pid: 473386, name: "kworker/1:2-eve", user: "root", cpu: 0.1, mem: "0 B" },
    { pid: 516634, name: "containerd-shim", user: "root", cpu: 0.1, mem: "9.23 M" },
  ];

  const containers = [
    { name: "docker-elk-kibana-1", status: "up", uptime: "7 months", cpu: 0, ram: 2, netRx: "228", netRxUnit: "G", netTx: "408", netTxUnit: "G", ioRead: "885", ioReadUnit: "M", ioWrite: "79.5", ioWriteUnit: "M" },
    { name: "docker-elk-logstash-1", status: "up", uptime: "1 second", cpu: 20, ram: 0, netRx: "12.4", netRxUnit: "M", netTx: "3.10", netTxUnit: "M", ioRead: "104", ioReadUnit: "M", ioWrite: "8.20", ioWriteUnit: "M" },
    { name: "docker-elk-elasticsearch-1", status: "up", uptime: "7 months", cpu: 14, ram: 65, netRx: "1.20", netRxUnit: "T", netTx: "980", netTxUnit: "G", ioRead: "2.40", ioReadUnit: "G", ioWrite: "1.10", ioWriteUnit: "G" },
    { name: "docker-elk-setup-1", status: "exited", uptime: "7 months ago", cpu: 0, ram: 0, netRx: "0", netRxUnit: "B", netTx: "0", netTxUnit: "B", ioRead: "0", ioReadUnit: "B", ioWrite: "0", ioWriteUnit: "B" },
  ];

  const memUsed = 9.99;
  const memCached = 4.87;
  const memTotal = 15.6;
  const memFree = Math.max(memTotal - memUsed - memCached, 0);
  const memData = [
    { name: "Used", value: memUsed, fill: "oklch(0.7 0.28 320)" },
    { name: "Cached", value: memCached, fill: "oklch(0.55 0.18 320)" },
    { name: "Free", value: memFree, fill: "var(--color-border)" },
  ];

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-[1400px] space-y-5 p-6">
        {/* ─── HERO IDENTITY BAR ───────────────────────────────────── */}
        <header className="relative overflow-hidden rounded-2xl border border-border bg-[var(--color-surface)] p-5">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-px"
            style={{
              background:
                "linear-gradient(90deg, transparent, color-mix(in oklab, var(--color-brand-cyan) 40%, transparent), transparent)",
            }}
          />
          <div className="flex flex-wrap items-center justify-between gap-6">
            <div className="flex items-center gap-4">
              <Button
                variant="outline"
                size="icon"
                className="h-9 w-9 shrink-0 border-border bg-background"
                onClick={onBack}
                aria-label="Back"
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>

              <div
                className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border border-border bg-background shadow-inner"
                style={{
                  boxShadow:
                    "inset 0 1px 0 color-mix(in oklab, var(--color-brand-cyan) 12%, transparent), 0 0 24px color-mix(in oklab, var(--color-brand-cyan) 8%, transparent)",
                }}
              >
                <Server className="h-6 w-6" style={{ color: "var(--color-brand-cyan)" }} />
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center gap-2.5">
                  <h1 className="text-xl font-bold tracking-tight text-foreground">{host.name}</h1>
                  <Badge
                    variant="secondary"
                    className="border border-[color-mix(in_oklab,var(--color-brand-orange)_25%,transparent)] bg-[color-mix(in_oklab,var(--color-brand-orange)_12%,transparent)] px-2 py-0 text-[10px] font-bold uppercase tracking-wider text-[var(--color-brand-orange)] hover:bg-[color-mix(in_oklab,var(--color-brand-orange)_12%,transparent)]"
                  >
                    {host.os}
                  </Badge>
                  <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                    <span className="relative flex h-1.5 w-1.5">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--color-brand-green)] opacity-60" />
                      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--color-brand-green)]" />
                    </span>
                    Online
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                  <span className="font-mono tabular-nums text-foreground/80">{host.ip}</span>
                  <span className="h-1 w-1 rounded-full bg-border" />
                  <span>
                    <span className="text-muted-foreground/70">Uptime</span>{" "}
                    <span className="font-mono tabular-nums text-foreground/80">14d 2h 12m</span>
                  </span>
                  <span className="h-1 w-1 rounded-full bg-border" />
                  <span>
                    <span className="text-muted-foreground/70">Cores</span>{" "}
                    <span className="font-mono tabular-nums text-foreground/80">{host.cores}</span>
                  </span>
                  <span className="h-1 w-1 rounded-full bg-border" />
                  <span>
                    <span className="text-muted-foreground/70">RAM</span>{" "}
                    <span className="font-mono tabular-nums text-foreground/80">{memTotal} GB</span>
                  </span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-5 rounded-xl border border-border bg-background/60 px-4 py-2.5">
              <MiniGauge value={host.cpu} label="CPU" color="var(--color-brand-cyan)" />
              <span className="h-9 w-px bg-border" />
              <MiniGauge value={host.ramUsed} label="RAM" color="oklch(0.7 0.28 320)" />
              <span className="h-9 w-px bg-border" />
              <MiniGauge value={host.diskUsed} label="Disk" color="var(--color-brand-yellow)" />
            </div>
          </div>
        </header>

        {/* ─── CPU USAGE ──────────────────────────────────────────── */}
        <CpuUsageChart
          samples={host.cpuSamples ?? [host.cpu]}
          cores={host.cores}
          model="Intel(R) Xeon(R) CPU E5-2650 v3 @ 2.30GHz"
        />

        {/* ─── CPU LOAD CHART + PROCESSES ─────────────────────────── */}
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
          <section className="flex flex-col rounded-2xl border border-border bg-[var(--color-surface)] p-5 lg:col-span-7">
            <SectionLabel
              color="var(--color-brand-yellow)"
              icon={Activity}
              title="CPU Load Average"
              action={
                <div className="flex gap-3 text-[11px]">
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-[var(--color-brand-red)]" />
                    <span className="text-muted-foreground">1m</span>
                    <span className="font-mono font-bold tabular-nums text-foreground">5.50</span>
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-[var(--color-brand-cyan)]" />
                    <span className="text-muted-foreground">5m</span>
                    <span className="font-mono font-bold tabular-nums text-foreground">5.71</span>
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-[var(--color-brand-yellow)]" />
                    <span className="text-muted-foreground">15m</span>
                    <span className="font-mono font-bold tabular-nums text-foreground">5.58</span>
                  </span>
                </div>
              }
            />
            <div className="flex-1 min-h-0 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={loadSeries} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="g1m" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--color-brand-red)" stopOpacity={0.45} />
                      <stop offset="100%" stopColor="var(--color-brand-red)" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="g5m" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--color-brand-cyan)" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="var(--color-brand-cyan)" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="g15m" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="oklch(0.85 0.17 95)" stopOpacity={0.18} />
                      <stop offset="100%" stopColor="oklch(0.85 0.17 95)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="2 4" stroke="var(--color-border)" vertical={false} />
                  <XAxis
                    dataKey="t"
                    tick={{ fontSize: 9, fill: "var(--color-muted-foreground)" }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 9, fill: "var(--color-muted-foreground)" }}
                    tickLine={false}
                    axisLine={false}
                    width={28}
                  />
                  <RTooltip
                    contentStyle={{
                      background: "var(--color-surface)",
                      border: "1px solid var(--color-border)",
                      borderRadius: 8,
                      fontSize: 11,
                    }}
                  />
                  <Area type="monotone" dataKey="m1" stroke="var(--color-brand-red)" fill="url(#g1m)" strokeWidth={2} />
                  <Area type="monotone" dataKey="m5" stroke="var(--color-brand-cyan)" fill="url(#g5m)" strokeWidth={2} />
                  <Area type="monotone" dataKey="m15" stroke="var(--color-brand-yellow)" fill="url(#g15m)" strokeWidth={1.5} strokeDasharray="3 3" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="overflow-hidden rounded-2xl border border-border bg-[var(--color-surface)] lg:col-span-5">
            <div className="px-4 pt-4 pb-2">
              <SectionLabel
                color="var(--color-brand-red)"
                icon={List}
                title="Top Processes"
                action={
                  <button className="text-[11px] font-medium text-[var(--color-brand-cyan)] hover:underline">
                    View all
                  </button>
                }
              />
            </div>
            <ScrollArea className="h-[230px]">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-[var(--color-surface)] backdrop-blur">
                  <TableRow className="border-border hover:bg-transparent">
                    <TableHead className="h-6 px-3 text-[9px] font-bold uppercase tracking-wider text-muted-foreground">Process</TableHead>
                    <TableHead className="h-6 text-[9px] font-bold uppercase tracking-wider text-muted-foreground">User</TableHead>
                    <TableHead className="h-6 text-right text-[9px] font-bold uppercase tracking-wider text-muted-foreground">CPU%</TableHead>
                    <TableHead className="h-6 px-3 text-right text-[9px] font-bold uppercase tracking-wider text-muted-foreground">Mem</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {processes.map((p) => {
                    const isHot = p.cpu >= 100;
                    const isWarm = p.cpu >= 4 && p.cpu < 100;
                    return (
                      <TableRow key={p.pid} className="border-border/60 text-[10.5px]">
                        <TableCell className="px-3 py-1">
                          <div className="font-medium leading-tight text-foreground">{p.name}</div>
                          <div className="font-mono text-[9px] leading-tight text-muted-foreground/60">{p.pid}</div>
                        </TableCell>
                        <TableCell className="py-1 font-mono text-muted-foreground">{p.user}</TableCell>
                        <TableCell
                          className="py-1 text-right font-mono font-bold tabular-nums"
                          style={{
                            color: isHot
                              ? "var(--color-brand-red)"
                              : isWarm
                                ? "var(--color-brand-yellow)"
                                : "var(--color-brand-cyan)",
                          }}
                        >
                          {p.cpu.toFixed(1)}
                        </TableCell>
                        <TableCell className="px-3 py-1 text-right font-mono tabular-nums text-foreground/80">{p.mem}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </ScrollArea>
          </section>

        </div>

        {/* ─── MEMORY · NETWORK · STORAGE BENTO ───────────────────── */}
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          {/* Memory */}
          <section className="rounded-2xl border border-border bg-[var(--color-surface)] p-5">
            <SectionLabel color="oklch(0.7 0.28 320)" icon={Activity} title="Memory" />
            <div className="flex items-center gap-5">
              <div className="relative h-[120px] w-[120px] shrink-0">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={memData} dataKey="value" innerRadius={42} outerRadius={56} paddingAngle={3} stroke="none">
                      {memData.map((d) => <Cell key={d.name} fill={d.fill} />)}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">Used</span>
                  <span className="text-lg font-bold tabular-nums text-foreground">64%</span>
                </div>
              </div>
              <div className="flex-1 space-y-2.5 text-[11px]">
                {[
                  { c: "oklch(0.7 0.28 320)", v: `${memUsed} G`, l: "Used" },
                  { c: "oklch(0.55 0.18 320)", v: `${memCached} G`, l: "Cached" },
                  { c: "var(--color-border)", v: `${memFree.toFixed(2)} G`, l: "Free" },
                ].map((row) => (
                  <div key={row.l} className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2">
                      <span className="h-2.5 w-2.5 rounded-sm" style={{ background: row.c }} />
                      <span className="text-muted-foreground">{row.l}</span>
                    </span>
                    <span className="font-mono font-bold tabular-nums text-foreground">{row.v}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="mt-4 border-t border-border pt-3">
              <div className="mb-1.5 flex justify-between text-[11px]">
                <span className="font-medium text-foreground">Swap</span>
                <span className="font-mono tabular-nums text-muted-foreground">949 M / 975 M</span>
              </div>
              <Progress value={97} className="h-1.5 [&>div]:bg-[oklch(0.7_0.28_320)]" />
            </div>
          </section>

          {/* Network */}
          <section className="rounded-2xl border border-border bg-[var(--color-surface)] p-5">
            <SectionLabel
              color="var(--color-brand-orange)"
              icon={Network}
              title="Network I/O"
              action={<span className="font-mono text-[10px] text-muted-foreground">ens192</span>}
            />
            <div className="space-y-4">
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="flex items-center gap-2 text-[11px]">
                    <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[color-mix(in_oklab,var(--color-brand-green)_15%,transparent)]">
                      <Download className="h-3 w-3 text-[var(--color-brand-green)]" />
                    </span>
                    <span className="font-medium text-foreground">Inbound</span>
                  </span>
                  <span className="font-mono text-[12px] font-bold tabular-nums text-[var(--color-brand-green)]">
                    570 K/s
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-border/60">
                  <div className="h-full rounded-full bg-[var(--color-brand-green)]" style={{ width: "40%" }} />
                </div>
                <div className="mt-1 text-right font-mono text-[10px] text-muted-foreground">Total ↓ 1.32 T</div>
              </div>
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="flex items-center gap-2 text-[11px]">
                    <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[color-mix(in_oklab,var(--color-brand-orange)_15%,transparent)]">
                      <Upload className="h-3 w-3 text-[var(--color-brand-orange)]" />
                    </span>
                    <span className="font-medium text-foreground">Outbound</span>
                  </span>
                  <span className="font-mono text-[12px] font-bold tabular-nums text-[var(--color-brand-orange)]">
                    122 K/s
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-border/60">
                  <div className="h-full rounded-full bg-[var(--color-brand-orange)]" style={{ width: "12%" }} />
                </div>
                <div className="mt-1 text-right font-mono text-[10px] text-muted-foreground">Total ↑ 644 G</div>
              </div>
            </div>
            <div className="mt-4 flex items-center justify-between border-t border-border pt-3 text-[11px]">
              <span className="text-muted-foreground">IP Address</span>
              <span className="font-mono font-bold tabular-nums text-foreground">{host.ip}</span>
            </div>
          </section>

          {/* Storage */}
          <section className="rounded-2xl border border-border bg-[var(--color-surface)] p-4">
            <SectionLabel
              color="var(--color-brand-green)"
              icon={HardDrive}
              title="Storage"
            />
            <div className="mt-2 flex items-center gap-3">
              <RingGauge
                value={host.diskUsed}
                label="DISK"
                gradientId="g-disk"
                from="oklch(0.78 0.16 150)"
                to="oklch(0.62 0.18 145)"
                size={52}
                stroke={5}
              />
              <div className="flex-1 space-y-1.5">
                <div className="font-mono text-[10px] text-muted-foreground">/dev/sda1 · ext4</div>
                <div className="flex items-baseline gap-1.5">
                  <span className="text-xl font-bold tabular-nums text-foreground">{host.diskUsed}</span>
                  <span className="text-[10px] text-muted-foreground">%</span>
                  <span className="ml-auto font-mono text-[10px] tabular-nums text-muted-foreground">
                    79.5 G / 92.0 G
                  </span>
                </div>
                <Progress
                  value={host.diskUsed}
                  className="h-1 [&>div]:bg-[var(--color-brand-green)]"
                />
              </div>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 border-t border-border pt-2 text-[10px]">
              <div className="flex items-center gap-1">
                <Badge variant="outline" className="h-3.5 border-[var(--color-brand-orange)]/40 px-1 text-[9px] text-[var(--color-brand-orange)]">R</Badge>
                <span className="font-mono font-bold tabular-nums text-foreground">40.0 K/s</span>
              </div>
              <div className="flex items-center gap-1">
                <Badge variant="outline" className="h-3.5 border-[var(--color-brand-cyan)]/40 px-1 text-[9px] text-[var(--color-brand-cyan)]">W</Badge>
                <span className="font-mono font-bold tabular-nums text-foreground">1.64 M/s</span>
              </div>
              <div className="text-muted-foreground">
                Latency <span className="font-mono font-bold text-foreground">0.25 ms</span>
              </div>
              <div className="text-muted-foreground">
                IOPS <span className="font-mono font-bold text-foreground">178</span>
              </div>
            </div>
          </section>
        </div>

        {/* ─── DOCKER CONTAINERS ──────────────────────────────────── */}
        <section className="rounded-2xl border border-border bg-[var(--color-surface)] p-5">
          <SectionLabel
            color="oklch(0.65 0.22 270)"
            icon={Container}
            title="Docker Containers"
            action={
              <div className="flex items-center gap-2 text-[11px]">
                <span className="flex items-center gap-1 text-muted-foreground">
                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-brand-green)]" />
                  {containers.filter((c) => c.status === "up").length} running
                </span>
                <span className="h-1 w-1 rounded-full bg-border" />
                <span className="flex items-center gap-1 text-muted-foreground">
                  <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60" />
                  {containers.filter((c) => c.status !== "up").length} stopped
                </span>
              </div>
            }
          />
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            {containers.map((c) => {
              const isUp = c.status === "up";
              return (
                <div
                  key={c.name}
                  className="group relative overflow-hidden rounded-xl border border-border bg-background/40 p-3.5 transition-colors hover:border-[color-mix(in_oklab,var(--color-brand-cyan)_30%,var(--color-border))]"
                >
                  <div
                    aria-hidden
                    className="absolute inset-y-0 left-0 w-[3px]"
                    style={{ background: isUp ? "var(--color-brand-green)" : "var(--color-border)" }}
                  />
                  <div className="flex items-center justify-between">
                    <div className="min-w-0">
                      <div className="truncate text-[12px] font-semibold text-foreground">{c.name}</div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${
                            isUp
                              ? "bg-[var(--color-brand-green)] shadow-[0_0_6px_var(--color-brand-green)]"
                              : "bg-muted-foreground/50"
                          }`}
                        />
                        <span className="font-mono">{isUp ? `Up · ${c.uptime}` : c.uptime}</span>
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <RingGauge
                        value={c.cpu}
                        label="CPU"
                        gradientId={`g-cpu-${c.name}`}
                        from="oklch(0.78 0.16 200)"
                        to="oklch(0.62 0.18 240)"
                      />
                      <RingGauge
                        value={c.ram}
                        label="RAM"
                        gradientId={`g-ram-${c.name}`}
                        from="oklch(0.88 0.18 95)"
                        to="oklch(0.72 0.20 55)"
                      />
                    </div>
                    <div className="flex flex-1 items-stretch gap-3 text-[10px]">
                      <IoStat
                        label="Network"
                        rows={[
                          { icon: ArrowDownToLine, value: c.netRx, unit: c.netRxUnit },
                          { icon: ArrowUpFromLine, value: c.netTx, unit: c.netTxUnit },
                        ]}
                      />
                      <IoStat
                        label="Block IO"
                        rows={[
                          { icon: ArrowDownToLine, value: c.ioRead, unit: c.ioReadUnit, letter: "R" },
                          { icon: ArrowUpFromLine, value: c.ioWrite, unit: c.ioWriteUnit, letter: "W" },
                        ]}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </ScrollArea>
  );
}


/* ---------------- Hosts view ---------------- */

function HostsView({
  onNewTerminal,
  onNewSftp,
  onConnectHost,
}: {
  onNewTerminal?: () => void;
  onNewSftp?: (host?: Host) => void;
  onConnectHost: (host: Host) => void;
}) {
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<"grid" | "list">(() => {
    const saved = localStorage.getItem("hosts-view-mode");
    return saved === "list" ? "list" : "grid";
  });
  const [sortDir, setSortDir] = useState<"desc" | "asc">(() => {
    const saved = localStorage.getItem("hosts-sort-dir");
    return saved === "asc" ? "asc" : "desc";
  });
  const [viewOpen, setViewOpen] = useState(false);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [tagMenuOpen, setTagMenuOpen] = useState(false);

  const [hosts, setHosts] = useState<Host[]>([]);
  const [groups, setGroups] = useState<HostGroup[]>([]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [hostsError, setHostsError] = useState<string | null>(null);

  const [hostModal, setHostModal] = useState<{ open: boolean; groupId: string | null }>({ open: false, groupId: null });
  const [editingHost, setEditingHost] = useState<Host | null>(null);
  const [groupModal, setGroupModal] = useState<{ open: boolean; parentId: string | null; group?: HostGroup | null }>({ open: false, parentId: null, group: null });
  const [removingHostId, setRemovingHostId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    invoke<{ hosts: Host[]; groups: HostGroup[] }>("list_hosts")
      .then((vault) => {
        if (!cancelled) {
          setHosts(vault.hosts);
          setGroups(vault.groups);
          setHostsError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setHostsError(String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    localStorage.setItem("hosts-view-mode", viewMode);
  }, [viewMode]);

  useEffect(() => {
    localStorage.setItem("hosts-sort-dir", sortDir);
  }, [sortDir]);

  const toggleCollapse = (id: string) =>
    setCollapsed((c) => ({ ...c, [id]: !c[id] }));

  const upsertGroup = async (name: string, parentId: string | null, id?: string) => {
    try {
      const group = await invoke<HostGroup>("save_host_group", {
        request: { id: id ?? null, name, parentId },
      });
      setGroups((curr) => [group, ...curr.filter((item) => item.id !== group.id)]);
      setHostsError(null);
      setGroupModal({ open: false, parentId: null, group: null });
    } catch (err) {
      setHostsError(String(err));
    }
  };
  const upsertHost = async (h: Omit<Host, "id">, id?: string) => {
    try {
      const host = await invoke<Host>("save_host", { request: { ...h, id: id ?? null } });
      setHosts((curr) => [host, ...curr.filter((item) => item.id !== host.id)]);
      setHostsError(null);
      setHostModal({ open: false, groupId: null });
      setEditingHost(null);
    } catch (err) {
      setHostsError(String(err));
    }
  };
  const removeHost = async (id: string) => {
    try {
      await invoke("remove_hosts", { ids: [id] });
      setHosts((curr) => curr.filter((host) => host.id !== id));
      setHostsError(null);
      toast.success("Host deleted");
    } catch (err) {
      setHostsError(String(err));
      toast.error("Delete host failed", { description: String(err) });
    }
  };
  const removeGroup = async (id: string) => {
    try {
      await invoke("remove_host_group", { id });
      const descendants = descendantGroupIds(groups, id);
      setGroups((curr) => curr.filter((group) => group.id !== id && !descendants.includes(group.id)));
      setHosts((curr) =>
        curr.filter((host) => !host.groupId || (host.groupId !== id && !descendants.includes(host.groupId)))
      );
      setHostsError(null);
      toast.success("Group deleted");
    } catch (err) {
      setHostsError(String(err));
      toast.error("Delete group failed", { description: String(err) });
    }
  };

  const filteredHosts = hosts
    .filter((h) =>
      `${h.name} ${h.user}@${h.hostname}`.toLowerCase().includes(query.toLowerCase()),
    )
    .filter((h) => !tagFilter || (h.tags ?? []).includes(tagFilter))
    .sort((a, b) => {
      const da = a.lastUsed ? new Date(a.lastUsed).getTime() : 0;
      const db = b.lastUsed ? new Date(b.lastUsed).getTime() : 0;
      return sortDir === "desc" ? db - da : da - db;
    });

  const rootHosts = filteredHosts.filter((h) => !h.groupId);
  const rootGroups = groups.filter((g) => !g.parentId);
  const connectTarget = filteredHosts[0] ?? null;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {/* Search + connect */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <div className="flex h-9 flex-1 items-center gap-2 rounded-md border border-border bg-[var(--color-surface)] px-3 focus-within:ring-2 focus-within:ring-ring/40">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a host or ssh user@hostname…"
            className="h-full flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
        </div>
        <button
          disabled={!query.trim() || !connectTarget}
          onClick={() => query.trim() && connectTarget && onConnectHost(connectTarget)}
          className="h-9 rounded-md border border-border bg-[var(--color-surface)] px-4 text-sm font-medium text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60 hover:enabled:bg-[var(--color-surface-2)] hover:enabled:text-foreground"
        >
          Connect
        </button>
      </div>

      {/* Toolbar */}
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <SplitButton
            primary={<><Plus className="h-3.5 w-3.5" /> New host</>}
            onPrimary={() => setHostModal({ open: true, groupId: null })}
            menu={[
              { label: "New host", icon: <Plus className="h-3.5 w-3.5" />, onClick: () => setHostModal({ open: true, groupId: null }) },
              { label: "New group", icon: <FolderPlus className="h-3.5 w-3.5" />, onClick: () => setGroupModal({ open: true, parentId: null }) },
            ]}
          />
          {onNewSftp && <ToolbarButton icon={<Folder className="h-4 w-4" />} label="SFTP" onClick={() => onNewSftp()} />}
          <ToolbarButton icon={<TerminalSquare className="h-4 w-4" />} label="Terminal" onClick={onNewTerminal} />
        </div>
        <div className="flex items-center gap-1">
          {/* View mode dropdown */}
          <div className="relative">
            <button
              onClick={() => setViewOpen((v) => !v)}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-foreground"
              title={viewMode === "grid" ? "Grid view" : "List view"}
            >
              {viewMode === "grid" ? <LayoutGrid className="h-4 w-4" /> : <List className="h-4 w-4" />}
            </button>
            {viewOpen && (
              <div
                className="absolute right-0 top-full z-30 mt-1 w-40 overflow-hidden rounded-lg border border-border bg-popover shadow-2xl"
                onMouseLeave={() => setViewOpen(false)}
              >
                <button
                  onClick={() => { setViewMode("grid"); setViewOpen(false); }}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-[var(--color-surface-2)] ${viewMode === "grid" ? "text-foreground" : "text-muted-foreground"}`}
                >
                  <LayoutGrid className="h-4 w-4" />
                  Grid view
                </button>
                <button
                  onClick={() => { setViewMode("list"); setViewOpen(false); }}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-[var(--color-surface-2)] ${viewMode === "list" ? "text-foreground" : "text-muted-foreground"}`}
                >
                  <List className="h-4 w-4" />
                  List view
                </button>
              </div>
            )}
          </div>

          <div className="relative">
            <button
              onClick={() => setTagMenuOpen((v) => !v)}
              className={[
                "flex h-7 w-7 items-center justify-center rounded-md hover:bg-[var(--color-surface-2)] hover:text-foreground",
                tagFilter ? "text-foreground" : "text-muted-foreground",
              ].join(" ")}
              title="Filter by tag"
            >
              <Tag className="h-4 w-4" />
            </button>
            {tagMenuOpen && (
              <div
                className="absolute right-0 top-full z-30 mt-1 w-44 overflow-hidden rounded-lg border border-border bg-popover shadow-2xl"
                onMouseLeave={() => setTagMenuOpen(false)}
              >
                <button
                  onClick={() => { setTagFilter(null); setTagMenuOpen(false); }}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-[var(--color-surface-2)] ${!tagFilter ? "text-foreground font-medium" : "text-muted-foreground"}`}
                >
                  All tags
                </button>
                {Array.from(new Set(hosts.flatMap((h) => h.tags ?? []))).sort().map((tag) => (
                  <button
                    key={tag}
                    onClick={() => { setTagFilter(tag); setTagMenuOpen(false); }}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-[var(--color-surface-2)] ${tagFilter === tag ? "text-foreground font-medium" : "text-muted-foreground"}`}
                  >
                    {tag}
                  </button>
                ))}
                {hosts.every((h) => !(h.tags ?? []).length) && (
                  <div className="px-3 py-2 text-xs text-muted-foreground">No tags defined</div>
                )}
              </div>
            )}
          </div>
          <button
            onClick={() => setSortDir((d) => (d === "desc" ? "asc" : "desc"))}
            className="flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-foreground"
            title={sortDir === "desc" ? "Newest first" : "Oldest first"}
          >
            <ArrowUpDown className="h-3.5 w-3.5" />
            {sortDir === "desc" ? "Newest" : "Oldest"}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {hostsError && (
          <div className="mb-3 rounded-md border border-[oklch(0.55_0.2_25)]/40 bg-[oklch(0.55_0.2_25)]/10 px-3 py-2 text-xs text-[oklch(0.72_0.18_25)]">
            {hostsError}
          </div>
        )}
        <h2 className="mb-3 text-sm font-semibold text-foreground">Hosts</h2>

        {loading ? (
          <div className="flex min-h-40 items-center justify-center text-sm text-muted-foreground">
            Loading hosts…
          </div>
        ) : hosts.length === 0 && groups.length === 0 && !query ? (
          <div className="flex min-h-80 flex-col items-center justify-center px-6 text-center">
            <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-[var(--color-surface-2)]">
              <Server className="h-9 w-9 text-muted-foreground" strokeWidth={1.5} />
            </div>
            <h3 className="mt-5 text-base font-semibold text-foreground">Create host</h3>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              Add SSH hosts and organize them into groups for quick terminal and SFTP access.
            </p>
          </div>
        ) : (
          <>
            {/* Root-level groups (recursive) */}
            {rootGroups.map((g) => (
              <GroupNode
                key={g.id}
                group={g}
                depth={0}
                groups={groups}
                hosts={filteredHosts}
                viewMode={viewMode}
                collapsed={collapsed}
                onToggle={toggleCollapse}
                onAddSubgroup={(parentId) => setGroupModal({ open: true, parentId, group: null })}
                onAddHost={(groupId) => setHostModal({ open: true, groupId })}
                onEditGroup={(group) => setGroupModal({ open: true, parentId: group.parentId, group })}
                onDeleteGroup={removeGroup}
                onEditHost={setEditingHost}
                onDeleteHost={setRemovingHostId}
                onConnectHost={onConnectHost}
                onOpenSftp={onNewSftp}
              />
            ))}

            {/* Root-level hosts */}
            <HostsList
              hosts={rootHosts}
              viewMode={viewMode}
              query={query}
              onConnectHost={onConnectHost}
              onEditHost={setEditingHost}
              onDeleteHost={setRemovingHostId}
              onOpenSftp={onNewSftp}
            />
          </>
        )}
      </div>

      {(hostModal.open || editingHost) && (
        <HostModal
          groups={groups}
          existingTags={Array.from(new Set(hosts.flatMap((host) => host.tags ?? []))).sort()}
          defaultGroupId={editingHost?.groupId ?? hostModal.groupId}
          host={editingHost}
          onClose={() => {
            setHostModal({ open: false, groupId: null });
            setEditingHost(null);
          }}
          onSubmit={(h) => void upsertHost(h, editingHost?.id)}
        />
      )}
      {groupModal.open && (
        <GroupModal
          groups={groups}
          defaultParentId={groupModal.parentId}
          group={groupModal.group}
          onClose={() => setGroupModal({ open: false, parentId: null, group: null })}
          onSubmit={(name, parentId) => void upsertGroup(name, parentId, groupModal.group?.id)}
        />
      )}
      {removingHostId && (
        <RemoveHostModal
          hostName={hosts.find((h) => h.id === removingHostId)?.name || hosts.find((h) => h.id === removingHostId)?.hostname || "this host"}
          onClose={() => setRemovingHostId(null)}
          onConfirm={() => {
            void removeHost(removingHostId);
            setRemovingHostId(null);
          }}
        />
      )}
    </div>
  );
}

/* ---- Group rendering (recursive) ---- */
function GroupNode({
  group, depth, groups, hosts, viewMode, collapsed, onToggle, onAddSubgroup, onAddHost, onEditGroup, onDeleteGroup, onEditHost, onDeleteHost, onConnectHost, onOpenSftp,
}: {
  group: HostGroup;
  depth: number;
  groups: HostGroup[];
  hosts: Host[];
  viewMode: "grid" | "list";
  collapsed: Record<string, boolean>;
  onToggle: (id: string) => void;
  onAddSubgroup: (parentId: string) => void;
  onAddHost: (groupId: string) => void;
  onEditGroup: (group: HostGroup) => void;
  onDeleteGroup: (id: string) => void;
  onEditHost: (host: Host) => void;
  onDeleteHost: (id: string) => void;
  onConnectHost: (host: Host) => void;
  onOpenSftp?: (host: Host) => void;
}) {
  const isOpen = !collapsed[group.id];
  const children = groups.filter((g) => g.parentId === group.id);
  const groupHosts = hosts.filter((h) => h.groupId === group.id);

  return (
    <div className="mb-2" style={{ marginLeft: depth * 16 }}>
      <div className="group flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-[var(--color-surface)]">
        <button
          onClick={() => onToggle(group.id)}
          className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-foreground"
        >
          <ChevronRight className={`h-3.5 w-3.5 transition-transform ${isOpen ? "rotate-90" : ""}`} />
        </button>
        <Folder className="h-4 w-4 text-[oklch(0.7_0.13_230)]" />
        <span className="text-sm font-medium text-foreground">{group.name}</span>
        <span className="text-xs text-muted-foreground">
          ({children.length + groupHosts.length})
        </span>
        <div className="ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
          <button
            title="New host in this group"
            onClick={() => onAddHost(group.id)}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button
            title="New subgroup"
            onClick={() => onAddSubgroup(group.id)}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-foreground"
          >
            <FolderPlus className="h-3.5 w-3.5" />
          </button>
          <button
            title="Edit group"
            onClick={() => onEditGroup(group)}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-foreground"
          >
            <Settings className="h-3.5 w-3.5" />
          </button>
          <button
            title="Delete group"
            onClick={() => onDeleteGroup(group.id)}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-[oklch(0.72_0.18_25)]"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {isOpen && (
        <div className="mt-1.5 pl-4">
          {children.map((c) => (
            <GroupNode
              key={c.id}
              group={c}
              depth={depth + 1}
              groups={groups}
              hosts={hosts}
              viewMode={viewMode}
              collapsed={collapsed}
              onToggle={onToggle}
              onAddSubgroup={onAddSubgroup}
              onAddHost={onAddHost}
              onEditGroup={onEditGroup}
              onDeleteGroup={onDeleteGroup}
              onEditHost={onEditHost}
              onDeleteHost={onDeleteHost}
              onConnectHost={onConnectHost}
              onOpenSftp={onOpenSftp}
            />
          ))}
          {groupHosts.length > 0 && (
            <HostsList
              hosts={groupHosts}
              viewMode={viewMode}
              query=""
              onConnectHost={onConnectHost}
              onEditHost={onEditHost}
              onDeleteHost={onDeleteHost}
              onOpenSftp={onOpenSftp}
            />
          )}
        </div>
      )}
    </div>
  );
}

function HostsList({
  hosts,
  viewMode,
  query,
  onConnectHost,
  onEditHost,
  onDeleteHost,
  onOpenSftp,
}: {
  hosts: Host[];
  viewMode: "grid" | "list";
  query: string;
  onConnectHost: (host: Host) => void;
  onEditHost: (host: Host) => void;
  onDeleteHost: (id: string) => void;
  onOpenSftp?: (host: Host) => void;
}) {
  if (hosts.length === 0 && query) {
    return (
      <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
        No hosts match "{query}"
      </div>
    );
  }
  if (hosts.length === 0) return null;

  if (viewMode === "grid") {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {hosts.map((h) => (
          <div
            key={h.id}
            role="button"
            tabIndex={0}
            onClick={() => onConnectHost(h)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onConnectHost(h); } }}
            className="group flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-[var(--color-surface)] p-3 text-left transition hover:border-[var(--color-brand-orange)]/40 hover:bg-[var(--color-surface-2)]"
          >
            <OsBadge os={h.os} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-foreground">{h.name}</div>
              <div className="truncate text-xs text-muted-foreground">ssh, {h.user}</div>
            </div>
            <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
              {onOpenSftp && (
                <button
                  title="Open SFTP"
                  onClick={(e) => { e.stopPropagation(); onOpenSftp(h); }}
                  className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-[var(--color-surface)] hover:text-[var(--color-brand-cyan)]"
                >
                  <Folder className="h-3.5 w-3.5" />
                </button>
              )}
              <button
                title="Edit"
                onClick={(e) => { e.stopPropagation(); onEditHost(h); }}
                className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-[var(--color-surface)] hover:text-foreground"
              >
                <Settings className="h-3.5 w-3.5" />
              </button>
              <button
                title="Delete"
                onClick={(e) => { e.stopPropagation(); onDeleteHost(h.id); }}
                className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-[var(--color-surface)] hover:text-[oklch(0.72_0.18_25)]"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
              <PanelRightOpen className="h-4 w-4 text-muted-foreground" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {hosts.map((h) => (
        <div
          key={h.id}
          role="button"
          tabIndex={0}
          onClick={() => onConnectHost(h)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onConnectHost(h); } }}
          className="group flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-[var(--color-surface)] p-3 text-left transition hover:border-[var(--color-brand-orange)]/40 hover:bg-[var(--color-surface-2)]"
        >
          <OsBadge os={h.os} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-foreground">{h.name}</div>
            <div className="truncate text-xs text-muted-foreground">{h.user}@{h.hostname}</div>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {onOpenSftp && (
              <button
                title="Open SFTP"
                onClick={(e) => { e.stopPropagation(); onOpenSftp(h); }}
                className="flex h-7 w-7 items-center justify-center rounded opacity-0 transition-opacity hover:bg-[var(--color-surface)] hover:text-[var(--color-brand-cyan)] group-hover:opacity-100"
              >
                <Folder className="h-3.5 w-3.5" />
              </button>
            )}
            <button
              title="Edit"
              onClick={(e) => { e.stopPropagation(); onEditHost(h); }}
              className="flex h-7 w-7 items-center justify-center rounded opacity-0 transition-opacity hover:bg-[var(--color-surface)] hover:text-foreground group-hover:opacity-100"
            >
              <Settings className="h-3.5 w-3.5" />
            </button>
            <button
              title="Delete"
              onClick={(e) => { e.stopPropagation(); onDeleteHost(h.id); }}
              className="flex h-7 w-7 items-center justify-center rounded opacity-0 transition-opacity hover:bg-[var(--color-surface)] hover:text-[oklch(0.72_0.18_25)] group-hover:opacity-100"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
            <PanelRightOpen className="h-4 w-4 opacity-0 transition-opacity group-hover:opacity-100" />
            <span className="rounded border border-border px-1.5 py-0.5">{h.os}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---- Helpers to render a group path like "A › B › C" ---- */
function groupPath(groups: HostGroup[], id: string | null): string {
  if (!id) return "— (root)";
  const parts: string[] = [];
  let cur: HostGroup | undefined = groups.find((g) => g.id === id);
  while (cur) {
    parts.unshift(cur.name);
    cur = cur.parentId ? groups.find((g) => g.id === cur!.parentId) : undefined;
  }
  return parts.join(" › ");
}

function descendantGroupIds(groups: HostGroup[], id: string): string[] {
  const descendants: string[] = [];
  const stack = [id];

  while (stack.length > 0) {
    const parentId = stack.pop()!;
    groups
      .filter((group) => group.parentId === parentId)
      .forEach((group) => {
        descendants.push(group.id);
        stack.push(group.id);
      });
  }

  return descendants;
}

/* ---- Modal: New Group ---- */
function GroupModal({
  groups, defaultParentId, group, onClose, onSubmit,
}: {
  groups: HostGroup[];
  defaultParentId: string | null;
  group?: HostGroup | null;
  onClose: () => void;
  onSubmit: (name: string, parentId: string | null) => void;
}) {
  const [name, setName] = useState(group?.name ?? "");
  const [parentId, setParentId] = useState<string | null>(group?.parentId ?? defaultParentId);
  const invalidParentIds = group ? [group.id, ...descendantGroupIds(groups, group.id)] : [];

  return (
    <ModalShell title={group ? "Edit group" : "New group"} onClose={onClose}>
      <Field label="Name">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Production"
          className="h-9 w-full rounded-md border border-border bg-[var(--color-surface)] px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
        />
      </Field>
      <Field label="Parent group">
        <Select value={parentId ?? "__none__"} onValueChange={(val) => setParentId(val === "__none__" ? null : val)}>
          <SelectTrigger className="h-9 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">— (root)</SelectItem>
            {groups.filter((g) => !invalidParentIds.includes(g.id)).map((g) => (
              <SelectItem key={g.id} value={g.id}>{groupPath(groups, g.id)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <ModalActions
        onClose={onClose}
        onConfirm={() => {
          const n = name.trim();
          if (n) onSubmit(n, parentId);
        }}
        confirmDisabled={!name.trim()}
        confirmLabel={group ? "Save group" : "Create group"}
      />
    </ModalShell>
  );
}

function HostModalSectionTitle({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2 px-4 py-3">
      <span className="flex h-5 w-5 items-center justify-center text-muted-foreground">
        {icon}
      </span>
      <span className="text-sm font-semibold text-foreground">{title}</span>
    </div>
  );
}

function HostModalRow({
  label,
  children,
  rightText,
}: {
  label: string;
  children: React.ReactNode;
  rightText?: string;
}) {
  return (
    <div className="flex items-center justify-between border-t border-border px-4 py-2.5">
      <span className="text-sm text-foreground">{label}</span>
      <div className="flex items-center gap-2">
        {children}
        {rightText && <span className="text-sm text-muted-foreground">{rightText}</span>}
      </div>
    </div>
  );
}

function HostModalInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      dir="ltr"
      className={[
        "h-8 w-40 rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 text-left text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-[var(--color-brand-orange)]/40",
        props.className,
      ].filter(Boolean).join(" ")}
    />
  );
}

function HostModalToggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={[
        "relative h-5 w-9 rounded-full transition-colors",
        checked ? "bg-[var(--color-brand-orange)]" : "bg-muted",
      ].join(" ")}
    >
      <span
        className={[
          "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform",
          checked ? "left-[18px]" : "left-0.5",
        ].join(" ")}
      />
    </button>
  );
}

/* ---- Modal: New Host ---- */
function HostModal({
  groups, existingTags, defaultGroupId, host, onClose, onSubmit,
}: {
  groups: HostGroup[];
  existingTags: string[];
  defaultGroupId: string | null;
  host?: Host | null;
  onClose: () => void;
  onSubmit: (h: Omit<Host, "id">) => void;
}) {
  const [name, setName] = useState(host?.name ?? "");
  const [hostname, setHostname] = useState(host?.hostname ?? "");
  const [port, setPort] = useState(host?.port ?? 22);
  const [user, setUser] = useState(host?.user ?? "");
  const [password, setPassword] = useState(host?.password ?? "");
  const [showPass, setShowPass] = useState(false);
  const [sshKeyId, setSshKeyId] = useState<string | null>(host?.sshKeyId ?? null);
  const [os, setOs] = useState<import("./types").OsKind>(host?.os ?? "ubuntu");
  const [groupId, setGroupId] = useState<string | null>(host?.groupId ?? defaultGroupId);
  const [tags, setTags] = useState<string[]>(host?.tags ?? []);
  const [tagInput, setTagInput] = useState("");
  const [showStatus, setShowStatus] = useState(host?.showStatusInDashboard ?? true);
  const [workingDir, setWorkingDir] = useState(host?.workingDirectory ?? "");
  const [sftpPath, setSftpPath] = useState(host?.defaultSftpPath ?? "/");
  const [sshKeys, setSshKeys] = useState<SshKey[]>([]);
  const [testing, setTesting] = useState(false);

  const valid = name.trim() && hostname.trim() && user.trim();

  useEffect(() => {
    let cancelled = false;
    invoke<SshKey[]>("list_ssh_keys")
      .then((items) => {
        if (!cancelled) setSshKeys(items);
      })
      .catch(() => {
        if (!cancelled) setSshKeys([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const addTag = (tag: string) => {
    const normalized = tag.trim();
    if (!normalized) return;
    setTags((curr) => (curr.includes(normalized) ? curr : [...curr, normalized]));
    setTagInput("");
  };
  const removeTag = (tag: string) => {
    setTags((curr) => curr.filter((item) => item !== tag));
  };
  const testConnection = async () => {
    if (!hostname.trim() || !user.trim()) return;
    // flushSync forces React to paint the "Testing..." / disabled state before
    // the async invoke starts — without this, React may batch the state update
    // with the invoke call and the button never visually changes on macOS/Linux.
    flushSync(() => setTesting(true));

    try {
      const result = await invoke<{ ok: boolean; message: string }>("test_host_connection", {
        request: {
          hostname: hostname.trim(),
          user: user.trim(),
          port,
          password,
          sshKeyId,
          timeoutSecs: 5,
        },
      });
      if (result.ok) toast.success("Connection test passed", { description: result.message });
      else toast.error("Connection test failed", { description: result.message });
    } catch (err) {
      const message = String(err);
      toast.error("Connection test failed", { description: message });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="flex max-h-[70vh] w-[520px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-border bg-[var(--color-surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border bg-[var(--color-sidebar)] px-5 py-3">
          <h3 className="text-sm font-semibold text-foreground">{host ? "Edit Machine" : "Create New Machine"}</h3>
          <button
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition hover:bg-[var(--color-surface-2)] hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {/* Machine Information */}
          <HostModalSectionTitle icon={<Info className="h-4 w-4" />} title="Machine Information" />
          <div className="border-t border-border">
            <HostModalRow label="Name">
              <HostModalInput autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
            </HostModalRow>
            <HostModalRow label="Host">
              <HostModalInput value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="IP or Hostname" />
            </HostModalRow>
            <HostModalRow label="Port" rightText="22">
              <input
                type="number"
                value={port}
                onChange={(e) => setPort(Number(e.target.value) || 22)}
                dir="ltr"
                className="h-8 w-24 rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 text-left text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-[var(--color-brand-orange)]/40"
              />
            </HostModalRow>
            <HostModalRow label="OS">
              <Select value={os} onValueChange={(val) => setOs(val as import("./types").OsKind)}>
                <SelectTrigger className="h-8 w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ubuntu">Ubuntu</SelectItem>
                  <SelectItem value="debian">Debian</SelectItem>
                  <SelectItem value="centos">CentOS</SelectItem>
                  <SelectItem value="alpine">Alpine</SelectItem>
                  <SelectItem value="macos">macOS</SelectItem>
                  <SelectItem value="windows">Windows</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </HostModalRow>
          </div>
          <div className="px-4 pb-2 pt-1.5">
            <p className="text-right text-[11px] text-muted-foreground">If Name is empty, Host will be used as Name.</p>
          </div>

          {/* Authentication */}
          <HostModalSectionTitle icon={<Lock className="h-4 w-4" />} title="Authentication" />
          <div className="border-t border-border">
            <HostModalRow label="Username">
              <HostModalInput value={user} onChange={(e) => setUser(e.target.value)} placeholder="Username" />
            </HostModalRow>
            <HostModalRow label="Password">
              <div className="relative">
                <HostModalInput
                  className="pr-7"
                  type={showPass ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                />
                <button
                  onClick={() => setShowPass((s) => !s)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showPass ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                </button>
              </div>
            </HostModalRow>
            <HostModalRow label="SSH Key">
              <Select value={sshKeyId ?? "__none__"} onValueChange={(val) => setSshKeyId(val === "__none__" ? null : val)}>
                <SelectTrigger className="h-8 w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">No key</SelectItem>
                  {sshKeys.map((key) => (
                    <SelectItem key={key.id} value={key.id}>{key.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </HostModalRow>
          </div>

          {/* Categorization */}
          <HostModalSectionTitle icon={<Tag className="h-4 w-4" />} title="Categorization" />
          <div className="border-t border-border">
            <HostModalRow label="Group">
              <Select value={groupId ?? "__none__"} onValueChange={(val) => setGroupId(val === "__none__" ? null : val)}>
                <SelectTrigger className="h-8 w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Root</SelectItem>
                  {groups.map((group) => (
                    <SelectItem key={group.id} value={group.id}>{groupPath(groups, group.id)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </HostModalRow>
            <HostModalRow label="Tags">
              <div className="flex w-64 flex-col items-end gap-2">
                <div className="flex w-full flex-wrap justify-end gap-1">
                  {tags.map((tag) => (
                    <button
                      key={tag}
                      onClick={() => removeTag(tag)}
                      className="rounded border border-border bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                    >
                      {tag} ×
                    </button>
                  ))}
                </div>
                <input
                  list="host-tag-options"
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === ",") {
                      e.preventDefault();
                      addTag(tagInput.replace(",", ""));
                    }
                  }}
                  onBlur={() => addTag(tagInput)}
                  placeholder="Add tag"
                  className="h-8 w-40 rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 text-left text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-[var(--color-brand-orange)]/40"
                />
                <datalist id="host-tag-options">
                  {existingTags.map((tag) => (
                    <option key={tag} value={tag} />
                  ))}
                </datalist>
              </div>
            </HostModalRow>
          </div>

          {/* Preferences */}
          <HostModalSectionTitle icon={<Settings className="h-4 w-4" />} title="Preferences" />
          <div className="border-t border-border">
            <HostModalRow label="Show Status in Dashboard">
              <HostModalToggle checked={showStatus} onChange={setShowStatus} />
            </HostModalRow>
            <HostModalRow label="Working Directory">
              <HostModalInput value={workingDir} onChange={(e) => setWorkingDir(e.target.value)} placeholder="e.g. /home/user/project" />
            </HostModalRow>
            <HostModalRow label="Default SFTP Path">
              <HostModalInput value={sftpPath} onChange={(e) => setSftpPath(e.target.value)} placeholder="/" />
            </HostModalRow>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-border bg-[var(--color-sidebar)] px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-md px-4 py-1.5 text-sm font-medium text-muted-foreground transition hover:bg-[var(--color-surface-2)] hover:text-foreground"
          >
            Cancel
          </button>
          <button
            disabled={!hostname.trim() || !user.trim() || testing}
            onClick={() => void testConnection()}
            className="w-[9.5rem] rounded-md border border-border bg-[var(--color-surface)] px-4 py-1.5 text-center text-sm font-medium text-foreground disabled:cursor-not-allowed disabled:opacity-50 hover:enabled:bg-[var(--color-surface-2)]"
          >
            {testing ? "Testing..." : "Test Connection"}
          </button>
          <button
            onClick={() =>
              valid &&
              onSubmit({
                name: name.trim(),
                hostname: hostname.trim(),
                port,
                user: user.trim(),
                os,
                groupId,
                tags,
                password,
                sshKeyId,
                authMethod: sshKeyId ? "key" : password ? "password" : undefined,
                showStatusInDashboard: showStatus,
                workingDirectory: workingDir.trim() || undefined,
                defaultSftpPath: sftpPath,
              })
            }
            disabled={!valid}
            className="rounded-md bg-[var(--color-brand-orange)] px-4 py-1.5 text-sm font-semibold text-[var(--color-primary-foreground)] disabled:cursor-not-allowed disabled:opacity-50 hover:enabled:opacity-90"
          >
            {host ? "Save host" : "Create host"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---- Generic modal scaffolding ---- */
function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-[440px] max-w-[90vw] rounded-xl border border-border bg-popover p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-3">{children}</div>
      </div>
    </div>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] uppercase tracking-wider text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
function ModalActions({ onClose, onConfirm, confirmDisabled, confirmLabel }: { onClose: () => void; onConfirm: () => void; confirmDisabled?: boolean; confirmLabel: string }) {
  return (
    <div className="mt-5 flex items-center justify-end gap-2">
      <button onClick={onClose} className="h-8 rounded-md px-3 text-xs font-medium text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-foreground">
        Cancel
      </button>
      <button
        onClick={onConfirm}
        disabled={confirmDisabled}
        className="h-8 rounded-md bg-[var(--color-brand-orange)] px-3 text-xs font-semibold text-[var(--color-primary-foreground)] disabled:cursor-not-allowed disabled:opacity-50 hover:enabled:opacity-90"
      >
        {confirmLabel}
      </button>
    </div>
  );
}

function ToolbarButton({ icon, label, hint, onClick }: { icon: React.ReactNode; label: string; hint?: boolean; onClick?: () => void }) {
  return (
    <button onClick={onClick} className="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-foreground/90 hover:bg-[var(--color-surface-2)]">
      {icon}
      <span>{label}</span>
      {hint && <span className="ml-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-border text-[9px] text-muted-foreground">i</span>}
    </button>
  );
}

function IconButton({ icon, title, active, onClick }: { icon: React.ReactNode; title: string; active?: boolean; onClick?: () => void }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={[
        "flex h-7 w-7 items-center justify-center rounded-md",
        active ? "bg-[var(--color-surface-2)] text-foreground" : "text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-foreground",
      ].join(" ")}
    >
      {icon}
    </button>
  );
}

interface SplitMenuItem {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
}
function SplitButton({
  primary,
  onPrimary,
  menu,
}: {
  primary: React.ReactNode;
  onPrimary?: () => void;
  menu?: SplitMenuItem[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <div className="flex h-7 overflow-hidden rounded-md bg-[var(--color-surface-2)] text-xs font-medium">
        <button
          onClick={onPrimary}
          className="flex items-center gap-1 px-2.5 text-foreground hover:bg-white/5"
        >
          {primary}
        </button>
        <div className="w-px bg-border" />
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex items-center px-1.5 text-muted-foreground hover:bg-white/5 hover:text-foreground"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      </div>
      {open && menu && (
        <div className="absolute left-0 top-full z-30 mt-1 w-56 overflow-hidden rounded-lg border border-border bg-popover shadow-2xl">
          {menu.map((it) => (
            <button
              key={it.label}
              onClick={() => { setOpen(false); it.onClick(); }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground hover:bg-[var(--color-surface-2)]"
            >
              {it.icon}
              <span>{it.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------- Port forwarding (empty) ---------------- */

function PortForwardingView() {
  const [rules, setRules] = useState<import("./types").PortForwardRule[]>([]);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [statuses, setStatuses] = useState<Record<string, import("./types").TunnelStatus>>({});
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<import("./types").PortForwardRule | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (searchOpen) searchRef.current?.focus(); }, [searchOpen]);

  const loadData = async () => {
    try {
      const [ruleList, hostVault] = await Promise.all([
        invoke<import("./types").PortForwardRule[]>("list_port_forwards"),
        invoke<{ hosts: Host[]; groups: HostGroup[] }>("list_hosts"),
      ]);
      setRules(ruleList);
      setHosts(hostVault.hosts);

      if (ruleList.length > 0) {
        const s = await invoke<import("./types").TunnelStatus[]>("get_tunnel_statuses", {
          ruleIds: ruleList.map((r) => r.id),
        });
        const map: Record<string, import("./types").TunnelStatus> = {};
        s.forEach((st) => { map[st.ruleId] = st; });
        setStatuses(map);
      }
    } catch (err) {
      toast.error("Failed to load port forwards", { description: String(err) });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadData(); }, []);

  // Refresh statuses periodically
  useEffect(() => {
    if (rules.length === 0) return;
    const interval = setInterval(async () => {
      try {
        const s = await invoke<import("./types").TunnelStatus[]>("get_tunnel_statuses", {
          ruleIds: rules.map((r) => r.id),
        });
        const map: Record<string, import("./types").TunnelStatus> = {};
        s.forEach((st) => { map[st.ruleId] = st; });
        setStatuses(map);
      } catch { /* ignore */ }
    }, 3000);
    return () => clearInterval(interval);
  }, [rules]);

  const handleSave = async (data: Omit<import("./types").PortForwardRule, "id" | "createdAt">, id?: string) => {
    try {
      const saved = await invoke<import("./types").PortForwardRule>("save_port_forward", {
        request: { ...data, id: id ?? null },
      });
      setRules((curr) => [saved, ...curr.filter((r) => r.id !== saved.id)]);
      setModalOpen(false);
      setEditingRule(null);
      toast.success(id ? "Rule updated" : "Rule created");
    } catch (err) {
      toast.error("Failed to save rule", { description: String(err) });
    }
  };

  const handleRemove = async (id: string) => {
    try {
      await invoke("remove_port_forwards", { ids: [id] });
      setRules((curr) => curr.filter((r) => r.id !== id));
      setStatuses((curr) => { const next = { ...curr }; delete next[id]; return next; });
      setRemovingId(null);
      toast.success("Rule removed");
    } catch (err) {
      toast.error("Failed to remove rule", { description: String(err) });
    }
  };

  const handleToggle = async (ruleId: string) => {
    const current = statuses[ruleId];
    try {
      if (current?.active) {
        const s = await invoke<import("./types").TunnelStatus>("stop_tunnel", { ruleId });
        setStatuses((curr) => ({ ...curr, [ruleId]: s }));
        toast.success("Tunnel stopped");
      } else {
        const s = await invoke<import("./types").TunnelStatus>("start_tunnel", { ruleId });
        setStatuses((curr) => ({ ...curr, [ruleId]: s }));
        if (s.active) toast.success("Tunnel started");
        else toast.error("Tunnel failed to start", { description: s.error ?? "Unknown error" });
      }
    } catch (err) {
      toast.error("Tunnel operation failed", { description: String(err) });
    }
  };

  const filtered = rules.filter((r) =>
    `${r.name} ${r.localHost}:${r.localPort} ${r.remoteHost}:${r.remotePort}`.toLowerCase().includes(query.toLowerCase())
  );

  const getHostName = (hostId: string) => {
    const h = hosts.find((x) => x.id === hostId);
    return h ? (h.name || h.hostname) : "Unknown host";
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <button
          onClick={() => { setEditingRule(null); setModalOpen(true); }}
          className="flex h-7 items-center gap-1 rounded-md bg-[var(--color-surface-2)] px-2.5 text-xs font-medium text-foreground hover:bg-white/5"
        >
          <Plus className="h-3.5 w-3.5" /> New forwarding
        </button>
        <div className="flex items-center gap-1">
          {searchOpen ? (
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onBlur={() => { if (!query) setSearchOpen(false); }}
              onKeyDown={(e) => { if (e.key === "Escape") { setQuery(""); setSearchOpen(false); } }}
              placeholder="Search..."
              className="h-7 w-40 rounded-md border border-border bg-[var(--color-surface-2)] px-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring/40"
            />
          ) : (
            <button
              onClick={() => setSearchOpen(true)}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-foreground"
              title="Search"
            >
              <Search className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex flex-1 flex-col overflow-y-auto px-4 py-4">
        {loading ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Loading...</div>
        ) : filtered.length === 0 && !query ? (
          <EmptyState
            icon={Network}
            title="Set up port forwarding"
            subtitle="Save port forwarding rules to access databases, web apps, and other services through SSH tunnels."
          />
        ) : filtered.length === 0 && query ? (
          <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
            No rules match "{query}"
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {filtered.map((rule) => {
              const status = statuses[rule.id];
              const active = status?.active ?? false;
              const hasError = !!status?.error;
              return (
                <div
                  key={rule.id}
                  className="group flex items-center gap-4 rounded-lg border border-border bg-[var(--color-surface)] p-4 transition hover:border-[var(--color-brand-orange)]/40"
                >
                  {/* Status indicator + toggle */}
                  <button
                    onClick={() => void handleToggle(rule.id)}
                    className={[
                      "flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition",
                      active
                        ? "bg-[oklch(0.65_0.18_145)]/20 text-[oklch(0.65_0.18_145)] hover:bg-[oklch(0.65_0.2_25)]/20 hover:text-[oklch(0.65_0.2_25)]"
                        : "bg-[var(--color-surface-2)] text-muted-foreground hover:bg-[oklch(0.65_0.18_145)]/20 hover:text-[oklch(0.65_0.18_145)]",
                    ].join(" ")}
                    title={active ? "Stop tunnel" : "Start tunnel"}
                  >
                    {active ? <X className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                  </button>

                  {/* Info */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{rule.name}</span>
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                        rule.direction === "local" ? "bg-[oklch(0.65_0.15_230)]/15 text-[oklch(0.65_0.15_230)]"
                        : rule.direction === "remote" ? "bg-[oklch(0.65_0.18_145)]/15 text-[oklch(0.65_0.18_145)]"
                        : "bg-[var(--color-brand-yellow)]/15 text-[var(--color-brand-yellow)]"
                      }`}>
                        {rule.direction}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-mono">{rule.localHost}:{rule.localPort}</span>
                      <span>→</span>
                      {rule.direction === "dynamic" ? (
                        <span className="font-mono">SOCKS proxy</span>
                      ) : (
                        <span className="font-mono">{rule.remoteHost}:{rule.remotePort}</span>
                      )}
                      <span className="text-muted-foreground/60">via</span>
                      <span>{getHostName(rule.hostId)}</span>
                    </div>
                    {/* Status line */}
                    <div className="mt-1.5 flex items-center gap-2 text-[11px]">
                      {active ? (
                        <span className="flex items-center gap-1.5 font-medium text-[oklch(0.65_0.18_145)]">
                          <span className="h-1.5 w-1.5 rounded-full bg-[oklch(0.65_0.18_145)] animate-pulse" />
                          Connected{status?.pid ? ` (PID ${status.pid})` : ""}
                        </span>
                      ) : hasError ? (
                        <span className="flex items-center gap-1.5 font-medium text-[oklch(0.65_0.2_25)]">
                          <span className="h-1.5 w-1.5 rounded-full bg-[oklch(0.65_0.2_25)]" />
                          Failed: {status.error}
                        </span>
                      ) : (
                        <span className="flex items-center gap-1.5 text-muted-foreground">
                          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
                          Disconnected
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    <button
                      title="Edit"
                      onClick={() => { setEditingRule(rule); setModalOpen(true); }}
                      className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-foreground"
                    >
                      <Settings className="h-3.5 w-3.5" />
                    </button>
                    <button
                      title="Delete"
                      onClick={() => setRemovingId(rule.id)}
                      className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-[oklch(0.72_0.18_25)]"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Modal: Create / Edit */}
      {modalOpen && (
        <PortForwardModal
          rule={editingRule}
          hosts={hosts}
          onClose={() => { setModalOpen(false); setEditingRule(null); }}
          onSubmit={(data) => void handleSave(data, editingRule?.id)}
        />
      )}

      {/* Modal: Remove confirmation */}
      {removingId && (
        <RemovePortForwardModal
          name={rules.find((r) => r.id === removingId)?.name ?? "this rule"}
          onClose={() => setRemovingId(null)}
          onConfirm={() => void handleRemove(removingId)}
        />
      )}
    </div>
  );
}

function PortForwardModal({
  rule,
  hosts,
  onClose,
  onSubmit,
}: {
  rule?: import("./types").PortForwardRule | null;
  hosts: Host[];
  onClose: () => void;
  onSubmit: (data: Omit<import("./types").PortForwardRule, "id" | "createdAt">) => void;
}) {
  const [name, setName] = useState(rule?.name ?? "");
  const [hostId, setHostId] = useState(rule?.hostId ?? (hosts[0]?.id ?? ""));
  const [direction, setDirection] = useState<import("./types").TunnelDirection>(rule?.direction ?? "local");
  const [localHost, setLocalHost] = useState(rule?.localHost ?? "127.0.0.1");
  const [localPort, setLocalPort] = useState(rule?.localPort ?? 0);
  const [remoteHost, setRemoteHost] = useState(rule?.remoteHost ?? "127.0.0.1");
  const [remotePort, setRemotePort] = useState(rule?.remotePort ?? 0);
  const [autoConnect, setAutoConnect] = useState(rule?.autoConnect ?? false);

  const valid = name.trim() && hostId && localPort > 0 && (direction === "dynamic" || remotePort > 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="flex max-h-[75vh] w-[520px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-border bg-[var(--color-surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border bg-[var(--color-sidebar)] px-5 py-3">
          <h3 className="text-sm font-semibold text-foreground">{rule ? "Edit Port Forward" : "New Port Forward"}</h3>
          <button onClick={onClose} className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition hover:bg-[var(--color-surface-2)] hover:text-foreground">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="border-t border-border">
            <HostModalRow label="Name">
              <HostModalInput autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. My Database" />
            </HostModalRow>
            <HostModalRow label="Host">
              <Select value={hostId} onValueChange={setHostId}>
                <SelectTrigger className="h-8 w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {hosts.map((h) => (
                    <SelectItem key={h.id} value={h.id}>{h.name || h.hostname}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </HostModalRow>
            <HostModalRow label="Direction">
              <Select value={direction} onValueChange={(val) => setDirection(val as import("./types").TunnelDirection)}>
                <SelectTrigger className="h-8 w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="local">Local (-L)</SelectItem>
                  <SelectItem value="remote">Remote (-R)</SelectItem>
                  <SelectItem value="dynamic">Dynamic SOCKS (-D)</SelectItem>
                </SelectContent>
              </Select>
            </HostModalRow>
            <HostModalRow label="Local Host">
              <HostModalInput value={localHost} onChange={(e) => setLocalHost(e.target.value)} placeholder="127.0.0.1" />
            </HostModalRow>
            <HostModalRow label="Local Port">
              <input
                type="number"
                value={localPort || ""}
                onChange={(e) => setLocalPort(Number(e.target.value) || 0)}
                placeholder="e.g. 3306"
                dir="ltr"
                className="h-8 w-24 rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 text-left text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-[var(--color-brand-orange)]/40"
              />
            </HostModalRow>
            {direction !== "dynamic" && (
              <>
                <HostModalRow label="Remote Host">
                  <HostModalInput value={remoteHost} onChange={(e) => setRemoteHost(e.target.value)} placeholder="127.0.0.1" />
                </HostModalRow>
                <HostModalRow label="Remote Port">
                  <input
                    type="number"
                    value={remotePort || ""}
                    onChange={(e) => setRemotePort(Number(e.target.value) || 0)}
                    placeholder="e.g. 3306"
                    dir="ltr"
                    className="h-8 w-24 rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 text-left text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-[var(--color-brand-orange)]/40"
                  />
                </HostModalRow>
              </>
            )}
            <HostModalRow label="Auto-connect">
              <HostModalToggle checked={autoConnect} onChange={setAutoConnect} />
            </HostModalRow>
          </div>
          <div className="px-4 pb-2 pt-1.5">
            <p className="text-[11px] text-muted-foreground">
              {direction === "local" && "Local: binds a local port and forwards traffic through SSH to the remote destination."}
              {direction === "remote" && "Remote: binds a port on the remote server and forwards traffic back to your local machine."}
              {direction === "dynamic" && "Dynamic: creates a local SOCKS proxy that routes traffic through the SSH connection."}
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border bg-[var(--color-sidebar)] px-5 py-3">
          <button onClick={onClose} className="rounded-md px-4 py-1.5 text-sm font-medium text-muted-foreground transition hover:bg-[var(--color-surface-2)] hover:text-foreground">
            Cancel
          </button>
          <button
            onClick={() => valid && onSubmit({ name: name.trim(), hostId, direction, localHost: localHost.trim() || "127.0.0.1", localPort, remoteHost: remoteHost.trim() || "127.0.0.1", remotePort, autoConnect })}
            disabled={!valid}
            className="rounded-md bg-[var(--color-brand-orange)] px-4 py-1.5 text-sm font-semibold text-[var(--color-primary-foreground)] disabled:cursor-not-allowed disabled:opacity-50 hover:enabled:opacity-90"
          >
            {rule ? "Save" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

function RemovePortForwardModal({
  name, onClose, onConfirm,
}: {
  name: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="w-[480px] max-w-[92vw] overflow-hidden rounded-lg border border-border bg-[var(--color-surface)] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border bg-[var(--color-sidebar)] px-5 py-3">
          <h3 className="text-sm font-semibold text-foreground">Remove port forward</h3>
          <button onClick={onClose} className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-muted-foreground transition hover:bg-[var(--color-surface-2)] hover:text-foreground">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="px-5 py-6">
          <p className="text-sm text-foreground">
            Are you sure you want to remove <span className="font-semibold">{name}</span>? Active tunnels will be stopped.
          </p>
          <div className="mt-6 flex items-center justify-end">
            <button onClick={onConfirm} className="cursor-pointer rounded-md bg-[oklch(0.68_0.17_25)] px-5 py-1.5 text-sm font-semibold text-white transition hover:opacity-90">
              Remove
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function EmptyState({
  icon: Icon,
  title,
  subtitle,
  cta,
}: {
  icon: typeof Server;
  title: string;
  subtitle: string;
  cta?: string;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-[var(--color-surface-2)]">
        <Icon className="h-6 w-6 text-muted-foreground" />
      </div>
      <h3 className="mt-5 text-base font-semibold text-foreground">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{subtitle}</p>
      {cta && (
        <button className="mt-5 rounded-md bg-[var(--color-brand-orange)] px-4 py-2 text-xs font-semibold text-[var(--color-primary-foreground)] hover:opacity-90">
          {cta}
        </button>
      )}
    </div>
  );
}

/* ---------------- SSH Keys view ---------------- */

function SshKeysView() {
  const [keys, setKeys] = useState<SshKey[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showGenerate, setShowGenerate] = useState(false);
  const [removing, setRemoving] = useState<string[] | null>(null);
  const [viewMode, setViewMode] = useState<"grid" | "list">(() => {
    const saved = localStorage.getItem("sshkeys-view-mode");
    return saved === "list" ? "list" : "grid";
  });
  const [viewOpen, setViewOpen] = useState(false);
  const [sortDir, setSortDir] = useState<"desc" | "asc">(() => {
    const saved = localStorage.getItem("sshkeys-sort-dir");
    return saved === "asc" ? "asc" : "desc";
  });
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [sshKeyError, setSshKeyError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (searchOpen) searchRef.current?.focus(); }, [searchOpen]);
  useEffect(() => { localStorage.setItem("sshkeys-view-mode", viewMode); }, [viewMode]);
  useEffect(() => { localStorage.setItem("sshkeys-sort-dir", sortDir); }, [sortDir]);
  useEffect(() => {
    let cancelled = false;

    invoke<SshKey[]>("list_ssh_keys")
      .then((items) => {
        if (!cancelled) {
          setKeys(items);
          setSshKeyError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setSshKeyError(String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const toggleSelect = (id: string, additive: boolean) => {
    setSelected((curr) => {
      if (!additive) {
        return curr.has(id) && curr.size === 1 ? new Set() : new Set([id]);
      }

      const next = new Set(curr);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const copyPublicKey = (key: SshKey) => {
    if (!key.publicKey) return;
    navigator.clipboard
      .writeText(key.publicKey)
      .then(() => {
        toast.success("Public key copied", {
          description: `${key.name} public key copied to clipboard.`,
        });
      })
      .catch((err) => {
        const message = `Copy public key failed: ${String(err)}`;
        setSshKeyError(message);
        toast.error("Copy failed", { description: message });
      });
  };

  const remove = async (ids: string[]) => {
    try {
      await invoke("remove_ssh_keys", { ids });
      setKeys((curr) => curr.filter((k) => !ids.includes(k.id)));
      setSelected(new Set());
      setRemoving(null);
      setSshKeyError(null);
    } catch (err) {
      setSshKeyError(String(err));
    }
  };

  const addKey = (key: SshKey) => {
    setKeys((curr) => [key, ...curr.filter((item) => item.id !== key.id)]);
    setShowGenerate(false);
    setSshKeyError(null);
  };

  const selectedIds = Array.from(selected);

  const visible = keys
    .filter((k) => {
      if (!query.trim()) return true;
      const q = query.toLowerCase();
      return (
        k.name.toLowerCase().includes(q) ||
        k.fingerprint.toLowerCase().includes(q) ||
        (k.remark?.toLowerCase().includes(q) ?? false)
      );
    })
    .sort((a, b) => {
      const da = new Date(a.createdAt).getTime();
      const db = new Date(b.createdAt).getTime();
      return sortDir === "desc" ? db - da : da - db;
    });

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowGenerate(true)}
            className="flex h-7 items-center gap-1 rounded-md bg-[var(--color-surface-2)] px-2.5 text-xs font-medium text-foreground hover:bg-white/5"
          >
            <Plus className="h-3.5 w-3.5" /> New key
          </button>
          {selectedIds.length > 0 && (
            <button
              onClick={() => setRemoving(selectedIds)}
              className="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-[oklch(0.72_0.18_25)] hover:bg-[var(--color-surface-2)]"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Remove ({selectedIds.length})
            </button>
          )}
        </div>
        <div className="flex items-center gap-1">
          <div className="flex items-center">
            {searchOpen && (
              <div className="mr-1 flex h-7 items-center gap-1.5 rounded-md border border-border bg-[var(--color-surface)] px-2">
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Escape") { setQuery(""); setSearchOpen(false); } }}
                  placeholder="Search keys…"
                  className="h-full w-44 bg-transparent text-xs text-foreground placeholder:text-muted-foreground focus:outline-none"
                />
                {query && (
                  <button onClick={() => setQuery("")} className="text-muted-foreground hover:text-foreground" title="Clear">
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            )}
            <button
              onClick={() => setSearchOpen((v) => !v)}
              className={`flex h-7 w-7 items-center justify-center rounded-md hover:bg-[var(--color-surface-2)] ${searchOpen ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              title="Search"
            >
              <Search className="h-4 w-4" />
            </button>
          </div>

          <div className="relative">
            <button
              onClick={() => setViewOpen((v) => !v)}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-foreground"
              title={viewMode === "grid" ? "Grid view" : "List view"}
            >
              {viewMode === "grid" ? <LayoutGrid className="h-4 w-4" /> : <List className="h-4 w-4" />}
            </button>
            {viewOpen && (
              <div
                className="absolute right-0 top-full z-30 mt-1 w-40 overflow-hidden rounded-lg border border-border bg-popover shadow-2xl"
                onMouseLeave={() => setViewOpen(false)}
              >
                <button
                  onClick={() => { setViewMode("grid"); setViewOpen(false); }}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-[var(--color-surface-2)] ${viewMode === "grid" ? "text-foreground" : "text-muted-foreground"}`}
                >
                  <LayoutGrid className="h-4 w-4" /> Grid view
                </button>
                <button
                  onClick={() => { setViewMode("list"); setViewOpen(false); }}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-[var(--color-surface-2)] ${viewMode === "list" ? "text-foreground" : "text-muted-foreground"}`}
                >
                  <List className="h-4 w-4" /> List view
                </button>
              </div>
            )}
          </div>

          <button
            onClick={() => setSortDir((d) => (d === "desc" ? "asc" : "desc"))}
            className="flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-foreground"
            title={sortDir === "desc" ? "Newest first" : "Oldest first"}
          >
            <ArrowUpDown className="h-3.5 w-3.5" />
            {sortDir === "desc" ? "Newest" : "Oldest"}
          </button>
        </div>
      </div>

      {sshKeyError && (
        <div className="mx-4 mt-4 rounded-md border border-[oklch(0.55_0.2_25)]/40 bg-[oklch(0.55_0.2_25)]/10 px-3 py-2 text-xs text-[oklch(0.72_0.18_25)]">
          {sshKeyError}
        </div>
      )}

      {keys.length === 0 ? (
        loading ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Loading SSH keys…
          </div>
        ) : (
          <SshKeysEmpty />
        )
      ) : (
        <div className="flex-1 overflow-y-auto px-4 py-4">
          <h2 className="mb-3 text-sm font-semibold text-foreground">SSH Keys</h2>
          {visible.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              No keys match “{query}”.
            </div>
          ) : viewMode === "grid" ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {visible.map((k) => (
                <SshKeyCard
                  key={k.id}
                  k={k}
                  selected={selected.has(k.id)}
                  onClick={(e) => toggleSelect(k.id, e.metaKey || e.ctrlKey || e.shiftKey)}
                  onCopy={() => copyPublicKey(k)}
                  onRemove={() => setRemoving([k.id])}
                />
              ))}
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border bg-[var(--color-surface)]">
              {visible.map((k, i) => {
                const isSel = selected.has(k.id);
                return (
                  <div
                    key={k.id}
                    onClick={(e) => toggleSelect(k.id, e.metaKey || e.ctrlKey || e.shiftKey)}
                    className={[
                      "group flex cursor-pointer items-center gap-3 px-3 py-2.5 text-left transition",
                      i > 0 ? "border-t border-border" : "",
                      isSel ? "bg-[var(--color-brand-orange)]/10" : "hover:bg-[var(--color-surface-2)]",
                    ].join(" ")}
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[oklch(0.55_0.16_85)] text-white">
                      <KeyRound className="h-4 w-4" />
                    </span>
                    <div className="w-48 shrink-0 truncate text-sm font-medium text-foreground">{k.name}</div>
                    <span className="shrink-0 rounded border border-border bg-[var(--color-surface-2)] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                      {k.type}{k.type === "rsa" && k.size ? ` ${k.size}` : ""}
                    </span>
                    <div className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{k.fingerprint}</div>
                    {k.hasPassphrase && (
                      <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-[oklch(0.7_0.15_150)]" />
                    )}
                    <div className="hidden shrink-0 text-xs text-muted-foreground md:block">
                      {new Date(k.createdAt).toLocaleDateString()}
                    </div>
                    <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        title="Copy public key"
                        onClick={(e) => { e.stopPropagation(); copyPublicKey(k); }}
                        className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-foreground"
                      >
                        <Clipboard className="h-3.5 w-3.5" />
                      </button>
                      <button
                        title="Remove"
                        onClick={(e) => { e.stopPropagation(); setRemoving([k.id]); }}
                        className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-[oklch(0.72_0.18_25)]"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {showGenerate && <GenerateSshKeyModal onClose={() => setShowGenerate(false)} onCreated={addKey} />}
      {removing && (
        <RemoveSshKeyModal
          count={removing.length}
          onClose={() => setRemoving(null)}
          onConfirm={() => void remove(removing)}
        />
      )}
    </div>
  );
}

function SshKeyCard({
  k, selected, onClick, onCopy, onRemove,
}: {
  k: SshKey;
  selected: boolean;
  onClick: (e: React.MouseEvent) => void;
  onCopy: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={[
        "group relative flex cursor-pointer flex-col gap-3 rounded-lg border p-3.5 text-left transition",
        selected
          ? "border-[var(--color-brand-orange)]/60 bg-[var(--color-brand-orange)]/10"
          : "border-border bg-[var(--color-surface)] hover:border-[var(--color-brand-orange)]/40 hover:bg-[var(--color-surface-2)]",
      ].join(" ")}
    >
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-[oklch(0.55_0.16_85)] text-white">
          <KeyRound className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <div className="truncate text-sm font-medium text-foreground">{k.name}</div>
            {k.hasPassphrase && (
              <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-[oklch(0.7_0.15_150)]" />
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5">
            <span className="rounded border border-border bg-[var(--color-surface-2)] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              {k.type}{k.type === "rsa" && k.size ? ` ${k.size}` : ""}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {new Date(k.createdAt).toLocaleDateString()}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            title="Copy public key"
            onClick={(e) => { e.stopPropagation(); onCopy(); }}
            className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-foreground"
          >
            <Clipboard className="h-3.5 w-3.5" />
          </button>
          <button
            title="Remove"
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-[oklch(0.72_0.18_25)]"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="truncate font-mono text-[11px] text-muted-foreground" title={k.fingerprint}>
        {k.fingerprint}
      </div>
      {k.remark && (
        <div className="truncate text-xs text-muted-foreground">{k.remark}</div>
      )}
    </div>
  );
}

function RemoveSshKeyModal({
  count, onClose, onConfirm,
}: { count: number; onClose: () => void; onConfirm: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-sm rounded-xl border border-border bg-[var(--color-surface)] p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-foreground">Remove SSH key</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          Are you sure you want to remove {count} key{count > 1 ? "s" : ""}? This action cannot be undone.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="h-8 rounded-md border border-border bg-[var(--color-surface)] px-3 text-xs font-medium text-foreground hover:bg-[var(--color-surface-2)]">
            Cancel
          </button>
          <button onClick={onConfirm} className="h-8 rounded-md bg-[oklch(0.55_0.2_25)] px-3 text-xs font-medium text-white hover:bg-[oklch(0.5_0.2_25)]">
            Remove
          </button>
        </div>
      </div>
    </div>
  );
}

function SshKeysEmpty() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
      <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-[var(--color-surface-2)]">
        <KeyRound className="h-9 w-9 text-muted-foreground" strokeWidth={1.5} />
      </div>
      <h3 className="mt-5 text-base font-semibold text-foreground">Create SSH key</h3>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        Generate or import SSH keys to connect to your saved hosts securely.
      </p>
    </div>
  );
}


type KeyType = "ed25519" | "rsa";
type KeySize = 1024 | 2048 | 4096;

function GenerateSshKeyModal({ onClose, onCreated }: { onClose: () => void; onCreated: (key: SshKey) => void }) {
  const [name, setName] = useState("");
  const [keyType, setKeyType] = useState<KeyType>("ed25519");
  const [keySize, setKeySize] = useState<KeySize>(2048);
  const [passphrase, setPassphrase] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  

  const canCreate = name.trim().length > 0 && !creating;
  const createKey = async () => {
    if (!canCreate) return;
    setCreating(true);
    setError(null);

    try {
      const key = await invoke<SshKey>("generate_ssh_key", {
        request: {
          name: name.trim(),
          type: keyType,
          size: keyType === "rsa" ? keySize : null,
          passphrase,
          remark: name.trim(),
        },
      });
      onCreated(key);
    } catch (err) {
      setError(String(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[480px] max-w-[92vw] overflow-hidden rounded-lg border border-border bg-[var(--color-surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border bg-[var(--color-sidebar)] px-5 py-3">
          <h3 className="text-sm font-semibold text-foreground">Generate SSH Key</h3>
          <button
            onClick={onClose}
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-muted-foreground transition hover:bg-[var(--color-surface-2)] hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Body */}
        <div className="space-y-6 px-5 py-5">
          {/* Key Information */}
          <div className="space-y-4">
            <SectionTitle title="Key Information" />

            {/* Name */}
            <FieldRow label="Name">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. production-server-key"
                className="w-full rounded-md border border-border bg-[var(--color-surface-2)] px-3 py-2 text-sm text-foreground outline-none transition placeholder:text-muted-foreground/60 focus:border-[var(--color-brand-orange)]/60 focus:ring-2 focus:ring-[var(--color-brand-orange)]/20"
              />
            </FieldRow>

            {/* Key Type */}
            <FieldRow label="Key Type">
              <div className="grid grid-cols-2 gap-2">
                {(["ed25519", "rsa"] as KeyType[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setKeyType(t)}
                    className={`flex cursor-pointer items-center justify-center rounded-md border px-3 py-2 text-sm font-medium transition ${
                      keyType === t
                        ? "border-[var(--color-brand-orange)]/60 bg-[var(--color-brand-orange)]/10 text-[var(--color-brand-orange)]"
                        : "border-border bg-[var(--color-surface-2)] text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {t === "ed25519" ? "ed25519" : "RSA"}
                  </button>
                ))}
              </div>
            </FieldRow>

            {/* Key Size (RSA only) */}
            {keyType === "rsa" && (
              <FieldRow label="Key Size">
                <Segmented
                  value={String(keySize)}
                  onChange={(v) => setKeySize(Number(v) as KeySize)}
                  options={[
                    { value: "1024", label: "1024" },
                    { value: "2048", label: "2048" },
                    { value: "4096", label: "4096" },
                  ]}
                />
              </FieldRow>
            )}

            {/* Passphrase */}
            <FieldRow
              label="Passphrase"
              hint="Optional"
            >
              <div className="relative">
                <input
                  type={showPass ? "text" : "password"}
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder="Enter a secure passphrase"
                  className="w-full rounded-md border border-border bg-[var(--color-surface-2)] px-3 py-2 pr-9 text-sm text-foreground outline-none transition placeholder:text-muted-foreground/60 focus:border-[var(--color-brand-orange)]/60 focus:ring-2 focus:ring-[var(--color-brand-orange)]/20"
                />
                <button
                  type="button"
                  onClick={() => setShowPass((s) => !s)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground transition hover:text-foreground"
                >
                  {showPass ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </div>
            </FieldRow>
          </div>
          {error && (
            <div className="rounded-md border border-[oklch(0.55_0.2_25)]/40 bg-[oklch(0.55_0.2_25)]/10 px-3 py-2 text-xs text-[oklch(0.72_0.18_25)]">
              {error}
            </div>
          )}

        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-border bg-[var(--color-sidebar)] px-5 py-3">
          <button
            onClick={onClose}
            className="cursor-pointer rounded-md px-4 py-1.5 text-sm font-medium text-muted-foreground transition hover:bg-[var(--color-surface-2)] hover:text-foreground"
          >
            Cancel
          </button>
          <button
            disabled={!canCreate}
            onClick={() => void createKey()}
            className="cursor-pointer rounded-md bg-[var(--color-brand-orange)] px-4 py-1.5 text-sm font-semibold text-[var(--color-primary-foreground)] transition disabled:cursor-not-allowed disabled:opacity-50 hover:enabled:opacity-90"
          >
            {creating ? "Creating…" : "Create Key"}
          </button>
        </div>
      </div>
    </div>
  );
}

function FieldRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-foreground">{label}</label>
        {hint && <span className="text-[11px] font-normal text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function SectionTitle({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="h-px flex-1 bg-border" />
      <h3 className="text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
        {title}
      </h3>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function Segmented({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="flex gap-1 rounded-md border border-border bg-[var(--color-surface-2)] p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`flex-1 rounded-sm py-1 text-xs font-medium transition ${
            value === o.value
              ? "bg-[var(--color-sidebar-active)] text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------------- SFTP view ---------------- */

function SftpConnectingOverlay({
  message, hostTitle, hostLabel, failed, error, onRetry, onChangeHost,
}: {
  message: string;
  hostTitle: string;
  hostLabel: string;
  failed: boolean;
  error: string | null;
  onRetry: () => void;
  onChangeHost: () => void;
}) {
  const accent = failed ? "oklch(0.55 0.18 25)" : "oklch(0.55 0.14 145)";
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-background">
      {/* Icon with pulsing glow rings */}
      <div className="relative mb-8 flex items-center justify-center">
        {!failed && (
          <>
            <span
              className="absolute h-24 w-24 animate-ping rounded-full opacity-10"
              style={{ background: accent, animationDuration: "2s" }}
            />
            <span
              className="absolute h-16 w-16 animate-ping rounded-full opacity-15"
              style={{ background: accent, animationDuration: "2s", animationDelay: "0.4s" }}
            />
          </>
        )}
        <div
          className="relative flex h-14 w-14 items-center justify-center rounded-2xl"
          style={{
            background: `color-mix(in oklab, ${accent} 18%, var(--color-surface))`,
            border: `1px solid color-mix(in oklab, ${accent} 35%, transparent)`,
            boxShadow: `0 0 32px color-mix(in oklab, ${accent} 20%, transparent)`,
          }}
        >
          <Folder className="h-7 w-7" style={{ color: accent }} />
        </div>
      </div>

      {/* Host info */}
      <h2 className="text-lg font-semibold tracking-tight text-foreground">
        {hostTitle || "SFTP"}
      </h2>
      {hostLabel && (
        <p className="mt-1 text-xs text-muted-foreground">{hostLabel}</p>
      )}

      {/* Status / error */}
      {!failed ? (
        <p className="mt-6 text-xs text-muted-foreground">{message || "Connecting..."}</p>
      ) : (
        <div className="mt-6 flex w-full max-w-xs flex-col items-center gap-4">
          <p className="text-center text-xs text-red-400">{error}</p>
          <div className="flex w-full gap-2">
            <button
              className="flex-1 rounded-lg border border-border bg-[var(--color-surface-2)] py-2 text-xs font-semibold text-foreground hover:bg-white/5"
              onClick={onRetry}
            >
              Retry
            </button>
            <button
              className="flex-1 rounded-lg border border-border bg-[var(--color-surface-2)] py-2 text-xs font-semibold text-muted-foreground hover:bg-white/5"
              onClick={onChangeHost}
            >
              Change host
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function SftpView({ tab }: { tab: AppTab }) {
  const homeDir = "/Users/" + (typeof window !== "undefined"
    ? window.navigator.userAgent.match(/Mac/) ? "admin" : "user"
    : "user");

  const [localPath, setLocalPath] = useState(homeDir);
  const [localFiles, setLocalFiles] = useState<LocalFileEntry[]>([]);
  const [localLoading, setLocalLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const [sftpSessionId] = useState(() => `sftp-${tab.id}-${Date.now()}`);
  const [pickedHostId, setPickedHostId] = useState<string | undefined>(tab.sftpHostId);
  const [allHosts, setAllHosts] = useState<Host[]>([]);
  const [hostQuery, setHostQuery] = useState("");
  const [isConnected, setIsConnected] = useState(false);
  // Start in "connecting" immediately if a host is pre-selected — avoids first-render flash
  const [isConnecting, setIsConnecting] = useState(!!tab.sftpHostId);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectStage, setConnectStage] = useState<"connecting" | "handshaking" | "authenticating" | "ready">("connecting");
  const [connectMessage, setConnectMessage] = useState(tab.sftpHostId ? "Opening TCP connection..." : "");
  const [connectLogs, setConnectLogs] = useState<string[]>([]);
  // Use tab.title so host name shows immediately without waiting for host list load
  const [connectHostTitle, setConnectHostTitle] = useState(tab.sftpHostId ? (tab.title || "SFTP") : "");
  const [connectHostLabel, setConnectHostLabel] = useState("");
  const [remotePath, setRemotePath] = useState("/");
  const [remoteFiles, setRemoteFiles] = useState<RemoteFileEntry[]>([]);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [watchedFile, setWatchedFile] = useState<{ tmpPath: string; remotePath: string; changed: boolean } | null>(null);

  // Load hosts for picker (only when no host is pre-selected)
  useEffect(() => {
    if (!tab.sftpHostId) {
      invoke<{ hosts: Host[] }>("list_hosts")
        .then((v) => setAllHosts(v.hosts))
        .catch(() => {});
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [selectedLocal, setSelectedLocal] = useState<Set<string>>(new Set());
  const [selectedRemote, setSelectedRemote] = useState<Set<string>>(new Set());
  const [lastLocalClick, setLastLocalClick] = useState<string | null>(null);
  const [lastRemoteClick, setLastRemoteClick] = useState<string | null>(null);
  const [transferProgress, setTransferProgress] = useState<TransferProgress | null>(null);
  const [transferOverall, setTransferOverall] = useState<{ current: number; total: number; fileName: string } | null>(null);
  const [transferError, setTransferError] = useState<string | null>(null);
  const [localDragOver, setLocalDragOver] = useState(false);
  const [remoteDragOver, setRemoteDragOver] = useState(false);
  const [showHiddenLocal, setShowHiddenLocal] = useState(false);
  const [showHiddenRemote, setShowHiddenRemote] = useState(false);
  const [localMenuOpen, setLocalMenuOpen] = useState(false);
  const [remoteMenuOpen, setRemoteMenuOpen] = useState(false);
  const [localClipboard, setLocalClipboard] = useState<string[]>([]);
  const [remoteClipboard, setRemoteClipboard] = useState<string[]>([]);
  const [renameTarget, setRenameTarget] = useState<{ path: string; name: string; isLocal: boolean } | null>(null);
  const [permTarget, setPermTarget] = useState<string | null>(null);
  const [openWithTarget, setOpenWithTarget] = useState<{ path: string; isLocal: boolean } | null>(null);
  const [openWithApp, setOpenWithApp] = useState("");

  // Resizable divider — 50% default
  const [localWidthPct, setLocalWidthPct] = useState(50);
  const paneContainerRef = useRef<HTMLDivElement>(null);

  const onDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const container = paneContainerRef.current;
    if (!container) return;
    const stripWidth = 48;
    const containerWidth = container.getBoundingClientRect().width - stripWidth;
    const startPct = localWidthPct;

    const onMove = (mv: MouseEvent) => {
      const delta = mv.clientX - startX;
      const newPct = Math.max(20, Math.min(80, startPct + (delta / containerWidth) * 100));
      setLocalWidthPct(newPct);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [localWidthPct]);

  // Listen for progress events
  useEffect(() => {
    if (!isConnected) return;
    const unlisten = listen<TransferProgress>(`sftp:${sftpSessionId}:progress`, (event) => {
      setTransferProgress(event.payload);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [isConnected, sftpSessionId]);

  // Listen for file-changed events (remote watch)
  useEffect(() => {
    if (!sftpSessionId) return;
    const unlisten = listen<{ tmp_path: string; remote_path: string }>(
      `sftp:${sftpSessionId}:file-changed`,
      (ev) => {
        setWatchedFile({
          tmpPath: ev.payload.tmp_path,
          remotePath: ev.payload.remote_path,
          changed: true,
        });
      }
    );
    return () => { void unlisten.then((fn) => fn()); };
  }, [sftpSessionId]);

  const handleLocalClick = (e: React.MouseEvent, path: string) => {
    if (e.shiftKey && lastLocalClick) {
      const paths = localFiles.map((f) => f.path);
      const a = paths.indexOf(lastLocalClick);
      const b = paths.indexOf(path);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      setSelectedLocal(new Set(paths.slice(lo, hi + 1)));
    } else if (e.metaKey || e.ctrlKey) {
      setSelectedLocal((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path); else next.add(path);
        return next;
      });
    } else {
      setSelectedLocal(new Set([path]));
    }
    setLastLocalClick(path);
  };

  const handleRemoteClick = (e: React.MouseEvent, path: string) => {
    if (e.shiftKey && lastRemoteClick) {
      const paths = remoteFiles.map((f) => f.path);
      const a = paths.indexOf(lastRemoteClick);
      const b = paths.indexOf(path);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      setSelectedRemote(new Set(paths.slice(lo, hi + 1)));
    } else if (e.metaKey || e.ctrlKey) {
      setSelectedRemote((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path); else next.add(path);
        return next;
      });
    } else {
      setSelectedRemote(new Set([path]));
    }
    setLastRemoteClick(path);
  };

  const invokeTransfer = async (
    command: string,
    args: Record<string, string>,
  ): Promise<void> => {
    let unlisten: (() => void) | undefined;
    try {
      await new Promise<void>(async (resolve, reject) => {
        unlisten = await listen<{ ok: boolean; error?: string }>(
          `sftp:${sftpSessionId}:transfer-done`,
          (ev) => {
            unlisten?.();
            if (ev.payload.ok) resolve();
            else reject(new Error(ev.payload.error ?? "Transfer failed"));
          }
        );
        invoke(command, args).catch((e: unknown) => { unlisten?.(); reject(e); });
      });
    } finally {
      unlisten?.();
    }
  };

  const handleDownload = async (paths?: string[]) => {
    const targets = paths ?? [...selectedRemote];
    if (targets.length === 0 || !isConnected) return;
    setTransferError(null);
    setTransferProgress(null);
    try {
      for (let i = 0; i < targets.length; i++) {
        const rp = targets[i];
        const fileName = rp.split("/").pop() ?? "file";
        setTransferOverall({ current: i + 1, total: targets.length, fileName });
        await invokeTransfer("sftp_download", {
          sessionId: sftpSessionId,
          remotePath: rp,
          localPath: `${localPath}/${fileName}`,
        });
      }
      await loadLocalDir(localPath);
    } catch (e) {
      setTransferError(String(e));
    } finally {
      setTransferProgress(null);
      setTransferOverall(null);
    }
  };

  const handleUpload = async (paths?: string[]) => {
    const targets = paths ?? [...selectedLocal];
    if (targets.length === 0 || !isConnected) return;
    setTransferError(null);
    setTransferProgress(null);
    try {
      for (let i = 0; i < targets.length; i++) {
        const lp = targets[i];
        const fileName = lp.split("/").pop() ?? "file";
        setTransferOverall({ current: i + 1, total: targets.length, fileName });
        await invokeTransfer("sftp_upload", {
          sessionId: sftpSessionId,
          localPath: lp,
          remotePath: `${remotePath}/${fileName}`,
        });
      }
      await loadRemoteDir(remotePath);
    } catch (e) {
      setTransferError(String(e));
    } finally {
      setTransferProgress(null);
      setTransferOverall(null);
    }
  };

  const handleOpenLocal = (path: string) => {
    void invoke("sftp_open_local", { path });
  };

  const handleOpenWithLocal = (path: string, app: string) => {
    void invoke("sftp_open_with_local", { path, app });
  };

  const handleOpenRemote = async (path: string) => {
    const tmpPath = await invoke<string>("sftp_open_remote", { sessionId: sftpSessionId, remotePath: path });
    await invoke("sftp_watch_remote", { sessionId: sftpSessionId, tmpPath, remotePath: path });
  };

  const handleCopyLocal = (paths: string[]) => setLocalClipboard(paths);
  const handlePasteLocal = () => {
    if (!localClipboard.length) return;
    void invoke("sftp_copy_local", { paths: localClipboard, destDir: localPath })
      .then(() => loadLocalDir(localPath))
      .catch((e: unknown) => toast.error(String(e)));
  };

  const handleCopyRemote = (paths: string[]) => setRemoteClipboard(paths);
  const handlePasteRemote = () => {
    if (!remoteClipboard.length || !remotePath) return;
    void invoke("sftp_copy_remote", { sessionId: sftpSessionId, paths: remoteClipboard, destDir: remotePath })
      .then(() => loadRemoteDir(remotePath))
      .catch((e: unknown) => toast.error(String(e)));
  };

  const handleDeleteLocal = (paths: string[]) => {
    void invoke("sftp_delete_local", { paths })
      .then(() => loadLocalDir(localPath))
      .catch((e: unknown) => toast.error(String(e)));
  };

  const handleRenameConfirm = async (newName: string) => {
    if (!renameTarget) return;
    try {
      if (renameTarget.isLocal) {
        await invoke("sftp_rename_local", { path: renameTarget.path, newName });
        await loadLocalDir(localPath);
      } else {
        const dir = renameTarget.path.substring(0, renameTarget.path.lastIndexOf("/")) || "/";
        await invoke("sftp_rename_remote", {
          sessionId: sftpSessionId,
          fromPath: renameTarget.path,
          toPath: `${dir}/${newName}`,
        });
        if (remotePath) await loadRemoteDir(remotePath);
      }
    } catch (e) { toast.error(String(e)); }
    setRenameTarget(null);
  };

  const connectCleanupRef = useRef<(() => void) | null>(null);

  const handleConnect = async (hostId?: string, hostObj?: Host) => {
    const targetHostId = hostId ?? pickedHostId;
    if (!targetHostId) return;
    if (hostId) setPickedHostId(hostId);

    const resolvedHost = hostObj ?? allHosts.find((h) => h.id === targetHostId);
    setConnectHostTitle(resolvedHost?.name || resolvedHost?.hostname || "SFTP");
    setConnectHostLabel(resolvedHost ? `${resolvedHost.user}@${resolvedHost.hostname}:${resolvedHost.port}` : "");

    setIsConnecting(true);
    setConnectError(null);
    setConnectMessage("Connecting...");
    setConnectLogs([]);

    // Subscribe to progress + done events before firing the command
    const [unlistenProgress, unlistenDone] = await Promise.all([
      listen<{ stage: string; message: string }>(`sftp:${sftpSessionId}:connect`, (ev) => {
        setConnectMessage(ev.payload.message);
      }),
      listen<{ ok: boolean; remote_path?: string; error?: string }>(`sftp:${sftpSessionId}:done`, async (ev) => {
        connectCleanupRef.current?.();
        connectCleanupRef.current = null;
        if (ev.payload.ok && ev.payload.remote_path) {
          setIsConnected(true);
          await loadRemoteDir(ev.payload.remote_path);
        } else {
          setConnectError(ev.payload.error ?? "Connection failed");
        }
        setIsConnecting(false);
      }),
    ]);

    const cleanup = () => { unlistenProgress(); unlistenDone(); };
    connectCleanupRef.current = cleanup;

    // Command returns immediately — actual connection runs in Rust background thread
    try {
      await invoke("sftp_connect_from_host", { hostId: targetHostId, sessionId: sftpSessionId });
    } catch (e) {
      // Only fires if credential resolution fails (before background spawn)
      cleanup();
      connectCleanupRef.current = null;
      setConnectError(String(e));
      setIsConnecting(false);
    }
  };

  const loadRemoteDir = async (path: string) => {
    setRemoteLoading(true);
    setRemoteError(null);
    try {
      const files = await invoke<RemoteFileEntry[]>("sftp_list_remote", {
        sessionId: sftpSessionId,
        path,
      });
      setRemoteFiles(files);
      setRemotePath(path);
    } catch (e) {
      setRemoteError(String(e));
    } finally {
      setRemoteLoading(false);
    }
  };

  // Auto-connect on mount if hostId is pre-set
  useEffect(() => {
    if (tab.sftpHostId && !isConnected) {
      void handleConnect();
    }
    return () => {
      connectCleanupRef.current?.();
      connectCleanupRef.current = null;
      void invoke("sftp_disconnect", { sessionId: sftpSessionId }).catch(() => {});
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadLocalDir = async (path: string) => {
    setLocalLoading(true);
    setLocalError(null);
    try {
      const files = await invoke<LocalFileEntry[]>("sftp_list_local", { path });
      setLocalFiles(files);
      setLocalPath(path);
    } catch (e) {
      setLocalError(String(e));
    } finally {
      setLocalLoading(false);
    }
  };

  useEffect(() => {
    void loadLocalDir(localPath);
  }, []); // load on mount

  const localParent = localPath.split("/").slice(0, -1).join("/") || "/";
  const localPathParts = localPath.split("/").filter(Boolean);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {/* Transfer progress bar */}
      {(transferOverall || transferError) && (
        <div className="flex h-9 items-center gap-3 border-b border-border bg-[var(--color-surface-2)] px-4 text-xs">
          {transferError ? (
            <span className="text-red-400">{transferError}</span>
          ) : transferOverall ? (() => {
            const filePct = transferProgress && transferProgress.total_bytes > 0
              ? transferProgress.bytes_transferred / transferProgress.total_bytes
              : 0;
            const overallPct = transferOverall.total > 1
              ? ((transferOverall.current - 1 + filePct) / transferOverall.total) * 100
              : filePct * 100;
            return (
              <>
                {transferOverall.total > 1 && (
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {transferOverall.current}/{transferOverall.total}
                  </span>
                )}
                <span className="min-w-0 truncate text-muted-foreground">{transferOverall.fileName}</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border">
                  <div
                    className="h-full rounded-full bg-[var(--color-brand-cyan)] transition-all"
                    style={{ width: `${Math.round(overallPct)}%` }}
                  />
                </div>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {Math.round(overallPct)}%
                </span>
              </>
            );
          })() : null}
        </div>
      )}
      <div ref={paneContainerRef} className="flex min-h-0 flex-1">
      {/* Local pane */}
      <div
        className={`flex flex-col border-r border-border overflow-hidden transition-colors ${localDragOver ? "bg-[var(--color-brand-cyan)]/5" : ""}`}
        style={{ width: `${localWidthPct}%` }}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; setLocalDragOver(true); }}
        onDragLeave={() => setLocalDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setLocalDragOver(false);
          const data = e.dataTransfer.getData("application/x-sftp-remote");
          if (data) {
            const paths: string[] = JSON.parse(data);
            void handleDownload(paths);
          }
        }}
      >
        <div className="flex h-11 items-center justify-between border-b border-border bg-[var(--color-surface)] px-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <span className="flex h-5 w-5 items-center justify-center rounded bg-[oklch(0.55_0.18_230)]">
              <Folder className="h-3 w-3 text-white" />
            </span>
            Local
          </div>
          <div className="relative">
            <button
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-foreground"
              onClick={() => setLocalMenuOpen((v) => !v)}
            >
              <MoreVertical className="h-3.5 w-3.5" />
            </button>
            {localMenuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setLocalMenuOpen(false)} />
                <div className="absolute right-0 top-full z-20 mt-1 w-44 overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
                  <button
                    className="flex w-full items-center justify-between px-3 py-2 text-xs text-foreground hover:bg-[var(--color-surface)]"
                    onClick={() => { setShowHiddenLocal((v) => !v); setLocalMenuOpen(false); }}
                  >
                    Show hidden files
                    <span className={`h-3.5 w-3.5 rounded border ${showHiddenLocal ? "border-[var(--color-brand-cyan)] bg-[var(--color-brand-cyan)]" : "border-border"}`} />
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Breadcrumb */}
        <div className="flex items-center gap-1 border-b border-border px-4 py-2 text-xs text-muted-foreground overflow-x-auto">
          <button
            className="hover:text-foreground"
            onClick={() => void loadLocalDir("/")}
          >
            /
          </button>
          {localPathParts.map((part, i) => {
            const partPath = "/" + localPathParts.slice(0, i + 1).join("/");
            return (
              <span key={partPath} className="flex items-center gap-1">
                <span className="opacity-40">›</span>
                <button
                  className="hover:text-foreground"
                  onClick={() => void loadLocalDir(partPath)}
                >
                  {part}
                </button>
              </span>
            );
          })}
        </div>

        {/* Column headers + file list — shared horizontal scroll */}
        <div className="flex min-h-0 flex-1 flex-col overflow-x-auto">
          <div className="grid min-w-[560px] grid-cols-[1fr_180px_100px_80px] border-b border-border px-4 py-2 text-[11px] uppercase tracking-wider text-muted-foreground">
            <span>Name</span><span>Date Modified</span><span>Size</span><span>Kind</span>
          </div>
          <div className="flex-1 overflow-y-auto">
            {localLoading && (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">Loading...</div>
            )}
            {localError && (
              <div className="px-4 py-8 text-center text-sm text-red-400">{localError}</div>
            )}
            {!localLoading && !localError && (
              <>
                {localPath !== "/" && (
                  <div
                    className="grid min-w-[560px] grid-cols-[1fr_180px_100px_80px] cursor-pointer items-center px-4 py-2 text-sm hover:bg-[var(--color-surface)]"
                    onDoubleClick={() => void loadLocalDir(localParent)}
                  >
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Folder className="h-4 w-4 text-[oklch(0.7_0.13_230)]" />
                      ..
                    </div>
                    <div /><div /><div />
                  </div>
                )}
                {localFiles.filter((f) => showHiddenLocal || !f.name.startsWith(".")).map((f) => (
                  <SftpContextMenu
                    key={f.path}
                    isLocal={true}
                    isConnected={isConnected}
                    file={f}
                    hasClipboard={localClipboard.length > 0}
                    onOpen={() => handleOpenLocal(f.path)}
                    onOpenWith={() => setOpenWithTarget({ path: f.path, isLocal: true })}
                    onDownload={() => {}}
                    onUpload={() => void handleUpload([f.path])}
                    onCopy={() => handleCopyLocal(selectedLocal.size > 0 ? [...selectedLocal] : [f.path])}
                    onPaste={handlePasteLocal}
                    onRename={() => setRenameTarget({ path: f.path, name: f.name, isLocal: true })}
                    onDelete={() => {
                      const targets = selectedLocal.has(f.path) ? [...selectedLocal] : [f.path];
                      handleDeleteLocal(targets);
                    }}
                    onRefresh={() => void loadLocalDir(localPath)}
                    onEditPermissions={() => {}}
                  >
                  <div
                    draggable={!f.is_dir}
                    onDragStart={(e) => {
                      const toDrag = selectedLocal.has(f.path) ? [...selectedLocal].filter((p) => !localFiles.find((lf) => lf.path === p)?.is_dir) : [f.path];
                      e.dataTransfer.setData("application/x-sftp-local", JSON.stringify(toDrag));
                      e.dataTransfer.effectAllowed = "copy";
                    }}
                    className={`grid min-w-[560px] grid-cols-[1fr_180px_100px_80px] cursor-pointer items-center px-4 py-2 text-sm ${
                      selectedLocal.has(f.path)
                        ? "bg-[var(--color-brand-cyan)]/10 ring-1 ring-inset ring-[var(--color-brand-cyan)]/20"
                        : "hover:bg-[var(--color-surface)]"
                    }`}
                    onClick={(e) => handleLocalClick(e, f.path)}
                    onDoubleClick={() => {
                      if (f.is_dir) void loadLocalDir(f.path);
                    }}
                  >
                    <div className="flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap text-foreground">
                      <Folder className={`h-4 w-4 shrink-0 ${f.is_dir ? "text-[oklch(0.7_0.13_230)]" : "text-muted-foreground"}`} />
                      {f.name}
                    </div>
                    <div className="text-xs text-muted-foreground">{f.modified ?? "—"}</div>
                    <div className="text-xs text-muted-foreground">
                      {f.size != null ? formatBytes(f.size) : "—"}
                    </div>
                    <div className="text-xs text-muted-foreground">{f.is_dir ? "folder" : "file"}</div>
                  </div>
                  </SftpContextMenu>
                ))}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Resizable divider */}
      <div
        className="flex w-6 flex-shrink-0 cursor-col-resize items-center justify-center border-r border-border bg-[var(--color-surface)] select-none"
        onMouseDown={onDividerMouseDown}
      >
        <GripVertical className="h-3.5 w-3.5 text-muted-foreground" />
      </div>

      {/* Remote pane */}
      <div
        className={`flex flex-col overflow-hidden transition-colors ${remoteDragOver ? "bg-[oklch(0.45_0.12_145)]/5" : ""}`}
        style={{ width: `calc(100% - ${localWidthPct}% - 24px)` }}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; setRemoteDragOver(true); }}
        onDragLeave={() => setRemoteDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setRemoteDragOver(false);
          const data = e.dataTransfer.getData("application/x-sftp-local");
          if (data) {
            const paths: string[] = JSON.parse(data);
            void handleUpload(paths);
          }
        }}
      >
        <div className="flex h-11 items-center justify-between border-b border-border bg-[var(--color-surface)] px-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <span className="flex h-5 w-5 items-center justify-center rounded bg-[oklch(0.45_0.12_145)]">
              <Folder className="h-3 w-3 text-white" />
            </span>
            Remote
          </div>
          <div className="flex items-center gap-2">
            {isConnected && (
              <button
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => {
                  void invoke("sftp_disconnect", { sessionId: sftpSessionId });
                  setIsConnected(false);
                  setPickedHostId(undefined);
                  setConnectError(null);
                  setRemoteFiles([]);
                  invoke<{ hosts: Host[] }>("list_hosts").then((v) => setAllHosts(v.hosts)).catch(() => {});
                }}
              >
                Disconnect
              </button>
            )}
            <div className="relative">
              <button
                className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-foreground"
                onClick={() => setRemoteMenuOpen((v) => !v)}
              >
                <MoreVertical className="h-3.5 w-3.5" />
              </button>
              {remoteMenuOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setRemoteMenuOpen(false)} />
                  <div className="absolute right-0 top-full z-20 mt-1 w-44 overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
                    <button
                      className="flex w-full items-center justify-between px-3 py-2 text-xs text-foreground hover:bg-[var(--color-surface)]"
                      onClick={() => { setShowHiddenRemote((v) => !v); setRemoteMenuOpen(false); }}
                    >
                      Show hidden files
                      <span className={`h-3.5 w-3.5 rounded border ${showHiddenRemote ? "border-[var(--color-brand-cyan)] bg-[var(--color-brand-cyan)]" : "border-border"}`} />
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Not connected — host picker (no host selected yet) */}
        {!isConnected && !isConnecting && !pickedHostId && (
          <div className="flex flex-1 flex-col overflow-hidden">
            <div className="border-b border-border px-4 py-3">
              <p className="mb-2 text-xs text-muted-foreground">Select a host to connect</p>
              <div className="flex items-center gap-2 rounded-md border border-border bg-[var(--color-surface-2)] px-3 py-1.5">
                <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <input
                  className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                  placeholder="Search hosts..."
                  value={hostQuery}
                  onChange={(e) => setHostQuery(e.target.value)}
                  autoFocus
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {allHosts.length === 0 && (
                <div className="px-4 py-8 text-center text-xs text-muted-foreground">No saved hosts</div>
              )}
              {allHosts
                .filter((h) => {
                  const q = hostQuery.toLowerCase();
                  return !q || h.name.toLowerCase().includes(q) || h.hostname.toLowerCase().includes(q) || h.user.toLowerCase().includes(q);
                })
                .map((h) => (
                  <button
                    key={h.id}
                    className="flex w-full items-center gap-3 border-b border-border px-4 py-2.5 text-left hover:bg-[var(--color-surface)]"
                    onClick={() => void handleConnect(h.id, h)}
                  >
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-[var(--color-surface-2)]">
                      <Server className="h-3.5 w-3.5 text-muted-foreground" />
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-foreground">{h.name || h.hostname}</div>
                      <div className="truncate text-xs text-muted-foreground">{h.user}@{h.hostname}:{h.port}</div>
                    </div>
                  </button>
                ))}
            </div>
          </div>
        )}

        {/* Connecting — XTerminal-style step indicator */}
        {(isConnecting || (!isConnected && pickedHostId)) && <SftpConnectingOverlay
          message={connectMessage}
          hostTitle={connectHostTitle}
          hostLabel={connectHostLabel}
          failed={!isConnecting && !!connectError}
          error={connectError}
          onRetry={() => void handleConnect()}
          onChangeHost={() => { setPickedHostId(undefined); setConnectError(null); setConnectLogs([]); }}
        />}

        {/* Connected file browser */}
        {isConnected && (
          <>
            {/* Breadcrumb */}
            <div className="flex items-center gap-1 border-b border-border px-4 py-2 text-xs text-muted-foreground overflow-x-auto">
              <button className="hover:text-foreground" onClick={() => void loadRemoteDir("/")}>
                /
              </button>
              {remotePath.split("/").filter(Boolean).map((part, i, arr) => {
                const partPath = "/" + arr.slice(0, i + 1).join("/");
                return (
                  <span key={partPath} className="flex items-center gap-1">
                    <span className="opacity-40">›</span>
                    <button className="hover:text-foreground" onClick={() => void loadRemoteDir(partPath)}>
                      {part}
                    </button>
                  </span>
                );
              })}
            </div>

            {/* Column headers + file list — shared horizontal scroll */}
            <div className="flex min-h-0 flex-1 flex-col overflow-x-auto">
              <div className="grid min-w-[500px] grid-cols-[1fr_160px_90px_70px] border-b border-border px-4 py-2 text-[11px] uppercase tracking-wider text-muted-foreground">
                <span>Name</span><span>Date Modified</span><span>Size</span><span>Kind</span>
              </div>
              <div className="flex-1 overflow-y-auto">
                {remoteLoading && (
                  <div className="px-4 py-8 text-center text-sm text-muted-foreground">Loading...</div>
                )}
                {remoteError && (
                  <div className="px-4 py-8 text-center text-sm text-red-400">{remoteError}</div>
                )}
                {!remoteLoading && !remoteError && (
                  <>
                    {remotePath !== "/" && (
                      <div
                        className="grid min-w-[500px] grid-cols-[1fr_160px_90px_70px] cursor-pointer items-center px-4 py-2 text-sm hover:bg-[var(--color-surface)]"
                        onDoubleClick={() => {
                          const parent = remotePath.split("/").slice(0, -1).join("/") || "/";
                          void loadRemoteDir(parent);
                        }}
                      >
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <Folder className="h-4 w-4 text-[oklch(0.65_0.12_145)]" />
                          ..
                        </div>
                        <div /><div /><div />
                      </div>
                    )}
                    {remoteFiles.filter((f) => showHiddenRemote || !f.name.startsWith(".")).map((f) => (
                      <SftpContextMenu
                        key={f.path}
                        isLocal={false}
                        isConnected={isConnected}
                        file={f}
                        hasClipboard={remoteClipboard.length > 0}
                        onOpen={() => void handleOpenRemote(f.path).catch((e: unknown) => toast.error(String(e)))}
                        onOpenWith={() => setOpenWithTarget({ path: f.path, isLocal: false })}
                        onDownload={() => void handleDownload([f.path])}
                        onUpload={() => {}}
                        onCopy={() => handleCopyRemote(selectedRemote.size > 0 ? [...selectedRemote] : [f.path])}
                        onPaste={handlePasteRemote}
                        onRename={() => setRenameTarget({ path: f.path, name: f.name, isLocal: false })}
                        onDelete={() => {
                          const targets = selectedRemote.has(f.path) ? [...selectedRemote] : [f.path];
                          void invoke("sftp_delete_remote", { sessionId: sftpSessionId, paths: targets })
                            .then(() => remotePath && loadRemoteDir(remotePath))
                            .catch((e: unknown) => toast.error(String(e)));
                        }}
                        onRefresh={() => remotePath && void loadRemoteDir(remotePath)}
                        onEditPermissions={() => setPermTarget(f.path)}
                      >
                      <div
                        draggable={!f.is_dir}
                        onDragStart={(e) => {
                          const toDrag = selectedRemote.has(f.path) ? [...selectedRemote].filter((p) => !remoteFiles.find((rf) => rf.path === p)?.is_dir) : [f.path];
                          e.dataTransfer.setData("application/x-sftp-remote", JSON.stringify(toDrag));
                          e.dataTransfer.effectAllowed = "copy";
                        }}
                        className={`grid min-w-[500px] grid-cols-[1fr_160px_90px_70px] cursor-pointer items-center px-4 py-2 text-sm ${
                          selectedRemote.has(f.path)
                            ? "bg-[oklch(0.45_0.12_145)]/10 ring-1 ring-inset ring-[oklch(0.45_0.12_145)]/20"
                            : "hover:bg-[var(--color-surface)]"
                        }`}
                        onClick={(e) => handleRemoteClick(e, f.path)}
                        onDoubleClick={() => {
                          if (f.is_dir) void loadRemoteDir(f.path);
                        }}
                      >
                        <div className="flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap text-foreground">
                          <Folder
                            className={`h-4 w-4 shrink-0 ${
                              f.is_dir ? "text-[oklch(0.65_0.12_145)]" : "text-muted-foreground"
                            }`}
                          />
                          {f.name}
                          {f.is_symlink && <span className="text-[10px] text-muted-foreground">→</span>}
                        </div>
                        <div className="text-xs text-muted-foreground">{f.modified ?? "—"}</div>
                        <div className="text-xs text-muted-foreground">
                          {f.size != null ? formatBytes(f.size) : "—"}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {f.is_symlink ? "symlink" : f.is_dir ? "folder" : "file"}
                        </div>
                      </div>
                      </SftpContextMenu>
                    ))}
                  </>
                )}
              </div>
            </div>
          </>
        )}

        {/* Remote file watch bar */}
        {watchedFile?.changed && (
          <div className="flex h-10 flex-shrink-0 items-center justify-between border-t border-border bg-[var(--color-surface)] px-4">
            <span className="text-xs text-muted-foreground">
              <span className="mr-1 text-foreground">{watchedFile.remotePath.split("/").pop()}</span>
              was modified locally
            </span>
            <div className="flex gap-2">
              <button
                className="rounded px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => {
                  void invoke("sftp_stop_watch", { tmpPath: watchedFile.tmpPath });
                  setWatchedFile(null);
                }}
              >
                Reject
              </button>
              <button
                className="rounded bg-[oklch(0.45_0.12_145)] px-2.5 py-1 text-xs font-medium text-white hover:bg-[oklch(0.5_0.12_145)]"
                onClick={async () => {
                  try {
                    await invokeTransfer("sftp_upload", {
                      sessionId: sftpSessionId,
                      localPath: watchedFile.tmpPath,
                      remotePath: watchedFile.remotePath,
                    });
                    await invoke("sftp_stop_watch", { tmpPath: watchedFile.tmpPath });
                    setWatchedFile(null);
                    if (remotePath) await loadRemoteDir(remotePath);
                  } catch (e) { toast.error(String(e)); }
                }}
              >
                Upload
              </button>
            </div>
          </div>
        )}
      </div>
      </div>

      {/* Rename dialog */}
      <SftpRenameDialog
        open={renameTarget !== null}
        currentName={renameTarget?.name ?? ""}
        onConfirm={(n) => void handleRenameConfirm(n)}
        onClose={() => setRenameTarget(null)}
      />

      {/* Edit Permissions dialog */}
      <SftpPermissionsDialog
        open={permTarget !== null}
        sessionId={sftpSessionId}
        path={permTarget ?? ""}
        onClose={() => setPermTarget(null)}
      />

      {/* Open With dialog */}
      {openWithTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-80 rounded-xl border border-border bg-[var(--color-surface)] p-5 shadow-xl">
            <p className="mb-3 text-sm font-semibold text-foreground">Open With</p>
            <input
              autoFocus
              placeholder="App name or path…"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-[var(--color-brand-cyan)]"
              value={openWithApp}
              onChange={(e) => setOpenWithApp(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && openWithApp.trim()) {
                  if (openWithTarget.isLocal) handleOpenWithLocal(openWithTarget.path, openWithApp.trim());
                  else void invoke("sftp_open_remote", { sessionId: sftpSessionId, remotePath: openWithTarget.path })
                    .then((tmp) => invoke("sftp_open_with_local", { path: tmp as string, app: openWithApp.trim() }).then(() => tmp))
                    .then((tmp) => invoke("sftp_watch_remote", { sessionId: sftpSessionId, tmpPath: tmp as string, remotePath: openWithTarget.path }))
                    .catch((e: unknown) => toast.error(String(e)));
                  setOpenWithTarget(null);
                  setOpenWithApp("");
                }
                if (e.key === "Escape") { setOpenWithTarget(null); setOpenWithApp(""); }
              }}
            />
            <div className="mt-3 flex justify-end gap-2">
              <button className="rounded px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground" onClick={() => { setOpenWithTarget(null); setOpenWithApp(""); }}>Cancel</button>
              <button
                className="rounded bg-[var(--color-brand-cyan)] px-3 py-1.5 text-xs font-medium text-black"
                onClick={() => {
                  if (openWithApp.trim()) {
                    if (openWithTarget.isLocal) {
                      handleOpenWithLocal(openWithTarget.path, openWithApp.trim());
                    } else {
                      const app = openWithApp.trim();
                      const target = openWithTarget;
                      invoke<string>("sftp_open_remote", { sessionId: sftpSessionId, remotePath: target.path })
                        .then((tmp) => invoke("sftp_open_with_local", { path: tmp, app }).then(() => tmp))
                        .then((tmp) => invoke("sftp_watch_remote", { sessionId: sftpSessionId, tmpPath: tmp as string, remotePath: target.path }))
                        .catch((e: unknown) => toast.error(String(e)));
                    }
                  }
                  setOpenWithTarget(null); setOpenWithApp("");
                }}
              >Open</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- Snippets view ---------------- */

const SNIPPET_KIND_META: Record<SnippetKind, { label: string; color: string; icon: typeof Braces }> = {
  text: { label: "Text Template", color: "oklch(0.55_0.15_160)", icon: FileText },
  command: { label: "Command", color: "oklch(0.45_0.15_230)", icon: TerminalSquare },
  script: { label: "Script", color: "oklch(0.55_0.15_300)", icon: Braces },
};

const initialSnippets: Snippet[] = [];

function SnippetsView() {
  const [snippets, setSnippets] = useState<Snippet[]>(initialSnippets);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editor, setEditor] = useState<{ open: boolean; snippet?: Snippet | null }>({ open: false });
  const [removing, setRemoving] = useState<string[] | null>(null);
  const [viewMode, setViewMode] = useState<"grid" | "list">(
    () => (localStorage.getItem("snippets-view-mode") as "grid" | "list") ?? "grid"
  );
  const [viewOpen, setViewOpen] = useState(false);
  const [sortDir, setSortDir] = useState<"desc" | "asc">(
    () => (localStorage.getItem("snippets-sort-dir") as "desc" | "asc") ?? "desc"
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (searchOpen) searchRef.current?.focus(); }, [searchOpen]);
  useEffect(() => { localStorage.setItem("snippets-view-mode", viewMode); }, [viewMode]);
  useEffect(() => { localStorage.setItem("snippets-sort-dir", sortDir); }, [sortDir]);

  // Load from backend
  useEffect(() => {
    invoke<Snippet[]>("list_snippets").then((data) => {
      setSnippets(data);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const toggleSelect = (id: string, additive: boolean) => {
    setSelected((curr) => {
      if (!additive) {
        return curr.has(id) && curr.size === 1 ? new Set() : new Set([id]);
      }
      const next = new Set(curr);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const upsert = async (s: Snippet) => {
    try {
      const saved = await invoke<Snippet>("save_snippet", {
        request: { id: s.id, kind: s.kind, name: s.name, body: s.body, command: s.command, script: s.script, variables: s.variables || [] },
      });
      setSnippets((curr) => {
        const idx = curr.findIndex((x) => x.id === saved.id);
        if (idx === -1) return [saved, ...curr];
        const next = [...curr];
        next[idx] = saved;
        return next;
      });
    } catch (err) {
      console.error("Failed to save snippet:", err);
    }
  };

  const remove = async (ids: string[]) => {
    try {
      await invoke("remove_snippets", { ids });
      setSnippets((curr) => curr.filter((s) => !ids.includes(s.id)));
      setSelected(new Set());
      setRemoving(null);
    } catch (err) {
      console.error("Failed to remove snippets:", err);
    }
  };

  const selectedIds = Array.from(selected);

  const getSnippetContent = (s: Snippet) => s.body || s.command || s.script || "";

  const visibleSnippets = snippets
    .filter((s) => {
      if (!query.trim()) return true;
      const q = query.toLowerCase();
      return s.name.toLowerCase().includes(q) || getSnippetContent(s).toLowerCase().includes(q);
    })
    .sort((a, b) => {
      const da = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const db = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return sortDir === "desc" ? db - da : da - db;
    });

  if (loading) return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Loading…</div>;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setEditor({ open: true, snippet: null })}
            className="flex h-7 items-center gap-1 rounded-md bg-[var(--color-surface-2)] px-2.5 text-xs font-medium text-foreground hover:bg-white/5"
          >
            <Plus className="h-3.5 w-3.5" /> New snippet
          </button>
          {selectedIds.length > 0 && (
            <button
              onClick={() => setRemoving(selectedIds)}
              className="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-[oklch(0.72_0.18_25)] hover:bg-[var(--color-surface-2)]"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Remove ({selectedIds.length})
            </button>
          )}
        </div>
        <div className="flex items-center gap-1">
          {/* Search */}
          <div className="flex items-center">
            {searchOpen && (
              <div className="mr-1 flex h-7 items-center gap-1.5 rounded-md border border-border bg-[var(--color-surface)] px-2">
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Escape") { setQuery(""); setSearchOpen(false); } }}
                  placeholder="Search snippets…"
                  className="h-full w-44 bg-transparent text-xs text-foreground placeholder:text-muted-foreground focus:outline-none"
                />
                {query && (
                  <button
                    onClick={() => setQuery("")}
                    className="text-muted-foreground hover:text-foreground"
                    title="Clear"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            )}
            <button
              onClick={() => setSearchOpen((v) => !v)}
              className={`flex h-7 w-7 items-center justify-center rounded-md hover:bg-[var(--color-surface-2)] ${searchOpen ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              title="Search"
            >
              <Search className="h-4 w-4" />
            </button>
          </div>

          {/* View mode dropdown */}
          <div className="relative">
            <button
              onClick={() => setViewOpen((v) => !v)}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-foreground"
              title={viewMode === "grid" ? "Grid view" : "List view"}
            >
              {viewMode === "grid" ? <LayoutGrid className="h-4 w-4" /> : <List className="h-4 w-4" />}
            </button>
            {viewOpen && (
              <div
                className="absolute right-0 top-full z-30 mt-1 w-40 overflow-hidden rounded-lg border border-border bg-popover shadow-2xl"
                onMouseLeave={() => setViewOpen(false)}
              >
                <button
                  onClick={() => { setViewMode("grid"); setViewOpen(false); }}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-[var(--color-surface-2)] ${viewMode === "grid" ? "text-foreground" : "text-muted-foreground"}`}
                >
                  <LayoutGrid className="h-4 w-4" />
                  Grid view
                </button>
                <button
                  onClick={() => { setViewMode("list"); setViewOpen(false); }}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-[var(--color-surface-2)] ${viewMode === "list" ? "text-foreground" : "text-muted-foreground"}`}
                >
                  <List className="h-4 w-4" />
                  List view
                </button>
              </div>
            )}
          </div>

          {/* Sort by date */}
          <button
            onClick={() => setSortDir((d) => (d === "desc" ? "asc" : "desc"))}
            className="flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-foreground"
            title={sortDir === "desc" ? "Newest first" : "Oldest first"}
          >
            <ArrowUpDown className="h-3.5 w-3.5" />
            {sortDir === "desc" ? "Newest" : "Oldest"}
          </button>
        </div>
      </div>

      {snippets.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-[var(--color-surface-2)]">
            <Braces className="h-9 w-9 text-muted-foreground" strokeWidth={1.5} />
          </div>
          <h3 className="mt-5 text-base font-semibold text-foreground">Create snippet</h3>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            Save your most used commands as snippets to reuse them in one click.
          </p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-4 py-4">
          <h2 className="mb-3 text-sm font-semibold text-foreground">Snippets</h2>
          {visibleSnippets.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              No snippets match “{query}”.
            </div>
          ) : viewMode === "grid" ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {visibleSnippets.map((s) => {
                const isSel = selected.has(s.id);
                const meta = SNIPPET_KIND_META[s.kind || "command"];
                const KindIcon = meta.icon;
                return (
                  <div
                    key={s.id}
                    onClick={(e) => toggleSelect(s.id, e.metaKey || e.ctrlKey || e.shiftKey)}
                    className={[
                      "group relative flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-left transition",
                      isSel
                        ? "border-[var(--color-brand-orange)]/60 bg-[var(--color-brand-orange)]/10"
                        : "border-border bg-[var(--color-surface)] hover:border-[var(--color-brand-orange)]/40 hover:bg-[var(--color-surface-2)]",
                    ].join(" ")}
                  >
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-white" style={{ backgroundColor: meta.color }}>
                      <KindIcon className="h-5 w-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-foreground">{s.name}</div>
                      <div className="truncate font-mono text-xs text-muted-foreground">{getSnippetContent(s)}</div>
                      {s.variables && s.variables.length > 0 && (
                        <div className="mt-1 flex items-center gap-1">
                          <span className="rounded bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            {s.variables.length} var{s.variables.length > 1 ? "s" : ""}
                          </span>
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        title="Edit"
                        onClick={(e) => { e.stopPropagation(); setEditor({ open: true, snippet: s }); }}
                        className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-foreground"
                      >
                        <Settings className="h-3.5 w-3.5" />
                      </button>
                      <button
                        title="Remove"
                        onClick={(e) => { e.stopPropagation(); setRemoving([s.id]); }}
                        className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-[oklch(0.72_0.18_25)]"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border bg-[var(--color-surface)]">
              {visibleSnippets.map((s, i) => {
                const isSel = selected.has(s.id);
                const meta = SNIPPET_KIND_META[s.kind || "command"];
                const KindIcon = meta.icon;
                return (
                  <div
                    key={s.id}
                    onClick={(e) => toggleSelect(s.id, e.metaKey || e.ctrlKey || e.shiftKey)}
                    className={[
                      "group flex cursor-pointer items-center gap-3 px-3 py-2.5 text-left transition",
                      i > 0 ? "border-t border-border" : "",
                      isSel
                        ? "bg-[var(--color-brand-orange)]/10"
                        : "hover:bg-[var(--color-surface-2)]",
                    ].join(" ")}
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-white" style={{ backgroundColor: meta.color }}>
                      <KindIcon className="h-4 w-4" />
                    </span>
                    <div className="w-48 shrink-0 truncate text-sm font-medium text-foreground">{s.name}</div>
                    <span className="shrink-0 rounded bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{meta.label}</span>
                    <div className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{getSnippetContent(s)}</div>
                    {s.createdAt && (
                      <div className="hidden shrink-0 text-xs text-muted-foreground md:block">
                        {new Date(s.createdAt).toLocaleDateString()}
                      </div>
                    )}
                    <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        title="Edit"
                        onClick={(e) => { e.stopPropagation(); setEditor({ open: true, snippet: s }); }}
                        className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-foreground"
                      >
                        <Settings className="h-3.5 w-3.5" />
                      </button>
                      <button
                        title="Remove"
                        onClick={(e) => { e.stopPropagation(); setRemoving([s.id]); }}
                        className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-[oklch(0.72_0.18_25)]"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {editor.open && (
        <SnippetModal
          snippet={editor.snippet ?? null}
          onClose={() => setEditor({ open: false })}
          onSubmit={(s) => { void upsert(s); setEditor({ open: false }); }}
        />
      )}

      {removing && (
        <RemoveSnippetModal
          count={removing.length}
          onClose={() => setRemoving(null)}
          onConfirm={() => void remove(removing)}
        />
      )}
    </div>
  );
}

function SortableVariableRow({
  id, v, idx, updateVariable, removeVariable,
}: {
  id: string;
  v: SnippetVariable;
  idx: number;
  updateVariable: (idx: number, patch: Partial<SnippetVariable>) => void;
  removeVariable: (idx: number) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform ? { ...transform, x: 0, scaleX: 1, scaleY: 1 } : null),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  };
  return (
    <div ref={setNodeRef} style={style} className="flex items-center gap-2 rounded-md border border-border bg-[var(--color-surface)] p-2">
      <button
        type="button"
        {...attributes}
        {...listeners}
        className="flex h-7 w-5 cursor-grab items-center justify-center text-muted-foreground/50 hover:text-muted-foreground active:cursor-grabbing"
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>
      <input
        value={v.name}
        onChange={(e) => updateVariable(idx, { name: e.target.value })}
        placeholder="name"
        className="h-7 w-24 rounded border border-border bg-transparent px-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none"
      />
      <Select value={v.type} onValueChange={(val) => updateVariable(idx, { type: val as "text" | "enum" })}>
        <SelectTrigger className="h-7 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="text">text</SelectItem>
          <SelectItem value="enum">enum</SelectItem>
        </SelectContent>
      </Select>
      {v.type === "text" && (
        <input
          value={v.defaultValue ?? ""}
          onChange={(e) => updateVariable(idx, { defaultValue: e.target.value })}
          placeholder="default"
          className="h-7 flex-1 rounded border border-border bg-transparent px-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none"
        />
      )}
      {v.type === "enum" && (
        <EnumOptionsInput
          value={v.options ?? []}
          onChange={(opts) => updateVariable(idx, { options: opts })}
        />
      )}
      <button
        type="button"
        onClick={() => removeVariable(idx)}
        className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:text-[oklch(0.72_0.18_25)]"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function EnumOptionsInput({ value, onChange }: { value: string[]; onChange: (opts: string[]) => void }) {
  const [draft, setDraft] = useState(value.join(", "));
  return (
    <input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onChange(draft.split(",").map((o) => o.trim()).filter(Boolean))}
      placeholder="opt1, opt2, opt3"
      className="h-7 flex-1 rounded border border-border bg-transparent px-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none"
    />
  );
}

function CodeEditor({
  value,
  onChange,
  placeholder,
  minRows = 6,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  minRows?: number;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const lines = value.split("\n");
  const lineCount = Math.max(lines.length, minRows);
  const lineH = 1.625;

  const syncScroll = () => {
    if (textareaRef.current && gutterRef.current)
      gutterRef.current.scrollTop = textareaRef.current.scrollTop;
  };

  return (
    <div className="flex overflow-hidden rounded-md border border-border bg-[var(--color-surface)] font-mono text-sm">
      <div
        ref={gutterRef}
        aria-hidden
        className="select-none overflow-hidden border-r border-border bg-[var(--color-surface-2)] px-2 py-2 text-right text-xs text-muted-foreground/50"
        style={{ minWidth: `${String(lineCount).length * 0.55 + 1.5}rem`, lineHeight: `${lineH}rem` }}
      >
        {Array.from({ length: lineCount }, (_, i) => (
          <div key={i} style={{ height: `${lineH}rem` }}>{i + 1}</div>
        ))}
      </div>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        placeholder={placeholder}
        spellCheck={false}
        className="flex-1 resize-none bg-transparent px-3 py-2 text-foreground placeholder:text-muted-foreground/50 focus:outline-none"
        style={{ minHeight: `${lineCount * lineH + 1}rem`, lineHeight: `${lineH}rem` }}
      />
    </div>
  );
}

function SnippetModal({
  snippet, onClose, onSubmit,
}: {
  snippet: Snippet | null;
  onClose: () => void;
  onSubmit: (s: Snippet) => void;
}) {
  const [name, setName] = useState(snippet?.name ?? "");
  const [kind, setKind] = useState<SnippetKind>(snippet?.kind ?? "command");
  const [body, setBody] = useState(snippet?.body ?? "");
  const [command, setCommand] = useState(snippet?.command ?? "");
  const [script, setScript] = useState(snippet?.script ?? "");
  const [variables, setVariables] = useState<SnippetVariable[]>(
    () => (snippet?.variables ?? []).map((v) => ({ ...v, _id: v._id ?? `v-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` }))
  );

  const varSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const valid = name.trim() && (
    (kind === "text" && body.trim()) ||
    (kind === "command" && command.trim()) ||
    (kind === "script" && script.trim())
  );

  const addVariable = () => {
    setVariables([...variables, { _id: `v-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: "", type: "text", defaultValue: "", options: [] }]);
  };

  const updateVariable = (idx: number, patch: Partial<SnippetVariable>) => {
    setVariables((curr) => curr.map((v, i) => i === idx ? { ...v, ...patch } : v));
  };

  const removeVariable = (idx: number) => {
    setVariables((curr) => curr.filter((_, i) => i !== idx));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="flex w-[880px] max-w-[95vw] max-h-[75vh] flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3">
          <h3 className="text-sm font-semibold text-foreground">{snippet ? "Edit snippet" : "New snippet"}</h3>
          <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          <Field label="Name">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Disk Size"
              className="h-9 w-full rounded-md border border-border bg-[var(--color-surface)] px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
            />
          </Field>
          <Field label="Type">
            <div className="flex gap-2">
              {(["text", "command", "script"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  className={[
                    "flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition",
                    kind === k
                      ? "border-[var(--color-brand-orange)]/60 bg-[var(--color-brand-orange)]/10 text-foreground"
                      : "border-border text-muted-foreground hover:text-foreground hover:bg-[var(--color-surface-2)]",
                  ].join(" ")}
                >
                  {SNIPPET_KIND_META[k].label}
                </button>
              ))}
            </div>
          </Field>
          {kind === "text" && (
            <Field label="Body">
              <input
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="e.g. Hello {{name}}…"
                className="h-9 w-full rounded-md border border-border bg-[var(--color-surface)] px-3 font-mono text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
              />
            </Field>
          )}
          {kind === "command" && (
            <Field label="Command">
              <CodeEditor value={command} onChange={setCommand} placeholder="e.g. ssh {{user}}@{{host}}" minRows={6} />
            </Field>
          )}
          {kind === "script" && (
            <Field label="Script">
              <CodeEditor value={script} onChange={setScript} placeholder="#!/bin/bash" minRows={10} />
            </Field>
          )}
          {/* Variables section */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <label className="text-xs font-medium text-muted-foreground">Variables</label>
                <span className="rounded bg-[var(--color-surface-2)] px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/70">{"{{var_name}}"}</span>
              </div>
              <button
                type="button"
                onClick={addVariable}
                className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-foreground"
              >
                <Plus className="h-3 w-3" /> Add
              </button>
            </div>
            {variables.length > 0 && (
              <DndContext
                sensors={varSensors}
                collisionDetection={closestCenter}
                modifiers={[restrictToVerticalAxis, restrictToParentElement]}
                onDragEnd={(e) => {
                  const { active, over } = e;
                  if (!over || active.id === over.id) return;
                  const from = variables.findIndex((v) => v._id === active.id);
                  const to = variables.findIndex((v) => v._id === over.id);
                  if (from !== -1 && to !== -1) setVariables((curr) => arrayMove(curr, from, to));
                }}
              >
                <SortableContext items={variables.map((v) => v._id!)} strategy={verticalListSortingStrategy}>
                  {variables.map((v, idx) => (
                    <SortableVariableRow
                      key={v._id}
                      id={v._id!}
                      v={v}
                      idx={idx}
                      updateVariable={updateVariable}
                      removeVariable={removeVariable}
                    />
                  ))}
                </SortableContext>
              </DndContext>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-3">
          <button onClick={onClose} className="h-8 rounded-md px-3 text-xs font-medium text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-foreground">
            Cancel
          </button>
          <button
            onClick={() => valid && onSubmit({
              id: snippet?.id ?? `s-${Date.now()}`,
              kind,
              name: name.trim(),
              body: kind === "text" ? body.trim() : undefined,
              command: kind === "command" ? command.trim() : undefined,
              script: kind === "script" ? script.trim() : undefined,
              variables: variables.filter((v) => v.name.trim()),
              createdAt: snippet?.createdAt ?? new Date().toISOString(),
            })}
            disabled={!valid}
            className="h-8 rounded-md bg-[var(--color-brand-orange)] px-3 text-xs font-semibold text-[var(--color-primary-foreground)] disabled:cursor-not-allowed disabled:opacity-50 hover:enabled:opacity-90"
          >
            {snippet ? "Save" : "Create snippet"}
          </button>
        </div>
      </div>
    </div>
  );
}

function RemoveSnippetModal({
  count, onClose, onConfirm,
}: {
  count: number;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[480px] max-w-[92vw] overflow-hidden rounded-lg border border-border bg-[var(--color-surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border bg-[var(--color-sidebar)] px-5 py-3">
          <h3 className="text-sm font-semibold text-foreground">Remove snippet</h3>
          <button
            onClick={onClose}
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-muted-foreground transition hover:bg-[var(--color-surface-2)] hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="px-5 py-6">
          <p className="text-sm text-foreground">
            Are you sure you want to remove {count} snippet{count > 1 ? "s" : ""}?
          </p>
          <div className="mt-6 flex items-center justify-end">
            <button
              onClick={onConfirm}
              className="cursor-pointer rounded-md bg-[oklch(0.68_0.17_25)] px-5 py-1.5 text-sm font-semibold text-white transition hover:opacity-90"
            >
              Remove
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function RemoveHostModal({
  hostName, onClose, onConfirm,
}: {
  hostName: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[480px] max-w-[92vw] overflow-hidden rounded-lg border border-border bg-[var(--color-surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border bg-[var(--color-sidebar)] px-5 py-3">
          <h3 className="text-sm font-semibold text-foreground">Remove host</h3>
          <button
            onClick={onClose}
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-muted-foreground transition hover:bg-[var(--color-surface-2)] hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="px-5 py-6">
          <p className="text-sm text-foreground">
            Are you sure you want to remove <span className="font-semibold">{hostName}</span>?
          </p>
          <div className="mt-6 flex items-center justify-end">
            <button
              onClick={onConfirm}
              className="cursor-pointer rounded-md bg-[oklch(0.68_0.17_25)] px-5 py-1.5 text-sm font-semibold text-white transition hover:opacity-90"
            >
              Remove
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
