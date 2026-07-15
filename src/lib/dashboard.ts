import { call } from "./api/transport";
import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  dashboardStore,
  PROCESS_INTERVAL_MS,
  CONTAINER_INTERVAL_MS,
  type HostPollResult,
  type HostStatusEntry,
  type HostPhase,
  type CoreMetrics,
  type SystemMetrics,
  type ContainerMetric,
  type ProcessInfo,
} from "./dashboardStore";

export type {
  HostPollResult,
  HostStatusEntry,
  HostPhase,
  CoreMetrics,
  SystemMetrics,
  ContainerMetric,
  ProcessInfo,
};

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

  const refreshProcesses = () => {
    if (!hostIdRef.current) return;
    call("dashboard_poll", { wantProcesses: true, wantContainers: false, hostId: hostIdRef.current }).catch(
      console.error,
    );
  };
  const refreshContainers = () => {
    if (!hostIdRef.current) return;
    call("dashboard_poll", { wantProcesses: false, wantContainers: true, hostId: hostIdRef.current }).catch(
      console.error,
    );
  };

  useEffect(() => {
    if (!hostId) return;

    refreshProcesses();
    refreshContainers();

    // Poll processes every 5s (fast, lightweight — /proc/*/stat reads) and containers
    // on a slower cadence (docker inspect + cgroup reads per container). Both requests
    // return the same HostPollResult shape; the store merges whichever field is present
    // into the cached detail, preserving the other from the previous merge.
    const procInterval = setInterval(refreshProcesses, PROCESS_INTERVAL_MS);
    const containerInterval = setInterval(refreshContainers, CONTAINER_INTERVAL_MS);

    return () => {
      clearInterval(procInterval);
      clearInterval(containerInterval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId]);

  return { detail, refresh: refreshProcesses };
}
