use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};

static COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Serialize)]
pub struct TabInfo {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Serialize)]
struct ConnectionStatusPayload {
    stage: String,
    status: String,
    message: String,
    log: Option<String>,
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
}

pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, Session>>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn create_session(
        &self,
        app: &AppHandle,
        cwd: &str,
        initial_command: Option<&str>,
        initial_password: Option<&str>,
        ready_marker: Option<&str>,
    ) -> Result<TabInfo, String> {
        let pty_system = native_pty_system();

        let size = PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        };

        let pair = pty_system
            .openpty(size)
            .map_err(|e| format!("Failed to open PTY: {}", e))?;

        let mut cmd = build_shell_command(initial_command);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");


        let cwd_path = if !cwd.is_empty() {
            Some(cwd.to_string())
        } else {
            std::env::var("HOME")
                .ok()
                .or_else(|| std::env::var("USERPROFILE").ok())
        };
        if let Some(path) = cwd_path {
            cmd.cwd(path);
        }

        pair.slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn shell: {}", e))?;

        let session_id = uuid::Uuid::new_v4().to_string();
        let seq = COUNTER.fetch_add(1, Ordering::SeqCst) + 1;
        let label = format!("Terminal {}", seq);

        // Read thread: read PTY output and emit to frontend
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to clone reader: {}", e))?;

        let event_name = format!("term:{}:output", session_id);
        let exit_event = format!("term:{}:exited", session_id);
        let app_handle = app.clone();
        let password_for_prompt = initial_password
            .filter(|password| !password.is_empty())
            .map(|password| password.to_string());
        let ready_marker = ready_marker
            .filter(|marker| !marker.is_empty())
            .map(|marker| marker.to_string());
        let password_session_id = session_id.clone();
        let sessions_for_password = self.sessions.clone();
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to take writer: {}", e))?;
        let session = Session {
            master: pair.master,
            writer,
        };

        self.sessions
            .lock()
            .unwrap()
            .insert(session_id.clone(), session);

        let mut connection_tracker =
            ConnectionTracker::new(app.clone(), ready_marker.as_deref());
        connection_tracker.start();

        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut recent_output = String::new();
            let mut password_sent = false;
            let mut ready = ready_marker.is_none();
            let mut pending_output = String::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        if !ready {
                            connection_tracker.fail_current(
                                "Connection failed before the SSH session became ready.",
                            );
                            let _ = app_handle.emit(
                                &event_name,
                                "\r\n\x1b[31mConnection failed before SSH session became ready.\x1b[0m\r\n"
                                    .to_string(),
                            );
                        }
                        let _ = app_handle.emit(&exit_event, true);
                        break;
                    }
                    Ok(n) => {
                        let data = String::from_utf8_lossy(&buf[..n]).to_string();
                        if !ready {
                            connection_tracker.handle_output(&data, ready_marker.as_deref());
                        }
                        if !password_sent {
                            if let Some(password) = password_for_prompt.as_deref() {
                                recent_output.push_str(&String::from_utf8_lossy(&buf[..n]).to_lowercase());
                                if recent_output.len() > 2048 {
                                    let keep_from = recent_output.len().saturating_sub(2048);
                                    recent_output = recent_output[keep_from..].to_string();
                                }
                                if recent_output.contains("password:") {
                                    if let Ok(mut sessions) = sessions_for_password.lock() {
                                        if let Some(session) = sessions.get_mut(&password_session_id) {
                                            let _ = session.writer.write_all(format!("{}\r", password).as_bytes());
                                            let _ = session.writer.flush();
                                            password_sent = true;
                                        }
                                    }
                                }
                            }
                        }
                        if ready {
                            let _ = app_handle.emit(&event_name, data);
                        } else if let Some(marker) = ready_marker.as_deref() {
                            pending_output.push_str(&data);
                            if let Some(marker_end) = find_ready_marker_line(&pending_output, marker) {
                                ready = true;
                                connection_tracker.complete();
                                let _ = app_handle.emit(&event_name, "\x1b[2J\x1b[H".to_string());
                                let cleaned = pending_output[marker_end..]
                                    .trim_start_matches('\r')
                                    .trim_start_matches('\n')
                                    .to_string();
                                if !cleaned.is_empty() {
                                    let _ = app_handle.emit(&event_name, cleaned);
                                }
                                pending_output.clear();
                            } else if pending_output.len() > 8192 {
                                let keep_from = pending_output.len().saturating_sub(8192);
                                pending_output = pending_output[keep_from..].to_string();
                            }
                        }
                    }
                    Err(_) => {
                        if !ready {
                            connection_tracker.fail_current(
                                "Connection failed before the SSH session became ready.",
                            );
                            let _ = app_handle.emit(
                                &event_name,
                                "\r\n\x1b[31mConnection failed before SSH session became ready.\x1b[0m\r\n"
                                    .to_string(),
                            );
                        }
                        let _ = app_handle.emit(&exit_event, true);
                        break;
                    }
                }
            }
        });

        Ok(TabInfo {
            id: session_id,
            label,
        })
    }

    pub fn write_to_session(&self, session_id: &str, data: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("Session not found: {}", session_id))?;
        session
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("Write failed: {}", e))?;
        Ok(())
    }

    pub fn resize_session(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(session_id)
            .ok_or_else(|| format!("Session not found: {}", session_id))?;
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Resize failed: {}", e))?;
        Ok(())
    }

    pub fn close_session(&self, session_id: &str) -> Result<(), String> {
        self.sessions.lock().unwrap().remove(session_id);
        Ok(())
    }
}

fn build_shell_command(initial_command: Option<&str>) -> CommandBuilder {
    #[cfg(target_os = "windows")]
    {
        // SSH command: parse the POSIX-quoted command line and invoke the executable
        // directly — bypasses PowerShell so Unix-style quoting is preserved intact.
        if let Some(command) = initial_command.filter(|c| !c.trim().is_empty()) {
            let args = parse_posix_command(command);
            if !args.is_empty() {
                let mut cmd = CommandBuilder::new(&args[0]);
                for arg in &args[1..] {
                    cmd.arg(arg);
                }
                return cmd;
            }
        }

        // Local terminal (no initial_command): prefer PowerShell, fall back to cmd.exe
        let pwsh = ["pwsh.exe", "powershell.exe"]
            .iter()
            .find(|&&name| which_exists(name))
            .map(|s| s.to_string());

        if let Some(ps) = pwsh {
            CommandBuilder::new(&ps)
        } else {
            CommandBuilder::new(
                std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string()),
            )
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        let mut cmd = CommandBuilder::new(&shell);
        if let Some(command) = initial_command.filter(|c| !c.trim().is_empty()) {
            cmd.arg("-lc");
            cmd.arg(command);
        } else {
            cmd.arg("-l");
        }
        cmd
    }
}

/// Parse a POSIX-style shell command line into individual arguments.
/// Handles single-quoted strings, double-quoted strings, and backslash escapes —
/// including the `'\''` pattern used by shellQuote to embed single quotes.
#[cfg(target_os = "windows")]
fn parse_posix_command(cmd: &str) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_arg = false;
    let mut chars = cmd.chars().peekable();

    while let Some(c) = chars.next() {
        match c {
            ' ' | '\t' => {
                if in_arg {
                    args.push(std::mem::take(&mut current));
                    in_arg = false;
                }
            }
            '\'' => {
                in_arg = true;
                // Read until closing single quote (no escaping inside SQ)
                for ch in chars.by_ref() {
                    if ch == '\'' {
                        break;
                    }
                    current.push(ch);
                }
            }
            '"' => {
                in_arg = true;
                // Double-quoted: only \\ \" \$ \` \<newline> are special
                loop {
                    match chars.next() {
                        Some('"') => break,
                        Some('\\') => match chars.next() {
                            Some(ch @ ('"' | '\\' | '$' | '`' | '\n')) => current.push(ch),
                            Some(ch) => { current.push('\\'); current.push(ch); }
                            None => break,
                        },
                        Some(ch) => current.push(ch),
                        None => break,
                    }
                }
            }
            '\\' => {
                in_arg = true;
                if let Some(ch) = chars.next() {
                    current.push(ch);
                }
            }
            _ => {
                in_arg = true;
                current.push(c);
            }
        }
    }

    if in_arg {
        args.push(current);
    }

    args
}

#[cfg(target_os = "windows")]
fn which_exists(name: &str) -> bool {
    std::process::Command::new("where")
        .arg(name)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

struct ConnectionTracker {
    app: AppHandle,
    event_name: Option<String>,
    stage: &'static str,
    failed: bool,
}

impl ConnectionTracker {
    fn new(app: AppHandle, ready_marker: Option<&str>) -> Self {
        Self {
            app,
            event_name: ready_marker.map(|marker| format!("term:{}:connection-status", marker)),
            stage: "connecting",
            failed: false,
        }
    }

    fn start(&self) {
        self.emit(
            "connecting",
            "active",
            "Opening TCP connection to SSH server...",
            None,
        );
    }

    fn handle_output(&mut self, data: &str, ready_marker: Option<&str>) {
        if self.event_name.is_none() || self.failed {
            return;
        }

        for line in data.split(['\r', '\n']) {
            if let Some(log) = sanitize_connection_log(line, ready_marker) {
                self.emit(self.stage, "active", self.message_for_stage(), Some(log));
            }
        }

        let lower = data.to_lowercase();
        if lower.contains("could not resolve hostname")
            || lower.contains("name or service not known")
            || lower.contains("nodename nor servname provided")
        {
            self.fail("connecting", "Hostname could not be resolved.");
        } else if lower.contains("connection refused") {
            self.fail("connecting", "SSH connection was refused by the server.");
        } else if lower.contains("operation timed out")
            || lower.contains("connection timed out")
            || lower.contains("no route to host")
            || lower.contains("network is unreachable")
        {
            self.fail("connecting", "SSH connection timed out.");
        } else if lower.contains("are you sure you want to continue connecting") {
            // Host key not yet in known_hosts — accept-new flag should handle this automatically,
            // but if it doesn't (older SSH), surface it as a handshake failure
            self.fail("handshaking", "Host key not verified. Check SSH client version.");
        } else if lower.contains("host key verification failed")
            || lower.contains("no matching host key type")
            || lower.contains("no matching key exchange method")
            || lower.contains("kex_exchange_identification")
        {
            self.fail("handshaking", "SSH handshake failed.");
        } else if lower.contains("permission denied")
            || lower.contains("too many authentication failures")
            || lower.contains("authentication failed")
        {
            self.fail("authenticating", "SSH authentication failed.");
        } else if lower.contains("connection closed")
            || lower.contains("connection reset")
            || lower.contains("broken pipe")
        {
            self.fail(self.stage, "SSH connection closed before the shell opened.");
        } else if lower.contains("authenticated to")
            || lower.contains("authentication succeeded")
            || lower.contains("debug1: entering interactive session")
        {
            self.advance("shell", "Opening remote shell...");
        } else if lower.contains("authenticating to")
            || lower.contains("authentications that can continue")
            || lower.contains("next authentication method")
            || lower.contains("password:")
        {
            self.advance("authenticating", "Authenticating with SSH server...");
        } else if lower.contains("connection established")
            || lower.contains("remote protocol version")
            || lower.contains("local version string")
            || lower.contains("ssh2_msg_kexinit")
            || lower.contains("expecting ssh2_msg")
            || lower.contains("server host key")
            || lower.contains("kex:")
        {
            self.advance("handshaking", "Handshaking with SSH server...");
        } else if lower.contains("connecting to ") {
            self.advance("connecting", "Opening TCP connection to SSH server...");
        }
    }

    fn complete(&mut self) {
        self.failed = false;
        self.stage = "shell";
        self.emit("shell", "done", "Connected. Opening terminal...", None);
    }

    fn fail_current(&mut self, message: &str) {
        if self.failed {
            return;
        }
        self.fail(self.stage, message);
    }

    fn advance(&mut self, stage: &'static str, message: &str) {
        if self.failed || stage_order(stage) < stage_order(self.stage) {
            return;
        }

        self.stage = stage;
        self.emit(stage, "active", message, None);
    }

    fn fail(&mut self, stage: &'static str, message: &str) {
        self.failed = true;
        self.stage = stage;
        self.emit(stage, "failed", message, None);
    }

    fn emit(&self, stage: &str, status: &str, message: &str, log: Option<String>) {
        if let Some(event_name) = self.event_name.as_deref() {
            let _ = self.app.emit(
                event_name,
                ConnectionStatusPayload {
                    stage: stage.to_string(),
                    status: status.to_string(),
                    message: message.to_string(),
                    log,
                },
            );
        }
    }

    fn message_for_stage(&self) -> &'static str {
        match self.stage {
            "connecting" => "Opening TCP connection to SSH server...",
            "handshaking" => "Handshaking with SSH server...",
            "authenticating" => "Authenticating with SSH server...",
            "shell" => "Opening remote shell...",
            _ => "Connecting...",
        }
    }
}

fn stage_order(stage: &str) -> u8 {
    match stage {
        "connecting" => 0,
        "handshaking" => 1,
        "authenticating" => 2,
        "shell" => 3,
        _ => 0,
    }
}

fn sanitize_connection_log(line: &str, ready_marker: Option<&str>) -> Option<String> {
    let mut cleaned = line.replace('\u{1b}', "");
    if let Some(marker) = ready_marker {
        cleaned = cleaned.replace(marker, "");
    }
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn find_ready_marker_line(output: &str, marker: &str) -> Option<usize> {
    let mut search_from = 0;
    while let Some(relative_start) = output[search_from..].find(marker) {
        let marker_start = search_from + relative_start;
        let before = &output[..marker_start];
        let line_start = before
            .rfind(['\r', '\n'])
            .map(|index| index + 1)
            .unwrap_or(0);
        let marker_end = marker_start + marker.len();
        let after = &output[marker_end..];
        let line_end = after
            .find(['\r', '\n'])
            .map(|index| marker_end + index)
            .unwrap_or(output.len());

        if output[line_start..marker_start].trim().is_empty()
            && output[marker_end..line_end].trim().is_empty()
        {
            return Some(line_end);
        }

        search_from = marker_end;
    }

    None
}
