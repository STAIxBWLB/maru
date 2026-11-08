//! Opt-in invocation linkage; no prompts, environment or credentials enter a claim.
use std::path::{Path, PathBuf};

use crate::agent_host::contracts::TaskExecutionRequest;
use crate::task_execution_claims::{self as claims, TaskExecutionToken};

#[derive(Debug, Clone)]
pub(crate) struct TaskExecutionSession {
    work: PathBuf,
    pub token: TaskExecutionToken,
}

impl TaskExecutionSession {
    pub fn admit(
        cwd: &str,
        metadata: Option<&serde_json::Value>,
        run_id: &str,
    ) -> Result<Option<(Self, bool)>, String> {
        let Some(request) = TaskExecutionRequest::from_metadata(metadata)? else {
            return Ok(None);
        };
        let admission = claims::acquire(Path::new(cwd), &request, run_id)?;
        Ok(Some((
            Self {
                work: PathBuf::from(&admission.claim.workspace),
                token: admission.claim.token(),
            },
            admission.replayed,
        )))
    }

    pub fn workspace(&self) -> &Path {
        &self.work
    }

    pub fn check(&self) -> Result<(), String> {
        claims::check(&self.work, &self.token).map(|_| ())
    }

    pub fn spawn_child(
        &self,
        spawn: impl FnOnce() -> Result<std::process::Child, String>,
    ) -> Result<std::process::Child, String> {
        claims::spawn_owned_child(&self.work, &self.token, spawn)
    }

    /// Called only after successfully waiting on the Child handle owned here.
    pub fn child_reaped(&self, pid: u32) -> Result<(), String> {
        claims::record_reaped_child(&self.work, &self.token, pid).map(|_| ())
    }

    pub fn finish(&self, success: bool, exit_code: Option<i32>) -> Result<(), String> {
        claims::finish(&self.work, &self.token, success, exit_code).map(|_| ())
    }

    pub fn admission_failed(&self) {
        if let Err(error) = claims::cancel_admission(&self.work, &self.token) {
            eprintln!(
                "maru: task execution admission {} needs review: {error}",
                self.token.run_id
            );
        }
    }

    pub fn metadata(&self) -> serde_json::Value {
        serde_json::json!({
            "taskId": self.token.task_id,
            "requestId": self.token.request_id,
            "runId": self.token.run_id,
            "generation": self.token.generation,
        })
    }
}

/// Mission hydration never interprets an elapsed time or missing in-memory PID
/// as ownership evidence. This runs outside mission/path locks.
pub(crate) fn reconcile_mission(
    metadata: Option<&serde_json::Value>,
) -> Result<Option<claims::TaskExecutionClaim>, String> {
    let Some(metadata) = metadata else {
        return Ok(None);
    };
    let Some(token) = metadata
        .get("taskExecution")
        .filter(|value| !value.is_null())
    else {
        return Ok(None);
    };
    let token: TaskExecutionToken = serde_json::from_value(token.clone()).map_err(|error| format!(
        "task_execution_recovery_invalid: {error}; review the task claim and refresh mission history"
    ))?;
    let work = metadata.get("workspacePath").and_then(serde_json::Value::as_str)
        .ok_or("task_execution_recovery_workspace_missing: no workspace was recorded; review the mission before retrying")?;
    let current = claims::reconcile(Path::new(work), &token.task_id)?;
    current.execution_for_token(&token).map(Some).ok_or_else(||
        "task_execution_recovery_token_missing: the recorded mission token is absent from claim history; review the task claim and mission before retrying".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ordinary_invocations_do_not_touch_the_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path().join("not-created");
        for metadata in [
            None,
            Some(json!({"skillId": "example"})),
            Some(json!({"taskExecution": null})),
        ] {
            assert!(TaskExecutionSession::admit(
                work.to_str().unwrap(),
                metadata.as_ref(),
                "run-1"
            )
            .unwrap()
            .is_none());
        }
        assert!(!work.exists());
        assert!(reconcile_mission(Some(&json!({"taskExecution": null}))).is_ok());
    }

    #[test]
    fn invalid_opt_in_is_rejected_before_filesystem_effects() {
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path().join("not-created");
        for metadata in [
            json!({"taskExecution": {"requestId": "r", "taskPath": "tasks/active/t.md"}}),
            json!({"taskExecution": {"requestId": "../r", "taskPath": "tasks/active/t.md", "sourceRevision": "revision"}}),
            json!({"taskExecution": {"requestId": "r", "taskPath": "tasks/active/t.md", "sourceRevision": "revision", "generation": 7}}),
        ] {
            let error =
                TaskExecutionSession::admit(work.to_str().unwrap(), Some(&metadata), "run-1")
                    .unwrap_err();
            assert!(error.contains("task_execution_request_invalid"), "{error}");
            assert!(error.contains("retry"), "{error}");
        }
        assert!(!work.exists());
    }
}
