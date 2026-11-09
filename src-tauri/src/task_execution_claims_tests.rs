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
    // Both owners exited before the durable launch intent. This is positive
    // no-spawn evidence, not an elapsed-time takeover or a missing-child guess.
    assert_eq!(
        reconcile(&f.work, &task_id).unwrap().lifecycle,
        TaskExecutionLifecycle::Reconciled
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
        true,
        false
    ));
    assert!(!ownership_proves_stopped(
        ProcessOwnership::Unverified,
        Some(ProcessOwnership::Dead),
        true,
        false
    ));
    assert!(!ownership_proves_stopped(
        ProcessOwnership::Dead,
        Some(ProcessOwnership::Unverified),
        false,
        false
    ));
    assert!(!ownership_proves_stopped(
        ProcessOwnership::Dead,
        None,
        false,
        false
    ));
    assert!(ownership_proves_stopped(
        ProcessOwnership::Dead,
        Some(ProcessOwnership::Dead),
        false,
        false
    ));
    assert!(ownership_proves_stopped(
        ProcessOwnership::Dead,
        None,
        true,
        false
    ));
    let f = Fixture::new();
    let claim = acquire(&f.work, &f.request("wait-proof"), "run-proof")
        .unwrap()
        .claim;
    wait_owned(&f.work, &claim.token());
    let file = f.file(&claim.task_id);
    let result = spawn_owned_child(&f.work, &claim.token(), || {
        let on_disk = read_claim(&file, &claim.task_id).unwrap().unwrap();
        assert!(
            !on_disk.child_reaped && on_disk.spawn_attempted,
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
    assert!(!work.join(CLAIM_DIR).exists());
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
    let different_task = acquire(&f.work, &redirected, "different-task-run").unwrap();
    assert!(!different_task.replayed);
    assert_ne!(different_task.claim.task_id, claim.task_id);
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
fn removed_identity_after_completed_child_is_released_without_task_resolution() {
    let f = Fixture::new();
    let claim = acquire(&f.work, &f.request("identity"), "identity-run")
        .unwrap()
        .claim;
    wait_owned(&f.work, &claim.token());
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
    let target = PathBuf::from(renamed.target_path.unwrap());
    let before = fs::read(&target).unwrap();
    assert!(check(&f.work, &claim.token()).is_err());
    cancel_admission(&f.work, &claim.token()).unwrap();
    assert_eq!(
        read_claim(&f.file(&claim.task_id), &claim.task_id)
            .unwrap()
            .unwrap()
            .lifecycle,
        TaskExecutionLifecycle::Released
    );
    assert_eq!(fs::read(target).unwrap(), before);
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

#[test]
fn ordinary_modify_only_schedule_edits_create_no_claim_infrastructure() {
    use crate::vault_list::{
        ProviderPermissionSummary, WorkspaceCapabilities, WorkspaceRootEntry, WorkspaceWriteAction,
    };
    let f = Fixture::new();
    crate::vault_list::add_workspace_root(WorkspaceRootEntry {
        label: "Modify only".into(),
        path: display(&f.work),
        visibility: "public".into(),
        provider: "nextcloud".into(),
        provider_id: None,
        external_writer: None,
        write_policy: "direct".into(),
        permission_summary: Some(ProviderPermissionSummary {
            role: Some("3".into()),
            source: "manual".into(),
            checked_at: None,
            capabilities: WorkspaceCapabilities::default(),
            warning: None,
        }),
    })
    .unwrap();
    assert!(crate::vault_list::assert_maru_can_write(
        &display(&f.work),
        WorkspaceWriteAction::Modify
    )
    .is_ok());
    assert!(crate::vault_list::assert_maru_can_write(
        &display(&f.work),
        WorkspaceWriteAction::Create
    )
    .is_err());
    let row = crate::tasks::update_task_schedule_fields(
        display(&f.work),
        "tasks/active/task.md".into(),
        crate::tasks::UpdateTaskScheduleFields {
            project: Some(Some("Fixture project".into())),
            priority: None,
            due: None,
            calendar_start: None,
            calendar_end: None,
            estimate_minutes: None,
        },
    )
    .unwrap();
    assert_eq!(row.frontmatter["project"], "Fixture project");
    assert!(!f.work.join(CLAIM_DIR).exists());
    assert!(task_id_from_content(&fs::read_to_string(&f.path).unwrap()).is_none());
}

#[test]
fn identity_only_release_and_cleanup_survive_old_snapshot_overwrite_and_move() {
    let f = Fixture::new();
    let old = fs::read_to_string(&f.path).unwrap();
    for (index, cleanup) in [(0, false), (1, true), (2, false)] {
        let source = if index == 0 {
            f.path.clone()
        } else {
            f.work.join("tasks/active/second.md")
        };
        fs::write(&source, &old).unwrap();
        let request = TaskExecutionRequest {
            request_id: format!("before-move-{index}"),
            task_path: relative_task_path(&workspace_roots(&f.work, None).unwrap(), &source)
                .unwrap(),
            source_revision: crate::document::revision_for(&old),
            tasks_root: None,
        };
        let claim = acquire(&f.work, &request, &format!("move-run-{index}"))
            .unwrap()
            .claim;
        let child = if index == 2 {
            Some(
                spawn_owned_child(&f.work, &claim.token(), || {
                    Command::new(std::env::current_exe().unwrap())
                        .arg("--list")
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .spawn()
                        .map_err(|error| error.to_string())
                })
                .unwrap(),
            )
        } else {
            None
        };
        fs::write(&source, &old).unwrap();
        let target = f.work.join(format!("tasks/backlog/moved-{index}.md"));
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::rename(source, &target).unwrap();
        let before = fs::read(&target).unwrap();
        if let Some(mut child) = child {
            let pid = child.id();
            assert!(child.wait().unwrap().success());
            record_reaped_child(&f.work, &claim.token(), pid).unwrap();
        }
        if cleanup {
            cancel_admission(&f.work, &claim.token()).unwrap();
        } else {
            release(&f.work, &claim.token()).unwrap();
        }
        assert_eq!(fs::read(&target).unwrap(), before);
        let fresh = TaskExecutionRequest {
            request_id: format!("after-move-{index}"),
            task_path: target
                .strip_prefix(&f.work)
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            source_revision: crate::document::revision_for(&old),
            tasks_root: None,
        };
        let next = acquire(&f.work, &fresh, &format!("fresh-run-{index}")).unwrap();
        assert!(!next.replayed);
        assert_ne!(next.claim.task_id, claim.task_id);
    }
}

#[test]
fn request_ids_are_task_scoped_even_for_simultaneous_first_admissions() {
    let f = Fixture::new();
    let first = f.request("shared-request");
    let mut second = first.clone();
    second.task_path = "tasks/active/second.md".into();
    fs::copy(&f.path, f.work.join(&second.task_path)).unwrap();
    let (a_work, b_work) = (f.work.clone(), f.work.clone());
    let (a_request, b_request) = (first.clone(), second.clone());
    let a = std::thread::spawn(move || acquire(&a_work, &a_request, "shared-a"));
    let b = std::thread::spawn(move || acquire(&b_work, &b_request, "shared-b"));
    let a = a.join().unwrap().unwrap().claim;
    let b = b.join().unwrap().unwrap().claim;
    assert_ne!(a.task_id, b.task_id);
    assert_eq!(
        acquire(&f.work, &first, "no-rerun-a")
            .unwrap()
            .claim
            .token(),
        a.token()
    );
    assert_eq!(
        acquire(&f.work, &second, "no-rerun-b")
            .unwrap()
            .claim
            .token(),
        b.token()
    );
}

#[test]
fn post_rename_sync_failure_returns_a_usable_admission_session() {
    struct Restore;
    impl Drop for Restore {
        fn drop(&mut self) {
            *SYNC_FAILURE_PARENT
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = None;
        }
    }
    let f = Fixture::new();
    let before = SYNC_FAILURES.load(std::sync::atomic::Ordering::SeqCst);
    *SYNC_FAILURE_PARENT.lock().unwrap() = Some(f.work.join(CLAIM_DIR));
    let restore = Restore;
    let request = serde_json::json!({"taskExecution": f.request("sync-written")});
    let (session, replayed) = crate::task_execution_runtime::TaskExecutionSession::admit(
        f.work.to_str().unwrap(),
        Some(&request),
        "sync-run",
    )
    .unwrap()
    .unwrap();
    assert!(!replayed);
    assert!(SYNC_FAILURES.load(std::sync::atomic::Ordering::SeqCst) > before);
    assert!(f.file(&session.token.task_id).is_file());
    session.check().unwrap();
    drop(restore);
    session.admission_failed();
    assert_eq!(
        read_claim(&f.file(&session.token.task_id), &session.token.task_id)
            .unwrap()
            .unwrap()
            .lifecycle,
        TaskExecutionLifecycle::Released
    );
}

#[cfg(unix)]
#[test]
fn failed_initial_identity_write_publishes_no_active_claim() {
    let f = Fixture::new();
    let path = f
        .work
        .join("tasks/active")
        .join(format!("{}.md", "a".repeat(238)));
    let original = "---\nstatus: active\n---\nTask\n";
    fs::write(&path, original).unwrap();
    let request = TaskExecutionRequest {
        request_id: "identity-write-failed".into(),
        task_path: path
            .strip_prefix(&f.work)
            .unwrap()
            .to_string_lossy()
            .into_owned(),
        source_revision: crate::document::revision_for(original),
        tasks_root: None,
    };
    let error = acquire(&f.work, &request, "must-not-start").unwrap_err();
    assert!(error.contains("identity_write_failed"), "{error}");
    assert_eq!(fs::read_to_string(path).unwrap(), original);
    assert_eq!(
        fs::read_dir(f.work.join(CLAIM_DIR))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry
                .path()
                .extension()
                .is_some_and(|value| value == "json"))
            .count(),
        0
    );
}

#[cfg(unix)]
#[test]
fn first_identity_write_preserves_a_concurrent_process_edit_and_publishes_no_claim() {
    let f = Fixture::new();
    let request = f.request("identity-race");
    let concurrent = "---\ntitle: Concurrent edit\nstatus: active\n---\nKeep this body\n";
    let target = f.path.clone();
    let _hook = crate::atomic_file::PathTransactionTestHook::new(
        f.path.clone(),
        "task-identity-before-revision-check",
        move || {
            // An independent writer does not share in-process path admission.
            let status = Command::new("sh")
                .arg("-c")
                .arg("printf '%s' \"$1\" > \"$2\"")
                .arg("task-co-writer")
                .arg(concurrent)
                .arg(&target)
                .status()
                .unwrap();
            assert!(
                status.success(),
                "co-writer fixture failed; inspect the temporary task permissions"
            );
        },
    );
    let error = acquire(&f.work, &request, "must-not-start").unwrap_err();
    assert!(error.contains("task changed while starting"), "{error}");
    assert!(error.contains("reread the task"), "{error}");
    assert_eq!(fs::read_to_string(&f.path).unwrap(), concurrent);
    assert!(fs::read_dir(f.work.join(CLAIM_DIR))
        .unwrap()
        .filter_map(Result::ok)
        .all(|entry| entry.path().extension().is_none_or(|ext| ext != "json")));
}

#[test]
fn claimed_rename_to_non_markdown_is_refused_before_effects() {
    let f = Fixture::new();
    let claim = acquire(&f.work, &f.request("rename-extension"), "rename-run")
        .unwrap()
        .claim;
    let original = fs::read(&f.path).unwrap();
    let sidecar = fs::read(f.file(&claim.task_id)).unwrap();
    for target in ["task.txt", "task.MD", "task"] {
        let error = crate::workspace_files::rename_workspace_entry(
            display(&f.work),
            "tasks/active/task.md".into(),
            target.into(),
        )
        .unwrap_err();
        assert!(error.contains("must keep a .md"), "{error}");
        assert!(error.contains("keep the .md extension"), "{error}");
        assert_eq!(fs::read(&f.path).unwrap(), original);
        // Directory-entry spelling also catches case-only targets on macOS.
        assert!(fs::read_dir(f.path.parent().unwrap())
            .unwrap()
            .filter_map(Result::ok)
            .all(|entry| entry.file_name() != target));
        assert_eq!(fs::read(f.file(&claim.task_id)).unwrap(), sidecar);
    }
    check(&f.work, &claim.token()).unwrap();
}

/// Two-process writer fixture for #541 AC1. The parent holds the claim lock a
/// provider holds from its source check through the spawn; this child tries a
/// document save or a Today completion on the same note and reports whether it
/// landed (exit 0) or was refused (exit 3).
#[test]
fn writer_contender() {
    let Ok(raw) = std::env::var("MARU_TASK_WRITE_FIXTURE") else {
        return;
    };
    let (work, kind, run_id): (PathBuf, String, String) = serde_json::from_str(&raw).unwrap();
    fs::write(work.join(format!("ready-{run_id}")), "ready").unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while !work.join("go").exists() {
        assert!(
            Instant::now() < deadline,
            "writer fixture start signal absent; inspect the parent test"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    let result = if kind == "document" {
        // A body edit keeps the note's identity; dropping taskId here would
        // replace the claim-freshness refusal with a missing-task one.
        let current = fs::read_to_string(work.join("tasks/active/task.md")).unwrap();
        let task_id = task_id_from_content(&current).unwrap_or_default();
        crate::document::save_document(
            display(&work),
            "tasks/active/task.md".into(),
            format!(
                "---\ntitle: Task\ntaskId: {task_id}\nstatus: active\n---\nBody saved by the other process\n"
            ),
            None,
        )
        .map(|_| ())
    } else {
        let raw = fs::read_to_string(work.join("tasks/active/task.md")).unwrap();
        crate::today_lifecycle::task_transition(
            display(&work),
            crate::today::TaskTransitionRequest {
                task_id: task_id_from_content(&raw).unwrap_or_default(),
                task_path: "tasks/active/task.md".into(),
                kind: crate::today::TaskTransitionKind::Complete,
                expected_task_hash: crate::document::revision_for(&raw),
                defer_date: None,
                date: Some("2026-11-08".into()),
                now_iso: Some("2026-11-08T09:00:00+09:00".into()),
                web_action_id: None,
                payload: serde_json::json!({}),
            },
        )
        .map(|_| ())
    };
    match result {
        Ok(()) => {
            fs::write(work.join(format!("done-{run_id}")), "done").unwrap();
            std::process::exit(0);
        }
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(3);
        }
    }
}

/// Locate the note that carries `task_id`, scanning the tasks tree the way the
/// claim code does. A miss reports every markdown file it saw, so a lost
/// identity is visible instead of a bare "not found".
fn task_note_carrying(work: &Path, task_id: &str) -> PathBuf {
    let mut scanned = Vec::new();
    for entry in walkdir::WalkDir::new(work.join("tasks"))
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file()
            || entry.path().extension().and_then(|value| value.to_str()) != Some("md")
        {
            continue;
        }
        scanned.push(display(entry.path()));
        let Ok(content) = fs::read_to_string(entry.path()) else {
            continue;
        };
        let found = task_id_from_content(&content);
        if found.as_deref() == Some(task_id) {
            return entry.path().to_path_buf();
        }
        scanned.push(format!(
            "{} -> {:?}",
            display(entry.path()),
            found.as_deref()
        ));
    }
    panic!("no note carries taskId {task_id}; scanned {scanned:?}");
}

/// AC1: while another process holds the claim, a document save and a Today
/// completion both wait for it, and a spawn never starts after such a write
/// has committed.
#[test]
fn another_process_write_waits_for_the_claim_lock_and_fences_the_spawn() {
    for kind in ["document", "today"] {
        let f = Fixture::new();
        let claim = acquire(&f.work, &f.request(&format!("writer-{kind}")), "holder-run")
            .unwrap()
            .claim;
        let bound = fs::read_to_string(&f.path).unwrap();
        // What a provider holds across its source check and the spawn.
        let held = guard_task_mutation(&f.work, &f.path).unwrap().unwrap();
        let run = format!("run-{kind}");
        let raw = serde_json::to_string(&(f.work.clone(), kind.to_string(), run.clone())).unwrap();
        let child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "task_execution_claims::tests::writer_contender",
                "--nocapture",
            ])
            .env("MARU_TASK_WRITE_FIXTURE", raw)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        while !f.work.join(format!("ready-{run}")).exists() {
            assert!(
                Instant::now() < deadline,
                "{kind} writer fixture did not start; inspect its stderr and the test binary path"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        fs::write(f.work.join("go"), "go").unwrap();
        // Holding the claim lock is the whole test: no amount of host load can
        // make a blocked writer commit, so this window has no false positive.
        std::thread::sleep(Duration::from_millis(400));
        assert!(
            !f.work.join(format!("done-{run}")).exists(),
            "{kind} write committed while another owner held the claim lock"
        );
        assert_eq!(fs::read_to_string(&f.path).unwrap(), bound);
        drop(held);
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{kind} writer was not admitted after the claim lock was released: {output:?}"
        );
        let stored = read_claim(&f.file(&claim.task_id), &claim.task_id)
            .unwrap()
            .unwrap();
        assert_eq!(stored.lifecycle, TaskExecutionLifecycle::NeedsReview);
        let spawned = std::cell::Cell::new(false);
        let error = spawn_owned_child(&f.work, &claim.token(), || {
            spawned.set(true);
            Err("must not execute".into())
        })
        .unwrap_err();
        assert!(
            !spawned.get(),
            "{kind}: a spawn started after another process committed a write"
        );
        assert!(error.contains("claim_not_active"), "{error}");
        match kind {
            "document" => assert!(fs::read_to_string(&f.path)
                .unwrap()
                .contains("Body saved by the other process")),
            // Today completion archives the note and rebinds the claim to it.
            _ => {
                let archived = task_note_carrying(&f.work, &claim.task_id);
                assert!(!f.path.exists(), "{kind}: the active note must be moved");
                assert!(
                    display(&archived).contains("/archive/"),
                    "{kind}: the completed note should sit in the archive bucket: {}",
                    display(&archived)
                );
            }
        }
    }
}

/// AC2: ordinary notes, non-opt-in tasks and a modify-only workspace keep
/// their previous document and Today writes and create no claim state.
#[test]
fn unclaimed_notes_and_tasks_keep_unlocked_writes_and_create_no_claim() {
    let home = Home::new();
    let work = home.root.path().join("plain");
    fs::create_dir_all(&work).unwrap();
    let note = work.join("note.md");
    fs::write(&note, "---\ntitle: Note\n---\nBody\n").unwrap();
    let payload = crate::document::save_document(
        display(&work),
        "note.md".into(),
        "---\ntitle: Note\n---\nBody\nEdited\n".into(),
        None,
    )
    .unwrap();
    assert!(payload.content.contains("Edited"));
    let patched = crate::document::update_frontmatter_field(
        display(&work),
        "note.md".into(),
        "title".into(),
        Some(crate::document::FieldInput::Str("Renamed".into())),
        Some(crate::document::revision_for(&payload.content)),
    )
    .unwrap();
    assert_eq!(patched.meta["title"], "Renamed");
    assert!(!work.join(CLAIM_DIR).exists());

    // A task note with a taskId but no claim is not opted in.
    let task = work.join("tasks/active/plain.md");
    fs::create_dir_all(task.parent().unwrap()).unwrap();
    fs::write(
        &task,
        "---\ntitle: Plain\ntaskId: plain-task\nstatus: active\n---\nPlain body\n",
    )
    .unwrap();
    crate::document::save_document(
        display(&work),
        "tasks/active/plain.md".into(),
        "---\ntitle: Plain\ntaskId: plain-task\nstatus: active\n---\nPlain body edited\n".into(),
        None,
    )
    .unwrap();
    assert!(!work.join(CLAIM_DIR).exists());
    let raw = fs::read_to_string(&task).unwrap();
    let outcome = crate::today_lifecycle::task_transition(
        display(&work),
        crate::today::TaskTransitionRequest {
            task_id: "plain-task".into(),
            task_path: "tasks/active/plain.md".into(),
            kind: crate::today::TaskTransitionKind::Complete,
            expected_task_hash: crate::document::revision_for(&raw),
            defer_date: None,
            date: Some("2026-11-08".into()),
            now_iso: Some("2026-11-08T09:00:00+09:00".into()),
            web_action_id: None,
            payload: serde_json::json!({}),
        },
    )
    .unwrap();
    assert_eq!(outcome.bucket, "archive");
    assert!(!work.join(CLAIM_DIR).exists());

    // Workspaces without create permission keep their document writes usable.
    use crate::vault_list::{ProviderPermissionSummary, WorkspaceCapabilities, WorkspaceRootEntry};
    crate::vault_list::add_workspace_root(WorkspaceRootEntry {
        label: "Modify only".into(),
        path: display(&work),
        visibility: "public".into(),
        provider: "nextcloud".into(),
        provider_id: None,
        external_writer: None,
        write_policy: "direct".into(),
        permission_summary: Some(ProviderPermissionSummary {
            role: Some("3".into()),
            source: "manual".into(),
            checked_at: None,
            capabilities: WorkspaceCapabilities::default(),
            warning: None,
        }),
    })
    .unwrap();
    assert!(crate::vault_list::assert_maru_can_write(
        &display(&work),
        WorkspaceWriteAction::Create
    )
    .is_err());
    let current = fs::read_to_string(&note).unwrap();
    crate::document::save_document(
        display(&work),
        "note.md".into(),
        format!("{current}Still writable\n"),
        Some(crate::document::revision_for(&current)),
    )
    .unwrap();
    assert!(!work.join(CLAIM_DIR).exists());
}

/// AC3: claim locks, Today work locks and path leases keep one order in both
/// directions — the claim lock is never taken behind a work lock or a lease,
/// the work lock is never taken before a claim lock, and a batch sorts its
/// claim locks so two callers with opposite input orders cannot invert them.
#[test]
fn claim_today_work_lock_and_lease_never_invert_between_writers() {
    use std::sync::mpsc;
    let f = Fixture::new();
    let claim = acquire(&f.work, &f.request("order"), "order-run")
        .unwrap()
        .claim;
    let second = f.work.join("tasks/active/second.md");
    fs::write(&second, "---\nstatus: active\n---\nSecond\n").unwrap();
    let second_request = TaskExecutionRequest {
        request_id: "order-second".into(),
        task_path: "tasks/active/second.md".into(),
        source_revision: crate::document::revision_for(&fs::read_to_string(&second).unwrap()),
        tasks_root: None,
    };
    let second_claim = acquire(&f.work, &second_request, "order-second-run")
        .unwrap()
        .claim;

    // 1. The claim lock is not behind the Today work lock: a document writer
    //    takes it while another actor holds the work lock.
    let today_lock = crate::today_store::work_lock_for(&f.work).unwrap();
    let held_work = today_lock.lock().unwrap_or_else(|error| error.into_inner());
    let (tx, rx) = mpsc::channel();
    let (work, path) = (f.work.clone(), f.path.clone());
    let writer = std::thread::spawn(move || {
        tx.send(guard_task_mutation(&work, &path)).ok();
    });
    let guarded = rx
        .recv_timeout(Duration::from_secs(30))
        .expect("a document writer must take the claim lock while the Today work lock is held");
    assert!(guarded.unwrap().is_some());
    writer.join().unwrap();
    drop(held_work);

    // 2. A transition waiting on the claim lock holds no Today work lock, so
    //    the work lock stays free for the next writer.
    let held_claim = guard_task_mutation(&f.work, &f.path).unwrap().unwrap();
    let bound = fs::read_to_string(&f.path).unwrap();
    let (tx, rx) = mpsc::channel();
    let (work, path) = (f.work.clone(), f.path.clone());
    let transition = std::thread::spawn(move || {
        tx.send(crate::today_lifecycle::task_transition(
            display(&work),
            crate::today::TaskTransitionRequest {
                task_id: task_id_from_content(&fs::read_to_string(&path).unwrap())
                    .unwrap_or_default(),
                task_path: "tasks/active/task.md".into(),
                kind: crate::today::TaskTransitionKind::Complete,
                expected_task_hash: crate::document::revision_for(&bound),
                defer_date: None,
                date: Some("2026-11-08".into()),
                now_iso: Some("2026-11-08T09:00:00+09:00".into()),
                web_action_id: None,
                payload: serde_json::json!({}),
            },
        ))
        .ok();
    });
    // The transition is in flight and blocked on the claim lock. If it took the
    // Today work lock first, this acquisition would deadlock instead of
    // completing, so it runs on its own thread with a deadline.
    let today_lock = crate::today_store::work_lock_for(&f.work).unwrap();
    let (tx_work, rx_work) = mpsc::channel();
    let holder = std::thread::spawn(move || {
        let held = today_lock.lock().unwrap_or_else(|error| error.into_inner());
        tx_work.send(()).ok();
        std::thread::sleep(Duration::from_millis(200));
        drop(held);
    });
    rx_work
        .recv_timeout(Duration::from_secs(30))
        .expect("the Today work lock must stay free while a transition waits on the claim lock");
    holder.join().unwrap();
    std::thread::sleep(Duration::from_millis(50));
    assert!(
        !f.work.join("tasks/archive/task.md").exists(),
        "the transition wrote while the claim lock was held"
    );
    drop(held_claim);
    let outcome = rx
        .recv_timeout(Duration::from_secs(30))
        .expect("the transition must finish once the claim lock is free")
        .unwrap();
    assert_eq!(outcome.bucket, "archive");
    transition.join().unwrap();

    // 3. A batch locks in task-id order whatever order the caller lists it in.
    //    The first note moved to the archive bucket, so resolve its new path.
    let (first_source, second_source) = (task_note_carrying(&f.work, &claim.task_id), second);
    let (tx, rx) = mpsc::channel();
    for reversed in [false, true] {
        let (work, tx) = (f.work.clone(), tx.clone());
        let (first, second) = (first_source.clone(), second_source.clone());
        std::thread::spawn(move || {
            let sources = if reversed {
                vec![second, first]
            } else {
                vec![first, second]
            };
            tx.send(guard_task_mutations(&work, &sources).map(|guards| guards.len()))
                .ok();
        });
    }
    for _ in 0..2 {
        let count = rx
            .recv_timeout(Duration::from_secs(30))
            .expect("claim locks must be taken in one order whatever the input order")
            .unwrap();
        assert_eq!(count, 2);
    }
    assert_ne!(claim.task_id, second_claim.task_id);
}
