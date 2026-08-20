//! maru_migration — one-time on-disk migration for the M0 Anchor→Maru rename
//! (work repo DR-024 §2/§3). Idempotent, best-effort: every step only fires
//! when the legacy path is a REAL directory and the new path is absent, and
//! leaves a compat symlink behind so pre-M0 binaries and absolute symlinks
//! (e.g. ~/.claude/skills federation) keep resolving.

use std::fs;
use std::path::Path;

/// Migrate `<base>/.anchor` → `<base>/.maru` + compat symlink. Shared by the
/// home-root and workspace-root cases.
fn migrate_dot_dir(base: &Path) -> Result<bool, String> {
    let legacy = base.join(".anchor");
    let target = base.join(".maru");
    if target.exists() {
        return Ok(false);
    }
    let Ok(meta) = fs::symlink_metadata(&legacy) else {
        return Ok(false);
    };
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Ok(false);
    }
    fs::rename(&legacy, &target)
        .map_err(|err| format!("Cannot migrate {} to .maru: {err}", legacy.display()))?;
    #[cfg(unix)]
    {
        let _ = std::os::unix::fs::symlink(".maru", &legacy);
    }
    Ok(true)
}

/// App-startup migration: `~/.anchor` → `~/.maru` and the macOS app-config
/// dir `com.anchor.app` → `com.maru.app` (vault/workspace registry).
pub fn migrate_home() {
    if let Some(home) = dirs::home_dir() {
        match migrate_dot_dir(&home) {
            Ok(true) => eprintln!("[maru-migration] ~/.anchor → ~/.maru (compat symlink left)"),
            Ok(false) => {}
            Err(err) => eprintln!("[maru-migration] home migration skipped: {err}"),
        }
    }
    if let Some(config_base) = dirs::config_dir() {
        // macOS: ~/Library/Application Support
        let legacy = config_base.join("com.anchor.app");
        let target = config_base.join("com.maru.app");
        if legacy.is_dir() && !target.exists() {
            match fs::rename(&legacy, &target) {
                Ok(()) => eprintln!("[maru-migration] com.anchor.app → com.maru.app"),
                Err(err) => eprintln!("[maru-migration] app-config migration skipped: {err}"),
            }
        }
    }
}

/// Workspace-open migration: `<work>/.anchor` → `<work>/.maru` + symlink.
pub fn migrate_workspace(work: &Path) {
    match migrate_dot_dir(work) {
        Ok(true) => eprintln!(
            "[maru-migration] {}/.anchor → .maru (compat symlink left)",
            work.display()
        ),
        Ok(false) => {}
        Err(err) => eprintln!("[maru-migration] workspace migration skipped: {err}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn migrates_real_dir_and_leaves_symlink() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir(tmp.path().join(".anchor")).unwrap();
        fs::write(tmp.path().join(".anchor/settings.json"), "{}").unwrap();

        assert!(migrate_dot_dir(tmp.path()).unwrap());
        assert!(tmp.path().join(".maru/settings.json").is_file());
        let legacy = tmp.path().join(".anchor");
        assert!(fs::symlink_metadata(&legacy)
            .unwrap()
            .file_type()
            .is_symlink());
        // Old absolute paths still resolve through the compat symlink.
        assert!(legacy.join("settings.json").is_file());
    }

    #[test]
    fn noop_when_maru_exists_or_legacy_absent() {
        let tmp = TempDir::new().unwrap();
        assert!(!migrate_dot_dir(tmp.path()).unwrap()); // neither exists
        fs::create_dir(tmp.path().join(".maru")).unwrap();
        fs::create_dir(tmp.path().join(".anchor")).unwrap();
        assert!(!migrate_dot_dir(tmp.path()).unwrap()); // .maru already there
        assert!(tmp.path().join(".anchor").is_dir()); // untouched
    }

    #[test]
    fn noop_when_legacy_is_already_a_symlink() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir(tmp.path().join(".maru")).unwrap();
        std::os::unix::fs::symlink(".maru", tmp.path().join(".anchor")).unwrap();
        // Second run after a migration — must not rename the symlink itself.
        fs::remove_dir(tmp.path().join(".maru")).unwrap();
        assert!(!migrate_dot_dir(tmp.path()).unwrap());
    }
}
