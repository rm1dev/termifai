use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use crate::sync::backend::{SyncError, TokenStore};

// Real values live in `oauth_secrets.rs`, which is gitignored so they can
// never be committed — copy `oauth_secrets.example.rs` to `oauth_secrets.rs`
// (same directory) and fill it in. See that file for where to get each value.
//
// Google's token endpoint rejects the PKCE exchange with "client_secret is
// missing" unless GOOGLE_CLIENT_SECRET is sent — even for "Desktop app"
// clients, which still get a client secret issued in the console. It is not
// a secret in the traditional sense (it ships inside every copy of the app
// and cannot be kept confidential), which is exactly why Google calls this
// client type "public" and doesn't ask you to protect it; PKCE is what
// actually secures the flow. It still must never be committed to a public
// repo, since GitHub (and others) scan for and flag it regardless.
include!("oauth_secrets.rs");

/// Dropbox rejects the OAuth request with "Invalid redirect_uri" unless it
/// exactly matches a URI pre-registered in the app's dashboard — unlike
/// Google's "Desktop app" client type, it does not accept an arbitrary
/// loopback port. So, unlike Google, Dropbox's callback listener binds this
/// fixed port every time instead of letting the OS pick one.
///
/// You must register the exact same URI in the Dropbox App Console:
///   https://www.dropbox.com/developers/apps -> your app -> Settings tab
///   -> "OAuth 2" section -> "Redirect URIs" -> add:
///   http://127.0.0.1:53682/callback
/// (then Save at the bottom of that section). If port 53682 is already used
/// by something else on your machine, change the number here AND in the
/// Dropbox dashboard to match.
pub const DROPBOX_REDIRECT_PORT: u16 = 53682;

pub fn client_id(provider: &str) -> Result<&'static str, SyncError> {
    match provider {
        "google" => Ok(GOOGLE_CLIENT_ID),
        "dropbox" => Ok(DROPBOX_CLIENT_ID),
        _ => Err(SyncError::Backend(format!("Unknown provider: {provider}"))),
    }
}

/// `None` for providers whose PKCE flow needs no secret (Dropbox); `Some` for
/// providers that require one even in a public-client PKCE flow (Google).
pub fn client_secret(provider: &str) -> Option<&'static str> {
    match provider {
        "google" => Some(GOOGLE_CLIENT_SECRET),
        _ => None,
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct OAuthTokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at_rfc3339: String,
}

fn is_token_expired(expires_at: &str) -> bool {
    if let Ok(dt) = OffsetDateTime::parse(expires_at, &time::format_description::well_known::Rfc3339) {
        let now = OffsetDateTime::now_utc();
        now + time::Duration::minutes(5) >= dt
    } else {
        true
    }
}

pub fn get_valid_access_token(
    token_store: &dyn TokenStore,
    provider: &str,
) -> Result<String, SyncError> {
    let account = format!("sync-oauth-{}", provider);
    let token_str = token_store
        .load(&account)
        .map_err(|e| SyncError::Backend(format!("Failed to load OAuth tokens: {e}")))?
        .ok_or_else(|| {
            SyncError::Backend("No OAuth tokens found. Please connect your account.".to_string())
        })?;

    let mut tokens: OAuthTokens = serde_json::from_str(&token_str)?;

    if is_token_expired(&tokens.expires_at_rfc3339) {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| SyncError::Backend(e.to_string()))?;

        let token_url = match provider {
            "google" => "https://oauth2.googleapis.com/token",
            "dropbox" => "https://api.dropboxapi.com/oauth2/token",
            _ => {
                return Err(SyncError::Backend(format!(
                    "Unknown provider: {}",
                    provider
                )))
            }
        };
        let client_id = client_id(provider)?;

        let mut params = vec![
            ("client_id", client_id),
            ("grant_type", "refresh_token"),
            ("refresh_token", tokens.refresh_token.as_str()),
        ];
        if let Some(secret) = client_secret(provider) {
            params.push(("client_secret", secret));
        }

        let res = client
            .post(token_url)
            .form(&params)
            .send()
            .map_err(|e| {
                SyncError::Backend(format!("Token refresh request failed: {e}"))
            })?;

        if !res.status().is_success() {
            let status = res.status();
            let err_text = res.text().unwrap_or_default();
            if status.as_u16() == 400
                && (err_text.contains("invalid_grant") || err_text.contains("revoked"))
            {
                let _ = token_store.delete(&account);
                return Err(SyncError::Backend("reconnect required".to_string()));
            }
            return Err(SyncError::Backend(format!(
                "Token refresh failed ({}): {}",
                status, err_text
            )));
        }

        #[derive(Deserialize)]
        struct TokenResponse {
            access_token: String,
            expires_in: i64,
            refresh_token: Option<String>,
        }

        let body: TokenResponse = res.json().map_err(|e| {
            SyncError::Backend(format!("Failed to parse token response: {e}"))
        })?;

        tokens.access_token = body.access_token;
        if let Some(new_rt) = body.refresh_token {
            tokens.refresh_token = new_rt;
        }

        let new_expiry = OffsetDateTime::now_utc() + time::Duration::seconds(body.expires_in);
        tokens.expires_at_rfc3339 = new_expiry
            .format(&time::format_description::well_known::Rfc3339)
            .map_err(|e| SyncError::Backend(e.to_string()))?;

        let updated_str = serde_json::to_string(&tokens)?;
        token_store
            .save(&account, &updated_str)
            .map_err(|e| SyncError::Backend(format!("Failed to save refreshed tokens: {e}")))?;
    }

    Ok(tokens.access_token)
}
