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
    // اگه true باشه، ترمینال SSH این هاست داخل یه سشن tmux باز می‌شه که بعد از
    // قطعی اتصال همون شل قبلی رو زنده نگه می‌داره. عوضش tmux موقع خروجی‌های
    // پرحجم (مثل cat یه فایل بزرگ) خط‌های وسط رو برای ترمینال نمی‌فرسته و
    // اسکرول‌بک لوکال ناقص می‌شه — برای همین پیش‌فرض خاموشه.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resilient_session: Option<bool>,
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

/// شناسه زیر‌گروه‌های یک گروه (نه خود گروه).
pub fn descendant_group_ids(groups: &[HostGroup], id: &str) -> Vec<String> {
    let mut descendants = Vec::new();
    let mut stack = vec![id.to_string()];

    while let Some(parent_id) = stack.pop() {
        for group in groups.iter().filter(|group| {
            group
                .parent_id
                .as_ref()
                .map(|current| current == &parent_id)
                .unwrap_or(false)
        }) {
            descendants.push(group.id.clone());
            stack.push(group.id.clone());
        }
    }

    descendants
}

/// آیا حذف این گروه (و زیر‌گروه‌هاش) هاست مشخصی رو هم پاک می‌کنه؟
pub fn group_deletion_includes_host(vault: &HostsVault, group_id: &str, host_id: &str) -> bool {
    let descendants = descendant_group_ids(&vault.groups, group_id);
    vault.hosts.iter().any(|host| {
        host.id == host_id
            && host
                .group_id
                .as_ref()
                .map(|gid| gid == group_id || descendants.contains(gid))
                .unwrap_or(false)
    })
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

    fn sample_host(id: &str, group_id: Option<&str>) -> Host {
        Host {
            id: id.into(),
            name: id.into(),
            user: "u".into(),
            hostname: "h".into(),
            port: 22,
            os: OsKind::Other,
            tags: vec![],
            last_used: None,
            group_id: group_id.map(str::to_string),
            auth_method: None,
            password: None,
            ssh_key_id: None,
            show_status_in_dashboard: None,
            working_directory: None,
            default_sftp_path: None,
            updated_at: None,
            sync_server: None,
            resilient_session: None,
        }
    }

    #[test]
    fn group_deletion_detects_sync_host_in_nested_group() {
        let vault = HostsVault {
            version: 1,
            hosts: vec![
                sample_host("h-sync", Some("g-child")),
                sample_host("h-other", Some("g-root")),
            ],
            groups: vec![
                HostGroup {
                    id: "g-root".into(),
                    name: "root".into(),
                    parent_id: None,
                    updated_at: None,
                },
                HostGroup {
                    id: "g-child".into(),
                    name: "child".into(),
                    parent_id: Some("g-root".into()),
                    updated_at: None,
                },
            ],
            crypto: None,
        };

        assert!(group_deletion_includes_host(&vault, "g-root", "h-sync"));
        assert!(group_deletion_includes_host(&vault, "g-child", "h-sync"));
        assert!(!group_deletion_includes_host(&vault, "g-child", "h-other"));
        assert!(!group_deletion_includes_host(&vault, "g-root", "missing"));
    }
}
