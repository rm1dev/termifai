import { invoke } from "@tauri-apps/api/core";

export interface VaultStatus {
  initialized: boolean;
  unlocked: boolean;
}

export function vaultStatus(): Promise<VaultStatus> {
  return invoke<VaultStatus>("vault_status");
}

export function vaultInit(masterPassword: string): Promise<void> {
  return invoke<void>("vault_init", { masterPassword });
}

export function vaultUnlock(masterPassword: string): Promise<void> {
  return invoke<void>("vault_unlock", { masterPassword });
}

export function vaultLock(): Promise<void> {
  return invoke<void>("vault_lock");
}

export function vaultChangeMasterPassword(
  oldPassword: string,
  newPassword: string,
): Promise<void> {
  return invoke<void>("vault_change_master_password", { oldPassword, newPassword });
}

export function getHostPassword(hostId: string): Promise<string | null> {
  return invoke<string | null>("get_host_password", { hostId });
}
