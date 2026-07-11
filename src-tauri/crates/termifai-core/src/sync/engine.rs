use crate::model::forwards::PortForwardRule;
use crate::model::hosts::{Host, HostGroup};
use crate::model::snippets::{Snippet, SnippetGroup};
use crate::model::ssh_keys::SshKey;
use crate::model::tombstones::{EntityKind, Tombstone};
use crate::sync::backend::{SyncBackend, SyncError};
use crate::sync::merge::{merge_entities, merge_settings, union_tombstones};
use crate::sync::payload::{
    b64_decode, b64_encode, decrypt_payload, default_kdf_params, derive_sync_key, encrypt_payload,
    random_sync_salt, sha256_hex, Manifest, SettingsPayload, SyncPayload, PAYLOAD_FORMAT_VERSION,
};

const MAX_CONFLICT_RETRIES: u32 = 3;

/// Everything this device knows locally, going into a sync cycle.
#[derive(Clone, Default)]
pub struct LocalSnapshot {
    pub hosts: Vec<Host>,
    pub groups: Vec<HostGroup>,
    pub snippets: Vec<Snippet>,
    pub snippet_groups: Vec<SnippetGroup>,
    pub port_forwards: Vec<PortForwardRule>,
    /// `None` when this device has SSH-key sync turned off.
    pub ssh_keys: Option<Vec<SshKey>>,
    pub settings: SettingsPayload,
    pub tombstones: Vec<Tombstone>,
    pub device_id: String,
    pub device_name: Option<String>,
}

/// The result of one sync cycle: what should be written back to local
/// storage, and the blob version now live on the remote.
pub struct SyncOutcome {
    pub hosts: Vec<Host>,
    pub groups: Vec<HostGroup>,
    pub snippets: Vec<Snippet>,
    pub snippet_groups: Vec<SnippetGroup>,
    pub port_forwards: Vec<PortForwardRule>,
    pub ssh_keys: Option<Vec<SshKey>>,
    pub settings: SettingsPayload,
    pub tombstones: Vec<Tombstone>,
    pub blob_version: u64,
}

/// Pure merge step, exposed for the foreign-vault-merge flow (1.7-B) which
/// needs to merge against a payload decrypted with a different password than
/// the one it will re-encrypt and re-upload with.
pub fn merge_snapshot(local: &LocalSnapshot, remote: Option<SyncPayload>) -> SyncOutcome {
    let remote = remote.unwrap_or_default();
    let remote_device_id = if remote.device_id.is_empty() {
        local.device_id.clone()
    } else {
        remote.device_id.clone()
    };

    let tombstones = union_tombstones(&local.tombstones, &remote.tombstones);

    let hosts = merge_entities(
        local.hosts.clone(),
        remote.hosts,
        &tombstones,
        EntityKind::Host,
        &local.device_id,
        &remote_device_id,
    );
    let groups = merge_entities(
        local.groups.clone(),
        remote.groups,
        &tombstones,
        EntityKind::Group,
        &local.device_id,
        &remote_device_id,
    );
    let snippets = merge_entities(
        local.snippets.clone(),
        remote.snippets,
        &tombstones,
        EntityKind::Snippet,
        &local.device_id,
        &remote_device_id,
    );
    let snippet_groups = merge_entities(
        local.snippet_groups.clone(),
        remote.snippet_groups,
        &tombstones,
        EntityKind::SnippetGroup,
        &local.device_id,
        &remote_device_id,
    );
    let port_forwards = merge_entities(
        local.port_forwards.clone(),
        remote.port_forwards,
        &tombstones,
        EntityKind::PortForward,
        &local.device_id,
        &remote_device_id,
    );
    let ssh_keys = match (&local.ssh_keys, remote.ssh_keys) {
        (Some(l), Some(r)) => Some(merge_entities(
            l.clone(),
            r,
            &tombstones,
            EntityKind::SshKey,
            &local.device_id,
            &remote_device_id,
        )),
        (Some(l), None) => Some(l.clone()),
        (None, _) => None,
    };

    let settings = merge_settings(&local.settings, &remote.settings);

    SyncOutcome {
        hosts,
        groups,
        snippets,
        snippet_groups,
        port_forwards,
        ssh_keys,
        settings,
        tombstones,
        blob_version: 0, // filled in by run_sync once the store succeeds
    }
}

fn now_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

/// Runs one full sync cycle against `backend`: fetch → decrypt → merge →
/// encrypt → store, retrying on a lost compare-and-swap race up to
/// `MAX_CONFLICT_RETRIES` times (merge is commutative/idempotent, so a retry
/// after a fresh fetch always converges).
pub fn run_sync(
    backend: &dyn SyncBackend,
    local: LocalSnapshot,
    master_password: &str,
    vault_id: &str,
) -> Result<SyncOutcome, SyncError> {
    let mut attempt = 0;
    loop {
        attempt += 1;
        let remote_manifest = backend.fetch_manifest()?;

        let sync_salt_b64 = match &remote_manifest {
            Some(m) => m.sync_salt.clone(),
            None => b64_encode(&random_sync_salt()),
        };
        let sync_salt = b64_decode(&sync_salt_b64)?;
        let key = derive_sync_key(master_password, &sync_salt)?;

        let remote_payload = match &remote_manifest {
            Some(_) => {
                let blob = backend.fetch_blob()?;
                let blob_str = String::from_utf8(blob)
                    .map_err(|_| SyncError::Backend("blob was not valid UTF-8".to_string()))?;
                Some(decrypt_payload(&key, &blob_str)?)
            }
            None => None,
        };

        let mut outcome = merge_snapshot(&local, remote_payload);

        let merged_payload = SyncPayload {
            format_version: PAYLOAD_FORMAT_VERSION,
            exported_at: now_iso(),
            device_id: local.device_id.clone(),
            hosts: outcome.hosts.clone(),
            groups: outcome.groups.clone(),
            snippets: outcome.snippets.clone(),
            snippet_groups: outcome.snippet_groups.clone(),
            port_forwards: outcome.port_forwards.clone(),
            ssh_keys: outcome.ssh_keys.clone(),
            settings: outcome.settings.clone(),
            tombstones: outcome.tombstones.clone(),
        };

        let blob_str = encrypt_payload(&key, &merged_payload)?;
        let blob_bytes = blob_str.into_bytes();
        let expected_version = remote_manifest.as_ref().map(|m| m.blob_version);
        let new_version = expected_version.unwrap_or(0) + 1;

        let manifest = Manifest {
            format_version: PAYLOAD_FORMAT_VERSION,
            vault_id: vault_id.to_string(),
            blob_version: new_version,
            updated_at: now_iso(),
            device_id: local.device_id.clone(),
            device_name: local.device_name.clone(),
            kdf: default_kdf_params(),
            sync_salt: sync_salt_b64,
            blob_sha256: sha256_hex(&blob_bytes),
        };

        match backend.store(&manifest, &blob_bytes, expected_version) {
            Ok(()) => {
                outcome.blob_version = new_version;
                return Ok(outcome);
            }
            Err(SyncError::Conflict) if attempt < MAX_CONFLICT_RETRIES => continue,
            Err(e) => return Err(e),
        }
    }
}

/// Used by the restore/link flows (1.7): decrypt whatever's on the remote
/// using a caller-supplied master password, without merging against any
/// local state. Callers still need to derive their own local DEK afterwards
/// to re-encrypt secrets — this function only deals with the sync layer.
pub fn fetch_remote_payload(
    backend: &dyn SyncBackend,
    master_password: &str,
) -> Result<(Manifest, SyncPayload), SyncError> {
    let manifest = backend.fetch_manifest()?.ok_or(SyncError::NotFound)?;
    let sync_salt = b64_decode(&manifest.sync_salt)?;
    let key = derive_sync_key(master_password, &sync_salt)?;
    let blob = backend.fetch_blob()?;
    let blob_str =
        String::from_utf8(blob).map_err(|_| SyncError::Backend("blob was not valid UTF-8".to_string()))?;
    let payload = decrypt_payload(&key, &blob_str)?;
    Ok((manifest, payload))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::hosts::OsKind;
    use crate::sync::local_backend::LocalDirBackend;

    fn tmp_dir(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "termifai-engine-test-{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn host(id: &str, name: &str, updated_at: &str) -> Host {
        Host {
            id: id.to_string(),
            name: name.to_string(),
            user: "root".to_string(),
            hostname: "example.com".to_string(),
            port: 22,
            os: OsKind::Ubuntu,
            tags: vec![],
            last_used: None,
            group_id: None,
            auth_method: None,
            password: Some("s3cret".to_string()),
            ssh_key_id: None,
            show_status_in_dashboard: None,
            working_directory: None,
            default_sftp_path: None,
            updated_at: Some(updated_at.to_string()),
            sync_server: None,
        }
    }

    fn snapshot(device_id: &str, hosts: Vec<Host>) -> LocalSnapshot {
        LocalSnapshot {
            hosts,
            device_id: device_id.to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn first_sync_from_empty_remote_uploads_local_state() {
        let dir = tmp_dir("first-sync");
        let backend = LocalDirBackend::new(&dir);
        let local = snapshot("dev-a", vec![host("h1", "prod", "2026-01-01T00:00:00Z")]);

        let outcome = run_sync(&backend, local, "hunter2", "default").unwrap();
        assert_eq!(outcome.blob_version, 1);
        assert_eq!(outcome.hosts.len(), 1);
        assert_eq!(outcome.hosts[0].id, "h1");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn two_devices_converge_through_one_local_dir_backend() {
        let dir = tmp_dir("two-device");
        let backend = LocalDirBackend::new(&dir);

        // Device A creates a host and syncs first.
        let device_a = snapshot("dev-a", vec![host("h1", "prod", "2026-01-01T00:00:00Z")]);
        run_sync(&backend, device_a, "hunter2", "default").unwrap();

        // Device B, starting empty, syncs against the same folder and should
        // adopt device A's host.
        let device_b = snapshot("dev-b", vec![]);
        let outcome_b = run_sync(&backend, device_b, "hunter2", "default").unwrap();
        assert_eq!(outcome_b.hosts.len(), 1);
        assert_eq!(outcome_b.hosts[0].id, "h1");
        assert_eq!(outcome_b.blob_version, 2);

        // Device B adds a second host and syncs again.
        let mut device_b_hosts = outcome_b.hosts.clone();
        device_b_hosts.push(host("h2", "staging", "2026-01-02T00:00:00Z"));
        let device_b_again = LocalSnapshot {
            hosts: device_b_hosts,
            device_id: "dev-b".to_string(),
            ..Default::default()
        };
        run_sync(&backend, device_b_again, "hunter2", "default").unwrap();

        // Device A syncs again and should now see both hosts.
        let device_a_again = snapshot("dev-a", vec![host("h1", "prod", "2026-01-01T00:00:00Z")]);
        let outcome_a = run_sync(&backend, device_a_again, "hunter2", "default").unwrap();
        let mut ids: Vec<&str> = outcome_a.hosts.iter().map(|h| h.id.as_str()).collect();
        ids.sort();
        assert_eq!(ids, vec!["h1", "h2"]);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn wrong_master_password_fails_to_decrypt_existing_remote() {
        let dir = tmp_dir("wrong-pw");
        let backend = LocalDirBackend::new(&dir);
        let device_a = snapshot("dev-a", vec![host("h1", "prod", "2026-01-01T00:00:00Z")]);
        run_sync(&backend, device_a, "correct-horse", "default").unwrap();

        let device_b = snapshot("dev-b", vec![]);
        let result = run_sync(&backend, device_b, "wrong-password", "default");
        assert!(matches!(result, Err(SyncError::Crypto(_))));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn deleted_host_stays_deleted_after_remote_sync() {
        let dir = tmp_dir("delete-propagates");
        let backend = LocalDirBackend::new(&dir);

        let device_a = snapshot("dev-a", vec![host("h1", "prod", "2026-01-01T00:00:00Z")]);
        run_sync(&backend, device_a, "hunter2", "default").unwrap();

        // Device B pulls it down, then deletes it locally (tombstone, no more host).
        let device_b = snapshot("dev-b", vec![]);
        let outcome_b = run_sync(&backend, device_b, "hunter2", "default").unwrap();
        assert_eq!(outcome_b.hosts.len(), 1);

        let device_b_deleted = LocalSnapshot {
            hosts: vec![],
            tombstones: vec![Tombstone {
                entity: EntityKind::Host,
                id: "h1".to_string(),
                deleted_at: "2026-06-01T00:00:00Z".to_string(),
            }],
            device_id: "dev-b".to_string(),
            ..Default::default()
        };
        run_sync(&backend, device_b_deleted, "hunter2", "default").unwrap();

        // Device A syncs again with its stale copy of h1 (older updated_at than the delete).
        let device_a_again = snapshot("dev-a", vec![host("h1", "prod", "2026-01-01T00:00:00Z")]);
        let outcome_a = run_sync(&backend, device_a_again, "hunter2", "default").unwrap();
        assert!(outcome_a.hosts.is_empty(), "delete must win over an older, unedited copy");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn fetch_remote_payload_reads_without_merging() {
        let dir = tmp_dir("restore-flow");
        let backend = LocalDirBackend::new(&dir);
        let device_a = snapshot("dev-a", vec![host("h1", "prod", "2026-01-01T00:00:00Z")]);
        run_sync(&backend, device_a, "hunter2", "default").unwrap();

        let (manifest, payload) = fetch_remote_payload(&backend, "hunter2").unwrap();
        assert_eq!(manifest.blob_version, 1);
        assert_eq!(payload.hosts.len(), 1);
        assert_eq!(payload.hosts[0].password.as_deref(), Some("s3cret"));

        std::fs::remove_dir_all(&dir).ok();
    }
}
