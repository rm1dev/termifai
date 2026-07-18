import { call, subscribe, type UnlistenFn } from "./transport";

export type SyncBackendConfig =
  | { kind: "localDir"; path: string }
  | { kind: "googleDrive" }
  | { kind: "dropbox" }
  | { kind: "sftp"; hostId: string; remotePath: string };

export interface SettingsBlob {
  value?: unknown;
  updatedAt?: string;
}

export interface SyncStats {
  uploaded: boolean;
  applied: boolean;
  collectionsUploaded: string[];
  collectionsDownloaded: string[];
  at: string;
}

export interface SyncStatus {
  backend: SyncBackendConfig | null;
  lastSyncedBlobVersion: number;
  lastSyncAt: string | null;
  syncSshKeys: boolean;
  dirty: boolean;
  deviceId: string | null;
  autoSync: boolean;
  lastError: string | null;
  syncing: boolean;
  lastSyncStats: SyncStats | null;
}

export type SyncActivityPhase = "idle" | "syncing" | "ok" | "error";

export interface SyncActivity {
  phase: SyncActivityPhase;
  uploaded: boolean;
  applied: boolean;
  blobVersion: number;
  lastSyncAt: string | null;
  error: string | null;
  dirty: boolean;
  autoSync: boolean;
}

export function syncGetConfig(): Promise<SyncStatus> {
  return call<SyncStatus>("sync_get_config");
}

export function syncSetConfig(backend: SyncBackendConfig, syncSshKeys: boolean): Promise<void> {
  return call<void>("sync_set_config", { request: { backend, syncSshKeys } });
}

export function syncStatus(): Promise<SyncStatus> {
  return call<SyncStatus>("sync_status");
}

export function syncDisconnect(deleteRemote: boolean): Promise<void> {
  return call<void>("sync_disconnect", { deleteRemote });
}

export function syncSetAutoSync(enabled: boolean): Promise<void> {
  return call<void>("sync_set_auto_sync", { enabled });
}

export function syncCacheSettings(request: {
  appTheme?: SettingsBlob;
  terminalAppearance?: SettingsBlob;
  shortcuts?: SettingsBlob;
}): Promise<void> {
  return call<void>("sync_cache_settings", { request });
}

export type OAuthProvider = "google" | "dropbox";

/** Opens the system browser for the provider's OAuth consent screen and
 * blocks (up to 5 minutes) until the loopback callback completes the PKCE
 * exchange. Resolves with the keychain account name the tokens were stored
 * under — not a human-readable label (neither backend fetches a profile). */
export function syncConnectProvider(provider: OAuthProvider): Promise<string> {
  return call<string>("sync_connect_provider", { provider });
}

export interface SyncNowRequest {
  masterPassword?: string;
  appTheme?: SettingsBlob;
  terminalAppearance?: SettingsBlob;
  shortcuts?: SettingsBlob;
}

export interface SyncNowResult {
  blobVersion: number;
  /** True when a new remote blob was written (version bumped). */
  uploaded: boolean;
  /** True when local stores were rewritten from the merge result. */
  applied: boolean;
  collectionsUploaded: string[];
  collectionsDownloaded: string[];
  appTheme: SettingsBlob;
  terminalAppearance: SettingsBlob;
  shortcuts: SettingsBlob;
}

/** Rejects with the literal message "master_password_required" when no
 * password was supplied and none is cached in the OS keychain — callers
 * should catch that specifically and prompt the user. */
export function syncNow(request: SyncNowRequest = {}): Promise<SyncNowResult> {
  return call<SyncNowResult>("sync_now", { request });
}

export function onSyncActivity(handler: (activity: SyncActivity) => void): Promise<UnlistenFn> {
  return subscribe<SyncActivity>("sync:activity", (event) => handler(event.payload));
}

export function vaultInitFromSync(
  backend: SyncBackendConfig,
  masterPassword: string,
): Promise<void> {
  return call<void>("vault_init_from_sync", { request: { backend, masterPassword } });
}

export function syncImportForeign(
  backend: SyncBackendConfig,
  remoteMasterPassword: string,
  options?: { currentMasterPassword?: string; replaceRemote?: boolean },
): Promise<void> {
  return call<void>("sync_import_foreign", {
    request: {
      backend,
      remoteMasterPassword,
      currentMasterPassword: options?.currentMasterPassword,
      replaceRemote: options?.replaceRemote ?? false,
    },
  });
}
