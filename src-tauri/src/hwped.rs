//! hwped_* commands — thin spawner over the hwp-cli binary backing the
//! hwp-editor Tauri engine (`@hwp-editor/core` `createTauriEngine`).
//!
//! Each command maps 1:1 onto the same CLI invocation the Node CliEngine
//! uses (hwp-editor `packages/server/src/cli-engine.ts`):
//!
//!   hwped_read         hwp cat <in> --format markdown --with-segments
//!   hwped_render       hwp render <in> -o page.<fmt> --format <fmt> --pages <p> --dpi <d> --report <r>
//!   hwped_edit         hwp edit <in> -o <out> <opsArgv...> [--verify] [--allow-partial]
//!   hwped_compose      hwp compose <spec.json> -o <out> --report
//!   hwped_validate     hwp validate <in> --json   (exit 1 still prints the report)
//!   hwped_capabilities hwp --version (>= 0.8.7 required)
//!
//! The JS side does the EditOp -> argv mapping (`opsToArgv`) and sends argv
//! fragments, so this module owns no op grammar. Documents cross the bridge
//! as workspace paths when they are already on disk, base64 bytes otherwise.
//! If render latency ever justifies it, a resident `hwp mcp` process is the
//! documented follow-up (docs/hwp-editor.md) — deliberately not implemented
//! here.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::time::Duration;

use crate::cli_path::{augmented_path, is_executable, resolve_program};
use crate::command_output::{
    run_command_with_timeout_and_limits, CommandTermination, OutputLimits,
};
use crate::win_process::NoWindow;

/// Mirrors the Node engine's 60s timeout and 32MB maxBuffer.
const HWP_TIMEOUT: Duration = Duration::from_secs(60);
const STDOUT_LIMIT: usize = 32 * 1024 * 1024;
const STDERR_LIMIT: usize = 1024 * 1024;
const MIN_VERSION: (u64, u64, u64) = (0, 8, 7);

/// Document reference crossing the bridge (JS `TauriDocumentRef`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HwpedDocumentRef {
    pub name: String,
    /// Workspace-relative or absolute path; preferred over bytes.
    #[serde(default)]
    pub path: Option<String>,
    /// Base64 bytes — only when the document is not on disk.
    #[serde(default)]
    pub data_base64: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct HwpedRenderOptions {
    /// Page range: "1", "1-3", "all" (default "all").
    #[serde(default)]
    pub pages: Option<String>,
    /// Resolution, 36..=600 (default 96).
    #[serde(default)]
    pub dpi: Option<u32>,
    /// "svg" (default) or "png" — hwp-cli renders no other formats.
    #[serde(default)]
    pub format: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HwpedRenderPage {
    pub page: u32,
    pub width: u32,
    pub height: u32,
    pub dpi: u32,
    pub format: String,
    pub data_base64: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct HwpedRenderResponse {
    pub pages: Vec<HwpedRenderPage>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HwpedEditResponse {
    pub name: String,
    pub data_base64: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HwpedComposeResponse {
    pub name: String,
    pub data_base64: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HwpedValidationError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct HwpedValidationReport {
    pub valid: bool,
    pub errors: Vec<HwpedValidationError>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HwpedCapabilities {
    pub version: String,
    pub editable: bool,
    pub formats: Vec<String>,
}

/// Binary resolution, following find_hwpx_tool (export/dispatch.rs):
/// MARU_HWP_BIN override -> PATH (augmented) -> bundled skill fallbacks.
fn find_hwp_tool() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("MARU_HWP_BIN").map(PathBuf::from) {
        if is_executable(&path) {
            return Some(path);
        }
    }
    resolve_program("hwp").or_else(|| {
        let mut candidates = Vec::new();
        if let Some(home) = dirs::home_dir() {
            candidates.push(home.join(".maru/skills/hwpx/hwp"));
            candidates.push(home.join(".maru/skills/_builtin/skills/hwpx/hwp"));
        }
        candidates
            .push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../skills/skills/hwpx/hwp"));
        candidates.into_iter().find(|path| is_executable(path))
    })
}

fn hwp_bin() -> Result<PathBuf, String> {
    find_hwp_tool().ok_or_else(|| {
        "cli_missing: hwp binary not found. Install hwp-cli >= 0.8.7 or set MARU_HWP_BIN"
            .to_string()
    })
}

struct CliRun {
    code: i32,
    stdout: Vec<u8>,
    stderr: String,
}

/// Fixed-argv spawn — no shell, augmented PATH, 60s timeout (fixed_argv /
/// no_window convention from export/dispatch.rs).
fn run_hwp(bin: &Path, args: &[OsString]) -> Result<CliRun, String> {
    let subcommand = args
        .first()
        .map(|arg| arg.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut cmd = Command::new(bin);
    cmd.args(args);
    cmd.env("PATH", augmented_path());
    let output = run_command_with_timeout_and_limits(
        cmd.no_window(),
        HWP_TIMEOUT,
        OutputLimits::new(STDOUT_LIMIT, STDERR_LIMIT),
        |_, _| false,
    )
    .map_err(|err| format!("hwp_spawn_failed: hwp {subcommand}: {err}"))?;
    match output.termination {
        CommandTermination::TimedOut => Err(format!(
            "hwp_timeout: hwp {subcommand} timed out after {}s",
            HWP_TIMEOUT.as_secs()
        )),
        CommandTermination::Aborted => Err(format!("hwp_aborted: hwp {subcommand}")),
        CommandTermination::Exited => Ok(CliRun {
            code: output.status.code().unwrap_or(1),
            stdout: output.stdout,
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        }),
    }
}

/// Run a command that must succeed; error with stderr detail otherwise.
fn run_hwp_ok(bin: &Path, args: &[OsString]) -> Result<Vec<u8>, String> {
    let run = run_hwp(bin, args)?;
    if run.code != 0 {
        let subcommand = args
            .first()
            .map(|arg| arg.to_string_lossy().to_string())
            .unwrap_or_default();
        return Err(format!(
            "hwp_failed: hwp {subcommand} failed (exit {}): {}",
            run.code, run.stderr
        ));
    }
    Ok(run.stdout)
}

fn parse_version(stdout: &[u8]) -> Option<(u64, u64, u64)> {
    let text = String::from_utf8_lossy(stdout);
    let mut parts = text.split_whitespace().find_map(|token| {
        let nums: Vec<u64> = token
            .trim_start_matches('v')
            .split('.')
            .map(|part| part.parse::<u64>().ok())
            .collect::<Option<Vec<_>>>()?;
        (nums.len() == 3).then_some(nums)
    })?;
    Some((parts.remove(0), parts.remove(0), parts.remove(0)))
}

fn version_at_least(v: (u64, u64, u64), min: (u64, u64, u64)) -> bool {
    v >= min
}

/// One version verification per resolved binary per process (mirrors the
/// Node engine's memoized ensureVersion).
fn ensure_version(bin: &Path) -> Result<&'static str, String> {
    static VERSION: OnceLock<Result<String, String>> = OnceLock::new();
    VERSION
        .get_or_init(|| {
            let stdout = run_hwp(bin, &[OsString::from("--version")])?;
            let Some(version) = parse_version(&stdout.stdout) else {
                return Err(format!(
                    "hwp_version: cannot parse hwp --version output: {}",
                    String::from_utf8_lossy(&stdout.stdout).trim()
                ));
            };
            if !version_at_least(version, MIN_VERSION) {
                return Err(format!(
                    "hwp_version: hwp {}.{}.{} is too old; >= {}.{}.{} required ({})",
                    version.0,
                    version.1,
                    version.2,
                    MIN_VERSION.0,
                    MIN_VERSION.1,
                    MIN_VERSION.2,
                    bin.display()
                ));
            }
            Ok(format!("{}.{}.{}", version.0, version.1, version.2))
        })
        .as_deref()
        .map_err(Clone::clone)
}

/// Extension from the file name; unknown names are staged as .hwpx (the
/// Node engine additionally sniffs the CFBF signature — names from the
/// editor always carry an extension, so this stays name-based).
fn sniff_extension(name: &str) -> &'static str {
    let lower = name.to_lowercase();
    if lower.ends_with(".hwp") {
        ".hwp"
    } else {
        ".hwpx"
    }
}

/// Resolve the document to an on-disk path: an existing workspace file
/// (absolute, or relative to workspace_root with an escape guard), or a
/// staged temp file from base64 bytes.
fn stage_document(
    dir: &Path,
    document: &HwpedDocumentRef,
    workspace_root: Option<&str>,
) -> Result<PathBuf, String> {
    if let Some(path) = document
        .path
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        let candidate = PathBuf::from(path);
        if candidate.is_absolute() {
            return Ok(candidate);
        }
        let root = workspace_root
            .map(str::trim)
            .filter(|root| !root.is_empty())
            .ok_or_else(|| {
                "hwped_bad_request: relative document.path requires workspaceRoot".to_string()
            })?;
        let canonical_root = std::fs::canonicalize(root)
            .map_err(|err| format!("hwped_bad_request: workspaceRoot not readable: {err}"))?;
        let joined = canonical_root.join(candidate);
        let canonical = std::fs::canonicalize(&joined)
            .map_err(|err| format!("hwped_bad_request: document not found: {path} ({err})"))?;
        if !canonical.starts_with(&canonical_root) {
            return Err(format!(
                "hwped_bad_request: document path escapes workspaceRoot: {path}"
            ));
        }
        return Ok(canonical);
    }
    let Some(data_base64) = document.data_base64.as_deref() else {
        return Err("hwped_bad_request: document requires path or dataBase64".to_string());
    };
    let bytes = BASE64
        .decode(data_base64)
        .map_err(|err| format!("hwped_bad_request: document.dataBase64 is not base64: {err}"))?;
    if bytes.is_empty() {
        return Err("hwped_bad_request: document.dataBase64 is empty".to_string());
    }
    let file = dir.join(format!("in{}", sniff_extension(&document.name)));
    std::fs::write(&file, bytes).map_err(|err| format!("hwp_stage_failed: {err}"))?;
    Ok(file)
}

fn read_now(document: HwpedDocumentRef, workspace_root: Option<String>) -> Result<Value, String> {
    let bin = hwp_bin()?;
    ensure_version(&bin)?;
    let tmp = tempfile::tempdir().map_err(|err| format!("hwp_stage_failed: {err}"))?;
    let input = stage_document(tmp.path(), &document, workspace_root.as_deref())?;
    let stdout = run_hwp_ok(
        &bin,
        &[
            OsString::from("cat"),
            input.into_os_string(),
            OsString::from("--format"),
            OsString::from("markdown"),
            OsString::from("--with-segments"),
        ],
    )?;
    serde_json::from_slice(&stdout)
        .map_err(|err| format!("hwp_parse_failed: cat envelope is not JSON: {err}"))
}

fn png_size(data: &[u8]) -> Option<(u32, u32)> {
    if data.len() < 24 {
        return None;
    }
    let width = u32::from_be_bytes([data[16], data[17], data[18], data[19]]);
    let height = u32::from_be_bytes([data[20], data[21], data[22], data[23]]);
    Some((width, height))
}

fn svg_size(source: &str) -> Option<(u32, u32)> {
    let tag_start = source.find("<svg")?;
    let tag_end = source[tag_start..].find('>')? + tag_start;
    let tag = &source[tag_start..=tag_end];
    let attr = |name: &str| -> Option<u32> {
        let key = format!("{name}=\"");
        let value_start = tag.find(&key)? + key.len();
        let rest = &tag[value_start..];
        let value_end = rest.find('"')?;
        rest[..value_end]
            .trim_end_matches("pt")
            .trim_end_matches("px")
            .parse::<f64>()
            .ok()
            .map(|v| v.round() as u32)
    };
    Some((attr("width")?, attr("height")?))
}

fn render_attempt(
    bin: &Path,
    dir: &Path,
    input: &Path,
    format: &str,
    pages: &str,
    dpi: u32,
) -> Result<Vec<HwpedRenderPage>, String> {
    let out_base = dir.join(format!("page.{format}"));
    let report_path = dir.join(format!("render-report-{format}.json"));
    run_hwp_ok(
        bin,
        &[
            OsString::from("render"),
            input.as_os_str().to_os_string(),
            OsString::from("-o"),
            out_base.into_os_string(),
            OsString::from("--format"),
            OsString::from(format),
            OsString::from("--pages"),
            OsString::from(pages),
            OsString::from("--dpi"),
            OsString::from(dpi.to_string()),
            OsString::from("--report"),
            report_path.as_os_str().to_os_string(),
        ],
    )?;
    // Multi-page renders land as page-<n>.<ext>; a single selected page keeps
    // the exact -o name. The report's selected_pages pins page numbers.
    let prefix = format!("page.{format}");
    let numbered = "page-";
    let mut files: Vec<(u32, PathBuf)> = Vec::new();
    let entries = std::fs::read_dir(dir).map_err(|err| format!("hwp_stage_failed: {err}"))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == prefix {
            files.push((0, entry.path()));
        } else if name.starts_with(numbered) && name.ends_with(&format!(".{format}")) {
            let num = name[numbered.len()..name.len() - format.len() - 1]
                .parse::<u32>()
                .unwrap_or(0);
            files.push((num, entry.path()));
        }
    }
    files.sort_by_key(|(num, _)| *num);
    let selected: Vec<u32> = std::fs::read(&report_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|report| report.get("selected_pages")?.as_array().cloned())
        .map(|pages| {
            pages
                .iter()
                .filter_map(|page| page.as_u64().map(|n| n as u32))
                .collect()
        })
        .unwrap_or_default();
    let single_page: Option<u32> = if pages.chars().all(|c| c.is_ascii_digit()) {
        pages.parse::<u32>().ok()
    } else {
        None
    };
    let mut images = Vec::new();
    for (index, (num, file)) in files.iter().enumerate() {
        let data = std::fs::read(file).map_err(|err| format!("hwp_stage_failed: {err}"))?;
        let page = if *num > 0 {
            *num
        } else {
            selected
                .get(index)
                .copied()
                .or(single_page)
                .unwrap_or(index as u32 + 1)
        };
        let size = if format == "png" {
            png_size(&data)
        } else {
            svg_size(&String::from_utf8_lossy(&data))
        };
        images.push(HwpedRenderPage {
            page,
            width: size.map(|(w, _)| w).unwrap_or(0),
            height: size.map(|(_, h)| h).unwrap_or(0),
            dpi,
            format: format.to_string(),
            data_base64: BASE64.encode(&data),
        });
    }
    Ok(images)
}

fn render_now(
    document: HwpedDocumentRef,
    options: HwpedRenderOptions,
    workspace_root: Option<String>,
) -> Result<HwpedRenderResponse, String> {
    let bin = hwp_bin()?;
    ensure_version(&bin)?;
    let requested = options.format.as_deref().unwrap_or("svg").to_string();
    if requested != "svg" && requested != "png" {
        return Err(format!(
            "hwped_bad_request: hwp-cli render supports png and svg only; got \"{requested}\""
        ));
    }
    let dpi = options.dpi.unwrap_or(96);
    if !(36..=600).contains(&dpi) {
        return Err(format!(
            "hwped_bad_request: dpi must be within 36..=600; got {dpi}"
        ));
    }
    let pages = options.pages.as_deref().unwrap_or("all").to_string();
    let valid_range = pages == "all"
        || (pages.chars().all(|c| c.is_ascii_digit() || c == '-')
            && pages.split('-').all(|part| !part.is_empty())
            && pages.split('-').count() <= 2);
    if !valid_range {
        return Err(format!("hwped_bad_request: invalid page range: {pages}"));
    }
    let tmp = tempfile::tempdir().map_err(|err| format!("hwp_stage_failed: {err}"))?;
    let input = stage_document(tmp.path(), &document, workspace_root.as_deref())?;
    match render_attempt(&bin, tmp.path(), &input, &requested, &pages, dpi) {
        Ok(images) => Ok(HwpedRenderResponse { pages: images }),
        // SVG is the default; fall back to PNG when the renderer refuses.
        Err(err) if requested == "svg" && err.starts_with("hwp_failed:") => {
            let images = render_attempt(&bin, tmp.path(), &input, "png", &pages, dpi)?;
            Ok(HwpedRenderResponse { pages: images })
        }
        Err(err) => Err(err),
    }
}

/// Basename + validated extension, so a hostile name can never escape tmp.
fn safe_output_name(name: &str, fallback_ext: &str) -> String {
    let base = Path::new(name)
        .file_name()
        .map(|stem| stem.to_string_lossy().to_string())
        .filter(|stem| !stem.is_empty())
        .unwrap_or_else(|| format!("document{fallback_ext}"));
    let sanitized: String = base
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '.' | '_' | '-') || ('가'..='힣').contains(&c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    let lower = sanitized.to_lowercase();
    if lower.ends_with(".hwp") || lower.ends_with(".hwpx") {
        sanitized
    } else {
        format!("{sanitized}{fallback_ext}")
    }
}

fn edit_now(
    document: HwpedDocumentRef,
    ops_argv: Vec<String>,
    verify: Option<bool>,
    allow_partial: Option<bool>,
    workspace_root: Option<String>,
) -> Result<HwpedEditResponse, String> {
    let bin = hwp_bin()?;
    ensure_version(&bin)?;
    // opsArgv arrives as JS-side opsToArgv output: flag/value pairs. The
    // sanity check catches malformed calls; argv injection is impossible
    // because spawning never goes through a shell.
    if ops_argv.len() % 2 != 0 || ops_argv.iter().step_by(2).any(|a| !a.starts_with("--")) {
        return Err(
            "hwped_bad_request: opsArgv must be --flag value pairs (opsToArgv output)".to_string(),
        );
    }
    let tmp = tempfile::tempdir().map_err(|err| format!("hwp_stage_failed: {err}"))?;
    let input = stage_document(tmp.path(), &document, workspace_root.as_deref())?;
    let ext = sniff_extension(&document.name);
    let output = tmp.path().join(format!("out{ext}"));
    let mut args = vec![
        OsString::from("edit"),
        input.into_os_string(),
        OsString::from("-o"),
        output.clone().into_os_string(),
    ];
    args.extend(ops_argv.into_iter().map(OsString::from));
    if verify != Some(false) {
        args.push(OsString::from("--verify"));
    }
    if allow_partial == Some(true) {
        args.push(OsString::from("--allow-partial"));
    }
    run_hwp_ok(&bin, &args)?;
    let data = std::fs::read(&output).map_err(|err| format!("hwp_stage_failed: {err}"))?;
    Ok(HwpedEditResponse {
        name: document.name,
        data_base64: BASE64.encode(&data),
    })
}

fn compose_now(spec: Value, name: String) -> Result<HwpedComposeResponse, String> {
    let bin = hwp_bin()?;
    ensure_version(&bin)?;
    if name.trim().is_empty() {
        return Err("hwped_bad_request: compose requires a non-empty name".to_string());
    }
    let tmp = tempfile::tempdir().map_err(|err| format!("hwp_stage_failed: {err}"))?;
    let spec_path = tmp.path().join("spec.json");
    std::fs::write(&spec_path, serde_json::to_vec(&spec).unwrap_or_default())
        .map_err(|err| format!("hwp_stage_failed: {err}"))?;
    let out_name = safe_output_name(&name, ".hwpx");
    let out_path = tmp.path().join(&out_name);
    let stdout = run_hwp_ok(
        &bin,
        &[
            OsString::from("compose"),
            spec_path.into_os_string(),
            OsString::from("-o"),
            out_path.clone().into_os_string(),
            OsString::from("--report"),
        ],
    )?;
    let report = serde_json::from_slice::<Value>(&stdout).ok();
    let data = std::fs::read(&out_path).map_err(|err| format!("hwp_stage_failed: {err}"))?;
    Ok(HwpedComposeResponse {
        name: out_name,
        data_base64: BASE64.encode(&data),
        report,
    })
}

fn validate_now(
    document: HwpedDocumentRef,
    workspace_root: Option<String>,
) -> Result<HwpedValidationReport, String> {
    let bin = hwp_bin()?;
    ensure_version(&bin)?;
    let tmp = tempfile::tempdir().map_err(|err| format!("hwp_stage_failed: {err}"))?;
    let input = stage_document(tmp.path(), &document, workspace_root.as_deref())?;
    // Exit 1 means "invalid" and still prints the JSON report.
    let run = run_hwp(
        &bin,
        &[
            OsString::from("validate"),
            input.into_os_string(),
            OsString::from("--json"),
        ],
    )?;
    let parsed: Value = serde_json::from_slice(&run.stdout).map_err(|err| {
        format!(
            "hwp_parse_failed: hwp validate failed (exit {}): {} ({err})",
            run.code, run.stderr
        )
    })?;
    let errors = parsed
        .get("errors")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .map(|entry| HwpedValidationError {
                    code: "invalid".to_string(),
                    message: entry
                        .as_str()
                        .map(str::to_string)
                        .unwrap_or_else(|| entry.to_string()),
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(HwpedValidationReport {
        valid: parsed.get("valid").and_then(Value::as_bool) == Some(true),
        errors,
    })
}

fn capabilities_now() -> Result<HwpedCapabilities, String> {
    let bin = hwp_bin()?;
    let version = ensure_version(&bin)?;
    Ok(HwpedCapabilities {
        version: version.to_string(),
        editable: true,
        formats: vec!["hwp".to_string(), "hwpx".to_string()],
    })
}

#[tauri::command]
pub async fn hwped_read(
    document: HwpedDocumentRef,
    workspace_root: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || read_now(document, workspace_root))
        .await
        .map_err(|err| format!("hwped_task_failed: {err}"))?
}

#[tauri::command]
pub async fn hwped_render(
    document: HwpedDocumentRef,
    options: Option<HwpedRenderOptions>,
    workspace_root: Option<String>,
) -> Result<HwpedRenderResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        render_now(document, options.unwrap_or_default(), workspace_root)
    })
    .await
    .map_err(|err| format!("hwped_task_failed: {err}"))?
}

#[tauri::command]
pub async fn hwped_edit(
    document: HwpedDocumentRef,
    ops_argv: Vec<String>,
    verify: Option<bool>,
    allow_partial: Option<bool>,
    workspace_root: Option<String>,
) -> Result<HwpedEditResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        edit_now(document, ops_argv, verify, allow_partial, workspace_root)
    })
    .await
    .map_err(|err| format!("hwped_task_failed: {err}"))?
}

#[tauri::command]
pub async fn hwped_compose(spec: Value, name: String) -> Result<HwpedComposeResponse, String> {
    tauri::async_runtime::spawn_blocking(move || compose_now(spec, name))
        .await
        .map_err(|err| format!("hwped_task_failed: {err}"))?
}

#[tauri::command]
pub async fn hwped_validate(
    document: HwpedDocumentRef,
    workspace_root: Option<String>,
) -> Result<HwpedValidationReport, String> {
    tauri::async_runtime::spawn_blocking(move || validate_now(document, workspace_root))
        .await
        .map_err(|err| format!("hwped_task_failed: {err}"))?
}

#[tauri::command]
pub async fn hwped_capabilities() -> Result<HwpedCapabilities, String> {
    tauri::async_runtime::spawn_blocking(capabilities_now)
        .await
        .map_err(|err| format!("hwped_task_failed: {err}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_version_reads_semver_triplets() {
        assert_eq!(parse_version(b"hwp 0.8.7"), Some((0, 8, 7)));
        assert_eq!(parse_version(b"hwp-cli v1.2.3 (build)"), Some((1, 2, 3)));
        assert_eq!(parse_version(b"no version here"), None);
    }

    #[test]
    fn safe_output_name_strips_dirs_and_forces_extension() {
        assert_eq!(safe_output_name("../etc/evil", ".hwpx"), "evil.hwpx");
        assert_eq!(safe_output_name("보고서.hwpx", ".hwpx"), "보고서.hwpx");
        assert_eq!(safe_output_name("a b/c.hwp", ".hwpx"), "c.hwp");
        assert_eq!(safe_output_name("", ".hwpx"), "document.hwpx");
    }

    #[test]
    fn stage_document_rejects_relative_path_without_root() {
        let tmp = tempfile::tempdir().unwrap();
        let doc = HwpedDocumentRef {
            name: "a.hwpx".to_string(),
            path: Some("docs/a.hwpx".to_string()),
            data_base64: None,
        };
        let err = stage_document(tmp.path(), &doc, None).unwrap_err();
        assert!(err.contains("workspaceRoot"));
    }

    #[test]
    fn stage_document_blocks_workspace_escape() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("root");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(tmp.path().join("outside.hwpx"), b"x").unwrap();
        let doc = HwpedDocumentRef {
            name: "outside.hwpx".to_string(),
            path: Some("../outside.hwpx".to_string()),
            data_base64: None,
        };
        let err = stage_document(tmp.path(), &doc, Some(root.to_str().unwrap())).unwrap_err();
        assert!(err.contains("escapes workspaceRoot"));
    }

    #[test]
    fn stage_document_writes_base64_bytes() {
        let tmp = tempfile::tempdir().unwrap();
        let doc = HwpedDocumentRef {
            name: "a.hwpx".to_string(),
            path: None,
            data_base64: Some(BASE64.encode(b"payload")),
        };
        let staged = stage_document(tmp.path(), &doc, None).unwrap();
        assert_eq!(std::fs::read(&staged).unwrap(), b"payload");
        assert!(staged.ends_with("in.hwpx"));
    }

    #[test]
    fn svg_and_png_size_sniffers() {
        assert_eq!(
            svg_size(r#"<svg width="595.0pt" height="842pt">"#),
            Some((595, 842))
        );
        let mut png = vec![0u8; 24];
        png[16..20].copy_from_slice(&595u32.to_be_bytes());
        png[20..24].copy_from_slice(&842u32.to_be_bytes());
        assert_eq!(png_size(&png), Some((595, 842)));
    }
}
