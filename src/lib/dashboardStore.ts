import { call, subscribe } from "./api/transport";

export interface CoreMetrics {
  total: number;
  user: number;
  system: number;
  nice: number;
  iowait: number;
  steal: number;
}

export interface SystemMetrics {
  cpuPct: number;
  cpuCores: CoreMetrics[];
  memTotalKb: number;
  memUsedKb: number;
  memCachedKb: number;
  swapTotalKb: number;
  swapUsedKb: number;
  diskTotalKb: number;
  diskUsedKb: number;
  diskReadRate: number;       // bytes/sec
  diskWriteRate: number;      // bytes/sec
  diskIops: number;           // ops/sec
  diskReadLatencyMs: number;  // avg ms per read op
  diskWriteLatencyMs: number; // avg ms per write op
  diskDev: string;
  load1m: number;
  load5m: number;
  load15m: number;
  uptimeSecs: number;
  netRxRate: number; // bytes/sec
  netTxRate: number;
  netIface: string;
  cores: number;
  ip: string;
}

export type ContainerHealth = "healthy" | "unhealthy" | "starting";

export interface ContainerMetric {
  id: string;
  name: string;
  state: string;
  statusText: string; // e.g. "Up 3 hours", "Exited (137) 2 minutes ago"
  health: ContainerHealth | null;
  restartCount: number;
  cpuPct: number;
  memUsedBytes: number;
  memLimitBytes: number;
  netRxRate: number;
  netTxRate: number;
  diskReadRate: number;  // bytes/sec
  diskWriteRate: number; // bytes/sec
}

export interface ProcessInfo {
  pid: number;
  name: string;
  user: string;
  cpuPct: number;
  memKb: number;
}

export interface ContainerSummary {
  running: number;
  stopped: number;
}

export interface HostPollResult {
  hostId: string;
  ok: boolean;
  system: SystemMetrics | null;
  containerSummary: ContainerSummary | null; // null = docker not installed on this host
  containers: ContainerMetric[] | null;
  processes: ProcessInfo[] | null;
  error: string | null;
  latencyMs: number | null;
}

export type HostPhase = "connecting" | "online" | "offline" | "reconnecting";

export interface HostStatusEntry {
  phase: HostPhase;
  latencyMs: number | null;
  error: string | null;
}

interface DashStatusEvent {
  hostId: string;
  phase: HostPhase;
  error: string | null;
}

const OVERVIEW_INTERVAL_ACTIVE_MS = 30_000;
const OVERVIEW_INTERVAL_INACTIVE_MS = 120_000;
// Processes and containers share this cadence — the batched docker collection (Phase A of
// the container-monitoring plan) is cheap enough that container state doesn't need its own
// slower interval anymore.
const DETAIL_INTERVAL_MS = 5_000;

/**
 * Module-level singleton so dashboard polling and connection state survive the
 * DashboardView component being unmounted (e.g. when the user switches sidebar tabs).
 * Sessions are only torn down on app quit (backend-side reset) or when a host is
 * explicitly dropped from the tracked set via reconcile().
 */
class DashboardStore {
  private trackedHostIds = new Set<string>();
  private stats: Record<string, HostPollResult> = {};
  private status: Record<string, HostStatusEntry> = {};
  private detailCache: Record<string, HostPollResult> = {};
  private listeners = new Set<() => void>();

  private subscribed = false;
  private overviewInterval: ReturnType<typeof setInterval> | null = null;
  private visible = false;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private notify() {
    for (const fn of this.listeners) fn();
  }

  getStats = (): Record<string, HostPollResult> => this.stats;
  getStatus = (): Record<string, HostStatusEntry> => this.status;
  getDetailCache = (hostId: string): HostPollResult | null => this.detailCache[hostId] ?? null;

  setVisible(visible: boolean) {
    if (this.visible === visible) return;
    this.visible = visible;
    if (this.overviewInterval !== null) {
      // Restart the interval on the new cadence; an immediate poll on becoming
      // visible again keeps the return-to-dashboard experience snappy.
      this.startOverviewInterval();
      if (visible) this.pollOverview();
    }
  }

  /** Connects any host in `hostIds` not yet tracked, and disconnects tracked hosts no
   *  longer present. Call only with an authoritative (post-load) host list — an empty
   *  array during a transient loading state should not be passed here. */
  reconcile(hostIds: string[]) {
    const next = new Set(hostIds);
    const toAdd = hostIds.filter((id) => !this.trackedHostIds.has(id));
    const toRemove = [...this.trackedHostIds].filter((id) => !next.has(id));

    if (toAdd.length === 0 && toRemove.length === 0) return;

    this.ensureSubscribed();

    for (const id of toAdd) this.trackedHostIds.add(id);
    for (const id of toRemove) {
      this.trackedHostIds.delete(id);
      const { [id]: _s, ...restStats } = this.stats;
      const { [id]: _st, ...restStatus } = this.status;
      const { [id]: _d, ...restDetail } = this.detailCache;
      this.stats = restStats;
      this.status = restStatus;
      this.detailCache = restDetail;
    }
    this.notify();

    if (toAdd.length > 0) {
      call("dashboard_connect", { hostIds: toAdd })
        .then(() => call("dashboard_poll", { wantProcesses: false, wantContainers: false, hostId: null }))
        .catch(console.error);
    }
    if (toRemove.length > 0) {
      call("dashboard_disconnect", { hostIds: toRemove }).catch(console.error);
    }

    this.startOverviewInterval();
  }

  private ensureSubscribed() {
    if (this.subscribed) return;
    this.subscribed = true;

    subscribe<HostPollResult>("dash:stat", ({ payload }) => {
      if (!this.trackedHostIds.has(payload.hostId)) return;
      this.stats = { ...this.stats, [payload.hostId]: payload };

      // Merge into the detail cache too, preserving whichever of processes/containers
      // this particular poll didn't request — every dash:stat (overview or detail poll)
      // updates the same per-host snapshot so re-opening a host's detail view is instant.
      const prevDetail = this.detailCache[payload.hostId];
      this.detailCache = {
        ...this.detailCache,
        [payload.hostId]: {
          ...payload,
          processes: payload.processes ?? prevDetail?.processes ?? null,
          containers: payload.containers ?? prevDetail?.containers ?? null,
        },
      };

      // A successful poll implies the host is online — keep status in sync even if a
      // dash:status "online" event was coalesced, and carry the fresh ping value.
      const prevStatus = this.status[payload.hostId];
      this.status = {
        ...this.status,
        [payload.hostId]: {
          phase: payload.ok ? "online" : prevStatus?.phase ?? "offline",
          latencyMs: payload.ok ? payload.latencyMs : prevStatus?.latencyMs ?? null,
          error: payload.error,
        },
      };
      this.notify();
    });

    subscribe<DashStatusEvent>("dash:status", ({ payload }) => {
      if (!this.trackedHostIds.has(payload.hostId)) return;
      const prev = this.status[payload.hostId];
      this.status = {
        ...this.status,
        [payload.hostId]: {
          phase: payload.phase,
          latencyMs: payload.phase === "online" ? prev?.latencyMs ?? null : null,
          error: payload.error,
        },
      };
      this.notify();
    });
  }

  private startOverviewInterval() {
    if (this.overviewInterval !== null) clearInterval(this.overviewInterval);
    if (this.trackedHostIds.size === 0) {
      this.overviewInterval = null;
      return;
    }
    const ms = this.visible ? OVERVIEW_INTERVAL_ACTIVE_MS : OVERVIEW_INTERVAL_INACTIVE_MS;
    this.overviewInterval = setInterval(() => this.pollOverview(), ms);
  }

  private pollOverview() {
    if (this.trackedHostIds.size === 0) return;
    call("dashboard_poll", { wantProcesses: false, wantContainers: false, hostId: null }).catch(console.error);
  }
}

export const dashboardStore = new DashboardStore();

export { DETAIL_INTERVAL_MS };
