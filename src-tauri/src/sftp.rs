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
    fn test_disconnect_nonexistent_returns_error() {
        let mut manager = SftpManager::new();
        let result = manager.disconnect("nonexistent-id");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }
}
