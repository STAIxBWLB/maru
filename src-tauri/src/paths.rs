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

use std::path::{Path, PathBuf};

pub use crate::vault::lexical_normalize;

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
}
