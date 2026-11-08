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
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::Duration;
#[cfg(test)]
use std::time::Instant;
use tauri::Manager;

pub const ARCHIFY_INVALID_DIAGRAM_TYPE: &str = "archify_invalid_diagram_type";
pub const ARCHIFY_CANDIDATE_TOO_LARGE: &str = "archify_candidate_too_large";
pub const ARCHIFY_ENGINE_UNAVAILABLE: &str = "archify_engine_unavailable";
pub const ARCHIFY_VALIDATE_TIMEOUT: &str = "archify_validate_timeout";
pub const ARCHIFY_ENGINE_FAILED: &str = "archify_engine_failed";
pub const ARCHIFY_RENDER_TIMEOUT: &str = "archify_render_timeout";
pub const ARCHIFY_RENDER_OUTPUT_TOO_LARGE: &str = "archify_render_output_too_large";
pub const ARCHIFY_RENDER_FAILED: &str = "archify_render_failed";

fn render_error(code: &str, cause: impl Into<String>) -> IpcError {
    typed(
        code,
        format!(
            "{}; next step: review the diagram and retry the export, or contact support if it repeats",
            cause.into()
        ),
    )
}

const MAX_CANDIDATE_BYTES: usize = 512 * 1024;
const MAX_RENDERED_HTML_BYTES: u64 = 8 * 1024 * 1024;
const VALIDATE_TIMEOUT: Duration = Duration::from_secs(30);
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
const JOB_ID_ENV: &str = "MARU_ARCHIFY_TEST_JOB_ID";

const ENGINE_PIN_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../sidecars/archify/PIN.json"
));

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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArchifyEnginePin {
    pub name: String,
    pub version: String,
    pub revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArchifyRenderGate {
    pub status: String,
    pub scope: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArchifyRenderGates {
    pub schema: ArchifyRenderGate,
    pub artifact: ArchifyRenderGate,
    pub browser: ArchifyRenderGate,
    pub visual_review: ArchifyRenderGate,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArchifyRenderReceipt {
    pub schema_version: u32,
    pub input_spec_sha256: String,
    pub engine_pin: ArchifyEnginePin,
    pub output_sha256: String,
    pub output_mime_type: String,
    pub gates: ArchifyRenderGates,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArchifyRenderArtifact {
    pub bytes: Vec<u8>,
    pub receipt: ArchifyRenderReceipt,
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
pub(crate) fn bundled_engine_path<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<PathBuf, IpcError> {
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
    let output = bounded_engine_output(
        Command::new(&candidate)
            .env("PATH", augmented_path())
            .arg("--version"),
        Duration::from_secs(2),
        ARCHIFY_ENGINE_UNAVAILABLE,
        None,
    )
    .map_err(|error| {
        engine_unavailable(format!(
            "Node runtime probe failed: {}; check {NODE_ENV} or reinstall Node, then retry",
            error.message
        ))
    })?;
    if output.status.success() {
        Ok(candidate)
    } else {
        Err(engine_unavailable(format!(
            "Node runtime probe failed for {}; check {NODE_ENV} or reinstall Node, then retry",
            candidate.display()
        )))
    }
}

fn validate_timeout() -> Duration {
    std::env::var(TIMEOUT_ENV)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|ms| *ms > 0)
        .map_or(VALIDATE_TIMEOUT, Duration::from_millis)
}

fn render_job_id() -> String {
    #[cfg(test)]
    if let Ok(value) = std::env::var(JOB_ID_ENV) {
        if !value.is_empty()
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return value;
        }
    }
    uuid::Uuid::new_v4().simple().to_string()
}

fn engine_pin() -> Result<ArchifyEnginePin, IpcError> {
    serde_json::from_str(ENGINE_PIN_JSON).map_err(|err| {
        engine_unavailable(format!("Pinned Archify engine metadata is invalid: {err}"))
    })
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
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
fn bounded_engine_output(
    command: &mut Command,
    timeout: Duration,
    timeout_code: &str,
    monitored_html: Option<&Path>,
) -> Result<Output, IpcError> {
    use crate::command_output::{
        run_command_with_timeout_and_limits, CommandTermination, OutputLimits,
    };
    let output = run_command_with_timeout_and_limits(
        command,
        timeout,
        OutputLimits::new(1024 * 1024, 64 * 1024),
        |_, _| {
            monitored_html.is_some_and(|path| {
                validate_render_staging_parents(path).is_err()
                    || fs::symlink_metadata(path).is_ok_and(|metadata| {
                        metadata.file_type().is_symlink()
                            || !metadata.is_file()
                            || metadata.len() > MAX_RENDERED_HTML_BYTES
                    })
            })
        },
    )
    .map_err(|error| {
        render_error(
            ARCHIFY_ENGINE_FAILED,
            format!("Cannot execute the pinned engine: {error}"),
        )
    })?;
    if output.termination == CommandTermination::TimedOut {
        return Err(render_error(
            timeout_code,
            "Pinned engine exceeded its deadline; its owned process tree was terminated",
        ));
    }
    if output.termination == CommandTermination::Aborted {
        return Err(render_error(ARCHIFY_RENDER_FAILED, "Staging changed or exceeded the output budget; the owned engine process tree was terminated"));
    }
    if output.stdout_truncated || output.stderr_truncated {
        return Err(render_error(
            ARCHIFY_ENGINE_FAILED,
            "Pinned engine diagnostics exceeded the bounded output budget",
        ));
    }
    Ok(Output {
        status: output.status,
        stdout: output.stdout,
        stderr: output.stderr,
    })
}

fn run_engine(
    node: &Path,
    engine: &Path,
    diagram_type: &str,
    candidate: &Path,
    timeout: Duration,
) -> Result<ArchifyValidationReceipt, IpcError> {
    let output = bounded_engine_output(
        Command::new(node)
            .env("PATH", augmented_path())
            .arg(engine)
            .arg("validate")
            .arg(diagram_type)
            .arg(candidate)
            .arg("--json"),
        timeout,
        ARCHIFY_VALIDATE_TIMEOUT,
        None,
    )?;
    parse_receipt(diagram_type, &output)
}

fn validate_render_staging_parents(html_output: &Path) -> Result<(), IpcError> {
    let Some(parent) = html_output.parent() else {
        return Err(render_error(
            ARCHIFY_RENDER_FAILED,
            "Staged HTML output has no parent directory",
        ));
    };
    for directory in parent.ancestors().take(4) {
        let metadata = fs::symlink_metadata(directory).map_err(|error| {
            render_error(
                ARCHIFY_RENDER_FAILED,
                format!(
                    "Cannot verify staged render directory {}: {error}",
                    directory.display()
                ),
            )
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(render_error(
                ARCHIFY_RENDER_FAILED,
                format!(
                    "Staged render directory was replaced or is not a directory: {}",
                    directory.display()
                ),
            ));
        }
    }
    Ok(())
}

fn run_render_engine(
    node: &Path,
    engine: &Path,
    diagram_type: &str,
    candidate: &Path,
    html_output: &Path,
    timeout: Duration,
) -> Result<(), IpcError> {
    validate_render_staging_parents(html_output)?;
    match fs::symlink_metadata(html_output) {
        Ok(_) => {
            return Err(render_error(
                ARCHIFY_ENGINE_FAILED,
                format!(
                    "Archify staging output already exists: {}",
                    html_output.display()
                ),
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(render_error(
                ARCHIFY_ENGINE_FAILED,
                format!(
                    "Cannot inspect Archify staging output {}: {error}",
                    html_output.display()
                ),
            ))
        }
    }
    let output = bounded_engine_output(
        Command::new(node)
            .env("PATH", augmented_path())
            .arg(engine)
            .arg("render")
            .arg(diagram_type)
            .arg(candidate)
            .arg(html_output),
        timeout,
        ARCHIFY_RENDER_TIMEOUT,
        Some(html_output),
    )?;
    if !output.status.success() {
        return Err(render_error(
            ARCHIFY_RENDER_FAILED,
            format!(
                "Pinned Archify render failed ({}): {}",
                output.status,
                stderr_tail(&output)
            ),
        ));
    }
    let metadata = fs::symlink_metadata(html_output).map_err(|error| {
        render_error(
            ARCHIFY_RENDER_FAILED,
            format!(
                "Archify render did not produce a readable staged artifact {}: {error}",
                html_output.display()
            ),
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(render_error(
            ARCHIFY_RENDER_FAILED,
            format!(
                "Archify render produced an unsafe staged artifact: {}",
                html_output.display()
            ),
        ));
    }
    if metadata.len() > MAX_RENDERED_HTML_BYTES {
        return Err(render_error(
            ARCHIFY_RENDER_OUTPUT_TOO_LARGE,
            format!(
                "Rendered HTML exceeds {MAX_RENDERED_HTML_BYTES} bytes at {}",
                html_output.display()
            ),
        ));
    }
    Ok(())
}

fn check_rendered_html(
    node: &Path,
    engine: &Path,
    html: &Path,
    timeout: Duration,
) -> Result<(), IpcError> {
    let scripts = engine.parent().and_then(Path::parent).ok_or_else(|| {
        render_error(
            ARCHIFY_ENGINE_UNAVAILABLE,
            "Pinned engine path has no artifact-checker directory",
        )
    })?;
    let checker = scripts.join("scripts/check-render-output.mjs");
    if !checker.is_file() {
        return Err(render_error(
            ARCHIFY_ENGINE_UNAVAILABLE,
            format!(
                "Pinned Archify artifact checker is missing: {}",
                checker.display()
            ),
        ));
    }
    validate_render_staging_parents(html)?;
    let output = bounded_engine_output(
        Command::new(node)
            .env("PATH", augmented_path())
            .arg(checker)
            .arg(html),
        timeout,
        ARCHIFY_RENDER_TIMEOUT,
        Some(html),
    )?;
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|error| {
        render_error(
            ARCHIFY_RENDER_FAILED,
            format!(
                "Archify artifact checker emitted invalid JSON ({error}): {}",
                stderr_tail(&output)
            ),
        )
    })?;
    if !output.status.success()
        || report.get("ok").and_then(serde_json::Value::as_bool) != Some(true)
    {
        let bounded = |text: &str, limit: usize| -> String {
            text.chars()
                .take(limit)
                .map(|ch| if ch.is_control() { ' ' } else { ch })
                .collect()
        };
        let mut causes = Vec::new();
        for check in report
            .get("checks")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .filter(|check| check.get("ok").and_then(serde_json::Value::as_bool) == Some(false))
            .take(8)
        {
            let name = bounded(
                check
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("unnamed check"),
                80,
            );
            let details: Vec<String> = check
                .get("details")
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
                .take(3)
                .map(|detail| bounded(&detail.to_string(), 240))
                .collect();
            causes.push(format!("{name}: {}", details.join(", ")));
        }
        if let Some(composition) = report.get("composition") {
            if composition
                .get("status")
                .and_then(serde_json::Value::as_str)
                == Some("fail")
            {
                causes.push(format!(
                    "composition rejected: {} errors",
                    composition
                        .pointer("/summary/errors")
                        .unwrap_or(&serde_json::Value::Null)
                ));
            }
            for issue in composition
                .get("issues")
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
                .filter(|issue| {
                    issue.get("severity").and_then(serde_json::Value::as_str) == Some("error")
                })
                .take(4)
            {
                causes.push(format!("composition: {}", bounded(&issue.to_string(), 360)));
            }
        }
        if causes.is_empty() {
            let stderr = stderr_tail(&output);
            causes.push(if stderr.is_empty() {
                format!(
                    "checker rejected the artifact (exit {}, report ok={})",
                    output.status,
                    report.get("ok").unwrap_or(&serde_json::Value::Null)
                )
            } else {
                stderr
            });
        }
        return Err(render_error(
            ARCHIFY_RENDER_FAILED,
            format!(
                "Pinned Archify artifact check failed: {}",
                bounded(&causes.join("; "), 3200)
            ),
        ));
    }
    validate_render_staging_parents(html)?;
    Ok(())
}

fn read_bounded_rendered_html(path: &Path) -> Result<Vec<u8>, IpcError> {
    validate_render_staging_parents(path)?;
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        render_error(
            ARCHIFY_RENDER_FAILED,
            format!("Cannot inspect rendered HTML {}: {error}", path.display()),
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(render_error(
            ARCHIFY_RENDER_FAILED,
            format!(
                "Rendered HTML is not a regular staged file: {}",
                path.display()
            ),
        ));
    }
    if metadata.len() > MAX_RENDERED_HTML_BYTES {
        return Err(render_error(
            ARCHIFY_RENDER_OUTPUT_TOO_LARGE,
            format!(
                "Rendered HTML exceeds {MAX_RENDERED_HTML_BYTES} bytes; simplify the diagram before exporting"
            ),
        ));
    }
    let file = fs::File::open(path).map_err(|error| {
        render_error(
            ARCHIFY_RENDER_FAILED,
            format!("Cannot read rendered HTML {}: {error}", path.display()),
        )
    })?;
    let mut bytes = Vec::new();
    file.take(MAX_RENDERED_HTML_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            render_error(
                ARCHIFY_RENDER_FAILED,
                format!("Cannot read rendered HTML {}: {error}", path.display()),
            )
        })?;
    if bytes.len() as u64 > MAX_RENDERED_HTML_BYTES {
        return Err(render_error(
            ARCHIFY_RENDER_OUTPUT_TOO_LARGE,
            format!(
                "Rendered HTML exceeded {MAX_RENDERED_HTML_BYTES} bytes while reading; simplify the diagram before exporting"
            ),
        ));
    }
    Ok(bytes)
}

fn cleanup_job_dir(job_dir: &Path) -> Result<(), IpcError> {
    match fs::symlink_metadata(job_dir) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(typed(
            ARCHIFY_ENGINE_FAILED,
            format!(
                "Refusing to clean replaced Archify staging symlink {}",
                job_dir.display()
            ),
        )),
        Ok(metadata) if metadata.is_dir() => {
            validate_render_staging_parents(&job_dir.join("candidate.json"))?;
            fs::remove_dir_all(job_dir).map_err(|error| {
                typed(
                    ARCHIFY_ENGINE_FAILED,
                    format!(
                        "Cannot clean Archify staging directory {}: {error}",
                        job_dir.display()
                    ),
                )
            })
        }
        Ok(_) => Err(typed(
            ARCHIFY_ENGINE_FAILED,
            format!(
                "Refusing to clean non-directory Archify staging path {}",
                job_dir.display()
            ),
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(typed(
            ARCHIFY_ENGINE_FAILED,
            format!(
                "Cannot inspect Archify staging directory {}: {error}",
                job_dir.display()
            ),
        )),
    }
}

fn render_candidate_with_engine(
    workspace: String,
    diagram_type: String,
    candidate_json: String,
    engine: Option<PathBuf>,
) -> Result<ArchifyRenderArtifact, IpcError> {
    let diagram_type = validate_diagram_type(&diagram_type)
        .map_err(|error| render_error(&error.code, error.message))?;
    if candidate_json.len() > MAX_CANDIDATE_BYTES {
        return Err(typed(
            ARCHIFY_CANDIDATE_TOO_LARGE,
            format!("Candidate exceeds {MAX_CANDIDATE_BYTES} bytes; reduce the diagram spec before exporting"),
        ));
    }
    let engine = engine
        .map_or_else(resolve_engine_path, Ok)
        .map_err(|error| render_error(&error.code, error.message))?;
    let node = resolve_node().map_err(|error| render_error(&error.code, error.message))?;
    let pin = engine_pin().map_err(|error| render_error(&error.code, error.message))?;
    let input_spec_sha256 = sha256(candidate_json.as_bytes());
    let job_id = render_job_id();
    let job_dir = resolve_inside_vault(&workspace, STAGING_DIR)
        .map_err(|error: String| render_error(ARCHIFY_RENDER_FAILED, error))?
        .join(&job_id);
    let candidate = job_dir.join("candidate.json");
    let rendered_html = job_dir.join("rendered.html");

    let staged = stage_candidate(&workspace, &job_dir, &candidate, candidate_json.as_bytes())
        .map_err(|error| render_error(&error.code, error.message));
    let owns_staging = staged.is_ok();
    let result = staged.and_then(|()| (|| {
        let validation = run_engine(&node, &engine, diagram_type, &candidate, validate_timeout())
            .map_err(|error| render_error(&error.code, error.message))?;
        if !validation.ok {
            return Err(render_error(
                ARCHIFY_ENGINE_FAILED,
                format!("Pinned Archify schema/render validation failed: {}; review the diagnostics and edit the diagram before exporting", validation.errors.join("; ")),
            ));
        }
        if validation.candidate_sha256 != input_spec_sha256 {
            return Err(render_error(
                ARCHIFY_ENGINE_FAILED,
                "Pinned Archify validation hash did not match the submitted spec; retry with the unchanged candidate".to_string(),
            ));
        }
        run_render_engine(&node, &engine, diagram_type, &candidate, &rendered_html, validate_timeout())?;
        check_rendered_html(&node, &engine, &rendered_html, validate_timeout())?;
        let bytes = read_bounded_rendered_html(&rendered_html)?;
        let receipt = ArchifyRenderReceipt {
            schema_version: 1,
            input_spec_sha256,
            engine_pin: pin,
            output_sha256: sha256(&bytes),
            output_mime_type: "text/html".into(),
            gates: ArchifyRenderGates {
                schema: ArchifyRenderGate { status: "passed".into(), scope: "pinned-engine-validation".into() },
                artifact: ArchifyRenderGate { status: "passed".into(), scope: "pinned-engine-rendered-html".into() },
                browser: ArchifyRenderGate { status: "not-run".into(), scope: "none".into() },
                visual_review: ArchifyRenderGate { status: "not-run".into(), scope: "manual".into() },
            },
        };
        Ok(ArchifyRenderArtifact { bytes, receipt })
    })());

    let cleanup = if owns_staging {
        cleanup_job_dir(&job_dir)
    } else {
        Ok(())
    }
    .map_err(|error| render_error(&error.code, error.message));
    match (result, cleanup) {
        (Ok(artifact), Ok(())) => Ok(artifact),
        (Err(mut error), Err(cleanup_error)) => {
            error.message = format!(
                "{}; staging cleanup also failed: {}",
                error.message, cleanup_error.message
            );
            Err(error)
        }
        (Err(error), Ok(())) => Err(error),
        (Ok(_), Err(error)) => Err(error),
    }
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
    match fs::symlink_metadata(job_dir) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(typed(
                ARCHIFY_ENGINE_FAILED,
                format!("Unsafe Archify staging symlink at {}", job_dir.display()),
            ))
        }
        Ok(_) => {
            return Err(typed(
                ARCHIFY_ENGINE_FAILED,
                format!(
                    "Archify staging directory already exists: {}",
                    job_dir.display()
                ),
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(typed(
                ARCHIFY_ENGINE_FAILED,
                format!(
                    "Cannot inspect Archify staging directory {}: {error}",
                    job_dir.display()
                ),
            ))
        }
    }
    ensure_staging_path_absent(candidate)
        .map_err(|message| typed(ARCHIFY_ENGINE_FAILED, message))?;
    let request =
        PathTransactionRequest::new(vec![job_dir.to_path_buf(), candidate.to_path_buf()])?
            .require_parent(&root)?
            .with_workspace_registry()?;
    with_path_transactions(request, |lease| {
        lease.ensure_workspace_registry()?;
        lease.ensure_covered(vec![job_dir.to_path_buf(), candidate.to_path_buf()])?;
        ensure_staging_path_absent(job_dir)?;
        ensure_staging_path_absent(candidate)?;
        assert_maru_can_write(workspace, WorkspaceWriteAction::Create)?;
        lease.before_effect()?;
        fs::create_dir_all(job_dir).map_err(|err| format!("Cannot create staging dir: {err}"))?;
        if let Err(error) = write_atomic(candidate, bytes) {
            let cleanup = match fs::symlink_metadata(job_dir) {
                Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                    fs::remove_dir_all(job_dir).map_err(|cleanup_error| cleanup_error.to_string())
                }
                Ok(_) => Err("staging path changed type before cleanup".to_string()),
                Err(cleanup_error) => Err(cleanup_error.to_string()),
            };
            return Err(match cleanup {
                Ok(()) => error,
                Err(cleanup_error) => format!("{error}; staging cleanup failed: {cleanup_error}"),
            });
        }
        Ok(())
    })?;
    Ok(())
}

fn ensure_staging_path_absent(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Err(format!(
            "Archify staging path already exists: {}",
            path.display()
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Cannot inspect Archify staging path {}: {error}",
            path.display()
        )),
    }
}

#[cfg(test)]
fn archify_validate_candidate(
    workspace: String,
    diagram_type: String,
    candidate_json: String,
) -> Result<ArchifyValidationReceipt, IpcError> {
    validate_candidate_with_engine(workspace, diagram_type, candidate_json, None)
}

#[cfg(test)]
fn archify_render_candidate(
    workspace: String,
    diagram_type: String,
    candidate_json: String,
) -> Result<ArchifyRenderArtifact, IpcError> {
    render_candidate_with_engine(workspace, diagram_type, candidate_json, None)
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
    let staged = stage_candidate(&workspace, &job_dir, &candidate, candidate_json.as_bytes())
        .map_err(|error| {
            typed(
                &error.code,
                format!(
                    "{}; next step: review the workspace path and retry validation",
                    error.message
                ),
            )
        });
    let owns_staging = staged.is_ok();
    let result = staged
        .and_then(|()| run_engine(&node, &engine, diagram_type, &candidate, validate_timeout()));
    if owns_staging {
        let _ = cleanup_job_dir(&job_dir);
    }
    result
}

/// Owned production IPC boundary; tests use a synchronous source-engine adapter.
pub mod ipc {
    use super::{ArchifyRenderArtifact, ArchifyValidationReceipt, IpcError};

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

    #[tauri::command]
    pub async fn archify_render_candidate<R: tauri::Runtime>(
        app: tauri::AppHandle<R>,
        workspace: String,
        diagram_type: String,
        candidate_json: String,
        context: Option<crate::diagram::renders::RenderDocumentContext>,
    ) -> Result<ArchifyRenderArtifact, IpcError> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            crate::atomic_file::PathTransactionLease::test_stage(
                &[std::path::PathBuf::from(&workspace)],
                "worker:archify_render_candidate",
            );
            let engine = super::bundled_engine_path(&app).map_err(|error| {
                super::typed(&error.code, format!("{}; restore the bundled engine or fix MARU_ARCHIFY_ENGINE and retry the export", error.message))
            })?;
            if context.as_ref().is_some_and(|context| context.diagram_type != diagram_type) {
                return Err(super::render_error(super::ARCHIFY_RENDER_FAILED,
                    "Render document context names a different diagram type"));
            }
            let artifact = super::render_candidate_with_engine(
                workspace.clone(), diagram_type, candidate_json, Some(engine),
            )?;
            if let Some(context) = context {
                crate::diagram::renders::store_render(&workspace, context, artifact.clone())
                    .map_err(|error| super::render_error(super::ARCHIFY_RENDER_FAILED, error))?;
            }
            Ok(artifact)
        })
        .await
        .map_err(|err| IpcError::from(format!("archify_render_candidate_task_failed: {err}; retry the export and restart Maru if the worker failure repeats")))?
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

    const WORKFLOW_SPEC: &str = r#"{
  "schema_version": 2,
  "diagram_type": "workflow",
  "meta": { "title": "Review", "output": "review.html", "locale": "en" },
  "lanes": [{ "id": "author", "label": "Author" }, { "id": "reviewer", "label": "Reviewer" }],
  "nodes": [
    { "id": "draft", "lane": "author", "col": 0, "type": "frontend", "label": "Draft" },
    { "id": "review", "lane": "reviewer", "col": 1, "type": "backend", "label": "Review" },
    { "id": "merge", "lane": "author", "col": 2, "type": "backend", "label": "Merge" }
  ],
  "edges": [{ "from": "draft", "to": "review" }, { "from": "review", "to": "merge" }]
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

    fn assert_fixture_renders(diagram_type: &str, spec: &str) {
        let _lock = lock_env();
        std::env::remove_var(TIMEOUT_ENV);
        std::env::remove_var(JOB_ID_ENV);
        if !node_available() {
            eprintln!("skipping: node is not available on PATH");
            return;
        }
        let (tmp, work) = setup_workspace();
        let source_path = tmp.path().join("source.json");
        fs::write(&source_path, spec).unwrap();
        let original = fs::read(&source_path).unwrap();
        let artifact =
            archify_render_candidate(work, diagram_type.to_string(), spec.to_string()).unwrap();
        assert!(artifact.bytes.starts_with(b"<!DOCTYPE html>"));
        assert_eq!(artifact.receipt.schema_version, 1);
        assert_eq!(artifact.receipt.input_spec_sha256, sha256(spec.as_bytes()));
        assert_eq!(artifact.receipt.engine_pin.name, "archify");
        assert_eq!(artifact.receipt.engine_pin.version, "3.0.0");
        assert_eq!(artifact.receipt.output_sha256, sha256(&artifact.bytes));
        assert_eq!(artifact.receipt.output_mime_type, "text/html");
        assert_eq!(artifact.receipt.gates.schema.status, "passed");
        assert_eq!(artifact.receipt.gates.artifact.status, "passed");
        assert_eq!(artifact.receipt.gates.browser.status, "not-run");
        assert_eq!(artifact.receipt.gates.visual_review.status, "not-run");
        assert!(artifact.bytes.len() as u64 <= MAX_RENDERED_HTML_BYTES);
        assert_eq!(
            fs::read(source_path).unwrap(),
            original,
            "render must not mutate the submitted source file"
        );
        let leftovers: Vec<_> = fs::read_dir(tmp.path().join(STAGING_DIR))
            .map(|entries| entries.flatten().collect())
            .unwrap_or_default();
        assert!(leftovers.is_empty(), "staging leftovers: {leftovers:?}");
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
    fn renders_actual_pinned_html_for_all_five_diagram_types() {
        for (diagram_type, spec) in [
            ("architecture", VALID_SPEC),
            ("workflow", WORKFLOW_SPEC),
            ("sequence", SEQUENCE_SPEC),
            ("dataflow", DATAFLOW_SPEC),
            ("lifecycle", LIFECYCLE_SPEC),
        ] {
            assert_fixture_renders(diagram_type, spec);
        }
    }

    #[test]
    fn render_refuses_invalid_or_oversize_input() {
        let _lock = lock_env();
        if !node_available() {
            eprintln!("skipping: node is not available on PATH");
            return;
        }
        let (_tmp, work) = setup_workspace();
        let invalid = archify_render_candidate(
            work.clone(),
            "architecture".into(),
            MISSING_TITLE_SPEC.into(),
        )
        .unwrap_err();
        assert_eq!(invalid.code, ARCHIFY_ENGINE_FAILED);
        let oversized = archify_render_candidate(
            work,
            "architecture".into(),
            " ".repeat(MAX_CANDIDATE_BYTES + 1),
        )
        .unwrap_err();
        assert_eq!(oversized.code, ARCHIFY_CANDIDATE_TOO_LARGE);
    }

    #[test]
    fn render_rejects_unsafe_authored_output_without_writing_outside_staging() {
        let _lock = lock_env();
        if !node_available() {
            eprintln!("skipping: node is not available on PATH");
            return;
        }
        let (tmp, work) = setup_workspace();
        let unsafe_spec = VALID_SPEC.replace("x.html", "../outside.html");
        let error = archify_render_candidate(work, "architecture".into(), unsafe_spec).unwrap_err();
        assert_eq!(error.code, ARCHIFY_ENGINE_FAILED);
        assert!(!tmp.path().join("outside.html").exists());
        let staging = tmp.path().join(STAGING_DIR);
        assert!(fs::read_dir(staging).unwrap().next().is_none());
    }

    #[test]
    fn render_serializes_separate_gates_and_binary_payload() {
        let receipt = ArchifyRenderReceipt {
            schema_version: 1,
            input_spec_sha256: "a".repeat(64),
            engine_pin: engine_pin().unwrap(),
            output_sha256: "b".repeat(64),
            output_mime_type: "text/html".into(),
            gates: ArchifyRenderGates {
                schema: ArchifyRenderGate {
                    status: "passed".into(),
                    scope: "pinned-engine-validation".into(),
                },
                artifact: ArchifyRenderGate {
                    status: "passed".into(),
                    scope: "pinned-engine-rendered-html".into(),
                },
                browser: ArchifyRenderGate {
                    status: "not-run".into(),
                    scope: "none".into(),
                },
                visual_review: ArchifyRenderGate {
                    status: "not-run".into(),
                    scope: "manual".into(),
                },
            },
        };
        let value = serde_json::to_value(ArchifyRenderArtifact {
            bytes: vec![1, 2, 3],
            receipt,
        })
        .unwrap();
        assert_eq!(value["bytes"], serde_json::json!([1, 2, 3]));
        assert_eq!(value["receipt"]["schemaVersion"], 1);
        assert_eq!(value["receipt"]["enginePin"]["name"], "archify");
        assert_eq!(value["receipt"]["enginePin"]["version"], "3.0.0");
        assert_eq!(value["receipt"]["outputMimeType"], "text/html");
        assert_eq!(value["receipt"]["gates"]["schema"]["status"], "passed");
        assert_eq!(
            value["receipt"]["gates"]["schema"]["scope"],
            "pinned-engine-validation"
        );
        assert_eq!(
            value["receipt"]["gates"]["artifact"]["scope"],
            "pinned-engine-rendered-html"
        );
        assert_eq!(value["receipt"]["gates"]["browser"]["status"], "not-run");
        assert_eq!(value["receipt"]["gates"]["browser"]["scope"], "none");
        assert_eq!(value["receipt"]["gates"]["visualReview"]["scope"], "manual");
    }

    #[cfg(unix)]
    #[test]
    fn render_rejects_staging_symlink_without_removing_its_target() {
        use std::os::unix::fs::symlink;
        let _lock = lock_env();
        let _job = EnvRestore::set(JOB_ID_ENV, "render-symlink-test");
        if !node_available() {
            eprintln!("skipping: node is not available on PATH");
            return;
        }
        let (_tmp, work) = setup_workspace();
        let external = TempDir::new().unwrap();
        let marker = external.path().join("preserve");
        fs::write(&marker, b"keep").unwrap();
        let staging = Path::new(&work).join(STAGING_DIR);
        fs::create_dir_all(&staging).unwrap();
        symlink(external.path(), staging.join("render-symlink-test")).unwrap();
        let error =
            archify_render_candidate(work, "architecture".into(), VALID_SPEC.into()).unwrap_err();
        assert_eq!(error.code, ARCHIFY_ENGINE_FAILED);
        assert_eq!(fs::read(marker).unwrap(), b"keep");
    }

    #[cfg(unix)]
    #[test]
    fn render_kills_and_reaps_a_timed_out_engine() {
        let _lock = lock_env();
        let _timeout = EnvRestore::set(TIMEOUT_ENV, "300");
        let tmp = TempDir::new().unwrap();
        let fake = tmp.path().join("fake-node");
        let hash = sha256(VALID_SPEC.as_bytes());
        let script = format!(
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo fake; exit 0; fi\nif [ \"$2\" = \"validate\" ]; then echo '{{\"ok\":true,\"candidate\":{{\"sha256\":\"{hash}\"}},\"diagnostics\":[]}}'; exit 0; fi\nsleep 30\n"
        );
        crate::test_support::write_executable_fixture(&fake, &script, 0o755).unwrap();
        let _node = EnvRestore::set(NODE_ENV, fake.to_str().unwrap());
        let (_workspace, work) = setup_workspace();
        let started = Instant::now();
        let error =
            archify_render_candidate(work, "architecture".into(), VALID_SPEC.into()).unwrap_err();
        assert_eq!(error.code, ARCHIFY_RENDER_TIMEOUT);
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[cfg(unix)]
    #[test]
    fn render_timeout_stops_late_descendant_writes() {
        let _lock = lock_env();
        let _timeout = EnvRestore::set(TIMEOUT_ENV, "300");
        let tmp = TempDir::new().unwrap();
        let marker = tmp.path().join("late-descendant-write");
        let _marker = EnvRestore::set("MARU_TEST_ARCHIFY_LATE_MARKER", marker.to_str().unwrap());
        let fake = tmp.path().join("fake-node");
        let hash = sha256(VALID_SPEC.as_bytes());
        let script = format!("#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo fixture; exit 0; fi\nif [ \"$2\" = \"validate\" ]; then echo '{{\"ok\":true,\"candidate\":{{\"sha256\":\"{hash}\"}},\"diagnostics\":[]}}'; exit 0; fi\n(sleep 1; printf late > \"$MARU_TEST_ARCHIFY_LATE_MARKER\") &\nsleep 30\n");
        crate::test_support::write_executable_fixture(&fake, &script, 0o755).unwrap();
        let _node = EnvRestore::set(NODE_ENV, fake.to_str().unwrap());
        let (_workspace, work) = setup_workspace();
        let error =
            archify_render_candidate(work, "architecture".into(), VALID_SPEC.into()).unwrap_err();
        assert_eq!(error.code, ARCHIFY_RENDER_TIMEOUT);
        std::thread::sleep(Duration::from_millis(1200));
        assert!(!marker.exists(), "timed-out engine descendants survived; inspect the process-tree runner before retrying");
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

#[cfg(all(test, unix))]
mod render_worker_boundary_tests {
    use super::ipc;
    use crate::atomic_file::phase08_06::{boundary, Home};
    use std::fs;

    #[test]
    fn render_command_runs_in_worker_and_propagates_worker_failure() {
        let home = Home::new();
        let workspace = home.root.path().join("render-worker-workspace");
        fs::create_dir_all(&workspace).unwrap();
        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        boundary(workspace.clone(), "archify_render_candidate", async move {
            ipc::archify_render_candidate(
                handle,
                workspace.to_string_lossy().into_owned(),
                "architecture".into(),
                "{}".into(),
                None,
            )
            .await
            .map(|_| ())
            .map_err(|error| error.message)
        });
    }
    #[test]
    fn render_with_document_context_publishes_an_immutable_receipt_pair() {
        let _engine = super::ENGINE_ENV_LOCK.lock().unwrap();
        let home = Home::new();
        let workspace = home.root.path().join("stored-render-workspace");
        fs::create_dir_all(workspace.join("diagrams")).unwrap();
        fs::write(
            workspace.join("diagrams/generated.cmd.json"),
            r#"{"id":"stored-doc"}"#,
        )
        .unwrap();
        let app = tauri::test::mock_app();
        let spec = r#"{"schema_version":1,"diagram_type":"architecture","meta":{"title":"Stored fixture","output":"fixture.html"},"layout":{"mode":"grid"},"components":[{"id":"app","label":"App","type":"backend","row":0,"col":0}]}"#;
        let artifact = crate::atomic_file::phase08_06::run(ipc::archify_render_candidate(
            app.handle().clone(),
            workspace.to_string_lossy().into_owned(),
            "architecture".into(),
            spec.into(),
            Some(crate::diagram::renders::RenderDocumentContext {
                doc_id: "stored-doc".into(),
                document_name: "generated".into(),
                document_revision: "d".repeat(64),
                diagram_type: "architecture".into(),
                dataset_id: Some("source-dataset".into()),
            }),
        ))
        .unwrap();
        let groups = crate::diagram::renders::list_renders(workspace.to_str().unwrap()).unwrap();
        assert_eq!(groups.len(), 1);
        assert!(!groups[0].orphaned);
        let entry = &groups[0].renders[0];
        let folder = workspace
            .join("attachments/diagrams/stored-doc/renders")
            .join(&entry.render_id);
        assert_eq!(fs::read(folder.join("index.html")).unwrap(), artifact.bytes);
        let receipt: crate::diagram::renders::DiagramRenderReceipt =
            serde_json::from_slice(&fs::read(folder.join("receipt.json")).unwrap()).unwrap();
        assert_eq!(receipt.render, artifact.receipt);
        assert_eq!(receipt.doc_id, "stored-doc");
        assert_eq!(receipt.document_revision, "d".repeat(64));
        assert_eq!(receipt.dataset_id.as_deref(), Some("source-dataset"));
    }
}
