use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Manager};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshKey {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub key_type: SshKeyType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u16>,
    pub fingerprint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remark: Option<String>,
    pub has_passphrase: bool,
    pub created_at: String,
    pub public_key: String,
    pub public_key_path: String,
    pub private_key_path: String,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SshKeyType {
    Ed25519,
    Rsa,
}

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
    let key = build_key_metadata(
        key_id,
        name,
        request.key_type,
        saved_size,
        request.remark,
        !passphrase.is_empty(),
        key_path,
        public_key_path,
    )?;
    save_metadata(app, &key)?;
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
    fs::write(&key_path, private_key).map_err(|e| format!("Failed to write private key: {}", e))?;
    set_private_key_permissions(&key_path)?;

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
    let key = build_key_metadata(
        key_id,
        name,
        key_type,
        size,
        request.remark,
        has_passphrase,
        key_path,
        public_key_path,
    )?;
    save_metadata(app, &key)?;
    Ok(key)
}

pub fn remove_ssh_keys(app: &AppHandle, ids: Vec<String>) -> Result<(), String> {
    let dir = keys_dir(app)?;
    for id in ids {
        if !is_valid_key_id(&id) {
            return Err("Invalid SSH key id".to_string());
        }

        let key_path = dir.join(&id);
        let public_key_path = key_path.with_extension("pub");
        let metadata_path = metadata_path(app, &id)?;

        remove_if_exists(&key_path)?;
        remove_if_exists(&public_key_path)?;
        remove_if_exists(&metadata_path)?;
    }

    Ok(())
}

fn build_key_metadata(
    id: String,
    name: String,
    key_type: SshKeyType,
    size: Option<u16>,
    remark: Option<String>,
    has_passphrase: bool,
    private_key_path: PathBuf,
    public_key_path: PathBuf,
) -> Result<SshKey, String> {
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
    })
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
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data directory: {}", e))?
        .join("ssh-keys"))
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
