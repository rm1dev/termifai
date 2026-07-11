use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    pub id: String,
    pub name: String,
    pub user: String,
    pub hostname: String,
    pub port: u16,
    pub os: OsKind,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_method: Option<AuthMethod>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_key_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub show_status_in_dashboard: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub working_directory: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_sftp_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    /// At most one host per vault may have this set to `true`.
    /// Enforced in `save_host`. This host is the SFTP sync target.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_server: Option<bool>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OsKind {
    Ubuntu,
    Debian,
    Centos,
    Alpine,
    Macos,
    Windows,
    Other,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthMethod {
    Password,
    Key,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostGroup {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

fn default_version() -> u32 {
    1
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HostsVault {
    #[serde(default = "default_version")]
    pub version: u32,
    pub hosts: Vec<Host>,
    pub groups: Vec<HostGroup>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crypto: Option<super::vault::CryptoMeta>,
}

pub fn migrate_hosts_vault(value: &mut serde_json::Value) {
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
    fn empty_vault_serializes_without_crypto_field() {
        let vault = HostsVault::default();
        let json = serde_json::to_string(&vault).unwrap();
        assert!(!json.contains("crypto"), "crypto must be omitted when None");
    }
}
