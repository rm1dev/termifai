//! Single owner of programmatic SSH (libssh2) connect + host-key verification.
//!
//! `sftp.rs` and `dashboard.rs` both used to hand-roll near-identical
//! connect/handshake/auth logic with no host key verification at all. This
//! module is the one place that does it, so there is exactly one spot to get
//! host key checking right.
//!
//! The interactive terminal path (`pty_manager.rs`) spawns the system `ssh`
//! binary instead and is unaffected by this module — its host key handling
//! comes from the user's real `ssh` client.

use base64::engine::general_purpose::STANDARD_NO_PAD as B64;
use base64::Engine;
use ssh2::{CheckResult, HashType, KnownHostFileKind, Session};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub struct SshConfig<'a> {
    pub hostname: &'a str,
    pub port: u16,
    pub username: &'a str,
    pub password: Option<&'a str>,
    pub key_path: Option<&'a Path>,
}

#[derive(Debug)]
pub enum SshError {
    Tcp(String),
    Handshake(String),
    HostKeyMissing,
    HostKeyMismatch { fingerprint: String },
    HostKeyCheckFailed(String),
    Auth(String),
    NotAuthenticated,
}

impl std::fmt::Display for SshError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SshError::Tcp(e) => write!(f, "TCP connect failed: {e}"),
            SshError::Handshake(e) => write!(f, "SSH handshake failed: {e}"),
            SshError::HostKeyMissing => write!(f, "Server did not present a host key"),
            SshError::HostKeyMismatch { fingerprint } => write!(
                f,
                "Host key verification FAILED — the server's key does not match the one on \
                 record (fingerprint {fingerprint}). This can mean the host was reinstalled, or \
                 that someone is intercepting the connection. Remove the old entry from \
                 known_hosts only if you are sure the change is expected."
            ),
            SshError::HostKeyCheckFailed(e) => write!(f, "Could not verify host key: {e}"),
            SshError::Auth(e) => write!(f, "{e}"),
            SshError::NotAuthenticated => write!(f, "Authentication failed"),
        }
    }
}

impl std::error::Error for SshError {}

impl From<SshError> for String {
    fn from(e: SshError) -> String {
        e.to_string()
    }
}

/// Connect, verify the host key (trust-on-first-use, fail closed on mismatch),
/// authenticate, and return an authenticated session. `on_stage(stage, message)`
/// is called for progress reporting; stage is one of "connecting", "handshaking",
/// "authenticating".
pub fn connect(cfg: &SshConfig, on_stage: impl Fn(&str, &str)) -> Result<Session, SshError> {
    let addr = format!("{}:{}", cfg.hostname, cfg.port);

    on_stage(
        "connecting",
        &format!("Opening TCP connection to {addr}..."),
    );
    let tcp = TcpStream::connect(&addr).map_err(|e| SshError::Tcp(e.to_string()))?;
    tcp.set_read_timeout(Some(Duration::from_secs(15))).ok();
    tcp.set_write_timeout(Some(Duration::from_secs(15))).ok();

    let mut session = Session::new().map_err(|e| SshError::Handshake(e.to_string()))?;
    session.set_tcp_stream(tcp);

    on_stage("handshaking", "Starting SSH handshake...");
    session
        .handshake()
        .map_err(|e| SshError::Handshake(e.to_string()))?;

    verify_host_key(&session, cfg.hostname, cfg.port, &on_stage)?;

    on_stage(
        "authenticating",
        &format!("Authenticating as {}...", cfg.username),
    );
    if let Some(key_path) = cfg.key_path {
        session
            .userauth_pubkey_file(cfg.username, None, key_path, None)
            .map_err(|e| SshError::Auth(format!("Key auth failed: {e}")))?;
    } else if let Some(password) = cfg.password {
        session
            .userauth_password(cfg.username, password)
            .map_err(|e| SshError::Auth(format!("Password auth failed: {e}")))?;
    } else {
        session
            .userauth_agent(cfg.username)
            .map_err(|e| SshError::Auth(format!("Agent auth failed: {e}")))?;
    }

    if !session.authenticated() {
        return Err(SshError::NotAuthenticated);
    }

    // keepalive every 15s — prevents NAT/idle timeouts on long-lived sessions
    // (dashboard polling, open SFTP tabs).
    session.set_keepalive(true, 15);
    Ok(session)
}

/// Run a command over a fresh channel and return its stdout.
pub fn exec(session: &Session, cmd: &str) -> Result<String, String> {
    use std::io::Read;
    let mut channel = session
        .channel_session()
        .map_err(|e| format!("Channel open: {e}"))?;
    channel
        .exec(cmd)
        .map_err(|e| format!("Exec '{}': {e}", &cmd[..cmd.len().min(60)]))?;
    let mut output = String::new();
    channel
        .read_to_string(&mut output)
        .map_err(|e| format!("Read channel: {e}"))?;
    channel.wait_close().ok();
    Ok(output)
}

fn known_hosts_path() -> Option<PathBuf> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()?;
    Some(PathBuf::from(home).join(".ssh").join("known_hosts"))
}

/// OpenSSH stores non-default-port entries as `[host]:port`; port 22 is
/// stored as a bare hostname. `KnownHosts::add` requires this formatting
/// explicitly (unlike `check_port`, which takes the port separately).
fn host_key_entry_name(hostname: &str, port: u16) -> String {
    if port == 22 {
        hostname.to_string()
    } else {
        format!("[{hostname}]:{port}")
    }
}

fn verify_host_key(
    session: &Session,
    hostname: &str,
    port: u16,
    on_stage: &impl Fn(&str, &str),
) -> Result<(), SshError> {
    let (key, key_type) = session.host_key().ok_or(SshError::HostKeyMissing)?;
    let fingerprint = session
        .host_key_hash(HashType::Sha256)
        .map(|digest| format!("SHA256:{}", B64.encode(digest)))
        .unwrap_or_else(|| "<unavailable>".to_string());

    let known_hosts_path = known_hosts_path()
        .ok_or_else(|| SshError::HostKeyCheckFailed("no home directory".into()))?;

    let mut known_hosts = session
        .known_hosts()
        .map_err(|e| SshError::HostKeyCheckFailed(e.to_string()))?;
    // Missing file is fine on first run — nothing is "known" yet.
    let _ = known_hosts.read_file(&known_hosts_path, KnownHostFileKind::OpenSSH);

    match known_hosts.check_port(hostname, port, key) {
        CheckResult::Match => Ok(()),
        CheckResult::NotFound => {
            on_stage(
                "handshaking",
                &format!("Host key not yet known — trusting on first use ({fingerprint})."),
            );
            let entry_host = host_key_entry_name(hostname, port);
            known_hosts
                .add(&entry_host, key, hostname, key_type.into())
                .map_err(|e| SshError::HostKeyCheckFailed(e.to_string()))?;
            if let Some(parent) = known_hosts_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            known_hosts
                .write_file(&known_hosts_path, KnownHostFileKind::OpenSSH)
                .map_err(|e| SshError::HostKeyCheckFailed(e.to_string()))?;
            Ok(())
        }
        CheckResult::Mismatch => Err(SshError::HostKeyMismatch { fingerprint }),
        CheckResult::Failure => Err(SshError::HostKeyCheckFailed(
            "known_hosts check failed".into(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ssh2::KnownHostKeyFormat;

    #[test]
    fn host_key_entry_name_bare_for_default_port() {
        assert_eq!(host_key_entry_name("example.com", 22), "example.com");
    }

    #[test]
    fn host_key_entry_name_bracketed_for_nonstandard_port() {
        assert_eq!(
            host_key_entry_name("example.com", 2222),
            "[example.com]:2222"
        );
    }

    /// Exercises the actual `ssh2::KnownHosts` semantics `verify_host_key` relies
    /// on — match/not-found/mismatch — without a live SSH server. `Session::new()`
    /// works with no TCP connection because knownhost operations don't touch the
    /// wire; only `session.host_key()` (post-handshake) does, which is why
    /// `verify_host_key` itself needs a real connection and isn't unit-tested here.
    #[test]
    fn known_hosts_check_add_mismatch_roundtrip() {
        let session = Session::new().unwrap();
        let mut known_hosts = session.known_hosts().unwrap();
        let key: &[u8] = b"fake-host-key-bytes";
        let other_key: &[u8] = b"different-host-key-bytes";

        assert!(matches!(
            known_hosts.check("example.com", key),
            CheckResult::NotFound
        ));

        known_hosts
            .add(
                "example.com",
                key,
                "example.com",
                KnownHostKeyFormat::SshRsa,
            )
            .unwrap();

        assert!(matches!(
            known_hosts.check("example.com", key),
            CheckResult::Match
        ));
        assert!(matches!(
            known_hosts.check("example.com", other_key),
            CheckResult::Mismatch
        ));
    }
}
