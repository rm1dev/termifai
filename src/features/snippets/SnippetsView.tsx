import { useEffect, useRef, useState } from "react";
import {
  ArrowUpDown,
  Braces,
  FileText,
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
import { Field } from "@/components/shared/modal-primitives";
import type { Snippet, SnippetKind, SnippetVariable } from "@/components/app/types";
import { listSnippets, removeSnippets, saveSnippet } from "@/lib/api/snippets";

const SNIPPET_KIND_META: Record<SnippetKind, { label: string; color: string; icon: typeof Braces }> = {
  text: { label: "Text Template", color: "oklch(0.55_0.15_160)", icon: FileText },
  command: { label: "Command", color: "oklch(0.45_0.15_230)", icon: TerminalSquare },
  script: { label: "Script", color: "oklch(0.55_0.15_300)", icon: Braces },
};

const initialSnippets: Snippet[] = [];

export function SnippetsView() {
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
    listSnippets().then((data) => {
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
      const saved = await saveSnippet(s);
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
      await removeSnippets(ids);
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
