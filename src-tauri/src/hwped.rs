//! hwped_* commands — thin spawner over the hwp-cli binary backing the
//! hwp-editor Tauri engine (`@hwp-editor/core` `createTauriEngine`).
//!
//! Each command maps 1:1 onto the same CLI invocation the Node CliEngine
//! uses (hwp-editor `packages/server/src/cli-engine.ts`):
//!
//!   hwped_read         hwp cat <in> --format markdown --with-segments
//!                      + hwp info <in> --json --body-stats (optional bodyTables, >= 0.19.2)
//!   hwped_render       hwp render <in> -o page.<fmt> --format <fmt> --pages <p> --dpi <d> --report <r> --layout-json <l>
//!   hwped_edit         hwp edit <in> -o <out> (--ops <json> | <opsArgv...>) [--verify] [--allow-partial]
//!   hwped_compose      hwp compose <spec.json> -o <out> --report
//!   hwped_validate     hwp validate <in> --json   (exit 1 still prints the report)
//!   hwped_capabilities hwp --version (>= 0.8.7; JSON/layout require >= 0.20.0)
//!
//! JSON edit arrays are staged per call; legacy clients can still send argv
//! fragments (`opsToArgv`). This module owns no op grammar. Documents cross the bridge
//! as workspace paths when they are already on disk, base64 bytes otherwise.
//! If render latency ever justifies it, a resident `hwp mcp` process is the
//! documented follow-up (docs/hwp-editor.md) — deliberately not implemented
//! here.

#[cfg(test)]
use crate::atomic_file::PathTransactionLease;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use crate::cli_path::{augmented_path, is_executable, resolve_program};
use crate::command_output::{
    run_command_with_timeout_and_limits, CommandTermination, OutputLimits,
};
use crate::paths::{ensure_within, lexical_normalize};
use crate::win_process::NoWindow;

/// Mirrors the Node engine's 60s timeout and 32MB maxBuffer.
const HWP_TIMEOUT: Duration = Duration::from_secs(60);
const STDOUT_LIMIT: usize = 32 * 1024 * 1024;
const STDERR_LIMIT: usize = 1024 * 1024;
const MIN_VERSION: (u64, u64, u64) = (0, 8, 7);
const FEATURE_MIN_VERSION: (u64, u64, u64) = (0, 20, 0);
/// `hwp info --body-stats` landed in hwp-cli 0.19.2 (its CHANGELOG, "Table
/// placement switch"). Below it the read still answers, without `bodyTables`.
const BODY_STATS_MIN_VERSION: (u64, u64, u64) = (0, 19, 2);

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
    /// None requests layout automatically only when the binary supports it.
    #[serde(default)]
    pub layout: Option<bool>,
}

/// Geometry in points; source_chars remain source WCHAR offsets, never JS slices.
#[derive(Debug, Clone, Serialize)]
pub struct HwpedPageLayout {
    pub width_pt: f64,
    pub height_pt: f64,
    /// Preserve row order, repeated segment IDs and nullable box/range fields.
    pub rows: Vec<Value>,
    pub truncated: bool,
}

#[derive(Deserialize)]
struct RenderLayoutArtifact {
    contract: String,
    schema_version: String,
    truncated: bool,
    selected_pages: Vec<u32>,
    pages: Vec<RenderLayoutPage>,
}

#[derive(Deserialize)]
struct RenderLayoutPage {
    page: u32,
    width_pt: f64,
    height_pt: f64,
    rows: Vec<Value>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layout: Option<HwpedPageLayout>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HwpedRenderNote {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct HwpedRenderResponse {
    pub pages: Vec<HwpedRenderPage>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<HwpedRenderNote>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LayoutMetadataMode {
    Disabled,
    Optional,
    Required,
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
    #[serde(rename = "editOps", skip_serializing_if = "Option::is_none")]
    pub edit_ops: Option<&'static str>,
    pub version: String,
    pub editable: bool,
    pub formats: Vec<String>,
}

/// Binary resolution: MARU_HWP_BIN override -> `hwp` on the (augmented) PATH.
fn find_hwp_tool() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("MARU_HWP_BIN").map(PathBuf::from) {
        if is_executable(&path) {
            return Some(path);
        }
    }
    resolve_program("hwp")
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

struct CachedVersion {
    modified: SystemTime,
    version: String,
}

type VersionCache = BTreeMap<(PathBuf, PathBuf), CachedVersion>;
static VERSIONS: OnceLock<Mutex<VersionCache>> = OnceLock::new();

fn invalidate_version(bin: &Path) {
    if let Some(cache) = VERSIONS.get() {
        if let Ok(mut versions) = cache.lock() {
            versions.retain(|(logical, _), _| logical.as_path() != bin);
        }
    }
}

/// A manager shim may change its selected engine without changing its mtime.
/// Preserve the command error, but make the next feature call re-probe it.
fn run_hwp_feature_ok(bin: &Path, args: &[OsString]) -> Result<Vec<u8>, String> {
    let result = run_hwp_ok(bin, args);
    if matches!(&result, Err(error) if error.starts_with("hwp_failed:")) {
        invalidate_version(bin);
    }
    result
}

#[cfg(any(windows, test))]
fn windows_metadata_target(bin: &Path, is_file: impl Fn(&Path) -> bool) -> PathBuf {
    if bin
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
    {
        return bin.to_path_buf();
    }
    let mut executable = bin.as_os_str().to_os_string();
    executable.push(".exe");
    let executable = PathBuf::from(executable);
    if is_file(&executable) {
        executable
    } else {
        bin.to_path_buf()
    }
}

fn version_metadata_path(bin: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        windows_metadata_target(bin, Path::is_file)
    }
    #[cfg(not(windows))]
    {
        bin.to_path_buf()
    }
}

/// Re-probe each logical invocation when its canonical executable is replaced.
/// The caller's path is used for execution so symlink shims retain argv[0].
fn ensure_version(bin: &Path) -> Result<String, String> {
    let metadata_path = version_metadata_path(bin);
    let canonical_path =
        std::fs::canonicalize(&metadata_path).unwrap_or_else(|_| bin.to_path_buf());
    let modified = std::fs::metadata(&metadata_path)
        .and_then(|metadata| metadata.modified())
        .ok();
    let cache_key = modified.map(|modified| ((bin.to_path_buf(), canonical_path), modified));

    if let Some(((logical_path, canonical_path), modified)) = &cache_key {
        let versions = VERSIONS
            .get_or_init(|| Mutex::new(BTreeMap::new()))
            .lock()
            .map_err(|_| {
                "hwp_version: version cache lock is poisoned; restart Maru and retry".to_string()
            })?;
        if let Some(cached) = versions
            .get(&(logical_path.clone(), canonical_path.clone()))
            .filter(|cached| cached.modified == *modified)
        {
            return Ok(cached.version.clone());
        }
    }

    let stdout = run_hwp_ok(bin, &[OsString::from("--version")]).map_err(|cause| {
        format!(
            "hwp_version: cannot query the selected hwp binary: {cause}; check MARU_HWP_BIN or PATH and retry"
        )
    })?;
    let version = parse_version(&stdout).ok_or_else(|| {
        "hwp_version: cannot parse hwp --version output; install a supported hwp-cli release and retry".to_string()
    })?;
    if !version_at_least(version, MIN_VERSION) {
        return Err(format!(
            "hwp_version: hwp {}.{}.{} is too old; >= 0.8.7 required; update hwp-cli or set MARU_HWP_BIN to a supported binary and retry",
            version.0, version.1, version.2,
        ));
    }
    let text = format!("{}.{}.{}", version.0, version.1, version.2);
    if let Some(((logical_path, canonical_path), modified)) = cache_key {
        VERSIONS
            .get_or_init(|| Mutex::new(BTreeMap::new()))
            .lock()
            .map_err(|_| {
                "hwp_version: version cache lock is poisoned; restart Maru and retry".to_string()
            })?
            .insert(
                (logical_path, canonical_path),
                CachedVersion {
                    modified,
                    version: text.clone(),
                },
            );
    }
    Ok(text)
}

#[cfg(test)]
#[path = "hwped/version_tests.rs"]
mod version_tests;

#[cfg(all(test, unix))]
#[path = "hwped/retry_tests.rs"]
mod retry_tests;

/// Legacy failures retain their original string wire shape. New feature
/// refusals use the app's structured IPC error without flattening its code.
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum HwpedBridgeError {
    Legacy(String),
    FeatureVersion(crate::ipc_error::IpcError),
}

impl From<String> for HwpedBridgeError {
    fn from(message: String) -> Self {
        Self::Legacy(message)
    }
}

impl std::fmt::Display for HwpedBridgeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Legacy(message) => formatter.write_str(message),
            Self::FeatureVersion(error) => std::fmt::Display::fmt(error, formatter),
        }
    }
}

fn supports_feature_version(version: &str) -> bool {
    parse_version(version.as_bytes())
        .is_some_and(|version| version_at_least(version, FEATURE_MIN_VERSION))
}

fn require_feature_version(version: &str, feature: &str) -> Result<(), HwpedBridgeError> {
    if supports_feature_version(version) {
        return Ok(());
    }
    Err(HwpedBridgeError::FeatureVersion(crate::ipc_error::IpcError {
        code: crate::ipc_error::HWPED_FEATURE_REQUIRES_VERSION.to_string(),
        message: format!("{feature} requires hwp-cli >= 0.20.0; detected {version}. Upgrade hwp-cli to 0.20.0 or later, or set MARU_HWP_BIN before restarting Maru, then retry."),
    }))
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
        // Containment is lexical (crate::paths::ensure_within, SCAN-03).
        // canonicalize() here would follow symlinks, so a deliberate
        // workspace symlink whose target sits outside the workspace - the
        // documented inbox layout - would falsely read as an escape. `..`
        // traversal is still blocked, by lexical_normalize.
        ensure_within(&canonical_root, &joined).map_err(|_| {
            format!("hwped_bad_request: document path escapes workspaceRoot: {path}")
        })?;
        let resolved = lexical_normalize(&joined);
        if !resolved.exists() {
            return Err(format!("hwped_bad_request: document not found: {path}"));
        }
        return Ok(resolved);
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
    let version = ensure_version(&bin)?;
    let tmp = tempfile::tempdir().map_err(|err| format!("hwp_stage_failed: {err}"))?;
    let input = stage_document(tmp.path(), &document, workspace_root.as_deref())?;
    let stdout = run_hwp_ok(
        &bin,
        &[
            OsString::from("cat"),
            input.as_os_str().to_os_string(),
            OsString::from("--format"),
            OsString::from("markdown"),
            OsString::from("--with-segments"),
        ],
    )?;
    let mut envelope: Value = serde_json::from_slice(&stdout)
        .map_err(|err| format!("hwp_parse_failed: cat envelope is not JSON: {err}"))?;
    if let Some(tables) = body_table_count(&bin, &version, &input) {
        if let Some(object) = envelope.as_object_mut() {
            object.insert("bodyTables".to_string(), Value::from(tables));
        }
    }
    Ok(envelope)
}

/// The engine's own table count for the staged document (`hwp info --json
/// --body-stats`, field `body.tables`). It counts tables the segment envelope
/// publishes no segment for, which is the disagreement the editor's table-index
/// guard watches. Nothing here may fail the read: a body walk can fail on a
/// document plain `info` still answers, and a missing count only leaves the
/// guard off, as it was before this field existed.
fn body_table_count(bin: &Path, version: &str, input: &Path) -> Option<u64> {
    let supported = parse_version(version.as_bytes())
        .is_some_and(|version| version_at_least(version, BODY_STATS_MIN_VERSION));
    if !supported {
        return None;
    }
    let run = run_hwp(
        bin,
        &[
            OsString::from("info"),
            input.as_os_str().to_os_string(),
            OsString::from("--json"),
            OsString::from("--body-stats"),
        ],
    )
    .ok()?;
    if run.code != 0 {
        return None;
    }
    let info: Value = serde_json::from_slice(&run.stdout).ok()?;
    info.get("body")?.get("tables")?.as_u64()
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

fn invalid_render_layout(cause: impl std::fmt::Display) -> String {
    format!("hwp_parse_failed: invalid render layout metadata: {cause}; use hwp-cli that emits hwp-render-layout-v1 schema 1.x and render again")
}

fn validate_layout_row(row: &Value) -> Result<(), String> {
    if !row
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.is_empty())
    {
        return Err(invalid_render_layout("row.id must be a nonempty string"));
    }
    if !row
        .get("kind")
        .and_then(Value::as_str)
        .is_some_and(|kind| matches!(kind, "para" | "table" | "cell" | "bookmark"))
    {
        return Err(invalid_render_layout("row.kind is unsupported"));
    }
    match row.get("box") {
        Some(Value::Null) => {}
        Some(box_) => {
            let coordinates = ["x0", "y0", "x1", "y1"].map(|key| {
                box_.get(key)
                    .and_then(Value::as_f64)
                    .filter(|value| value.is_finite())
            });
            let [Some(_x0), Some(_y0), Some(_x1), Some(_y1)] = coordinates else {
                return Err(invalid_render_layout(
                    "row.box requires four finite coordinates or null",
                ));
            };
        }
        None => {
            return Err(invalid_render_layout(
                "row.box is missing; emit a box or null",
            ))
        }
    }
    match row.get("source_chars") {
        Some(Value::Null) => {}
        Some(range) => {
            let offset = |key| {
                range
                    .get(key)
                    .and_then(Value::as_u64)
                    .filter(|value| *value <= 9_007_199_254_740_991)
            };
            let (Some(start), Some(end)) = (offset("start"), offset("end")) else {
                return Err(invalid_render_layout(
                    "row.source_chars requires nonnegative safe integer offsets or null",
                ));
            };
            if start > end {
                return Err(invalid_render_layout(
                    "row.source_chars offsets must be ordered",
                ));
            }
        }
        None => {
            return Err(invalid_render_layout(
                "row.source_chars is missing; emit a range or null",
            ))
        }
    }
    Ok(())
}

fn parse_render_layouts(bytes: &[u8]) -> Result<BTreeMap<u32, HwpedPageLayout>, String> {
    let artifact: RenderLayoutArtifact =
        serde_json::from_slice(bytes).map_err(invalid_render_layout)?;
    let minor = artifact.schema_version.strip_prefix("1.").unwrap_or("");
    if artifact.contract != "hwp-render-layout-v1"
        || minor.is_empty()
        || !minor.chars().all(|c| c.is_ascii_digit())
    {
        return Err(invalid_render_layout(
            "expected hwp-render-layout-v1 contract and schema_version 1.x",
        ));
    }
    let selected: BTreeSet<_> = artifact.selected_pages.iter().copied().collect();
    if selected.is_empty()
        || selected.contains(&0)
        || selected.len() != artifact.selected_pages.len()
    {
        return Err(invalid_render_layout(
            "selected_pages must contain unique positive page numbers",
        ));
    }
    let mut layouts = BTreeMap::new();
    for page in artifact.pages {
        if !selected.contains(&page.page) || layouts.contains_key(&page.page) {
            return Err(invalid_render_layout(
                "layout pages must uniquely match selected_pages",
            ));
        }
        if !page.width_pt.is_finite()
            || page.width_pt <= 0.0
            || !page.height_pt.is_finite()
            || page.height_pt <= 0.0
        {
            return Err(invalid_render_layout(
                "page dimensions must be positive finite points",
            ));
        }
        for row in &page.rows {
            validate_layout_row(row)?;
        }
        layouts.insert(
            page.page,
            HwpedPageLayout {
                width_pt: page.width_pt,
                height_pt: page.height_pt,
                rows: page.rows,
                truncated: artifact.truncated,
            },
        );
    }
    if layouts.len() != selected.len() {
        return Err(invalid_render_layout(
            "layout pages must account for every selected page",
        ));
    }
    Ok(layouts)
}

fn read_render_layouts(file: &Path) -> Result<Option<BTreeMap<u32, HwpedPageLayout>>, String> {
    match std::fs::read(file) {
        Ok(bytes) => parse_render_layouts(&bytes).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("hwp_stage_failed: could not read render layout metadata: {error}; check temporary storage permissions and render again")),
    }
}

fn render_attempt(
    bin: &Path,
    dir: &Path,
    input: &Path,
    format: &str,
    pages: &str,
    dpi: u32,
    layout_mode: LayoutMetadataMode,
) -> Result<(Vec<HwpedRenderPage>, Vec<HwpedRenderNote>), String> {
    let include_layout = layout_mode != LayoutMetadataMode::Disabled;
    let out_base = dir.join(format!("page.{format}"));
    let report_path = dir.join(format!("render-report-{format}.json"));
    let layout_path = dir.join(format!("render-layout-{format}.json"));
    let mut args = vec![
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
    ];
    if include_layout {
        args.extend([
            OsString::from("--layout-json"),
            layout_path.as_os_str().to_os_string(),
        ]);
    }
    if include_layout {
        run_hwp_feature_ok(bin, &args)?;
    } else {
        run_hwp_ok(bin, &args)?;
    }
    let mut notes = Vec::new();
    let mut layouts = match layout_mode {
        LayoutMetadataMode::Disabled => None,
        LayoutMetadataMode::Optional => match read_render_layouts(&layout_path) {
            Ok(Some(layouts)) => Some(layouts),
            Ok(None) => {
                notes.push(HwpedRenderNote {
                    code: "layout_metadata_unavailable".to_string(),
                    message: "optional render layout metadata file was not produced; continue viewing the returned images, or request layout:true to require geometry and diagnose the missing artifact".to_string(),
                });
                None
            }
            Err(error) => {
                notes.push(HwpedRenderNote {
                    code: "layout_metadata_unavailable".to_string(),
                    message: format!("optional render layout metadata was invalid; image pages were returned without layout: {error}"),
                });
                None
            }
        },
        LayoutMetadataMode::Required => match read_render_layouts(&layout_path)? {
            Some(layouts) => Some(layouts),
            None => {
                return Err(invalid_render_layout(
                    "required layout metadata file was not produced",
                ));
            }
        },
    };
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
    let page_numbers: Vec<u32> = files
        .iter()
        .enumerate()
        .map(|(index, (num, _))| {
            if *num > 0 {
                *num
            } else {
                selected
                    .get(index)
                    .copied()
                    .or(single_page)
                    .unwrap_or(index as u32 + 1)
            }
        })
        .collect();
    if let Some(layout_map) = &layouts {
        let missing_pages: Vec<_> = page_numbers
            .iter()
            .filter(|page| !layout_map.contains_key(page))
            .copied()
            .collect();
        if !missing_pages.is_empty() {
            let error = invalid_render_layout(format!(
                "layout metadata is missing rendered page(s) {missing_pages:?}"
            ));
            match layout_mode {
                LayoutMetadataMode::Optional => {
                    notes.push(HwpedRenderNote {
                        code: "layout_metadata_unavailable".to_string(),
                        message: format!("optional render layout metadata was incomplete; image pages were returned without layout: {error}"),
                    });
                    layouts = None;
                }
                LayoutMetadataMode::Required => return Err(error),
                LayoutMetadataMode::Disabled => unreachable!(),
            }
        }
    }
    let mut images = Vec::new();
    for ((_, file), page) in files.iter().zip(page_numbers) {
        let data = std::fs::read(file).map_err(|err| format!("hwp_stage_failed: {err}"))?;
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
            layout: layouts
                .as_ref()
                .and_then(|layouts| layouts.get(&page).cloned()),
        });
    }
    Ok((images, notes))
}

fn render_with_layout_fallback(
    bin: &Path,
    dir: &Path,
    input: &Path,
    format: &str,
    pages: &str,
    dpi: u32,
    layout_mode: LayoutMetadataMode,
) -> Result<(Vec<HwpedRenderPage>, Vec<HwpedRenderNote>), String> {
    // Each attempt has its own output directory: partially written pages or
    // layout files from a failed CLI pass must not leak into a successful retry.
    let attempt = tempfile::tempdir_in(dir).map_err(|error| {
        format!("hwp_stage_failed: cannot create render attempt directory: {error}; check temporary storage permissions and free space, then retry")
    })?;
    match render_attempt(bin, attempt.path(), input, format, pages, dpi, layout_mode) {
        Err(error)
            if layout_mode == LayoutMetadataMode::Optional && error.starts_with("hwp_failed:") =>
        {
            let retry = tempfile::tempdir_in(dir).map_err(|cause| {
                format!("hwp_stage_failed: cannot create image-only render retry directory: {cause}; check temporary storage permissions and free space, then retry")
            })?;
            let (images, mut notes) = render_attempt(
                bin,
                retry.path(),
                input,
                format,
                pages,
                dpi,
                LayoutMetadataMode::Disabled,
            )?;
            notes.push(HwpedRenderNote {
                code: "layout_metadata_unavailable".to_string(),
                message: format!("optional layout render failed; image-only retry succeeded: {error}; continue viewing the returned images, or request layout:true to diagnose the layout failure"),
            });
            Ok((images, notes))
        }
        result => result,
    }
}

fn render_now(
    document: HwpedDocumentRef,
    options: HwpedRenderOptions,
    workspace_root: Option<String>,
) -> Result<HwpedRenderResponse, HwpedBridgeError> {
    let bin = hwp_bin()?;
    let version = ensure_version(&bin)?;
    let layout_mode = match options.layout {
        Some(false) => LayoutMetadataMode::Disabled,
        Some(true) => {
            require_feature_version(&version, "render layout rows")?;
            LayoutMetadataMode::Required
        }
        None if supports_feature_version(&version) => LayoutMetadataMode::Optional,
        None => LayoutMetadataMode::Disabled,
    };
    let requested = options.format.as_deref().unwrap_or("svg").to_string();
    if requested != "svg" && requested != "png" {
        return Err(format!(
            "hwped_bad_request: hwp-cli render supports png and svg only; got \"{requested}\""
        )
        .into());
    }
    let dpi = options.dpi.unwrap_or(96);
    if !(36..=600).contains(&dpi) {
        return Err(format!("hwped_bad_request: dpi must be within 36..=600; got {dpi}").into());
    }
    let pages = options.pages.as_deref().unwrap_or("all").to_string();
    let valid_range = pages == "all"
        || (pages.chars().all(|c| c.is_ascii_digit() || c == '-')
            && pages.split('-').all(|part| !part.is_empty())
            && pages.split('-').count() <= 2);
    if !valid_range {
        return Err(format!("hwped_bad_request: invalid page range: {pages}").into());
    }
    let tmp = tempfile::tempdir().map_err(|err| format!("hwp_stage_failed: {err}"))?;
    let input = stage_document(tmp.path(), &document, workspace_root.as_deref())?;
    match render_with_layout_fallback(
        &bin,
        tmp.path(),
        &input,
        &requested,
        &pages,
        dpi,
        layout_mode,
    ) {
        Ok((pages, notes)) => Ok(HwpedRenderResponse { pages, notes }),
        // SVG is the default; fall back to PNG when the renderer refuses.
        Err(err) if requested == "svg" && err.starts_with("hwp_failed:") => {
            // Optional layout already failed and its image-only SVG retry did
            // too. Do not re-enable layout when trying the other image format.
            let fallback_mode = if layout_mode == LayoutMetadataMode::Optional {
                LayoutMetadataMode::Disabled
            } else {
                layout_mode
            };
            let (pages, mut notes) = render_with_layout_fallback(
                &bin,
                tmp.path(),
                &input,
                "png",
                &pages,
                dpi,
                fallback_mode,
            )?;
            if layout_mode == LayoutMetadataMode::Optional {
                notes.push(HwpedRenderNote {
                    code: "layout_metadata_unavailable".to_string(),
                    message: format!("optional layout render failed; image-only PNG fallback succeeded: {err}; continue viewing the returned images, or request layout:true to diagnose the layout failure"),
                });
            }
            Ok(HwpedRenderResponse { pages, notes })
        }
        Err(err) => Err(err.into()),
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

/// Preserve raw key presence: Tauri's Option decoder otherwise collapses null
/// into absence, which would allow a request containing both edit channels.
#[derive(Debug)]
pub struct HwpedEditArgument(Option<Value>);

impl<'de, R: tauri::Runtime> tauri::ipc::CommandArg<'de, R> for HwpedEditArgument {
    fn from_command(
        command: tauri::ipc::CommandItem<'de, R>,
    ) -> Result<Self, tauri::ipc::InvokeError> {
        match command.message.payload() {
            tauri::ipc::InvokeBody::Json(payload) if payload.is_object() => {
                Ok(Self(payload.get(command.key).cloned()))
            }
            _ => Err("hwped_bad_request: edit arguments must be a JSON object; send exactly one of ops or opsArgv".into()),
        }
    }
}

enum EditOperations {
    Argv(Vec<String>),
    Json(Value),
}

/// The operation flags emitted by the legacy core opsToArgv adapter.
/// CLI modes, output/report paths and ops-file selection are never edit ops.
const LEGACY_EDIT_FLAGS: &[&str] = &[
    "--replace",
    "--set-cell",
    "--set-field",
    "--set-meta",
    "--create-field",
    "--create-bookmark",
    "--create-hyperlink",
    "--insert-image",
    "--seal",
    "--set-format",
    "--set-align",
    "--insert-para",
    "--insert-para-before",
    "--delete-para",
    "--add-row",
    "--add-col",
    "--delete-row",
    "--delete-col",
    "--merge-cells",
    "--split-cell",
    "--add-table",
    "--clone-table",
    "--set-para",
    "--set-page",
    "--delete-image",
    "--delete-table",
    "--delete-field",
    "--delete-bookmark",
];

fn validate_legacy_edit_args(argv: &[String]) -> Result<(), String> {
    if !argv.len().is_multiple_of(2) {
        return Err("hwped_bad_request: opsArgv must be --flag value pairs (opsToArgv output); send valid pairs or use the ops JSON array".to_string());
    }
    for pair in argv.as_chunks::<2>().0 {
        if !LEGACY_EDIT_FLAGS.contains(&pair[0].as_str()) {
            return Err(format!("hwped_bad_request: opsArgv flag {:?} is not a permitted legacy edit operation; send opsToArgv operation flags and use the dedicated verify/allowPartial fields instead of CLI controls", pair[0]));
        }
        if pair[1].starts_with('-')
            && !pair[1]
                .trim()
                .parse::<f64>()
                .is_ok_and(|value| value.is_finite())
        {
            return Err("hwped_bad_request: an opsArgv value starts with a CLI option prefix and is not a finite number; send literal hyphen-leading text through JSON ops, and pass verify/allowPartial in their dedicated fields".to_string());
        }
    }
    Ok(())
}

/// Match the CLI's final @size grammar without interpreting operation data.
fn legacy_asset_size_suffix<'a>(flag: &str, value: &'a str) -> Option<(&'a str, &'a str)> {
    let (path, size) = value.rsplit_once('@')?;
    let is_size = if flag == "--insert-image" {
        size.split_once(['x', 'X']).is_some_and(|(width, height)| {
            width.trim().parse::<f32>().is_ok() && height.trim().parse::<f32>().is_ok()
        })
    } else {
        size.trim()
            .strip_suffix("mm")
            .unwrap_or(size.trim())
            .trim()
            .parse::<f32>()
            .is_ok()
    };
    is_size.then_some((path, &value[path.len()..]))
}

/// Containment every asset path gets, whichever channel carries it: the
/// workspace is required, the path resolves inside it, the canonical file —
/// symlink targets included — stays inside, and it is a regular file. The
/// resolved absolute path is the only form either channel passes on.
fn resolve_workspace_asset(path: &str, workspace_root: Option<&str>) -> Result<String, String> {
    let root = workspace_root.filter(|root| !root.trim().is_empty()).ok_or_else(|| {
        "hwped_bad_request: image operations require workspaceRoot for path containment; provide the workspace containing the image file".to_string()
    })?;
    let canonical_root = crate::vault::normalize_existing_dir(root).map_err(|cause| {
        format!("hwped_bad_request: image workspaceRoot cannot be opened: {cause}; provide an existing workspace directory")
    })?;
    let candidate = crate::vault::resolve_inside_vault(root, path).map_err(|_| {
        "hwped_bad_request: image path is outside workspaceRoot; choose or copy an image into the workspace".to_string()
    })?;
    let resolved = candidate.canonicalize().map_err(|cause| {
        format!("hwped_bad_request: image file {path:?} is missing or cannot be resolved: {cause}; choose an existing readable file in the workspace")
    })?;
    ensure_within(&canonical_root, &resolved).map_err(|_| {
        "hwped_bad_request: image path or symlink target is outside workspaceRoot; choose or copy an image into the workspace".to_string()
    })?;
    if !resolved.is_file() {
        return Err("hwped_bad_request: image asset is not a regular file; choose an existing image file in the workspace".to_string());
    }
    resolved.to_str().map(str::to_string).ok_or_else(|| {
        "hwped_bad_request: resolved image path is not UTF-8; rename the asset with a Unicode filename and retry".to_string()
    })
}

fn resolve_legacy_asset(
    flag: &str,
    value: &str,
    workspace_root: Option<&str>,
) -> Result<String, String> {
    let (anchor, raw) = value.split_once("=>").ok_or_else(|| {
        format!("hwped_bad_request: {flag} requires anchor=>path with an optional @size; resend the opsToArgv value")
    })?;
    let (path, suffix) = legacy_asset_size_suffix(flag, raw).unwrap_or((raw, ""));
    let absolute = resolve_workspace_asset(path, workspace_root)?;
    if suffix.is_empty() && legacy_asset_size_suffix(flag, &absolute).is_some() {
        return Err("hwped_bad_request: resolved image filename has a size-like @suffix; rename the file or supply explicit image dimensions so the CLI selects the same file".to_string());
    }
    Ok(format!("{anchor}=>{absolute}{suffix}"))
}

fn prepare_legacy_edit_args(
    mut argv: Vec<String>,
    workspace_root: Option<&str>,
) -> Result<Vec<String>, String> {
    validate_legacy_edit_args(&argv)?;
    for pair in argv.as_chunks_mut::<2>().0 {
        if matches!(pair[0].as_str(), "--insert-image" | "--seal") {
            pair[1] = resolve_legacy_asset(&pair[0], &pair[1], workspace_root)?;
        }
    }
    Ok(argv)
}

#[cfg(test)]
mod argv_tests;

/// The JSON channel carries asset paths as bare `path` fields, with the anchor
/// and dimensions as their own keys, so there is no `=>` or `@size` to keep:
/// every `insert_image` and `seal` op is contained exactly as the legacy
/// channel contains its `=>path` half, and its `path` becomes that absolute
/// file before the ops file is staged. An op whose `path` is not a string is
/// refused here; a missing one is left to the engine's own schema.
fn contain_json_edit_assets(ops: Value, workspace_root: Option<&str>) -> Result<Value, String> {
    let Value::Array(items) = ops else {
        return Ok(ops);
    };
    let mut contained = Vec::with_capacity(items.len());
    for mut op in items {
        let is_asset = matches!(
            op.get("op").and_then(Value::as_str),
            Some("insert_image") | Some("seal")
        );
        if is_asset {
            if let Some(path) = op.get("path") {
                let path = path.as_str().ok_or_else(|| {
                    format!(
                        "hwped_bad_request: {} path must be a string; send the asset path as a JSON string",
                        op.get("op").and_then(Value::as_str).unwrap_or("asset")
                    )
                })?;
                let absolute = resolve_workspace_asset(path, workspace_root)?;
                if let Some(fields) = op.as_object_mut() {
                    fields.insert("path".to_string(), Value::from(absolute));
                }
            }
        }
        contained.push(op);
    }
    Ok(Value::Array(contained))
}

#[cfg(test)]
#[path = "hwped/json_ops_tests.rs"]
mod json_ops_tests;

fn edit_now(
    document: HwpedDocumentRef,
    ops_argv: Option<Value>,
    ops: Option<Value>,
    verify: Option<bool>,
    allow_partial: Option<bool>,
    workspace_root: Option<String>,
) -> Result<HwpedEditResponse, HwpedBridgeError> {
    let operations = match (ops_argv, ops) {
        (Some(argv), None) => {
            let argv: Vec<String> = serde_json::from_value(argv).map_err(|_| {
                "hwped_bad_request: opsArgv must be an array of strings; send --flag value pairs or use the ops JSON array".to_string()
            })?;
            EditOperations::Argv(prepare_legacy_edit_args(argv, workspace_root.as_deref())?)
        }
        (None, Some(ops)) if ops.is_array() => {
            EditOperations::Json(contain_json_edit_assets(ops, workspace_root.as_deref())?)
        }
        (None, Some(_)) => {
            return Err("hwped_bad_request: ops must be a JSON array; send an edit-ops-v1 array or use opsArgv instead".to_string().into());
        }
        _ => {
            return Err("hwped_bad_request: exactly one of ops and opsArgv is required; send one field and omit the other".to_string().into());
        }
    };
    let bin = hwp_bin()?;
    let version = ensure_version(&bin)?;
    let json_ops = matches!(operations, EditOperations::Json(_));
    if json_ops {
        require_feature_version(&version, "JSON edit ops")?;
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
    match operations {
        EditOperations::Argv(argv) => args.extend(argv.into_iter().map(OsString::from)),
        EditOperations::Json(ops) => {
            let ops_file = tmp.path().join("ops.json");
            let bytes = serde_json::to_vec(&ops).map_err(|err| {
                format!("hwp_stage_failed: could not encode edit operations JSON: {err}; check the operation payload and retry")
            })?;
            std::fs::write(&ops_file, bytes).map_err(|err| {
                format!("hwp_stage_failed: could not write the per-call edit operations file: {err}; check temporary storage permissions and free space, then retry")
            })?;
            args.extend([OsString::from("--ops"), ops_file.into_os_string()]);
        }
    }
    if verify != Some(false) {
        args.push(OsString::from("--verify"));
    }
    if allow_partial == Some(true) {
        args.push(OsString::from("--allow-partial"));
    }
    if json_ops {
        run_hwp_feature_ok(&bin, &args)?;
    } else {
        run_hwp_ok(&bin, &args)?;
    }
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
        edit_ops: supports_feature_version(&version).then_some("v1"),
        version,
        editable: true,
        formats: vec!["hwp".to_string(), "hwpx".to_string()],
    })
}

#[tauri::command]
pub async fn hwped_read(
    document: HwpedDocumentRef,
    workspace_root: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(test)]
        PathTransactionLease::test_stage(&[std::env::temp_dir()], "worker:hwped_read");
        read_now(document, workspace_root)
    })
    .await
    .map_err(|err| format!("hwped_task_failed: {err}"))?
}

#[tauri::command]
pub async fn hwped_render(
    document: HwpedDocumentRef,
    options: Option<HwpedRenderOptions>,
    workspace_root: Option<String>,
) -> Result<HwpedRenderResponse, HwpedBridgeError> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(test)]
        PathTransactionLease::test_stage(&[std::env::temp_dir()], "worker:hwped_render");
        render_now(document, options.unwrap_or_default(), workspace_root)
    })
    .await
    .map_err(|err| format!("hwped_task_failed: {err}"))?
}

#[tauri::command]
pub async fn hwped_edit(
    document: HwpedDocumentRef,
    ops_argv: HwpedEditArgument,
    ops: HwpedEditArgument,
    verify: Option<bool>,
    allow_partial: Option<bool>,
    workspace_root: Option<String>,
) -> Result<HwpedEditResponse, HwpedBridgeError> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(test)]
        PathTransactionLease::test_stage(&[std::env::temp_dir()], "worker:hwped_edit");
        edit_now(
            document,
            ops_argv.0,
            ops.0,
            verify,
            allow_partial,
            workspace_root,
        )
    })
    .await
    .map_err(|err| format!("hwped_task_failed: {err}"))?
}

#[tauri::command]
pub async fn hwped_compose(spec: Value, name: String) -> Result<HwpedComposeResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(test)]
        PathTransactionLease::test_stage(&[std::env::temp_dir()], "worker:hwped_compose");
        compose_now(spec, name)
    })
    .await
    .map_err(|err| format!("hwped_task_failed: {err}"))?
}

#[tauri::command]
pub async fn hwped_validate(
    document: HwpedDocumentRef,
    workspace_root: Option<String>,
) -> Result<HwpedValidationReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(test)]
        PathTransactionLease::test_stage(&[std::env::temp_dir()], "worker:hwped_validate");
        validate_now(document, workspace_root)
    })
    .await
    .map_err(|err| format!("hwped_task_failed: {err}"))?
}

#[tauri::command]
pub async fn hwped_capabilities() -> Result<HwpedCapabilities, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(test)]
        PathTransactionLease::test_stage(&[std::env::temp_dir()], "worker:hwped_capabilities");
        capabilities_now()
    })
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
    fn edit_channel_rejects_both_neither_and_nonarray_json_before_cli_lookup() {
        let document = || HwpedDocumentRef {
            name: "문서.hwpx".to_string(),
            path: None,
            data_base64: None,
        };
        for (argv, ops) in [
            (None, None),
            (Some(serde_json::json!([])), Some(serde_json::json!([]))),
        ] {
            let error = edit_now(document(), argv, ops, None, None, None).unwrap_err();
            let error = error.to_string();
            assert!(error.starts_with("hwped_bad_request:"), "{error}");
            assert!(error.contains("ops and opsArgv"), "{error}");
            assert!(error.contains("exactly one"), "{error}");
        }
        for ops in [
            Value::Null,
            serde_json::json!({}),
            serde_json::json!("not an array"),
            serde_json::json!(7),
        ] {
            let error = edit_now(document(), None, Some(ops), None, None, None).unwrap_err();
            assert!(
                error
                    .to_string()
                    .starts_with("hwped_bad_request: ops must be a JSON array"),
                "{error}"
            );
        }
    }

    #[test]
    fn json_and_layout_flags_require_the_supported_cli_floor() {
        assert!(!version_at_least((0, 8, 6), MIN_VERSION));
        assert!(version_at_least((0, 8, 7), MIN_VERSION));
        assert!(version_at_least((0, 19, 99), MIN_VERSION));
        assert!(!supports_feature_version("0.19.99"));
        assert!(supports_feature_version("0.20.0"));
        assert!(supports_feature_version("1.3.1"));
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

    /// A deliberate workspace symlink pointing outside the workspace stays
    /// readable - the lexical-containment invariant (paths.rs), not a
    /// canonicalize() escape.
    #[cfg(unix)]
    #[test]
    fn stage_document_follows_workspace_symlink_to_an_outside_target() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("root");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("a.hwpx"), b"x").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("inbox")).unwrap();
        let doc = HwpedDocumentRef {
            name: "a.hwpx".to_string(),
            path: Some("inbox/a.hwpx".to_string()),
            data_base64: None,
        };
        let staged = stage_document(tmp.path(), &doc, Some(root.to_str().unwrap())).unwrap();
        assert_eq!(std::fs::read(&staged).unwrap(), b"x");
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

    pub(super) fn layout_artifact() -> Value {
        serde_json::json!({
            "contract":"hwp-render-layout-v1", "schema_version":"1.0", "truncated":true,
            "selected_pages":[2,5],
            "pages":[
                {"page":5,"width_pt":500.0,"height_pt":700.0,"rows":[]},
                {"page":2,"width_pt":200.0,"height_pt":300.0,"rows":[
                    {"id":"same", "kind":"para", "box":{"x0":1,"y0":2,"x1":10,"y1":12}, "source_chars":{"start":2,"end":4}},
                    {"id":"same", "kind":"para", "box":null, "source_chars":null}
                ]}
            ]
        })
    }

    #[test]
    fn layout_metadata_preserves_actual_pages_duplicate_rows_and_nullable_geometry() {
        let source = layout_artifact();
        let layouts = parse_render_layouts(&serde_json::to_vec(&source).unwrap()).unwrap();
        assert_eq!(layouts.keys().copied().collect::<Vec<_>>(), vec![2, 5]);
        let page = serde_json::to_value(&layouts[&2]).unwrap();
        assert_eq!(page["width_pt"], 200.0);
        assert_eq!(page["height_pt"], 300.0);
        assert_eq!(page["truncated"], true);
        assert_eq!(page["rows"], source["pages"][1]["rows"]);
        assert_eq!(
            layouts[&5].rows.len(),
            0,
            "empty measured geometry is not absent metadata"
        );
        let tmp = tempfile::tempdir().unwrap();
        assert!(read_render_layouts(&tmp.path().join("absent.json"))
            .unwrap()
            .is_none());
    }

    #[test]
    fn layout_metadata_preserves_reversed_box_coordinates() {
        let mut source = layout_artifact();
        source["pages"][1]["rows"][0]["box"] = serde_json::json!({"x0":10,"y0":12,"x1":1,"y1":2});
        let layouts = parse_render_layouts(&serde_json::to_vec(&source).unwrap()).unwrap();
        assert_eq!(
            layouts[&2].rows[0]["box"],
            serde_json::json!({"x0":10,"y0":12,"x1":1,"y1":2})
        );
    }

    #[test]
    fn present_malformed_layout_metadata_is_a_parse_failure() {
        let valid = layout_artifact();
        let mut cases = vec![serde_json::json!(null), serde_json::json!({})];
        for (pointer, value) in [
            ("/contract", serde_json::json!("other")),
            ("/schema_version", serde_json::json!("2.0")),
            ("/schema_version", serde_json::json!("1.")),
            ("/truncated", serde_json::json!("true")),
            ("/selected_pages", serde_json::json!([2, 2])),
            ("/selected_pages", serde_json::json!([0, 5])),
            ("/pages/0/page", serde_json::json!(2)),
            ("/pages/0/width_pt", serde_json::json!(0)),
            ("/pages/0/height_pt", serde_json::json!(-1)),
            ("/pages/1/rows/0/kind", serde_json::json!("unsupported")),
            ("/pages/1/rows/0/id", serde_json::json!("")),
            (
                "/pages/1/rows/0/source_chars",
                serde_json::json!({"start":4,"end":2}),
            ),
            (
                "/pages/1/rows/0/source_chars",
                serde_json::json!({"start":-1,"end":2}),
            ),
        ] {
            let mut source = valid.clone();
            *source.pointer_mut(pointer).unwrap() = value;
            cases.push(source);
        }
        let mut missing_page = valid.clone();
        missing_page["pages"].as_array_mut().unwrap().pop();
        cases.push(missing_page);
        let mut missing_box = valid.clone();
        missing_box["pages"][1]["rows"][0]
            .as_object_mut()
            .unwrap()
            .remove("box");
        cases.push(missing_box);
        for source in cases {
            let error = parse_render_layouts(&serde_json::to_vec(&source).unwrap()).unwrap_err();
            assert!(error.starts_with("hwp_parse_failed:"), "{error}");
            assert!(error.contains("render again"), "{error}");
        }
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("malformed.json");
        std::fs::write(&file, b"{").unwrap();
        assert!(read_render_layouts(&file)
            .unwrap_err()
            .starts_with("hwp_parse_failed:"));
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

/// Serializes MARU_HWP_BIN overrides and temp-root worker failure hooks
/// across phase08_21 tests so real fixture calls cannot enter another test's hook.
#[cfg(test)]
pub(crate) static PHASE08_21_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod phase08_21 {
    use super::*;
    use crate::atomic_file::phase08_06::run;
    use std::path::{Path, PathBuf};
    use std::sync::MutexGuard;
    use std::time::Duration;

    /// hwped wrappers all map worker failures to the shared `hwped_task_failed:`
    /// prefix, so the stock `boundary` helper's per-command assertion does not
    /// apply. Mirrors it otherwise, staging `worker:{command}` per wrapper.
    fn boundary_hwped<F, T, E>(path: PathBuf, command: &str, future: F)
    where
        F: std::future::Future<Output = Result<T, E>> + Send + 'static,
        T: Send + 'static,
        E: std::fmt::Display + Send + 'static,
    {
        use crate::atomic_file::PathTransactionTestHook;
        use std::sync::{mpsc, Mutex};

        // Each wrapper stages the same temp-root path. Hold the fixture lock
        // until the hooked worker joins and the hook is removed, otherwise a
        // parallel real fixture call can enter it after its receiver is gone.
        let _fixture_lock = super::PHASE08_21_ENV_LOCK
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let (entered_tx, mut entered_rx) = tauri::async_runtime::channel(1);
        let (release_tx, release_rx) = mpsc::channel();
        let release_rx = Mutex::new(release_rx);
        let _hook = PathTransactionTestHook::new(path, &format!("worker:{command}"), move || {
            entered_tx
                .blocking_send(std::thread::current().id())
                .unwrap();
            release_rx
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(5))
                .unwrap();
            panic!("fixture worker failure");
        });
        run(async move {
            let caller = std::thread::current().id();
            let mut future = Box::pin(future);
            assert!(
                std::future::poll_fn(|cx| std::task::Poll::Ready(future.as_mut().poll(cx)))
                    .await
                    .is_pending()
            );
            let worker = entered_rx.recv().await.unwrap();
            let mut yielded = false;
            std::future::poll_fn(|cx| {
                if yielded {
                    std::task::Poll::Ready(())
                } else {
                    yielded = true;
                    cx.waker().wake_by_ref();
                    std::task::Poll::Pending
                }
            })
            .await;
            assert_ne!(worker, caller);
            release_tx.send(()).unwrap();
            assert!(
                matches!(future.await, Err(error) if error.to_string().starts_with("hwped_task_failed:"))
            );
        });
    }

    struct EnvGuard {
        _lock: MutexGuard<'static, ()>,
        key: &'static str,
    }
    impl EnvGuard {
        fn set(key: &'static str, value: &Path) -> Self {
            let guard = super::PHASE08_21_ENV_LOCK
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            std::env::set_var(key, value);
            Self { _lock: guard, key }
        }
    }
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            std::env::remove_var(self.key);
        }
    }

    fn text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    async fn edit_request(
        document: HwpedDocumentRef,
        ops_argv: Option<Vec<String>>,
        ops: Option<Value>,
        verify: Option<bool>,
        allow_partial: Option<bool>,
        workspace_root: Option<String>,
    ) -> Result<HwpedEditResponse, HwpedBridgeError> {
        super::hwped_edit(
            document,
            HwpedEditArgument(ops_argv.map(|argv| serde_json::json!(argv))),
            HwpedEditArgument(ops),
            verify,
            allow_partial,
            workspace_root,
        )
        .await
    }

    fn doc_with_path(path: &str) -> HwpedDocumentRef {
        HwpedDocumentRef {
            name: "문서.hwpx".to_string(),
            path: Some(path.to_string()),
            data_base64: None,
        }
    }

    /// Fake hwp-cli: version probe plus every subcommand the wrappers spawn.
    #[cfg(unix)]
    fn fake_hwp(dir: &Path) -> PathBuf {
        fake_hwp_version(dir, "0.20.0")
    }

    #[cfg(unix)]
    fn fake_hwp_version(dir: &Path, version: &str) -> PathBuf {
        let binary = dir.join("hwp");
        let script = r#"#!/bin/sh
printf '%s\n' "$*" >> "$(dirname "$0")/invocations"
case "$1" in
  --version)
    printf '%s\n' "__VERSION__" >> "$(dirname "$0")/version-probes"
    echo "hwp __VERSION__" ;;
  cat) echo '{"title":"문서","segments":[{"text":"본문"}]}' ;;
  render)
    out=""; report=""; layout=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "-o" ]; then shift; out="$1"; fi
      if [ "$1" = "--report" ]; then shift; report="$1"; fi
      if [ "$1" = "--layout-json" ]; then shift; layout="$1"; fi
      shift
    done
    [ -n "$out" ] && [ -n "$report" ] || exit 2
    printf '<svg width="100pt" height="50pt"></svg>' > "$out"
    printf '{"selected_pages":[1]}' > "$report"
    if [ -n "$layout" ]; then
      printf '{"contract":"hwp-render-layout-v1","schema_version":"1.0","truncated":false,"selected_pages":[1],"pages":[{"page":1,"width_pt":100,"height_pt":50,"rows":[]}]}' > "$layout"
    fi ;;
  edit)
    out=""; ops=""; verify=0; partial=0
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "-o" ]; then shift; out="$1"; fi
      if [ "$1" = "--ops" ]; then shift; ops="$1"; fi
      if [ "$1" = "--verify" ]; then verify=1; fi
      if [ "$1" = "--allow-partial" ]; then partial=1; fi
      shift
    done
    [ -n "$out" ] || exit 2
    if [ -n "$ops" ]; then
      printf '%s\n%s\n%s\n' "$ops" "$verify" "$partial" > "$out"
      cat "$ops" >> "$out"
    else
      printf 'edited' > "$out"
    fi ;;
  compose)
    out=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "-o" ]; then shift; out="$1"; fi
      shift
    done
    [ -n "$out" ] || exit 2
    printf 'composed' > "$out"
    printf '{"report":true}' ;;
  validate) printf '{"valid":true,"errors":[]}' ;;
  *) exit 2 ;;
esac
"#;
        let script = script.replace("__VERSION__", version);
        crate::test_support::write_executable_fixture(&binary, &script, 0o755).unwrap();
        binary
    }

    /// Fake hwp-cli whose `cat` publishes one `table` segment while its `info`
    /// branch answers verbatim — the two counts are meant to disagree, which is
    /// the condition the editor's table-index guard watches.
    #[cfg(unix)]
    fn fake_hwp_body_stats(dir: &Path, version: &str, info: &str) -> PathBuf {
        let binary = dir.join("hwp");
        let script = r#"#!/bin/sh
printf '%s\n' "$*" >> "$(dirname "$0")/invocations"
case "$1" in
  --version) echo "hwp __VERSION__" ;;
  cat) echo '{"title":"문서","segments":[{"kind":"table","start":0,"end":4,"section":0,"para":0},{"kind":"paragraph","start":4,"end":9,"section":0,"para":1}]}' ;;
  info) __INFO__ ;;
  *) exit 2 ;;
esac
"#;
        let script = script
            .replace("__VERSION__", version)
            .replace("__INFO__", info);
        crate::test_support::write_executable_fixture(&binary, &script, 0o755).unwrap();
        binary
    }

    /// Read `docs/a.hwpx` through a body-stats fixture, returning the envelope
    /// and the fixture's invocation log.
    #[cfg(unix)]
    fn read_with_body_stats(version: &str, info: &str) -> (Value, String) {
        let home = crate::atomic_file::phase08_06::Home::new();
        let root = home.root.path().join("work");
        std::fs::create_dir_all(root.join("docs")).unwrap();
        std::fs::write(root.join("docs/a.hwpx"), b"document").unwrap();
        let bin_dir = home.root.path().join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let binary = fake_hwp_body_stats(&bin_dir, version, info);
        let _env = EnvGuard::set("MARU_HWP_BIN", &binary);
        let read = run(hwped_read(doc_with_path("docs/a.hwpx"), Some(text(&root)))).unwrap();
        let invocations = std::fs::read_to_string(bin_dir.join("invocations")).unwrap();
        (read, invocations)
    }

    #[cfg(unix)]
    #[test]
    fn read_reports_the_engine_table_count_apart_from_published_segments() {
        let (read, invocations) = read_with_body_stats(
            "0.19.2",
            r#"echo '{"body":{"tables":2,"tables_inline":1,"tables_floating":1}}'"#,
        );
        let published = read["segments"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|segment| segment["kind"] == "table")
            .count();
        assert_eq!(published, 1, "{read}");
        assert!(
            invocations.contains("--body-stats"),
            "the count comes from the engine, not the segments: {invocations}"
        );
        assert_eq!(read["bodyTables"], 2);
        assert!(read["bodyTables"].as_u64().unwrap() > published as u64);
    }

    #[cfg(unix)]
    #[test]
    fn read_keeps_the_envelope_when_the_body_stats_call_fails() {
        let (read, _) = read_with_body_stats("0.20.0", "echo 'no body' >&2; exit 3");
        assert_eq!(read["title"], "문서");
        assert!(read.get("bodyTables").is_none(), "{read}");
    }

    #[cfg(unix)]
    #[test]
    fn read_keeps_the_envelope_when_the_stats_carry_no_table_count() {
        let (read, _) = read_with_body_stats("0.20.0", r#"echo '{"format":"hwpx"}'"#);
        assert_eq!(read["title"], "문서");
        assert!(read.get("bodyTables").is_none(), "{read}");
    }

    #[cfg(unix)]
    #[test]
    fn read_skips_body_stats_below_the_hwp_cli_floor() {
        let (read, invocations) = read_with_body_stats("0.19.1", r#"echo '{"body":{"tables":2}}'"#);
        assert_eq!(read["title"], "문서");
        assert!(read.get("bodyTables").is_none(), "{read}");
        assert!(!invocations.contains("--body-stats"), "{invocations}");
    }

    fn assert_feature_version_error(error: HwpedBridgeError, feature: &str, detected: &str) {
        let error = match error {
            HwpedBridgeError::FeatureVersion(error) => error,
            legacy => panic!("expected structured feature-version error, got {legacy}"),
        };
        assert_eq!(error.code, "hwped_feature_requires_version");
        assert!(error.message.contains(feature), "{}", error.message);
        assert!(error.message.contains(detected), "{}", error.message);
        assert!(error.message.contains("0.20.0"), "{}", error.message);
        assert!(
            error.message.contains("Upgrade hwp-cli"),
            "{}",
            error.message
        );
    }

    #[cfg(unix)]
    #[test]
    fn global_floor_binary_keeps_legacy_commands_and_omits_feature_capability() {
        let home = crate::atomic_file::phase08_06::Home::new();
        let root = home.root.path().join("work");
        std::fs::create_dir_all(root.join("docs")).unwrap();
        std::fs::write(root.join("docs/a.hwpx"), b"document").unwrap();
        let bin_dir = home.root.path().join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let binary = fake_hwp_version(&bin_dir, "0.8.7");
        let _env = EnvGuard::set("MARU_HWP_BIN", &binary);
        let work = text(&root);

        let read = run(hwped_read(doc_with_path("docs/a.hwpx"), Some(work.clone()))).unwrap();
        assert_eq!(read["title"], "문서");

        let rendered = run(hwped_render(
            doc_with_path("docs/a.hwpx"),
            None,
            Some(work.clone()),
        ))
        .unwrap();
        assert_eq!(rendered.pages.len(), 1);
        assert!(rendered.pages[0].layout.is_none());
        let invocations = std::fs::read_to_string(bin_dir.join("invocations")).unwrap();
        assert!(!invocations.contains("--layout-json"));

        let edited = run(edit_request(
            doc_with_path("docs/a.hwpx"),
            Some(vec!["--replace".to_string(), "본문".to_string()]),
            None,
            None,
            None,
            Some(work.clone()),
        ))
        .unwrap();
        assert_eq!(BASE64.decode(edited.data_base64).unwrap(), b"edited");

        let composed = run(hwped_compose(
            serde_json::json!({"sections": []}),
            "보고서".to_string(),
        ))
        .unwrap();
        assert_eq!(BASE64.decode(composed.data_base64).unwrap(), b"composed");

        let validated = run(hwped_validate(doc_with_path("docs/a.hwpx"), Some(work))).unwrap();
        assert!(validated.valid);

        let capabilities = run(hwped_capabilities()).unwrap();
        assert_eq!(capabilities.version, "0.8.7");
        assert_eq!(capabilities.edit_ops, None);
        assert!(serde_json::to_value(capabilities)
            .unwrap()
            .get("editOps")
            .is_none());
    }

    #[cfg(unix)]
    #[test]
    fn feature_floor_refuses_json_edit_and_explicit_layout_on_legacy_binary() {
        let home = crate::atomic_file::phase08_06::Home::new();
        let root = home.root.path().join("work");
        std::fs::create_dir_all(root.join("docs")).unwrap();
        std::fs::write(root.join("docs/a.hwpx"), b"document").unwrap();
        let bin_dir = home.root.path().join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let binary = fake_hwp_version(&bin_dir, "0.19.99");
        let _env = EnvGuard::set("MARU_HWP_BIN", &binary);
        let work = text(&root);

        let json_error = run(edit_request(
            doc_with_path("docs/a.hwpx"),
            None,
            Some(serde_json::json!([{"op":"set_format","address":{"at":{"section":0,"paragraph":1,"run":0}},"bold":"on"}])),
            None,
            None,
            Some(work.clone()),
        ))
        .unwrap_err();
        assert_feature_version_error(json_error, "JSON edit ops", "0.19.99");

        let layout_error = run(hwped_render(
            doc_with_path("docs/a.hwpx"),
            Some(HwpedRenderOptions {
                layout: Some(true),
                ..HwpedRenderOptions::default()
            }),
            Some(work),
        ))
        .unwrap_err();
        assert_feature_version_error(layout_error, "render layout rows", "0.19.99");
        let invocations = std::fs::read_to_string(bin_dir.join("invocations")).unwrap();
        assert!(!invocations.lines().any(|line| line.starts_with("edit ")));
        assert!(!invocations.contains("--layout-json"));
    }

    #[cfg(unix)]
    #[test]
    fn version_cache_is_per_binary_and_reprobes_same_path_after_mtime_change() {
        let home = crate::atomic_file::phase08_06::Home::new();
        let first_dir = home.root.path().join("first");
        let second_dir = home.root.path().join("second");
        std::fs::create_dir_all(&first_dir).unwrap();
        std::fs::create_dir_all(&second_dir).unwrap();
        let first = fake_hwp_version(&first_dir, "0.8.7");
        let second = fake_hwp_version(&second_dir, "0.19.99");

        assert_eq!(ensure_version(&first).unwrap(), "0.8.7");
        assert_eq!(ensure_version(&first).unwrap(), "0.8.7");
        assert_eq!(ensure_version(&second).unwrap(), "0.19.99");
        assert_eq!(ensure_version(&second).unwrap(), "0.19.99");
        assert_eq!(
            std::fs::read_to_string(first_dir.join("version-probes"))
                .unwrap()
                .lines()
                .count(),
            1
        );
        assert_eq!(
            std::fs::read_to_string(second_dir.join("version-probes"))
                .unwrap()
                .lines()
                .count(),
            1
        );

        let replacement = r#"#!/bin/sh
printf '%s\n' "0.20.0" >> "$(dirname "$0")/version-probes"
echo "hwp 0.20.0"
"#;
        std::fs::write(&first, replacement).unwrap();
        let modified = std::time::SystemTime::now() + Duration::from_secs(24 * 60 * 60);
        std::fs::File::open(&first)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(modified))
            .unwrap();
        assert_eq!(ensure_version(&first).unwrap(), "0.20.0");
        assert_eq!(
            std::fs::read_to_string(first_dir.join("version-probes"))
                .unwrap()
                .lines()
                .count(),
            2
        );
        assert_eq!(ensure_version(&second).unwrap(), "0.19.99");
        assert_eq!(
            std::fs::read_to_string(second_dir.join("version-probes"))
                .unwrap()
                .lines()
                .count(),
            1
        );
    }

    #[test]
    fn phase08_21_hwped_each_wrapper_yields_same_poll_and_maps_join_failure() {
        boundary_hwped(
            std::env::temp_dir(),
            "hwped_read",
            hwped_read(doc_with_path("docs/a.hwpx"), Some("/tmp".to_string())),
        );
        boundary_hwped(
            std::env::temp_dir(),
            "hwped_render",
            hwped_render(doc_with_path("docs/a.hwpx"), None, Some("/tmp".to_string())),
        );
        boundary_hwped(
            std::env::temp_dir(),
            "hwped_edit",
            edit_request(
                doc_with_path("docs/a.hwpx"),
                Some(vec!["--replace".to_string(), "x".to_string()]),
                None,
                None,
                None,
                Some("/tmp".to_string()),
            ),
        );
        boundary_hwped(
            std::env::temp_dir(),
            "hwped_compose",
            hwped_compose(serde_json::json!({"pages": []}), "보고서".to_string()),
        );
        boundary_hwped(
            std::env::temp_dir(),
            "hwped_validate",
            hwped_validate(doc_with_path("docs/a.hwpx"), Some("/tmp".to_string())),
        );
        boundary_hwped(
            std::env::temp_dir(),
            "hwped_capabilities",
            hwped_capabilities(),
        );
    }

    #[cfg(unix)]
    fn fake_layout_hwp(dir: &Path, artifact: Option<&[u8]>, version: &str) -> PathBuf {
        let binary = dir.join("hwp");
        if let Some(bytes) = artifact {
            std::fs::write(dir.join("layout-fixture.json"), bytes).unwrap();
        }
        let script = r#"#!/bin/sh
case "$1" in
  --version) echo "hwp __VERSION__" ;;
  render)
    printf '%s\n' "$*" >> "$(dirname "$0")/render-args"
    out=""; report=""; layout=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "-o" ]; then shift; out="$1"; fi
      if [ "$1" = "--report" ]; then shift; report="$1"; fi
      if [ "$1" = "--layout-json" ]; then shift; layout="$1"; fi
      shift
    done
    [ -n "$out" ] && [ -n "$report" ] || exit 2
    dir=$(dirname "$out")
    printf '<svg width="200pt" height="300pt"></svg>' > "$dir/page-2.svg"
    printf '<svg width="500pt" height="700pt"></svg>' > "$dir/page-5.svg"
    printf '{"selected_pages":[2,5]}' > "$report"
    fixture="$(dirname "$0")/layout-fixture.json"
    if [ -n "$layout" ] && [ -f "$fixture" ]; then cp "$fixture" "$layout"; fi ;;
  *) exit 2 ;;
esac
"#;
        let script = script.replace("__VERSION__", version);
        crate::test_support::write_executable_fixture(&binary, &script, 0o755).unwrap();
        binary
    }

    #[cfg(unix)]
    #[test]
    fn render_layout_rows_follow_page_numbers_and_missing_artifacts_stay_optional() {
        for artifact in [
            Some(serde_json::to_vec(&super::tests::layout_artifact()).unwrap()),
            None,
            Some(b"{".to_vec()),
        ] {
            let home = crate::atomic_file::phase08_06::Home::new();
            let bin_dir = home.root.path().join("bin");
            std::fs::create_dir_all(&bin_dir).unwrap();
            let _env = EnvGuard::set(
                "MARU_HWP_BIN",
                &fake_layout_hwp(&bin_dir, artifact.as_deref(), "0.20.0"),
            );
            let document = HwpedDocumentRef {
                name: "문서.hwpx".to_string(),
                path: None,
                data_base64: Some(BASE64.encode(b"document")),
            };
            let rendered = run(hwped_render(document, None, None));
            let rendered = rendered.unwrap();
            assert_eq!(
                rendered
                    .pages
                    .iter()
                    .map(|page| page.page)
                    .collect::<Vec<_>>(),
                vec![2, 5]
            );
            if artifact
                .as_deref()
                .is_some_and(|bytes| bytes != b"{".as_slice())
            {
                assert_eq!(rendered.pages[0].layout.as_ref().unwrap().width_pt, 200.0);
                assert_eq!(rendered.pages[1].layout.as_ref().unwrap().width_pt, 500.0);
                assert_eq!(rendered.pages[0].layout.as_ref().unwrap().rows.len(), 2);
                assert!(rendered.pages[0].layout.as_ref().unwrap().truncated);
                assert!(rendered.notes.is_empty());
                assert!(serde_json::to_value(&rendered)
                    .unwrap()
                    .get("notes")
                    .is_none());
            } else {
                assert_eq!(rendered.notes.len(), 1);
                assert_eq!(rendered.notes[0].code, "layout_metadata_unavailable");
                for page in &rendered.pages {
                    assert!(page.layout.is_none());
                    assert!(serde_json::to_value(page).unwrap().get("layout").is_none());
                    assert!(!page.data_base64.is_empty());
                }
                assert_eq!(
                    serde_json::to_value(&rendered).unwrap()["notes"][0]["code"],
                    "layout_metadata_unavailable"
                );
                if artifact.is_none() {
                    assert!(rendered.notes[0].message.contains("not produced"));
                } else {
                    assert!(rendered.notes[0].message.contains("hwp_parse_failed"));
                }
            }
        }
    }

    fn partial_layout_artifact() -> Vec<u8> {
        let mut artifact = super::tests::layout_artifact();
        let page = artifact["pages"][1].clone();
        artifact["selected_pages"] = serde_json::json!([2]);
        artifact["pages"] = serde_json::json!([page]);
        serde_json::to_vec(&artifact).unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn explicit_layout_rejects_missing_malformed_and_incomplete_artifacts() {
        for artifact in [None, Some(b"{".to_vec()), Some(partial_layout_artifact())] {
            let home = crate::atomic_file::phase08_06::Home::new();
            let bin_dir = home.root.path().join("bin");
            std::fs::create_dir_all(&bin_dir).unwrap();
            let _env = EnvGuard::set(
                "MARU_HWP_BIN",
                &fake_layout_hwp(&bin_dir, artifact.as_deref(), "0.20.0"),
            );
            let document = HwpedDocumentRef {
                name: "required-layout.hwpx".to_string(),
                path: None,
                data_base64: Some(BASE64.encode(b"document")),
            };
            let error = run(hwped_render(
                document,
                Some(HwpedRenderOptions {
                    layout: Some(true),
                    ..HwpedRenderOptions::default()
                }),
                None,
            ))
            .unwrap_err()
            .to_string();
            assert!(error.starts_with("hwp_parse_failed:"), "{error}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn optional_incomplete_layout_drops_all_metadata_but_keeps_every_image() {
        let home = crate::atomic_file::phase08_06::Home::new();
        let bin_dir = home.root.path().join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let artifact = partial_layout_artifact();
        let _env = EnvGuard::set(
            "MARU_HWP_BIN",
            &fake_layout_hwp(&bin_dir, Some(&artifact), "0.20.0"),
        );
        let document = HwpedDocumentRef {
            name: "optional-layout.hwpx".to_string(),
            path: None,
            data_base64: Some(BASE64.encode(b"document")),
        };
        let rendered = run(hwped_render(document, None, None)).unwrap();
        assert_eq!(rendered.pages.len(), 2);
        assert!(rendered.pages.iter().all(|page| page.layout.is_none()));
        assert!(rendered
            .pages
            .iter()
            .all(|page| !page.data_base64.is_empty()));
        assert_eq!(rendered.notes.len(), 1);
        assert_eq!(rendered.notes[0].code, "layout_metadata_unavailable");
        assert!(rendered.notes[0].message.contains("incomplete"));
    }

    #[cfg(unix)]
    #[test]
    fn disabled_and_old_auto_layout_keep_legacy_image_only_shape() {
        for (layout, version) in [(Some(false), "0.20.0"), (None, "0.8.7")] {
            let home = crate::atomic_file::phase08_06::Home::new();
            let bin_dir = home.root.path().join("bin");
            std::fs::create_dir_all(&bin_dir).unwrap();
            let _env = EnvGuard::set("MARU_HWP_BIN", &fake_layout_hwp(&bin_dir, None, version));
            let document = HwpedDocumentRef {
                name: "legacy-layout.hwpx".to_string(),
                path: None,
                data_base64: Some(BASE64.encode(b"document")),
            };
            let rendered = run(hwped_render(
                document,
                Some(HwpedRenderOptions {
                    layout,
                    ..HwpedRenderOptions::default()
                }),
                None,
            ))
            .unwrap();
            assert_eq!(rendered.pages.len(), 2);
            assert!(rendered.pages.iter().all(|page| page.layout.is_none()));
            assert!(rendered.notes.is_empty());
            let serialized = serde_json::to_value(&rendered).unwrap();
            assert!(serialized.get("notes").is_none());
            assert!(serialized["pages"]
                .as_array()
                .unwrap()
                .iter()
                .all(|page| page.get("layout").is_none()));
            let args = std::fs::read_to_string(bin_dir.join("render-args")).unwrap();
            assert!(!args.contains("--layout-json"), "{args}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn optional_layout_is_not_reenabled_during_svg_to_png_fallback() {
        let home = crate::atomic_file::phase08_06::Home::new();
        let binary = home.root.path().join("hwp");
        crate::test_support::write_executable_fixture(
            &binary,
            r#"#!/bin/sh
case "$1" in
  --version) echo 'hwp 0.20.0' ;;
  render)
    printf '%s\n' "$*" >> "$(dirname "$0")/render-args"
    out=""; format=""; report=""; layout=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -o) shift; out="$1" ;;
        --format) shift; format="$1" ;;
        --report) shift; report="$1" ;;
        --layout-json) shift; layout="$1" ;;
      esac
      shift
    done
    if [ "$format" = svg ] || [ -n "$layout" ]; then
      echo 'fixture renderer failure' >&2; exit 7
    fi
    printf 'fixture image bytes' > "$out"
    printf '{"selected_pages":[1]}' > "$report" ;;
  *) exit 2 ;;
esac
"#,
            0o755,
        )
        .unwrap();
        let _env = EnvGuard::set("MARU_HWP_BIN", &binary);
        let result = run(hwped_render(
            HwpedDocumentRef {
                name: "fallback.hwpx".to_string(),
                path: None,
                data_base64: Some(BASE64.encode(b"fixture document")),
            },
            None,
            None,
        ))
        .unwrap();
        assert_eq!(result.pages.len(), 1);
        assert_eq!(result.pages[0].format, "png");
        assert!(result.pages[0].layout.is_none());
        assert_eq!(result.notes.len(), 1);
        assert_eq!(result.notes[0].code, "layout_metadata_unavailable");
        let args = std::fs::read_to_string(home.root.path().join("render-args")).unwrap();
        let attempts: Vec<_> = args.lines().collect();
        assert_eq!(
            attempts.len(),
            3,
            "one optional attempt, image-only retry and PNG fallback: {args}"
        );
        assert!(attempts[0].contains("--format svg") && attempts[0].contains("--layout-json"));
        assert!(attempts[1].contains("--format svg") && !attempts[1].contains("--layout-json"));
        assert!(attempts[2].contains("--format png") && !attempts[2].contains("--layout-json"));
    }

    #[cfg(unix)]
    #[test]
    fn edit_json_and_legacy_channels_cross_the_real_tauri_argument_decoder() {
        use tauri::ipc::{CallbackFn, InvokeBody};
        use tauri::test::{get_ipc_response, INVOKE_KEY};
        use tauri::webview::InvokeRequest;
        let home = crate::atomic_file::phase08_06::Home::new();
        let bin_dir = home.root.path().join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let _env = EnvGuard::set("MARU_HWP_BIN", &fake_hwp(&bin_dir));
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.runtime_authority_mut().__allow_command(
            "hwped_edit".to_string(),
            tauri::utils::acl::ExecutionContext::Local,
        );
        let app = tauri::test::mock_builder()
            .invoke_handler(tauri::generate_handler![hwped_edit])
            .build(context)
            .unwrap();
        let view = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let invoke = |payload| {
            get_ipc_response(
                &view,
                InvokeRequest {
                    cmd: "hwped_edit".to_string(),
                    callback: CallbackFn(0),
                    error: CallbackFn(1),
                    url: view.url().unwrap(),
                    body: InvokeBody::Json(payload),
                    headers: Default::default(),
                    invoke_key: INVOKE_KEY.to_string(),
                },
            )
        };
        let document = serde_json::json!({"name":"문서.hwpx", "dataBase64":BASE64.encode(b"original document")});
        let ops = serde_json::json!([{"op":"set_format", "address":{"at":{"section":0,"paragraph":0,"run":1}}, "chars":[1,3], "bold":"on"}]);
        let response = invoke(serde_json::json!({"document":document, "ops":ops}))
            .unwrap()
            .deserialize::<Value>()
            .unwrap();
        let bytes = BASE64
            .decode(response["dataBase64"].as_str().unwrap())
            .unwrap();
        let captured = String::from_utf8(bytes).unwrap();
        let fields: Vec<_> = captured.splitn(4, '\n').collect();
        assert_eq!(serde_json::from_str::<Value>(fields[3]).unwrap(), ops);
        assert_eq!(fields[1], "1", "the default verification flag is preserved");
        let legacy =
            invoke(serde_json::json!({"document":document, "opsArgv":["--replace","본문"]}))
                .unwrap()
                .deserialize::<Value>()
                .unwrap();
        assert_eq!(
            BASE64
                .decode(legacy["dataBase64"].as_str().unwrap())
                .unwrap(),
            b"edited"
        );
        for payload in [
            serde_json::json!({"document":document}),
            serde_json::json!({"document":document, "ops":[], "opsArgv":[]}),
            serde_json::json!({"document":document, "ops":{"not":"array"}}),
            serde_json::json!({"document":document, "ops":null}),
            serde_json::json!({"document":document, "opsArgv":null}),
            serde_json::json!({"document":document, "ops":null, "opsArgv":null}),
            serde_json::json!({"document":document, "ops":null, "opsArgv":["--replace","x"]}),
            serde_json::json!({"document":document, "ops":[], "opsArgv":null}),
            serde_json::json!({"document":document, "opsArgv":[true]}),
        ] {
            let both_present = payload.get("ops").is_some() && payload.get("opsArgv").is_some();
            let error = invoke(payload).unwrap_err();
            let message = error.as_str().unwrap();
            assert!(message.starts_with("hwped_bad_request:"), "{error}");
            if both_present {
                assert!(
                    message.contains("ops and opsArgv") && message.contains("exactly one"),
                    "{error}"
                );
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn feature_version_refusals_remain_structured_at_the_tauri_ipc_boundary() {
        use tauri::ipc::{CallbackFn, InvokeBody};
        use tauri::test::{get_ipc_response, INVOKE_KEY};
        use tauri::webview::InvokeRequest;

        let home = crate::atomic_file::phase08_06::Home::new();
        let bin_dir = home.root.path().join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let _env = EnvGuard::set("MARU_HWP_BIN", &fake_hwp_version(&bin_dir, "0.19.99"));
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        for command in ["hwped_edit", "hwped_render", "hwped_capabilities"] {
            context.runtime_authority_mut().__allow_command(
                command.to_string(),
                tauri::utils::acl::ExecutionContext::Local,
            );
        }
        let app = tauri::test::mock_builder()
            .invoke_handler(tauri::generate_handler![
                hwped_edit,
                hwped_render,
                hwped_capabilities
            ])
            .build(context)
            .unwrap();
        let view = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let invoke = |cmd: &str, payload| {
            get_ipc_response(
                &view,
                InvokeRequest {
                    cmd: cmd.to_string(),
                    callback: CallbackFn(0),
                    error: CallbackFn(1),
                    url: view.url().unwrap(),
                    body: InvokeBody::Json(payload),
                    headers: Default::default(),
                    invoke_key: INVOKE_KEY.to_string(),
                },
            )
        };
        let document = serde_json::json!({
            "name":"문서.hwpx",
            "dataBase64":BASE64.encode(b"document")
        });
        let edit_error = invoke(
            "hwped_edit",
            serde_json::json!({
                "document":document,
                "ops":[{"op":"set_format","address":{"at":{"section":0,"paragraph":1,"run":0}},"bold":"on"}]
            }),
        )
        .unwrap_err();
        assert_eq!(edit_error["code"], "hwped_feature_requires_version");
        assert!(edit_error["message"]
            .as_str()
            .unwrap()
            .contains("JSON edit ops"));
        assert!(edit_error["message"].as_str().unwrap().contains("0.19.99"));
        assert!(edit_error["message"].as_str().unwrap().contains("0.20.0"));
        assert!(edit_error["message"]
            .as_str()
            .unwrap()
            .contains("Upgrade hwp-cli"));

        let layout_error = invoke(
            "hwped_render",
            serde_json::json!({
                "document":document,
                "options":{"layout":true}
            }),
        )
        .unwrap_err();
        assert_eq!(layout_error["code"], "hwped_feature_requires_version");
        assert!(layout_error["message"]
            .as_str()
            .unwrap()
            .contains("render layout rows"));
        assert!(layout_error["message"]
            .as_str()
            .unwrap()
            .contains("0.19.99"));

        let capabilities = invoke("hwped_capabilities", serde_json::json!({}))
            .unwrap()
            .deserialize::<Value>()
            .unwrap();
        assert_eq!(capabilities["version"], "0.19.99");
        assert!(capabilities.get("editOps").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn json_edit_channel_stages_the_contained_asset_path() {
        let home = crate::atomic_file::phase08_06::Home::new();
        let root = home.root.path().join("work");
        std::fs::create_dir_all(root.join("docs")).unwrap();
        std::fs::write(root.join("docs/a.hwpx"), b"original document").unwrap();
        std::fs::create_dir_all(root.join("assets")).unwrap();
        std::fs::write(root.join("assets/chart.png"), b"fixture asset bytes").unwrap();
        let bin_dir = home.root.path().join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let _env = EnvGuard::set("MARU_HWP_BIN", &fake_hwp(&bin_dir));
        let absolute = std::fs::canonicalize(root.join("assets/chart.png")).unwrap();

        let edited = run(edit_request(
            doc_with_path("docs/a.hwpx"),
            None,
            Some(serde_json::json!([
                {"op": "insert_image", "anchor": "삽화", "path": "assets/chart.png", "width_mm": 80, "height_mm": 60},
                {"op": "seal", "anchor": "서명", "path": "assets/chart.png"}
            ])),
            Some(false),
            None,
            Some(text(&root)),
        ))
        .unwrap();

        let bytes = BASE64.decode(edited.data_base64).unwrap();
        let captured = String::from_utf8(bytes).unwrap();
        let staged: Value = serde_json::from_str(captured.splitn(4, '\n').nth(3).unwrap()).unwrap();
        // Both asset ops reach the engine with the resolved absolute file, and
        // their own keys are untouched.
        assert_eq!(staged[0]["path"], text(&absolute), "{staged}");
        assert_eq!(staged[0]["anchor"], "삽화");
        assert_eq!(staged[0]["width_mm"], 80);
        assert_eq!(staged[1]["path"], text(&absolute), "{staged}");
        assert_eq!(staged[1]["anchor"], "서명");

        // A refusal happens before the engine runs at all: no edit invocation,
        // no output and no document change.
        let outside = home.root.path().join("outside.png");
        std::fs::write(&outside, b"outside asset").unwrap();
        let refused = run(edit_request(
            doc_with_path("docs/a.hwpx"),
            None,
            Some(serde_json::json!([
                {"op": "insert_image", "anchor": "삽화", "path": text(&outside)}
            ])),
            None,
            None,
            Some(text(&root)),
        ))
        .unwrap_err()
        .to_string();
        assert!(refused.contains("outside workspaceRoot"), "{refused}");
        let invocations = std::fs::read_to_string(bin_dir.join("invocations")).unwrap();
        assert!(
            invocations
                .lines()
                .filter(|line| line.starts_with("edit "))
                .count()
                == 1,
            "only the accepted call reaches the engine: {invocations}"
        );
        assert_eq!(
            std::fs::read(root.join("docs/a.hwpx")).unwrap(),
            b"original document"
        );
    }

    #[cfg(unix)]
    #[test]
    fn json_edit_channel_preserves_addresses_and_uses_isolated_temporary_files() {
        let home = crate::atomic_file::phase08_06::Home::new();
        let root = home.root.path().join("work");
        std::fs::create_dir_all(root.join("docs")).unwrap();
        std::fs::write(root.join("docs/a.hwpx"), b"original document").unwrap();
        let bin_dir = home.root.path().join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let _env = EnvGuard::set("MARU_HWP_BIN", &fake_hwp(&bin_dir));
        let payloads = [
            serde_json::json!([{"op":"set_format", "address":{"at":{"section":0,"paragraph":0,"run":1}}, "chars":[1,3], "bold":"on", "text":"같은 문구"}]),
            // The engine, rather than this host, owns every op and its grammar.
            serde_json::json!([{"future_op":{"text":"그대로 전달"}}, false, 1]),
            serde_json::json!([]),
        ];
        let mut previous_ops_file = None;
        for ops in payloads {
            let edited = run(edit_request(
                doc_with_path("docs/a.hwpx"),
                None,
                Some(ops.clone()),
                Some(false),
                Some(true),
                Some(text(&root)),
            ))
            .unwrap();
            let bytes = BASE64.decode(edited.data_base64).unwrap();
            let captured = String::from_utf8(bytes).unwrap();
            let fields: Vec<_> = captured.splitn(4, '\n').collect();
            let ops_file = PathBuf::from(fields[0]);
            assert_eq!(ops_file.file_name().unwrap(), "ops.json");
            assert!(
                !ops_file.exists(),
                "per-call files must be cleaned after readback"
            );
            assert_ne!(previous_ops_file.as_ref(), Some(&ops_file));
            previous_ops_file = Some(ops_file);
            assert_eq!(fields[1], "0", "verify=false must omit --verify");
            assert_eq!(fields[2], "1", "allowPartial must retain its CLI flag");
            assert_eq!(serde_json::from_str::<Value>(fields[3]).unwrap(), ops);
            assert_eq!(
                std::fs::read(root.join("docs/a.hwpx")).unwrap(),
                b"original document"
            );
        }
    }

    /// Opt-in integration against a checksum-verified released binary; the
    /// hermetic suite needs only its isolated scripted fixtures.
    #[cfg(unix)]
    #[test]
    #[ignore = "requires MARU_HWPED_REAL_TEST_BIN pointing to checksum-verified hwp-cli >= 1.3.1"]
    fn released_hwp_changes_only_the_addressed_duplicate_and_returns_page_layout() {
        let binary = std::env::var_os("MARU_HWPED_REAL_TEST_BIN")
            .map(PathBuf::from)
            .expect("set MARU_HWPED_REAL_TEST_BIN to the verified release binary");
        let home = crate::atomic_file::phase08_06::Home::new();
        let _env = EnvGuard::set("MARU_HWP_BIN", &binary);
        let root = home.root.path();
        let markdown = root.join("duplicate.md");
        std::fs::write(
            &markdown,
            "# 제목\n\n첫 문단\n\n같은 문단\n\n셋째 문단\n\n같은 문단\n",
        )
        .unwrap();
        let input = root.join("base.hwpx");
        run_hwp_ok(
            &binary,
            &[
                OsString::from("new"),
                OsString::from("--from"),
                markdown.into_os_string(),
                OsString::from("-o"),
                input.as_os_str().to_os_string(),
            ],
        )
        .unwrap();
        let original_bytes = std::fs::read(&input).unwrap();
        let read_ir = |file: &Path| -> Value {
            serde_json::from_slice(
                &run_hwp_ok(
                    &binary,
                    &[
                        OsString::from("cat"),
                        file.as_os_str().to_os_string(),
                        OsString::from("--format"),
                        OsString::from("json"),
                    ],
                )
                .unwrap(),
            )
            .unwrap()
        };
        let before = read_ir(&input);
        let ops = serde_json::json!([{"op":"set_format", "address":{"at":{"section":0,"paragraph":4,"run":0}}, "bold":"on"}]);
        let document = || HwpedDocumentRef {
            name: "base.hwpx".to_string(),
            path: Some(text(&input)),
            data_base64: None,
        };
        let edited = run(edit_request(document(), None, Some(ops), None, None, None)).unwrap();
        let output = root.join("edited.hwpx");
        std::fs::write(&output, BASE64.decode(edited.data_base64).unwrap()).unwrap();
        let after = read_ir(&output);
        assert_eq!(
            before["sections"][0]["paragraphs"][2], after["sections"][0]["paragraphs"][2],
            "the first identical phrase must remain entirely unchanged"
        );
        let changed = &after["sections"][0]["paragraphs"][4];
        assert_ne!(
            before["sections"][0]["paragraphs"][4]["char_shape_runs"],
            changed["char_shape_runs"]
        );
        let runs = changed["char_shape_runs"]
            .as_array()
            .expect("engine JSON IR exposes actual run shapes");
        assert!(
            runs.iter().any(|run| {
                let index = run[1].as_u64().expect("char shape ID is numeric") as usize;
                after["header"]["char_shapes"][index]["attr"]
                    .as_u64()
                    .unwrap()
                    & 2
                    != 0
            }),
            "the second identical phrase must have a bold run"
        );
        assert_eq!(
            std::fs::read(&input).unwrap(),
            original_bytes,
            "source document is not overwritten"
        );
        let rendered = run(hwped_render(document(), None, None)).unwrap();
        assert!(!rendered.pages.is_empty());
        assert!(
            rendered.pages.iter().all(|page| page.layout.is_some()),
            "released engine layout metadata must reach every returned page"
        );
        assert!(rendered
            .pages
            .iter()
            .any(|page| !page.layout.as_ref().unwrap().rows.is_empty()));
        println!(
            "HWPED_REAL_JSON_LAYOUT_PASS version={} pages={}",
            ensure_version(&binary).unwrap(),
            rendered.pages.len()
        );
    }

    #[cfg(unix)]
    #[test]
    fn phase08_21_hwped_real_fixture_results_and_legacy_rejections() {
        let home = crate::atomic_file::phase08_06::Home::new();
        let root = home.root.path().join("work");
        std::fs::create_dir_all(root.join("docs")).unwrap();
        std::fs::write(root.join("docs/a.hwpx"), b"doc").unwrap();
        let bin_dir = home.root.path().join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let _env = EnvGuard::set("MARU_HWP_BIN", &fake_hwp(&bin_dir));
        let work = text(&root);

        let read = run(hwped_read(doc_with_path("docs/a.hwpx"), Some(work.clone()))).unwrap();
        assert_eq!(read["title"], serde_json::json!("문서"));

        let rendered = run(hwped_render(
            doc_with_path("docs/a.hwpx"),
            None,
            Some(work.clone()),
        ))
        .unwrap();
        assert_eq!(rendered.pages.len(), 1);
        assert_eq!(rendered.pages[0].width, 100);
        assert_eq!(rendered.pages[0].height, 50);
        assert_eq!(rendered.pages[0].format, "svg");
        assert!(rendered.pages[0].layout.is_some());

        let layout_disabled = run(hwped_render(
            doc_with_path("docs/a.hwpx"),
            Some(HwpedRenderOptions {
                layout: Some(false),
                ..HwpedRenderOptions::default()
            }),
            Some(work.clone()),
        ))
        .unwrap();
        assert!(layout_disabled.pages[0].layout.is_none());

        let layout_required = run(hwped_render(
            doc_with_path("docs/a.hwpx"),
            Some(HwpedRenderOptions {
                layout: Some(true),
                ..HwpedRenderOptions::default()
            }),
            Some(work.clone()),
        ))
        .unwrap();
        assert!(layout_required.pages[0].layout.is_some());

        let edited = run(edit_request(
            doc_with_path("docs/a.hwpx"),
            Some(vec!["--replace".to_string(), "본문".to_string()]),
            None,
            None,
            None,
            Some(work.clone()),
        ))
        .unwrap();
        assert_eq!(
            BASE64.decode(edited.data_base64).unwrap(),
            b"edited".to_vec()
        );

        let composed = run(hwped_compose(
            serde_json::json!({"sections": []}),
            "보고서".to_string(),
        ))
        .unwrap();
        assert_eq!(composed.name, "보고서.hwpx");
        assert_eq!(
            BASE64.decode(composed.data_base64).unwrap(),
            b"composed".to_vec()
        );
        assert!(composed.report.is_some());

        let validated = run(hwped_validate(
            doc_with_path("docs/a.hwpx"),
            Some(work.clone()),
        ))
        .unwrap();
        assert!(validated.valid);
        assert!(validated.errors.is_empty());

        let capabilities = run(hwped_capabilities()).unwrap();
        assert_eq!(capabilities.version, "0.20.0");
        assert!(capabilities.editable);
        assert_eq!(
            serde_json::to_value(&capabilities).unwrap()["editOps"],
            "v1"
        );

        assert!(run(edit_request(
            doc_with_path("docs/a.hwpx"),
            Some(vec!["--replace".to_string()]),
            None,
            None,
            None,
            Some(work.clone()),
        ))
        .unwrap_err()
        .to_string()
        .contains("hwped_bad_request: opsArgv must be --flag value pairs"));
        assert!(run(hwped_render(
            doc_with_path("docs/a.hwpx"),
            Some(HwpedRenderOptions {
                pages: None,
                dpi: None,
                format: Some("pdf".to_string()),
                layout: None,
            }),
            Some(work.clone()),
        ))
        .unwrap_err()
        .to_string()
        .contains("hwped_bad_request"));
        assert!(run(hwped_compose(serde_json::json!({}), "  ".to_string()))
            .unwrap_err()
            .contains("hwped_bad_request: compose requires a non-empty name"));
        assert!(run(hwped_read(
            HwpedDocumentRef {
                name: "a.hwpx".to_string(),
                path: Some("../outside.hwpx".to_string()),
                data_base64: None,
            },
            Some(work),
        ))
        .unwrap_err()
        .contains("hwped_bad_request"));
    }
}
