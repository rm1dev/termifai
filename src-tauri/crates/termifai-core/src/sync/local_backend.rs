use crate::sync::backend::{SyncBackend, SyncError};
use crate::sync::payload::Manifest;
use std::fs;
use std::path::PathBuf;

/// Syncs to a plain directory: `manifest.json` (plaintext) + `vault.blob`
/// (ciphertext). Doubles as the phase-1 test harness (two "devices" pointed
/// at the same folder) and as a real option for anyone who points it at a
/// folder already synced by another tool (Dropbox/Drive desktop client, a
/// NAS mount, etc).
pub struct LocalDirBackend {
    dir: PathBuf,
}

impl LocalDirBackend {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    fn manifest_path(&self) -> PathBuf {
        self.dir.join("manifest.json")
    }

    fn blob_path(&self) -> PathBuf {
        self.dir.join("vault.blob")
    }
}

impl SyncBackend for LocalDirBackend {
    fn fetch_manifest(&self) -> Result<Option<Manifest>, SyncError> {
        let path = self.manifest_path();
        if !path.exists() {
            return Ok(None);
        }
        let contents = fs::read_to_string(&path)?;
        let manifest: Manifest = serde_json::from_str(&contents)?;
        Ok(Some(manifest))
    }

    fn fetch_blob(&self) -> Result<Vec<u8>, SyncError> {
        Ok(fs::read(self.blob_path())?)
    }

    fn store(
        &self,
        manifest: &Manifest,
        blob: &[u8],
        expected_blob_version: Option<u64>,
    ) -> Result<(), SyncError> {
        fs::create_dir_all(&self.dir)?;

        // Compare-and-swap: re-read the manifest right before writing so a
        // concurrent writer's blobVersion bump isn't silently overwritten.
        let current = self.fetch_manifest()?;
        match (expected_blob_version, current.as_ref()) {
            (None, None) => {}
            (None, Some(_)) => return Err(SyncError::Conflict),
            (Some(expected), Some(current)) if current.blob_version != expected => {
                return Err(SyncError::Conflict)
            }
            (Some(_), None) => return Err(SyncError::Conflict),
            _ => {}
        }

        let manifest_tmp = self.dir.join("manifest.json.tmp");
        let blob_tmp = self.dir.join("vault.blob.tmp");

        fs::write(&blob_tmp, blob)?;
        fs::write(&manifest_tmp, serde_json::to_string_pretty(manifest)?)?;

        // Blob first, then manifest — a reader that sees the new manifest
        // must find the matching blob already in place.
        fs::rename(&blob_tmp, self.blob_path())?;
        fs::rename(&manifest_tmp, self.manifest_path())?;
        Ok(())
    }

    fn wipe(&self) -> Result<(), SyncError> {
        let manifest = self.manifest_path();
        let blob = self.blob_path();
        if manifest.exists() {
            fs::remove_file(manifest)?;
        }
        if blob.exists() {
            fs::remove_file(blob)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "termifai-local-backend-test-{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        dir
    }

    fn sample_manifest(blob_version: u64) -> Manifest {
        Manifest {
            format_version: 1,
            vault_id: "default".into(),
            blob_version,
            updated_at: "2026-07-07T00:00:00Z".into(),
            device_id: "dev-1".into(),
            device_name: None,
            kdf: crate::sync::payload::default_kdf_params(),
            sync_salt: "c2FsdA".into(),
            blob_sha256: "abc".into(),
        }
    }

    #[test]
    fn fetch_manifest_is_none_before_first_store() {
        let dir = tmp_dir("empty");
        let backend = LocalDirBackend::new(&dir);
        assert!(backend.fetch_manifest().unwrap().is_none());
    }

    #[test]
    fn store_then_fetch_roundtrips() {
        let dir = tmp_dir("roundtrip");
        let backend = LocalDirBackend::new(&dir);
        backend.store(&sample_manifest(1), b"hello", None).unwrap();

        let manifest = backend.fetch_manifest().unwrap().unwrap();
        assert_eq!(manifest.blob_version, 1);
        assert_eq!(backend.fetch_blob().unwrap(), b"hello");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn store_rejects_stale_expected_version() {
        let dir = tmp_dir("cas");
        let backend = LocalDirBackend::new(&dir);
        backend.store(&sample_manifest(1), b"v1", None).unwrap();
        backend.store(&sample_manifest(2), b"v2", Some(1)).unwrap();

        // Someone still thinks the remote is at version 1 — must conflict.
        let result = backend.store(&sample_manifest(3), b"v3", Some(1));
        assert!(matches!(result, Err(SyncError::Conflict)));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn store_with_none_rejects_existing_remote() {
        let dir = tmp_dir("create-conflict");
        let backend = LocalDirBackend::new(&dir);
        backend.store(&sample_manifest(1), b"v1", None).unwrap();

        // A second "first sync" against an already-populated remote must conflict.
        let result = backend.store(&sample_manifest(1), b"v1-again", None);
        assert!(matches!(result, Err(SyncError::Conflict)));
        fs::remove_dir_all(&dir).ok();
    }
}
