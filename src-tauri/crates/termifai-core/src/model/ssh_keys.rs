use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshKey {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub key_type: SshKeyType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u16>,
    pub fingerprint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remark: Option<String>,
    pub has_passphrase: bool,
    pub created_at: String,
    pub public_key: String,
    pub public_key_path: String,
    pub private_key_path: String,
    /// Only populated in-memory when building a sync payload with SSH-key
    /// sync opted in — never written to the local per-key metadata file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private_key_pem: Option<String>,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SshKeyType {
    Ed25519,
    Rsa,
}
