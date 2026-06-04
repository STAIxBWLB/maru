use crate::kordoc_lite::{self, KordocLiteCheck, LiteField};
use crate::vault::resolve_inside_vault;
use crate::vault_list::{assert_anchor_can_write, WorkspaceWriteAction};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use crate::win_process::NoWindow;
use tempfile::NamedTempFile;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateField {
    pub key: String,
    pub label: String,
    pub required: bool,
    pub occurrences: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matched_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateFieldRequest {
    pub template_key: Option<String>,
    pub template_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateFieldResponse {
    pub template_path: String,
    pub source: String,
    #[serde(default)]
    pub fields: Vec<TemplateField>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplatePrepareResponse {
    pub input_path: String,
    pub prepared_path: Option<String>,
    pub status: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateFillRequest {
    pub template_key: Option<String>,
    pub template_path: Option<String>,
    #[serde(default)]
    pub values: BTreeMap<String, String>,
    pub output_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateFillResponse {
    pub output_path: String,
    pub replaced_count: u32,
    pub validation_ok: bool,
    pub command: String,
    #[serde(default)]
    pub form_filled_count: u32,
    #[serde(default)]
    pub unmatched_fields: Vec<String>,
    #[serde(default)]
    pub validation_checks: Vec<KordocLiteCheck>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct HwpxSlotsResponse {
    #[serde(default)]
    fields: Vec<TemplateField>,
}

#[tauri::command]
pub fn template_get_fields(
    work_path: String,
    request: TemplateFieldRequest,
) -> Result<TemplateFieldResponse, String> {
    let (template_path, source) =
        resolve_template_path(&work_path, request.template_key, request.template_path)?;
    if !has_extension(&template_path, "hwpx") {
        return Err("Template field extraction requires a .hwpx template".to_string());
    }

    let mut fields: BTreeMap<String, TemplateField> = BTreeMap::new();
    let mut warnings = Vec::new();

    match find_hwpx_tool() {
        Some(hwpx) => {
            match run_command(
                &hwpx,
                &[
                    OsString::from("slots"),
                    template_path.as_os_str().to_os_string(),
                    OsString::from("--format"),
                    OsString::from("json"),
                ],
            )
            .and_then(|run| {
                serde_json::from_slice::<HwpxSlotsResponse>(&run.stdout)
                    .map_err(|err| format!("Cannot parse hwpx slots output: {err}"))
            }) {
                Ok(parsed) => {
                    for mut field in parsed.fields {
                        field
                            .source
                            .get_or_insert_with(|| "placeholder".to_string());
                        field.confidence.get_or_insert(1.0);
                        merge_template_field(&mut fields, field);
                    }
                }
                Err(err) => warnings.push(format!("hwpx slots unavailable: {err}")),
            }
        }
        None => {
            warnings.push("hwpx tool is not available; using kordoc_lite scan only".to_string())
        }
    }

    match kordoc_lite::scan_hwpx_fields(&template_path) {
        Ok(scan) => {
            for field in scan.fields {
                merge_template_field(&mut fields, template_field_from_lite(field));
            }
            warnings.extend(scan.warnings);
            warnings.extend(
                scan.validation_checks
                    .into_iter()
                    .filter(|check| check.status != "pass")
                    .filter_map(|check| {
                        check
                            .reason
                            .map(|reason| format!("{}: {reason}", check.name))
                    }),
            );
        }
        Err(err) => {
            if fields.is_empty() {
                return Err(format!("Cannot scan HWPX template fields: {err}"));
            }
            warnings.push(format!("kordoc_lite scan skipped: {err}"));
        }
    }

    Ok(TemplateFieldResponse {
        template_path: template_path.to_string_lossy().to_string(),
        source,
        fields: fields.into_values().collect(),
        warnings,
    })
}

#[tauri::command]
pub fn template_prepare_hwpx_template(
    work_path: String,
    source_path: String,
) -> Result<TemplatePrepareResponse, String> {
    let input_path = resolve_inside_vault(&work_path, &source_path)?;
    if !input_path.is_file() {
        return Err("Template file does not exist".to_string());
    }
    let extension = input_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if extension == "hwpx" {
        return Ok(TemplatePrepareResponse {
            input_path: input_path.to_string_lossy().to_string(),
            prepared_path: Some(input_path.to_string_lossy().to_string()),
            status: "ready".to_string(),
            reason: None,
        });
    }
    if extension == "hwp" {
        return Ok(TemplatePrepareResponse {
            input_path: input_path.to_string_lossy().to_string(),
            prepared_path: None,
            status: "manualFallback".to_string(),
            reason: Some(
                "HWP binary templates must be saved as HWPX before field extraction".to_string(),
            ),
        });
    }
    Err("Template preparation supports .hwpx and .hwp files".to_string())
}

#[tauri::command]
pub fn template_fill_hwpx(
    work_path: String,
    request: TemplateFillRequest,
) -> Result<TemplateFillResponse, String> {
    if request.values.is_empty() {
        return Err("No template values provided".to_string());
    }
    let (template_path, _) =
        resolve_template_path(&work_path, request.template_key, request.template_path)?;
    if !has_extension(&template_path, "hwpx") {
        return Err("Template fill requires a .hwpx template".to_string());
    }
    let output_path = resolve_output_path(&work_path, &template_path, request.output_path)?;
    let write_action = if output_path.is_file() {
        WorkspaceWriteAction::Modify
    } else {
        WorkspaceWriteAction::Create
    };
    assert_anchor_can_write(&work_path, write_action)?;
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Cannot create output directory: {err}"))?;
    }

    let hwpx = find_hwpx_tool().ok_or_else(|| "hwpx tool is not available".to_string())?;
    let data_file = write_temp_values(&request.values)?;
    let fill_run = run_command(
        &hwpx,
        &[
            OsString::from("fill"),
            template_path.as_os_str().to_os_string(),
            OsString::from("--data"),
            data_file.path().as_os_str().to_os_string(),
            OsString::from("-o"),
            output_path.as_os_str().to_os_string(),
        ],
    );
    let fill_output = fill_run?;
    let replaced_count = parse_replaced_count(&fill_output.stderr);

    let mut form_filled_count = 0;
    let mut unmatched_fields = Vec::new();
    let mut validation_checks = Vec::new();
    let mut warnings = Vec::new();

    match kordoc_lite::fill_hwpx_form_fields(&output_path, &output_path, &request.values) {
        Ok(outcome) => {
            form_filled_count = outcome.filled_count;
            unmatched_fields = outcome.unmatched_fields;
            validation_checks = outcome.validation_checks;
            warnings.extend(outcome.warnings);
        }
        Err(err) => {
            validation_checks.push(KordocLiteCheck {
                name: "kordoc-lite-fill".to_string(),
                status: "fail".to_string(),
                reason: Some(err.clone()),
            });
            warnings.push(format!("kordoc_lite form fill skipped: {err}"));
        }
    }

    let hwpx_validation_ok = run_command(
        &hwpx,
        &[
            OsString::from("validate"),
            output_path.as_os_str().to_os_string(),
        ],
    )
    .is_ok();
    let kordoc_validation_ok = validation_checks.iter().all(|check| check.status == "pass");
    let validation_ok = hwpx_validation_ok && kordoc_validation_ok;

    Ok(TemplateFillResponse {
        output_path: output_path.to_string_lossy().to_string(),
        replaced_count,
        validation_ok,
        command: command_label(
            &hwpx,
            &[
                OsString::from("fill"),
                template_path.as_os_str().to_os_string(),
                OsString::from("--data"),
                OsString::from("<values.json>"),
                OsString::from("-o"),
                output_path.as_os_str().to_os_string(),
            ],
        ),
        form_filled_count,
        unmatched_fields,
        validation_checks,
        warnings: {
            if !hwpx_validation_ok {
                warnings
                    .push("Filled HWPX was written but hwpx validation did not pass".to_string());
            }
            if !kordoc_validation_ok {
                warnings.push(
                    "Filled HWPX was written but kordoc_lite validation did not pass".to_string(),
                );
            }
            warnings
        },
    })
}

fn merge_template_field(fields: &mut BTreeMap<String, TemplateField>, field: TemplateField) {
    fields
        .entry(field.key.clone())
        .and_modify(|existing| {
            existing.occurrences += field.occurrences;
            existing.required = existing.required || field.required;
            if should_replace_template_field_metadata(existing, &field) {
                existing.label = field.label.clone();
                existing.source = field.source.clone();
                existing.confidence = field.confidence;
                existing.matched_key = field.matched_key.clone();
            } else if existing.matched_key.is_none() && field.matched_key.is_some() {
                existing.matched_key = field.matched_key.clone();
            }
        })
        .or_insert(field);
}

fn should_replace_template_field_metadata(
    existing: &TemplateField,
    incoming: &TemplateField,
) -> bool {
    let existing_rank = template_field_source_rank(existing.source.as_deref());
    let incoming_rank = template_field_source_rank(incoming.source.as_deref());
    incoming_rank > existing_rank
        || (incoming_rank == existing_rank
            && incoming.confidence.unwrap_or(0.0) > existing.confidence.unwrap_or(0.0))
}

fn template_field_source_rank(source: Option<&str>) -> u8 {
    match source {
        Some("formLabel") => 3,
        Some("inlineLabel") => 2,
        Some("placeholder") => 1,
        Some(_) => 2,
        None => 0,
    }
}

fn template_field_from_lite(field: LiteField) -> TemplateField {
    TemplateField {
        key: field.key,
        label: field.label,
        required: field.required,
        occurrences: field.occurrences,
        source: Some(field.source),
        confidence: Some(field.confidence),
        matched_key: field.matched_key,
    }
}

fn resolve_template_path(
    work_path: &str,
    template_key: Option<String>,
    template_path: Option<String>,
) -> Result<(PathBuf, String), String> {
    if let Some(path) = template_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        let resolved = resolve_inside_vault(work_path, path)?;
        if !resolved.is_file() {
            return Err("Template file does not exist".to_string());
        }
        return Ok((resolved, "workspace".to_string()));
    }

    let key = template_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .ok_or_else(|| "Template key or template path is required".to_string())?;
    validate_template_key(key)?;
    let root = bundled_templates_root();
    let mut candidates = vec![root.join(key)];
    if Path::new(key).extension().is_none() {
        candidates.push(root.join(format!("{key}.hwpx")));
    }
    let template = candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| format!("Bundled HWPX template not found: {key}"))?;
    Ok((template, "bundled".to_string()))
}

fn resolve_output_path(
    work_path: &str,
    template_path: &Path,
    output_path: Option<String>,
) -> Result<PathBuf, String> {
    if let Some(path) = output_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        let resolved = resolve_inside_vault(work_path, path)?;
        if !has_extension(&resolved, "hwpx") {
            return Err("Output path must end with .hwpx".to_string());
        }
        return Ok(resolved);
    }

    let stem = template_path
        .file_stem()
        .and_then(|value| value.to_str())
        .map(sanitize_filename)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "filled-template".to_string());
    resolve_inside_vault(
        work_path,
        &format!(".anchor/studio/filled/{stem}-filled.hwpx"),
    )
}

fn validate_template_key(key: &str) -> Result<(), String> {
    if key.contains('/') || key.contains('\\') || key.contains("..") || key.starts_with('.') {
        return Err("Invalid HWPX template key".to_string());
    }
    Ok(())
}

fn has_extension(path: &Path, expected: &str) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case(expected))
        .unwrap_or(false)
}

fn bundled_templates_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../skills/skills/hwpx/templates")
}

fn sanitize_filename(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

fn write_temp_values(values: &BTreeMap<String, String>) -> Result<NamedTempFile, String> {
    let body =
        serde_json::to_string(values).map_err(|err| format!("Cannot serialize values: {err}"))?;
    let mut file = tempfile::Builder::new()
        .prefix("anchor-hwpx-values-")
        .suffix(".json")
        .tempfile()
        .map_err(|err| format!("Cannot create temporary values file: {err}"))?;
    file.write_all(body.as_bytes())
        .map_err(|err| format!("Cannot write temporary values: {err}"))?;
    file.flush()
        .map_err(|err| format!("Cannot flush temporary values: {err}"))?;
    Ok(file)
}

fn parse_replaced_count(stderr: &[u8]) -> u32 {
    let text = String::from_utf8_lossy(stderr);
    let Ok(re) = Regex::new(r"(\d+)건 치환") else {
        return 0;
    };
    re.captures_iter(&text)
        .filter_map(|captures| captures.get(1))
        .filter_map(|value| value.as_str().parse::<u32>().ok())
        .last()
        .unwrap_or(0)
}

fn run_command(program: &Path, args: &[OsString]) -> Result<Output, String> {
    let output = Command::new(program)
        .args(args)
        .no_window()
        .output()
        .map_err(|err| format!("Cannot run {}: {err}", program.display()))?;
    if output.status.success() {
        return Ok(output);
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let message = stderr
        .lines()
        .chain(stdout.lines())
        .find(|line| !line.trim().is_empty())
        .unwrap_or("hwpx command failed");
    Err(format!(
        "{} failed: {message}",
        command_label(program, args)
    ))
}

fn command_label(program: &Path, args: &[OsString]) -> String {
    let mut parts = vec![program.to_string_lossy().to_string()];
    parts.extend(args.iter().map(|arg| arg.to_string_lossy().to_string()));
    parts.join(" ")
}

fn find_hwpx_tool() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("ANCHOR_HWPX_BIN").map(PathBuf::from) {
        if is_executable(&path) {
            return Some(path);
        }
    }
    find_program("hwpx").or_else(|| {
        let mut candidates = Vec::new();
        if let Some(home) = dirs::home_dir() {
            candidates.push(home.join(".anchor/skills/hwpx/hwpx"));
            candidates.push(home.join(".anchor/skills/_builtin/skills/hwpx/hwpx"));
        }
        candidates
            .push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../skills/skills/hwpx/hwpx"));
        candidates.into_iter().find(|path| is_executable(path))
    })
}

fn find_program(name: &str) -> Option<PathBuf> {
    if name.contains(std::path::MAIN_SEPARATOR) {
        let path = PathBuf::from(name);
        return is_executable(&path).then_some(path);
    }
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths)
        .map(|dir| dir.join(name))
        .find(|path| is_executable(path))
}

fn is_executable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_path_like_template_key() {
        assert!(validate_template_key("../bad").is_err());
        assert!(validate_template_key("nested/name").is_err());
        assert!(validate_template_key("보고서_일반").is_ok());
    }

    #[test]
    fn sanitizes_default_output_stem() {
        assert_eq!(sanitize_filename("보고서 일반"), "보고서-일반");
        assert_eq!(sanitize_filename("template_v1"), "template_v1");
    }

    #[test]
    fn accepts_case_insensitive_hwpx_extensions() {
        assert!(has_extension(Path::new("Template.HWPX"), "hwpx"));
        assert!(has_extension(Path::new("Template.HwPx"), "hwpx"));
        assert!(!has_extension(Path::new("Template.hwp"), "hwpx"));
    }

    #[test]
    fn merge_template_field_prefers_form_metadata_over_placeholder() {
        let mut fields = BTreeMap::new();
        merge_template_field(
            &mut fields,
            TemplateField {
                key: "성명".to_string(),
                label: "성명".to_string(),
                required: false,
                occurrences: 1,
                source: Some("placeholder".to_string()),
                confidence: Some(1.0),
                matched_key: None,
            },
        );
        merge_template_field(
            &mut fields,
            TemplateField {
                key: "성명".to_string(),
                label: "성명 라벨".to_string(),
                required: true,
                occurrences: 1,
                source: Some("formLabel".to_string()),
                confidence: Some(0.72),
                matched_key: Some("성명".to_string()),
            },
        );
        merge_template_field(
            &mut fields,
            TemplateField {
                key: "성명".to_string(),
                label: "성명".to_string(),
                required: false,
                occurrences: 1,
                source: Some("placeholder".to_string()),
                confidence: Some(1.0),
                matched_key: None,
            },
        );

        let field = fields.get("성명").unwrap();
        assert_eq!(field.occurrences, 3);
        assert_eq!(field.label, "성명 라벨");
        assert_eq!(field.source.as_deref(), Some("formLabel"));
        assert_eq!(field.matched_key.as_deref(), Some("성명"));
        assert!(field.required);
    }

    #[test]
    fn parses_total_replaced_count() {
        let stderr = "[hwpx] {{제목}} → 1건\n[hwpx] 3건 치환 → out.hwpx\n";
        assert_eq!(parse_replaced_count(stderr.as_bytes()), 3);
    }
}
