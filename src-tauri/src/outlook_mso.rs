use std::collections::BTreeSet;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::json;
use serde_yaml::Value as YamlValue;
use tauri::{AppHandle, Emitter};

use crate::cli_path::{augmented_path, resolve_program};
use crate::command_output::{
    diagnostic_contains_sensitive_value, run_command_with_timeout,
    run_command_with_timeout_and_limits, BoundedOutput, CommandTermination, OutputLimits,
};
use crate::inbox_drop::{auth_status, stage_message_outcome, ProviderAuthStatus, StageOutcome};
use crate::vault::resolve_inside_vault;

const OUTLOOK_ACCEPT_KIND: &str = "outlook.accept";
const OUTLOOK_REJECT_KIND: &str = "outlook.reject";
const OUTLOOK_STAGE_KIND: &str = "outlook.stage";
const COMMS_BULK_KIND: &str = "comms.bulk";
const INBOX_BULK_KIND: &str = "inbox.bulk";
const ACCEPTED_CATEGORY: &str = "maru-accepted";
const REJECTED_CATEGORY: &str = "maru-rejected";
const OUTLOOK_SELECT_FIELDS: &str =
    "id,from,sender,subject,receivedDateTime,sentDateTime,bodyPreview,webLink,categories,isRead";
const M365_AUTH_REQUIRED_DETAIL: &str =
    "Microsoft 365 authentication is required. Sign in again from Messages or Settings.";
const M365_WORKSPACE_MISMATCH_DETAIL: &str =
    "Microsoft 365 sign-in does not match this workspace. Sign in again from Messages or Settings.";
const M365_DISABLED_DETAIL: &str = "Microsoft 365 is disabled for this workspace.";
const M365_JSON_STDOUT_LIMIT: usize = 2 * 1024 * 1024;
const M365_JSON_STDERR_LIMIT: usize = 64 * 1024;
#[cfg(not(test))]
const PROVIDER_READINESS_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(test)]
const PROVIDER_READINESS_TIMEOUT: Duration = Duration::from_millis(300);
#[cfg(not(test))]
const OUTLOOK_IO_TIMEOUT: Duration = Duration::from_secs(15);
#[cfg(test)]
const OUTLOOK_IO_TIMEOUT: Duration = Duration::from_secs(10);
const OUTLOOK_MAX_PAGES: usize = 10;

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

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct WorkspaceMsoConfig {
    enabled: Option<bool>,
    command: Option<String>,
    app_id: Option<String>,
    tenant_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct M365StatusIdentity {
    connected_as: Option<String>,
    app_id: Option<String>,
    app_tenant: Option<String>,
}

#[derive(Debug)]
struct ResolvedMsoContext {
    config: WorkspaceMsoConfig,
    m365_bin: Option<PathBuf>,
}

#[tauri::command]
pub async fn fetch_outlook_unread(
    work_path: Option<String>,
    max: Option<u32>,
    m365_path: Option<String>,
) -> Result<Vec<OutlookMessage>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        fetch_outlook_unread_now(work_path, max, m365_path)
    })
    .await
    .map_err(|err| format!("m365_task_failed: {err}"))?
}

fn fetch_outlook_unread_now(
    work_path: Option<String>,
    max: Option<u32>,
    m365_path: Option<String>,
) -> Result<Vec<OutlookMessage>, String> {
    let work_path = require_workspace_path(work_path.as_deref())?;
    let context = resolve_mso_context(Some(work_path), m365_path.as_deref())?;
    if context.config.enabled == Some(false) {
        return Ok(Vec::new());
    }
    let m365_bin = context.m365_bin.ok_or_else(|| {
        "cli_missing: m365 CLI not found. Install `@pnp/cli-microsoft365` or set the path in Comms settings."
            .to_string()
    })?;
    let deadline = Instant::now() + OUTLOOK_IO_TIMEOUT;
    validate_m365_session(
        &m365_bin,
        &context.config,
        remaining_before(deadline, "Outlook message read")?,
    )?;
    let limit = max.unwrap_or(50).clamp(1, 200);
    let mut url = outlook_unread_url(limit);
    let mut messages = Vec::new();
    for _ in 0..OUTLOOK_MAX_PAGES {
        let mut cmd = Command::new(&m365_bin);
        cmd.env("PATH", augmented_path())
            .args(["request", "--url", &url, "--output", "json"]);
        let output = run_m365_json_command(
            &mut cmd,
            remaining_before(deadline, "Outlook message read")?,
        )?;
        if output.termination == CommandTermination::TimedOut {
            return Err(timeout_detail(
                "m365_timeout: Outlook message read exceeded 15 seconds",
                &output,
            ));
        }
        if !output.status.success() {
            return Err(classify_m365_output_error(&output));
        }
        reject_truncated_json_stdout(&output, "Outlook message response")?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let (mut page, next_link) =
            parse_outlook_page(&stdout).map_err(|err| format!("m365_parse_failed: {err}"))?;
        messages.append(&mut page);
        let Some(next_link) = next_link else {
            break;
        };
        if messages.len() >= limit as usize {
            break;
        }
        url = next_link;
    }
    messages.retain(|message| !message.is_read);
    messages.sort_by(|a, b| b.date.cmp(&a.date));
    messages.truncate(limit as usize);
    Ok(messages)
}

#[tauri::command]
pub fn stage_outlook_items(
    approvals: tauri::State<'_, crate::approval::ApprovalState>,
    work_path: String,
    messages: Vec<OutlookMessage>,
    approval_id: Option<String>,
) -> Result<Vec<StageOutcome>, String> {
    crate::approval::require_approval_any(
        &approvals,
        approval_id,
        &[OUTLOOK_STAGE_KIND, COMMS_BULK_KIND, INBOX_BULK_KIND],
    )?;
    let work = resolve_inside_vault(&work_path, ".")?;
    Ok(messages
        .into_iter()
        .map(|message| stage_message_outcome(&work, "mso", "mso", &message.id, &message))
        .collect())
}

#[tauri::command]
pub async fn check_mso_auth(
    work_path: Option<String>,
    m365_path: Option<String>,
) -> Result<ProviderAuthStatus, String> {
    tauri::async_runtime::spawn_blocking(move || check_mso_auth_now(work_path, m365_path))
        .await
        .map_err(|err| format!("m365_probe_task_failed: {err}"))?
}

fn check_mso_auth_now(
    work_path: Option<String>,
    m365_path: Option<String>,
) -> Result<ProviderAuthStatus, String> {
    check_mso_auth_with_timeout(work_path, m365_path, PROVIDER_READINESS_TIMEOUT)
}

fn check_mso_auth_with_timeout(
    work_path: Option<String>,
    m365_path: Option<String>,
    timeout: Duration,
) -> Result<ProviderAuthStatus, String> {
    let context = resolve_mso_context(work_path.as_deref(), m365_path.as_deref())?;
    if context.config.enabled == Some(false) {
        return Ok(auth_status(
            "mso",
            "disabled",
            Some(M365_DISABLED_DETAIL.to_string()),
            None,
            None,
        ));
    }
    let Some(m365_bin) = context.m365_bin else {
        return Ok(auth_status(
            "mso",
            "cli_missing",
            Some("m365 CLI not found".to_string()),
            None,
            None,
        ));
    };
    let validation = validate_m365_session(&m365_bin, &context.config, timeout);
    Ok(mso_auth_status_from_validation(m365_bin, validation))
}

fn mso_auth_status_from_validation(
    m365_bin: PathBuf,
    validation: Result<M365StatusIdentity, String>,
) -> ProviderAuthStatus {
    match validation {
        Ok(identity) => auth_status("mso", "ok", None, Some(m365_bin), identity.connected_as),
        Err(error) => {
            let (state, detail) = if let Some(detail) = error.strip_prefix("auth_required: ") {
                ("auth_required", detail.to_string())
            } else if error.starts_with("auth_required:") {
                ("auth_required", M365_AUTH_REQUIRED_DETAIL.to_string())
            } else {
                ("error", m365_provider_status_detail("error", &error))
            };
            auth_status("mso", state, Some(detail), Some(m365_bin), None)
        }
    }
}

fn validate_m365_session(
    m365_bin: &Path,
    config: &WorkspaceMsoConfig,
    timeout: Duration,
) -> Result<M365StatusIdentity, String> {
    let mut cmd = Command::new(m365_bin);
    cmd.env("PATH", augmented_path())
        .args(["status", "--output", "json"]);
    let output = run_m365_status_command(&mut cmd, timeout)?;
    validate_m365_status_output(config, &output)
}

fn validate_m365_status_output(
    config: &WorkspaceMsoConfig,
    output: &BoundedOutput,
) -> Result<M365StatusIdentity, String> {
    let detail = output_detail(output);
    if output.termination == CommandTermination::Aborted {
        return Err(format!("auth_required: {M365_AUTH_REQUIRED_DETAIL}"));
    }
    if output.termination == CommandTermination::TimedOut {
        if classify_m365_auth_state(&detail) == "auth_required"
            || is_m365_auth_required_output(&output.stdout, &output.stderr)
        {
            return Err(format!("auth_required: {M365_AUTH_REQUIRED_DETAIL}"));
        }
        return Err(timeout_detail(
            "m365_timeout: readiness probe exceeded its deadline",
            output,
        ));
    }
    if !output.status.success() {
        return Err(classify_m365_output_error(output));
    }
    reject_truncated_json_stdout(output, "Microsoft 365 status response")?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if is_m365_logged_out_status(&stdout) {
        return Err(format!("auth_required: {M365_AUTH_REQUIRED_DETAIL}"));
    }
    let identity = parse_m365_status(&stdout)
        .map_err(|_| "m365_parse_failed: invalid Microsoft 365 status response".to_string())?;
    if identity.connected_as.is_none()
        && identity.app_id.is_none()
        && identity.app_tenant.is_none()
        && config.app_id.is_none()
        && config.tenant_id.is_none()
    {
        return Err("m365_parse_failed: Microsoft 365 status has no identity".to_string());
    }
    if !workspace_identity_matches(config, &identity) {
        return Err(format!("auth_required: {M365_WORKSPACE_MISMATCH_DETAIL}"));
    }
    Ok(identity)
}

fn is_m365_logged_out_status(raw: &str) -> bool {
    fn is_exact_logged_out(value: &str) -> bool {
        value.eq_ignore_ascii_case("Logged out")
            || value.eq_ignore_ascii_case("Logged out, signed in connections available")
    }

    let trimmed = raw.trim();
    if is_exact_logged_out(trimmed) {
        return true;
    }
    serde_json::from_str::<String>(trimmed)
        .ok()
        .is_some_and(|value| is_exact_logged_out(&value))
}

fn workspace_identity_matches(config: &WorkspaceMsoConfig, identity: &M365StatusIdentity) -> bool {
    let matches = |expected: &Option<String>, actual: &Option<String>| {
        expected.as_ref().map_or(true, |expected| {
            actual
                .as_ref()
                .is_some_and(|actual| expected.trim().eq_ignore_ascii_case(actual.trim()))
        })
    };
    matches(&config.app_id, &identity.app_id) && matches(&config.tenant_id, &identity.app_tenant)
}

fn parse_m365_status(raw: &str) -> Result<M365StatusIdentity, String> {
    let json = extract_json_fragment(raw).ok_or_else(|| "no_json_payload".to_string())?;
    let value: serde_json::Value = serde_json::from_str(json).map_err(|err| err.to_string())?;
    let object = value
        .as_object()
        .ok_or_else(|| "expected_status_object".to_string())?;
    let identity = M365StatusIdentity {
        connected_as: json_trimmed_string(object, "connectedAs"),
        app_id: json_trimmed_string(object, "appId"),
        app_tenant: json_trimmed_string(object, "appTenant"),
    };
    Ok(identity)
}

fn json_trimmed_string(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Option<String> {
    object
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn remaining_before(deadline: Instant, operation: &str) -> Result<Duration, String> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        Err(format!(
            "m365_timeout: {operation} exceeded {} seconds",
            OUTLOOK_IO_TIMEOUT.as_secs()
        ))
    } else {
        Ok(remaining)
    }
}

fn require_outlook_items_approval(
    approvals: &crate::approval::ApprovalState,
    approval_id: Option<String>,
    items: &[OutlookDecisionRequest],
) -> Result<(), String> {
    let kinds = outlook_items_approval_kinds(items)?;
    crate::approval::require_approval_any(approvals, approval_id, kinds)
}

fn outlook_items_approval_kinds(
    items: &[OutlookDecisionRequest],
) -> Result<&'static [&'static str], String> {
    if items.is_empty() {
        return Err("outlook_items_required".to_string());
    }
    if items.len() != 1 {
        return Ok(&[COMMS_BULK_KIND]);
    }
    Ok(match &items[0].decision {
        OutlookDecision::Accepted => &[OUTLOOK_ACCEPT_KIND, COMMS_BULK_KIND],
        OutlookDecision::Rejected => &[OUTLOOK_REJECT_KIND, COMMS_BULK_KIND],
    })
}

fn decision_error_outcome(item: OutlookDecisionRequest, error: String) -> OutlookDecisionOutcome {
    OutlookDecisionOutcome {
        message_id: item.message_id,
        decision: item.decision.as_str().to_string(),
        category_name: item.decision.category_name().to_string(),
        archived: false,
        ok: false,
        error: Some(error),
    }
}

#[tauri::command]
pub async fn decide_outlook_item(
    app: AppHandle,
    approvals: tauri::State<'_, crate::approval::ApprovalState>,
    work_path: Option<String>,
    message_id: String,
    decision: OutlookDecision,
    approval_id: Option<String>,
    m365_path: Option<String>,
) -> Result<OutlookDecisionOutcome, String> {
    crate::approval::require_approval(&approvals, approval_id, decision.approval_kind())?;
    drop(approvals);
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        decide_outlook_item_now(
            work_path.as_deref(),
            &message_id,
            decision,
            m365_path.as_deref(),
        )
    })
    .await
    .map_err(|err| format!("m365_task_failed: {err}"))??;
    let _ = app.emit("outlook://decision", &outcome);
    Ok(outcome)
}

#[tauri::command]
pub async fn decide_outlook_items(
    app: AppHandle,
    approvals: tauri::State<'_, crate::approval::ApprovalState>,
    work_path: Option<String>,
    items: Vec<OutlookDecisionRequest>,
    approval_id: Option<String>,
    m365_path: Option<String>,
) -> Result<Vec<OutlookDecisionOutcome>, String> {
    require_outlook_items_approval(&approvals, approval_id, &items)?;
    drop(approvals);
    let outcomes = tauri::async_runtime::spawn_blocking(move || {
        let work_path = require_workspace_path(work_path.as_deref())?;
        let context = resolve_mso_context(Some(work_path), m365_path.as_deref())?;
        if context.config.enabled == Some(false) {
            return Err(format!("provider_disabled: {M365_DISABLED_DETAIL}"));
        }
        let m365_bin = context.m365_bin.ok_or_else(|| {
            "cli_missing: m365 CLI not found. Install `@pnp/cli-microsoft365` or set the path in Comms settings."
                .to_string()
        })?;
        let deadline = Instant::now() + OUTLOOK_IO_TIMEOUT;
        validate_m365_session(
            &m365_bin,
            &context.config,
            remaining_before(deadline, "Outlook category update")?,
        )?;
        let mut outcomes = Vec::new();
        for item in items {
            let deadline = Instant::now() + OUTLOOK_IO_TIMEOUT;
            match decide_outlook_item_with_session(
                &m365_bin,
                &item.message_id,
                item.decision.clone(),
                deadline,
            ) {
                Ok(outcome) => outcomes.push(outcome),
                Err(error) => outcomes.push(decision_error_outcome(item, error)),
            }
        }
        Ok(outcomes)
    })
    .await
    .map_err(|err| format!("m365_task_failed: {err}"))??;
    for outcome in &outcomes {
        let _ = app.emit("outlook://decision", outcome);
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
    let work_path = require_workspace_path(work_path)?;
    let context = resolve_mso_context(Some(work_path), m365_path)?;
    if context.config.enabled == Some(false) {
        return Err(format!("provider_disabled: {M365_DISABLED_DETAIL}"));
    }
    let m365_bin = context.m365_bin.ok_or_else(|| {
        "cli_missing: m365 CLI not found. Install `@pnp/cli-microsoft365` or set the path in Comms settings."
            .to_string()
    })?;
    let deadline = Instant::now() + OUTLOOK_IO_TIMEOUT;
    validate_m365_session(
        &m365_bin,
        &context.config,
        remaining_before(deadline, "Outlook category update")?,
    )?;
    decide_outlook_item_with_session(&m365_bin, message_id, decision, deadline)
}

fn decide_outlook_item_with_session(
    m365_bin: &Path,
    message_id: &str,
    decision: OutlookDecision,
    deadline: Instant,
) -> Result<OutlookDecisionOutcome, String> {
    let message_id = message_id.trim();
    if message_id.is_empty() {
        return Err("message_id_required".to_string());
    }
    let mut categories = fetch_message_categories(
        m365_bin,
        message_id,
        remaining_before(deadline, "Outlook category update")?,
    )?;
    categories.insert(decision.category_name().to_string());
    patch_message_categories(
        m365_bin,
        message_id,
        categories,
        remaining_before(deadline, "Outlook category update")?,
    )?;
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
            return resolve_program(trimmed);
        }
    }
    resolve_program("m365")
}

fn fetch_message_categories(
    m365_bin: &Path,
    message_id: &str,
    timeout: Duration,
) -> Result<BTreeSet<String>, String> {
    let url = outlook_categories_url(message_id);
    let mut cmd = Command::new(m365_bin);
    cmd.env("PATH", augmented_path())
        .args(["request", "--url", &url, "--output", "json"]);
    let output = run_m365_json_command(&mut cmd, timeout)?;
    if output.termination == CommandTermination::TimedOut {
        return Err(timeout_detail(
            "m365_timeout: Outlook category read exceeded 15 seconds",
            &output,
        ));
    }
    if !output.status.success() {
        return Err(classify_m365_output_error(&output));
    }
    reject_truncated_json_stdout(&output, "Outlook category response")?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let json = extract_json_fragment(&stdout)
        .ok_or_else(|| "m365_parse_failed: no category JSON payload".to_string())?;
    let value: serde_json::Value = serde_json::from_str(json)
        .map_err(|_| "m365_parse_failed: invalid category response".to_string())?;
    let categories = value
        .get("categories")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "m365_parse_failed: category response is missing categories".to_string())?;
    categories
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(ToString::to_string)
                .ok_or_else(|| "m365_parse_failed: invalid category value".to_string())
        })
        .collect()
}

fn patch_message_categories(
    m365_bin: &Path,
    message_id: &str,
    categories: BTreeSet<String>,
    timeout: Duration,
) -> Result<(), String> {
    let url = format!(
        "@graph/me/messages/{}",
        percent_encode_path_segment(message_id)
    );
    let body = json!({ "categories": categories.into_iter().collect::<Vec<_>>() }).to_string();
    let mut cmd = Command::new(m365_bin);
    cmd.env("PATH", augmented_path()).args([
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
    ]);
    let output = run_m365_command(&mut cmd, timeout, |_, _| false)?;
    if output.termination == CommandTermination::TimedOut {
        return Err(timeout_detail(
            "m365_timeout: Outlook category update exceeded 15 seconds",
            &output,
        ));
    }
    if output.status.success() {
        Ok(())
    } else {
        Err(classify_m365_output_error(&output))
    }
}

fn outlook_unread_url(limit: u32) -> String {
    format!(
        "@graph/me/mailFolders/inbox/messages?\
$filter=receivedDateTime ge 1900-01-01T00:00:00Z and isRead eq false&\
$orderby=receivedDateTime desc&\
$select={OUTLOOK_SELECT_FIELDS}&\
$top={}",
        limit.clamp(1, 200)
    )
}

fn outlook_categories_url(message_id: &str) -> String {
    format!(
        "@graph/me/messages/{}?$select=categories",
        percent_encode_path_segment(message_id)
    )
}

fn run_m365_command<F>(
    command: &mut Command,
    timeout: Duration,
    abort_when: F,
) -> Result<BoundedOutput, String>
where
    F: Fn(&[u8], &[u8]) -> bool,
{
    run_command_with_timeout(command, timeout, abort_when)
        .map_err(|err| format!("m365_spawn_failed: {err}"))
}

fn run_m365_json_command(
    command: &mut Command,
    timeout: Duration,
) -> Result<BoundedOutput, String> {
    run_command_with_timeout_and_limits(
        command,
        timeout,
        OutputLimits::new(M365_JSON_STDOUT_LIMIT, M365_JSON_STDERR_LIMIT),
        |_, _| false,
    )
    .map_err(|err| format!("m365_spawn_failed: {err}"))
}

fn run_m365_status_command(
    command: &mut Command,
    timeout: Duration,
) -> Result<BoundedOutput, String> {
    run_command_with_timeout_and_limits(
        command,
        timeout,
        OutputLimits::new(M365_JSON_STDOUT_LIMIT, M365_JSON_STDERR_LIMIT),
        is_m365_auth_required_output,
    )
    .map_err(|err| format!("m365_spawn_failed: {err}"))
}

fn reject_truncated_json_stdout(output: &BoundedOutput, response_name: &str) -> Result<(), String> {
    if output.stdout_truncated {
        Err(format!(
            "m365_output_truncated: {response_name} exceeded {M365_JSON_STDOUT_LIMIT} bytes"
        ))
    } else {
        Ok(())
    }
}

fn output_detail(output: &BoundedOutput) -> String {
    output.diagnostic_tail(4096).unwrap_or_default()
}

fn timeout_detail(prefix: &str, output: &BoundedOutput) -> String {
    match output.safe_diagnostic_tail(1024) {
        Some(detail) if !detail.is_empty() => format!("{prefix}. Diagnostic tail:\n{detail}"),
        _ => prefix.to_string(),
    }
}

fn sanitize_m365_detail(detail: &str) -> String {
    let lower = detail.to_lowercase();
    if [
        "microsoft.com/device",
        "enter the code",
        "use the code",
        "device code",
        "user_code",
        "verification_uri",
    ]
    .into_iter()
    .any(|marker| lower.contains(marker))
    {
        M365_AUTH_REQUIRED_DETAIL.to_string()
    } else if diagnostic_contains_sensitive_value(detail) {
        "m365 command failed without a safe diagnostic".to_string()
    } else {
        detail.to_string()
    }
}

fn m365_provider_status_detail(state: &str, detail: &str) -> String {
    if state == "auth_required" {
        M365_AUTH_REQUIRED_DETAIL.to_string()
    } else {
        sanitize_m365_detail(detail)
    }
}

fn is_m365_device_login_prompt(stdout: &[u8], stderr: &[u8]) -> bool {
    [stdout, stderr].into_iter().any(|bytes| {
        let lower = String::from_utf8_lossy(bytes).to_lowercase();
        lower.contains("microsoft.com/devicelogin")
            || lower.contains("microsoft.com/device")
            || lower.contains("enter the code")
            || lower.contains("use the code")
            || lower.contains("device code")
            || lower.contains("user_code")
            || lower.contains("verification_uri")
    })
}

fn is_m365_auth_required_output(stdout: &[u8], stderr: &[u8]) -> bool {
    if is_m365_device_login_prompt(stdout, stderr) {
        return true;
    }
    [stdout, stderr].into_iter().any(|bytes| {
        let lower = String::from_utf8_lossy(bytes).to_lowercase();
        lower.contains("aadsts")
            || lower.contains("authentication required")
            || lower.contains("login required")
            || lower.contains("not logged in")
            || lower.contains("token expired")
            || lower.contains("expired token")
    })
}

fn parse_outlook_page(raw: &str) -> Result<(Vec<OutlookMessage>, Option<String>), String> {
    let json = extract_json_fragment(raw).ok_or_else(|| "no_json_payload".to_string())?;
    let value: serde_json::Value = serde_json::from_str(json).map_err(|err| err.to_string())?;
    let (raw_messages, next_link): (Vec<RawOutlookMessage>, Option<String>) = match value {
        serde_json::Value::Array(_) => (
            serde_json::from_value(value).map_err(|err| err.to_string())?,
            None,
        ),
        serde_json::Value::Object(mut object) => {
            let next_link = object.remove("@odata.nextLink").and_then(|value| {
                value
                    .as_str()
                    .map(str::trim)
                    .filter(|link| !link.is_empty())
                    .map(ToString::to_string)
            });
            let messages = object
                .remove("value")
                .ok_or_else(|| "missing_value_array".to_string())?;
            (
                serde_json::from_value(messages).map_err(|err| err.to_string())?,
                next_link,
            )
        }
        _ => return Err("expected_message_array_or_graph_envelope".to_string()),
    };
    let messages = raw_messages
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
        .collect();
    Ok((messages, next_link))
}

fn classify_m365_error(stderr: &[u8], stdout: &[u8]) -> String {
    let raw_detail = [stderr, stdout]
        .into_iter()
        .map(|bytes| String::from_utf8_lossy(bytes).trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let lower = raw_detail.to_lowercase();
    let auth_required = classify_m365_auth_state(&raw_detail) == "auth_required"
        || is_m365_device_login_prompt(stdout, stderr);
    if auth_required
        && (lower.contains("access is denied")
            || lower.contains("403")
            || lower.contains("forbidden")
            || lower.contains("insufficient privileges"))
    {
        "auth_required: m365 is connected, but Microsoft Graph mail access is denied. Reconnect with Mail.Read/Mail.ReadWrite consent.".to_string()
    } else if auth_required {
        format!("auth_required: {M365_AUTH_REQUIRED_DETAIL}")
    } else {
        let sanitized_detail = sanitize_m365_detail(&raw_detail);
        format!("m365_failed: {}", text_tail(&sanitized_detail, 4096))
    }
}

fn classify_m365_output_error(output: &BoundedOutput) -> String {
    let classified = classify_m365_error(&output.stderr, &output.stdout);
    if (output.stdout_truncated || output.stderr_truncated)
        && !classified.starts_with("auth_required:")
    {
        "m365_failed: m365 command failed without a safe diagnostic".to_string()
    } else {
        classified
    }
}

fn text_tail(detail: &str, max_bytes: usize) -> String {
    if detail.len() <= max_bytes {
        return detail.to_string();
    }
    let mut start = detail.len() - max_bytes;
    while !detail.is_char_boundary(start) {
        start += 1;
    }
    format!("[... output truncated ...]\n{}", &detail[start..])
}

pub fn classify_m365_auth_state(detail: &str) -> &'static str {
    let lower = detail.to_lowercase();
    if lower.contains("aadsts")
        || lower.contains("login")
        || lower.contains("not logged")
        || lower.contains("auth")
        || lower.contains("token")
        || lower.contains("access is denied")
        || lower.contains("403")
        || lower.contains("forbidden")
        || lower.contains("insufficient privileges")
        || lower.contains("permission")
        || lower.contains("device code")
        || lower.contains("enter the code")
        || lower.contains("use the code")
        || lower.contains("user_code")
        || lower.contains("verification_uri")
    {
        "auth_required"
    } else {
        "error"
    }
}

fn resolve_mso_context(
    work_path: Option<&str>,
    supplied_m365_path: Option<&str>,
) -> Result<ResolvedMsoContext, String> {
    let config = load_workspace_mso_config(work_path)?;
    let selected_path = supplied_m365_path.or(config.command.as_deref());
    let m365_bin = resolve_m365_path(selected_path);
    Ok(ResolvedMsoContext { config, m365_bin })
}

fn require_workspace_path(work_path: Option<&str>) -> Result<&str, String> {
    work_path
        .filter(|path| !path.trim().is_empty())
        .ok_or_else(|| "workspace_required".to_string())
}

fn load_workspace_mso_config(work_path: Option<&str>) -> Result<WorkspaceMsoConfig, String> {
    let Some(raw) = work_path else {
        return Ok(WorkspaceMsoConfig::default());
    };
    if raw.trim().is_empty() {
        return Err("workspace_path_invalid: path is empty".to_string());
    }
    let raw_path = Path::new(raw);
    if !raw_path.exists() {
        return Err("workspace_path_invalid: workspace does not exist".to_string());
    }
    if !raw_path.is_dir() {
        return Err("workspace_path_invalid: workspace is not a directory".to_string());
    }
    let work = resolve_inside_vault(raw, ".")?;
    read_workspace_mso_config(&work)
}

fn read_workspace_mso_config(work_path: &Path) -> Result<WorkspaceMsoConfig, String> {
    let config_path = work_path.join("workspace.config.yaml");
    let content = match fs::read_to_string(&config_path) {
        Ok(content) => content,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Ok(WorkspaceMsoConfig::default());
        }
        Err(error) => {
            return Err(format!(
                "workspace_config_read_failed: {}",
                sanitize_m365_detail(&error.to_string())
            ));
        }
    };
    let yaml: YamlValue = serde_yaml::from_str(&content)
        .map_err(|_| "workspace_config_parse_failed: invalid YAML".to_string())?;
    let root = yaml
        .as_mapping()
        .ok_or_else(|| "workspace_config_parse_failed: root must be a mapping".to_string())?;
    let Some(io) = root.get(YamlValue::String("io".to_string())) else {
        return Ok(WorkspaceMsoConfig::default());
    };
    let io = io
        .as_mapping()
        .ok_or_else(|| "workspace_config_parse_failed: io must be a mapping".to_string())?;
    let Some(providers) = io.get(YamlValue::String("providers".to_string())) else {
        return Ok(WorkspaceMsoConfig::default());
    };
    let providers = providers.as_mapping().ok_or_else(|| {
        "workspace_config_parse_failed: io.providers must be a mapping".to_string()
    })?;
    let mso_key = YamlValue::String("mso".to_string());
    let outlook_key = YamlValue::String("outlook".to_string());
    let (provider_name, provider) = if let Some(provider) = providers.get(&mso_key) {
        ("mso", provider)
    } else if let Some(provider) = providers.get(&outlook_key) {
        ("outlook", provider)
    } else {
        return Ok(WorkspaceMsoConfig::default());
    };
    let provider = provider.as_mapping().ok_or_else(|| {
        format!("workspace_config_parse_failed: io.providers.{provider_name} must be a mapping")
    })?;
    Ok(WorkspaceMsoConfig {
        enabled: yaml_optional_bool(provider, "enabled", provider_name)?,
        command: yaml_first_trimmed_string(provider, &["command", "m365_path"], provider_name)?,
        app_id: yaml_first_trimmed_string(provider, &["app_id", "appId"], provider_name)?,
        tenant_id: yaml_first_trimmed_string(provider, &["tenant_id", "tenantId"], provider_name)?,
    })
}

fn yaml_optional_bool(
    provider: &serde_yaml::Mapping,
    key: &str,
    provider_name: &str,
) -> Result<Option<bool>, String> {
    let Some(value) = provider.get(YamlValue::String(key.to_string())) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    value.as_bool().map(Some).ok_or_else(|| {
        format!(
            "workspace_config_parse_failed: io.providers.{provider_name}.{key} must be a boolean"
        )
    })
}

fn yaml_first_trimmed_string(
    provider: &serde_yaml::Mapping,
    keys: &[&str],
    provider_name: &str,
) -> Result<Option<String>, String> {
    for key in keys {
        let Some(value) = provider.get(YamlValue::String((*key).to_string())) else {
            continue;
        };
        if value.is_null() {
            continue;
        }
        let value = value.as_str().ok_or_else(|| {
            format!(
                "workspace_config_parse_failed: io.providers.{provider_name}.{key} must be a string"
            )
        })?;
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Ok(Some(trimmed.to_string()));
        }
    }
    Ok(None)
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

    #[cfg(unix)]
    fn executable_script(contents: &str) -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let script = tmp.path().join("m365");
        write_executable(&script, contents);
        (tmp, script)
    }

    #[cfg(unix)]
    fn write_executable(path: &Path, contents: &str) {
        use std::os::unix::fs::PermissionsExt;

        std::fs::write(path, contents).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[cfg(unix)]
    fn captured_output(
        stdout: &str,
        stderr: &str,
        success: bool,
        termination: CommandTermination,
    ) -> BoundedOutput {
        use std::os::unix::process::ExitStatusExt;

        BoundedOutput {
            status: std::process::ExitStatus::from_raw(if success { 0 } else { 1 << 8 }),
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.as_bytes().to_vec(),
            termination,
            stdout_truncated: false,
            stderr_truncated: false,
        }
    }

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
        let (parsed, next_link) = parse_outlook_page(raw).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].from, "Jane <jane@example.com>");
        assert_eq!(parsed[0].categories, vec!["Blue"]);
        assert_eq!(next_link, None);
    }

    #[test]
    fn parses_graph_value_envelope() {
        let raw = r#"Using cached context
{
  "value": [
    {
      "id": "graph-a",
      "subject": "Graph message",
      "receivedDateTime": "2026-07-29T08:00:00Z",
      "isRead": false,
      "from": { "emailAddress": { "address": "graph@example.com" } }
    }
  ],
  "@odata.nextLink": "https://graph.microsoft.com/page2"
}"#;

        let (parsed, next_link) = parse_outlook_page(raw).unwrap();

        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].id, "graph-a");
        assert_eq!(parsed[0].from, "graph@example.com");
        assert_eq!(
            next_link.as_deref(),
            Some("https://graph.microsoft.com/page2")
        );
    }

    #[test]
    fn builds_single_bounded_unread_graph_page() {
        assert_eq!(
            outlook_unread_url(50),
            concat!(
                "@graph/me/mailFolders/inbox/messages?",
                "$filter=receivedDateTime ge 1900-01-01T00:00:00Z and isRead eq false&",
                "$orderby=receivedDateTime desc&",
                "$select=id,from,sender,subject,receivedDateTime,sentDateTime,bodyPreview,webLink,categories,isRead&",
                "$top=50"
            )
        );
        assert!(outlook_unread_url(500).ends_with("$top=200"));
        assert_eq!(
            outlook_categories_url("a/b+c="),
            "@graph/me/messages/a%2Fb%2Bc%3D?$select=categories"
        );
    }

    #[test]
    fn workspace_config_uses_one_canonical_provider_record() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("workspace.config.yaml"),
            r#"
io:
  providers:
    mso:
      enabled: false
      command: " m365-custom "
      app_id: " "
      appId: " app-from-mso "
      tenant_id: "tenant-from-mso"
    outlook:
      enabled: true
      command: "outlook-command"
      app_id: "app-from-outlook"
      tenant_id: "tenant-from-outlook"
"#,
        )
        .unwrap();

        let config = read_workspace_mso_config(tmp.path()).unwrap();

        assert_eq!(
            config,
            WorkspaceMsoConfig {
                enabled: Some(false),
                command: Some("m365-custom".to_string()),
                app_id: Some("app-from-mso".to_string()),
                tenant_id: Some("tenant-from-mso".to_string()),
            }
        );
    }

    #[test]
    fn workspace_config_falls_back_to_outlook_only_when_mso_is_absent() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("workspace.config.yaml"),
            r#"
io:
  providers:
    outlook:
      m365_path: " outlook-m365 "
      appId: " outlook-app "
      tenantId: " outlook-tenant "
"#,
        )
        .unwrap();

        let config = read_workspace_mso_config(tmp.path()).unwrap();

        assert_eq!(config.command.as_deref(), Some("outlook-m365"));
        assert_eq!(config.app_id.as_deref(), Some("outlook-app"));
        assert_eq!(config.tenant_id.as_deref(), Some("outlook-tenant"));
    }

    #[test]
    fn missing_workspace_config_is_configless_but_invalid_config_is_an_error() {
        let missing = tempfile::tempdir().unwrap();
        assert_eq!(
            read_workspace_mso_config(missing.path()).unwrap(),
            WorkspaceMsoConfig::default()
        );

        let malformed = tempfile::tempdir().unwrap();
        std::fs::write(
            malformed.path().join("workspace.config.yaml"),
            "io: [not valid",
        )
        .unwrap();
        assert_eq!(
            read_workspace_mso_config(malformed.path()).unwrap_err(),
            "workspace_config_parse_failed: invalid YAML"
        );

        let unreadable = tempfile::tempdir().unwrap();
        std::fs::create_dir(unreadable.path().join("workspace.config.yaml")).unwrap();
        assert!(read_workspace_mso_config(unreadable.path())
            .unwrap_err()
            .starts_with("workspace_config_read_failed:"));
    }

    #[test]
    fn invalid_workspace_path_never_becomes_configless() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("missing-workspace");

        let error = load_workspace_mso_config(Some(&missing.to_string_lossy())).unwrap_err();

        assert!(!error.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn graph_operations_require_workspace_before_invoking_m365() {
        let (tmp, script) = executable_script(
            "#!/bin/sh\ntouch \"${0%/*}/invoked\"\nprintf '%s' '{\"connectedAs\":\"user@example.com\"}'\n",
        );
        let script_path = script.to_string_lossy().into_owned();

        let fetch_error =
            fetch_outlook_unread_now(None, Some(1), Some(script_path.clone())).unwrap_err();
        let decision_error = decide_outlook_item_now(
            None,
            "message",
            OutlookDecision::Accepted,
            Some(&script_path),
        )
        .unwrap_err();

        assert_eq!(fetch_error, "workspace_required");
        assert_eq!(decision_error, "workspace_required");
        assert!(!tmp.path().join("invoked").exists());
    }

    #[cfg(unix)]
    #[test]
    fn successful_logged_out_status_blocks_every_graph_operation() {
        let tmp = tempfile::tempdir().unwrap();
        let script = tmp.path().join("m365");
        write_executable(
            &script,
            "#!/bin/sh\nif [ \"$1\" = status ]; then printf '%s' 'Logged out'; sleep 1; exit 0; fi\ntouch \"${0%/*}/graph-reached\"\nprintf '%s' '{}'\n",
        );
        let work_path = tmp.path().to_string_lossy().into_owned();
        let script_path = script.to_string_lossy().into_owned();

        let fetch_error =
            fetch_outlook_unread_now(Some(work_path.clone()), Some(1), Some(script_path.clone()))
                .unwrap_err();
        let decision_error = decide_outlook_item_now(
            Some(&work_path),
            "message",
            OutlookDecision::Accepted,
            Some(&script_path),
        )
        .unwrap_err();

        assert_eq!(
            fetch_error,
            format!("auth_required: {M365_AUTH_REQUIRED_DETAIL}")
        );
        assert_eq!(
            decision_error,
            format!("auth_required: {M365_AUTH_REQUIRED_DETAIL}")
        );
        assert!(!tmp.path().join("graph-reached").exists());
    }

    #[cfg(unix)]
    #[test]
    fn supplied_m365_path_overrides_workspace_config_command() {
        let (_configured_tmp, configured) = executable_script("#!/bin/sh\nexit 0\n");
        let (_supplied_tmp, supplied) = executable_script("#!/bin/sh\nexit 0\n");
        let work = tempfile::tempdir().unwrap();
        std::fs::write(
            work.path().join("workspace.config.yaml"),
            format!(
                "io:\n  providers:\n    mso:\n      command: \"{}\"\n",
                configured.to_string_lossy()
            ),
        )
        .unwrap();
        let work_path = work.path().to_string_lossy().into_owned();
        let supplied_path = supplied.to_string_lossy().into_owned();

        let context = resolve_mso_context(Some(&work_path), Some(&supplied_path)).unwrap();
        assert_eq!(context.m365_bin.as_deref(), Some(supplied.as_path()));

        let context = resolve_mso_context(Some(&work_path), None).unwrap();
        assert_eq!(context.m365_bin.as_deref(), Some(configured.as_path()));
    }

    #[cfg(unix)]
    #[test]
    fn fetch_follows_graph_next_link_for_additional_pages() {
        let (_tmp, script) = executable_script(
            "#!/bin/sh\n\
             if [ \"$1\" = status ]; then printf '%s' '{\"connectedAs\":\"user@example.com\"}'; exit 0; fi\n\
             case \"$3\" in\n\
             *page2*) printf '%s' '{\"value\":[{\"id\":\"b\",\"subject\":\"Second page\",\"receivedDateTime\":\"2026-07-28T08:00:00Z\",\"isRead\":false}]}' ;;\n\
             *) printf '%s' '{\"value\":[{\"id\":\"a\",\"subject\":\"First page\",\"receivedDateTime\":\"2026-07-29T08:00:00Z\",\"isRead\":false}],\"@odata.nextLink\":\"https://graph.microsoft.com/page2\"}' ;;\n\
             esac\n",
        );
        let work = tempfile::tempdir().unwrap();
        let work_path = work.path().to_string_lossy().into_owned();
        let script_path = script.to_string_lossy().into_owned();

        let messages =
            fetch_outlook_unread_now(Some(work_path), Some(50), Some(script_path)).unwrap();

        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].id, "a");
        assert_eq!(messages[1].id, "b");
    }

    #[test]
    fn parses_and_compares_m365_status_identity_without_exposing_values() {
        let identity = parse_m365_status(
            r#"notice
{"connectedAs":" user@example.com ","appId":" APP-ID ","appTenant":" TENANT-ID "}"#,
        )
        .unwrap();
        let matching = WorkspaceMsoConfig {
            app_id: Some("app-id".to_string()),
            tenant_id: Some("tenant-id".to_string()),
            ..WorkspaceMsoConfig::default()
        };
        let mismatch = WorkspaceMsoConfig {
            app_id: Some("other-app".to_string()),
            tenant_id: Some("tenant-id".to_string()),
            ..WorkspaceMsoConfig::default()
        };

        assert_eq!(identity.connected_as.as_deref(), Some("user@example.com"));
        assert!(workspace_identity_matches(&matching, &identity));
        assert!(!workspace_identity_matches(&mismatch, &identity));
    }

    #[test]
    fn recognizes_only_exact_m365_logged_out_status_values() {
        for output in [
            "Logged out",
            "  logged OUT \n",
            "Logged out, signed in connections available",
            r#""Logged out""#,
            r#""logged OUT, signed in connections AVAILABLE""#,
        ] {
            assert!(is_m365_logged_out_status(output), "output: {output:?}");
            let captured = captured_output(output, "", true, CommandTermination::Exited);
            let validation = validate_m365_status_output(&WorkspaceMsoConfig::default(), &captured);
            let status =
                mso_auth_status_from_validation(PathBuf::from("/bin/sh"), validation.clone());
            assert_eq!(
                validation.unwrap_err(),
                format!("auth_required: {M365_AUTH_REQUIRED_DETAIL}")
            );
            assert_eq!(status.state, "auth_required");
            assert_eq!(status.detail.as_deref(), Some(M365_AUTH_REQUIRED_DETAIL));
        }
        for output in [
            "",
            "Logged out now",
            "notice: Logged out",
            "Logged out, signed in connections available.",
            r#""Logged out" extra"#,
            r#"" Logged out ""#,
            r#"{"state":"Logged out"}"#,
        ] {
            assert!(!is_m365_logged_out_status(output), "near miss: {output:?}");
        }
        assert!(parse_m365_status("Logged out now").is_err());
        assert!(parse_m365_status(r#""Logged out now""#).is_err());
        for output in ["Logged out now", r#""Logged out now""#] {
            let captured = captured_output(output, "", true, CommandTermination::Exited);
            let validation = validate_m365_status_output(&WorkspaceMsoConfig::default(), &captured);
            let status =
                mso_auth_status_from_validation(PathBuf::from("/bin/sh"), validation.clone());
            assert!(validation.unwrap_err().starts_with("m365_parse_failed:"));
            assert_eq!(status.state, "error");
        }
    }

    #[test]
    fn bulk_approval_requires_bulk_kind_and_single_item_is_decision_scoped() {
        let accepted = OutlookDecisionRequest {
            message_id: "accepted".to_string(),
            decision: OutlookDecision::Accepted,
        };
        let rejected = OutlookDecisionRequest {
            message_id: "rejected".to_string(),
            decision: OutlookDecision::Rejected,
        };

        assert_eq!(
            outlook_items_approval_kinds(&[accepted.clone()]).unwrap(),
            &[OUTLOOK_ACCEPT_KIND, COMMS_BULK_KIND]
        );
        assert_eq!(
            outlook_items_approval_kinds(&[rejected.clone()]).unwrap(),
            &[OUTLOOK_REJECT_KIND, COMMS_BULK_KIND]
        );
        assert_eq!(
            outlook_items_approval_kinds(&[accepted.clone(), accepted]).unwrap(),
            &[COMMS_BULK_KIND]
        );
        assert_eq!(
            outlook_items_approval_kinds(&[rejected.clone(), rejected]).unwrap(),
            &[COMMS_BULK_KIND]
        );
        assert_eq!(
            outlook_items_approval_kinds(&[
                OutlookDecisionRequest {
                    message_id: "accepted".to_string(),
                    decision: OutlookDecision::Accepted,
                },
                OutlookDecisionRequest {
                    message_id: "rejected".to_string(),
                    decision: OutlookDecision::Rejected,
                },
            ])
            .unwrap(),
            &[COMMS_BULK_KIND]
        );
        assert_eq!(
            outlook_items_approval_kinds(&[]).unwrap_err(),
            "outlook_items_required"
        );
    }

    #[cfg(unix)]
    #[test]
    fn disabled_workspace_never_invokes_m365() {
        let tmp = tempfile::tempdir().unwrap();
        let script = tmp.path().join("m365");
        write_executable(&script, "#!/bin/sh\ntouch \"${0%/*}/invoked\"\nexit 1\n");
        std::fs::write(
            tmp.path().join("workspace.config.yaml"),
            format!(
                "io:\n  providers:\n    mso:\n      enabled: false\n      command: '{}'\n",
                script.display()
            ),
        )
        .unwrap();
        let work_path = tmp.path().to_string_lossy().into_owned();

        let status =
            check_mso_auth_with_timeout(Some(work_path.clone()), None, Duration::from_secs(1))
                .unwrap();
        let messages = fetch_outlook_unread_now(Some(work_path.clone()), Some(5), None).unwrap();
        let decision_error =
            decide_outlook_item_now(Some(&work_path), "message", OutlookDecision::Accepted, None)
                .unwrap_err();

        assert_eq!(status.state, "disabled");
        assert_eq!(status.detail.as_deref(), Some(M365_DISABLED_DETAIL));
        assert!(messages.is_empty());
        assert_eq!(
            decision_error,
            format!("provider_disabled: {M365_DISABLED_DETAIL}")
        );
        assert!(!tmp.path().join("invoked").exists());
    }

    #[cfg(unix)]
    #[test]
    fn matching_workspace_identity_allows_graph_read() {
        let tmp = tempfile::tempdir().unwrap();
        let script = tmp.path().join("m365");
        write_executable(
            &script,
            r#"#!/bin/sh
if [ "$1" = status ]; then
  printf '%s' '{"connectedAs":"user@example.com","appId":"EXPECTED-APP","appTenant":"EXPECTED-TENANT"}'
  exit 0
fi
touch "${0%/*}/graph-reached"
printf '%s' '{"value":[{"id":"message","receivedDateTime":"2026-07-29T08:00:00Z","isRead":false}]}'
"#,
        );
        std::fs::write(
            tmp.path().join("workspace.config.yaml"),
            format!(
                "io:\n  providers:\n    mso:\n      command: '{}'\n      app_id: expected-app\n      tenant_id: expected-tenant\n",
                script.display()
            ),
        )
        .unwrap();

        let messages = fetch_outlook_unread_now(
            Some(tmp.path().to_string_lossy().into_owned()),
            Some(5),
            None,
        )
        .unwrap();

        assert_eq!(messages.len(), 1);
        assert!(tmp.path().join("graph-reached").exists());
    }

    #[cfg(unix)]
    #[test]
    fn workspace_identity_mismatch_or_missing_fields_blocks_graph() {
        let config = WorkspaceMsoConfig {
            app_id: Some("expected-app".to_string()),
            tenant_id: Some("expected-tenant".to_string()),
            ..WorkspaceMsoConfig::default()
        };
        let cases = [
            (
                "app-mismatch",
                r#"{"connectedAs":"user@example.com","appId":"other-app","appTenant":"expected-tenant"}"#,
            ),
            (
                "tenant-mismatch",
                r#"{"connectedAs":"user@example.com","appId":"expected-app","appTenant":"other-tenant"}"#,
            ),
            ("missing-fields", r#"{"connectedAs":"user@example.com"}"#),
        ];
        for (name, status_json) in cases {
            let output = captured_output(status_json, "", true, CommandTermination::Exited);
            let mut graph_reached = false;
            let validation = validate_m365_status_output(&config, &output).map(|identity| {
                graph_reached = true;
                identity
            });
            let readiness =
                mso_auth_status_from_validation(PathBuf::from("/bin/sh"), validation.clone());
            let error = validation.unwrap_err();

            assert_eq!(
                readiness.state, "auth_required",
                "case {name}: {:?}",
                readiness.detail
            );
            assert_eq!(
                readiness.detail.as_deref(),
                Some(M365_WORKSPACE_MISMATCH_DETAIL),
                "case {name}"
            );
            assert_eq!(
                error,
                format!("auth_required: {M365_WORKSPACE_MISMATCH_DETAIL}"),
                "case {name}"
            );
            assert!(!graph_reached, "case {name}");
            assert!(!error.contains("expected-app"));
            assert!(!error.contains("expected-tenant"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn auth_prompt_blocks_graph_without_exposing_device_code() {
        let (tmp, script) = executable_script(
            "#!/bin/sh\nif [ \"$1\" = status ]; then printf 'Open https://microsoft.com/devicelogin and enter the code LIVE-CODE-99'; sleep 60; fi\ntouch \"${0%/*}/graph-reached\"\n",
        );

        let error = fetch_outlook_unread_now(
            Some(tmp.path().to_string_lossy().into_owned()),
            Some(1),
            Some(script.to_string_lossy().into_owned()),
        )
        .unwrap_err();

        assert_eq!(error, format!("auth_required: {M365_AUTH_REQUIRED_DETAIL}"));
        assert!(!error.contains("LIVE-CODE-99"));
        assert!(!error.contains("microsoft.com"));
        assert!(!tmp.path().join("graph-reached").exists());
    }

    #[cfg(unix)]
    #[test]
    fn category_get_failure_never_patches() {
        for (name, get_response) in [
            ("nonzero", "printf 'category read failed' >&2\nexit 1\n"),
            ("parse", "printf '%s' '{\"wrong\":[]}'\nexit 0\n"),
        ] {
            let tmp = tempfile::tempdir().unwrap();
            let script = tmp.path().join("m365");
            write_executable(
                &script,
                &format!(
                    r#"#!/bin/sh
if [ "$1" = status ]; then
  printf '%s' '{{"connectedAs":"user@example.com"}}'
  exit 0
fi
method=""
previous=""
for argument in "$@"; do
  if [ "$previous" = "--method" ]; then method="$argument"; fi
  previous="$argument"
done
if [ "$method" = patch ]; then
  touch "${{0%/*}}/patch-reached"
  exit 0
fi
{get_response}"#
                ),
            );

            let error = decide_outlook_item_now(
                Some(tmp.path().to_str().unwrap()),
                "message",
                OutlookDecision::Accepted,
                Some(&script.to_string_lossy()),
            )
            .unwrap_err();

            assert!(!error.is_empty(), "case {name}");
            assert!(!tmp.path().join("patch-reached").exists(), "case {name}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn truncated_category_response_never_patches() {
        let (tmp, script) = executable_script(
            r#"#!/bin/sh
if [ "$1" = status ]; then
  printf '%s' '{"connectedAs":"user@example.com"}'
  exit 0
fi
method=""
previous=""
for argument in "$@"; do
  if [ "$previous" = "--method" ]; then method="$argument"; fi
  previous="$argument"
done
if [ "$method" = patch ]; then
  touch "${0%/*}/patch-reached"
  exit 0
fi
cat "${0%/*}/categories.json"
"#,
        );
        std::fs::write(
            tmp.path().join("categories.json"),
            json!({ "categories": ["x".repeat(M365_JSON_STDOUT_LIMIT)] }).to_string(),
        )
        .unwrap();

        let error = decide_outlook_item_now(
            Some(tmp.path().to_str().unwrap()),
            "message",
            OutlookDecision::Accepted,
            Some(&script.to_string_lossy()),
        )
        .unwrap_err();

        assert!(error.starts_with("m365_output_truncated:"));
        assert!(!tmp.path().join("patch-reached").exists());
    }

    #[cfg(unix)]
    #[test]
    fn timed_out_category_read_never_patches() {
        let (tmp, script) = executable_script(
            r#"#!/bin/sh
method=""
previous=""
for argument in "$@"; do
  if [ "$previous" = "--method" ]; then method="$argument"; fi
  previous="$argument"
done
if [ "$method" = patch ]; then
  touch "${0%/*}/patch-reached"
  exit 0
fi
sleep 60
"#,
        );

        let error = decide_outlook_item_with_session(
            &script,
            "message",
            OutlookDecision::Accepted,
            Instant::now() + Duration::from_millis(100),
        )
        .unwrap_err();

        assert!(error.starts_with("m365_timeout:"));
        assert!(!tmp.path().join("patch-reached").exists());
    }

    #[cfg(unix)]
    #[test]
    fn category_update_retains_existing_categories() {
        let (tmp, script) = executable_script(
            r#"#!/bin/sh
if [ "$1" = status ]; then
  printf '%s' '{"connectedAs":"user@example.com"}'
  exit 0
fi
method=""
previous=""
for argument in "$@"; do
  if [ "$previous" = "--method" ]; then method="$argument"; fi
  previous="$argument"
done
if [ "$method" = patch ]; then
  printf '%s\n' "$@" > "${0%/*}/patch-args"
  printf '%s' '{}'
  exit 0
fi
printf '%s' '{"categories":["Existing","Team"]}'
"#,
        );

        let outcome = decide_outlook_item_now(
            Some(tmp.path().to_str().unwrap()),
            "message",
            OutlookDecision::Accepted,
            Some(&script.to_string_lossy()),
        )
        .unwrap();
        let patch_args = std::fs::read_to_string(tmp.path().join("patch-args")).unwrap();

        assert!(outcome.ok);
        assert!(patch_args.contains("Existing"));
        assert!(patch_args.contains("Team"));
        assert!(patch_args.contains(ACCEPTED_CATEGORY));
    }

    #[cfg(unix)]
    #[test]
    fn fetch_uses_m365_request_with_the_bounded_graph_url() {
        let (tmp, script) = executable_script(
            r#"#!/bin/sh
if [ "$1" = "status" ]; then
  printf '%s' '{"connectedAs":"user@example.com","appId":"app","appTenant":"tenant"}'
  exit 0
fi
printf '%s\n' "$@" > "${0%/*}/args.txt"
printf '%s' '{"value":[{"id":"new","receivedDateTime":"2026-07-29T08:00:00Z","isRead":false},{"id":"read","receivedDateTime":"2026-07-29T09:00:00Z","isRead":true}]}'
"#,
        );

        let messages = fetch_outlook_unread_now(
            Some(tmp.path().to_string_lossy().into_owned()),
            Some(3),
            Some(script.to_string_lossy().into_owned()),
        )
        .unwrap();
        let args = std::fs::read_to_string(tmp.path().join("args.txt")).unwrap();
        let expected_url = outlook_unread_url(3);

        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].id, "new");
        assert_eq!(
            args.lines().collect::<Vec<_>>(),
            vec![
                "request",
                "--url",
                expected_url.as_str(),
                "--output",
                "json"
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn fetch_parses_complete_graph_envelope_larger_than_default_capture() {
        let messages = (0..200)
            .map(|index| {
                json!({
                    "id": format!("message-{index}"),
                    "from": {
                        "emailAddress": {
                            "name": format!("Sender {index}"),
                            "address": format!("sender-{index}@example.com")
                        }
                    },
                    "sender": {
                        "emailAddress": {
                            "name": format!("Sender {index}"),
                            "address": format!("sender-{index}@example.com")
                        }
                    },
                    "subject": format!("Message subject {index}"),
                    "receivedDateTime": format!("2026-07-29T08:{:02}:00Z", index % 60),
                    "sentDateTime": format!("2026-07-29T08:{:02}:00Z", index % 60),
                    "bodyPreview": "x".repeat(1024),
                    "webLink": format!("https://outlook.office.com/mail/inbox/id/message-{index}"),
                    "categories": ["Operations", "Maru"],
                    "isRead": false
                })
            })
            .collect::<Vec<_>>();
        let payload = json!({ "value": messages }).to_string();
        assert!(payload.len() > 64 * 1024);
        assert!(payload.len() < M365_JSON_STDOUT_LIMIT);
        let (tmp, script) = executable_script(
            "#!/bin/sh\nif [ \"$1\" = status ]; then printf '%s' '{\"connectedAs\":\"user@example.com\"}'; else cat \"${0%/*}/graph-response.json\"; fi\n",
        );
        std::fs::write(tmp.path().join("graph-response.json"), payload).unwrap();

        let parsed = fetch_outlook_unread_now(
            Some(tmp.path().to_string_lossy().into_owned()),
            Some(200),
            Some(script.to_string_lossy().into_owned()),
        )
        .unwrap();

        assert_eq!(parsed.len(), 200);
        assert_eq!(parsed[0].body_preview.len(), 1024);
        assert!(parsed.iter().any(|message| message.id == "message-199"));
    }

    #[cfg(unix)]
    #[test]
    fn fetch_rejects_graph_stdout_truncated_at_structured_cap() {
        let payload = json!({
            "value": [{
                "id": "oversized",
                "bodyPreview": "x".repeat(M365_JSON_STDOUT_LIMIT)
            }]
        })
        .to_string();
        assert!(payload.len() > M365_JSON_STDOUT_LIMIT);
        let (tmp, script) = executable_script(
            "#!/bin/sh\nif [ \"$1\" = status ]; then printf '%s' '{\"connectedAs\":\"user@example.com\"}'; else cat \"${0%/*}/graph-response.json\"; fi\n",
        );
        std::fs::write(tmp.path().join("graph-response.json"), payload).unwrap();

        let error = fetch_outlook_unread_now(
            Some(tmp.path().to_string_lossy().into_owned()),
            Some(1),
            Some(script.to_string_lossy().into_owned()),
        )
        .unwrap_err();

        assert!(error.starts_with("m365_output_truncated:"));
    }

    #[cfg(unix)]
    #[test]
    fn nonzero_graph_errors_never_expose_device_login_prompt() {
        let (tmp, script) = executable_script(
            "#!/bin/sh\nif [ \"$1\" = status ]; then printf '%s' '{\"connectedAs\":\"user@example.com\"}'; exit 0; fi\nprintf 'Open https://microsoft.com/devicelogin and enter the code LIVE-CODE-42' >&2\nexit 1\n",
        );
        let script_path = script.to_string_lossy().into_owned();

        let fetch_error = fetch_outlook_unread_now(
            Some(tmp.path().to_string_lossy().into_owned()),
            Some(1),
            Some(script_path.clone()),
        )
        .unwrap_err();
        let category_error =
            fetch_message_categories(&script, "message-id", Duration::from_secs(2)).unwrap_err();
        let patch_error = patch_message_categories(
            &script,
            "message-id",
            BTreeSet::from(["Maru".to_string()]),
            Duration::from_secs(2),
        )
        .unwrap_err();

        for error in [fetch_error, category_error, patch_error] {
            assert_eq!(error, format!("auth_required: {M365_AUTH_REQUIRED_DETAIL}"));
            assert!(!error.contains("LIVE-CODE-42"));
            assert!(!error.contains("microsoft.com"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn non_auth_graph_error_suppresses_generic_secret() {
        let (tmp, script) = executable_script(
            "#!/bin/sh\nif [ \"$1\" = status ]; then printf '%s' '{\"connectedAs\":\"user@example.com\"}'; exit 0; fi\nprintf 'password=M365-REQUEST-SECRET network unavailable' >&2\nexit 1\n",
        );

        let error = fetch_outlook_unread_now(
            Some(tmp.path().to_string_lossy().into_owned()),
            Some(1),
            Some(script.to_string_lossy().into_owned()),
        )
        .unwrap_err();

        assert_eq!(
            error,
            "m365_failed: m365 command failed without a safe diagnostic"
        );
        assert!(!error.contains("M365-REQUEST-SECRET"));
    }

    #[cfg(unix)]
    #[test]
    fn device_login_prompt_returns_auth_required_without_waiting_for_timeout() {
        let (_tmp, script) = executable_script(
            "#!/bin/sh\nprintf 'Open https://microsoft.com/devicelogin and enter the code ABC'\nsleep 60\n",
        );

        let status = check_mso_auth_with_timeout(
            None,
            Some(script.to_string_lossy().into_owned()),
            Duration::from_secs(5),
        )
        .unwrap();

        assert_eq!(
            status.state, "auth_required",
            "unexpected detail: {:?}",
            status.detail
        );
        assert_eq!(status.detail.as_deref(), Some(M365_AUTH_REQUIRED_DETAIL));
        let detail = status.detail.unwrap();
        assert!(!detail.contains("ABC"));
        assert!(!detail.contains("microsoft.com"));
    }

    #[test]
    fn readiness_error_suppresses_camel_case_client_secret() {
        let detail = m365_provider_status_detail(
            "error",
            r#"{"clientSecret":"M365-READINESS-SECRET","error":"network unavailable"}"#,
        );

        assert_eq!(detail, "m365 command failed without a safe diagnostic");
        assert!(!detail.contains("M365-READINESS-SECRET"));
    }

    #[cfg(unix)]
    #[test]
    fn timed_out_auth_variant_is_classified_and_sanitized() {
        let mut command = Command::new("/bin/sh");
        command.args([
            "-c",
            "printf 'AADSTS700082: token expired for live code SECRET-CODE-42'; sleep 60",
        ]);
        let output = run_m365_status_command(&mut command, Duration::from_secs(5)).unwrap();
        let validation = validate_m365_status_output(&WorkspaceMsoConfig::default(), &output);
        let status = mso_auth_status_from_validation(PathBuf::from("/bin/sh"), validation);

        assert_eq!(output.termination, CommandTermination::Aborted);

        assert_eq!(
            status.state, "auth_required",
            "unexpected detail: {:?}",
            status.detail
        );
        assert_eq!(status.detail.as_deref(), Some(M365_AUTH_REQUIRED_DETAIL));
        assert!(!status.detail.unwrap().contains("SECRET-CODE-42"));
    }

    #[cfg(unix)]
    #[test]
    fn silent_m365_probe_timeout_returns_error_state() {
        let (_tmp, script) = executable_script("#!/bin/sh\nsleep 60\n");

        let status = check_mso_auth_with_timeout(
            None,
            Some(script.to_string_lossy().into_owned()),
            Duration::from_millis(100),
        )
        .unwrap();

        assert_eq!(status.state, "error");
        assert!(status
            .detail
            .as_deref()
            .is_some_and(|detail| detail.starts_with("m365_timeout:")));
    }

    #[cfg(unix)]
    #[test]
    fn timeout_retains_safe_bounded_diagnostic_tail() {
        let output = captured_output(
            "",
            "network route unavailable",
            false,
            CommandTermination::TimedOut,
        );
        let validation = validate_m365_status_output(&WorkspaceMsoConfig::default(), &output);
        let status = mso_auth_status_from_validation(PathBuf::from("/bin/sh"), validation);

        assert_eq!(status.state, "error");
        let detail = status.detail.unwrap();
        assert!(detail.starts_with("m365_timeout:"));
        assert!(
            detail.contains("network route unavailable"),
            "unexpected detail: {detail}"
        );
        assert!(detail.len() < 1200);
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
    fn nonzero_error_sanitizes_full_detail_before_display_tail() {
        let raw = format!("clientSecret={}", "S".repeat(5000));

        let error = classify_m365_error(raw.as_bytes(), b"");

        assert_eq!(
            error,
            "m365_failed: m365 command failed without a safe diagnostic"
        );
        assert!(!error.contains(&"S".repeat(128)));
    }

    #[cfg(unix)]
    #[test]
    fn nonzero_output_error_suppresses_truncated_secret_continuation() {
        let mut command = Command::new("sh");
        command.args([
            "-c",
            "printf 'clientSecret=' >&2; i=0; while [ \"$i\" -lt 70000 ]; do printf S >&2; i=$((i + 1)); done; exit 1",
        ]);
        let output = run_m365_command(&mut command, Duration::from_secs(2), |_, _| false).unwrap();

        assert!(output.stderr_truncated);
        assert!(!String::from_utf8_lossy(&output.stderr)
            .to_lowercase()
            .contains("clientsecret"));
        let error = classify_m365_output_error(&output);

        assert_eq!(
            error,
            "m365_failed: m365 command failed without a safe diagnostic"
        );
        assert!(!error.contains(&"S".repeat(128)));
    }

    #[test]
    fn encodes_graph_message_path_segment() {
        assert_eq!(percent_encode_path_segment("a/b+c="), "a%2Fb%2Bc%3D");
    }
}
