use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use serde_json::json;
use serde_yaml::Value as YamlValue;
use tauri::{AppHandle, Emitter};

use crate::cli_path::{augmented_path, is_executable, resolve_program};
use crate::vault::resolve_inside_vault;
use crate::win_process::NoWindow;

const OUTLOOK_ACCEPT_KIND: &str = "outlook.accept";
const OUTLOOK_REJECT_KIND: &str = "outlook.reject";
const COMMS_BULK_KIND: &str = "comms.bulk";
const ACCEPTED_CATEGORY: &str = "anchor-accepted";
const REJECTED_CATEGORY: &str = "anchor-rejected";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OutlookMessage {
    pub id: String,
    pub from: String,
    pub subject: String,
    pub date: String,
    pub body_preview: String,
    pub web_link: Option<String>,
    pub categories: Vec<String>,
    pub is_read: bool,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OutlookDecision {
    Accepted,
    Rejected,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlookDecisionRequest {
    pub message_id: String,
    pub decision: OutlookDecision,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlookDecisionOutcome {
    pub message_id: String,
    pub decision: String,
    pub category_name: String,
    pub archived: bool,
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawOutlookMessage {
    id: String,
    #[serde(default)]
    subject: Option<String>,
    #[serde(default)]
    received_date_time: Option<String>,
    #[serde(default)]
    sent_date_time: Option<String>,
    #[serde(default)]
    body_preview: Option<String>,
    #[serde(default)]
    web_link: Option<String>,
    #[serde(default)]
    categories: Vec<String>,
    #[serde(default)]
    is_read: Option<bool>,
    #[serde(default)]
    from: Option<RawRecipient>,
    #[serde(default)]
    sender: Option<RawRecipient>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRecipient {
    #[serde(default)]
    email_address: Option<RawEmailAddress>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawEmailAddress {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    address: Option<String>,
}

#[tauri::command]
pub fn fetch_outlook_unread(
    work_path: Option<String>,
    max: Option<u32>,
    m365_path: Option<String>,
) -> Result<Vec<OutlookMessage>, String> {
    let work = work_path
        .as_deref()
        .and_then(|raw| resolve_inside_vault(raw, ".").ok());
    if provider_enabled(work.as_deref(), "mso") == Some(false) {
        return Ok(Vec::new());
    }
    let configured_m365 = work
        .as_deref()
        .and_then(|path| workspace_provider_string(path, "mso", &["command", "m365_path"]));
    let m365_bin = resolve_m365_path(m365_path.as_deref().or(configured_m365.as_deref()))
    .ok_or_else(|| {
        "cli_missing: m365 CLI not found. Install `@pnp/cli-microsoft365` or set the path in Comms settings."
            .to_string()
    })?;
    let mut cmd = Command::new(&m365_bin);
    cmd.env("PATH", augmented_path());
    cmd.args([
        "outlook",
        "message",
        "list",
        "--folderName",
        "inbox",
        "--output",
        "json",
    ]);
    let output = cmd
        .no_window()
        .output()
        .map_err(|err| format!("m365_spawn_failed: {err}"))?;
    if !output.status.success() {
        return Err(classify_m365_error(&output.stderr, &output.stdout));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut messages = parse_outlook_messages(&stdout)
        .map_err(|err| format!("m365_parse_failed: {err}"))?
        .into_iter()
        .filter(|message| !message.is_read)
        .collect::<Vec<_>>();
    messages.sort_by(|a, b| b.date.cmp(&a.date));
    let limit = max.unwrap_or(50).clamp(1, 200) as usize;
    messages.truncate(limit);
    Ok(messages)
}

#[tauri::command]
pub fn decide_outlook_item(
    app: AppHandle,
    approvals: tauri::State<'_, crate::approval::ApprovalState>,
    work_path: Option<String>,
    message_id: String,
    decision: OutlookDecision,
    approval_id: Option<String>,
    m365_path: Option<String>,
) -> Result<OutlookDecisionOutcome, String> {
    crate::approval::require_approval(&approvals, approval_id, decision.approval_kind())?;
    let outcome = decide_outlook_item_now(
        work_path.as_deref(),
        &message_id,
        decision,
        m365_path.as_deref(),
    )?;
    let _ = app.emit("outlook://decision", &outcome);
    Ok(outcome)
}

#[tauri::command]
pub fn decide_outlook_items(
    app: AppHandle,
    approvals: tauri::State<'_, crate::approval::ApprovalState>,
    work_path: Option<String>,
    items: Vec<OutlookDecisionRequest>,
    approval_id: Option<String>,
    m365_path: Option<String>,
) -> Result<Vec<OutlookDecisionOutcome>, String> {
    crate::approval::require_approval_any(
        &approvals,
        approval_id,
        &[OUTLOOK_ACCEPT_KIND, OUTLOOK_REJECT_KIND, COMMS_BULK_KIND],
    )?;
    let mut outcomes = Vec::new();
    for item in items {
        match decide_outlook_item_now(
            work_path.as_deref(),
            &item.message_id,
            item.decision.clone(),
            m365_path.as_deref(),
        ) {
            Ok(outcome) => {
                let _ = app.emit("outlook://decision", &outcome);
                outcomes.push(outcome);
            }
            Err(err) => outcomes.push(OutlookDecisionOutcome {
                message_id: item.message_id,
                decision: item.decision.as_str().to_string(),
                category_name: item.decision.category_name().to_string(),
                archived: false,
                ok: false,
                error: Some(err),
            }),
        }
    }
    Ok(outcomes)
}

fn decide_outlook_item_now(
    work_path: Option<&str>,
    message_id: &str,
    decision: OutlookDecision,
    m365_path: Option<&str>,
) -> Result<OutlookDecisionOutcome, String> {
    let message_id = message_id.trim();
    if message_id.is_empty() {
        return Err("message_id_required".to_string());
    }
    let work = work_path.and_then(|raw| resolve_inside_vault(raw, ".").ok());
    let configured_m365 = work
        .as_deref()
        .and_then(|path| workspace_provider_string(path, "mso", &["command", "m365_path"]));
    let m365_bin = resolve_m365_path(m365_path.or(configured_m365.as_deref()))
    .ok_or_else(|| {
        "cli_missing: m365 CLI not found. Install `@pnp/cli-microsoft365` or set the path in Comms settings."
            .to_string()
    })?;
    let mut categories = fetch_message_categories(&m365_bin, message_id).unwrap_or_default();
    categories.insert(decision.category_name().to_string());
    patch_message_categories(&m365_bin, message_id, categories)?;
    Ok(OutlookDecisionOutcome {
        message_id: message_id.to_string(),
        decision: decision.as_str().to_string(),
        category_name: decision.category_name().to_string(),
        archived: false,
        ok: true,
        error: None,
    })
}

fn resolve_m365_path(override_path: Option<&str>) -> Option<PathBuf> {
    if let Some(raw) = override_path {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            let candidate = PathBuf::from(trimmed);
            if is_executable(&candidate) {
                return Some(candidate);
            }
        }
    }
    resolve_program("m365")
}

fn fetch_message_categories(m365_bin: &Path, message_id: &str) -> Result<BTreeSet<String>, String> {
    let url = format!(
        "@graph/me/messages/{}?\\$select=categories",
        percent_encode_path_segment(message_id)
    );
    let output = Command::new(m365_bin)
        .env("PATH", augmented_path())
        .args(["request", "--url", &url, "--output", "json"])
        .no_window()
        .output()
        .map_err(|err| format!("m365_spawn_failed: {err}"))?;
    if !output.status.success() {
        return Err(classify_m365_error(&output.stderr, &output.stdout));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let json = extract_json_fragment(&stdout).ok_or_else(|| "no_json_payload".to_string())?;
    let value: serde_json::Value = serde_json::from_str(json).map_err(|err| err.to_string())?;
    Ok(value
        .get("categories")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .map(ToString::to_string)
        .collect())
}

fn patch_message_categories(
    m365_bin: &Path,
    message_id: &str,
    categories: BTreeSet<String>,
) -> Result<(), String> {
    let url = format!(
        "@graph/me/messages/{}",
        percent_encode_path_segment(message_id)
    );
    let body = json!({ "categories": categories.into_iter().collect::<Vec<_>>() }).to_string();
    let output = Command::new(m365_bin)
        .env("PATH", augmented_path())
        .args([
            "request",
            "--url",
            &url,
            "--method",
            "patch",
            "--body",
            &body,
            "--content-type",
            "application/json",
            "--output",
            "json",
        ])
        .no_window()
        .output()
        .map_err(|err| format!("m365_spawn_failed: {err}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(classify_m365_error(&output.stderr, &output.stdout))
    }
}

fn parse_outlook_messages(raw: &str) -> Result<Vec<OutlookMessage>, String> {
    let json = extract_json_fragment(raw).ok_or_else(|| "no_json_payload".to_string())?;
    let raw_messages: Vec<RawOutlookMessage> =
        serde_json::from_str(json).map_err(|err| err.to_string())?;
    Ok(raw_messages
        .into_iter()
        .map(|message| {
            let from = message
                .from
                .or(message.sender)
                .and_then(|recipient| recipient.email_address)
                .map(|email| match (email.name, email.address) {
                    (Some(name), Some(address)) if !name.trim().is_empty() => {
                        format!("{} <{}>", name.trim(), address.trim())
                    }
                    (_, Some(address)) => address,
                    (Some(name), _) => name,
                    _ => String::new(),
                })
                .unwrap_or_default();
            OutlookMessage {
                id: message.id,
                from,
                subject: message.subject.unwrap_or_default(),
                date: message
                    .received_date_time
                    .or(message.sent_date_time)
                    .unwrap_or_default(),
                body_preview: message.body_preview.unwrap_or_default(),
                web_link: message.web_link,
                categories: message.categories,
                is_read: message.is_read.unwrap_or(false),
            }
        })
        .collect())
}

fn classify_m365_error(stderr: &[u8], stdout: &[u8]) -> String {
    let detail = [stderr, stdout]
        .into_iter()
        .map(|bytes| String::from_utf8_lossy(bytes).trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let lower = detail.to_lowercase();
    let kind = if lower.contains("aadsts")
        || lower.contains("login")
        || lower.contains("not logged")
        || lower.contains("auth")
        || lower.contains("token")
        || lower.contains("access is denied")
        || lower.contains("403")
        || lower.contains("forbidden")
        || lower.contains("insufficient privileges")
        || lower.contains("permission")
    {
        "auth_required"
    } else {
        "m365_failed"
    };
    if kind == "auth_required"
        && (lower.contains("access is denied")
            || lower.contains("403")
            || lower.contains("forbidden")
            || lower.contains("insufficient privileges"))
    {
        format!(
            "{kind}: m365 is connected, but Microsoft Graph mail access is denied. Reconnect with Mail.Read/Mail.ReadWrite consent. {detail}"
        )
    } else {
        format!("{kind}: {detail}")
    }
}

fn provider_enabled(work_path: Option<&Path>, provider: &str) -> Option<bool> {
    let value = workspace_provider_value(work_path?, provider, "enabled")?;
    value.as_bool()
}

fn workspace_provider_string(work_path: &Path, provider: &str, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(value) = workspace_provider_value(work_path, provider, key).and_then(|value| {
            value
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
        }) {
            return Some(value);
        }
    }
    None
}

fn workspace_provider_value(work_path: &Path, provider: &str, key: &str) -> Option<YamlValue> {
    let content = fs::read_to_string(work_path.join("workspace.config.yaml")).ok()?;
    let yaml: YamlValue = serde_yaml::from_str(&content).ok()?;
    yaml.get("io")?
        .get("providers")?
        .get(provider)?
        .get(key)
        .cloned()
}

fn percent_encode_path_segment(input: &str) -> String {
    let mut out = String::new();
    for byte in input.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(*byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

fn extract_json_fragment(raw: &str) -> Option<&str> {
    let bytes = raw.as_bytes();
    for (start, byte) in bytes.iter().enumerate() {
        if *byte != b'[' && *byte != b'{' {
            continue;
        }
        let open = *byte;
        let close = if open == b'[' { b']' } else { b'}' };
        let mut depth = 0usize;
        let mut in_string = false;
        let mut escaped = false;
        for (offset, current) in bytes[start..].iter().enumerate() {
            if in_string {
                if escaped {
                    escaped = false;
                } else if *current == b'\\' {
                    escaped = true;
                } else if *current == b'"' {
                    in_string = false;
                }
                continue;
            }
            if *current == b'"' {
                in_string = true;
            } else if *current == open {
                depth += 1;
            } else if *current == close {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return raw.get(start..=start + offset);
                }
            }
        }
    }
    None
}

impl OutlookDecision {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::Rejected => "rejected",
        }
    }

    fn category_name(&self) -> &'static str {
        match self {
            Self::Accepted => ACCEPTED_CATEGORY,
            Self::Rejected => REJECTED_CATEGORY,
        }
    }

    fn approval_kind(&self) -> &'static str {
        match self {
            Self::Accepted => OUTLOOK_ACCEPT_KIND,
            Self::Rejected => OUTLOOK_REJECT_KIND,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_normal_and_noisy_json_output() {
        let raw = r#"Using cached context
[
  {
    "id": "a",
    "subject": "Hello",
    "receivedDateTime": "2026-05-10T01:00:00Z",
    "bodyPreview": "Preview",
    "isRead": false,
    "categories": ["Blue"],
    "from": { "emailAddress": { "name": "Jane", "address": "jane@example.com" } }
  }
]
"#;
        let parsed = parse_outlook_messages(raw).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].from, "Jane <jane@example.com>");
        assert_eq!(parsed[0].categories, vec!["Blue"]);
    }

    #[test]
    fn classifies_auth_and_provider_errors() {
        assert!(
            classify_m365_error(b"AADSTS device login required", b"").starts_with("auth_required:")
        );
        assert!(classify_m365_error(
            b"Error: Access is denied. Check credentials and try again.",
            b""
        )
        .starts_with("auth_required:"));
        assert!(classify_m365_error(b"network down", b"").starts_with("m365_failed:"));
    }

    #[test]
    fn encodes_graph_message_path_segment() {
        assert_eq!(percent_encode_path_segment("a/b+c="), "a%2Fb%2Bc%3D");
    }
}
