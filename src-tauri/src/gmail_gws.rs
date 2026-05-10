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

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use serde_json::json;
use serde_yaml::Value as YamlValue;
use tauri::{AppHandle, Emitter};

use crate::cli_path::{augmented_path, is_executable, resolve_program};
use crate::inbox_settings::{self, InboxGmailConfig};
use crate::vault::resolve_inside_vault;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GmailMessage {
    pub id: String,
    pub from: String,
    pub subject: String,
    pub date: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GmailDecision {
    Accepted,
    Rejected,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GmailDecisionRequest {
    pub message_id: String,
    pub decision: GmailDecision,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GmailDecisionOutcome {
    pub message_id: String,
    pub decision: String,
    pub label_name: String,
    pub archived: bool,
    pub ok: bool,
    pub error: Option<String>,
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

#[derive(Debug, Deserialize)]
struct LabelListResponse {
    #[serde(default)]
    labels: Vec<GmailLabel>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
struct GmailLabel {
    id: String,
    name: String,
}

const GMAIL_ACCEPT_KIND: &str = "gmail.accept";
const GMAIL_REJECT_KIND: &str = "gmail.reject";
const INBOX_BULK_KIND: &str = "inbox.bulk";
const ACCEPTED_LABEL: &str = "anchor-accepted";
const REJECTED_LABEL: &str = "anchor-rejected";

/// Resolve the `gws` binary. Priority: explicit override → PATH →
/// augmented PATH probe. Returns the absolute path so spawning is not
/// dependent on the inherited PATH.
fn resolve_gws_path(override_path: Option<&str>) -> Option<PathBuf> {
    if let Some(raw) = override_path {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            let candidate = PathBuf::from(trimmed);
            if is_executable(&candidate) {
                return Some(candidate);
            }
        }
    }
    resolve_program("gws")
}

#[tauri::command]
pub fn fetch_gmail_unread(
    vault_path: Option<String>,
    max: Option<u32>,
    query: Option<String>,
) -> Result<Vec<GmailMessage>, String> {
    let runtime_gmail = vault_path
        .as_deref()
        .and_then(|raw| resolve_inside_vault(raw, ".").ok())
        .and_then(|vault| inbox_settings::load_runtime_config(&vault).ok().flatten())
        .map(|config| config.gmail);

    if runtime_gmail.as_ref().is_some_and(|gmail| !gmail.enabled) {
        return Ok(Vec::new());
    }

    let max = max
        .or_else(|| runtime_gmail.as_ref().map(|gmail| gmail.max_results))
        .unwrap_or(20)
        .clamp(1, 200);
    let query = match query {
        Some(value) if !value.trim().is_empty() => Some(value),
        _ => runtime_gmail.as_ref().and_then(gmail_scan_query),
    };

    let override_path = vault_path
        .as_deref()
        .and_then(configured_gws_path_for_vault);

    let gws_bin = resolve_gws_path(override_path.as_deref()).ok_or_else(|| {
        "cli_missing: gws CLI not found. Install via `brew install gws` or set the path in inbox settings (https://github.com/googleworkspace/gws)"
            .to_string()
    })?;

    let mut cmd = Command::new(&gws_bin);
    cmd.env("PATH", augmented_path());
    cmd.args(["gmail", "+triage", "--format", "json", "--max"])
        .arg(max.to_string());
    if let Some(q) = query.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
        cmd.args(["--query", q]);
    }

    let output = cmd
        .output()
        .map_err(|err| format!("gws_spawn_failed: {err}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.trim();
        let kind =
            if detail.contains("scope") || detail.contains("consent") || detail.contains("token") {
                "auth_required"
            } else {
                "gws_failed"
            };
        return Err(format!("{kind}: {detail}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_triage_output(&stdout).map_err(|err| format!("gws_parse_failed: {err}"))
}

#[tauri::command]
pub fn decide_gmail_item(
    app: AppHandle,
    approvals: tauri::State<'_, crate::approval::ApprovalState>,
    vault_path: Option<String>,
    message_id: String,
    decision: GmailDecision,
    approval_id: Option<String>,
) -> Result<GmailDecisionOutcome, String> {
    let kind = decision.approval_kind();
    crate::approval::require_approval(&approvals, approval_id, kind)?;
    let outcome = decide_gmail_item_now(vault_path.as_deref(), message_id, decision)?;
    emit_gmail_decision(&app, &outcome);
    Ok(outcome)
}

#[tauri::command]
pub fn decide_gmail_items(
    app: AppHandle,
    approvals: tauri::State<'_, crate::approval::ApprovalState>,
    vault_path: Option<String>,
    items: Vec<GmailDecisionRequest>,
    approval_id: Option<String>,
) -> Result<Vec<GmailDecisionOutcome>, String> {
    crate::approval::require_approval_any(
        &approvals,
        approval_id,
        &[GMAIL_ACCEPT_KIND, GMAIL_REJECT_KIND, INBOX_BULK_KIND],
    )?;
    let mut outcomes = Vec::new();
    for item in items {
        match decide_gmail_item_now(
            vault_path.as_deref(),
            item.message_id.clone(),
            item.decision.clone(),
        ) {
            Ok(outcome) => {
                emit_gmail_decision(&app, &outcome);
                outcomes.push(outcome);
            }
            Err(err) => outcomes.push(GmailDecisionOutcome {
                message_id: item.message_id,
                decision: item.decision.as_str().to_string(),
                label_name: item.decision.label_name().to_string(),
                archived: false,
                ok: false,
                error: Some(err),
            }),
        }
    }
    Ok(outcomes)
}

fn decide_gmail_item_now(
    vault_path: Option<&str>,
    message_id: String,
    decision: GmailDecision,
) -> Result<GmailDecisionOutcome, String> {
    let trimmed = message_id.trim();
    if trimmed.is_empty() {
        return Err("message_id_required".to_string());
    }
    let gws_bin = resolve_gws_for_vault(vault_path)?;
    let label = ensure_gmail_label(&gws_bin, decision.label_name())?;
    let remove = if decision == GmailDecision::Accepted {
        vec!["INBOX".to_string()]
    } else {
        Vec::new()
    };
    modify_gmail_message(&gws_bin, trimmed, vec![label.id], remove)?;
    Ok(GmailDecisionOutcome {
        message_id: trimmed.to_string(),
        decision: decision.as_str().to_string(),
        label_name: decision.label_name().to_string(),
        archived: decision == GmailDecision::Accepted,
        ok: true,
        error: None,
    })
}

fn resolve_gws_for_vault(vault_path: Option<&str>) -> Result<PathBuf, String> {
    let override_path = vault_path.and_then(configured_gws_path_for_vault);
    resolve_gws_path(override_path.as_deref()).ok_or_else(|| {
        "cli_missing: gws CLI not found. Install via `brew install gws` or set the path in inbox settings (https://github.com/googleworkspace/gws)"
            .to_string()
    })
}

fn configured_gws_path_for_vault(raw: &str) -> Option<String> {
    let vault = resolve_inside_vault(raw, ".").ok()?;
    if let Ok(Some(config)) = inbox_settings::load_runtime_config(&vault) {
        if let Some(path) = config.gmail.gws_path.filter(|path| !path.trim().is_empty()) {
            return Some(path);
        }
    }
    if let Some(path) = workspace_provider_string(
        &vault,
        &["gws", "gmail"],
        &[
            "gws_binary",
            "gwsBinary",
            "gws_path",
            "gwsPath",
            "command",
            "commandPath",
            "command_path",
        ],
    ) {
        return Some(path);
    }
    inbox_settings::load(&vault).gws_path
}

fn workspace_provider_string(
    work_path: &Path,
    providers: &[&str],
    keys: &[&str],
) -> Option<String> {
    let content = fs::read_to_string(work_path.join("workspace.config.yaml")).ok()?;
    let yaml: YamlValue = serde_yaml::from_str(&content).ok()?;
    let provider_root = yaml.get("io")?.get("providers")?;
    for provider_name in providers {
        let Some(provider) = provider_root.get(*provider_name) else {
            continue;
        };
        for key in keys {
            if let Some(value) = provider
                .get(*key)
                .and_then(YamlValue::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
            {
                return Some(value);
            }
        }
    }
    None
}

fn gmail_scan_query(config: &InboxGmailConfig) -> Option<String> {
    let explicit = config.query.trim();
    if !explicit.is_empty() {
        return Some(explicit.to_string());
    }
    let mut terms = Vec::new();
    if config.unread_only {
        terms.push("is:unread".to_string());
    }
    if config.scan_window_days > 0 {
        terms.push(format!("newer_than:{}d", config.scan_window_days));
    }
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" "))
    }
}

fn ensure_gmail_label(gws_bin: &PathBuf, name: &str) -> Result<GmailLabel, String> {
    let labels = list_gmail_labels(gws_bin)?;
    if let Some(label) = labels.into_iter().find(|label| label.name == name) {
        return Ok(label);
    }
    create_gmail_label(gws_bin, name).or_else(|_| {
        list_gmail_labels(gws_bin)?
            .into_iter()
            .find(|label| label.name == name)
            .ok_or_else(|| format!("gmail_label_missing: {name}"))
    })
}

fn list_gmail_labels(gws_bin: &PathBuf) -> Result<Vec<GmailLabel>, String> {
    let output = gws_command(gws_bin)
        .args([
            "gmail",
            "users",
            "labels",
            "list",
            "--params",
            r#"{"userId":"me"}"#,
            "--format",
            "json",
        ])
        .output()
        .map_err(|err| format!("gws_spawn_failed: {err}"))?;
    parse_gws_json_output(output, "gmail_labels_list").and_then(parse_label_list)
}

fn create_gmail_label(gws_bin: &PathBuf, name: &str) -> Result<GmailLabel, String> {
    let body = gmail_label_create_body(name);
    let output = gws_command(gws_bin)
        .args([
            "gmail",
            "users",
            "labels",
            "create",
            "--params",
            r#"{"userId":"me"}"#,
            "--format",
            "json",
            "--json",
            &body,
        ])
        .output()
        .map_err(|err| format!("gws_spawn_failed: {err}"))?;
    let raw = parse_gws_json_output(output, "gmail_labels_create")?;
    serde_json::from_str(&raw).map_err(|err| format!("gws_parse_failed: {err}"))
}

fn modify_gmail_message(
    gws_bin: &PathBuf,
    message_id: &str,
    add_label_ids: Vec<String>,
    remove_label_ids: Vec<String>,
) -> Result<(), String> {
    let params = json!({"userId": "me", "id": message_id}).to_string();
    let body = gmail_modify_body(add_label_ids, remove_label_ids);
    let output = gws_command(gws_bin)
        .args([
            "gmail", "users", "messages", "modify", "--params", &params, "--format", "json",
            "--json", &body,
        ])
        .output()
        .map_err(|err| format!("gws_spawn_failed: {err}"))?;
    parse_gws_json_output(output, "gmail_messages_modify").map(|_| ())
}

fn gws_command(gws_bin: &PathBuf) -> Command {
    let mut cmd = Command::new(gws_bin);
    cmd.env("PATH", augmented_path());
    cmd
}

fn parse_gws_json_output(output: std::process::Output, operation: &str) -> Result<String, String> {
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.trim();
        let kind =
            if detail.contains("scope") || detail.contains("consent") || detail.contains("token") {
                "auth_required"
            } else {
                operation
            };
        return Err(format!("{kind}: {detail}"));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn parse_label_list(raw: String) -> Result<Vec<GmailLabel>, String> {
    let response: LabelListResponse =
        serde_json::from_str(&raw).map_err(|err| format!("gws_parse_failed: {err}"))?;
    Ok(response.labels)
}

fn gmail_label_create_body(name: &str) -> String {
    json!({
        "name": name,
        "labelListVisibility": "labelShow",
        "messageListVisibility": "show"
    })
    .to_string()
}

fn gmail_modify_body(add_label_ids: Vec<String>, remove_label_ids: Vec<String>) -> String {
    json!({
        "addLabelIds": add_label_ids,
        "removeLabelIds": remove_label_ids
    })
    .to_string()
}

fn emit_gmail_decision(app: &AppHandle, outcome: &GmailDecisionOutcome) {
    let _ = app.emit("gmail://decided", outcome);
}

fn parse_triage_output(raw: &str) -> Result<Vec<GmailMessage>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("empty stdout".to_string());
    }
    let response: TriageResponse = serde_json::from_str(trimmed).map_err(|err| err.to_string())?;
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

impl GmailDecision {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::Rejected => "rejected",
        }
    }

    fn approval_kind(&self) -> &'static str {
        match self {
            Self::Accepted => GMAIL_ACCEPT_KIND,
            Self::Rejected => GMAIL_REJECT_KIND,
        }
    }

    fn label_name(&self) -> &'static str {
        match self {
            Self::Accepted => ACCEPTED_LABEL,
            Self::Rejected => REJECTED_LABEL,
        }
    }
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
    fn gmail_scan_query_uses_explicit_query() {
        let config = InboxGmailConfig {
            query: "label:work newer_than:7d".to_string(),
            ..InboxGmailConfig::default()
        };

        assert_eq!(
            gmail_scan_query(&config),
            Some("label:work newer_than:7d".to_string())
        );
    }

    #[test]
    fn gmail_scan_query_builds_unread_window() {
        let config = InboxGmailConfig {
            scan_window_days: 30,
            ..InboxGmailConfig::default()
        };

        assert_eq!(
            gmail_scan_query(&config),
            Some("is:unread newer_than:30d".to_string())
        );
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

    #[test]
    fn reads_gws_binary_from_workspace_provider_config() {
        let tmp = tempfile::TempDir::new().unwrap();
        std::fs::write(
            tmp.path().join("workspace.config.yaml"),
            "io:\n  providers:\n    gws:\n      gws_binary: /opt/homebrew/bin/gws\n",
        )
        .unwrap();

        let resolved =
            workspace_provider_string(tmp.path(), &["gws", "gmail"], &["gws_binary", "command"]);

        assert_eq!(resolved.as_deref(), Some("/opt/homebrew/bin/gws"));
    }

    #[test]
    fn parses_label_list_payload() {
        let raw = r#"{"labels":[{"id":"Label_1","name":"anchor-accepted"},{"id":"INBOX","name":"INBOX"}]}"#;
        let labels = parse_label_list(raw.to_string()).unwrap();
        assert_eq!(
            labels[0],
            GmailLabel {
                id: "Label_1".to_string(),
                name: "anchor-accepted".to_string(),
            }
        );
    }

    #[test]
    fn label_create_body_uses_anchor_visible_label() {
        let body = gmail_label_create_body("anchor-rejected");
        let value: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(value["name"], "anchor-rejected");
        assert_eq!(value["labelListVisibility"], "labelShow");
        assert_eq!(value["messageListVisibility"], "show");
    }

    #[test]
    fn accepted_modify_body_adds_label_and_archives() {
        let body = gmail_modify_body(vec!["Label_1".to_string()], vec!["INBOX".to_string()]);
        let value: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(value["addLabelIds"][0], "Label_1");
        assert_eq!(value["removeLabelIds"][0], "INBOX");
    }

    #[test]
    fn rejected_modify_body_does_not_archive() {
        let body = gmail_modify_body(vec!["Label_2".to_string()], Vec::new());
        let value: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(value["addLabelIds"][0], "Label_2");
        assert_eq!(value["removeLabelIds"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn decision_metadata_matches_policy() {
        assert_eq!(GmailDecision::Accepted.label_name(), "anchor-accepted");
        assert_eq!(GmailDecision::Accepted.approval_kind(), "gmail.accept");
        assert_eq!(GmailDecision::Rejected.label_name(), "anchor-rejected");
        assert_eq!(GmailDecision::Rejected.approval_kind(), "gmail.reject");
    }
}
