use crate::AppState;
use tauri::{AppHandle, Manager};
pub use termifai_core::model::tombstones::{
    migrate_tombstones_vault, EntityKind, Tombstone, TombstonesVault,
};

/// Days after which a tombstone is pruned — long enough that any plausibly
/// still-offline device will have reconnected and merged the delete first.
const RETENTION_DAYS: i64 = 180;

pub fn record(app: &AppHandle, entity: EntityKind, ids: &[String]) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }
    let now = now_iso();
    let state = app.state::<AppState>();
    state
        .tombstones_store
        .update_with_migration(migrate_tombstones_vault, |vault| {
            for id in ids {
                vault.tombstones.push(Tombstone {
                    entity,
                    id: id.clone(),
                    deleted_at: now.clone(),
                });
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn list(app: &AppHandle) -> Result<Vec<Tombstone>, String> {
    let state = app.state::<AppState>();
    let vault = state
        .tombstones_store
        .load_with_migration(migrate_tombstones_vault)
        .map_err(|e| e.to_string())?;
    Ok(vault.tombstones)
}

/// Replaces the local tombstone list with `merged` (the union computed by a
/// sync cycle), then prunes anything older than the retention window.
pub fn replace_and_prune(app: &AppHandle, merged: Vec<Tombstone>) -> Result<(), String> {
    let cutoff = cutoff_iso();
    let state = app.state::<AppState>();
    state
        .tombstones_store
        .update_with_migration(migrate_tombstones_vault, |vault| {
            vault.tombstones = merged;
            termifai_core::model::tombstones::prune_older_than(&mut vault.tombstones, &cutoff);
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn cutoff_iso() -> String {
    let cutoff = time::OffsetDateTime::now_utc() - time::Duration::days(RETENTION_DAYS);
    cutoff
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

fn now_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}
