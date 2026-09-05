// Phase 2 step 5 (revised): Gmail surface via the user's existing
// Google Workspace CLI (`gws`). Replaces the planned async-imap path —
// no app password, no TLS, no IMAP state machine. Maru shells out to
// `gws gmail +triage --format json` and parses the JSON envelope.
//
// `gws` writes "Using keyring backend: keyring" to stderr; stdout is
// pure JSON. The parser therefore never sees the keyring line.
//
// macOS Tauri apps inherit a sparse PATH that does not include
// /opt/homebrew/bin or ~/go/bin where users typically install `gws`.
// `resolve_gws_path` augments PATH with the standard install
// locations and falls back to a user-provided absolute path stored in
// `<vault>/.maru/inbox.json`.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use crate::win_process::NoWindow;

use serde::{Deserialize, Serialize};
use serde_json::json;
use serde_yaml::Value as YamlValue;
use tauri::{AppHandle, Emitter, Manager};

use crate::cli_path::{augmented_path, is_executable, resolve_program};
use crate::command_output::{run_command_with_timeout, BoundedOutput, CommandTermination};
use crate::inbox_drop::{
    auth_status, stage_message_outcome_with_parent, ProviderAuthStatus, StageOutcome,
};
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
const GMAIL_STAGE_KIND: &str = "gmail.stage";
const INBOX_BULK_KIND: &str = "inbox.bulk";
const ACCEPTED_LABEL: &str = "maru-accepted";
const REJECTED_LABEL: &str = "maru-rejected";
#[cfg(not(test))]
const PROVIDER_READINESS_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(test)]
const PROVIDER_READINESS_TIMEOUT: Duration = Duration::from_millis(300);

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
        .no_window()
        .output()
        .map_err(|err| format!("gws_spawn_failed: {err}"))?;

    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let kind = if classify_gws_auth_state(&detail) == "auth_required" {
            "auth_required"
        } else {
            "gws_failed"
        };
        return Err(format!("{kind}: {detail}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_triage_output(&stdout).map_err(|err| format!("gws_parse_failed: {err}"))
}

#[allow(dead_code)] // Preserved synchronous API for Rust callers.
pub fn stage_gmail_items(
    approvals: tauri::State<'_, crate::approval::ApprovalState>,
    work_path: String,
    messages: Vec<GmailMessage>,
    approval_id: Option<String>,
) -> Result<Vec<StageOutcome>, String> {
    stage_gmail_items_blocking(&approvals, work_path, messages, approval_id)
}

fn stage_gmail_items_blocking(
    approvals: &crate::approval::ApprovalState,
    work_path: String,
    messages: Vec<GmailMessage>,
    approval_id: Option<String>,
) -> Result<Vec<StageOutcome>, String> {
    crate::approval::require_approval_any(
        approvals,
        approval_id,
        &[GMAIL_STAGE_KIND, INBOX_BULK_KIND],
    )?;
    let work = resolve_inside_vault(&work_path, ".")?;
    let parent = crate::atomic_file::PathTransactionParent::capture(&work)?;
    Ok(messages
        .into_iter()
        .map(|message| {
            stage_message_outcome_with_parent(&work, "gws", "gws", &message.id, &message, &parent)
        })
        .collect())
}

#[tauri::command]
pub async fn check_gws_auth(vault_path: Option<String>) -> Result<ProviderAuthStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(test)]
        crate::atomic_file::PathTransactionLease::test_stage(
            &[PathBuf::from(vault_path.as_deref().unwrap_or("/"))],
            "worker:check_gws_auth",
        );
        check_gws_auth_now(vault_path)
    })
    .await
    .map_err(|err| format!("gws_probe_task_failed: {err}"))?
}

fn check_gws_auth_now(vault_path: Option<String>) -> Result<ProviderAuthStatus, String> {
    let override_path = vault_path
        .as_deref()
        .and_then(configured_gws_path_for_vault);
    let Some(gws_bin) = resolve_gws_path(override_path.as_deref()) else {
        return Ok(auth_status(
            "gws",
            "cli_missing",
            Some("gws CLI not found".to_string()),
            None,
            None,
        ));
    };
    let mut cmd = gws_command(&gws_bin);
    cmd.args([
        "gmail",
        "users",
        "labels",
        "list",
        "--params",
        r#"{"userId":"me"}"#,
        "--format",
        "json",
    ]);
    let output = run_command_with_timeout(&mut cmd, PROVIDER_READINESS_TIMEOUT, |_, _| false)
        .map_err(|err| format!("gws_spawn_failed: {err}"))?;
    let detail = output.diagnostic_tail(4096).unwrap_or_default();
    if output.termination == CommandTermination::TimedOut {
        if classify_gws_auth_state(&detail) == "auth_required" {
            return Ok(auth_status(
                "gws",
                "auth_required",
                Some("Google Workspace authentication is required.".to_string()),
                Some(gws_bin),
                None,
            ));
        }
        return Ok(auth_status(
            "gws",
            "error",
            Some(provider_timeout_detail(
                "gws_timeout: readiness probe exceeded 10 seconds",
                &output,
            )),
            Some(gws_bin),
            None,
        ));
    }
    if output.status.success() {
        return Ok(auth_status("gws", "ok", None, Some(gws_bin), None));
    }
    let state = classify_gws_auth_state(&detail);
    Ok(auth_status(
        "gws",
        state,
        Some(if state == "auth_required" {
            "Google Workspace authentication is required.".to_string()
        } else {
            provider_failure_detail(&output, "gws command failed without a safe diagnostic")
        }),
        Some(gws_bin),
        None,
    ))
}

fn provider_timeout_detail(prefix: &str, output: &BoundedOutput) -> String {
    match output.safe_diagnostic_tail(1024) {
        Some(detail) if !detail.is_empty() => format!("{prefix}. Diagnostic tail:\n{detail}"),
        _ => prefix.to_string(),
    }
}

fn provider_failure_detail(output: &BoundedOutput, fallback: &str) -> String {
    output
        .safe_diagnostic_tail(4096)
        .filter(|detail| !detail.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

#[allow(dead_code)] // Preserved synchronous API for Rust callers.
pub fn decide_gmail_item<R: tauri::Runtime>(
    app: AppHandle<R>,
    approvals: tauri::State<'_, crate::approval::ApprovalState>,
    vault_path: Option<String>,
    message_id: String,
    decision: GmailDecision,
    approval_id: Option<String>,
) -> Result<GmailDecisionOutcome, String> {
    decide_gmail_item_blocking(
        app,
        &approvals,
        vault_path,
        message_id,
        decision,
        approval_id,
    )
}

fn decide_gmail_item_blocking<R: tauri::Runtime>(
    app: AppHandle<R>,
    approvals: &crate::approval::ApprovalState,
    vault_path: Option<String>,
    message_id: String,
    decision: GmailDecision,
    approval_id: Option<String>,
) -> Result<GmailDecisionOutcome, String> {
    let kind = decision.approval_kind();
    crate::approval::require_approval(approvals, approval_id, kind)?;
    let outcome = decide_gmail_item_now(vault_path.as_deref(), message_id, decision)?;
    emit_gmail_decision(&app, &outcome);
    Ok(outcome)
}

#[allow(dead_code)] // Preserved synchronous API for Rust callers.
pub fn decide_gmail_items<R: tauri::Runtime>(
    app: AppHandle<R>,
    approvals: tauri::State<'_, crate::approval::ApprovalState>,
    vault_path: Option<String>,
    items: Vec<GmailDecisionRequest>,
    approval_id: Option<String>,
) -> Result<Vec<GmailDecisionOutcome>, String> {
    decide_gmail_items_blocking(app, &approvals, vault_path, items, approval_id)
}

fn decide_gmail_items_blocking<R: tauri::Runtime>(
    app: AppHandle<R>,
    approvals: &crate::approval::ApprovalState,
    vault_path: Option<String>,
    items: Vec<GmailDecisionRequest>,
    approval_id: Option<String>,
) -> Result<Vec<GmailDecisionOutcome>, String> {
    crate::approval::require_approval_any(
        approvals,
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

pub fn classify_gws_auth_state(detail: &str) -> &'static str {
    let lower = detail.to_lowercase();
    if lower.contains("scope")
        || lower.contains("consent")
        || lower.contains("token")
        || lower.contains("auth")
        || lower.contains("login")
        || lower.contains("keychain")
        || lower.contains("keyring")
    {
        "auth_required"
    } else {
        "error"
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
        .no_window()
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
        .no_window()
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
        .no_window()
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

fn emit_gmail_decision<R: tauri::Runtime>(app: &AppHandle<R>, outcome: &GmailDecisionOutcome) {
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

// Each worker owns all request values and an AppHandle. Real managed approval
// state is borrowed only after dispatch, never across await. Gmail decisions
// have provider effects only; no filesystem/domain guard spans the CLI calls.
pub mod ipc {
    use super::*;

    #[tauri::command]
    pub async fn fetch_gmail_unread(
        vault_path: Option<String>,
        max: Option<u32>,
        query: Option<String>,
    ) -> Result<Vec<GmailMessage>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            crate::atomic_file::PathTransactionLease::test_stage(
                &[PathBuf::from(vault_path.as_deref().unwrap_or("/"))],
                "worker:fetch_gmail_unread",
            );
            super::fetch_gmail_unread(vault_path, max, query)
        })
        .await
        .map_err(|err| format!("fetch_gmail_unread_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn stage_gmail_items<R: tauri::Runtime>(
        app: AppHandle<R>,
        work_path: String,
        messages: Vec<GmailMessage>,
        approval_id: Option<String>,
    ) -> Result<Vec<StageOutcome>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            crate::atomic_file::PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:stage_gmail_items",
            );
            stage_gmail_items_blocking(
                &app.state::<crate::approval::ApprovalState>(),
                work_path,
                messages,
                approval_id,
            )
        })
        .await
        .map_err(|err| format!("stage_gmail_items_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn decide_gmail_item<R: tauri::Runtime>(
        app: AppHandle<R>,
        vault_path: Option<String>,
        message_id: String,
        decision: GmailDecision,
        approval_id: Option<String>,
    ) -> Result<GmailDecisionOutcome, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            crate::atomic_file::PathTransactionLease::test_stage(
                &[PathBuf::from(vault_path.as_deref().unwrap_or("/"))],
                "worker:decide_gmail_item",
            );
            let approvals = app.state::<crate::approval::ApprovalState>();
            decide_gmail_item_blocking(
                app.clone(),
                &approvals,
                vault_path,
                message_id,
                decision,
                approval_id,
            )
        })
        .await
        .map_err(|err| format!("decide_gmail_item_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn decide_gmail_items<R: tauri::Runtime>(
        app: AppHandle<R>,
        vault_path: Option<String>,
        items: Vec<GmailDecisionRequest>,
        approval_id: Option<String>,
    ) -> Result<Vec<GmailDecisionOutcome>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            crate::atomic_file::PathTransactionLease::test_stage(
                &[PathBuf::from(vault_path.as_deref().unwrap_or("/"))],
                "worker:decide_gmail_items",
            );
            let approvals = app.state::<crate::approval::ApprovalState>();
            decide_gmail_items_blocking(app.clone(), &approvals, vault_path, items, approval_id)
        })
        .await
        .map_err(|err| format!("decide_gmail_items_task_failed: {err}"))?
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
        let raw =
            r#"{"labels":[{"id":"Label_1","name":"maru-accepted"},{"id":"INBOX","name":"INBOX"}]}"#;
        let labels = parse_label_list(raw.to_string()).unwrap();
        assert_eq!(
            labels[0],
            GmailLabel {
                id: "Label_1".to_string(),
                name: "maru-accepted".to_string(),
            }
        );
    }

    #[test]
    fn label_create_body_uses_maru_visible_label() {
        let body = gmail_label_create_body("maru-rejected");
        let value: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(value["name"], "maru-rejected");
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
        assert_eq!(GmailDecision::Accepted.label_name(), "maru-accepted");
        assert_eq!(GmailDecision::Accepted.approval_kind(), "gmail.accept");
        assert_eq!(GmailDecision::Rejected.label_name(), "maru-rejected");
        assert_eq!(GmailDecision::Rejected.approval_kind(), "gmail.reject");
    }

    #[test]
    fn classifies_gws_auth_errors() {
        assert_eq!(classify_gws_auth_state("token expired"), "auth_required");
        assert_eq!(
            classify_gws_auth_state("No keychain is available"),
            "auth_required"
        );
        assert_eq!(classify_gws_auth_state("network down"), "error");
    }

    #[cfg(unix)]
    #[test]
    fn non_timeout_failure_detail_suppresses_sensitive_output() {
        let mut command = Command::new("sh");
        command.args([
            "-c",
            "printf 'password=GWS-SECRET network unavailable' >&2; exit 1",
        ]);
        let output =
            run_command_with_timeout(&mut command, Duration::from_secs(1), |_, _| false).unwrap();

        let detail =
            provider_failure_detail(&output, "gws command failed without a safe diagnostic");

        assert_eq!(detail, "gws command failed without a safe diagnostic");
        assert!(!detail.contains("GWS-SECRET"));
    }

    #[cfg(unix)]
    #[test]
    fn non_timeout_failure_detail_suppresses_truncated_secret_continuation() {
        let mut command = Command::new("sh");
        command.args([
            "-c",
            "printf 'clientSecret=' >&2; i=0; while [ \"$i\" -lt 70000 ]; do printf S >&2; i=$((i + 1)); done; exit 1",
        ]);
        let output =
            run_command_with_timeout(&mut command, Duration::from_secs(2), |_, _| false).unwrap();

        assert!(output.stderr_truncated);
        assert!(!String::from_utf8_lossy(&output.stderr)
            .to_lowercase()
            .contains("clientsecret"));
        let detail =
            provider_failure_detail(&output, "gws command failed without a safe diagnostic");

        assert_eq!(detail, "gws command failed without a safe diagnostic");
        assert!(!detail.contains(&"S".repeat(128)));
    }
}

#[cfg(all(test, unix))]
mod phase08_14 {
    use super::*;
    use crate::atomic_file::phase08_06::{boundary, run, Held, Home};
    use crate::atomic_file::PathTransactionTestHook;
    use crate::scratchpad::phase08_08::registry;
    use std::future::Future;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::mpsc;
    type TestApp = AppHandle<tauri::test::MockRuntime>;

    fn text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }
    fn app() -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        app.manage(crate::approval::ApprovalState::default());
        app
    }
    fn approval(app: &TestApp, kind: &str) -> Option<String> {
        let request = crate::approval::prepare_approval(
            app.state(),
            kind.into(),
            "Synthetic Gmail fixture".into(),
            None,
            None,
        )
        .unwrap();
        crate::approval::record_approval(
            app.state(),
            request.id.clone(),
            crate::approval::ApprovalDecision::Approved,
            None,
        )
        .unwrap();
        Some(request.id)
    }
    fn fixture(home: &Home) -> tempfile::TempDir {
        let tmp = tempfile::tempdir_in(home.root.path()).unwrap();
        let bin = tmp.path().join("fake-gws");
        fs::write(&bin, r#"#!/bin/sh
printf '%s\n' "$*" >> "$0.calls"
case "$*" in
  *+triage*) printf '%s\n' '{"messages":[{"id":"fixture-1","from":"synthetic@example.invalid","subject":"Synthetic envelope","date":"2026-01-01"}]}' ;;
  *'labels list'*) printf '%s\n' '{"labels":[{"id":"Label_A","name":"maru-accepted"},{"id":"Label_R","name":"maru-rejected"}]}' ;;
  *'messages modify'*) printf '%s\n' '{"id":"fixture-1"}' ;;
  *) printf '%s\n' 'unexpected synthetic arguments' >&2; exit 7 ;;
esac
"#).unwrap();
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(tmp.path().join("workspace.config.yaml"), format!("io:\n  providers:\n    gws:\n      gws_binary: {}\ninbox:\n  root: inbox\n  channels:\n    gws:\n      provider: gws\n      kind: bundle\n      dedupe: provider-id\n      drop_paths: [drop/gws]\n", text(&bin))).unwrap();
        fs::create_dir_all(tmp.path().join("inbox/drop/gws")).unwrap();
        assert_eq!(resolve_gws_for_vault(Some(&text(tmp.path()))).unwrap(), bin);
        tmp
    }
    fn message() -> GmailMessage {
        GmailMessage {
            id: "fixture-1".into(),
            from: "synthetic@example.invalid".into(),
            subject: "Synthetic envelope".into(),
            date: "2026-01-01".into(),
        }
    }
    fn start<F: Future + Send + 'static>(future: F) -> mpsc::Receiver<F::Output>
    where
        F::Output: Send + 'static,
    {
        let (tx, rx) = mpsc::channel();
        tauri::async_runtime::spawn(async move {
            let _ = tx.send(future.await);
        });
        rx
    }
    fn done<T>(rx: mpsc::Receiver<T>) -> T {
        rx.recv_timeout(Duration::from_secs(10))
            .expect("Gmail fixture completion")
    }
    fn stage(
        app: &TestApp,
        root: &Path,
    ) -> impl Future<Output = Result<Vec<StageOutcome>, String>> + Send + 'static {
        ipc::stage_gmail_items(
            app.clone(),
            text(root),
            vec![message()],
            approval(app, GMAIL_STAGE_KIND),
        )
    }

    #[test]
    fn phase08_14_gmail_each_wrapper_nonempty_results_and_legacy_rejections() {
        let home = Home::new();
        let tmp = fixture(&home);
        let app = app();
        let w = text(tmp.path());
        use tauri::Listener;
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = events.clone();
        let _listener = app.listen("gmail://decided", move |event| {
            seen.lock().unwrap().push(event.payload().to_string());
        });
        let messages = run(ipc::fetch_gmail_unread(
            Some(w.clone()),
            Some(3),
            Some("is:unread".into()),
        ))
        .unwrap();
        assert_eq!(messages, vec![message()]);
        let status = run(check_gws_auth(Some(w.clone()))).unwrap();
        assert_eq!(status.state, "ok");
        assert_eq!(status.cli_path, Some(text(&tmp.path().join("fake-gws"))));
        let staged = run(stage(app.handle(), tmp.path())).unwrap();
        assert!(staged[0].ok);
        let payload: serde_json::Value =
            serde_json::from_slice(&fs::read(staged[0].target_path.as_ref().unwrap()).unwrap())
                .unwrap();
        assert_eq!(payload["message"]["subject"], "Synthetic envelope");
        let accepted = run(ipc::decide_gmail_item(
            app.handle().clone(),
            Some(w.clone()),
            "fixture-1".into(),
            GmailDecision::Accepted,
            approval(app.handle(), GMAIL_ACCEPT_KIND),
        ))
        .unwrap();
        assert!(accepted.ok && accepted.archived);
        let rows = run(ipc::decide_gmail_items(
            app.handle().clone(),
            Some(w.clone()),
            vec![
                GmailDecisionRequest {
                    message_id: "".into(),
                    decision: GmailDecision::Accepted,
                },
                GmailDecisionRequest {
                    message_id: "fixture-1".into(),
                    decision: GmailDecision::Rejected,
                },
            ],
            approval(app.handle(), INBOX_BULK_KIND),
        ))
        .unwrap();
        assert!(!rows[0].ok);
        assert_eq!(rows[0].error.as_deref(), Some("message_id_required"));
        assert!(rows[1].ok && !rows[1].archived);
        assert_eq!(events.lock().unwrap().len(), 2);
        let call_log = tmp.path().join("fake-gws.calls");
        let calls_before_denials = fs::read(&call_log).unwrap();
        assert_eq!(
            run(ipc::stage_gmail_items(
                app.handle().clone(),
                w.clone(),
                vec![message()],
                None
            ))
            .unwrap_err(),
            "approval_required: gmail.stage"
        );
        assert_eq!(
            run(ipc::decide_gmail_item(
                app.handle().clone(),
                Some(w.clone()),
                "fixture-1".into(),
                GmailDecision::Accepted,
                None
            ))
            .unwrap_err(),
            "approval_required: gmail.accept"
        );
        assert_eq!(
            run(ipc::decide_gmail_items(
                app.handle().clone(),
                Some(w.clone()),
                vec![],
                None
            ))
            .unwrap_err(),
            "approval_required: gmail.accept"
        );
        assert_eq!(
            run(ipc::decide_gmail_item(
                app.handle().clone(),
                Some(w),
                "".into(),
                GmailDecision::Rejected,
                approval(app.handle(), GMAIL_REJECT_KIND)
            ))
            .unwrap_err(),
            "message_id_required"
        );
        assert_eq!(fs::read(call_log).unwrap(), calls_before_denials);
        assert_eq!(events.lock().unwrap().len(), 2);
    }

    #[test]
    fn phase08_14_gmail_each_new_wrapper_yields_same_task_and_maps_worker_unwind() {
        let home = Home::new();
        let tmp = fixture(&home);
        let app = app();
        let root = tmp.path();
        let w = text(root);
        boundary(
            root.into(),
            "fetch_gmail_unread",
            ipc::fetch_gmail_unread(Some(w.clone()), None, None),
        );
        boundary(root.into(), "stage_gmail_items", stage(app.handle(), root));
        boundary(
            root.into(),
            "decide_gmail_item",
            ipc::decide_gmail_item(
                app.handle().clone(),
                Some(w.clone()),
                "fixture-1".into(),
                GmailDecision::Accepted,
                approval(app.handle(), GMAIL_ACCEPT_KIND),
            ),
        );
        boundary(
            root.into(),
            "decide_gmail_items",
            ipc::decide_gmail_items(
                app.handle().clone(),
                Some(w),
                vec![GmailDecisionRequest {
                    message_id: "fixture-1".into(),
                    decision: GmailDecision::Rejected,
                }],
                approval(app.handle(), INBOX_BULK_KIND),
            ),
        );
    }

    #[test]
    fn phase08_14_gmail_auth_existing_worker_yields_and_preserves_probe_error() {
        let home = Home::new();
        let tmp = fixture(&home);
        let w = text(tmp.path());
        let (tx, mut entered) = tauri::async_runtime::channel(1);
        let (release, rx) = mpsc::channel();
        let rx = std::sync::Mutex::new(rx);
        let _hook =
            PathTransactionTestHook::new(tmp.path().into(), "worker:check_gws_auth", move || {
                tx.blocking_send(std::thread::current().id()).unwrap();
                rx.lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(5))
                    .unwrap();
                panic!("synthetic Gmail probe panic");
            });
        run(async move {
            let caller = std::thread::current().id();
            let mut future = Box::pin(check_gws_auth(Some(w)));
            assert!(
                std::future::poll_fn(|cx| std::task::Poll::Ready(future.as_mut().poll(cx)))
                    .await
                    .is_pending()
            );
            assert_ne!(caller, entered.recv().await.unwrap());
            let mut yielded = false;
            std::future::poll_fn(|cx| {
                if yielded {
                    std::task::Poll::Ready(())
                } else {
                    yielded = true;
                    cx.waker().wake_by_ref();
                    std::task::Poll::Pending
                }
            })
            .await;
            release.send(()).unwrap();
            assert!(future
                .await
                .unwrap_err()
                .starts_with("gws_probe_task_failed:"));
        });
    }

    #[test]
    fn phase08_14_gmail_stage_same_target_contention_policy_and_unwind_release() {
        let home = Home::new();
        let tmp = fixture(&home);
        let app = app();
        let root = tmp.path();
        let key = root.join("inbox/drop/gws");
        let held = Held::new(key.clone(), "admitted");
        let first = start(stage(app.handle(), root));
        held.wait();
        let waiting = Held::new(key.clone(), "before-admission");
        let second = start(stage(app.handle(), root));
        waiting.wait();
        waiting.release();
        assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
        held.release();
        assert!(done(first).unwrap()[0].ok);
        let second = done(second).unwrap();
        // Preserve the existing identical-message duplicate contract: admitted
        // publication may replace the same timestamp name with identical bytes.
        if !second[0].ok {
            assert!(second[0].error.is_some());
        }
        assert!(fs::read_dir(&key).unwrap().count() >= 1);
        drop(held);
        drop(waiting);
        registry(root, "direct");
        let held = Held::new(key.clone(), "admitted");
        let denied = start(stage(app.handle(), root));
        held.wait();
        registry(root, "readOnly");
        held.release();
        let denied = done(denied).unwrap();
        assert!(!denied[0].ok);
        assert!(denied[0]
            .error
            .as_deref()
            .unwrap()
            .contains("Workspace writes are blocked"));
        drop(held);
        registry(root, "direct");
        let hook = PathTransactionTestHook::new(key.clone(), "admitted", || {
            panic!("synthetic Gmail stage unwind")
        });
        assert!(run(stage(app.handle(), root))
            .unwrap_err()
            .starts_with("stage_gmail_items_task_failed:"));
        drop(hook);
        let mut distinct = message();
        distinct.id = "after-unwind".into();
        assert!(
            run(ipc::stage_gmail_items(
                app.handle().clone(),
                text(root),
                vec![distinct],
                approval(app.handle(), GMAIL_STAGE_KIND)
            ))
            .unwrap()[0]
                .ok
        );
    }

    #[test]
    fn phase08_14_gmail_stage_real_files_parent_rename_trash_both_orders_aliases() {
        let home = Home::new();
        let app = app();
        for parent_first in [false, true] {
            for trash in [false, true] {
                for alias in [false, true] {
                    let tmp = fixture(&home);
                    let root = tmp.path().to_path_buf();
                    let parent = root.parent().unwrap();
                    let moved = parent.join(format!(
                        "moved-{}",
                        root.file_name().unwrap().to_string_lossy()
                    ));
                    let mut parent_w = text(parent);
                    if alias {
                        let link = parent.join(format!(
                            "alias-{}",
                            root.file_name().unwrap().to_string_lossy()
                        ));
                        std::os::unix::fs::symlink(parent, &link).unwrap();
                        parent_w = text(&link);
                    }
                    let _trash = crate::workspace_files::phase08_06::TrashFixture::new(
                        root.clone(),
                        moved.clone(),
                    );
                    let source = text(&root);
                    let name = moved.file_name().unwrap().to_string_lossy().into_owned();
                    let parent_future = async move {
                        if trash {
                            crate::workspace_files::ipc::trash_workspace_entries(
                                parent_w,
                                vec![source],
                            )
                            .await
                            .map(|_| ())
                        } else {
                            crate::workspace_files::ipc::rename_workspace_entry(
                                parent_w, source, name,
                            )
                            .await
                            .map(|_| ())
                        }
                    };
                    let key = root.join("inbox/drop/gws");
                    if parent_first {
                        let held = Held::new(root.clone(), "admitted");
                        let first = start(parent_future);
                        held.wait();
                        let waiting = Held::new(key.clone(), "before-admission");
                        let second = start(stage(app.handle(), &root));
                        waiting.wait();
                        waiting.release();
                        assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
                        held.release();
                        done(first).unwrap();
                        let rows = done(second).unwrap();
                        assert!(!rows[0].ok);
                        assert_eq!(
                            fs::read_dir(moved.join("inbox/drop/gws")).unwrap().count(),
                            0
                        );
                    } else {
                        let held = Held::new(key.clone(), "admitted");
                        let first = start(stage(app.handle(), &root));
                        held.wait();
                        let waiting = Held::new(root.clone(), "before-admission");
                        let second = start(parent_future);
                        waiting.wait();
                        waiting.release();
                        assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
                        held.release();
                        assert!(done(first).unwrap()[0].ok);
                        done(second).unwrap();
                        assert_eq!(
                            fs::read_dir(moved.join("inbox/drop/gws")).unwrap().count(),
                            1
                        );
                    }
                    assert!(!root.exists(), "Gmail stage recreated moved parent");
                }
            }
        }
    }

    #[test]
    fn phase08_14_gmail_stage_policy_aliases_and_config_change_fail_closed() {
        let home = Home::new();
        let tmp = fixture(&home);
        let app = app();
        let root = tmp.path();
        let alias = home.root.path().join("gmail-alias");
        std::os::unix::fs::symlink(root, &alias).unwrap();
        for reverse in [false, true] {
            for policy in ["readOnly", "delegated"] {
                let (registered, caller) = if reverse {
                    (alias.as_path(), root)
                } else {
                    (root, alias.as_path())
                };
                registry(registered, policy);
                assert!(!run(stage(app.handle(), caller)).unwrap()[0].ok);
            }
        }
        registry(&alias, "direct");
        assert!(run(stage(app.handle(), &alias)).unwrap()[0].ok);
        let key = root.join("inbox/drop/gws");
        let held = Held::new(key, "admitted");
        let pending = start(stage(app.handle(), root));
        held.wait();
        let config = root.join("workspace.config.yaml");
        fs::write(
            &config,
            fs::read_to_string(&config)
                .unwrap()
                .replace("drop/gws", "drop/changed"),
        )
        .unwrap();
        held.release();
        let rows = done(pending).unwrap();
        assert!(!rows[0].ok);
        assert!(!root.join("inbox/drop/changed").exists());
    }

    #[test]
    fn phase08_14_gmail_stage_batch_retains_success_and_rejects_replaced_parent() {
        let home = Home::new();
        let tmp = fixture(&home);
        let app = app();
        let root = tmp.path().to_path_buf();
        let key = root.join("inbox/drop/gws");
        let (tx, entered) = mpsc::channel();
        let (release, rx) = mpsc::channel();
        let rx = std::sync::Mutex::new(rx);
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let _hook = PathTransactionTestHook::new(key.clone(), "before-admission", move || {
            if calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 1 {
                tx.send(()).unwrap();
                rx.lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(5))
                    .unwrap();
            }
        });
        let mut second = message();
        second.id = "fixture-2".into();
        let result = start(ipc::stage_gmail_items(
            app.handle().clone(),
            text(&root),
            vec![message(), second],
            approval(app.handle(), GMAIL_STAGE_KIND),
        ));
        entered.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(fs::read_dir(&key).unwrap().count(), 1);
        let moved = root.parent().unwrap().join("gmail-original-parent");
        run(crate::workspace_files::ipc::rename_workspace_entry(
            text(root.parent().unwrap()),
            text(&root),
            "gmail-original-parent".into(),
        ))
        .unwrap();
        fs::create_dir(&root).unwrap();
        release.send(()).unwrap();
        let rows = done(result).unwrap();
        assert!(rows[0].ok);
        assert!(!rows[1].ok);
        assert!(rows[1].error.is_some());
        assert_eq!(
            fs::read_dir(moved.join("inbox/drop/gws")).unwrap().count(),
            1
        );
        assert!(!root.join("inbox").exists());
    }
}
