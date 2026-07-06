import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import {
  ArrowUpDown,
  ChevronRight,
  Eye,
  EyeOff,
  Folder,
  FolderPlus,
  Info,
  LayoutGrid,
  List,
  Lock,
  PanelRightOpen,
  Plus,
  Search,
  Server,
  Settings,
  Tag,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Field,
  HostModalInput,
  HostModalRow,
  HostModalSectionTitle,
  HostModalToggle,
  ModalActions,
  ModalShell,
  SplitButton,
  ToolbarButton,
} from "@/components/shared/modal-primitives";
import { OsBadge } from "@/components/app/icons";
import type { Host, HostGroup, OsKind, SshKey } from "@/components/app/types";
import { listSshKeys } from "@/lib/api/ssh-keys";
import {
  listHosts,
  removeHostGroup,
  removeHosts,
  saveHost,
  saveHostGroup,
  testHostConnection,
} from "@/lib/api/hosts";

export function HostsView({
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

    listHosts()
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
      const group = await saveHostGroup(name, parentId, id);
      setGroups((curr) => [group, ...curr.filter((item) => item.id !== group.id)]);
      setHostsError(null);
      setGroupModal({ open: false, parentId: null, group: null });
    } catch (err) {
      setHostsError(String(err));
    }
  };
  const upsertHost = async (h: Omit<Host, "id">, id?: string) => {
    try {
      const host = await saveHost(h, id);
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
      await removeHosts([id]);
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
      await removeHostGroup(id);
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
  const [os, setOs] = useState<OsKind>(host?.os ?? "ubuntu");
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
    listSshKeys()
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
      const result = await testHostConnection({
        hostname: hostname.trim(),
        user: user.trim(),
        port,
        password,
        sshKeyId,
        timeoutSecs: 5,
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
              <Select value={os} onValueChange={(val) => setOs(val as OsKind)}>
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
