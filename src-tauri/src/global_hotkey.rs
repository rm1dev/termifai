//! Global (system-wide) hotkey to show/hide the main window.
//!
//! Disabled by default. Two backends depending on platform/session:
//! - Windows / macOS / Linux+X11: `tauri-plugin-global-shortcut` (OS-level RegisterHotKey /
//!   Carbon hotkey / X11 XGrabKey under the hood).
//! - Linux + Wayland: the `org.freedesktop.portal.GlobalShortcuts` XDG desktop portal, which is
//!   the only sanctioned way to get a global shortcut under Wayland's security model. Binding
//!   happens interactively — the compositor shows the user a one-time confirmation dialog the
//!   moment we ask, which is fine here because the user just clicked "enable" in Settings.
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

#[cfg(target_os = "linux")]
mod portal;

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct HotkeySettings {
    pub enabled: bool,
    /// Tauri accelerator syntax, e.g. "CmdOrCtrl+Shift+Space".
    pub accelerator: String,
}

#[derive(Serialize, Clone)]
pub struct HotkeyStatus {
    pub enabled: bool,
    pub accelerator: String,
    pub backend: &'static str, // "plugin" | "portal"
}

#[derive(Default)]
pub struct HotkeyState {
    current: Mutex<Option<HotkeyStatus>>,
    #[cfg(target_os = "linux")]
    portal_session: Mutex<Option<portal::PortalSession>>,
}

pub fn is_wayland() -> bool {
    if cfg!(not(target_os = "linux")) {
        return false;
    }
    std::env::var("XDG_SESSION_TYPE")
        .map(|v| v.eq_ignore_ascii_case("wayland"))
        .unwrap_or(false)
        || std::env::var("WAYLAND_DISPLAY").is_ok()
}

fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let visible = window.is_visible().unwrap_or(false);
        if visible {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

#[tauri::command]
pub async fn enable_global_hotkey(
    app: AppHandle,
    accelerator: String,
) -> Result<HotkeyStatus, String> {
    enable_inner(app, accelerator).await
}

async fn enable_inner(app: AppHandle, accelerator: String) -> Result<HotkeyStatus, String> {
    let state = app.state::<HotkeyState>();
    disable_inner(&app, &state);

    let status = if is_wayland() {
        #[cfg(target_os = "linux")]
        {
            let (session, effective_accelerator) = portal::bind(app.clone(), accelerator.clone())
                .await
                .map_err(|e| format!("Wayland global shortcut portal error: {}", e))?;
            *state.portal_session.lock().unwrap() = Some(session);
            HotkeyStatus {
                enabled: true,
                accelerator: effective_accelerator,
                backend: "portal",
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            unreachable!("is_wayland() is only true on linux")
        }
    } else {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        app.global_shortcut()
            .register(accelerator.as_str())
            .map_err(|e| format!("Failed to register global shortcut: {}", e))?;
        HotkeyStatus {
            enabled: true,
            accelerator: accelerator.clone(),
            backend: "plugin",
        }
    };

    *state.current.lock().unwrap() = Some(status.clone());
    save_settings(
        &app,
        &HotkeySettings {
            enabled: true,
            accelerator: status.accelerator.clone(),
        },
    );
    Ok(status)
}

#[tauri::command]
pub fn disable_global_hotkey(app: AppHandle) -> Result<(), String> {
    let state = app.state::<HotkeyState>();
    disable_inner(&app, &state);
    save_settings(
        &app,
        &HotkeySettings {
            enabled: false,
            accelerator: String::new(),
        },
    );
    Ok(())
}

fn disable_inner(app: &AppHandle, state: &tauri::State<'_, HotkeyState>) {
    if let Some(previous) = state.current.lock().unwrap().take() {
        if previous.backend == "plugin" {
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            let _ = app
                .global_shortcut()
                .unregister(previous.accelerator.as_str());
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(session) = state.portal_session.lock().unwrap().take() {
            portal::close(session);
        }
    }
}

#[tauri::command]
pub fn get_global_hotkey_status(app: AppHandle) -> Result<Option<HotkeyStatus>, String> {
    let state = app.state::<HotkeyState>();
    let current = state.current.lock().unwrap().clone();
    Ok(current)
}

fn settings_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("global_hotkey.json"))
}

pub fn load_settings(app: &AppHandle) -> HotkeySettings {
    settings_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_settings(app: &AppHandle, settings: &HotkeySettings) {
    if let Some(path) = settings_path(app) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(settings) {
            let _ = std::fs::write(path, json);
        }
    }
}

/// Called once at startup: if the user previously enabled the hotkey, re-register it.
/// On Wayland, the portal typically restores a previously-bound session without
/// re-prompting the user, since the compositor remembers the grant.
pub fn restore_on_startup(app: &AppHandle) {
    let settings = load_settings(app);
    if !settings.enabled || settings.accelerator.is_empty() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = enable_inner(app, settings.accelerator).await;
    });
}

pub fn plugin_handler(
    app: &AppHandle,
    _shortcut: &tauri_plugin_global_shortcut::Shortcut,
    event: tauri_plugin_global_shortcut::ShortcutEvent,
) {
    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
        toggle_main_window(app);
    }
}
