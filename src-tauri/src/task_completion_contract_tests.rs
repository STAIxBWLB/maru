//! T1 contract fixtures; the completion implementation is deliberately added later.
use crate::agent_host::contracts::SKILL_PROPOSAL_SCHEMA_VERSION;
use crate::agent_host::proposal::{apply_skill_proposal, SkillProposal, SkillProposalFile};
use crate::agent_host::provider::CliProviderKind;
use crate::approval::{ApprovalDecision, ApprovalState};
use crate::atomic_file::phase08_06::Home;
use crate::scratchpad::phase08_08::registry;
use crate::task_completion as completion;
use crate::task_execution_claims::TaskExecutionToken;
use crate::task_execution_runtime::TaskExecutionSession;
use serde_json::json;
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::Manager;

const TASK: &str = "tasks/active/task.md";
const CREATOR: &str = "completion-creator";

#[cfg(unix)]
#[test]
fn completion_control_namespace_refuses_physical_aliases() {
    let temp = tempfile::tempdir().unwrap();
    let work = fs::canonicalize(temp.path()).unwrap();
    for (name, alias) in [
        ("task-completion", "evidence-link"),
        ("task-execution", "claims-link"),
    ] {
        fs::create_dir_all(work.join(".maru").join(name)).unwrap();
        std::os::unix::fs::symlink(work.join(".maru").join(name), work.join(alias)).unwrap();
        let destination = work.join(alias).join("new-record.json");
        assert!(
            completion::guard_managed_task_write(&work, &destination, None, Some("{}")).is_err()
        );
        assert!(!destination.exists());
    }
    let foreign = work.join("other-workspace");
    fs::create_dir_all(foreign.join(".maru/task-completion/receipts")).unwrap();
    std::os::unix::fs::symlink(&foreign, work.join("shared")).unwrap();
    let destination = work.join("shared/.maru/task-completion/receipts/forged.json");
    assert!(completion::guard_managed_task_write(&work, &destination, None, Some("{}")).is_err());
    assert!(!destination.exists());
}

#[test]
fn completion_ac3_terminal_claim_repairs_interrupted_process_sidecar_publication() {
    let f = Fixture::new();
    f.creator("request-process-gap", CREATOR);
    f.apply(CREATOR);
    let receipt = walkdir::WalkDir::new(f.work.join(".maru/task-completion/receipts"))
        .into_iter()
        .map(Result::unwrap)
        .find(|entry| entry.file_type().is_file())
        .unwrap()
        .into_path();
    let mut stale: serde_json::Value =
        serde_json::from_slice(&fs::read(&receipt).unwrap()).unwrap();
    // Model the crash after the exact claim's native wait result was committed
    // but before its optional completion sidecar was published.
    stale["processFinished"] = json!(false);
    stale["processSuccess"] = json!(false);
    fs::write(&receipt, serde_json::to_vec(&stale).unwrap()).unwrap();
    let source_before = fs::read(f.work.join(TASK)).unwrap();
    let view = completion::view(&f.work, TASK).unwrap();
    assert!(view.can_review);
    assert!(
        !view.can_accept,
        "repair never grants review or person acceptance"
    );
    assert_eq!(fs::read(f.work.join(TASK)).unwrap(), source_before);
    let repaired: serde_json::Value = serde_json::from_slice(&fs::read(receipt).unwrap()).unwrap();
    assert_eq!(repaired["processFinished"], true);
    assert_eq!(repaired["processSuccess"], true);
}

struct Fixture {
    app: tauri::App<tauri::test::MockRuntime>,
    work: PathBuf,
    _home: Home,
}
impl Fixture {
    fn new() -> Self {
        let home = Home::new();
        let work = home.root.path().join("work");
        fs::create_dir_all(work.join("tasks/active")).unwrap();
        fs::write(
            work.join(TASK),
            "---\ntitle: Completion\nstatus: active\n---\n# Task\n",
        )
        .unwrap();
        registry(&work, "direct");
        let app = tauri::test::mock_app();
        app.manage(ApprovalState::default());
        let f = Self {
            app,
            work,
            _home: home,
        };
        let revision =
            crate::document::revision_for(&fs::read_to_string(f.work.join(TASK)).unwrap());
        completion::set_policy(&f.work, TASK, true, &revision).unwrap();
        f
    }
    fn state(&self) -> tauri::State<'_, ApprovalState> {
        self.app.state()
    }
    fn creator(&self, request_id: &str, run_id: &str) -> TaskExecutionToken {
        let source = fs::read_to_string(self.work.join(TASK)).unwrap();
        let metadata = json!({"actor":"human", "principal":"claude", "taskExecution": {
            "requestId":request_id,"taskPath":TASK,"sourceRevision":crate::document::revision_for(&source)
        }});
        let (session, replayed) = TaskExecutionSession::admit_recorded(
            self.work.to_str().unwrap(),
            Some(&metadata),
            run_id,
            CliProviderKind::Codex,
        )
        .unwrap()
        .unwrap();
        assert!(!replayed);
        // Keep the fixture child alive until native process ownership is recorded.
        let mut child = session
            .spawn_child(|| {
                Command::new(crate::test_support::posix_shell())
                    .args(["-c", "read line"])
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .spawn()
                    .map_err(|e| e.to_string())
            })
            .unwrap();
        child.stdin.take().unwrap().write_all(b"done\n").unwrap();
        let pid = child.id();
        let status = child.wait().unwrap();
        session.child_reaped(pid).unwrap();
        session.finish(status.success(), status.code()).unwrap();
        session.token
    }
    fn proposal(path: &str, operation: &str, expected_hash: Option<String>) -> SkillProposal {
        SkillProposal {
            summary: "Reviewed output".into(),
            schema_version: SKILL_PROPOSAL_SCHEMA_VERSION.into(),
            files: vec![SkillProposalFile {
                path: path.into(),
                operation: operation.into(),
                content: Some("{\"result\":\"ok\"}".into()),
                expected_hash,
                diff: None,
            }],
            commands: vec![],
            risks: vec![],
            requires_approval: true,
        }
    }
    fn apply(&self, run_id: &str) {
        apply_skill_proposal(
            self.work.to_str().unwrap(),
            &Self::proposal("output.json", "create", None),
            Some(run_id),
        )
        .unwrap();
    }
    fn review(
        &self,
        token: &TaskExecutionToken,
        id: &str,
        principal: CliProviderKind,
        passed: bool,
    ) {
        let view = completion::view(&self.work, TASK).unwrap();
        let session = completion::begin_review(
            &self.work,
            token,
            id,
            principal,
            view.binding_revision.as_deref().unwrap(),
            id,
        )
        .unwrap();
        session
            .finish(
                &json!({"passed":passed,"reason":"Checked current source and artifacts"})
                    .to_string(),
                true,
            )
            .unwrap();
    }
    fn approve(&self, token: &TaskExecutionToken) -> (String, String) {
        let view = completion::view(&self.work, TASK).unwrap();
        let review = view.review_revision.unwrap();
        let request =
            completion::prepare_acceptance(&self.state(), &self.work, token, &review).unwrap();
        assert!(!request.auto_approved);
        crate::approval::record_approval(
            self.state(),
            request.id.clone(),
            ApprovalDecision::Approved,
            Some(false),
        )
        .unwrap();
        (request.id, review)
    }
    fn assert_open(&self) {
        assert!(fs::read_to_string(self.work.join(TASK))
            .unwrap()
            .contains("status: active"));
        assert!(!self.work.join("tasks/archive/task.md").exists());
    }
}
fn files(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    fn visit(root: &Path, current: &Path, out: &mut BTreeMap<PathBuf, Vec<u8>>) {
        if !current.exists() {
            return;
        }
        for item in fs::read_dir(current).unwrap() {
            let p = item.unwrap().path();
            if p.is_dir() {
                visit(root, &p, out);
            } else {
                out.insert(
                    p.strip_prefix(root).unwrap().to_path_buf(),
                    fs::read(p).unwrap(),
                );
            }
        }
    }
    let mut out = BTreeMap::new();
    visit(root, root, &mut out);
    out
}

#[test]
fn completion_ac1_failed_review_cannot_finalize() {
    let f = Fixture::new();
    let token = f.creator("creator-request", CREATOR);
    f.apply(CREATOR);
    f.review(&token, "failed-review", CliProviderKind::Claude, false);
    let view = completion::view(&f.work, TASK).unwrap();
    assert!(!view.can_accept);
    assert!(completion::prepare_acceptance(
        &f.state(),
        &f.work,
        &token,
        view.review_revision.as_deref().unwrap()
    )
    .is_err());
    f.assert_open();
}
#[test]
fn completion_ac1_partial_artifact_commit_is_not_reviewable() {
    let f = Fixture::new();
    let token = f.creator("creator-request", CREATOR);
    fs::write(f.work.join("second.json"), "old").unwrap();
    let mut p = Fixture::proposal("output.json", "create", None);
    p.files.push(
        Fixture::proposal("second.json", "replace", Some("wrong-revision".into()))
            .files
            .remove(0),
    );
    assert!(apply_skill_proposal(f.work.to_str().unwrap(), &p, Some(CREATOR)).is_err());
    assert!(f.work.join("output.json").is_file());
    let view = completion::view(&f.work, TASK).unwrap();
    assert!(!view.can_review);
    assert!(completion::begin_review(
        &f.work,
        &token,
        "review",
        CliProviderKind::Claude,
        view.binding_revision.as_deref().unwrap_or(""),
        "request"
    )
    .is_err());
    f.assert_open();
}
#[test]
fn completion_ac2_artifact_drift_requires_a_new_review() {
    let f = Fixture::new();
    let token = f.creator("creator-request", CREATOR);
    f.apply(CREATOR);
    f.review(&token, "review-1", CliProviderKind::Claude, true);
    let (approval, revision) = f.approve(&token);
    fs::write(f.work.join("output.json"), "{\"result\":\"edited\"}").unwrap();
    assert!(completion::finalize(&f.state(), &f.work, &token, &approval, &revision).is_err());
    f.assert_open();
    f.review(&token, "review-2", CliProviderKind::Claude, true);
    let (approval, revision) = f.approve(&token);
    let result = completion::finalize(&f.state(), &f.work, &token, &approval, &revision).unwrap();
    assert_eq!(result.task.rel_path, "tasks/archive/task.md");
}
#[test]
fn completion_ac2_source_drift_requires_a_new_review() {
    let f = Fixture::new();
    let token = f.creator("creator-request", CREATOR);
    f.apply(CREATOR);
    f.review(&token, "review-1", CliProviderKind::Claude, true);
    let (approval, revision) = f.approve(&token);
    let before = fs::read_to_string(f.work.join(TASK)).unwrap();
    crate::document::save_document(
        f.work.to_string_lossy().into(),
        TASK.into(),
        before.replace("# Task", "# Changed task"),
        Some(crate::document::revision_for(&before)),
    )
    .unwrap();
    assert!(completion::finalize(&f.state(), &f.work, &token, &approval, &revision).is_err());
    f.review(&token, "review-2", CliProviderKind::Claude, true);
    let (approval, revision) = f.approve(&token);
    completion::finalize(&f.state(), &f.work, &token, &approval, &revision).unwrap();
}
#[test]
fn completion_ac2_new_generation_refuses_old_review_and_acceptance() {
    let f = Fixture::new();
    let old = f.creator("creator-request", CREATOR);
    f.apply(CREATOR);
    f.review(&old, "review-1", CliProviderKind::Claude, true);
    let (approval, revision) = f.approve(&old);
    let current = f.creator("new-request", "new-creator");
    assert!(current.generation > old.generation);
    assert!(completion::finalize(&f.state(), &f.work, &old, &approval, &revision).is_err());
    f.assert_open();
}
#[test]
fn completion_ac3_duplicate_and_restart_preserve_one_terminal_effect() {
    let f = Fixture::new();
    let token = f.creator("creator-request", CREATOR);
    f.apply(CREATOR);
    f.review(&token, "review", CliProviderKind::Claude, true);
    let (approval, revision) = f.approve(&token);
    let first = completion::finalize(&f.state(), &f.work, &token, &approval, &revision).unwrap();
    assert!(!first.duplicate);
    let snapshots = files(&f.work.join(".maru/versions"));
    assert!(!snapshots.is_empty());
    let evidence = files(&f.work.join(".maru/task-completion"));
    let fresh_state = ApprovalState::default();
    let replay = completion::finalize(&fresh_state, &f.work, &token, &approval, &revision).unwrap();
    assert!(replay.duplicate);
    assert_eq!(replay.task.rel_path, first.task.rel_path);
    assert_eq!(files(&f.work.join(".maru/versions")), snapshots);
    assert_eq!(files(&f.work.join(".maru/task-completion")), evidence);
    assert!(!f.work.join(TASK).exists());
    assert!(f.work.join("tasks/archive/task.md").is_file());
    assert!(!f.work.join("tasks/archive/task-2.md").exists());
}
#[test]
fn completion_ac3_concurrent_finalize_has_one_effect() {
    let f = Fixture::new();
    let token = f.creator("creator-request", CREATOR);
    f.apply(CREATOR);
    f.review(&token, "review", CliProviderKind::Claude, true);
    let (approval, revision) = f.approve(&token);
    let state = f.state().inner().clone();
    let work = f.work.clone();
    let results = std::thread::scope(|scope| {
        let a = scope.spawn(|| completion::finalize(&state, &work, &token, &approval, &revision));
        let b = scope.spawn(|| completion::finalize(&state, &work, &token, &approval, &revision));
        [a.join().unwrap().unwrap(), b.join().unwrap().unwrap()]
    });
    assert_eq!(results.iter().filter(|r| !r.duplicate).count(), 1);
    assert_eq!(results[0].task.rel_path, results[1].task.rel_path);
}
#[test]
fn completion_ac4_creator_principal_is_not_a_reviewer_even_in_a_new_run() {
    let f = Fixture::new();
    let token = f.creator("creator-request", CREATOR);
    f.apply(CREATOR);
    let view = completion::view(&f.work, TASK).unwrap();
    assert_eq!(view.creator_principal.as_deref(), Some("codex"));
    assert!(completion::begin_review(
        &f.work,
        &token,
        "totally-new-run",
        CliProviderKind::Codex,
        view.binding_revision.as_deref().unwrap(),
        "new-request"
    )
    .is_err());
    f.assert_open();
}
#[test]
fn completion_ac4_review_approval_never_finalizes_without_fresh_person_confirmation() {
    let f = Fixture::new();
    let token = f.creator("creator-request", CREATOR);
    f.apply(CREATOR);
    f.review(&token, "review", CliProviderKind::Claude, true);
    f.assert_open();
    let view = completion::view(&f.work, TASK).unwrap();
    assert!(view.can_accept);
    assert!(completion::finalize(
        &f.state(),
        &f.work,
        &token,
        "forged-human-approval",
        view.review_revision.as_deref().unwrap()
    )
    .is_err());
    let request = completion::prepare_acceptance(
        &f.state(),
        &f.work,
        &token,
        view.review_revision.as_deref().unwrap(),
    )
    .unwrap();
    // A prepared request is not a person's decision, including after restart.
    assert!(completion::finalize(
        &ApprovalState::default(),
        &f.work,
        &token,
        &request.id,
        view.review_revision.as_deref().unwrap()
    )
    .is_err());
    f.assert_open();
}
#[test]
fn completion_ac4_policy_fields_cannot_be_changed_through_generic_document_save() {
    let f = Fixture::new();
    let before = fs::read_to_string(f.work.join(TASK)).unwrap();
    let result = crate::document::save_document(
        f.work.to_string_lossy().into(),
        TASK.into(),
        before.replace(
            "maruCompletionRequired: true",
            "maruCompletionRequired: false",
        ),
        Some(crate::document::revision_for(&before)),
    );
    assert!(result.is_err());
    assert_eq!(fs::read_to_string(f.work.join(TASK)).unwrap(), before);
}

#[test]
fn completion_ac2_replacing_review_revision_invalidates_old_acceptance() {
    let f = Fixture::new();
    let token = f.creator("creator-request", CREATOR);
    f.apply(CREATOR);
    f.review(&token, "review-1", CliProviderKind::Claude, true);
    let (approval, revision) = f.approve(&token);
    f.review(&token, "review-2", CliProviderKind::Claude, true);
    assert_ne!(
        completion::view(&f.work, TASK)
            .unwrap()
            .review_revision
            .as_deref(),
        Some(revision.as_str())
    );
    assert!(completion::finalize(&f.state(), &f.work, &token, &approval, &revision).is_err());
    f.assert_open();
}
#[test]
fn completion_ac2_policy_off_on_does_not_revive_a_review() {
    let f = Fixture::new();
    let token = f.creator("creator-request", CREATOR);
    f.apply(CREATOR);
    f.review(&token, "review", CliProviderKind::Claude, true);
    let (approval, revision) = f.approve(&token);
    let source = completion::view(&f.work, TASK).unwrap().source_revision;
    completion::set_policy(&f.work, TASK, false, &source).unwrap();
    let source = completion::view(&f.work, TASK).unwrap().source_revision;
    completion::set_policy(&f.work, TASK, true, &source).unwrap();
    assert!(completion::finalize(&f.state(), &f.work, &token, &approval, &revision).is_err());
    f.assert_open();
}
#[test]
fn completion_ac3_restart_recovers_only_an_already_written_terminal_effect() {
    let f = Fixture::new();
    let token = f.creator("creator-request", CREATOR);
    f.apply(CREATOR);
    f.review(&token, "review", CliProviderKind::Claude, true);
    let (approval, revision) = f.approve(&token);
    *completion::AFTER_TASK_EFFECT_FAILURE.lock().unwrap() = Some(f.work.clone());
    assert!(completion::finalize(&f.state(), &f.work, &token, &approval, &revision).is_err());
    assert!(fs::read_to_string(f.work.join("tasks/archive/task.md"))
        .unwrap()
        .contains("status: done"));
    let snapshots = files(&f.work.join(".maru/versions"));
    let replay = completion::finalize(
        &ApprovalState::default(),
        &f.work,
        &token,
        &approval,
        &revision,
    )
    .unwrap();
    assert!(replay.duplicate);
    assert!(replay.receipt.acceptance.is_some());
    assert_eq!(files(&f.work.join(".maru/versions")), snapshots);
}

fn completion_review_r5_interrupted_before_archive() -> (Fixture, TaskExecutionToken, String, String)
{
    let f = Fixture::new();
    let token = f.creator("creator-request", CREATOR);
    f.apply(CREATOR);
    f.review(&token, "review", CliProviderKind::Claude, true);
    let (approval, revision) = f.approve(&token);
    *completion::AFTER_DONE_WRITE_FAILURE.lock().unwrap() = Some(f.work.clone());
    let error = completion::finalize(&f.state(), &f.work, &token, &approval, &revision)
        .err()
        .unwrap();
    assert!(error
        .message
        .contains("archive publication was interrupted"));
    assert!(fs::read_to_string(f.work.join(TASK))
        .unwrap()
        .contains("status: done"));
    assert!(!f.work.join("tasks/archive/task.md").exists());
    (f, token, approval, revision)
}

#[test]
fn completion_review_r5_restart_reconciles_done_bytes_before_archive_rename() {
    let (f, token, approval, revision) = completion_review_r5_interrupted_before_archive();
    let done = fs::read(f.work.join(TASK)).unwrap();
    let snapshots = files(&f.work.join(".maru/versions"));
    let restarted = ApprovalState::default();
    let view = serde_json::to_value(completion::view(&f.work, TASK).unwrap()).unwrap();
    assert_eq!(view["resumeAcceptance"]["approvalId"], approval);
    assert_eq!(view["resumeAcceptance"]["reviewRevision"], revision);
    assert_eq!(
        fs::read(f.work.join(TASK)).unwrap(),
        done,
        "readback must not publish Archive"
    );
    assert!(!f.work.join("tasks/archive/task.md").exists());
    let recovered =
        completion::finalize(&restarted, &f.work, &token, &approval, &revision).unwrap();
    assert!(recovered.duplicate);
    assert!(!f.work.join(TASK).exists());
    assert_eq!(
        fs::read(f.work.join("tasks/archive/task.md")).unwrap(),
        done
    );
    assert_eq!(files(&f.work.join(".maru/versions")), snapshots);
    let receipt = serde_json::to_value(&recovered.receipt).unwrap();
    assert_eq!(receipt["acceptance"]["completed"], true);
    assert!(
        completion::finalize(&restarted, &f.work, &token, &approval, &revision)
            .unwrap()
            .duplicate
    );
    assert_eq!(files(&f.work.join(".maru/versions")), snapshots);
}

#[test]
fn completion_review_r5_changed_intermediate_source_is_never_archived() {
    let (f, token, approval, revision) = completion_review_r5_interrupted_before_archive();
    let changed = fs::read_to_string(f.work.join(TASK)).unwrap() + "\nUnreviewed edit\n";
    fs::write(f.work.join(TASK), &changed).unwrap();
    assert!(completion::finalize(
        &ApprovalState::default(),
        &f.work,
        &token,
        &approval,
        &revision
    )
    .is_err());
    assert_eq!(fs::read_to_string(f.work.join(TASK)).unwrap(), changed);
    assert!(!f.work.join("tasks/archive/task.md").exists());
}

#[test]
fn completion_review_r5_changed_artifact_is_never_recovered_as_accepted() {
    let (f, token, approval, revision) = completion_review_r5_interrupted_before_archive();
    let done = fs::read(f.work.join(TASK)).unwrap();
    fs::write(f.work.join("output.json"), "unreviewed artifact").unwrap();
    assert!(completion::finalize(
        &ApprovalState::default(),
        &f.work,
        &token,
        &approval,
        &revision
    )
    .is_err());
    assert_eq!(fs::read(f.work.join(TASK)).unwrap(), done);
    assert!(!f.work.join("tasks/archive/task.md").exists());
}

#[test]
fn completion_review_r5_occupied_archive_is_never_overwritten() {
    let (f, token, approval, revision) = completion_review_r5_interrupted_before_archive();
    let done = fs::read(f.work.join(TASK)).unwrap();
    let target = f.work.join("tasks/archive/task.md");
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    fs::write(&target, "unrelated existing task").unwrap();
    assert!(completion::finalize(
        &ApprovalState::default(),
        &f.work,
        &token,
        &approval,
        &revision
    )
    .is_err());
    assert_eq!(fs::read(f.work.join(TASK)).unwrap(), done);
    assert_eq!(
        fs::read_to_string(target).unwrap(),
        "unrelated existing task"
    );
}

#[test]
fn completion_review_r5_missing_consumed_audit_cannot_resume() {
    let (f, token, approval, revision) = completion_review_r5_interrupted_before_archive();
    let done = fs::read(f.work.join(TASK)).unwrap();
    fs::remove_file(crate::approval::audit_path(f.work.to_str().unwrap(), &approval).unwrap())
        .unwrap();
    assert!(completion::finalize(
        &ApprovalState::default(),
        &f.work,
        &token,
        &approval,
        &revision
    )
    .is_err());
    assert_eq!(fs::read(f.work.join(TASK)).unwrap(), done);
    assert!(!f.work.join("tasks/archive/task.md").exists());
}

#[cfg(unix)]
#[test]
fn completion_review_r5_dangling_archive_link_is_occupied() {
    let (f, token, approval, revision) = completion_review_r5_interrupted_before_archive();
    let target = f.work.join("tasks/archive/task.md");
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink("missing.md", &target).unwrap();
    let done = fs::read(f.work.join(TASK)).unwrap();
    assert!(completion::finalize(
        &ApprovalState::default(),
        &f.work,
        &token,
        &approval,
        &revision
    )
    .is_err());
    assert_eq!(fs::read(f.work.join(TASK)).unwrap(), done);
    assert_eq!(fs::read_link(&target).unwrap(), PathBuf::from("missing.md"));
}

#[test]
fn completion_review_r5_retargeted_intent_cannot_reuse_consumed_audit() {
    let (f, token, approval, revision) = completion_review_r5_interrupted_before_archive();
    let done = fs::read_to_string(f.work.join(TASK)).unwrap();
    let target = f.work.join("tasks/archive/task.md");
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    fs::write(&target, "unrelated task").unwrap();
    let alternate = crate::tasks::prepare_task_completion(
        &f.work,
        &f.work.join("tasks"),
        &f.work.join(TASK),
        &done,
    )
    .unwrap()
    .target;
    let receipt = walkdir::WalkDir::new(f.work.join(".maru/task-completion/receipts"))
        .into_iter()
        .map(Result::unwrap)
        .find(|entry| entry.file_type().is_file())
        .unwrap()
        .into_path();
    let mut journal: serde_json::Value =
        serde_json::from_slice(&fs::read(&receipt).unwrap()).unwrap();
    journal["acceptance"]["targetPath"] =
        json!(alternate.strip_prefix(&f.work).unwrap().to_str().unwrap());
    fs::write(receipt, serde_json::to_vec(&journal).unwrap()).unwrap();
    assert!(completion::finalize(
        &ApprovalState::default(),
        &f.work,
        &token,
        &approval,
        &revision
    )
    .is_err());
    assert_eq!(fs::read_to_string(f.work.join(TASK)).unwrap(), done);
    assert_eq!(fs::read_to_string(target).unwrap(), "unrelated task");
    assert!(!alternate.exists());
}
