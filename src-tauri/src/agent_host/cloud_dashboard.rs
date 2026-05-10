use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

use crate::agent_host::event_store::{read_run_events, summarize_events, RunReplaySummary};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RedactedRunSummary {
    pub run_id: String,
    pub event_count: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_type: Option<String>,
    pub proposal_count: usize,
    pub write_claimed_count: usize,
    pub write_committed_count: usize,
    pub write_conflict_count: usize,
    #[serde(default)]
    pub providers: Vec<String>,
    #[serde(default)]
    pub skills: Vec<String>,
}

#[tauri::command]
pub fn agent_export_redacted_run_summary(
    cwd: String,
    run_id: String,
) -> Result<RedactedRunSummary, String> {
    export_redacted_run_summary(&cwd, &run_id)
}

pub fn export_redacted_run_summary(cwd: &str, run_id: &str) -> Result<RedactedRunSummary, String> {
    let events = read_run_events(cwd, run_id)?;
    let summary = summarize_events(run_id, &events);
    Ok(redact_summary(
        summary,
        events.iter().map(|event| &event.payload),
    ))
}

fn redact_summary<'a>(
    summary: RunReplaySummary,
    payloads: impl Iterator<Item = &'a JsonValue>,
) -> RedactedRunSummary {
    let mut providers = Vec::new();
    let mut skills = Vec::new();
    for payload in payloads {
        if let Some(provider) = payload
            .get("request")
            .and_then(|request| request.get("runtimeProvider"))
            .or_else(|| payload.get("runtimeProvider"))
            .and_then(|value| value.as_str())
        {
            push_unique(&mut providers, provider);
        }
        if let Some(skill) = payload
            .get("request")
            .and_then(|request| request.get("skillId"))
            .or_else(|| payload.get("skillId"))
            .and_then(|value| value.as_str())
        {
            push_unique(&mut skills, skill);
        }
    }
    RedactedRunSummary {
        run_id: summary.run_id,
        event_count: summary.event_count,
        last_type: summary.last_type,
        proposal_count: summary.proposal_count,
        write_claimed_count: summary.write_claimed_count,
        write_committed_count: summary.write_committed_count,
        write_conflict_count: summary.write_conflict_count,
        providers,
        skills,
    }
}

fn push_unique(values: &mut Vec<String>, value: &str) {
    if !values.iter().any(|existing| existing == value) {
        values.push(value.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_host::contracts::new_run_event;
    use serde_json::json;

    #[test]
    fn redacted_summary_keeps_metadata_not_payload_body() {
        let events = vec![new_run_event(
            "ai-test",
            "run.started",
            "agent",
            json!({
                "request": {
                    "runtimeProvider": "claude",
                    "skillId": "anchor-builtin::meeting-notes",
                    "intent": "secret prompt body"
                }
            }),
            None,
        )];
        let summary = redact_summary(
            summarize_events("ai-test", &events),
            events.iter().map(|e| &e.payload),
        );
        assert_eq!(summary.providers, vec!["claude"]);
        assert_eq!(summary.skills, vec!["anchor-builtin::meeting-notes"]);
    }
}
