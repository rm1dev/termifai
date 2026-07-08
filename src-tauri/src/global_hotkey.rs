//! Global (system-wide) hotkeys, keyed by action id.
//!
//! Actions: `"main-window"` toggles the main window, `"quick-terminal"` toggles the
//! slide-in Quick Terminal panel. All actions are disabled by default. Two backends
//! depending on platform/session:
//! - Windows / macOS / Linux+X11: `tauri-plugin-global-shortcut` (OS-level RegisterHotKey /
//!   Carbon hotkey / X11 XGrabKey under the hood).
//! - Linux + Wayland: the `org.freedesktop.portal.GlobalShortcuts` XDG desktop portal, which is
//!   the only sanctioned way to get a global shortcut under Wayland's security model. Binding
//!   happens interactively — the compositor shows the user a one-time confirmation dialog the
//!   moment we ask, which is fine here because the user just clicked "enable" in Settings.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

#[cfg(target_os = "linux")]
mod portal;

pub const ACTION_MAIN_WINDOW: &str = "main-window";
pub const ACTION_QUICK_TERMINAL: &str = "quick-terminal";

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct HotkeySettings {
    pub enabled: bool,
    /// Tauri accelerator syntax, e.g. "CmdOrCtrl+Shift+Space".
    pub accelerator: String,
}

/// On-disk format. `actions` is keyed by action id; the legacy single-hotkey
/// format ({enabled, accelerator} at the top level) is migrated on load.
#[derive(Serialize, Deserialize, Clone, Default)]
struct HotkeySettingsFile {
    actions: HashMap<String, HotkeySettings>,
}

#[derive(Serialize, Clone)]
pub struct HotkeyStatus {
    pub enabled: bool,
    pub accelerator: String,
    pub backend: &'static str, // "plugin" | "portal"
}

struct ActiveHotkey {
    status: HotkeyStatus,
    /// Set for the plugin backend: the parsed shortcut's id, used by the
    /// handler to map an incoming event back to its action.
    plugin_shortcut_id: Option<u32>,
    #[cfg(target_os = "linux")]
    portal_session: Option<portal::PortalSession>,
}

#[derive(Default)]
pub struct HotkeyState {
    active: Mutex<HashMap<String, ActiveHotkey>>,
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

/// Routes a fired hotkey (from either backend) to its action.
pub fn dispatch(app: &AppHandle, action: &str) {
    match action {
        ACTION_QUICK_TERMINAL => crate::quick_terminal::toggle(app),
        _ => toggle_main_window(app),
    }
}

fn validate_action(action: &str) -> Result<(), String> {
    match action {
        ACTION_MAIN_WINDOW | ACTION_QUICK_TERMINAL => Ok(()),
        other => Err(format!("Unknown hotkey action: {other}")),
    }
}

#[tauri::command]
pub async fn enable_global_hotkey(
    app: AppHandle,
    action: String,
    accelerator: String,
) -> Result<HotkeyStatus, String> {
    validate_action(&action)?;
    enable_inner(app, action, accelerator).await
}

async fn enable_inner(
    app: AppHandle,
    action: String,
    accelerator: String,
) -> Result<HotkeyStatus, String> {
    // Each action must have a distinct combo: with a shared combo only one
    // registration can exist, so the other action would silently never fire.
    {
        let state = app.state::<HotkeyState>();
        let active = state.active.lock().unwrap();
        if active.iter().any(|(other, entry)| {
            other != &action && entry.status.accelerator.eq_ignore_ascii_case(&accelerator)
        }) {
            return Err(format!(
                "'{}' is already assigned to another global hotkey — choose a different combination",
                accelerator
            ));
        }
    }
    disable_inner(&app, &action);

    let active = if is_wayland() {
        #[cfg(target_os = "linux")]
        {
            let (session, effective_accelerator) =
                portal::bind(app.clone(), action.clone(), accelerator.clone())
                    .await
                    .map_err(|e| format!("Wayland global shortcut portal error: {}", e))?;
            ActiveHotkey {
                status: HotkeyStatus {
                    enabled: true,
                    accelerator: effective_accelerator,
                    backend: "portal",
                },
                plugin_shortcut_id: None,
                portal_session: Some(session),
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            unreachable!("is_wayland() is only true on linux")
        }
    } else {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        let shortcut: tauri_plugin_global_shortcut::Shortcut = accelerator
            .parse()
            .map_err(|e| format!("Invalid accelerator '{}': {}", accelerator, e))?;
        let shortcut_id = shortcut.id();
        app.global_shortcut()
            .register(shortcut)
            .map_err(|e| format!("Failed to register global shortcut: {}", e))?;
        ActiveHotkey {
            status: HotkeyStatus {
                enabled: true,
                accelerator: accelerator.clone(),
                backend: "plugin",
            },
            plugin_shortcut_id: Some(shortcut_id),
            #[cfg(target_os = "linux")]
            portal_session: None,
        }
    };

    let status = active.status.clone();
    {
        let state = app.state::<HotkeyState>();
        state.active.lock().unwrap().insert(action.clone(), active);
    }
    save_action_settings(
        &app,
        &action,
        HotkeySettings {
            enabled: true,
            accelerator: status.accelerator.clone(),
        },
    );
    Ok(status)
}

#[tauri::command]
pub fn disable_global_hotkey(app: AppHandle, action: String) -> Result<(), String> {
    validate_action(&action)?;
    disable_inner(&app, &action);
    save_action_settings(
        &app,
        &action,
        HotkeySettings {
            enabled: false,
            accelerator: String::new(),
        },
    );
    Ok(())
}

fn disable_inner(app: &AppHandle, action: &str) {
    let state = app.state::<HotkeyState>();
    let previous = state.active.lock().unwrap().remove(action);
    if let Some(previous) = previous {
        if previous.status.backend == "plugin" {
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            let _ = app
                .global_shortcut()
                .unregister(previous.status.accelerator.as_str());
        }
        #[cfg(target_os = "linux")]
        if let Some(session) = previous.portal_session {
            portal::close(session);
        }
    }
}

#[tauri::command]
pub fn get_global_hotkey_status(app: AppHandle) -> Result<HashMap<String, HotkeyStatus>, String> {
    let state = app.state::<HotkeyState>();
    let active = state.active.lock().unwrap();
    Ok(active
        .iter()
        .map(|(action, entry)| (action.clone(), entry.status.clone()))
        .collect())
}

fn settings_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("global_hotkey.json"))
}

fn load_settings_file(app: &AppHandle) -> HotkeySettingsFile {
    let Some(contents) = settings_path(app).and_then(|p| std::fs::read_to_string(p).ok()) else {
        return HotkeySettingsFile::default();
    };
    if let Ok(file) = serde_json::from_str::<HotkeySettingsFile>(&contents) {
        return file;
    }
    // Legacy single-hotkey format: treat it as the main-window action.
    if let Ok(legacy) = serde_json::from_str::<HotkeySettings>(&contents) {
        let mut actions = HashMap::new();
        actions.insert(ACTION_MAIN_WINDOW.to_string(), legacy);
        return HotkeySettingsFile { actions };
    }
    HotkeySettingsFile::default()
}

fn save_action_settings(app: &AppHandle, action: &str, settings: HotkeySettings) {
    let mut file = load_settings_file(app);
    file.actions.insert(action.to_string(), settings);
    if let Some(path) = settings_path(app) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(&file) {
            let _ = std::fs::write(path, json);
        }
    }
}

/// Called once at startup: re-register every previously enabled hotkey.
/// On Wayland, the portal typically restores a previously-bound session without
/// re-prompting the user, since the compositor remembers the grant.
pub fn restore_on_startup(app: &AppHandle) {
    let file = load_settings_file(app);
    for (action, settings) in file.actions {
        if !settings.enabled || settings.accelerator.is_empty() {
            continue;
        }
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = enable_inner(app, action, settings.accelerator).await;
        });
    }
}

pub fn plugin_handler(
    app: &AppHandle,
    shortcut: &tauri_plugin_global_shortcut::Shortcut,
    event: tauri_plugin_global_shortcut::ShortcutEvent,
) {
    if event.state() != tauri_plugin_global_shortcut::ShortcutState::Pressed {
        return;
    }
    let action = {
        let state = app.state::<HotkeyState>();
        let active = state.active.lock().unwrap();
        active
            .iter()
            .find(|(_, entry)| entry.plugin_shortcut_id == Some(shortcut.id()))
            .map(|(action, _)| action.clone())
    };
    if let Some(action) = action {
        dispatch(app, &action);
    }
}
