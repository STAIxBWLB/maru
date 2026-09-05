// Tauri command that drives the five-role structured loop (`roles.rs`) against a
// real CLI provider (Claude/Codex). The loop runs lead → planner → worker →
// reviewer (plus an advisor when high-risk/ambiguous) with bounded rework, then
// emits a single `maru_skill_proposal_v1` proposal.
//
// Because the loop performs several sequential CLI spawns (each potentially tens
// of seconds), the command returns the run id immediately and runs the loop on a
// worker thread — matching the fire-and-forget model of `ai_router`/`dispatch`.
// Progress is observable two ways:
//   1. run events under `<cwd>/.maru/runs/skills/<run_id>/events.jsonl`
//      (`run.started` / `role.output` / `proposal.created` / `run.completed|failed`),
//      so the existing `SkillRunsPanel` review→apply path reconstructs the proposal
//      with no new apply code; and
//   2. a logical mission + `ai://done` / `ai://error` events.
use serde_json::json;
use std::thread;

use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::agent_host::event_store::{append_run_event_payload, validate_run_id};
use crate::agent_host::provider::{normalize_permission_mode, CliProviderAdapter, CliProviderKind};
use crate::agent_host::roles::{run_five_role_loop, FiveRoleLoopInput};
use crate::ai_router::{AiDoneEvent, AiErrorEvent};
use crate::mission_state;

#[allow(clippy::too_many_arguments)]
pub fn agent_run_structured_loop<R: tauri::Runtime>(
    app: AppHandle<R>,
    provider: String,
    directive: String,
    cwd: String,
    high_risk: Option<bool>,
    ambiguous: Option<bool>,
    max_rework: Option<usize>,
    run_id: Option<String>,
    command_override: Option<String>,
    permission_mode: Option<String>,
) -> Result<String, String> {
    if directive.trim().is_empty() {
        return Err("five_role_directive_required".to_string());
    }
    if cwd.trim().is_empty() {
        return Err("agent_run_cwd_required".to_string());
    }
    let provider_kind = CliProviderKind::parse(&provider)?;
    let run_id = match run_id {
        Some(id) => {
            validate_run_id(&id)?;
            id
        }
        None => format!("ai-{}", Uuid::new_v4()),
    };
    let high_risk = high_risk.unwrap_or(false);
    let ambiguous = ambiguous.unwrap_or(false);
    let max_rework = max_rework.unwrap_or(1);
    let command_override = command_override.filter(|value| !value.trim().is_empty());
    let permission_mode =
        normalize_permission_mode(permission_mode.as_deref().unwrap_or("plan")).to_string();

    // Write `run.started` up-front so an invalid cwd fails fast (propagated to
    // the caller). The top-level `runtimeProvider` lets the redacted-summary
    // export surface the provider without exposing prompt bodies.
    append_run_event_payload(
        &cwd,
        &run_id,
        "run.started",
        "maru.structured_loop",
        json!({
            "runtimeProvider": provider_kind.id(),
            "directive": directive,
            "highRisk": high_risk,
            "ambiguous": ambiguous,
            "maxRework": max_rework,
            "permissionMode": permission_mode,
            "commandOverride": command_override,
        }),
    )?;

    mission_state::register_mission_logical(
        &app,
        &run_id,
        provider_kind.id(),
        Some(json!({
            "origin": "structuredLoop",
            "provider": provider_kind.id(),
            // `runtime` + `workspacePath` mirror the skill-dispatch mission shape so
            // SkillRunsPanel labels the run and resolves the cwd for review/apply.
            "runtime": provider_kind.id(),
            "workspacePath": cwd.clone(),
            "skillName": "Structured run",
            "permissionMode": permission_mode,
            "commandOverride": command_override,
        })),
    )?;

    let input = FiveRoleLoopInput {
        directive,
        cwd: cwd.clone(),
        high_risk,
        ambiguous,
        max_rework,
    };
    let add_dirs = vec![cwd.clone()];

    let app_thread = app.clone();
    let run_id_thread = run_id.clone();
    let cwd_thread = cwd;
    thread::spawn(move || {
        let mut adapter =
            CliProviderAdapter::new(provider_kind, add_dirs, command_override, permission_mode);
        match run_five_role_loop(&mut adapter, input) {
            Ok(result) => {
                for role_output in &result.role_outputs {
                    let _ = append_run_event_payload(
                        &cwd_thread,
                        &run_id_thread,
                        "role.output",
                        &role_output.role,
                        json!({ "role": role_output.role, "content": role_output.content }),
                    );
                }
                let success = result.status == "passed";
                // Only a reviewer-approved ("passed") proposal is applicable. A
                // proposal that failed the structured review must NOT surface as
                // `proposal.created`, or SkillRunsPanel would let it be applied.
                if success {
                    if let Some(proposal) = &result.proposal {
                        let _ = append_run_event_payload(
                            &cwd_thread,
                            &run_id_thread,
                            "proposal.created",
                            "maru.structured_loop",
                            json!({ "proposal": proposal }),
                        );
                    }
                }
                let _ = append_run_event_payload(
                    &cwd_thread,
                    &run_id_thread,
                    "run.completed",
                    "maru.structured_loop",
                    json!({
                        "status": result.status,
                        "iterations": result.iterations,
                        "advisorCalled": result.advisor_called,
                        "result": result,
                    }),
                );
                mission_state::finish_mission(&app_thread, &run_id_thread, Some(0), success);
                let _ = app_thread.emit(
                    "ai://done",
                    AiDoneEvent {
                        invocation_id: run_id_thread.clone(),
                        exit_code: Some(0),
                        success,
                    },
                );
            }
            Err(err) => {
                let _ = append_run_event_payload(
                    &cwd_thread,
                    &run_id_thread,
                    "run.failed",
                    "maru.structured_loop",
                    json!({ "error": err }),
                );
                mission_state::fail_mission(&app_thread, &run_id_thread, &err);
                let _ = app_thread.emit(
                    "ai://error",
                    AiErrorEvent {
                        invocation_id: run_id_thread.clone(),
                        kind: "loop_failed".to_string(),
                        message: err,
                    },
                );
            }
        }
    });

    Ok(run_id)
}

/// IPC owns values before offloading; synchronous Rust callers keep their API.
pub mod ipc {
    use super::*;

    #[tauri::command]
    #[allow(clippy::too_many_arguments)]
    pub async fn agent_run_structured_loop<R: tauri::Runtime>(
        app: AppHandle<R>,
        provider: String,
        directive: String,
        cwd: String,
        high_risk: Option<bool>,
        ambiguous: Option<bool>,
        max_rework: Option<usize>,
        run_id: Option<String>,
        command_override: Option<String>,
        permission_mode: Option<String>,
    ) -> Result<String, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            crate::atomic_file::PathTransactionLease::test_stage(
                &[std::path::PathBuf::from(&cwd)],
                "worker:agent_run_structured_loop",
            );
            super::agent_run_structured_loop(
                app,
                provider,
                directive,
                cwd,
                high_risk,
                ambiguous,
                max_rework,
                run_id,
                command_override,
                permission_mode,
            )
        })
        .await
        .map_err(|err| format!("agent_run_structured_loop_task_failed: {err}"))?
    }
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use crate::agent_host::provider::{CliProviderAdapter, CliProviderKind};
    #[cfg(unix)]
    use crate::agent_host::roles::{run_five_role_loop, FiveRoleLoopInput};

    #[cfg(unix)]
    fn write_fake_cli(path: std::path::PathBuf, script: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(&path, script).unwrap();
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).unwrap();
        path
    }

    // Proves the real CLI adapter composes with the five-role loop end-to-end: a
    // counter-file fake CLI returns lead → plan → proposal → passing-review across
    // its four sequential calls, and the loop converges to a parsed proposal.
    #[cfg(unix)]
    #[test]
    fn structured_loop_with_cli_adapter_converges_to_proposal() {
        let dir = tempfile::tempdir().unwrap();
        let count = dir.path().join("count");
        let script = format!(
            "#!/bin/sh\nN=$(cat '{c}' 2>/dev/null || echo 0)\nN=$((N+1))\necho \"$N\" > '{c}'\ncase \"$N\" in\n1) echo 'lead directive' ;;\n2) echo 'a plan' ;;\n3) echo '{{\"summary\":\"do it\",\"files\":[],\"commands\":[],\"risks\":[],\"requiresApproval\":true,\"schemaVersion\":\"maru_skill_proposal_v1\"}}' ;;\n*) echo '{{\"passed\":true,\"findings\":[]}}' ;;\nesac\n",
            c = count.display()
        );
        let cli = write_fake_cli(dir.path().join("fake-claude"), &script);
        let mut adapter = CliProviderAdapter::new(
            CliProviderKind::Claude,
            vec![dir.path().to_string_lossy().into_owned()],
            Some(cli.to_string_lossy().into_owned()),
            "plan".to_string(),
        );
        let result = run_five_role_loop(
            &mut adapter,
            FiveRoleLoopInput {
                directive: "do work".to_string(),
                cwd: dir.path().to_string_lossy().into_owned(),
                high_risk: false,
                ambiguous: false,
                max_rework: 1,
            },
        )
        .unwrap();
        assert_eq!(result.status, "passed");
        assert!(result.proposal.is_some());
        assert_eq!(result.iterations, 1);
    }
}

#[cfg(all(test, unix))]
mod phase08_16 {
    use super::*;
    use crate::atomic_file::phase08_06::{boundary, run, Home};
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    use std::time::{Duration, Instant};
    use tauri::Manager;

    fn text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    fn fixture(home: &Home) -> (std::path::PathBuf, std::path::PathBuf) {
        let work = home.root.path().join("loop-work");
        fs::create_dir_all(&work).unwrap();
        let count = work.join("count");
        let script = format!(
            "#!/bin/sh\nN=$(cat '{c}' 2>/dev/null || echo 0)\nN=$((N+1))\necho \"$N\" > '{c}'\ncase \"$N\" in\n1) echo 'lead directive' ;;\n2) echo 'a plan' ;;\n3) echo '{{\"summary\":\"do it\",\"files\":[],\"commands\":[],\"risks\":[],\"requiresApproval\":true,\"schemaVersion\":\"maru_skill_proposal_v1\"}}' ;;\n*) echo '{{\"passed\":true,\"findings\":[]}}' ;;\nesac\n",
            c = count.display()
        );
        let cli = home.root.path().join("fake-claude");
        fs::write(&cli, script).unwrap();
        let mut perms = fs::metadata(&cli).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&cli, perms).unwrap();
        (work, cli)
    }

    #[test]
    fn phase08_16_structured_loop_wrapper_runs_fixture_cli_to_proposal() {
        let home = Home::new();
        let app = tauri::test::mock_app();
        app.manage(crate::mission_state::MissionState::default());
        let handle = app.handle().clone();
        let (work, cli) = fixture(&home);
        let cwd = text(&work);

        let run_id = run(ipc::agent_run_structured_loop(
            handle.clone(),
            "claude".into(),
            "do work".into(),
            cwd.clone(),
            None,
            None,
            Some(1),
            None,
            Some(text(&cli)),
            Some("plan".into()),
        ))
        .unwrap();
        assert!(run_id.starts_with("ai-"), "{run_id}");

        let events_path = crate::agent_host::event_store::run_events_path(&cwd, &run_id).unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        let raw = loop {
            if let Ok(raw) = fs::read_to_string(&events_path) {
                if raw.contains("\"run.completed\"") {
                    break raw;
                }
            }
            assert!(Instant::now() < deadline, "structured loop must complete");
            std::thread::sleep(Duration::from_millis(15));
        };
        assert!(raw.contains("\"run.started\""));
        assert!(raw.contains("\"role.output\""));
        assert!(raw.contains("\"proposal.created\""));
        assert!(raw.contains("\"passed\""));

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let records = run(crate::mission_state::ipc::list_ai_missions(handle.clone())).unwrap();
            if let Some(record) = records.iter().find(|r| r.id == run_id) {
                assert_eq!(record.status, crate::mission_state::MissionStatus::Done);
                assert_eq!(record.exit_code, Some(0));
                break;
            }
            assert!(Instant::now() < deadline, "mission must settle done");
            std::thread::sleep(Duration::from_millis(15));
        }

        assert_eq!(
            run(ipc::agent_run_structured_loop(
                handle.clone(),
                "claude".into(),
                "  ".into(),
                cwd.clone(),
                None,
                None,
                None,
                None,
                None,
                None,
            ))
            .unwrap_err(),
            "five_role_directive_required"
        );
        assert_eq!(
            run(ipc::agent_run_structured_loop(
                handle.clone(),
                "claude".into(),
                "work".into(),
                "  ".into(),
                None,
                None,
                None,
                None,
                None,
                None,
            ))
            .unwrap_err(),
            "agent_run_cwd_required"
        );
        assert!(run(ipc::agent_run_structured_loop(
            handle,
            "openai".into(),
            "work".into(),
            cwd,
            None,
            None,
            None,
            None,
            None,
            None,
        ))
        .unwrap_err()
        .starts_with("unsupported_provider"));
    }

    #[test]
    fn phase08_16_structured_loop_wrapper_yields_same_poll_and_maps_join_failure() {
        let home = Home::new();
        let app = tauri::test::mock_app();
        app.manage(crate::mission_state::MissionState::default());
        let handle = app.handle().clone();
        let (work, cli) = fixture(&home);
        boundary(
            work.clone(),
            "agent_run_structured_loop",
            ipc::agent_run_structured_loop(
                handle,
                "claude".into(),
                "do work".into(),
                text(&work),
                None,
                None,
                Some(1),
                None,
                Some(text(&cli)),
                Some("plan".into()),
            ),
        );
    }
}
