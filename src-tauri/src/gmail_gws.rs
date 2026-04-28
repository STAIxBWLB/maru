// Phase 2 step 5 (revised): Gmail surface via the user's existing
// Google Workspace CLI (`gws`). Replaces the planned async-imap path —
// no app password, no TLS, no IMAP state machine. Anchor shells out to
// `gws gmail +triage --format json` and parses the JSON envelope.
//
// `gws` writes "Using keyring backend: keyring" to stderr; stdout is
// pure JSON. The parser therefore never sees the keyring line.

use std::process::Command;

use serde::{Deserialize, Serialize};

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

#[tauri::command]
pub fn fetch_gmail_unread(
    max: Option<u32>,
    query: Option<String>,
) -> Result<Vec<GmailMessage>, String> {
    let max = max.unwrap_or(20).min(200);
    let mut cmd = Command::new("gws");
    cmd.args(["gmail", "+triage", "--format", "json", "--max"])
        .arg(max.to_string());
    if let Some(q) = query {
        let trimmed = q.trim();
        if !trimmed.is_empty() {
            cmd.args(["--query", trimmed]);
        }
    }

    let output = cmd.output().map_err(|err| {
        if err.kind() == std::io::ErrorKind::NotFound {
            "cli_missing: gws CLI not found in PATH (https://github.com/googleworkspace/gws)"
                .to_string()
        } else {
            format!("gws_spawn_failed: {err}")
        }
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.trim();
        // Heuristic auth detection — gws surfaces auth issues with
        // wording about scopes / consent / token.
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
        // Without `id`, the message can't be deduplicated downstream;
        // serde rejects it because RawMessage.id is non-optional.
        let raw = r#"{"messages": [{"subject": "no id"}]}"#;
        assert!(parse_triage_output(raw).is_err());
    }
}
