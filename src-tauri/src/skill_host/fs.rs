use std::fs;
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::fs as unix_fs;

pub fn home_dir() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "Cannot resolve home directory".to_string())
}

pub fn anchor_home() -> Result<PathBuf, String> {
    if let Some(path) = test_anchor_home_override() {
        return Ok(path.join(".anchor"));
    }
    Ok(home_dir()?.join(".anchor"))
}

pub fn skills_root() -> Result<PathBuf, String> {
    Ok(anchor_home()?.join("skills"))
}

pub fn env_root() -> Result<PathBuf, String> {
    Ok(anchor_home()?.join("env"))
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
    let tmp = path.with_extension("tmp");
    let data = serde_json::to_vec_pretty(value)
        .map_err(|err| format!("Cannot serialize {}: {err}", display_path(path)))?;
    fs::write(&tmp, data).map_err(|err| format!("Cannot write {}: {err}", display_path(&tmp)))?;
    fs::rename(&tmp, path).map_err(|err| format!("Cannot replace {}: {err}", display_path(path)))
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
fn test_anchor_home_override() -> Option<PathBuf> {
    std::env::var_os("ANCHOR_TEST_HOME").map(PathBuf::from)
}

#[cfg(not(test))]
fn test_anchor_home_override() -> Option<PathBuf> {
    None
}
