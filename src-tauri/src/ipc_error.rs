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
/// A guarded web-action linkage repair no longer matches the record or note
/// the Today surface rendered. The frontend can refresh without guessing.
pub const WEB_ACTION_REPAIR_CONFLICT: &str = "web_action_repair_conflict";

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
    use std::fs;
    use std::path::{Path, PathBuf};
    use walkdir::WalkDir;

    /// Name of the function a line sits in, found by walking back to the
    /// nearest `fn` declaration. Used both to match the allowlist precisely and
    /// to name the offender in the failure message.
    fn enclosing_fn_name<'a>(lines: &[&'a str], index: usize) -> Option<&'a str> {
        lines[..=index].iter().rev().find_map(|line| {
            let trimmed = line.trim_start();
            let rest = trimmed
                .strip_prefix("pub ")
                .unwrap_or(trimmed)
                .strip_prefix("pub(crate) ")
                .unwrap_or_else(|| trimmed.strip_prefix("pub ").unwrap_or(trimmed));
            let rest = rest.strip_prefix("async ").unwrap_or(rest);
            let rest = rest.strip_prefix("fn ")?;
            Some(rest.split(['(', '<']).next().unwrap_or(rest).trim())
        })
    }

    /// True only for `map_err(|x| x.to_string())`, where the closure's own
    /// argument is what gets stringified. That is the shape that takes a typed
    /// error and throws the code away. It deliberately does not match
    /// `map_err(|_| "literal".to_string())`, which mints a fresh error rather
    /// than flattening one, nor an unrelated `.to_string()` elsewhere on the line.
    fn flattens_the_closure_argument(line: &str) -> bool {
        let Some((_, rest)) = line.split_once("map_err(|") else {
            return false;
        };
        let Some((param, body)) = rest.split_once('|') else {
            return false;
        };
        let param = param.trim();
        if param.is_empty() || param == "_" {
            return false;
        }
        body.trim_start()
            .starts_with(&format!("{param}.to_string())"))
    }

    /// Read every Rust source under this crate's `src/` tree. Keeping source
    /// discovery automatic means a new module that calls an existing emitter
    /// is covered without a second, easy-to-forget inventory edit.
    fn rust_sources() -> Vec<(String, String)> {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut paths: Vec<PathBuf> = WalkDir::new(&root)
            .into_iter()
            .map(|entry| entry.expect("Rust source tree must be readable"))
            .filter(|entry| {
                entry.file_type().is_file()
                    && entry.path().extension().and_then(|value| value.to_str()) == Some("rs")
            })
            .map(|entry| entry.into_path())
            .collect();
        paths.sort();

        paths
            .into_iter()
            .map(|path| {
                let name = path
                    .strip_prefix(&root)
                    .expect("walked source must stay below the crate src directory")
                    .to_string_lossy()
                    .replace('\\', "/");
                let source = fs::read_to_string(&path)
                    .unwrap_or_else(|err| panic!("Cannot read {}: {err}", path.display()));
                (name, source)
            })
            .collect()
    }

    /// ERR-06: a path that reaches a contract-code emitter must not flatten its
    /// error back to `String`. `.map_err(|e| e.to_string())` compiles fine and
    /// silently strips the code, so the frontend's `err instanceof IpcError`
    /// recovery branch stops matching while every build stays green. The
    /// compiler cannot catch that; only an inventory can.
    ///
    /// Extend EMITTERS when a new code-producing helper lands. Add to ALLOWED
    /// only with a reason, and only when the error genuinely never crosses IPC.
    #[test]
    fn no_code_emitting_path_flattens_its_error_to_string() {
        const EMITTERS: &[&str] = &[
            "today_mutate(",
            "task_transition(",
            "task_trash(",
            "save_document(",
            "evidence_binder_mutate(",
            "assert_expected_revision(",
            "check_revision(",
            "load_context(",
        ];
        // (file, line) pairs that flatten deliberately, each with its reason.
        const ALLOWED: &[(&str, &str)] = &[(
            "web_actions.rs",
            // apply_receipt is an internal helper, not a command: web_actions_apply
            // consumes its Err as the reason string on a retry marker, so the value
            // never crosses the IPC boundary and no frontend branch can read a code.
            "apply_receipt",
        )];
        let mut offenders = Vec::new();
        for (name, source) in rust_sources() {
            let lines: Vec<&str> = source.lines().collect();
            for (index, line) in lines.iter().enumerate() {
                if !flattens_the_closure_argument(line) {
                    continue;
                }
                // Look back a short window for the emitter call this flattens.
                let start = index.saturating_sub(15);
                let window = lines[start..=index].join("\n");
                let Some(emitter) = EMITTERS.iter().find(|e| window.contains(**e)) else {
                    continue;
                };
                let enclosing = enclosing_fn_name(&lines, index).unwrap_or("<unknown>");
                let allowed = ALLOWED
                    .iter()
                    .any(|(file, func)| *file == name && *func == enclosing);
                if !allowed {
                    offenders.push(format!(
                        "{name}:{} in {enclosing}() flattens {emitter}",
                        index + 1
                    ));
                }
            }
        }

        assert!(
            offenders.is_empty(),
            "these paths reach a contract-code emitter and flatten its error to String, \
             stripping the code the frontend branches on: {offenders:#?}"
        );
    }

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
