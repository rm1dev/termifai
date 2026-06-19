mod hosts;
mod port_forwarding;
mod pty_manager;
mod ssh_keys;

use hosts::{
    Host, HostGroup, HostsVault, SaveHostGroupRequest, SaveHostRequest, TestHostConnectionRequest,
    TestHostConnectionResult,
};
use port_forwarding::{
    PortForwardRule, SavePortForwardRequest, TunnelManagerState, TunnelStatus,
};
use pty_manager::{PtyManager, TabInfo};
use ssh_keys::{GenerateSshKeyRequest, ImportSshKeyRequest, SshKey};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_window_state::StateFlags;

static WINDOW_COUNTER: AtomicU64 = AtomicU64::new(0);

struct AppState {
    pty_manager: Mutex<PtyManager>,
    tunnel_manager: TunnelManagerState,
}

#[tauri::command]
fn create_session(
    app: tauri::AppHandle,
    state: State<AppState>,
    cwd: String,
    initial_command: Option<String>,
    initial_password: Option<String>,
    ready_marker: Option<String>,
) -> Result<TabInfo, String> {
    let manager = state.pty_manager.lock().unwrap();
    manager.create_session(
        &app,
        &cwd,
        initial_command.as_deref(),
        initial_password.as_deref(),
        ready_marker.as_deref(),
    )
}

#[tauri::command]
fn write_to_session(
    state: State<AppState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let manager = state.pty_manager.lock().unwrap();
    manager.write_to_session(&session_id, &data)
}

#[tauri::command]
fn resize_session(
    state: State<AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let manager = state.pty_manager.lock().unwrap();
    manager.resize_session(&session_id, cols, rows)
}

#[tauri::command]
fn close_session(state: State<AppState>, session_id: String) -> Result<(), String> {
    let manager = state.pty_manager.lock().unwrap();
    manager.close_session(&session_id)
}

#[tauri::command]
fn new_window(app: tauri::AppHandle) -> Result<(), String> {
    let count = WINDOW_COUNTER.fetch_add(1, Ordering::SeqCst) + 1;
    let label = format!("window-{}", count);

    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title("Termifai")
        .inner_size(800.0, 600.0)
        .min_inner_size(800.0, 600.0)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::Position::Logical(tauri::LogicalPosition::new(
            12.0, 16.0,
        )))
        .build()
        .map_err(|e| format!("Failed to create window: {}", e))?;

    Ok(())
}

#[tauri::command]
fn open_settings_window(app: tauri::AppHandle) -> Result<(), String> {
    open_settings_window_inner(&app)
}

#[tauri::command]
fn list_ssh_keys(app: tauri::AppHandle) -> Result<Vec<SshKey>, String> {
    ssh_keys::list_ssh_keys(&app)
}

#[tauri::command]
fn generate_ssh_key(
    app: tauri::AppHandle,
    request: GenerateSshKeyRequest,
) -> Result<SshKey, String> {
    ssh_keys::generate_ssh_key(&app, request)
}

#[tauri::command]
fn import_ssh_key(app: tauri::AppHandle, request: ImportSshKeyRequest) -> Result<SshKey, String> {
    ssh_keys::import_ssh_key(&app, request)
}

#[tauri::command]
fn remove_ssh_keys(app: tauri::AppHandle, ids: Vec<String>) -> Result<(), String> {
    ssh_keys::remove_ssh_keys(&app, ids)
}

#[tauri::command]
fn list_hosts(app: tauri::AppHandle) -> Result<HostsVault, String> {
    hosts::list_hosts(&app)
}

#[tauri::command]
fn save_host(app: tauri::AppHandle, request: SaveHostRequest) -> Result<Host, String> {
    hosts::save_host(&app, request)
}

#[tauri::command]
fn remove_hosts(app: tauri::AppHandle, ids: Vec<String>) -> Result<(), String> {
    hosts::remove_hosts(&app, ids)
}

#[tauri::command]
fn save_host_group(
    app: tauri::AppHandle,
    request: SaveHostGroupRequest,
) -> Result<HostGroup, String> {
    hosts::save_host_group(&app, request)
}

#[tauri::command]
fn remove_host_group(app: tauri::AppHandle, id: String) -> Result<(), String> {
    hosts::remove_host_group(&app, id)
}

#[tauri::command]
fn test_host_connection(
    app: tauri::AppHandle,
    request: TestHostConnectionRequest,
) -> Result<TestHostConnectionResult, String> {
    hosts::test_host_connection(&app, request)
}

#[tauri::command]
fn list_port_forwards(app: tauri::AppHandle) -> Result<Vec<PortForwardRule>, String> {
    port_forwarding::list_port_forwards(&app)
}

#[tauri::command]
fn save_port_forward(
    app: tauri::AppHandle,
    request: SavePortForwardRequest,
) -> Result<PortForwardRule, String> {
    port_forwarding::save_port_forward(&app, request)
}

#[tauri::command]
fn remove_port_forwards(
    app: tauri::AppHandle,
    state: State<AppState>,
    ids: Vec<String>,
) -> Result<(), String> {
    port_forwarding::remove_port_forwards(&app, &state.tunnel_manager, ids)
}

#[tauri::command]
fn start_tunnel(
    app: tauri::AppHandle,
    state: State<AppState>,
    rule_id: String,
) -> Result<TunnelStatus, String> {
    port_forwarding::start_tunnel(&app, &state.tunnel_manager, rule_id)
}

#[tauri::command]
fn stop_tunnel(state: State<AppState>, rule_id: String) -> Result<TunnelStatus, String> {
    port_forwarding::stop_tunnel(&state.tunnel_manager, rule_id)
}

#[tauri::command]
fn get_tunnel_statuses(
    state: State<AppState>,
    rule_ids: Vec<String>,
) -> Vec<TunnelStatus> {
    port_forwarding::get_tunnel_statuses(&state.tunnel_manager, rule_ids)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::all())
                .build(),
        )
        .manage(AppState {
            pty_manager: Mutex::new(PtyManager::new()),
            tunnel_manager: port_forwarding::new_tunnel_manager(),
        })
        .invoke_handler(tauri::generate_handler![
            create_session,
            write_to_session,
            resize_session,
            close_session,
            new_window,
            open_settings_window,
            list_ssh_keys,
            generate_ssh_key,
            import_ssh_key,
            remove_ssh_keys,
            list_hosts,
            save_host,
            remove_hosts,
            save_host_group,
            remove_host_group,
            test_host_connection,
            list_port_forwards,
            save_port_forward,
            remove_port_forwards,
            start_tunnel,
            stop_tunnel,
            get_tunnel_statuses,
        ])
        .setup(|app| {
            // Build custom application menu
            let new_terminal = MenuItemBuilder::with_id("new-terminal", "New Terminal")
                .accelerator("CmdOrCtrl+T")
                .build(app)?;
            let settings = MenuItemBuilder::with_id("open-settings", "Settings...")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;

            let file_menu = SubmenuBuilder::new(app, "File")
                .item(&new_terminal)
                .item(&settings)
                .separator()
                .item(&PredefinedMenuItem::close_window(app, None)?)
                .build()?;

            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;

            let window_menu = SubmenuBuilder::new(app, "Window")
                .minimize()
                .maximize()
                .separator()
                .fullscreen()
                .build()?;

            let menu = MenuBuilder::new(app)
                .item(&file_menu)
                .item(&edit_menu)
                .item(&window_menu)
                .build()?;

            app.set_menu(menu)?;

            // Handle custom menu events
            let handle = app.handle().clone();
            app.on_menu_event(move |_app_handle, event| match event.id().as_ref() {
                "new-terminal" => {
                    let _ = handle.emit("menu-new-terminal", ());
                }
                "open-settings" => {
                    let _ = open_settings_window_inner(&handle);
                }
                _ => {}
            });

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Shared logic for opening the settings window (used by both command and menu event).
fn open_settings_window_inner(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        window
            .set_focus()
            .map_err(|e| format!("Failed to focus settings window: {}", e))?;
        return Ok(());
    }

    WebviewWindowBuilder::new(
        app,
        "settings",
        WebviewUrl::App("index.html?window=settings".into()),
    )
    .title("Settings")
    .inner_size(800.0, 600.0)
    .min_inner_size(800.0, 600.0)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .minimizable(false)
    .maximizable(false)
    .build()
    .map_err(|e| format!("Failed to create settings window: {}", e))?;

    Ok(())
}
