//! Path invariants shared across the crate: the generated-directory prune
//! list, the lexical containment helper, and the absolute-base guard. This
//! module is the one place to reach for these invariants — new path-accepting
//! commands import from here instead of growing another private copy.
//!
//! Containment is lexical: `ensure_within` resolves `..`/`.` without
//! following symlinks, then requires the result to live under the parent.
//! Using `canonicalize()` here was wrong — it follows symlinks, so a
//! deliberate user symlink inside a workspace would resolve outside it and
//! falsely trigger an "escapes" error. Path traversal via `..` is still
//! blocked by `lexical_normalize` (rationale carried from `vault.rs`'s
//! `resolve_inside_vault`).
//!
//! ```rust,ignore
//! // Illustrative only: this module is crate-private, so the example is not
//! // a compiled doctest.
//! let rules = rules_dir(work);
//! let candidate = rules.join(format!("{name}.md"));
//! paths::ensure_within(&rules, &candidate)?; // Err on a `..` escape
//! ```

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

pub use crate::vault::lexical_normalize;

/// Env var naming the native-e2e runner's override for `maru_home_dir()`
/// (`crate::maru_dir::maru_home_dir`). Read only when the `native-e2e`
/// cargo feature is active (D-09/D-10).
pub const NATIVE_E2E_HOME_VAR: &str = "MARU_NATIVE_E2E_HOME";

/// Env var naming the native-e2e runner's override for `app_config_dir()`
/// (`crate::vault_list::app_config_dir`). Read only when the `native-e2e`
/// cargo feature is active (D-09/D-10).
pub const NATIVE_E2E_CONFIG_DIR_VAR: &str = "MARU_NATIVE_E2E_CONFIG_DIR";

/// Directories produced by tooling, never authored content. Every scanner
/// prunes these; adding one is a one-line edit here (SCAN-01).
///
/// `.maru` is deliberately absent — it is Maru state, not a generated dir
/// (evidence_binder keeps excluding it module-locally).
pub const GENERATED_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".cache",
    ".git",
    ".venv",
    ".context",
    ".omc",
    ".omx",
    ".pnpm-store",
    "__pycache__",
];

/// Containment check: `child` must resolve (lexically — symlinks untouched)
/// to a path under `parent`. Canonical example for new path-accepting
/// commands (SCAN-03).
pub fn ensure_within(parent: &Path, child: &Path) -> Result<(), String> {
    let normalized = lexical_normalize(child);
    if !normalized.starts_with(parent) {
        return Err("Path escapes the .maru directory".to_string());
    }
    Ok(())
}

/// A home-rooted base must be absolute before anything joins against it —
/// a relative base silently materializes trees in the cwd (the stray
/// `Users/` incident class). Consumed by `skill_host/fs.rs` (SCAN-04).
pub fn require_absolute(path: PathBuf) -> Result<PathBuf, String> {
    if path.is_absolute() {
        Ok(path)
    } else {
        Err(format!(
            "Home root must be absolute, got: {}",
            path.display()
        ))
    }
}

/// Pure resolver for a native-e2e isolation override: fails closed when
/// `value` is absent or empty, naming `var_name` in the error so a
/// misconfigured run says what to set (T-06-03). Ungated so it compiles
/// and is unit-testable under default features; the feature-gated caller
/// is `native_e2e_dir_override`.
///
/// With the `native-e2e` feature off, its only production caller (the
/// `#[cfg(not(feature = "native-e2e"))]` branch of `native_e2e_dir_override`)
/// short-circuits to `Ok(None)` without calling it, so it is dead outside
/// its own tests in that configuration — allowed here rather than with a
/// crate-wide suppression, so `cargo clippy --features native-e2e` (where
/// it IS called) still catches a real regression.
#[cfg_attr(not(feature = "native-e2e"), allow(dead_code))]
pub fn resolve_native_e2e_dir(var_name: &str, value: Option<&OsStr>) -> Result<PathBuf, String> {
    match value {
        Some(raw) if !raw.is_empty() => require_absolute(PathBuf::from(raw)),
        _ => Err(format!(
            "{var_name} must be set to an absolute path when the native-e2e feature is active"
        )),
    }
}

/// Reads `var_name` from the process environment and resolves it through
/// `resolve_native_e2e_dir`, but only when the `native-e2e` cargo feature
/// is compiled in. With the feature off this always returns `Ok(None)`,
/// so the override is inert in every shipped build (D-10).
#[cfg(feature = "native-e2e")]
pub fn native_e2e_dir_override(var_name: &str) -> Result<Option<PathBuf>, String> {
    let value = std::env::var_os(var_name);
    // Under `cargo test --features native-e2e` the existing Rust suite
    // does not set either isolation variable, and must keep passing: the
    // refusal path itself is covered by resolve_native_e2e_dir's own
    // tests below, so this escape hatch costs no coverage.
    if cfg!(test) && value.is_none() {
        return Ok(None);
    }
    resolve_native_e2e_dir(var_name, value.as_deref()).map(Some)
}

/// With the `native-e2e` feature off, the override never exists.
#[cfg(not(feature = "native-e2e"))]
pub fn native_e2e_dir_override(_var_name: &str) -> Result<Option<PathBuf>, String> {
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_within_accepts_descendant() {
        let root = Path::new("/work/.maru/rules");
        assert!(ensure_within(root, &root.join("a/b.md")).is_ok());
    }

    #[test]
    fn ensure_within_accepts_child_equal_to_parent() {
        // starts_with is reflexive: the root itself is contained in itself.
        let root = Path::new("/work/.maru/rules");
        assert!(ensure_within(root, root).is_ok());
    }

    #[test]
    fn ensure_within_rejects_dotdot_escape() {
        let root = Path::new("/work/.maru/rules");
        assert!(ensure_within(root, &root.join("../secrets/key")).is_err());
    }

    #[test]
    fn ensure_within_rejects_unrelated_absolute_path() {
        let root = Path::new("/work/.maru/rules");
        assert!(ensure_within(root, Path::new("/elsewhere/x.md")).is_err());
    }

    #[test]
    fn require_absolute_accepts_absolute_path() {
        assert!(require_absolute(PathBuf::from("/work")).is_ok());
    }

    #[test]
    fn require_absolute_rejects_relative_path() {
        assert!(require_absolute(PathBuf::from("relative-home")).is_err());
    }

    #[test]
    fn resolve_native_e2e_dir_accepts_absolute_value() {
        let value = OsStr::new("/tmp/native-e2e-home");
        assert_eq!(
            resolve_native_e2e_dir("MARU_NATIVE_E2E_HOME", Some(value)).unwrap(),
            PathBuf::from("/tmp/native-e2e-home")
        );
    }

    #[test]
    fn resolve_native_e2e_dir_rejects_relative_value() {
        let value = OsStr::new("relative/native-e2e-home");
        assert!(resolve_native_e2e_dir("MARU_NATIVE_E2E_HOME", Some(value)).is_err());
    }

    #[test]
    fn resolve_native_e2e_dir_errors_on_absent_value_naming_the_variable() {
        let err = resolve_native_e2e_dir("MARU_NATIVE_E2E_HOME", None).unwrap_err();
        assert!(err.contains("MARU_NATIVE_E2E_HOME"));
    }

    #[test]
    fn resolve_native_e2e_dir_errors_on_empty_value_naming_the_variable() {
        let value = OsStr::new("");
        let err = resolve_native_e2e_dir("MARU_NATIVE_E2E_CONFIG_DIR", Some(value)).unwrap_err();
        assert!(err.contains("MARU_NATIVE_E2E_CONFIG_DIR"));
    }
}
