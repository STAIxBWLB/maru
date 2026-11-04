//! Session-owned bundle snapshots. Locks retain bundle/env generations until
//! the launching Maru process exits (conservative for detached terminal runs).
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions, TryLockError};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{bundle_update as bundle, fs as host_fs};

type SessionLocks = BTreeMap<(PathBuf, PathBuf), File>;
static SESSION_LOCKS: OnceLock<Mutex<SessionLocks>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct BundleSession {
    pub bundle_id: String,
    pub root: PathBuf,
    pub env_root: PathBuf,
    pub env_hash: String,
}

pub(crate) fn sessions_dir() -> Result<PathBuf, String> {
    Ok(host_fs::skills_root()?.join("_sessions"))
}

impl BundleSession {
    /// Caller holds bundle/state admission and the registry lock, so capture
    /// and publishing the retention lock precede any concurrent pruning.
    pub(crate) fn retain(self) -> Result<Self, String> {
        let key = (self.root.clone(), self.env_root.clone());
        let mut locks = SESSION_LOCKS
            .get_or_init(Default::default)
            .lock()
            .map_err(|_| "bundle_session_lock_poisoned")?;
        if locks.contains_key(&key) {
            return Ok(self);
        }
        let dir = sessions_dir()?;
        host_fs::ensure_dir(&dir)?;
        let path = dir.join(format!("{}.json", Uuid::new_v4()));
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(path.with_extension("lock"))
            .map_err(|error| format!("bundle_session_pin_failed: {error}; retry the session"))?;
        file.lock().map_err(|error| error.to_string())?;
        fs::write(
            &path,
            serde_json::to_vec(&self).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        locks.insert(key, file);
        Ok(self)
    }

    pub(crate) fn env(&self, work: Option<&Path>) -> Result<BTreeMap<String, String>, String> {
        let mut env = super::store::env_vars_for_root(&self.env_root, work)?;
        let bin = self.env_root.join(".venv/bin");
        let search = std::ffi::OsString::from(crate::cli_path::augmented_path());
        let path = crate::cli_path::merge_path_env(Some(bin.as_os_str()), Some(search.as_os_str()));
        env.insert("PATH".into(), path.to_string_lossy().into_owned());
        env.insert(
            "MARU_SKILLS_BUNDLE".into(),
            host_fs::display_path(&self.root),
        );
        env.insert("MARU_SKILLS_BUNDLE_ID".into(), self.bundle_id.clone());
        Ok(env)
    }

    /// Bundled instructions historically contained mutable absolute aliases.
    /// Render those aliases against the captured generation without modifying
    /// the signed bundle or the user's editable _builtin workspace.
    pub(crate) fn render(&self, text: &str) -> Result<String, String> {
        let skills = host_fs::skills_root()?;
        let legacy_env = host_fs::env_base()?;
        let root = host_fs::display_path(&self.root);
        let env = host_fs::display_path(&self.env_root);
        let mut text = text
            .replace(&root, "@PINNED_BUNDLE@")
            .replace(&env, "@PINNED_ENV@");
        text = text
            .replace("~/.maru/skills/_builtin", "@MARU_BUNDLE@")
            .replace(
                &host_fs::display_path(&skills.join("_builtin")),
                "@MARU_BUNDLE@",
            );
        for entry in fs::read_dir(self.root.join("skills")).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            if !entry
                .file_type()
                .map_err(|error| error.to_string())?
                .is_dir()
            {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            text = text
                .replace(
                    &format!("~/.maru/skills/{name}/"),
                    &format!("@MARU_BUNDLE@/skills/{name}/"),
                )
                .replace(
                    &format!("{}/{name}/", host_fs::display_path(&skills)),
                    &format!("@MARU_BUNDLE@/skills/{name}/"),
                );
        }
        Ok(text
            .replace("~/.maru/env", "@MARU_ENV@")
            .replace(&host_fs::display_path(&legacy_env), "@MARU_ENV@")
            .replace("@MARU_BUNDLE@", &root)
            .replace("@MARU_ENV@", &env)
            .replace("@PINNED_BUNDLE@", &root)
            .replace("@PINNED_ENV@", &env))
    }

    pub(crate) fn prompt(&self, text: &str) -> Result<String, String> {
        Ok(format!("<maru_bundle root={:?} env={:?}>\nUse this captured bundle for bundled skills and their resources throughout this session.\n</maru_bundle>\n{}",
            self.root, self.env_root, self.render(text)?))
    }
}

/// Locks are OS-owned, so a crash releases them without PID reuse heuristics.
/// Any unreadable pin fails closed rather than pruning an uncertain session.
pub(crate) fn retained_generations() -> Result<(BTreeSet<String>, BTreeSet<String>), String> {
    let mut bundles = BTreeSet::new();
    let mut envs = BTreeSet::new();
    let dir = sessions_dir()?;
    if !dir.is_dir() {
        return Ok((bundles, envs));
    }
    for entry in fs::read_dir(dir).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let lock_path = path.with_extension("lock");
        let file = OpenOptions::new().read(true).write(true).open(&lock_path)
            .map_err(|error| format!("bundle_session_pin_unreadable: {}: {error}; inspect the pin before retrying cleanup", path.display()))?;
        match file.try_lock() {
            Ok(()) => {
                drop(file);
                fs::remove_file(path).map_err(|error| error.to_string())?;
                fs::remove_file(lock_path).map_err(|error| error.to_string())?;
            }
            Err(TryLockError::WouldBlock) => {
                let session: BundleSession = serde_json::from_slice(&fs::read(&path).map_err(|error| error.to_string())?)
                    .map_err(|error| format!("bundle_session_pin_invalid: {}: {error}; inspect the pin before retrying cleanup", path.display()))?;
                bundles.insert(session.bundle_id);
                envs.insert(session.env_hash);
            }
            Err(error) => {
                return Err(format!(
                    "bundle_session_pin_lock_failed: {error}; retry cleanup"
                ))
            }
        }
    }
    Ok((bundles, envs))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rendered_paths_remain_pinned_and_do_not_rebind_custom_skills() {
        let _home = host_fs::test_home_for_bundle_tests();
        let root = bundle::bundle_pristine_dir("old").unwrap();
        fs::create_dir_all(root.join("skills/demo")).unwrap();
        let session = BundleSession {
            bundle_id: "old".into(),
            root: root.clone(),
            env_root: host_fs::hashed_env_root("old-env").unwrap(),
            env_hash: "old-env".into(),
        };
        let text = session.render("~/.maru/skills/demo/scripts/run.sh ~/.maru/env/.venv/bin/python ~/.maru/skills/custom/run.sh").unwrap();
        assert!(text.contains(&format!("{}/skills/demo/scripts/run.sh", root.display())));
        assert!(text.contains(&format!("{}/.venv/bin/python", session.env_root.display())));
        assert!(text.contains("~/.maru/skills/custom/run.sh"));
        assert_eq!(session.render(&text).unwrap(), text);
    }

    #[test]
    fn live_locks_retain_generations_and_expired_locks_are_swept() {
        let _home = host_fs::test_home_for_bundle_tests();
        let root = bundle::bundle_pristine_dir("old").unwrap();
        let session = BundleSession {
            bundle_id: "old".into(),
            root,
            env_root: host_fs::hashed_env_root("old-env").unwrap(),
            env_hash: "old-env".into(),
        };
        session.retain().unwrap();
        let (bundles, envs) = retained_generations().unwrap();
        assert!(bundles.contains("old"));
        assert!(envs.contains("old-env"));
        let stale = sessions_dir().unwrap().join("expired.json");
        fs::write(&stale, b"invalid metadata is not read for an unlocked pin").unwrap();
        fs::write(stale.with_extension("lock"), b"").unwrap();
        retained_generations().unwrap();
        assert!(!stale.exists());
        assert!(!stale.with_extension("lock").exists());
    }
}
