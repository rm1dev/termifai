use crate::crypto::{self, VaultKey};
use crate::hosts::{self, CryptoMeta};
use serde::Serialize;
use std::sync::{Mutex, MutexGuard, OnceLock};
use tauri::AppHandle;

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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub initialized: bool,
    pub unlocked: bool,
}

pub fn op_status(app: &AppHandle) -> Result<VaultStatus, String> {
    let initialized = hosts::read_crypto_meta(app)?.is_some();
    Ok(VaultStatus {
        initialized,
        unlocked: is_unlocked(),
    })
}

/// Initialize a brand-new vault. Fails if one already exists.
pub fn op_init(app: &AppHandle, master_password: &str) -> Result<(), String> {
    if master_password.is_empty() {
        return Err("Master password cannot be empty".to_string());
    }
    if hosts::read_crypto_meta(app)?.is_some() {
        return Err("Vault is already initialized".to_string());
    }
    let v = crypto::create_vault(master_password).map_err(|_| "Failed to create vault".to_string())?;
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
    let _ = cache_master_password(master_password);
    hosts::migrate_plaintext_passwords(app)?;
    Ok(())
}

/// Unlock with an explicit master password. Caches it on success.
pub fn op_unlock(app: &AppHandle, master_password: &str) -> Result<(), String> {
    let meta = hosts::read_crypto_meta(app)?.ok_or("Vault is not initialized")?;
    let key = crypto::unlock_vault(master_password, &meta.salt, &meta.wrapped_key, &meta.verifier)
        .map_err(|e| match e {
            crypto::CryptoError::WrongPassword => "Incorrect master password".to_string(),
            _ => "Failed to unlock vault".to_string(),
        })?;
    set_unlocked(key);
    let _ = cache_master_password(master_password);
    hosts::migrate_plaintext_passwords(app)?;
    Ok(())
}

/// Attempt a silent unlock using the keychain-cached master password.
/// Returns Ok(true) if unlocked, Ok(false) if no usable cache.
pub fn op_try_cached_unlock(app: &AppHandle) -> Result<bool, String> {
    if hosts::read_crypto_meta(app)?.is_none() {
        return Ok(false);
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

pub fn op_lock() {
    forget_master_password();
    clear();
}

pub fn op_change_master_password(app: &AppHandle, old: &str, new: &str) -> Result<(), String> {
    if new.is_empty() {
        return Err("New master password cannot be empty".to_string());
    }
    let meta = hosts::read_crypto_meta(app)?.ok_or("Vault is not initialized")?;
    let v = crypto::rewrap(old, &meta.salt, &meta.wrapped_key, &meta.verifier, new).map_err(|e| {
        match e {
            crypto::CryptoError::WrongPassword => "Current master password is incorrect".to_string(),
            _ => "Failed to change master password".to_string(),
        }
    })?;
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
    let _ = cache_master_password(new);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vault_status_serializes_camel_case() {
        let s = VaultStatus { initialized: true, unlocked: false };
        let json = serde_json::to_string(&s).unwrap();
        assert_eq!(json, "{\"initialized\":true,\"unlocked\":false}");
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
}
