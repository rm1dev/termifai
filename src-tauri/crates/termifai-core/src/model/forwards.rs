use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TunnelDirection {
    Local,
    Remote,
    Dynamic,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardRule {
    pub id: String,
    pub name: String,
    pub host_id: String,
    pub direction: TunnelDirection,
    pub local_host: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    pub auto_connect: bool,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

fn default_version() -> u32 {
    1
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardVault {
    #[serde(default = "default_version")]
    pub version: u32,
    pub rules: Vec<PortForwardRule>,
}

pub fn migrate_port_forward_vault(value: &mut serde_json::Value) {
    if value.get("version").is_none() {
        if let Some(obj) = value.as_object_mut() {
            obj.insert("version".to_string(), serde_json::Value::from(1u32));
        }
    }
}
