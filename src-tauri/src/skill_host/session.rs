//! Session-owned bundle snapshots. Locks retain bundle/env generations until
//! the launching Maru process exits (conservative for detached terminal runs).
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions, TryLockError};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::fs as host_fs;

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
    /// Caller holds narrow pin admission and the registry guard. Update
    /// commit/pruning acquires the same pin path, while network/setup does not.
    pub(crate) fn retain(self) -> Result<Self, String> {
        let key = (self.root.clone(), self.env_root.clone());
        let dir = sessions_dir()?;
        let mut locks = SESSION_LOCKS
            .get_or_init(Default::default)
            .lock()
            .map_err(|_| format!("bundle_session_lock_poisoned: pin bookkeeping at {} is unavailable; preserve the pin files and restart Maru before retrying this skill run", dir.display()))?;
        if locks.contains_key(&key) {
            return Ok(self);
        }
        host_fs::ensure_dir(&dir).map_err(|error| {
            host_fs::operation_error("create session pin directory", &dir, error)
        })?;
        let path = dir.join(format!("{}.json", Uuid::new_v4()));
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(path.with_extension("lock"))
            .map_err(|error| format!("bundle_session_pin_failed: {error}; retry the session"))?;
        file.lock().map_err(|error| {
            host_fs::operation_error("lock session pin", &path.with_extension("lock"), error)
        })?;
        fs::write(
            &path,
            serde_json::to_vec(&self)
                .map_err(|error| host_fs::operation_error("serialize session pin", &path, error))?,
        )
        .map_err(|error| host_fs::operation_error("write session pin", &path, error))?;
        locks.insert(key, file);
        Ok(self)
    }

    pub(crate) fn env(&self, work: Option<&Path>) -> Result<BTreeMap<String, String>, String> {
        let mut env = super::store::env_vars_for_root(&self.env_root, work)?;
        let bin = self.env_root.join(".venv/bin");
        let search = crate::cli_path::augmented_path();
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
        let mut text = replace_path(text, &root, "@PINNED_BUNDLE@");
        text = replace_path(&text, &env, "@PINNED_ENV@");
        text = replace_path(&text, "~/.maru/skills/_builtin", "@MARU_BUNDLE@");
        text = replace_path(
            &text,
            &host_fs::display_path(&skills.join("_builtin")),
            "@MARU_BUNDLE@",
        );
        let catalog = self.root.join("skills");
        for entry in fs::read_dir(&catalog).map_err(|error| {
            host_fs::operation_error("list captured skill catalog", &catalog, error)
        })? {
            let entry = entry.map_err(|error| {
                host_fs::operation_error("read captured skill catalog entry", &catalog, error)
            })?;
            if !entry
                .file_type()
                .map_err(|error| {
                    host_fs::operation_error("inspect captured skill entry", &entry.path(), error)
                })?
                .is_dir()
            {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            // Skill roots are rewritten with or without a trailing '/', so
            // `cd ~/.maru/skills/<name>` stays on the captured generation.
            let pinned = format!("@MARU_BUNDLE@/skills/{name}");
            text = replace_path(&text, &format!("~/.maru/skills/{name}"), &pinned);
            text = replace_path(
                &text,
                &format!("{}/{name}", host_fs::display_path(&skills)),
                &pinned,
            );
        }
        text = replace_path(&text, "~/.maru/env", "@MARU_ENV@");
        text = replace_path(&text, &host_fs::display_path(&legacy_env), "@MARU_ENV@");
        Ok(text
            .replace("@MARU_BUNDLE@", &root)
            .replace("@MARU_ENV@", &env)
            .replace("@PINNED_BUNDLE@", &root)
            .replace("@PINNED_ENV@", &env))
    }

    pub(crate) fn prompt(&self, text: &str) -> Result<String, String> {
        let header = format!("<maru_bundle root={:?} env={:?}>", self.root, self.env_root);
        let rendered = self.render(text)?;
        // Structured role prompts embed the already-composed directive.
        if rendered.contains(&header) {
            return Ok(rendered);
        }
        Ok(format!("{header}\nUse this captured bundle for bundled skills and their resources throughout this session.\n</maru_bundle>\n{rendered}"))
    }
}

/// Cross-process gate between pinning and pruning. The registry guard and
/// path admission are process-local, so the app and a `maru` CLI update in
/// another process meet only here: capture holds it shared while it validates
/// the active state and publishes its pin, and pruning holds it exclusive
/// from the pin scan to the last delete.
pub(crate) fn pin_gate(exclusive: bool) -> Result<File, String> {
    let dir = sessions_dir()?;
    host_fs::ensure_dir(&dir)
        .map_err(|error| host_fs::operation_error("create session pin directory", &dir, error))?;
    let path = dir.join(".gate");
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(|error| host_fs::operation_error("open session pin gate", &path, error))?;
    let locked = if exclusive {
        file.lock()
    } else {
        file.lock_shared()
    };
    locked.map_err(|error| host_fs::operation_error("lock session pin gate", &path, error))?;
    Ok(file)
}

/// Replace `from` only where it ends at a path boundary, so `~/.maru/env`
/// never rewrites `~/.maru/env-backup` or `~/.maru/env.bak`. A trailing '.'
/// that ends a sentence still counts as a boundary.
fn replace_path(text: &str, from: &str, to: &str) -> String {
    if from.is_empty() {
        return text.to_string();
    }
    let path_char = |c: char| c.is_alphanumeric() || c == '-' || c == '_';
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(index) = rest.find(from) {
        let after = &rest[index + from.len()..];
        let mut next = after.chars();
        let boundary = match next.next() {
            None => true,
            Some('.') => !next.next().is_some_and(path_char),
            Some(c) => !path_char(c),
        };
        out.push_str(&rest[..index]);
        out.push_str(if boundary { to } else { from });
        rest = after;
    }
    out.push_str(rest);
    out
}

/// Locks are OS-owned, so a crash releases them without PID reuse heuristics.
/// Any unreadable pin fails closed rather than pruning an uncertain session.
pub(crate) fn retained_generations() -> Result<(BTreeSet<String>, BTreeSet<String>), String> {
    scan_retained(true)
}

pub(crate) fn retained_generations_readonly() -> Result<(BTreeSet<String>, BTreeSet<String>), String>
{
    scan_retained(false)
}

fn scan_retained(cleanup: bool) -> Result<(BTreeSet<String>, BTreeSet<String>), String> {
    let mut bundles = BTreeSet::new();
    let mut envs = BTreeSet::new();
    let dir = sessions_dir()?;
    if !dir.is_dir() {
        return Ok((bundles, envs));
    }
    for entry in fs::read_dir(&dir)
        .map_err(|error| host_fs::operation_error("list session pins", &dir, error))?
    {
        let path = entry
            .map_err(|error| host_fs::operation_error("read session pin entry", &dir, error))?
            .path();
        let extension = path.extension().and_then(|ext| ext.to_str());
        // retain() creates the lock before its json, so a lock-only pin may
        // be a session still publishing in another process: never prune
        // through it. ponytail: a lock-only pin left by a crash is cleared
        // after 60 s; raise the bound if pin publication can stall longer.
        if extension == Some("lock") && !path.with_extension("json").exists() {
            // Its json pair may have been swept earlier in this same scan.
            let file = match OpenOptions::new().read(true).write(true).open(&path) {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    return Err(host_fs::operation_error(
                        "open session pin lock",
                        &path,
                        error,
                    ))
                }
            };
            let stale = match file.try_lock() {
                Ok(()) => path
                    .metadata()
                    .and_then(|metadata| metadata.modified())
                    .ok()
                    .and_then(|modified| modified.elapsed().ok())
                    .is_some_and(|age| age > std::time::Duration::from_secs(60)),
                Err(TryLockError::WouldBlock) => false,
                Err(error) => {
                    return Err(host_fs::operation_error(
                        "probe session pin lock",
                        &path,
                        error,
                    ))
                }
            };
            drop(file);
            if !stale {
                return Err(format!("bundle_session_pin_initializing: {} belongs to a session that is still publishing its pin; cleanup was skipped, retry it after that session starts", path.display()));
            }
            if cleanup {
                fs::remove_file(&path).map_err(|error| {
                    host_fs::operation_error("remove abandoned session lock", &path, error)
                })?;
            }
            continue;
        }
        if extension != Some("json") {
            continue;
        }
        let lock_path = path.with_extension("lock");
        let file = OpenOptions::new().read(true).write(true).open(&lock_path)
            .map_err(|error| format!("bundle_session_pin_unreadable: {}: {error}; inspect the pin before retrying cleanup", path.display()))?;
        match file.try_lock() {
            Ok(()) => {
                drop(file);
                if cleanup {
                    fs::remove_file(&path).map_err(|error| {
                        host_fs::operation_error("remove expired session metadata", &path, error)
                    })?;
                    fs::remove_file(&lock_path).map_err(|error| {
                        host_fs::operation_error("remove expired session lock", &lock_path, error)
                    })?;
                }
            }
            Err(TryLockError::WouldBlock) => {
                let session: BundleSession = serde_json::from_slice(&fs::read(&path).map_err(|error| host_fs::operation_error("read retained session metadata", &path, error))?)
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
    use super::super::bundle_update as bundle;
    use super::*;

    #[test]
    fn path_replacement_stops_at_path_boundaries() {
        assert_eq!(
            replace_path("~/.maru/env-backup", "~/.maru/env", "X"),
            "~/.maru/env-backup"
        );
        assert_eq!(
            replace_path("~/.maru/env.bak", "~/.maru/env", "X"),
            "~/.maru/env.bak"
        );
        assert_eq!(
            replace_path("a/_builtin-old a/_builtin/x", "a/_builtin", "X"),
            "a/_builtin-old X/x"
        );
        assert_eq!(
            replace_path(
                "use ~/.maru/env. Then ~/.maru/env/.venv",
                "~/.maru/env",
                "X"
            ),
            "use X. Then X/.venv"
        );
        assert_eq!(replace_path("`~/.maru/env`", "~/.maru/env", "X"), "`X`");
    }

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
        let root_ref = session
            .render("cd ~/.maru/skills/demo && ls ~/.maru/skills/demo-extra")
            .unwrap();
        assert!(
            root_ref.starts_with(&format!("cd {}/skills/demo &&", root.display())),
            "{root_ref}"
        );
        assert!(
            root_ref.ends_with("~/.maru/skills/demo-extra"),
            "{root_ref}"
        );
        let once = session.prompt(&text).unwrap();
        assert_eq!(
            session
                .prompt(&once)
                .unwrap()
                .matches("<maru_bundle ")
                .count(),
            1
        );
        let role = format!("<role>worker</role><input>{once}</input>");
        assert_eq!(
            session
                .prompt(&role)
                .unwrap()
                .matches("<maru_bundle ")
                .count(),
            1
        );
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

    #[test]
    fn pruning_gate_excludes_pinning_until_released() {
        let _home = host_fs::test_home_for_bundle_tests();
        let exclusive = pin_gate(true).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let pinner = std::thread::spawn(move || {
            let _shared = pin_gate(false).unwrap();
            tx.send(()).unwrap();
        });
        assert!(rx
            .recv_timeout(std::time::Duration::from_millis(300))
            .is_err());
        drop(exclusive);
        rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap();
        pinner.join().unwrap();
    }

    #[test]
    fn a_lock_only_pin_blocks_cleanup_until_it_is_old() {
        let _home = host_fs::test_home_for_bundle_tests();
        let dir = sessions_dir().unwrap();
        fs::create_dir_all(&dir).unwrap();
        let lock = dir.join("publishing.lock");
        fs::write(&lock, b"").unwrap();
        let error = retained_generations().unwrap_err();
        assert!(error.contains("bundle_session_pin_initializing"), "{error}");
        assert!(lock.exists(), "a fresh lock-only pin must not be removed");
    }
}
