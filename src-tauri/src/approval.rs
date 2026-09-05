use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    pub id: String,
    pub kind: String,
    pub summary: String,
    pub target: Option<String>,
    pub payload_preview: Option<String>,
    pub auto_approved: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ApprovalDecision {
    Pending,
    Approved,
    Rejected,
}

#[derive(Debug, Clone)]
struct StoredApproval {
    request: ApprovalRequest,
    decision: ApprovalDecision,
    consumed: bool,
}

#[derive(Debug, Default)]
struct ApprovalStore {
    approvals: HashMap<String, StoredApproval>,
    session_allowed_kinds: HashSet<String>,
}

#[derive(Debug, Default, Clone)]
pub struct ApprovalState {
    store: Arc<Mutex<ApprovalStore>>,
}

#[allow(dead_code)] // Stable synchronous Rust API; desktop registration uses ipc.
pub fn prepare_approval(
    state: tauri::State<'_, ApprovalState>,
    kind: String,
    summary: String,
    target: Option<String>,
    payload_preview: Option<String>,
) -> Result<ApprovalRequest, String> {
    state.prepare(kind, summary, target, payload_preview)
}

#[allow(dead_code)] // Stable synchronous Rust API; desktop registration uses ipc.
pub fn record_approval(
    state: tauri::State<'_, ApprovalState>,
    id: String,
    decision: ApprovalDecision,
    remember_kind: Option<bool>,
) -> Result<ApprovalRequest, String> {
    state.record(&id, decision, remember_kind.unwrap_or(false))
}

pub fn require_approval(
    state: &ApprovalState,
    approval_id: Option<String>,
    kind: &str,
) -> Result<(), String> {
    state.consume_any(approval_id.as_deref(), &[kind])
}

pub fn require_approval_any(
    state: &ApprovalState,
    approval_id: Option<String>,
    kinds: &[&str],
) -> Result<(), String> {
    state.consume_any(approval_id.as_deref(), kinds)
}

impl ApprovalState {
    fn prepare(
        &self,
        kind: String,
        summary: String,
        target: Option<String>,
        payload_preview: Option<String>,
    ) -> Result<ApprovalRequest, String> {
        let trimmed_kind = kind.trim();
        if trimmed_kind.is_empty() {
            return Err("approval_kind_required".to_string());
        }
        let id = format!("approval-{}", Uuid::new_v4());
        let mut store = self
            .store
            .lock()
            .map_err(|_| "approval_state_poisoned".to_string())?;
        let auto_approved = store.session_allowed_kinds.contains(trimmed_kind);
        let request = ApprovalRequest {
            id: id.clone(),
            kind: trimmed_kind.to_string(),
            summary,
            target,
            payload_preview,
            auto_approved,
        };
        store.approvals.insert(
            id,
            StoredApproval {
                request: request.clone(),
                decision: if auto_approved {
                    ApprovalDecision::Approved
                } else {
                    ApprovalDecision::Pending
                },
                consumed: false,
            },
        );
        Ok(request)
    }

    fn record(
        &self,
        id: &str,
        decision: ApprovalDecision,
        remember_kind: bool,
    ) -> Result<ApprovalRequest, String> {
        let mut store = self
            .store
            .lock()
            .map_err(|_| "approval_state_poisoned".to_string())?;
        let kind = {
            let Some(stored) = store.approvals.get_mut(id) else {
                return Err("approval_not_found".to_string());
            };
            stored.decision = decision;
            stored.request.auto_approved = false;
            stored.request.kind.clone()
        };
        if decision == ApprovalDecision::Approved && remember_kind {
            store.session_allowed_kinds.insert(kind);
        }
        store
            .approvals
            .get(id)
            .map(|stored| stored.request.clone())
            .ok_or_else(|| "approval_not_found".to_string())
    }

    fn consume_any(&self, approval_id: Option<&str>, kinds: &[&str]) -> Result<(), String> {
        let Some(approval_id) = approval_id.filter(|value| !value.trim().is_empty()) else {
            return Err(format!(
                "approval_required: {}",
                kinds.first().copied().unwrap_or("unknown")
            ));
        };
        let mut store = self
            .store
            .lock()
            .map_err(|_| "approval_state_poisoned".to_string())?;
        let Some(stored) = store.approvals.get_mut(approval_id) else {
            return Err("approval_not_found".to_string());
        };
        if stored.consumed {
            return Err("approval_consumed".to_string());
        }
        if !kinds.iter().any(|kind| *kind == stored.request.kind) {
            return Err(format!(
                "approval_kind_mismatch: expected {}, got {}",
                kinds.join("|"),
                stored.request.kind
            ));
        }
        if stored.decision != ApprovalDecision::Approved {
            return Err("approval_not_granted".to_string());
        }
        stored.consumed = true;
        Ok(())
    }
}

#[cfg(test)]
const WORKER_HOOK_KEY: &str = "/maru/phase08_24/approval";

/// Owned IPC boundaries; the synchronous functions remain the Rust/CLI API and
/// the store lock waits run on finite blocking workers.
pub mod ipc {
    use super::*;

    #[tauri::command]
    pub async fn prepare_approval(
        state: tauri::State<'_, ApprovalState>,
        kind: String,
        summary: String,
        target: Option<String>,
        payload_preview: Option<String>,
    ) -> Result<ApprovalRequest, String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            crate::atomic_file::PathTransactionLease::test_stage(
                &[std::path::PathBuf::from(WORKER_HOOK_KEY)],
                "worker:prepare_approval",
            );
            state.prepare(kind, summary, target, payload_preview)
        })
        .await
        .map_err(|err| format!("prepare_approval_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn record_approval(
        state: tauri::State<'_, ApprovalState>,
        id: String,
        decision: ApprovalDecision,
        remember_kind: Option<bool>,
    ) -> Result<ApprovalRequest, String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            crate::atomic_file::PathTransactionLease::test_stage(
                &[std::path::PathBuf::from(WORKER_HOOK_KEY)],
                "worker:record_approval",
            );
            state.record(&id, decision, remember_kind.unwrap_or(false))
        })
        .await
        .map_err(|err| format!("record_approval_task_failed: {err}"))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approval_must_be_recorded_before_consuming() {
        let state = ApprovalState::default();
        let request = state
            .prepare("inbox.file.accept".into(), "Move file".into(), None, None)
            .unwrap();
        assert!(state
            .consume_any(Some(&request.id), &["inbox.file.accept"])
            .is_err());
        state
            .record(&request.id, ApprovalDecision::Approved, false)
            .unwrap();
        assert!(state
            .consume_any(Some(&request.id), &["inbox.file.accept"])
            .is_ok());
        assert!(state
            .consume_any(Some(&request.id), &["inbox.file.accept"])
            .is_err());
    }

    #[test]
    fn approval_kind_mismatch_is_rejected() {
        let state = ApprovalState::default();
        let request = state
            .prepare("gmail.accept".into(), "Archive mail".into(), None, None)
            .unwrap();
        state
            .record(&request.id, ApprovalDecision::Approved, false)
            .unwrap();
        let err = state
            .consume_any(Some(&request.id), &["inbox.file.accept"])
            .unwrap_err();
        assert!(err.starts_with("approval_kind_mismatch"));
    }

    #[test]
    fn session_cache_auto_approves_same_kind() {
        let state = ApprovalState::default();
        let first = state
            .prepare("inbox.bulk".into(), "Bulk".into(), None, None)
            .unwrap();
        state
            .record(&first.id, ApprovalDecision::Approved, true)
            .unwrap();
        let second = state
            .prepare("inbox.bulk".into(), "Bulk again".into(), None, None)
            .unwrap();
        assert!(second.auto_approved);
        assert!(state.consume_any(Some(&second.id), &["inbox.bulk"]).is_ok());
    }

    #[test]
    fn rejected_approval_cannot_be_consumed() {
        let state = ApprovalState::default();
        let request = state
            .prepare("gmail.reject".into(), "Reject mail".into(), None, None)
            .unwrap();
        state
            .record(&request.id, ApprovalDecision::Rejected, false)
            .unwrap();
        let err = state
            .consume_any(Some(&request.id), &["gmail.reject"])
            .unwrap_err();
        assert_eq!(err, "approval_not_granted");
    }

    mod phase08_24 {
        use super::*;
        use crate::atomic_file::phase08_06::{boundary, run};
        use std::sync::{mpsc, Mutex, MutexGuard};
        use std::time::Duration;
        use tauri::Manager;

        // The synthetic worker-hook key is module-global, so the stage-hook
        // tests must not overlap with any other wrapper-driven test.
        static TEST_LOCK: Mutex<()> = Mutex::new(());
        fn serialized() -> MutexGuard<'static, ()> {
            TEST_LOCK
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
        }

        fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
            let app = tauri::test::mock_app();
            app.manage(ApprovalState::default());
            app
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
                .expect("fixture completion")
        }

        #[test]
        fn phase08_24_approval_wrappers_yield_same_poll_and_map_join_failure() {
            let _guard = serialized();
            let key = std::path::PathBuf::from(WORKER_HOOK_KEY);
            let app = mock_app();
            let prepare_app = app.handle().clone();
            boundary(key.clone(), "prepare_approval", async move {
                ipc::prepare_approval(
                    prepare_app.state(),
                    "inbox.file.accept".into(),
                    "Move file".into(),
                    None,
                    None,
                )
                .await
            });
            let record_app = app.handle().clone();
            boundary(key, "record_approval", async move {
                ipc::record_approval(
                    record_app.state(),
                    "approval-missing".into(),
                    ApprovalDecision::Approved,
                    None,
                )
                .await
            });
        }

        #[test]
        fn phase08_24_approval_real_fixture_results_and_rejections() {
            let _guard = serialized();
            let app = mock_app();
            let app = app.handle().clone();
            run(async move {
                let request = ipc::prepare_approval(
                    app.state(),
                    "inbox.file.accept".into(),
                    "Move file".into(),
                    None,
                    None,
                )
                .await
                .unwrap();
                assert!(request.id.starts_with("approval-"));
                assert!(!request.auto_approved);
                assert_eq!(request.kind, "inbox.file.accept");

                let recorded = ipc::record_approval(
                    app.state(),
                    request.id.clone(),
                    ApprovalDecision::Approved,
                    None,
                )
                .await
                .unwrap();
                assert!(!recorded.auto_approved);

                let error = ipc::record_approval(
                    app.state(),
                    "approval-nope".into(),
                    ApprovalDecision::Approved,
                    None,
                )
                .await
                .unwrap_err();
                assert_eq!(error, "approval_not_found");

                let error = ipc::prepare_approval(
                    app.state(),
                    "   ".into(),
                    "Empty kind".into(),
                    None,
                    None,
                )
                .await
                .unwrap_err();
                assert_eq!(error, "approval_kind_required");

                let remembered = ipc::prepare_approval(
                    app.state(),
                    "vault.trash".into(),
                    "Trash entry".into(),
                    None,
                    None,
                )
                .await
                .unwrap();
                ipc::record_approval(
                    app.state(),
                    remembered.id.clone(),
                    ApprovalDecision::Approved,
                    Some(true),
                )
                .await
                .unwrap();
                let auto = ipc::prepare_approval(
                    app.state(),
                    "vault.trash".into(),
                    "Trash again".into(),
                    None,
                    None,
                )
                .await
                .unwrap();
                assert!(auto.auto_approved);

                require_approval(
                    &app.state::<ApprovalState>(),
                    Some(request.id.clone()),
                    "inbox.file.accept",
                )
                .unwrap();
                let error = require_approval(
                    &app.state::<ApprovalState>(),
                    Some(request.id.clone()),
                    "inbox.file.accept",
                )
                .unwrap_err();
                assert_eq!(error, "approval_consumed");
            });
        }

        #[test]
        fn phase08_24_approval_record_serializes_same_target_both_orders() {
            let _guard = serialized();
            for (decision_a, decision_b) in [
                (ApprovalDecision::Approved, ApprovalDecision::Rejected),
                (ApprovalDecision::Rejected, ApprovalDecision::Approved),
            ] {
                let app = mock_app();
                let app = app.handle().clone();
                let id = run({
                    let app = app.clone();
                    async move {
                        ipc::prepare_approval(
                            app.state(),
                            "inbox.bulk".into(),
                            "Bulk".into(),
                            None,
                            None,
                        )
                        .await
                        .unwrap()
                        .id
                    }
                });
                let request_id = id.clone();

                // While the store lock is held externally, a record worker
                // cannot complete: the lock wait happens on the worker.
                let store = app.state::<ApprovalState>().store.clone();
                let blocked_guard = store.lock().unwrap();
                let blocked_app = app.clone();
                let blocked = start(async move {
                    ipc::record_approval(blocked_app.state(), request_id.clone(), decision_a, None)
                        .await
                });
                assert!(
                    blocked.recv_timeout(Duration::from_millis(100)).is_err(),
                    "record must wait on the store lock held outside the worker"
                );
                drop(blocked_guard);
                done(blocked).unwrap();

                // Two concurrent writers on the same id: whichever record
                // completes last must own the store with no mixed state.
                let (order_tx, order_rx) = mpsc::channel();
                let first_tx = order_tx.clone();
                let first_app = app.clone();
                let first_id = id.clone();
                let first = start(async move {
                    let outcome =
                        ipc::record_approval(first_app.state(), first_id, decision_a, None)
                            .await
                            .unwrap();
                    first_tx.send(decision_a).unwrap();
                    outcome
                });
                let second_app = app.clone();
                let second_id = id.clone();
                let second = start(async move {
                    let outcome =
                        ipc::record_approval(second_app.state(), second_id, decision_b, None)
                            .await
                            .unwrap();
                    order_tx.send(decision_b).unwrap();
                    outcome
                });
                let first_outcome = done(first);
                let second_outcome = done(second);
                assert_eq!(first_outcome.kind, "inbox.bulk");
                assert_eq!(second_outcome.kind, "inbox.bulk");
                assert!(!first_outcome.auto_approved);
                assert!(!second_outcome.auto_approved);
                let _first_completed = order_rx.recv().unwrap();
                let last_decision = order_rx
                    .recv_timeout(Duration::from_millis(10))
                    .expect("both record workers must complete");

                let verdict = require_approval(
                    &app.state::<ApprovalState>(),
                    Some(id.clone()),
                    "inbox.bulk",
                );
                if last_decision == ApprovalDecision::Approved {
                    verdict.unwrap();
                } else {
                    assert_eq!(verdict.unwrap_err(), "approval_not_granted");
                }
            }
        }
    }
}
