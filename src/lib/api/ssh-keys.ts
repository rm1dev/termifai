import { call } from "./transport";
import type { SshKey } from "@/components/app/types";

export function listSshKeys(): Promise<SshKey[]> {
  return call<SshKey[]>("list_ssh_keys");
}

export function removeSshKeys(ids: string[]): Promise<void> {
  return call<void>("remove_ssh_keys", { ids });
}

export interface GenerateSshKeyRequest {
  name: string;
  type: "ed25519" | "rsa";
  size: 1024 | 2048 | 4096 | null;
  passphrase: string;
  remark: string;
}

export function generateSshKey(request: GenerateSshKeyRequest): Promise<SshKey> {
  return call<SshKey>("generate_ssh_key", { request });
}
