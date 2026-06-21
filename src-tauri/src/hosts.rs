use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::net::ToSocketAddrs;
use std::path::PathBuf;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    pub id: String,
    pub name: String,
    pub user: String,
    pub hostname: String,
    pub port: u16,
    pub os: OsKind,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_method: Option<AuthMethod>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_key_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub show_status_in_dashboard: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub working_directory: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_sftp_path: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OsKind {
    Ubuntu,
    Debian,
    Centos,
    Alpine,
    Macos,
    Windows,
    Other,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthMethod {
    Password,
    Key,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostGroup {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HostsVault {
    pub hosts: Vec<Host>,
    pub groups: Vec<HostGroup>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveHostRequest {
    pub id: Option<String>,
    pub name: String,
    pub user: String,
    pub hostname: String,
    pub port: u16,
    pub os: OsKind,
    #[serde(default)]
    pub tags: Vec<String>,
    pub group_id: Option<String>,
    pub auth_method: Option<AuthMethod>,
    pub password: Option<String>,
    pub ssh_key_id: Option<String>,
    pub show_status_in_dashboard: Option<bool>,
    pub working_directory: Option<String>,
    pub default_sftp_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveHostGroupRequest {
    pub id: Option<String>,
    pub name: String,
    pub parent_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestHostConnectionRequest {
    pub hostname: String,
    pub user: String,
    pub port: u16,
    pub password: Option<String>,
    pub ssh_key_id: Option<String>,
    pub timeout_secs: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestHostConnectionResult {
    pub ok: bool,
    pub message: String,
}

pub fn list_hosts(app: &AppHandle) -> Result<HostsVault, String> {
    read_vault(app)
}

pub fn save_host(app: &AppHandle, request: SaveHostRequest) -> Result<Host, String> {
    validate_host(&request)?;
    let mut vault = read_vault(app)?;
    validate_group_exists(&vault, request.group_id.as_deref())?;

    let id = request
        .id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("h-{}", uuid::Uuid::new_v4()));
    let now = now_iso();
    let existing_last_used = vault
        .hosts
        .iter()
        .find(|host| host.id == id)
        .and_then(|host| host.last_used.clone());
    let host = Host {
        id: id.clone(),
        name: request.name.trim().to_string(),
        user: request.user.trim().to_string(),
        hostname: request.hostname.trim().to_string(),
        port: request.port,
        os: request.os,
        tags: request
            .tags
            .into_iter()
            .map(|tag| tag.trim().to_string())
            .filter(|tag| !tag.is_empty())
            .collect(),
        last_used: existing_last_used.or(Some(now)),
        group_id: request.group_id.filter(|value| !value.trim().is_empty()),
        auth_method: request.auth_method,
        password: request.password.filter(|value| !value.is_empty()),
        ssh_key_id: request.ssh_key_id.filter(|value| !value.trim().is_empty()),
        show_status_in_dashboard: request.show_status_in_dashboard,
        working_directory: request
            .working_directory
            .filter(|value| !value.trim().is_empty()),
        default_sftp_path: request
            .default_sftp_path
            .filter(|value| !value.trim().is_empty()),
    };

    upsert_by_id(&mut vault.hosts, host.clone(), |item| &item.id);
    write_vault(app, &vault)?;
    Ok(host)
}

pub fn remove_hosts(app: &AppHandle, ids: Vec<String>) -> Result<(), String> {
    let mut vault = read_vault(app)?;
    vault.hosts.retain(|host| !ids.contains(&host.id));
    write_vault(app, &vault)
}

pub fn save_host_group(
    app: &AppHandle,
    request: SaveHostGroupRequest,
) -> Result<HostGroup, String> {
    let name = request.name.trim();
    if name.is_empty() {
        return Err("Group name is required".to_string());
    }

    let mut vault = read_vault(app)?;
    validate_group_exists(&vault, request.parent_id.as_deref())?;
    let id = request
        .id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("g-{}", uuid::Uuid::new_v4()));

    if request.parent_id.as_deref() == Some(&id) {
        return Err("Group cannot be its own parent".to_string());
    }

    let group = HostGroup {
        id: id.clone(),
        name: name.to_string(),
        parent_id: request.parent_id.filter(|value| !value.trim().is_empty()),
    };

    upsert_by_id(&mut vault.groups, group.clone(), |item| &item.id);
    write_vault(app, &vault)?;
    Ok(group)
}

pub fn remove_host_group(app: &AppHandle, id: String) -> Result<(), String> {
    let mut vault = read_vault(app)?;
    let descendants = descendant_group_ids(&vault.groups, &id);
    vault
        .groups
        .retain(|group| group.id != id && !descendants.contains(&group.id));
    vault.hosts.retain(|host| {
        host.group_id
            .as_ref()
            .map(|group_id| group_id != &id && !descendants.contains(group_id))
            .unwrap_or(true)
    });
    write_vault(app, &vault)
}

pub fn test_host_connection(
    app: &AppHandle,
    request: TestHostConnectionRequest,
) -> Result<TestHostConnectionResult, String> {
    let hostname = request.hostname.trim();
    let user = request.user.trim();
    if hostname.is_empty() {
        return Err("Hostname is required".to_string());
    }
    if user.is_empty() {
        return Err("Username is required".to_string());
    }
    if request.port == 0 {
        return Err("Port must be between 1 and 65535".to_string());
    }

    (hostname, request.port)
        .to_socket_addrs()
        .map_err(|e| format!("Failed to resolve host: {}", e))?;

    let timeout_secs = request.timeout_secs.unwrap_or(8).clamp(2, 30);
    let target = format!("{}@{}", user, hostname);
    let mut command = portable_pty::CommandBuilder::new("ssh");
    command.arg("-o");
    command.arg("BatchMode=no");
    command.arg("-o");
    command.arg("StrictHostKeyChecking=no");
    command.arg("-o");
    command.arg("UserKnownHostsFile=/dev/null");
    command.arg("-o");
    command.arg(format!("ConnectTimeout={}", timeout_secs));
    command.arg("-p");
    command.arg(request.port.to_string());

    if let Some(ssh_key_id) = request.ssh_key_id.as_deref().filter(|id| !id.trim().is_empty()) {
        let key_path = crate::ssh_keys::private_key_path(app, ssh_key_id)?;
        command.arg("-i");
        command.arg(key_path);
    }

    command.arg(target);
    command.arg("echo");
    command.arg("termifai-ssh-ok");
    run_ssh_test(command, request.password.unwrap_or_default(), timeout_secs)
}

fn read_vault(app: &AppHandle) -> Result<HostsVault, String> {
    let path = vault_path(app)?;
    if !path.exists() {
        return Ok(HostsVault::default());
    }

    let contents =
        fs::read_to_string(path).map_err(|e| format!("Failed to read hosts vault: {}", e))?;
    serde_json::from_str(&contents).map_err(|e| format!("Failed to parse hosts vault: {}", e))
}

fn run_ssh_test(
    command: portable_pty::CommandBuilder,
    password: String,
    timeout_secs: u64,
) -> Result<TestHostConnectionResult, String> {
    let pty_system = portable_pty::native_pty_system();
    let pair = pty_system
        .openpty(portable_pty::PtySize {
            rows: 24,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY for SSH test: {}", e))?;
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|e| format!("Failed to run ssh: {}", e))?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to read SSH test output: {}", e))?;
    let mut writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to write SSH test input: {}", e))?;
    let mut killer = child.clone_killer();
    let timeout = Duration::from_secs(timeout_secs);

    // Run the blocking read loop in a dedicated thread and communicate via channel.
    // This lets us enforce a hard timeout without blocking on reader.read() forever,
    // which on Linux can hang indefinitely even after the child process is killed.
    let (tx, rx) = std::sync::mpsc::channel::<Result<TestHostConnectionResult, String>>();

    thread::spawn(move || {
        let mut output = String::new();
        let mut password_sent = false;
        let mut buffer = [0_u8; 512];

        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buffer[..n]);
                    output.push_str(&chunk);
                    let lower = output.to_lowercase();

                    if lower.contains("termifai-ssh-ok") {
                        let _ = child.kill();
                        let _ = tx.send(Ok(TestHostConnectionResult {
                            ok: true,
                            message: "SSH authentication succeeded".to_string(),
                        }));
                        return;
                    }

                    if !password_sent && lower.contains("password:") {
                        if password.is_empty() {
                            let _ = child.kill();
                            let _ = tx.send(Ok(TestHostConnectionResult {
                                ok: false,
                                message: "SSH password is required for this host".to_string(),
                            }));
                            return;
                        }
                        if writer.write_all(format!("{}\r", password).as_bytes()).is_err() {
                            break;
                        }
                        password_sent = true;
                    }
                }
                Err(_) => break,
            }

            if let Ok(Some(_)) = child.try_wait() {
                break;
            }
        }

        let _ = child.wait();
        let _ = tx.send(Ok(TestHostConnectionResult {
            ok: false,
            message: ssh_failure_message(&output),
        }));
    });

    // Wait for the result with a hard timeout; kill the child if it expires
    match rx.recv_timeout(timeout) {
        Ok(result) => result,
        Err(_) => {
            let _ = killer.kill();
            Ok(TestHostConnectionResult {
                ok: false,
                message: "SSH connection test timed out".to_string(),
            })
        }
    }
}

fn ssh_failure_message(output: &str) -> String {
    let lower = output.to_lowercase();
    if lower.contains("permission denied") {
        "SSH authentication failed".to_string()
    } else if lower.contains("connection refused") {
        "SSH connection refused".to_string()
    } else if lower.contains("operation timed out") || lower.contains("connection timed out") {
        "SSH connection timed out".to_string()
    } else if lower.contains("could not resolve hostname") || lower.contains("name or service not known") {
        "SSH hostname could not be resolved".to_string()
    } else if lower.contains("no route to host") {
        "No route to SSH host".to_string()
    } else {
        "SSH test failed".to_string()
    }
}

fn write_vault(app: &AppHandle, vault: &HostsVault) -> Result<(), String> {
    let path = vault_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create hosts vault directory: {}", e))?;
    }

    let json = serde_json::to_string_pretty(vault)
        .map_err(|e| format!("Failed to serialize hosts vault: {}", e))?;
    fs::write(path, json).map_err(|e| format!("Failed to save hosts vault: {}", e))
}

fn validate_host(request: &SaveHostRequest) -> Result<(), String> {
    if request.name.trim().is_empty() {
        return Err("Host name is required".to_string());
    }
    if request.hostname.trim().is_empty() {
        return Err("Hostname is required".to_string());
    }
    if request.user.trim().is_empty() {
        return Err("Username is required".to_string());
    }
    if request.port == 0 {
        return Err("Port must be between 1 and 65535".to_string());
    }
    Ok(())
}

fn validate_group_exists(vault: &HostsVault, group_id: Option<&str>) -> Result<(), String> {
    if let Some(group_id) = group_id {
        if !vault.groups.iter().any(|group| group.id == group_id) {
            return Err("Selected group does not exist".to_string());
        }
    }
    Ok(())
}

fn upsert_by_id<T, F>(items: &mut Vec<T>, item: T, id: F)
where
    F: Fn(&T) -> &String,
{
    if let Some(index) = items.iter().position(|existing| id(existing) == id(&item)) {
        items[index] = item;
    } else {
        items.insert(0, item);
    }
}

fn descendant_group_ids(groups: &[HostGroup], id: &str) -> Vec<String> {
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

fn vault_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data directory: {}", e))?
        .join("hosts.json"))
}

fn now_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}
