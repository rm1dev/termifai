use crate::AppState;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use termifai_core::model::sync_state::{migrate_sync_state, SyncBackendConfig, SyncState};
use termifai_core::sync::{
    self, LocalDirBackend, LocalSnapshot, Manifest, SettingsBlob, SettingsPayload, SyncBackend,
    SyncError, SyncOutcome, TokenStore,
};

// ── Request / response DTOs (Tauri command boundary) ──────────────────────────

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncNowRequest {
    /// Falls back to the keychain-cached master password when omitted.
    pub master_password: Option<String>,
    #[serde(default)]
    pub app_theme: Option<SettingsBlob>,
    #[serde(default)]
    pub terminal_appearance: Option<SettingsBlob>,
    #[serde(default)]
    pub shortcuts: Option<SettingsBlob>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncNowResult {
    pub blob_version: u64,
    pub app_theme: SettingsBlob,
    pub terminal_appearance: SettingsBlob,
    pub shortcuts: SettingsBlob,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatusDto {
    pub backend: Option<SyncBackendConfig>,
    pub last_synced_blob_version: u64,
    pub last_sync_at: Option<String>,
    pub sync_ssh_keys: bool,
    pub dirty: bool,
    pub device_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSyncConfigRequest {
    pub backend: SyncBackendConfig,
    #[serde(default)]
    pub sync_ssh_keys: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultInitFromSyncRequest {
    pub backend: SyncBackendConfig,
    pub master_password: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncImportForeignRequest {
    pub backend: SyncBackendConfig,
    pub remote_master_password: String,
    /// Falls back to the keychain-cached master password when omitted.
    pub current_master_password: Option<String>,
    #[serde(default)]
    pub replace_remote: bool,
}

// ── Commands (thin coordinators — real logic below) ───────────────────────────

pub fn sync_get_config(app: &AppHandle) -> Result<SyncStatusDto, String> {
    let state = load_state(app)?;
    Ok(to_status_dto(&state))
}

fn open_url(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(url).spawn();
    #[cfg(target_os = "linux")]
    let _ = std::process::Command::new("xdg-open").arg(url).spawn();
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("cmd")
        .args(["/c", "start", "", url])
        .spawn();
    Ok(())
}

pub async fn sync_connect_provider(_app: AppHandle, provider: String) -> Result<String, String> {
    use oauth2::basic::BasicClient;
    use oauth2::{
        AuthUrl, ClientId, ClientSecret, CsrfToken, PkceCodeChallenge, RedirectUrl, TokenResponse,
        TokenUrl,
    };

    let client_id = sync::oauth::client_id(&provider)?;
    let client_secret = sync::oauth::client_secret(&provider);

    let (auth_url, token_url) = match provider.as_str() {
        "google" => (
            "https://accounts.google.com/o/oauth2/v2/auth",
            "https://oauth2.googleapis.com/token",
        ),
        "dropbox" => (
            "https://www.dropbox.com/oauth2/authorize",
            "https://api.dropboxapi.com/oauth2/token",
        ),
        _ => unreachable!(),
    };

    // Bind loopback listener. Google's "Desktop app" client type accepts any
    // loopback port automatically, so we let the OS pick one. Dropbox (like
    // most providers) requires the redirect_uri to exactly match one
    // pre-registered in the app's dashboard, so it needs a fixed port that
    // you register once — see `DROPBOX_REDIRECT_PORT` below.
    let bind_addr = if provider == "dropbox" {
        format!("127.0.0.1:{}", sync::oauth::DROPBOX_REDIRECT_PORT)
    } else {
        "127.0.0.1:0".to_string()
    };
    let listener = tokio::net::TcpListener::bind(&bind_addr)
        .await
        .map_err(|e| {
            if provider == "dropbox" {
                format!(
                    "Failed to bind 127.0.0.1:{} for the Dropbox OAuth callback — is another \
                 program using that port? ({e})",
                    sync::oauth::DROPBOX_REDIRECT_PORT
                )
            } else {
                format!("Failed to bind loopback address: {}", e)
            }
        })?;
    let port = listener.local_addr().unwrap().port();

    let client = BasicClient::new(
        ClientId::new(client_id.to_string()),
        client_secret.map(|s| ClientSecret::new(s.to_string())),
        AuthUrl::new(auth_url.to_string()).unwrap(),
        Some(TokenUrl::new(token_url.to_string()).unwrap()),
    )
    .set_redirect_uri(RedirectUrl::new(format!("http://127.0.0.1:{}/callback", port)).unwrap());

    let (pkce_challenge, pkce_verifier) = PkceCodeChallenge::new_random_sha256();
    let state = CsrfToken::new_random();

    let mut auth_request = client.authorize_url(|| state.clone());

    if provider == "google" {
        auth_request = auth_request
            .add_scope(oauth2::Scope::new(
                "https://www.googleapis.com/auth/drive.appdata".to_string(),
            ))
            .add_extra_param("prompt", "consent")
            .add_extra_param("access_type", "offline");
    } else if provider == "dropbox" {
        auth_request = auth_request
            .add_scope(oauth2::Scope::new("files.content.read".to_string()))
            .add_scope(oauth2::Scope::new("files.content.write".to_string()))
            .add_extra_param("token_access_type", "offline");
    }

    let (auth_url, csrf_token) = auth_request.set_pkce_challenge(pkce_challenge).url();

    // Open consent page in system browser
    open_url(auth_url.as_str())?;

    // Wait for callback redirection (timeout after 5 minutes)
    let timeout = tokio::time::sleep(tokio::time::Duration::from_secs(300));
    tokio::pin!(timeout);

    let accept_fut = listener.accept();
    tokio::pin!(accept_fut);

    let (mut stream, _) = tokio::select! {
        res = &mut accept_fut => {
            res.map_err(|e| format!("Failed to accept callback connection: {}", e))?
        }
        _ = &mut timeout => {
            return Err("Authorization timed out".to_string());
        }
    };

    // Read HTTP GET redirect request
    let mut buf = [0u8; 1024];
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let n = stream.read(&mut buf).await.map_err(|e| e.to_string())?;
    let request_str = String::from_utf8_lossy(&buf[..n]);
    let first_line = request_str.lines().next().unwrap_or("");

    let mut code = None;
    let mut incoming_state = None;

    if let Some(query_start) = first_line.find("?") {
        let query_end = first_line[query_start..]
            .find(" ")
            .unwrap_or(first_line[query_start..].len());
        let query_str = &first_line[query_start + 1..query_start + query_end];
        for pair in query_str.split("&") {
            let mut parts = pair.split("=");
            if let (Some(k), Some(v)) = (parts.next(), parts.next()) {
                if k == "code" {
                    code = Some(v.to_string());
                } else if k == "state" {
                    incoming_state = Some(v.to_string());
                }
            }
        }
    }

    let code = code.ok_or_else(|| "No authorization code found".to_string())?;
    let incoming_state = incoming_state.ok_or_else(|| "No state parameter found".to_string())?;

    if &incoming_state != csrf_token.secret() {
        return Err("State parameter mismatch (CSRF protection)".to_string());
    }

    // Respond back to browser
    let response_html = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\r\n\
        <html>\
        <head><title>Authorization Successful</title></head>\
        <body style=\"font-family: sans-serif; text-align: center; padding-top: 50px; background: #0f0f13; color: #e2e8f0;\">\
          <h1 style=\"color: #10b981;\">Authorization Successful!</h1>\
          <p>You can now close this browser tab and return to Termifai.</p>\
        </body>\
        </html>";
    let _ = stream.write_all(response_html.as_bytes()).await;
    let _ = stream.flush().await;

    // Exchange authorization code for tokens
    let token_result = client
        .exchange_code(oauth2::AuthorizationCode::new(code))
        .set_pkce_verifier(pkce_verifier)
        .request_async(oauth2::reqwest::async_http_client)
        .await
        .map_err(|e| format!("Token exchange failed: {:?}", e))?;

    let access_token = token_result.access_token().secret().to_string();
    let refresh_token = token_result
        .refresh_token()
        .ok_or_else(|| "No refresh token returned".to_string())?
        .secret()
        .to_string();

    let expires_in = token_result
        .expires_in()
        .map(|d| d.as_secs())
        .unwrap_or(3600);
    let expires_at = time::OffsetDateTime::now_utc() + time::Duration::seconds(expires_in as i64);
    let expires_at_rfc3339 = expires_at
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|e| e.to_string())?;

    let oauth_tokens = termifai_core::sync::oauth::OAuthTokens {
        access_token,
        refresh_token,
        expires_at_rfc3339,
    };

    let token_str = serde_json::to_string(&oauth_tokens).map_err(|e| e.to_string())?;
    let account = format!("sync-oauth-{}", provider);
    KeyringTokenStore.save(&account, &token_str)?;

    Ok(account)
}

pub fn sync_set_config(app: &AppHandle, request: SetSyncConfigRequest) -> Result<(), String> {
    let state = app.state::<AppState>();
    state
        .sync_state_store
        .update_with_migration(migrate_sync_state, |s| {
            s.backend = Some(request.backend.clone());
            s.sync_ssh_keys = request.sync_ssh_keys;
            // A backend switch targets a different remote — start it fresh.
            s.last_synced_blob_version = 0;
            s.last_sync_at = None;
            s.dirty = true;
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn sync_status(app: &AppHandle) -> Result<SyncStatusDto, String> {
    sync_get_config(app)
}

pub fn sync_disconnect(app: &AppHandle, delete_remote: bool) -> Result<(), String> {
    let current = load_state(app)?;
    if delete_remote {
        if let Some(backend_config) = &current.backend {
            wipe_remote(app, backend_config)?;
        }
    }
    let state = app.state::<AppState>();
    state
        .sync_state_store
        .update_with_migration(migrate_sync_state, |s| {
            s.backend = None;
            s.last_synced_blob_version = 0;
            s.last_sync_at = None;
            s.dirty = false;
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn sync_now(app: &AppHandle, request: SyncNowRequest) -> Result<SyncNowResult, String> {
    let sync_state = load_state(app)?;
    let backend_config = sync_state
        .backend
        .clone()
        .ok_or_else(|| "No sync backend configured".to_string())?;
    let master_password = resolve_master_password(request.master_password)?;
    let device_id = ensure_device_id(app)?;

    let settings = SettingsPayload {
        app_theme: request.app_theme.unwrap_or_default(),
        terminal_appearance: request.terminal_appearance.unwrap_or_default(),
        shortcuts: request.shortcuts.unwrap_or_default(),
    };

    let local = gather_local_snapshot(
        app,
        sync_state.sync_ssh_keys,
        settings,
        device_id,
        sync_state.device_name.clone(),
    )?;

    let backend = build_backend(app, &backend_config)?;
    let outcome = sync::run_sync(
        backend.as_ref(),
        local,
        &master_password,
        termifai_core::layout::DEFAULT_VAULT_ID,
    )
    .map_err(|e| e.to_string())?;

    apply_outcome(app, &outcome, sync_state.sync_ssh_keys)?;

    let blob_version = outcome.blob_version;
    let result = SyncNowResult {
        blob_version,
        app_theme: outcome.settings.app_theme.clone(),
        terminal_appearance: outcome.settings.terminal_appearance.clone(),
        shortcuts: outcome.settings.shortcuts.clone(),
    };

    let state = app.state::<AppState>();
    state
        .sync_state_store
        .update_with_migration(migrate_sync_state, |s| {
            s.last_synced_blob_version = blob_version;
            s.last_sync_at = Some(now_iso());
            s.dirty = false;
        })
        .map_err(|e| e.to_string())?;

    Ok(result)
}

/// Restore flow (1.7-A): a fresh device with no local vault, linking to an
/// existing synced vault. Nothing is written locally until the remote blob
/// decrypts successfully with the supplied master password.
pub fn vault_init_from_sync(
    app: &AppHandle,
    request: VaultInitFromSyncRequest,
) -> Result<(), String> {
    if crate::vault::read_crypto_meta(app)?.is_some() {
        return Err("Vault is already initialized".to_string());
    }

    let backend = build_backend(app, &request.backend)?;
    let (manifest, payload) =
        sync::fetch_remote_payload(backend.as_ref(), &request.master_password)
            .map_err(|e| e.to_string())?;

    // Decrypt succeeded — safe to start writing local state now.
    crate::vault::op_init(app, &request.master_password)?;

    let sync_ssh_keys = payload.ssh_keys.is_some();
    write_payload_to_local_stores(app, &payload)?;

    let device_id = ensure_device_id(app)?;
    let state = app.state::<AppState>();
    state
        .sync_state_store
        .update_with_migration(migrate_sync_state, |s| {
            s.backend = Some(request.backend.clone());
            s.sync_ssh_keys = sync_ssh_keys;
            s.last_synced_blob_version = manifest.blob_version;
            s.last_sync_at = Some(now_iso());
            s.dirty = false;
        })
        .map_err(|e| e.to_string())?;
    let _ = device_id;

    Ok(())
}

/// Foreign-vault-merge flow (1.7-B): the local vault is already unlocked,
/// and the configured backend turns out to hold data encrypted under a
/// different master password. Decrypts with the caller-supplied remote
/// password, merges into local state, then re-uploads under the *local*
/// device's own master password with a fresh sync salt.
pub fn sync_import_foreign(
    app: &AppHandle,
    request: SyncImportForeignRequest,
) -> Result<(), String> {
    if !crate::vault::is_unlocked() {
        return Err("Vault is locked".to_string());
    }
    let current_master_password = resolve_master_password(request.current_master_password)?;

    let backend = build_backend(app, &request.backend)?;
    let (manifest, foreign_payload) =
        sync::fetch_remote_payload(backend.as_ref(), &request.remote_master_password)
            .map_err(|e| e.to_string())?;

    let sync_state = load_state(app)?;
    let device_id = ensure_device_id(app)?;
    let device_name = sync_state.device_name.clone();

    let outcome = if request.replace_remote {
        // Overwrite remote with this device's own state — no merge.
        let local = gather_local_snapshot(
            app,
            sync_state.sync_ssh_keys,
            SettingsPayload::default(),
            device_id.clone(),
            device_name.clone(),
        )?;
        sync::merge_snapshot(&local, None)
    } else {
        let local = gather_local_snapshot(
            app,
            sync_state.sync_ssh_keys,
            SettingsPayload::default(),
            device_id.clone(),
            device_name.clone(),
        )?;
        sync::merge_snapshot(&local, Some(foreign_payload))
    };

    apply_outcome(app, &outcome, sync_state.sync_ssh_keys)?;

    // Re-encrypt and re-upload under the current device's own master
    // password with a fresh salt, so other devices hit the standard
    // "master password changed elsewhere" re-link path on their next sync.
    let new_salt = sync::random_sync_salt();
    let key = sync::derive_sync_key(&current_master_password, &new_salt)
        .map_err(|e| format!("Failed to derive sync key: {:?}", e))?;
    let merged_payload = termifai_core::sync::SyncPayload {
        format_version: sync::PAYLOAD_FORMAT_VERSION,
        exported_at: now_iso(),
        device_id: device_id.clone(),
        hosts: outcome.hosts.clone(),
        groups: outcome.groups.clone(),
        snippets: outcome.snippets.clone(),
        port_forwards: outcome.port_forwards.clone(),
        ssh_keys: outcome.ssh_keys.clone(),
        settings: outcome.settings.clone(),
        tombstones: outcome.tombstones.clone(),
    };
    let blob_str = sync::encrypt_payload(&key, &merged_payload)
        .map_err(|e| format!("Failed to encrypt sync payload: {:?}", e))?;
    let blob_bytes = blob_str.into_bytes();
    let new_manifest = Manifest {
        format_version: sync::PAYLOAD_FORMAT_VERSION,
        vault_id: termifai_core::layout::DEFAULT_VAULT_ID.to_string(),
        blob_version: manifest.blob_version + 1,
        updated_at: now_iso(),
        device_id: device_id.clone(),
        device_name,
        kdf: sync::default_kdf_params(),
        sync_salt: sync::b64_encode(&new_salt),
        blob_sha256: sync::sha256_hex(&blob_bytes),
    };
    backend
        .store(&new_manifest, &blob_bytes, Some(manifest.blob_version))
        .map_err(|e| e.to_string())?;

    let state = app.state::<AppState>();
    state
        .sync_state_store
        .update_with_migration(migrate_sync_state, |s| {
            s.backend = Some(request.backend.clone());
            s.last_synced_blob_version = new_manifest.blob_version;
            s.last_sync_at = Some(now_iso());
            s.dirty = false;
        })
        .map_err(|e| e.to_string())?;

    Ok(())
}

// ── Internals ──────────────────────────────────────────────────────────────────

pub(crate) fn load_state(app: &AppHandle) -> Result<SyncState, String> {
    let state = app.state::<AppState>();
    state
        .sync_state_store
        .load_with_migration(migrate_sync_state)
        .map_err(|e| e.to_string())
}

fn to_status_dto(state: &SyncState) -> SyncStatusDto {
    SyncStatusDto {
        backend: state.backend.clone(),
        last_synced_blob_version: state.last_synced_blob_version,
        last_sync_at: state.last_sync_at.clone(),
        sync_ssh_keys: state.sync_ssh_keys,
        dirty: state.dirty,
        device_id: state.device_id.clone(),
    }
}

fn ensure_device_id(app: &AppHandle) -> Result<String, String> {
    let existing = load_state(app)?.device_id;
    if let Some(id) = existing {
        return Ok(id);
    }
    let id = format!("dev-{}", uuid::Uuid::new_v4());
    let state = app.state::<AppState>();
    state
        .sync_state_store
        .update_with_migration(migrate_sync_state, |s| {
            s.device_id = Some(id.clone());
        })
        .map_err(|e| e.to_string())?;
    Ok(id)
}

/// Falls back to the OS-keychain-cached master password (already used for
/// silent unlock) so background/automatic syncs don't need to prompt.
fn resolve_master_password(explicit: Option<String>) -> Result<String, String> {
    if let Some(pw) = explicit.filter(|p| !p.is_empty()) {
        return Ok(pw);
    }
    crate::vault::cached_master_password().ok_or_else(|| "master_password_required".to_string())
}

struct KeyringTokenStore;

impl termifai_core::sync::TokenStore for KeyringTokenStore {
    fn load(&self, account: &str) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new("termifai", account)
            .map_err(|e| format!("Keychain unavailable: {e}"))?;
        match entry.get_password() {
            Ok(pw) => Ok(Some(pw)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    fn save(&self, account: &str, value: &str) -> Result<(), String> {
        let entry = keyring::Entry::new("termifai", account)
            .map_err(|e| format!("Keychain unavailable: {e}"))?;
        entry.set_password(value).map_err(|e| e.to_string())
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        let entry = keyring::Entry::new("termifai", account)
            .map_err(|e| format!("Keychain unavailable: {e}"))?;
        let _ = entry.delete_credential();
        Ok(())
    }
}

/// `fs::create_dir_all("~/foo")` creates a literal directory named `~` next
/// to the app's working directory — the filesystem never expands `~`, only
/// shells do. Expand it ourselves so a path typed in Settings behaves the
/// way the user expects.
fn expand_home(path: &str) -> std::path::PathBuf {
    if let Some(rest) = path
        .strip_prefix("~/")
        .or_else(|| (path == "~").then_some(""))
    {
        if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
            return std::path::PathBuf::from(home).join(rest);
        }
    }
    std::path::PathBuf::from(path)
}

fn build_backend(
    app: &AppHandle,
    config: &SyncBackendConfig,
) -> Result<Box<dyn SyncBackend>, String> {
    use std::sync::Arc;
    match config {
        SyncBackendConfig::LocalDir { path } => {
            Ok(Box::new(LocalDirBackend::new(expand_home(path))))
        }
        SyncBackendConfig::GoogleDrive => Ok(Box::new(
            termifai_core::sync::GoogleDriveBackend::new(Arc::new(KeyringTokenStore)),
        )),
        SyncBackendConfig::Dropbox => Ok(Box::new(termifai_core::sync::DropboxBackend::new(
            Arc::new(KeyringTokenStore),
        ))),
        SyncBackendConfig::Sftp {
            host_id,
            remote_path,
        } => {
            let hosts_vault = crate::hosts::list_hosts(app)?;
            let host = hosts_vault
                .hosts
                .iter()
                .find(|h| &h.id == host_id)
                .ok_or_else(|| format!("Sync server host '{}' not found", host_id))?;

            let password = crate::hosts::decrypt_host_password(host);

            let key_path = if let Some(ref key_id) = host.ssh_key_id {
                if !key_id.trim().is_empty() {
                    crate::ssh_keys::private_key_path(app, key_id)
                        .ok()
                        .map(std::path::PathBuf::from)
                } else {
                    None
                }
            } else {
                None
            };

            let backend = SftpSyncBackend::new(
                host.hostname.clone(),
                host.port,
                host.user.clone(),
                password,
                key_path,
                remote_path.clone(),
            );
            Ok(Box::new(backend))
        }
    }
}

fn gather_local_snapshot(
    app: &AppHandle,
    sync_ssh_keys: bool,
    settings: SettingsPayload,
    device_id: String,
    device_name: Option<String>,
) -> Result<LocalSnapshot, String> {
    let hosts_vault = crate::hosts::list_hosts(app)?;
    let mut hosts = hosts_vault.hosts;
    for host in hosts.iter_mut() {
        host.password = crate::hosts::decrypt_host_password(host);
    }

    let ssh_keys = if sync_ssh_keys {
        let mut keys = crate::ssh_keys::list_ssh_keys(app)?;
        for key in keys.iter_mut() {
            key.private_key_pem = crate::ssh_keys::read_private_key_pem(key).ok();
        }
        Some(keys)
    } else {
        None
    };

    Ok(LocalSnapshot {
        hosts,
        groups: hosts_vault.groups,
        snippets: crate::snippets::list_snippets(app)?,
        port_forwards: crate::port_forwarding::list_port_forwards(app)?,
        ssh_keys,
        settings,
        tombstones: crate::tombstones::list(app)?,
        device_id,
        device_name,
    })
}

/// Writes a merged result back to every local store: hosts (re-encrypting
/// plaintext passwords with the local DEK), groups, snippets, port forwards,
/// SSH keys (opt-in only), and the merged tombstone list.
fn apply_outcome(
    app: &AppHandle,
    outcome: &SyncOutcome,
    sync_ssh_keys: bool,
) -> Result<(), String> {
    let mut hosts = outcome.hosts.clone();
    for host in hosts.iter_mut() {
        if let Some(plaintext) = host.password.take() {
            if !plaintext.is_empty() {
                let guard = crate::vault::current_key();
                if let Some(key) = guard.as_ref() {
                    host.password = termifai_core::crypto::encrypt_field(key, &plaintext).ok();
                }
            }
        }
    }

    let state = app.state::<AppState>();
    let groups = outcome.groups.clone();
    state
        .hosts_store
        .update_with_migration(termifai_core::model::hosts::migrate_hosts_vault, |vault| {
            vault.hosts = hosts.clone();
            vault.groups = groups.clone();
        })
        .map_err(|e| e.to_string())?;

    let snippets = outcome.snippets.clone();
    state
        .snippets_store
        .update_with_migration(
            termifai_core::model::snippets::migrate_snippets_vault,
            |vault| {
                vault.snippets = snippets.clone();
            },
        )
        .map_err(|e| e.to_string())?;

    let port_forwards = outcome.port_forwards.clone();
    state
        .port_forward_store
        .update_with_migration(
            termifai_core::model::forwards::migrate_port_forward_vault,
            |vault| {
                vault.rules = port_forwards.clone();
            },
        )
        .map_err(|e| e.to_string())?;

    if sync_ssh_keys {
        if let Some(merged_keys) = &outcome.ssh_keys {
            let local_keys = crate::ssh_keys::list_ssh_keys(app)?;
            let merged_ids: std::collections::HashSet<&str> =
                merged_keys.iter().map(|k| k.id.as_str()).collect();

            // New keys this device doesn't have yet.
            for key in merged_keys {
                if !local_keys.iter().any(|k| k.id == key.id) {
                    crate::ssh_keys::import_synced_key(app, key)?;
                }
            }
            // Keys removed elsewhere — tombstone-driven deletion propagates here.
            let removed: Vec<String> = local_keys
                .iter()
                .filter(|k| !merged_ids.contains(k.id.as_str()))
                .map(|k| k.id.clone())
                .collect();
            if !removed.is_empty() {
                crate::ssh_keys::remove_ssh_keys(app, removed)?;
            }
        }
    }

    crate::tombstones::replace_and_prune(app, outcome.tombstones.clone())?;
    Ok(())
}

fn write_payload_to_local_stores(
    app: &AppHandle,
    payload: &termifai_core::sync::SyncPayload,
) -> Result<(), String> {
    let outcome = SyncOutcome {
        hosts: payload.hosts.clone(),
        groups: payload.groups.clone(),
        snippets: payload.snippets.clone(),
        port_forwards: payload.port_forwards.clone(),
        ssh_keys: payload.ssh_keys.clone(),
        settings: payload.settings.clone(),
        tombstones: payload.tombstones.clone(),
        blob_version: 0,
    };
    apply_outcome(app, &outcome, payload.ssh_keys.is_some())
}

fn now_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

/// Deletes the remote blob + manifest. Cloud/SFTP backends (phases 2/3) will
/// need their own delete semantics when those variants are added.
fn wipe_remote(app: &AppHandle, config: &SyncBackendConfig) -> Result<(), String> {
    let backend = build_backend(app, config)?;
    backend.wipe().map_err(|e| e.to_string())
}

pub struct SftpSyncBackend {
    hostname: String,
    port: u16,
    username: String,
    password: Option<String>,
    key_path: Option<std::path::PathBuf>,
    remote_path: String,
}

impl SftpSyncBackend {
    pub fn new(
        hostname: String,
        port: u16,
        username: String,
        password: Option<String>,
        key_path: Option<std::path::PathBuf>,
        remote_path: String,
    ) -> Self {
        Self {
            hostname,
            port,
            username,
            password,
            key_path,
            remote_path,
        }
    }

    fn connect(&self) -> Result<ssh2::Session, String> {
        let ssh_cfg = crate::ssh::SshConfig {
            hostname: &self.hostname,
            port: self.port,
            username: &self.username,
            password: self.password.as_deref(),
            key_path: self.key_path.as_deref(),
        };
        crate::ssh::connect(&ssh_cfg, |_, _| {})
            .map_err(|e| format!("Failed to connect to sync server: {}", e))
    }

    /// SFTP never expands `~` — a configured path like `~/.termifai/sync` would
    /// be taken literally (a directory named `~`). Resolve it against the
    /// server-side home directory (`realpath(".")`).
    fn resolve_remote_dir(&self, sftp: &ssh2::Sftp) -> Result<std::path::PathBuf, SyncError> {
        let raw = self.remote_path.trim();
        if raw == "~" || raw.starts_with("~/") {
            let home = sftp.realpath(std::path::Path::new(".")).map_err(|e| {
                SyncError::Backend(format!("Failed to resolve remote home directory: {}", e))
            })?;
            Ok(if raw == "~" {
                home
            } else {
                home.join(&raw[2..])
            })
        } else {
            Ok(std::path::PathBuf::from(raw))
        }
    }

    /// Resolves the remote directory and creates it (with any missing parents —
    /// SFTP mkdir is not recursive) so first sync against a fresh server works.
    fn ensure_remote_dir(&self, sftp: &ssh2::Sftp) -> Result<std::path::PathBuf, SyncError> {
        let dir = self.resolve_remote_dir(sftp)?;
        let mut current = std::path::PathBuf::new();
        for component in dir.components() {
            current.push(component);
            if sftp.stat(&current).is_err() {
                sftp.mkdir(&current, 0o755).map_err(|e| {
                    SyncError::Backend(format!(
                        "Failed to create remote directory {}: {}",
                        current.display(),
                        e
                    ))
                })?;
            }
        }
        Ok(dir)
    }

    fn acquire_lock(
        &self,
        sftp: &ssh2::Sftp,
        lock_path: &std::path::Path,
    ) -> Result<(), SyncError> {
        use ssh2::{OpenFlags, OpenType};
        let mut attempts = 0;
        loop {
            match sftp.open_mode(
                lock_path,
                OpenFlags::CREATE | OpenFlags::EXCLUSIVE | OpenFlags::WRITE,
                0o644,
                OpenType::File,
            ) {
                Ok(_) => return Ok(()),
                Err(open_err) => {
                    match sftp.stat(lock_path) {
                        Ok(stat) => {
                            if let Some(mtime) = stat.mtime {
                                let now = time::OffsetDateTime::now_utc().unix_timestamp() as u64;
                                if now > mtime && now - mtime > 120 {
                                    let _ = sftp.unlink(lock_path);
                                    continue;
                                }
                            }
                        }
                        // The lock file doesn't exist, so the open failure wasn't
                        // contention — report the real error instead of retrying
                        // into a misleading "remote changed concurrently".
                        Err(_) => {
                            return Err(SyncError::Backend(format!(
                                "Failed to create sync lock file {}: {}",
                                lock_path.display(),
                                open_err
                            )))
                        }
                    }

                    attempts += 1;
                    if attempts > 5 {
                        return Err(SyncError::Conflict);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(500));
                }
            }
        }
    }
}

impl SyncBackend for SftpSyncBackend {
    fn fetch_manifest(&self) -> Result<Option<Manifest>, SyncError> {
        let session = self.connect().map_err(SyncError::Backend)?;
        let sftp = session
            .sftp()
            .map_err(|e| SyncError::Backend(e.to_string()))?;

        let remote_dir = self.ensure_remote_dir(&sftp)?;

        let manifest_path = remote_dir.join("manifest.json");
        let mut file = match sftp.open(&manifest_path) {
            Ok(f) => f,
            Err(_) => return Ok(None),
        };

        use std::io::Read;
        let mut contents = String::new();
        file.read_to_string(&mut contents)
            .map_err(|e| SyncError::Io(e.to_string()))?;

        let manifest: Manifest = serde_json::from_str(&contents)?;
        Ok(Some(manifest))
    }

    fn fetch_blob(&self) -> Result<Vec<u8>, SyncError> {
        let session = self.connect().map_err(SyncError::Backend)?;
        let sftp = session
            .sftp()
            .map_err(|e| SyncError::Backend(e.to_string()))?;

        let remote_dir = self.resolve_remote_dir(&sftp)?;
        let blob_path = remote_dir.join("vault.blob");

        let mut file = sftp.open(&blob_path).map_err(|_| SyncError::NotFound)?;

        use std::io::Read;
        let mut contents = Vec::new();
        file.read_to_end(&mut contents)
            .map_err(|e| SyncError::Io(e.to_string()))?;
        Ok(contents)
    }

    fn store(
        &self,
        manifest: &Manifest,
        blob: &[u8],
        expected_blob_version: Option<u64>,
    ) -> Result<(), SyncError> {
        let session = self.connect().map_err(SyncError::Backend)?;
        let sftp = session
            .sftp()
            .map_err(|e| SyncError::Backend(e.to_string()))?;

        let remote_dir = self.ensure_remote_dir(&sftp)?;

        let lock_path = remote_dir.join(".lock");
        let manifest_path = remote_dir.join("manifest.json");

        // 1. Acquire exclusive lock
        self.acquire_lock(&sftp, &lock_path)?;

        // 2. CAS check
        let mut conflict = false;
        let current_manifest = sftp.open(&manifest_path).ok().and_then(|mut f| {
            use std::io::Read;
            let mut contents = String::new();
            f.read_to_string(&mut contents).ok()?;
            serde_json::from_str::<Manifest>(&contents).ok()
        });

        match (expected_blob_version, current_manifest.as_ref()) {
            (None, None) => {}
            (None, Some(_)) => conflict = true,
            (Some(expected), Some(current)) if current.blob_version != expected => conflict = true,
            (Some(_), None) => conflict = true,
            _ => {}
        }

        if conflict {
            let _ = sftp.unlink(&lock_path);
            return Err(SyncError::Conflict);
        }

        // 3. Write temp files
        let blob_tmp = remote_dir.join("vault.blob.tmp");
        let manifest_tmp = remote_dir.join("manifest.json.tmp");

        {
            use std::io::Write;
            let mut f_blob = sftp
                .create(&blob_tmp)
                .map_err(|e| SyncError::Backend(e.to_string()))?;
            f_blob
                .write_all(blob)
                .map_err(|e| SyncError::Io(e.to_string()))?;
        }

        {
            use std::io::Write;
            let manifest_bytes = serde_json::to_vec_pretty(manifest)?;
            let mut f_manifest = sftp
                .create(&manifest_tmp)
                .map_err(|e| SyncError::Backend(e.to_string()))?;
            f_manifest
                .write_all(&manifest_bytes)
                .map_err(|e| SyncError::Io(e.to_string()))?;
        }

        // 4. Rename temp to final (atomic per file)
        let blob_path = remote_dir.join("vault.blob");
        let _ = sftp.unlink(&blob_path);
        sftp.rename(&blob_tmp, &blob_path, None)
            .map_err(|e| SyncError::Backend(e.to_string()))?;

        let _ = sftp.unlink(&manifest_path);
        sftp.rename(&manifest_tmp, &manifest_path, None)
            .map_err(|e| SyncError::Backend(e.to_string()))?;

        // 5. Release lock
        let _ = sftp.unlink(&lock_path);

        Ok(())
    }

    fn wipe(&self) -> Result<(), SyncError> {
        let session = self.connect().map_err(SyncError::Backend)?;
        let sftp = session
            .sftp()
            .map_err(|e| SyncError::Backend(e.to_string()))?;

        let remote_dir = self.resolve_remote_dir(&sftp)?;
        let _ = sftp.unlink(&remote_dir.join("manifest.json"));
        let _ = sftp.unlink(&remote_dir.join("vault.blob"));
        let _ = sftp.unlink(&remote_dir.join(".lock"));
        Ok(())
    }
}
