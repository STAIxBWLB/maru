use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::path::{Path, PathBuf};

use crate::agent_host::event_store::{read_run_events, summarize_events, RunReplaySummary};
use crate::atomic_file::{with_path_transactions, PathTransactionLease, PathTransactionRequest};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RedactedRunSummary {
    pub run_id: String,
    pub event_count: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_type: Option<String>,
    pub proposal_count: usize,
    pub write_claimed_count: usize,
    pub write_committed_count: usize,
    pub write_conflict_count: usize,
    #[serde(default)]
    pub providers: Vec<String>,
    #[serde(default)]
    pub skills: Vec<String>,
}

pub fn agent_export_redacted_run_summary(
    cwd: String,
    run_id: String,
) -> Result<RedactedRunSummary, String> {
    export_redacted_run_summary(&cwd, &run_id)
}

pub fn export_redacted_run_summary(cwd: &str, run_id: &str) -> Result<RedactedRunSummary, String> {
    let events = read_run_events(cwd, run_id)?;
    let summary = summarize_events(run_id, &events);
    Ok(redact_summary(
        summary,
        events.iter().map(|event| &event.payload),
    ))
}

/// Build the redacted summary and write it as pretty JSON to `target_path`
/// (creating parent directories). Returns the written path. The UI uses this to
/// "Export redacted summary" — there is no JS-side file write, so the bytes are
/// produced here, server-side.
pub fn agent_write_redacted_run_summary(
    cwd: String,
    run_id: String,
    target_path: String,
) -> Result<String, String> {
    write_redacted_run_summary(&cwd, &run_id, &target_path)
}

/// Resolve the export target exactly where `std::fs::write` would place a
/// relative path, then admit that single-file write set.
fn write_redacted_run_summary(
    cwd: &str,
    run_id: &str,
    target_path: &str,
) -> Result<String, String> {
    if target_path.trim().is_empty() {
        return Err("redacted_summary_target_required".to_string());
    }
    let summary = export_redacted_run_summary(cwd, run_id)?;
    let json = serde_json::to_string_pretty(&summary)
        .map_err(|err| format!("redacted_summary_serialize_failed: {err}"))?;
    let path = absolute_export_target(target_path)?;
    with_path_transactions(PathTransactionRequest::new(vec![path.clone()])?, |lease| {
        write_redacted_run_summary_in_transaction(&path, target_path, &json, lease)
    })
}

fn absolute_export_target(target_path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(target_path);
    let absolute = if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .map_err(|err| format!("redacted_summary_dir_failed: {err}"))?
            .join(path)
    };
    Ok(crate::vault::lexical_normalize(&absolute))
}

fn write_redacted_run_summary_in_transaction(
    path: &Path,
    target_path: &str,
    json: &str,
    lease: &PathTransactionLease,
) -> Result<String, String> {
    lease.ensure_covered(vec![path.to_path_buf()])?;
    lease.before_effect()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("redacted_summary_dir_failed: {err}"))?;
    }
    std::fs::write(path, json.as_bytes())
        .map_err(|err| format!("redacted_summary_write_failed: {err}"))?;
    Ok(target_path.to_string())
}

pub mod ipc {
    use super::*;

    #[tauri::command]
    pub async fn agent_export_redacted_run_summary(
        cwd: String,
        run_id: String,
    ) -> Result<RedactedRunSummary, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            if let Ok(path) = crate::agent_host::event_store::run_events_path(&cwd, &run_id) {
                PathTransactionLease::test_stage(
                    &[path],
                    "worker:agent_export_redacted_run_summary",
                );
            }
            super::agent_export_redacted_run_summary(cwd, run_id)
        })
        .await
        .map_err(|err| format!("agent_export_redacted_run_summary_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn agent_write_redacted_run_summary(
        cwd: String,
        run_id: String,
        target_path: String,
    ) -> Result<String, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            if let Ok(path) = super::absolute_export_target(&target_path) {
                PathTransactionLease::test_stage(
                    &[path],
                    "worker:agent_write_redacted_run_summary",
                );
            }
            super::agent_write_redacted_run_summary(cwd, run_id, target_path)
        })
        .await
        .map_err(|err| format!("agent_write_redacted_run_summary_task_failed: {err}"))?
    }
}

fn redact_summary<'a>(
    summary: RunReplaySummary,
    payloads: impl Iterator<Item = &'a JsonValue>,
) -> RedactedRunSummary {
    let mut providers = Vec::new();
    let mut skills = Vec::new();
    for payload in payloads {
        if let Some(provider) = payload
            .get("request")
            .and_then(|request| request.get("runtimeProvider"))
            .or_else(|| payload.get("runtimeProvider"))
            .and_then(|value| value.as_str())
        {
            push_unique(&mut providers, provider);
        }
        if let Some(skill) = payload
            .get("request")
            .and_then(|request| request.get("skillId"))
            .or_else(|| payload.get("skillId"))
            .and_then(|value| value.as_str())
        {
            push_unique(&mut skills, skill);
        }
    }
    RedactedRunSummary {
        run_id: summary.run_id,
        event_count: summary.event_count,
        last_type: summary.last_type,
        proposal_count: summary.proposal_count,
        write_claimed_count: summary.write_claimed_count,
        write_committed_count: summary.write_committed_count,
        write_conflict_count: summary.write_conflict_count,
        providers,
        skills,
    }
}

fn push_unique(values: &mut Vec<String>, value: &str) {
    if !values.iter().any(|existing| existing == value) {
        values.push(value.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_host::contracts::new_run_event;
    use serde_json::json;

    #[test]
    fn redacted_summary_keeps_metadata_not_payload_body() {
        let events = vec![new_run_event(
            "ai-test",
            "run.started",
            "agent",
            json!({
                "request": {
                    "runtimeProvider": "claude",
                    "skillId": "maru-builtin::meeting-notes",
                    "intent": "secret prompt body"
                }
            }),
            None,
        )];
        let summary = redact_summary(
            summarize_events("ai-test", &events),
            events.iter().map(|e| &e.payload),
        );
        assert_eq!(summary.providers, vec!["claude"]);
        assert_eq!(summary.skills, vec!["maru-builtin::meeting-notes"]);
    }

    #[test]
    fn redacted_summary_reads_top_level_runtime_provider() {
        // The structured-loop `run.started` payload carries `runtimeProvider` at
        // the top level (not nested under `request`).
        let events = vec![new_run_event(
            "ai-loop",
            "run.started",
            "maru.structured_loop",
            json!({ "runtimeProvider": "codex", "directive": "secret directive" }),
            None,
        )];
        let summary = redact_summary(
            summarize_events("ai-loop", &events),
            events.iter().map(|e| &e.payload),
        );
        assert_eq!(summary.providers, vec!["codex"]);
    }

    #[test]
    fn write_redacted_summary_emits_json_file() {
        use crate::agent_host::event_store::append_run_event;
        let tmp = tempfile::TempDir::new().unwrap();
        let cwd = tmp.path().to_string_lossy().to_string();
        append_run_event(
            &cwd,
            &new_run_event(
                "ai-export",
                "run.started",
                "maru.structured_loop",
                json!({ "runtimeProvider": "codex" }),
                None,
            ),
        )
        .unwrap();
        append_run_event(
            &cwd,
            &new_run_event(
                "ai-export",
                "proposal.created",
                "maru.structured_loop",
                json!({}),
                None,
            ),
        )
        .unwrap();
        let target = tmp.path().join("export").join("summary.json");
        let written = agent_write_redacted_run_summary(
            cwd,
            "ai-export".to_string(),
            target.to_string_lossy().to_string(),
        )
        .unwrap();
        assert_eq!(written, target.to_string_lossy());
        let parsed: RedactedRunSummary =
            serde_json::from_str(&std::fs::read_to_string(&target).unwrap()).unwrap();
        assert_eq!(parsed.run_id, "ai-export");
        assert_eq!(parsed.proposal_count, 1);
        assert_eq!(parsed.providers, vec!["codex"]);
    }
}

#[cfg(test)]
mod phase08_17 {
    use super::ipc;
    use super::*;
    use crate::agent_host::contracts::new_run_event;
    use crate::agent_host::event_store::append_run_event;
    use crate::atomic_file::phase08_06::{boundary, run, Held, Home};
    use crate::atomic_file::PathTransactionTestHook;
    use crate::workspace_files::{ipc as files_ipc, phase08_06::TrashFixture};
    use serde_json::json;
    use std::sync::mpsc;
    use std::time::Duration;

    fn text(path: &std::path::Path) -> String {
        path.to_string_lossy().into_owned()
    }

    fn seed_run(cwd: &str) {
        for event_type in ["run.started", "proposal.created"] {
            let event = new_run_event(
                "ai-export",
                event_type,
                "maru.structured_loop",
                json!({
                    "request": {
                        "runtimeProvider": "codex",
                        "skillId": "maru-builtin::meeting-notes",
                        "intent": "secret prompt body"
                    }
                }),
                None,
            );
            append_run_event(cwd, &event).unwrap();
        }
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
            .expect("cloud fixture completion")
    }

    #[test]
    fn phase08_17_cloud_wrappers_round_trip_and_legacy_rejections() {
        let tmp = tempfile::TempDir::new().unwrap();
        let cwd = tmp.path().to_string_lossy().to_string();
        seed_run(&cwd);

        let summary = run(ipc::agent_export_redacted_run_summary(
            cwd.clone(),
            "ai-export".into(),
        ))
        .unwrap();
        assert_eq!(summary.run_id, "ai-export");
        assert_eq!(summary.event_count, 2);
        assert_eq!(summary.proposal_count, 1);
        assert_eq!(summary.providers, vec!["codex"]);
        assert_eq!(summary.skills, vec!["maru-builtin::meeting-notes"]);

        let target = tmp.path().join("export/summary.json");
        let written = run(ipc::agent_write_redacted_run_summary(
            cwd.clone(),
            "ai-export".into(),
            text(&target),
        ))
        .unwrap();
        assert_eq!(written, text(&target));
        let parsed: RedactedRunSummary =
            serde_json::from_str(&std::fs::read_to_string(&target).unwrap()).unwrap();
        assert_eq!(parsed.run_id, "ai-export");
        assert!(!std::fs::read_to_string(&target)
            .unwrap()
            .contains("secret prompt body"));

        assert_eq!(
            run(ipc::agent_write_redacted_run_summary(
                cwd.clone(),
                "ai-export".into(),
                "   ".into(),
            ))
            .unwrap_err(),
            "redacted_summary_target_required"
        );
        assert_eq!(
            run(ipc::agent_export_redacted_run_summary(
                cwd.clone(),
                "bad id".into()
            ))
            .unwrap_err(),
            "agent_run_id_invalid"
        );
        assert_eq!(
            run(ipc::agent_write_redacted_run_summary(
                cwd,
                "bad id".into(),
                text(&target)
            ))
            .unwrap_err(),
            "agent_run_id_invalid"
        );
    }

    #[test]
    fn phase08_17_cloud_wrappers_yield_same_poll_and_map_join_failure() {
        let tmp = tempfile::TempDir::new().unwrap();
        let cwd = text(tmp.path());
        seed_run(&cwd);
        let events_path =
            crate::agent_host::event_store::run_events_path(&cwd, "ai-export").unwrap();
        let target = tmp.path().join("export/summary.json");

        boundary(
            events_path,
            "agent_export_redacted_run_summary",
            ipc::agent_export_redacted_run_summary(cwd.clone(), "ai-export".into()),
        );
        boundary(
            target.clone(),
            "agent_write_redacted_run_summary",
            ipc::agent_write_redacted_run_summary(cwd, "ai-export".into(), text(&target)),
        );
    }

    #[cfg(unix)]
    #[test]
    fn phase08_17_cloud_write_parent_both_orders_and_aliases_no_recreation() {
        let home = Home::new();
        let root = home.root.path();
        for parent in ["rename", "trash"] {
            for parent_first in [false, true] {
                for alias in [false, true] {
                    if alias && parent == "trash" {
                        continue;
                    }
                    let fixture = tempfile::tempdir_in(root).unwrap();
                    let fixture_root = fixture.path();
                    let cwd = text(fixture_root);
                    seed_run(&cwd);
                    let export_dir = fixture_root.join("export");
                    let external = fixture_root.join("external");
                    std::fs::create_dir(&external).unwrap();
                    let (selected, key) = if alias {
                        std::fs::create_dir(&export_dir).unwrap();
                        std::fs::remove_dir(&export_dir).unwrap();
                        std::os::unix::fs::symlink(&external, &export_dir).unwrap();
                        (external.clone(), export_dir.join("summary.json"))
                    } else {
                        std::fs::create_dir(&export_dir).unwrap();
                        (export_dir.clone(), export_dir.join("summary.json"))
                    };
                    let trash_target = fixture_root.join("trash-target");
                    let vault = text(fixture_root);
                    let selected_for_parent = selected.clone();
                    let trash_target_for_parent = trash_target.clone();
                    let parent_future = async move {
                        if parent == "rename" {
                            files_ipc::rename_workspace_entry(
                                vault,
                                text(&selected_for_parent),
                                "moved".into(),
                            )
                            .await
                            .map(|outcome| assert!(outcome.error.is_none()))
                        } else {
                            let _trash = TrashFixture::new(
                                selected_for_parent.clone(),
                                trash_target_for_parent.clone(),
                            );
                            files_ipc::trash_workspace_entries(
                                vault,
                                vec![text(&selected_for_parent)],
                            )
                            .await
                            .map(|outcomes| assert!(outcomes[0].error.is_none()))
                        }
                    };
                    let child_future =
                        ipc::agent_write_redacted_run_summary(cwd, "ai-export".into(), text(&key));
                    if parent_first {
                        let held = Held::new(selected.clone(), "pre-effect");
                        let p = start(parent_future);
                        held.wait();
                        let waiting = Held::new(key.clone(), "before-admission");
                        let c = start(child_future);
                        waiting.wait();
                        waiting.release();
                        assert!(c.recv_timeout(Duration::from_millis(20)).is_err());
                        held.release();
                        done(p).unwrap();
                        assert!(
                            done(c).is_err(),
                            "{parent}/{alias}: renamed export parent must fail revalidation"
                        );
                    } else {
                        let held = Held::new(key.clone(), "pre-effect");
                        let c = start(child_future);
                        held.wait();
                        let waiting = Held::new(selected.clone(), "before-admission");
                        let p = start(parent_future);
                        waiting.wait();
                        waiting.release();
                        assert!(p.recv_timeout(Duration::from_millis(20)).is_err());
                        held.release();
                        done(c).unwrap();
                        done(p).unwrap();
                        let moved = if parent == "rename" {
                            fixture_root.join("moved")
                        } else {
                            trash_target.clone()
                        };
                        assert!(
                            moved.join("summary.json").is_file(),
                            "{parent}/{alias}: export must land in the moved parent"
                        );
                    }
                    assert!(
                        !selected.exists(),
                        "{parent}/{alias}: original export parent recreated"
                    );
                }
            }
        }
    }

    #[test]
    fn phase08_17_cloud_write_error_and_unwind_release_admission() {
        let tmp = tempfile::TempDir::new().unwrap();
        let cwd = text(tmp.path());
        seed_run(&cwd);

        // A blocked parent (regular file where the export dir belongs) fails
        // the write after admission and releases the lease.
        let blocker = tmp.path().join("blocked");
        std::fs::write(&blocker, "not a dir").unwrap();
        let target = blocker.join("summary.json");
        assert!(run(ipc::agent_write_redacted_run_summary(
            cwd.clone(),
            "ai-export".into(),
            text(&target),
        ))
        .unwrap_err()
        .starts_with("redacted_summary_dir_failed:"));

        // An unwinding worker releases the whole admitted set.
        let release_target = tmp.path().join("release/summary.json");
        {
            let _panic = PathTransactionTestHook::new(
                crate::vault::lexical_normalize(&release_target),
                "pre-effect",
                || panic!("fixture cloud transaction unwind"),
            );
            assert!(run(ipc::agent_write_redacted_run_summary(
                cwd,
                "ai-export".into(),
                text(&release_target),
            ))
            .unwrap_err()
            .starts_with("agent_write_redacted_run_summary_task_failed:"));
        }
        // The panicked hook above fired for any pre-effect on the same path;
        // a fresh write to a new target under the released lease succeeds.
        let ok_target = tmp.path().join("ok/summary.json");
        let written = run(ipc::agent_write_redacted_run_summary(
            text(tmp.path()),
            "ai-export".into(),
            text(&ok_target),
        ))
        .unwrap();
        assert_eq!(written, text(&ok_target));
        assert!(ok_target.is_file());
    }
}
