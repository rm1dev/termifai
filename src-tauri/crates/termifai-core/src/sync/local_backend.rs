use crate::sync::backend::{SyncBackend, SyncError};
use crate::sync::collections::CollectionKind;
use crate::sync::payload::Manifest;
use std::fs;
use std::path::PathBuf;

/// Syncs to a plain directory: `manifest.json` (plaintext) + either legacy
/// `vault.blob` or Phase-C `col-*.blob` collection files.
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

    fn collection_path(&self, name: &str) -> PathBuf {
        if let Some(kind) = CollectionKind::from_str(name) {
            self.dir.join(kind.file_name())
        } else {
            self.dir.join(format!("col-{name}.blob"))
        }
    }

    fn cas_check(&self, expected_blob_version: Option<u64>) -> Result<(), SyncError> {
        let current = self.fetch_manifest()?;
        match (expected_blob_version, current.as_ref()) {
            (None, None) => Ok(()),
            (None, Some(_)) => Err(SyncError::Conflict),
            (Some(expected), Some(current)) if current.blob_version != expected => {
                Err(SyncError::Conflict)
            }
            (Some(_), None) => Err(SyncError::Conflict),
            _ => Ok(()),
        }
    }

    fn write_manifest(&self, manifest: &Manifest) -> Result<(), SyncError> {
        let manifest_tmp = self.dir.join("manifest.json.tmp");
        fs::write(&manifest_tmp, serde_json::to_string_pretty(manifest)?)?;
        fs::rename(&manifest_tmp, self.manifest_path())?;
        Ok(())
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

    fn fetch_collection(&self, name: &str) -> Result<Vec<u8>, SyncError> {
        let path = self.collection_path(name);
        if !path.exists() {
            return Err(SyncError::NotFound);
        }
        Ok(fs::read(path)?)
    }

    fn store(
        &self,
        manifest: &Manifest,
        blob: &[u8],
        expected_blob_version: Option<u64>,
    ) -> Result<(), SyncError> {
        fs::create_dir_all(&self.dir)?;
        self.cas_check(expected_blob_version)?;

        let blob_tmp = self.dir.join("vault.blob.tmp");
        fs::write(&blob_tmp, blob)?;
        fs::rename(&blob_tmp, self.blob_path())?;
        self.write_manifest(manifest)?;
        Ok(())
    }

    fn store_delta(
        &self,
        manifest: &Manifest,
        changed: &[(String, Vec<u8>)],
        expected_blob_version: Option<u64>,
    ) -> Result<(), SyncError> {
        fs::create_dir_all(&self.dir)?;
        self.cas_check(expected_blob_version)?;

        for (name, bytes) in changed {
            let path = self.collection_path(name);
            let tmp = path.with_extension("blob.tmp");
            fs::write(&tmp, bytes)?;
            fs::rename(&tmp, &path)?;
        }

        // Manifest last — readers that see the new index find blobs already in place.
        self.write_manifest(manifest)?;

        // Legacy monolith رو پاک می‌کنیم تا نسخهٔ کهنه گمراه‌کننده نمونه
        let legacy = self.blob_path();
        if legacy.exists() {
            let _ = fs::remove_file(legacy);
        }
        Ok(())
    }

    fn wipe(&self) -> Result<(), SyncError> {
        if self.manifest_path().exists() {
            fs::remove_file(self.manifest_path())?;
        }
        if self.blob_path().exists() {
            fs::remove_file(self.blob_path())?;
        }
        if let Ok(entries) = fs::read_dir(&self.dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if name.starts_with("col-") && name.ends_with(".blob") {
                        let _ = fs::remove_file(path);
                    }
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "termifai-local-backend-test-{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
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
            content_hash: None,
            collections: Default::default(),
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
    fn store_delta_writes_collection_files() {
        let dir = tmp_dir("delta");
        let backend = LocalDirBackend::new(&dir);
        let mut manifest = sample_manifest(1);
        manifest.format_version = 2;
        backend
            .store_delta(
                &manifest,
                &[("hosts".into(), b"enc-hosts".to_vec())],
                None,
            )
            .unwrap();
        assert_eq!(backend.fetch_collection("hosts").unwrap(), b"enc-hosts");
        assert!(!backend.blob_path().exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn store_rejects_stale_expected_version() {
        let dir = tmp_dir("cas");
        let backend = LocalDirBackend::new(&dir);
        backend.store(&sample_manifest(1), b"v1", None).unwrap();
        backend.store(&sample_manifest(2), b"v2", Some(1)).unwrap();

        let result = backend.store(&sample_manifest(3), b"v3", Some(1));
        assert!(matches!(result, Err(SyncError::Conflict)));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn store_with_none_rejects_existing_remote() {
        let dir = tmp_dir("create-conflict");
        let backend = LocalDirBackend::new(&dir);
        backend.store(&sample_manifest(1), b"v1", None).unwrap();

        let result = backend.store(&sample_manifest(1), b"v1-again", None);
        assert!(matches!(result, Err(SyncError::Conflict)));
        fs::remove_dir_all(&dir).ok();
    }
}
