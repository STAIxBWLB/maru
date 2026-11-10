use super::{ensure_version, windows_metadata_target};
use std::path::PathBuf;

#[test]
fn windows_extensionless_metadata_uses_spawnable_exe_when_present() {
    let dir = tempfile::tempdir().unwrap();
    let logical = dir.path().join("hwp");
    let mut executable_name = logical.as_os_str().to_os_string();
    executable_name.push(".exe");
    let executable = PathBuf::from(executable_name);
    std::fs::write(&executable, b"fixture").unwrap();

    assert_eq!(
        windows_metadata_target(&logical, |candidate| candidate.is_file()),
        executable
    );
    assert_eq!(
        windows_metadata_target(&logical, |_| false),
        logical,
        "the logical program path is the fallback when .exe is absent"
    );
}

#[cfg(unix)]
#[test]
fn version_probe_uses_original_symlink_argv0_and_separates_alias_cache_entries() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("shim-target");
    let old_alias = dir.path().join("logical-old");
    let new_alias = dir.path().join("logical-new");
    crate::test_support::write_executable_fixture(
        &target,
        "#!/bin/sh\ncase \"$0\" in\n  *logical-old) printf 'hwp 0.8.7\\n' ;;\n  *logical-new) printf 'hwp 0.20.0\\n' ;;\n  *) exit 9 ;;\nesac\n",
        0o755,
    )
    .unwrap();
    symlink(&target, &old_alias).unwrap();
    symlink(&target, &new_alias).unwrap();
    assert_eq!(
        std::fs::canonicalize(&old_alias).unwrap(),
        std::fs::canonicalize(&new_alias).unwrap()
    );

    assert_eq!(ensure_version(&old_alias).unwrap(), "0.8.7");
    assert_eq!(ensure_version(&new_alias).unwrap(), "0.20.0");
    assert_eq!(ensure_version(&old_alias).unwrap(), "0.8.7");
    assert_eq!(ensure_version(&new_alias).unwrap(), "0.20.0");
}
