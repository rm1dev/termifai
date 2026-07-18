//! Collection-level delta sync (Phase C).
//!
//! Instead of re-uploading one monolithic `vault.blob` on every change, each
//! logical slice (hosts, snippets, settings, …) is encrypted and stored as its
//! own `col-<name>.blob`. The plaintext manifest carries a per-collection
//! content hash so peers only download / upload the slices that actually
//! changed.

use crate::crypto::VaultKey;
use crate::model::forwards::PortForwardRule;
use crate::model::hosts::{Host, HostGroup};
use crate::model::snippets::{Snippet, SnippetGroup};
use crate::model::ssh_keys::SshKey;
use crate::model::tombstones::Tombstone;
use crate::sync::backend::SyncError;
use crate::sync::payload::{
    decrypt_payload, encrypt_payload, sha256_hex, SyncPayload,
    PAYLOAD_FORMAT_VERSION,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Manifest format that includes a collection index. Older remotes use `1`
/// with a single `vault.blob`.
pub const MANIFEST_FORMAT_V2: u32 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum CollectionKind {
    Hosts,
    Groups,
    Snippets,
    SnippetGroups,
    PortForwards,
    SshKeys,
    Settings,
    Tombstones,
}

impl CollectionKind {
    pub const ALL: [CollectionKind; 8] = [
        CollectionKind::Hosts,
        CollectionKind::Groups,
        CollectionKind::Snippets,
        CollectionKind::SnippetGroups,
        CollectionKind::PortForwards,
        CollectionKind::SshKeys,
        CollectionKind::Settings,
        CollectionKind::Tombstones,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            CollectionKind::Hosts => "hosts",
            CollectionKind::Groups => "groups",
            CollectionKind::Snippets => "snippets",
            CollectionKind::SnippetGroups => "snippetGroups",
            CollectionKind::PortForwards => "portForwards",
            CollectionKind::SshKeys => "sshKeys",
            CollectionKind::Settings => "settings",
            CollectionKind::Tombstones => "tombstones",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "hosts" => Some(Self::Hosts),
            "groups" => Some(Self::Groups),
            "snippets" => Some(Self::Snippets),
            "snippetGroups" => Some(Self::SnippetGroups),
            "portForwards" => Some(Self::PortForwards),
            "sshKeys" => Some(Self::SshKeys),
            "settings" => Some(Self::Settings),
            "tombstones" => Some(Self::Tombstones),
            _ => None,
        }
    }

    pub fn file_name(self) -> String {
        format!("col-{}.blob", self.as_str())
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CollectionMeta {
    /// Logical (plaintext) content hash for this slice.
    pub content_hash: String,
    /// SHA-256 of the encrypted bytes on the wire.
    pub blob_sha256: String,
}

pub type CollectionIndex = BTreeMap<String, CollectionMeta>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalHosts<'a> {
    hosts: &'a [Host],
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalGroups<'a> {
    groups: &'a [HostGroup],
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalSnippets<'a> {
    snippets: &'a [Snippet],
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalSnippetGroups<'a> {
    snippet_groups: &'a [SnippetGroup],
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalPortForwards<'a> {
    port_forwards: &'a [PortForwardRule],
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalSshKeys<'a> {
    ssh_keys: &'a [SshKey],
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalTombstones<'a> {
    tombstones: &'a [Tombstone],
}

/// Plaintext JSON for one collection (before AEAD).
pub fn collection_plaintext(kind: CollectionKind, payload: &SyncPayload) -> Result<Vec<u8>, SyncError> {
    let value = match kind {
        CollectionKind::Hosts => serde_json::to_vec(&CanonicalHosts {
            hosts: &payload.hosts,
        }),
        CollectionKind::Groups => serde_json::to_vec(&CanonicalGroups {
            groups: &payload.groups,
        }),
        CollectionKind::Snippets => serde_json::to_vec(&CanonicalSnippets {
            snippets: &payload.snippets,
        }),
        CollectionKind::SnippetGroups => serde_json::to_vec(&CanonicalSnippetGroups {
            snippet_groups: &payload.snippet_groups,
        }),
        CollectionKind::PortForwards => serde_json::to_vec(&CanonicalPortForwards {
            port_forwards: &payload.port_forwards,
        }),
        CollectionKind::SshKeys => {
            let keys = payload.ssh_keys.as_deref().unwrap_or(&[]);
            serde_json::to_vec(&CanonicalSshKeys { ssh_keys: keys })
        }
        CollectionKind::Settings => serde_json::to_vec(&payload.settings),
        CollectionKind::Tombstones => serde_json::to_vec(&CanonicalTombstones {
            tombstones: &payload.tombstones,
        }),
    }?;
    Ok(value)
}

pub fn collection_content_hash(kind: CollectionKind, payload: &SyncPayload) -> Result<String, SyncError> {
    Ok(sha256_hex(&collection_plaintext(kind, payload)?))
}

pub fn build_collection_hashes(payload: &SyncPayload) -> Result<BTreeMap<CollectionKind, String>, SyncError> {
    let mut map = BTreeMap::new();
    for kind in CollectionKind::ALL {
        if kind == CollectionKind::SshKeys && payload.ssh_keys.is_none() {
            continue;
        }
        map.insert(kind, collection_content_hash(kind, payload)?);
    }
    Ok(map)
}

/// Encrypt one collection as a tiny SyncPayload-shaped envelope so we reuse
/// the existing AEAD helpers (ciphertext still starts with `v1:`).
pub fn encrypt_collection(
    key: &VaultKey,
    kind: CollectionKind,
    payload: &SyncPayload,
) -> Result<Vec<u8>, SyncError> {
    let mut mini = SyncPayload {
        format_version: PAYLOAD_FORMAT_VERSION,
        ..Default::default()
    };
    apply_collection_to_payload(kind, payload, &mut mini);
    let blob = encrypt_payload(key, &mini)?;
    Ok(blob.into_bytes())
}

pub fn decrypt_collection(
    key: &VaultKey,
    _kind: CollectionKind,
    bytes: &[u8],
) -> Result<SyncPayload, SyncError> {
    let blob_str = String::from_utf8(bytes.to_vec())
        .map_err(|_| SyncError::Backend("collection blob was not valid UTF-8".to_string()))?;
    // encrypt_collection فقط یک اسلایس رو تو payload می‌ذاره؛ decrypt همون رو برمی‌گردونه
    Ok(decrypt_payload(key, &blob_str)?)
}

fn apply_collection_to_payload(kind: CollectionKind, from: &SyncPayload, to: &mut SyncPayload) {
    match kind {
        CollectionKind::Hosts => to.hosts = from.hosts.clone(),
        CollectionKind::Groups => to.groups = from.groups.clone(),
        CollectionKind::Snippets => to.snippets = from.snippets.clone(),
        CollectionKind::SnippetGroups => to.snippet_groups = from.snippet_groups.clone(),
        CollectionKind::PortForwards => to.port_forwards = from.port_forwards.clone(),
        CollectionKind::SshKeys => to.ssh_keys = from.ssh_keys.clone(),
        CollectionKind::Settings => to.settings = from.settings.clone(),
        CollectionKind::Tombstones => to.tombstones = from.tombstones.clone(),
    }
}

pub fn merge_collection_into(target: &mut SyncPayload, kind: CollectionKind, piece: SyncPayload) {
    apply_collection_to_payload(kind, &piece, target);
}

/// Fold decrypted collection pieces into one payload (missing pieces stay empty).
pub fn assemble_payload(
    pieces: BTreeMap<CollectionKind, SyncPayload>,
    device_id: String,
) -> SyncPayload {
    let mut payload = SyncPayload {
        format_version: PAYLOAD_FORMAT_VERSION,
        device_id,
        ..Default::default()
    };
    for (kind, piece) in pieces {
        merge_collection_into(&mut payload, kind, piece);
    }
    payload
}

pub fn index_integrity_hash(index: &CollectionIndex) -> String {
    let mut parts: Vec<String> = index
        .iter()
        .map(|(k, v)| format!("{}:{}", k, v.content_hash))
        .collect();
    parts.sort();
    sha256_hex(parts.join("|").as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::payload::{derive_sync_key, random_sync_salt};

    #[test]
    fn collection_hash_stable_for_same_hosts() {
        let mut a = SyncPayload::default();
        a.hosts = vec![];
        let mut b = a.clone();
        b.exported_at = "x".into();
        assert_eq!(
            collection_content_hash(CollectionKind::Hosts, &a).unwrap(),
            collection_content_hash(CollectionKind::Hosts, &b).unwrap()
        );
    }

    #[test]
    fn encrypt_decrypt_hosts_roundtrip() {
        let salt = random_sync_salt();
        let key = derive_sync_key("pw", &salt).unwrap();
        let mut payload = SyncPayload::default();
        payload.hosts = vec![];
        let bytes = encrypt_collection(&key, CollectionKind::Hosts, &payload).unwrap();
        let back = decrypt_collection(&key, CollectionKind::Hosts, &bytes).unwrap();
        assert!(back.hosts.is_empty());
    }
}
