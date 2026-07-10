//! Pure helpers for building the shell payloads used by `run_snippet_script`.

/// Strip carriage returns so CRLF-authored snippets run cleanly under bash
/// (a trailing `\r` per line otherwise yields `$'\r': command not found`).
pub fn normalize_script(script: &str) -> String {
    script.replace('\r', "")
}

/// 8-char random id for temp file names / heredoc markers.
pub fn short_id() -> String {
    uuid::Uuid::new_v4().to_string().replace('-', "")[..8].to_string()
}

/// PTY payload executing a script already uploaded to `remote_path` via SFTP.
/// The leading `printf` erases the echoed command line; `bash` interprets the
/// file regardless of shebang, matching the local branch and pre-SFTP behavior.
pub fn remote_exec_payload(remote_path: &str) -> String {
    format!(
        " printf '\\033[1A\\033[2K\\r' && bash \"{p}\"; rm -f \"{p}\"\r",
        p = remote_path
    )
}

/// PTY payload executing a script written to a local temp file.
pub fn local_exec_payload(path: &str) -> String {
    format!(
        " printf '\\033[1A\\033[2K\\r' && bash \"{p}\"; rm -f \"{p}\"\r",
        p = path
    )
}

/// Heredoc-over-PTY payload — needs no SFTP subsystem on the host, so it is
/// the fallback when the SFTP upload path is unavailable. The heredoc body is
/// not echoed by the shell, so script content stays out of the terminal.
/// `script` must already be normalized (no `\r`).
/// The mktemp template must end in the X run: BSD/busybox mktemp only
/// substitute a trailing run of X's.
pub fn heredoc_payload(script: &str, marker_id: &str) -> String {
    let eof = format!("TERMIFAI_EOF_{}", marker_id);
    format!(
        " printf '\\033[1A\\033[2K\\r' && f=$(mktemp /tmp/termifai_XXXXXXXX) && cat > \"$f\" << '{eof}'\r{script}\r{eof}\rbash \"$f\"; rm -f \"$f\"\r",
        eof = eof,
        script = script,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_strips_carriage_returns() {
        assert_eq!(normalize_script("a\r\nb\r\n"), "a\nb\n");
        assert_eq!(normalize_script("plain\n"), "plain\n");
    }

    #[test]
    fn short_id_is_8_chars_and_random() {
        let a = short_id();
        let b = short_id();
        assert_eq!(a.len(), 8);
        assert_ne!(a, b);
    }

    #[test]
    fn remote_payload_runs_via_bash_and_cleans_up() {
        let p = remote_exec_payload("/tmp/x.sh");
        assert!(p.contains("bash \"/tmp/x.sh\""), "must run via bash, got: {p}");
        assert!(p.contains("rm -f \"/tmp/x.sh\""));
        assert!(!p.contains("chmod"), "bash execution needs no chmod");
        assert!(p.starts_with(' '), "leading space keeps it out of shell history");
        assert!(p.ends_with('\r'));
    }

    #[test]
    fn local_payload_runs_via_bash_and_cleans_up() {
        let p = local_exec_payload("/var/folders/t/x.sh");
        assert!(p.contains("bash \"/var/folders/t/x.sh\""));
        assert!(p.contains("rm -f \"/var/folders/t/x.sh\""));
    }

    #[test]
    fn heredoc_payload_embeds_script_and_marker() {
        let p = heredoc_payload("echo hi\necho bye", "abc12345");
        assert!(p.contains("<< 'TERMIFAI_EOF_abc12345'"));
        assert!(p.contains("echo hi\necho bye"));
        assert!(p.contains("bash \"$f\""));
        assert!(p.contains("mktemp /tmp/termifai_XXXXXXXX"));
        assert!(p.ends_with('\r'));
    }
}
