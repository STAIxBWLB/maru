use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::paths::require_absolute;

#[cfg(unix)]
use std::os::unix::fs as unix_fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

#[cfg(test)]
use std::sync::{Mutex, MutexGuard, OnceLock};

pub fn home_dir() -> Result<PathBuf, String> {
    if let Some(home) = crate::paths::native_e2e_dir_override(crate::paths::NATIVE_E2E_HOME_VAR)? {
        return Ok(home);
    }
    dirs::home_dir().ok_or_else(|| "Cannot resolve home directory".to_string())
}

pub fn maru_home() -> Result<PathBuf, String> {
    // The final value is validated on every return path, including the
    // test-override branch (D-08/D-09): a relative base would silently
    // materialize directory trees in the process cwd.
    let base = if let Some(path) = test_maru_home_override() {
        path.join(".maru")
    } else {
        home_dir()?.join(".maru")
    };
    require_absolute(base)
}

pub fn skills_root() -> Result<PathBuf, String> {
    Ok(maru_home()?.join("skills"))
}

pub fn env_base() -> Result<PathBuf, String> {
    Ok(maru_home()?.join("env"))
}

pub fn hashed_env_root(hash: &str) -> Result<PathBuf, String> {
    if hash.is_empty()
        || ["node", "node_modules", "temp", "logs", "input", "output"].contains(&hash)
        || !hash
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-' || c == b'_')
    {
        return Err("invalid_env_hash: expected a nonempty lowercase ASCII path-safe hash; report the invalid envHash to the skills channel maintainer, then retry with `maru skills update --apply --repair-env` after corrected metadata is published".into());
    }
    let root = env_base()?.join(hash);
    if fs::symlink_metadata(&root).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("invalid_env_hash: environment directory must not be a symlink; move the conflicting link aside and retry".into());
    }
    Ok(root)
}

/// All runtime and maintenance callers resolve the same active environment.
/// Older installations remain usable until their first hashed build succeeds.
pub fn env_root() -> Result<PathBuf, String> {
    let state_path = super::bundle_update::state_path()?;
    let recovery = format!("restore {} from a known-good backup, then run `maru skills update --apply --repair-env`; if no backup is available, report this file to the skills channel maintainer", display_path(&state_path));
    match fs::symlink_metadata(&state_path) {
        Ok(metadata) if !metadata.file_type().is_file() => {
            return Err(format!(
                "skills_env_state_unreadable: {} is not a regular file; {recovery}",
                display_path(&state_path)
            ));
        }
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            return Err(format!(
                "skills_env_state_unreadable: cannot inspect {}: {error}; {recovery}",
                display_path(&state_path)
            ));
        }
        _ => (),
    }
    let state = super::bundle_update::read_state()
        .map_err(|error| format!("skills_env_state_unreadable: {error}; {recovery}"))?;
    // A missing state permits legacy fallback. An unreadable state must not
    // redirect repair into the legacy env when the active hash is unknown.
    if let Some(active) = state.and_then(|state| state.active) {
        if !active.env_hash.is_empty() {
            let root = hashed_env_root(&active.env_hash).map_err(|error| {
                format!(
                    "{error}; invalid env hash in bundle state {}: {recovery}",
                    display_path(&state_path)
                )
            })?;
            if root.is_dir() {
                return Ok(root);
            }
        }
    }
    env_base()
}

/// Base directory under which tool install roots (`~/.claude`, `~/.codex`)
/// resolve. In production this is the real home; under tests it follows the
/// `MARU_TEST_HOME` override so installs stay sandboxed.
pub fn install_root_base() -> Result<PathBuf, String> {
    // Same absolute-base guard as maru_home() — covers both the test-override
    // and the production branch (D-08/D-09, Pitfall 6).
    let base = match test_maru_home_override() {
        Some(path) => path,
        None => home_dir()?,
    };
    require_absolute(base)
}

/// Resolve Codex's active home. Isolated hosts such as Orca set `CODEX_HOME`
/// to a profile-specific directory instead of using the default `~/.codex`.
/// Test homes always win so tool-sync tests cannot escape their sandbox.
pub fn codex_home() -> Result<PathBuf, String> {
    if let Some(path) = test_maru_home_override() {
        return Ok(path.join(".codex"));
    }
    if let Some(home) = crate::paths::native_e2e_dir_override(crate::paths::NATIVE_E2E_HOME_VAR)? {
        return Ok(home.join(".codex"));
    }
    let home = home_dir()?;
    require_absolute(resolve_codex_home(
        &home,
        std::env::var_os("CODEX_HOME").map(PathBuf::from),
    ))
}

fn resolve_codex_home(home: &Path, configured: Option<PathBuf>) -> PathBuf {
    configured
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| home.join(".codex"))
}

/// Explicit runtime roots stay isolated under hermetic test homes.
pub fn agent_config_home(variable: &str, fallback: &str) -> Result<PathBuf, String> {
    let home = install_root_base()?;
    if test_maru_home_override().is_some()
        || crate::paths::native_e2e_dir_override(crate::paths::NATIVE_E2E_HOME_VAR)?.is_some()
    {
        return require_absolute(home.join(fallback));
    }
    require_absolute(
        std::env::var_os(variable)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(fallback)),
    )
}

pub fn opencode_home() -> Result<PathBuf, String> {
    let base = agent_config_home("OPENCODE_CONFIG_DIR", ".config/opencode")?;
    if test_maru_home_override().is_none()
        && crate::paths::native_e2e_dir_override(crate::paths::NATIVE_E2E_HOME_VAR)?.is_none()
        && std::env::var_os("OPENCODE_CONFIG_DIR")
            .filter(|value| !value.is_empty())
            .is_none()
    {
        if let Some(root) = std::env::var_os("XDG_CONFIG_HOME").filter(|value| !value.is_empty()) {
            return require_absolute(PathBuf::from(root).join("opencode"));
        }
    }
    Ok(base)
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

/// Path text for comparing link targets. Windows stores a link created with a
/// canonical `\\?\C:\...` target and reads it back as `C:\...`; both name
/// the same location, so comparisons drop the verbatim drive prefix.
pub fn simplified(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            if !rest.starts_with(r"UNC\") {
                return PathBuf::from(rest);
            }
        }
    }
    path.to_path_buf()
}

pub fn read_link_target(path: &Path) -> Option<PathBuf> {
    fs::symlink_metadata(path)
        .ok()
        .filter(|meta| meta.file_type().is_symlink())
        .and_then(|_| fs::read_link(path).ok())
}

/// Unlinks the link itself, never its target. Windows stores a directory
/// symlink as a directory entry, which `remove_file` refuses.
pub fn remove_symlink(path: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileTypeExt;
        if fs::symlink_metadata(path)?.file_type().is_symlink_dir() {
            return fs::remove_dir(path);
        }
    }
    fs::remove_file(path)
}

pub fn remove_if_matching_symlink(path: &Path, expected: &Path) -> Result<bool, String> {
    let Some(target) = read_link_target(path) else {
        return Ok(false);
    };
    if simplified(&target) != simplified(expected) {
        return Ok(false);
    }
    remove_symlink(path).map_err(|err| format!("Cannot remove {}: {err}", display_path(path)))?;
    Ok(true)
}

pub fn create_symlink_no_clobber(link: &Path, target: &Path) -> Result<(), String> {
    if link.exists() || fs::symlink_metadata(link).is_ok() {
        if read_link_target(link).is_some_and(|current| simplified(&current) == simplified(target))
        {
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
pub(crate) fn test_maru_home_override() -> Option<PathBuf> {
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
pub(crate) fn test_maru_home_override() -> Option<PathBuf> {
    None
}

/// Shared test fixture: sandbox MARU_TEST_HOME into a TempDir, holding the
/// process-global home lock until dropped. Field order is load-bearing (the
/// guard must drop last) — see store::tests::TestHome.
#[cfg(test)]
pub(crate) struct BundleTestHome {
    _dir: tempfile::TempDir,
    previous: Option<std::ffi::OsString>,
    _guard: MutexGuard<'static, ()>,
}

#[cfg(test)]
impl Drop for BundleTestHome {
    fn drop(&mut self) {
        if let Some(previous) = self.previous.as_ref() {
            std::env::set_var("MARU_TEST_HOME", previous);
        } else {
            std::env::remove_var("MARU_TEST_HOME");
        }
    }
}

#[cfg(test)]
pub(crate) fn test_home_for_bundle_tests() -> BundleTestHome {
    let guard = test_maru_home_lock();
    let dir = tempfile::TempDir::new().unwrap();
    let previous = std::env::var_os("MARU_TEST_HOME");
    std::env::set_var("MARU_TEST_HOME", dir.path());
    BundleTestHome {
        _dir: dir,
        previous,
        _guard: guard,
    }
}

/// Shared boundary for filesystem/archive failures surfaced by skills CLI/IPC.
pub(crate) fn operation_error(
    operation: &str,
    path: &Path,
    error: impl std::fmt::Display,
) -> String {
    format!("skills_io_failed: {operation} at {}: {error}; inspect this path and resolve the reported filesystem/archive error, check the active bundle with `maru skills update --check`, then retry the requested skill/update/rollback", display_path(path))
}

pub(crate) fn link_temp(link: &Path) -> PathBuf {
    let name = link.file_name().unwrap_or_default().to_string_lossy();
    let hash = super::bundle_update::sha256_hex(name.as_bytes());
    link.with_file_name(format!(".maru-next-{}", &hash[..16]))
}

/// Prefer an atomic legacy-directory exchange; use the owner's one-time
/// migration exception only when the platform/filesystem cannot exchange.
pub(crate) fn migrate_legacy_directory(
    link: &Path,
    target: &Path,
    retired: &Path,
) -> Result<(), String> {
    migrate_legacy_directory_with_exchange(link, target, retired, exchange_paths)
}

fn migrate_legacy_directory_with_exchange(
    link: &Path,
    target: &Path,
    retired: &Path,
    exchange: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> Result<(), String> {
    let parent = retired.parent().ok_or(
        "skill_migration_parent_missing: inspect the retired-workspace path before retrying",
    )?;
    ensure_dir(parent)
        .map_err(|error| operation_error("create retired-workspace parent", parent, error))?;
    match fs::symlink_metadata(retired) {
        Ok(metadata) if metadata.file_type().is_symlink() && read_link_target(retired).as_deref() == Some(target) => (),
        Ok(_) => return Err(format!("skill_migration_conflict: {} already contains an entry; preserve it and inspect the migration journal before retrying", retired.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => create_symlink_no_clobber(retired, target)?,
        Err(error) => return Err(operation_error("inspect retired-workspace staging path", retired, error)),
    }
    match exchange(link, retired) {
        Ok(()) => Ok(()),
        Err(error) if exchange_is_unsupported(&error) => migrate_legacy_with_gap(link, retired),
        Err(error) => Err(operation_error(
            "atomically exchange legacy directory and staged symlink",
            link,
            error,
        )),
    }
}

fn exchange_is_unsupported(error: &std::io::Error) -> bool {
    if error.kind() == std::io::ErrorKind::Unsupported {
        return true;
    }
    #[cfg(target_os = "linux")]
    {
        matches!(error.raw_os_error(), Some(22 | 38 | 95))
    } // EINVAL / ENOSYS / ENOTSUP
    #[cfg(target_os = "macos")]
    {
        matches!(error.raw_os_error(), Some(22 | 45 | 78))
    } // EINVAL / ENOTSUP / ENOSYS
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        false
    }
}

fn migrate_legacy_with_gap(link: &Path, retired: &Path) -> Result<(), String> {
    // Owner's AC1 exception: https://github.com/STAIxBWLB/maru/issues/466#issuecomment-6622259347
    // Windows and unsupported
    // exchange filesystems may have a short gap on this ONE-TIME migration.
    // Fully stage the symlink before retiring the directory; keep the old
    // tree for N-1/recovery. Later switches retain atomic link replacement.
    let staged = link_temp(link);
    match fs::symlink_metadata(&staged) {
        Ok(_) => return Err(format!("skill_migration_conflict: {}; preserve the existing staging entry and inspect the journal before retrying", staged.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(error) => return Err(operation_error("inspect fallback migration staging", &staged, error)),
    }
    fs::rename(retired, &staged)
        .map_err(|error| operation_error("stage fallback migration symlink", &staged, error))?;
    fs::rename(link, retired).map_err(|error| {
        operation_error(
            "retire legacy directory for fallback migration",
            retired,
            error,
        )
    })?;
    // Only these two adjacent renames are in the gap. No copy/setup runs here.
    if let Err(error) = fs::rename(&staged, link) {
        let publication = operation_error("publish fallback migration symlink", link, error);
        if let Err(restore) = fs::rename(retired, link) {
            return Err(format!("{publication}; restoration failed: {restore}; old tree remains at {}; preserve it and retry journal recovery after resolving the path error", retired.display()));
        }
        return Err(publication);
    }
    Ok(())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn exchange_paths(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let from = std::ffi::CString::new(from.as_os_str().as_bytes())
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
    let to = std::ffi::CString::new(to.as_os_str().as_bytes())
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
    #[cfg(target_os = "linux")]
    unsafe extern "C" {
        fn renameat2(
            old_dir: i32,
            old: *const std::ffi::c_char,
            new_dir: i32,
            new: *const std::ffi::c_char,
            flags: u32,
        ) -> i32;
    }
    #[cfg(target_os = "macos")]
    unsafe extern "C" {
        fn renamex_np(
            old: *const std::ffi::c_char,
            new: *const std::ffi::c_char,
            flags: u32,
        ) -> i32;
    }
    // SAFETY: live NUL-terminated paths; flag 2 is RENAME_EXCHANGE on Linux
    // and RENAME_SWAP on Darwin. Both exchange existing names atomically.
    #[cfg(target_os = "linux")]
    let result = unsafe { renameat2(-100, from.as_ptr(), -100, to.as_ptr(), 2) };
    #[cfg(target_os = "macos")]
    let result = unsafe { renamex_np(from.as_ptr(), to.as_ptr(), 2) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn exchange_paths(_from: &Path, _to: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "atomic legacy-directory migration is unavailable on this platform; the old directory was preserved"))
}

/// Publish a new symlink by rename, never by unlinking the old entry first.
/// The caller has already checked ownership and admitted link + temporary path.
pub(crate) fn replace_symlink(link: &Path, target: &Path) -> Result<(), String> {
    let temp = link_temp(link);
    if let Some(existing) = read_link_target(&temp) {
        if simplified(&existing) != simplified(target) {
            return Err(format!(
                "skill_link_staging_conflict: {}; inspect the staging link before retrying",
                display_path(&temp)
            ));
        }
        remove_symlink(&temp).map_err(|error| {
            operation_error("remove stale skill-link staging entry", &temp, error)
        })?;
    }
    create_symlink_no_clobber(&temp, target)?;
    let result = rename_link(&temp, link);
    if result.is_err() {
        let _ = remove_symlink(&temp);
    }
    result.map_err(|error| format!("skill_link_switch_failed: {}: {error}; the previous link was preserved, retry after resolving the filesystem error", display_path(link)))
}

#[cfg(not(windows))]
fn rename_link(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::rename(from, to)
}

#[cfg(windows)]
fn rename_link(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::{ffi::OsStrExt, fs::OpenOptionsExt, io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::{
        FileRenameInfoEx, SetFileInformationByHandle, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_RENAME_INFO,
    };
    let file = fs::OpenOptions::new()
        .access_mode(0x00010000)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(from)?;
    let name: Vec<u16> = to.as_os_str().encode_wide().collect();
    let offset = std::mem::offset_of!(FILE_RENAME_INFO, FileName);
    let size = offset + name.len() * 2;
    let mut storage = vec![0usize; size.div_ceil(std::mem::size_of::<usize>())];
    let info = storage.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    // SAFETY: aligned storage has room for the header and complete UTF-16 name;
    // the open handle names the reparse point itself, never its target.
    unsafe {
        (*info).Anonymous.Flags = 0x1 | 0x2; // REPLACE_IF_EXISTS | POSIX_SEMANTICS
        (*info).RootDirectory = std::ptr::null_mut();
        (*info).FileNameLength = (name.len() * 2) as u32;
        std::ptr::copy_nonoverlapping(
            name.as_ptr(),
            storage.as_mut_ptr().cast::<u8>().add(offset).cast::<u16>(),
            name.len(),
        );
        if SetFileInformationByHandle(
            file.as_raw_handle(),
            FileRenameInfoEx,
            info.cast(),
            size as u32,
        ) == 0
        {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    #[test]
    fn unsupported_exchange_migrates_with_staged_link_and_retains_the_old_tree() {
        let _home = test_home_for_bundle_tests();
        let builtin = skills_root().unwrap().join("_builtin");
        let target = skills_root().unwrap().join("_workspaces/old");
        for dir in [&builtin, &target] {
            fs::create_dir_all(dir).unwrap();
            fs::write(dir.join("keep"), "old bytes").unwrap();
        }
        let retired = skills_root().unwrap().join("_cache/retired/old");
        migrate_legacy_directory_with_exchange(&builtin, &target, &retired, |_, _| {
            Err(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "fixture unsupported exchange",
            ))
        })
        .unwrap();
        assert_eq!(read_link_target(&builtin).unwrap(), target);
        assert_eq!(
            fs::read_to_string(builtin.join("keep")).unwrap(),
            "old bytes"
        );
        assert_eq!(
            fs::read_to_string(retired.join("keep")).unwrap(),
            "old bytes"
        );
        assert!(fs::symlink_metadata(&retired).unwrap().is_dir());
        assert!(!link_temp(&builtin).exists());
    }

    #[test]
    fn migration_does_not_fall_back_for_an_ordinary_exchange_error() {
        let _home = test_home_for_bundle_tests();
        let builtin = skills_root().unwrap().join("_builtin");
        let target = skills_root().unwrap().join("_workspaces/old");
        fs::create_dir_all(&builtin).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(builtin.join("keep"), "old bytes").unwrap();
        let retired = skills_root().unwrap().join("_cache/retired/old");
        let error = migrate_legacy_directory_with_exchange(&builtin, &target, &retired, |_, _| {
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "fixture denied exchange",
            ))
        })
        .unwrap_err();
        assert!(
            error.contains("atomically exchange legacy directory"),
            "{error}"
        );
        assert!(fs::symlink_metadata(&builtin).unwrap().is_dir());
        assert_eq!(
            fs::read_to_string(builtin.join("keep")).unwrap(),
            "old bytes"
        );
        assert!(
            read_link_target(&retired).is_some(),
            "failed exchange did not retire the old directory"
        );
    }

    #[test]
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn legacy_migration_exchanges_names_and_retains_the_original_directory() {
        let _home = test_home_for_bundle_tests();
        let builtin = skills_root().unwrap().join("_builtin");
        let workspace = skills_root().unwrap().join("_workspaces/old");
        for root in [&builtin, &workspace] {
            fs::create_dir_all(root.join("skills/demo")).unwrap();
            fs::write(root.join("skills/demo/SKILL.md"), "old").unwrap();
        }
        let cached_target = builtin.join("skills/demo/SKILL.md");
        let retired = skills_root().unwrap().join("_cache/retired/old");
        migrate_legacy_directory(&builtin, &workspace, &retired).unwrap();
        assert_eq!(read_link_target(&builtin).unwrap(), workspace);
        assert_eq!(fs::read_to_string(cached_target).unwrap(), "old");
        assert!(fs::symlink_metadata(&retired).unwrap().is_dir());
        assert_eq!(
            fs::read_to_string(retired.join("skills/demo/SKILL.md")).unwrap(),
            "old"
        );
    }

    #[test]
    fn hashed_env_root_rejects_case_aliases_of_active_and_reserved_directories() {
        let _home = test_home_for_bundle_tests();
        assert!(hashed_env_root("active-env").is_ok());
        for hash in ["ACTIVE-ENV", "Active-env", "NODE", "Temp", "Abcdef"] {
            let error = hashed_env_root(hash).unwrap_err();
            assert!(error.contains("invalid_env_hash"), "{hash}: {error}");
            assert!(error.contains("lowercase ASCII"), "{hash}: {error}");
        }
    }

    #[test]
    fn env_resolver_refuses_a_directory_at_the_state_path() {
        let _home = test_home_for_bundle_tests();
        let state_path = super::super::bundle_update::state_path().unwrap();
        fs::create_dir_all(&state_path).unwrap();
        fs::create_dir_all(env_base().unwrap().join(".venv")).unwrap();
        let error = env_root().unwrap_err();
        assert!(error.contains("skills_env_state_unreadable"), "{error}");
        assert!(error.contains("not a regular file"), "{error}");
        assert!(error.contains(&display_path(&state_path)), "{error}");
        assert!(
            error.contains("maru skills update --apply --repair-env"),
            "{error}"
        );
        assert!(state_path.is_dir());
    }

    #[test]
    #[cfg(unix)]
    fn env_resolver_refuses_a_dangling_state_symlink() {
        let _home = test_home_for_bundle_tests();
        let state_path = super::super::bundle_update::state_path().unwrap();
        fs::create_dir_all(state_path.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink("missing-state", &state_path).unwrap();
        let error = env_root().unwrap_err();
        assert!(error.contains("skills_env_state_unreadable"), "{error}");
        assert!(error.contains("not a regular file"), "{error}");
        assert!(error.contains(&display_path(&state_path)), "{error}");
        assert_eq!(
            fs::read_link(&state_path).unwrap(),
            PathBuf::from("missing-state")
        );
    }

    #[test]
    fn env_resolver_preserves_legacy_fallback_but_rejects_corrupt_state() {
        let _home = test_home_for_bundle_tests();
        let legacy = env_base().unwrap();
        fs::create_dir_all(&legacy).unwrap();
        assert_eq!(env_root().unwrap(), legacy);
        let state_path = super::super::bundle_update::state_path().unwrap();
        fs::create_dir_all(state_path.parent().unwrap()).unwrap();
        fs::write(&state_path, b"{broken state").unwrap();
        let error = env_root().unwrap_err();
        assert!(error.contains("Cannot parse"), "{error}");
        assert!(error.contains("skills_env_state_unreadable"), "{error}");
        assert!(error.contains(&display_path(&state_path)), "{error}");
        assert!(error.contains("known-good backup"), "{error}");
        assert!(
            error.contains("maru skills update --apply --repair-env"),
            "{error}"
        );
        assert_eq!(fs::read(&state_path).unwrap(), b"{broken state");
    }

    #[test]
    #[cfg(not(feature = "native-e2e"))]
    fn phase08_01_normal_build_ignores_native_home_override() {
        let _guard = test_maru_home_lock();
        let previous = std::env::var_os(crate::paths::NATIVE_E2E_HOME_VAR);
        std::env::set_var(crate::paths::NATIVE_E2E_HOME_VAR, "relative-native-home");
        let result = home_dir();
        if let Some(previous) = previous {
            std::env::set_var(crate::paths::NATIVE_E2E_HOME_VAR, previous);
        } else {
            std::env::remove_var(crate::paths::NATIVE_E2E_HOME_VAR);
        }
        assert_eq!(result.unwrap(), dirs::home_dir().unwrap());
        assert!(!Path::new("relative-native-home").exists());
    }

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

    #[test]
    fn maru_home_rejects_relative_test_home() {
        // SCAN-04: a non-absolute home base must fail loudly via Err on every
        // return path — a relative base otherwise materializes directory
        // trees in the process cwd (the stray `Users/` incident class).
        let _guard = test_maru_home_lock();
        let previous = std::env::var_os("MARU_TEST_HOME");
        std::env::set_var("MARU_TEST_HOME", "relative-home");

        let home_result = maru_home();
        let env_result = env_root();
        let install_result = install_root_base();

        // Restore the previous env value on all paths (BundleTestHome Drop
        // idiom) so the mutation cannot leak into sibling tests.
        if let Some(previous) = previous.as_ref() {
            std::env::set_var("MARU_TEST_HOME", previous);
        } else {
            std::env::remove_var("MARU_TEST_HOME");
        }

        assert!(
            home_result.is_err(),
            "maru_home() must reject a relative base, got: {home_result:?}"
        );
        assert!(
            env_result.is_err(),
            "env_root() must reject a relative base (derived from maru_home), got: {env_result:?}"
        );
        assert!(
            install_result.is_err(),
            "install_root_base() must reject a relative base, got: {install_result:?}"
        );
        // The guard must fire before anything is created: no tree in cwd.
        assert!(!Path::new("relative-home").exists());
    }

    #[test]
    fn codex_home_prefers_configured_profile_and_falls_back_to_dot_codex() {
        let home = Path::new("/users/tester");
        assert_eq!(
            resolve_codex_home(home, Some(PathBuf::from("/profiles/orca"))),
            PathBuf::from("/profiles/orca")
        );
        assert_eq!(
            resolve_codex_home(home, Some(PathBuf::new())),
            PathBuf::from("/users/tester/.codex")
        );
        assert_eq!(
            resolve_codex_home(home, None),
            PathBuf::from("/users/tester/.codex")
        );
    }

    /// Env-mutating resolution tests must run outside the MARU_TEST_HOME
    /// sandbox (the override intentionally ignores profile env vars) while
    /// still holding the shared home lock so sandboxed tests never observe
    /// the mutation. Restores every variable on all paths.
    struct ProfileEnv {
        _guard: MutexGuard<'static, ()>,
        saved: Vec<(&'static str, Option<std::ffi::OsString>)>,
    }

    impl ProfileEnv {
        fn enter(names: &[&'static str]) -> Self {
            let guard = test_maru_home_lock();
            let saved = names
                .iter()
                .map(|name| (*name, std::env::var_os(name)))
                .collect();
            ProfileEnv {
                _guard: guard,
                saved,
            }
        }
    }

    impl Drop for ProfileEnv {
        fn drop(&mut self) {
            for (name, value) in &self.saved {
                if let Some(value) = value {
                    std::env::set_var(name, value);
                } else {
                    std::env::remove_var(name);
                }
            }
        }
    }

    #[test]
    fn agent_config_home_honors_absolute_profile_override_and_rejects_relative() {
        let env = ProfileEnv::enter(&["MARU_TEST_HOME", "KIMI_CODE_HOME"]);
        std::env::remove_var("MARU_TEST_HOME");
        let profile = TempDir::new().unwrap();
        std::env::set_var("KIMI_CODE_HOME", profile.path());
        assert_eq!(
            agent_config_home("KIMI_CODE_HOME", ".kimi-code").unwrap(),
            profile.path()
        );
        std::env::remove_var("KIMI_CODE_HOME");
        assert_eq!(
            agent_config_home("KIMI_CODE_HOME", ".kimi-code").unwrap(),
            dirs::home_dir().unwrap().join(".kimi-code")
        );
        std::env::set_var("KIMI_CODE_HOME", "relative-kimi-home");
        assert!(agent_config_home("KIMI_CODE_HOME", ".kimi-code").is_err());
        drop(env);
        assert!(!Path::new("relative-kimi-home").exists());
    }

    #[test]
    fn opencode_home_prefers_explicit_dir_then_xdg_then_default_config() {
        let env = ProfileEnv::enter(&["MARU_TEST_HOME", "OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME"]);
        std::env::remove_var("MARU_TEST_HOME");
        let explicit = TempDir::new().unwrap();
        let xdg = TempDir::new().unwrap();
        std::env::set_var("OPENCODE_CONFIG_DIR", explicit.path());
        std::env::set_var("XDG_CONFIG_HOME", xdg.path());
        assert_eq!(opencode_home().unwrap(), explicit.path());
        std::env::remove_var("OPENCODE_CONFIG_DIR");
        assert_eq!(opencode_home().unwrap(), xdg.path().join("opencode"));
        std::env::remove_var("XDG_CONFIG_HOME");
        assert_eq!(
            opencode_home().unwrap(),
            dirs::home_dir().unwrap().join(".config/opencode")
        );
        drop(env);
    }
}
