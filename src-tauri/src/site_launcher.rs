//! Optional local console launch: fixed argv, trusted Bun install, bounded
//! readiness, and a ticket-free direct loopback probe before native navigation.
use crate::command_output::{configure_process_tree, terminate_tree_and_reap, ProcessTree};
use crate::skill_host::fs as host_fs;
use crate::win_process::NoWindow;
use serde::Deserialize;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    mpsc,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::Url;

pub(crate) const ACON_LAUNCH: &str = "acon ui --no-open --json";
const MAX_JSON: usize = 32 * 1024;
const READY_TIMEOUT: Duration = Duration::from_secs(10);
static LIVE: AtomicUsize = AtomicUsize::new(0);

fn failure(operation: &str, error: impl std::fmt::Display) -> String {
    format!("site_launch_failed: {operation}: {error}; run `acon ui --no-open --json` in a terminal to inspect the console, or reinstall with `bun add -g @staix/agent-console`; a manual URL site remains available")
}

pub(crate) fn validate_launch(value: &str) -> Result<(), String> {
    match value.trim() {
        ACON_LAUNCH | "acon ui --json" => Ok(()),
        _ => Err("site_launch_not_allowed: use the Agent Console launch option (acon ui --no-open --json), or disable launch and enter an HTTP(S) URL; shell text, custom executables and extra arguments are refused".into()),
    }
}

struct TrustedConsole {
    bun: PathBuf,
    entry: PathBuf,
    home: PathBuf,
}

fn read_small(path: &Path) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path)
        .map_err(|error| failure(&format!("read {}", path.display()), error))?;
    let mut bytes = Vec::new();
    file.take((64 * 1024 + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| failure(&format!("read {}", path.display()), error))?;
    if bytes.len() > 64 * 1024 {
        return Err(failure(
            "validate installed package metadata",
            "package.json exceeds 64 KiB",
        ));
    }
    Ok(bytes)
}

fn verify_permissions(path: &Path, home: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let owner = fs::metadata(home)
            .map_err(|error| failure("identify launch home", error))?
            .uid();
        for current in path.ancestors() {
            let metadata = fs::metadata(current)
                .map_err(|error| failure(&format!("inspect {}", current.display()), error))?;
            if (metadata.uid() != owner && metadata.uid() != 0) || metadata.mode() & 0o022 != 0 {
                return Err(failure("validate trusted executable ownership", format!("{} has an untrusted owner or group/world write permission; fix that installation's permissions", current.display())));
            }
            if current == home {
                break;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (path, home);
    }
    Ok(())
}

fn resolve_console(home: &Path) -> Result<TrustedConsole, String> {
    let home = home
        .canonicalize()
        .map_err(|error| failure("resolve launch home", error))?;
    let bin = home.join(".bun/bin");
    let alias = bin.join(if cfg!(windows) { "acon.exe" } else { "acon" });
    let program = alias
        .canonicalize()
        .map_err(|error| failure(&format!("resolve trusted {}", alias.display()), error))?;
    let global = home
        .join(".bun/install/global/node_modules")
        .canonicalize()
        .map_err(|error| failure("resolve Bun global package root", error))?;
    let package = global
        .join("@staix/agent-console")
        .canonicalize()
        .map_err(|error| failure("resolve installed @staix/agent-console", error))?;
    if !package.starts_with(&global) {
        return Err(failure(
            "validate console package location",
            "package resolves outside the Bun global package root",
        ));
    }
    let metadata: serde_json::Value =
        serde_json::from_slice(&read_small(&package.join("package.json"))?)
            .map_err(|error| failure("parse installed console package.json", error))?;
    if metadata.get("name").and_then(|value| value.as_str()) != Some("@staix/agent-console") {
        return Err(failure(
            "validate console package identity",
            "installed package name is not @staix/agent-console",
        ));
    }
    let entry_name = metadata
        .get("bin")
        .and_then(|value| value.get("acon"))
        .and_then(|value| value.as_str())
        .ok_or_else(|| failure("validate console bin manifest", "missing bin.acon entry"))?;
    let entry = package
        .join(entry_name)
        .canonicalize()
        .map_err(|error| failure("resolve console bin entry", error))?;
    let shim = cfg!(windows) && program == bin.join("acon.exe");
    if !entry.starts_with(&package) || (!shim && program != entry) || !entry.is_file() {
        return Err(failure(
            "validate trusted acon executable",
            "acon does not match the installed package's contained bin entry",
        ));
    }
    let bun = bin
        .join(if cfg!(windows) { "bun.exe" } else { "bun" })
        .canonicalize()
        .map_err(|error| failure("resolve trusted Bun runtime from ~/.bun/bin", error))?;
    if !bun.is_file() {
        return Err(failure("validate Bun runtime", "Bun is not a regular file"));
    }
    verify_permissions(&bin, &home)?;
    verify_permissions(&entry, &home)?;
    verify_permissions(&package.join("package.json"), &home)?;
    verify_permissions(&bun, &home)?;
    Ok(TrustedConsole { bun, entry, home })
}

#[derive(Deserialize)]
struct Readiness {
    url: String,
    origin: String,
    pid: u32,
}

fn parse_readiness(bytes: &[u8], pid: u32) -> Result<Url, String> {
    if bytes.len() > MAX_JSON {
        return Err(failure(
            "read console readiness",
            "JSON response exceeds 32 KiB",
        ));
    }
    let ready: Readiness = serde_json::from_slice(bytes).map_err(|_| {
        failure(
            "parse console readiness",
            "expected one JSON object with url, origin and pid",
        )
    })?;
    let url = Url::parse(&ready.url)
        .map_err(|_| failure("validate console URL", "malformed readiness URL"))?;
    let loopback = url
        .host_str()
        .and_then(|host| {
            host.trim_start_matches('[')
                .trim_end_matches(']')
                .parse::<std::net::IpAddr>()
                .ok()
        })
        .is_some_and(|address| address.is_loopback());
    if url.scheme() != "http"
        || !loopback
        || url.port().is_none_or(|port| port == 0)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(failure("validate console URL", "acon must report an HTTP literal-loopback URL with a non-default port and no credentials"));
    }
    if ready.origin != url.origin().ascii_serialization() || ready.pid != pid {
        return Err(failure(
            "validate console readiness identity",
            "origin or pid does not match the local launched console",
        ));
    }
    Ok(url)
}

struct Permit;
impl Permit {
    fn acquire() -> Result<Self, String> {
        LIVE.fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| (n < 12).then_some(n + 1)).map_err(|_| failure("start console", "12 launched consoles are still running; reuse an existing tab or wait for their idle shutdown"))?;
        Ok(Self)
    }
}
impl Drop for Permit {
    fn drop(&mut self) {
        LIVE.fetch_sub(1, Ordering::AcqRel);
    }
}

struct ConsoleChild {
    child: Child,
    tree: ProcessTree,
    reaped: bool,
    _permit: Permit,
}
impl Drop for ConsoleChild {
    fn drop(&mut self) {
        if !self.reaped {
            let status = self.child.try_wait().ok().flatten();
            let _ = terminate_tree_and_reap(&mut self.child, &self.tree, status);
        }
    }
}

pub(crate) struct LaunchedSite {
    pub url: Url,
    keep: Option<mpsc::Sender<()>>,
    monitor: Option<JoinHandle<()>>,
}
impl LaunchedSite {
    pub(crate) fn keep_alive(mut self) -> Result<(), String> {
        self.keep
            .take()
            .ok_or_else(|| failure("retain console", "launch monitor is unavailable"))?
            .send(())
            .map_err(|_| {
                failure(
                    "retain console",
                    "launch monitor stopped before the navigation handoff",
                )
            })?;
        self.monitor.take();
        Ok(())
    }
}
impl Drop for LaunchedSite {
    fn drop(&mut self) {
        if let Some(keep) = self.keep.take() {
            drop(keep);
            if let Some(monitor) = self.monitor.take() {
                let _ = monitor.join();
            }
        }
    }
}

pub(crate) fn launch_site(launch: &str, cancelled: &AtomicBool) -> Result<LaunchedSite, String> {
    validate_launch(launch)?;
    start_console(
        resolve_console(&host_fs::install_root_base()?)?,
        READY_TIMEOUT,
        cancelled,
    )
}

fn start_console(
    trusted: TrustedConsole,
    timeout: Duration,
    cancelled: &AtomicBool,
) -> Result<LaunchedSite, String> {
    let permit = Permit::acquire()?;
    let mut command = Command::new(&trusted.bun);
    command
        .arg(&trusted.entry)
        .args(["ui", "--no-open", "--json"])
        .current_dir(&trusted.home)
        .env("PATH", crate::cli_path::augmented_path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .no_window();
    #[cfg(any(test, feature = "native-e2e"))]
    command
        .env_remove("BASH_ENV")
        .env_remove("ENV")
        .env("HOME", &trusted.home)
        .env("USERPROFILE", &trusted.home)
        .env("AGENTHUB_HOME", trusted.home.join(".agenthub"));
    configure_process_tree(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| failure(&format!("execute trusted {}", trusted.bun.display()), error))?;
    let tree = ProcessTree::attach(&mut child)
        .map_err(|error| failure("own console process tree", error))?;
    let mut owned = ConsoleChild {
        child,
        tree,
        reaped: false,
        _permit: permit,
    };
    let stdout = owned
        .child
        .stdout
        .take()
        .ok_or_else(|| failure("read console readiness", "stdout pipe unavailable"))?;
    let mut stderr = owned
        .child
        .stderr
        .take()
        .ok_or_else(|| failure("read console diagnostics", "stderr pipe unavailable"))?;
    let (tx, rx) = mpsc::sync_channel(1);
    thread::Builder::new()
        .name("acon-readiness".into())
        .spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = Vec::new();
            let result = reader
                .by_ref()
                .take((MAX_JSON + 1) as u64)
                .read_until(b'\n', &mut line)
                .map(|_| line);
            let _ = tx.send(result);
            let _ = std::io::copy(&mut reader, &mut std::io::sink());
        })
        .map_err(|error| failure("start console output reader", error))?;
    thread::Builder::new()
        .name("acon-diagnostics".into())
        .spawn(move || {
            let _ = std::io::copy(&mut stderr, &mut std::io::sink());
        })
        .map_err(|error| failure("start console diagnostic drain", error))?;
    let deadline = Instant::now() + timeout;
    let bytes = loop {
        if cancelled.load(Ordering::Acquire) {
            return Err("site_open_cancelled: this tab was closed or superseded; open the site again if needed".into());
        }
        if let Some(status) = owned
            .child
            .try_wait()
            .map_err(|error| failure("check console startup", error))?
        {
            return Err(failure(
                "start console",
                format!("process exited with {status} before readiness"),
            ));
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(failure("start console", "readiness deadline expired"));
        }
        match rx.recv_timeout(remaining.min(Duration::from_millis(25))) {
            Ok(result) => {
                break result.map_err(|error| failure("read console readiness", error))?
            }
            Err(mpsc::RecvTimeoutError::Timeout) => (),
            Err(_) => {
                return Err(failure(
                    "read console readiness",
                    "output stream ended without JSON",
                ))
            }
        }
    };
    let url = parse_readiness(&bytes, owned.child.id())?;
    // Never consume the one-time URL/ticket. Probe only the declared origin,
    // without redirects or environment proxies, then recheck process status.
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|error| failure("prepare loopback readiness probe", error))?;
    let response = client
        .get(format!("{}/", url.origin().ascii_serialization()))
        .send()
        .map_err(|_| {
            failure(
                "probe console origin",
                "local console did not answer directly before the readiness deadline",
            )
        })?;
    if !response.status().is_success() {
        return Err(failure(
            "probe console origin",
            format!("local server returned {}", response.status()),
        ));
    }
    if owned
        .child
        .try_wait()
        .map_err(|error| failure("check console handoff", error))?
        .is_some()
    {
        return Err(failure("start console", "process exited before navigation"));
    }
    let (keep, kept) = mpsc::channel();
    let monitor = thread::Builder::new()
        .name("acon-lifetime".into())
        .spawn(move || {
            if kept.recv().is_ok() {
                let _ = owned.child.wait();
                owned.reaped = true;
            }
        })
        .map_err(|error| failure("start console lifetime monitor", error))?;
    Ok(LaunchedSite {
        url,
        keep: Some(keep),
        monitor: Some(monitor),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn readiness(url: &str, origin: &str, pid: u32) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({"url":url,"origin":origin,"pid":pid,"plugins":[]}))
            .unwrap()
    }

    #[test]
    fn only_the_two_declared_console_spellings_are_accepted() {
        for valid in [ACON_LAUNCH, "acon ui --json"] {
            validate_launch(valid).unwrap();
        }
        for bad in [
            "sh -c 'acon ui'",
            "/tmp/acon ui --json",
            "acon ui --json; touch /tmp/x",
            "acon ui --json && echo x",
            "acon ui --json --port 1234",
            "acon serve --json",
            "$(acon ui --json)",
        ] {
            let error = validate_launch(bad).unwrap_err();
            assert!(error.contains("site_launch_not_allowed"), "{error}");
            assert!(error.contains("disable launch"), "{error}");
        }
    }

    #[test]
    fn readiness_is_bounded_literal_loopback_and_bound_to_own_origin_and_pid() {
        parse_readiness(
            &readiness(
                "http://127.0.0.1:43211/#ticket",
                "http://127.0.0.1:43211",
                7,
            ),
            7,
        )
        .unwrap();
        parse_readiness(
            &readiness("http://[::1]:43211/#ticket", "http://[::1]:43211", 7),
            7,
        )
        .unwrap();
        for bad in [
            "https://127.0.0.1:43211/#secret",
            "http://localhost:43211/#secret",
            "http://127.0.0.1.evil:43211/#secret",
            "http://0.0.0.0:43211/#secret",
            "http://192.0.2.1:43211/#secret",
            "http://user:pass@127.0.0.1:43211/#secret",
            "http://127.0.0.1:0/#secret",
            "file:///tmp/secret",
        ] {
            let error =
                parse_readiness(&readiness(bad, "http://127.0.0.1:43211", 7), 7).unwrap_err();
            assert!(
                !error.contains("#secret"),
                "readiness tickets must not reach diagnostics"
            );
            assert!(error.contains("site_launch_failed"));
        }
        assert!(parse_readiness(
            &readiness("http://127.0.0.1:43211/", "http://127.0.0.1:43212", 7),
            7
        )
        .is_err());
        assert!(parse_readiness(
            &readiness("http://127.0.0.1:43211/", "http://127.0.0.1:43211", 8),
            7
        )
        .is_err());
        assert!(parse_readiness(b"not JSON", 7).is_err());
        assert!(parse_readiness(&vec![b' '; MAX_JSON + 1], 7).is_err());
    }

    #[cfg(unix)]
    fn fixture(mode: &str) -> tempfile::TempDir {
        let home = tempfile::tempdir().unwrap();
        let bin = home.path().join(".bun/bin");
        let package = home
            .path()
            .join(".bun/install/global/node_modules/@staix/agent-console");
        fs::create_dir_all(&bin).unwrap();
        fs::create_dir_all(package.join("bin")).unwrap();
        fs::write(
            package.join("package.json"),
            br#"{"name":"@staix/agent-console","version":"0.1.0","bin":{"acon":"bin/acon.js"}}"#,
        )
        .unwrap();
        crate::test_support::write_executable_fixture(
            &bin.join("bun"),
            "#!/bin/sh\nexec \"$@\"\n",
            0o755,
        )
        .unwrap();
        let source = r#"#!/usr/bin/env python3
import http.server, json, os, sys, time
assert sys.argv[1:] == ['ui', '--no-open', '--json']
mode = 'FIXTURE_MODE'
if mode == 'exit': sys.exit(7)
if mode == 'timeout': time.sleep(10); sys.exit(0)
if mode == 'oversize': print('x' * 40000, flush=True); time.sleep(10)
if mode == 'invalid': print('not-json', flush=True); time.sleep(10)
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(302 if mode == 'redirect' else 200)
        self.send_header('Content-Length', '0')
        self.send_header('Content-Security-Policy', "frame-ancestors 'none'")
        if mode == 'redirect': self.send_header('Location', 'http://192.0.2.1/')
        self.end_headers()
    def log_message(self, *args): pass
server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
origin = 'http://127.0.0.1:' + str(server.server_port)
print(json.dumps({'url': origin + '/#one-time-ticket', 'origin': origin, 'pid': os.getpid(), 'plugins': []}), flush=True)
server.serve_forever()
"#.replace("FIXTURE_MODE", mode);
        crate::test_support::write_executable_fixture(&package.join("bin/acon.js"), &source, 0o755)
            .unwrap();
        std::os::unix::fs::symlink(package.join("bin/acon.js"), bin.join("acon")).unwrap();
        home
    }

    #[test]
    #[cfg(unix)]
    fn trusted_install_is_manifest_bound_and_rejects_executable_escape_or_writable_parents() {
        use std::os::unix::fs::PermissionsExt;
        let home = fixture("valid");
        resolve_console(home.path()).unwrap();
        let bin = home.path().join(".bun/bin");
        fs::remove_file(bin.join("acon")).unwrap();
        std::os::unix::fs::symlink("/bin/sh", bin.join("acon")).unwrap();
        assert!(resolve_console(home.path())
            .err()
            .unwrap()
            .contains("does not match"));
        fs::remove_file(bin.join("acon")).unwrap();
        std::os::unix::fs::symlink(
            home.path()
                .join(".bun/install/global/node_modules/@staix/agent-console/bin/acon.js"),
            bin.join("acon"),
        )
        .unwrap();
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o777)).unwrap();
        assert!(resolve_console(home.path())
            .err()
            .unwrap()
            .contains("group/world write"));
    }

    #[test]
    fn absent_console_reports_install_command_without_creating_installation_state() {
        let home = tempfile::tempdir().unwrap();
        let error = resolve_console(home.path()).err().unwrap();
        assert!(error.contains("bun add -g @staix/agent-console"));
        assert!(!home.path().join(".bun").exists());
    }

    #[test]
    #[cfg(unix)]
    fn readiness_works_while_console_is_resident_and_failures_do_not_handoff_a_url() {
        let cancel = AtomicBool::new(false);
        let home = fixture("valid");
        let before = LIVE.load(Ordering::Acquire);
        let console = start_console(
            resolve_console(home.path()).unwrap(),
            Duration::from_secs(5),
            &cancel,
        )
        .unwrap();
        assert!(console.url.fragment().unwrap().contains("one-time-ticket"));
        assert_eq!(LIVE.load(Ordering::Acquire), before + 1);
        // Drop before keep_alive cancels/reaps only this owned console.
        drop(console);
        assert_eq!(LIVE.load(Ordering::Acquire), before);
        for mode in ["exit", "timeout", "invalid", "oversize", "redirect"] {
            let home = fixture(mode);
            let result = start_console(
                resolve_console(home.path()).unwrap(),
                if mode == "timeout" {
                    Duration::from_millis(100)
                } else {
                    Duration::from_secs(5)
                },
                &cancel,
            );
            assert!(
                result.is_err(),
                "{mode} must not produce a navigation handoff"
            );
            assert_eq!(LIVE.load(Ordering::Acquire), before);
        }
        let home = fixture("timeout");
        let cancelled = AtomicBool::new(true);
        assert!(start_console(
            resolve_console(home.path()).unwrap(),
            Duration::from_secs(5),
            &cancelled
        )
        .err()
        .unwrap()
        .contains("site_open_cancelled"));
        assert_eq!(LIVE.load(Ordering::Acquire), before);
    }
}
