//! Termifai hotkey service.
//!
//! A tiny standalone daemon that owns the *global hotkey* registrations so
//! they keep working when the main app is completely closed (Cmd+Q, Dock
//! quit, Force Quit — none of them matter, this is a separate process).
//!
//! - Reads the same `global_hotkey.json` the app's Settings UI writes, and
//!   re-syncs every couple of seconds, so enabling/disabling/rebinding in the
//!   app takes effect here without any IPC.
//! - On a hotkey press it launches the app binary (recorded by the app in
//!   `service.json`) with `--hotkey=<action>`. If the app is already running,
//!   its single-instance plugin forwards the argument to the live process;
//!   if not, a fresh instance starts and performs the action.
//! - Exits by itself once every hotkey is disabled.
//! - Backends: `global-hotkey` (macOS / Windows / Linux-X11) or the
//!   `org.freedesktop.portal.GlobalShortcuts` XDG portal (Linux-Wayland).
#![cfg_attr(windows, windows_subsystem = "windows")]

use serde::Deserialize;
use std::collections::HashMap;
use std::path::PathBuf;

#[cfg(target_os = "linux")]
mod portal;

const APP_IDENTIFIER: &str = "com.termifai";
const SYNC_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);

#[derive(Deserialize, Clone, Default)]
struct HotkeySettings {
    enabled: bool,
    accelerator: String,
}

#[derive(Deserialize, Default)]
struct HotkeySettingsFile {
    actions: HashMap<String, HotkeySettings>,
}

#[derive(Deserialize)]
struct ServiceInfo {
    app_exe: String,
    #[serde(default)]
    port: Option<u16>,
    #[serde(default)]
    uds_path: Option<String>,
    #[serde(default)]
    supervise: bool,
}

fn app_data_dir() -> Option<PathBuf> {
    // Mirrors Tauri's app_data_dir: data_dir()/<identifier> on every platform.
    dirs::data_dir().map(|d| d.join(APP_IDENTIFIER))
}

/// Appends a timestamped line to hotkeyd.log in the app data dir. The daemon
/// runs headless (spawned by the app or by login autostart), so a log file is
/// the only way to see what it did.
pub fn log_line(message: &str) {
    let Some(path) = app_data_dir().map(|d| d.join("termifaid.log")) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        use std::io::Write;
        let _ = writeln!(file, "[{timestamp}] {message}");
    }
}

/// Enabled actions → accelerator, from the file the app's Settings UI writes.
fn load_enabled_actions() -> HashMap<String, String> {
    let Some(path) = app_data_dir().map(|d| d.join("global_hotkey.json")) else {
        return HashMap::new();
    };
    let Ok(contents) = std::fs::read_to_string(path) else {
        return HashMap::new();
    };
    let file: HotkeySettingsFile = serde_json::from_str(&contents).unwrap_or_default();
    file.actions
        .into_iter()
        .filter(|(_, s)| s.enabled && !s.accelerator.is_empty())
        .map(|(action, s)| (action, s.accelerator))
        .collect()
}

fn is_app_alive(info: &ServiceInfo) -> bool {
    let timeout = std::time::Duration::from_millis(400);
    #[cfg(unix)]
    {
        if let Some(ref uds_path) = info.uds_path {
            if let Ok(stream) = std::os::unix::net::UnixStream::connect(uds_path) {
                let _ = stream.set_read_timeout(Some(timeout));
                let _ = stream.set_write_timeout(Some(timeout));
                return true;
            }
        }
    }
    if let Some(port) = info.port {
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        if std::net::TcpStream::connect_timeout(&addr, timeout).is_ok() {
            return true;
        }
    }
    false
}

fn spawn_app(app_exe: &str, args: &[&str]) -> std::io::Result<std::process::Child> {
    #[cfg(target_os = "macos")]
    {
        let exe_path = std::path::Path::new(app_exe);
        if let Some(app_bundle) = exe_path.parent().and_then(|p| p.parent()).and_then(|p| p.parent()) {
            if app_bundle.extension().map_or(false, |ext| ext == "app") {
                let mut cmd_args = vec!["-n", "-a", app_bundle.to_str().unwrap_or(app_exe), "--args"];
                cmd_args.extend(args);
                return std::process::Command::new("open")
                    .args(&cmd_args)
                    .spawn();
            }
        }
    }

    std::process::Command::new(app_exe)
        .args(args)
        .spawn()
}

/// Launches (or pokes the running instance of) the app with the action.
fn launch_app(action: &str) {
    let Some(path) = app_data_dir().map(|d| d.join("service.json")) else {
        return;
    };
    let Some(info) = std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<ServiceInfo>(&s).ok())
    else {
        log_line("service.json missing — app never ran?");
        return;
    };

    if notify_running_app(&info, action) {
        log_line(&format!("notified running app → {action}"));
        return;
    }

    let hotkey_arg = format!("--hotkey={action}");
    let result = spawn_app(&info.app_exe, &[&hotkey_arg]);
    match result {
        Ok(_) => log_line(&format!("launched {} --hotkey={action}", info.app_exe)),
        Err(e) => log_line(&format!("failed to launch {}: {e}", info.app_exe)),
    }
}

/// Sends the action to the app's IPC listener. Returns true only after the
/// app acknowledges with "ok" — a refused/stale/hijacked port falls through
/// to a normal launch.
fn notify_running_app(info: &ServiceInfo, action: &str) -> bool {
    use std::io::{Read, Write};
    let timeout = std::time::Duration::from_millis(400);

    #[cfg(unix)]
    {
        if let Some(ref uds_path) = info.uds_path {
            if let Ok(mut stream) = std::os::unix::net::UnixStream::connect(uds_path) {
                let _ = stream.set_read_timeout(Some(timeout));
                let _ = stream.set_write_timeout(Some(timeout));
                if stream.write_all(format!("hotkey {action}\n").as_bytes()).is_ok() {
                    let mut buf = [0u8; 4];
                    return matches!(stream.read(&mut buf), Ok(n) if n >= 2 && &buf[..2] == b"ok");
                }
            }
        }
    }

    if let Some(port) = info.port {
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        if let Ok(mut stream) = std::net::TcpStream::connect_timeout(&addr, timeout) {
            let _ = stream.set_read_timeout(Some(timeout));
            let _ = stream.set_write_timeout(Some(timeout));
            if stream.write_all(format!("hotkey {action}\n").as_bytes()).is_ok() {
                let mut buf = [0u8; 4];
                return matches!(stream.read(&mut buf), Ok(n) if n >= 2 && &buf[..2] == b"ok");
            }
        }
    }
    false
}

#[allow(dead_code)]
fn is_wayland() -> bool {
    cfg!(target_os = "linux")
        && (std::env::var("XDG_SESSION_TYPE")
            .map(|v| v.eq_ignore_ascii_case("wayland"))
            .unwrap_or(false)
            || std::env::var("WAYLAND_DISPLAY").is_ok())
}

/// Identifier for the single-instance guard. On unix the crate treats this as
/// a *file path* (flock on macOS, abstract socket name on Linux) — a bare
/// name would land in the CWD, which is `/` (read-only) when we're spawned by
/// the installed app, so use an absolute path in the app data dir. On Windows
/// it's a mutex name, where backslashes are illegal, so keep the bare name.
fn instance_lock_name() -> String {
    #[cfg(windows)]
    {
        "termifaid".to_string()
    }
    #[cfg(not(windows))]
    {
        let dir = app_data_dir().unwrap_or_else(std::env::temp_dir);
        let _ = std::fs::create_dir_all(&dir);
        dir.join("termifaid.lock").to_string_lossy().into_owned()
    }
}

fn get_supervise() -> bool {
    let Some(path) = app_data_dir().map(|d| d.join("service.json")) else {
        return false;
    };
    let Ok(contents) = std::fs::read_to_string(path) else {
        return false;
    };
    let Ok(info) = serde_json::from_str::<ServiceInfo>(&contents) else {
        return false;
    };
    info.supervise
}

struct SupervisorState {
    last_spawn_time: Option<std::time::Instant>,
    consecutive_failures: u32,
}

impl SupervisorState {
    fn new() -> Self {
        Self {
            last_spawn_time: None,
            consecutive_failures: 0,
        }
    }

    fn tick(&mut self) -> bool {
        let Some(path) = app_data_dir().map(|d| d.join("service.json")) else {
            return false;
        };
        let Ok(contents) = std::fs::read_to_string(path) else {
            return false;
        };
        let Ok(info) = serde_json::from_str::<ServiceInfo>(&contents) else {
            return false;
        };

        if !info.supervise {
            return false;
        }

        if is_app_alive(&info) {
            self.consecutive_failures = 0;
            return true;
        }

        let now = std::time::Instant::now();
        let backoff_secs = match self.consecutive_failures {
            0 => 5,
            1 => 10,
            2 => 20,
            3 => 40,
            _ => 60,
        };

        if let Some(last_spawn) = self.last_spawn_time {
            if now.duration_since(last_spawn) < std::time::Duration::from_secs(backoff_secs) {
                return true;
            }
        }

        log_line(&format!(
            "supervision alert: app is dead! spawning background instance (consecutive failures={})",
            self.consecutive_failures
        ));
        self.last_spawn_time = Some(now);
        self.consecutive_failures += 1;

        let result = spawn_app(&info.app_exe, &["--background"]);
        match result {
            Ok(_) => log_line(&format!("spawned fallback: {} --background", info.app_exe)),
            Err(e) => log_line(&format!("failed to spawn fallback: {e}")),
        }

        true
    }
}

fn main() {
    log_line("daemon starting");
    // One daemon per user session; a second launch just exits.
    let instance = match single_instance::SingleInstance::new(&instance_lock_name()) {
        Ok(instance) => instance,
        Err(e) => {
            log_line(&format!("single-instance guard failed: {e}"));
            return;
        }
    };
    if !instance.is_single() {
        log_line("another daemon is already running — exiting");
        return;
    }

    let actions = load_enabled_actions();
    let supervise = get_supervise();
    if actions.is_empty() && !supervise {
        log_line("no enabled hotkeys and supervise is false — exiting");
        return;
    }
    log_line(&format!("enabled actions: {:?}", actions));

    #[cfg(target_os = "linux")]
    if is_wayland() {
        portal::run();
        return;
    }

    run_global_hotkey_backend();
}

/// macOS / Windows / Linux-X11 backend: OS-level hotkey registration via the
/// `global-hotkey` crate. Needs a run loop on the main thread (Carbon events
/// on macOS, a message pump on Windows), which `tao` provides.
fn run_global_hotkey_backend() {
    use global_hotkey::{hotkey::HotKey, GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState};
    use std::sync::{Arc, Mutex};
    use tao::event_loop::{ControlFlow, EventLoop};

    #[allow(unused_mut)]
    let mut event_loop = EventLoop::new();
    // Background service: no Dock icon, and don't act on app-level quit
    // Apple Events meant for the main app.
    #[cfg(target_os = "macos")]
    {
        use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};
        event_loop.set_activation_policy(ActivationPolicy::Accessory);
    }
    let manager = GlobalHotKeyManager::new().expect("failed to init hotkey manager");

    // hotkey id → action, shared with the event callback.
    let id_to_action: Arc<Mutex<HashMap<u32, String>>> = Arc::new(Mutex::new(HashMap::new()));
    // action → (accelerator, hotkey) currently registered.
    let mut registered: HashMap<String, (String, HotKey)> = HashMap::new();

    {
        let id_to_action = Arc::clone(&id_to_action);
        GlobalHotKeyEvent::set_event_handler(Some(move |event: GlobalHotKeyEvent| {
            if event.state() == HotKeyState::Pressed {
                let action = id_to_action.lock().unwrap().get(&event.id()).cloned();
                if let Some(action) = action {
                    log_line(&format!("hotkey pressed → {action}"));
                    launch_app(&action);
                }
            }
        }));
    }

    let sync = {
        let id_to_action = Arc::clone(&id_to_action);
        move |manager: &GlobalHotKeyManager,
              registered: &mut HashMap<String, (String, HotKey)>|
              -> bool {
            let desired = load_enabled_actions();
            // Unregister actions that disappeared or changed accelerator.
            let stale: Vec<String> = registered
                .iter()
                .filter(|(action, (accel, _))| desired.get(*action) != Some(accel))
                .map(|(action, _)| action.clone())
                .collect();
            for action in stale {
                if let Some((_, hotkey)) = registered.remove(&action) {
                    let _ = manager.unregister(hotkey);
                    id_to_action.lock().unwrap().remove(&hotkey.id());
                }
            }
            // Register new/changed ones.
            for (action, accel) in &desired {
                if registered.contains_key(action) {
                    continue;
                }
                match parse_accelerator(accel) {
                    Some(hotkey) => match manager.register(hotkey) {
                        Ok(()) => {
                            log_line(&format!("registered '{accel}' for {action}"));
                            id_to_action
                                .lock()
                                .unwrap()
                                .insert(hotkey.id(), action.clone());
                            registered.insert(action.clone(), (accel.clone(), hotkey));
                        }
                        Err(e) => log_line(&format!("failed to register '{accel}': {e}")),
                    },
                    None => log_line(&format!("cannot parse accelerator '{accel}'")),
                }
            }
            !desired.is_empty()
        }
    };

    sync(&manager, &mut registered);

    let mut next_sync = std::time::Instant::now() + SYNC_INTERVAL;
    let mut supervisor = SupervisorState::new();
    event_loop.run(move |_event, _target, control_flow| {
        if std::time::Instant::now() >= next_sync {
            next_sync = std::time::Instant::now() + SYNC_INTERVAL;
            let has_hotkeys = sync(&manager, &mut registered);
            let supervise = get_supervise();
            if !has_hotkeys && !supervise {
                log_line("no enabled hotkeys and supervise is false — exiting");
                *control_flow = ControlFlow::Exit;
                return;
            }
            if supervise {
                supervisor.tick();
            }
        }
        *control_flow = ControlFlow::WaitUntil(next_sync);
    });
}

/// Parses the accelerator syntax the app's Settings UI produces
/// ("Ctrl+Shift+Space", "Super+Alt+Q", "Ctrl+Shift+`") into a `HotKey`.
#[cfg(any(not(target_os = "linux"), target_os = "linux"))]
fn parse_accelerator(accelerator: &str) -> Option<global_hotkey::hotkey::HotKey> {
    use global_hotkey::hotkey::{Code, HotKey, Modifiers};

    let mut mods = Modifiers::empty();
    let mut code: Option<Code> = None;
    for part in accelerator.split('+') {
        match part.to_ascii_lowercase().as_str() {
            "ctrl" | "control" | "cmdorctrl" | "commandorcontrol" => {
                // CmdOrCtrl resolves per-platform like Tauri's accelerators.
                if cfg!(target_os = "macos")
                    && matches!(
                        part.to_ascii_lowercase().as_str(),
                        "cmdorctrl" | "commandorcontrol"
                    )
                {
                    mods |= Modifiers::META;
                } else {
                    mods |= Modifiers::CONTROL;
                }
            }
            "shift" => mods |= Modifiers::SHIFT,
            "alt" | "option" => mods |= Modifiers::ALT,
            "super" | "cmd" | "command" | "meta" => mods |= Modifiers::META,
            key => code = parse_key(key),
        }
    }
    code.map(|c| HotKey::new(Some(mods), c))
}

fn parse_key(key: &str) -> Option<global_hotkey::hotkey::Code> {
    use global_hotkey::hotkey::Code;
    use std::str::FromStr;

    // Single characters come through as "Q", "9", "`", " "…
    if key.len() == 1 {
        let ch = key.chars().next().unwrap();
        return match ch {
            'a'..='z' | 'A'..='Z' => {
                Code::from_str(&format!("Key{}", ch.to_ascii_uppercase())).ok()
            }
            '0'..='9' => Code::from_str(&format!("Digit{ch}")).ok(),
            '`' => Some(Code::Backquote),
            '-' => Some(Code::Minus),
            '=' => Some(Code::Equal),
            '[' => Some(Code::BracketLeft),
            ']' => Some(Code::BracketRight),
            '\\' => Some(Code::Backslash),
            ';' => Some(Code::Semicolon),
            '\'' => Some(Code::Quote),
            ',' => Some(Code::Comma),
            '.' => Some(Code::Period),
            '/' => Some(Code::Slash),
            ' ' => Some(Code::Space),
            _ => None,
        };
    }
    let mapped = match key.to_ascii_lowercase().as_str() {
        "space" => "Space",
        "esc" | "escape" => "Escape",
        "up" => "ArrowUp",
        "down" => "ArrowDown",
        "left" => "ArrowLeft",
        "right" => "ArrowRight",
        "enter" | "return" => "Enter",
        "tab" => "Tab",
        "backspace" => "Backspace",
        "delete" => "Delete",
        "home" => "Home",
        "end" => "End",
        "pageup" => "PageUp",
        "pagedown" => "PageDown",
        other => {
            // F-keys and anything already in `Code` syntax ("F1", "Backquote").
            return Code::from_str(&capitalize(other)).ok();
        }
    };
    Code::from_str(mapped).ok()
}

fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(first) => first.to_ascii_uppercase().to_string() + chars.as_str(),
        None => String::new(),
    }
}
