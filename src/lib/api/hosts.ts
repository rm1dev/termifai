import { call } from "./transport";
import type { Host, HostGroup } from "@/components/app/types";

export function listHosts(): Promise<{ hosts: Host[]; groups: HostGroup[] }> {
  return call<{ hosts: Host[]; groups: HostGroup[] }>("list_hosts");
}

export function saveHost(data: Omit<Host, "id">, id?: string): Promise<Host> {
  return call<Host>("save_host", { request: { ...data, id: id ?? null } });
}

export function removeHosts(ids: string[]): Promise<void> {
  return call<void>("remove_hosts", { ids });
}

/** Plaintext password of a stored host, decrypted with the unlocked vault key.
 * Used by the edit form so the field shows the real password, not the vault token. */
export function getHostPassword(id: string): Promise<string | null> {
  return call<string | null>("get_host_password", { id });
}

export function saveHostGroup(
  name: string,
  parentId: string | null,
  id?: string,
): Promise<HostGroup> {
  return call<HostGroup>("save_host_group", { request: { id: id ?? null, name, parentId } });
}

export function removeHostGroup(id: string): Promise<void> {
  return call<void>("remove_host_group", { id });
}

export interface TestHostConnectionRequest {
  hostname: string;
  user: string;
  port: number;
  password: string;
  sshKeyId: string | null;
  timeoutSecs: number;
}

export function testHostConnection(
  request: TestHostConnectionRequest,
): Promise<{ ok: boolean; message: string }> {
  return call<{ ok: boolean; message: string }>("test_host_connection", { request });
}
