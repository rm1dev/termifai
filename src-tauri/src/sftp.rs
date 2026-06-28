use serde::{Deserialize, Serialize};
use ssh2::Session;
use std::collections::HashMap;
use std::net::TcpStream;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SftpConnectRequest {
    pub session_id: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub private_key_path: Option<String>,
    pub default_remote_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SftpSessionInfo {
    pub session_id: String,
    pub remote_path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LocalFileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: Option<u64>,
    pub modified: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RemoteFileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: Option<u64>,
    pub permissions: Option<u32>,
    pub modified: Option<String>,
}

pub fn list_local(path: &str) -> Result<Vec<LocalFileEntry>, String> {
    let dir = std::fs::read_dir(path).map_err(|e| format!("Cannot read '{}': {}", path, e))?;

    let mut entries: Vec<LocalFileEntry> = dir
        .filter_map(|e| e.ok())
        .map(|entry| {
            let meta = entry.metadata().ok();
            let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
            let size = if is_dir { None } else { meta.as_ref().map(|m| m.len()) };
            let modified = meta
                .and_then(|m| m.modified().ok())
                .map(|t| {
                    let secs = t
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs();
                    format_unix_timestamp(secs)
                });
            LocalFileEntry {
                name: entry.file_name().to_string_lossy().to_string(),
                path: entry.path().to_string_lossy().to_string(),
                is_dir,
                size,
                modified,
            }
        })
        .collect();

    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(entries)
}

fn format_unix_timestamp(secs: u64) -> String {
    let secs = secs as i64;
    let (y, mo, d, h, mi) = unix_to_ymd_hm(secs);
    format!("{:04}-{:02}-{:02} {:02}:{:02}", y, mo, d, h, mi)
}

fn unix_to_ymd_hm(secs: i64) -> (i32, u32, u32, u32, u32) {
    let days = secs / 86400;
    let time_of_day = secs % 86400;
    let h = (time_of_day / 3600) as u32;
    let mi = ((time_of_day % 3600) / 60) as u32;

    let jd = days + 2440588;
    let l = jd + 68569;
    let n = (4 * l) / 146097;
    let l = l - (146097 * n + 3) / 4;
    let i = (4000 * (l + 1)) / 1461001;
    let l = l - (1461 * i) / 4 + 31;
    let j = (80 * l) / 2447;
    let d = l - (2447 * j) / 80;
    let l = j / 11;
    let mo = j + 2 - 12 * l;
    let y = 100 * (n - 49) + i + l;
    (y as i32, mo as u32, d as u32, h, mi)
}

pub struct SftpEntry {
    pub session: Session,
}

pub struct SftpManager {
    sessions: HashMap<String, SftpEntry>,
}

impl SftpManager {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
        }
    }

    pub fn connect(&mut self, req: SftpConnectRequest) -> Result<SftpSessionInfo, String> {
        let addr = format!("{}:{}", req.hostname, req.port);
        let tcp = TcpStream::connect(&addr)
            .map_err(|e| format!("TCP connect to {}: {}", addr, e))?;

        let mut session = Session::new().map_err(|e| format!("SSH session init: {}", e))?;
        session.set_tcp_stream(tcp);
        session.handshake().map_err(|e| format!("SSH handshake: {}", e))?;

        // Auth: try key first, fall back to password
        if let Some(key_path) = &req.private_key_path {
            session
                .userauth_pubkey_file(&req.username, None, std::path::Path::new(key_path), None)
                .map_err(|e| format!("Key auth failed: {}", e))?;
        } else if let Some(password) = &req.password {
            session
                .userauth_password(&req.username, password)
                .map_err(|e| format!("Password auth failed: {}", e))?;
        } else {
            // Try SSH agent
            session
                .userauth_agent(&req.username)
                .map_err(|e| format!("Agent auth failed: {}", e))?;
        }

        if !session.authenticated() {
            return Err("Authentication failed".to_string());
        }

        let remote_path = req.default_remote_path.clone().unwrap_or_else(|| "/".to_string());
        self.sessions.insert(req.session_id.clone(), SftpEntry { session });

        Ok(SftpSessionInfo {
            session_id: req.session_id,
            remote_path,
        })
    }

    pub fn list_remote(&self, session_id: &str, path: &str) -> Result<Vec<RemoteFileEntry>, String> {
        let entry = self
            .sessions
            .get(session_id)
            .ok_or_else(|| format!("SFTP session '{}' not found", session_id))?;

        let sftp = entry.session.sftp().map_err(|e| format!("SFTP subsystem: {}", e))?;
        let dir_entries = sftp
            .readdir(std::path::Path::new(path))
            .map_err(|e| format!("readdir '{}': {}", path, e))?;

        let mut result: Vec<RemoteFileEntry> = dir_entries
            .into_iter()
            .filter_map(|(pb, stat)| {
                let name = pb.file_name()?.to_string_lossy().to_string();
                if name == "." || name == ".." {
                    return None;
                }
                let is_dir = stat.file_type().is_dir();
                let is_symlink = stat.file_type().is_symlink();
                let size = if is_dir { None } else { Some(stat.size.unwrap_or(0)) };
                let modified = stat.mtime.map(|t| format_unix_timestamp(t as u64));
                Some(RemoteFileEntry {
                    name,
                    path: pb.to_string_lossy().to_string(),
                    is_dir,
                    is_symlink,
                    size,
                    permissions: stat.perm,
                    modified,
                })
            })
            .collect();

        result.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
        Ok(result)
    }

    pub fn disconnect(&mut self, session_id: &str) -> Result<(), String> {
        self.sessions
            .remove(session_id)
            .ok_or_else(|| format!("SFTP session '{}' not found", session_id))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sftp_manager_new() {
        let manager = SftpManager::new();
        assert_eq!(manager.sessions.len(), 0);
    }

    #[test]
    fn test_list_local_home() {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
        let result = list_local(&home);
        assert!(result.is_ok(), "list_local failed: {:?}", result.err());
        let entries = result.unwrap();
        assert!(!entries.is_empty());
    }

    #[test]
    fn test_list_local_nonexistent() {
        let result = list_local("/this/path/does/not/exist/ever");
        assert!(result.is_err());
    }

    #[test]
    fn test_disconnect_nonexistent_returns_error() {
        let mut manager = SftpManager::new();
        let result = manager.disconnect("nonexistent-id");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }
}
