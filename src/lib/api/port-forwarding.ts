import { call } from "./transport";
import type { Host, HostGroup, PortForwardRule, TunnelStatus } from "@/components/app/types";

export function listPortForwards(): Promise<PortForwardRule[]> {
  return call<PortForwardRule[]>("list_port_forwards");
}

export function listHostsForForwarding(): Promise<{ hosts: Host[]; groups: HostGroup[] }> {
  return call<{ hosts: Host[]; groups: HostGroup[] }>("list_hosts");
}

export function getTunnelStatuses(ruleIds: string[]): Promise<TunnelStatus[]> {
  return call<TunnelStatus[]>("get_tunnel_statuses", { ruleIds });
}

export function savePortForward(
  data: Omit<PortForwardRule, "id" | "createdAt">,
  id?: string,
): Promise<PortForwardRule> {
  return call<PortForwardRule>("save_port_forward", { request: { ...data, id: id ?? null } });
}

export function removePortForwards(ids: string[]): Promise<void> {
  return call<void>("remove_port_forwards", { ids });
}

export function startTunnel(ruleId: string): Promise<TunnelStatus> {
  return call<TunnelStatus>("start_tunnel", { ruleId });
}

export function stopTunnel(ruleId: string): Promise<TunnelStatus> {
  return call<TunnelStatus>("stop_tunnel", { ruleId });
}
