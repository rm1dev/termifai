use crate::crypto::CryptoError;
use crate::sync::payload::Manifest;

#[derive(Debug)]
pub enum SyncError {
    /// Remote has no data yet (first sync).
    NotFound,
    /// `store()` lost a compare-and-swap race — caller should refetch, remerge, retry.
    Conflict,
    Io(String),
    Crypto(String),
    Serde(String),
    Backend(String),
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SyncError::NotFound => write!(f, "no synced data found"),
            SyncError::Conflict => write!(f, "sync conflict — remote changed concurrently"),
            SyncError::Io(e) => write!(f, "sync I/O error: {e}"),
            SyncError::Crypto(e) => write!(f, "sync decryption failed: {e}"),
            SyncError::Serde(e) => write!(f, "sync data was malformed: {e}"),
            SyncError::Backend(e) => write!(f, "sync backend error: {e}"),
        }
    }
}

impl std::error::Error for SyncError {}

impl From<CryptoError> for SyncError {
    fn from(e: CryptoError) -> Self {
        SyncError::Crypto(format!("{:?}", e))
    }
}

impl From<serde_json::Error> for SyncError {
    fn from(e: serde_json::Error) -> Self {
        SyncError::Serde(e.to_string())
    }
}

impl From<std::io::Error> for SyncError {
    fn from(e: std::io::Error) -> Self {
        SyncError::Io(e.to_string())
    }
}

impl From<reqwest::Error> for SyncError {
    fn from(e: reqwest::Error) -> Self {
        SyncError::Backend(e.to_string())
    }
}

impl From<SyncError> for String {
    fn from(e: SyncError) -> String {
        e.to_string()
    }
}

pub trait TokenStore: Send + Sync {
    fn load(&self, account: &str) -> Result<Option<String>, String>;
    fn save(&self, account: &str, value: &str) -> Result<(), String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

/// A storage target for the encrypted sync blob: a local directory (this
/// phase), or — in later phases — Google Drive, Dropbox, or a user's own SFTP
/// host. Every method is synchronous and blocking by design: the real
/// backends (SFTP over `ssh2`, HTTP over `reqwest::blocking`) are all
/// naturally blocking, so callers run this behind `spawn_blocking` rather
/// than forcing an async runtime into `termifai-core`.
pub trait SyncBackend: Send {
    /// `Ok(None)` means no sync has ever happened against this target.
    fn fetch_manifest(&self) -> Result<Option<Manifest>, SyncError>;
    /// Must only be called after `fetch_manifest` returned `Some`.
    /// Legacy monolith blob (`vault.blob`). Prefer `fetch_collection` when the
    /// manifest carries a collection index.
    fn fetch_blob(&self) -> Result<Vec<u8>, SyncError>;
    /// Fetch one Phase-C collection file (`col-<name>.blob`).
    fn fetch_collection(&self, name: &str) -> Result<Vec<u8>, SyncError>;
    /// `expected_blob_version = None` creates fresh; `Some(v)` is a
    /// compare-and-swap against the remote's current `blobVersion` where the
    /// backend supports it. A mismatch must return `Err(SyncError::Conflict)`.
    fn store(
        &self,
        manifest: &Manifest,
        blob: &[u8],
        expected_blob_version: Option<u64>,
    ) -> Result<(), SyncError>;
    /// CAS + write only the changed collection blobs, then the manifest.
    /// `changed` entries are `(collection_name, encrypted_bytes)`.
    fn store_delta(
        &self,
        manifest: &Manifest,
        changed: &[(String, Vec<u8>)],
        expected_blob_version: Option<u64>,
    ) -> Result<(), SyncError>;
    /// Deletes all remote sync data (manifest + blob + collections) from the backend.
    fn wipe(&self) -> Result<(), SyncError>;
}
