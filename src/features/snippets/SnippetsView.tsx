import { useEffect, useRef, useState } from "react";
import {
  Braces,
  ChevronRight,
  FileText,
  Folder,
  FolderPlus,
  GripVertical,
  LayoutGrid,
  List,
  Plus,
  Search,
  Settings,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, ModalActions, ModalShell } from "@/components/shared/modal-primitives";
import type { Snippet, SnippetGroup, SnippetKind, SnippetOsTarget, SnippetVariable } from "@/components/app/types";
import {
  listSnippets,
  removeSnippetGroup,
  removeSnippets,
  reorderSnippets,
  saveSnippet,
  saveSnippetGroup,
} from "@/lib/api/snippets";
import { notifySnippetsChanged } from "@/lib/snippets-events";
import { SNIPPET_OS_TARGET_OPTIONS } from "./osTargets";

const SNIPPET_KIND_META: Record<SnippetKind, { label: string; color: string; icon: typeof Braces }> = {
  text: { label: "Text Template", color: "oklch(0.55_0.15_160)", icon: FileText },
  command: { label: "Command", color: "oklch(0.45_0.15_230)", icon: TerminalSquare },
  script: { label: "Script", color: "oklch(0.55_0.15_300)", icon: Braces },
};

const initialSnippets: Snippet[] = [];

export function SnippetsView() {
  const [snippets, setSnippets] = useState<Snippet[]>(initialSnippets);
  const [groups, setGroups] = useState<SnippetGroup[]>([]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editor, setEditor] = useState<{ open: boolean; snippet?: Snippet | null; groupId?: string | null }>({ open: false });
  const [groupModal, setGroupModal] = useState<{ open: boolean; parentId: string | null; group?: SnippetGroup | null }>({ open: false, parentId: null, group: null });
  const [removing, setRemoving] = useState<string[] | null>(null);
  const [viewMode, setViewMode] = useState<"grid" | "list">(
    () => (localStorage.getItem("snippets-view-mode") as "grid" | "list") ?? "list"
  );
  const [viewOpen, setViewOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (searchOpen) searchRef.current?.focus(); }, [searchOpen]);
  useEffect(() => { localStorage.setItem("snippets-view-mode", viewMode); }, [viewMode]);

  // Load from backend
  useEffect(() => {
    listSnippets().then((data) => {
      setSnippets(data.snippets);
      setGroups(data.groups);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const toggleCollapse = (id: string) => setCollapsed((c) => ({ ...c, [id]: !c[id] }));

  const upsertGroup = async (name: string, parentId: string | null, id?: string) => {
    try {
      const group = await saveSnippetGroup(name, parentId, id);
      setGroups((curr) => [group, ...curr.filter((item) => item.id !== group.id)]);
      setGroupModal({ open: false, parentId: null, group: null });
      notifySnippetsChanged();
    } catch (err) {
      console.error("Failed to save snippet group:", err);
    }
  };

  const removeGroup = async (id: string) => {
    try {
      await removeSnippetGroup(id);
      const descendants = descendantGroupIds(groups, id);
      setGroups((curr) => curr.filter((group) => group.id !== id && !descendants.includes(group.id)));
      setSnippets((curr) =>
        curr.map((s) => (s.groupId === id || (s.groupId && descendants.includes(s.groupId)) ? { ...s, groupId: null } : s))
      );
      notifySnippetsChanged();
    } catch (err) {
      console.error("Failed to remove snippet group:", err);
    }
  };

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
      const saved = await saveSnippet(s);
      setSnippets((curr) => {
        const idx = curr.findIndex((x) => x.id === saved.id);
        if (idx === -1) return [saved, ...curr];
        const next = [...curr];
        next[idx] = saved;
        return next;
      });
      notifySnippetsChanged();
    } catch (err) {
      console.error("Failed to save snippet:", err);
    }
  };

  const remove = async (ids: string[]) => {
    try {
      await removeSnippets(ids);
      setSnippets((curr) => curr.filter((s) => !ids.includes(s.id)));
      setSelected(new Set());
      setRemoving(null);
      notifySnippetsChanged();
    } catch (err) {
      console.error("Failed to remove snippets:", err);
    }
  };

  // Applies a new relative order for a subset of ids (e.g. one group's rows)
  // back into the full snippet order, keeping every other snippet's slot.
  const reorder = async (subsetNewOrder: string[]) => {
    const subsetSet = new Set(subsetNewOrder);
    let subsetIdx = 0;
    const fullOrder = snippets.map((s) => (subsetSet.has(s.id) ? subsetNewOrder[subsetIdx++] : s.id));
    const byId = new Map(snippets.map((s) => [s.id, s]));
    setSnippets(fullOrder.map((id) => byId.get(id)!));
    try {
      await reorderSnippets(fullOrder);
      notifySnippetsChanged();
    } catch (err) {
      console.error("Failed to reorder snippets:", err);
    }
  };

  const selectedIds = Array.from(selected);

  const getSnippetContent = (s: Snippet) => s.body || s.command || s.script || "";

  const visibleSnippets = snippets.filter((s) => {
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return s.name.toLowerCase().includes(q) || getSnippetContent(s).toLowerCase().includes(q);
  });

  const rootSnippets = visibleSnippets.filter((s) => !s.groupId);
  const rootGroups = groups.filter((g) => !g.parentId);
  const isSearching = query.trim().length > 0;

  if (loading) return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Loading…</div>;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setEditor({ open: true, snippet: null, groupId: null })}
            className="flex h-7 items-center gap-1 rounded-md bg-[var(--color-surface-2)] px-2.5 text-xs font-medium text-foreground hover:bg-white/5"
          >
            <Plus className="h-3.5 w-3.5" /> New snippet
          </button>
          <button
            onClick={() => setGroupModal({ open: true, parentId: null, group: null })}
            className="flex h-7 items-center gap-1 rounded-md px-2.5 text-xs font-medium text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-foreground"
          >
            <FolderPlus className="h-3.5 w-3.5" /> New group
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
        </div>
      </div>

      {snippets.length === 0 && groups.length === 0 ? (
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
          ) : isSearching ? (
            <SnippetsList
              snippets={visibleSnippets}
              viewMode={viewMode}
              selected={selected}
              toggleSelect={toggleSelect}
              getSnippetContent={getSnippetContent}
              onEdit={(s) => setEditor({ open: true, snippet: s })}
              onRemove={(id) => setRemoving([id])}
            />
          ) : (
            <>
              {rootGroups.map((g) => (
                <SnippetGroupNode
                  key={g.id}
                  group={g}
                  depth={0}
                  groups={groups}
                  snippets={visibleSnippets}
                  viewMode={viewMode}
                  selected={selected}
                  collapsed={collapsed}
                  onToggle={toggleCollapse}
                  toggleSelect={toggleSelect}
                  getSnippetContent={getSnippetContent}
                  onAddSubgroup={(parentId) => setGroupModal({ open: true, parentId, group: null })}
                  onAddSnippet={(groupId) => setEditor({ open: true, snippet: null, groupId })}
                  onEditGroup={(group) => setGroupModal({ open: true, parentId: group.parentId, group })}
                  onDeleteGroup={(id) => void removeGroup(id)}
                  onEdit={(s) => setEditor({ open: true, snippet: s })}
                  onRemove={(id) => setRemoving([id])}
                  onReorder={(ids) => void reorder(ids)}
                />
              ))}
              <SnippetsList
                snippets={rootSnippets}
                viewMode={viewMode}
                selected={selected}
                toggleSelect={toggleSelect}
                getSnippetContent={getSnippetContent}
                onEdit={(s) => setEditor({ open: true, snippet: s })}
                onRemove={(id) => setRemoving([id])}
                onReorder={(ids) => void reorder(ids)}
              />
            </>
          )}
        </div>
      )}

      {(editor.open) && (
        <SnippetModal
          snippet={editor.snippet ?? null}
          groups={groups}
          defaultGroupId={editor.snippet?.groupId ?? editor.groupId ?? null}
          onClose={() => setEditor({ open: false })}
          onSubmit={(s) => { void upsert(s); setEditor({ open: false }); }}
        />
      )}

      {groupModal.open && (
        <SnippetGroupModal
          groups={groups}
          defaultParentId={groupModal.parentId}
          group={groupModal.group}
          onClose={() => setGroupModal({ open: false, parentId: null, group: null })}
          onSubmit={(name, parentId) => void upsertGroup(name, parentId, groupModal.group?.id)}
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

/* ---- Group tree helpers ---- */
function groupPath(groups: SnippetGroup[], id: string | null): string {
  if (!id) return "— (root)";
  const parts: string[] = [];
  let cur: SnippetGroup | undefined = groups.find((g) => g.id === id);
  while (cur) {
    parts.unshift(cur.name);
    cur = cur.parentId ? groups.find((g) => g.id === cur!.parentId) : undefined;
  }
  return parts.join(" › ");
}

function descendantGroupIds(groups: SnippetGroup[], id: string): string[] {
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

/* ---- Group rendering (recursive) ---- */
function SnippetGroupNode({
  group, depth, groups, snippets, viewMode, selected, collapsed, onToggle, toggleSelect, getSnippetContent,
  onAddSubgroup, onAddSnippet, onEditGroup, onDeleteGroup, onEdit, onRemove, onReorder,
}: {
  group: SnippetGroup;
  depth: number;
  groups: SnippetGroup[];
  snippets: Snippet[];
  viewMode: "grid" | "list";
  selected: Set<string>;
  collapsed: Record<string, boolean>;
  onToggle: (id: string) => void;
  toggleSelect: (id: string, additive: boolean) => void;
  getSnippetContent: (s: Snippet) => string;
  onAddSubgroup: (parentId: string) => void;
  onAddSnippet: (groupId: string) => void;
  onEditGroup: (group: SnippetGroup) => void;
  onDeleteGroup: (id: string) => void;
  onEdit: (s: Snippet) => void;
  onRemove: (id: string) => void;
  onReorder: (ids: string[]) => void;
}) {
  const isOpen = !collapsed[group.id];
  const children = groups.filter((g) => g.parentId === group.id);
  const groupSnippets = snippets.filter((s) => s.groupId === group.id);

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
          ({children.length + groupSnippets.length})
        </span>
        <div className="ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
          <button
            title="New snippet in this group"
            onClick={() => onAddSnippet(group.id)}
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
            <SnippetGroupNode
              key={c.id}
              group={c}
              depth={depth + 1}
              groups={groups}
              snippets={snippets}
              viewMode={viewMode}
              selected={selected}
              collapsed={collapsed}
              onToggle={onToggle}
              toggleSelect={toggleSelect}
              getSnippetContent={getSnippetContent}
              onAddSubgroup={onAddSubgroup}
              onAddSnippet={onAddSnippet}
              onEditGroup={onEditGroup}
              onDeleteGroup={onDeleteGroup}
              onEdit={onEdit}
              onRemove={onRemove}
              onReorder={onReorder}
            />
          ))}
          {groupSnippets.length > 0 && (
            <SnippetsList
              snippets={groupSnippets}
              viewMode={viewMode}
              selected={selected}
              toggleSelect={toggleSelect}
              getSnippetContent={getSnippetContent}
              onEdit={onEdit}
              onRemove={onRemove}
              onReorder={onReorder}
            />
          )}
        </div>
      )}
    </div>
  );
}

function SnippetGroupModal({
  groups, defaultParentId, group, onClose, onSubmit,
}: {
  groups: SnippetGroup[];
  defaultParentId: string | null;
  group?: SnippetGroup | null;
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
          placeholder="e.g. Deployment"
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

/* ---- Snippet list (grid/list, reused for root + group nodes) ---- */
function SnippetsList({
  snippets, viewMode, selected, toggleSelect, getSnippetContent, onEdit, onRemove, onReorder,
}: {
  snippets: Snippet[];
  viewMode: "grid" | "list";
  selected: Set<string>;
  toggleSelect: (id: string, additive: boolean) => void;
  getSnippetContent: (s: Snippet) => string;
  onEdit: (s: Snippet) => void;
  onRemove: (id: string) => void;
  /** Enables vertical drag-to-reorder in list view. Omitted (e.g. during search) disables it. */
  onReorder?: (ids: string[]) => void;
}) {
  const dragSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  if (snippets.length === 0) return null;

  if (viewMode === "grid") {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {snippets.map((s) => {
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
                {((s.variables && s.variables.length > 0) || s.keyword) && (
                  <div className="mt-1 flex items-center gap-1">
                    {s.variables && s.variables.length > 0 && (
                      <span className="rounded bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {s.variables.length} var{s.variables.length > 1 ? "s" : ""}
                      </span>
                    )}
                    {s.keyword && (
                      <span className="rounded bg-[var(--color-surface-2)] px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                        :{s.keyword}
                      </span>
                    )}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  title="Edit"
                  onClick={(e) => { e.stopPropagation(); onEdit(s); }}
                  className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-foreground"
                >
                  <Settings className="h-3.5 w-3.5" />
                </button>
                <button
                  title="Remove"
                  onClick={(e) => { e.stopPropagation(); onRemove(s.id); }}
                  className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-[oklch(0.72_0.18_25)]"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  if (!onReorder) {
    return (
      <div className="overflow-hidden rounded-lg border border-border bg-[var(--color-surface)]">
        {snippets.map((s, i) => (
          <SnippetListRow
            key={s.id}
            s={s}
            bordered={i > 0}
            isSel={selected.has(s.id)}
            toggleSelect={toggleSelect}
            getSnippetContent={getSnippetContent}
            onEdit={onEdit}
            onRemove={onRemove}
          />
        ))}
      </div>
    );
  }

  return (
    <DndContext
      sensors={dragSensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      onDragEnd={(e: DragEndEvent) => {
        const { active, over } = e;
        if (!over || active.id === over.id) return;
        const ids = snippets.map((s) => s.id);
        const from = ids.indexOf(active.id as string);
        const to = ids.indexOf(over.id as string);
        if (from !== -1 && to !== -1) onReorder(arrayMove(ids, from, to));
      }}
    >
      <SortableContext items={snippets.map((s) => s.id)} strategy={verticalListSortingStrategy}>
        <div className="overflow-hidden rounded-lg border border-border bg-[var(--color-surface)]">
          {snippets.map((s, i) => (
            <SortableSnippetRow
              key={s.id}
              s={s}
              bordered={i > 0}
              isSel={selected.has(s.id)}
              toggleSelect={toggleSelect}
              getSnippetContent={getSnippetContent}
              onEdit={onEdit}
              onRemove={onRemove}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function SnippetListRow({
  s, bordered, isSel, toggleSelect, getSnippetContent, onEdit, onRemove, dragHandle,
}: {
  s: Snippet;
  bordered: boolean;
  isSel: boolean;
  toggleSelect: (id: string, additive: boolean) => void;
  getSnippetContent: (s: Snippet) => string;
  onEdit: (s: Snippet) => void;
  onRemove: (id: string) => void;
  dragHandle?: React.ReactNode;
}) {
  const meta = SNIPPET_KIND_META[s.kind || "command"];
  const KindIcon = meta.icon;
  return (
    <div
      onClick={(e) => toggleSelect(s.id, e.metaKey || e.ctrlKey || e.shiftKey)}
      className={[
        "group flex cursor-pointer items-center gap-3 px-3 py-2.5 text-left transition",
        bordered ? "border-t border-border" : "",
        isSel ? "bg-[var(--color-brand-orange)]/10" : "hover:bg-[var(--color-surface-2)]",
      ].join(" ")}
    >
      {dragHandle}
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
          onClick={(e) => { e.stopPropagation(); onEdit(s); }}
          className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-foreground"
        >
          <Settings className="h-3.5 w-3.5" />
        </button>
        <button
          title="Remove"
          onClick={(e) => { e.stopPropagation(); onRemove(s.id); }}
          className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-[oklch(0.72_0.18_25)]"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function SortableSnippetRow({
  s, bordered, isSel, toggleSelect, getSnippetContent, onEdit, onRemove,
}: {
  s: Snippet;
  bordered: boolean;
  isSel: boolean;
  toggleSelect: (id: string, additive: boolean) => void;
  getSnippetContent: (s: Snippet) => string;
  onEdit: (s: Snippet) => void;
  onRemove: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: s.id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform ? { ...transform, x: 0, scaleX: 1, scaleY: 1 } : null),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
    position: "relative",
    background: isDragging ? "var(--color-surface-2)" : undefined,
  };
  return (
    <div ref={setNodeRef} style={style}>
      <SnippetListRow
        s={s}
        bordered={bordered}
        isSel={isSel}
        toggleSelect={toggleSelect}
        getSnippetContent={getSnippetContent}
        onEdit={onEdit}
        onRemove={onRemove}
        dragHandle={
          <button
            type="button"
            {...attributes}
            {...listeners}
            onClick={(e) => e.stopPropagation()}
            className="flex h-6 w-5 shrink-0 cursor-grab items-center justify-center text-muted-foreground/50 opacity-0 transition-opacity hover:text-muted-foreground group-hover:opacity-100 active:cursor-grabbing"
          >
            <GripVertical className="h-3.5 w-3.5" />
          </button>
        }
      />
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
  snippet, groups, defaultGroupId, onClose, onSubmit,
}: {
  snippet: Snippet | null;
  groups: SnippetGroup[];
  defaultGroupId?: string | null;
  onClose: () => void;
  onSubmit: (s: Snippet) => void;
}) {
  const [name, setName] = useState(snippet?.name ?? "");
  const [kind, setKind] = useState<SnippetKind>(snippet?.kind ?? "command");
  const [body, setBody] = useState(snippet?.body ?? "");
  const [command, setCommand] = useState(snippet?.command ?? "");
  const [script, setScript] = useState(snippet?.script ?? "");
  const [groupId, setGroupId] = useState<string | null>(snippet?.groupId ?? defaultGroupId ?? null);
  const [keyword, setKeyword] = useState(snippet?.keyword ?? "");
  const [osTargets, setOsTargets] = useState<SnippetOsTarget[]>(
    snippet?.osTargets && snippet.osTargets.length > 0 ? snippet.osTargets : ["all"]
  );
  const [variables, setVariables] = useState<SnippetVariable[]>(
    () => (snippet?.variables ?? []).map((v) => ({ ...v, _id: v._id ?? `v-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` }))
  );

  const toggleOsTarget = (value: SnippetOsTarget) => {
    setOsTargets((curr) => {
      if (value === "all") return ["all"];
      const next = curr.includes(value) ? curr.filter((v) => v !== value) : [...curr.filter((v) => v !== "all"), value];
      return next.length === 0 ? ["all"] : next;
    });
  };

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
          <hr className="border-border" />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Group">
              <Select value={groupId ?? "__none__"} onValueChange={(val) => setGroupId(val === "__none__" ? null : val)}>
                <SelectTrigger className="h-9 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Ungrouped</SelectItem>
                  {groups.map((g) => (
                    <SelectItem key={g.id} value={g.id}>{groupPath(groups, g.id)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Applies to">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="flex h-9 w-full items-center justify-between rounded-md border border-border bg-[var(--color-surface)] px-3 text-left text-sm text-foreground hover:bg-[var(--color-surface-2)]"
                  >
                    <span className="truncate">
                      {osTargets.includes("all")
                        ? "All OS"
                        : SNIPPET_OS_TARGET_OPTIONS.filter((o) => osTargets.includes(o.value)).map((o) => o.label).join(", ")}
                    </span>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-64">
                  {SNIPPET_OS_TARGET_OPTIONS.map((opt) => (
                    <DropdownMenuCheckboxItem
                      key={opt.value}
                      checked={osTargets.includes(opt.value)}
                      onSelect={(e) => e.preventDefault()}
                      onCheckedChange={() => toggleOsTarget(opt.value)}
                    >
                      {opt.label}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </Field>
          </div>
          <hr className="border-border" />
          {kind === "text" && (
            <Field label="Keyword">
              <input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="e.g. deploy"
                className="h-9 w-full rounded-md border border-border bg-[var(--color-surface)] px-3 font-mono text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Type a snippet keyword and have it automatically replaced with your snippet.
              </p>
            </Field>
          )}
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
              groupId,
              keyword: kind === "text" ? keyword.trim() || undefined : undefined,
              osTargets: osTargets.includes("all") ? [] : osTargets,
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
