use crate::atomic_file::{with_path_transactions, PathTransactionLease, PathTransactionRequest};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding: Option<ApprovalBinding>,
}

/// Authority is scoped to this exact workspace operation, never display text.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalBinding {
    pub logical_target: String,
    pub payload_hash: String,
    pub source_run_id: Option<String>,
    pub source_revision: String,
    pub base_revision: String,
    pub policy_revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalAuditEvent {
    pub event: String,
    pub request: ApprovalRequest,
    pub decision: ApprovalDecision,
    pub detail: Option<String>,
}

fn validate_audit_store_path(path: &std::path::Path) -> Result<(), String> {
    let home = crate::skill_host::fs::maru_home()?;
    let relative = path
        .strip_prefix(&home)
        .map_err(|_| "approval_audit_path_outside_home")?;
    let mut current = home;
    for component in std::iter::once(None).chain(relative.components().map(Some)) {
        if let Some(component) = component {
            current.push(component);
        }
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("approval_audit_symlink_rejected".into())
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("approval_audit_path_invalid: {error}")),
        }
    }
    Ok(())
}

pub(crate) fn audit_path(cwd: &str, id: &str) -> Result<PathBuf, String> {
    let suffix = id.strip_prefix("approval-").ok_or("approval_id_invalid")?;
    Uuid::parse_str(suffix).map_err(|_| "approval_id_invalid".to_string())?;
    let workspace = crate::vault::normalize_existing_dir(cwd)?;
    let workspace_key = format!(
        "{:x}",
        Sha256::digest(workspace.to_string_lossy().as_bytes())
    );
    let path = crate::skill_host::fs::maru_home()?
        .join("approvals")
        .join(workspace_key)
        .join(format!("{id}.json"));
    validate_audit_store_path(&path)?;
    Ok(path)
}

fn audit_transaction(path: PathBuf) -> Result<PathTransactionRequest, String> {
    PathTransactionRequest::new([
        path,
        crate::vault_list::workspace_registry_path()?,
        crate::vault_list::legacy_vault_list_path()?,
    ])
}

/// History is deliberately readable without restoring any in-memory authority.
pub fn read_approval_audit(cwd: &str, id: &str) -> Result<Vec<ApprovalAuditEvent>, String> {
    let path = audit_path(cwd, id)?;
    let bytes = std::fs::read(path).map_err(|e| format!("approval_audit_read_failed: {e}"))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("approval_audit_invalid: {e}"))
}

fn persist_audit(
    stored: &StoredApproval,
    event: &str,
    detail: Option<String>,
    lease: &PathTransactionLease,
) -> Result<(), String> {
    let Some(cwd) = stored.audit_workspace.as_deref() else {
        return Ok(());
    };
    let path = audit_path(cwd, &stored.request.id)?;
    lease.ensure_covered([path.clone()])?;
    lease.before_effect()?;
    validate_audit_store_path(&path)?;
    // This is application metadata, not a provider document operation. Its
    // scope is constructed from the configured Maru home, workspace hash and UUID.
    let mut events = if path.exists() {
        read_approval_audit(cwd, &stored.request.id)?
    } else {
        Vec::new()
    };
    events.push(ApprovalAuditEvent {
        event: event.into(),
        request: stored.request.clone(),
        decision: stored.decision,
        detail,
    });
    let content = serde_json::to_string_pretty(&events).map_err(|e| e.to_string())?;
    crate::atomic_file::write_atomic_private(&path, content.as_bytes())
        .map_err(|e| format!("approval_audit_persist_failed: {e}"))?;
    // Publish the audit tree and the application home in its owning parent.
    // Neither source workspace aliases nor provider document permissions alter it.
    #[cfg(unix)]
    {
        let home = crate::skill_host::fs::maru_home()?;
        let home_parent = home.parent().ok_or("approval_audit_home_parent_missing")?;
        for parent in path.ancestors().skip(1) {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[parent.to_path_buf()],
                "approval-audit-before-directory-sync",
            );
            std::fs::File::open(parent)
                .and_then(|file| file.sync_all())
                .map_err(|e| format!("approval_audit_sync_failed: {e}"))?;
            if parent == home_parent {
                break;
            }
        }
    }
    Ok(())
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
    audit_workspace: Option<String>,
}

#[derive(Debug, Default)]
struct ApprovalStore {
    approvals: HashMap<String, StoredApproval>,
    session_allowed_kinds: HashSet<String>,
    session_allowed_bindings: HashSet<ApprovalBinding>,
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
            binding: None,
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
                audit_workspace: None,
            },
        );
        Ok(request)
    }

    pub(crate) fn prepare_bound(
        &self,
        cwd: &str,
        summary: String,
        target: Option<String>,
        preview: Option<String>,
        binding: ApprovalBinding,
    ) -> Result<ApprovalRequest, String> {
        let id = format!("approval-{}", Uuid::new_v4());
        let path = audit_path(cwd, &id)?;
        with_path_transactions(audit_transaction(path)?, |lease| {
            let mut store = self.store.lock().map_err(|_| "approval_state_poisoned")?;
            let auto_approved = store.session_allowed_bindings.contains(&binding);
            let request = ApprovalRequest {
                id: id.clone(),
                kind: "agent.proposal.apply".into(),
                summary,
                target,
                payload_preview: preview,
                auto_approved,
                binding: Some(binding),
            };
            let stored = StoredApproval {
                request: request.clone(),
                decision: if auto_approved {
                    ApprovalDecision::Approved
                } else {
                    ApprovalDecision::Pending
                },
                consumed: false,
                audit_workspace: Some(cwd.into()),
            };
            persist_audit(&stored, "requested", None, lease)?;
            store.approvals.insert(id, stored);
            Ok(request)
        })
    }

    fn record(
        &self,
        id: &str,
        decision: ApprovalDecision,
        remember_kind: bool,
    ) -> Result<ApprovalRequest, String> {
        let path = {
            let store = self.store.lock().map_err(|_| "approval_state_poisoned")?;
            let stored = store.approvals.get(id).ok_or("approval_not_found")?;
            stored
                .audit_workspace
                .as_deref()
                .map(|cwd| audit_path(cwd, id))
                .transpose()?
        };
        if let Some(path) = path {
            with_path_transactions(audit_transaction(path)?, |lease| {
                self.record_locked(id, decision, remember_kind, Some(lease))
            })
        } else {
            self.record_locked(id, decision, remember_kind, None)
        }
    }

    fn record_locked(
        &self,
        id: &str,
        decision: ApprovalDecision,
        remember_kind: bool,
        lease: Option<&PathTransactionLease>,
    ) -> Result<ApprovalRequest, String> {
        let mut store = self.store.lock().map_err(|_| "approval_state_poisoned")?;
        let current = store.approvals.get(id).ok_or("approval_not_found")?;
        if current.consumed {
            return Err("approval_consumed".into());
        }
        if current.decision != ApprovalDecision::Pending {
            if current.decision == decision {
                return Ok(current.request.clone());
            }
            return Err("approval_decision_terminal".into());
        }
        if decision == ApprovalDecision::Pending {
            return Err("approval_decision_required".into());
        }
        let mut next = current.clone();
        next.decision = decision;
        next.request.auto_approved = false;
        if let Some(lease) = lease {
            persist_audit(&next, "decided", None, lease)?;
        }
        if decision == ApprovalDecision::Approved && remember_kind {
            if let Some(binding) = &next.request.binding {
                store.session_allowed_bindings.insert(binding.clone());
            } else {
                store
                    .session_allowed_kinds
                    .insert(next.request.kind.clone());
            }
        }
        let request = next.request.clone();
        store.approvals.insert(id.into(), next);
        Ok(request)
    }

    pub(crate) fn consume_bound(
        &self,
        id: Option<&str>,
        binding: &ApprovalBinding,
        lease: &PathTransactionLease,
    ) -> Result<String, String> {
        let id = id.ok_or("approval_required: agent.proposal.apply")?;
        let mut store = self.store.lock().map_err(|_| "approval_state_poisoned")?;
        let stored = store.approvals.get_mut(id).ok_or("approval_not_found")?;
        if stored.consumed {
            return Err("approval_consumed".into());
        }
        if stored.request.kind != "agent.proposal.apply" {
            return Err("approval_kind_mismatch".into());
        }
        if stored.request.binding.as_ref() != Some(binding) {
            return Err("approval_binding_mismatch".into());
        }
        if stored.decision != ApprovalDecision::Approved {
            return Err("approval_not_granted".into());
        }
        // Poison authority even when publication has an uncertain result.
        stored.consumed = true;
        persist_audit(stored, "consumed", None, lease)?;
        Ok(id.into())
    }

    pub(crate) fn record_effect(
        &self,
        id: &str,
        detail: String,
        lease: &PathTransactionLease,
    ) -> Result<(), String> {
        let store = self.store.lock().map_err(|_| "approval_state_poisoned")?;
        let stored = store.approvals.get(id).ok_or("approval_not_found")?;
        if !stored.consumed {
            return Err("approval_not_consumed".into());
        }
        persist_audit(stored, "effect.outcome", Some(detail), lease)
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
        if stored.request.binding.is_some() {
            return Err("approval_bound_required".into());
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
        proposal_context: Option<crate::agent_host::proposal::ProposalApprovalContext>,
    ) -> Result<ApprovalRequest, String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            crate::atomic_file::PathTransactionLease::test_stage(
                &[std::path::PathBuf::from(WORKER_HOOK_KEY)],
                "worker:prepare_approval",
            );
            if let Some(context) = proposal_context {
                if kind != "agent.proposal.apply" {
                    return Err("approval_kind_mismatch".into());
                }
                crate::agent_host::proposal::prepare_proposal_approval(
                    &state,
                    &context,
                    summary,
                    target,
                    payload_preview,
                )
            } else {
                if kind == "agent.proposal.apply" {
                    return Err("approval_binding_required".into());
                }
                state.prepare(kind, summary, target, payload_preview)
            }
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

                // A terminal decision is immutable, including a concurrent
                // opposing writer. Idempotent repeats retain the same verdict.
                let first_app = app.clone();
                let first_id = id.clone();
                let first = start(async move {
                    ipc::record_approval(first_app.state(), first_id, decision_a, None).await
                });
                let second_app = app.clone();
                let second_id = id.clone();
                let second = start(async move {
                    ipc::record_approval(second_app.state(), second_id, decision_b, None).await
                });
                assert_eq!(done(first).unwrap().kind, "inbox.bulk");
                assert_eq!(done(second).unwrap_err(), "approval_decision_terminal");
                let final_decision = store.lock().unwrap().approvals.get(&id).unwrap().decision;
                assert_eq!(final_decision, decision_a);

                let verdict = require_approval(
                    &app.state::<ApprovalState>(),
                    Some(id.clone()),
                    "inbox.bulk",
                );
                if final_decision == ApprovalDecision::Approved {
                    verdict.unwrap();
                } else {
                    assert_eq!(verdict.unwrap_err(), "approval_not_granted");
                }
            }
        }
    }
}
