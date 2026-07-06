use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager};

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TunnelDirection {
    Local,
    Remote,
    Dynamic,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardRule {
    pub id: String,
    pub name: String,
    pub host_id: String,
    pub direction: TunnelDirection,
    pub local_host: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    pub auto_connect: bool,
    pub created_at: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatus {
    pub rule_id: String,
    pub active: bool,
    pub pid: Option<u32>,
    pub error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePortForwardRequest {
    pub id: Option<String>,
    pub name: String,
    pub host_id: String,
    pub direction: TunnelDirection,
    pub local_host: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    pub auto_connect: bool,
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PortForwardVault {
    rules: Vec<PortForwardRule>,
}

/// Manages running SSH tunnel processes.
pub struct TunnelManager {
    /// Map from rule_id to child process handle
    processes: HashMap<String, Box<dyn portable_pty::Child + Send>>,
}

impl TunnelManager {
    pub fn new() -> Self {
        Self {
            processes: HashMap::new(),
        }
    }
}

pub type TunnelManagerState = Mutex<TunnelManager>;

pub fn new_tunnel_manager() -> TunnelManagerState {
    Mutex::new(TunnelManager::new())
}

pub fn list_port_forwards(app: &AppHandle) -> Result<Vec<PortForwardRule>, String> {
    let vault = read_vault(app)?;
    Ok(vault.rules)
}

pub fn save_port_forward(
    app: &AppHandle,
    request: SavePortForwardRequest,
) -> Result<PortForwardRule, String> {
    let name = request.name.trim();
    if name.is_empty() {
        return Err("Name is required".to_string());
    }
    if request.host_id.trim().is_empty() {
        return Err("Host is required".to_string());
    }
    if request.local_port == 0 {
        return Err("Local port must be between 1 and 65535".to_string());
    }
    if request.direction != TunnelDirection::Dynamic && request.remote_port == 0 {
        return Err("Remote port must be between 1 and 65535".to_string());
    }

    let mut vault = read_vault(app)?;
    let id = request
        .id
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| format!("pf-{}", uuid::Uuid::new_v4()));

    let now = now_iso();
    let existing_created = vault
        .rules
        .iter()
        .find(|r| r.id == id)
        .map(|r| r.created_at.clone());

    let rule = PortForwardRule {
        id: id.clone(),
        name: name.to_string(),
        host_id: request.host_id.trim().to_string(),
        direction: request.direction,
        local_host: if request.local_host.trim().is_empty() {
            "127.0.0.1".to_string()
        } else {
            request.local_host.trim().to_string()
        },
        local_port: request.local_port,
        remote_host: if request.remote_host.trim().is_empty() {
            "127.0.0.1".to_string()
        } else {
            request.remote_host.trim().to_string()
        },
        remote_port: request.remote_port,
        auto_connect: request.auto_connect,
        created_at: existing_created.unwrap_or(now),
    };

    upsert_by_id(&mut vault.rules, rule.clone(), |r| &r.id);
    write_vault(app, &vault)?;
    Ok(rule)
}

pub fn remove_port_forwards(
    app: &AppHandle,
    tunnel_mgr: &TunnelManagerState,
    ids: Vec<String>,
) -> Result<(), String> {
    // Stop any running tunnels first
    if let Ok(mut mgr) = tunnel_mgr.lock() {
        for id in &ids {
            if let Some(mut child) = mgr.processes.remove(id) {
                let _ = child.kill();
            }
        }
    }

    let mut vault = read_vault(app)?;
    vault.rules.retain(|r| !ids.contains(&r.id));
    write_vault(app, &vault)
}

pub fn start_tunnel(
    app: &AppHandle,
    tunnel_mgr: &TunnelManagerState,
    rule_id: String,
) -> Result<TunnelStatus, String> {
    let vault = read_vault(app)?;
    let rule = vault
        .rules
        .iter()
        .find(|r| r.id == rule_id)
        .ok_or_else(|| "Port forward rule not found".to_string())?;

    // Find host details
    let hosts_vault = crate::hosts::list_hosts(app)?;
    let host = hosts_vault
        .hosts
        .iter()
        .find(|h| h.id == rule.host_id)
        .ok_or_else(|| "Host not found for this rule".to_string())?;

    // Build the SSH tunnel command
    let mut command = portable_pty::CommandBuilder::new("ssh");
    command.arg("-N"); // no remote command
                       // accept-new: TOFU against the real known_hosts, hard-fail on a changed key.
                       // See hosts.rs::test_host_connection for why this replaces StrictHostKeyChecking=no.
    command.arg("-o");
    command.arg("StrictHostKeyChecking=accept-new");
    command.arg("-o");
    command.arg("ExitOnForwardFailure=yes");
    command.arg("-o");
    command.arg("ServerAliveInterval=30");
    command.arg("-o");
    command.arg("ServerAliveCountMax=3");
    command.arg("-o");
    command.arg("ConnectTimeout=10");

    // If no password, use BatchMode to avoid hanging on prompts
    let host_password = crate::hosts::decrypt_host_password(host);
    let has_password = host_password
        .as_ref()
        .map(|p| !p.is_empty())
        .unwrap_or(false);
    if !has_password {
        command.arg("-o");
        command.arg("BatchMode=yes");
    }

    // Port
    if host.port != 22 {
        command.arg("-p");
        command.arg(host.port.to_string());
    }

    // SSH key
    if let Some(ref key_id) = host.ssh_key_id {
        if !key_id.trim().is_empty() {
            if let Ok(key_path) = crate::ssh_keys::private_key_path(app, key_id) {
                command.arg("-i");
                command.arg(key_path);
            }
        }
    }

    // Tunnel specification
    match rule.direction {
        TunnelDirection::Local => {
            command.arg("-L");
            command.arg(format!(
                "{}:{}:{}:{}",
                rule.local_host, rule.local_port, rule.remote_host, rule.remote_port
            ));
        }
        TunnelDirection::Remote => {
            command.arg("-R");
            command.arg(format!(
                "{}:{}:{}:{}",
                rule.remote_host, rule.remote_port, rule.local_host, rule.local_port
            ));
        }
        TunnelDirection::Dynamic => {
            command.arg("-D");
            command.arg(format!("{}:{}", rule.local_host, rule.local_port));
        }
    }

    // Target
    command.arg(format!("{}@{}", host.user, host.hostname));

    // Spawn via PTY so we can handle password prompts
    let pty_system = portable_pty::native_pty_system();
    let pair = pty_system
        .openpty(portable_pty::PtySize {
            rows: 4,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY for tunnel: {}", e))?;

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|e| format!("Failed to start SSH tunnel: {}", e))?;

    // Drop the slave so the master side works correctly
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to read tunnel output: {}", e))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to write to tunnel: {}", e))?;

    // Keep master alive so the PTY stays open for the lifetime of the tunnel
    // We'll leak it intentionally — it will be cleaned up when the process exits
    let _master = pair.master;

    // Handle password in a background thread, then keep reading to drain output
    let password = host_password.clone().unwrap_or_default();
    thread::spawn(move || {
        let mut buf = [0u8; 1024];
        let mut output = String::new();
        let mut password_sent = password.is_empty();
        let mut writer = Some(writer);

        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if !password_sent {
                        let chunk = String::from_utf8_lossy(&buf[..n]);
                        output.push_str(&chunk);
                        if output.to_lowercase().contains("password:") {
                            if let Some(ref mut w) = writer {
                                let _ = w.write_all(format!("{}\r", password).as_bytes());
                            }
                            password_sent = true;
                        }
                    }
                    // Keep draining output so PTY buffer doesn't fill up
                }
                Err(_) => break,
            }
        }
        // Drop writer when done
        drop(writer);
    });

    // Wait for SSH to establish connection or fail
    thread::sleep(Duration::from_millis(3000));

    // Check if child is still running (borrow as mutable temporarily)
    // We need to wrap child for shared ownership
    let mut child = child;
    match child.try_wait() {
        Ok(Some(_status)) => {
            return Ok(TunnelStatus {
                rule_id,
                active: false,
                pid: None,
                error: Some(
                    "SSH tunnel exited immediately. Check host credentials and ports.".to_string(),
                ),
            });
        }
        Ok(None) => { /* still running, good */ }
        Err(e) => {
            return Ok(TunnelStatus {
                rule_id,
                active: false,
                pid: None,
                error: Some(format!("Failed to check tunnel status: {}", e)),
            });
        }
    }

    let pid = child.process_id();

    let mut mgr = tunnel_mgr
        .lock()
        .map_err(|_| "Failed to lock tunnel manager".to_string())?;

    // Kill existing tunnel for this rule if any
    if let Some(mut old) = mgr.processes.remove(&rule_id) {
        let _ = old.kill();
    }

    mgr.processes.insert(rule_id.clone(), child);

    Ok(TunnelStatus {
        rule_id,
        active: true,
        pid,
        error: None,
    })
}

pub fn stop_tunnel(
    tunnel_mgr: &TunnelManagerState,
    rule_id: String,
) -> Result<TunnelStatus, String> {
    let mut mgr = tunnel_mgr
        .lock()
        .map_err(|_| "Failed to lock tunnel manager".to_string())?;

    if let Some(mut child) = mgr.processes.remove(&rule_id) {
        let _ = child.kill();
        let _ = child.wait();
    }

    Ok(TunnelStatus {
        rule_id,
        active: false,
        pid: None,
        error: None,
    })
}

pub fn get_tunnel_statuses(
    tunnel_mgr: &TunnelManagerState,
    rule_ids: Vec<String>,
) -> Vec<TunnelStatus> {
    let mut mgr = match tunnel_mgr.lock() {
        Ok(m) => m,
        Err(_) => {
            return rule_ids
                .iter()
                .map(|id| TunnelStatus {
                    rule_id: id.clone(),
                    active: false,
                    pid: None,
                    error: None,
                })
                .collect()
        }
    };

    let mut statuses = Vec::new();
    for id in rule_ids {
        let active = if let Some(child) = mgr.processes.get_mut(&id) {
            match child.try_wait() {
                Ok(Some(_)) => {
                    // Process has exited
                    mgr.processes.remove(&id);
                    false
                }
                Ok(None) => true, // still running
                Err(_) => {
                    mgr.processes.remove(&id);
                    false
                }
            }
        } else {
            false
        };

        let pid = if active {
            mgr.processes.get(&id).and_then(|c| c.process_id())
        } else {
            None
        };

        statuses.push(TunnelStatus {
            rule_id: id,
            active,
            pid,
            error: None,
        });
    }
    statuses
}

// --- Storage helpers ---

fn read_vault(app: &AppHandle) -> Result<PortForwardVault, String> {
    let path = vault_path(app)?;
    if !path.exists() {
        return Ok(PortForwardVault::default());
    }
    let contents = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read port forward vault: {}", e))?;
    serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse port forward vault: {}", e))
}

fn write_vault(app: &AppHandle, vault: &PortForwardVault) -> Result<(), String> {
    let path = vault_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create port forward vault directory: {}", e))?;
    }
    let json = serde_json::to_string_pretty(vault)
        .map_err(|e| format!("Failed to serialize port forward vault: {}", e))?;
    fs::write(path, json).map_err(|e| format!("Failed to save port forward vault: {}", e))
}

fn vault_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data directory: {}", e))?
        .join("port_forwards.json"))
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

fn now_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}
