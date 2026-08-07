use crate::AppState;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};
#[cfg(target_os = "macos")]
use tauri::Emitter;
use tauri::{AppHandle, Manager};
use termifai_core::crypto::{self, VaultKey};
use termifai_core::model::vault::migrate_vault_settings;
pub use termifai_core::model::vault::{CryptoMeta, CryptoVault, LockPolicy, VaultSettings};

fn cell() -> &'static Mutex<Option<VaultKey>> {
    static VAULT: OnceLock<Mutex<Option<VaultKey>>> = OnceLock::new();
    VAULT.get_or_init(|| Mutex::new(None))
}

const KEYCHAIN_SERVICE: &str = "termifai";
const KEYCHAIN_ACCOUNT: &str = "vault-master-password";
const KEYCHAIN_SESSION_ACCOUNT: &str = "vault-session-token";

pub fn current_key() -> MutexGuard<'static, Option<VaultKey>> {
    cell().lock().expect("vault mutex poisoned")
}

pub fn is_unlocked() -> bool {
    current_key().is_some()
}

pub fn set_unlocked(key: VaultKey) {
    *current_key() = Some(key);
}

pub fn clear() {
    *current_key() = None;
}

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|e| format!("Keychain unavailable: {e}"))
}

pub fn cache_master_password(pw: &str) -> Result<(), String> {
    entry()?
        .set_password(pw)
        .map_err(|e| format!("Failed to cache master password: {e}"))
}

pub fn cached_master_password() -> Option<String> {
    entry().ok()?.get_password().ok()
}

pub fn forget_master_password() {
    if let Ok(e) = entry() {
        let _ = e.delete_credential();
    }
}

pub fn read_crypto_meta(app: &AppHandle) -> Result<Option<CryptoMeta>, String> {
    let state = app.state::<AppState>();
    let vault = state.vault_crypto_store.load().map_err(|e| e.to_string())?;
    Ok(vault.crypto)
}

pub fn write_crypto_meta(app: &AppHandle, meta: CryptoMeta) -> Result<(), String> {
    let state = app.state::<AppState>();
    state
        .vault_crypto_store
        .update(|vault| {
            vault.crypto = Some(meta);
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn migrate_crypto_meta_from_hosts(
    app: &AppHandle,
    crypto_meta: CryptoMeta,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    state
        .vault_crypto_store
        .update(|vault| {
            if vault.crypto.is_none() {
                vault.crypto = Some(crypto_meta);
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn get_lock_policy(app: &AppHandle) -> LockPolicy {
    let state = app.state::<AppState>();
    state
        .vault_settings_store
        .load_with_migration(migrate_vault_settings)
        .map(|s| s.lock_policy)
        .unwrap_or_default()
}

pub fn set_lock_policy(app: &AppHandle, policy: LockPolicy) -> Result<(), String> {
    let state = app.state::<AppState>();
    state
        .vault_settings_store
        .update_with_migration(migrate_vault_settings, |s| {
            s.lock_policy = policy;
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Session token ─────────────────────────────────────────────────────────────
// On macOS, $TMPDIR is per-user-session and cleared on logout/restart — a simple
// presence file there detects "same login session?".
// On Linux, `/tmp` is shared and world-sticky: a predictable
// `termifai-vault-session` file can be planted after reboot to skip the
// OnRestart re-prompt while the keychain still holds the master password.
// Linux therefore binds the session to the kernel boot_id stored in the
// keychain instead of trusting a forgeable temp file.

fn session_token_path() -> PathBuf {
    // Prefer the per-user runtime dir when available (cleared on logout).
    if let Ok(runtime) = std::env::var("XDG_RUNTIME_DIR") {
        let runtime = runtime.trim();
        if !runtime.is_empty() {
            return PathBuf::from(runtime).join("termifai-vault-session");
        }
    }
    std::env::temp_dir().join("termifai-vault-session")
}

fn legacy_tmp_session_token_path() -> PathBuf {
    std::env::temp_dir().join("termifai-vault-session")
}

fn session_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_SESSION_ACCOUNT)
        .map_err(|e| format!("Keychain unavailable: {e}"))
}

fn linux_boot_session_marker() -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        let boot_id = std::fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?;
        let boot_id = boot_id.trim();
        if boot_id.is_empty() {
            return None;
        }
        return Some(format!("boot:{boot_id}"));
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

fn touch_session_token() {
    if let Some(marker) = linux_boot_session_marker() {
        if let Ok(entry) = session_entry() {
            let _ = entry.set_password(&marker);
        }
        // فایل قدیمی و forgeable تو /tmp رو پاک کن تا کسی روش حساب نکنه
        let _ = std::fs::remove_file(legacy_tmp_session_token_path());
        return;
    }

    let path = session_token_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&path, b"1");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
}

fn session_alive() -> bool {
    if let Some(marker) = linux_boot_session_marker() {
        return session_entry()
            .ok()
            .and_then(|entry| entry.get_password().ok())
            .map(|stored| stored == marker)
            .unwrap_or(false);
    }
    session_token_path().exists()
}

pub fn clear_session_token() {
    let _ = std::fs::remove_file(session_token_path());
    let _ = std::fs::remove_file(legacy_tmp_session_token_path());
    if let Ok(entry) = session_entry() {
        let _ = entry.delete_credential();
    }
}

// ── Vault status ──────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub initialized: bool,
    pub unlocked: bool,
    pub lock_policy: LockPolicy,
}

pub fn op_status(app: &AppHandle) -> Result<VaultStatus, String> {
    let initialized = read_crypto_meta(app)?.is_some();
    Ok(VaultStatus {
        initialized,
        unlocked: is_unlocked(),
        lock_policy: get_lock_policy(app),
    })
}

// ── Vault operations ──────────────────────────────────────────────────────────

/// Initialize a brand-new vault. Fails if one already exists.
pub fn op_init(app: &AppHandle, master_password: &str) -> Result<(), String> {
    if master_password.is_empty() {
        return Err("Master password cannot be empty".to_string());
    }
    if read_crypto_meta(app)?.is_some() {
        return Err("Vault is already initialized".to_string());
    }
    let v =
        crypto::create_vault(master_password).map_err(|_| "Failed to create vault".to_string())?;
    write_crypto_meta(
        app,
        CryptoMeta {
            kdf: "argon2id".to_string(),
            salt: v.salt_b64,
            wrapped_key: v.wrapped_key,
            verifier: v.verifier,
        },
    )?;
    set_unlocked(v.key);
    cache_for_policy(app, master_password);
    Ok(())
}

/// Unlock with an explicit master password. Caches per policy on success.
pub fn op_unlock(app: &AppHandle, master_password: &str) -> Result<(), String> {
    let meta = read_crypto_meta(app)?.ok_or("Vault is not initialized")?;
    let key = crypto::unlock_vault(
        master_password,
        &meta.salt,
        &meta.wrapped_key,
        &meta.verifier,
    )
    .map_err(|e| match e {
        crypto::CryptoError::WrongPassword => "Incorrect master password".to_string(),
        _ => "Failed to unlock vault".to_string(),
    })?;
    set_unlocked(key);
    cache_for_policy(app, master_password);
    Ok(())
}

/// Attempt a silent unlock using the keychain-cached master password.
/// Returns Ok(true) if unlocked, Ok(false) if no usable cache.
pub fn op_try_cached_unlock(app: &AppHandle) -> Result<bool, String> {
    if read_crypto_meta(app)?.is_none() {
        return Ok(false);
    }
    let policy = get_lock_policy(app);
    match policy {
        LockPolicy::OnAppClose => return Ok(false),
        LockPolicy::OnRestart if !session_alive() => {
            // New session (restart/logout) — clear stale keychain entry and ask
            forget_master_password();
            return Ok(false);
        }
        _ => {}
    }
    let Some(pw) = cached_master_password() else {
        return Ok(false);
    };
    match op_unlock(app, &pw) {
        Ok(()) => Ok(true),
        Err(_) => {
            forget_master_password();
            Ok(false)
        }
    }
}

/// Explicitly lock the vault. Always clears keychain and session token.
pub fn op_lock() {
    forget_master_password();
    clear_session_token();
    clear();
}

pub fn op_change_master_password(app: &AppHandle, old: &str, new: &str) -> Result<(), String> {
    if new.is_empty() {
        return Err("New master password cannot be empty".to_string());
    }
    let meta = read_crypto_meta(app)?.ok_or("Vault is not initialized")?;
    let v = crypto::rewrap(old, &meta.salt, &meta.wrapped_key, &meta.verifier, new).map_err(
        |e| match e {
            crypto::CryptoError::WrongPassword => {
                "Current master password is incorrect".to_string()
            }
            _ => "Failed to change master password".to_string(),
        },
    )?;
    write_crypto_meta(
        app,
        CryptoMeta {
            kdf: "argon2id".to_string(),
            salt: v.salt_b64,
            wrapped_key: v.wrapped_key,
            verifier: v.verifier,
        },
    )?;
    set_unlocked(v.key);
    cache_for_policy(app, new);
    Ok(())
}

/// Called on app exit — clears keychain if policy is OnAppClose.
pub fn on_app_exit(app: &AppHandle) {
    if get_lock_policy(app) == LockPolicy::OnAppClose {
        forget_master_password();
        clear();
    }
}

/// Called when screen is locked — clears keychain if policy is OnScreenLock.
#[cfg(target_os = "macos")]
pub fn on_screen_lock(app: &AppHandle) {
    if get_lock_policy(app) == LockPolicy::OnScreenLock {
        op_lock();
        // Notify the frontend so it can re-gate the Hosts view immediately.
        let _ = app.emit("vault-locked", ());
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn cache_for_policy(app: &AppHandle, master_password: &str) {
    let policy = get_lock_policy(app);
    match policy {
        LockPolicy::OnAppClose => {} // don't persist to keychain
        _ => {
            let _ = cache_master_password(master_password);
            touch_session_token();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vault_status_serializes_camel_case() {
        // We can't call op_status without an AppHandle; test the struct directly.
        let s = serde_json::to_value(VaultStatus {
            initialized: true,
            unlocked: false,
            lock_policy: LockPolicy::OnRestart,
        })
        .unwrap();
        assert_eq!(s["initialized"], true);
        assert_eq!(s["unlocked"], false);
        assert_eq!(s["lockPolicy"], "on_restart");
    }

    #[test]
    fn starts_locked_then_unlocks_and_clears() {
        clear();
        assert!(!is_unlocked());
        set_unlocked(VaultKey::from_bytes([1u8; 32]));
        assert!(is_unlocked());
        clear();
        assert!(!is_unlocked());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_boot_session_marker_is_stable_within_boot() {
        let a = linux_boot_session_marker().expect("boot_id should be readable");
        let b = linux_boot_session_marker().expect("boot_id should be readable");
        assert_eq!(a, b);
        assert!(a.starts_with("boot:"));
        assert!(a.len() > 5);
    }
}
