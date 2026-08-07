use crate::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use std::thread;
use tauri::{AppHandle, Manager};
use termifai_core::model::forwards::migrate_port_forward_vault;
pub use termifai_core::model::forwards::{PortForwardRule, PortForwardVault, TunnelDirection};

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

    /// Kills every running tunnel process — used by quit-to-background reset.
    pub fn stop_all(&mut self) {
        for (_, mut child) in self.processes.drain() {
            let _ = child.kill();
        }
    }
}

pub type TunnelManagerState = Mutex<TunnelManager>;

pub fn new_tunnel_manager() -> TunnelManagerState {
    Mutex::new(TunnelManager::new())
}

pub fn list_port_forwards(app: &AppHandle) -> Result<Vec<PortForwardRule>, String> {
    let state = app.state::<AppState>();
    let vault = state
        .port_forward_store
        .load_with_migration(migrate_port_forward_vault)
        .map_err(|e| e.to_string())?;
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

    let id = request
        .id
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| format!("pf-{}", uuid::Uuid::new_v4()));

    let now = now_iso();
    let state = app.state::<AppState>();
    let mut saved_rule = None;

    state
        .port_forward_store
        .update_with_migration(migrate_port_forward_vault, |vault| {
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
                created_at: existing_created.unwrap_or_else(|| now.clone()),
                updated_at: Some(now.clone()),
            };

            upsert_by_id(&mut vault.rules, rule.clone(), |r| &r.id);
            saved_rule = Some(rule);
        })
        .map_err(|e| e.to_string())?;

    crate::sync::mark_dirty(app);
    saved_rule.ok_or_else(|| "Failed to save rule".to_string())
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

    let state = app.state::<AppState>();
    state
        .port_forward_store
        .update_with_migration(migrate_port_forward_vault, |vault| {
            vault.rules.retain(|r| !ids.contains(&r.id));
        })
        .map_err(|e| e.to_string())?;
    crate::tombstones::record(app, crate::tombstones::EntityKind::PortForward, &ids)?;
    crate::sync::mark_dirty(app);
    Ok(())
}

fn check_fatal_errors(output: &str) -> Option<String> {
    if output.contains("could not resolve hostname")
        || output.contains("name or service not known")
        || output.contains("nodename nor servname provided")
    {
        Some("Hostname could not be resolved".to_string())
    } else if output.contains("connection refused") {
        Some("SSH connection was refused by the server".to_string())
    } else if output.contains("operation timed out")
        || output.contains("connection timed out")
        || output.contains("no route to host")
        || output.contains("network is unreachable")
    {
        Some("SSH connection timed out".to_string())
    } else if output.contains("host key verification failed") {
        Some("Host key verification failed".to_string())
    } else if output.contains("permission denied")
        || output.contains("too many authentication failures")
        || output.contains("authentication failed")
    {
        Some("SSH authentication failed".to_string())
    } else if output.contains("connection closed")
        || output.contains("connection reset")
        || output.contains("broken pipe")
    {
        Some("SSH connection closed prematurely".to_string())
    } else {
        None
    }
}

pub async fn start_tunnel(
    app: &AppHandle,
    tunnel_mgr: &TunnelManagerState,
    rule_id: String,
) -> Result<TunnelStatus, String> {
    let state = app.state::<AppState>();
    let vault = state
        .port_forward_store
        .load_with_migration(migrate_port_forward_vault)
        .map_err(|e| e.to_string())?;
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
    command.arg("-v"); // verbose output so we can detect success/failure quickly
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
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    let mut tx = Some(tx);

    thread::spawn(move || {
        let mut buf = [0u8; 1024];
        let mut output = String::new();
        let mut password_sent = password.is_empty();
        let mut writer = Some(writer);

        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    if let Some(t) = tx.take() {
                        let _ = t.send(Err("SSH tunnel exited prematurely".to_string()));
                    }
                    break;
                }
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]);
                    output.push_str(&chunk);

                    let lower = output.to_lowercase();

                    if !password_sent && lower.contains("password:") {
                        if let Some(ref mut w) = writer {
                            let _ = w.write_all(format!("{}\r", password).as_bytes());
                        }
                        password_sent = true;
                    }

                    if let Some(err) = check_fatal_errors(&lower) {
                        if let Some(t) = tx.take() {
                            let _ = t.send(Err(err));
                        }
                    }

                    if lower.contains("entering interactive session")
                        || lower.contains("authenticated to")
                        || lower.contains("authentication succeeded")
                    {
                        if let Some(t) = tx.take() {
                            let _ = t.send(Ok(()));
                        }
                    }
                }
                Err(_) => {
                    if let Some(t) = tx.take() {
                        let _ = t.send(Err("Failed to read from PTY".to_string()));
                    }
                    break;
                }
            }
        }
        // Drop writer when done
        drop(writer);
    });

    // Wait for SSH to establish connection or fail within bounded 3 seconds
    let timeout_res = tokio::time::timeout(std::time::Duration::from_millis(3000), rx).await;

    let mut child = child;

    let success = match timeout_res {
        Ok(Ok(Ok(()))) => true,
        Ok(Ok(Err(err))) => {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(TunnelStatus {
                rule_id,
                active: false,
                pid: None,
                error: Some(err),
            });
        }
        Ok(Err(_)) => {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(TunnelStatus {
                rule_id,
                active: false,
                pid: None,
                error: Some("SSH tunnel failed to start (internal error)".to_string()),
            });
        }
        Err(_) => {
            // Timeout! Check if process is still running
            match child.try_wait() {
                Ok(None) => true, // Still running, assume success fallback
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Ok(TunnelStatus {
                        rule_id,
                        active: false,
                        pid: None,
                        error: Some("SSH tunnel timed out or exited".to_string()),
                    });
                }
            }
        }
    };

    if success {
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
    } else {
        Err("Failed to start tunnel".to_string())
    }
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

#[cfg(test)]
mod quit_reset_tests {
    use super::*;

    #[test]
    fn stop_all_on_empty_manager_is_noop() {
        let mut mgr = TunnelManager::new();
        mgr.stop_all();
        assert!(mgr.processes.is_empty());
    }
}
