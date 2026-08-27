//! Native `hwp_cli_skill` template consumer.
//!
//! Hub records keep `hwpx_template_key` for schema compatibility, but when
//! their source is `hwp_cli_skill` that key is the released Korean alias for
//! an embedded hwp template, never a path to the retired binary-template tree.
//! The generated document remains HWPX so the existing export contract is
//! unchanged. Outputs are built and validated in a sibling staging directory
//! and only then atomically published into the workspace.

use crate::atomic_file::write_atomic;
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
const MIN_HWP_VERSION: (u64, u64, u64) = (0, 12, 1);
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
    pub validation_checks: Vec<TemplateValidationCheck>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateValidationCheck {
    pub name: String,
    pub status: String,
    pub reason: Option<String>,
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

/// The closed JSON contract emitted by `hwp fill --json` for placeholder fills.
///
/// This is deliberately not a loose `serde_json::Value`: Maru only publishes a
/// staged document after the native tool has supplied an internally consistent
/// report for every requested value.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeFillReport {
    output: String,
    mode: String,
    replaced: u32,
    counts: BTreeMap<String, u32>,
    warnings: Vec<String>,
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

fn canonical_template(source: &str, alias: &str) -> Result<(&'static str, &'static str), String> {
    if source != HWP_CLI_SKILL_SOURCE {
        return Err(format!(
            "template_source_invalid: expected {HWP_CLI_SKILL_SOURCE}, got {source}"
        ));
    }
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
        "cli_missing: released hwp >= 0.12.1 binary not found; install/export the unified hwp skill or set MARU_HWP_BIN".to_string()
    }))
}

fn hwp_bin() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("MARU_HWP_BIN").map(PathBuf::from) {
        return is_executable(&path)
            .then_some(path)
            .ok_or_else(|| "cli_missing: MARU_HWP_BIN is not executable".to_string());
    }
    select_compatible_hwp(hwp_candidates())
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
            "hwp_version: hwp {}.{}.{} is too old; hwp_cli_skill requires >= {}.{}.{}",
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

fn validate_template(bin: &Path, output: &Path) -> Result<(), String> {
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

fn slots_for(bin: &Path, document: &Path) -> Result<Vec<TemplateField>, String> {
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
    if report.mode != "placeholders" {
        return Err(format!(
            "hwp_fill_invalid_report: expected placeholders mode, got {}",
            report.mode
        ));
    }
    if report.output.trim().is_empty() {
        return Err("hwp_fill_invalid_report: native fill report omitted output".to_string());
    }

    let missing_counts = values
        .keys()
        .filter(|name| !report.counts.contains_key(*name))
        .cloned()
        .collect::<Vec<_>>();
    if !missing_counts.is_empty() {
        return Err(format!(
            "hwp_fill_invalid_report: native fill report omitted counts for {}",
            missing_counts.join(", ")
        ));
    }
    let unexpected_counts = report
        .counts
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

    let counted_replacements = report.counts.values().try_fold(0u32, |total, count| {
        total
            .checked_add(*count)
            .ok_or_else(|| "hwp_fill_invalid_report: replacement count overflow".to_string())
    })?;
    if report.replaced != counted_replacements {
        return Err(format!(
            "hwp_fill_invalid_report: replaced {} does not match counts total {}",
            report.replaced, counted_replacements
        ));
    }
    Ok(report)
}

fn fill_with_bin(
    bin: &Path,
    work_path: &str,
    source: &str,
    template_key: &str,
    values: &BTreeMap<String, String>,
    requested_output: Option<String>,
) -> Result<HwpCliTemplateFillResponse, String> {
    if values.is_empty() {
        return Err("hwp_cli_skill requires at least one template value".to_string());
    }
    let (alias, slug) = canonical_template(source, template_key)?;
    ensure_released_version(bin)?;
    let output = output_path(work_path, alias, requested_output)?;
    let write_action = if output.is_file() {
        WorkspaceWriteAction::Modify
    } else {
        WorkspaceWriteAction::Create
    };
    assert_maru_can_write(work_path, write_action)?;
    let parent = output
        .parent()
        .ok_or_else(|| "hwp_cli_skill output path has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|err| format!("Cannot create output directory: {err}"))?;
    let stage = tempfile::Builder::new()
        .prefix(".maru-hwp-cli-")
        .tempdir_in(parent)
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
    let native_fill = run_hwp_ok(
        bin,
        &[
            OsString::from("fill"),
            template.as_os_str().to_os_string(),
            OsString::from("--data"),
            values_path.as_os_str().to_os_string(),
            OsString::from("-o"),
            staged_output.as_os_str().to_os_string(),
            OsString::from("--json"),
        ],
    )?;
    let native_report = parse_native_fill_report(&native_fill, values)?;
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
        validation_checks: vec![TemplateValidationCheck {
            name: "hwp-validate".to_string(),
            status: "pass".to_string(),
            reason: None,
        }],
        warnings: native_report.warnings,
    })
}

#[tauri::command]
pub fn hwp_cli_template_fields(
    request: HwpCliTemplateFieldsRequest,
) -> Result<HwpCliTemplateFieldsResponse, String> {
    let bin = hwp_bin()?;
    fields_with_bin(&bin, &request.source, &request.template_key)
}

#[tauri::command]
pub fn hwp_cli_template_fill(
    work_path: String,
    request: HwpCliTemplateFillRequest,
) -> Result<HwpCliTemplateFillResponse, String> {
    let bin = hwp_bin()?;
    fill_with_bin(
        &bin,
        &work_path,
        &request.source,
        &request.template_key,
        &request.values,
        request.output_path,
    )
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
        assert!(canonical_template("hwpx_skill", "보고서")
            .unwrap_err()
            .contains("template_source_invalid"));
        assert!(canonical_template("hwp_cli_skill", "공고문")
            .unwrap_err()
            .contains("template_alias_invalid"));
    }

    #[test]
    fn version_parser_requires_the_released_floor() {
        assert_eq!(parse_version(b"hwp 0.12.0"), Some((0, 12, 0)));
        assert_eq!(parse_version(b"hwp 0.12.1"), Some((0, 12, 1)));
        assert_eq!(parse_version(b"hwp 0.11.9"), Some((0, 11, 9)));
        assert_eq!(parse_version(b"broken"), None);
    }

    #[cfg(unix)]
    #[test]
    fn released_version_floor_rejects_0120_and_accepts_0121() {
        let too_old = tempfile::tempdir().unwrap();
        let too_old_binary = fake_hwp(
            too_old.path(),
            "0.12.0",
            false,
            r#"{"output":"filled.hwpx","mode":"placeholders","replaced":1,"counts":{"기관명":1},"warnings":[]}"#,
        );
        let error = ensure_released_version(&too_old_binary).unwrap_err();
        assert!(error.contains("hwp 0.12.0 is too old"));
        assert!(error.contains("requires >= 0.12.1"));

        let released = tempfile::tempdir().unwrap();
        let released_binary = fake_hwp(
            released.path(),
            "0.12.1",
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
            "0.12.0",
            false,
            r#"{"output":"filled.hwpx","mode":"placeholders","replaced":1,"counts":{"기관명":1},"warnings":[]}"#,
        );
        let managed_binary = fake_hwp(
            &managed_dir,
            "0.12.1",
            false,
            r#"{"output":"filled.hwpx","mode":"placeholders","replaced":1,"counts":{"기관명":1},"warnings":[]}"#,
        );

        assert_eq!(
            select_compatible_hwp(vec![old_path_binary, managed_binary.clone()]).unwrap(),
            managed_binary
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
            "0.12.1",
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
    #[test]
    fn failed_validation_never_publishes_a_native_template() {
        let tmp = tempfile::tempdir().unwrap();
        let binary = fake_hwp(
            tmp.path(),
            "0.12.1",
            true,
            r#"{"output":"filled.hwpx","mode":"placeholders","replaced":1,"counts":{"기관명":1},"warnings":[]}"#,
        );
        let result = fill_with_bin(
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
            "0.12.1",
            false,
            r#"{"output":"filled.hwpx","mode":"placeholders","replaced":1,"counts":{"기관명":1},"warnings":[]}"#,
        );
        let output = tmp.path().join("published.hwpx");
        fs::write(&output, "old output").unwrap();
        let response = fill_with_bin(
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
            "0.12.1",
            false,
            r#"{"output":"filled.hwpx","mode":"placeholders","replaced":2,"counts":{"기관명":2},"warnings":["native warning"]}"#,
        );
        let response = fill_with_bin(
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
            "0.12.1",
            false,
            r#"{"output":"filled.hwpx","mode":"placeholders","replaced":1,"counts":{"기관명":1,"없는필드":0},"warnings":["native unmatched"]}"#,
        );
        let unmatched = fill_with_bin(
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

        let malformed_binary = fake_hwp(tmp.path(), "0.12.1", false, "not json");
        let malformed = fill_with_bin(
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
