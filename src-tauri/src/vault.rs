use crate::crypto::{self, VaultKey};
use crate::hosts::{self, CryptoMeta};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};
#[cfg(target_os = "macos")]
use tauri::Emitter;
use tauri::{AppHandle, Manager};

fn cell() -> &'static Mutex<Option<VaultKey>> {
    static VAULT: OnceLock<Mutex<Option<VaultKey>>> = OnceLock::new();
    VAULT.get_or_init(|| Mutex::new(None))
}

const KEYCHAIN_SERVICE: &str = "termifai";
const KEYCHAIN_ACCOUNT: &str = "vault-master-password";

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

// ── Lock Policy ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum LockPolicy {
    /// Cache master password in OS keychain; never auto-lock.
    Never,
    /// Cache in keychain; re-ask after system restart/logout (default).
    #[default]
    OnRestart,
    /// Never cache; always ask when app reopens.
    OnAppClose,
    /// Cache in keychain; lock when screen is locked.
    OnScreenLock,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct VaultSettings {
    #[serde(default)]
    lock_policy: LockPolicy,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve data dir: {e}"))?
        .join("vault_settings.json"))
}

fn read_settings(app: &AppHandle) -> VaultSettings {
    settings_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_settings(app: &AppHandle, settings: &VaultSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    let json = serde_json::to_string_pretty(settings).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("write: {e}"))
}

pub fn get_lock_policy(app: &AppHandle) -> LockPolicy {
    read_settings(app).lock_policy
}

pub fn set_lock_policy(app: &AppHandle, policy: LockPolicy) -> Result<(), String> {
    let mut s = read_settings(app);
    s.lock_policy = policy;
    write_settings(app, &s)
}

// ── Session token ─────────────────────────────────────────────────────────────
// $TMPDIR on macOS is per-user-session and is cleared on logout/restart.
// Writing a token there lets us detect "is this the same session?" cheaply.

fn session_token_path() -> PathBuf {
    let tmp = std::env::var("TMPDIR").unwrap_or_else(|_| "/tmp".into());
    PathBuf::from(tmp).join("termifai-vault-session")
}

fn touch_session_token() {
    let _ = std::fs::write(session_token_path(), b"1");
}

fn session_alive() -> bool {
    session_token_path().exists()
}

pub fn clear_session_token() {
    let _ = std::fs::remove_file(session_token_path());
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
    let initialized = hosts::read_crypto_meta(app)?.is_some();
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
    if hosts::read_crypto_meta(app)?.is_some() {
        return Err("Vault is already initialized".to_string());
    }
    let v =
        crypto::create_vault(master_password).map_err(|_| "Failed to create vault".to_string())?;
    hosts::write_crypto_meta(
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
    hosts::migrate_plaintext_passwords(app)?;
    Ok(())
}

/// Unlock with an explicit master password. Caches per policy on success.
pub fn op_unlock(app: &AppHandle, master_password: &str) -> Result<(), String> {
    let meta = hosts::read_crypto_meta(app)?.ok_or("Vault is not initialized")?;
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
    hosts::migrate_plaintext_passwords(app)?;
    Ok(())
}

/// Attempt a silent unlock using the keychain-cached master password.
/// Returns Ok(true) if unlocked, Ok(false) if no usable cache.
pub fn op_try_cached_unlock(app: &AppHandle) -> Result<bool, String> {
    if hosts::read_crypto_meta(app)?.is_none() {
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
    let meta = hosts::read_crypto_meta(app)?.ok_or("Vault is not initialized")?;
    let v = crypto::rewrap(old, &meta.salt, &meta.wrapped_key, &meta.verifier, new).map_err(
        |e| match e {
            crypto::CryptoError::WrongPassword => {
                "Current master password is incorrect".to_string()
            }
            _ => "Failed to change master password".to_string(),
        },
    )?;
    hosts::write_crypto_meta(
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

    #[test]
    fn lock_policy_round_trips() {
        let p = LockPolicy::OnScreenLock;
        let s = serde_json::to_string(&p).unwrap();
        assert_eq!(s, "\"on_screen_lock\"");
        let back: LockPolicy = serde_json::from_str(&s).unwrap();
        assert_eq!(back, p);
    }
}
