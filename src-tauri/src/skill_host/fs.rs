use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::fs as unix_fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

#[cfg(test)]
use std::sync::{Mutex, MutexGuard, OnceLock};

pub fn home_dir() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "Cannot resolve home directory".to_string())
}

pub fn maru_home() -> Result<PathBuf, String> {
    if let Some(path) = test_maru_home_override() {
        return Ok(path.join(".maru"));
    }
    Ok(home_dir()?.join(".maru"))
}

pub fn skills_root() -> Result<PathBuf, String> {
    Ok(maru_home()?.join("skills"))
}

pub fn env_root() -> Result<PathBuf, String> {
    Ok(maru_home()?.join("env"))
}

/// Base directory under which tool install roots (`~/.claude`, `~/.codex`)
/// resolve. In production this is the real home; under tests it follows the
/// `MARU_TEST_HOME` override so installs stay sandboxed.
pub fn install_root_base() -> Result<PathBuf, String> {
    if let Some(path) = test_maru_home_override() {
        return Ok(path);
    }
    home_dir()
}

pub fn expand_tilde(input: &str) -> PathBuf {
    let trimmed = input.trim();
    if trimmed == "~" {
        return home_dir().unwrap_or_else(|_| PathBuf::from(trimmed));
    }
    if let Some(rest) = trimmed.strip_prefix("~/") {
        return home_dir()
            .map(|home| home.join(rest))
            .unwrap_or_else(|_| PathBuf::from(trimmed));
    }
    PathBuf::from(trimmed)
}

pub fn display_path(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

pub fn ensure_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|err| format!("Cannot create {}: {err}", display_path(path)))
}

pub fn write_json_pretty<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Cannot resolve parent for {}", display_path(path)))?;
    ensure_dir(parent)?;
    let data = serde_json::to_vec_pretty(value)
        .map_err(|err| format!("Cannot serialize {}: {err}", display_path(path)))?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("registry.json");
    let prefix = format!(".{file_name}.maru-tmp-");
    let mut builder = tempfile::Builder::new();
    builder.prefix(&prefix);
    #[cfg(unix)]
    builder.permissions(fs::Permissions::from_mode(0o666));
    let mut tmp = builder.tempfile_in(parent).map_err(|err| {
        format!(
            "Cannot create temporary file in {}: {err}",
            display_path(parent)
        )
    })?;
    tmp.write_all(&data).map_err(|err| {
        format!(
            "Cannot write temporary file for {}: {err}",
            display_path(path)
        )
    })?;
    if let Ok(metadata) = fs::metadata(path) {
        tmp.as_file()
            .set_permissions(metadata.permissions())
            .map_err(|err| format!("Cannot preserve {} permissions: {err}", display_path(path)))?;
    }
    tmp.as_file().sync_all().map_err(|err| {
        format!(
            "Cannot sync temporary file for {}: {err}",
            display_path(path)
        )
    })?;
    tmp.persist(path)
        .map(|_| ())
        .map_err(|err| format!("Cannot replace {}: {}", display_path(path), err.error))
}

pub fn read_link_target(path: &Path) -> Option<PathBuf> {
    fs::symlink_metadata(path)
        .ok()
        .filter(|meta| meta.file_type().is_symlink())
        .and_then(|_| fs::read_link(path).ok())
}

pub fn remove_if_matching_symlink(path: &Path, expected: &Path) -> Result<bool, String> {
    let Some(target) = read_link_target(path) else {
        return Ok(false);
    };
    if target != expected {
        return Ok(false);
    }
    fs::remove_file(path).map_err(|err| format!("Cannot remove {}: {err}", display_path(path)))?;
    Ok(true)
}

pub fn create_symlink_no_clobber(link: &Path, target: &Path) -> Result<(), String> {
    if link.exists() || fs::symlink_metadata(link).is_ok() {
        if read_link_target(link).as_deref() == Some(target) {
            return Ok(());
        }
        return Err(format!(
            "install_target_exists: {} already exists and does not point to {}",
            display_path(link),
            display_path(target)
        ));
    }
    let parent = link
        .parent()
        .ok_or_else(|| format!("Cannot resolve parent for {}", display_path(link)))?;
    ensure_dir(parent)?;
    #[cfg(unix)]
    {
        unix_fs::symlink(target, link).map_err(|err| {
            format!(
                "Cannot symlink {} -> {}: {err}",
                display_path(link),
                display_path(target)
            )
        })
    }
    #[cfg(not(unix))]
    {
        std::os::windows::fs::symlink_dir(target, link).map_err(|err| {
            format!(
                "Cannot symlink {} -> {}: {err}",
                display_path(link),
                display_path(target)
            )
        })
    }
}

pub fn safe_entry_name(input: &str) -> Result<String, String> {
    let name = input.trim();
    if name.is_empty() {
        return Err("skill_name_required".to_string());
    }
    if name.contains('/') || name.contains('\\') || name == "." || name == ".." {
        return Err(format!("invalid_skill_name: {name}"));
    }
    Ok(name.to_string())
}

#[cfg(test)]
fn test_maru_home_override() -> Option<PathBuf> {
    std::env::var_os("MARU_TEST_HOME").map(PathBuf::from)
}

#[cfg(test)]
static MARU_TEST_HOME_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[cfg(test)]
pub(crate) fn test_maru_home_lock() -> MutexGuard<'static, ()> {
    MARU_TEST_HOME_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(not(test))]
fn test_maru_home_override() -> Option<PathBuf> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    #[test]
    fn pretty_json_atomically_replaces_an_existing_file() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("registry.json");
        fs::write(&path, b"{\"old\":true}").unwrap();

        write_json_pretty(&path, &json!({ "new": true })).unwrap();

        let value: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(value, json!({ "new": true }));
        assert_eq!(fs::read_dir(tmp.path()).unwrap().count(), 1);
    }
}
