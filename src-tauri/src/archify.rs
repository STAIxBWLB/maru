//! Archify engine adapter (#433): validates a candidate diagram spec against
//! the vendored, hash-pinned Archify engine (`sidecars/archify/`, see
//! `PIN.json`). The engine is a zero-dependency Node ESM CLI; this module
//! stages the candidate into a job-private directory under
//! `<workspace>/.maru/diagram-gen/<jobId>/`, runs
//! `node bin/archify.mjs validate <type> <candidate> --json` with a bounded
//! timeout, and returns the receipt as a typed struct. A missing engine or
//! Node runtime is a typed ENGINE_UNAVAILABLE error — never a faked success.

use crate::atomic_file::{with_path_transactions, write_atomic, PathTransactionRequest};
use crate::cli_path::{augmented_path, resolve_program};
use crate::ipc_error::IpcError;
use crate::vault::resolve_inside_vault;
use crate::vault_list::{assert_maru_can_write, WorkspaceWriteAction};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};
use tauri::Manager;

pub const ARCHIFY_INVALID_DIAGRAM_TYPE: &str = "archify_invalid_diagram_type";
pub const ARCHIFY_CANDIDATE_TOO_LARGE: &str = "archify_candidate_too_large";
pub const ARCHIFY_ENGINE_UNAVAILABLE: &str = "archify_engine_unavailable";
pub const ARCHIFY_VALIDATE_TIMEOUT: &str = "archify_validate_timeout";
pub const ARCHIFY_ENGINE_FAILED: &str = "archify_engine_failed";

const MAX_CANDIDATE_BYTES: usize = 512 * 1024;
const VALIDATE_TIMEOUT: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_millis(50);
/// Host-owned staging root for validation jobs, inside the workspace vault.
const STAGING_DIR: &str = ".maru/diagram-gen";
const ENGINE_REL: &str = "sidecars/archify/bin/archify.mjs";
/// Explicit engine path override (development and tests).
const ENGINE_ENV: &str = "MARU_ARCHIFY_ENGINE";
/// Node binary override, mirroring the other CLI integrations.
const NODE_ENV: &str = "MARU_NODE_PATH";
/// Millisecond timeout override, so tests can exercise the kill path quickly.
const TIMEOUT_ENV: &str = "MARU_ARCHIFY_TIMEOUT_MS";

#[cfg(test)]
static ENGINE_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ArchifyValidationReceipt {
    pub ok: bool,
    pub diagram_type: String,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    pub candidate_sha256: String,
}

fn typed(code: &str, message: impl Into<String>) -> IpcError {
    IpcError {
        code: code.to_string(),
        message: message.into(),
    }
}

fn engine_unavailable(message: impl Into<String>) -> IpcError {
    typed(ARCHIFY_ENGINE_UNAVAILABLE, message)
}

fn validate_diagram_type(diagram_type: &str) -> Result<&'static str, IpcError> {
    match diagram_type {
        "architecture" => Ok("architecture"),
        "workflow" => Ok("workflow"),
        "sequence" => Ok("sequence"),
        "dataflow" => Ok("dataflow"),
        "lifecycle" => Ok("lifecycle"),
        other => Err(typed(
            ARCHIFY_INVALID_DIAGRAM_TYPE,
            format!("Unsupported diagram type: {other}"),
        )),
    }
}

/// Dev builds run from the repo, so the engine sits at
/// `<repo>/sidecars/archify/bin/archify.mjs`: walk up from the current exe and
/// from the compile-time manifest dir until it appears. An explicit
/// `MARU_ARCHIFY_ENGINE` override wins and must exist.
pub(crate) fn bundled_engine_path(app: &tauri::AppHandle) -> Result<PathBuf, IpcError> {
    if cfg!(debug_assertions) {
        return resolve_engine_path();
    }
    let engine = app
        .path()
        .resource_dir()
        .map_err(|err| engine_unavailable(format!("Cannot resolve resources: {err}")))?
        .join("archify/bin/archify.mjs");
    if !engine.is_file() {
        return Err(engine_unavailable("Bundled Archify engine is missing"));
    }
    Ok(engine)
}

fn resolve_engine_path() -> Result<PathBuf, IpcError> {
    if let Some(override_path) = std::env::var_os(ENGINE_ENV) {
        let candidate = PathBuf::from(override_path);
        if candidate.is_file() {
            return Ok(candidate);
        }
        return Err(engine_unavailable(format!(
            "{ENGINE_ENV} points at a missing engine: {}",
            candidate.display()
        )));
    }
    let mut starts: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            starts.push(dir.to_path_buf());
        }
    }
    starts.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")));
    for start in starts {
        for dir in start.ancestors() {
            let candidate = dir.join(ENGINE_REL);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    Err(engine_unavailable(format!(
        "Vendored Archify engine not found ({ENGINE_REL})"
    )))
}

/// `MARU_NODE_PATH` wins; otherwise reuse the shared GUI-safe CLI resolver. The candidate is proven
/// with a `--version` probe so a stale override fails before any staging.
fn resolve_node() -> Result<PathBuf, IpcError> {
    let candidate = match std::env::var_os(NODE_ENV) {
        Some(path) => PathBuf::from(path),
        None => resolve_program("node").ok_or_else(|| {
            engine_unavailable(format!("Node runtime not found (set {NODE_ENV})"))
        })?,
    };
    match Command::new(&candidate)
        .env("PATH", augmented_path())
        .arg("--version")
        .output()
    {
        Ok(output) if output.status.success() => Ok(candidate),
        Ok(_) => Err(engine_unavailable(format!(
            "Node runtime probe failed: {}",
            candidate.display()
        ))),
        Err(err) => Err(engine_unavailable(format!(
            "Node runtime not found (set {NODE_ENV}): {err}"
        ))),
    }
}

fn validate_timeout() -> Duration {
    std::env::var(TIMEOUT_ENV)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|ms| *ms > 0)
        .map_or(VALIDATE_TIMEOUT, Duration::from_millis)
}

fn stderr_tail(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let trimmed = stderr.trim();
    trimmed
        .chars()
        .rev()
        .take(400)
        .collect::<String>()
        .chars()
        .rev()
        .collect()
}

/// The engine prints one JSON receipt on stdout for both pass (exit 0) and
/// fail (nonzero): diagnostics flatten to `code: message` lines bucketed by
/// severity, and the frozen candidate hash comes from `candidate.sha256`.
fn parse_receipt(
    diagram_type: &str,
    output: &Output,
) -> Result<ArchifyValidationReceipt, IpcError> {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let value: serde_json::Value = serde_json::from_str(stdout.trim()).map_err(|err| {
        typed(
            ARCHIFY_ENGINE_FAILED,
            format!(
                "Archify engine did not print a JSON receipt ({err}); stderr: {}",
                stderr_tail(output)
            ),
        )
    })?;
    let ok = value.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    let mut errors: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    if let Some(diagnostics) = value.get("diagnostics").and_then(|v| v.as_array()) {
        for diagnostic in diagnostics {
            let code = diagnostic
                .get("code")
                .and_then(|v| v.as_str())
                .unwrap_or("diagnostic");
            let message = diagnostic
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .trim();
            let line = format!("{code}: {message}");
            if diagnostic.get("severity").and_then(|v| v.as_str()) == Some("error") {
                errors.push(line);
            } else {
                warnings.push(line);
            }
        }
    }
    if !ok && errors.is_empty() {
        if let Some(error) = value.get("error").and_then(|v| v.as_str()) {
            errors.push(error.to_string());
        }
    }
    let candidate_sha256 = value
        .pointer("/candidate/sha256")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    Ok(ArchifyValidationReceipt {
        ok,
        diagram_type: diagram_type.to_string(),
        errors,
        warnings,
        candidate_sha256,
    })
}

/// Spawn the engine with piped output and poll `try_wait`: on timeout the
/// child is killed and reaped so no orphan node process outlives the command.
fn run_engine(
    node: &Path,
    engine: &Path,
    diagram_type: &str,
    candidate: &Path,
    timeout: Duration,
) -> Result<ArchifyValidationReceipt, IpcError> {
    let child = Command::new(node)
        .env("PATH", augmented_path())
        .arg(engine)
        .arg("validate")
        .arg(diagram_type)
        .arg(candidate)
        .arg("--json")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| engine_unavailable(format!("Cannot start the Archify engine: {err}")))?;
    wait_engine(child, diagram_type, timeout)
}

fn wait_engine(
    mut child: std::process::Child,
    diagram_type: &str,
    timeout: Duration,
) -> Result<ArchifyValidationReceipt, IpcError> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(typed(
                        ARCHIFY_VALIDATE_TIMEOUT,
                        format!(
                            "Archify validate exceeded {}ms and was killed",
                            timeout.as_millis()
                        ),
                    ));
                }
                std::thread::sleep(POLL_INTERVAL);
            }
            Err(err) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(typed(
                    ARCHIFY_ENGINE_FAILED,
                    format!("Cannot wait on the Archify engine: {err}"),
                ));
            }
        }
    }
    let output = child.wait_with_output().map_err(|err| {
        typed(
            ARCHIFY_ENGINE_FAILED,
            format!("Cannot read engine output: {err}"),
        )
    })?;
    parse_receipt(diagram_type, &output)
}

/// Job-private staging write, admitted through the shared path-transaction
/// discipline every other workspace writer uses.
fn stage_candidate(
    workspace: &str,
    job_dir: &Path,
    candidate: &Path,
    bytes: &[u8],
) -> Result<(), IpcError> {
    let root = resolve_inside_vault(workspace, ".")?;
    let request =
        PathTransactionRequest::new(vec![job_dir.to_path_buf(), candidate.to_path_buf()])?
            .require_parent(&root)?
            .with_workspace_registry()?;
    with_path_transactions(request, |lease| {
        lease.ensure_workspace_registry()?;
        lease.ensure_covered(vec![job_dir.to_path_buf(), candidate.to_path_buf()])?;
        assert_maru_can_write(workspace, WorkspaceWriteAction::Create)?;
        lease.before_effect()?;
        fs::create_dir_all(job_dir).map_err(|err| format!("Cannot create staging dir: {err}"))?;
        write_atomic(candidate, bytes)?;
        Ok(())
    })?;
    Ok(())
}

/// Validate the exact bytes already read through gallery containment guards.
/// The pinned schema validator runs without rendering or source-file writes.
pub(crate) fn validate_sibling_schema(body: &str, engine: Option<PathBuf>) -> Result<(), IpcError> {
    #[cfg(test)]
    let _environment = ENGINE_ENV_LOCK.lock().unwrap();
    let engine = engine.map_or_else(resolve_engine_path, Ok)?;
    let validator = engine
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| engine_unavailable("Invalid engine location"))?
        .join("renderers/shared/validator.mjs");
    let script = r#"import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
const { validateSchema } = await import(pathToFileURL(process.argv[1]).href);
try {
  validateSchema('architecture', JSON.parse(readFileSync(0, 'utf8')));
  console.log(JSON.stringify({ok:true}));
} catch (error) {
  console.log(JSON.stringify({ok:false,error:error.message}));
  process.exitCode = 1;
}"#;
    let mut child = Command::new(resolve_node()?)
        .env("PATH", augmented_path())
        .args(["--input-type=module", "--eval", script])
        .arg(validator)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| engine_unavailable(format!("Cannot start schema validator: {err}")))?;
    if let Err(err) = child.stdin.take().unwrap().write_all(body.as_bytes()) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(typed(
            ARCHIFY_ENGINE_FAILED,
            format!("Cannot send sibling spec: {err}"),
        ));
    }
    let receipt = wait_engine(child, "architecture", validate_timeout())?;
    if !receipt.ok {
        return Err(typed(
            ARCHIFY_ENGINE_FAILED,
            format!(
                "Sibling spec fails pinned architecture schema: {}",
                receipt.errors.join("; ")
            ),
        ));
    }
    Ok(())
}

#[cfg(test)]
fn archify_validate_candidate(
    workspace: String,
    diagram_type: String,
    candidate_json: String,
) -> Result<ArchifyValidationReceipt, IpcError> {
    validate_candidate_with_engine(workspace, diagram_type, candidate_json, None)
}

fn validate_candidate_with_engine(
    workspace: String,
    diagram_type: String,
    candidate_json: String,
    engine: Option<PathBuf>,
) -> Result<ArchifyValidationReceipt, IpcError> {
    // Type and size gates run before any filesystem or process work.
    let diagram_type = validate_diagram_type(&diagram_type)?;
    if candidate_json.len() > MAX_CANDIDATE_BYTES {
        return Err(typed(
            ARCHIFY_CANDIDATE_TOO_LARGE,
            format!("Candidate exceeds {MAX_CANDIDATE_BYTES} bytes"),
        ));
    }
    let engine = engine.map_or_else(resolve_engine_path, Ok)?;
    let node = resolve_node()?;
    let job_id = uuid::Uuid::new_v4().simple().to_string();
    let job_dir = resolve_inside_vault(&workspace, STAGING_DIR)?.join(&job_id);
    let candidate = job_dir.join("candidate.json");
    let staged = stage_candidate(&workspace, &job_dir, &candidate, candidate_json.as_bytes());
    let result = staged
        .and_then(|()| run_engine(&node, &engine, diagram_type, &candidate, validate_timeout()));
    // Best-effort cleanup, success or failure: the job dir is private staging.
    let _ = fs::remove_dir_all(&job_dir);
    result
}

/// Owned production IPC boundary; tests use a synchronous source-engine adapter.
pub mod ipc {
    use super::{ArchifyValidationReceipt, IpcError};

    #[tauri::command]
    pub async fn archify_validate_candidate(
        app: tauri::AppHandle,
        workspace: String,
        diagram_type: String,
        candidate_json: String,
    ) -> Result<ArchifyValidationReceipt, IpcError> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            crate::atomic_file::PathTransactionLease::test_stage(
                &[std::path::PathBuf::from(&workspace)],
                "worker:archify_validate_candidate",
            );
            let engine = super::bundled_engine_path(&app)?;
            super::validate_candidate_with_engine(
                workspace,
                diagram_type,
                candidate_json,
                Some(engine),
            )
        })
        .await
        .map_err(|err| IpcError::from(format!("archify_validate_candidate_task_failed: {err}")))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::MutexGuard;
    use tempfile::TempDir;

    /// Env-var overrides are process-global, so every test that resolves the
    /// engine or node serializes here.

    const VALID_SPEC: &str = r#"{
  "schema_version": 1,
  "diagram_type": "architecture",
  "meta": { "title": "Probe", "output": "x.html" },
  "layout": { "mode": "grid" },
  "components": [
    { "id": "app", "label": "App", "type": "backend", "row": 0, "col": 0 }
  ]
}"#;

    const MISSING_TITLE_SPEC: &str = r#"{
  "schema_version": 1,
  "diagram_type": "architecture",
  "meta": { "output": "x.html" },
  "layout": { "mode": "grid" },
  "components": [
    { "id": "app", "label": "App", "type": "backend", "row": 0, "col": 0 }
  ]
}"#;

    fn lock_env() -> MutexGuard<'static, ()> {
        ENGINE_ENV_LOCK.lock().unwrap()
    }

    struct EnvRestore {
        key: &'static str,
        previous: Option<std::ffi::OsString>,
    }

    impl EnvRestore {
        fn set(key: &'static str, value: &str) -> Self {
            let previous = std::env::var_os(key);
            std::env::set_var(key, value);
            EnvRestore { key, previous }
        }
    }

    impl Drop for EnvRestore {
        fn drop(&mut self) {
            match &self.previous {
                Some(value) => std::env::set_var(self.key, value),
                None => std::env::remove_var(self.key),
            }
        }
    }

    fn setup_workspace() -> (TempDir, String) {
        let tmp = TempDir::new().expect("tempdir");
        fs::create_dir_all(tmp.path().join(".maru")).expect("maru dir");
        let work = tmp.path().to_string_lossy().to_string();
        (tmp, work)
    }

    fn node_available() -> bool {
        Command::new("node")
            .arg("--version")
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }

    #[test]
    fn rejects_unknown_diagram_type_before_filesystem_work() {
        // A workspace path that does not exist: reaching the filesystem at
        // all would fail differently, so the typed code proves the order.
        let err = archify_validate_candidate(
            "/definitely/not/a/workspace".to_string(),
            "gantt".to_string(),
            "{}".to_string(),
        )
        .unwrap_err();
        assert_eq!(err.code, ARCHIFY_INVALID_DIAGRAM_TYPE);
    }

    #[test]
    fn accepts_all_five_diagram_types() {
        for diagram_type in [
            "architecture",
            "workflow",
            "sequence",
            "dataflow",
            "lifecycle",
        ] {
            assert_eq!(validate_diagram_type(diagram_type).unwrap(), diagram_type);
        }
    }

    /// The #433 P2 fixtures, verbatim from the issue, validated by the pinned engine.
    const SEQUENCE_SPEC: &str = r#"{"schema_version":1,"diagram_type":"sequence","meta":{"title":"Login","output":"login.html","locale":"en"},"participants":[{"id":"web","type":"frontend","label":"Web"},{"id":"api","type":"backend","label":"API"},{"id":"db","type":"database","label":"DB"}],"messages":[{"from":"web","to":"api","y":180,"label":"POST /login"},{"from":"api","to":"db","y":230,"label":"find user"},{"from":"db","to":"api","y":280,"label":"row","variant":"return"},{"from":"api","to":"web","y":330,"label":"200 OK","variant":"return"}]}"#;
    const DATAFLOW_SPEC: &str = r#"{"schema_version":1,"diagram_type":"dataflow","meta":{"title":"Events","output":"events.html","locale":"en"},"stages":[{"label":"Collect"},{"label":"Store"}],"nodes":[{"id":"app","type":"frontend","label":"App","stage":0,"row":0},{"id":"wh","type":"database","label":"Warehouse","stage":1,"row":0}],"flows":[{"from":"app","to":"wh","label":"events","classification":"PII"}]}"#;
    const LIFECYCLE_SPEC: &str = r#"{"schema_version":2,"diagram_type":"lifecycle","meta":{"title":"Run","output":"run.html","locale":"en"},"lanes":[{"id":"main","label":"Main"}],"states":[{"id":"queued","type":"start","label":"Queued","lane":"main","col":0},{"id":"running","type":"active","label":"Running","lane":"main","col":1},{"id":"done","type":"success","label":"Done","lane":"main","col":2}],"transitions":[{"from":"queued","to":"running","label":"start"},{"from":"running","to":"done","label":"finish"}]}"#;

    fn assert_fixture_validates(diagram_type: &str, spec: &str) {
        let _lock = lock_env();
        std::env::remove_var(TIMEOUT_ENV);
        if !node_available() {
            eprintln!("skipping: node is not available on PATH");
            return;
        }
        let (_tmp, work) = setup_workspace();
        let receipt =
            archify_validate_candidate(work, diagram_type.to_string(), spec.to_string()).unwrap();
        assert!(receipt.ok, "{diagram_type} errors: {:?}", receipt.errors);
        assert_eq!(receipt.diagram_type, diagram_type);
    }

    #[test]
    fn sequence_fixture_validates_with_real_engine() {
        assert_fixture_validates("sequence", SEQUENCE_SPEC);
    }

    #[test]
    fn dataflow_fixture_validates_with_real_engine() {
        assert_fixture_validates("dataflow", DATAFLOW_SPEC);
    }

    #[test]
    fn lifecycle_fixture_validates_with_real_engine() {
        assert_fixture_validates("lifecycle", LIFECYCLE_SPEC);
    }

    #[test]
    fn rejects_oversize_candidate() {
        let (tmp, work) = setup_workspace();
        let err = archify_validate_candidate(
            work,
            "architecture".to_string(),
            " ".repeat(MAX_CANDIDATE_BYTES + 1),
        )
        .unwrap_err();
        assert_eq!(err.code, ARCHIFY_CANDIDATE_TOO_LARGE);
        assert!(!tmp.path().join(".maru/diagram-gen").exists());
    }

    #[test]
    fn valid_candidate_validates_with_real_engine() {
        let _lock = lock_env();
        std::env::remove_var(TIMEOUT_ENV);
        if !node_available() {
            eprintln!("skipping: node is not available on PATH");
            return;
        }
        let (tmp, work) = setup_workspace();
        let receipt =
            archify_validate_candidate(work, "architecture".to_string(), VALID_SPEC.to_string())
                .unwrap();
        assert!(receipt.ok, "errors: {:?}", receipt.errors);
        assert!(receipt.errors.is_empty());
        assert_eq!(receipt.diagram_type, "architecture");
        assert_eq!(receipt.candidate_sha256.len(), 64);
        assert!(receipt
            .candidate_sha256
            .chars()
            .all(|c| c.is_ascii_hexdigit()));
        // Staging is cleaned up after the run.
        let staging = tmp.path().join(".maru/diagram-gen");
        let left: Vec<_> = fs::read_dir(&staging)
            .map(|read| read.flatten().collect())
            .unwrap_or_default();
        assert!(left.is_empty(), "staging leftovers: {left:?}");
    }

    #[test]
    fn invalid_candidate_returns_errors() {
        let _lock = lock_env();
        std::env::remove_var(TIMEOUT_ENV);
        if !node_available() {
            eprintln!("skipping: node is not available on PATH");
            return;
        }
        let (_tmp, work) = setup_workspace();
        let receipt = archify_validate_candidate(
            work,
            "architecture".to_string(),
            MISSING_TITLE_SPEC.to_string(),
        )
        .unwrap();
        assert!(!receipt.ok);
        assert!(!receipt.errors.is_empty());
    }

    #[test]
    fn sleeping_node_is_killed_at_timeout() {
        let _lock = lock_env();
        let _timeout = EnvRestore::set(TIMEOUT_ENV, "300");
        let tmp = TempDir::new().unwrap();
        let fake = tmp.path().join("fake-node");
        crate::test_support::write_executable_fixture(&fake, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo v0.0.0-fake; exit 0; fi\nsleep 30\n", 0o755).unwrap();
        let _node = EnvRestore::set(NODE_ENV, fake.to_str().unwrap());
        let (_work_tmp, work) = setup_workspace();
        let started = Instant::now();
        let err =
            archify_validate_candidate(work, "architecture".to_string(), VALID_SPEC.to_string())
                .unwrap_err();
        assert_eq!(err.code, ARCHIFY_VALIDATE_TIMEOUT);
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn missing_engine_is_engine_unavailable() {
        let _lock = lock_env();
        let tmp = TempDir::new().unwrap();
        let missing = tmp.path().join("no-such-engine.mjs");
        let _engine = EnvRestore::set(ENGINE_ENV, missing.to_str().unwrap());
        let err = archify_validate_candidate(
            "/definitely/not/a/workspace".to_string(),
            "architecture".to_string(),
            "{}".to_string(),
        )
        .unwrap_err();
        assert_eq!(err.code, ARCHIFY_ENGINE_UNAVAILABLE);
        assert!(err.message.contains(ENGINE_ENV));
    }
}
