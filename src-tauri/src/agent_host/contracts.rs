use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use uuid::Uuid;

pub const AGENT_RUN_REQUEST_SCHEMA_VERSION: &str = "anchor_agent_run_request_v1";
pub const AGENT_RUN_EVENT_SCHEMA_VERSION: &str = "anchor_agent_run_event_v1";
pub const COMPLETION_REQUEST_SCHEMA_VERSION: &str = "anchor_completion_request_v1";
pub const COMPLETION_RESPONSE_SCHEMA_VERSION: &str = "anchor_completion_response_v1";
pub const SKILL_PROPOSAL_SCHEMA_VERSION: &str = "anchor_skill_proposal_v1";
pub const PROTECTED_WRITE_CLAIM_SCHEMA_VERSION: &str = "anchor_protected_write_claim_v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunContextItem {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunRequest {
    pub intent: String,
    pub runtime_provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill_id: Option<String>,
    pub cwd: String,
    #[serde(default)]
    pub context: Vec<AgentRunContextItem>,
    pub mode: String,
    pub approval_policy: String,
    pub schema_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<JsonValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunEvent {
    pub id: String,
    pub run_id: String,
    pub ts: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub actor: String,
    pub payload: JsonValue,
    pub schema_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompletionRequest {
    pub schema_version: String,
    pub provider: String,
    pub prompt: String,
    pub cwd: String,
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<JsonValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompletionResponse {
    pub schema_version: String,
    pub provider: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<JsonValue>,
}

impl AgentRunRequest {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != AGENT_RUN_REQUEST_SCHEMA_VERSION {
            return Err(format!(
                "agent_run_request_schema_unsupported: {}",
                self.schema_version
            ));
        }
        if self.intent.trim().is_empty() {
            return Err("agent_run_intent_required".to_string());
        }
        if self.runtime_provider.trim().is_empty() {
            return Err("agent_run_provider_required".to_string());
        }
        if self.cwd.trim().is_empty() {
            return Err("agent_run_cwd_required".to_string());
        }
        if self.mode.trim().is_empty() {
            return Err("agent_run_mode_required".to_string());
        }
        if self.approval_policy.trim().is_empty() {
            return Err("agent_run_approval_policy_required".to_string());
        }
        Ok(())
    }
}

impl CompletionRequest {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != COMPLETION_REQUEST_SCHEMA_VERSION {
            return Err(format!(
                "completion_request_schema_unsupported: {}",
                self.schema_version
            ));
        }
        if self.provider.trim().is_empty() {
            return Err("completion_provider_required".to_string());
        }
        if self.prompt.trim().is_empty() {
            return Err("completion_prompt_required".to_string());
        }
        if self.cwd.trim().is_empty() {
            return Err("completion_cwd_required".to_string());
        }
        Ok(())
    }
}

impl CompletionResponse {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != COMPLETION_RESPONSE_SCHEMA_VERSION {
            return Err(format!(
                "completion_response_schema_unsupported: {}",
                self.schema_version
            ));
        }
        if self.provider.trim().is_empty() {
            return Err("completion_response_provider_required".to_string());
        }
        Ok(())
    }
}

pub fn new_run_event(
    run_id: &str,
    event_type: impl Into<String>,
    actor: impl Into<String>,
    payload: JsonValue,
    parent_id: Option<String>,
) -> AgentRunEvent {
    AgentRunEvent {
        id: format!("event-{}", Uuid::new_v4()),
        run_id: run_id.to_string(),
        ts: Utc::now().to_rfc3339(),
        event_type: event_type.into(),
        actor: actor.into(),
        payload,
        schema_version: AGENT_RUN_EVENT_SCHEMA_VERSION.to_string(),
        parent_id,
    }
}
