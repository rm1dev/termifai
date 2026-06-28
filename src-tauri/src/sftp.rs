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

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TransferProgress {
    pub session_id: String,
    pub file_name: String,
    pub bytes_transferred: u64,
    pub total_bytes: u64,
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

    pub fn download_file<F>(
        &self,
        session_id: &str,
        remote_path: &str,
        local_path: &str,
        on_progress: F,
    ) -> Result<(), String>
    where
        F: Fn(TransferProgress),
    {
        let entry = self
            .sessions
            .get(session_id)
            .ok_or_else(|| format!("SFTP session '{}' not found", session_id))?;

        let sftp = entry.session.sftp().map_err(|e| format!("SFTP subsystem: {}", e))?;

        let remote_p = std::path::Path::new(remote_path);
        let stat = sftp.stat(remote_p).map_err(|e| format!("stat '{}': {}", remote_path, e))?;
        let total_bytes = stat.size.unwrap_or(0);

        let mut remote_file = sftp.open(remote_p).map_err(|e| format!("open remote: {}", e))?;

        let tmp_path = format!("{}.termifai_dl_tmp", local_path);
        let mut local_file = std::fs::File::create(&tmp_path)
            .map_err(|e| format!("create tmp file '{}': {}", tmp_path, e))?;

        let file_name = remote_p
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| remote_path.to_string());

        let mut buf = vec![0u8; 32 * 1024];
        let mut bytes_transferred = 0u64;

        let result = (|| {
            loop {
                use std::io::{Read, Write};
                let n = remote_file.read(&mut buf).map_err(|e| format!("read remote: {}", e))?;
                if n == 0 {
                    break;
                }
                local_file.write_all(&buf[..n]).map_err(|e| format!("write tmp: {}", e))?;
                bytes_transferred += n as u64;
                on_progress(TransferProgress {
                    session_id: session_id.to_string(),
                    file_name: file_name.clone(),
                    bytes_transferred,
                    total_bytes,
                });
            }
            use std::io::Write;
            local_file.flush().map_err(|e| format!("flush tmp: {}", e))?;
            Ok::<(), String>(())
        })();

        if let Err(e) = result {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(e);
        }

        std::fs::rename(&tmp_path, local_path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp_path);
            format!("rename tmp to '{}': {}", local_path, e)
        })
    }

    pub fn upload_file<F>(
        &self,
        session_id: &str,
        local_path: &str,
        remote_path: &str,
        on_progress: F,
    ) -> Result<(), String>
    where
        F: Fn(TransferProgress),
    {
        let entry = self
            .sessions
            .get(session_id)
            .ok_or_else(|| format!("SFTP session '{}' not found", session_id))?;

        let sftp = entry.session.sftp().map_err(|e| format!("SFTP subsystem: {}", e))?;

        let local_meta = std::fs::metadata(local_path)
            .map_err(|e| format!("stat local '{}': {}", local_path, e))?;
        let total_bytes = local_meta.len();

        let mut local_file =
            std::fs::File::open(local_path).map_err(|e| format!("open local: {}", e))?;

        let mut remote_file = sftp
            .create(std::path::Path::new(remote_path))
            .map_err(|e| format!("create remote '{}': {}", remote_path, e))?;

        let file_name = std::path::Path::new(local_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| local_path.to_string());

        let mut buf = vec![0u8; 32 * 1024];
        let mut bytes_transferred = 0u64;

        loop {
            use std::io::{Read, Write};
            let n = local_file.read(&mut buf).map_err(|e| format!("read local: {}", e))?;
            if n == 0 {
                break;
            }
            remote_file.write_all(&buf[..n]).map_err(|e| format!("write remote: {}", e))?;
            bytes_transferred += n as u64;
            on_progress(TransferProgress {
                session_id: session_id.to_string(),
                file_name: file_name.clone(),
                bytes_transferred,
                total_bytes,
            });
        }

        Ok(())
    }

    pub fn delete_remote(&self, session_id: &str, paths: &[String]) -> Result<(), String> {
        let entry = self
            .sessions
            .get(session_id)
            .ok_or_else(|| format!("SFTP session '{}' not found", session_id))?;

        let sftp = entry.session.sftp().map_err(|e| format!("SFTP subsystem: {}", e))?;

        for path in paths {
            let p = std::path::Path::new(path);
            let stat = sftp.stat(p).map_err(|e| format!("stat '{}': {}", path, e))?;
            if stat.file_type().is_dir() {
                sftp.rmdir(p).map_err(|e| format!("rmdir '{}': {}", path, e))?;
            } else {
                sftp.unlink(p).map_err(|e| format!("unlink '{}': {}", path, e))?;
            }
        }
        Ok(())
    }

    pub fn rename_remote(
        &self,
        session_id: &str,
        from_path: &str,
        to_path: &str,
    ) -> Result<(), String> {
        let entry = self
            .sessions
            .get(session_id)
            .ok_or_else(|| format!("SFTP session '{}' not found", session_id))?;

        let sftp = entry.session.sftp().map_err(|e| format!("SFTP subsystem: {}", e))?;
        sftp.rename(
            std::path::Path::new(from_path),
            std::path::Path::new(to_path),
            None,
        )
        .map_err(|e| format!("rename '{}' -> '{}': {}", from_path, to_path, e))
    }

    pub fn mkdir_remote(&self, session_id: &str, path: &str) -> Result<(), String> {
        let entry = self
            .sessions
            .get(session_id)
            .ok_or_else(|| format!("SFTP session '{}' not found", session_id))?;

        let sftp = entry.session.sftp().map_err(|e| format!("SFTP subsystem: {}", e))?;
        sftp.mkdir(std::path::Path::new(path), 0o755)
            .map_err(|e| format!("mkdir '{}': {}", path, e))
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
    fn test_download_no_session_returns_error() {
        let manager = SftpManager::new();
        let result = manager.download_file("nonexistent", "/remote/file.txt", "/tmp/out.txt", |_| {});
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }

    #[test]
    fn test_upload_no_session_returns_error() {
        let manager = SftpManager::new();
        let result = manager.upload_file("nonexistent", "/tmp/local.txt", "/remote/file.txt", |_| {});
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }

    #[test]
    fn test_delete_no_session_returns_error() {
        let manager = SftpManager::new();
        let result = manager.delete_remote("nonexistent", &["/remote/file.txt".to_string()]);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }

    #[test]
    fn test_rename_no_session_returns_error() {
        let manager = SftpManager::new();
        let result = manager.rename_remote("nonexistent", "/remote/old.txt", "/remote/new.txt");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }

    #[test]
    fn test_mkdir_no_session_returns_error() {
        let manager = SftpManager::new();
        let result = manager.mkdir_remote("nonexistent", "/remote/newdir");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }

    #[test]
    fn test_disconnect_nonexistent_returns_error() {
        let mut manager = SftpManager::new();
        let result = manager.disconnect("nonexistent-id");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }
}
