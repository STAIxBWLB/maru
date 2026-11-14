//! The process umask belongs only to a re-executed test child. The parent
//! harness keeps its own umask and existing parallel-test behavior unchanged.

use super::private_temp_dir;
use std::os::unix::fs::PermissionsExt;

const CHILD: &str = "MARU_HWPED_PRIVATE_TEMPDIR_TEST_CHILD";

fn check_under_umask(test_name: &str, explicit_parent: bool) {
    let case = if explicit_parent {
        "explicit-parent"
    } else {
        "default"
    };
    if std::env::var(CHILD).as_deref() == Ok(case) {
        let root = std::env::temp_dir();
        let parent = root.join("explicit-parent");
        if explicit_parent {
            std::fs::create_dir(&parent).unwrap();
        }
        let directory =
            private_temp_dir(explicit_parent.then_some(parent.as_path()), None).unwrap();
        let expected_parent = if explicit_parent { &parent } else { &root };
        assert_eq!(
            std::fs::canonicalize(directory.path().parent().unwrap()).unwrap(),
            std::fs::canonicalize(expected_parent).unwrap(),
            "the helper must preserve the requested temporary parent"
        );
        let mode = std::fs::metadata(directory.path())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        println!("HWPED_PRIVATE_TEMPDIR_CHILD case={case} mode={mode:o}");
        assert_eq!(
            mode, 0o700,
            "create HWP staging owner-only under umask 022 for {case}"
        );
        return;
    }
    let fixture = tempfile::tempdir().unwrap();
    let output = std::process::Command::new(crate::test_support::posix_shell())
        .args(["-c", "umask 022; exec \"$@\"", "hwped-private-tempdir-test"])
        .arg(std::env::current_exe().unwrap())
        .args(["--exact", test_name, "--nocapture", "--test-threads=1"])
        .env(CHILD, case)
        .env("TMPDIR", fixture.path())
        .env("TMP", fixture.path())
        .env("TEMP", fixture.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "umask child failed: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout)
            .contains(&format!("HWPED_PRIVATE_TEMPDIR_CHILD case={case} mode=700")),
        "the child must execute the exact permission check"
    );
}

#[test]
fn private_temp_dir_default_is_private_under_umask_022() {
    check_under_umask(
        "hwped::private_tempdir_tests::private_temp_dir_default_is_private_under_umask_022",
        false,
    );
}

#[test]
fn private_temp_dir_explicit_parent_is_private_under_umask_022() {
    check_under_umask(
        "hwped::private_tempdir_tests::private_temp_dir_explicit_parent_is_private_under_umask_022",
        true,
    );
}
