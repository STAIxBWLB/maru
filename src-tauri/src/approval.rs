use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
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

#[derive(Debug, Default)]
pub struct ApprovalState {
    store: Mutex<ApprovalStore>,
}

#[tauri::command]
pub fn prepare_approval(
    state: tauri::State<'_, ApprovalState>,
    kind: String,
    summary: String,
    target: Option<String>,
    payload_preview: Option<String>,
) -> Result<ApprovalRequest, String> {
    state.prepare(kind, summary, target, payload_preview)
}

#[tauri::command]
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
}
