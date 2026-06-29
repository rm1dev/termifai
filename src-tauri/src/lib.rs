mod hosts;
mod port_forwarding;
mod pty_manager;
mod sftp;
mod snippets;
mod ssh_keys;

use hosts::{
    Host, HostGroup, HostsVault, SaveHostGroupRequest, SaveHostRequest, TestHostConnectionRequest,
    TestHostConnectionResult,
};
use port_forwarding::{
    PortForwardRule, SavePortForwardRequest, TunnelManagerState, TunnelStatus,
};
use pty_manager::{PtyManager, TabInfo};
use sftp::{LocalFileEntry, RemoteFileEntry, SftpConnectRequest, SftpManager, SftpSessionInfo, TransferProgress};
use serde::Serialize;

#[derive(Serialize, Clone)]
struct SftpConnectEvent {
    stage: String,
    message: String,
}

#[derive(Serialize, Clone)]
struct SftpConnectDone {
    ok: bool,
    remote_path: Option<String>,
    error: Option<String>,
}

#[derive(Serialize, Clone)]
struct SftpTransferDone {
    ok: bool,
    error: Option<String>,
}
use snippets::{SaveSnippetRequest, Snippet};
use ssh_keys::{GenerateSshKeyRequest, ImportSshKeyRequest, SshKey};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
#[cfg(target_os = "macos")]
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_window_state::StateFlags;

static WINDOW_COUNTER: AtomicU64 = AtomicU64::new(0);

struct AppState {
    pty_manager: Mutex<PtyManager>,
    tunnel_manager: TunnelManagerState,
    sftp_manager: Mutex<SftpManager>,
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

    let app_clone = app.clone();
    app.run_on_main_thread(move || {
        let mut builder =
            WebviewWindowBuilder::new(&app_clone, &label, WebviewUrl::App("index.html".into()))
                .title("Termifai")
                .inner_size(800.0, 600.0)
                .min_inner_size(800.0, 600.0);

        #[cfg(target_os = "macos")]
        {
            builder = builder
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true)
                .traffic_light_position(tauri::Position::Logical(tauri::LogicalPosition::new(
                    12.0, 16.0,
                )));
        }

        #[cfg(any(target_os = "windows", target_os = "linux"))]
        {
            builder = builder.decorations(false);
        }

        let _ = builder.build();
    })
    .map_err(|e| format!("Failed to dispatch to main thread: {:?}", e))?;

    Ok(())
}

#[tauri::command]
fn get_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
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
async fn test_host_connection(
    app: tauri::AppHandle,
    request: TestHostConnectionRequest,
) -> Result<TestHostConnectionResult, String> {
    tauri::async_runtime::spawn_blocking(move || hosts::test_host_connection(&app, request))
        .await
        .map_err(|e| format!("Task error: {}", e))?
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

#[tauri::command]
fn list_snippets(app: tauri::AppHandle) -> Result<Vec<Snippet>, String> {
    snippets::list_snippets(&app)
}

#[tauri::command]
fn save_snippet(app: tauri::AppHandle, request: SaveSnippetRequest) -> Result<Snippet, String> {
    snippets::save_snippet(&app, request)
}

#[tauri::command]
fn remove_snippets(app: tauri::AppHandle, ids: Vec<String>) -> Result<(), String> {
    snippets::remove_snippets(&app, ids)
}

#[tauri::command]
fn run_snippet_script(
    app: tauri::AppHandle,
    state: State<AppState>,
    session_id: String,
    title: String,
    script: String,
) -> Result<(), String> {
    // Emit title message directly to xterm via event (bypasses PTY — user sees the title)
    let title_msg = format!(
        "\x1b[38;2;255;207;107m▶ {} script started...\x1b[0m\r\n",
        title
    );
    let event_name = format!("term:{}:output", session_id);
    let _ = app.emit(&event_name, title_msg);

    // Strategy for hiding the command from terminal display AND supporting remote SSH:
    // We cannot write to the remote filesystem from Rust directly.
    // Instead we use heredoc via PTY to write the script to /tmp on the target machine,
    // then execute it. The heredoc content is NOT echoed by the shell (only the cat command is).
    // A wrapper script erases the visible command line with ANSI escapes.
    //
    // The full sequence sent to PTY:
    //   printf '\033[1A\033[2K\r' && cat > /tmp/termifai_s_ID.sh << 'TERMIFAI_SNIPPET_EOF'
    //   [script content - not echoed by shell]
    //   TERMIFAI_SNIPPET_EOF
    //   chmod +x /tmp/termifai_s_ID.sh && bash /tmp/termifai_s_ID.sh; rm -f /tmp/termifai_s_ID.sh

    let script_id = uuid::Uuid::new_v4().to_string().replace('-', "");
    let script_id = &script_id[..8];
    let tmp_path = format!("/tmp/termifai_s_{}.sh", script_id);
    let eof_marker = "TERMIFAI_SNIPPET_EOF";

    // Build the full payload to send to PTY
    // Line 1: erase the echoed command + write script via heredoc
    // Line 2..N: script content (shell does NOT echo heredoc body)
    // Last line: EOF marker
    // Then: chmod + execute + cleanup
    let payload = format!(
        " printf '\\033[1A\\033[2K\\r' && cat > {path} << '{eof}'\r{script}\r{eof}\rchmod +x {path} && bash {path}; rm -f {path}\r",
        path = tmp_path,
        eof = eof_marker,
        script = script.replace('\r', ""),
    );

    let manager = state.pty_manager.lock().unwrap();
    manager.write_to_session(&session_id, &payload)
}

#[tauri::command]
async fn sftp_connect_from_host(
    app: tauri::AppHandle,
    host_id: String,
    session_id: String,
) -> Result<(), String> {
    // Resolve credentials synchronously (fast local file reads) before spawning
    let vault = hosts::list_hosts(&app)?;
    let host = vault
        .hosts
        .into_iter()
        .find(|h| h.id == host_id)
        .ok_or_else(|| format!("Host '{}' not found", host_id))?;

    let private_key_path = if let Some(key_id) = &host.ssh_key_id {
        let keys = ssh_keys::list_ssh_keys(&app)?;
        keys.into_iter()
            .find(|k| &k.id == key_id)
            .map(|k| k.private_key_path)
    } else {
        None
    };

    let request = SftpConnectRequest {
        session_id: session_id.clone(),
        hostname: host.hostname.clone(),
        port: host.port,
        username: host.user.clone(),
        password: host.password.clone(),
        private_key_path,
        default_remote_path: host.default_sftp_path.clone(),
    };

    // Spawn blocking work in background — command returns immediately so the
    // loading screen appears before any network round-trips begin.
    let app_bg = app.clone();
    tokio::spawn(async move {
        let app_inner = app_bg.clone();
        let sid = session_id.clone();

        let result = tokio::task::spawn_blocking(move || {
            let app_log = app_inner.clone();
            let sid_log = sid.clone();
            let log = move |stage: &str, msg: &str| {
                let _ = app_log.emit(
                    &format!("sftp:{}:connect", sid_log),
                    SftpConnectEvent { stage: stage.to_string(), message: msg.to_string() },
                );
            };
            let state = app_inner.state::<AppState>();
            let mut manager = state.sftp_manager.lock().unwrap();
            manager.connect(request, log)
        })
        .await;

        let done = match result {
            Ok(Ok(info)) => SftpConnectDone { ok: true, remote_path: Some(info.remote_path), error: None },
            Ok(Err(e)) => SftpConnectDone { ok: false, remote_path: None, error: Some(e) },
            Err(e) => SftpConnectDone { ok: false, remote_path: None, error: Some(format!("Task panic: {e}")) },
        };
        let _ = app_bg.emit(&format!("sftp:{}:done", session_id), done);
    });

    Ok(())
}

#[tauri::command]
fn sftp_list_local(path: String) -> Result<Vec<LocalFileEntry>, String> {
    sftp::list_local(&path)
}

#[tauri::command]
fn sftp_list_remote(
    state: State<AppState>,
    session_id: String,
    path: String,
) -> Result<Vec<RemoteFileEntry>, String> {
    let manager = state.sftp_manager.lock().unwrap();
    manager.list_remote(&session_id, &path)
}

#[tauri::command]
async fn sftp_download(
    app: tauri::AppHandle,
    session_id: String,
    remote_path: String,
    local_path: String,
) -> Result<(), String> {
    let app_bg = app.clone();
    let sid = session_id.clone();
    tokio::spawn(async move {
        let result = tokio::task::spawn_blocking(move || {
            let app_prog = app_bg.clone();
            let sid_prog = sid.clone();
            let state = app_bg.state::<AppState>();
            let manager = state.sftp_manager.lock().unwrap();
            manager.download_file(&sid, &remote_path, &local_path, move |progress| {
                let _ = app_prog.emit(&format!("sftp:{}:progress", sid_prog), progress);
            })
        })
        .await;
        let done = match result {
            Ok(Ok(())) => SftpTransferDone { ok: true, error: None },
            Ok(Err(e)) => SftpTransferDone { ok: false, error: Some(e) },
            Err(e) => SftpTransferDone { ok: false, error: Some(format!("Task panic: {e}")) },
        };
        let _ = app.emit(&format!("sftp:{}:transfer-done", session_id), done);
    });
    Ok(())
}

#[tauri::command]
async fn sftp_upload(
    app: tauri::AppHandle,
    session_id: String,
    local_path: String,
    remote_path: String,
) -> Result<(), String> {
    let app_bg = app.clone();
    let sid = session_id.clone();
    tokio::spawn(async move {
        let result = tokio::task::spawn_blocking(move || {
            let app_prog = app_bg.clone();
            let sid_prog = sid.clone();
            let state = app_bg.state::<AppState>();
            let manager = state.sftp_manager.lock().unwrap();
            manager.upload_file(&sid, &local_path, &remote_path, move |progress| {
                let _ = app_prog.emit(&format!("sftp:{}:progress", sid_prog), progress);
            })
        })
        .await;
        let done = match result {
            Ok(Ok(())) => SftpTransferDone { ok: true, error: None },
            Ok(Err(e)) => SftpTransferDone { ok: false, error: Some(e) },
            Err(e) => SftpTransferDone { ok: false, error: Some(format!("Task panic: {e}")) },
        };
        let _ = app.emit(&format!("sftp:{}:transfer-done", session_id), done);
    });
    Ok(())
}

#[tauri::command]
fn sftp_delete_remote(
    state: State<AppState>,
    session_id: String,
    paths: Vec<String>,
) -> Result<(), String> {
    let manager = state.sftp_manager.lock().unwrap();
    manager.delete_remote(&session_id, &paths)
}

#[tauri::command]
fn sftp_rename_remote(
    state: State<AppState>,
    session_id: String,
    from_path: String,
    to_path: String,
) -> Result<(), String> {
    let manager = state.sftp_manager.lock().unwrap();
    manager.rename_remote(&session_id, &from_path, &to_path)
}

#[tauri::command]
fn sftp_mkdir_remote(
    state: State<AppState>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let manager = state.sftp_manager.lock().unwrap();
    manager.mkdir_remote(&session_id, &path)
}

#[tauri::command]
fn sftp_disconnect(state: State<AppState>, session_id: String) -> Result<(), String> {
    let mut manager = state.sftp_manager.lock().unwrap();
    manager.disconnect(&session_id)
}

#[tauri::command]
fn sftp_stat_remote(
    state: State<AppState>,
    session_id: String,
    path: String,
) -> Result<sftp::RemoteStatResult, String> {
    let manager = state.sftp_manager.lock().unwrap();
    manager.stat_remote(&session_id, &path)
}

#[tauri::command]
fn sftp_rename_local(path: String, new_name: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    let dest = p.parent()
        .ok_or("No parent dir")?
        .join(&new_name);
    std::fs::rename(&p, &dest).map_err(|e| format!("Rename: {}", e))
}

#[tauri::command]
fn sftp_delete_local(paths: Vec<String>) -> Result<(), String> {
    for path in &paths {
        let p = std::path::Path::new(path);
        if p.is_dir() {
            std::fs::remove_dir_all(p).map_err(|e| format!("Delete dir '{}': {}", path, e))?;
        } else {
            std::fs::remove_file(p).map_err(|e| format!("Delete '{}': {}", path, e))?;
        }
    }
    Ok(())
}

#[tauri::command]
fn sftp_copy_local(paths: Vec<String>, dest_dir: String) -> Result<(), String> {
    let dest = std::path::Path::new(&dest_dir);
    for path in &paths {
        let src = std::path::Path::new(path);
        let name = src.file_name().ok_or("No file name")?;
        let target = dest.join(name);
        if src.is_dir() {
            copy_dir_all(src, &target).map_err(|e| format!("Copy dir '{}': {}", path, e))?;
        } else {
            std::fs::copy(src, &target).map_err(|e| format!("Copy '{}': {}", path, e))?;
        }
    }
    Ok(())
}

fn copy_dir_all(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &dst.join(entry.file_name()))?;
        } else {
            std::fs::copy(entry.path(), dst.join(entry.file_name()))?;
        }
    }
    Ok(())
}

#[tauri::command]
fn sftp_open_local(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    std::process::Command::new("open").arg(&path).spawn().map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open").arg(&path).spawn().map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    std::process::Command::new("cmd").args(["/c", "start", "", &path]).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn sftp_open_with_local(path: String, app: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    std::process::Command::new("open").args(["-a", &app, &path]).spawn().map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    std::process::Command::new(&app).arg(&path).spawn().map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    std::process::Command::new("cmd").args(["/c", "start", "", &app, &path]).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn sftp_chmod(
    state: State<AppState>,
    session_id: String,
    path: String,
    mode: String,
    recursive: bool,
) -> Result<(), String> {
    let manager = state.sftp_manager.lock().unwrap();
    manager.chmod(&session_id, &path, &mode, recursive)
}

#[tauri::command]
fn sftp_chown(
    state: State<AppState>,
    session_id: String,
    path: String,
    user: String,
    group: String,
    recursive: bool,
) -> Result<(), String> {
    let manager = state.sftp_manager.lock().unwrap();
    manager.chown(&session_id, &path, &user, &group, recursive)
}

#[tauri::command]
fn sftp_copy_remote(
    state: State<AppState>,
    session_id: String,
    paths: Vec<String>,
    dest_dir: String,
) -> Result<(), String> {
    let manager = state.sftp_manager.lock().unwrap();
    manager.copy_remote(&session_id, &paths, &dest_dir)
}

#[tauri::command]
fn sftp_get_users_groups(
    state: State<AppState>,
    session_id: String,
) -> Result<sftp::UsersGroups, String> {
    let manager = state.sftp_manager.lock().unwrap();
    manager.get_users_groups(&session_id)
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    StateFlags::all() & !StateFlags::VISIBLE,
                )
                .build(),
        )
        .manage(AppState {
            pty_manager: Mutex::new(PtyManager::new()),
            tunnel_manager: port_forwarding::new_tunnel_manager(),
            sftp_manager: Mutex::new(SftpManager::new()),
        })
        .invoke_handler(tauri::generate_handler![
            create_session,
            write_to_session,
            resize_session,
            close_session,
            new_window,
            get_platform,
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
            list_snippets,
            save_snippet,
            remove_snippets,
            run_snippet_script,
            sftp_connect_from_host,
            sftp_disconnect,
            sftp_download,
            sftp_upload,
            sftp_list_local,
            sftp_list_remote,
            sftp_delete_remote,
            sftp_rename_remote,
            sftp_mkdir_remote,
            sftp_stat_remote,
            sftp_chmod,
            sftp_chown,
            sftp_copy_remote,
            sftp_get_users_groups,
            sftp_rename_local,
            sftp_delete_local,
            sftp_copy_local,
            sftp_open_local,
            sftp_open_with_local,
            quit_app,
        ])
        .on_window_event(|window, event| {
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let label = window.label();
                if label == "main" || label.starts_with("window-") {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .setup(|app| {
            // On Windows: pre-allocate a hidden console so that ConPTY session creation
            // doesn't flash a black console window each time a terminal tab is opened.
            // Also set UTF-8 (codepage 65001) so ConPTY correctly interprets multi-byte
            // Unicode sequences — fixes garbled Arabic/Persian text in RTL sessions.
            #[cfg(target_os = "windows")]
            unsafe {
                use windows_sys::Win32::System::Console::{
                    AllocConsole, GetConsoleWindow, SetConsoleCP, SetConsoleOutputCP,
                };
                use windows_sys::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};
                AllocConsole();
                SetConsoleCP(65001);
                SetConsoleOutputCP(65001);
                let hwnd = GetConsoleWindow();
                if !hwnd.is_null() {
                    ShowWindow(hwnd, SW_HIDE);
                }
            }

            // On Linux and Windows, remove native decorations so the custom frontend titlebar takes over
            #[cfg(any(target_os = "linux", target_os = "windows"))]
            {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_decorations(false);
                }
            }

            // Create the settings window hidden at startup — creating it dynamically after
            // the event loop starts deadlocks on Windows because WebView2 initialization
            // requires the event loop to be free.
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
            .visible(false)
            .build()?;

            // On Linux and Windows the native menubar is replaced by a frontend hamburger menu
            #[cfg(target_os = "macos")]
            {
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
                    .separator()
                    .item(&PredefinedMenuItem::quit(app, None)?)
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
            }

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { has_visible_windows, .. } = event {
                if !has_visible_windows {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
        });
}

/// Shared logic for opening the settings window (used by both command and menu event).
fn open_settings_window_inner(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("settings")
        .ok_or_else(|| "Settings window not found".to_string())?;

    window.show().map_err(|e| format!("Failed to show settings window: {}", e))?;
    window.set_focus().map_err(|e| format!("Failed to focus settings window: {}", e))?;

    Ok(())
}
