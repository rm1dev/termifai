pub mod dashboard;
mod global_hotkey;
mod hosts;
mod port_forwarding;
mod pty_manager;
mod quick_terminal;
mod sftp;
mod snippets;
mod ssh;
mod ssh_keys;
mod sync;
mod tombstones;
mod vault;
use dashboard::DashboardManager;
use termifai_core::store;

use hosts::{
    Host, HostGroup, HostsVault, SaveHostGroupRequest, SaveHostRequest, TestHostConnectionRequest,
    TestHostConnectionResult,
};
use port_forwarding::{PortForwardRule, SavePortForwardRequest, TunnelManagerState, TunnelStatus};
use pty_manager::{PtyManager, TabInfo};
use serde::Serialize;
use sftp::{LocalFileEntry, RemoteFileEntry, SftpConnectRequest, SftpManager};

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
use global_hotkey::{disable_global_hotkey, enable_global_hotkey, get_global_hotkey_status};
use quick_terminal::{
    get_quick_terminal_info, hide_quick_terminal, quick_terminal_frontend_ready,
    resize_quick_terminal, set_quick_terminal_edge, set_quick_terminal_enabled,
    set_quick_terminal_opacity, toggle_quick_terminal,
};
use snippets::{SaveSnippetRequest, Snippet};
use ssh_keys::{GenerateSshKeyRequest, ImportSshKeyRequest, SshKey};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem};
#[cfg(target_os = "macos")]
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_window_state::StateFlags;

static WINDOW_COUNTER: AtomicU64 = AtomicU64::new(0);
static SHOULD_EXIT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

struct AppState {
    pty_manager: Mutex<PtyManager>,
    tunnel_manager: TunnelManagerState,
    sftp_manager: Mutex<SftpManager>,
    watch_handles: Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<()>>>,
    transfer_cancel_flags: Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>,
    dashboard_manager: Mutex<DashboardManager>,
    hosts_store: store::JsonStore<hosts::HostsVault>,
    port_forward_store: store::JsonStore<port_forwarding::PortForwardVault>,
    snippets_store: store::JsonStore<snippets::SnippetsVault>,
    vault_settings_store: store::JsonStore<vault::VaultSettings>,
    vault_crypto_store: store::JsonStore<vault::CryptoVault>,
    tombstones_store: store::JsonStore<tombstones::TombstonesVault>,
    sync_state_store: store::JsonStore<termifai_core::model::sync_state::SyncState>,
}

#[tauri::command]
fn create_session(
    app: tauri::AppHandle,
    state: State<AppState>,
    cwd: String,
    initial_command: Option<String>,
    host_id: Option<String>,
    ready_marker: Option<String>,
) -> Result<TabInfo, String> {
    let password = if let Some(ref h_id) = host_id {
        let vault = hosts::list_hosts(&app)?;
        let host = vault
            .hosts
            .iter()
            .find(|h| h.id == *h_id)
            .ok_or_else(|| "Host not found".to_string())?;
        hosts::decrypt_host_password(host)
    } else {
        None
    };

    let manager = state.pty_manager.lock().unwrap();
    manager.create_session(
        &app,
        &cwd,
        initial_command.as_deref(),
        password.as_deref(),
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
fn get_host_password(app: tauri::AppHandle, id: String) -> Result<Option<String>, String> {
    hosts::get_host_password(&app, &id)
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
fn vault_status(app: tauri::AppHandle) -> Result<vault::VaultStatus, String> {
    vault::op_status(&app)
}

#[tauri::command]
fn vault_init(app: tauri::AppHandle, master_password: String) -> Result<(), String> {
    vault::op_init(&app, &master_password)?;
    hosts::migrate_plaintext_passwords(&app)?;
    Ok(())
}

#[tauri::command]
fn vault_unlock(app: tauri::AppHandle, master_password: String) -> Result<(), String> {
    vault::op_unlock(&app, &master_password)?;
    hosts::migrate_plaintext_passwords(&app)?;
    Ok(())
}

#[tauri::command]
fn vault_lock(app: tauri::AppHandle) {
    vault::op_lock();
    let _ = app.emit("vault-locked", ());
}

#[tauri::command]
fn vault_change_master_password(
    app: tauri::AppHandle,
    old_password: String,
    new_password: String,
) -> Result<(), String> {
    vault::op_change_master_password(&app, &old_password, &new_password)?;
    hosts::migrate_plaintext_passwords(&app)?;
    Ok(())
}

#[tauri::command]
fn get_vault_lock_policy(app: tauri::AppHandle) -> String {
    let policy = vault::get_lock_policy(&app);
    serde_json::to_string(&policy)
        .map(|s| s.trim_matches('"').to_string())
        .unwrap_or_else(|_| "on_restart".to_string())
}

#[tauri::command]
fn set_vault_lock_policy(app: tauri::AppHandle, policy: String) -> Result<(), String> {
    let p: vault::LockPolicy = serde_json::from_str(&format!("\"{}\"", policy))
        .map_err(|_| format!("Unknown lock policy: {policy}"))?;
    vault::set_lock_policy(&app, p)
}

#[tauri::command]
fn sync_get_config(app: tauri::AppHandle) -> Result<sync::SyncStatusDto, String> {
    sync::sync_get_config(&app)
}

#[tauri::command]
async fn sync_connect_provider(app: tauri::AppHandle, provider: String) -> Result<String, String> {
    sync::sync_connect_provider(app, provider).await
}

#[tauri::command]
fn sync_set_config(
    app: tauri::AppHandle,
    request: sync::SetSyncConfigRequest,
) -> Result<(), String> {
    sync::sync_set_config(&app, request)
}

#[tauri::command]
fn sync_status(app: tauri::AppHandle) -> Result<sync::SyncStatusDto, String> {
    sync::sync_status(&app)
}

#[tauri::command]
fn sync_disconnect(app: tauri::AppHandle, delete_remote: bool) -> Result<(), String> {
    sync::sync_disconnect(&app, delete_remote)
}

#[tauri::command]
async fn sync_now(
    app: tauri::AppHandle,
    request: sync::SyncNowRequest,
) -> Result<sync::SyncNowResult, String> {
    tauri::async_runtime::spawn_blocking(move || sync::sync_now(&app, request))
        .await
        .map_err(|e| format!("Sync task error: {}", e))?
}

#[tauri::command]
async fn vault_init_from_sync(
    app: tauri::AppHandle,
    request: sync::VaultInitFromSyncRequest,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || sync::vault_init_from_sync(&app, request))
        .await
        .map_err(|e| format!("Sync task error: {}", e))?
}

#[tauri::command]
async fn sync_import_foreign(
    app: tauri::AppHandle,
    request: sync::SyncImportForeignRequest,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || sync::sync_import_foreign(&app, request))
        .await
        .map_err(|e| format!("Sync task error: {}", e))?
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
async fn start_tunnel(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    rule_id: String,
) -> Result<TunnelStatus, String> {
    port_forwarding::start_tunnel(&app, &state.tunnel_manager, rule_id).await
}

#[tauri::command]
fn stop_tunnel(state: State<AppState>, rule_id: String) -> Result<TunnelStatus, String> {
    port_forwarding::stop_tunnel(&state.tunnel_manager, rule_id)
}

#[tauri::command]
fn get_tunnel_statuses(state: State<AppState>, rule_ids: Vec<String>) -> Vec<TunnelStatus> {
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
    // The full sequence sent to PTY:
    //   printf '\033[1A\033[2K\r' && f=$(mktemp /tmp/termifai_XXXXXXXX) && cat > "$f" << 'TERMIFAI_EOF_random'
    //   [script content - not echoed by shell]
    //   TERMIFAI_EOF_random
    //   chmod +x "$f" && bash "$f"; rm -f "$f"
    //
    // The X's must be the trailing characters of the template with nothing after them —
    // BSD/macOS mktemp and busybox mktemp (used on Alpine, a supported host OS) only
    // substitute a trailing run of X's and either leave a literal "XXXXXXXX" in the
    // filename (macOS) or fail outright (busybox) if a suffix like ".sh" follows it.
    // No extension is needed since the file is executed explicitly via `bash "$f"`.

    let rand_id = uuid::Uuid::new_v4().to_string().replace('-', "");
    let rand_id = &rand_id[..8];
    let eof_marker = format!("TERMIFAI_EOF_{}", rand_id);

    // Build the full payload to send to PTY
    // Line 1: erase the echoed command + create temp file + write script via heredoc
    // Line 2..N: script content (shell does NOT echo heredoc body)
    // Last line: EOF marker
    // Then: chmod + execute + cleanup
    let payload = format!(
        " printf '\\033[1A\\033[2K\\r' && f=$(mktemp /tmp/termifai_XXXXXXXX) && cat > \"$f\" << '{eof}'\r{script}\r{eof}\rchmod +x \"$f\" && bash \"$f\"; rm -f \"$f\"\r",
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
        password: hosts::decrypt_host_password(&host),
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
                    SftpConnectEvent {
                        stage: stage.to_string(),
                        message: msg.to_string(),
                    },
                );
            };
            let state = app_inner.state::<AppState>();
            let mut manager = state.sftp_manager.lock().unwrap();
            manager.connect(request, log)
        })
        .await;

        let done = match result {
            Ok(Ok(info)) => SftpConnectDone {
                ok: true,
                remote_path: Some(info.remote_path),
                error: None,
            },
            Ok(Err(e)) => SftpConnectDone {
                ok: false,
                remote_path: None,
                error: Some(e),
            },
            Err(e) => SftpConnectDone {
                ok: false,
                remote_path: None,
                error: Some(format!("Task panic: {e}")),
            },
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
fn get_home_dir() -> Result<String, String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "Could not determine home directory".to_string())
}

#[tauri::command]
fn sftp_list_remote(
    state: State<AppState>,
    session_id: String,
    path: String,
) -> Result<Vec<RemoteFileEntry>, String> {
    let entry = {
        let manager = state.sftp_manager.lock().unwrap();
        manager.get_session(&session_id)?
    };
    let entry_guard = entry.lock().unwrap();
    entry_guard.list_remote(&path)
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
    let cancel_flag = {
        let state = app.state::<AppState>();
        let mut flags = state.transfer_cancel_flags.lock().unwrap();
        let flag = Arc::new(AtomicBool::new(false));
        flags.insert(session_id.clone(), Arc::clone(&flag));
        flag
    };
    tokio::spawn(async move {
        let result = tokio::task::spawn_blocking(move || {
            let app_prog = app_bg.clone();
            let sid_prog = sid.clone();
            let state = app_bg.state::<AppState>();
            let entry = {
                let manager = state.sftp_manager.lock().unwrap();
                manager.get_session(&sid)
            };
            match entry {
                Ok(entry_arc) => {
                    let entry_guard = entry_arc.lock().unwrap();
                    entry_guard.download_file(
                        &sid,
                        &remote_path,
                        &local_path,
                        Arc::clone(&cancel_flag),
                        move |progress| {
                            let _ = app_prog.emit(&format!("sftp:{}:progress", sid_prog), progress);
                        },
                    )
                }
                Err(e) => Err(e),
            }
        })
        .await;
        let state = app.state::<AppState>();
        state
            .transfer_cancel_flags
            .lock()
            .unwrap()
            .remove(&session_id);
        let done = match result {
            Ok(Ok(())) => SftpTransferDone {
                ok: true,
                error: None,
            },
            Ok(Err(e)) => SftpTransferDone {
                ok: false,
                error: Some(e),
            },
            Err(e) => SftpTransferDone {
                ok: false,
                error: Some(format!("Task panic: {e}")),
            },
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
    let cancel_flag = {
        let state = app.state::<AppState>();
        let mut flags = state.transfer_cancel_flags.lock().unwrap();
        let flag = Arc::new(AtomicBool::new(false));
        flags.insert(session_id.clone(), Arc::clone(&flag));
        flag
    };
    tokio::spawn(async move {
        let result = tokio::task::spawn_blocking(move || {
            let app_prog = app_bg.clone();
            let sid_prog = sid.clone();
            let state = app_bg.state::<AppState>();
            let entry = {
                let manager = state.sftp_manager.lock().unwrap();
                manager.get_session(&sid)
            };
            match entry {
                Ok(entry_arc) => {
                    let entry_guard = entry_arc.lock().unwrap();
                    entry_guard.upload_file(
                        &sid,
                        &local_path,
                        &remote_path,
                        Arc::clone(&cancel_flag),
                        move |progress| {
                            let _ = app_prog.emit(&format!("sftp:{}:progress", sid_prog), progress);
                        },
                    )
                }
                Err(e) => Err(e),
            }
        })
        .await;
        let state = app.state::<AppState>();
        state
            .transfer_cancel_flags
            .lock()
            .unwrap()
            .remove(&session_id);
        let done = match result {
            Ok(Ok(())) => SftpTransferDone {
                ok: true,
                error: None,
            },
            Ok(Err(e)) => SftpTransferDone {
                ok: false,
                error: Some(e),
            },
            Err(e) => SftpTransferDone {
                ok: false,
                error: Some(format!("Task panic: {e}")),
            },
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
    let entry = {
        let manager = state.sftp_manager.lock().unwrap();
        manager.get_session(&session_id)?
    };
    let entry_guard = entry.lock().unwrap();
    entry_guard.delete_remote(&paths)
}

#[tauri::command]
fn sftp_rename_remote(
    state: State<AppState>,
    session_id: String,
    from_path: String,
    to_path: String,
) -> Result<(), String> {
    let entry = {
        let manager = state.sftp_manager.lock().unwrap();
        manager.get_session(&session_id)?
    };
    let entry_guard = entry.lock().unwrap();
    entry_guard.rename_remote(&from_path, &to_path)
}

#[tauri::command]
fn sftp_mkdir_remote(
    state: State<AppState>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let entry = {
        let manager = state.sftp_manager.lock().unwrap();
        manager.get_session(&session_id)?
    };
    let entry_guard = entry.lock().unwrap();
    entry_guard.mkdir_remote(&path)
}

#[tauri::command]
fn sftp_disconnect(state: State<AppState>, session_id: String) -> Result<(), String> {
    let mut manager = state.sftp_manager.lock().unwrap();
    manager.disconnect(&session_id)
}

#[tauri::command]
fn sftp_cancel_transfer(state: State<AppState>, session_id: String) -> Result<(), String> {
    let flags = state.transfer_cancel_flags.lock().unwrap();
    if let Some(flag) = flags.get(&session_id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
fn sftp_stat_remote(
    state: State<AppState>,
    session_id: String,
    path: String,
) -> Result<sftp::RemoteStatResult, String> {
    let entry = {
        let manager = state.sftp_manager.lock().unwrap();
        manager.get_session(&session_id)?
    };
    let entry_guard = entry.lock().unwrap();
    entry_guard.stat_remote(&path)
}

#[tauri::command]
fn sftp_rename_local(path: String, new_name: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    let dest = p.parent().ok_or("No parent dir")?.join(&new_name);
    std::fs::rename(p, &dest).map_err(|e| format!("Rename: {}", e))
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
fn sftp_mkdir_local(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| format!("Create dir '{}': {}", path, e))
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
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    std::process::Command::new("cmd")
        .args(["/c", "start", "", &path])
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    return Err("Platform not supported for open_local".to_string());
    Ok(())
}

#[tauri::command]
fn sftp_open_with_local(path: String, app: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .args(["-a", &app, &path])
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    std::process::Command::new(&app)
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    std::process::Command::new("cmd")
        .args(["/c", "start", "", &app, &path])
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    return Err("Platform not supported for open_with_local".to_string());
    Ok(())
}

#[derive(Serialize, Clone)]
struct SftpFileChangedEvent {
    tmp_path: String,
    remote_path: String,
}

#[tauri::command]
async fn sftp_open_remote(
    _app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    remote_path: String,
) -> Result<String, String> {
    let tmp_path = {
        let entry = {
            let manager = state.sftp_manager.lock().unwrap();
            manager.get_session(&session_id)?
        };
        let entry_guard = entry.lock().unwrap();
        entry_guard.open_remote(&session_id, &remote_path)?
    };
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(&tmp_path).spawn();
    #[cfg(target_os = "linux")]
    let _ = std::process::Command::new("xdg-open")
        .arg(&tmp_path)
        .spawn();
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("cmd")
        .args(["/c", "start", "", &tmp_path])
        .spawn();
    Ok(tmp_path)
}

#[tauri::command]
async fn sftp_watch_remote(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    tmp_path: String,
    remote_path: String,
) -> Result<(), String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    {
        let mut handles = state.watch_handles.lock().unwrap();
        // Cancel any existing watch for this tmp_path
        if let Some(old_tx) = handles.remove(&tmp_path) {
            let _ = old_tx.send(());
        }
        handles.insert(tmp_path.clone(), tx);
    }
    let app_bg = app.clone();
    let sid = session_id.clone();
    let tp = tmp_path.clone();
    let rp = remote_path.clone();
    tokio::spawn(async move {
        let initial_mtime = std::fs::metadata(&tp).and_then(|m| m.modified()).ok();
        let mut last_mtime = initial_mtime;
        let mut rx = rx;
        loop {
            tokio::select! {
                _ = &mut rx => break,
                _ = tokio::time::sleep(tokio::time::Duration::from_secs(2)) => {
                    let current = std::fs::metadata(&tp).and_then(|m| m.modified()).ok();
                    if current != last_mtime && current.is_some() {
                        last_mtime = current;
                        let _ = app_bg.emit(
                            &format!("sftp:{}:file-changed", sid),
                            SftpFileChangedEvent { tmp_path: tp.clone(), remote_path: rp.clone() },
                        );
                    }
                }
            }
        }
    });
    Ok(())
}

#[tauri::command]
fn sftp_stop_watch(state: State<AppState>, tmp_path: String) -> Result<(), String> {
    let mut handles = state.watch_handles.lock().unwrap();
    if let Some(tx) = handles.remove(&tmp_path) {
        let _ = tx.send(());
    }
    let _ = std::fs::remove_file(&tmp_path);
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
    let entry = {
        let manager = state.sftp_manager.lock().unwrap();
        manager.get_session(&session_id)?
    };
    let entry_guard = entry.lock().unwrap();
    entry_guard.chmod(&path, &mode, recursive)
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
    let entry = {
        let manager = state.sftp_manager.lock().unwrap();
        manager.get_session(&session_id)?
    };
    let entry_guard = entry.lock().unwrap();
    entry_guard.chown(&path, &user, &group, recursive)
}

#[tauri::command]
fn sftp_copy_remote(
    state: State<AppState>,
    session_id: String,
    paths: Vec<String>,
    dest_dir: String,
) -> Result<(), String> {
    let entry = {
        let manager = state.sftp_manager.lock().unwrap();
        manager.get_session(&session_id)?
    };
    let entry_guard = entry.lock().unwrap();
    entry_guard.copy_remote(&paths, &dest_dir)
}

#[tauri::command]
fn sftp_get_users_groups(
    state: State<AppState>,
    session_id: String,
) -> Result<sftp::UsersGroups, String> {
    let entry = {
        let manager = state.sftp_manager.lock().unwrap();
        manager.get_session(&session_id)?
    };
    let entry_guard = entry.lock().unwrap();
    entry_guard.get_users_groups()
}

#[tauri::command]
async fn dashboard_connect(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    host_ids: Vec<String>,
) -> Result<(), String> {
    let vault = hosts::list_hosts(&app)?;

    for host in vault.hosts.iter().filter(|h| host_ids.contains(&h.id)) {
        let key_path = if let Some(key_id) = &host.ssh_key_id {
            let keys = crate::ssh_keys::list_ssh_keys(&app).unwrap_or_default();
            keys.into_iter()
                .find(|k| &k.id == key_id)
                .map(|k| std::path::PathBuf::from(k.private_key_path))
        } else {
            None
        };

        let actor = dashboard::spawn_host_actor(
            app.clone(),
            host.id.clone(),
            host.hostname.clone(),
            host.port,
            host.user.clone(),
            hosts::decrypt_host_password(host),
            key_path,
        );

        let mut dm = state.dashboard_manager.lock().unwrap();
        dm.connect(host.id.clone(), actor);
    }
    Ok(())
}

#[tauri::command]
async fn dashboard_poll(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    want_detail: bool,
    host_id: Option<String>,
) -> Result<(), String> {
    let senders = {
        let dm = state.dashboard_manager.lock().unwrap();
        match &host_id {
            Some(id) => dm
                .sender(id)
                .map(|s| vec![(id.clone(), s)])
                .unwrap_or_default(),
            None => dm.senders(),
        }
    };

    let handles: Vec<_> = senders
        .into_iter()
        .map(|(_id, tx)| {
            let app = app.clone();
            tokio::spawn(async move {
                let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
                let cmd = dashboard::ActorCmd::Poll {
                    want_detail,
                    reply: reply_tx,
                };

                if tx.try_send(cmd).is_err() {
                    return;
                }

                if let Ok(result) = reply_rx.await {
                    let _ = app.emit("dash:stat", result);
                }
            })
        })
        .collect();

    futures::future::join_all(handles).await;
    Ok(())
}

#[tauri::command]
fn dashboard_disconnect(
    state: tauri::State<'_, AppState>,
    host_ids: Vec<String>,
) -> Result<(), String> {
    let mut dm = state.dashboard_manager.lock().unwrap();
    for id in &host_ids {
        dm.disconnect(id);
    }
    Ok(())
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GeneralSettings {
    pub run_in_background: bool,
}

impl Default for GeneralSettings {
    fn default() -> Self {
        Self {
            run_in_background: true,
        }
    }
}

fn general_settings_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("general_settings.json"))
}

fn load_general_settings(app: &tauri::AppHandle) -> GeneralSettings {
    general_settings_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<GeneralSettings>(&s).ok())
        .unwrap_or_default()
}

fn save_general_settings(app: &tauri::AppHandle, settings: &GeneralSettings) {
    if let Some(path) = general_settings_path(app) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(settings) {
            let _ = std::fs::write(path, json);
        }
    }
}

#[tauri::command]
fn get_general_settings(app: tauri::AppHandle) -> GeneralSettings {
    load_general_settings(&app)
}

#[tauri::command]
fn set_general_settings(app: tauri::AppHandle, settings: GeneralSettings) {
    save_general_settings(&app, &settings);
}

#[tauri::command]
fn is_autostart_enabled(app: tauri::AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_autostart_enabled(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    if enabled {
        app.autolaunch().enable().map_err(|e| e.to_string())
    } else {
        app.autolaunch().disable().map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn force_quit_app(app: tauri::AppHandle) {
    global_hotkey::kill_daemon();
    app.exit(0);
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// Global AppHandle for the screen-lock notification callback.
/// Populated once in `start_screen_lock_monitor` before the observer is registered.
#[cfg(target_os = "macos")]
static SCREEN_LOCK_APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

/// CoreFoundation callback fired when macOS emits `com.apple.screenIsLocked`.
/// Runs on the main thread (the Cocoa run loop delivers it there).
#[cfg(target_os = "macos")]
unsafe extern "C" fn screen_locked_callback(
    _center: *mut std::ffi::c_void,
    _observer: *const std::ffi::c_void,
    _name: *mut std::ffi::c_void,
    _object: *const std::ffi::c_void,
    _user_info: *mut std::ffi::c_void,
) {
    eprintln!("[vault] screen lock notification received");
    if let Some(app) = SCREEN_LOCK_APP.get() {
        vault::on_screen_lock(app);
    }
}

/// Registers for the `com.apple.screenIsLocked` Darwin distributed notification
/// on the main thread so delivery uses the existing Cocoa run loop.
///
/// Unlike the old polling approach this fires only on a genuine lock transition,
/// never on transient display-sleep states or polling races at startup.
#[cfg(target_os = "macos")]
fn start_screen_lock_monitor(app: tauri::AppHandle) {
    use std::ffi::c_void;
    use std::ptr;

    let _ = SCREEN_LOCK_APP.set(app.clone());

    let _ = app.run_on_main_thread(|| unsafe {
        #[link(name = "CoreFoundation", kind = "framework")]
        extern "C" {
            fn CFNotificationCenterGetDistributedCenter() -> *mut c_void;
            fn CFNotificationCenterAddObserver(
                center: *mut c_void,
                observer: *const c_void,
                callback: unsafe extern "C" fn(
                    *mut c_void,
                    *const c_void,
                    *mut c_void,
                    *const c_void,
                    *mut c_void,
                ),
                name: *mut c_void,
                object: *const c_void,
                suspension_behavior: isize,
            );
            fn CFStringCreateWithCString(
                alloc: *const c_void,
                c_str: *const i8,
                encoding: u32,
            ) -> *mut c_void;
            fn CFRelease(cf: *const c_void);
        }

        let center = CFNotificationCenterGetDistributedCenter();
        let name_bytes = b"com.apple.screenIsLocked\0";
        let name = CFStringCreateWithCString(
            ptr::null(),
            name_bytes.as_ptr() as *const i8,
            0x0800_0100u32, // kCFStringEncodingUTF8
        );
        // kCFNotificationSuspensionBehaviorDeliverImmediately = 4
        CFNotificationCenterAddObserver(
            center,
            ptr::null(),
            screen_locked_callback,
            name,
            ptr::null(),
            4,
        );
        CFRelease(name as *const c_void); // AddObserver retains; we release our ref
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // The hotkey daemon launches us with --hotkey=<action>; when an
            // instance is already running the argument lands here and is
            // dispatched directly. Any other second launch (e.g. clicking the
            // app icon again) just surfaces the existing instance.
            if let Some(action) = global_hotkey::hotkey_arg(&argv) {
                global_hotkey::dispatch(app, &action);
            } else if let Some(window) = app.get_webview_window("main") {
                global_hotkey::set_dock_visible(app, true);
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .with_filter(|label| label != "settings" && label != quick_terminal::WINDOW_LABEL)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
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
            get_host_password,
            save_host_group,
            remove_host_group,
            vault_status,
            vault_init,
            vault_unlock,
            vault_lock,
            vault_change_master_password,
            get_vault_lock_policy,
            set_vault_lock_policy,
            sync_get_config,
            sync_connect_provider,
            sync_set_config,
            sync_status,
            sync_disconnect,
            sync_now,
            vault_init_from_sync,
            sync_import_foreign,
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
            sftp_cancel_transfer,
            sftp_download,
            sftp_upload,
            sftp_list_local,
            get_home_dir,
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
            sftp_mkdir_local,
            sftp_copy_local,
            sftp_open_local,
            sftp_open_with_local,
            sftp_open_remote,
            sftp_watch_remote,
            sftp_stop_watch,
            dashboard_connect,
            dashboard_poll,
            dashboard_disconnect,
            quit_app,
            get_general_settings,
            set_general_settings,
            is_autostart_enabled,
            set_autostart_enabled,
            force_quit_app,
            enable_global_hotkey,
            disable_global_hotkey,
            get_global_hotkey_status,
            toggle_quick_terminal,
            hide_quick_terminal,
            resize_quick_terminal,
            get_quick_terminal_info,
            set_quick_terminal_edge,
            set_quick_terminal_enabled,
            set_quick_terminal_opacity,
            quick_terminal_frontend_ready,
        ])
        .on_window_event(|window, event| {
            // Closing the main/extra windows hides them rather than exiting the
            // process on every platform: the tray icon + optional global hotkey
            // only make sense if the app keeps running in the background. The
            // tray's "Quit" item (or the menu/shortcut equivalent) is the real exit.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let label = window.label();
                if label == "main"
                    || label.starts_with("window-")
                    || label == quick_terminal::WINDOW_LABEL
                {
                    let app = window.app_handle();
                    let settings = load_general_settings(app);
                    if settings.run_in_background {
                        let _ = window.hide();
                        api.prevent_close();
                    }
                }
            }
        })
        .setup(|app| {
            // Cold launch triggered by the termifaid hotkey service?
            // This must be decided FIRST: Tauri pumps the event loop while
            // building the webviews below, which fires didFinishLaunching and
            // locks in the activation policy — setting Accessory any later
            // leaves the app registered as a regular (Dock-visible) app.
            let launch_args: Vec<String> = std::env::args().collect();
            let is_background_flag = launch_args.iter().any(|arg| arg == "--background");
            let hotkey_action = global_hotkey::hotkey_arg(&launch_args);
            let is_hotkey_launch = hotkey_action.is_some();
            let background_launch = is_background_flag || is_hotkey_launch;

            #[cfg(target_os = "macos")]
            if background_launch {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }

            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;

            // One-time, idempotent move of pre-multi-vault top-level files into
            // vaults/default/. Every store below reads from vault_dir, never
            // app_data_dir directly, so this runs before any store is opened.
            termifai_core::layout::migrate_legacy_layout(&app_data_dir)
                .map_err(|e| format!("Failed to migrate to vault layout: {}", e))?;
            let vault_dir = termifai_core::layout::vault_dir(
                &app_data_dir,
                termifai_core::layout::DEFAULT_VAULT_ID,
            );

            app.manage(AppState {
                pty_manager: Mutex::new(PtyManager::new()),
                tunnel_manager: port_forwarding::new_tunnel_manager(),
                sftp_manager: Mutex::new(SftpManager::new()),
                watch_handles: Mutex::new(std::collections::HashMap::new()),
                transfer_cancel_flags: Mutex::new(std::collections::HashMap::new()),
                dashboard_manager: Mutex::new(DashboardManager::new()),
                hosts_store: store::JsonStore::new(vault_dir.join("hosts.json")),
                port_forward_store: store::JsonStore::new(vault_dir.join("port_forwards.json")),
                snippets_store: store::JsonStore::new(vault_dir.join("snippets.json")),
                vault_settings_store: store::JsonStore::new(vault_dir.join("vault_settings.json")),
                vault_crypto_store: store::JsonStore::new(vault_dir.join("vault.json")),
                tombstones_store: store::JsonStore::new(vault_dir.join("tombstones.json")),
                sync_state_store: store::JsonStore::new(vault_dir.join("sync_state.json")),
            });
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
            // Build the main window programmatically.
            // On macOS: with decorations and Overlay title bar style for traffic lights.
            // On Windows/Linux: without decorations to avoid two-toned title bar.
            let mut main_builder =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("Termifai")
                    .inner_size(900.0, 600.0)
                    .min_inner_size(900.0, 600.0)
                    .resizable(true)
                    .transparent(true)
                    // On a quick-terminal cold launch the main window must
                    // never appear — creating it visible and hiding later
                    // makes it (and the Dock icon) flash.
                    .visible(!background_launch);

            #[cfg(target_os = "macos")]
            {
                main_builder = main_builder
                    .decorations(true)
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true)
                    .traffic_light_position(tauri::LogicalPosition::new(12.0, 25.0));
            }

            #[cfg(not(target_os = "macos"))]
            {
                main_builder = main_builder.decorations(false);
            }

            let _main_win = main_builder.build()?;

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

            // Quick Terminal panel — same create-hidden-at-startup pattern as the
            // settings window (dynamic creation deadlocks WebView2 on Windows).
            // Not draggable (no drag region in its HTML) and not natively
            // resizable: sizing happens only via the in-panel drag handle.
            WebviewWindowBuilder::new(
                app,
                quick_terminal::WINDOW_LABEL,
                WebviewUrl::App("index.html?window=quick-terminal".into()),
            )
            .title("Quick Terminal")
            .decorations(false)
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .minimizable(false)
            .maximizable(false)
            // Transparent + shadowless so the native window itself is invisible:
            // what the user sees sliding in is the panel div inside the webview.
            .transparent(true)
            .shadow(false)
            // Native backdrop blur for the glass look: the first effect the
            // platform supports is applied (HudWindow → macOS vibrancy,
            // Acrylic/Blur → Windows; no-op on Linux). Only visible where the
            // frontend makes its backgrounds translucent (panel transparency
            // setting below 100%).
            .effects(
                tauri::window::EffectsBuilder::new()
                    .effect(tauri::window::Effect::HudWindow)
                    .effect(tauri::window::Effect::Acrylic)
                    .effect(tauri::window::Effect::Blur)
                    // Pin the effect to its active look — by default macOS
                    // vibrancy follows window focus and dims when the panel
                    // loses key status, which reads as the panel "darkening".
                    .state(tauri::window::EffectState::Active)
                    .build(),
            )
            .visible(false)
            .build()?;

            let app_handle = app.handle().clone();
            if let Some(main_win) = app.get_webview_window("main") {
                let _ = main_win.set_effects(
                    tauri::window::EffectsBuilder::new()
                        .effect(tauri::window::Effect::HudWindow)
                        .effect(tauri::window::Effect::Acrylic)
                        .effect(tauri::window::Effect::Blur)
                        .state(tauri::window::EffectState::Active)
                        .build(),
                );

                main_win.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { .. } = event {
                        // Closing "main" now only hides it on every platform (the app
                        // keeps running via the tray), so the settings window — created
                        // once at startup — must survive too, or it becomes unopenable
                        // for the rest of the session.
                        if let Some(settings_win) = app_handle.get_webview_window("settings") {
                            let _ = settings_win.hide();
                        }
                    }
                });
            }

            // On Linux and Windows the native menubar is replaced by a frontend hamburger menu
            #[cfg(target_os = "macos")]
            {
                let new_terminal = MenuItemBuilder::with_id("new-terminal", "New Terminal")
                    .accelerator("CmdOrCtrl+T")
                    .build(app)?;
                let settings = MenuItemBuilder::with_id("open-settings", "Settings...")
                    .accelerator("CmdOrCtrl+,")
                    .build(app)?;
                let lock_vault = MenuItemBuilder::with_id("lock-vault", "Lock Vault")
                    .accelerator("CmdOrCtrl+Shift+L")
                    .build(app)?;
                let custom_quit = MenuItemBuilder::with_id("custom-quit", "Quit Termifai")
                    .accelerator("CmdOrCtrl+Q")
                    .build(app)?;
                let custom_force_quit = MenuItemBuilder::with_id("custom-force-quit", "Force Quit")
                    .accelerator("CmdOrCtrl+Shift+Q")
                    .build(app)?;

                let file_menu = SubmenuBuilder::new(app, "File")
                    .item(&new_terminal)
                    .item(&settings)
                    .separator()
                    .item(&lock_vault)
                    .separator()
                    .item(&PredefinedMenuItem::close_window(app, None)?)
                    .separator()
                    .item(&custom_quit)
                    .item(&custom_force_quit)
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
                    "lock-vault" => {
                        vault::op_lock();
                        let _ = handle.emit("vault-locked", ());
                    }
                    "custom-quit" => {
                        for window in handle.webview_windows().values() {
                            let _ = window.hide();
                        }
                        global_hotkey::set_dock_visible(&handle, false);
                    }
                    "custom-force-quit" => {
                        global_hotkey::kill_daemon();
                        handle.exit(0);
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
            app.handle().plugin(tauri_plugin_autostart::init(
                MacosLauncher::LaunchAgent,
                Some(vec!["--background"]),
            ))?;
            // Try to unlock the vault silently using the keychain-cached master password,
            // so a returning user on this device isn't prompted again. This bypasses the
            // vault_unlock command, so — same as that command — it must also trigger the
            // legacy-plaintext-password migration; otherwise a user whose vault always
            // auto-unlocks (the default OnRestart policy) would never get migrated.
            if let Ok(true) = vault::op_try_cached_unlock(app.handle()) {
                let _ = hosts::migrate_plaintext_passwords(app.handle());
            }

            // Start background screen-lock monitor (macOS only).
            #[cfg(target_os = "macos")]
            start_screen_lock_monitor(app.handle().clone());

            // Tray icon so the app can keep running in the background (required
            // for the optional global hotkey to mean anything) with an explicit
            // way to show the window or quit.
            let show_item =
                MenuItem::with_id(app, "tray-show", "Show Termifai", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "tray-quit", "Quit", true, None::<&str>)?;
            let force_quit_item = MenuItem::with_id(app, "tray-force-quit", "Force Quit", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &quit_item, &force_quit_item])?;
            TrayIconBuilder::new()
                .icon(
                    app.default_window_icon()
                        .cloned()
                        .ok_or("Missing default window icon")?,
                )
                .menu(&tray_menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "tray-show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            global_hotkey::set_dock_visible(app, true);
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "tray-quit" => {
                        SHOULD_EXIT.store(true, std::sync::atomic::Ordering::SeqCst);
                        global_hotkey::clean_quit(app);
                        app.exit(0);
                    }
                    "tray-force-quit" => {
                        SHOULD_EXIT.store(true, std::sync::atomic::Ordering::SeqCst);
                        global_hotkey::kill_daemon();
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            // Record our exe path for the hotkey daemon and make sure the
            // daemon is running if any hotkey is enabled.
            global_hotkey::restore_on_startup(&app.handle().clone());

            // Cold launch triggered by the hotkey daemon (--hotkey=<action>).
            // main-window needs nothing: the main window shows by default.
            // quick-terminal: the user asked for the panel, not the app — hide
            // the main window and slide the panel in once its webview reports
            // ready (see quick_terminal_frontend_ready).
            app.manage(quick_terminal::PendingToggle::default());
            // Finish the cold-launch handling decided at the top of setup:
            // the panel slides in once its webview reports ready. The bundle
            // is marked LSUIElement (agent) to cover the instant before
            // didFinishLaunching; normal launches opt back into being a
            // regular app here, which is what shows the Dock icon.
            if hotkey_action.as_deref() == Some(global_hotkey::ACTION_QUICK_TERMINAL) {
                app.state::<quick_terminal::PendingToggle>()
                    .0
                    .store(true, std::sync::atomic::Ordering::SeqCst);
            } else if hotkey_action.as_deref() == Some(global_hotkey::ACTION_MAIN_WINDOW) {
                if let Some(main_win) = app.get_webview_window("main") {
                    global_hotkey::set_dock_visible(app.handle(), true);
                    let _ = main_win.show();
                    let _ = main_win.set_focus();
                }
            } else if !background_launch {
                global_hotkey::set_dock_visible(app.handle(), true);
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            tauri::RunEvent::ExitRequested { api, .. } => {
                let run_in_background = load_general_settings(app_handle).run_in_background;
                if !run_in_background {
                    global_hotkey::kill_daemon();
                } else if !SHOULD_EXIT.load(std::sync::atomic::Ordering::SeqCst) {
                    api.prevent_exit();
                    for window in app_handle.webview_windows().values() {
                        let _ = window.hide();
                    }
                    global_hotkey::set_dock_visible(app_handle, false);
                }
            }
            tauri::RunEvent::Exit => {
                vault::on_app_exit(app_handle);
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } => {
                if let Some(window) = app_handle.get_webview_window("main") {
                    global_hotkey::set_dock_visible(app_handle, true);
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            _ => {}
        });
}

/// Shared logic for opening the settings window (used by both command and menu event).
fn open_settings_window_inner(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("settings")
        .ok_or_else(|| "Settings window not found".to_string())?;

    // The settings window is a normal window (not always-on-top), so it would
    // end up *behind* the always-on-top Quick Terminal panel. Collapse the
    // panel instead — it's a transient overlay, and this keeps the settings
    // window from having to sit above other apps' windows.
    if let Some(quick) = app.get_webview_window(quick_terminal::WINDOW_LABEL) {
        if quick.is_visible().unwrap_or(false) {
            let _ = app.emit("quick-terminal:hide", ());
        }
    }

    // Center on the main window using *logical* coordinates: physical
    // coordinates are interpreted with the scale factor of the monitor the
    // settings window currently sits on, so when the main window is on a
    // monitor with a different scale factor the position lands on the wrong
    // screen. Logical coordinates are global across monitors.
    let center_on_main = |window: &tauri::WebviewWindow| {
        if let Some(main_window) = app.get_webview_window("main") {
            if let (Ok(main_pos), Ok(main_size), Ok(scale_factor)) = (
                main_window.outer_position(),
                main_window.outer_size(),
                main_window.scale_factor(),
            ) {
                let main_pos = main_pos.to_logical::<f64>(scale_factor);
                let main_size = main_size.to_logical::<f64>(scale_factor);
                let x = main_pos.x + (main_size.width - 800.0) / 2.0;
                let y = main_pos.y + (main_size.height - 600.0) / 2.0;
                let _ = window
                    .set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x, y)));
            }
        }
    };

    // Position before showing so the window doesn't flash at its old spot.
    center_on_main(&window);

    window
        .show()
        .map_err(|e| format!("Failed to show settings window: {}", e))?;

    // Re-apply after show: on Windows the window's DPI is only updated once it
    // actually moves to the other monitor, so the first pass can be slightly off.
    center_on_main(&window);

    window
        .set_focus()
        .map_err(|e| format!("Failed to focus settings window: {}", e))?;

    Ok(())
}
