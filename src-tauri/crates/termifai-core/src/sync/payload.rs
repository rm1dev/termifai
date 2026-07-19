use crate::crypto::{self, CryptoError, VaultKey};
use crate::model::forwards::PortForwardRule;
use crate::model::hosts::{Host, HostGroup};
use crate::model::snippets::{Snippet, SnippetGroup};
use crate::model::ssh_keys::SshKey;
use crate::model::tombstones::Tombstone;
use base64::engine::general_purpose::STANDARD_NO_PAD as B64;
use base64::Engine;
use crate::sync::collections::CollectionIndex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const PAYLOAD_FORMAT_VERSION: u32 = 1;

/// One synced settings document (theme / terminal appearance / shortcuts).
/// The frontend owns the actual shape — `value` is passed through untouched.
#[derive(Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SettingsBlob {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPayload {
    #[serde(default)]
    pub app_theme: SettingsBlob,
    #[serde(default)]
    pub terminal_appearance: SettingsBlob,
    #[serde(default)]
    pub shortcuts: SettingsBlob,
}

/// The decrypted contents of `vault.blob`. `ssh_keys: None` means this
/// snapshot's device has SSH-key sync turned off — it neither exposes nor
/// overwrites keys on the remote side.
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncPayload {
    #[serde(default = "default_format_version")]
    pub format_version: u32,
    #[serde(default)]
    pub exported_at: String,
    #[serde(default)]
    pub device_id: String,
    #[serde(default)]
    pub hosts: Vec<Host>,
    #[serde(default)]
    pub groups: Vec<HostGroup>,
    #[serde(default)]
    pub snippets: Vec<Snippet>,
    #[serde(default)]
    pub snippet_groups: Vec<SnippetGroup>,
    #[serde(default)]
    pub port_forwards: Vec<PortForwardRule>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh_keys: Option<Vec<SshKey>>,
    #[serde(default)]
    pub settings: SettingsPayload,
    #[serde(default)]
    pub tombstones: Vec<Tombstone>,
}

fn default_format_version() -> u32 {
    PAYLOAD_FORMAT_VERSION
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KdfParams {
    pub algo: String,
    pub mem_kib: u32,
    pub iters: u32,
    pub parallelism: u32,
}

pub fn default_kdf_params() -> KdfParams {
    KdfParams {
        algo: "argon2id".to_string(),
        mem_kib: crypto::ARGON2_MEM_KIB,
        iters: crypto::ARGON2_ITERS,
        parallelism: crypto::ARGON2_PARALLELISM,
    }
}

/// Plaintext manifest stored alongside `vault.blob`. Contains no secrets, but
/// everything needed to begin decryption (given the master password).
#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub format_version: u32,
    pub vault_id: String,
    pub blob_version: u64,
    pub updated_at: String,
    pub device_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
    pub kdf: KdfParams,
    /// base64 (no-pad) — dedicated salt for the SyncKey, independent from the
    /// local vault's salt so every device can keep its own local DEK.
    pub sync_salt: String,
    /// hex-encoded SHA-256 of the (encrypted) blob bytes.
    pub blob_sha256: String,
    /// SHA-256 of the *logical* payload (entities/settings/tombstones), ignoring
    /// ephemeral fields like `exportedAt` / `deviceId`. Lets a no-op sync skip
    /// re-encrypt + upload even though AEAD nonces would differ.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
    /// Per-collection content hashes (Phase C). When non-empty, peers sync via
    /// `col-*.blob` files instead of a monolithic `vault.blob`.
    #[serde(default, skip_serializing_if = "CollectionIndex::is_empty")]
    pub collections: CollectionIndex,
}

/// Derive the SyncKey from the master password and the manifest's `syncSalt`.
/// Same Argon2id derivation as the local vault's KEK, just a different salt —
/// deliberately independent so a local master-password change doesn't require
/// re-deriving anything else.
pub fn derive_sync_key(master_password: &str, sync_salt: &[u8]) -> Result<VaultKey, CryptoError> {
    crypto::derive_kek(master_password, sync_salt)
}

pub fn random_sync_salt() -> Vec<u8> {
    use rand::RngCore;
    let mut salt = vec![0u8; 32];
    rand::thread_rng().fill_bytes(&mut salt);
    salt
}

pub fn b64_encode(bytes: &[u8]) -> String {
    B64.encode(bytes)
}

pub fn b64_decode(s: &str) -> Result<Vec<u8>, CryptoError> {
    B64.decode(s).map_err(|_| CryptoError::BadToken)
}

pub fn encrypt_payload(key: &VaultKey, payload: &SyncPayload) -> Result<String, CryptoError> {
    let json = serde_json::to_string(payload).map_err(|_| CryptoError::BadToken)?;
    crypto::encrypt_field(key, &json)
}

pub fn decrypt_payload(key: &VaultKey, blob: &str) -> Result<SyncPayload, CryptoError> {
    let json = crypto::decrypt_field(key, blob)?;
    serde_json::from_str(&json).map_err(|_| CryptoError::BadToken)
}

pub fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    let digest = hasher.finalize();
    digest.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Logical content used for change-detection. Excludes `exported_at` / `device_id`
/// so a re-export of the same vault doesn't look like a new revision.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalSyncContent<'a> {
    format_version: u32,
    hosts: &'a [Host],
    groups: &'a [HostGroup],
    snippets: &'a [Snippet],
    snippet_groups: &'a [SnippetGroup],
    port_forwards: &'a [PortForwardRule],
    #[serde(skip_serializing_if = "Option::is_none")]
    ssh_keys: Option<&'a [SshKey]>,
    settings: &'a SettingsPayload,
    tombstones: &'a [Tombstone],
}

/// Stable SHA-256 over the syncable data. Same logical vault ⇒ same hash,
/// regardless of who exports it or when.
pub fn payload_content_hash(payload: &SyncPayload) -> String {
    let canonical = CanonicalSyncContent {
        format_version: payload.format_version,
        hosts: &payload.hosts,
        groups: &payload.groups,
        snippets: &payload.snippets,
        snippet_groups: &payload.snippet_groups,
        port_forwards: &payload.port_forwards,
        ssh_keys: payload.ssh_keys.as_deref(),
        settings: &payload.settings,
        tombstones: &payload.tombstones,
    };
    // serde_json preserves field order from the struct definition; entity
    // vectors are already sorted by id in merge_entities / gather paths that
    // matter for equality after a sync cycle.
    let bytes = serde_json::to_vec(&canonical).unwrap_or_default();
    sha256_hex(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypt_then_decrypt_payload_roundtrips() {
        let salt = random_sync_salt();
        let key = derive_sync_key("hunter2", &salt).unwrap();
        let payload = SyncPayload {
            device_id: "dev-1".into(),
            exported_at: "2026-07-07T00:00:00Z".into(),
            ..Default::default()
        };
        let blob = encrypt_payload(&key, &payload).unwrap();
        assert!(blob.starts_with("v1:"));
        let back = decrypt_payload(&key, &blob).unwrap();
        assert_eq!(back.device_id, "dev-1");
    }

    #[test]
    fn decrypt_with_wrong_password_fails() {
        let salt = random_sync_salt();
        let key = derive_sync_key("hunter2", &salt).unwrap();
        let payload = SyncPayload::default();
        let blob = encrypt_payload(&key, &payload).unwrap();

        let wrong_key = derive_sync_key("wrong", &salt).unwrap();
        assert!(decrypt_payload(&wrong_key, &blob).is_err());
    }

    #[test]
    fn sha256_hex_is_stable() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn content_hash_ignores_exported_at_and_device_id() {
        let a = SyncPayload {
            exported_at: "2026-01-01T00:00:00Z".into(),
            device_id: "dev-a".into(),
            ..Default::default()
        };
        let b = SyncPayload {
            exported_at: "2026-07-01T00:00:00Z".into(),
            device_id: "dev-b".into(),
            ..Default::default()
        };
        assert_eq!(payload_content_hash(&a), payload_content_hash(&b));
    }
}
