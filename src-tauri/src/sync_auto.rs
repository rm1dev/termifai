//! Event-driven auto-sync — no polling loop.
//!
//! Sync runs only when:
//! 1. the app unlocks / opens (pull + push), or
//! 2. local syncable data changes (push after a short coalesce).

use crate::sync::{self, SyncNowRequest};
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::AppHandle;
use termifai_core::sync::{SettingsBlob, SettingsPayload};

/// Coalesce burst edits (e.g. several saves in a row) into one sync.
const DIRTY_COALESCE_MS: u64 = 1000;

static APP: OnceLock<Mutex<Option<AppHandle>>> = OnceLock::new();
static DIRTY_GEN: AtomicU64 = AtomicU64::new(0);

fn app_slot() -> &'static Mutex<Option<AppHandle>> {
    APP.get_or_init(|| Mutex::new(None))
}

fn with_app(f: impl FnOnce(&AppHandle)) {
    if let Ok(guard) = app_slot().lock() {
        if let Some(app) = guard.as_ref() {
            f(app);
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncActivityEvent {
    pub phase: &'static str,
    pub uploaded: bool,
    pub applied: bool,
    pub blob_version: u64,
    pub last_sync_at: Option<String>,
    pub error: Option<String>,
    pub dirty: bool,
    pub auto_sync: bool,
}

fn cache_to_settings(cache: &termifai_core::model::sync_state::SettingsCache) -> SettingsPayload {
    SettingsPayload {
        app_theme: SettingsBlob {
            value: cache.app_theme.value.clone(),
            updated_at: cache.app_theme.updated_at.clone(),
        },
        terminal_appearance: SettingsBlob {
            value: cache.terminal_appearance.value.clone(),
            updated_at: cache.terminal_appearance.updated_at.clone(),
        },
        shortcuts: SettingsBlob {
            value: cache.shortcuts.value.clone(),
            updated_at: cache.shortcuts.updated_at.clone(),
        },
    }
}

fn should_run(app: &AppHandle) -> bool {
    if !crate::vault::is_unlocked() {
        return false;
    }
    let Ok(state) = sync::load_state(app) else {
        return false;
    };
    if state.backend.is_none() || !state.auto_sync {
        return false;
    }
    crate::vault::cached_master_password().is_some()
}

fn run_auto_sync(app: &AppHandle) {
    if !should_run(app) {
        return;
    }
    let Ok(state) = sync::load_state(app) else {
        return;
    };
    let settings = cache_to_settings(&state.settings_cache);
    let _ = sync::try_sync_now(
        app,
        SyncNowRequest {
            master_password: None,
            app_theme: Some(settings.app_theme),
            terminal_appearance: Some(settings.terminal_appearance),
            shortcuts: Some(settings.shortcuts),
        },
    );
}

fn spawn_sync_now(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let _ = tokio::task::spawn_blocking(move || run_auto_sync(&app)).await;
    });
}

/// Registers the app handle. No background loop — sync is purely event-driven.
pub fn start(app: AppHandle) {
    if let Ok(mut guard) = app_slot().lock() {
        *guard = Some(app);
    }
}

/// Called after vault unlock (cold start or manual) — sync immediately.
pub fn request_sync_after_unlock() {
    with_app(|app| spawn_sync_now(app.clone()));
}

/// Called when local syncable data changes. Coalesces rapid edits (~1s) into one sync.
pub fn note_dirty() {
    let gen = DIRTY_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let app = match app_slot().lock() {
        Ok(g) => g.clone(),
        Err(_) => None,
    };
    let Some(app) = app else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(DIRTY_COALESCE_MS)).await;
        if DIRTY_GEN.load(Ordering::SeqCst) != gen {
            return; // ویرایش جدیدتر اومده؛ این دور لغوه
        }
        let _ = tokio::task::spawn_blocking(move || run_auto_sync(&app)).await;
    });
}
