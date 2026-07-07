use std::sync::Arc;
use serde::Deserialize;
use crate::sync::backend::{SyncBackend, SyncError, TokenStore};
use crate::sync::payload::Manifest;

pub struct GoogleDriveBackend {
    token_store: Arc<dyn TokenStore>,
    client: reqwest::blocking::Client,
}

impl GoogleDriveBackend {
    pub fn new(token_store: Arc<dyn TokenStore>) -> Self {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .unwrap();
        Self { token_store, client }
    }

    fn get_token(&self) -> Result<String, SyncError> {
        crate::sync::oauth::get_valid_access_token(self.token_store.as_ref(), "google")
    }
}

fn find_file_id(
    client: &reqwest::blocking::Client,
    token: &str,
    name: &str,
) -> Result<Option<String>, String> {
    let url = "https://www.googleapis.com/drive/v3/files";
    let q = format!(
        "name = '{}' and 'appDataFolder' in parents and trashed = false",
        name
    );
    let res = client
        .get(url)
        .bearer_auth(token)
        .query(&[
            ("spaces", "appDataFolder"),
            ("q", &q),
            ("fields", "files(id)"),
        ])
        .send()
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!(
            "Drive list failed ({}): {}",
            res.status(),
            res.text().unwrap_or_default()
        ));
    }

    #[derive(Deserialize)]
    struct FileItem {
        id: String,
    }
    #[derive(Deserialize)]
    struct ListResponse {
        files: Vec<FileItem>,
    }

    let body: ListResponse = res.json().map_err(|e| e.to_string())?;
    Ok(body.files.first().map(|f| f.id.clone()))
}

fn download_file(
    client: &reqwest::blocking::Client,
    token: &str,
    file_id: &str,
) -> Result<Vec<u8>, String> {
    let url = format!(
        "https://www.googleapis.com/drive/v3/files/{}?alt=media",
        file_id
    );
    let res = client
        .get(&url)
        .bearer_auth(token)
        .send()
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!(
            "Drive download failed ({}): {}",
            res.status(),
            res.text().unwrap_or_default()
        ));
    }

    let bytes = res.bytes().map_err(|e| e.to_string())?;
    Ok(bytes.to_vec())
}

fn create_file(
    client: &reqwest::blocking::Client,
    token: &str,
    name: &str,
    content: &[u8],
) -> Result<String, String> {
    let url = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";

    let boundary = "boundary_termifai_sync";
    let multipart_body = build_multipart_related(boundary, name, content);

    let res = client
        .post(url)
        .bearer_auth(token)
        .header(
            "Content-Type",
            format!("multipart/related; boundary={}", boundary),
        )
        .body(multipart_body)
        .send()
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!(
            "Drive create failed ({}): {}",
            res.status(),
            res.text().unwrap_or_default()
        ));
    }

    #[derive(Deserialize)]
    struct CreateResponse {
        id: String,
    }
    let body: CreateResponse = res.json().map_err(|e| e.to_string())?;
    Ok(body.id)
}

fn build_multipart_related(boundary: &str, name: &str, content: &[u8]) -> Vec<u8> {
    let metadata = serde_json::json!({
        "name": name,
        "parents": ["appDataFolder"]
    });
    let metadata_str = serde_json::to_string(&metadata).unwrap();

    let mut body = Vec::new();
    body.extend_from_slice(format!("--{}\r\n", boundary).as_bytes());
    body.extend_from_slice(b"Content-Type: application/json; charset=UTF-8\r\n\r\n");
    body.extend_from_slice(metadata_str.as_bytes());
    body.extend_from_slice(b"\r\n");
    body.extend_from_slice(format!("--{}\r\n", boundary).as_bytes());
    body.extend_from_slice(b"Content-Type: application/octet-stream\r\n\r\n");
    body.extend_from_slice(content);
    body.extend_from_slice(b"\r\n");
    body.extend_from_slice(format!("--{}--\r\n", boundary).as_bytes());
    body
}

fn update_file(
    client: &reqwest::blocking::Client,
    token: &str,
    file_id: &str,
    content: &[u8],
) -> Result<(), String> {
    let url = format!(
        "https://www.googleapis.com/upload/drive/v3/files/{}?uploadType=media",
        file_id
    );
    let res = client
        .patch(&url)
        .bearer_auth(token)
        .header("Content-Type", "application/octet-stream")
        .body(content.to_vec())
        .send()
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!(
            "Drive update failed ({}): {}",
            res.status(),
            res.text().unwrap_or_default()
        ));
    }
    Ok(())
}

fn delete_file(
    client: &reqwest::blocking::Client,
    token: &str,
    file_id: &str,
) -> Result<(), String> {
    let url = format!("https://www.googleapis.com/drive/v3/files/{}", file_id);
    let res = client
        .delete(&url)
        .bearer_auth(token)
        .send()
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() && res.status() != reqwest::StatusCode::NOT_FOUND {
        return Err(format!(
            "Drive delete failed ({}): {}",
            res.status(),
            res.text().unwrap_or_default()
        ));
    }
    Ok(())
}

impl SyncBackend for GoogleDriveBackend {
    fn fetch_manifest(&self) -> Result<Option<Manifest>, SyncError> {
        let token = self.get_token()?;
        let file_id_opt = find_file_id(&self.client, &token, "manifest.json")
            .map_err(SyncError::Backend)?;

        let file_id = match file_id_opt {
            Some(id) => id,
            None => return Ok(None),
        };

        let bytes = download_file(&self.client, &token, &file_id).map_err(SyncError::Backend)?;
        let manifest: Manifest = serde_json::from_slice(&bytes)?;
        Ok(Some(manifest))
    }

    fn fetch_blob(&self) -> Result<Vec<u8>, SyncError> {
        let token = self.get_token()?;
        let file_id_opt = find_file_id(&self.client, &token, "vault.blob")
            .map_err(SyncError::Backend)?;

        let file_id = match file_id_opt {
            Some(id) => id,
            None => return Err(SyncError::NotFound),
        };

        let bytes = download_file(&self.client, &token, &file_id).map_err(SyncError::Backend)?;
        Ok(bytes)
    }

    fn store(
        &self,
        manifest: &Manifest,
        blob: &[u8],
        expected_blob_version: Option<u64>,
    ) -> Result<(), SyncError> {
        let token = self.get_token()?;

        // CAS check
        let current = self.fetch_manifest()?;
        match (expected_blob_version, current.as_ref()) {
            (None, None) => {}
            (None, Some(_)) => return Err(SyncError::Conflict),
            (Some(expected), Some(current)) if current.blob_version != expected => {
                return Err(SyncError::Conflict)
            }
            (Some(_), None) => return Err(SyncError::Conflict),
            _ => {}
        }

        // Upload blob first, then manifest.
        let blob_id_opt = find_file_id(&self.client, &token, "vault.blob")
            .map_err(SyncError::Backend)?;
        match blob_id_opt {
            Some(id) => {
                update_file(&self.client, &token, &id, blob).map_err(SyncError::Backend)?
            }
            None => {
                create_file(&self.client, &token, "vault.blob", blob).map_err(SyncError::Backend)?;
            }
        }

        let manifest_bytes = serde_json::to_vec_pretty(manifest)?;
        let manifest_id_opt = find_file_id(&self.client, &token, "manifest.json")
            .map_err(SyncError::Backend)?;
        match manifest_id_opt {
            Some(id) => update_file(&self.client, &token, &id, &manifest_bytes)
                .map_err(SyncError::Backend)?,
            None => {
                create_file(&self.client, &token, "manifest.json", &manifest_bytes)
                    .map_err(SyncError::Backend)?;
            }
        }

        Ok(())
    }

    fn wipe(&self) -> Result<(), SyncError> {
        let token = self.get_token()?;
        for name in ["manifest.json", "vault.blob"] {
            if let Ok(Some(id)) = find_file_id(&self.client, &token, name) {
                let _ = delete_file(&self.client, &token, &id);
            }
        }
        Ok(())
    }
}
