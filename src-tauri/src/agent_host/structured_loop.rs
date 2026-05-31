// Tauri command that drives the five-role structured loop (`roles.rs`) against a
// real CLI provider (Claude/Codex). The loop runs lead → planner → worker →
// reviewer (plus an advisor when high-risk/ambiguous) with bounded rework, then
// emits a single `anchor_skill_proposal_v1` proposal.
//
// Because the loop performs several sequential CLI spawns (each potentially tens
// of seconds), the command returns the run id immediately and runs the loop on a
// worker thread — matching the fire-and-forget model of `ai_router`/`dispatch`.
// Progress is observable two ways:
//   1. run events under `<cwd>/.anchor/runs/skills/<run_id>/events.jsonl`
//      (`run.started` / `role.output` / `proposal.created` / `run.completed|failed`),
//      so the existing `SkillRunsPanel` review→apply path reconstructs the proposal
//      with no new apply code; and
//   2. a logical mission + `ai://done` / `ai://error` events.
use serde_json::json;
use std::thread;

use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::agent_host::event_store::{append_run_event_payload, validate_run_id};
use crate::agent_host::provider::{CliProviderAdapter, CliProviderKind};
use crate::agent_host::roles::{run_five_role_loop, FiveRoleLoopInput};
use crate::ai_router::{AiDoneEvent, AiErrorEvent};
use crate::mission_state;

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn agent_run_structured_loop(
    app: AppHandle,
    provider: String,
    directive: String,
    cwd: String,
    high_risk: Option<bool>,
    ambiguous: Option<bool>,
    max_rework: Option<usize>,
    run_id: Option<String>,
    command_override: Option<String>,
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

    // Write `run.started` up-front so an invalid cwd fails fast (propagated to
    // the caller). The top-level `runtimeProvider` lets the redacted-summary
    // export surface the provider without exposing prompt bodies.
    append_run_event_payload(
        &cwd,
        &run_id,
        "run.started",
        "anchor.structured_loop",
        json!({
            "runtimeProvider": provider_kind.id(),
            "directive": directive,
            "highRisk": high_risk,
            "ambiguous": ambiguous,
            "maxRework": max_rework,
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
        let mut adapter = CliProviderAdapter::new(provider_kind, add_dirs, command_override);
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
                if let Some(proposal) = &result.proposal {
                    let _ = append_run_event_payload(
                        &cwd_thread,
                        &run_id_thread,
                        "proposal.created",
                        "anchor.structured_loop",
                        json!({ "proposal": proposal }),
                    );
                }
                let success = result.status == "passed";
                let _ = append_run_event_payload(
                    &cwd_thread,
                    &run_id_thread,
                    "run.completed",
                    "anchor.structured_loop",
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
                    "anchor.structured_loop",
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
            "#!/bin/sh\nN=$(cat '{c}' 2>/dev/null || echo 0)\nN=$((N+1))\necho \"$N\" > '{c}'\ncase \"$N\" in\n1) echo 'lead directive' ;;\n2) echo 'a plan' ;;\n3) echo '{{\"summary\":\"do it\",\"files\":[],\"commands\":[],\"risks\":[],\"requiresApproval\":true,\"schemaVersion\":\"anchor_skill_proposal_v1\"}}' ;;\n*) echo '{{\"passed\":true,\"findings\":[]}}' ;;\nesac\n",
            c = count.display()
        );
        let cli = write_fake_cli(dir.path().join("fake-claude"), &script);
        let mut adapter = CliProviderAdapter::new(
            CliProviderKind::Claude,
            vec![dir.path().to_string_lossy().into_owned()],
            Some(cli.to_string_lossy().into_owned()),
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
