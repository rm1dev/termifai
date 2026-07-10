use crate::AppState;
use serde::Deserialize;
use tauri::{AppHandle, Manager};
use termifai_core::model::snippets::migrate_snippets_vault;
pub use termifai_core::model::snippets::{
    Snippet, SnippetKind, SnippetVariable, SnippetVariableType, SnippetsVault,
};

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

fn get_snippets_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let vault_dir =
        termifai_core::layout::vault_dir(&app_data_dir, termifai_core::layout::DEFAULT_VAULT_ID);
    let snippets_dir = vault_dir.join("snippets");
    if !snippets_dir.exists() {
        std::fs::create_dir_all(&snippets_dir)
            .map_err(|e| format!("Failed to create snippets dir: {}", e))?;
    }
    Ok(snippets_dir)
}

fn script_path(dir: &std::path::Path, id: &str) -> std::path::PathBuf {
    dir.join(format!("{}.sh", id))
}

fn read_script_file(dir: &std::path::Path, id: &str) -> Option<String> {
    std::fs::read_to_string(script_path(dir, id)).ok()
}

fn write_script_file(dir: &std::path::Path, id: &str, content: &str) -> Result<(), String> {
    std::fs::write(script_path(dir, id), content)
        .map_err(|e| format!("Failed to write script file: {}", e))
}

fn delete_script_file(dir: &std::path::Path, id: &str) {
    let _ = std::fs::remove_file(script_path(dir, id));
}

pub fn list_snippets(app: &AppHandle) -> Result<Vec<Snippet>, String> {
    let state = app.state::<AppState>();
    let vault = state
        .snippets_store
        .load_with_migration(migrate_snippets_vault)
        .map_err(|e| e.to_string())?;

    let dir = get_snippets_dir(app)?;
    let mut snippets = vault.snippets;
    for snippet in &mut snippets {
        if matches!(snippet.kind, SnippetKind::Script) {
            // Prefer the .sh file; keep any inline copy that hasn't been
            // migrated yet (never downgrade Some(inline) to None here).
            if let Some(content) = read_script_file(&dir, &snippet.id) {
                snippet.script = Some(content);
            }
        }
    }
    Ok(snippets)
}

/// One-time startup migration: move inline script bodies from the DB vault
/// into per-snippet .sh files. The inline copy is cleared ONLY for snippets
/// whose file write succeeded (or that already have a file on disk), so a
/// failed write can never lose the script.
pub fn migrate_inline_scripts(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let vault = state
        .snippets_store
        .load_with_migration(migrate_snippets_vault)
        .map_err(|e| e.to_string())?;

    let dir = get_snippets_dir(app)?;
    let mut migrated_ids: Vec<String> = Vec::new();
    for s in &vault.snippets {
        if matches!(s.kind, SnippetKind::Script) {
            if let Some(ref content) = s.script {
                let already_on_disk = script_path(&dir, &s.id).exists();
                if already_on_disk || write_script_file(&dir, &s.id, content).is_ok() {
                    migrated_ids.push(s.id.clone());
                }
            }
        }
    }

    if !migrated_ids.is_empty() {
        state
            .snippets_store
            .update_with_migration(migrate_snippets_vault, |v| {
                for s in &mut v.snippets {
                    if migrated_ids.contains(&s.id) {
                        s.script = None;
                    }
                }
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn save_snippet(app: &AppHandle, request: SaveSnippetRequest) -> Result<Snippet, String> {
    validate_snippet(&request)?;

    let id = request
        .id
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| format!("s-{}", uuid::Uuid::new_v4()));

    let dir = get_snippets_dir(app)?;
    if matches!(request.kind, SnippetKind::Script) {
        if let Some(ref script_content) = request.script {
            write_script_file(&dir, &id, script_content)?;
        }
    } else {
        // Editing an existing Script snippet to another kind orphans its file.
        delete_script_file(&dir, &id);
    }

    let state = app.state::<AppState>();
    let mut saved_snippet = None;

    state
        .snippets_store
        .update_with_migration(migrate_snippets_vault, |vault| {
            let existing_created_at = vault
                .snippets
                .iter()
                .find(|s| s.id == id)
                .and_then(|s| s.created_at.clone());

            let snippet_db = Snippet {
                id: id.clone(),
                kind: request.kind.clone(),
                name: request.name.trim().to_string(),
                body: request.body.filter(|v| !v.trim().is_empty()),
                command: request.command.filter(|v| !v.trim().is_empty()),
                script: None, // Do not store script content inline in DB
                variables: request.variables.clone(),
                created_at: existing_created_at.or_else(|| Some(now_iso())),
                updated_at: Some(now_iso()),
            };

            upsert_by_id(&mut vault.snippets, snippet_db.clone());

            let mut returned = snippet_db;
            if matches!(request.kind, SnippetKind::Script) {
                returned.script = request.script.clone();
            }
            saved_snippet = Some(returned);
        })
        .map_err(|e| e.to_string())?;

    saved_snippet.ok_or_else(|| "Failed to save snippet".to_string())
}

pub fn remove_snippets(app: &AppHandle, ids: Vec<String>) -> Result<(), String> {
    let state = app.state::<AppState>();

    if let Ok(dir) = get_snippets_dir(app) {
        for id in &ids {
            delete_script_file(&dir, id);
        }
    }

    state
        .snippets_store
        .update_with_migration(migrate_snippets_vault, |vault| {
            vault.snippets.retain(|s| !ids.contains(&s.id));
        })
        .map_err(|e| e.to_string())?;
    crate::tombstones::record(app, crate::tombstones::EntityKind::Snippet, &ids)?;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("termifai_snippets_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn script_file_roundtrip() {
        let dir = temp_dir();
        write_script_file(&dir, "abc", "echo hi").unwrap();
        assert_eq!(read_script_file(&dir, "abc").as_deref(), Some("echo hi"));
        delete_script_file(&dir, "abc");
        assert!(read_script_file(&dir, "abc").is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn script_path_uses_id_and_sh_extension() {
        let dir = temp_dir();
        assert_eq!(script_path(&dir, "s-1"), dir.join("s-1.sh"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_to_missing_dir_fails_without_panicking() {
        let dir = std::env::temp_dir().join("termifai_missing_dir_test/never_created");
        assert!(write_script_file(&dir, "abc", "x").is_err());
    }
}
