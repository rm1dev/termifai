import { useState, useRef, useEffect, forwardRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Server,
  Network,
  Braces,
  ShieldCheck,
  KeyRound,
  Clipboard,
  FileUp,
  Eye,
  EyeOff,
  ClipboardList,
  Plus,
  ChevronDown,
  TerminalSquare,
  Bell,
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
} from "lucide-react";
import { sampleHosts } from "./data";
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
import type { AppTab, Host, HostGroup, SidebarKey, Snippet, SshKey, TabKind } from "./types";
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
import { toast } from "sonner";


const sidebarItems: { key: SidebarKey; label: string; icon: typeof Server }[] = [
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "hosts", label: "Hosts", icon: Server },
  { key: "port-forwarding", label: "Port Forwarding", icon: Network },
  { key: "snippets", label: "Snippets", icon: Braces },
  { key: "ssh-keys", label: "SSH Keys", icon: KeyRound },
  { key: "logs", label: "Logs", icon: ClipboardList },
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

  const closeTab = (id: string) => {
    setTabs((curr) => {
      const tgt = curr.find((t) => t.id === id);
      if (tgt && !tgt.closable) return curr;
      const next = curr.filter((t) => t.id !== id);
      if (id === activeTab && next.length) setActiveTab(next[next.length - 1].id);
      return next;
    });
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
                  {activeSidebar === "hosts" && <HostsView onNewTerminal={() => newTab("terminal")} onNewSftp={() => newTab("sftp")} />}
                  {activeSidebar === "port-forwarding" && <PortForwardingView />}
                  {activeSidebar === "snippets" && <SnippetsView />}
                  {activeSidebar === "ssh-keys" && <SshKeysView />}
                  {activeSidebar === "logs" && (
                    <EmptyState icon={ClipboardList} title="Connection logs" subtitle="Audit of recent sessions, transfers and tunnels." />
                  )}
                </main>
              </>
            )}
            {t.kind === "sftp" && <SftpView />}
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
}: {
  tabs: AppTab[];
  activeTab: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: (kind: TabKind) => void;
  onRename: (id: string, title: string) => void;
  onReorder: (fromId: string, toId: string) => void;
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
    <div className="flex h-11 shrink-0 items-center border-b border-border bg-[var(--color-surface)] pr-3 select-none" data-tauri-drag-region>
      {/* Space for native macOS traffic lights */}
      <div className="w-[80px] h-full shrink-0 flex items-center" />

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

      <button className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-foreground self-center" aria-label="Notifications">
        <Bell className="h-4 w-4" />
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
    tab.kind === "terminal" ? (
      <TerminalSquare className="h-3.5 w-3.5 text-[var(--color-brand-green)]" />
    ) : tab.kind === "sftp" ? (
      <Folder className="h-3.5 w-3.5 text-muted-foreground" />
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

function HostsView({ onNewTerminal, onNewSftp }: { onNewTerminal?: () => void; onNewSftp?: () => void }) {
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");
  const [viewOpen, setViewOpen] = useState(false);

  const [hosts, setHosts] = useState<Host[]>(sampleHosts);
  const [groups, setGroups] = useState<HostGroup[]>([]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const [hostModal, setHostModal] = useState<{ open: boolean; groupId: string | null }>({ open: false, groupId: null });
  const [groupModal, setGroupModal] = useState<{ open: boolean; parentId: string | null }>({ open: false, parentId: null });

  const toggleCollapse = (id: string) =>
    setCollapsed((c) => ({ ...c, [id]: !c[id] }));

  const addGroup = (name: string, parentId: string | null) => {
    const id = `g-${Date.now()}`;
    setGroups((g) => [...g, { id, name, parentId }]);
  };
  const addHost = (h: Omit<Host, "id">) => {
    const id = `h-${Date.now()}`;
    setHosts((hs) => [{ ...h, id, lastUsed: new Date().toISOString() }, ...hs]);
  };

  const filteredHosts = hosts
    .filter((h) =>
      `${h.name} ${h.user}@${h.hostname}`.toLowerCase().includes(query.toLowerCase()),
    )
    .sort((a, b) => {
      const da = a.lastUsed ? new Date(a.lastUsed).getTime() : 0;
      const db = b.lastUsed ? new Date(b.lastUsed).getTime() : 0;
      return sortDir === "desc" ? db - da : da - db;
    });

  const rootHosts = filteredHosts.filter((h) => !h.groupId);
  const rootGroups = groups.filter((g) => !g.parentId);

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
          disabled={!query}
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
          <ToolbarButton icon={<Folder className="h-4 w-4" />} label="SFTP" onClick={onNewSftp} />
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

          <IconButton icon={<Tag className="h-4 w-4" />} title="Tags" />
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
        <h2 className="mb-3 text-sm font-semibold text-foreground">Hosts</h2>

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
            onAddSubgroup={(parentId) => setGroupModal({ open: true, parentId })}
            onAddHost={(groupId) => setHostModal({ open: true, groupId })}
          />
        ))}

        {/* Root-level hosts */}
        <HostsList hosts={rootHosts} viewMode={viewMode} query={query} />
      </div>

      {hostModal.open && (
        <HostModal
          groups={groups}
          defaultGroupId={hostModal.groupId}
          onClose={() => setHostModal({ open: false, groupId: null })}
          onSubmit={(h) => {
            addHost(h);
            setHostModal({ open: false, groupId: null });
          }}
        />
      )}
      {groupModal.open && (
        <GroupModal
          groups={groups}
          defaultParentId={groupModal.parentId}
          onClose={() => setGroupModal({ open: false, parentId: null })}
          onSubmit={(name, parentId) => {
            addGroup(name, parentId);
            setGroupModal({ open: false, parentId: null });
          }}
        />
      )}
    </div>
  );
}

/* ---- Group rendering (recursive) ---- */
function GroupNode({
  group, depth, groups, hosts, viewMode, collapsed, onToggle, onAddSubgroup, onAddHost,
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
            />
          ))}
          {groupHosts.length > 0 && (
            <HostsList hosts={groupHosts} viewMode={viewMode} query="" />
          )}
        </div>
      )}
    </div>
  );
}

function HostsList({ hosts, viewMode, query }: { hosts: Host[]; viewMode: "grid" | "list"; query: string }) {
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
          <button
            key={h.id}
            className="group flex items-center gap-3 rounded-lg border border-border bg-[var(--color-surface)] p-3 text-left transition hover:border-[var(--color-brand-orange)]/40 hover:bg-[var(--color-surface-2)]"
          >
            <OsBadge os={h.os} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-foreground">{h.name}</div>
              <div className="truncate text-xs text-muted-foreground">ssh, {h.user}</div>
            </div>
            <PanelRightOpen className="h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
        ))}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {hosts.map((h) => (
        <button
          key={h.id}
          className="group flex items-center gap-3 rounded-lg border border-border bg-[var(--color-surface)] p-3 text-left transition hover:border-[var(--color-brand-orange)]/40 hover:bg-[var(--color-surface-2)]"
        >
          <OsBadge os={h.os} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-foreground">{h.name}</div>
            <div className="truncate text-xs text-muted-foreground">{h.user}@{h.hostname}</div>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="rounded border border-border px-1.5 py-0.5">{h.os}</span>
            <PanelRightOpen className="h-4 w-4 opacity-0 transition-opacity group-hover:opacity-100" />
          </div>
        </button>
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

/* ---- Modal: New Group ---- */
function GroupModal({
  groups, defaultParentId, onClose, onSubmit,
}: {
  groups: HostGroup[];
  defaultParentId: string | null;
  onClose: () => void;
  onSubmit: (name: string, parentId: string | null) => void;
}) {
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState<string | null>(defaultParentId);

  return (
    <ModalShell title="New group" onClose={onClose}>
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
        <select
          value={parentId ?? ""}
          onChange={(e) => setParentId(e.target.value || null)}
          className="h-9 w-full rounded-md border border-border bg-[var(--color-surface)] px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
        >
          <option value="">— (root)</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>{groupPath(groups, g.id)}</option>
          ))}
        </select>
      </Field>
      <ModalActions
        onClose={onClose}
        onConfirm={() => {
          const n = name.trim();
          if (n) onSubmit(n, parentId);
        }}
        confirmDisabled={!name.trim()}
        confirmLabel="Create group"
      />
    </ModalShell>
  );
}

/* ---- Modal: New Host ---- */
function HostModal({
  groups, defaultGroupId, onClose, onSubmit,
}: {
  groups: HostGroup[];
  defaultGroupId: string | null;
  onClose: () => void;
  onSubmit: (h: Omit<Host, "id">) => void;
}) {
  const [name, setName] = useState("");
  const [hostname, setHostname] = useState("");
  const [port, setPort] = useState(22);
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [sshKeyId, setSshKeyId] = useState<string | null>(null);
  const [groupId, setGroupId] = useState<string | null>(defaultGroupId);
  const [tags, setTags] = useState<string[]>([]);
  const [showStatus, setShowStatus] = useState(true);
  const [sftpPath, setSftpPath] = useState("/");

  const valid = name.trim() && hostname.trim() && user.trim();

  const SectionTitle = ({ icon, title }: { icon: React.ReactNode; title: string }) => (
    <div className="flex items-center gap-2 px-4 py-3">
      <span className="flex h-5 w-5 items-center justify-center text-muted-foreground">
        {icon}
      </span>
      <span className="text-sm font-semibold text-foreground">{title}</span>
    </div>
  );

  const Row = ({ label, children, rightText }: { label: string; children: React.ReactNode; rightText?: string }) => (
    <div className="flex items-center justify-between border-t border-border px-4 py-2.5">
      <span className="text-sm text-foreground">{label}</span>
      <div className="flex items-center gap-2">
        {children}
        {rightText && <span className="text-sm text-muted-foreground">{rightText}</span>}
      </div>
    </div>
  );

  const Input = (props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input
      {...props}
      dir="ltr"
      className={[
        "h-8 w-40 rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 text-left text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-[var(--color-brand-orange)]/40",
        props.className,
      ].filter(Boolean).join(" ")}
    />
  );

  const SelectButton = ({ label, icon, onClick }: { label: string; icon: React.ReactNode; onClick?: () => void }) => (
    <button
      onClick={onClick}
      className="flex h-7 items-center gap-1.5 rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 text-xs font-medium text-foreground hover:bg-[var(--color-surface)]"
    >
      <span>{label}</span>
      {icon}
    </button>
  );

  const Toggle = ({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) => (
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="flex max-h-[70vh] w-[520px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-border bg-[var(--color-surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border bg-[var(--color-sidebar)] px-5 py-3">
          <h3 className="text-sm font-semibold text-foreground">Create New Machine</h3>
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
          <SectionTitle icon={<Info className="h-4 w-4" />} title="Machine Information" />
          <div className="border-t border-border">
            <Row label="Name">
              <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
            </Row>
            <Row label="Host">
              <Input value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="IP or Hostname" />
            </Row>
            <Row label="Port" rightText="22">
              <input
                type="number"
                value={port}
                onChange={(e) => setPort(Number(e.target.value) || 22)}
                dir="ltr"
                className="h-8 w-16 rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 text-left text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-[var(--color-brand-orange)]/40"
              />
            </Row>
          </div>
          <div className="px-4 pb-2 pt-1.5">
            <p className="text-right text-[11px] text-muted-foreground">If Name is empty, Host will be used as Name.</p>
          </div>

          {/* Authentication */}
          <SectionTitle icon={<Lock className="h-4 w-4" />} title="Authentication" />
          <div className="border-t border-border">
            <Row label="Username">
              <Input value={user} onChange={(e) => setUser(e.target.value)} placeholder="Username" />
            </Row>
            <Row label="Password">
              <div className="relative">
                <Input
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
            </Row>
            <Row label="SSH Key">
              <SelectButton
                label={sshKeyId ? "Selected" : "Select Key"}
                icon={<KeyRound className="h-3.5 w-3.5" />}
              />
            </Row>
          </div>
          <div className="mx-4 my-2 rounded-md border border-border bg-[var(--color-surface-2)] px-3 py-2">
            <button className="rounded-md bg-[var(--color-surface)] px-3 py-1 text-xs font-medium text-muted-foreground hover:text-foreground">
              Test Connection
            </button>
          </div>
          <div className="px-4 pb-2 pt-1">
            <p className="text-right text-[11px] text-muted-foreground">It is recommended to test connection before saving.</p>
          </div>

          {/* Categorization */}
          <SectionTitle icon={<Tag className="h-4 w-4" />} title="Categorization" />
          <div className="border-t border-border">
            <Row label="Group">
              <SelectButton
                label={groupId ? groupPath(groups, groupId) : "Select Group"}
                icon={<LayoutGrid className="h-3.5 w-3.5" />}
              />
            </Row>
            <Row label="Tags">
              <SelectButton
                label={tags.length > 0 ? `${tags.length} tags` : "Edit Tags"}
                icon={<Tag className="h-3.5 w-3.5" />}
              />
            </Row>
          </div>

          {/* Preferences */}
          <SectionTitle icon={<Settings className="h-4 w-4" />} title="Preferences" />
          <div className="border-t border-border">
            <Row label="Show Status in Dashboard">
              <Toggle checked={showStatus} onChange={setShowStatus} />
            </Row>
            <Row label="Default SFTP Path">
              <Input value={sftpPath} onChange={(e) => setSftpPath(e.target.value)} placeholder="/" />
            </Row>
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
            onClick={() =>
              valid &&
              onSubmit({
                name: name.trim(),
                hostname: hostname.trim(),
                port,
                user: user.trim(),
                os: "ubuntu",
                groupId,
                tags,
                password,
                sshKeyId,
                showStatusInDashboard: showStatus,
                defaultSftpPath: sftpPath,
              })
            }
            disabled={!valid}
            className="rounded-md bg-[var(--color-brand-orange)] px-4 py-1.5 text-sm font-semibold text-[var(--color-primary-foreground)] disabled:cursor-not-allowed disabled:opacity-50 hover:enabled:opacity-90"
          >
            Create host
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
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <SplitButton primary={<><Plus className="h-3.5 w-3.5" /> New forwarding</>} />
        <div className="flex items-center gap-1">
          <IconButton icon={<Search className="h-4 w-4" />} title="Search" />
          <IconButton icon={<LayoutGrid className="h-4 w-4" />} title="Grid" active />
          <IconButton icon={<CalendarClock className="h-4 w-4" />} title="Recent" />
        </div>
      </div>
      <EmptyState
        icon={Network}
        title="Set up port forwarding"
        subtitle="Save port forwarding to access databases, web apps, and other services."
      />
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
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [viewOpen, setViewOpen] = useState(false);
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [sshKeyError, setSshKeyError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (searchOpen) searchRef.current?.focus(); }, [searchOpen]);
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

function SftpView() {
  const files = [
    { n: "Applications", d: "5/9/2026, 1:58 PM", k: "folder" },
    { n: "CascadeProjects", d: "5/28/2025, 7:38 PM", k: "folder" },
    { n: "Desktop", d: "6/3/2026, 9:14 AM", k: "folder" },
    { n: "Documents", d: "6/13/2026, 1:51 PM", k: "folder" },
    { n: "Downloads", d: "6/17/2026, 8:59 AM", k: "folder" },
    { n: "Library", d: "5/14/2026, 8:21 PM", k: "folder" },
    { n: "Movies", d: "2/26/2026, 10:05 PM", k: "folder" },
    { n: "Music", d: "2/4/2026, 7:40 PM", k: "folder" },
    { n: "Pictures", d: "5/13/2026, 8:32 AM", k: "folder" },
    { n: "Public", d: "11/17/2024, 7:55 AM", k: "folder" },
    { n: "Dockerfile", d: "7/23/2025, 10:13 AM", k: "file", size: "1.05 kB" },
  ];

  return (
    <div className="flex h-full min-h-0 flex-1">
      {/* Local pane */}
      <div className="flex min-w-0 flex-1 flex-col border-r border-border">
        <div className="flex h-11 items-center justify-between border-b border-border bg-[var(--color-surface)] px-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <span className="flex h-5 w-5 items-center justify-center rounded bg-[oklch(0.55_0.18_230)]">
              <Folder className="h-3 w-3 text-white" />
            </span>
            Local
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <button className="flex items-center gap-1 hover:text-foreground"><Search className="h-3.5 w-3.5" /> Filter</button>
            <button className="flex items-center gap-1 hover:text-foreground">Actions <ChevronDown className="h-3.5 w-3.5" /></button>
          </div>
        </div>
        <div className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
          <span className="text-foreground/80">Users</span> <span className="opacity-50">›</span> <span className="text-foreground">admin</span>
        </div>
        <div className="grid grid-cols-[1fr_180px_100px_80px] border-b border-border px-4 py-2 text-[11px] uppercase tracking-wider text-muted-foreground">
          <span>Name</span><span>Date Modified</span><span>Size</span><span>Kind</span>
        </div>
        <div className="flex-1 overflow-y-auto">
          {files.map((f) => (
            <div key={f.n} className="grid grid-cols-[1fr_180px_100px_80px] items-center px-4 py-2 text-sm hover:bg-[var(--color-surface)]">
              <div className="flex items-center gap-2 text-foreground">
                <Folder className={`h-4 w-4 ${f.k === "folder" ? "text-[oklch(0.7_0.13_230)]" : "text-muted-foreground"}`} />
                {f.n}
              </div>
              <div className="text-xs text-muted-foreground">{f.d}</div>
              <div className="text-xs text-muted-foreground">{f.size ?? "—"}</div>
              <div className="text-xs text-muted-foreground">{f.k}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Remote pane (placeholder) */}
      <div className="flex w-[42%] min-w-[320px] flex-col">
        <div className="flex h-11 items-center justify-between border-b border-border bg-[var(--color-surface)] px-4 text-sm">
          <span className="text-muted-foreground">Remote</span>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-[var(--color-surface-2)]">
            <Folder className="h-6 w-6 text-muted-foreground" />
          </div>
          <h3 className="mt-5 text-base font-semibold">Connect to host</h3>
          <p className="mt-1 max-w-xs text-sm text-muted-foreground">
            Start by connecting to a saved host to manage your files with SFTP.
          </p>
          <button className="mt-5 rounded-md bg-[var(--color-surface-2)] px-4 py-2 text-xs font-semibold text-foreground hover:bg-white/5">
            Select host
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Snippets view ---------------- */

const initialSnippets: Snippet[] = [
  { id: "s-disk", name: "Disk Size", command: "df -h /", createdAt: "2025-06-01T10:00:00Z" },
  { id: "s-ls", name: "list directory", command: "ls -l", createdAt: "2025-06-10T14:00:00Z" },
];

function SnippetsView() {
  const [snippets, setSnippets] = useState<Snippet[]>(initialSnippets);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editor, setEditor] = useState<{ open: boolean; snippet?: Snippet | null }>({ open: false });
  const [removing, setRemoving] = useState<string[] | null>(null);
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [viewOpen, setViewOpen] = useState(false);
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (searchOpen) searchRef.current?.focus(); }, [searchOpen]);

  const toggleSelect = (id: string, additive: boolean) => {
    setSelected((curr) => {
      const next = new Set(additive ? curr : []);
      if (curr.has(id) && additive) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const upsert = (s: Snippet) => {
    setSnippets((curr) => {
      const idx = curr.findIndex((x) => x.id === s.id);
      if (idx === -1) return [...curr, s];
      const next = [...curr];
      next[idx] = s;
      return next;
    });
  };

  const remove = (ids: string[]) => {
    setSnippets((curr) => curr.filter((s) => !ids.includes(s.id)));
    setSelected(new Set());
    setRemoving(null);
  };

  const selectedIds = Array.from(selected);

  const visibleSnippets = snippets
    .filter((s) => {
      if (!query.trim()) return true;
      const q = query.toLowerCase();
      return s.name.toLowerCase().includes(q) || s.command.toLowerCase().includes(q);
    })
    .sort((a, b) => {
      const da = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const db = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return sortDir === "desc" ? db - da : da - db;
    });

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <SplitButton
            primary={<><Plus className="h-3.5 w-3.5" /> New snippet</>}
            onPrimary={() => setEditor({ open: true, snippet: null })}
            menu={[
              { label: "New snippet", icon: <Plus className="h-3.5 w-3.5" />, onClick: () => setEditor({ open: true, snippet: null }) },
              { label: "Import from file", icon: <FileUp className="h-3.5 w-3.5" />, onClick: () => {} },
            ]}
          />
          <ToolbarButton icon={<Clock className="h-4 w-4" />} label="Shell History" />
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
                return (
                  <div
                    key={s.id}
                    onClick={(e) => toggleSelect(s.id, e.metaKey || e.ctrlKey || e.shiftKey)}
                    onDoubleClick={() => setEditor({ open: true, snippet: s })}
                    className={[
                      "group relative flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-left transition",
                      isSel
                        ? "border-[var(--color-brand-orange)]/60 bg-[var(--color-brand-orange)]/10"
                        : "border-border bg-[var(--color-surface)] hover:border-[var(--color-brand-orange)]/40 hover:bg-[var(--color-surface-2)]",
                    ].join(" ")}
                  >
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-[oklch(0.45_0.15_230)] text-white">
                      <Braces className="h-5 w-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-foreground">{s.name}</div>
                      <div className="truncate font-mono text-xs text-muted-foreground">{s.command}</div>
                    </div>
                    <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        title="Run"
                        onClick={(e) => { e.stopPropagation(); }}
                        className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-foreground"
                      >
                        <Play className="h-3.5 w-3.5" />
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
                return (
                  <div
                    key={s.id}
                    onClick={(e) => toggleSelect(s.id, e.metaKey || e.ctrlKey || e.shiftKey)}
                    onDoubleClick={() => setEditor({ open: true, snippet: s })}
                    className={[
                      "group flex cursor-pointer items-center gap-3 px-3 py-2.5 text-left transition",
                      i > 0 ? "border-t border-border" : "",
                      isSel
                        ? "bg-[var(--color-brand-orange)]/10"
                        : "hover:bg-[var(--color-surface-2)]",
                    ].join(" ")}
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[oklch(0.45_0.15_230)] text-white">
                      <Braces className="h-4 w-4" />
                    </span>
                    <div className="w-48 shrink-0 truncate text-sm font-medium text-foreground">{s.name}</div>
                    <div className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{s.command}</div>
                    {s.createdAt && (
                      <div className="hidden shrink-0 text-xs text-muted-foreground md:block">
                        {new Date(s.createdAt).toLocaleDateString()}
                      </div>
                    )}
                    <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        title="Run"
                        onClick={(e) => { e.stopPropagation(); }}
                        className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-[var(--color-surface-3,var(--color-surface-2))] hover:text-foreground"
                      >
                        <Play className="h-3.5 w-3.5" />
                      </button>
                      <button
                        title="Remove"
                        onClick={(e) => { e.stopPropagation(); setRemoving([s.id]); }}
                        className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-[var(--color-surface-3,var(--color-surface-2))] hover:text-[oklch(0.72_0.18_25)]"
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
          onSubmit={(s) => { upsert(s); setEditor({ open: false }); }}
        />
      )}

      {removing && (
        <RemoveSnippetModal
          count={removing.length}
          onClose={() => setRemoving(null)}
          onConfirm={() => remove(removing)}
        />
      )}
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
  const [command, setCommand] = useState(snippet?.command ?? "");
  const valid = name.trim() && command.trim();

  return (
    <ModalShell title={snippet ? "Edit snippet" : "New snippet"} onClose={onClose}>
      <Field label="Name">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Disk Size"
          className="h-9 w-full rounded-md border border-border bg-[var(--color-surface)] px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
        />
      </Field>
      <Field label="Command">
        <textarea
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="df -h /"
          rows={4}
          className="w-full resize-none rounded-md border border-border bg-[var(--color-surface)] px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
        />
      </Field>
      <ModalActions
        onClose={onClose}
        onConfirm={() => valid && onSubmit({
          id: snippet?.id ?? `s-${Date.now()}`,
          name: name.trim(),
          command: command.trim(),
          createdAt: snippet?.createdAt ?? new Date().toISOString(),
        })}
        confirmDisabled={!valid}
        confirmLabel={snippet ? "Save" : "Create snippet"}
      />
    </ModalShell>
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
