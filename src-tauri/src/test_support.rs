//! Executable fixtures shared by unit tests; never part of production builds.

use std::io;
use std::path::Path;

/// Synthetic worker keys use rooted paths without touching the filesystem.
/// Windows additionally requires a drive prefix for such a path to be absolute.
pub(crate) fn absolute_hook_path(path: &Path) -> std::path::PathBuf {
    #[cfg(windows)]
    if path.has_root() && !path.is_absolute() {
        return Path::new(env!("CARGO_MANIFEST_DIR")).join(path);
    }
    path.to_path_buf()
}

/// Git parses a verbatim `\\?\C:\...` path as an scp-style `host:path` SSH
/// remote. Fixture remotes are local, so drop the prefix git cannot read.
pub(crate) fn git_local_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    #[cfg(windows)]
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        if !rest.starts_with(r"UNC\") {
            return rest.to_string();
        }
    }
    text.into_owned()
}

pub(crate) fn symlink_dir(target: impl AsRef<Path>, link: impl AsRef<Path>) -> io::Result<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link)
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_dir(target, link)
    }
}

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
    #[cfg(windows)]
    {
        let _ = mode;
        windows::write_launched(path.as_ref(), contents.as_ref())
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = mode;
        std::fs::write(path, contents)
    }
}

/// The POSIX shell for fixtures that run a shell line directly.
pub(crate) fn posix_shell() -> String {
    #[cfg(windows)]
    {
        windows::tool("sh.exe")
    }
    #[cfg(not(windows))]
    {
        "/bin/sh".to_string()
    }
}

/// Windows cannot execute a `#!` script. The fixture keeps its script at
/// `path` and gains `path.exe`, which `Command::new(path)` and PATH lookup
/// resolve first: a dependency-free launcher that runs the sibling script under
/// its shebang interpreter (Git for Windows `sh`/`bash`, or `node`).
#[cfg(windows)]
mod windows {
    use std::io;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::OnceLock;

    const LAUNCHER: &str = r##"
use std::process::{exit, Command};
fn fail(message: &str) -> ! {
    eprintln!("fixture launcher: {message}");
    exit(127)
}
fn quote(arg: &str) -> String {
    let mut out = String::from("\"");
    let mut slashes = 0;
    for ch in arg.chars() {
        match ch {
            '\\' => slashes += 1,
            '"' => {
                out.push_str(&"\\".repeat(slashes * 2 + 1));
                out.push('"');
                slashes = 0;
            }
            _ => {
                out.push_str(&"\\".repeat(slashes));
                out.push(ch);
                slashes = 0;
            }
        }
    }
    out.push_str(&"\\".repeat(slashes * 2));
    out.push('"');
    out
}
fn main() {
    let exe = std::env::current_exe().unwrap_or_else(|err| fail(&err.to_string()));
    let exe = exe.to_string_lossy();
    let script = exe[..exe.len() - 4].replace('\\', "/");
    let bytes = std::fs::read(&script).unwrap_or_else(|err| fail(&format!("{script}: {err}")));
    let first = bytes.split(|byte| *byte == b'\n').next().unwrap_or(&[]);
    let line = String::from_utf8_lossy(first).trim().to_string();
    let mut words: Vec<&str> = line.strip_prefix("#!").unwrap_or("/bin/sh").split_whitespace().collect();
    if words.first() == Some(&"/usr/bin/env") {
        words.remove(0);
    }
    let name = words.first().map(|word| word.rsplit('/').next().unwrap()).unwrap_or("sh");
    let program = match name {
        "sh" => SH,
        "bash" => BASH,
        "node" => NODE,
        other => other,
    };
    let mut command = Command::new(program);
    if !TOOLS.is_empty() {
        let path = std::env::var_os("PATH").unwrap_or_default();
        let mut dirs: Vec<_> = std::env::split_paths(&path).collect();
        if !dirs.iter().any(|dir| dir == std::path::Path::new(TOOLS)) {
            dirs.push(TOOLS.into());
            command.env("PATH", std::env::join_paths(dirs).unwrap());
        }
    }
    // MSYS globs and unescapes unquoted words, so every argument is quoted.
    // MSYS also cannot open verbatim `\\?\C:\` paths; the drive form is equal.
    use std::os::windows::process::CommandExt;
    let args = std::env::args_os().skip(1).map(|arg| {
        let arg = arg.to_string_lossy().into_owned();
        match arg.strip_prefix(r"\\?\") {
            Some(rest) if !rest.starts_with(r"UNC\") => rest.to_string(),
            _ => arg,
        }
    });
    for arg in words.iter().skip(1).map(|word| word.to_string()).chain([script.clone()]).chain(args) {
        command.raw_arg(quote(&arg));
    }
    let status = command
        .status()
        .unwrap_or_else(|err| fail(&format!("{program}: {err}")));
    exit(status.code().unwrap_or(1))
}
"##;

    pub(super) fn write_launched(path: &Path, contents: &[u8]) -> io::Result<()> {
        let text = path.to_string_lossy();
        let (script, shim) = if text.to_ascii_lowercase().ends_with(".exe") {
            (PathBuf::from(&text[..text.len() - 4]), path.to_path_buf())
        } else {
            (path.to_path_buf(), PathBuf::from(format!("{text}.exe")))
        };
        std::fs::write(&script, portable_script(contents))?;
        // A rewrite keeps the launcher; only the script bytes change.
        if !shim.exists() {
            std::fs::copy(launcher()?, &shim)?;
        }
        Ok(())
    }

    /// MSYS `sh` reads an unquoted `\` as an escape, so absolute Windows paths
    /// interpolated into a script use `/`, which both Windows and MSYS accept.
    fn portable_script(contents: &[u8]) -> Vec<u8> {
        if !contents.starts_with(b"#!") {
            return contents.to_vec();
        }
        let mut out = Vec::with_capacity(contents.len());
        let mut index = 0;
        while index < contents.len() {
            let rest = &contents[index..];
            let boundary = index == 0 || !contents[index - 1].is_ascii_alphanumeric();
            let verbatim = rest.starts_with(br"\\?\");
            let start = if verbatim { 4 } else { 0 };
            let drive = rest.len() > start + 2
                && rest[start].is_ascii_alphabetic()
                && rest[start + 1] == b':'
                && rest[start + 2] == b'\\';
            if boundary && drive {
                index += start;
                while index < contents.len() && !b" \t\r\n'\"`;|&<>()".contains(&contents[index]) {
                    out.push(match contents[index] {
                        b'\\' => b'/',
                        byte => byte,
                    });
                    index += 1;
                }
                continue;
            }
            out.push(contents[index]);
            index += 1;
        }
        out
    }

    fn launcher() -> io::Result<&'static Path> {
        static LAUNCHER_EXE: OnceLock<Result<PathBuf, String>> = OnceLock::new();
        LAUNCHER_EXE
            .get_or_init(build_launcher)
            .as_deref()
            .map_err(|err| io::Error::other(err.clone()))
    }

    /// A Git for Windows MSYS tool, else the first one on PATH.
    pub(super) fn tool(name: &str) -> String {
        static GIT_ROOT: OnceLock<Option<PathBuf>> = OnceLock::new();
        GIT_ROOT
            .get_or_init(git_root)
            .as_ref()
            .map(|root| root.join("usr/bin").join(name))
            .filter(|path| path.is_file())
            .or_else(|| find_on_path(name))
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_else(|| name.to_string())
    }

    fn build_launcher() -> Result<PathBuf, String> {
        use std::hash::{Hash, Hasher};
        let sh = tool("sh.exe");
        let tools = Path::new(&sh)
            .parent()
            .filter(|dir| dir.join("cat.exe").is_file())
            .map(|dir| dir.to_string_lossy().into_owned())
            .unwrap_or_default();
        let source = format!(
            "const SH: &str = {sh:?};\nconst BASH: &str = {:?};\nconst NODE: &str = {:?};\nconst TOOLS: &str = {tools:?};\n{LAUNCHER}",
            tool("bash.exe"),
            find_on_path("node.exe")
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_else(|| "node".to_string()),
        );
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        source.hash(&mut hasher);
        let dir =
            std::env::temp_dir().join(format!("maru-fixture-launcher-{:016x}", hasher.finish()));
        let exe = dir.join("launcher.exe");
        if exe.is_file() {
            return Ok(exe);
        }
        // Concurrent test processes each build privately, then publish by rename.
        let staging = dir.join(format!("build-{}", std::process::id()));
        std::fs::create_dir_all(&staging).map_err(|err| err.to_string())?;
        std::fs::write(staging.join("launcher.rs"), &source).map_err(|err| err.to_string())?;
        let rustc = std::env::var_os("CARGO")
            .map(|cargo| PathBuf::from(cargo).with_file_name("rustc.exe"))
            .filter(|rustc| rustc.is_file())
            .unwrap_or_else(|| PathBuf::from("rustc"));
        let output = Command::new(rustc)
            .args(["--edition", "2021", "-o"])
            .arg(staging.join("launcher.exe"))
            .arg(staging.join("launcher.rs"))
            .output()
            .map_err(|err| format!("Cannot build fixture launcher: {err}"))?;
        if !output.status.success() {
            return Err(format!(
                "Cannot build fixture launcher: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        if std::fs::rename(staging.join("launcher.exe"), &exe).is_err() && !exe.is_file() {
            return Err("Cannot publish fixture launcher".to_string());
        }
        let _ = std::fs::remove_dir_all(&staging);
        Ok(exe)
    }

    /// `git --exec-path` is `<root>/mingw64/libexec/git-core` for Git for Windows.
    fn git_root() -> Option<PathBuf> {
        let output = Command::new("git").arg("--exec-path").output().ok()?;
        let exec = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
        exec.ancestors().nth(3).map(Path::to_path_buf)
    }

    fn find_on_path(name: &str) -> Option<PathBuf> {
        std::env::split_paths(&std::env::var_os("PATH")?)
            .map(|dir| dir.join(name))
            .find(|path| path.is_file())
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
