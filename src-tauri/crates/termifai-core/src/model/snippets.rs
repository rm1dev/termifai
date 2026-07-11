use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SnippetKind {
    Text,
    Command,
    Script,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SnippetVariableType {
    Text,
    Enum,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetVariable {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(rename = "type")]
    pub var_type: SnippetVariableType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_value: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SnippetOsTarget {
    All,
    Local,
    Linux,
    Windows,
    Ubuntu,
    Debian,
    Centos,
    Alpine,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: String,
    pub kind: SnippetKind,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub script: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub variables: Vec<SnippetVariable>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keyword: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub os_targets: Vec<SnippetOsTarget>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetGroup {
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
pub struct SnippetsVault {
    #[serde(default = "default_version")]
    pub version: u32,
    pub snippets: Vec<Snippet>,
    #[serde(default)]
    pub groups: Vec<SnippetGroup>,
}

pub fn migrate_snippets_vault(value: &mut serde_json::Value) {
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
    fn snippet_round_trips_keyword_group_and_os_targets() {
        let snippet = Snippet {
            id: "s1".to_string(),
            kind: SnippetKind::Text,
            name: "Deploy".to_string(),
            body: Some("echo deploying".to_string()),
            command: None,
            script: None,
            variables: vec![],
            group_id: Some("g1".to_string()),
            keyword: Some("deploy".to_string()),
            os_targets: vec![SnippetOsTarget::Linux, SnippetOsTarget::Windows],
            created_at: None,
            updated_at: None,
        };
        let json = serde_json::to_string(&snippet).unwrap();
        let back: Snippet = serde_json::from_str(&json).unwrap();
        assert_eq!(back.group_id.as_deref(), Some("g1"));
        assert_eq!(back.keyword.as_deref(), Some("deploy"));
        assert_eq!(back.os_targets.len(), 2);
    }

    #[test]
    fn old_snippet_json_without_new_fields_still_deserializes() {
        let json = r#"{"id":"s1","kind":"command","name":"Old","command":"ls"}"#;
        let snippet: Snippet = serde_json::from_str(json).unwrap();
        assert!(snippet.group_id.is_none());
        assert!(snippet.keyword.is_none());
        assert!(snippet.os_targets.is_empty());
    }

    #[test]
    fn empty_vault_serializes_without_groups_growing() {
        let vault = SnippetsVault::default();
        let json = serde_json::to_string(&vault).unwrap();
        let back: SnippetsVault = serde_json::from_str(&json).unwrap();
        assert!(back.groups.is_empty());
        assert!(back.snippets.is_empty());
    }
}
