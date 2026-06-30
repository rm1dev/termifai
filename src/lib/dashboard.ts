import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";

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

export interface ContainerMetric {
  id: string;
  name: string;
  state: string;
  cpuPct: number;
  memUsedBytes: number;
  memLimitBytes: number;
  netRxRate: number;
  netTxRate: number;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  user: string;
  cpuPct: number;
  memKb: number;
}

export interface HostPollResult {
  hostId: string;
  ok: boolean;
  system: SystemMetrics | null;
  containers: ContainerMetric[] | null;
  processes: ProcessInfo[] | null;
  error: string | null;
}

/** Converts bytes to a human-readable string */
export function fmtBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "K", "M", "G", "T"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/** Converts seconds to "Xd Xh Xm" format */
export function fmtUptime(secs: number): string {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const POLL_INTERVAL_MS = 30_000;
const PROCESS_INTERVAL_MS = 5_000;

export function useDashboard(hostIds: string[]): {
  stats: Record<string, HostPollResult>;
  loading: Set<string>;
} {
  const [stats, setStats] = useState<Record<string, HostPollResult>>({});
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const hostIdsRef = useRef(hostIds);

  useEffect(() => {
    hostIdsRef.current = hostIds;
  }, [hostIds]);

  // Stable key so the effect re-runs when host list changes (e.g. after async load)
  const hostIdsKey = hostIds.join(",");

  useEffect(() => {
    if (hostIds.length === 0) return;

    setLoading(new Set(hostIds));

    // Connect and initial poll
    invoke("dashboard_connect", { hostIds })
      .then(() => invoke("dashboard_poll", { wantDetail: false, hostId: null }))
      .catch(console.error);

    // Receive streaming results
    const unlistenPromise = listen<HostPollResult>("dash:stat", ({ payload }) => {
      setStats((prev) => ({ ...prev, [payload.hostId]: payload }));
      setLoading((prev) => {
        const next = new Set(prev);
        next.delete(payload.hostId);
        return next;
      });
    });

    // Poll every 30 seconds
    const interval = setInterval(() => {
      invoke("dashboard_poll", {
        wantDetail: false,
        hostId: null,
      }).catch(console.error);
    }, POLL_INTERVAL_MS);

    return () => {
      clearInterval(interval);
      unlistenPromise.then((fn) => fn());
      invoke("dashboard_disconnect", { hostIds: hostIdsRef.current }).catch(console.error);
    };
  }, [hostIdsKey]); // Re-run when host list changes (hosts load async)

  return { stats, loading };
}

/** For detail view of a specific host */
export function useHostDetail(hostId: string | null): {
  detail: HostPollResult | null;
  refresh: () => void;
} {
  const [detail, setDetail] = useState<HostPollResult | null>(null);

  const refresh = () => {
    if (!hostId) return;
    invoke("dashboard_poll", { wantDetail: true, hostId }).catch(console.error);
  };

  useEffect(() => {
    if (!hostId) return;

    setDetail(null);
    refresh(); // initial poll — fetches system metrics + process list

    const unlistenPromise = listen<HostPollResult>("dash:stat", ({ payload }) => {
      if (payload.hostId === hostId) {
        setDetail((prev) => {
          // want_detail=true polls: return processes + sys metrics, containers=null (Docker skipped).
          // want_detail=false polls: return containers + sys metrics, processes=null.
          // In both cases, preserve whichever field is missing from prev state.
          return {
            ...payload,
            processes:  payload.processes  ?? prev?.processes  ?? null,
            containers: payload.containers ?? prev?.containers ?? null,
          };
        });
      }
    });

    // Poll processes every 5s — lightweight: reads /proc/*/stat, no ps CPU sorting.
    // Docker metrics are handled by useDashboard's 30s interval separately.
    const interval = setInterval(() => {
      if (!hostId) return;
      invoke("dashboard_poll", { wantDetail: true, hostId }).catch(console.error);
    }, PROCESS_INTERVAL_MS);

    return () => {
      clearInterval(interval);
      unlistenPromise.then((fn) => fn());
    };
  }, [hostId]);

  return { detail, refresh };
}
