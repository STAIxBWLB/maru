use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tauri::{AppHandle, Manager};

use crate::agent_host::contracts::SKILL_PROPOSAL_SCHEMA_VERSION;
use crate::agent_host::event_store::append_run_event_payload;
use crate::agent_host::protected_write::{
    apply_protected_write_claim, ProtectedWriteClaim, ProtectedWriteOutcome,
};
use crate::approval::{require_approval, ApprovalState};

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

#[tauri::command]
pub fn agent_parse_skill_proposal(raw: String) -> Result<SkillProposal, String> {
    parse_skill_proposal(&raw)
}

#[tauri::command]
pub fn agent_apply_skill_proposal(
    app: AppHandle,
    cwd: String,
    proposal: SkillProposal,
    approval_id: Option<String>,
    run_id: Option<String>,
) -> Result<ProposalApplyReport, String> {
    let approvals = app.state::<ApprovalState>();
    require_approval(&approvals, approval_id, "agent.proposal.apply")?;
    apply_skill_proposal(&cwd, &proposal, run_id.as_deref())
}

pub fn parse_skill_proposal(raw: &str) -> Result<SkillProposal, String> {
    let json = extract_json_object(raw).ok_or_else(|| "skill_proposal_json_missing".to_string())?;
    let proposal: SkillProposal =
        serde_json::from_str(json).map_err(|err| format!("skill_proposal_json_invalid: {err}"))?;
    proposal.validate()?;
    Ok(proposal)
}

pub fn apply_skill_proposal(
    cwd: &str,
    proposal: &SkillProposal,
    run_id: Option<&str>,
) -> Result<ProposalApplyReport, String> {
    proposal.validate()?;
    let mut writes = Vec::new();
    for file in &proposal.files {
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
            let _ = append_run_event_payload(
                cwd,
                run_id,
                "write.claimed",
                "agent.proposal.apply",
                serde_json::to_value(&claim).unwrap_or(JsonValue::Null),
            );
        }
        match apply_protected_write_claim(cwd, &claim, file.content.as_deref()) {
            Ok(outcome) => {
                if let Some(run_id) = run_id {
                    let _ = append_run_event_payload(
                        cwd,
                        run_id,
                        "write.committed",
                        "agent.proposal.apply",
                        serde_json::to_value(&outcome).unwrap_or(JsonValue::Null),
                    );
                }
                writes.push(outcome);
            }
            Err(err) => {
                if let Some(run_id) = run_id {
                    let _ = append_run_event_payload(
                        cwd,
                        run_id,
                        "write.conflict",
                        "agent.proposal.apply",
                        serde_json::json!({
                            "path": file.path,
                            "error": err,
                        }),
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
}
