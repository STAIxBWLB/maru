use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tauri::{AppHandle, Manager};

use crate::agent_host::contracts::SKILL_PROPOSAL_SCHEMA_VERSION;
use crate::agent_host::event_store::{append_run_event_payload_in_transaction, run_events_path};
use crate::agent_host::protected_write::{
    apply_protected_write_claim, ProtectedWriteClaim, ProtectedWriteOutcome,
};
use crate::approval::{ApprovalBinding, ApprovalRequest, ApprovalState};
use crate::atomic_file::{with_path_transactions, PathTransactionLease, PathTransactionRequest};
use sha2::{Digest, Sha256};

pub const MEETING_SOURCE_REVIEW_SCHEMA_VERSION: &str = "maru_meeting_source_review_v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MeetingSourceReview {
    pub schema_version: String,
    pub session_id: String,
    pub base_revision: String,
    #[serde(default)]
    pub suggestions: Vec<MeetingSourceSuggestion>,
    #[serde(default)]
    pub uncertainties: Vec<String>,
    #[serde(default)]
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MeetingSourceSuggestion {
    pub id: String,
    pub source_id: String,
    pub before: String,
    pub after: String,
    pub category: String,
    pub reason: String,
    #[serde(default)]
    pub evidence: String,
    #[serde(default = "default_meeting_suggestion_required")]
    pub required: bool,
}

fn default_meeting_suggestion_required() -> bool {
    true
}

impl MeetingSourceReview {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != MEETING_SOURCE_REVIEW_SCHEMA_VERSION {
            return Err(format!(
                "meeting_source_review_schema_unsupported: {}",
                self.schema_version
            ));
        }
        if self.session_id.trim().is_empty() {
            return Err("meeting_source_review_session_required".to_string());
        }
        for suggestion in &self.suggestions {
            if suggestion.id.trim().is_empty() || suggestion.source_id.trim().is_empty() {
                return Err("meeting_source_review_suggestion_identity_required".to_string());
            }
            if suggestion.before.is_empty() {
                return Err(format!(
                    "meeting_source_review_before_required: {}",
                    suggestion.id
                ));
            }
            if suggestion.category.trim().is_empty() || suggestion.reason.trim().is_empty() {
                return Err(format!(
                    "meeting_source_review_reason_required: {}",
                    suggestion.id
                ));
            }
        }
        Ok(())
    }
}

pub fn parse_meeting_source_review(raw: &str) -> Result<MeetingSourceReview, String> {
    let json =
        extract_json_object(raw).ok_or_else(|| "meeting_source_review_json_missing".to_string())?;
    let review: MeetingSourceReview = serde_json::from_str(json)
        .map_err(|err| format!("meeting_source_review_json_invalid: {err}"))?;
    review.validate()?;
    Ok(review)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkillProposal {
    pub summary: String,
    #[serde(default)]
    pub files: Vec<SkillProposalFile>,
    #[serde(default)]
    pub commands: Vec<SkillProposalCommand>,
    #[serde(default)]
    pub risks: Vec<String>,
    #[serde(default)]
    pub requires_approval: bool,
    pub schema_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillProposalFile {
    pub path: String,
    #[serde(default = "default_file_operation")]
    pub operation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillProposalCommand {
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default)]
    pub requires_approval: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProposalApplyReport {
    pub summary: String,
    #[serde(default)]
    pub writes: Vec<ProtectedWriteOutcome>,
}

fn default_file_operation() -> String {
    "replace".to_string()
}

impl SkillProposal {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != SKILL_PROPOSAL_SCHEMA_VERSION {
            return Err(format!(
                "skill_proposal_schema_unsupported: {}",
                self.schema_version
            ));
        }
        if self.summary.trim().is_empty() {
            return Err("skill_proposal_summary_required".to_string());
        }
        for file in &self.files {
            if file.path.trim().is_empty() {
                return Err("skill_proposal_file_path_required".to_string());
            }
            match file.operation.as_str() {
                "create" | "replace" | "append" | "delete" => {}
                other => {
                    return Err(format!(
                        "skill_proposal_file_operation_unsupported: {other}"
                    ))
                }
            }
            if file.operation != "delete" && file.content.is_none() {
                return Err(format!(
                    "skill_proposal_file_content_required: {}",
                    file.path
                ));
            }
        }
        for command in &self.commands {
            if command.command.trim().is_empty() {
                return Err("skill_proposal_command_required".to_string());
            }
        }
        Ok(())
    }
}

pub fn agent_parse_skill_proposal(raw: String) -> Result<SkillProposal, String> {
    parse_skill_proposal(&raw)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalApprovalContext {
    pub cwd: String,
    pub proposal: SkillProposal,
    pub run_id: Option<String>,
}

fn hash_json(value: &impl Serialize) -> Result<String, String> {
    serde_json::to_vec(value)
        .map(|bytes| format!("{:x}", Sha256::digest(bytes)))
        .map_err(|e| e.to_string())
}

fn proposal_binding(context: &ProposalApprovalContext) -> Result<ApprovalBinding, String> {
    context.proposal.validate()?;
    let root = crate::vault::normalize_existing_dir(&context.cwd)?;
    let mut targets = Vec::new();
    let mut revisions = Vec::new();
    for file in &context.proposal.files {
        let path = crate::vault::resolve_inside_vault(&context.cwd, &file.path)?;
        targets.push(path.to_string_lossy().to_string());
        revisions.push(if path.exists() {
            Some(crate::agent_host::protected_write::file_sha256_hex(&path)?)
        } else {
            None
        });
    }
    let source = if let Some(run_id) = context.run_id.as_deref() {
        validate_reviewed_source_provenance(&context.cwd, run_id)?;
        let events = crate::agent_host::event_store::read_run_events(&context.cwd, run_id)?;
        let started = events.iter().find(|e| e.event_type == "run.started");
        let reviewed = reviewed_source_state_path(&context.cwd, run_id)?;
        let reviewed_hash = reviewed
            .as_ref()
            .map(|path| crate::agent_host::protected_write::file_sha256_hex(path))
            .transpose()?;
        hash_json(&(started, reviewed_hash))?
    } else {
        hash_json(&Option::<String>::None)?
    };
    let policy_path = crate::vault_list::workspace_registry_path()?;
    let legacy_path = crate::vault_list::legacy_vault_list_path()?;
    let policy_bytes = |path: &std::path::Path| -> Result<Option<Vec<u8>>, String> {
        match std::fs::read(path) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(format!("approval_policy_read_failed: {error}")),
        }
    };
    let policy = (policy_bytes(&policy_path)?, policy_bytes(&legacy_path)?);
    Ok(ApprovalBinding {
        logical_target: hash_json(&(root.to_string_lossy(), targets))?,
        payload_hash: hash_json(&context.proposal)?,
        source_run_id: context.run_id.clone(),
        source_revision: source,
        base_revision: hash_json(&revisions)?,
        policy_revision: hash_json(&("proposal-approval-v1", policy))?,
    })
}

pub(crate) fn prepare_proposal_approval(
    state: &ApprovalState,
    context: &ProposalApprovalContext,
    summary: String,
    target: Option<String>,
    preview: Option<String>,
) -> Result<ApprovalRequest, String> {
    let binding = proposal_binding(context)?;
    state.prepare_bound(&context.cwd, summary, target, preview, binding)
}

pub fn agent_apply_skill_proposal<R: tauri::Runtime>(
    app: AppHandle<R>,
    cwd: String,
    proposal: SkillProposal,
    approval_id: Option<String>,
    run_id: Option<String>,
) -> Result<ProposalApplyReport, String> {
    let approvals = app.state::<ApprovalState>();
    let id = approval_id
        .as_deref()
        .ok_or("approval_required: agent.proposal.apply")?;
    let mut paths = apply_write_set(&cwd, &proposal, run_id.as_deref())?;
    paths.push(crate::approval::audit_path(&cwd, id)?);
    paths.push(crate::vault_list::workspace_registry_path()?);
    paths.push(crate::vault_list::legacy_vault_list_path()?);
    with_path_transactions(
        PathTransactionRequest::new(paths)?.with_workspace_registry()?,
        |lease| {
            lease.before_effect()?;
            let binding = proposal_binding(&ProposalApprovalContext {
                cwd: cwd.clone(),
                proposal: proposal.clone(),
                run_id: run_id.clone(),
            })?;
            let id = approvals.consume_bound(Some(id), &binding, lease)?;
            let outcome =
                apply_skill_proposal_in_transaction(&cwd, &proposal, run_id.as_deref(), lease);
            let detail = match &outcome {
                Ok(report) => serde_json::to_string(report).map_err(|e| e.to_string())?,
                Err(error) => format!("failed_or_partial: {error}"),
            };
            if let Err(error) = approvals.record_effect(&id, detail, lease) {
                return Err(format!(
                    "approval_effect_outcome_uncertain: effect attempted; do not retry; {error}"
                ));
            }
            outcome
        },
    )
}

/// A meeting generation proposal may only be applied while its source-review
/// pin is still present in the durable run metadata. The meeting_sources
/// domain additionally verifies confirmation, version identity, and content
/// hash; this guard keeps legacy runs (which have no provenance) compatible.
fn validate_reviewed_source_provenance(cwd: &str, run_id: &str) -> Result<(), String> {
    let events = crate::agent_host::event_store::read_run_events(cwd, run_id)?;
    let Some(started) = events
        .iter()
        .find(|event| event.event_type == "run.started")
    else {
        return Ok(());
    };
    let metadata = started
        .payload
        .get("request")
        .and_then(|request| request.get("metadata"))
        .or_else(|| started.payload.get("metadata"));
    let Some(metadata) = metadata else {
        return Ok(());
    };
    let Some(origin) = metadata.get("origin").and_then(serde_json::Value::as_str) else {
        return Ok(());
    };
    if !matches!(
        origin,
        "meetingNotesFromTranscript" | "meetingNotesExternalRefine"
    ) {
        return Ok(());
    }
    if !metadata
        .get("provenanceRequired")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
    {
        // Runs created before source review was introduced remain readable and
        // applicable, as required by the migration contract.
        return Ok(());
    }
    let reviewed = metadata
        .get("reviewedSource")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| "meeting_reviewed_source_provenance_missing".to_string())?;
    for key in ["sessionId", "versionId", "contentHash"] {
        if reviewed
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_none()
        {
            return Err(format!("meeting_reviewed_source_{key}_missing_at_apply"));
        }
    }
    let reference: crate::meeting_sources::ReviewedSourceReference =
        serde_json::from_value(serde_json::Value::Object(reviewed.clone()))
            .map_err(|_| "meeting_reviewed_source_provenance_invalid".to_string())?;
    crate::meeting_sources::validate_reviewed_source(cwd, &reference)
        .map_err(|error| format!("meeting_reviewed_source_stale_at_apply: {error}"))?;
    Ok(())
}

/// IPC owns values before offloading; synchronous Rust callers keep their API.
pub mod ipc {
    use super::*;

    #[tauri::command]
    pub async fn agent_parse_skill_proposal(raw: String) -> Result<SkillProposal, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            super::phase08_16_hooks::stage("agent_parse_skill_proposal");
            super::agent_parse_skill_proposal(raw)
        })
        .await
        .map_err(|err| format!("agent_parse_skill_proposal_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn agent_apply_skill_proposal<R: tauri::Runtime>(
        app: AppHandle<R>,
        cwd: String,
        proposal: SkillProposal,
        approval_id: Option<String>,
        run_id: Option<String>,
    ) -> Result<ProposalApplyReport, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            super::phase08_16_hooks::stage("agent_apply_skill_proposal");
            super::agent_apply_skill_proposal(app, cwd, proposal, approval_id, run_id)
        })
        .await
        .map_err(|err| format!("agent_apply_skill_proposal_task_failed: {err}"))?
    }
}

#[cfg(test)]
mod phase08_16_hooks {
    use std::sync::{Arc, Mutex, OnceLock};

    type Callback = Arc<dyn Fn() + Send + Sync>;

    static STAGES: OnceLock<Mutex<Vec<(u64, String, Callback)>>> = OnceLock::new();
    static TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

    fn stages() -> &'static Mutex<Vec<(u64, String, Callback)>> {
        STAGES.get_or_init(|| Mutex::new(Vec::new()))
    }

    pub(crate) fn lock() -> std::sync::MutexGuard<'static, ()> {
        TEST_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap()
    }

    pub(crate) struct StageHook(u64);

    impl StageHook {
        pub(crate) fn new(command: &str, callback: impl Fn() + Send + Sync + 'static) -> Self {
            let id = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            stages()
                .lock()
                .unwrap()
                .push((id, command.to_string(), Arc::new(callback)));
            Self(id)
        }
    }

    impl Drop for StageHook {
        fn drop(&mut self) {
            stages().lock().unwrap().retain(|(id, _, _)| *id != self.0);
        }
    }

    pub(crate) fn stage(command: &str) {
        let callbacks: Vec<_> = stages()
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, registered, _)| registered == command)
            .map(|(_, _, callback)| callback.clone())
            .collect();
        for callback in callbacks {
            callback();
        }
    }
}

pub fn parse_skill_proposal(raw: &str) -> Result<SkillProposal, String> {
    let json = extract_json_object(raw).ok_or_else(|| "skill_proposal_json_missing".to_string())?;
    let proposal: SkillProposal =
        serde_json::from_str(json).map_err(|err| format!("skill_proposal_json_invalid: {err}"))?;
    proposal.validate()?;
    Ok(proposal)
}

/// Complete write set for one apply: every claimed target with its
/// `maru-write.tmp` sidecar plus the run-event log when a run id is present.
fn apply_write_set(
    cwd: &str,
    proposal: &SkillProposal,
    run_id: Option<&str>,
) -> Result<Vec<PathBuf>, String> {
    let mut paths = Vec::new();
    for file in &proposal.files {
        let target = crate::vault::resolve_inside_vault(cwd, &file.path)?;
        paths.push(target.with_extension("maru-write.tmp"));
        paths.push(target);
    }
    if let Some(run_id) = run_id {
        paths.push(run_events_path(cwd, run_id)?);
        if let Some(session_path) = reviewed_source_state_path(cwd, run_id)? {
            paths.push(session_path);
        }
    }
    Ok(paths)
}

fn reviewed_source_state_path(cwd: &str, run_id: &str) -> Result<Option<PathBuf>, String> {
    let Some(reference) = reviewed_source_reference(cwd, run_id)? else {
        return Ok(None);
    };
    let workspace = crate::vault::normalize_existing_dir(cwd)?;
    Ok(Some(
        workspace
            .join(".maru")
            .join("meetings")
            .join("source-reviews")
            .join(reference.session_id)
            .join("state.json"),
    ))
}

fn reviewed_source_reference(
    cwd: &str,
    run_id: &str,
) -> Result<Option<crate::meeting_sources::ReviewedSourceReference>, String> {
    let events = crate::agent_host::event_store::read_run_events(cwd, run_id)?;
    let Some(started) = events
        .iter()
        .find(|event| event.event_type == "run.started")
    else {
        return Ok(None);
    };
    let metadata = started
        .payload
        .get("request")
        .and_then(|request| request.get("metadata"));
    let Some(metadata) = metadata else {
        return Ok(None);
    };
    let Some(origin) = metadata.get("origin").and_then(serde_json::Value::as_str) else {
        return Ok(None);
    };
    if !matches!(
        origin,
        "meetingNotesFromTranscript" | "meetingNotesExternalRefine"
    ) || !metadata
        .get("provenanceRequired")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
    {
        return Ok(None);
    }
    let Some(reviewed) = metadata.get("reviewedSource") else {
        return Ok(None);
    };
    serde_json::from_value(reviewed.clone())
        .map(Some)
        .map_err(|_| "meeting_reviewed_source_provenance_invalid".to_string())
}

pub fn apply_skill_proposal(
    cwd: &str,
    proposal: &SkillProposal,
    run_id: Option<&str>,
) -> Result<ProposalApplyReport, String> {
    proposal.validate()?;
    with_path_transactions(
        PathTransactionRequest::new(apply_write_set(cwd, proposal, run_id)?)?,
        |lease| apply_skill_proposal_in_transaction(cwd, proposal, run_id, lease),
    )
}

fn apply_skill_proposal_in_transaction(
    cwd: &str,
    proposal: &SkillProposal,
    run_id: Option<&str>,
    lease: &PathTransactionLease,
) -> Result<ProposalApplyReport, String> {
    lease.ensure_covered(apply_write_set(cwd, proposal, run_id)?)?;
    lease.before_effect()?;
    if let Some(run_id) = run_id {
        validate_reviewed_source_provenance(cwd, run_id)?;
    }
    let reviewed = run_id
        .map(|id| reviewed_source_reference(cwd, id))
        .transpose()?
        .flatten();
    let mut writes = Vec::new();
    for file in &proposal.files {
        let target = crate::vault::resolve_inside_vault(cwd, &file.path)?;
        let previous_content = if reviewed.is_some() && target.exists() {
            Some(
                std::fs::read_to_string(&target)
                    .map_err(|error| format!("Cannot preserve output for rollback: {error}"))?,
            )
        } else {
            None
        };
        let claim = ProtectedWriteClaim {
            path: file.path.clone(),
            expected_hash: file.expected_hash.clone(),
            operation: file.operation.clone(),
            actor: "agent.proposal.apply".to_string(),
            reason: proposal.summary.clone(),
            schema_version: crate::agent_host::contracts::PROTECTED_WRITE_CLAIM_SCHEMA_VERSION
                .to_string(),
        };
        if let Some(run_id) = run_id {
            let _ = append_run_event_payload_in_transaction(
                cwd,
                run_id,
                "write.claimed",
                "agent.proposal.apply",
                serde_json::to_value(&claim).unwrap_or(JsonValue::Null),
                lease,
            );
        }
        match apply_protected_write_claim(cwd, &claim, file.content.as_deref()) {
            Ok(outcome) => {
                if outcome.committed_hash.is_some() {
                    if let Some(reference) = reviewed.as_ref() {
                        if let Err(error) =
                            crate::meeting_sources::record_source_output_provenance_in_transaction(
                                cwd,
                                reference,
                                &outcome.path,
                                lease,
                            )
                        {
                            let rollback = ProtectedWriteClaim {
                                path: file.path.clone(), expected_hash: outcome.committed_hash.clone(),
                                operation: if previous_content.is_some() { "replace" } else { "delete" }.into(),
                                actor: "meeting.source.provenance.rollback".into(), reason: error.to_string(),
                                schema_version: crate::agent_host::contracts::PROTECTED_WRITE_CLAIM_SCHEMA_VERSION.into(),
                            };
                            apply_protected_write_claim(cwd, &rollback, previous_content.as_deref())
                                .map_err(|rollback_error| format!("meeting_output_provenance_failed: {error}; rollback_failed: {rollback_error}"))?;
                            return Err(format!(
                                "meeting_output_provenance_failed: {error}; output rolled back"
                            ));
                        }
                    }
                }
                if let Some(run_id) = run_id {
                    let _ = append_run_event_payload_in_transaction(
                        cwd,
                        run_id,
                        "write.committed",
                        "agent.proposal.apply",
                        serde_json::to_value(&outcome).unwrap_or(JsonValue::Null),
                        lease,
                    );
                }
                writes.push(outcome);
            }
            Err(err) => {
                if let Some(run_id) = run_id {
                    let _ = append_run_event_payload_in_transaction(
                        cwd,
                        run_id,
                        "write.conflict",
                        "agent.proposal.apply",
                        serde_json::json!({
                            "path": file.path,
                            "error": err,
                        }),
                        lease,
                    );
                }
                return Err(err);
            }
        }
    }
    Ok(ProposalApplyReport {
        summary: proposal.summary.clone(),
        writes,
    })
}

fn extract_json_object(raw: &str) -> Option<&str> {
    let trimmed = raw.trim();
    if trimmed.starts_with('{') && trimmed.ends_with('}') {
        return Some(trimmed);
    }
    if let Some(start) = trimmed.find("```json") {
        let after = &trimmed[start + "```json".len()..];
        if let Some(end) = after.find("```") {
            let candidate = after[..end].trim();
            if candidate.starts_with('{') {
                return Some(candidate);
            }
        }
    }
    if let Some(start) = trimmed.find("```") {
        let after = &trimmed[start + "```".len()..];
        if let Some(end) = after.find("```") {
            let candidate = after[..end].trim();
            if candidate.starts_with('{') {
                return Some(candidate);
            }
        }
    }
    let start = trimmed.find('{')?;
    let end = trimmed.rfind('}')?;
    if end > start {
        Some(&trimmed[start..=end])
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_host::contracts::SKILL_PROPOSAL_SCHEMA_VERSION;

    #[test]
    fn parses_fenced_skill_proposal() {
        let raw = format!(
            "Proposal:\n```json\n{{\"summary\":\"update\",\"files\":[],\"commands\":[],\"risks\":[],\"requiresApproval\":true,\"schemaVersion\":\"{}\"}}\n```",
            SKILL_PROPOSAL_SCHEMA_VERSION
        );
        let parsed = parse_skill_proposal(&raw).unwrap();
        assert_eq!(parsed.summary, "update");
        assert!(parsed.requires_approval);
    }

    #[test]
    fn rejects_direct_write_without_content() {
        let raw = format!(
            "{{\"summary\":\"update\",\"files\":[{{\"path\":\"a.md\",\"operation\":\"replace\"}}],\"commands\":[],\"risks\":[],\"requiresApproval\":true,\"schemaVersion\":\"{}\"}}",
            SKILL_PROPOSAL_SCHEMA_VERSION
        );
        let err = parse_skill_proposal(&raw).unwrap_err();
        assert!(err.starts_with("skill_proposal_file_content_required"));
    }

    #[test]
    fn parses_source_review_contract_without_file_proposals() {
        let raw = r#"{"schemaVersion":"maru_meeting_source_review_v1","sessionId":"s1","baseRevision":"r1","suggestions":[{"id":"x","sourceId":"plaud","before":"old","after":"new","category":"fact","reason":"확인","evidence":"회의 발언"}],"uncertainties":[]}"#;
        let review = parse_meeting_source_review(raw).unwrap();
        assert_eq!(review.base_revision, "r1");
        assert_eq!(review.suggestions[0].evidence, "회의 발언");
        assert!(review.suggestions[0].required);
    }
}

#[cfg(test)]
mod phase08_16 {
    use super::phase08_16_hooks::{lock, StageHook};
    use super::*;
    use crate::atomic_file::phase08_06::{run, Held, Home};
    use crate::atomic_file::PathTransactionTestHook;
    use crate::workspace_files::ipc as files_ipc;
    use std::fs;
    use std::future::Future;
    use std::sync::mpsc;
    use std::time::Duration;

    fn text(path: &std::path::Path) -> String {
        path.to_string_lossy().into_owned()
    }

    fn start<F>(future: F) -> mpsc::Receiver<F::Output>
    where
        F: std::future::Future + Send + 'static,
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
            .expect("proposal fixture completion")
    }

    fn app() -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        app.manage(ApprovalState::default());
        app
    }

    fn grant(
        app: &tauri::App<tauri::test::MockRuntime>,
        cwd: &str,
        proposal: &SkillProposal,
        run_id: Option<&str>,
    ) -> String {
        let request = prepare_proposal_approval(
            &app.state::<ApprovalState>(),
            &ProposalApprovalContext {
                cwd: cwd.into(),
                proposal: proposal.clone(),
                run_id: run_id.map(str::to_string),
            },
            "synthetic fixture".into(),
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
        request.id
    }

    fn proposal(summary: &str, files: Vec<SkillProposalFile>) -> SkillProposal {
        SkillProposal {
            summary: summary.to_string(),
            files,
            commands: Vec::new(),
            risks: Vec::new(),
            requires_approval: true,
            schema_version: SKILL_PROPOSAL_SCHEMA_VERSION.to_string(),
        }
    }

    fn file(path: &str, operation: &str, content: Option<&str>) -> SkillProposalFile {
        SkillProposalFile {
            path: path.to_string(),
            operation: operation.to_string(),
            content: content.map(str::to_string),
            expected_hash: None,
            diff: None,
        }
    }

    fn fenced(raw: &str) -> String {
        format!("Proposal:\n```json\n{raw}\n```")
    }

    fn valid_raw(summary: &str) -> String {
        format!(
            "{{\"summary\":\"{summary}\",\"files\":[],\"commands\":[],\"risks\":[],\"requiresApproval\":true,\"schemaVersion\":\"{SKILL_PROPOSAL_SCHEMA_VERSION}\"}}"
        )
    }

    #[test]
    fn phase08_16_proposal_parse_wrapper_round_trip_and_legacy_rejections() {
        let _guard = lock();
        let parsed = run(ipc::agent_parse_skill_proposal(fenced(&valid_raw(
            "update",
        ))))
        .unwrap();
        assert_eq!(parsed.summary, "update");
        assert!(parsed.requires_approval);

        assert_eq!(
            run(ipc::agent_parse_skill_proposal("no object here".into())).unwrap_err(),
            "skill_proposal_json_missing"
        );
        assert!(run(ipc::agent_parse_skill_proposal("{broken}".into()))
            .unwrap_err()
            .starts_with("skill_proposal_json_invalid"));
        let wrong_schema = valid_raw("update").replace(SKILL_PROPOSAL_SCHEMA_VERSION, "v0");
        assert!(run(ipc::agent_parse_skill_proposal(wrong_schema))
            .unwrap_err()
            .starts_with("skill_proposal_schema_unsupported"));
        let no_content = valid_raw("update").replace(
            "\"files\":[]",
            "\"files\":[{\"path\":\"a.md\",\"operation\":\"replace\"}]",
        );
        assert!(run(ipc::agent_parse_skill_proposal(no_content))
            .unwrap_err()
            .starts_with("skill_proposal_file_content_required"));
    }

    #[test]
    fn phase08_16_proposal_apply_commits_writes_with_approval_and_rejections() {
        let home = Home::new();
        let app = app();
        let handle = app.handle().clone();
        let work = home.root.path().join("work");
        fs::create_dir_all(&work).unwrap();
        fs::write(work.join("existing.md"), "old content\n").unwrap();
        let cwd = text(&work);

        let create = proposal(
            "fixture apply",
            vec![
                file("created/notes.md", "create", Some("new file body\n")),
                file("existing.md", "replace", Some("replaced body\n")),
            ],
        );
        let approval = grant(&app, &cwd, &create, Some("ai-proposal-run"));
        let report = run(ipc::agent_apply_skill_proposal(
            handle.clone(),
            cwd.clone(),
            create,
            Some(approval),
            Some("ai-proposal-run".into()),
        ))
        .unwrap();
        assert_eq!(report.summary, "fixture apply");
        assert_eq!(report.writes.len(), 2);
        assert!(report.writes[0].committed_hash.is_some());
        assert_eq!(
            fs::read_to_string(work.join("created/notes.md")).unwrap(),
            "new file body\n"
        );
        assert_eq!(
            fs::read_to_string(work.join("existing.md")).unwrap(),
            "replaced body\n"
        );
        let events =
            fs::read_to_string(work.join(".maru/runs/skills/ai-proposal-run/events.jsonl"))
                .unwrap();
        assert!(events.contains("\"write.claimed\""));
        assert!(events.contains("\"write.committed\""));

        // Legacy rejection surfaces through the wrapper unchanged.
        assert_eq!(
            run(ipc::agent_apply_skill_proposal(
                handle.clone(),
                cwd.clone(),
                proposal(
                    "x",
                    vec![file("created/notes.md", "create", Some("again\n"))]
                ),
                None,
                None,
            ))
            .unwrap_err(),
            "approval_required: agent.proposal.apply"
        );
        let wrong_kind = {
            let request = crate::approval::prepare_approval(
                app.state(),
                "inbox.file.accept".into(),
                "synthetic".into(),
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
            request.id
        };
        assert!(run(ipc::agent_apply_skill_proposal(
            handle.clone(),
            cwd.clone(),
            proposal("x", vec![file("other.md", "create", Some("y\n"))]),
            Some(wrong_kind),
            None,
        ))
        .unwrap_err()
        .starts_with("approval_kind_mismatch"));
        let first = proposal("x", vec![file("consumed.md", "create", Some("1\n"))]);
        let consumed = grant(&app, &cwd, &first, None);
        run(ipc::agent_apply_skill_proposal(
            handle.clone(),
            cwd.clone(),
            first,
            Some(consumed.clone()),
            None,
        ))
        .unwrap();
        let second = proposal("x", vec![file("consumed.md", "create", Some("2\n"))]);
        assert_eq!(
            run(ipc::agent_apply_skill_proposal(
                handle.clone(),
                cwd.clone(),
                second,
                Some(consumed),
                None,
            ))
            .unwrap_err(),
            "approval_consumed"
        );
        let stale_hash = proposal(
            "x",
            vec![SkillProposalFile {
                path: "existing.md".into(),
                operation: "replace".into(),
                content: Some("nope\n".into()),
                expected_hash: Some("deadbeef".into()),
                diff: None,
            }],
        );
        let stale_approval = grant(&app, &cwd, &stale_hash, None);
        assert!(run(ipc::agent_apply_skill_proposal(
            handle,
            cwd.clone(),
            stale_hash,
            Some(stale_approval),
            None,
        ))
        .unwrap_err()
        .starts_with("write_conflict"));
    }

    #[test]
    fn bound_proposal_rejects_payload_target_workspace_run_and_base_drift() {
        let home = Home::new();
        let app = app();
        let work = home.root.path().join("work");
        let other = home.root.path().join("other");
        fs::create_dir_all(&work).unwrap();
        fs::create_dir_all(&other).unwrap();
        let cwd = text(&work);
        let original = proposal(
            "approved",
            vec![file("note.md", "replace", Some("approved body"))],
        );
        let id = grant(&app, &cwd, &original, Some("source-run"));
        for (root, candidate, run_id) in [
            (
                cwd.clone(),
                proposal(
                    "approved",
                    vec![file("note.md", "replace", Some("other body"))],
                ),
                Some("source-run".into()),
            ),
            (
                cwd.clone(),
                proposal(
                    "approved",
                    vec![file("other.md", "replace", Some("approved body"))],
                ),
                Some("source-run".into()),
            ),
            (text(&other), original.clone(), Some("source-run".into())),
            (cwd.clone(), original.clone(), Some("other-run".into())),
        ] {
            assert_eq!(
                agent_apply_skill_proposal(
                    app.handle().clone(),
                    root,
                    candidate,
                    Some(id.clone()),
                    run_id
                )
                .unwrap_err(),
                "approval_binding_mismatch"
            );
        }
        fs::write(work.join("note.md"), "new source revision").unwrap();
        assert_eq!(
            agent_apply_skill_proposal(
                app.handle().clone(),
                cwd.clone(),
                original,
                Some(id),
                Some("source-run".into())
            )
            .unwrap_err(),
            "approval_binding_mismatch"
        );
        assert_eq!(
            fs::read_to_string(work.join("note.md")).unwrap(),
            "new source revision"
        );
        assert!(!other.join("note.md").exists());
    }

    #[test]
    fn bound_proposal_rejects_changed_source_and_policy_revision() {
        let home = Home::new();
        let app = app();
        let work = home.root.path().join("work");
        fs::create_dir_all(&work).unwrap();
        let cwd = text(&work);
        let candidate = proposal("approved", vec![file("note.md", "create", Some("body"))]);
        let id = grant(&app, &cwd, &candidate, Some("source-run"));
        crate::agent_host::event_store::append_run_event_payload(
            &cwd,
            "source-run",
            "run.started",
            "fixture",
            serde_json::json!({"metadata": {"revision": "changed"}}),
        )
        .unwrap();
        assert_eq!(
            agent_apply_skill_proposal(
                app.handle().clone(),
                cwd.clone(),
                candidate.clone(),
                Some(id),
                Some("source-run".into())
            )
            .unwrap_err(),
            "approval_binding_mismatch"
        );
        let id = grant(&app, &cwd, &candidate, None);
        let registry = crate::vault_list::workspace_registry_path().unwrap();
        fs::create_dir_all(registry.parent().unwrap()).unwrap();
        fs::write(
            registry,
            serde_json::to_vec(&serde_json::json!({"workspaces": [], "activeByVisibility": {}, "hiddenDefaults": ["policy-revision-changed"]})).unwrap(),
        )
        .unwrap();
        assert_eq!(
            agent_apply_skill_proposal(app.handle().clone(), cwd, candidate, Some(id), None)
                .unwrap_err(),
            "approval_binding_mismatch"
        );
        assert!(!work.join("note.md").exists());
    }

    #[test]
    fn bound_proposal_concurrent_consumes_and_restart_keep_history_without_authority() {
        let home = Home::new();
        let app = app();
        let work = home.root.path().join("work");
        fs::create_dir_all(&work).unwrap();
        let cwd = text(&work);
        let candidate = proposal(
            "approved",
            vec![file("note.md", "append", Some("one attempt"))],
        );
        let id = grant(&app, &cwd, &candidate, None);
        let make = || {
            let handle = app.handle().clone();
            let cwd = cwd.clone();
            let candidate = candidate.clone();
            let id = id.clone();
            start(async move {
                ipc::agent_apply_skill_proposal(handle, cwd, candidate, Some(id), None).await
            })
        };
        let a = make();
        let b = make();
        let outcomes = [done(a), done(b)];
        assert_eq!(outcomes.iter().filter(|r| r.is_ok()).count(), 1);
        assert_eq!(
            outcomes.iter().find_map(|r| r.as_ref().err()).unwrap(),
            "approval_consumed"
        );
        assert_eq!(
            fs::read_to_string(work.join("note.md")).unwrap(),
            "one attempt"
        );
        let events = crate::approval::read_approval_audit(&cwd, &id).unwrap();
        assert_eq!(
            events.iter().map(|e| e.event.as_str()).collect::<Vec<_>>(),
            ["requested", "decided", "consumed", "effect.outcome"]
        );
        let unused = proposal(
            "unused grant",
            vec![file("unused.md", "create", Some("body"))],
        );
        let unused_id = grant(&app, &cwd, &unused, None);
        let restarted = super::phase08_16::app();
        assert_eq!(
            agent_apply_skill_proposal(
                restarted.handle().clone(),
                cwd.clone(),
                unused,
                Some(unused_id.clone()),
                None
            )
            .unwrap_err(),
            "approval_not_found"
        );
        assert_eq!(
            crate::approval::read_approval_audit(&cwd, &unused_id)
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            agent_apply_skill_proposal(
                restarted.handle().clone(),
                cwd.clone(),
                candidate,
                Some(id.clone()),
                None
            )
            .unwrap_err(),
            "approval_not_found"
        );
        assert_eq!(
            crate::approval::read_approval_audit(&cwd, &id)
                .unwrap()
                .len(),
            4
        );
    }

    #[test]
    fn bound_remembered_grants_are_exactly_scoped_and_terminal_decisions_immutable() {
        let home = Home::new();
        let app = app();
        let work = home.root.path().join("work");
        fs::create_dir_all(&work).unwrap();
        let context = ProposalApprovalContext {
            cwd: text(&work),
            proposal: proposal("approved", vec![file("note.md", "replace", Some("body"))]),
            run_id: None,
        };
        let prepare = |context: &ProposalApprovalContext| {
            prepare_proposal_approval(
                &app.state::<ApprovalState>(),
                context,
                "Review".into(),
                None,
                None,
            )
            .unwrap()
        };
        let request = prepare(&context);
        crate::approval::record_approval(
            app.state(),
            request.id.clone(),
            crate::approval::ApprovalDecision::Approved,
            Some(true),
        )
        .unwrap();
        assert_eq!(
            crate::approval::record_approval(
                app.state(),
                request.id.clone(),
                crate::approval::ApprovalDecision::Rejected,
                None
            )
            .unwrap_err(),
            "approval_decision_terminal"
        );
        assert!(prepare(&context).auto_approved);
        let mut changed = context.clone();
        changed.proposal.files[0].path = "other.md".into();
        assert!(!prepare(&changed).auto_approved);
        changed = context.clone();
        changed.run_id = Some("other-run".into());
        assert!(!prepare(&changed).auto_approved);
        changed = context.clone();
        changed.proposal.files[0].content = Some("changed".into());
        assert!(!prepare(&changed).auto_approved);
        assert_eq!(
            crate::approval::require_approval(
                &app.state::<ApprovalState>(),
                Some(request.id),
                "agent.proposal.apply"
            )
            .unwrap_err(),
            "approval_bound_required"
        );
    }

    #[test]
    fn bound_proposal_pre_effect_audit_failure_blocks_and_poisoned_grant_cannot_retry() {
        let home = Home::new();
        let app = app();
        let work = home.root.path().join("work");
        fs::create_dir_all(&work).unwrap();
        let cwd = text(&work);
        let candidate = proposal("approved", vec![file("note.md", "create", Some("body"))]);
        let id = grant(&app, &cwd, &candidate, None);
        let audit = crate::approval::audit_path(&cwd, &id).unwrap();
        fs::write(&audit, "corrupt history").unwrap();
        assert!(agent_apply_skill_proposal(
            app.handle().clone(),
            cwd.clone(),
            candidate.clone(),
            Some(id.clone()),
            None
        )
        .unwrap_err()
        .starts_with("approval_audit_invalid"));
        assert!(!work.join("note.md").exists());
        fs::write(audit, "[]").unwrap();
        assert_eq!(
            agent_apply_skill_proposal(app.handle().clone(), cwd, candidate, Some(id), None)
                .unwrap_err(),
            "approval_consumed"
        );
    }

    #[test]
    fn bound_proposal_consume_cannot_publish_audit_blocks_effect() {
        let home = Home::new();
        let app = app();
        let work = home.root.path().join("work");
        fs::create_dir_all(&work).unwrap();
        let cwd = text(&work);
        let candidate = proposal("approved", vec![file("note.md", "create", Some("body"))]);
        let id = grant(&app, &cwd, &candidate, None);
        let audit = crate::approval::audit_path(&cwd, &id).unwrap();
        fs::remove_file(&audit).unwrap();
        fs::create_dir(&audit).unwrap();
        assert!(agent_apply_skill_proposal(
            app.handle().clone(),
            cwd.clone(),
            candidate.clone(),
            Some(id.clone()),
            None
        )
        .unwrap_err()
        .starts_with("approval_audit_read_failed"));
        assert!(!work.join("note.md").exists());
        fs::remove_dir(&audit).unwrap();
        fs::write(&audit, "[]").unwrap();
        assert_eq!(
            agent_apply_skill_proposal(app.handle().clone(), cwd, candidate, Some(id), None)
                .unwrap_err(),
            "approval_consumed"
        );
    }

    #[cfg(unix)]
    #[test]
    fn bound_audit_syncs_first_workspace_publication_through_root_alias() {
        let home = Home::new();
        let app = app();
        let work = home.root.path().join("work");
        let alias = home.root.path().join("work-alias");
        fs::create_dir_all(&work).unwrap();
        std::os::unix::fs::symlink(&work, &alias).unwrap();
        let workspace_syncs = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed = workspace_syncs.clone();
        let _hook = PathTransactionTestHook::new(
            work.clone(),
            "approval-audit-before-directory-sync",
            move || {
                observed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            },
        );
        assert!(!work.join(".maru").exists());
        let candidate = proposal("approved", vec![file("note.md", "create", Some("body"))]);
        let context = ProposalApprovalContext {
            cwd: text(&alias),
            proposal: candidate,
            run_id: None,
        };
        let request = prepare_proposal_approval(
            &app.state::<ApprovalState>(),
            &context,
            "Review".into(),
            None,
            None,
        )
        .unwrap();
        assert_eq!(workspace_syncs.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(
            crate::approval::read_approval_audit(&text(&work), &request.id)
                .unwrap()
                .len(),
            1
        );
    }

    #[cfg(unix)]
    #[test]
    fn bound_consume_workspace_sync_failure_blocks_effect_and_retry() {
        let home = Home::new();
        let app = app();
        let work = home.root.path().join("work");
        let moved = home.root.path().join("moved-work");
        fs::create_dir_all(&work).unwrap();
        let cwd = text(&work);
        let candidate = proposal("approved", vec![file("note.md", "create", Some("body"))]);
        let id = grant(&app, &cwd, &candidate, None);
        let original = work.clone();
        let relocated = moved.clone();
        let hook = PathTransactionTestHook::new(
            work.clone(),
            "approval-audit-before-directory-sync",
            move || {
                fs::rename(&original, &relocated).unwrap();
            },
        );
        assert!(agent_apply_skill_proposal(
            app.handle().clone(),
            cwd.clone(),
            candidate.clone(),
            Some(id.clone()),
            None
        )
        .unwrap_err()
        .starts_with("approval_audit_sync_failed"));
        drop(hook);
        assert!(!moved.join("note.md").exists());
        fs::rename(&moved, &work).unwrap();
        assert_eq!(
            agent_apply_skill_proposal(app.handle().clone(), cwd, candidate, Some(id), None)
                .unwrap_err(),
            "approval_consumed"
        );
        assert!(!work.join("note.md").exists());
    }

    #[test]
    fn bound_proposal_outcome_failure_is_uncertain_without_rollback_or_retry() {
        let home = Home::new();
        let app = app();
        let work = home.root.path().join("work");
        fs::create_dir_all(&work).unwrap();
        let cwd = text(&work);
        let candidate = proposal("approved", vec![file("note.md", "create", Some("body"))]);
        let id = grant(&app, &cwd, &candidate, None);
        let audit = crate::approval::audit_path(&cwd, &id).unwrap();
        let effect = work.join("note.md");
        let hook = PathTransactionTestHook::new(audit.clone(), "pre-effect", move || {
            if effect.exists() {
                fs::write(&audit, "corrupt after effect").unwrap();
            }
        });
        assert!(agent_apply_skill_proposal(
            app.handle().clone(),
            cwd.clone(),
            candidate.clone(),
            Some(id.clone()),
            None
        )
        .unwrap_err()
        .starts_with("approval_effect_outcome_uncertain"));
        drop(hook);
        assert_eq!(fs::read_to_string(work.join("note.md")).unwrap(), "body");
        assert_eq!(
            agent_apply_skill_proposal(app.handle().clone(), cwd, candidate, Some(id), None)
                .unwrap_err(),
            "approval_consumed"
        );
    }

    #[test]
    fn phase08_16_proposal_wrappers_yield_on_same_polling_task() {
        let _guard = lock();
        let (entered_tx, mut entered_rx) = tauri::async_runtime::channel(1);
        let (release_tx, release_rx) = mpsc::channel();
        let release_rx = std::sync::Mutex::new(release_rx);
        let _hook = StageHook::new("agent_parse_skill_proposal", move || {
            entered_tx
                .blocking_send(std::thread::current().id())
                .unwrap();
            release_rx
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(5))
                .expect("release parse worker");
        });
        run(async move {
            let caller = std::thread::current().id();
            let mut future = Box::pin(ipc::agent_parse_skill_proposal(fenced(&valid_raw("yield"))));
            assert!(
                std::future::poll_fn(|cx| std::task::Poll::Ready(future.as_mut().poll(cx)))
                    .await
                    .is_pending()
            );
            let worker = entered_rx.recv().await.expect("parse worker entered");
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
            assert_ne!(caller, worker);
            release_tx.send(()).unwrap();
            assert_eq!(future.await.unwrap().summary, "yield");
        });
    }

    #[cfg(unix)]
    #[test]
    fn phase08_16_proposal_wrappers_map_join_failure() {
        let _guard = lock();
        {
            let _panic = StageHook::new("agent_parse_skill_proposal", || {
                panic!("fixture parse worker panic")
            });
            assert!(
                run(ipc::agent_parse_skill_proposal(fenced(&valid_raw("x"))))
                    .unwrap_err()
                    .starts_with("agent_parse_skill_proposal_task_failed:")
            );
        }
        let home = Home::new();
        let app = app();
        let handle = app.handle().clone();
        let work = home.root.path().join("work");
        fs::create_dir_all(&work).unwrap();
        {
            let _panic = StageHook::new("agent_apply_skill_proposal", || {
                panic!("fixture apply worker panic")
            });
            assert!(run(ipc::agent_apply_skill_proposal(
                handle,
                text(&work),
                proposal("x", vec![file("a.md", "create", Some("b\n"))]),
                Some(grant(
                    &app,
                    &(text(&work)),
                    &(proposal("x", vec![file("a.md", "create", Some("b\n"))])),
                    None
                )),
                None,
            ))
            .unwrap_err()
            .starts_with("agent_apply_skill_proposal_task_failed:"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn phase08_16_proposal_apply_files_parent_both_orders_and_aliases_no_recreation() {
        let home = Home::new();
        let app = app();
        let handle = app.handle().clone();
        for parent_first in [false, true] {
            for alias in [false, true] {
                let fixture = tempfile::tempdir_in(home.root.path()).unwrap();
                let fixture_root = fixture.path();
                let docs = fixture_root.join("work/docs");
                fs::create_dir_all(&docs).unwrap();
                let external = fixture_root.join("external");
                fs::create_dir(&external).unwrap();
                let (selected, key, apply_cwd, competitor_vault, competitor_source) = if alias {
                    fs::remove_dir_all(&docs).unwrap();
                    std::os::unix::fs::symlink(&external, &docs).unwrap();
                    let work = fixture_root.join("work");
                    (
                        external.clone(),
                        docs.join("note.md"),
                        text(&work),
                        text(fixture_root),
                        "external".to_string(),
                    )
                } else {
                    let work = fixture_root.join("work");
                    (
                        docs.clone(),
                        docs.join("note.md"),
                        text(&work),
                        text(&work),
                        "docs".to_string(),
                    )
                };
                fs::write(docs.join("note.md"), "original note\n").unwrap();
                let approval = grant(
                    &app,
                    &apply_cwd,
                    &proposal(
                        "contended apply",
                        vec![file("docs/note.md", "replace", Some("changed note\n"))],
                    ),
                    None,
                );
                let moved_dir = if alias {
                    fixture_root.join("moved")
                } else {
                    fixture_root.join("work/moved")
                };
                let apply_handle = handle.clone();
                let apply_future = async move {
                    ipc::agent_apply_skill_proposal(
                        apply_handle,
                        apply_cwd,
                        proposal(
                            "contended apply",
                            vec![file("docs/note.md", "replace", Some("changed note\n"))],
                        ),
                        Some(approval),
                        None,
                    )
                    .await
                };
                let parent_future = async move {
                    files_ipc::rename_workspace_entry(
                        competitor_vault,
                        competitor_source,
                        "moved".into(),
                    )
                    .await
                    .map(|outcome| assert!(outcome.error.is_none()))
                };
                if parent_first {
                    let held = Held::new(selected.clone(), "pre-effect");
                    let p = start(parent_future);
                    held.wait();
                    let waiting = Held::new(key.clone(), "before-admission");
                    let c = start(apply_future);
                    waiting.wait();
                    waiting.release();
                    assert!(c.recv_timeout(Duration::from_millis(20)).is_err());
                    held.release();
                    done(p).unwrap();
                    assert!(
                        done(c).is_err(),
                        "{alias}: renamed original parent must fail revalidation"
                    );
                    assert!(
                        !selected.exists(),
                        "{alias}: original docs parent recreated"
                    );
                    assert_eq!(
                        fs::read_to_string(moved_dir.join("note.md")).unwrap(),
                        "original note\n"
                    );
                } else {
                    let held = Held::new(key.clone(), "pre-effect");
                    let c = start(apply_future);
                    held.wait();
                    let waiting = Held::new(selected.clone(), "before-admission");
                    let p = start(parent_future);
                    waiting.wait();
                    waiting.release();
                    assert!(p.recv_timeout(Duration::from_millis(20)).is_err());
                    held.release();
                    done(c).unwrap();
                    done(p).unwrap();
                    assert_eq!(
                        fs::read_to_string(moved_dir.join("note.md")).unwrap(),
                        "changed note\n",
                        "{alias}"
                    );
                }
            }
        }
    }

    #[test]
    fn phase08_16_proposal_apply_error_and_unwind_release_admission() {
        let home = Home::new();
        let app = app();
        let handle = app.handle().clone();
        let work = home.root.path().join("work");
        fs::create_dir_all(&work).unwrap();
        fs::write(work.join("note.md"), "stable\n").unwrap();
        let key = work.join("note.md");
        let cwd = text(&work);

        // A typed write conflict releases the lease: the competing rename of
        // the same file then proceeds.
        let conflict = proposal(
            "conflict",
            vec![SkillProposalFile {
                path: "note.md".into(),
                operation: "replace".into(),
                content: Some("changed\n".into()),
                expected_hash: Some("deadbeef".into()),
                diff: None,
            }],
        );
        let conflict_approval = grant(&app, &cwd, &conflict, None);
        assert!(run(ipc::agent_apply_skill_proposal(
            handle.clone(),
            cwd.clone(),
            conflict,
            Some(conflict_approval),
            None,
        ))
        .unwrap_err()
        .starts_with("write_conflict"));
        run(files_ipc::rename_workspace_entry(
            cwd.clone(),
            "note.md".into(),
            "note-moved.md".into(),
        ))
        .unwrap();
        assert_eq!(
            fs::read_to_string(work.join("note-moved.md")).unwrap(),
            "stable\n"
        );
        fs::rename(work.join("note-moved.md"), &key).unwrap();

        // An unwinding worker releases the admitted set.
        {
            let _panic = PathTransactionTestHook::new(key, "pre-effect", || {
                panic!("fixture proposal transaction unwind")
            });
            assert!(run(ipc::agent_apply_skill_proposal(
                handle.clone(),
                cwd.clone(),
                proposal("x", vec![file("note.md", "replace", Some("unwind\n"))]),
                Some(grant(
                    &app,
                    &(cwd.clone()),
                    &(proposal("x", vec![file("note.md", "replace", Some("unwind\n"))])),
                    None
                )),
                None,
            ))
            .unwrap_err()
            .starts_with("agent_apply_skill_proposal_task_failed:"));
        }
        let report = run(ipc::agent_apply_skill_proposal(
            handle,
            cwd.clone(),
            proposal("x", vec![file("note.md", "replace", Some("recovered\n"))]),
            Some(grant(
                &app,
                &(cwd),
                &(proposal("x", vec![file("note.md", "replace", Some("recovered\n"))])),
                None,
            )),
            None,
        ))
        .unwrap();
        assert_eq!(report.writes.len(), 1);
    }
}
