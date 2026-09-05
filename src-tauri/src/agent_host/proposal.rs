use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tauri::{AppHandle, Manager};

use crate::agent_host::contracts::SKILL_PROPOSAL_SCHEMA_VERSION;
use crate::agent_host::event_store::{append_run_event_payload_in_transaction, run_events_path};
use crate::agent_host::protected_write::{
    apply_protected_write_claim, ProtectedWriteClaim, ProtectedWriteOutcome,
};
use crate::approval::{require_approval, ApprovalState};
use crate::atomic_file::{with_path_transactions, PathTransactionLease, PathTransactionRequest};

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

pub fn agent_apply_skill_proposal<R: tauri::Runtime>(
    app: AppHandle<R>,
    cwd: String,
    proposal: SkillProposal,
    approval_id: Option<String>,
    run_id: Option<String>,
) -> Result<ProposalApplyReport, String> {
    let approvals = app.state::<ApprovalState>();
    require_approval(&approvals, approval_id, "agent.proposal.apply")?;
    apply_skill_proposal(&cwd, &proposal, run_id.as_deref())
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
    }
    Ok(paths)
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

    fn grant(app: &tauri::App<tauri::test::MockRuntime>) -> String {
        let request = crate::approval::prepare_approval(
            app.state(),
            "agent.proposal.apply".into(),
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
        let approval = grant(&app);
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
        let consumed = grant(&app);
        let first = proposal("x", vec![file("consumed.md", "create", Some("1\n"))]);
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
        assert!(run(ipc::agent_apply_skill_proposal(
            handle,
            cwd,
            stale_hash,
            Some(grant(&app)),
            None,
        ))
        .unwrap_err()
        .starts_with("write_conflict"));
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
                Some(grant(&app)),
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
                let approval = grant(&app);
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
        assert!(run(ipc::agent_apply_skill_proposal(
            handle.clone(),
            cwd.clone(),
            conflict,
            Some(grant(&app)),
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
                Some(grant(&app)),
                None,
            ))
            .unwrap_err()
            .starts_with("agent_apply_skill_proposal_task_failed:"));
        }
        let report = run(ipc::agent_apply_skill_proposal(
            handle,
            cwd,
            proposal("x", vec![file("note.md", "replace", Some("recovered\n"))]),
            Some(grant(&app)),
            None,
        ))
        .unwrap();
        assert_eq!(report.writes.len(), 1);
    }
}
