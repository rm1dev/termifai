use crate::AppState;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

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
    pub created_at: Option<String>,
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
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSnippetRequest {
    pub id: Option<String>,
    pub kind: SnippetKind,
    pub name: String,
    pub body: Option<String>,
    pub command: Option<String>,
    pub script: Option<String>,
    #[serde(default)]
    pub variables: Vec<SnippetVariable>,
}

// ──────────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────────

fn migrate_snippets_vault(value: &mut serde_json::Value) {
    if value.get("version").is_none() {
        if let Some(obj) = value.as_object_mut() {
            obj.insert("version".to_string(), serde_json::Value::from(1u32));
        }
    }
}

pub fn list_snippets(app: &AppHandle) -> Result<Vec<Snippet>, String> {
    let state = app.state::<AppState>();
    let vault = state.snippets_store
        .load_with_migration(migrate_snippets_vault)
        .map_err(|e| e.to_string())?;
    Ok(vault.snippets)
}

pub fn save_snippet(app: &AppHandle, request: SaveSnippetRequest) -> Result<Snippet, String> {
    validate_snippet(&request)?;

    let id = request
        .id
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| format!("s-{}", uuid::Uuid::new_v4()));

    let state = app.state::<AppState>();
    let mut saved_snippet = None;

    state.snippets_store.update_with_migration(migrate_snippets_vault, |vault| {
        let existing_created_at = vault
            .snippets
            .iter()
            .find(|s| s.id == id)
            .and_then(|s| s.created_at.clone());

        let snippet = Snippet {
            id: id.clone(),
            kind: request.kind,
            name: request.name.trim().to_string(),
            body: request.body.filter(|v| !v.trim().is_empty()),
            command: request.command.filter(|v| !v.trim().is_empty()),
            script: request.script.filter(|v| !v.trim().is_empty()),
            variables: request.variables,
            created_at: existing_created_at.or_else(|| Some(now_iso())),
        };

        upsert_by_id(&mut vault.snippets, snippet.clone());
        saved_snippet = Some(snippet);
    }).map_err(|e| e.to_string())?;

    saved_snippet.ok_or_else(|| "Failed to save snippet".to_string())
}

pub fn remove_snippets(app: &AppHandle, ids: Vec<String>) -> Result<(), String> {
    let state = app.state::<AppState>();
    state.snippets_store.update_with_migration(migrate_snippets_vault, |vault| {
        vault.snippets.retain(|s| !ids.contains(&s.id));
    }).map_err(|e| e.to_string())?;
    Ok(())
}

// ──────────────────────────────────────────────────────────────────────────────
// Internals
// ──────────────────────────────────────────────────────────────────────────────

fn validate_snippet(request: &SaveSnippetRequest) -> Result<(), String> {
    if request.name.trim().is_empty() {
        return Err("Snippet name is required".to_string());
    }

    match request.kind {
        SnippetKind::Text => {
            if request
                .body
                .as_ref()
                .map(|v| v.trim().is_empty())
                .unwrap_or(true)
            {
                return Err("Body is required for text snippets".to_string());
            }
        }
        SnippetKind::Command => {
            if request
                .command
                .as_ref()
                .map(|v| v.trim().is_empty())
                .unwrap_or(true)
            {
                return Err("Command is required for command snippets".to_string());
            }
        }
        SnippetKind::Script => {
            if request
                .script
                .as_ref()
                .map(|v| v.trim().is_empty())
                .unwrap_or(true)
            {
                return Err("Script is required for script snippets".to_string());
            }
        }
    }

    // Validate variables
    for var in &request.variables {
        if var.name.trim().is_empty() {
            return Err("Variable name is required".to_string());
        }
        if matches!(var.var_type, SnippetVariableType::Enum) && var.options.is_empty() {
            return Err(format!(
                "Variable '{}' is enum type but has no options",
                var.name
            ));
        }
    }

    Ok(())
}



fn upsert_by_id(items: &mut Vec<Snippet>, item: Snippet) {
    if let Some(index) = items.iter().position(|existing| existing.id == item.id) {
        items[index] = item;
    } else {
        items.insert(0, item);
    }
}

fn now_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}
