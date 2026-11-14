use super::*;
use crate::agent_host::contracts::TaskExecutionRequest;
use crate::atomic_file::phase08_06::Home;
use crate::task_execution_claims as claims;
use std::fs;
use std::sync::mpsc;
use std::time::Duration;
use tauri::{Listener, Manager};

const TASK: &str = "tasks/active/task.md";

fn workspace(home: &Home) -> PathBuf {
    let work = home.root.path().join("work");
    fs::create_dir_all(work.join("tasks/active")).unwrap();
    fs::write(
        work.join(TASK),
        "---\nstatus: active\n---\n# Dispatch task\n",
    )
    .unwrap();
    crate::scratchpad::phase08_08::registry(&work, "direct");
    work
}

fn request(work: &Path) -> TaskExecutionRequest {
    TaskExecutionRequest {
        request_id: "dispatch-request".into(),
        task_path: TASK.into(),
        source_revision: crate::document::revision_for(
            &fs::read_to_string(work.join(TASK)).unwrap(),
        ),
        tasks_root: None,
    }
}

fn args(work: &Path, request: &TaskExecutionRequest) -> SkillDispatchBackgroundArgs {
    SkillDispatchBackgroundArgs {
        skill_id: "missing::skill".into(),
        runtime: "codex".into(),
        prompt: "Prepare a task output proposal".into(),
        cwd: Some(work.to_string_lossy().into_owned()),
        context: None,
        metadata: Some(serde_json::json!({
            "origin": "fixture-origin",
            "actor": "forged-reviewer",
            "runtime": "forged-provider",
            "taskExecution": request,
        })),
        command_override: None,
        permission_mode: Some("plan".into()),
    }
}

#[test]
fn background_task_replay_returns_before_skill_preparation_or_run_effects() {
    let home = Home::new();
    let work = workspace(&home);
    let request = request(&work);
    let claim = claims::acquire(&work, &request, "recorded-background-run").unwrap();
    let bound = fs::read(work.join(TASK)).unwrap();
    let app = tauri::test::mock_app();
    app.manage(mission_state::MissionState::default());
    let result = skills_dispatch_background(app.handle().clone(), args(&work, &request));
    assert_eq!(result.unwrap(), claim.claim.run_id);
    assert_eq!(fs::read(work.join(TASK)).unwrap(), bound);
    assert!(!work.join(".maru/runs").exists());
    assert!(mission_state::list_ai_missions(app.handle().clone())
        .unwrap()
        .is_empty());
}

#[test]
fn background_task_preparation_failure_releases_its_unstarted_claim() {
    let home = Home::new();
    let work = workspace(&home);
    let request = request(&work);
    let app = tauri::test::mock_app();
    app.manage(mission_state::MissionState::default());
    assert!(skills_dispatch_background(app.handle().clone(), args(&work, &request)).is_err());
    let paths = fs::read_dir(work.join(".maru/task-execution"))
        .expect("opted-in dispatch must admit before attempting skill preparation")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect::<Vec<_>>();
    assert_eq!(paths.len(), 1);
    let claim: JsonValue = serde_json::from_slice(&fs::read(&paths[0]).unwrap()).unwrap();
    assert_eq!(claim["lifecycle"], "released");
    assert!(claim["receipt"]["child"].is_null());
    assert!(!work.join(".maru/runs").exists());
}

fn completes_claimed_background(approved: bool, exit_code: i32) {
    let home = Home::new();
    let work = workspace(&home);
    let before = fs::read_to_string(work.join(TASK)).unwrap();
    crate::task_completion::set_policy(&work, TASK, true, &crate::document::revision_for(&before))
        .unwrap();
    let request = request(&work);
    let skill =
        crate::skill_host::store::skills_create_skill("task-background-fixture".into(), None)
            .unwrap();
    let marker = home.root.path().join("provider-calls");
    let cli = tests::write_fake_cli(
        home.root.path().join("provider"),
        &format!(
            "#!/bin/sh\nprintf 'called\\n' >> {}\nprintf 'task output\\n'\nexit {exit_code}\n",
            shell_quote(&marker.to_string_lossy())
        ),
    );
    let mut args = args(&work, &request);
    args.skill_id = skill.id;
    args.command_override = Some(cli.to_string_lossy().into_owned());
    args.metadata.as_mut().unwrap()["approvedExecution"] = serde_json::json!(approved);
    let app = tauri::test::mock_app();
    app.manage(mission_state::MissionState::default());
    let (tx, rx) = mpsc::channel();
    app.listen("ai://done", move |event| {
        let value: JsonValue = serde_json::from_str(event.payload()).unwrap();
        let _ = tx.send(value);
    });
    let (start_tx, start_rx) = mpsc::channel();
    let handle = app.handle().clone();
    let launcher = std::thread::spawn(move || {
        let _ = start_tx.send(skills_dispatch_background(handle, args));
    });
    let id = start_rx
        .recv_timeout(Duration::from_secs(10))
        .expect("claim OS lock and broad dispatch reservation must not deadlock at spawn")
        .unwrap();
    launcher.join().unwrap();
    let done = rx
        .recv_timeout(Duration::from_secs(10))
        .expect("claimed background run must finish");
    assert_eq!(done["success"], exit_code == 0);
    assert_eq!(fs::read_to_string(marker).unwrap(), "called\n");
    let view = crate::task_completion::view(&work, TASK).unwrap();
    assert_eq!(view.creator_principals, ["codex"]);
    let receipt = serde_json::to_value(view.receipt.unwrap()).unwrap();
    assert_eq!(receipt["processFinished"], true);
    assert_eq!(receipt["processSuccess"], exit_code == 0);
    let mission = mission_state::list_ai_missions(app.handle().clone())
        .unwrap()
        .into_iter()
        .find(|mission| mission.id == id)
        .unwrap();
    assert_eq!(
        mission.metadata.as_ref().unwrap()["origin"],
        "fixture-origin"
    );
    assert_eq!(
        mission.metadata.as_ref().unwrap()["taskExecution"]["runId"],
        id
    );
    let events =
        crate::agent_host::event_store::read_run_events(&work.to_string_lossy(), &id).unwrap();
    let started = events
        .iter()
        .find(|event| event.event_type == "run.started")
        .unwrap();
    assert_eq!(
        started.payload["dispatch"]["metadata"]["taskExecution"]["requestId"],
        request.request_id
    );
    assert_eq!(
        started.payload["dispatch"]["metadata"]["taskExecution"]["sourceRevision"],
        request.source_revision
    );
    assert!(fs::read_to_string(work.join(TASK))
        .unwrap()
        .contains("status: active"));
}

#[test]
fn background_task_records_actual_provider_and_reaped_result_without_changing_origin() {
    completes_claimed_background(false, 0);
}

#[test]
fn approved_background_task_reuses_its_claim_reservation_and_finishes_without_deadlock() {
    completes_claimed_background(true, 0);
}

#[test]
fn failed_approved_background_task_retains_failure_and_releases_its_claim_reservation() {
    completes_claimed_background(true, 9);
}
