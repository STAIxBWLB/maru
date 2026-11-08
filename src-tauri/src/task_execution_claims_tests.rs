use super::*;
use crate::atomic_file::phase08_06::Home;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

struct Fixture {
    _home: Home,
    work: PathBuf,
    path: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let home = Home::new();
        let work = home.root.path().join("work");
        let path = work.join("tasks/active/task.md");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "---\ntitle: Task\nstatus: active\n---\nTask body\n").unwrap();
        Self {
            _home: home,
            work,
            path,
        }
    }

    fn request(&self, id: &str) -> TaskExecutionRequest {
        TaskExecutionRequest {
            request_id: id.into(),
            task_path: "tasks/active/task.md".into(),
            source_revision: crate::document::revision_for(
                &fs::read_to_string(&self.path).unwrap(),
            ),
            tasks_root: None,
        }
    }

    fn file(&self, id: &str) -> PathBuf {
        self.work.join(CLAIM_DIR).join(format!("{id}.json"))
    }

    fn edit(&self, id: &str, edit: impl FnOnce(&mut TaskExecutionClaim)) {
        with_claim_operation(&self.work, id, |roots, claim, _, lease, lock| {
            edit(claim);
            write_claim(roots, lease, claim, lock)
        })
        .unwrap();
    }
}

fn stopped_identity() -> NativeProcessIdentity {
    // A reused PID with a different native creation time is positive death
    // evidence for the recorded identity. No process is signalled.
    NativeProcessIdentity {
        pid: std::process::id(),
        start: "a-prior-process-start".into(),
    }
}

fn wait_owned(work: &Path, token: &TaskExecutionToken) {
    let mut child = spawn_owned_child(work, token, || {
        Command::new(std::env::current_exe().unwrap())
            .arg("--list")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("fixture child failed: {error}; rebuild the test binary"))
    })
    .unwrap();
    let pid = child.id();
    assert!(child.wait().unwrap().success());
    record_reaped_child(work, token, pid).unwrap();
}

#[test]
fn process_contender() {
    let Ok(raw) = std::env::var("MARU_TASK_CLAIM_FIXTURE") else {
        return;
    };
    let (work, request, run_id): (PathBuf, TaskExecutionRequest, String) =
        serde_json::from_str(&raw).unwrap();
    fs::write(work.join(format!("ready-{run_id}")), "ready").unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while !work.join("go").exists() {
        assert!(
            Instant::now() < deadline,
            "claim fixture start signal absent; inspect the parent contender test"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    let result = acquire(&work, &request, &run_id);
    match result {
        Ok(admission) => {
            fs::write(
                work.join(format!("result-{run_id}")),
                serde_json::to_vec(&admission.claim).unwrap(),
            )
            .unwrap();
            std::process::exit(0);
        }
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(3);
        }
    }
}

#[test]
fn cross_process_contenders_have_one_owner_and_same_request_replays_after_restart() {
    let f = Fixture::new();
    let request = f.request("request-a");
    let mut children = Vec::new();
    for suffix in ["a", "b"] {
        let mut contender = request.clone();
        contender.request_id = format!("request-{suffix}");
        let run = format!("run-{suffix}");
        let raw = serde_json::to_string(&(f.work.clone(), contender, run)).unwrap();
        children.push(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "task_execution_claims::tests::process_contender",
                    "--nocapture",
                ])
                .env("MARU_TASK_CLAIM_FIXTURE", raw)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap(),
        );
    }
    let deadline = Instant::now() + Duration::from_secs(30);
    while !["ready-run-a", "ready-run-b"]
        .iter()
        .all(|name| f.work.join(name).exists())
    {
        assert!(
            Instant::now() < deadline,
            "claim contenders did not start; inspect their stderr and the test binary path"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    fs::write(f.work.join("go"), "go").unwrap();
    let outputs: Vec<_> = children
        .into_iter()
        .map(|child| child.wait_with_output().unwrap())
        .collect();
    assert_eq!(
        outputs
            .iter()
            .filter(|output| output.status.success())
            .count(),
        1,
        "{outputs:?}"
    );
    assert_eq!(
        outputs
            .iter()
            .filter(|output| output.status.code() == Some(3))
            .count(),
        1,
        "{outputs:?}"
    );
    let task_id = task_id_from_content(&fs::read_to_string(&f.path).unwrap()).unwrap();
    let current = read_claim(&f.file(&task_id), &task_id).unwrap().unwrap();
    let mut replay_request = request;
    replay_request.request_id = current.request_id.clone();
    let before = fs::read(f.file(&task_id)).unwrap();
    let replay = acquire(&f.work, &replay_request, "another-run").unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.claim.token(), current.token());
    assert_eq!(fs::read(f.file(&task_id)).unwrap(), before);
    // Both contender processes exited without a child binding. That uncertainty
    // cannot become a time-based takeover, even though their native owners died.
    assert_eq!(
        reconcile(&f.work, &task_id).unwrap().lifecycle,
        TaskExecutionLifecycle::Active
    );
}

#[test]
fn stale_generations_cannot_release_update_or_finalize_and_old_requests_do_not_respawn() {
    let f = Fixture::new();
    let first_request = f.request("first");
    let first = acquire(&f.work, &first_request, "run-first").unwrap().claim;
    let token = first.token();
    let released = release(&f.work, &token).unwrap();
    assert_eq!(release(&f.work, &token).unwrap(), released);
    let second = acquire(&f.work, &f.request("second"), "run-second")
        .unwrap()
        .claim;
    assert_eq!(second.generation, first.generation + 1);
    let before = fs::read(f.file(&token.task_id)).unwrap();
    assert!(check(&f.work, &token).unwrap_err().contains("token_stale"));
    assert!(record_child(&f.work, &token, Some(stopped_identity()))
        .unwrap_err()
        .contains("token_stale"));
    assert!(release(&f.work, &token)
        .unwrap_err()
        .contains("token_stale"));
    assert!(finish(&f.work, &token, true, Some(0))
        .unwrap_err()
        .contains("token_stale"));
    let historical = acquire(&f.work, &first_request, "must-not-run").unwrap();
    assert!(historical.replayed);
    assert_eq!(historical.claim.token(), token);
    assert_eq!(fs::read(f.file(&token.task_id)).unwrap(), before);
    wait_owned(&f.work, &second.token());
    let done = finish(&f.work, &second.token(), true, Some(0)).unwrap();
    assert_eq!(
        finish(&f.work, &second.token(), true, Some(0)).unwrap(),
        done
    );
    assert!(finish(&f.work, &second.token(), false, None)
        .unwrap_err()
        .contains("finish_conflict"));
}

#[test]
fn source_drift_and_terminal_tasks_conflict_before_spawn_or_identity_effect() {
    let f = Fixture::new();
    let request = f.request("revision");
    let original = fs::read_to_string(&f.path).unwrap();
    fs::write(&f.path, format!("{original}Changed\n")).unwrap();
    assert!(acquire(&f.work, &request, "stale-run")
        .unwrap_err()
        .contains("source_changed"));
    assert!(task_id_from_content(&fs::read_to_string(&f.path).unwrap()).is_none());
    fs::write(&f.path, original).unwrap();
    let claim = acquire(&f.work, &request, "run").unwrap().claim;
    let bound = fs::read_to_string(&f.path).unwrap();
    let changed = update_frontmatter_content(
        &bound,
        "status",
        Some(FrontmatterValue::String("done".into())),
    )
    .unwrap();
    fs::write(&f.path, &changed).unwrap();
    let called = std::cell::Cell::new(false);
    assert!(spawn_owned_child(&f.work, &claim.token(), || {
        called.set(true);
        Err("must not execute".into())
    })
    .is_err());
    assert!(!called.get());
    f.edit(&claim.task_id, |row| {
        row.receipt.owner = Some(stopped_identity());
        row.receipt.child = Some(stopped_identity());
    });
    assert_eq!(
        reconcile(&f.work, &claim.task_id).unwrap().lifecycle,
        TaskExecutionLifecycle::NeedsReview
    );
    assert!(acquire(&f.work, &f.request("cannot-resurrect"), "new-run").is_err());
    assert_eq!(fs::read_to_string(&f.path).unwrap(), changed);
}

#[test]
fn native_ownership_and_prior_wait_proof_never_cover_a_new_spawn_window() {
    assert!(!ownership_proves_stopped(
        ProcessOwnership::Live,
        Some(ProcessOwnership::Dead),
        true
    ));
    assert!(!ownership_proves_stopped(
        ProcessOwnership::Unverified,
        Some(ProcessOwnership::Dead),
        true
    ));
    assert!(!ownership_proves_stopped(
        ProcessOwnership::Dead,
        Some(ProcessOwnership::Unverified),
        false
    ));
    assert!(!ownership_proves_stopped(
        ProcessOwnership::Dead,
        None,
        false
    ));
    assert!(ownership_proves_stopped(
        ProcessOwnership::Dead,
        Some(ProcessOwnership::Dead),
        false
    ));
    assert!(ownership_proves_stopped(ProcessOwnership::Dead, None, true));
    let f = Fixture::new();
    let claim = acquire(&f.work, &f.request("wait-proof"), "run-proof")
        .unwrap()
        .claim;
    wait_owned(&f.work, &claim.token());
    let file = f.file(&claim.task_id);
    let result = spawn_owned_child(&f.work, &claim.token(), || {
        let on_disk = read_claim(&file, &claim.task_id).unwrap().unwrap();
        assert!(
            !on_disk.child_reaped,
            "prior wait proof must be cleared before the next spawn effect"
        );
        Err("fixture spawn failure".into())
    });
    assert!(result.unwrap_err().contains("spawn_failed"));
    let stored = read_claim(&file, &claim.task_id).unwrap().unwrap();
    assert_eq!(stored.lifecycle, TaskExecutionLifecycle::Finished);
    assert_eq!(stored.receipt.process_outcome, "failed");
}

#[test]
fn identity_survives_managed_bucket_move_and_workspace_rename() {
    let f = Fixture::new();
    let claim = acquire(&f.work, &f.request("move"), "move-run")
        .unwrap()
        .claim;
    let moved = crate::tasks::move_task_note(
        display(&f.work),
        "tasks/active/task.md".into(),
        crate::tasks::TaskBucket::Backlog,
        None,
    )
    .unwrap();
    assert_eq!(
        task_id_from_content(&fs::read_to_string(&moved.path).unwrap()).as_deref(),
        Some(claim.task_id.as_str())
    );
    let renamed = crate::workspace_files::rename_workspace_entry(
        display(&f.work),
        moved.rel_path,
        "renamed.md".into(),
    )
    .unwrap();
    let target = renamed.target_path.unwrap();
    assert_eq!(
        task_id_from_content(&fs::read_to_string(&target).unwrap()).as_deref(),
        Some(claim.task_id.as_str())
    );
    let stored = read_claim(&f.file(&claim.task_id), &claim.task_id)
        .unwrap()
        .unwrap();
    assert_eq!(f.work.join(stored.task_path), PathBuf::from(target));
    assert_eq!(stored.source_revision, claim.source_revision);
}

#[test]
fn ordinary_rename_and_custom_task_roots_keep_their_existing_defaults() {
    let home = Home::new();
    let work = home.root.path().join("ordinary");
    fs::create_dir_all(&work).unwrap();
    fs::write(work.join("note.md"), [255, 0, 1]).unwrap();
    crate::workspace_files::rename_workspace_entry(
        display(&work),
        "note.md".into(),
        "renamed.md".into(),
    )
    .unwrap();
    assert_eq!(fs::read(work.join("renamed.md")).unwrap(), [255, 0, 1]);
    assert!(!work.join("tasks").exists());
    assert_eq!(
        fs::read_dir(work.join(CLAIM_DIR))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry
                .path()
                .extension()
                .is_some_and(|value| value == "json"))
            .count(),
        0
    );
    let path = work.join("work-items/active/custom.md");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let source = "---\nstatus: active\n---\nCustom\n";
    fs::write(&path, source).unwrap();
    let request = TaskExecutionRequest {
        request_id: "custom".into(),
        task_path: "work-items/active/custom.md".into(),
        source_revision: crate::document::revision_for(source),
        tasks_root: Some("work-items".into()),
    };
    let claim = acquire(&work, &request, "custom-run").unwrap().claim;
    assert_eq!(check(&work, &claim.token()).unwrap().task_id, claim.task_id);
    crate::workspace_files::rename_workspace_entry(
        display(&work),
        request.task_path,
        "custom-renamed.md".into(),
    )
    .unwrap();
    assert!(check(&work, &claim.token())
        .unwrap()
        .task_path
        .ends_with("custom-renamed.md"));
}

#[test]
fn pending_identity_replay_is_read_only_and_duplicate_request_path_checks_are_fail_closed() {
    let f = Fixture::new();
    let original = fs::read_to_string(&f.path).unwrap();
    let request = f.request("pending");
    let claim = acquire(&f.work, &request, "pending-run").unwrap().claim;
    let bound = fs::read_to_string(&f.path).unwrap();
    // Simulate interruption after sidecar admission but before identity bytes.
    fs::write(&f.path, &original).unwrap();
    let replay = acquire(&f.work, &request, "must-not-run").unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.claim.token(), claim.token());
    assert_eq!(fs::read_to_string(&f.path).unwrap(), original);
    fs::write(&f.path, bound).unwrap();
    let other = f.work.join("tasks/active/other.md");
    fs::write(&other, original).unwrap();
    let mut redirected = request;
    redirected.task_path = "tasks/active/other.md".into();
    assert!(acquire(&f.work, &redirected, "wrong-task")
        .unwrap_err()
        .contains("request_conflict"));
    fs::copy(&f.path, &other).unwrap();
    assert!(check(&f.work, &claim.token())
        .unwrap_err()
        .contains("duplicate_id"));
}

#[test]
fn bounded_history_and_corrupt_claims_cannot_enable_replay_or_replacement() {
    let f = Fixture::new();
    let claim = acquire(&f.work, &f.request("bounded"), "bounded-run")
        .unwrap()
        .claim;
    release(&f.work, &claim.token()).unwrap();
    f.edit(&claim.task_id, |row| {
        row.generation = REQUEST_HISTORY_LIMIT as u64 + 1;
        let template = TaskExecutionRequestRecord::from_claim(row);
        row.request_history = (0..REQUEST_HISTORY_LIMIT)
            .map(|index| {
                let mut record = template.clone();
                record.request_id = format!("past-{index}");
                record.run_id = format!("past-run-{index}");
                record.generation = index as u64 + 1;
                record.receipt.request_id = record.request_id.clone();
                record.receipt.run_id = record.run_id.clone();
                record
            })
            .collect();
    });
    let before = fs::read(f.file(&claim.task_id)).unwrap();
    assert!(acquire(&f.work, &f.request("overflow"), "overflow-run")
        .unwrap_err()
        .contains("history_full"));
    assert_eq!(fs::read(f.file(&claim.task_id)).unwrap(), before);
    fs::write(f.file(&claim.task_id), "{invalid").unwrap();
    assert!(check(&f.work, &claim.token())
        .unwrap_err()
        .contains("claim_invalid"));
    assert_eq!(fs::read(f.file(&claim.task_id)).unwrap(), b"{invalid");
}

#[test]
fn removed_identity_remains_owned_across_rename_and_automatic_cleanup_cannot_release_review() {
    let f = Fixture::new();
    let claim = acquire(&f.work, &f.request("identity"), "identity-run")
        .unwrap()
        .claim;
    let bound = fs::read_to_string(&f.path).unwrap();
    let edited = update_frontmatter_content(&bound, "taskId", None).unwrap();
    fs::write(&f.path, &edited).unwrap();
    assert!(acquire(&f.work, &f.request("new-identity"), "forbidden")
        .unwrap_err()
        .contains("identity_changed"));
    let renamed = crate::workspace_files::rename_workspace_entry(
        display(&f.work),
        "tasks/active/task.md".into(),
        "without-id.md".into(),
    )
    .unwrap();
    let stored = read_claim(&f.file(&claim.task_id), &claim.task_id)
        .unwrap()
        .unwrap();
    assert_eq!(stored.lifecycle, TaskExecutionLifecycle::NeedsReview);
    assert_eq!(
        f.work.join(&stored.task_path),
        PathBuf::from(renamed.target_path.unwrap())
    );
    assert_eq!(stored.source_revision, claim.source_revision);
    let before = fs::read(f.file(&claim.task_id)).unwrap();
    assert!(cancel_admission(&f.work, &claim.token()).is_err());
    assert_eq!(fs::read(f.file(&claim.task_id)).unwrap(), before);
    let next = TaskExecutionRequest {
        request_id: "cannot-evade".into(),
        task_path: stored.task_path,
        source_revision: crate::document::revision_for(&edited),
        tasks_root: None,
    };
    assert!(acquire(&f.work, &next, "forbidden-again").is_err());
}

#[test]
fn today_completion_preserves_identity_and_revision_fences_refuse_stale_adoption() {
    let f = Fixture::new();
    let claim = acquire(&f.work, &f.request("today"), "today-run")
        .unwrap()
        .claim;
    let bound = fs::read_to_string(&f.path).unwrap();
    let outcome = crate::today_lifecycle::task_transition(
        display(&f.work),
        crate::today::TaskTransitionRequest {
            task_id: claim.task_id.clone(),
            task_path: "tasks/active/task.md".into(),
            kind: crate::today::TaskTransitionKind::Complete,
            expected_task_hash: crate::document::revision_for(&bound),
            defer_date: None,
            date: Some("2026-11-08".into()),
            now_iso: Some("2026-11-08T09:00:00+09:00".into()),
            web_action_id: None,
            payload: serde_json::json!({}),
        },
    )
    .unwrap();
    assert_eq!(outcome.bucket, "archive");
    let roots = workspace_roots(&f.work, None).unwrap();
    let snapshot = find_task_by_id(&roots, &roots.tasks, &claim.task_id).unwrap();
    assert!(snapshot.archived);
    assert_eq!(snapshot.task_id.as_deref(), Some(claim.task_id.as_str()));
    assert!(check(&f.work, &claim.token()).is_err());
    f.edit(&claim.task_id, |row| {
        row.receipt.owner = Some(stopped_identity());
        row.receipt.child = Some(stopped_identity());
    });
    let recovered = reconcile(&f.work, &claim.task_id).unwrap();
    assert_eq!(recovered.lifecycle, TaskExecutionLifecycle::NeedsReview);
    let request = TaskExecutionRequest {
        request_id: "no-reopen".into(),
        task_path: recovered.task_path,
        source_revision: snapshot.revision,
        tasks_root: None,
    };
    let before = fs::read(&snapshot.path).unwrap();
    assert!(acquire(&f.work, &request, "cannot-run").is_err());
    assert_eq!(fs::read(&snapshot.path).unwrap(), before);
}

#[cfg(unix)]
#[test]
fn a_symlinked_claim_namespace_never_writes_outside_the_workspace() {
    let f = Fixture::new();
    let outside = tempfile::tempdir().unwrap();
    fs::create_dir_all(f.work.join(".maru")).unwrap();
    std::os::unix::fs::symlink(outside.path(), f.work.join(CLAIM_DIR)).unwrap();
    let before = fs::read(&f.path).unwrap();
    let error = acquire(&f.work, &f.request("symlink"), "symlink-run").unwrap_err();
    assert!(error.contains("directory_invalid"), "{error}");
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    assert_eq!(fs::read(&f.path).unwrap(), before);
}

#[test]
fn exact_finished_request_replays_after_archive_and_edit_without_any_write() {
    let f = Fixture::new();
    let request = f.request("exact-replay");
    let claim = acquire(&f.work, &request, "exact-run").unwrap().claim;
    wait_owned(&f.work, &claim.token());
    finish(&f.work, &claim.token(), true, Some(0)).unwrap();
    let bound = fs::read_to_string(&f.path).unwrap();
    crate::today_lifecycle::task_transition(
        display(&f.work),
        crate::today::TaskTransitionRequest {
            task_id: claim.task_id.clone(),
            task_path: request.task_path.clone(),
            kind: crate::today::TaskTransitionKind::Complete,
            expected_task_hash: crate::document::revision_for(&bound),
            defer_date: None,
            date: Some("2026-11-08".into()),
            now_iso: Some("2026-11-08T09:00:00+09:00".into()),
            web_action_id: None,
            payload: serde_json::json!({}),
        },
    )
    .unwrap();
    let roots = workspace_roots(&f.work, None).unwrap();
    let archived = find_task_by_id(&roots, &roots.tasks, &claim.task_id)
        .unwrap()
        .path;
    for edit in [false, true] {
        if edit {
            let raw = fs::read_to_string(&archived).unwrap();
            fs::write(&archived, format!("{raw}Edited after completion\n")).unwrap();
        }
        let note = fs::read(&archived).unwrap();
        let receipt = fs::read(f.file(&claim.task_id)).unwrap();
        let replay = acquire(&f.work, &request, "must-not-spawn").unwrap();
        assert!(replay.replayed);
        assert_eq!(replay.claim.token(), claim.token());
        assert_eq!(fs::read(&archived).unwrap(), note);
        assert_eq!(fs::read(f.file(&claim.task_id)).unwrap(), receipt);
    }
}

#[test]
fn reviewed_stop_releases_dead_unreaped_drift_after_restart_without_signalling_a_pid() {
    use tauri::Manager;
    let f = Fixture::new();
    let claim = acquire(&f.work, &f.request("reviewed-stop"), "reviewed-stop-run")
        .unwrap()
        .claim;
    let raw = fs::read_to_string(&f.path).unwrap();
    fs::write(&f.path, format!("{raw}Manual edit\n")).unwrap();
    f.edit(&claim.task_id, |row| {
        row.receipt.owner = Some(stopped_identity());
        row.receipt.child = Some(stopped_identity());
        row.child_reaped = false;
    });
    let dir = crate::mission_state::mission_dir().unwrap();
    fs::create_dir_all(&dir).unwrap();
    let now = chrono::Utc::now().to_rfc3339();
    let old_record = crate::mission_state::MissionRecord {
        id: claim.run_id.clone(),
        kind: "claude".into(),
        started_at: now.clone(),
        last_output_at: now,
        status: crate::mission_state::MissionStatus::Running,
        exit_code: None,
        output_log_path: None,
        metadata: Some(
            serde_json::json!({"workspacePath": display(&f.work), "taskExecution": claim.token()}),
        ),
    };
    fs::write(
        dir.join(format!("{}.json", claim.run_id)),
        serde_json::to_vec(&old_record).unwrap(),
    )
    .unwrap();
    let restarted = tauri::test::mock_app();
    restarted.manage(crate::mission_state::MissionState::default());
    let before = fs::read(&f.path).unwrap();
    let stopped =
        crate::mission_state::stop_ai_mission(restarted.handle().clone(), claim.run_id.clone())
            .unwrap();
    assert_eq!(stopped.status, crate::mission_state::MissionStatus::Stopped);
    let stored = read_claim(&f.file(&claim.task_id), &claim.task_id)
        .unwrap()
        .unwrap();
    assert_eq!(stored.lifecycle, TaskExecutionLifecycle::Released);
    assert!(stored.child_reaped);
    assert_eq!(fs::read(&f.path).unwrap(), before);
    let next = acquire(&f.work, &f.request("after-review"), "after-review-run").unwrap();
    assert!(!next.replayed);
    assert_eq!(next.claim.generation, claim.generation + 1);
}
