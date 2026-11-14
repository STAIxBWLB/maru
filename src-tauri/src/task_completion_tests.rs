use crate::atomic_file::phase08_06::Home;
use crate::scratchpad::phase08_08::registry;
use crate::tasks::{TaskBucket, TaskStatus, UpdateTaskDetailsFields};
use std::fs;
use std::path::{Path, PathBuf};

const TASK_PATH: &str = "tasks/active/task.md";
const ARCHIVED_PATH: &str = "tasks/archive/task.md";

struct Fixture {
    _workspace: tempfile::TempDir,
    work: PathBuf,
    original: String,
}

impl Fixture {
    fn new(home: &Home, completion_required: Option<bool>) -> Self {
        let workspace = tempfile::tempdir_in(home.root.path()).unwrap();
        let work = workspace.path().to_path_buf();
        fs::create_dir_all(work.join("tasks/active")).unwrap();
        fs::create_dir_all(work.join(".maru")).unwrap();
        let opt_in = completion_required
            .map(|required| format!("maruCompletionRequired: {required}\n"))
            .unwrap_or_default();
        let original = format!(
            "---\ntitle: Completion fixture\nstatus: active\npriority: high\n{opt_in}custom: preserved\n---\n# Original body\n"
        );
        // Direct writes are fixture seeding only. Every attempted transition
        // below goes through an existing production mutation entry point.
        fs::write(work.join(TASK_PATH), &original).unwrap();
        registry(&work, "direct");
        Self {
            _workspace: workspace,
            work,
            original,
        }
    }

    fn work_path(&self) -> String {
        self.work.to_string_lossy().into_owned()
    }

    fn assert_task_untouched(&self) {
        assert_eq!(
            fs::read_to_string(self.work.join(TASK_PATH)).unwrap(),
            self.original,
            "refusing unreviewed completion must preserve the exact task bytes"
        );
        assert!(
            !self.work.join(ARCHIVED_PATH).exists(),
            "refusing completion must not publish an archived task"
        );
        assert!(
            !self.work.join(".maru/versions").exists(),
            "completion evidence must be checked before creating a snapshot"
        );
    }
}

fn done_details() -> UpdateTaskDetailsFields {
    UpdateTaskDetailsFields {
        title: Some("Changed title".into()),
        status: Some(TaskStatus::Done),
        project: None,
        priority: None,
        due: None,
        calendar_start: None,
        calendar_end: None,
        estimate_minutes: None,
        body: Some("# Changed body\n".into()),
    }
}

fn complete_today(
    fixture: &Fixture,
) -> Result<crate::today::TaskTransitionOutcome, crate::ipc_error::IpcError> {
    crate::today_lifecycle::task_transition(
        fixture.work_path(),
        crate::today::TaskTransitionRequest {
            task_id: "completion-fixture".into(),
            task_path: TASK_PATH.into(),
            kind: crate::today::TaskTransitionKind::Complete,
            expected_task_hash: crate::document::revision_for(&fixture.original),
            defer_date: None,
            date: Some("2026-11-14".into()),
            now_iso: Some("2026-11-14T10:00:00+09:00".into()),
            web_action_id: None,
            payload: serde_json::json!({}),
        },
    )
}

fn link_google_task(fixture: &mut Fixture) {
    fixture.original = fixture.original.replace(
        "custom: preserved",
        "googleTaskId: synthetic-google-task\ngoogleTaskListId: synthetic-list\ncustom: preserved",
    );
    fs::write(fixture.work.join(TASK_PATH), &fixture.original).unwrap();
}

#[test]
fn completion_required_today_complete_is_refused_before_effects() {
    let home = Home::new();
    let fixture = Fixture::new(&home, Some(true));
    let result = complete_today(&fixture);
    assert!(
        result.is_err(),
        "Today bypassed completion evidence: {result:?}"
    );
    fixture.assert_task_untouched();
    assert!(crate::today_outbox::list_records(&fixture.work)
        .unwrap()
        .is_empty());
    assert!(!fixture.work.join(".maru/today").exists());
}

#[test]
fn completion_required_linked_today_complete_creates_no_provider_outbox() {
    let home = Home::new();
    let mut fixture = Fixture::new(&home, Some(true));
    link_google_task(&mut fixture);
    let result = complete_today(&fixture);
    assert!(
        result.is_err(),
        "linked Today bypassed completion evidence: {result:?}"
    );
    fixture.assert_task_untouched();
    assert!(crate::today_outbox::list_records(&fixture.work)
        .unwrap()
        .is_empty());
    assert!(!fixture.work.join(".maru/today").exists());
}

#[test]
fn completion_manual_linked_today_keeps_archive_and_ready_outbox() {
    let home = Home::new();
    let mut fixture = Fixture::new(&home, Some(false));
    link_google_task(&mut fixture);
    complete_today(&fixture).unwrap();
    assert!(!fixture.work.join(TASK_PATH).exists());
    assert!(fs::read_to_string(fixture.work.join(ARCHIVED_PATH))
        .unwrap()
        .contains("status: done"));
    let records = crate::today_outbox::list_records(&fixture.work).unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].status, crate::today_outbox::OutboxStatus::Ready);
}

#[test]
fn completion_required_precompleted_today_cannot_archive_without_acceptance() {
    let home = Home::new();
    let mut fixture = Fixture::new(&home, Some(true));
    fixture.original = fixture.original.replace("status: active", "status: done");
    fs::write(fixture.work.join(TASK_PATH), &fixture.original).unwrap();
    let result = complete_today(&fixture);
    assert!(
        result.is_err(),
        "a precompleted note must not bypass guarded archive publication: {result:?}"
    );
    fixture.assert_task_untouched();
    assert!(crate::today_outbox::list_records(&fixture.work)
        .unwrap()
        .is_empty());
    assert!(!fixture.work.join(".maru/today").exists());
}

fn assert_archived_manual_task(work: &Path, bucket: TaskBucket, rel_path: &str) -> String {
    assert_eq!(bucket, TaskBucket::Archive);
    assert_eq!(rel_path, ARCHIVED_PATH);
    assert!(!work.join(TASK_PATH).exists());
    let saved = fs::read_to_string(work.join(ARCHIVED_PATH)).unwrap();
    assert!(saved.contains("status: done"));
    assert!(saved.contains("custom: preserved"));
    assert!(saved.contains("priority: high"));
    saved
}

#[test]
fn completion_required_status_done_without_evidence_is_refused_before_effects() {
    let home = Home::new();
    let fixture = Fixture::new(&home, Some(true));

    let result = crate::tasks::update_task_status(
        fixture.work_path(),
        TASK_PATH.into(),
        TaskStatus::Done,
        None,
    );

    assert!(
        result.is_err(),
        "an opted-in task with no completion evidence must refuse direct status Done; got {result:?}"
    );
    fixture.assert_task_untouched();
}

#[test]
fn completion_required_details_done_without_evidence_is_refused_before_effects() {
    let home = Home::new();
    let fixture = Fixture::new(&home, Some(true));

    let result = crate::tasks::update_task_details(
        fixture.work_path(),
        TASK_PATH.into(),
        done_details(),
        None,
    );

    assert!(
        result.is_err(),
        "the details writer must not finalize an opted-in task without evidence or partly edit it; got {result:?}"
    );
    fixture.assert_task_untouched();
}

#[test]
fn completion_required_document_done_without_evidence_is_refused_before_effects() {
    let home = Home::new();
    let fixture = Fixture::new(&home, Some(true));
    let result = crate::document::save_document(
        fixture.work_path(),
        TASK_PATH.into(),
        fixture.original.replace("status: active", "status: done"),
        Some(crate::document::revision_for(&fixture.original)),
    );

    assert!(
        result.is_err(),
        "a revision-valid document save must not bypass required completion evidence; got {result:?}"
    );
    fixture.assert_task_untouched();
}

#[test]
fn completion_manual_status_done_keeps_existing_archive_behavior() {
    let home = Home::new();
    for completion_required in [None, Some(false)] {
        let fixture = Fixture::new(&home, completion_required);
        let row = crate::tasks::update_task_status(
            fixture.work_path(),
            TASK_PATH.into(),
            TaskStatus::Done,
            None,
        )
        .unwrap();

        let saved = assert_archived_manual_task(&fixture.work, row.bucket, &row.rel_path);
        assert!(saved.contains("title: Completion fixture"));
        assert!(saved.contains("# Original body"));
        if completion_required == Some(false) {
            assert!(saved.contains("maruCompletionRequired: false"));
        } else {
            assert!(!saved.contains("maruCompletionRequired"));
        }
    }
}

#[test]
fn completion_manual_details_done_keeps_edits_and_existing_archive_behavior() {
    let home = Home::new();
    for completion_required in [None, Some(false)] {
        let fixture = Fixture::new(&home, completion_required);
        let row = crate::tasks::update_task_details(
            fixture.work_path(),
            TASK_PATH.into(),
            done_details(),
            None,
        )
        .unwrap();

        let saved = assert_archived_manual_task(&fixture.work, row.bucket, &row.rel_path);
        assert!(saved.contains("title: Changed title"));
        assert!(saved.contains("# Changed body"));
        if completion_required == Some(false) {
            assert!(saved.contains("maruCompletionRequired: false"));
        } else {
            assert!(!saved.contains("maruCompletionRequired"));
        }
    }
}

#[test]
fn completion_guard_whitespace_done_uses_task_read_semantics_before_effects() {
    let home = Home::new();
    let fixture = Fixture::new(&home, Some(true));
    let result = crate::document::save_document(
        fixture.work_path(),
        TASK_PATH.into(),
        fixture
            .original
            .replace("status: active", "status: ' done '"),
        Some(crate::document::revision_for(&fixture.original)),
    );
    assert!(
        result.is_err(),
        "read-side Done bypassed evidence: {result:?}"
    );
    fixture.assert_task_untouched();
}

#[test]
fn completion_guard_cancelled_archive_cannot_default_to_done_after_status_edit() {
    let home = Home::new();
    for value in [
        None,
        Some(crate::document::FieldInput::Str(
            "unrecognized-status".into(),
        )),
    ] {
        let fixture = Fixture::new(&home, Some(true));
        let cancelled = crate::tasks::update_task_status(
            fixture.work_path(),
            TASK_PATH.into(),
            TaskStatus::Cancelled,
            None,
        )
        .unwrap();
        let before = fs::read_to_string(&cancelled.path).unwrap();
        assert_eq!(cancelled.bucket, TaskBucket::Archive);
        let result = crate::document::update_frontmatter_field(
            fixture.work_path(),
            cancelled.rel_path,
            "status".into(),
            value,
            Some(crate::document::revision_for(&before)),
        );
        assert!(
            result.is_err(),
            "Archive status fallback bypassed evidence: {result:?}"
        );
        assert_eq!(fs::read_to_string(&cancelled.path).unwrap(), before);
        assert!(!fixture.work.join(".maru/versions").exists());
    }
}

fn injected_completion_draft(key: &str, value: serde_json::Value) -> crate::tasks::CreateTaskDraft {
    crate::tasks::CreateTaskDraft {
        slug: "injected-completion".into(),
        title: "Injected completion".into(),
        frontmatter: [
            (key.to_string(), value),
            ("status".into(), serde_json::json!("done")),
        ]
        .into_iter()
        .collect(),
        body: "# Unreviewed output\n".into(),
        bucket: TaskBucket::Archive,
    }
}

#[test]
fn completion_guard_task_create_refuses_reserved_policy_before_bucket_creation() {
    let home = Home::new();
    for (key, value) in [
        ("maruCompletionRequired", serde_json::json!(true)),
        (
            "maruCompletionPolicyRevision",
            serde_json::json!("forged-policy"),
        ),
    ] {
        let fixture = Fixture::new(&home, None);
        let result = crate::tasks::create_task_note(
            fixture.work_path(),
            injected_completion_draft(key, value),
            None,
        );
        assert!(
            result.is_err(),
            "Task creation injected reserved policy: {result:?}"
        );
        assert!(!fixture.work.join("tasks/archive").exists());
        fixture.assert_task_untouched();
    }
}

#[test]
fn completion_guard_capture_materialization_refuses_reserved_policy_before_effects() {
    let home = Home::new();
    let fixture = Fixture::new(&home, None);
    let result = crate::tasks::prepare_capture_task_materialization(
        &fixture.work,
        "2026-11-14",
        "completion-injection",
        injected_completion_draft("maruCompletionRequired", serde_json::json!(true)),
    )
    .and_then(|prepared| crate::tasks::materialize_capture_task(&fixture.work, &prepared));
    assert!(
        result.is_err(),
        "Capture materialization injected reserved policy: {result:?}"
    );
    assert!(!fixture.work.join("tasks/archive").exists());
    fixture.assert_task_untouched();
}

#[test]
fn completion_guard_nested_archive_name_does_not_change_the_source_bucket() {
    let home = Home::new();
    let fixture = Fixture::new(&home, Some(true));
    let source = "tasks/active/archive/task.md";
    fs::create_dir_all(fixture.work.join("tasks/active/archive")).unwrap();
    fs::rename(fixture.work.join(TASK_PATH), fixture.work.join(source)).unwrap();
    let result = crate::tasks::move_task_note(
        fixture.work_path(),
        source.into(),
        TaskBucket::Archive,
        None,
    );
    assert!(
        result.is_err(),
        "A nested folder name bypassed Archive admission: {result:?}"
    );
    assert_eq!(
        fs::read_to_string(fixture.work.join(source)).unwrap(),
        fixture.original
    );
    assert!(!fixture.work.join("tasks/archive").exists());
}

#[test]
fn completion_guard_uppercase_markdown_matches_the_task_scanner() {
    let home = Home::new();
    let fixture = Fixture::new(&home, Some(true));
    let source = "tasks/active/upper.MD";
    fs::rename(fixture.work.join(TASK_PATH), fixture.work.join(source)).unwrap();
    let rows = crate::tasks::scan_task_notes(fixture.work_path(), None).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].bucket, TaskBucket::Active);
    let result = crate::tasks::move_task_note(
        fixture.work_path(),
        source.into(),
        TaskBucket::Archive,
        None,
    );
    assert!(
        result.is_err(),
        "Uppercase Markdown bypassed Archive admission: {result:?}"
    );
    assert_eq!(
        fs::read_to_string(fixture.work.join(source)).unwrap(),
        fixture.original
    );
    assert!(!fixture.work.join("tasks/archive").exists());
}

#[cfg(unix)]
#[test]
fn completion_guard_physical_archive_destination_alias_is_checked_before_move() {
    let home = Home::new();
    let fixture = Fixture::new(&home, Some(true));
    fs::create_dir_all(fixture.work.join("tasks/archive")).unwrap();
    std::os::unix::fs::symlink(
        fixture.work.join("tasks/archive"),
        fixture.work.join("finished"),
    )
    .unwrap();
    let result = crate::document::move_document(
        fixture.work_path(),
        TASK_PATH.into(),
        "finished/task.md".into(),
    );
    assert!(
        result.is_err(),
        "A physical Archive alias bypassed evidence: {result:?}"
    );
    fixture.assert_task_untouched();
}

#[test]
fn completion_guard_nonopted_creation_and_cancelled_metadata_edits_stay_ordinary() {
    let home = Home::new();
    let fixture = Fixture::new(&home, None);
    let draft = crate::tasks::CreateTaskDraft {
        slug: "ordinary-done".into(),
        title: "Ordinary manual task".into(),
        frontmatter: [("status".into(), serde_json::json!("done"))]
            .into_iter()
            .collect(),
        body: "# Manual\n".into(),
        bucket: TaskBucket::Archive,
    };
    let ordinary = crate::tasks::create_task_note(fixture.work_path(), draft, None).unwrap();
    assert_eq!(ordinary.bucket, TaskBucket::Archive);
    let opted = Fixture::new(&home, Some(true));
    let cancelled = crate::tasks::update_task_status(
        opted.work_path(),
        TASK_PATH.into(),
        TaskStatus::Cancelled,
        None,
    )
    .unwrap();
    let before = fs::read_to_string(&cancelled.path).unwrap();
    crate::document::update_frontmatter_field(
        opted.work_path(),
        cancelled.rel_path,
        "title".into(),
        Some(crate::document::FieldInput::Str(
            "Cancellation explanation".into(),
        )),
        Some(crate::document::revision_for(&before)),
    )
    .unwrap();
    assert!(fs::read_to_string(&cancelled.path)
        .unwrap()
        .contains("status: cancelled"));
}

#[test]
fn completion_guard_custom_scope_is_recorded_and_omitted_updates_keep_it() {
    let home = Home::new();
    let fixture = Fixture::new(&home, None);
    let custom = "projects/archive/custom-tasks";
    let task = format!("{custom}/active/task.md");
    fs::create_dir_all(fixture.work.join(custom).join("active")).unwrap();
    fs::write(fixture.work.join(&task), &fixture.original).unwrap();
    let source = crate::document::revision_for(&fixture.original);
    crate::task_completion::set_policy_scoped(&fixture.work, &task, true, &source, Some(custom))
        .unwrap();
    let before = fs::read_to_string(fixture.work.join(&task)).unwrap();
    crate::task_completion::set_policy(
        &fixture.work,
        &task,
        false,
        &crate::document::revision_for(&before),
    )
    .unwrap();
    let before = fs::read_to_string(fixture.work.join(&task)).unwrap();
    crate::task_completion::set_policy(
        &fixture.work,
        &task,
        true,
        &crate::document::revision_for(&before),
    )
    .unwrap();
    let expected_root = fs::canonicalize(fixture.work.join(custom))
        .unwrap()
        .to_string_lossy()
        .into_owned();
    for proof in fs::read_dir(fixture.work.join(".maru/task-completion/policy-revisions")).unwrap()
    {
        let proof: serde_json::Value =
            serde_json::from_slice(&fs::read(proof.unwrap().path()).unwrap()).unwrap();
        assert_eq!(proof["tasksRoot"], expected_root);
    }
    let before = fs::read_to_string(fixture.work.join(&task)).unwrap();
    assert!(crate::tasks::move_task_note(
        fixture.work_path(),
        task.clone(),
        TaskBucket::Archive,
        Some(custom.into())
    )
    .is_err());
    assert_eq!(
        fs::read_to_string(fixture.work.join(&task)).unwrap(),
        before
    );
    assert!(!fixture.work.join(custom).join("archive").exists());
}

#[test]
fn completion_guard_requested_scope_must_agree_with_existing_claim() {
    let home = Home::new();
    let fixture = Fixture::new(&home, None);
    let custom = "projects/tasks";
    let task = format!("{custom}/active/task.md");
    fs::create_dir_all(fixture.work.join(custom).join("active")).unwrap();
    fs::write(fixture.work.join(&task), &fixture.original).unwrap();
    crate::task_completion::set_policy_scoped(
        &fixture.work,
        &task,
        true,
        &crate::document::revision_for(&fixture.original),
        Some(custom),
    )
    .unwrap();
    let source = fs::read_to_string(fixture.work.join(&task)).unwrap();
    let metadata = serde_json::json!({"taskExecution": {
        "requestId":"scope-agreement", "taskPath":task, "sourceRevision":crate::document::revision_for(&source), "tasksRoot":custom
    }});
    let (_session, _) = crate::task_execution_runtime::TaskExecutionSession::admit(
        &fixture.work_path(),
        Some(&metadata),
        "scope-agreement-run",
    )
    .unwrap()
    .unwrap();
    let before = fs::read_to_string(fixture.work.join(&task)).unwrap();
    let result = crate::task_completion::set_policy_scoped(
        &fixture.work,
        &task,
        true,
        &crate::document::revision_for(&before),
        Some("tasks"),
    );
    assert!(result.is_err());
    assert_eq!(
        fs::read_to_string(fixture.work.join(&task)).unwrap(),
        before
    );
}

#[cfg(unix)]
#[test]
fn completion_guard_scope_root_alias_keeps_authorization_and_physical_identity() {
    let home = Home::new();
    let fixture = Fixture::new(&home, None);
    std::os::unix::fs::symlink(
        fixture.work.join("tasks"),
        fixture.work.join("task-root-link"),
    )
    .unwrap();
    crate::task_completion::set_policy_scoped(
        &fixture.work,
        TASK_PATH,
        true,
        &crate::document::revision_for(&fixture.original),
        Some("task-root-link"),
    )
    .unwrap();
    let proof = fs::read_dir(fixture.work.join(".maru/task-completion/policy-revisions"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let proof: serde_json::Value = serde_json::from_slice(&fs::read(proof).unwrap()).unwrap();
    assert_eq!(
        proof["tasksRoot"],
        fs::canonicalize(&fixture.work)
            .unwrap()
            .join("task-root-link")
            .to_string_lossy()
            .as_ref()
    );
    let index: serde_json::Value = serde_json::from_slice(
        &fs::read(fixture.work.join(".maru/task-completion/known-scopes.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        index["scopes"][0]["physicalRoot"],
        fs::canonicalize(fixture.work.join("tasks"))
            .unwrap()
            .to_string_lossy()
            .as_ref()
    );
    assert!(crate::tasks::move_task_note(
        fixture.work_path(),
        TASK_PATH.into(),
        TaskBucket::Archive,
        None
    )
    .is_err());
}

#[test]
fn completion_guard_directory_move_checks_nested_uppercase_tasks_before_any_move() {
    let home = Home::new();
    let fixture = Fixture::new(&home, Some(true));
    let source_dir = "tasks/active/group";
    let source_note = "tasks/active/group/nested/archive/task.MD";
    fs::create_dir_all(fixture.work.join("tasks/active/group/nested/archive")).unwrap();
    fs::rename(fixture.work.join(TASK_PATH), fixture.work.join(source_note)).unwrap();
    fs::write(fixture.work.join(source_dir).join("ordinary.txt"), "keep").unwrap();
    fs::create_dir_all(fixture.work.join("tasks/archive")).unwrap();
    let outcomes = crate::workspace_files::paste_workspace_entries(
        fixture.work_path(),
        vec![source_dir.into()],
        "tasks/archive".into(),
        crate::workspace_files::FileQueueOperation::Move,
    )
    .unwrap();
    assert!(matches!(
        outcomes[0].status,
        crate::workspace_files::WorkspaceMutationStatus::Error
    ));
    assert_eq!(
        fs::read_to_string(fixture.work.join(source_note)).unwrap(),
        fixture.original
    );
    assert_eq!(
        fs::read_to_string(fixture.work.join(source_dir).join("ordinary.txt")).unwrap(),
        "keep"
    );
    assert!(!fixture.work.join("tasks/archive/group").exists());
}

#[test]
fn completion_guard_document_suffix_conversion_cannot_mint_policy() {
    let home = Home::new();
    let fixture = Fixture::new(&home, None);
    let source = fixture.work.join("unreviewed.markdown");
    let content = "---\nstatus: done\nmaruCompletionRequired: true\n---\n# Unreviewed\n";
    fs::write(&source, content).unwrap();
    let result = crate::document::move_document(
        fixture.work_path(),
        "unreviewed.markdown".into(),
        "tasks/archive/unreviewed.md".into(),
    );
    assert!(result.is_err());
    assert_eq!(fs::read_to_string(source).unwrap(), content);
    assert!(!fixture.work.join("tasks/archive").exists());
}

#[test]
fn completion_guard_directory_preflight_skips_unrelated_and_same_bucket_trees() {
    let home = Home::new();
    for (source_dir, target_dir, required) in [
        ("ordinary/source", "ordinary/destination", false),
        ("tasks/active/source", "tasks/active/destination", true),
    ] {
        let fixture = Fixture::new(&home, None);
        let mut deepest = fixture.work.join(source_dir);
        for _ in 0..70 {
            deepest.push("nested");
        }
        fs::create_dir_all(&deepest).unwrap();
        let content = if required {
            fixture.original.replace(
                "status: active",
                "status: active\nmaruCompletionRequired: true",
            )
        } else {
            fixture.original.clone()
        };
        fs::write(deepest.join("task.MD"), &content).unwrap();
        fs::create_dir_all(fixture.work.join(target_dir)).unwrap();
        let outcomes = crate::workspace_files::paste_workspace_entries(
            fixture.work_path(),
            vec![source_dir.into()],
            target_dir.into(),
            crate::workspace_files::FileQueueOperation::Move,
        )
        .unwrap();
        assert!(matches!(outcomes[0].status, crate::workspace_files::WorkspaceMutationStatus::Done), "unrelated/same-bucket moves must not hit the completion tree depth limit: {outcomes:?}");
        assert!(!fixture.work.join(source_dir).exists());
        let moved = fixture.work.join(target_dir).join("source");
        let mut leaf = moved;
        for _ in 0..70 {
            leaf.push("nested");
        }
        assert_eq!(fs::read_to_string(leaf.join("task.MD")).unwrap(), content);
    }
}

#[cfg(unix)]
#[test]
fn completion_guard_generic_tasks_scope_keeps_supported_external_directory_aliases() {
    let home = Home::new();
    let fixture = Fixture::new(&home, None);
    let external = tempfile::tempdir_in(home.root.path()).unwrap();
    fs::create_dir_all(external.path().join("active")).unwrap();
    fs::write(external.path().join("active/task.md"), &fixture.original).unwrap();
    std::os::unix::fs::symlink(external.path(), fixture.work.join("external-tasks")).unwrap();
    let task = "external-tasks/active/task.md";
    crate::task_completion::set_policy_scoped(
        &fixture.work,
        task,
        true,
        &crate::document::revision_for(&fixture.original),
        Some("external-tasks"),
    )
    .unwrap();
    let before = fs::read_to_string(external.path().join("active/task.md")).unwrap();
    let proof_file = fs::read_dir(fixture.work.join(".maru/task-completion/policy-revisions"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let proof: serde_json::Value = serde_json::from_slice(&fs::read(proof_file).unwrap()).unwrap();
    assert_eq!(
        proof["tasksRoot"],
        fs::canonicalize(&fixture.work)
            .unwrap()
            .join("external-tasks")
            .to_string_lossy()
            .as_ref()
    );
    let result = crate::document::move_document(
        fixture.work_path(),
        task.into(),
        "external-tasks/archive/task.md".into(),
    );
    assert!(result.is_err());
    assert_eq!(
        fs::read_to_string(external.path().join("active/task.md")).unwrap(),
        before
    );
    assert!(!external.path().join("archive").exists());
    // Generic Tasks aliases stay supported; execution claims retain their
    // separate existing physical-workspace containment boundary.
    let metadata = serde_json::json!({"taskExecution": {
        "requestId":"external-root-claim", "taskPath":task, "tasksRoot":"external-tasks", "sourceRevision":crate::document::revision_for(&before)
    }});
    assert!(crate::task_execution_runtime::TaskExecutionSession::admit(
        &fixture.work_path(),
        Some(&metadata),
        "external-root-run"
    )
    .is_err());
}

#[test]
fn completion_guard_scope_index_precedes_partial_policy_publication() {
    let home = Home::new();
    let fixture = Fixture::new(&home, None);
    let custom = "projects/custom-tasks";
    let group = format!("{custom}/active/group");
    let task = format!("{group}/task.md");
    fs::create_dir_all(fixture.work.join(&group)).unwrap();
    fs::write(fixture.work.join(&task), &fixture.original).unwrap();
    *crate::task_completion::AFTER_POLICY_EFFECT_FAILURE
        .lock()
        .unwrap() = Some(fs::canonicalize(&fixture.work).unwrap());
    assert!(crate::task_completion::set_policy_scoped(
        &fixture.work,
        &task,
        true,
        &crate::document::revision_for(&fixture.original),
        Some(custom)
    )
    .is_err());
    assert!(fs::read_to_string(fixture.work.join(&task))
        .unwrap()
        .contains("maruCompletionRequired: true"));
    let index: serde_json::Value = serde_json::from_slice(
        &fs::read(fixture.work.join(".maru/task-completion/known-scopes.json")).unwrap(),
    )
    .unwrap();
    assert!(index["scopes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|scope| scope["lexicalRoot"]
            == fs::canonicalize(&fixture.work)
                .unwrap()
                .join(custom)
                .to_string_lossy()
                .as_ref()));
    fs::create_dir_all(fixture.work.join(custom).join("archive")).unwrap();
    let before = fs::read_to_string(fixture.work.join(&task)).unwrap();
    let outcomes = crate::workspace_files::paste_workspace_entries(
        fixture.work_path(),
        vec![group],
        format!("{custom}/archive"),
        crate::workspace_files::FileQueueOperation::Move,
    )
    .unwrap();
    assert!(matches!(
        outcomes[0].status,
        crate::workspace_files::WorkspaceMutationStatus::Error
    ));
    assert_eq!(
        fs::read_to_string(fixture.work.join(&task)).unwrap(),
        before
    );
    assert!(!fixture.work.join(custom).join("archive/group").exists());
}
