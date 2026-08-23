//! Typed IPC error contract (Phase 3, ERR-01/ERR-02). Commands whose errors
//! the frontend branches on return `Result<T, IpcError>` instead of a bare
//! `code: message` string; every other command keeps `Result<T, String>`
//! (ERR-04 — display-only errors are out of scope).
//!
//! The four contract codes below are pinned by `ipc_error_codes_are_stable`:
//! renaming one fails `cargo test` here, and the `src/lib/types.ts` union
//! mirror fails `tsc -b` on the frontend side — a rename breaks the build on
//! both sides of the bridge (ERR-02).

use serde::{Deserialize, Serialize};

/// Optimistic-concurrency conflict from `today_mutate` / `today_finalize_setup`
/// / `today_calendar_publish`.
pub const TODAY_CONFLICT: &str = "today_conflict";
/// Optimistic-concurrency conflict from `task_transition` / `task_trash`.
pub const TASK_CONFLICT: &str = "task_conflict";
/// Optimistic-concurrency conflict from `save_document`.
pub const DOCUMENT_CONFLICT: &str = "document_conflict";
/// Optimistic-concurrency conflict from `evidence_binder_mutate`.
pub const EVIDENCE_BINDER_REVISION_CONFLICT: &str = "evidence_binder_revision_conflict";

/// Error crossing the Tauri bridge. `code` is empty for legacy errors
/// converted via `From<String>` (the whole original string lands in
/// `message`, unchanged) — this keeps every migrated command's non-contract
/// error paths (lock-poisoning, read/parse failures, ...) byte-identical to
/// today's user-visible text.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IpcError {
    pub code: String,
    pub message: String,
}

impl std::fmt::Display for IpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.code.is_empty() {
            write!(f, "{}", self.message)
        } else {
            write!(f, "{}: {}", self.code, self.message)
        }
    }
}

impl std::error::Error for IpcError {}

impl From<String> for IpcError {
    fn from(message: String) -> Self {
        IpcError {
            code: String::new(),
            message,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ipc_error_codes_are_stable() {
        assert_eq!(TODAY_CONFLICT, "today_conflict");
        assert_eq!(TASK_CONFLICT, "task_conflict");
        assert_eq!(DOCUMENT_CONFLICT, "document_conflict");
        assert_eq!(
            EVIDENCE_BINDER_REVISION_CONFLICT,
            "evidence_binder_revision_conflict"
        );
    }

    #[test]
    fn ipc_error_wire_shape_round_trips() {
        let err = IpcError {
            code: TODAY_CONFLICT.to_string(),
            message: "expected revision a, found b".to_string(),
        };

        let value = serde_json::to_value(&err).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "code": "today_conflict",
                "message": "expected revision a, found b",
            })
        );

        let round_tripped: IpcError = serde_json::from_value(value).unwrap();
        assert_eq!(round_tripped.code, err.code);
        assert_eq!(round_tripped.message, err.message);
    }

    #[test]
    fn display_renders_contract_coded_and_legacy_forms() {
        let coded = IpcError {
            code: EVIDENCE_BINDER_REVISION_CONFLICT.to_string(),
            message: "expected revision a, found b".to_string(),
        };
        assert_eq!(
            coded.to_string(),
            "evidence_binder_revision_conflict: expected revision a, found b"
        );

        let legacy: IpcError = "evidence_binder_lock_poisoned".to_string().into();
        assert_eq!(legacy.to_string(), "evidence_binder_lock_poisoned");
    }
}
