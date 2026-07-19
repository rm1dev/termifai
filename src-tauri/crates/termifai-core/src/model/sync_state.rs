use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum SyncBackendConfig {
    /// A plain directory — used for local testing, and as a real option for
    /// users who point it at a folder already synced by Dropbox/Drive's own
    /// desktop client, a NAS mount, etc. Cloud (OAuth) and SFTP backends are
    /// later variants of this same enum (phases 2/3).
    LocalDir { path: String },
    GoogleDrive,
    Dropbox,
    Sftp {
        #[serde(rename = "hostId")]
        host_id: String,
        #[serde(rename = "remotePath")]
        remote_path: String,
    },
}

fn default_version() -> u32 {
    1
}

fn default_auto_sync() -> bool {
    true
}

/// Mirrors the sync engine's settings blobs so the background loop can sync
/// theme / appearance / shortcuts without reading the webview's localStorage.
#[derive(Clone, Serialize, Deserialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CachedSettingsBlob {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SettingsCache {
    #[serde(default)]
    pub app_theme: CachedSettingsBlob,
    #[serde(default)]
    pub terminal_appearance: CachedSettingsBlob,
    #[serde(default)]
    pub shortcuts: CachedSettingsBlob,
}

/// Diagnostics from the most recent sync cycle (Phase C).
#[derive(Clone, Serialize, Deserialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncStats {
    pub uploaded: bool,
    pub applied: bool,
    #[serde(default)]
    pub collections_uploaded: Vec<String>,
    #[serde(default)]
    pub collections_downloaded: Vec<String>,
    pub at: String,
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncState {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub device_id: Option<String>,
    #[serde(default)]
    pub device_name: Option<String>,
    #[serde(default)]
    pub backend: Option<SyncBackendConfig>,
    #[serde(default)]
    pub last_synced_blob_version: u64,
    #[serde(default)]
    pub last_sync_at: Option<String>,
    #[serde(default)]
    pub sync_ssh_keys: bool,
    /// Set whenever a save_*/remove_* mutation happens locally; cleared once
    /// a sync cycle completes. Lets the engine skip a network round trip when
    /// nothing changed on either side.
    #[serde(default)]
    pub dirty: bool,
    /// When true (default), the background loop pushes/pulls automatically.
    #[serde(default = "default_auto_sync")]
    pub auto_sync: bool,
    /// Last error from an automatic or manual sync attempt (cleared on success).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    /// Frontend-pushed settings used by background sync.
    #[serde(default)]
    pub settings_cache: SettingsCache,
    /// Last successful/failed cycle stats for the Settings diagnostics panel.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_sync_stats: Option<SyncStats>,
}

pub fn migrate_sync_state(value: &mut serde_json::Value) {
    if let Some(obj) = value.as_object_mut() {
        if obj.get("version").is_none() {
            obj.insert("version".to_string(), serde_json::Value::from(1u32));
        }
        if obj.get("autoSync").is_none() {
            obj.insert("autoSync".to_string(), serde_json::Value::Bool(true));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sftp_backend_config_deserializes_from_camel_case_json() {
        let json = r#"{"kind":"sftp","hostId":"abc123","remotePath":"~/.termifai/sync"}"#;
        let parsed: SyncBackendConfig = serde_json::from_str(json).expect("should deserialize");
        assert_eq!(
            parsed,
            SyncBackendConfig::Sftp {
                host_id: "abc123".to_string(),
                remote_path: "~/.termifai/sync".to_string(),
            }
        );
    }

    #[test]
    fn set_sync_config_request_shape_deserializes() {
        // Mirrors exactly what src-tauri/src/sync.rs::SetSyncConfigRequest expects,
        // and exactly what src/lib/api/sync.ts::syncSetConfig sends.
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct SetSyncConfigRequest {
            backend: SyncBackendConfig,
            #[serde(default)]
            #[allow(dead_code)]
            sync_ssh_keys: bool,
        }
        let json = r#"{"backend":{"kind":"sftp","hostId":"abc123","remotePath":"~/x"},"syncSshKeys":false}"#;
        let parsed: SetSyncConfigRequest = serde_json::from_str(json).expect("should deserialize");
        assert!(matches!(parsed.backend, SyncBackendConfig::Sftp { .. }));
    }

    #[test]
    fn legacy_sync_state_gets_auto_sync_default() {
        let mut value = serde_json::json!({
            "version": 1,
            "dirty": false
        });
        migrate_sync_state(&mut value);
        assert_eq!(value["autoSync"], true);
    }
}
