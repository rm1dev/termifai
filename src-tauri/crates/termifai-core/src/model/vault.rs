use serde::{Deserialize, Serialize};

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

fn default_version() -> u32 {
    1
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CryptoMeta {
    pub kdf: String,
    pub salt: String,
    pub wrapped_key: String,
    pub verifier: String,
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CryptoVault {
    #[serde(default = "default_version")]
    pub version: u32,
    pub crypto: Option<CryptoMeta>,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VaultSettings {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub lock_policy: LockPolicy,
}

pub fn migrate_vault_settings(value: &mut serde_json::Value) {
    if value.get("version").is_none() {
        if let Some(obj) = value.as_object_mut() {
            obj.insert("version".to_string(), serde_json::Value::from(1u32));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crypto_meta_round_trips_through_json() {
        let meta = CryptoMeta {
            kdf: "argon2id".to_string(),
            salt: "c2FsdA".to_string(),
            wrapped_key: "v1:n:c".to_string(),
            verifier: "v1:n:c".to_string(),
        };
        let json = serde_json::to_string(&meta).unwrap();
        assert!(json.contains("\"wrappedKey\""));
        let back: CryptoMeta = serde_json::from_str(&json).unwrap();
        assert_eq!(back.kdf, "argon2id");
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
