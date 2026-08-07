use serde::Deserialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Manager};
pub use termifai_core::model::ssh_keys::{SshKey, SshKeyType};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateSshKeyRequest {
    pub name: String,
    #[serde(rename = "type")]
    pub key_type: SshKeyType,
    pub size: Option<u16>,
    pub passphrase: Option<String>,
    pub remark: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSshKeyRequest {
    pub name: String,
    pub private_key: String,
    pub public_key: Option<String>,
    pub passphrase: Option<String>,
    pub remark: Option<String>,
}

pub fn list_ssh_keys(app: &AppHandle) -> Result<Vec<SshKey>, String> {
    let dir = keys_dir(app)?;
    ensure_dir(&dir)?;

    let mut keys = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| format!("Failed to read SSH keys: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read SSH key entry: {}", e))?;
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }

        let contents = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read SSH key metadata: {}", e))?;
        let key: SshKey = serde_json::from_str(&contents)
            .map_err(|e| format!("Failed to parse SSH key metadata: {}", e))?;
        keys.push(key);
    }

    keys.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(keys)
}

pub fn generate_ssh_key(app: &AppHandle, request: GenerateSshKeyRequest) -> Result<SshKey, String> {
    let name = normalize_name(&request.name)?;
    let passphrase = request.passphrase.unwrap_or_default();
    let key_id = new_key_id(&name);
    let key_path = keys_dir(app)?.join(&key_id);
    let public_key_path = key_path.with_extension("pub");
    let comment = request.remark.clone().unwrap_or_else(|| name.clone());

    ensure_dir(&keys_dir(app)?)?;
    ensure_available_filename(&key_path)?;
    ensure_available_filename(&public_key_path)?;

    let mut command = Command::new("ssh-keygen");
    command
        .arg("-q")
        .arg("-N")
        .arg(&passphrase)
        .arg("-C")
        .arg(&comment)
        .arg("-f")
        .arg(&key_path)
        .stdin(Stdio::null());

    let saved_size = match request.key_type {
        SshKeyType::Ed25519 => {
            command.arg("-t").arg("ed25519");
            None
        }
        SshKeyType::Rsa => {
            let size = request.size.unwrap_or(2048);
            validate_rsa_size(size)?;
            command.arg("-t").arg("rsa").arg("-b").arg(size.to_string());
            Some(size)
        }
    };

    let output = command
        .output()
        .map_err(|e| format!("Failed to run ssh-keygen: {}", e))?;
    if !output.status.success() {
        cleanup_key_files(&key_path, &public_key_path);
        return Err(command_error("ssh-keygen failed", &output.stderr));
    }

    set_private_key_permissions(&key_path)?;
    let key = build_key_metadata(KeyMetadataRequest {
        id: key_id,
        name,
        key_type: request.key_type,
        size: saved_size,
        remark: request.remark,
        has_passphrase: !passphrase.is_empty(),
        private_key_path: key_path,
        public_key_path,
    })?;
    save_metadata(app, &key)?;
    crate::sync::mark_dirty(app);
    Ok(key)
}

pub fn import_ssh_key(app: &AppHandle, request: ImportSshKeyRequest) -> Result<SshKey, String> {
    let name = normalize_name(&request.name)?;
    let key_id = new_key_id(&name);
    let key_path = keys_dir(app)?.join(&key_id);
    let public_key_path = key_path.with_extension("pub");
    let private_key = ensure_trailing_newline(request.private_key.trim())?;

    ensure_dir(&keys_dir(app)?)?;
    ensure_available_filename(&key_path)?;
    ensure_available_filename(&public_key_path)?;
    // از همون اول با 0600 بنویس تا کلید خصوصی لحظه‌ای world-readable نشه
    write_private_key_file(&key_path, &private_key)?;

    if let Some(public_key) = request.public_key {
        fs::write(
            &public_key_path,
            ensure_trailing_newline(public_key.trim())?,
        )
        .map_err(|e| format!("Failed to write public key: {}", e))?;
    } else {
        let output = Command::new("ssh-keygen")
            .arg("-y")
            .arg("-f")
            .arg(&key_path)
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("Failed to derive public key: {}", e))?;
        if !output.status.success() {
            cleanup_key_files(&key_path, &public_key_path);
            return Err(command_error("Failed to derive public key", &output.stderr));
        }
        fs::write(&public_key_path, &output.stdout)
            .map_err(|e| format!("Failed to write public key: {}", e))?;
    }

    let public_key = fs::read_to_string(&public_key_path)
        .map_err(|e| format!("Failed to read public key: {}", e))?;
    let (key_type, size) = parse_public_key_type(&public_key)?;
    let has_passphrase = request
        .passphrase
        .as_deref()
        .map(|value| !value.is_empty())
        .unwrap_or(false);
    let key = build_key_metadata(KeyMetadataRequest {
        id: key_id,
        name,
        key_type,
        size,
        remark: request.remark,
        has_passphrase,
        private_key_path: key_path,
        public_key_path,
    })?;
    save_metadata(app, &key)?;
    crate::sync::mark_dirty(app);
    Ok(key)
}

pub fn remove_ssh_keys(app: &AppHandle, ids: Vec<String>) -> Result<(), String> {
    let dir = keys_dir(app)?;
    for id in &ids {
        if !is_valid_key_id(id) {
            return Err("Invalid SSH key id".to_string());
        }

        let key_path = dir.join(id);
        let public_key_path = key_path.with_extension("pub");
        let metadata_path = metadata_path(app, id)?;

        remove_if_exists(&key_path)?;
        remove_if_exists(&public_key_path)?;
        remove_if_exists(&metadata_path)?;
    }

    crate::tombstones::record(app, crate::tombstones::EntityKind::SshKey, &ids)?;
    crate::sync::mark_dirty(app);
    Ok(())
}

pub fn private_key_path(app: &AppHandle, id: &str) -> Result<String, String> {
    if !is_valid_key_id(id) {
        return Err("Invalid SSH key id".to_string());
    }

    let contents = fs::read_to_string(metadata_path(app, id)?)
        .map_err(|e| format!("Failed to read SSH key metadata: {}", e))?;
    let key: SshKey = serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse SSH key metadata: {}", e))?;
    Ok(key.private_key_path)
}

struct KeyMetadataRequest {
    id: String,
    name: String,
    key_type: SshKeyType,
    size: Option<u16>,
    remark: Option<String>,
    has_passphrase: bool,
    private_key_path: PathBuf,
    public_key_path: PathBuf,
}

fn build_key_metadata(req: KeyMetadataRequest) -> Result<SshKey, String> {
    let KeyMetadataRequest {
        id,
        name,
        key_type,
        size,
        remark,
        has_passphrase,
        private_key_path,
        public_key_path,
    } = req;
    let public_key = fs::read_to_string(&public_key_path)
        .map_err(|e| format!("Failed to read public key: {}", e))?;
    let fingerprint = fingerprint(&public_key_path)?;
    let created_at = now_iso();

    Ok(SshKey {
        id,
        name,
        key_type,
        size,
        fingerprint,
        remark,
        has_passphrase,
        created_at,
        public_key: public_key.trim().to_string(),
        public_key_path: public_key_path.to_string_lossy().to_string(),
        private_key_path: private_key_path.to_string_lossy().to_string(),
        private_key_pem: None,
    })
}

/// Reads this key's private key file content — only ever called when the
/// user has opted in to syncing SSH keys.
pub fn read_private_key_pem(key: &SshKey) -> Result<String, String> {
    fs::read_to_string(&key.private_key_path)
        .map_err(|e| format!("Failed to read private key for sync: {}", e))
}

/// Writes a key received from sync that doesn't exist locally yet. Reuses
/// the same id (so future deletes/tombstones stay keyed consistently across
/// devices) and re-derives nothing — the payload already carries everything.
pub fn import_synced_key(app: &AppHandle, key: &SshKey) -> Result<(), String> {
    if !is_valid_key_id(&key.id) {
        return Err("Invalid SSH key id".to_string());
    }
    let Some(pem) = key.private_key_pem.as_deref() else {
        return Err("Synced key is missing private key content".to_string());
    };

    let dir = keys_dir(app)?;
    ensure_dir(&dir)?;
    let key_path = dir.join(&key.id);
    let public_key_path = key_path.with_extension("pub");

    if key_path.exists() {
        return Ok(()); // already imported on a previous sync cycle
    }

    if let Err(err) = write_private_key_file(&key_path, &ensure_trailing_newline(pem.trim())?) {
        cleanup_key_files(&key_path, &public_key_path);
        return Err(err);
    }
    if let Err(err) = fs::write(
        &public_key_path,
        ensure_trailing_newline(key.public_key.trim())?,
    ) {
        cleanup_key_files(&key_path, &public_key_path);
        return Err(format!("Failed to write synced public key: {}", err));
    }

    let mut local_key = key.clone();
    local_key.private_key_pem = None;
    local_key.public_key_path = public_key_path.to_string_lossy().to_string();
    local_key.private_key_path = key_path.to_string_lossy().to_string();
    save_metadata(app, &local_key)
}

fn save_metadata(app: &AppHandle, key: &SshKey) -> Result<(), String> {
    let path = metadata_path(app, &key.id)?;
    let json = serde_json::to_string_pretty(key)
        .map_err(|e| format!("Failed to serialize SSH key metadata: {}", e))?;
    fs::write(path, json).map_err(|e| format!("Failed to save SSH key metadata: {}", e))
}

fn fingerprint(public_key_path: &Path) -> Result<String, String> {
    let output = Command::new("ssh-keygen")
        .arg("-l")
        .arg("-E")
        .arg("sha256")
        .arg("-f")
        .arg(public_key_path)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("Failed to fingerprint public key: {}", e))?;
    if !output.status.success() {
        return Err(command_error(
            "Failed to fingerprint public key",
            &output.stderr,
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .split_whitespace()
        .nth(1)
        .map(|value| value.to_string())
        .ok_or_else(|| "Could not parse SSH key fingerprint".to_string())
}

fn parse_public_key_type(public_key: &str) -> Result<(SshKeyType, Option<u16>), String> {
    let prefix = public_key
        .split_whitespace()
        .next()
        .ok_or_else(|| "Invalid public key".to_string())?;

    match prefix {
        "ssh-ed25519" => Ok((SshKeyType::Ed25519, None)),
        "ssh-rsa" => Ok((SshKeyType::Rsa, None)),
        _ => Err("Unsupported SSH key type".to_string()),
    }
}

fn keys_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data directory: {}", e))?;
    Ok(
        termifai_core::layout::vault_dir(&app_data_dir, termifai_core::layout::DEFAULT_VAULT_ID)
            .join("ssh-keys"),
    )
}

fn metadata_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(keys_dir(app)?.join(format!("{}.json", id)))
}

fn ensure_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| format!("Failed to create SSH keys directory: {}", e))
}

fn ensure_available_filename(path: &Path) -> Result<(), String> {
    if path.exists() {
        Err("An SSH key with this generated id already exists".to_string())
    } else {
        Ok(())
    }
}

fn normalize_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("SSH key name is required".to_string());
    }
    Ok(name.to_string())
}

fn new_key_id(name: &str) -> String {
    let slug = name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    let slug = if slug.is_empty() { "ssh-key" } else { &slug };
    format!("{}-{}", slug, uuid::Uuid::new_v4())
}

fn validate_rsa_size(size: u16) -> Result<(), String> {
    match size {
        1024 | 2048 | 4096 => Ok(()),
        _ => Err("RSA key size must be 1024, 2048, or 4096".to_string()),
    }
}

fn is_valid_key_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
}

fn ensure_trailing_newline(value: &str) -> Result<String, String> {
    if value.is_empty() {
        return Err("SSH key content is required".to_string());
    }
    Ok(format!("{}\n", value))
}

fn cleanup_key_files(private_key_path: &Path, public_key_path: &Path) {
    let _ = fs::remove_file(private_key_path);
    let _ = fs::remove_file(public_key_path);
}

fn remove_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Failed to remove SSH key file: {}", e)),
    }
}

pub fn remove_known_host(host_or_ip: &str) -> Result<(), String> {
    let clean_target = host_or_ip.trim();
    if clean_target.is_empty() {
        return Err("Target host or IP cannot be empty".to_string());
    }

    let host_only = if let Some(idx) = clean_target.find('@') {
        &clean_target[idx + 1..]
    } else {
        clean_target
    };

    let (hostname, port) = if host_only.starts_with('[') {
        if let Some(end_bracket) = host_only.find(']') {
            let h = &host_only[1..end_bracket];
            let p = host_only[end_bracket + 1..].strip_prefix(':');
            (h, p)
        } else {
            (host_only, None)
        }
    } else if let Some(colon_idx) = host_only.rfind(':') {
        if host_only.chars().filter(|&c| c == ':').count() == 1 {
            (&host_only[..colon_idx], Some(&host_only[colon_idx + 1..]))
        } else {
            (host_only, None)
        }
    } else {
        (host_only, None)
    };

    let mut targets_to_remove = vec![hostname.to_string()];
    if let Some(p) = port {
        if p != "22" {
            targets_to_remove.push(format!("[{}]:{}", hostname, p));
        }
    }
    if !targets_to_remove.contains(&clean_target.to_string()) {
        targets_to_remove.push(clean_target.to_string());
    }

    for target in &targets_to_remove {
        let _ = Command::new("ssh-keygen")
            .arg("-R")
            .arg(target)
            .stdin(Stdio::null())
            .output();
    }

    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        let known_hosts_path = PathBuf::from(home).join(".ssh").join("known_hosts");
        if known_hosts_path.exists() {
            if let Ok(contents) = fs::read_to_string(&known_hosts_path) {
                let mut modified = false;
                let new_lines: Vec<&str> = contents
                    .lines()
                    .filter(|line| {
                        let trimmed = line.trim();
                        if trimmed.is_empty() || trimmed.starts_with('#') {
                            return true;
                        }
                        let host_field = match trimmed.split_whitespace().next() {
                            Some(f) => f,
                            None => return true,
                        };

                        let matches = targets_to_remove.iter().any(|t| {
                            host_field == t
                                || host_field.split(',').any(|h| h == t)
                                || (t.contains(':') && host_field.contains(t))
                        });

                        if matches {
                            modified = true;
                            false
                        } else {
                            true
                        }
                    })
                    .collect();

                if modified {
                    let mut new_content = new_lines.join("\n");
                    if !new_content.is_empty() {
                        new_content.push('\n');
                    }
                    let temp_path = known_hosts_path.with_extension("tmp_termifai");
                    if fs::write(&temp_path, new_content.as_bytes()).is_ok() {
                        let _ = fs::rename(&temp_path, &known_hosts_path);
                    }
                }
            }
        }
    }

    Ok(())
}

fn command_error(prefix: &str, stderr: &[u8]) -> String {
    let details = String::from_utf8_lossy(stderr).trim().to_string();
    if details.is_empty() {
        prefix.to_string()
    } else {
        format!("{}: {}", prefix, details)
    }
}

fn now_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

/// Create/truncate a private key file with mode 0600 from the first byte written.
/// `fs::write` + later chmod leaves a world-readable window (and a permanent
/// leak if chmod fails after the write succeeded).
fn write_private_key_file(path: &Path, contents: &str) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .map_err(|e| format!("Failed to write private key: {}", e))?;
        file.write_all(contents.as_bytes())
            .map_err(|e| format!("Failed to write private key: {}", e))?;
        file.sync_all()
            .map_err(|e| format!("Failed to write private key: {}", e))?;
        // اگر فایل از قبل با پرمیشن شل‌تر وجود داشت، mode موقع create اعمال نمی‌شه
        set_private_key_permissions(path)?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        fs::write(path, contents).map_err(|e| format!("Failed to write private key: {}", e))?;
        Ok(())
    }
}

#[cfg(unix)]
fn set_private_key_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let permissions = fs::Permissions::from_mode(0o600);
    fs::set_permissions(path, permissions)
        .map_err(|e| format!("Failed to set private key permissions: {}", e))
}

#[cfg(not(unix))]
fn set_private_key_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn write_private_key_file_creates_owner_only_mode() {
        let dir = std::env::temp_dir().join(format!("termifai_key_perm_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("id_test");
        write_private_key_file(&path, "-----BEGIN OPENSSH PRIVATE KEY-----\n").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "private key must be 0600, got {mode:#o}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_remove_known_host_invalid_input() {
        assert!(remove_known_host("").is_err());
        assert!(remove_known_host("   ").is_err());
    }
}
