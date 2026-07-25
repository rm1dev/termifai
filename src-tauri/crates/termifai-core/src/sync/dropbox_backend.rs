use std::sync::Arc;
use serde::{Deserialize, Serialize};
use crate::sync::backend::{SyncBackend, SyncError, TokenStore};
use crate::sync::collections::CollectionKind;
use crate::sync::payload::Manifest;

pub struct DropboxBackend {
    token_store: Arc<dyn TokenStore>,
    client: reqwest::blocking::Client,
}

impl DropboxBackend {
    pub fn new(token_store: Arc<dyn TokenStore>) -> Self {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .unwrap();
        Self { token_store, client }
    }

    fn get_token(&self) -> Result<String, SyncError> {
        crate::sync::oauth::get_valid_access_token(self.token_store.as_ref(), "dropbox")
    }

    fn fetch_manifest_with_rev(&self) -> Result<Option<(Manifest, String)>, SyncError> {
        let token = self.get_token()?;
        let url = "https://content.dropboxapi.com/2/files/download";

        #[derive(Serialize)]
        struct DownloadArg {
            path: String,
        }
        let arg = DownloadArg {
            path: "/manifest.json".to_string(),
        };
        let arg_str = serde_json::to_string(&arg)?;

        let res = self
            .client
            .post(url)
            .bearer_auth(&token)
            .header("Dropbox-API-Arg", arg_str)
            .send()
            .map_err(|e| SyncError::Backend(format!("Dropbox manifest download failed: {e}")))?;

        if res.status() == reqwest::StatusCode::CONFLICT || res.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }

        if !res.status().is_success() {
            let status = res.status();
            let err_text = res.text().unwrap_or_default();
            if err_text.contains("path/not_found") {
                return Ok(None);
            }
            return Err(SyncError::Backend(format!(
                "Dropbox download failed ({}): {}",
                status, err_text
            )));
        }

        let api_result_header = res
            .headers()
            .get("dropbox-api-result")
            .ok_or_else(|| {
                SyncError::Backend("Missing dropbox-api-result header in response".to_string())
            })?
            .to_str()
            .map_err(|e| SyncError::Backend(e.to_string()))?;

        #[derive(Deserialize)]
        struct DropboxMetadata {
            rev: String,
        }
        let meta: DropboxMetadata = serde_json::from_str(api_result_header)?;

        let bytes = res.bytes().map_err(|e| SyncError::Backend(e.to_string()))?;
        let manifest: Manifest = serde_json::from_slice(&bytes)?;
        Ok(Some((manifest, meta.rev)))
    }
}

#[derive(Serialize)]
#[serde(tag = ".tag", rename_all = "lowercase")]
enum WriteMode {
    Add,
    Overwrite,
    Update { update: String },
}

#[derive(Serialize)]
struct UploadArg {
    path: String,
    mode: WriteMode,
    mute: bool,
}

fn upload_file(
    client: &reqwest::blocking::Client,
    token: &str,
    path: &str,
    content: &[u8],
    mode: WriteMode,
) -> Result<String, SyncError> {
    let url = "https://content.dropboxapi.com/2/files/upload";
    let arg = UploadArg {
        path: path.to_string(),
        mode,
        mute: true,
    };
    let arg_str = serde_json::to_string(&arg)?;

    let res = client
        .post(url)
        .bearer_auth(token)
        .header("Content-Type", "application/octet-stream")
        .header("Dropbox-API-Arg", arg_str)
        .body(content.to_vec())
        .send()
        .map_err(|e| SyncError::Backend(format!("Dropbox upload failed: {e}")))?;

    let status = res.status();
    if status == reqwest::StatusCode::CONFLICT {
        let err_text = res.text().unwrap_or_default();
        if err_text.contains("conflict") || err_text.contains("path/conflict") {
            return Err(SyncError::Conflict);
        }
        return Err(SyncError::Backend(format!(
            "Dropbox upload conflict/error: {}",
            err_text
        )));
    }

    if !status.is_success() {
        return Err(SyncError::Backend(format!(
            "Dropbox upload status failure: {} - {}",
            status,
            res.text().unwrap_or_default()
        )));
    }

    #[derive(Deserialize)]
    struct UploadResponse {
        rev: String,
    }
    let body: UploadResponse = res.json()?;
    Ok(body.rev)
}

fn delete_file(
    client: &reqwest::blocking::Client,
    token: &str,
    path: &str,
) -> Result<(), SyncError> {
    let url = "https://api.dropboxapi.com/2/files/delete_v2";

    #[derive(Serialize)]
    struct DeleteArg {
        path: String,
    }
    let arg = DeleteArg {
        path: path.to_string(),
    };

    let res = client
        .post(url)
        .bearer_auth(token)
        .json(&arg)
        .send()
        .map_err(|e| SyncError::Backend(format!("Dropbox delete request failed: {e}")))?;

    let status = res.status();
    if !status.is_success() && status != reqwest::StatusCode::CONFLICT {
        let err_text = res.text().unwrap_or_default();
        if !err_text.contains("path_lookup/not_found") {
            return Err(SyncError::Backend(format!(
                "Dropbox delete failed: {} - {}",
                status,
                err_text
            )));
        }
    }
    Ok(())
}

impl SyncBackend for DropboxBackend {
    fn fetch_manifest(&self) -> Result<Option<Manifest>, SyncError> {
        let res = self.fetch_manifest_with_rev()?;
        Ok(res.map(|(m, _rev)| m))
    }

    fn fetch_blob(&self) -> Result<Vec<u8>, SyncError> {
        let token = self.get_token()?;
        let url = "https://content.dropboxapi.com/2/files/download";

        #[derive(Serialize)]
        struct DownloadArg {
            path: String,
        }
        let arg = DownloadArg {
            path: "/vault.blob".to_string(),
        };
        let arg_str = serde_json::to_string(&arg)?;

        let res = self
            .client
            .post(url)
            .bearer_auth(&token)
            .header("Dropbox-API-Arg", arg_str)
            .send()
            .map_err(|e| SyncError::Backend(format!("Dropbox blob download failed: {e}")))?;

        let status = res.status();
        if status == reqwest::StatusCode::CONFLICT || status == reqwest::StatusCode::NOT_FOUND {
            return Err(SyncError::NotFound);
        }

        if !status.is_success() {
            let err_text = res.text().unwrap_or_default();
            if err_text.contains("path/not_found") {
                return Err(SyncError::NotFound);
            }
            return Err(SyncError::Backend(format!(
                "Dropbox blob download failed: {} - {}",
                status,
                err_text
            )));
        }

        let bytes = res.bytes().map_err(|e| SyncError::Backend(e.to_string()))?;
        Ok(bytes.to_vec())
    }

    fn store(
        &self,
        manifest: &Manifest,
        blob: &[u8],
        expected_blob_version: Option<u64>,
    ) -> Result<(), SyncError> {
        let token = self.get_token()?;

        // CAS logic: download remote manifest and check version
        let remote = self.fetch_manifest_with_rev()?;
        let rev = match (expected_blob_version, remote.as_ref()) {
            (None, None) => None,
            (None, Some(_)) => return Err(SyncError::Conflict),
            (Some(expected), Some((current, rev))) => {
                if current.blob_version != expected {
                    return Err(SyncError::Conflict);
                }
                Some(rev.clone())
            }
            (Some(_), None) => return Err(SyncError::Conflict),
        };

        upload_file(
            &self.client,
            &token,
            "/vault.blob",
            blob,
            WriteMode::Overwrite,
        )?;

        let manifest_bytes = serde_json::to_vec_pretty(manifest)?;
        let mode = match rev {
            Some(r) => WriteMode::Update { update: r },
            None => WriteMode::Add,
        };

        upload_file(
            &self.client,
            &token,
            "/manifest.json",
            &manifest_bytes,
            mode,
        )?;

        Ok(())
    }

    fn fetch_collection(&self, name: &str) -> Result<Vec<u8>, SyncError> {
        let token = self.get_token()?;
        let file_name = CollectionKind::from_str(name)
            .map(|k| k.file_name())
            .unwrap_or_else(|| format!("col-{name}.blob"));
        let path = format!("/{file_name}");
        let url = "https://content.dropboxapi.com/2/files/download";

        #[derive(Serialize)]
        struct DownloadArg {
            path: String,
        }
        let arg = DownloadArg { path };
        let arg_str = serde_json::to_string(&arg)?;

        let res = self
            .client
            .post(url)
            .bearer_auth(&token)
            .header("Dropbox-API-Arg", arg_str)
            .send()
            .map_err(|e| SyncError::Backend(format!("Dropbox collection download failed: {e}")))?;

        let status = res.status();
        if status == reqwest::StatusCode::CONFLICT || status == reqwest::StatusCode::NOT_FOUND {
            return Err(SyncError::NotFound);
        }
        if !status.is_success() {
            let err_text = res.text().unwrap_or_default();
            if err_text.contains("path/not_found") {
                return Err(SyncError::NotFound);
            }
            return Err(SyncError::Backend(format!(
                "Dropbox collection download failed: {} - {}",
                status, err_text
            )));
        }
        Ok(res.bytes().map_err(|e| SyncError::Backend(e.to_string()))?.to_vec())
    }

    fn store_delta(
        &self,
        manifest: &Manifest,
        changed: &[(String, Vec<u8>)],
        expected_blob_version: Option<u64>,
    ) -> Result<(), SyncError> {
        let token = self.get_token()?;
        let remote = self.fetch_manifest_with_rev()?;
        let rev = match (expected_blob_version, remote.as_ref()) {
            (None, None) => None,
            (None, Some(_)) => return Err(SyncError::Conflict),
            (Some(expected), Some((current, rev))) => {
                if current.blob_version != expected {
                    return Err(SyncError::Conflict);
                }
                Some(rev.clone())
            }
            (Some(_), None) => return Err(SyncError::Conflict),
        };

        for (name, bytes) in changed {
            let file_name = CollectionKind::from_str(name)
                .map(|k| k.file_name())
                .unwrap_or_else(|| format!("col-{name}.blob"));
            upload_file(
                &self.client,
                &token,
                &format!("/{file_name}"),
                bytes,
                WriteMode::Overwrite,
            )?;
        }

        let manifest_bytes = serde_json::to_vec_pretty(manifest)?;
        let mode = match rev {
            Some(r) => WriteMode::Update { update: r },
            None => WriteMode::Add,
        };
        upload_file(
            &self.client,
            &token,
            "/manifest.json",
            &manifest_bytes,
            mode,
        )?;
        let _ = delete_file(&self.client, &token, "/vault.blob");
        Ok(())
    }

    fn wipe(&self) -> Result<(), SyncError> {
        let token = self.get_token()?;
        let _ = delete_file(&self.client, &token, "/manifest.json");
        let _ = delete_file(&self.client, &token, "/vault.blob");
        for kind in CollectionKind::ALL {
            let _ = delete_file(&self.client, &token, &format!("/{}", kind.file_name()));
        }
        Ok(())
    }
}
