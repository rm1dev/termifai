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

use base64::engine::general_purpose::STANDARD as B64_PADDED;
use base64::engine::general_purpose::STANDARD_NO_PAD as B64;
use base64::Engine;
use hmac::{Hmac, Mac};
use sha1::Sha1;
use ssh2::{CheckResult, HashType, KnownHostFileKind, MethodType, Session};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

type HmacSha1 = Hmac<Sha1>;

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
    let sock_addrs: Vec<std::net::SocketAddr> =
        std::net::ToSocketAddrs::to_socket_addrs(&addr.as_str())
            .map_err(|e| SshError::Tcp(e.to_string()))?
            .collect();

    // Match TcpStream::connect semantics: try every resolved address in
    // order (IPv4/IPv6 dual-stack, round-robin DNS), but bound each dial.
    let mut tcp: Option<TcpStream> = None;
    let mut last_err: Option<std::io::Error> = None;
    for sock_addr in &sock_addrs {
        match TcpStream::connect_timeout(sock_addr, Duration::from_secs(10)) {
            Ok(stream) => {
                tcp = Some(stream);
                break;
            }
            Err(e) => last_err = Some(e),
        }
    }
    let tcp = tcp.ok_or_else(|| match last_err {
        Some(e) => SshError::Tcp(e.to_string()),
        None => SshError::Tcp(format!("Could not resolve {addr}")),
    })?;
    // This timeout bounds a single blocking read()/write() on the socket, not
    // the whole operation — but it's set on the session's TCP stream for its
    // entire lifetime, which SFTP reuses for uploads/downloads/directory
    // listings that can run far longer than a handshake. 15s was tight enough
    // to fail large transfers or slow links ("Timed out waiting on socket")
    // even though the connection was alive; 120s still catches a genuinely
    // dead socket while giving slow I/O room to complete. True liveness is
    // covered separately by the 15s keepalive below.
    tcp.set_read_timeout(Some(Duration::from_secs(120))).ok();
    tcp.set_write_timeout(Some(Duration::from_secs(120))).ok();

    let mut session = Session::new().map_err(|e| SshError::Handshake(e.to_string()))?;
    session.set_tcp_stream(tcp);

    // Nudge libssh2 to negotiate whichever host key type is already recorded
    // for this host in known_hosts (mirroring what the system `ssh` binary
    // does). Without this, libssh2's own default algorithm order can pick a
    // *different* key type than what's on record — e.g. RSA when only an
    // ED25519 entry exists — and verify_host_key below would then report a
    // spurious mismatch for a host that hasn't actually changed.
    if let Some(prefs) = preferred_host_key_algorithms(cfg.hostname, cfg.port) {
        let _ = session.method_pref(MethodType::HostKey, &prefs);
    }

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

/// Reads known_hosts (plain text, OpenSSH format) and builds a libssh2
/// host-key algorithm preference string that puts whatever type(s) are
/// already on record for this host first, followed by the standard set as
/// a fallback so a legitimate key rotation to an unrecorded type still works.
fn preferred_host_key_algorithms(hostname: &str, port: u16) -> Option<String> {
    let path = known_hosts_path()?;
    let contents = std::fs::read_to_string(path).ok()?;
    algorithms_pref_from_known_hosts_text(&contents, hostname, port)
}

/// Pure parsing logic behind [`preferred_host_key_algorithms`], split out so
/// it's testable without touching the real `known_hosts` file or `HOME` env var.
fn algorithms_pref_from_known_hosts_text(
    contents: &str,
    hostname: &str,
    port: u16,
) -> Option<String> {
    let entry_host = host_key_entry_name(hostname, port);

    let mut recorded: Vec<String> = Vec::new();
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut fields = line.split_whitespace();
        let Some(host_field) = fields.next() else {
            continue;
        };
        let matches_host = if host_field.starts_with("|1|") {
            // HashKnownHosts format: the hostname isn't stored in plain text,
            // so literal comparison can never match — it must be verified via
            // HMAC-SHA1(salt, hostname), same as OpenSSH itself does.
            hashed_host_matches(host_field, hostname)
                || hashed_host_matches(host_field, &entry_host)
        } else {
            host_field
                .split(',')
                .any(|h| h == hostname || h == entry_host)
        };
        if !matches_host {
            continue;
        }
        if let Some(alg) = fields.next() {
            if !recorded.iter().any(|r| r == alg) {
                recorded.push(alg.to_string());
            }
        }
    }

    if recorded.is_empty() {
        return None;
    }

    // "ssh-rsa" in known_hosts describes the key *blob* format, not the
    // signature algorithm — libssh2/OpenSSH may negotiate the modern SHA-2
    // signature variants over the same recorded RSA key, so offer those first.
    let mut prefs: Vec<String> = Vec::new();
    for alg in &recorded {
        if alg == "ssh-rsa" {
            prefs.push("rsa-sha2-512".to_string());
            prefs.push("rsa-sha2-256".to_string());
        }
        prefs.push(alg.clone());
    }

    for fallback in [
        "ssh-ed25519",
        "ecdsa-sha2-nistp256",
        "ecdsa-sha2-nistp384",
        "ecdsa-sha2-nistp521",
        "rsa-sha2-512",
        "rsa-sha2-256",
        "ssh-rsa",
    ] {
        if !prefs.iter().any(|p| p == fallback) {
            prefs.push(fallback.to_string());
        }
    }

    Some(prefs.join(","))
}

/// Checks a candidate hostname against an OpenSSH `HashKnownHosts`-format
/// field: `|1|<base64 salt>|<base64 HMAC-SHA1(salt, hostname)>`. This is the
/// same construction OpenSSH itself uses (see `ssh_config(5)` HashKnownHosts).
fn hashed_host_matches(host_field: &str, candidate: &str) -> bool {
    let Some(rest) = host_field.strip_prefix("|1|") else {
        return false;
    };
    let Some((salt_b64, hash_b64)) = rest.split_once('|') else {
        return false;
    };
    let Ok(salt) = B64_PADDED.decode(salt_b64) else {
        return false;
    };
    let Ok(expected) = B64_PADDED.decode(hash_b64) else {
        return false;
    };
    let Ok(mut mac) = HmacSha1::new_from_slice(&salt) else {
        return false;
    };
    mac.update(candidate.as_bytes());
    mac.verify_slice(&expected).is_ok()
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
    fn algorithms_pref_prioritizes_recorded_type() {
        // Reproduces the reported bug: a host recorded only under ED25519 (e.g.
        // added by the system `ssh` binary) must make libssh2 prefer ED25519
        // too, or it may negotiate RSA by default and falsely report a mismatch.
        let known_hosts = "185.252.30.206 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI...\n";
        let prefs = algorithms_pref_from_known_hosts_text(known_hosts, "185.252.30.206", 22)
            .expect("should find a recorded algorithm");
        assert!(
            prefs.starts_with("ssh-ed25519"),
            "recorded type must be first, got: {prefs}"
        );
        // Fallback set must still be present so a real key-type rotation works.
        assert!(prefs.contains("rsa-sha2-512"));
        assert!(prefs.contains("ssh-rsa"));
    }

    #[test]
    fn hashed_host_matches_self_generated_entry() {
        // Round-trip check of the HMAC-SHA1 construction itself, independent of
        // any real-world known_hosts sample: generate a hashed entry exactly the
        // way OpenSSH's HashKnownHosts does, then confirm we can verify it.
        let salt = b"0123456789abcdefghij"; // 20 bytes, matches SHA1 digest size
        let mut mac = HmacSha1::new_from_slice(salt).unwrap();
        mac.update(b"self-test-host".as_slice());
        let digest = mac.finalize().into_bytes();
        let field = format!(
            "|1|{}|{}",
            B64_PADDED.encode(salt),
            B64_PADDED.encode(digest)
        );
        assert!(hashed_host_matches(&field, "self-test-host"));
        assert!(!hashed_host_matches(&field, "wrong-host"));
    }

    #[test]
    fn hashed_host_matches_real_openssh_hashknownhosts_entry() {
        // Real HashKnownHosts-format line reported from a user's ~/.ssh/known_hosts
        // (Ubuntu 24.04, HashKnownHosts yes) that was silently un-matched before
        // hashed-entry support was added, causing preferred_host_key_algorithms
        // to always return None and libssh2 to negotiate the wrong key type.
        let line = "|1|6BS5bhOa51c43ob788+AeJFWXgQ=|3aeVyKbmK1iIxVUsP0efXmiBWDg=";
        assert!(hashed_host_matches(line, "185.252.30.210"));
        assert!(!hashed_host_matches(line, "some-other-host.example"));
    }

    #[test]
    fn algorithms_pref_matches_hashed_known_hosts_entries() {
        let known_hosts =
            "|1|6BS5bhOa51c43ob788+AeJFWXgQ=|3aeVyKbmK1iIxVUsP0efXmiBWDg= ssh-ed25519 AAAAC3...\n";
        let prefs =
            algorithms_pref_from_known_hosts_text(known_hosts, "185.252.30.210", 22).unwrap();
        assert!(prefs.starts_with("ssh-ed25519"));
    }

    #[test]
    fn algorithms_pref_expands_ssh_rsa_to_sha2_variants_first() {
        let known_hosts = "example.com ssh-rsa AAAAB3NzaC1yc2EAAAA...\n";
        let prefs = algorithms_pref_from_known_hosts_text(known_hosts, "example.com", 22).unwrap();
        let rsa_sha2_512_pos = prefs.find("rsa-sha2-512").unwrap();
        let ssh_rsa_pos = prefs.find("ssh-rsa").unwrap();
        assert!(
            rsa_sha2_512_pos < ssh_rsa_pos,
            "modern rsa-sha2 variants must be offered before legacy ssh-rsa: {prefs}"
        );
    }

    #[test]
    fn algorithms_pref_matches_bracketed_nonstandard_port_entries() {
        let known_hosts = "[git.example.com]:2222 ssh-ed25519 AAAAC3...\n";
        let prefs =
            algorithms_pref_from_known_hosts_text(known_hosts, "git.example.com", 2222).unwrap();
        assert!(prefs.starts_with("ssh-ed25519"));
    }

    #[test]
    fn algorithms_pref_none_when_host_not_recorded() {
        let known_hosts = "other-host.com ssh-ed25519 AAAAC3...\n";
        assert!(algorithms_pref_from_known_hosts_text(known_hosts, "example.com", 22).is_none());
    }

    #[test]
    fn algorithms_pref_ignores_comments_and_blank_lines() {
        let known_hosts = "# comment\n\nexample.com ssh-ed25519 AAAAC3...\n";
        assert!(algorithms_pref_from_known_hosts_text(known_hosts, "example.com", 22).is_some());
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
