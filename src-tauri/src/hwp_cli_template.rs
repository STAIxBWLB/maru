//! Native `hwp_cli_skill` template consumer.
//!
//! Hub records keep `hwpx_template_key` for schema compatibility, but when
//! their source is `hwp_cli_skill` that key is the released Korean alias for
//! an embedded hwp template, never a path to the retired binary-template tree.
//! Legacy `hwpx_skill` records name a template of that retired tree, by file
//! stem or by Hub seed key; the known keys map onto the same aliases, so they
//! fill natively too.
//! The generated document remains HWPX so the existing export contract is
//! unchanged. Outputs are built and validated in a sibling staging directory
//! and only then atomically published into the workspace.

use crate::artifact_checks::ArtifactCheck;
use crate::atomic_file::{
    with_path_transactions, write_atomic, PathTransactionLease, PathTransactionRequest,
};
use crate::cli_path::{augmented_path, is_executable, resolve_program};
use crate::command_output::{
    run_command_with_timeout_and_limits, CommandTermination, OutputLimits,
};
use crate::template_fill::TemplateField;
use crate::vault::resolve_inside_vault;
use crate::vault_list::{assert_maru_can_write, WorkspaceWriteAction};
use crate::win_process::NoWindow;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

const HWP_CLI_SKILL_SOURCE: &str = "hwp_cli_skill";
const LEGACY_HWPX_SKILL_SOURCE: &str = "hwpx_skill";
/// hwp 1.3.0 ships `hwp slots --forms` and `hwp fill --forms`, which own
/// every HWPX form scan and fill Maru runs, with the corrupt `.hwp`
/// merge/fill output fixed.
const MIN_HWP_VERSION: (u64, u64, u64) = (1, 3, 0);
const HWP_TIMEOUT: Duration = Duration::from_secs(60);
const STDOUT_LIMIT: usize = 32 * 1024 * 1024;
const STDERR_LIMIT: usize = 1024 * 1024;

const TEMPLATE_ALIASES: &[(&str, &str)] = &[
    ("기안문-내부결재", "gian-internal"),
    ("기안문-대외시행", "gian-external"),
    ("공문서-기본", "gongmun-basic"),
    ("보고서", "report"),
    ("사업계획서", "plan"),
    ("회의록", "minutes"),
];

/// Template keys of the retired `hwpx` skill, mapped to their released alias:
/// its template file stems, then the ASCII keys the Hub catalog seeds.
const LEGACY_HWPX_TEMPLATE_KEYS: &[(&str, &str)] = &[
    ("공문서_기본", "공문서-기본"),
    ("기안문_내부결재", "기안문-내부결재"),
    ("기안문_대외시행", "기안문-대외시행"),
    ("보고서_일반", "보고서"),
    ("사업계획서_기본", "사업계획서"),
    ("회의록", "회의록"),
    ("gongmun_default", "공문서-기본"),
    ("gibun_internal_approval", "기안문-내부결재"),
    ("gibun_external_dispatch", "기안문-대외시행"),
    ("bogoseo_general", "보고서"),
    ("business_plan_default", "사업계획서"),
    ("meeting_minutes_default", "회의록"),
];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HwpCliTemplateFieldsRequest {
    pub source: String,
    pub template_key: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HwpCliTemplateFieldsResponse {
    pub template_alias: String,
    pub template_slug: String,
    pub fields: Vec<TemplateField>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HwpCliTemplateFillRequest {
    pub source: String,
    pub template_key: String,
    #[serde(default)]
    pub values: BTreeMap<String, String>,
    pub output_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HwpCliTemplateFillResponse {
    pub output_path: String,
    pub template_alias: String,
    pub template_slug: String,
    pub replaced_count: u32,
    pub validation_ok: bool,
    pub command: String,
    pub form_filled_count: u32,
    pub unmatched_fields: Vec<String>,
    pub validation_checks: Vec<ArtifactCheck>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct SlotsResponse {
    #[serde(default)]
    placeholders: Vec<Slot>,
}

#[derive(Debug, Deserialize)]
struct Slot {
    name: String,
    occurrences: u32,
}

/// `hwp slots --forms --json`, read for hwp's merged Korean form-field view.
/// `fields` already holds every slot under its normalized key (source
/// `placeholder`, `required`), so it is the one field list; the separate
/// `placeholders` list is not read.
#[derive(Debug, Deserialize)]
pub(crate) struct FormScan {
    pub(crate) fields: Vec<FormField>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct FormField {
    pub(crate) key: String,
    pub(crate) label: String,
    pub(crate) source: String,
    pub(crate) confidence: f32,
    pub(crate) occurrences: u32,
    pub(crate) required: bool,
}

impl FormScan {
    /// A requested key hwp fills as a `{{slot}}`: hwp marks every slot's
    /// field `required`, and fill matches keys normalized like field keys.
    pub(crate) fn is_slot(&self, key: &str) -> bool {
        let key = normalize_key(key);
        self.fields
            .iter()
            .any(|field| field.required && field.key == key)
    }
}

/// The closed JSON contract of `hwp fill --forms --json`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct FormsFillReport {
    output: String,
    mode: String,
    replaced: u32,
    pub(crate) counts: BTreeMap<String, u32>,
    pub(crate) unmatched: Vec<String>,
    pub(crate) warnings: Vec<String>,
}

/// The part of `hwp validate --json` Maru reads.
#[derive(Debug, Deserialize)]
pub(crate) struct ValidateReport {
    pub(crate) valid: bool,
    /// `hwpx`, `hwp5` or `unknown`: hwp validates an HWP5 file as valid too.
    pub(crate) format: String,
    #[serde(default)]
    pub(crate) errors: Vec<String>,
}

/// The closed JSON contract emitted by `hwp fill --json` for placeholder fills.
///
/// This is deliberately not a loose `serde_json::Value`: Maru only publishes a
/// staged document after the native tool has supplied an internally consistent
/// report for every requested value.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct NativeFillReport {
    output: String,
    mode: String,
    pub(crate) replaced: u32,
    counts: BTreeMap<String, u32>,
    pub(crate) warnings: Vec<String>,
}

struct CliRun {
    code: i32,
    stdout: Vec<u8>,
    stderr: String,
}

#[cfg(test)]
fn hwp_cli_skill_aliases() -> &'static [(&'static str, &'static str)] {
    TEMPLATE_ALIASES
}

/// `사업계획서_기본.HWPX` -> `사업계획서_기본`; anything else is returned unchanged.
fn without_hwpx_extension(key: &str) -> &str {
    let cut = key.len().saturating_sub(".hwpx".len());
    match key.get(cut..) {
        Some(ext) if ext.eq_ignore_ascii_case(".hwpx") => &key[..cut],
        _ => key,
    }
}

fn canonical_template(source: &str, key: &str) -> Result<(&'static str, &'static str), String> {
    let alias = match source {
        HWP_CLI_SKILL_SOURCE => key,
        LEGACY_HWPX_SKILL_SOURCE => LEGACY_HWPX_TEMPLATE_KEYS
            .iter()
            .find(|(legacy, _)| *legacy == without_hwpx_extension(key))
            .map(|(_, alias)| *alias)
            .ok_or_else(|| {
                let known = LEGACY_HWPX_TEMPLATE_KEYS
                    .iter()
                    .map(|(legacy, _)| *legacy)
                    .collect::<Vec<_>>()
                    .join(", ");
                format!(
                    "template_alias_invalid: unsupported legacy hwpx_skill template key: {key} (supported: {known}); re-pick the template as hwp_cli_skill"
                )
            })?,
        _ => {
            return Err(format!(
                "template_source_invalid: expected {HWP_CLI_SKILL_SOURCE} or {LEGACY_HWPX_SKILL_SOURCE}, got {source}"
            ))
        }
    };
    TEMPLATE_ALIASES
        .iter()
        .copied()
        .find(|(known_alias, _)| *known_alias == alias)
        .ok_or_else(|| format!("template_alias_invalid: unsupported hwp_cli_skill alias: {alias}"))
}

fn hwp_candidates() -> Vec<PathBuf> {
    let mut candidates = resolve_program("hwp").into_iter().collect::<Vec<_>>();
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".maru/skills/hwp/hwp"));
        candidates.push(home.join(".maru/skills/_builtin/skills/hwp/hwp"));
    }
    candidates
        .push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("skills-bootstrap/skills/hwp/hwp"));
    candidates
}

fn select_compatible_hwp(candidates: impl IntoIterator<Item = PathBuf>) -> Result<PathBuf, String> {
    let mut version_errors = Vec::new();
    for candidate in candidates {
        if !is_executable(&candidate) {
            continue;
        }
        match ensure_released_version(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) => version_errors.push(error),
        }
    }
    Err(version_errors.into_iter().next().unwrap_or_else(|| {
        let (major, minor, patch) = MIN_HWP_VERSION;
        format!("cli_missing: released hwp >= {major}.{minor}.{patch} binary not found; install/export the unified hwp skill or set MARU_HWP_BIN")
    }))
}

fn select_hwp_bin(
    override_path: Option<PathBuf>,
    candidates: impl IntoIterator<Item = PathBuf>,
) -> Result<PathBuf, String> {
    if let Some(path) = override_path {
        if !is_executable(&path) {
            return Err("cli_missing: MARU_HWP_BIN is not executable".to_string());
        }
        ensure_released_version(&path)?;
        return Ok(path);
    }
    select_compatible_hwp(candidates)
}

pub(crate) fn hwp_bin() -> Result<PathBuf, String> {
    select_hwp_bin(
        std::env::var_os("MARU_HWP_BIN").map(PathBuf::from),
        hwp_candidates(),
    )
}

fn run_hwp(bin: &Path, args: &[OsString]) -> Result<CliRun, String> {
    let subcommand = args
        .first()
        .map(|arg| arg.to_string_lossy())
        .unwrap_or_default();
    let mut command = Command::new(bin);
    command.args(args).env("PATH", augmented_path());
    let output = run_command_with_timeout_and_limits(
        command.no_window(),
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
        // The runner keeps only the tail of an oversized stream, which no
        // caller can parse (a JSON report, an HTML document).
        CommandTermination::Exited if output.stdout_truncated => Err(format!(
            "hwp_output_too_large: hwp {subcommand} printed more than {} MiB on stdout",
            STDOUT_LIMIT / (1024 * 1024)
        )),
        CommandTermination::Exited => Ok(CliRun {
            code: output.status.code().unwrap_or(1),
            stdout: output.stdout,
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        }),
    }
}

fn run_hwp_ok(bin: &Path, args: &[OsString]) -> Result<Vec<u8>, String> {
    let run = run_hwp(bin, args)?;
    if run.code == 0 {
        return Ok(run.stdout);
    }
    let subcommand = args
        .first()
        .map(|arg| arg.to_string_lossy())
        .unwrap_or_default();
    Err(format!(
        "hwp_failed: hwp {subcommand} failed (exit {}): {}",
        run.code, run.stderr
    ))
}

fn parse_version(stdout: &[u8]) -> Option<(u64, u64, u64)> {
    String::from_utf8_lossy(stdout)
        .split_whitespace()
        .find_map(|token| {
            let pieces = token
                .trim_start_matches('v')
                .split('.')
                .map(str::parse::<u64>)
                .collect::<Result<Vec<_>, _>>()
                .ok()?;
            (pieces.len() == 3).then(|| (pieces[0], pieces[1], pieces[2]))
        })
}

fn ensure_released_version(bin: &Path) -> Result<(), String> {
    let output = run_hwp_ok(bin, &[OsString::from("--version")])?;
    let version = parse_version(&output).ok_or_else(|| {
        format!(
            "hwp_version: cannot parse hwp --version output: {}",
            String::from_utf8_lossy(&output).trim()
        )
    })?;
    if version < MIN_HWP_VERSION {
        return Err(format!(
            "hwp_version: hwp {}.{}.{} is too old; Maru requires >= {}.{}.{}",
            version.0,
            version.1,
            version.2,
            MIN_HWP_VERSION.0,
            MIN_HWP_VERSION.1,
            MIN_HWP_VERSION.2
        ));
    }
    Ok(())
}

fn native_template_path(dir: &Path) -> PathBuf {
    dir.join("template.hwpx")
}

fn create_template(bin: &Path, alias: &str, output: &Path) -> Result<(), String> {
    run_hwp_ok(
        bin,
        &[
            OsString::from("new"),
            OsString::from("--template"),
            OsString::from(alias),
            OsString::from("-o"),
            output.as_os_str().to_os_string(),
        ],
    )?;
    Ok(())
}

pub(crate) fn validate_template(bin: &Path, output: &Path) -> Result<(), String> {
    run_hwp_ok(
        bin,
        &[
            OsString::from("validate"),
            output.as_os_str().to_os_string(),
            OsString::from("--json"),
        ],
    )?;
    Ok(())
}

pub(crate) fn slots_for(bin: &Path, document: &Path) -> Result<Vec<TemplateField>, String> {
    let output = run_hwp_ok(
        bin,
        &[
            OsString::from("slots"),
            document.as_os_str().to_os_string(),
            OsString::from("--json"),
        ],
    )?;
    let parsed: SlotsResponse =
        serde_json::from_slice(&output).map_err(|err| format!("hwp_slots_invalid_json: {err}"))?;
    Ok(parsed
        .placeholders
        .into_iter()
        .map(|slot| TemplateField {
            key: slot.name.clone(),
            label: slot.name,
            required: true,
            occurrences: slot.occurrences,
            source: Some("placeholder".to_string()),
            confidence: Some(1.0),
            matched_key: None,
        })
        .collect())
}

pub(crate) fn form_scan(bin: &Path, document: &Path) -> Result<FormScan, String> {
    let output = run_hwp_ok(
        bin,
        &[
            OsString::from("slots"),
            document.as_os_str().to_os_string(),
            OsString::from("--forms"),
            OsString::from("--json"),
        ],
    )?;
    serde_json::from_slice(&output).map_err(|err| format!("hwp_slots_invalid_json: {err}"))
}

/// `hwp validate --json`. hwp prints its report on stdout and exits 1 for an
/// invalid package, so the report is read by schema, not by exit code.
pub(crate) fn validate_report(bin: &Path, document: &Path) -> Result<ValidateReport, String> {
    let run = run_hwp(
        bin,
        &[
            OsString::from("validate"),
            document.as_os_str().to_os_string(),
            OsString::from("--json"),
        ],
    )?;
    serde_json::from_slice(&run.stdout).map_err(|err| {
        format!(
            "hwp_validate_invalid_json: {err} (exit {}): {}",
            run.code, run.stderr
        )
    })
}

/// `sections` of `hwp info --json`.
pub(crate) fn info_sections(bin: &Path, document: &Path) -> Result<usize, String> {
    #[derive(Deserialize)]
    struct Info {
        sections: usize,
    }
    let output = run_hwp_ok(
        bin,
        &[
            OsString::from("info"),
            document.as_os_str().to_os_string(),
            OsString::from("--json"),
        ],
    )?;
    serde_json::from_slice::<Info>(&output)
        .map(|info| info.sections)
        .map_err(|err| format!("hwp_info_invalid_json: {err}"))
}

/// `hwp convert <document> --to html -o -`: a complete HTML document.
pub(crate) fn convert_to_html(bin: &Path, document: &Path) -> Result<String, String> {
    let output = run_hwp_ok(
        bin,
        &[
            OsString::from("convert"),
            document.as_os_str().to_os_string(),
            OsString::from("--to"),
            OsString::from("html"),
            OsString::from("-o"),
            OsString::from("-"),
        ],
    )?;
    String::from_utf8(output).map_err(|err| format!("hwp_convert_invalid_utf8: {err}"))
}

fn fields_with_bin(
    bin: &Path,
    source: &str,
    template_key: &str,
) -> Result<HwpCliTemplateFieldsResponse, String> {
    let (alias, slug) = canonical_template(source, template_key)?;
    ensure_released_version(bin)?;
    let dir = tempfile::tempdir().map_err(|err| format!("hwp_stage_failed: {err}"))?;
    let template = native_template_path(dir.path());
    create_template(bin, alias, &template)?;
    validate_template(bin, &template)?;
    Ok(HwpCliTemplateFieldsResponse {
        template_alias: alias.to_string(),
        template_slug: slug.to_string(),
        fields: slots_for(bin, &template)?,
        warnings: Vec::new(),
    })
}

fn output_path(work_path: &str, alias: &str, requested: Option<String>) -> Result<PathBuf, String> {
    let candidate = requested.unwrap_or_else(|| format!(".maru/studio/filled/{alias}-filled.hwpx"));
    let resolved = resolve_inside_vault(work_path, &candidate)?;
    if resolved
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("hwpx"))
        != Some(true)
    {
        return Err("hwp_cli_skill output path must end with .hwpx".to_string());
    }
    Ok(resolved)
}

fn parse_native_fill_report(
    stdout: &[u8],
    values: &BTreeMap<String, String>,
) -> Result<NativeFillReport, String> {
    let report: NativeFillReport =
        serde_json::from_slice(stdout).map_err(|err| format!("hwp_fill_invalid_json: {err}"))?;
    check_report_header(&report.mode, "placeholders", &report.output)?;
    check_report_counts(&report.counts, values, |_| false)?;
    let unmatched = report
        .counts
        .iter()
        .filter(|(_, count)| **count == 0)
        .map(|(name, _)| name.clone())
        .collect::<Vec<_>>();
    if !unmatched.is_empty() {
        return Err(format!(
            "hwp_fill_unmatched_required: {}",
            unmatched.join(", ")
        ));
    }
    check_report_total(&report.counts, report.replaced)?;
    Ok(report)
}

/// The `--forms` report must account for every requested key: `counts` holds
/// exactly the requested keys (hwp drops, with a warning, a key that
/// normalizes to nothing), every `unmatched` key has a zero count, and
/// `replaced` is the counts total. A zero count outside `unmatched` is a
/// checkbox a falsy value left unchecked, which hwp counts as matched.
fn parse_forms_fill_report(
    stdout: &[u8],
    values: &BTreeMap<String, String>,
) -> Result<FormsFillReport, String> {
    let report: FormsFillReport =
        serde_json::from_slice(stdout).map_err(|err| format!("hwp_fill_invalid_json: {err}"))?;
    check_report_header(&report.mode, "forms", &report.output)?;
    check_report_counts(&report.counts, values, normalizes_to_nothing)?;
    let disagreeing = report
        .unmatched
        .iter()
        .filter(|name| report.counts.get(*name) != Some(&0))
        .cloned()
        .collect::<Vec<_>>();
    if !disagreeing.is_empty() {
        return Err(format!(
            "hwp_fill_invalid_report: unmatched {} without a zero count",
            disagreeing.join(", ")
        ));
    }
    check_report_total(&report.counts, report.replaced)?;
    Ok(report)
}

/// hwp's form-key normalization: trimmed, then spaces, colons,
/// parentheses and middle dots removed.
fn normalize_key(key: &str) -> String {
    key.trim().replace(
        [':', '：', ' ', '\t', '\n', '\r', '(', ')', '（', '）', '·'],
        "",
    )
}

fn normalizes_to_nothing(key: &str) -> bool {
    normalize_key(key).is_empty()
}

fn check_report_header(mode: &str, expected: &str, output: &str) -> Result<(), String> {
    if mode != expected {
        return Err(format!(
            "hwp_fill_invalid_report: expected {expected} mode, got {mode}"
        ));
    }
    if output.trim().is_empty() {
        return Err("hwp_fill_invalid_report: native fill report omitted output".to_string());
    }
    Ok(())
}

fn check_report_counts(
    counts: &BTreeMap<String, u32>,
    values: &BTreeMap<String, String>,
    may_omit: impl Fn(&str) -> bool,
) -> Result<(), String> {
    let missing_counts = values
        .keys()
        .filter(|name| !counts.contains_key(*name) && !may_omit(name))
        .cloned()
        .collect::<Vec<_>>();
    if !missing_counts.is_empty() {
        return Err(format!(
            "hwp_fill_invalid_report: native fill report omitted counts for {}",
            missing_counts.join(", ")
        ));
    }
    let unexpected_counts = counts
        .keys()
        .filter(|name| !values.contains_key(*name))
        .cloned()
        .collect::<Vec<_>>();
    if !unexpected_counts.is_empty() {
        return Err(format!(
            "hwp_fill_invalid_report: native fill report included unexpected counts for {}",
            unexpected_counts.join(", ")
        ));
    }
    Ok(())
}

fn check_report_total(counts: &BTreeMap<String, u32>, replaced: u32) -> Result<(), String> {
    let counted_replacements = counts.values().try_fold(0u32, |total, count| {
        total
            .checked_add(*count)
            .ok_or_else(|| "hwp_fill_invalid_report: replacement count overflow".to_string())
    })?;
    if replaced != counted_replacements {
        return Err(format!(
            "hwp_fill_invalid_report: replaced {replaced} does not match counts total {counted_replacements}"
        ));
    }
    Ok(())
}

/// `hwp fill <template> --data <values.json> -o <output> --json` for exactly
/// `values`; hwp fails closed on an unreplaced request, and the report must
/// account for every value.
fn fill_slots(
    bin: &Path,
    template: &Path,
    values_path: &Path,
    output: &Path,
    values: &BTreeMap<String, String>,
) -> Result<NativeFillReport, String> {
    let stdout = run_hwp_ok(bin, &fill_args(template, values_path, output, &[]))?;
    parse_native_fill_report(&stdout, values)
}

/// `hwp fill <template> --forms --data <values.json> -o <output> --json
/// --allow-partial`: slots and Korean form fields from `values` in one pass.
/// hwp publishes whatever matched (the input unchanged when nothing did) and
/// reports the rest, so the caller decides which misses are errors.
pub(crate) fn fill_forms(
    bin: &Path,
    template: &Path,
    values_path: &Path,
    output: &Path,
    values: &BTreeMap<String, String>,
) -> Result<FormsFillReport, String> {
    let stdout = run_hwp_ok(
        bin,
        &fill_args(
            template,
            values_path,
            output,
            &["--forms", "--allow-partial"],
        ),
    )?;
    parse_forms_fill_report(&stdout, values)
}

pub(crate) fn fill_args(
    template: &Path,
    values_path: &Path,
    output: &Path,
    flags: &[&str],
) -> Vec<OsString> {
    let mut args = vec![
        OsString::from("fill"),
        template.as_os_str().to_os_string(),
        OsString::from("--data"),
        values_path.as_os_str().to_os_string(),
        OsString::from("-o"),
        output.as_os_str().to_os_string(),
        OsString::from("--json"),
    ];
    args.extend(flags.iter().map(OsString::from));
    args
}

pub fn hwp_cli_template_fields(
    request: HwpCliTemplateFieldsRequest,
) -> Result<HwpCliTemplateFieldsResponse, String> {
    let bin = hwp_bin()?;
    fields_with_bin(&bin, &request.source, &request.template_key)
}

pub fn hwp_cli_template_fill(
    work_path: String,
    request: HwpCliTemplateFillRequest,
) -> Result<HwpCliTemplateFillResponse, String> {
    fill_impl(&work_path, &request, None)
}

fn fill_impl(
    work_path: &str,
    request: &HwpCliTemplateFillRequest,
    bin_override: Option<PathBuf>,
) -> Result<HwpCliTemplateFillResponse, String> {
    if request.values.is_empty() {
        return Err("hwp_cli_skill requires at least one template value".to_string());
    }
    let (alias, _) = canonical_template(&request.source, &request.template_key)?;
    let output = output_path(work_path, alias, request.output_path.clone())?;
    let parent = output
        .parent()
        .ok_or_else(|| "hwp_cli_skill output path has no parent".to_string())?
        .to_path_buf();
    let root = resolve_inside_vault(work_path, ".")?;
    let admission = PathTransactionRequest::new(vec![output.clone(), parent.clone()])?
        .require_parent(&root)?
        .with_workspace_registry()?;
    with_path_transactions(admission, |lease| {
        lease.ensure_workspace_registry()?;
        lease.ensure_covered(vec![output.clone(), parent.clone()])?;
        let bin = match bin_override {
            Some(path) => select_hwp_bin(Some(path), Vec::new())?,
            None => hwp_bin()?,
        };
        let write_action = if output.is_file() {
            WorkspaceWriteAction::Modify
        } else {
            WorkspaceWriteAction::Create
        };
        assert_maru_can_write(work_path, write_action)?;
        lease.before_effect()?;
        fill_with_bin(
            &bin,
            work_path,
            &request.source,
            &request.template_key,
            &request.values,
            request.output_path.clone(),
            lease,
        )
    })
}

fn fill_with_bin(
    bin: &Path,
    work_path: &str,
    source: &str,
    template_key: &str,
    values: &BTreeMap<String, String>,
    requested_output: Option<String>,
    lease: &PathTransactionLease,
) -> Result<HwpCliTemplateFillResponse, String> {
    let (alias, slug) = canonical_template(source, template_key)?;
    ensure_released_version(bin)?;
    let output = output_path(work_path, alias, requested_output)?;
    let parent = output
        .parent()
        .ok_or_else(|| "hwp_cli_skill output path has no parent".to_string())?
        .to_path_buf();
    lease.ensure_covered(vec![output.clone(), parent.clone()])?;
    fs::create_dir_all(&parent).map_err(|err| format!("Cannot create output directory: {err}"))?;
    let stage = tempfile::Builder::new()
        .prefix(".maru-hwp-cli-")
        .tempdir_in(&parent)
        .map_err(|err| format!("hwp_stage_failed: {err}"))?;
    let template = native_template_path(stage.path());
    let staged_output = stage.path().join("filled.hwpx");
    let values_path = stage.path().join("values.json");
    fs::write(
        &values_path,
        serde_json::to_vec(values).map_err(|err| format!("hwp_values_invalid: {err}"))?,
    )
    .map_err(|err| format!("hwp_stage_failed: {err}"))?;
    create_template(bin, alias, &template)?;
    validate_template(bin, &template)?;
    let native_report = fill_slots(bin, &template, &values_path, &staged_output, values)?;
    validate_template(bin, &staged_output)?;
    let staged_bytes = fs::read(&staged_output)
        .map_err(|err| format!("hwp_publish_failed: cannot read staged output: {err}"))?;
    write_atomic(&output, &staged_bytes).map_err(|err| format!("hwp_publish_failed: {err}"))?;
    Ok(HwpCliTemplateFillResponse {
        output_path: output.to_string_lossy().to_string(),
        template_alias: alias.to_string(),
        template_slug: slug.to_string(),
        replaced_count: native_report.replaced,
        validation_ok: true,
        command:
            "hwp new --template <alias> -> hwp fill --data <values.json> --json -> hwp validate"
                .to_string(),
        form_filled_count: native_report.replaced,
        unmatched_fields: Vec::new(),
        validation_checks: vec![ArtifactCheck::pass("hwp-validate")],
        warnings: native_report.warnings,
    })
}

/// Owned IPC boundaries; the synchronous entry points remain available to Rust callers.
pub mod ipc {
    use super::*;
    #[tauri::command]
    pub async fn hwp_cli_template_fields(
        request: HwpCliTemplateFieldsRequest,
    ) -> Result<HwpCliTemplateFieldsResponse, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[std::env::temp_dir()],
                "worker:hwp_cli_template_fields",
            );
            super::hwp_cli_template_fields(request)
        })
        .await
        .map_err(|err| format!("hwp_cli_template_fields_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn hwp_cli_template_fill(
        work_path: String,
        request: HwpCliTemplateFillRequest,
    ) -> Result<HwpCliTemplateFillResponse, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:hwp_cli_template_fill",
            );
            super::hwp_cli_template_fill(work_path, request)
        })
        .await
        .map_err(|err| format!("hwp_cli_template_fill_task_failed: {err}"))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn fake_hwp(
        dir: &Path,
        version: &str,
        fail_filled_validation: bool,
        fill_stdout: &str,
    ) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let binary = dir.join("hwp");
        let validate_exit = if fail_filled_validation {
            "exit 1"
        } else {
            "exit 0"
        };
        let script = format!(
            r#"#!/bin/sh
case "$1" in
  --version) echo "hwp {version}" ;;
  new)
    shift
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "-o" ]; then shift; printf 'template' > "$1"; exit 0; fi
      shift
    done
    exit 2 ;;
  slots) echo '{{"placeholders":[{{"name":"기관명","occurrences":1}}]}}' ;;
  fill)
    output=""
    json=false
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "-o" ]; then shift; output="$1"; fi
      if [ "$1" = "--json" ]; then json=true; fi
      shift
    done
    [ -n "$output" ] && [ "$json" = true ] || exit 2
    printf 'filled' > "$output"
    printf '%s\n' '{fill_stdout}'
    exit 0 ;;
  validate)
    case "$2" in *filled.hwpx) {validate_exit} ;; *) exit 0 ;; esac ;;
  *) exit 2 ;;
esac
"#
        );
        fs::write(&binary, script).unwrap();
        let mut permissions = fs::metadata(&binary).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&binary, permissions).unwrap();
        binary
    }

    #[test]
    fn maps_the_six_released_aliases_and_rejects_everything_else() {
        assert_eq!(hwp_cli_skill_aliases().len(), 6);
        for (alias, slug) in hwp_cli_skill_aliases() {
            assert_eq!(
                canonical_template("hwp_cli_skill", alias).unwrap(),
                (*alias, *slug)
            );
        }
        assert!(canonical_template("manual", "보고서")
            .unwrap_err()
            .contains("template_source_invalid"));
        assert!(canonical_template("hwp_cli_skill", "공고문")
            .unwrap_err()
            .contains("template_alias_invalid"));
    }

    #[test]
    fn maps_the_legacy_hwpx_skill_keys_onto_released_aliases() {
        let expected = [
            ("공문서_기본", "공문서-기본", "gongmun-basic"),
            ("기안문_내부결재", "기안문-내부결재", "gian-internal"),
            ("기안문_대외시행", "기안문-대외시행", "gian-external"),
            ("보고서_일반", "보고서", "report"),
            ("사업계획서_기본", "사업계획서", "plan"),
            ("회의록", "회의록", "minutes"),
            // maru-hub scripts/seed_catalog.py hwpx_skill seeds
            ("gongmun_default", "공문서-기본", "gongmun-basic"),
            (
                "gibun_internal_approval",
                "기안문-내부결재",
                "gian-internal",
            ),
            (
                "gibun_external_dispatch",
                "기안문-대외시행",
                "gian-external",
            ),
            ("bogoseo_general", "보고서", "report"),
            ("business_plan_default", "사업계획서", "plan"),
            ("meeting_minutes_default", "회의록", "minutes"),
        ];
        assert_eq!(LEGACY_HWPX_TEMPLATE_KEYS.len(), expected.len());
        for (legacy, alias, slug) in expected {
            assert_eq!(
                canonical_template("hwpx_skill", legacy).unwrap(),
                (alias, slug)
            );
        }
        // A key saved with its template file name resolves to the same alias.
        assert_eq!(
            canonical_template("hwpx_skill", "사업계획서_기본.hwpx").unwrap(),
            ("사업계획서", "plan")
        );
        assert_eq!(
            canonical_template("hwpx_skill", "business_plan_default.HWPX").unwrap(),
            ("사업계획서", "plan")
        );
        // A released alias is not a legacy key, and an unknown key names the supported ones.
        let error = canonical_template("hwpx_skill", "보고서").unwrap_err();
        assert!(error.contains("template_alias_invalid"), "{error}");
        assert!(error.contains("사업계획서_기본"), "{error}");
    }

    #[test]
    fn version_parser_requires_the_released_floor() {
        assert_eq!(parse_version(b"hwp 1.2.0"), Some((1, 2, 0)));
        assert_eq!(parse_version(b"hwp 1.3.0"), Some((1, 3, 0)));
        assert_eq!(parse_version(b"hwp v1.3.0 (abc)"), Some((1, 3, 0)));
        assert_eq!(parse_version(b"broken"), None);
    }

    #[test]
    fn forms_fill_report_follows_the_closed_contract() {
        let values = BTreeMap::from([
            ("제목".to_string(), "a".to_string()),
            ("동의".to_string(), "false".to_string()),
            ("없는키".to_string(), "b".to_string()),
            (" : ".to_string(), "dropped".to_string()),
        ]);
        let parse = |json: &str| parse_forms_fill_report(json.as_bytes(), &values);
        // A falsy checkbox counts 0 but matched; a key that normalizes to
        // nothing is dropped by hwp.
        let report = parse(
            r#"{"output":"o.hwpx","mode":"forms","replaced":1,"counts":{"동의":0,"없는키":0,"제목":1},"unmatched":["없는키"],"warnings":["w"]}"#,
        )
        .unwrap();
        assert_eq!(report.unmatched, ["없는키"]);
        assert_eq!(report.warnings, ["w"]);

        for (json, expected) in [
            (
                r#"{"output":"o.hwpx","mode":"placeholders","replaced":1,"counts":{"동의":0,"없는키":0,"제목":1},"unmatched":[],"warnings":[]}"#,
                "expected forms mode",
            ),
            (
                r#"{"output":"o.hwpx","mode":"forms","replaced":1,"counts":{"제목":1},"unmatched":[],"warnings":[]}"#,
                "omitted counts for 동의, 없는키",
            ),
            (
                r#"{"output":"o.hwpx","mode":"forms","replaced":1,"counts":{"동의":0,"없는키":0,"제목":1,"기타":0},"unmatched":[],"warnings":[]}"#,
                "unexpected counts for 기타",
            ),
            (
                r#"{"output":"o.hwpx","mode":"forms","replaced":2,"counts":{"동의":0,"없는키":0,"제목":1},"unmatched":[],"warnings":[]}"#,
                "replaced 2 does not match counts total 1",
            ),
            (
                r#"{"output":"o.hwpx","mode":"forms","replaced":1,"counts":{"동의":0,"없는키":0,"제목":1},"unmatched":["제목"],"warnings":[]}"#,
                "unmatched 제목 without a zero count",
            ),
            (
                r#"{"output":"o.hwpx","mode":"forms","replaced":1,"counts":{"동의":0,"없는키":0,"제목":1},"warnings":[]}"#,
                "hwp_fill_invalid_json",
            ),
        ] {
            let error = parse(json).unwrap_err();
            assert!(error.contains(expected), "{expected}: {error}");
        }
        assert!(normalizes_to_nothing(" （）：· "));
        assert!(!normalizes_to_nothing("[]"));
    }

    #[test]
    fn form_scan_marks_slots_by_normalized_required_field_key() {
        let scan: FormScan = serde_json::from_str(
            r#"{"placeholders":[{"name":"성 명","occurrences":1}],"fields":[
                {"key":"성명","label":"성 명","source":"placeholder","confidence":1.0,"occurrences":1,"required":true},
                {"key":"주소","label":"주소","source":"formLabel","confidence":0.72,"occurrences":1,"required":false}]}"#,
        )
        .unwrap();
        assert!(scan.is_slot("성 명"));
        assert!(scan.is_slot("성명"));
        // hwp fill matches `성  명` and `성명:` to the same slot.
        assert!(scan.is_slot(" 성  명: "));
        assert!(!scan.is_slot("주소"));
        assert!(serde_json::from_str::<FormScan>(r#"{"placeholders":[]}"#).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn oversized_hwp_stdout_fails_with_a_size_limit_error() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let binary = tmp.path().join("hwp");
        // A document just over the stdout limit: the runner keeps only its
        // tail, so a parse would report a misleading error.
        let script = format!(
            "#!/bin/sh\nprintf '<html><body>'\nhead -c {} /dev/zero\nprintf '</body></html>'\n",
            STDOUT_LIMIT
        );
        fs::write(&binary, script).unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();

        let error = convert_to_html(&binary, tmp.path()).unwrap_err();
        assert_eq!(
            error,
            "hwp_output_too_large: hwp convert printed more than 32 MiB on stdout"
        );
        let error = validate_report(&binary, tmp.path()).unwrap_err();
        assert!(
            error.starts_with("hwp_output_too_large: hwp validate"),
            "{error}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn released_version_floor_rejects_1_2_0_and_accepts_1_3_0() {
        let too_old = tempfile::tempdir().unwrap();
        let too_old_binary = fake_hwp(
            too_old.path(),
            "1.2.0",
            false,
            r#"{"output":"filled.hwpx","mode":"placeholders","replaced":1,"counts":{"기관명":1},"warnings":[]}"#,
        );
        let error = ensure_released_version(&too_old_binary).unwrap_err();
        assert!(error.contains("hwp 1.2.0 is too old"));
        assert!(error.contains("requires >= 1.3.0"));

        let released = tempfile::tempdir().unwrap();
        let released_binary = fake_hwp(
            released.path(),
            "1.3.0",
            false,
            r#"{"output":"filled.hwpx","mode":"placeholders","replaced":1,"counts":{"기관명":1},"warnings":[]}"#,
        );
        assert!(ensure_released_version(&released_binary).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn automatic_discovery_skips_an_old_path_binary_for_a_managed_release() {
        let tmp = tempfile::tempdir().unwrap();
        let path_dir = tmp.path().join("path");
        let managed_dir = tmp.path().join("managed");
        fs::create_dir_all(&path_dir).unwrap();
        fs::create_dir_all(&managed_dir).unwrap();
        let old_path_binary = fake_hwp(
            &path_dir,
            "1.1.9",
            false,
            r#"{"output":"filled.hwpx","mode":"placeholders","replaced":1,"counts":{"기관명":1},"warnings":[]}"#,
        );
        let managed_binary = fake_hwp(
            &managed_dir,
            "1.3.0",
            false,
            r#"{"output":"filled.hwpx","mode":"placeholders","replaced":1,"counts":{"기관명":1},"warnings":[]}"#,
        );

        assert_eq!(
            select_compatible_hwp(vec![old_path_binary, managed_binary.clone()]).unwrap(),
            managed_binary
        );
    }

    #[cfg(unix)]
    #[test]
    fn explicit_override_is_authoritative_but_must_meet_the_version_floor() {
        let tmp = tempfile::tempdir().unwrap();
        let old_dir = tmp.path().join("old");
        let released_dir = tmp.path().join("released");
        fs::create_dir_all(&old_dir).unwrap();
        fs::create_dir_all(&released_dir).unwrap();
        let old_override = fake_hwp(
            &old_dir,
            "1.2.0",
            false,
            r#"{"output":"filled.hwpx","mode":"placeholders","replaced":1,"counts":{"기관명":1},"warnings":[]}"#,
        );
        let released_override = fake_hwp(
            &released_dir,
            "1.3.0",
            false,
            r#"{"output":"filled.hwpx","mode":"placeholders","replaced":1,"counts":{"기관명":1},"warnings":[]}"#,
        );

        let error =
            select_hwp_bin(Some(old_override), vec![released_override.clone()]).unwrap_err();
        assert!(error.contains("hwp 1.2.0 is too old"));
        assert_eq!(
            select_hwp_bin(Some(released_override.clone()), Vec::new()).unwrap(),
            released_override
        );
    }

    #[test]
    fn native_output_keeps_hwp_format_semantics() {
        let tmp = tempfile::tempdir().unwrap();
        let output = output_path(tmp.path().to_str().unwrap(), "보고서", None).unwrap();
        assert!(output.ends_with(".maru/studio/filled/보고서-filled.hwpx"));
        assert!(output_path(
            tmp.path().to_str().unwrap(),
            "보고서",
            Some("result.docx".to_string())
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn all_aliases_route_through_native_new_slots_and_validate() {
        let tmp = tempfile::tempdir().unwrap();
        let binary = fake_hwp(
            tmp.path(),
            "1.3.0",
            false,
            r#"{"output":"filled.hwpx","mode":"placeholders","replaced":1,"counts":{"기관명":1},"warnings":[]}"#,
        );
        for (alias, slug) in hwp_cli_skill_aliases() {
            let response = fields_with_bin(&binary, "hwp_cli_skill", alias).unwrap();
            assert_eq!(response.template_alias, *alias);
            assert_eq!(response.template_slug, *slug);
            assert_eq!(response.fields[0].key, "기관명");
        }
    }

    #[cfg(unix)]
    fn fill_with_test_bin(
        binary: &Path,
        work_path: &str,
        source: &str,
        template_key: &str,
        values: &BTreeMap<String, String>,
        requested_output: Option<String>,
    ) -> Result<HwpCliTemplateFillResponse, String> {
        let _home = crate::atomic_file::phase08_06::Home::new();
        fill_impl(
            work_path,
            &HwpCliTemplateFillRequest {
                source: source.to_string(),
                template_key: template_key.to_string(),
                values: values.clone(),
                output_path: requested_output,
            },
            Some(binary.to_path_buf()),
        )
    }

    #[cfg(unix)]
    #[test]
    fn failed_validation_never_publishes_a_native_template() {
        let tmp = tempfile::tempdir().unwrap();
        let binary = fake_hwp(
            tmp.path(),
            "1.3.0",
            true,
            r#"{"output":"filled.hwpx","mode":"placeholders","replaced":1,"counts":{"기관명":1},"warnings":[]}"#,
        );
        let result = fill_with_test_bin(
            &binary,
            tmp.path().to_str().unwrap(),
            "hwp_cli_skill",
            "보고서",
            &BTreeMap::from([("기관명".to_string(), "제주한라대학교".to_string())]),
            Some("published.hwpx".to_string()),
        );
        assert!(result.unwrap_err().contains("hwp_failed: hwp validate"));
        assert!(!tmp.path().join("published.hwpx").exists());
    }

    #[cfg(unix)]
    #[test]
    fn replaces_an_existing_output_after_staging_and_validation() {
        let tmp = tempfile::tempdir().unwrap();
        let binary = fake_hwp(
            tmp.path(),
            "1.3.0",
            false,
            r#"{"output":"filled.hwpx","mode":"placeholders","replaced":1,"counts":{"기관명":1},"warnings":[]}"#,
        );
        let output = tmp.path().join("published.hwpx");
        fs::write(&output, "old output").unwrap();
        let response = fill_with_test_bin(
            &binary,
            tmp.path().to_str().unwrap(),
            "hwp_cli_skill",
            "보고서",
            &BTreeMap::from([("기관명".to_string(), "제주한라대학교".to_string())]),
            Some("published.hwpx".to_string()),
        )
        .unwrap();
        assert_eq!(
            PathBuf::from(response.output_path),
            fs::canonicalize(&output).unwrap()
        );
        assert_eq!(fs::read_to_string(&output).unwrap(), "filled");
    }

    #[cfg(unix)]
    #[test]
    fn native_fill_report_preserves_multiplicity_and_warnings() {
        let tmp = tempfile::tempdir().unwrap();
        let binary = fake_hwp(
            tmp.path(),
            "1.3.0",
            false,
            r#"{"output":"filled.hwpx","mode":"placeholders","replaced":2,"counts":{"기관명":2},"warnings":["native warning"]}"#,
        );
        let response = fill_with_test_bin(
            &binary,
            tmp.path().to_str().unwrap(),
            "hwp_cli_skill",
            "보고서",
            &BTreeMap::from([("기관명".to_string(), "제주한라대학교".to_string())]),
            Some("published.hwpx".to_string()),
        )
        .unwrap();

        assert_eq!(response.replaced_count, 2);
        assert_eq!(response.form_filled_count, 2);
        assert!(response.unmatched_fields.is_empty());
        assert_eq!(response.warnings, vec!["native warning"]);
    }

    #[cfg(unix)]
    #[test]
    fn unmatched_or_malformed_native_fill_report_never_publishes() {
        let tmp = tempfile::tempdir().unwrap();
        let values = BTreeMap::from([
            ("기관명".to_string(), "제주한라대학교".to_string()),
            ("없는필드".to_string(), "값".to_string()),
        ]);
        let output = tmp.path().join("published.hwpx");
        fs::write(&output, "old output").unwrap();

        let unmatched_binary = fake_hwp(
            tmp.path(),
            "1.3.0",
            false,
            r#"{"output":"filled.hwpx","mode":"placeholders","replaced":1,"counts":{"기관명":1,"없는필드":0},"warnings":["native unmatched"]}"#,
        );
        let unmatched = fill_with_test_bin(
            &unmatched_binary,
            tmp.path().to_str().unwrap(),
            "hwp_cli_skill",
            "보고서",
            &values,
            Some("published.hwpx".to_string()),
        )
        .unwrap_err();
        assert!(unmatched.contains("hwp_fill_unmatched_required: 없는필드"));
        assert_eq!(fs::read_to_string(&output).unwrap(), "old output");

        let malformed_binary = fake_hwp(tmp.path(), "1.3.0", false, "not json");
        let malformed = fill_with_test_bin(
            &malformed_binary,
            tmp.path().to_str().unwrap(),
            "hwp_cli_skill",
            "보고서",
            &BTreeMap::from([("기관명".to_string(), "제주한라대학교".to_string())]),
            Some("published.hwpx".to_string()),
        )
        .unwrap_err();
        assert!(malformed.contains("hwp_fill_invalid_json"));
        assert_eq!(fs::read_to_string(&output).unwrap(), "old output");
    }
}

#[cfg(test)]
mod phase08_21 {
    use super::*;
    use crate::atomic_file::phase08_06::{boundary, run, Held, Home};
    use std::path::Path;
    use std::sync::MutexGuard;
    use std::time::Duration;

    struct EnvGuard {
        _lock: MutexGuard<'static, ()>,
    }
    impl EnvGuard {
        fn set_hwp(value: &Path) -> Self {
            let guard = crate::hwped::PHASE08_21_ENV_LOCK
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            std::env::set_var("MARU_HWP_BIN", value);
            Self { _lock: guard }
        }
    }
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            std::env::remove_var("MARU_HWP_BIN");
        }
    }

    fn text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    fn fill_request(values: BTreeMap<String, String>, output: &str) -> HwpCliTemplateFillRequest {
        HwpCliTemplateFillRequest {
            source: HWP_CLI_SKILL_SOURCE.to_string(),
            template_key: "보고서".to_string(),
            values,
            output_path: Some(output.to_string()),
        }
    }

    fn values(marker: &str) -> BTreeMap<String, String> {
        BTreeMap::from([("기관명".to_string(), marker.to_string())])
    }

    /// Fake released hwp whose fill publishes the values JSON it received, so
    /// the last admitted writer is visible in the published bytes.
    #[cfg(unix)]
    fn fake_hwp_publishing_values(dir: &Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let binary = dir.join("hwp");
        let script = r#"#!/bin/sh
case "$1" in
  --version) echo "hwp 1.3.0" ;;
  new)
    shift
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "-o" ]; then shift; printf 'template' > "$1"; exit 0; fi
      shift
    done
    exit 2 ;;
  slots) echo '{"placeholders":[{"name":"기관명","occurrences":1}]}' ;;
  fill)
    output=""; data=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "-o" ]; then shift; output="$1"; fi
      if [ "$1" = "--data" ]; then shift; data="$1"; fi
      shift
    done
    [ -n "$output" ] && [ -n "$data" ] || exit 2
    cp "$data" "$output"
    printf '%s\n' '{"output":"filled.hwpx","mode":"placeholders","replaced":1,"counts":{"기관명":1},"warnings":[]}'
    exit 0 ;;
  validate) exit 0 ;;
  *) exit 2 ;;
esac
"#;
        std::fs::write(&binary, script).unwrap();
        let mut permissions = std::fs::metadata(&binary).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&binary, permissions).unwrap();
        binary
    }

    #[test]
    fn phase08_21_hwp_cli_template_each_wrapper_yields_same_poll_and_maps_join_failure() {
        let home = Home::new();
        let root = home.root.path();
        boundary(
            std::env::temp_dir(),
            "hwp_cli_template_fields",
            ipc::hwp_cli_template_fields(HwpCliTemplateFieldsRequest {
                source: HWP_CLI_SKILL_SOURCE.to_string(),
                template_key: "보고서".to_string(),
            }),
        );
        boundary(
            root.into(),
            "hwp_cli_template_fill",
            ipc::hwp_cli_template_fill(text(root), fill_request(values("x"), "filled.hwpx")),
        );
    }

    #[cfg(unix)]
    #[test]
    fn phase08_21_hwp_cli_template_real_fixture_results_and_legacy_rejections() {
        let home = Home::new();
        let root = home.root.path().join("work");
        std::fs::create_dir_all(&root).unwrap();
        let bin_dir = home.root.path().join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let _env = EnvGuard::set_hwp(&fake_hwp_publishing_values(&bin_dir));
        let work = text(&root);

        let fields = run(ipc::hwp_cli_template_fields(HwpCliTemplateFieldsRequest {
            source: HWP_CLI_SKILL_SOURCE.to_string(),
            template_key: "보고서".to_string(),
        }))
        .unwrap();
        assert_eq!(fields.template_alias, "보고서");
        assert_eq!(fields.template_slug, "report");
        assert_eq!(fields.fields[0].key, "기관명");

        let filled = run(ipc::hwp_cli_template_fill(
            work.clone(),
            fill_request(values("제주한라대학교"), "published.hwpx"),
        ))
        .unwrap();
        assert!(filled.validation_ok);
        assert_eq!(filled.replaced_count, 1);
        assert_eq!(
            std::fs::read_to_string(root.join("published.hwpx")).unwrap(),
            serde_json::to_string(&values("제주한라대학교")).unwrap()
        );

        let legacy = run(ipc::hwp_cli_template_fields(HwpCliTemplateFieldsRequest {
            source: "hwpx_skill".to_string(),
            template_key: "사업계획서_기본".to_string(),
        }))
        .unwrap();
        assert_eq!(legacy.template_alias, "사업계획서");
        assert_eq!(legacy.template_slug, "plan");
        let legacy_filled = run(ipc::hwp_cli_template_fill(
            work.clone(),
            HwpCliTemplateFillRequest {
                source: "hwpx_skill".to_string(),
                template_key: "사업계획서_기본".to_string(),
                values: values("레거시"),
                output_path: Some("legacy.hwpx".to_string()),
            },
        ))
        .unwrap();
        assert!(legacy_filled.validation_ok);
        assert_eq!(
            std::fs::read_to_string(root.join("legacy.hwpx")).unwrap(),
            serde_json::to_string(&values("레거시")).unwrap()
        );

        let fields_err = run(ipc::hwp_cli_template_fields(HwpCliTemplateFieldsRequest {
            source: "manual".to_string(),
            template_key: "보고서".to_string(),
        }))
        .unwrap_err();
        assert!(fields_err.contains("template_source_invalid"));
        let fields_err = run(ipc::hwp_cli_template_fields(HwpCliTemplateFieldsRequest {
            source: HWP_CLI_SKILL_SOURCE.to_string(),
            template_key: "공고문".to_string(),
        }))
        .unwrap_err();
        assert!(fields_err.contains("template_alias_invalid"));
        let fill_err = run(ipc::hwp_cli_template_fill(
            work.clone(),
            fill_request(BTreeMap::new(), "published.hwpx"),
        ))
        .unwrap_err();
        assert!(fill_err.contains("requires at least one template value"));
        let fill_err = run(ipc::hwp_cli_template_fill(
            work,
            fill_request(values("x"), "published.docx"),
        ))
        .unwrap_err();
        assert!(fill_err.contains("must end with .hwpx"));
    }

    #[cfg(unix)]
    #[test]
    fn phase08_21_hwp_cli_template_fill_serializes_same_target_both_orders() {
        let home = Home::new();
        let bin_dir = home.root.path().join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let _env = EnvGuard::set_hwp(&fake_hwp_publishing_values(&bin_dir));
        for swap in [false, true] {
            let root = home.root.path().join(format!("fill-{swap}"));
            std::fs::create_dir_all(&root).unwrap();
            let work = text(&root);
            let target = root.join("published.hwpx");
            let first_marker = if swap { "second" } else { "first" };
            let second_marker = if swap { "first" } else { "second" };
            let held = Held::new(target.clone(), "admitted");
            let first = start(ipc::hwp_cli_template_fill(
                work.clone(),
                fill_request(values(first_marker), "published.hwpx"),
            ));
            held.wait();
            let waiting = Held::new(target.clone(), "before-admission");
            let second = start(ipc::hwp_cli_template_fill(
                work.clone(),
                fill_request(values(second_marker), "published.hwpx"),
            ));
            waiting.wait();
            waiting.release();
            assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
            held.release();
            done(first).unwrap();
            let written = done(second).unwrap();
            assert!(written.validation_ok);
            assert_eq!(
                std::fs::read_to_string(&target).unwrap(),
                serde_json::to_string(&values(second_marker)).unwrap()
            );
            let _ = work;
        }
    }

    #[cfg(unix)]
    #[test]
    fn phase08_21_hwp_cli_template_denied_and_error_release_admission() {
        let home = Home::new();
        let root = home.root.path().join("policy");
        std::fs::create_dir_all(&root).unwrap();
        let bin_dir = home.root.path().join("bin-policy");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let _env = EnvGuard::set_hwp(&fake_hwp_publishing_values(&bin_dir));
        let work = text(&root);
        crate::scratchpad::phase08_08::registry(&root, "readOnly");
        let err = run(ipc::hwp_cli_template_fill(
            work.clone(),
            fill_request(values("x"), "published.hwpx"),
        ))
        .unwrap_err();
        assert!(err.contains("Workspace writes are blocked"));
        assert!(!root.join("published.hwpx").exists());
        crate::scratchpad::phase08_08::registry(&root, "direct");
        run(ipc::hwp_cli_template_fill(
            work.clone(),
            fill_request(values("allowed"), "published.hwpx"),
        ))
        .unwrap();

        std::fs::write(root.join("blocked"), "not a directory").unwrap();
        let err = run(ipc::hwp_cli_template_fill(
            work.clone(),
            fill_request(values("x"), "blocked/published.hwpx"),
        ))
        .unwrap_err();
        assert!(err.contains("Cannot create output directory"));
        std::fs::remove_file(root.join("blocked")).unwrap();
        run(ipc::hwp_cli_template_fill(
            work,
            fill_request(values("recovered"), "blocked/published.hwpx"),
        ))
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("blocked/published.hwpx")).unwrap(),
            serde_json::to_string(&values("recovered")).unwrap()
        );
    }

    fn start<F, T>(future: F) -> std::sync::mpsc::Receiver<T>
    where
        F: std::future::Future<Output = T> + Send + 'static,
        T: Send + 'static,
    {
        let (tx, rx) = std::sync::mpsc::channel();
        tauri::async_runtime::spawn(async move {
            let _ = tx.send(future.await);
        });
        rx
    }

    fn done<T>(rx: std::sync::mpsc::Receiver<T>) -> T {
        rx.recv_timeout(Duration::from_secs(10))
            .expect("fixture completion")
    }
}
