use crate::AppState;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use termifai_core::model::snippets::migrate_snippets_vault;
pub use termifai_core::model::snippets::{
    Snippet, SnippetGroup, SnippetKind, SnippetOsTarget, SnippetVariable, SnippetVariableType,
    SnippetsVault,
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
    #[serde(default)]
    pub group_id: Option<String>,
    #[serde(default)]
    pub keyword: Option<String>,
    #[serde(default)]
    pub os_targets: Vec<SnippetOsTarget>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSnippetGroupRequest {
    pub id: Option<String>,
    pub name: String,
    pub parent_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetsListResult {
    pub snippets: Vec<Snippet>,
    pub groups: Vec<SnippetGroup>,
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

/// Applies a merged snippet set from sync: writes/updates `.sh` files for
/// Script snippets, drops orphaned script files, and stores metadata with
/// `script: None` (body lives on disk, same as `save_snippet`).
pub fn apply_synced_snippets(
    app: &AppHandle,
    snippets: Vec<Snippet>,
    groups: Vec<SnippetGroup>,
) -> Result<(), String> {
    let dir = get_snippets_dir(app)?;
    let keep_ids: std::collections::HashSet<&str> =
        snippets.iter().map(|s| s.id.as_str()).collect();

    // پاک کردن فایل اسکریپت‌هایی که دیگه تو لیست merged نیستن
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("sh") {
                continue;
            }
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                if !keep_ids.contains(stem) {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
    }

    let mut vault_snippets = Vec::with_capacity(snippets.len());
    for mut snippet in snippets {
        if matches!(snippet.kind, SnippetKind::Script) {
            if let Some(content) = snippet.script.take() {
                write_script_file(&dir, &snippet.id, &content)?;
            }
        } else {
            snippet.script = None;
            delete_script_file(&dir, &snippet.id);
        }
        // مثل save_snippet — محتوای اسکریپت تو DB نمی‌مونه
        snippet.script = None;
        vault_snippets.push(snippet);
    }

    let state = app.state::<AppState>();
    state
        .snippets_store
        .update_with_migration(migrate_snippets_vault, |vault| {
            vault.snippets = vault_snippets.clone();
            vault.groups = groups.clone();
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn list_snippets(app: &AppHandle) -> Result<SnippetsListResult, String> {
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
    Ok(SnippetsListResult {
        snippets,
        groups: vault.groups,
    })
}

/// One-time startup migration: move inline script bodies from the DB vault
/// into per-snippet .sh files. The inline copy is cleared ONLY for snippets
/// whose file write succeeded, so a failed write can never lose the script.
/// The write is unconditional (even if a .sh file already exists) because
/// synced inline content may be newer than whatever is on disk locally.
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
                if write_script_file(&dir, &s.id, content).is_ok() {
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

            let keyword = if matches!(request.kind, SnippetKind::Text) {
                request.keyword.clone().filter(|v| !v.trim().is_empty())
            } else {
                None
            };

            let snippet_db = Snippet {
                id: id.clone(),
                kind: request.kind.clone(),
                name: request.name.trim().to_string(),
                body: request.body.filter(|v| !v.trim().is_empty()),
                command: request.command.filter(|v| !v.trim().is_empty()),
                script: None, // Do not store script content inline in DB
                variables: request.variables.clone(),
                group_id: request.group_id.clone().filter(|v| !v.trim().is_empty()),
                keyword,
                os_targets: request.os_targets.clone(),
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

    if !matches!(request.kind, SnippetKind::Script) {
        // Editing an existing Script snippet to another kind orphans its file.
        // Deleted only after the DB update succeeds, so a failure never loses
        // the script while also removing the snippet's Script-kind record.
        delete_script_file(&dir, &id);
    }

    crate::sync::mark_dirty(app);
    saved_snippet.ok_or_else(|| "Failed to save snippet".to_string())
}

pub fn remove_snippets(app: &AppHandle, ids: Vec<String>) -> Result<(), String> {
    let state = app.state::<AppState>();

    state
        .snippets_store
        .update_with_migration(migrate_snippets_vault, |vault| {
            vault.snippets.retain(|s| !ids.contains(&s.id));
        })
        .map_err(|e| e.to_string())?;
    crate::tombstones::record(app, crate::tombstones::EntityKind::Snippet, &ids)?;

    if let Ok(dir) = get_snippets_dir(app) {
        for id in &ids {
            delete_script_file(&dir, id);
        }
    }
    crate::sync::mark_dirty(app);
    Ok(())
}

/// Reorders `vault.snippets` to match `ids` (front-to-back). Any snippet not
/// referenced in `ids` keeps its original relative position, appended after
/// the reordered ones — defensive against a stale/partial id list.
pub fn reorder_snippets(app: &AppHandle, ids: Vec<String>) -> Result<(), String> {
    let state = app.state::<AppState>();
    state
        .snippets_store
        .update_with_migration(migrate_snippets_vault, |vault| {
            let mut reordered: Vec<Snippet> = Vec::with_capacity(vault.snippets.len());
            for id in &ids {
                if let Some(pos) = vault.snippets.iter().position(|s| &s.id == id) {
                    reordered.push(vault.snippets.remove(pos));
                }
            }
            reordered.append(&mut vault.snippets);
            vault.snippets = reordered;
        })
        .map_err(|e| e.to_string())?;
    crate::sync::mark_dirty(app);
    Ok(())
}

pub fn save_snippet_group(
    app: &AppHandle,
    request: SaveSnippetGroupRequest,
) -> Result<SnippetGroup, String> {
    let name = request.name.trim();
    if name.is_empty() {
        return Err("Group name is required".to_string());
    }

    let id = request
        .id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("sg-{}", uuid::Uuid::new_v4()));

    if request.parent_id.as_deref() == Some(&id) {
        return Err("Group cannot be its own parent".to_string());
    }

    let parent_id = request
        .parent_id
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .cloned();

    let group = SnippetGroup {
        id: id.clone(),
        name: name.to_string(),
        parent_id: parent_id.clone(),
        updated_at: Some(now_iso()),
    };

    let state = app.state::<AppState>();
    let mut error = None;

    state
        .snippets_store
        .update_with_migration(migrate_snippets_vault, |vault| {
            if let Some(parent_id) = parent_id.as_deref() {
                if !vault.groups.iter().any(|g| g.id == parent_id) {
                    error = Some("Selected group does not exist".to_string());
                    return;
                }
            }
            upsert_group_by_id(&mut vault.groups, group.clone());
        })
        .map_err(|e| e.to_string())?;

    if let Some(err_msg) = error {
        return Err(err_msg);
    }

    crate::sync::mark_dirty(app);
    Ok(group)
}

pub fn remove_snippet_group(app: &AppHandle, id: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut removed_group_ids: Vec<String> = Vec::new();

    state
        .snippets_store
        .update_with_migration(migrate_snippets_vault, |vault| {
            let descendants = descendant_group_ids(&vault.groups, &id);
            removed_group_ids = std::iter::once(id.clone())
                .chain(descendants.iter().cloned())
                .collect();

            vault
                .groups
                .retain(|group| group.id != id && !descendants.contains(&group.id));
            for snippet in vault.snippets.iter_mut() {
                if snippet
                    .group_id
                    .as_ref()
                    .map(|group_id| group_id == &id || descendants.contains(group_id))
                    .unwrap_or(false)
                {
                    snippet.group_id = None;
                }
            }
        })
        .map_err(|e| e.to_string())?;
    crate::tombstones::record(
        app,
        crate::tombstones::EntityKind::SnippetGroup,
        &removed_group_ids,
    )?;
    crate::sync::mark_dirty(app);
    Ok(())
}

fn descendant_group_ids(groups: &[SnippetGroup], id: &str) -> Vec<String> {
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

fn upsert_group_by_id(items: &mut Vec<SnippetGroup>, item: SnippetGroup) {
    if let Some(index) = items.iter().position(|existing| existing.id == item.id) {
        items[index] = item;
    } else {
        items.insert(0, item);
    }
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

    if let Some(keyword) = request.keyword.as_ref() {
        let trimmed = keyword.trim();
        if !trimmed.is_empty() && trimmed.split_whitespace().count() > 1 {
            return Err("Snippet keyword must be a single word".to_string());
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

    #[test]
    fn write_script_file_overwrites_stale_file_on_disk() {
        // Regression test for the migrate_inline_scripts short-circuit bug:
        // a .sh file already on disk must not block a write-through of newer
        // (e.g. synced) inline content.
        let dir = temp_dir();
        write_script_file(&dir, "abc", "OLD content").unwrap();
        assert_eq!(
            read_script_file(&dir, "abc").as_deref(),
            Some("OLD content")
        );

        write_script_file(&dir, "abc", "NEW content").unwrap();
        assert_eq!(
            read_script_file(&dir, "abc").as_deref(),
            Some("NEW content")
        );

        std::fs::remove_dir_all(&dir).ok();
    }
}
