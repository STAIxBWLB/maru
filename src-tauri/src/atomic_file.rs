use std::fs;
use std::io::Write;
use std::path::Path;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

/// Write a same-filesystem temporary file, flush it, then atomically replace
/// the destination. `tempfile::persist` uses replace semantics on Windows,
/// where `std::fs::rename` cannot overwrite an existing file.
pub(crate) fn write_atomic(path: &Path, content: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Cannot determine parent directory for {}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|err| format!("Cannot create {}: {err}", parent.display()))?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("file");
    let prefix = format!(".{file_name}.maru-tmp-");
    let mut builder = tempfile::Builder::new();
    builder.prefix(&prefix);
    #[cfg(unix)]
    builder.permissions(fs::Permissions::from_mode(0o666));
    let mut temp = builder
        .tempfile_in(parent)
        .map_err(|err| format!("Cannot create temporary file: {err}"))?;
    temp.write_all(content)
        .map_err(|err| format!("Cannot write temporary file: {err}"))?;
    if let Ok(metadata) = fs::metadata(path) {
        temp.as_file()
            .set_permissions(metadata.permissions())
            .map_err(|err| format!("Cannot preserve {} permissions: {err}", path.display()))?;
    }
    temp.as_file()
        .sync_all()
        .map_err(|err| format!("Cannot sync temporary file: {err}"))?;
    temp.persist(path).map(|_| ()).map_err(|err| {
        format!(
            "Cannot atomically replace {}: {}",
            path.display(),
            err.error
        )
    })
}

/// Atomically publish a fully written file only when the destination does not
/// exist. `persist_noclobber` closes the check/write race that would otherwise
/// let a concurrent creator be overwritten.
pub(crate) fn write_atomic_create(path: &Path, content: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Cannot determine parent directory for {}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|err| format!("Cannot create {}: {err}", parent.display()))?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("file");
    let prefix = format!(".{file_name}.maru-tmp-");
    let mut builder = tempfile::Builder::new();
    builder.prefix(&prefix);
    #[cfg(unix)]
    builder.permissions(fs::Permissions::from_mode(0o666));
    let mut temp = builder
        .tempfile_in(parent)
        .map_err(|err| format!("Cannot create temporary file: {err}"))?;
    temp.write_all(content)
        .map_err(|err| format!("Cannot write temporary file: {err}"))?;
    temp.as_file()
        .sync_all()
        .map_err(|err| format!("Cannot sync temporary file: {err}"))?;
    temp.persist_noclobber(path).map(|_| ()).map_err(|err| {
        format!(
            "target_exists: cannot create {} without overwriting: {}",
            path.display(),
            err.error
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn replaces_existing_file_without_leaving_a_temp_file() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("note.md");
        fs::write(&path, "old").unwrap();

        write_atomic(&path, b"new").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "new");
        assert_eq!(fs::read_dir(tmp.path()).unwrap().count(), 1);
    }

    #[test]
    fn create_never_overwrites_existing_file() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("note.md");
        fs::write(&path, "old").unwrap();

        let error = write_atomic_create(&path, b"new").unwrap_err();

        assert!(error.contains("target_exists"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "old");
    }

    #[cfg(unix)]
    #[test]
    fn preserves_existing_unix_permissions() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("shared.md");
        fs::write(&path, "old").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();

        write_atomic(&path, b"new").unwrap();

        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o640);
    }
}
