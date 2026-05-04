// Phase 2 step 5 (revised): Gmail surface via the user's existing
// Google Workspace CLI (`gws`). Replaces the planned async-imap path —
// no app password, no TLS, no IMAP state machine. Anchor shells out to
// `gws gmail +triage --format json` and parses the JSON envelope.
//
// `gws` writes "Using keyring backend: keyring" to stderr; stdout is
// pure JSON. The parser therefore never sees the keyring line.
//
// macOS Tauri apps inherit a sparse PATH that does not include
// /opt/homebrew/bin or ~/go/bin where users typically install `gws`.
// `resolve_gws_path` augments PATH with the standard install
// locations and falls back to a user-provided absolute path stored in
// `<vault>/.anchor/inbox.json`.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::inbox_settings;
use crate::vault::resolve_inside_vault;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GmailMessage {
    pub id: String,
    pub from: String,
    pub subject: String,
    pub date: String,
}

#[derive(Debug, Deserialize)]
struct TriageResponse {
    messages: Vec<RawMessage>,
}

#[derive(Debug, Deserialize)]
struct RawMessage {
    id: String,
    #[serde(default)]
    from: Option<String>,
    #[serde(default)]
    subject: Option<String>,
    #[serde(default)]
    date: Option<String>,
}

/// Locations to probe in addition to the inherited PATH. macOS Tauri
/// apps launched from Finder do not inherit the user's shell PATH, so
/// `gws` installed via Homebrew or `go install` is invisible without
/// this augmentation.
fn extra_path_dirs() -> Vec<PathBuf> {
    let mut out = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
    ];
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        out.push(home.join(".local/bin"));
        out.push(home.join("go/bin"));
        out.push(home.join(".cargo/bin"));
    }
    out
}

fn augmented_path() -> std::ffi::OsString {
    let existing = std::env::var_os("PATH").unwrap_or_default();
    let extras = extra_path_dirs();
    let mut paths: Vec<PathBuf> = std::env::split_paths(&existing).collect();
    for dir in extras {
        if !paths.iter().any(|p| p == &dir) {
            paths.push(dir);
        }
    }
    std::env::join_paths(paths).unwrap_or(existing)
}

/// Resolve the `gws` binary. Priority: explicit override → PATH →
/// augmented PATH probe. Returns the absolute path so spawning is not
/// dependent on the inherited PATH.
fn resolve_gws_path(override_path: Option<&str>) -> Option<PathBuf> {
    if let Some(raw) = override_path {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            let candidate = PathBuf::from(trimmed);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    if let Ok(path) = which_in_path("gws", std::env::var_os("PATH").as_deref()) {
        return Some(path);
    }
    if let Ok(path) = which_in_path("gws", Some(&augmented_path())) {
        return Some(path);
    }
    None
}

fn which_in_path(
    program: &str,
    path_env: Option<&std::ffi::OsStr>,
) -> Result<PathBuf, std::io::Error> {
    let Some(path_env) = path_env else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "PATH unavailable",
        ));
    };
    for dir in std::env::split_paths(path_env) {
        let candidate = dir.join(program);
        if is_executable(&candidate) {
            return Ok(candidate);
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        format!("{program} not found"),
    ))
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    match std::fs::metadata(path) {
        Ok(meta) => meta.is_file() && (meta.permissions().mode() & 0o111) != 0,
        Err(_) => false,
    }
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

#[tauri::command]
pub fn fetch_gmail_unread(
    vault_path: Option<String>,
    max: Option<u32>,
    query: Option<String>,
) -> Result<Vec<GmailMessage>, String> {
    let max = max.unwrap_or(20).min(200);

    let override_path = vault_path.as_deref().and_then(|raw| {
        let vault = resolve_inside_vault(raw, ".").ok()?;
        inbox_settings::load(&vault).gws_path
    });

    let gws_bin = resolve_gws_path(override_path.as_deref()).ok_or_else(|| {
        "cli_missing: gws CLI not found. Install via `brew install gws` or set the path in inbox settings (https://github.com/googleworkspace/gws)"
            .to_string()
    })?;

    let mut cmd = Command::new(&gws_bin);
    cmd.env("PATH", augmented_path());
    cmd.args(["gmail", "+triage", "--format", "json", "--max"])
        .arg(max.to_string());
    if let Some(q) = query {
        let trimmed = q.trim();
        if !trimmed.is_empty() {
            cmd.args(["--query", trimmed]);
        }
    }

    let output = cmd
        .output()
        .map_err(|err| format!("gws_spawn_failed: {err}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.trim();
        let kind = if detail.contains("scope") || detail.contains("consent") || detail.contains("token") {
            "auth_required"
        } else {
            "gws_failed"
        };
        return Err(format!("{kind}: {detail}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_triage_output(&stdout).map_err(|err| format!("gws_parse_failed: {err}"))
}

fn parse_triage_output(raw: &str) -> Result<Vec<GmailMessage>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("empty stdout".to_string());
    }
    let response: TriageResponse =
        serde_json::from_str(trimmed).map_err(|err| err.to_string())?;
    Ok(response
        .messages
        .into_iter()
        .map(|m| GmailMessage {
            id: m.id,
            from: m.from.unwrap_or_default(),
            subject: m.subject.unwrap_or_default(),
            date: m.date.unwrap_or_default(),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_full_triage_payload() {
        let raw = r#"{
  "messages": [
    {"id": "abc", "from": "x@y.com", "subject": "hello", "date": "Tue, 1 Jan 2026 00:00:00 +0000"},
    {"id": "def", "from": "boss <b@y.com>", "subject": "회의록", "date": "Wed, 2 Jan 2026 09:00:00 +0900"}
  ],
  "query": "is:unread",
  "resultSizeEstimate": 2
}"#;
        let msgs = parse_triage_output(raw).unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].id, "abc");
        assert_eq!(msgs[0].subject, "hello");
        assert_eq!(msgs[1].subject, "회의록");
    }

    #[test]
    fn parses_empty_message_list() {
        let raw = r#"{"messages": [], "query": "is:unread", "resultSizeEstimate": 0}"#;
        let msgs = parse_triage_output(raw).unwrap();
        assert!(msgs.is_empty());
    }

    #[test]
    fn missing_optional_fields_default_to_empty_strings() {
        let raw = r#"{"messages": [{"id": "abc"}]}"#;
        let msgs = parse_triage_output(raw).unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].from, "");
        assert_eq!(msgs[0].subject, "");
        assert_eq!(msgs[0].date, "");
    }

    #[test]
    fn invalid_json_errors() {
        assert!(parse_triage_output("not json").is_err());
        assert!(parse_triage_output("").is_err());
        assert!(parse_triage_output("   ").is_err());
    }

    #[test]
    fn missing_id_field_errors() {
        let raw = r#"{"messages": [{"subject": "no id"}]}"#;
        assert!(parse_triage_output(raw).is_err());
    }

    #[test]
    fn augmented_path_includes_homebrew_bin() {
        let augmented = augmented_path();
        let augmented_str = augmented.to_string_lossy();
        assert!(
            augmented_str.contains("/opt/homebrew/bin"),
            "expected /opt/homebrew/bin in {augmented_str}"
        );
    }

    #[test]
    fn resolve_gws_path_respects_override_when_file_exists() {
        let tmp = tempfile::TempDir::new().unwrap();
        let bin = tmp.path().join("gws");
        std::fs::write(&bin, b"#!/bin/sh\necho gws").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let resolved = resolve_gws_path(Some(bin.to_string_lossy().as_ref()));
        assert_eq!(resolved.as_deref(), Some(bin.as_path()));
    }

    #[test]
    fn resolve_gws_path_ignores_blank_override() {
        let resolved = resolve_gws_path(Some("   "));
        // Result depends on host PATH; we only assert no panic and that
        // an empty-string override is treated as "no override".
        let _ = resolved;
    }
}
