use crate::ssh;
use serde::{Deserialize, Serialize};
use ssh2::Session;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictDecision {
    Overwrite,
    Skip,
    OverwriteAll,
    SkipAll,
    Cancel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictMode {
    Ask,
    OverwriteAll,
    SkipAll,
}

/// Payload for the `sftp:{sid}:conflict` event: what already exists at the
/// destination vs. what is about to be written, so the dialog can compare.
#[derive(Debug, Clone, Serialize)]
pub struct ConflictInfo {
    pub session_id: String,
    pub file_name: String,
    pub dest_path: String,
    /// "file" | "dir"
    pub kind: String,
    /// "upload" | "download"
    pub direction: String,
    pub existing_size: Option<u64>,
    pub existing_modified: Option<String>,
    pub incoming_size: Option<u64>,
    pub incoming_modified: Option<String>,
}

/// Per-transfer conflict policy. `resolve` consults the sticky mode first and
/// only prompts (blocking) while the mode is `Ask`.
pub struct ConflictHandler<'a> {
    mode: ConflictMode,
    prompt: Box<dyn FnMut(&ConflictInfo) -> ConflictDecision + 'a>,
}

impl<'a> ConflictHandler<'a> {
    pub fn new(
        mode: ConflictMode,
        prompt: impl FnMut(&ConflictInfo) -> ConflictDecision + 'a,
    ) -> Self {
        Self { mode, prompt: Box::new(prompt) }
    }

    /// Ok(true) = overwrite/merge, Ok(false) = skip this item, Err = abort transfer.
    pub fn resolve(&mut self, info: &ConflictInfo) -> Result<bool, String> {
        match self.mode {
            ConflictMode::OverwriteAll => return Ok(true),
            ConflictMode::SkipAll => return Ok(false),
            ConflictMode::Ask => {}
        }
        match (self.prompt)(info) {
            ConflictDecision::Overwrite => Ok(true),
            ConflictDecision::Skip => Ok(false),
            ConflictDecision::OverwriteAll => {
                self.mode = ConflictMode::OverwriteAll;
                Ok(true)
            }
            ConflictDecision::SkipAll => {
                self.mode = ConflictMode::SkipAll;
                Ok(false)
            }
            ConflictDecision::Cancel => Err("Cancelled".to_string()),
        }
    }
}


pub fn list_local(path: &str) -> Result<Vec<LocalFileEntry>, String> {
    let dir = std::fs::read_dir(path).map_err(|e| format!("Cannot read '{}': {}", path, e))?;

    let mut entries: Vec<LocalFileEntry> = dir
        .filter_map(|e| e.ok())
        .map(|entry| {
            let meta = entry.metadata().ok();
            let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
            let size = if is_dir {
                None
            } else {
                meta.as_ref().map(|m| m.len())
            };
            let modified = meta.and_then(|m| m.modified().ok()).map(|t| {
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

fn shell_escape(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
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

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RemoteStatResult {
    pub permissions: u32,
    pub owner: String,
    pub group: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UsersGroups {
    pub users: Vec<String>,
    pub groups: Vec<String>,
}

pub struct SftpEntry {
    pub session: Session,
}

impl std::fmt::Debug for SftpEntry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SftpEntry").finish()
    }
}

impl SftpEntry {
    pub fn list_remote(&self, path: &str) -> Result<Vec<RemoteFileEntry>, String> {
        let sftp = self
            .session
            .sftp()
            .map_err(|e| format!("SFTP subsystem: {}", e))?;
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
                let size = if is_dir {
                    None
                } else {
                    Some(stat.size.unwrap_or(0))
                };
                let modified = stat.mtime.map(format_unix_timestamp);
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
        cancel: Arc<AtomicBool>,
        on_progress: F,
    ) -> Result<(), String>
    where
        F: Fn(TransferProgress),
    {
        let sftp = self
            .session
            .sftp()
            .map_err(|e| format!("SFTP subsystem: {}", e))?;

        let remote_p = std::path::Path::new(remote_path);
        let stat = sftp
            .stat(remote_p)
            .map_err(|e| format!("stat '{}': {}", remote_path, e))?;
        let total_bytes = stat.size.unwrap_or(0);

        let mut remote_file = sftp
            .open(remote_p)
            .map_err(|e| format!("open remote: {}", e))?;

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
                if cancel.load(Ordering::Relaxed) {
                    let _ = std::fs::remove_file(&tmp_path);
                    return Err("Cancelled".to_string());
                }
                let n = remote_file
                    .read(&mut buf)
                    .map_err(|e| format!("read remote: {}", e))?;
                if n == 0 {
                    break;
                }
                local_file
                    .write_all(&buf[..n])
                    .map_err(|e| format!("write tmp: {}", e))?;
                bytes_transferred += n as u64;
                on_progress(TransferProgress {
                    session_id: session_id.to_string(),
                    file_name: file_name.clone(),
                    bytes_transferred,
                    total_bytes,
                });
            }
            use std::io::Write;
            local_file
                .flush()
                .map_err(|e| format!("flush tmp: {}", e))?;
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
        cancel: Arc<AtomicBool>,
        on_progress: F,
    ) -> Result<(), String>
    where
        F: Fn(TransferProgress),
    {
        let sftp = self
            .session
            .sftp()
            .map_err(|e| format!("SFTP subsystem: {}", e))?;

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
            if cancel.load(Ordering::Relaxed) {
                let _ = sftp.unlink(std::path::Path::new(remote_path));
                return Err("Cancelled".to_string());
            }
            let n = local_file
                .read(&mut buf)
                .map_err(|e| format!("read local: {}", e))?;
            if n == 0 {
                break;
            }
            remote_file
                .write_all(&buf[..n])
                .map_err(|e| format!("write remote: {}", e))?;
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

    pub fn delete_remote(&self, paths: &[String]) -> Result<(), String> {
        let sftp = self
            .session
            .sftp()
            .map_err(|e| format!("SFTP subsystem: {}", e))?;

        for path in paths {
            let p = std::path::Path::new(path);
            let stat = sftp
                .stat(p)
                .map_err(|e| format!("stat '{}': {}", path, e))?;
            if stat.file_type().is_dir() {
                sftp.rmdir(p)
                    .map_err(|e| format!("rmdir '{}': {}", path, e))?;
            } else {
                sftp.unlink(p)
                    .map_err(|e| format!("unlink '{}': {}", path, e))?;
            }
        }
        Ok(())
    }

    pub fn rename_remote(&self, from_path: &str, to_path: &str) -> Result<(), String> {
        let sftp = self
            .session
            .sftp()
            .map_err(|e| format!("SFTP subsystem: {}", e))?;
        sftp.rename(
            std::path::Path::new(from_path),
            std::path::Path::new(to_path),
            None,
        )
        .map_err(|e| format!("rename '{}' -> '{}': {}", from_path, to_path, e))
    }

    pub fn mkdir_remote(&self, path: &str) -> Result<(), String> {
        let sftp = self
            .session
            .sftp()
            .map_err(|e| format!("SFTP subsystem: {}", e))?;
        sftp.mkdir(std::path::Path::new(path), 0o755)
            .map_err(|e| format!("mkdir '{}': {}", path, e))
    }

    pub fn exec_command(&self, cmd: &str) -> Result<String, String> {
        let mut channel = self
            .session
            .channel_session()
            .map_err(|e| format!("Channel open: {}", e))?;
        channel
            .exec(cmd)
            .map_err(|e| format!("Exec '{}': {}", cmd, e))?;
        let mut output = String::new();
        use std::io::Read;
        channel
            .read_to_string(&mut output)
            .map_err(|e| format!("Read output: {}", e))?;
        channel
            .wait_close()
            .map_err(|e| format!("Channel close: {}", e))?;
        let status = channel
            .exit_status()
            .map_err(|e| format!("Exit status: {}", e))?;
        if status != 0 {
            return Err(format!("Command '{}' exited with status {}", cmd, status));
        }
        Ok(output)
    }

    pub fn stat_remote(&self, path: &str) -> Result<RemoteStatResult, String> {
        let sftp = self
            .session
            .sftp()
            .map_err(|e| format!("SFTP subsystem: {}", e))?;
        let stat = sftp
            .stat(std::path::Path::new(path))
            .map_err(|e| format!("stat '{}': {}", path, e))?;
        let permissions = stat.perm.unwrap_or(0) & 0o7777;
        // get owner/group via SSH exec since libssh2 stat doesn't return names
        let owner_out = self.exec_command(&format!(
            "stat -c '%U %G' {} 2>/dev/null || echo 'root root'",
            shell_escape(path)
        ))?;
        let parts: Vec<&str> = owner_out.trim().splitn(2, ' ').collect();
        let owner = parts.first().unwrap_or(&"root").to_string();
        let group = parts.get(1).unwrap_or(&"root").to_string();
        Ok(RemoteStatResult {
            permissions,
            owner,
            group,
        })
    }

    pub fn chmod(&self, path: &str, mode: &str, recursive: bool) -> Result<(), String> {
        if !mode.chars().all(|c| c.is_ascii_digit()) || mode.is_empty() || mode.len() > 4 {
            return Err(format!("Invalid chmod mode: '{}'", mode));
        }
        let flag = if recursive { "-R " } else { "" };
        let cmd = format!("chmod {}{} {}", flag, mode, shell_escape(path));
        self.exec_command(&cmd)?;
        Ok(())
    }

    pub fn chown(
        &self,
        path: &str,
        user: &str,
        group: &str,
        recursive: bool,
    ) -> Result<(), String> {
        fn is_valid_name(s: &str) -> bool {
            !s.is_empty()
                && s.chars().all(|c| {
                    c.is_alphanumeric() || c == '_' || c == '-' || c == '.' || c == '@' || c == ':'
                })
        }
        if !is_valid_name(user) {
            return Err(format!("Invalid user name: '{}'", user));
        }
        if !is_valid_name(group) {
            return Err(format!("Invalid group name: '{}'", group));
        }
        let flag = if recursive { "-R " } else { "" };
        let cmd = format!("chown {}{}:{} {}", flag, user, group, shell_escape(path));
        self.exec_command(&cmd)?;
        Ok(())
    }

    pub fn copy_remote(&self, paths: &[String], dest_dir: &str) -> Result<(), String> {
        for path in paths {
            let cmd = format!("cp -a {} {}/", shell_escape(path), shell_escape(dest_dir));
            self.exec_command(&cmd)?;
        }
        Ok(())
    }

    pub fn get_users_groups(&self) -> Result<UsersGroups, String> {
        let users_out = self
            .exec_command("getent passwd | cut -d: -f1 2>/dev/null || cut -d: -f1 /etc/passwd")?;
        let groups_out =
            self.exec_command("getent group | cut -d: -f1 2>/dev/null || cut -d: -f1 /etc/group")?;
        let users = users_out
            .lines()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        let groups = groups_out
            .lines()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        Ok(UsersGroups { users, groups })
    }

    pub fn open_remote(&self, session_id: &str, remote_path: &str) -> Result<String, String> {
        let file_name = std::path::Path::new(remote_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "file".to_string());

        let rand_id = uuid::Uuid::new_v4().to_string().replace('-', "");
        let rand_id = &rand_id[..8];
        let app_temp_dir = std::env::temp_dir()
            .join("termifai")
            .join(format!("{}_{}", session_id, rand_id));
        std::fs::create_dir_all(&app_temp_dir)
            .map_err(|e| format!("Create temp dir failed: {}", e))?;
        let tmp_path = app_temp_dir.join(file_name);

        let sftp = self
            .session
            .sftp()
            .map_err(|e| format!("SFTP subsystem: {}", e))?;
        let mut remote_file = sftp
            .open(std::path::Path::new(remote_path))
            .map_err(|e| format!("Open remote '{}': {}", remote_path, e))?;
        let mut local_file = std::fs::File::create(&tmp_path)
            .map_err(|e| format!("Create tmp '{:?}': {}", tmp_path, e))?;
        std::io::copy(&mut remote_file, &mut local_file)
            .map_err(|e| format!("Copy to tmp: {}", e))?;
        Ok(tmp_path.to_string_lossy().to_string())
    }

    /// Uploads a local file OR directory (recursively) to the remote path.
    pub fn upload_path<F>(
        &self,
        session_id: &str,
        local_path: &str,
        remote_path: &str,
        cancel: Arc<AtomicBool>,
        conflicts: &mut ConflictHandler,
        on_progress: F,
    ) -> Result<(), String>
    where
        F: Fn(TransferProgress),
    {
        let meta = std::fs::metadata(local_path)
            .map_err(|e| format!("stat local '{}': {}", local_path, e))?;

        let (local_is_dir, local_size, local_modified) = (
            meta.is_dir(),
            if meta.is_dir() { None } else { Some(meta.len()) },
            meta.modified().ok().map(|t| {
                format_unix_timestamp(
                    t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs(),
                )
            }),
        );
        {
            let sftp = self
                .session
                .sftp()
                .map_err(|e| format!("SFTP subsystem: {}", e))?;
            if let Some((dest_is_dir, dest_size, dest_modified)) =
                stat_remote_brief(&sftp, remote_path)
            {
                if dest_is_dir == local_is_dir {
                    let proceed = conflicts.resolve(&ConflictInfo {
                        session_id: session_id.to_string(),
                        file_name: pathbase(remote_path),
                        dest_path: remote_path.to_string(),
                        kind: if dest_is_dir { "dir" } else { "file" }.to_string(),
                        direction: "upload".to_string(),
                        existing_size: dest_size,
                        existing_modified: dest_modified,
                        incoming_size: local_size,
                        incoming_modified: local_modified,
                    })?;
                    if !proceed {
                        return Ok(());
                    }
                }
            }
        }

        if !meta.is_dir() {
            return self.upload_file(session_id, local_path, remote_path, cancel, on_progress);
        }

        let mut remote_dirs: Vec<String> = Vec::new();
        let mut files: Vec<(std::path::PathBuf, String, u64)> = Vec::new();
        walk_local_tree(
            std::path::Path::new(local_path),
            remote_path,
            &mut remote_dirs,
            &mut files,
        )?;

        {
            let sftp = self
                .session
                .sftp()
                .map_err(|e| format!("SFTP subsystem: {}", e))?;
            for dir in &remote_dirs {
                if cancel.load(Ordering::Relaxed) {
                    return Err("Cancelled".to_string());
                }
                ensure_remote_dir(&sftp, dir)?;
            }
        }

        let sftp = self
            .session
            .sftp()
            .map_err(|e| format!("SFTP subsystem: {}", e))?;

        let grand_total: u64 = files.iter().map(|(_, _, size)| size).sum();
        let mut offset = 0u64;
        for (lp, rp, size) in &files {
            if cancel.load(Ordering::Relaxed) {
                return Err("Cancelled".to_string());
            }

            if let Some((dest_is_dir, dest_size, dest_modified)) = stat_remote_brief(&sftp, rp) {
                let incoming = stat_local_brief(lp);
                let proceed = conflicts.resolve(&ConflictInfo {
                    session_id: session_id.to_string(),
                    file_name: pathbase(rp),
                    dest_path: rp.clone(),
                    kind: if dest_is_dir { "dir" } else { "file" }.to_string(),
                    direction: "upload".to_string(),
                    existing_size: dest_size,
                    existing_modified: dest_modified,
                    incoming_size: incoming.as_ref().and_then(|(_, s, _)| *s),
                    incoming_modified: incoming.and_then(|(_, _, m)| m),
                })?;
                if !proceed {
                    offset += size;
                    on_progress(TransferProgress {
                        session_id: session_id.to_string(),
                        file_name: pathbase(rp),
                        bytes_transferred: offset,
                        total_bytes: grand_total,
                    });
                    continue;
                }
            }

            let base = offset;
            self.upload_file(
                session_id,
                &lp.to_string_lossy(),
                rp,
                Arc::clone(&cancel),
                |p| {
                    on_progress(TransferProgress {
                        session_id: p.session_id,
                        file_name: p.file_name,
                        bytes_transferred: base + p.bytes_transferred,
                        total_bytes: grand_total,
                    })
                },
            )?;
            offset += size;
        }
        Ok(())
    }

    /// Downloads a remote file OR directory (recursively) to the local path.
    pub fn download_path<F>(
        &self,
        session_id: &str,
        remote_path: &str,
        local_path: &str,
        cancel: Arc<AtomicBool>,
        conflicts: &mut ConflictHandler,
        on_progress: F,
    ) -> Result<(), String>
    where
        F: Fn(TransferProgress),
    {
        let (is_dir, remote_size, remote_modified) = {
            let sftp = self
                .session
                .sftp()
                .map_err(|e| format!("SFTP subsystem: {}", e))?;
            let stat = sftp
                .stat(std::path::Path::new(remote_path))
                .map_err(|e| format!("stat '{}': {}", remote_path, e))?;
            let is_dir = stat.file_type().is_dir();
            let remote_size = if is_dir { None } else { stat.size };
            let remote_modified = stat.mtime.map(format_unix_timestamp);
            (is_dir, remote_size, remote_modified)
        };

        if let Some((dest_is_dir, dest_size, dest_modified)) = stat_local_brief(std::path::Path::new(local_path)) {
            if dest_is_dir == is_dir {
                let proceed = conflicts.resolve(&ConflictInfo {
                    session_id: session_id.to_string(),
                    file_name: pathbase(remote_path),
                    dest_path: local_path.to_string(),
                    kind: if dest_is_dir { "dir" } else { "file" }.to_string(),
                    direction: "download".to_string(),
                    existing_size: dest_size,
                    existing_modified: dest_modified,
                    incoming_size: remote_size,
                    incoming_modified: remote_modified,
                })?;
                if !proceed {
                    return Ok(());
                }
            }
        }

        if !is_dir {
            return self.download_file(session_id, remote_path, local_path, cancel, on_progress);
        }

        let mut local_dirs: Vec<std::path::PathBuf> = Vec::new();
        let mut files: Vec<(String, std::path::PathBuf, u64)> = Vec::new();
        {
            let sftp = self
                .session
                .sftp()
                .map_err(|e| format!("SFTP subsystem: {}", e))?;
            collect_remote_tree(
                &sftp,
                remote_path,
                std::path::Path::new(local_path),
                &mut local_dirs,
                &mut files,
            )?;
        }

        for dir in &local_dirs {
            if cancel.load(Ordering::Relaxed) {
                return Err("Cancelled".to_string());
            }
            std::fs::create_dir_all(dir)
                .map_err(|e| format!("create local dir '{}': {}", dir.display(), e))?;
        }

        let grand_total: u64 = files.iter().map(|(_, _, size)| size).sum();
        let mut offset = 0u64;
        for (rp, lp, size) in &files {
            if cancel.load(Ordering::Relaxed) {
                return Err("Cancelled".to_string());
            }

            if let Some((_, dest_size, dest_modified)) = stat_local_brief(lp) {
                let proceed = conflicts.resolve(&ConflictInfo {
                    session_id: session_id.to_string(),
                    file_name: pathbase(rp),
                    dest_path: lp.to_string_lossy().to_string(),
                    kind: "file".to_string(),
                    direction: "download".to_string(),
                    existing_size: dest_size,
                    existing_modified: dest_modified,
                    incoming_size: Some(*size),
                    incoming_modified: None,
                })?;
                if !proceed {
                    offset += size;
                    on_progress(TransferProgress {
                        session_id: session_id.to_string(),
                        file_name: pathbase(rp),
                        bytes_transferred: offset,
                        total_bytes: grand_total,
                    });
                    continue;
                }
            }

            let base = offset;
            self.download_file(
                session_id,
                rp,
                &lp.to_string_lossy(),
                Arc::clone(&cancel),
                |p| {
                    on_progress(TransferProgress {
                        session_id: p.session_id,
                        file_name: p.file_name,
                        bytes_transferred: base + p.bytes_transferred,
                        total_bytes: grand_total,
                    })
                },
            )?;
            offset += size;
        }
        Ok(())
    }
}

/// (is_dir, size, modified) of a remote path, or None if it doesn't exist.
fn stat_remote_brief(sftp: &ssh2::Sftp, path: &str) -> Option<(bool, Option<u64>, Option<String>)> {
    let stat = sftp.stat(std::path::Path::new(path)).ok()?;
    Some((
        stat.file_type().is_dir(),
        stat.size,
        stat.mtime.map(format_unix_timestamp),
    ))
}

/// (is_dir, size, modified) of a local path, or None if it doesn't exist.
fn stat_local_brief(path: &std::path::Path) -> Option<(bool, Option<u64>, Option<String>)> {
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta.modified().ok().map(|t| {
        format_unix_timestamp(
            t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs(),
        )
    });
    let size = if meta.is_dir() { None } else { Some(meta.len()) };
    Some((meta.is_dir(), size, modified))
}

fn pathbase(path: &str) -> String {
    path.rsplit(['/', '\\']).find(|s| !s.is_empty()).unwrap_or("file").to_string()
}

/// Creates `path` on the remote if it doesn't exist; errors if it exists as a non-directory.
fn ensure_remote_dir(sftp: &ssh2::Sftp, path: &str) -> Result<(), String> {
    if let Ok(stat) = sftp.stat(std::path::Path::new(path)) {
        if stat.file_type().is_dir() {
            return Ok(());
        }
        return Err(format!(
            "Remote path '{}' exists and is not a directory",
            path
        ));
    }
    sftp.mkdir(std::path::Path::new(path), 0o755)
        .map_err(|e| format!("mkdir '{}': {}", path, e))
}

/// Recursively walks a local directory, collecting remote directories to create
/// (parents before children) and `(local file, remote path, size)` tuples.
/// Symlinks are followed via `metadata()`; broken links are skipped.
fn walk_local_tree(
    local_dir: &std::path::Path,
    remote_dir: &str,
    remote_dirs: &mut Vec<String>,
    files: &mut Vec<(std::path::PathBuf, String, u64)>,
) -> Result<(), String> {
    remote_dirs.push(remote_dir.to_string());
    let rd = std::fs::read_dir(local_dir)
        .map_err(|e| format!("read dir '{}': {}", local_dir.display(), e))?;
    for entry in rd.filter_map(|e| e.ok()) {
        let name = entry.file_name().to_string_lossy().to_string();
        let remote_child = format!("{}/{}", remote_dir.trim_end_matches('/'), name);
        let meta = match std::fs::metadata(entry.path()) {
            Ok(m) => m,
            Err(_) => continue, // broken symlink or unreadable — skip
        };
        if meta.is_dir() {
            walk_local_tree(&entry.path(), &remote_child, remote_dirs, files)?;
        } else if meta.is_file() {
            files.push((entry.path(), remote_child, meta.len()));
        }
    }
    Ok(())
}

/// Recursively walks a remote directory, collecting local directories to create
/// (parents before children) and `(remote path, local path, size)` tuples.
/// Symlinks are resolved with a follow-stat; broken links are skipped.
fn collect_remote_tree(
    sftp: &ssh2::Sftp,
    remote_dir: &str,
    local_dir: &std::path::Path,
    local_dirs: &mut Vec<std::path::PathBuf>,
    files: &mut Vec<(String, std::path::PathBuf, u64)>,
) -> Result<(), String> {
    local_dirs.push(local_dir.to_path_buf());
    let entries = sftp
        .readdir(std::path::Path::new(remote_dir))
        .map_err(|e| format!("readdir '{}': {}", remote_dir, e))?;
    for (pb, stat) in entries {
        let name = match pb.file_name() {
            Some(n) => n.to_string_lossy().to_string(),
            None => continue,
        };
        if name == "." || name == ".." {
            continue;
        }
        let remote_child = pb.to_string_lossy().to_string();
        let local_child = local_dir.join(&name);
        let mut is_dir = stat.file_type().is_dir();
        let mut size = stat.size.unwrap_or(0);
        if stat.file_type().is_symlink() {
            match sftp.stat(&pb) {
                Ok(target) => {
                    is_dir = target.file_type().is_dir();
                    size = target.size.unwrap_or(0);
                }
                Err(_) => continue, // broken symlink — skip
            }
        }
        if is_dir {
            collect_remote_tree(sftp, &remote_child, &local_child, local_dirs, files)?;
        } else {
            files.push((remote_child, local_child, size));
        }
    }
    Ok(())
}

pub struct SftpManager {
    sessions: HashMap<String, Arc<Mutex<SftpEntry>>>,
}

impl SftpManager {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
        }
    }

    /// Drops every SFTP session — used by quit-to-background reset.
    pub fn clear_all(&mut self) {
        self.sessions.clear();
    }

    pub fn get_session(&self, session_id: &str) -> Result<Arc<Mutex<SftpEntry>>, String> {
        self.sessions
            .get(session_id)
            .cloned()
            .ok_or_else(|| format!("SFTP session '{}' not found", session_id))
    }

    /// `log(stage, message)` — stage is one of "connecting", "handshaking", "authenticating", "ready"
    pub fn connect<F>(&mut self, req: SftpConnectRequest, log: F) -> Result<SftpSessionInfo, String>
    where
        F: Fn(&str, &str),
    {
        let key_path = req.private_key_path.as_deref().map(std::path::Path::new);
        let cfg = ssh::SshConfig {
            hostname: &req.hostname,
            port: req.port,
            username: &req.username,
            password: req.password.as_deref(),
            key_path,
        };
        let session = ssh::connect(&cfg, &log)?;

        let remote_path = req
            .default_remote_path
            .clone()
            .unwrap_or_else(|| "/".to_string());
        self.sessions.insert(
            req.session_id.clone(),
            Arc::new(Mutex::new(SftpEntry { session })),
        );

        log(
            "ready",
            &format!("Authenticated. Opening {}...", remote_path),
        );
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
        let result = manager.get_session("nonexistent");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }

    #[test]
    fn test_upload_no_session_returns_error() {
        let manager = SftpManager::new();
        let result = manager.get_session("nonexistent");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }

    #[test]
    fn test_delete_no_session_returns_error() {
        let manager = SftpManager::new();
        let result = manager.get_session("nonexistent");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }

    #[test]
    fn test_rename_no_session_returns_error() {
        let manager = SftpManager::new();
        let result = manager.get_session("nonexistent");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }

    #[test]
    fn test_mkdir_no_session_returns_error() {
        let manager = SftpManager::new();
        let result = manager.get_session("nonexistent");
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

    // --- conflict handler ---
    use std::cell::Cell;

    fn conflict_info() -> ConflictInfo {
        ConflictInfo {
            session_id: "s".into(),
            file_name: "f.txt".into(),
            dest_path: "/dest/f.txt".into(),
            kind: "file".into(),
            direction: "upload".into(),
            existing_size: Some(1),
            existing_modified: None,
            incoming_size: Some(2),
            incoming_modified: None,
        }
    }

    #[test]
    fn conflict_single_decisions_do_not_stick() {
        let mut h = ConflictHandler::new(ConflictMode::Ask, |_: &ConflictInfo| ConflictDecision::Overwrite);
        assert_eq!(h.resolve(&conflict_info()).unwrap(), true);
        let mut h = ConflictHandler::new(ConflictMode::Ask, |_: &ConflictInfo| ConflictDecision::Skip);
        assert_eq!(h.resolve(&conflict_info()).unwrap(), false);
    }

    #[test]
    fn conflict_apply_to_all_stops_prompting() {
        let calls = Cell::new(0u32);
        let mut h = ConflictHandler::new(ConflictMode::Ask, |_: &ConflictInfo| {
            calls.set(calls.get() + 1);
            ConflictDecision::OverwriteAll
        });
        assert_eq!(h.resolve(&conflict_info()).unwrap(), true);
        assert_eq!(h.resolve(&conflict_info()).unwrap(), true);
        assert_eq!(calls.get(), 1);

        let calls = Cell::new(0u32);
        let mut h = ConflictHandler::new(ConflictMode::Ask, |_: &ConflictInfo| {
            calls.set(calls.get() + 1);
            ConflictDecision::SkipAll
        });
        assert_eq!(h.resolve(&conflict_info()).unwrap(), false);
        assert_eq!(h.resolve(&conflict_info()).unwrap(), false);
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn conflict_preset_overwrite_all_never_prompts() {
        let mut h = ConflictHandler::new(ConflictMode::OverwriteAll, |_: &ConflictInfo| {
            panic!("must not prompt")
        });
        assert_eq!(h.resolve(&conflict_info()).unwrap(), true);
    }

    #[test]
    fn conflict_cancel_returns_cancelled_err() {
        let mut h = ConflictHandler::new(ConflictMode::Ask, |_: &ConflictInfo| ConflictDecision::Cancel);
        assert_eq!(h.resolve(&conflict_info()).unwrap_err(), "Cancelled");
    }
}

#[cfg(test)]
mod quit_reset_tests {
    use super::*;

    #[test]
    fn clear_all_empties_sessions() {
        let mut mgr = SftpManager::new();
        mgr.clear_all();
        assert!(mgr.sessions.is_empty());
    }
}
