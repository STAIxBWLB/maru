use std::io::{self, Read};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::thread;
use std::time::{Duration, Instant};

use crate::win_process::NoWindow;

const OUTPUT_RETAINED_BYTES: usize = 64 * 1024;
const OUTPUT_CHANNEL_CAPACITY: usize = 32;
const MAX_DRAIN_EVENTS_PER_TICK: usize = 8;
const READER_SETTLE_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Copy)]
pub(crate) struct OutputLimits {
    pub stdout_bytes: usize,
    pub stderr_bytes: usize,
}

impl OutputLimits {
    pub(crate) const fn new(stdout_bytes: usize, stderr_bytes: usize) -> Self {
        Self {
            stdout_bytes,
            stderr_bytes,
        }
    }
}

const DEFAULT_OUTPUT_LIMITS: OutputLimits =
    OutputLimits::new(OUTPUT_RETAINED_BYTES, OUTPUT_RETAINED_BYTES);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CommandTermination {
    Exited,
    TimedOut,
    Aborted,
}

#[derive(Debug)]
pub(crate) struct BoundedOutput {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub termination: CommandTermination,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

impl BoundedOutput {
    pub(crate) fn diagnostic_tail(&self, max_bytes: usize) -> Option<String> {
        let mut parts = Vec::new();
        if !self.stderr.is_empty() {
            parts.push(String::from_utf8_lossy(&self.stderr).trim().to_string());
        }
        if !self.stdout.is_empty() {
            parts.push(String::from_utf8_lossy(&self.stdout).trim().to_string());
        }
        let detail = parts
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        if detail.is_empty() {
            return None;
        }

        let mut normalized = detail
            .chars()
            .map(|character| {
                if character == '\n' || character == '\t' || !character.is_control() {
                    character
                } else {
                    ' '
                }
            })
            .collect::<String>();
        let output_was_truncated =
            self.stdout_truncated || self.stderr_truncated || normalized.len() > max_bytes;
        if normalized.len() > max_bytes {
            let mut start = normalized.len() - max_bytes;
            while !normalized.is_char_boundary(start) {
                start += 1;
            }
            normalized = normalized[start..].to_string();
        }
        if output_was_truncated {
            normalized.insert_str(0, "[... output truncated ...]\n");
        }
        Some(normalized)
    }

    pub(crate) fn safe_diagnostic_tail(&self, max_bytes: usize) -> Option<String> {
        // Once a stream is truncated, a credential marker may have been evicted
        // while its value remains in the retained tail. Do not expose partial
        // diagnostics whose full sensitivity can no longer be determined.
        if self.stdout_truncated || self.stderr_truncated {
            return None;
        }
        let retained_output_is_sensitive = [&self.stderr, &self.stdout]
            .into_iter()
            .any(|bytes| diagnostic_contains_sensitive_value(&String::from_utf8_lossy(bytes)));
        if retained_output_is_sensitive {
            return None;
        }
        self.diagnostic_tail(max_bytes)
    }
}

pub(crate) fn diagnostic_contains_sensitive_value(detail: &str) -> bool {
    let lower = detail.to_lowercase();
    [
        "authorization:",
        "bearer ",
        "access_token",
        "accesstoken",
        "refresh_token",
        "refreshtoken",
        "id_token",
        "idtoken",
        "client_secret",
        "clientsecret",
        "password",
        "cookie",
        "session_string",
        "session string",
        "sessionstring",
        "api_hash",
        "apihash",
        "microsoft.com/device",
        "enter the code",
        "use the code",
        "user_code",
        "usercode",
        "verification_uri",
        "verificationuri",
    ]
    .into_iter()
    .any(|marker| lower.contains(marker))
}

#[derive(Clone, Copy, Debug)]
enum OutputStream {
    Stdout,
    Stderr,
}

enum OutputEvent {
    Data(OutputStream, Vec<u8>),
    Done(OutputStream, Option<io::Error>),
}

struct TailBuffer {
    bytes: Vec<u8>,
    truncated: bool,
    limit: usize,
}

impl TailBuffer {
    fn new(limit: usize) -> Self {
        Self {
            bytes: Vec::new(),
            truncated: false,
            limit: limit.max(1),
        }
    }

    fn append(&mut self, chunk: &[u8]) {
        if chunk.len() >= self.limit {
            self.bytes.clear();
            self.bytes
                .extend_from_slice(&chunk[chunk.len() - self.limit..]);
            self.truncated = true;
            return;
        }

        let overflow = self
            .bytes
            .len()
            .saturating_add(chunk.len())
            .saturating_sub(self.limit);
        if overflow > 0 {
            self.bytes.drain(..overflow);
            self.truncated = true;
        }
        self.bytes.extend_from_slice(chunk);
    }
}

struct CapturedOutput {
    stdout: TailBuffer,
    stderr: TailBuffer,
    stdout_done: bool,
    stderr_done: bool,
    read_error: Option<io::Error>,
}

impl CapturedOutput {
    fn new(limits: OutputLimits) -> Self {
        Self {
            stdout: TailBuffer::new(limits.stdout_bytes),
            stderr: TailBuffer::new(limits.stderr_bytes),
            stdout_done: false,
            stderr_done: false,
            read_error: None,
        }
    }

    fn readers_done(&self) -> bool {
        self.stdout_done && self.stderr_done
    }
}

/// Run a child process without exposing the parent stdin, continuously drain
/// both output pipes, and terminate the spawned process tree when the deadline
/// or an output-based abort condition is reached.
pub(crate) fn run_command_with_timeout<F>(
    command: &mut Command,
    timeout: Duration,
    abort_when: F,
) -> io::Result<BoundedOutput>
where
    F: Fn(&[u8], &[u8]) -> bool,
{
    run_command_with_timeout_and_limits(command, timeout, DEFAULT_OUTPUT_LIMITS, abort_when)
}

pub(crate) fn run_command_with_timeout_and_limits<F>(
    command: &mut Command,
    timeout: Duration,
    limits: OutputLimits,
    abort_when: F,
) -> io::Result<BoundedOutput>
where
    F: Fn(&[u8], &[u8]) -> bool,
{
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .no_window();
    configure_process_tree(command);

    let mut child = command.spawn()?;
    let process_tree = ProcessTree::attach(&mut child)?;
    let stdout = child
        .stdout
        .take()
        .expect("stdout is piped before spawning");
    let stderr = child
        .stderr
        .take()
        .expect("stderr is piped before spawning");
    let (tx, rx) = mpsc::sync_channel(OUTPUT_CHANNEL_CAPACITY);
    let stdout_reader = spawn_output_reader(stdout, OutputStream::Stdout, tx.clone());
    let stderr_reader = spawn_output_reader(stderr, OutputStream::Stderr, tx);

    let deadline = Instant::now() + timeout;
    let mut captured = CapturedOutput::new(limits);
    let mut child_status = None;
    let process_result = loop {
        let abort_requested = drain_output(&rx, &mut captured, &abort_when);

        if abort_requested {
            break terminate_tree_and_reap(&mut child, &process_tree, child_status)
                .map(|status| (status, CommandTermination::Aborted));
        }
        if let Some(err) = captured.read_error.take() {
            let _ = terminate_tree_and_reap(&mut child, &process_tree, child_status);
            break Err(err);
        }

        if child_status.is_none() {
            match child.try_wait() {
                Ok(Some(status)) => child_status = Some(status),
                Ok(None) => {}
                Err(err) => {
                    let _ = terminate_tree_and_reap(&mut child, &process_tree, child_status);
                    break Err(err);
                }
            }
        }
        if let Some(status) = child_status.filter(|_| captured.readers_done()) {
            break Ok((status, CommandTermination::Exited));
        }
        if Instant::now() >= deadline {
            break terminate_tree_and_reap(&mut child, &process_tree, child_status)
                .map(|status| (status, CommandTermination::TimedOut));
        }

        let remaining = deadline.saturating_duration_since(Instant::now());
        thread::sleep(remaining.min(Duration::from_millis(10)));
    };

    let settle_deadline = Instant::now() + READER_SETTLE_TIMEOUT;
    while !captured.readers_done() && Instant::now() < settle_deadline {
        drain_output(&rx, &mut captured, &abort_when);
        if !captured.readers_done() {
            thread::sleep(Duration::from_millis(5));
        }
    }
    drain_output(&rx, &mut captured, &abort_when);
    drop(rx);
    join_finished_reader(stdout_reader, "stdout")?;
    join_finished_reader(stderr_reader, "stderr")?;

    let (status, mut termination) = process_result?;
    if let Some(err) = captured.read_error {
        return Err(err);
    }
    if termination == CommandTermination::Exited
        && abort_when(&captured.stdout.bytes, &captured.stderr.bytes)
    {
        termination = CommandTermination::Aborted;
    }

    Ok(BoundedOutput {
        status,
        stdout: captured.stdout.bytes,
        stderr: captured.stderr.bytes,
        termination,
        stdout_truncated: captured.stdout.truncated,
        stderr_truncated: captured.stderr.truncated,
    })
}

fn spawn_output_reader<R>(
    mut reader: R,
    stream: OutputStream,
    tx: SyncSender<OutputEvent>,
) -> thread::JoinHandle<()>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        let read_error = loop {
            match reader.read(&mut buffer) {
                Ok(0) => break None,
                Ok(read) => {
                    if tx
                        .send(OutputEvent::Data(stream, buffer[..read].to_vec()))
                        .is_err()
                    {
                        return;
                    }
                }
                Err(err) => break Some(err),
            }
        };
        let _ = tx.send(OutputEvent::Done(stream, read_error));
    })
}

fn drain_output<F>(
    rx: &Receiver<OutputEvent>,
    captured: &mut CapturedOutput,
    abort_when: &F,
) -> bool
where
    F: Fn(&[u8], &[u8]) -> bool,
{
    let mut abort_requested = false;
    for _ in 0..MAX_DRAIN_EVENTS_PER_TICK {
        let Ok(event) = rx.try_recv() else {
            break;
        };
        match event {
            OutputEvent::Data(OutputStream::Stdout, chunk) => captured.stdout.append(&chunk),
            OutputEvent::Data(OutputStream::Stderr, chunk) => captured.stderr.append(&chunk),
            OutputEvent::Done(OutputStream::Stdout, error) => {
                captured.stdout_done = true;
                if captured.read_error.is_none() {
                    captured.read_error = error;
                }
            }
            OutputEvent::Done(OutputStream::Stderr, error) => {
                captured.stderr_done = true;
                if captured.read_error.is_none() {
                    captured.read_error = error;
                }
            }
        }
        if abort_when(&captured.stdout.bytes, &captured.stderr.bytes) {
            abort_requested = true;
            break;
        }
    }
    abort_requested
}

fn join_finished_reader(reader: thread::JoinHandle<()>, stream: &str) -> io::Result<()> {
    if !reader.is_finished() {
        return Ok(());
    }
    reader
        .join()
        .map_err(|_| io::Error::other(format!("{stream} reader thread panicked")))
}

#[cfg(unix)]
fn configure_process_tree(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    command.process_group(0);
}

#[cfg(not(unix))]
fn configure_process_tree(_command: &mut Command) {}

struct ProcessTree {
    #[cfg(unix)]
    process_group_id: u32,
    #[cfg(windows)]
    job: windows_job::Job,
}

impl ProcessTree {
    fn attach(child: &mut std::process::Child) -> io::Result<Self> {
        #[cfg(windows)]
        {
            return windows_job::Job::assign(child)
                .map(|job| Self { job })
                .map_err(|job_error| cleanup_after_attach_failure(child, job_error));
        }

        #[cfg(unix)]
        {
            Ok(Self {
                process_group_id: child.id(),
            })
        }

        #[cfg(not(any(unix, windows)))]
        {
            let _ = child;
            Ok(Self {})
        }
    }

    fn terminate(&self, child: &mut std::process::Child) -> io::Result<()> {
        #[cfg(windows)]
        {
            let _ = child;
            return self.job.terminate();
        }

        #[cfg(unix)]
        {
            return terminate_unix_process_group(child, self.process_group_id);
        }

        #[cfg(not(any(unix, windows)))]
        {
            child.kill()
        }
    }
}

#[cfg(windows)]
fn cleanup_after_attach_failure(
    child: &mut std::process::Child,
    job_error: io::Error,
) -> io::Error {
    let cleanup_error = match child.try_wait() {
        Ok(Some(_)) => None,
        Ok(None) => match child.kill() {
            Ok(()) => child.wait().err(),
            Err(kill_error) => match child.try_wait() {
                Ok(Some(_)) => None,
                Ok(None) | Err(_) => Some(kill_error),
            },
        },
        Err(wait_error) => Some(wait_error),
    };

    let context = match cleanup_error {
        Some(cleanup_error) => {
            format!("{job_error}; additionally failed to kill and reap child: {cleanup_error}")
        }
        None => job_error.to_string(),
    };
    io::Error::new(
        job_error.kind(),
        format!(
            "failed to attach child process to Windows Job Object: {context} \
             (a host job object without nesting/breakaway can cause AssignProcessToJobObject to fail)"
        ),
    )
}

fn terminate_tree_and_reap(
    child: &mut std::process::Child,
    process_tree: &ProcessTree,
    known_status: Option<ExitStatus>,
) -> io::Result<ExitStatus> {
    let tree_kill_error = process_tree.terminate(child).err();
    if let Some(status) = known_status {
        return match tree_kill_error {
            Some(err) if !tree_kill_error_is_ignorable(&err) => Err(err),
            _ => Ok(status),
        };
    }

    let reap_deadline = Instant::now() + READER_SETTLE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return match tree_kill_error {
                    Some(err) if !tree_kill_error_is_ignorable(&err) => Err(err),
                    _ => Ok(status),
                };
            }
            Ok(None) if Instant::now() < reap_deadline => {
                thread::sleep(Duration::from_millis(5));
            }
            Ok(None) => {
                return Err(tree_kill_error.unwrap_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::TimedOut,
                        "timed out while reaping terminated child",
                    )
                }));
            }
            Err(wait_error) => return Err(tree_kill_error.unwrap_or(wait_error)),
        }
    }
}

fn tree_kill_error_is_ignorable(error: &io::Error) -> bool {
    #[cfg(unix)]
    {
        return process_not_found(error);
    }

    #[cfg(not(unix))]
    {
        let _ = error;
        false
    }
}

#[cfg(unix)]
fn terminate_unix_process_group(
    child: &mut std::process::Child,
    process_group_id: u32,
) -> io::Result<()> {
    const SIGKILL: i32 = 9;

    extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }

    let process_group = i32::try_from(process_group_id)
        .map_err(|_| io::Error::other("child process id exceeds i32"))?;
    let result = unsafe { kill(-process_group, SIGKILL) };
    if result == 0 {
        return Ok(());
    }
    let group_error = io::Error::last_os_error();
    if process_not_found(&group_error) {
        return match child.try_wait()? {
            Some(_) => Ok(()),
            None => child.kill(),
        };
    }
    let _ = child.kill();
    Err(group_error)
}

#[cfg(windows)]
mod windows_job {
    use std::ffi::c_void;
    use std::io;
    use std::mem::{size_of, zeroed};
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use std::ptr;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub(super) struct Job {
        handle: HANDLE,
    }

    impl Job {
        pub(super) fn assign(child: &Child) -> io::Result<Self> {
            // SAFETY: A null security descriptor and name request an unnamed job
            // with default security. The returned owned handle is closed by Drop.
            let handle = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            let job = Self { handle };

            // SAFETY: The zeroed Windows SDK structure is fully initialized for
            // this information class, and SetInformationJobObject reads exactly
            // the supplied structure size during the call.
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = unsafe {
                SetInformationJobObject(
                    job.handle,
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast::<c_void>(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if configured == 0 {
                return Err(io::Error::last_os_error());
            }

            // Windows 8 and later support nested jobs. If the host's existing
            // job restrictions are incompatible, assignment fails; the caller
            // then kills and reaps the child instead of running it unbounded.
            let process_handle = child.as_raw_handle() as HANDLE;
            // SAFETY: Both handles remain valid for the duration of this call.
            if unsafe { AssignProcessToJobObject(job.handle, process_handle) } == 0 {
                return Err(io::Error::last_os_error());
            }

            Ok(job)
        }

        pub(super) fn terminate(&self) -> io::Result<()> {
            // SAFETY: The job handle is owned by self and remains open. This
            // terminates every process still assigned even if the direct child
            // has already exited.
            if unsafe { TerminateJobObject(self.handle, 1) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE makes this a final safety net
            // for normal returns and early errors.
            // SAFETY: handle was returned by CreateJobObjectW and is closed once.
            unsafe {
                CloseHandle(self.handle);
            }
        }
    }
}

#[cfg(unix)]
fn process_not_found(error: &io::Error) -> bool {
    error.raw_os_error() == Some(3)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn captures_both_streams() {
        let mut command = Command::new("sh");
        command.args(["-c", "printf stdout; printf stderr >&2"]);

        let output =
            run_command_with_timeout(&mut command, Duration::from_secs(1), |_, _| false).unwrap();

        assert_eq!(output.termination, CommandTermination::Exited);
        assert!(output.status.success());
        assert_eq!(output.stdout, b"stdout");
        assert_eq!(output.stderr, b"stderr");
        assert!(!output.stdout_truncated);
        assert!(!output.stderr_truncated);
    }

    #[cfg(unix)]
    #[test]
    fn safe_diagnostic_tail_suppresses_secret_bearing_output() {
        let mut command = Command::new("sh");
        command.args([
            "-c",
            "printf 'client_secret=do-not-expose'; printf 'network unavailable' >&2",
        ]);

        let output =
            run_command_with_timeout(&mut command, Duration::from_secs(1), |_, _| false).unwrap();

        assert!(output.diagnostic_tail(1024).is_some());
        assert!(output.safe_diagnostic_tail(1024).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn safe_diagnostic_scans_retained_output_before_display_truncation() {
        let mut command = Command::new("sh");
        command.args([
            "-c",
            "printf 'clientSecret='; i=0; while [ \"$i\" -lt 256 ]; do printf x; i=$((i + 1)); done; printf 'TRAILING-SECRET'",
        ]);

        let output =
            run_command_with_timeout(&mut command, Duration::from_secs(1), |_, _| false).unwrap();
        let display_tail = output.diagnostic_tail(64).unwrap();

        assert!(!display_tail.to_lowercase().contains("clientsecret"));
        assert!(display_tail.contains("TRAILING-SECRET"));
        assert!(output.safe_diagnostic_tail(64).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn safe_diagnostic_suppresses_truncated_tail_after_marker_eviction() {
        let mut command = Command::new("sh");
        command.args([
            "-c",
            "printf 'clientSecret='; i=0; while [ \"$i\" -lt 256 ]; do printf S; i=$((i + 1)); done",
        ]);

        let output = run_command_with_timeout_and_limits(
            &mut command,
            Duration::from_secs(1),
            OutputLimits::new(64, 64),
            |_, _| false,
        )
        .unwrap();

        assert!(output.stdout_truncated);
        assert!(!String::from_utf8_lossy(&output.stdout)
            .to_lowercase()
            .contains("clientsecret"));
        assert!(output.diagnostic_tail(64).is_some());
        assert!(output.safe_diagnostic_tail(64).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn configurable_stream_limits_preserve_each_tail() {
        let mut command = Command::new("sh");
        command.args(["-c", "printf '0123456789abcdef'; printf 'abcdefghij' >&2"]);

        let output = run_command_with_timeout_and_limits(
            &mut command,
            Duration::from_secs(1),
            OutputLimits::new(8, 4),
            |_, _| false,
        )
        .unwrap();

        assert_eq!(output.stdout, b"89abcdef");
        assert_eq!(output.stderr, b"ghij");
        assert!(output.stdout_truncated);
        assert!(output.stderr_truncated);
    }

    #[cfg(unix)]
    #[test]
    fn timeout_kills_and_reaps_the_child() {
        let mut command = Command::new("sh");
        command.args(["-c", "printf '%s' \"$$\"; while :; do :; done"]);

        let output =
            run_command_with_timeout(&mut command, Duration::from_millis(100), |_, _| false)
                .unwrap();

        assert_eq!(output.termination, CommandTermination::TimedOut);
        let pid = String::from_utf8(output.stdout).unwrap();
        let status = Command::new("kill")
            .args(["-0", pid.trim()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(!status.success(), "timed-out child {pid} is still running");
    }

    #[cfg(unix)]
    #[test]
    fn timeout_kills_orphaned_descendant_that_inherits_output_pipes() {
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 60 & printf '%s' \"$!\""]);
        let started = Instant::now();

        let output =
            run_command_with_timeout(&mut command, Duration::from_millis(100), |_, _| false)
                .unwrap();

        assert_eq!(output.termination, CommandTermination::TimedOut);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "inherited output pipes kept readers blocked for {:?}",
            started.elapsed()
        );
        let pid = String::from_utf8(output.stdout).unwrap();
        let gone_deadline = Instant::now() + Duration::from_secs(1);
        loop {
            let status = Command::new("kill")
                .args(["-0", pid.trim()])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap();
            if !status.success() {
                break;
            }
            assert!(
                Instant::now() < gone_deadline,
                "timed-out descendant {pid} is still running"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[cfg(windows)]
    #[test]
    fn timeout_kills_descendant_after_direct_parent_exits() {
        use windows_sys::Win32::Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, WAIT_OBJECT_0};
        use windows_sys::Win32::System::Threading::{
            OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
        };

        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$child = Start-Process powershell.exe -ArgumentList '-NoLogo','-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 60' -NoNewWindow -PassThru; [Console]::Out.Write($child.Id); Start-Sleep -Milliseconds 200",
        ]);
        let started = Instant::now();

        let output =
            run_command_with_timeout(&mut command, Duration::from_millis(500), |_, _| false)
                .unwrap();

        assert_eq!(output.termination, CommandTermination::TimedOut);
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "inherited output pipes kept readers blocked for {:?}",
            started.elapsed()
        );
        let pid = String::from_utf8(output.stdout)
            .unwrap()
            .trim()
            .parse::<u32>()
            .unwrap();

        // SAFETY: OpenProcess returns an owned handle, which is closed below.
        let process = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        if process.is_null() {
            let error = io::Error::last_os_error();
            assert_eq!(
                error.raw_os_error(),
                Some(ERROR_INVALID_PARAMETER as i32),
                "could not verify terminated descendant {pid}: {error}"
            );
            return;
        }

        // SAFETY: process is a live process handle with synchronization access.
        let wait_result = unsafe { WaitForSingleObject(process, 1_000) };
        // SAFETY: process is owned by this test and has not been closed.
        unsafe {
            CloseHandle(process);
        }
        assert_eq!(
            wait_result, WAIT_OBJECT_0,
            "timed-out descendant {pid} is still running"
        );
    }

    #[cfg(unix)]
    #[test]
    fn chatty_process_stays_bounded_and_observes_timeout() {
        let mut command = Command::new("sh");
        command.args([
            "-c",
            "while :; do printf '0123456789abcdef0123456789abcdef'; printf 'stderr-line\\n' >&2; done",
        ]);
        let started = Instant::now();

        let output =
            run_command_with_timeout(&mut command, Duration::from_millis(100), |_, _| false)
                .unwrap();

        assert_eq!(output.termination, CommandTermination::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(output.stdout.len() <= OUTPUT_RETAINED_BYTES);
        assert!(output.stderr.len() <= OUTPUT_RETAINED_BYTES);
        assert!(output.stdout_truncated || output.stderr_truncated);
        assert!(output
            .diagnostic_tail(1024)
            .is_some_and(|detail| detail.len() <= 1100));
    }

    #[cfg(unix)]
    #[test]
    fn output_predicate_aborts_before_timeout() {
        let mut command = Command::new("sh");
        command.args([
            "-c",
            "printf 'Open https://microsoft.com/devicelogin and enter the code'; while :; do :; done",
        ]);
        let started = Instant::now();

        let output =
            run_command_with_timeout(&mut command, Duration::from_secs(5), |stdout, stderr| {
                [stdout, stderr].into_iter().any(|bytes| {
                    String::from_utf8_lossy(bytes).contains("microsoft.com/devicelogin")
                })
            })
            .unwrap();

        assert_eq!(output.termination, CommandTermination::Aborted);
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
