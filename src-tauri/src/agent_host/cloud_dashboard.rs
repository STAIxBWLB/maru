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

/// Build the redacted summary and write it as pretty JSON to `target_path`
/// (creating parent directories). Returns the written path. The UI uses this to
/// "Export redacted summary" — there is no JS-side file write, so the bytes are
/// produced here, server-side.
#[tauri::command]
pub fn agent_write_redacted_run_summary(
    cwd: String,
    run_id: String,
    target_path: String,
) -> Result<String, String> {
    if target_path.trim().is_empty() {
        return Err("redacted_summary_target_required".to_string());
    }
    let summary = export_redacted_run_summary(&cwd, &run_id)?;
    let json = serde_json::to_string_pretty(&summary)
        .map_err(|err| format!("redacted_summary_serialize_failed: {err}"))?;
    let path = std::path::Path::new(&target_path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("redacted_summary_dir_failed: {err}"))?;
    }
    std::fs::write(path, json.as_bytes())
        .map_err(|err| format!("redacted_summary_write_failed: {err}"))?;
    Ok(target_path)
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

    #[test]
    fn redacted_summary_reads_top_level_runtime_provider() {
        // The structured-loop `run.started` payload carries `runtimeProvider` at
        // the top level (not nested under `request`).
        let events = vec![new_run_event(
            "ai-loop",
            "run.started",
            "anchor.structured_loop",
            json!({ "runtimeProvider": "codex", "directive": "secret directive" }),
            None,
        )];
        let summary = redact_summary(
            summarize_events("ai-loop", &events),
            events.iter().map(|e| &e.payload),
        );
        assert_eq!(summary.providers, vec!["codex"]);
    }

    #[test]
    fn write_redacted_summary_emits_json_file() {
        use crate::agent_host::event_store::append_run_event;
        let tmp = tempfile::TempDir::new().unwrap();
        let cwd = tmp.path().to_string_lossy().to_string();
        append_run_event(
            &cwd,
            &new_run_event(
                "ai-export",
                "run.started",
                "anchor.structured_loop",
                json!({ "runtimeProvider": "codex" }),
                None,
            ),
        )
        .unwrap();
        append_run_event(
            &cwd,
            &new_run_event("ai-export", "proposal.created", "anchor.structured_loop", json!({}), None),
        )
        .unwrap();
        let target = tmp.path().join("export").join("summary.json");
        let written = agent_write_redacted_run_summary(
            cwd,
            "ai-export".to_string(),
            target.to_string_lossy().to_string(),
        )
        .unwrap();
        assert_eq!(written, target.to_string_lossy());
        let parsed: RedactedRunSummary =
            serde_json::from_str(&std::fs::read_to_string(&target).unwrap()).unwrap();
        assert_eq!(parsed.run_id, "ai-export");
        assert_eq!(parsed.proposal_count, 1);
        assert_eq!(parsed.providers, vec!["codex"]);
    }
}
