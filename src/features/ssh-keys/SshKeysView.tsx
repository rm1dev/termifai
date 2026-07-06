import { useEffect, useRef, useState } from "react";
import {
  ArrowUpDown,
  Clipboard,
  Eye,
  EyeOff,
  KeyRound,
  LayoutGrid,
  List,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type { SshKey } from "@/components/app/types";
import { generateSshKey, listSshKeys, removeSshKeys } from "@/lib/api/ssh-keys";

export function SshKeysView() {
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

    listSshKeys()
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
      await removeSshKeys(ids);
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
      const key = await generateSshKey({
        name: name.trim(),
        type: keyType,
        size: keyType === "rsa" ? keySize : null,
        passphrase,
        remark: name.trim(),
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
