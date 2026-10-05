//! Executable fixtures shared by unit tests; never part of production builds.

use std::io;
use std::path::Path;

pub(crate) fn write_executable_fixture(
    path: impl AsRef<Path>,
    contents: impl AsRef<[u8]>,
    mode: u32,
) -> io::Result<()> {
    #[cfg(unix)]
    {
        let path = path.as_ref();
        let writer = unix::write_locked(path, contents.as_ref(), mode)?;
        // Never unlock explicitly: fork/dup shares this open file description.
        // Its lock must survive until the last writable descriptor closes.
        drop(writer);
        unix::wait_until_ready(path, std::time::Duration::from_secs(5))
    }
    #[cfg(not(unix))]
    {
        let _ = mode;
        std::fs::write(path, contents)
    }
}

#[cfg(unix)]
mod unix {
    use std::fs::{File, Permissions, TryLockError};
    use std::io::{self, Write};
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    use std::time::{Duration, Instant};

    pub(super) fn write_locked(path: &Path, contents: &[u8], mode: u32) -> io::Result<File> {
        let mut writer = File::create(path)?;
        writer.write_all(contents)?;
        writer.set_permissions(Permissions::from_mode(mode))?;
        // A fork during creation or writing shares the descriptor and this lock.
        // See https://github.com/rust-lang/rust/issues/114554.
        writer.lock()?;
        Ok(writer)
    }

    pub(super) fn wait_until_ready(path: &Path, timeout: Duration) -> io::Result<()> {
        let reader = File::open(path)?;
        let deadline = Instant::now() + timeout;
        loop {
            match reader.try_lock() {
                Ok(()) => return Ok(()),
                Err(TryLockError::WouldBlock) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(1));
                }
                Err(TryLockError::WouldBlock) => {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        format!(
                            "Executable fixture still has a writable descriptor: {}",
                            path.display()
                        ),
                    ));
                }
                Err(TryLockError::Error(error))
                    if error.kind() == io::ErrorKind::Interrupted && Instant::now() < deadline => {}
                Err(TryLockError::Error(error)) => return Err(error),
            }
        }
    }
}

#[cfg(unix)]
mod tests {
    use super::*;
    use std::fs::{File, TryLockError};
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn readiness_waits_for_the_last_duplicated_writable_descriptor() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("fixture");
        let writer = unix::write_locked(&path, b"#!/bin/sh\necho ready\n", 0o755).unwrap();
        // try_clone shares the open file description, as an inherited fork FD does.
        let duplicate = writer.try_clone().unwrap();
        drop(writer);
        assert!(matches!(
            File::open(&path).unwrap().try_lock(),
            Err(TryLockError::WouldBlock)
        ));
        let (started_tx, started_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let worker_path = path.clone();
        let worker = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            done_tx
                .send(unix::wait_until_ready(&worker_path, Duration::from_secs(5)))
                .unwrap();
        });
        started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(matches!(
            done_rx.recv_timeout(Duration::from_millis(40)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        drop(duplicate);
        done_rx
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap();
        worker.join().unwrap();
        let output = Command::new(&path).output().unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"ready\n");
    }

    #[test]
    fn persistent_writable_descriptor_has_a_bounded_readiness_error() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("fixture");
        let writer = unix::write_locked(&path, b"#!/bin/sh\nexit 0\n", 0o700).unwrap();
        let error = unix::wait_until_ready(&path, Duration::from_millis(10)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(error
            .to_string()
            .contains("Executable fixture still has a writable descriptor"));
        drop(writer);
    }

    #[test]
    fn published_fixture_preserves_bytes_modes_and_direct_execution() {
        let tmp = tempfile::tempdir().unwrap();
        let script = b"#!/bin/sh\nprintf '%s' fixture-output\nexit 7\n";
        for mode in [0o700, 0o755] {
            let path = tmp.path().join(format!("fixture-{mode:o}"));
            write_executable_fixture(&path, script, mode).unwrap();
            assert_eq!(std::fs::read(&path).unwrap(), script);
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                mode
            );
            let output = Command::new(&path).output().unwrap();
            assert_eq!(output.status.code(), Some(7));
            assert_eq!(output.stdout, b"fixture-output");
        }
    }
}
