use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

/// Locations to probe in addition to the inherited PATH. macOS GUI apps
/// launched from Finder receive a sparse PATH, so CLIs installed by Homebrew,
/// user package managers, or app bundles may be invisible without this.
pub fn extra_path_dirs() -> Vec<PathBuf> {
    let mut out = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
        PathBuf::from("/Applications/cmux.app/Contents/Resources/bin"),
    ];
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        out.push(home.join(".local/bin"));
        out.push(home.join(".npm-global/bin"));
        out.push(home.join(".local/share/fnm/aliases/default/bin"));
        out.push(home.join("go/bin"));
        out.push(home.join(".cargo/bin"));
        out.push(home.join(".nvm/versions/node/current/bin"));
    }
    out.push(PathBuf::from("/opt/homebrew/lib/node_modules/.bin"));
    out.push(PathBuf::from("/usr/local/lib/node_modules/.bin"));
    out
}

pub fn augmented_path() -> OsString {
    let existing = std::env::var_os("PATH").unwrap_or_default();
    let extras = extra_path_dirs();
    let mut paths: Vec<PathBuf> = std::env::split_paths(&existing).collect();
    for dir in extras {
        if !paths.iter().any(|p| p == &dir) {
            paths.push(dir);
        }
    }
    std::env::join_paths(paths).unwrap_or(existing)
}

pub fn merge_path_env(primary: Option<&OsStr>, fallback: Option<&OsStr>) -> OsString {
    let mut paths = Vec::<PathBuf>::new();
    for value in [primary, fallback].into_iter().flatten() {
        for path in std::env::split_paths(value) {
            if !paths.iter().any(|existing| existing == &path) {
                paths.push(path);
            }
        }
    }
    std::env::join_paths(paths).unwrap_or_else(|_| {
        primary
            .or(fallback)
            .map(OsStr::to_os_string)
            .unwrap_or_default()
    })
}

pub fn resolve_program(program: &str) -> Option<PathBuf> {
    let trimmed = program.trim();
    if trimmed.is_empty() {
        return None;
    }
    let candidate = PathBuf::from(trimmed);
    if trimmed.contains(std::path::MAIN_SEPARATOR) || candidate.is_absolute() {
        return is_executable(&candidate).then_some(candidate);
    }
    which_in_path(trimmed, std::env::var_os("PATH").as_deref())
        .or_else(|_| which_in_path(trimmed, Some(&augmented_path())))
        .ok()
}

pub fn which_in_path(program: &str, path_env: Option<&OsStr>) -> Result<PathBuf, std::io::Error> {
    let Some(path_env) = path_env else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "PATH unavailable",
        ));
    };
    for dir in std::env::split_paths(path_env) {
        let candidate = dir.join(program);
        if is_executable(&candidate) {
            return Ok(candidate);
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        format!("{program} not found"),
    ))
}

#[cfg(unix)]
pub fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    match std::fs::metadata(path) {
        Ok(meta) => meta.is_file() && (meta.permissions().mode() & 0o111) != 0,
        Err(_) => false,
    }
}

#[cfg(not(unix))]
pub fn is_executable(path: &Path) -> bool {
    path.is_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn resolves_executable_from_supplied_path() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("sample-cli");
        std::fs::write(&bin, "#!/bin/sh\nexit 0\n").unwrap();
        let mut perms = std::fs::metadata(&bin).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&bin, perms).unwrap();

        let path_env = std::env::join_paths([dir.path()]).unwrap();
        assert_eq!(which_in_path("sample-cli", Some(&path_env)).unwrap(), bin);
    }

    #[test]
    fn augmented_path_includes_common_cli_dirs() {
        let augmented = augmented_path();
        let paths: Vec<PathBuf> = std::env::split_paths(&augmented).collect();
        assert!(paths.contains(&PathBuf::from("/opt/homebrew/bin")));
        assert!(paths.contains(&PathBuf::from(
            "/Applications/cmux.app/Contents/Resources/bin"
        )));
        assert!(paths.contains(&PathBuf::from("/opt/homebrew/lib/node_modules/.bin")));
        if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
            assert!(paths.contains(&home.join(".local/share/fnm/aliases/default/bin")));
        }
    }

    #[test]
    fn merge_path_env_keeps_primary_before_fallback_and_dedupes() {
        let primary =
            std::env::join_paths([PathBuf::from("/custom/bin"), PathBuf::from("/bin")]).unwrap();
        let fallback =
            std::env::join_paths([PathBuf::from("/usr/bin"), PathBuf::from("/bin")]).unwrap();
        let merged = merge_path_env(Some(primary.as_os_str()), Some(fallback.as_os_str()));
        let paths: Vec<PathBuf> = std::env::split_paths(&merged).collect();
        assert_eq!(
            paths,
            vec![
                PathBuf::from("/custom/bin"),
                PathBuf::from("/bin"),
                PathBuf::from("/usr/bin"),
            ]
        );
    }
}
