import { useEffect, useRef, useState } from "react";
import { Network, Play, Plus, Search, Settings, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, HostModalInput, HostModalRow, HostModalToggle } from "@/components/shared/modal-primitives";
import type { Host, PortForwardRule, TunnelDirection, TunnelStatus } from "@/components/app/types";
import {
  getTunnelStatuses,
  listHostsForForwarding,
  listPortForwards,
  removePortForwards,
  savePortForward,
  startTunnel,
  stopTunnel,
} from "@/lib/api/port-forwarding";

export function PortForwardingView() {
  const [rules, setRules] = useState<PortForwardRule[]>([]);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [statuses, setStatuses] = useState<Record<string, TunnelStatus>>({});
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<PortForwardRule | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (searchOpen) searchRef.current?.focus(); }, [searchOpen]);

  const loadData = async () => {
    try {
      const [ruleList, hostVault] = await Promise.all([
        listPortForwards(),
        listHostsForForwarding(),
      ]);
      setRules(ruleList);
      setHosts(hostVault.hosts);

      if (ruleList.length > 0) {
        const s = await getTunnelStatuses(ruleList.map((r) => r.id));
        const map: Record<string, TunnelStatus> = {};
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
        const s = await getTunnelStatuses(rules.map((r) => r.id));
        const map: Record<string, TunnelStatus> = {};
        s.forEach((st) => { map[st.ruleId] = st; });
        setStatuses(map);
      } catch { /* ignore */ }
    }, 3000);
    return () => clearInterval(interval);
  }, [rules]);

  const handleSave = async (data: Omit<PortForwardRule, "id" | "createdAt">, id?: string) => {
    try {
      const saved = await savePortForward(data, id);
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
      await removePortForwards([id]);
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
        const s = await stopTunnel(ruleId);
        setStatuses((curr) => ({ ...curr, [ruleId]: s }));
        toast.success("Tunnel stopped");
      } else {
        const s = await startTunnel(ruleId);
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
  rule?: PortForwardRule | null;
  hosts: Host[];
  onClose: () => void;
  onSubmit: (data: Omit<PortForwardRule, "id" | "createdAt">) => void;
}) {
  const [name, setName] = useState(rule?.name ?? "");
  const [hostId, setHostId] = useState(rule?.hostId ?? (hosts[0]?.id ?? ""));
  const [direction, setDirection] = useState<TunnelDirection>(rule?.direction ?? "local");
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
              <Select value={direction} onValueChange={(val) => setDirection(val as TunnelDirection)}>
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
