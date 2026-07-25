import { call } from "./api/transport";
import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  dashboardStore,
  DETAIL_INTERVAL_MS,
  type HostPollResult,
  type HostStatusEntry,
  type HostPhase,
  type CoreMetrics,
  type SystemMetrics,
  type ContainerMetric,
  type ContainerSummary,
  type ProcessInfo,
} from "./dashboardStore";

export type {
  HostPollResult,
  HostStatusEntry,
  HostPhase,
  CoreMetrics,
  SystemMetrics,
  ContainerMetric,
  ContainerSummary,
  ProcessInfo,
};

/** Converts bytes to a compact human-readable string. Kept short on purpose — these render
 *  in tight stat columns: byte values are integers ("107 B", not "107.4 B") and anything
 *  ≥ 100 drops the decimal ("121 K"), so values never wrap or truncate. */
export function fmtBytes(bytes: number): string {
  if (bytes < 1) return "0 B";
  const units = ["B", "K", "M", "G", "T"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const v = bytes / Math.pow(1024, i);
  const s = i === 0 || v >= 100 ? Math.round(v).toString() : v.toFixed(1);
  return `${s} ${units[i]}`;
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

/**
 * Reads dashboard state from the persistent store and keeps it reconciled with the
 * current host list. Pass `null` for `hostIds` while the host list is still loading —
 * that avoids the store treating a transient empty array as "all hosts removed".
 * Polling and SSH connections live in the store, not this component, so switching
 * away from the dashboard tab and back does not reconnect or reset anything.
 */
export function useDashboard(hostIds: string[] | null): {
  stats: Record<string, HostPollResult>;
  status: Record<string, HostStatusEntry>;
} {
  const hostIdsKey = hostIds ? hostIds.join(",") : null;

  useEffect(() => {
    if (hostIds === null) return;
    dashboardStore.reconcile(hostIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostIdsKey]);

  useEffect(() => {
    dashboardStore.setVisible(true);
    return () => dashboardStore.setVisible(false);
  }, []);

  const stats = useSyncExternalStore(dashboardStore.subscribe, dashboardStore.getStats);
  const status = useSyncExternalStore(dashboardStore.subscribe, dashboardStore.getStatus);

  return { stats, status };
}

/** For detail view of a specific host */
export function useHostDetail(hostId: string | null): {
  detail: HostPollResult | null;
  refresh: () => void;
} {
  const detail = useSyncExternalStore(dashboardStore.subscribe, () =>
    hostId ? dashboardStore.getDetailCache(hostId) : null,
  );
  const hostIdRef = useRef(hostId);
  hostIdRef.current = hostId;

  const refreshDetail = () => {
    if (!hostIdRef.current) return;
    call("dashboard_poll", { wantProcesses: true, wantContainers: true, hostId: hostIdRef.current }).catch(
      console.error,
    );
  };

  useEffect(() => {
    if (!hostId) return;

    refreshDetail();
    // Tells the actor to start a docker-events watcher for near-1s container state changes
    // (a container dying between two 5s polls shouldn't take up to 5s to show up).
    call("dashboard_watch_containers", { hostId, watch: true }).catch(console.error);

    // Processes and containers are requested together on the same 5s cadence. The batched
    // docker collection (single exec regardless of container count) makes this cheap enough
    // that container state — often more important than host-level CPU/RAM — doesn't lag
    // 30s behind everything else.
    const interval = setInterval(refreshDetail, DETAIL_INTERVAL_MS);

    return () => {
      clearInterval(interval);
      call("dashboard_watch_containers", { hostId, watch: false }).catch(console.error);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId]);

  return { detail, refresh: refreshDetail };
}
