//! Global (system-wide) hotkeys, keyed by action id.
//!
//! The app process does NOT register any hotkeys itself. A separate tiny
//! daemon (`termifaid`, bundled next to the app binary) owns the OS
//! registrations, so hotkeys keep working after the app fully quits — Cmd+Q,
//! Dock quit, even Force Quit can't take them down. The daemon watches
//! `global_hotkey.json` (written here by the Settings commands) and launches
//! or pokes the app with `--hotkey=<action>`; the single-instance plugin
//! forwards that to a running instance, otherwise a fresh launch handles it.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;

pub const ACTION_MAIN_WINDOW: &str = "main-window";
pub const ACTION_QUICK_TERMINAL: &str = "quick-terminal";

const DAEMON_BIN: &str = "com.termifai";
/// Loopback port of this process's IPC listener (set once at startup).
#[allow(dead_code)]
static IPC_PORT: std::sync::OnceLock<u16> = std::sync::OnceLock::new();

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct HotkeySettings {
    pub enabled: bool,
    /// Tauri-style accelerator syntax, e.g. "Ctrl+Shift+Space".
    pub accelerator: String,
}

/// On-disk format shared with the daemon. `actions` is keyed by action id;
/// the legacy single-hotkey format is migrated on load.
#[derive(Serialize, Deserialize, Clone, Default)]
struct HotkeySettingsFile {
    actions: HashMap<String, HotkeySettings>,
}

#[derive(Serialize, Clone)]
pub struct HotkeyStatus {
    pub enabled: bool,
    pub accelerator: String,
    pub backend: &'static str, // always "service"
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

/// macOS Dock icon visibility. When the app is cold-launched just for the
/// Quick Terminal it starts as an Accessory (no Dock icon); the first time
/// the main window is actually shown, the app becomes a Regular app again.
/// No-op elsewhere.
pub fn set_dock_visible(app: &AppHandle, visible: bool) {
    #[cfg(target_os = "macos")]
    {
        let policy = if visible {
            tauri::ActivationPolicy::Regular
        } else {
            tauri::ActivationPolicy::Accessory
        };
        let _ = app.set_activation_policy(policy);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, visible);
    }
}

fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let visible = window.is_visible().unwrap_or(false);
        if visible {
            let _ = window.hide();
        } else {
            set_dock_visible(app, true);
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

/// Routes a hotkey action (delivered by the daemon via `--hotkey=<action>`).
pub fn dispatch(app: &AppHandle, action: &str) {
    match action {
        ACTION_QUICK_TERMINAL => crate::quick_terminal::toggle(app),
        _ => toggle_main_window(app),
    }
}

/// Extracts the action from a `--hotkey=<action>` argument list.
pub fn hotkey_arg(args: &[String]) -> Option<String> {
    args.iter()
        .find_map(|arg| arg.strip_prefix("--hotkey=").map(|s| s.to_string()))
}

fn validate_action(action: &str) -> Result<(), String> {
    match action {
        ACTION_MAIN_WINDOW | ACTION_QUICK_TERMINAL => Ok(()),
        other => Err(format!("Unknown hotkey action: {other}")),
    }
}

// ── Settings file (shared contract with the daemon) ─────────────────────────

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

fn any_enabled(app: &AppHandle) -> bool {
    load_settings_file(app)
        .actions
        .values()
        .any(|s| s.enabled && !s.accelerator.is_empty())
}

// ── Daemon lifecycle ─────────────────────────────────────────────────────────

/// The bundled sidecar, next to the app executable.
fn bundled_daemon_path() -> Result<std::path::PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("no parent dir for current exe")?;
    let path = dir.join(format!("{DAEMON_BIN}{}", std::env::consts::EXE_SUFFIX));
    if path.exists() {
        Ok(path)
    } else {
        Err(format!(
            "hotkey service binary not found at {} — build termifaid",
            path.display()
        ))
    }
}

/// Installs (copies) the daemon into the app data dir and returns that path.
///
/// The daemon must NOT run from inside the .app bundle: on macOS a process
/// whose executable lives in Termifai.app shares the app's LaunchServices
/// identity, so the quit Apple Event sent to "Termifai" (Dock, AppleScript,
/// app menus) is delivered to the daemon too, and its event loop dutifully
/// exits — observed as "hotkeys die whenever the app quits". Running the
/// copy from Application Support gives it an identity of its own. The copy
/// is refreshed (size comparison, temp + rename so a running daemon isn't
/// truncated) whenever the bundled sidecar changes.
fn daemon_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let source = bundled_daemon_path()?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("bin");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let target = dir.join(format!("{DAEMON_BIN}{}", std::env::consts::EXE_SUFFIX));

    let same = match (std::fs::metadata(&source), std::fs::metadata(&target)) {
        (Ok(s), Ok(t)) => s.len() == t.len(),
        _ => false,
    };
    if !same {
        let tmp = dir.join(format!("{DAEMON_BIN}.tmp"));
        std::fs::copy(&source, &tmp).map_err(|e| format!("failed to install service: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755));
        }
        std::fs::rename(&tmp, &target).map_err(|e| format!("failed to install service: {e}"))?;
    }
    Ok(target)
}

/// Records where the app binary lives (and the IPC address/port of this running
/// instance) so the daemon can poke or launch it.
pub fn write_service_info(app: &AppHandle, supervise: bool) {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let Some(path) = app
        .path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("service.json"))
    else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let mut val = serde_json::json!({
        "app_exe": exe.to_string_lossy(),
        "supervise": supervise,
    });

    #[cfg(unix)]
    {
        if let Ok(dir) = app.path().app_data_dir() {
            let sock_path = dir.join("termifai.sock");
            val["uds_path"] = serde_json::json!(sock_path.to_string_lossy());
        }
    }
    #[cfg(not(unix))]
    {
        val["port"] = serde_json::json!(IPC_PORT.get());
    }

    let _ = std::fs::write(path, val.to_string());
}

/// Loopback IPC listener for the daemon. When the app is already running the
/// daemon delivers hotkey actions here instead of spawning a second app
/// process (which flashes a Dock icon on macOS on every press). Protocol:
/// one line "hotkey <action>\n", answered with "ok\n".
#[cfg(unix)]
fn start_ipc_listener(app: &AppHandle) {
    let socket_path = match app
        .path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("termifai.sock"))
    {
        Some(path) => path,
        None => return,
    };
    let _ = std::fs::remove_file(&socket_path);

    let listener = match std::os::unix::net::UnixListener::bind(&socket_path) {
        Ok(listener) => listener,
        Err(e) => {
            service_log(app, &format!("IPC listener UDS bind failed: {e}"));
            return;
        }
    };

    let app = app.clone();
    std::thread::spawn(move || {
        use std::io::{BufRead, BufReader, Write};
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(500)));
            let mut line = String::new();
            if BufReader::new(&stream).read_line(&mut line).is_err() {
                continue;
            }
            if let Some(action) = line.trim().strip_prefix("hotkey ") {
                let _ = stream.write_all(b"ok\n");
                dispatch(&app, action);
            }
        }
    });
}

#[cfg(not(unix))]
fn start_ipc_listener(app: &AppHandle) {
    if IPC_PORT.get().is_some() {
        return;
    }
    let listener = match std::net::TcpListener::bind("127.0.0.1:0") {
        Ok(listener) => listener,
        Err(e) => {
            service_log(app, &format!("IPC listener bind failed: {e}"));
            return;
        }
    };
    let port = match listener.local_addr() {
        Ok(addr) => addr.port(),
        Err(_) => return,
    };
    let _ = IPC_PORT.set(port);

    let app = app.clone();
    std::thread::spawn(move || {
        use std::io::{BufRead, BufReader, Write};
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(500)));
            let mut line = String::new();
            if BufReader::new(&stream).read_line(&mut line).is_err() {
                continue;
            }
            if let Some(action) = line.trim().strip_prefix("hotkey ") {
                let _ = stream.write_all(b"ok\n");
                dispatch(&app, action);
            }
        }
    });
}

/// Appends to the same hotkeyd.log the daemon writes, so the app-side spawn
/// attempts and the daemon's own lifecycle land in one timeline.
fn service_log(app: &AppHandle, message: &str) {
    let Some(path) = app
        .path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("Termifaid.log"))
    else {
        return;
    };
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        use std::io::Write;
        let _ = writeln!(file, "[{timestamp}] app: {message}");
    }
}

/// Spawns the daemon (its single-instance guard makes duplicate spawns a
/// no-op) and registers it to start at login while any hotkey is enabled.
fn ensure_daemon_running(app: &AppHandle) -> Result<(), String> {
    let path = daemon_path(app).inspect_err(|e| service_log(app, e))?;
    let mut command = std::process::Command::new(&path);
    // Own process group: a group-wide kill aimed at the app can't take the
    // service down with it.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    match command.spawn() {
        Ok(child) => service_log(
            app,
            &format!("spawned daemon pid={} from {}", child.id(), path.display()),
        ),
        Err(e) => {
            let msg = format!("failed to start hotkey service: {e}");
            service_log(app, &msg);
            return Err(msg);
        }
    }
    let _ = app.autolaunch().enable();
    Ok(())
}

// ── Commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn enable_global_hotkey(
    app: AppHandle,
    action: String,
    accelerator: String,
) -> Result<HotkeyStatus, String> {
    validate_action(&action)?;
    if accelerator.is_empty() {
        return Err("Accelerator must not be empty".to_string());
    }
    // Distinct combos per action: the daemon can only deliver one of them.
    let file = load_settings_file(&app);
    if file.actions.iter().any(|(other, s)| {
        other != &action && s.enabled && s.accelerator.eq_ignore_ascii_case(&accelerator)
    }) {
        return Err(format!(
            "'{}' is already assigned to another global hotkey — choose a different combination",
            accelerator
        ));
    }

    write_service_info(&app, true);
    save_action_settings(
        &app,
        &action,
        HotkeySettings {
            enabled: true,
            accelerator: accelerator.clone(),
        },
    );
    // The daemon picks the change up on its next sync; start it if needed.
    ensure_daemon_running(&app)?;
    Ok(HotkeyStatus {
        enabled: true,
        accelerator,
        backend: "service",
    })
}

#[tauri::command]
pub fn disable_global_hotkey(app: AppHandle, action: String) -> Result<(), String> {
    validate_action(&action)?;
    save_action_settings(
        &app,
        &action,
        HotkeySettings {
            enabled: false,
            accelerator: String::new(),
        },
    );
    // Supervision still needs the daemon, so we do not disable autostart here.
    Ok(())
}

#[tauri::command]
pub fn get_global_hotkey_status(app: AppHandle) -> Result<HashMap<String, HotkeyStatus>, String> {
    Ok(load_settings_file(&app)
        .actions
        .into_iter()
        .filter(|(_, s)| s.enabled)
        .map(|(action, s)| {
            (
                action,
                HotkeyStatus {
                    enabled: true,
                    accelerator: s.accelerator,
                    backend: "service",
                },
            )
        })
        .collect())
}

/// Called once at startup: record our binary path for the daemon and make
/// sure the daemon is alive if any hotkey is enabled (it may have been killed
/// or the settings may predate the service).
pub fn restore_on_startup(app: &AppHandle) {
    start_ipc_listener(app);
    write_service_info(app, true);
    cleanup_legacy_daemon(app);
    if any_enabled(app) {
        if let Err(e) = ensure_daemon_running(app) {
            log::warn!("{e}");
        }
    }
}

pub fn clean_quit(app: &AppHandle) {
    write_service_info(app, false);
    if !any_enabled(app) {
        let _ = app.autolaunch().disable();
    }
}

pub fn kill_daemon() {
    #[cfg(unix)]
    {
        let _ = std::process::Command::new("pkill")
            .args(["-f", "com.termifai"])
            .status();
        let _ = std::process::Command::new("pkill")
            .args(["-f", "Termifaid"])
            .status();
    }
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/IM", "com.termifai.exe", "/F"])
            .status();
        let _ = std::process::Command::new("taskkill")
            .args(["/IM", "Termifaid.exe", "/F"])
            .status();
    }
}

/// Removes the pre-rename daemon ("termifai-hotkeyd"): kill a running copy
/// and delete its installed binary so only `termifaid` remains.
fn cleanup_legacy_daemon(app: &AppHandle) {
    #[cfg(unix)]
    let _ = std::process::Command::new("pkill")
        .args(["-f", "termifai-hotkeyd"])
        .status();
    #[cfg(windows)]
    let _ = std::process::Command::new("taskkill")
        .args(["/IM", "termifai-hotkeyd.exe", "/F"])
        .status();
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = std::fs::remove_file(
            dir.join(format!("termifai-hotkeyd{}", std::env::consts::EXE_SUFFIX)),
        );
        let _ = std::fs::remove_file(
            dir.join("bin")
                .join(format!("termifai-hotkeyd{}", std::env::consts::EXE_SUFFIX)),
        );
        let _ = std::fs::remove_file(dir.join("hotkeyd.lock"));
        let _ = std::fs::remove_file(dir.join("hotkeyd.log"));
    }
}
