use crate::crypto::VaultKey;
use std::sync::{Mutex, MutexGuard, OnceLock};

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

#[cfg(test)]
mod tests {
    use super::*;

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
