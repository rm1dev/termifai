pub mod backend;
pub mod engine;
pub mod local_backend;
pub mod merge;
pub mod payload;
pub mod oauth;
pub mod gdrive_backend;
pub mod dropbox_backend;

pub use backend::{SyncBackend, SyncError, TokenStore};
pub use engine::{fetch_remote_payload, merge_snapshot, run_sync, LocalSnapshot, SyncOutcome};
pub use local_backend::LocalDirBackend;
pub use gdrive_backend::GoogleDriveBackend;
pub use dropbox_backend::DropboxBackend;
pub use payload::{
    b64_decode, b64_encode, default_kdf_params, derive_sync_key, encrypt_payload, random_sync_salt,
    sha256_hex, Manifest, SettingsBlob, SettingsPayload, SyncPayload, PAYLOAD_FORMAT_VERSION,
};
