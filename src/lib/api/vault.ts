import { invoke } from "@tauri-apps/api/core";

export type LockPolicy = "never" | "on_restart" | "on_app_close" | "on_screen_lock";

export interface VaultStatus {
  initialized: boolean;
  unlocked: boolean;
  lockPolicy: LockPolicy;
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


export function getLockPolicy(): Promise<LockPolicy> {
  return invoke<LockPolicy>("get_vault_lock_policy");
}

export function setLockPolicy(policy: LockPolicy): Promise<void> {
  return invoke<void>("set_vault_lock_policy", { policy });
}
