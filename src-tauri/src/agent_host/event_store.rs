use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use crate::agent_host::contracts::{new_run_event, AgentRunEvent};
use crate::vault::normalize_existing_dir;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunReplaySummary {
    pub run_id: String,
    pub event_count: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_type: Option<String>,
    pub proposal_count: usize,
    pub write_claimed_count: usize,
    pub write_committed_count: usize,
    pub write_conflict_count: usize,
}

pub fn run_events_path(cwd: &str, run_id: &str) -> Result<PathBuf, String> {
    validate_run_id(run_id)?;
    let root = normalize_existing_dir(cwd)?;
    Ok(root
        .join(".anchor")
        .join("runs")
        .join("skills")
        .join(run_id)
        .join("events.jsonl"))
}

pub fn append_run_event(cwd: &str, event: &AgentRunEvent) -> Result<(), String> {
    validate_run_id(&event.run_id)?;
    let path = run_events_path(cwd, &event.run_id)?;
    append_run_event_at(&path, event)
}

pub fn append_run_event_at(path: &Path, event: &AgentRunEvent) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Cannot create run event directory: {err}"))?;
    }
    let json =
        serde_json::to_string(event).map_err(|err| format!("Cannot serialize run event: {err}"))?;
    let line = format!("{json}\n");
    let append_lock = append_lock_for(path)?;
    let _guard = append_lock
        .lock()
        .map_err(|_| "run_event_append_lock_poisoned".to_string())?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|err| format!("Cannot open run event log: {err}"))?;
    file.write_all(line.as_bytes())
        .map_err(|err| format!("Cannot append run event: {err}"))
}

pub fn append_run_event_payload(
    cwd: &str,
    run_id: &str,
    event_type: &str,
    actor: &str,
    payload: serde_json::Value,
) -> Result<AgentRunEvent, String> {
    let event = new_run_event(run_id, event_type, actor, payload, None);
    append_run_event(cwd, &event)?;
    Ok(event)
}

#[tauri::command]
pub fn agent_read_run_events(cwd: String, run_id: String) -> Result<Vec<AgentRunEvent>, String> {
    read_run_events(&cwd, &run_id)
}

#[tauri::command]
pub fn agent_replay_run_summary(cwd: String, run_id: String) -> Result<RunReplaySummary, String> {
    replay_run_summary(&cwd, &run_id)
}

pub fn read_run_events(cwd: &str, run_id: &str) -> Result<Vec<AgentRunEvent>, String> {
    validate_run_id(run_id)?;
    let path = run_events_path(cwd, run_id)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    read_run_events_at(&path)
}

pub fn read_run_events_at(path: &Path) -> Result<Vec<AgentRunEvent>, String> {
    let file = fs::File::open(path).map_err(|err| format!("Cannot read run event log: {err}"))?;
    let reader = BufReader::new(file);
    let mut events = Vec::new();
    for (line_no, line) in reader.lines().enumerate() {
        let line = line.map_err(|err| format!("Cannot read run event line: {err}"))?;
        if line.trim().is_empty() {
            continue;
        }
        let event: AgentRunEvent = serde_json::from_str(&line).map_err(|err| {
            format!(
                "Cannot parse run event {} in {}: {err}",
                line_no + 1,
                path.display()
            )
        })?;
        events.push(event);
    }
    Ok(events)
}

pub fn replay_run_summary(cwd: &str, run_id: &str) -> Result<RunReplaySummary, String> {
    let events = read_run_events(cwd, run_id)?;
    Ok(summarize_events(run_id, &events))
}

pub fn summarize_events(run_id: &str, events: &[AgentRunEvent]) -> RunReplaySummary {
    RunReplaySummary {
        run_id: run_id.to_string(),
        event_count: events.len(),
        last_type: events.last().map(|event| event.event_type.clone()),
        proposal_count: events
            .iter()
            .filter(|event| event.event_type == "proposal.created")
            .count(),
        write_claimed_count: events
            .iter()
            .filter(|event| event.event_type == "write.claimed")
            .count(),
        write_committed_count: events
            .iter()
            .filter(|event| event.event_type == "write.committed")
            .count(),
        write_conflict_count: events
            .iter()
            .filter(|event| event.event_type == "write.conflict")
            .count(),
    }
}

pub fn validate_run_id(run_id: &str) -> Result<(), String> {
    if run_id.is_empty()
        || !run_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err("agent_run_id_invalid".to_string());
    }
    Ok(())
}

fn append_lock_for(path: &Path) -> Result<Arc<Mutex<()>>, String> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    let key = path.to_path_buf();
    let mut locks = LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "run_event_lock_registry_poisoned".to_string())?;
    Ok(locks
        .entry(key)
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    #[test]
    fn append_and_replay_event_log() {
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path().to_string_lossy().to_string();
        let event = new_run_event("ai-test", "proposal.created", "test", json!({}), None);
        append_run_event(&cwd, &event).unwrap();
        let events = read_run_events(&cwd, "ai-test").unwrap();
        assert_eq!(events.len(), 1);
        let summary = replay_run_summary(&cwd, "ai-test").unwrap();
        assert_eq!(summary.proposal_count, 1);
        assert_eq!(summary.last_type.as_deref(), Some("proposal.created"));
    }
}
