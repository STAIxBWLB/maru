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
