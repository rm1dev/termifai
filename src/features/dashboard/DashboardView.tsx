import { useEffect, useRef, useState, useTransition } from "react";
import { call } from "@/lib/api/transport";
import {
  Activity,
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpFromLine,
  ChevronRight,
  Clock,
  Container,
  Cpu,
  Download,
  Folder,
  HardDrive,
  List,
  Network,
  Search,
  Server,
  Upload,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  PolarAngleAxis,
  RadialBar,
  RadialBarChart,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Host, HostGroup } from "@/components/app/types";
import { useDashboard, useHostDetail, fmtBytes, fmtUptime, type HostStatusEntry, type HostPhase, type CoreMetrics } from "@/lib/dashboard";

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

function ringGaugeColor(pct: number): { from: string; to: string } {
  // cyan(210°) → yellow(85°) → orange(42°) → red #ff5f57
  const bands = [
    { at: 45,  from: "oklch(0.78 0.14 210)", to: "oklch(0.58 0.14 210)" },
    { at: 70,  from: "oklch(0.92 0.16 85)",  to: "oklch(0.72 0.16 85)"  },
    { at: 85,  from: "oklch(0.64 0.18 42)",  to: "oklch(0.48 0.18 42)"  },
    { at: 100, from: "#ff5f57",               to: "#c0120a"               },
  ];
  const band = bands.find((b) => pct <= b.at) ?? bands[bands.length - 1];
  return { from: band.from, to: band.to };
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
  from?: string;
  to?: string;
  size?: number;
  stroke?: number;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, value));
  const offset = c - (pct / 100) * c;
  const colors = ringGaugeColor(pct);
  const colorFrom = from ?? colors.from;
  const colorTo = to ?? colors.to;
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-[9px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </span>
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
          <defs>
            <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor={colorFrom} />
              <stop offset="100%" stopColor={colorTo} />
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





function statusDotClass(phase: HostPhase): string {
  switch (phase) {
    case "online":
      return "bg-[oklch(0.65_0.18_145)]";
    case "offline":
      return "bg-[oklch(0.65_0.2_25)]";
    case "reconnecting":
      return "bg-[var(--color-brand-orange)] animate-pulse";
    default:
      return "bg-muted-foreground/40 animate-pulse"; // connecting
  }
}

function latencyColor(ms: number): string {
  if (ms < 100) return "text-[oklch(0.65_0.18_145)]";
  if (ms < 300) return "text-[var(--color-brand-yellow)]";
  return "text-[var(--color-brand-orange)]";
}

function statusLabel(phase: HostPhase, hostStatus?: HostStatusEntry): string {
  switch (phase) {
    case "online":
      return hostStatus?.latencyMs != null ? `${Math.round(hostStatus.latencyMs)} ms` : "Online";
    case "offline":
      return "Offline";
    case "reconnecting":
      return "Reconnecting…";
    default:
      return "Connecting…";
  }
}

export function DashboardView() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [groups, setGroups] = useState<HostGroup[]>([]);
  const [hostsLoaded, setHostsLoaded] = useState(false);

  // Load hosts that have showStatusInDashboard enabled
  useEffect(() => {
    call<{ hosts: Host[]; groups: HostGroup[] }>("list_hosts")
      .then((v) => {
        setHosts(v.hosts.filter((h) => h.showStatusInDashboard !== false));
        setGroups(v.groups || []);
        setHostsLoaded(true);
      })
      .catch(console.error);
  }, []);

  const hostIds = hosts.map((h) => h.id);
  // Pass null until the host list has actually loaded — an empty array during that
  // window would otherwise look like "all hosts were removed" to the store.
  const { stats, status } = useDashboard(hostsLoaded ? hostIds : null);

  if (selectedId) {
    const selectedHost = hosts.find((h) => h.id === selectedId);
    if (selectedHost) {
      return (
        <HostDashboardView
          host={selectedHost}
          hostStatus={status[selectedId]}
          onBack={() => setSelectedId(null)}
        />
      );
    }
  }

  const renderHostCard = (host: Host) => {
    const poll = stats[host.id];
    const hostStatus = status[host.id];
    const phase: HostPhase = hostStatus?.phase ?? "connecting";
    const sys = poll?.system ?? null;

    return (
      <button
        key={host.id}
        type="button"
        onClick={() => setSelectedId(host.id)}
        title={phase === "offline" ? (hostStatus?.error ?? undefined) : undefined}
        className="rounded-xl border border-border bg-[var(--color-surface)] p-4 text-left transition hover:border-primary/60 hover:bg-[var(--color-surface)]/80 focus:outline-none focus:ring-2 focus:ring-primary/40"
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-foreground">{host.name}</span>
          <div className="flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${statusDotClass(phase)}`} />
            <span
              className={`text-xs font-mono tabular-nums ${
                phase === "online" && hostStatus?.latencyMs != null
                  ? latencyColor(hostStatus.latencyMs)
                  : "text-muted-foreground"
              }`}
            >
              {statusLabel(phase, hostStatus)}
            </span>
          </div>
        </div>

        {/* Specs from real system data — zeroed placeholders before the first poll */}
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1"><Cpu className="h-3 w-3" /> {sys?.cores ?? 0} Cores</span>
          <span className="flex items-center gap-1"><Activity className="h-3 w-3" /> {fmtBytes((sys?.memTotalKb ?? 0) * 1024)}</span>
          <span className="flex items-center gap-1"><HardDrive className="h-3 w-3" /> {fmtBytes((sys?.diskTotalKb ?? 0) * 1024)}</span>
          <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> {sys ? fmtUptime(sys.uptimeSecs) : "0m"}</span>
        </div>

        {/* Gauges — always rendered at full structure, zeroed until the first poll lands */}
        <div className="mt-4 flex items-start gap-4">
          <RingGauge value={sys?.cpuPct ?? 0} label="CPU" gradientId={`g-dash-cpu-${host.id}`} size={52} />
          <RingGauge
            value={sys && sys.memTotalKb > 0 ? (sys.memUsedKb / sys.memTotalKb) * 100 : 0}
            label="RAM"
            gradientId={`g-dash-ram-${host.id}`}
            size={52}
          />
          <RingGauge
            value={sys && sys.diskTotalKb > 0 ? (sys.diskUsedKb / sys.diskTotalKb) * 100 : 0}
            label="Disk"
            gradientId={`g-dash-disk-${host.id}`}
            size={52}
          />
          <IoStat
            label="Network"
            rows={[
              { icon: ArrowDownToLine, value: fmtBytes(sys?.netRxRate ?? 0), unit: "/s" },
              { icon: ArrowUpFromLine, value: fmtBytes(sys?.netTxRate ?? 0), unit: "/s" },
            ]}
          />
        </div>
      </button>
    );
  };

  const hasHostsInGroup = (gId: string): boolean => {
    if (hosts.some(h => h.groupId === gId)) return true;
    const subs = groups.filter(g => g.parentId === gId);
    return subs.some(sub => hasHostsInGroup(sub.id));
  };

  const renderGroupDashboard = (groupId: string | null, depth: number): React.ReactNode => {
    const subGroups = groups.filter(g => g.parentId === groupId);
    const groupHosts = hosts.filter(h => groupId ? h.groupId === groupId : !h.groupId);

    const hasSubgroupContent = subGroups.some(sg => hasHostsInGroup(sg.id));
    const hasDirectHosts = groupHosts.length > 0;

    if (!hasSubgroupContent && !hasDirectHosts) return null;

    return (
      <div key={groupId || "root"} className={groupId ? "mb-6" : ""}>
        {groupId && (
          <div 
            className="flex items-center gap-1.5 mb-2.5 mt-4 text-[10px] font-bold tracking-wider text-muted-foreground/80 uppercase"
            style={{ marginLeft: `${Math.max(0, depth - 1) * 8}px` }}
          >
            <Folder className="h-3.5 w-3.5 text-[oklch(0.7_0.13_230)] shrink-0" />
            <span>{groups.find(g => g.id === groupId)?.name}</span>
          </div>
        )}

        {hasDirectHosts && (
          <div 
            className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(340px,1fr))]"
            style={{ marginLeft: `${depth * 8}px` }}
          >
            {groupHosts.map(host => renderHostCard(host))}
          </div>
        )}

        {subGroups.map(sg => renderGroupDashboard(sg.id, depth + 1))}
      </div>
    );
  };

  const total = hosts.length;
  const online = hosts.filter((h) => status[h.id]?.phase === "online").length;
  const offline = hosts.filter((h) => status[h.id]?.phase === "offline").length;

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

      {hosts.length === 0 && (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          No hosts configured for dashboard display.
          <br />
          Enable "Show in Dashboard" in host settings.
        </div>
      )}

      {/* Server cards */}
      {renderGroupDashboard(null, 0)}
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

function buildCpuData(samples: number[], cores: number, coreMetrics?: CoreMetrics[]) {
  // Use real per-core breakdown when available (second poll onwards)
  const threads: CpuThread[] = (coreMetrics && coreMetrics.length > 0)
    ? coreMetrics.map((c) => ({
        user:   Math.max(0, c.user),
        system: Math.max(0, c.system),
        nice:   Math.max(0, c.nice),
        iowait: Math.max(0, c.iowait),
        steal:  Math.max(0, c.steal),
      }))
    : Array.from({ length: cores }, (_, i) => {
        // Fallback: first poll has no per-core data yet — show aggregate evenly
        const total = Math.max(0, Math.min(100, samples[0] ?? 0));
        const system = total > 0 ? Math.min(total, Math.round(total * 0.05)) : 0;
        const iowait = 0;
        const user = Math.max(0, total - system);
        return { user, system, nice: 0, iowait, steal: 0 };
      });
  const sum = (k: CpuCategory) => threads.reduce((a, t) => a + t[k], 0) / Math.max(threads.length, 1);
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
  const [cols, setCols] = useState(0);

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

function CpuThreadRow({ thread, cols }: { thread: CpuThread; cols: number }) {
  const total = thread.user + thread.system + thread.nice + thread.iowait + thread.steal;
  const filled = Math.round((total / 100) * cols);
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
      <div className="flex flex-1 gap-[1px] overflow-hidden">
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

function CpuUsageChart({ samples, cores, model, coreMetrics }: { samples: number[]; cores: number; model: string; coreMetrics?: CoreMetrics[] }) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const data = buildCpuData(samples, cores, coreMetrics);
  const { ref, cols } = useColumnCount(6, 1);

  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-[var(--color-surface)] p-4">
      <button
        type="button"
        onClick={() => startTransition(() => setOpen((v) => !v))}
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
        <div className="mt-3 border-t border-border pt-3">
          {isPending ? (
            <div className="space-y-1.5">
              {Array.from({ length: cores }).map((_, i) => (
                <div key={i} className="flex items-center gap-2">
                  <div className="h-[10px] flex-1 rounded-[1px] animate-shimmer" />
                  <span className="w-9" />
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-1">
              {data.threads.map((t, i) => (
                <CpuThreadRow key={i} thread={t} cols={Math.max(10, cols - Math.round(44 / 7))} />
              ))}
            </div>
          )}
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

function HostDashboardView({
  host,
  hostStatus,
  onBack,
}: {
  host: Host;
  hostStatus?: HostStatusEntry;
  onBack: () => void;
}) {
  // detail comes straight from the shared dashboardStore — already seeded from the
  // overview poll, so it's non-null the moment any poll for this host has landed,
  // even before this view mounts.
  const { detail: poll } = useHostDetail(host.id);
  const sys = poll?.system ?? null;
  const pollProcesses = poll?.processes ?? null;
  const pollContainers = poll?.containers ?? null; // null = docker not installed
  const phase: HostPhase = hostStatus?.phase ?? "connecting";

  const [procSearch, setProcSearch] = useState("");

  // Accumulate load average history for the chart (max 32 points)
  const loadHistoryRef = useRef<{ t: number; m1: number; m5: number; m15: number }[]>([]);
  const [loadHistory, setLoadHistory] = useState<{ t: number; m1: number; m5: number; m15: number }[]>([]);
  useEffect(() => {
    if (!sys) return;
    const entry = { t: loadHistoryRef.current.length, m1: sys.load1m, m5: sys.load5m, m15: sys.load15m };
    const next = [...loadHistoryRef.current.slice(-31), entry];
    loadHistoryRef.current = next;
    setLoadHistory(next);
  }, [sys?.load1m, sys?.load5m, sys?.load15m]);

  // Memory calculations (in GB)
  const memTotalGb = sys ? sys.memTotalKb / 1_048_576 : 0;
  const memUsedGb = sys ? sys.memUsedKb / 1_048_576 : 0;
  const memCachedGb = sys ? sys.memCachedKb / 1_048_576 : 0;
  const memFree = Math.max(memTotalGb - memUsedGb - memCachedGb, 0);
  const memUsedPct = memTotalGb > 0 ? (memUsedGb / memTotalGb) * 100 : 0;
  const swapUsedGb = sys ? sys.swapUsedKb / 1_048_576 : 0;
  const swapTotalGb = sys ? sys.swapTotalKb / 1_048_576 : 0;
  const swapPct = swapTotalGb > 0 ? (swapUsedGb / swapTotalGb) * 100 : 0;
  const diskPct = sys && sys.diskTotalKb > 0 ? (sys.diskUsedKb / sys.diskTotalKb) * 100 : 0;
  const diskTotalGb = sys ? sys.diskTotalKb / 1_048_576 : 0;
  const diskUsedGb = sys ? sys.diskUsedKb / 1_048_576 : 0;

  const memData = [
    { name: "Used", value: memUsedGb || 0.001, fill: "oklch(0.7 0.28 320)" },
    { name: "Cached", value: memCachedGb || 0.001, fill: "oklch(0.55 0.18 320)" },
    { name: "Free", value: memFree || 0.001, fill: "var(--color-border)" },
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
                      {phase === "online" && (
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--color-brand-green)] opacity-60" />
                      )}
                      <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${statusDotClass(phase)}`} />
                    </span>
                    {statusLabel(phase, hostStatus)}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                  <span className="font-mono tabular-nums text-foreground/80">{sys?.ip ?? "—"}</span>
                  <span className="h-1 w-1 rounded-full bg-border" />
                  <span>
                    <span className="text-muted-foreground/70">Uptime</span>{" "}
                    <span className="font-mono tabular-nums text-foreground/80">{sys ? fmtUptime(sys.uptimeSecs) : "—"}</span>
                  </span>
                  <span className="h-1 w-1 rounded-full bg-border" />
                  <span>
                    <span className="text-muted-foreground/70">Cores</span>{" "}
                    <span className="font-mono tabular-nums text-foreground/80">{sys?.cores ?? "—"}</span>
                  </span>
                  <span className="h-1 w-1 rounded-full bg-border" />
                  <span>
                    <span className="text-muted-foreground/70">RAM</span>{" "}
                    <span className="font-mono tabular-nums text-foreground/80">{sys ? `${memTotalGb.toFixed(1)} GB` : "—"}</span>
                  </span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-4">
              <div className="flex items-center gap-5 rounded-xl border border-border bg-background/60 px-4 py-2.5">
                <MiniGauge value={sys?.cpuPct ?? 0} label="CPU" color="var(--color-brand-cyan)" />
                <span className="h-9 w-px bg-border" />
                <MiniGauge value={memUsedPct} label="RAM" color="oklch(0.7 0.28 320)" />
                <span className="h-9 w-px bg-border" />
                <MiniGauge value={diskPct} label="Disk" color="var(--color-brand-yellow)" />
              </div>
            </div>
          </div>
        </header>

        {/* ─── CPU USAGE ──────────────────────────────────────────── */}
        <CpuUsageChart
          samples={sys ? [sys.cpuPct] : [0]}
          cores={sys?.cores ?? 1}
          model={sys ? `Load: ${sys.load1m.toFixed(2)} / ${sys.load5m.toFixed(2)} / ${sys.load15m.toFixed(2)}` : "—"}
          coreMetrics={sys?.cpuCores}
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
                    <span className="font-mono font-bold tabular-nums text-foreground">{sys?.load1m?.toFixed(2) ?? "—"}</span>
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-[var(--color-brand-cyan)]" />
                    <span className="text-muted-foreground">5m</span>
                    <span className="font-mono font-bold tabular-nums text-foreground">{sys?.load5m?.toFixed(2) ?? "—"}</span>
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-[var(--color-brand-yellow)]" />
                    <span className="text-muted-foreground">15m</span>
                    <span className="font-mono font-bold tabular-nums text-foreground">{sys?.load15m?.toFixed(2) ?? "—"}</span>
                  </span>
                </div>
              }
            />
            <div className="flex-1 min-h-0 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={loadHistory} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
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
                  <div className="relative">
                    <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                    <input
                      type="text"
                      value={procSearch}
                      onChange={(e) => setProcSearch(e.target.value)}
                      placeholder="filter…"
                      className="h-6 w-28 rounded-md border border-border bg-transparent pl-6 pr-2 text-[10px] text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-border"
                    />
                  </div>
                }
              />
            </div>
            <ScrollArea className="h-[230px]">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-[var(--color-surface)] backdrop-blur">
                  <TableRow className="border-border hover:bg-transparent">
                    <TableHead className="h-6 px-3 text-[9px] font-bold uppercase tracking-wider text-muted-foreground">Process</TableHead>
                    <TableHead className="h-6 w-16 text-[9px] font-bold uppercase tracking-wider text-muted-foreground">User</TableHead>
                    <TableHead className="h-6 w-12 text-right text-[9px] font-bold uppercase tracking-wider text-muted-foreground">CPU%</TableHead>
                    <TableHead className="h-6 w-20 px-3 text-right text-[9px] font-bold uppercase tracking-wider text-muted-foreground">Mem</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pollProcesses === null && (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center text-xs text-muted-foreground py-4">Loading processes…</TableCell>
                    </TableRow>
                  )}
                  {(() => {
                    if (pollProcesses === null) return null;
                    const q = procSearch.trim().toLowerCase();
                    const filtered = q
                      ? pollProcesses.filter(
                          (p) =>
                            p.name.toLowerCase().includes(q) ||
                            p.user.toLowerCase().includes(q) ||
                            String(p.pid).includes(q),
                        )
                      : pollProcesses;
                    if (filtered.length === 0) {
                      return (
                        <TableRow>
                          <TableCell colSpan={4} className="text-center text-xs text-muted-foreground py-4">
                            {q ? "No matching processes" : "No processes found"}
                          </TableCell>
                        </TableRow>
                      );
                    }
                    return filtered.map((p) => {
                      const isHot = p.cpuPct >= 100;
                      const isWarm = p.cpuPct >= 4 && p.cpuPct < 100;
                      return (
                        <TableRow key={p.pid} className="border-border/60 text-[10.5px]">
                          <TableCell className="px-3 py-1">
                            <div className="font-medium leading-tight text-foreground">{p.name}</div>
                            <div className="font-mono text-[9px] leading-tight text-muted-foreground/60">{p.pid}</div>
                          </TableCell>
                          <TableCell className="w-16 max-w-[4rem] truncate py-1 font-mono text-muted-foreground">{p.user}</TableCell>
                          <TableCell
                            className="w-12 py-1 text-right font-mono font-bold tabular-nums"
                            style={{
                              color: isHot
                                ? "var(--color-brand-red)"
                                : isWarm
                                  ? "var(--color-brand-yellow)"
                                  : "var(--color-brand-cyan)",
                            }}
                          >
                            {p.cpuPct.toFixed(1)}
                          </TableCell>
                          <TableCell className="w-20 px-3 py-1 text-right font-mono tabular-nums text-foreground/80">{fmtBytes(p.memKb * 1024)}</TableCell>
                        </TableRow>
                      );
                    });
                  })()}
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
                  <span className="text-lg font-bold tabular-nums text-foreground">{Math.round(memUsedPct)}%</span>
                </div>
              </div>
              <div className="flex-1 space-y-2.5 text-[11px]">
                {[
                  { c: "oklch(0.7 0.28 320)", v: `${memUsedGb.toFixed(2)} G`, l: "Used" },
                  { c: "oklch(0.55 0.18 320)", v: `${memCachedGb.toFixed(2)} G`, l: "Cached" },
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
                <span className="font-mono tabular-nums text-muted-foreground">{(swapUsedGb * 1024).toFixed(0)} M / {(swapTotalGb * 1024).toFixed(0)} M</span>
              </div>
              <Progress value={swapPct} className="h-1.5 [&>div]:bg-[oklch(0.7_0.28_320)]" />
            </div>
          </section>

          {/* Network */}
          <section className="rounded-2xl border border-border bg-[var(--color-surface)] p-5">
            <SectionLabel
              color="var(--color-brand-orange)"
              icon={Network}
              title="Network I/O"
              action={<span className="font-mono text-[10px] text-muted-foreground">{sys?.netIface ?? "—"}</span>}
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
                    {fmtBytes(sys?.netRxRate ?? 0)}/s
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-border/60">
                  <div className="h-full rounded-full bg-[var(--color-brand-green)]" style={{ width: "40%" }} />
                </div>
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
                    {fmtBytes(sys?.netTxRate ?? 0)}/s
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-border/60">
                  <div className="h-full rounded-full bg-[var(--color-brand-orange)]" style={{ width: "12%" }} />
                </div>
              </div>
            </div>
            <div className="mt-4 flex items-center justify-between border-t border-border pt-3 text-[11px]">
              <span className="text-muted-foreground">IP Address</span>
              <span className="font-mono font-bold tabular-nums text-foreground">{sys?.ip ?? "—"}</span>
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
                value={diskPct}
                label="DISK"
                gradientId="g-disk"
                size={52}
                stroke={5}
              />
              <div className="flex-1 space-y-1.5">
                <div className="font-mono text-[10px] text-muted-foreground">
                  {sys?.diskDev ? `/dev/${sys.diskDev}` : "—"}
                </div>
                <div className="flex items-baseline gap-1.5">
                  <span className="text-xl font-bold tabular-nums text-foreground">{diskPct.toFixed(0)}</span>
                  <span className="text-[10px] text-muted-foreground">%</span>
                  <span className="ml-auto font-mono text-[10px] tabular-nums text-muted-foreground">
                    {diskUsedGb.toFixed(1)} G / {diskTotalGb.toFixed(1)} G
                  </span>
                </div>
                <Progress
                  value={diskPct}
                  className="h-1 [&>div]:bg-[var(--color-brand-green)]"
                />
              </div>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 border-t border-border pt-2 text-[10px]">
              <div className="flex items-center gap-1">
                <Badge variant="outline" className="h-3.5 border-[var(--color-brand-orange)]/40 px-1 text-[9px] text-[var(--color-brand-orange)]">R</Badge>
                <span className="font-mono font-bold tabular-nums text-foreground">
                  {sys?.diskDev ? fmtBytes(sys.diskReadRate) + "/s" : "—"}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <Badge variant="outline" className="h-3.5 border-[var(--color-brand-cyan)]/40 px-1 text-[9px] text-[var(--color-brand-cyan)]">W</Badge>
                <span className="font-mono font-bold tabular-nums text-foreground">
                  {sys?.diskDev ? fmtBytes(sys.diskWriteRate) + "/s" : "—"}
                </span>
              </div>
              <div className="text-muted-foreground">
                Latency{" "}
                <span className="font-mono font-bold text-foreground">
                  {sys?.diskDev
                    ? (() => {
                        const r = sys.diskReadLatencyMs;
                        const w = sys.diskWriteLatencyMs;
                        const avg = r > 0 && w > 0 ? (r + w) / 2 : r > 0 ? r : w;
                        return avg > 0 ? `${avg.toFixed(1)} ms` : "0 ms";
                      })()
                    : "—"}
                </span>
              </div>
              <div className="text-muted-foreground">
                IOPS{" "}
                <span className="font-mono font-bold text-foreground">
                  {sys?.diskDev ? Math.round(sys.diskIops).toLocaleString() : "—"}
                </span>
              </div>
            </div>
          </section>
        </div>

        {/* ─── DOCKER CONTAINERS ──────────────────────────────────── */}
        {pollContainers !== null && (
          <section className="rounded-2xl border border-border bg-[var(--color-surface)] p-5">
            <SectionLabel
              color="oklch(0.65 0.22 270)"
              icon={Container}
              title="Docker Containers"
              action={
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="flex items-center gap-1 text-muted-foreground">
                    <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-brand-green)]" />
                    {pollContainers.filter((c) => c.state === "running").length} running
                  </span>
                  <span className="h-1 w-1 rounded-full bg-border" />
                  <span className="flex items-center gap-1 text-muted-foreground">
                    <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60" />
                    {pollContainers.filter((c) => c.state !== "running").length} stopped
                  </span>
                </div>
              }
            />
            {pollContainers.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">No containers found.</div>
            ) : (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
                {pollContainers.map((c) => {
                  const isUp = c.state === "running";
                  const memPct = c.memLimitBytes > 0 ? (c.memUsedBytes / c.memLimitBytes) * 100 : 0;
                  return (
                    <div
                      key={c.id}
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
                            <span className="font-mono">{c.state}</span>
                          </div>
                        </div>
                      </div>
                      <div className="mt-3 flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <RingGauge value={c.cpuPct} label="CPU" gradientId={`g-cpu-${c.id}`} />
                          <RingGauge value={memPct} label="RAM" gradientId={`g-ram-${c.id}`} />
                        </div>
                        <div className="flex flex-1 items-stretch gap-3 text-[10px]">
                          <IoStat
                            label="Network"
                            rows={[
                              { icon: ArrowDownToLine, value: fmtBytes(c.netRxRate), unit: "/s" },
                              { icon: ArrowUpFromLine, value: fmtBytes(c.netTxRate), unit: "/s" },
                            ]}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}
      </div>
    </ScrollArea>
  );
}



/* ---------------- Snippets view ---------------- */

