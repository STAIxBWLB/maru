use crate::atomic_file::{with_path_transactions, PathTransactionLease, PathTransactionRequest};
use crate::hwp_cli_template;
use crate::kordoc_lite::{self, KordocLiteCheck, LiteField};
use crate::vault::resolve_inside_vault;
use crate::vault_list::{assert_maru_can_write, WorkspaceWriteAction};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

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

    match hwp_cli_template::hwp_bin() {
        Ok(hwp) => match hwp_cli_template::slots_for(&hwp, &template_path) {
            Ok(slots) => {
                for field in slots {
                    merge_template_field(&mut fields, field);
                }
            }
            Err(err) => warnings.push(format!("hwp slots unavailable: {err}")),
        },
        Err(err) => warnings.push(format!("{err}; using kordoc_lite scan only")),
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

pub fn template_fill_hwpx(
    work_path: String,
    request: TemplateFillRequest,
) -> Result<TemplateFillResponse, String> {
    if request.values.is_empty() {
        return Err("No template values provided".to_string());
    }
    let (template_path, _) = resolve_template_path(
        &work_path,
        request.template_key.clone(),
        request.template_path.clone(),
    )?;
    if !has_extension(&template_path, "hwpx") {
        return Err("Template fill requires a .hwpx template".to_string());
    }
    let output_path = resolve_output_path(&work_path, &template_path, request.output_path.clone())?;
    let parent = output_path
        .parent()
        .ok_or_else(|| "Template fill output path has no parent".to_string())?
        .to_path_buf();
    let root = resolve_inside_vault(&work_path, ".")?;
    let admission = PathTransactionRequest::new(vec![output_path.clone(), parent])?
        .require_parent(&root)?
        .with_workspace_registry()?;
    with_path_transactions(admission, |lease| {
        lease.ensure_workspace_registry()?;
        lease.ensure_covered(std::iter::once(output_path.clone()))?;
        let write_action = if output_path.is_file() {
            WorkspaceWriteAction::Modify
        } else {
            WorkspaceWriteAction::Create
        };
        assert_maru_can_write(&work_path, write_action)?;
        lease.before_effect()?;
        template_fill_hwpx_in_transaction(work_path, request, template_path, output_path, lease)
    })
}

fn template_fill_hwpx_in_transaction(
    _work_path: String,
    request: TemplateFillRequest,
    template_path: PathBuf,
    output_path: PathBuf,
    lease: &PathTransactionLease,
) -> Result<TemplateFillResponse, String> {
    lease.ensure_covered(std::iter::once(output_path.clone()))?;
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Cannot create output directory: {err}"))?;
    }

    let hwp = hwp_cli_template::hwp_bin()?;
    // Only requested keys that are real {{slot}}s go to `hwp fill`, which fails
    // closed on an unreplaced request; every value still goes to the kordoc_lite
    // form fill, which covers form labels.
    let slots = hwp_cli_template::slots_for(&hwp, &template_path)?;
    let slot_values: BTreeMap<String, String> = request
        .values
        .iter()
        .filter(|(key, _)| slots.iter().any(|slot| &slot.key == *key))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();

    let mut warnings = Vec::new();
    let (replaced_count, command) = if slot_values.is_empty() {
        fs::copy(&template_path, &output_path)
            .map_err(|err| format!("Cannot copy template to output: {err}"))?;
        (
            0,
            format!(
                "copy {} {} (no requested slot keys)",
                template_path.display(),
                output_path.display()
            ),
        )
    } else {
        let data_file = write_temp_values(&slot_values)?;
        let report = hwp_cli_template::fill_slots(
            &hwp,
            &template_path,
            data_file.path(),
            &output_path,
            &slot_values,
        )?;
        warnings.extend(report.warnings);
        let command = command_label(
            &hwp,
            &[
                OsString::from("fill"),
                template_path.as_os_str().to_os_string(),
                OsString::from("--data"),
                OsString::from("<values.json>"),
                OsString::from("-o"),
                output_path.as_os_str().to_os_string(),
                OsString::from("--json"),
            ],
        );
        (report.replaced, command)
    };

    let mut form_filled_count = 0;
    let mut unmatched_fields = Vec::new();
    let mut validation_checks = Vec::new();

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
    // hwp fill already replaced every requested slot, so only keys that are
    // neither a slot nor a kordoc_lite match stay unmatched.
    unmatched_fields.retain(|key| !slot_values.contains_key(key));

    let hwp_validation_ok = hwp_cli_template::validate_template(&hwp, &output_path).is_ok();
    let kordoc_validation_ok = validation_checks.iter().all(|check| check.status == "pass");
    let validation_ok = hwp_validation_ok && kordoc_validation_ok;

    Ok(TemplateFillResponse {
        output_path: output_path.to_string_lossy().to_string(),
        replaced_count,
        validation_ok,
        command,
        form_filled_count,
        unmatched_fields,
        validation_checks,
        warnings: {
            if !hwp_validation_ok {
                warnings
                    .push("Filled HWPX was written but hwp validation did not pass".to_string());
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
    // The bundled template tree went away with the retired hwpx skill;
    // hwpx_skill and hwp_cli_skill keys fill through hwp_cli_template.
    Err(format!(
        "Bundled HWPX templates were retired with the hwpx skill; set a workspace .hwpx template path for {key}, or use an hwp_cli_skill template"
    ))
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
        &format!(".maru/studio/filled/{stem}-filled.hwpx"),
    )
}

fn has_extension(path: &Path, expected: &str) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case(expected))
        .unwrap_or(false)
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
        .prefix("maru-hwpx-values-")
        .suffix(".json")
        .tempfile()
        .map_err(|err| format!("Cannot create temporary values file: {err}"))?;
    file.write_all(body.as_bytes())
        .map_err(|err| format!("Cannot write temporary values: {err}"))?;
    file.flush()
        .map_err(|err| format!("Cannot flush temporary values: {err}"))?;
    Ok(file)
}

fn command_label(program: &Path, args: &[OsString]) -> String {
    let mut parts = vec![program.to_string_lossy().to_string()];
    parts.extend(args.iter().map(|arg| arg.to_string_lossy().to_string()));
    parts.join(" ")
}

/// Owned IPC boundaries; the synchronous entry points remain available to Rust callers.
pub mod ipc {
    use super::*;
    #[tauri::command]
    pub async fn template_get_fields(
        work_path: String,
        request: TemplateFieldRequest,
    ) -> Result<TemplateFieldResponse, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:template_get_fields",
            );
            super::template_get_fields(work_path, request)
        })
        .await
        .map_err(|err| format!("template_get_fields_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn template_prepare_hwpx_template(
        work_path: String,
        source_path: String,
    ) -> Result<TemplatePrepareResponse, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:template_prepare_hwpx_template",
            );
            super::template_prepare_hwpx_template(work_path, source_path)
        })
        .await
        .map_err(|err| format!("template_prepare_hwpx_template_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn template_fill_hwpx(
        work_path: String,
        request: TemplateFillRequest,
    ) -> Result<TemplateFillResponse, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:template_fill_hwpx",
            );
            super::template_fill_hwpx(work_path, request)
        })
        .await
        .map_err(|err| format!("template_fill_hwpx_task_failed: {err}"))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn template_key_without_path_never_reads_the_retired_bundle() {
        let tmp = tempfile::tempdir().unwrap();
        let error = resolve_template_path(
            tmp.path().to_str().unwrap(),
            Some("사업계획서_기본".to_string()),
            None,
        )
        .unwrap_err();
        assert!(
            error.contains("Bundled HWPX templates were retired"),
            "{error}"
        );
        assert!(error.contains("사업계획서_기본"), "{error}");
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
}

#[cfg(test)]
mod phase08_21 {
    use super::*;
    use crate::atomic_file::phase08_06::{boundary, run, Held, Home};
    use std::io::{Read, Write};
    use std::path::Path;
    use std::sync::MutexGuard;
    use std::time::Duration;
    use zip::write::SimpleFileOptions;

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

    fn write_hwpx_fixture(path: &Path, section_xml: &str) {
        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        zip.start_file("mimetype", options).unwrap();
        zip.write_all(b"application/hwp+zip").unwrap();
        zip.start_file("Contents/content.hpf", options).unwrap();
        zip.write_all(b"<package />").unwrap();
        zip.start_file("Contents/section0.xml", options).unwrap();
        zip.write_all(section_xml.as_bytes()).unwrap();
        zip.finish().unwrap();
    }

    fn read_section(path: &Path) -> String {
        let file = std::fs::File::open(path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut entry = archive.by_name("Contents/section0.xml").unwrap();
        let mut xml = String::new();
        entry.read_to_string(&mut xml).unwrap();
        xml
    }

    /// Fake released hwp. `slots` reports `slots`; `fill` appends the values
    /// JSON it received to fill.log, copies the template to the output, and
    /// reports one replacement per slot, so kordoc_lite then fills the copy
    /// and the last admitted writer is visible in the output bytes.
    #[cfg(unix)]
    fn fake_hwp(dir: &Path, slots: &[&str]) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let binary = dir.join("hwp");
        let placeholders = serde_json::json!({
            "placeholders": slots
                .iter()
                .map(|name| serde_json::json!({ "name": name, "occurrences": 1 }))
                .collect::<Vec<_>>(),
        });
        let report = serde_json::json!({
            "output": "filled.hwpx",
            "mode": "placeholders",
            "replaced": slots.len(),
            "counts": slots
                .iter()
                .map(|name| (name.to_string(), 1))
                .collect::<BTreeMap<_, _>>(),
            "warnings": [],
        });
        let script = format!(
            r#"#!/bin/sh
case "$1" in
  --version) echo "hwp 1.1.0" ;;
  slots) printf '%s\n' '{placeholders}' ;;
  fill)
    template="$2"; output=""; data=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "-o" ]; then shift; output="$1"; fi
      if [ "$1" = "--data" ]; then shift; data="$1"; fi
      shift
    done
    [ -n "$output" ] && [ -f "$template" ] && [ -f "$data" ] || exit 2
    cat "$data" >> "{log}"
    cp "$template" "$output"
    printf '%s\n' '{report}' ;;
  validate) exit 0 ;;
  *) exit 2 ;;
esac
"#,
            log = dir.join("fill.log").display()
        );
        std::fs::write(&binary, script).unwrap();
        let mut permissions = std::fs::metadata(&binary).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&binary, permissions).unwrap();
        binary
    }

    fn fill_request(
        values: BTreeMap<String, String>,
        output: Option<String>,
    ) -> TemplateFillRequest {
        TemplateFillRequest {
            template_key: None,
            template_path: Some("templates/form.hwpx".to_string()),
            values,
            output_path: output,
        }
    }

    fn values(marker: &str) -> BTreeMap<String, String> {
        BTreeMap::from([("제목".to_string(), marker.to_string())])
    }

    #[test]
    fn phase08_21_template_fill_each_wrapper_yields_same_poll_and_maps_join_failure() {
        let home = Home::new();
        let root = home.root.path();
        let work = text(root);
        boundary(
            root.into(),
            "template_get_fields",
            ipc::template_get_fields(
                work.clone(),
                TemplateFieldRequest {
                    template_key: None,
                    template_path: Some("templates/form.hwpx".to_string()),
                },
            ),
        );
        boundary(
            root.into(),
            "template_prepare_hwpx_template",
            ipc::template_prepare_hwpx_template(work.clone(), "templates/form.hwpx".to_string()),
        );
        boundary(
            root.into(),
            "template_fill_hwpx",
            ipc::template_fill_hwpx(work, fill_request(values("x"), None)),
        );
    }

    #[cfg(unix)]
    #[test]
    fn phase08_21_template_real_fixture_results_and_legacy_rejections() {
        let home = Home::new();
        let root = home.root.path().join("work");
        std::fs::create_dir_all(root.join("templates")).unwrap();
        write_hwpx_fixture(
            &root.join("templates/form.hwpx"),
            "<hp:sec><hp:p><hp:t>{{제목}}</hp:t></hp:p></hp:sec>",
        );
        let bin_dir = home.root.path().join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let _env = EnvGuard::set_hwp(&fake_hwp(&bin_dir, &["제목"]));
        let work = text(&root);

        let fields = run(ipc::template_get_fields(
            work.clone(),
            TemplateFieldRequest {
                template_key: None,
                template_path: Some("templates/form.hwpx".to_string()),
            },
        ))
        .unwrap();
        assert_eq!(fields.source, "workspace");
        assert!(fields.fields.iter().any(|field| field.key == "제목"));

        let prepared = run(ipc::template_prepare_hwpx_template(
            work.clone(),
            "templates/form.hwpx".to_string(),
        ))
        .unwrap();
        assert_eq!(prepared.status, "ready");

        let filled = run(ipc::template_fill_hwpx(
            work.clone(),
            fill_request(values("제목값"), Some("out/filled.hwpx".to_string())),
        ))
        .unwrap();
        assert_eq!(filled.replaced_count, 1);
        assert!(filled.validation_ok);
        assert!(filled.unmatched_fields.is_empty());
        assert!(
            read_section(&root.join("out/filled.hwpx")).contains("제목값"),
            "marker value should be substituted into the filled hwpx"
        );

        std::fs::write(root.join("templates/form.docx"), b"docx").unwrap();
        assert!(run(ipc::template_get_fields(
            work.clone(),
            TemplateFieldRequest {
                template_key: None,
                template_path: Some("templates/form.docx".to_string()),
            },
        ))
        .unwrap_err()
        .contains("requires a .hwpx template"));
        assert!(run(ipc::template_prepare_hwpx_template(
            work.clone(),
            "templates/missing.hwpx".to_string(),
        ))
        .unwrap_err()
        .contains("Template file does not exist"));
        assert_eq!(
            run(ipc::template_prepare_hwpx_template(
                work.clone(),
                "templates/form.hwpx".to_string()
            ))
            .unwrap()
            .status,
            "ready"
        );
        assert!(run(ipc::template_fill_hwpx(
            work.clone(),
            fill_request(BTreeMap::new(), None),
        ))
        .unwrap_err()
        .contains("No template values provided"));
        let mut not_template = fill_request(values("x"), None);
        not_template.template_path = Some("templates/form.docx".to_string());
        assert!(run(ipc::template_fill_hwpx(work, not_template))
            .unwrap_err()
            .contains("requires a .hwpx template"));
    }

    #[cfg(unix)]
    #[test]
    fn phase08_21_template_fill_serializes_same_target_both_orders() {
        let home = Home::new();
        let bin_dir = home.root.path().join("bin-orders");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let _env = EnvGuard::set_hwp(&fake_hwp(&bin_dir, &["제목"]));
        for swap in [false, true] {
            let root = home.root.path().join(format!("fill-{swap}"));
            std::fs::create_dir_all(root.join("templates")).unwrap();
            write_hwpx_fixture(
                &root.join("templates/form.hwpx"),
                "<hp:sec><hp:p><hp:t>{{제목}}</hp:t></hp:p></hp:sec>",
            );
            let work = text(&root);
            let target = root.join("out/filled.hwpx");
            let first_marker = if swap { "second" } else { "first" };
            let second_marker = if swap { "first" } else { "second" };
            let held = Held::new(target.clone(), "admitted");
            let first = start(ipc::template_fill_hwpx(
                work.clone(),
                fill_request(values(first_marker), Some("out/filled.hwpx".to_string())),
            ));
            held.wait();
            let waiting = Held::new(target.clone(), "before-admission");
            let second = start(ipc::template_fill_hwpx(
                work.clone(),
                fill_request(values(second_marker), Some("out/filled.hwpx".to_string())),
            ));
            waiting.wait();
            waiting.release();
            assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
            held.release();
            done(first).unwrap();
            let written = done(second).unwrap();
            assert_eq!(written.replaced_count, 1);
            assert!(
                read_section(&target).contains(second_marker),
                "second admitted writer must own the final bytes"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn phase08_21_template_denied_and_error_release_admission() {
        let home = Home::new();
        let root = home.root.path().join("policy");
        std::fs::create_dir_all(root.join("templates")).unwrap();
        write_hwpx_fixture(
            &root.join("templates/form.hwpx"),
            "<hp:sec><hp:p><hp:t>{{제목}}</hp:t></hp:p></hp:sec>",
        );
        let bin_dir = home.root.path().join("bin-policy");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let _env = EnvGuard::set_hwp(&fake_hwp(&bin_dir, &["제목"]));
        let work = text(&root);
        crate::scratchpad::phase08_08::registry(&root, "readOnly");
        let err = run(ipc::template_fill_hwpx(
            work.clone(),
            fill_request(values("x"), Some("published.hwpx".to_string())),
        ))
        .unwrap_err();
        assert!(err.contains("Workspace writes are blocked"));
        assert!(!root.join("published.hwpx").exists());
        crate::scratchpad::phase08_08::registry(&root, "direct");
        run(ipc::template_fill_hwpx(
            work.clone(),
            fill_request(values("allowed"), Some("published.hwpx".to_string())),
        ))
        .unwrap();

        std::fs::write(root.join("blocked"), "not a directory").unwrap();
        let err = run(ipc::template_fill_hwpx(
            work.clone(),
            fill_request(values("x"), Some("blocked/published.hwpx".to_string())),
        ))
        .unwrap_err();
        assert!(err.contains("Cannot create output directory"));
        std::fs::remove_file(root.join("blocked")).unwrap();
        run(ipc::template_fill_hwpx(
            work,
            fill_request(
                values("recovered"),
                Some("blocked/published.hwpx".to_string()),
            ),
        ))
        .unwrap();
        assert!(
            read_section(&root.join("blocked/published.hwpx")).contains("recovered"),
            "retry after admission error must publish the recovered fill"
        );
    }

    const SLOT_AND_FORM_LABEL: &str = "<hp:sec><hp:p><hp:t>{{제목}}</hp:t></hp:p><hp:tbl><hp:tr><hp:tc><hp:p><hp:t>성명</hp:t></hp:p></hp:tc><hp:tc><hp:p><hp:t></hp:t></hp:p></hp:tc></hp:tr></hp:tbl></hp:sec>";
    const FORM_LABEL_ONLY: &str = "<hp:sec><hp:tbl><hp:tr><hp:tc><hp:p><hp:t>성명</hp:t></hp:p></hp:tc><hp:tc><hp:p><hp:t></hp:t></hp:p></hp:tc></hp:tr></hp:tbl></hp:sec>";

    #[cfg(unix)]
    #[test]
    fn phase08_21_template_fill_sends_only_slots_to_hwp_and_form_labels_to_kordoc() {
        let home = Home::new();
        let root = home.root.path().join("mixed");
        std::fs::create_dir_all(root.join("templates")).unwrap();
        write_hwpx_fixture(&root.join("templates/form.hwpx"), SLOT_AND_FORM_LABEL);
        let bin_dir = home.root.path().join("bin-mixed");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let _env = EnvGuard::set_hwp(&fake_hwp(&bin_dir, &["제목"]));

        let filled = run(ipc::template_fill_hwpx(
            text(&root),
            fill_request(
                BTreeMap::from([
                    ("제목".to_string(), "사업계획".to_string()),
                    ("성명".to_string(), "홍길동".to_string()),
                ]),
                Some("out/mixed.hwpx".to_string()),
            ),
        ))
        .unwrap();
        // hwp fill received only the slot; the form label went to kordoc_lite.
        assert_eq!(
            std::fs::read_to_string(bin_dir.join("fill.log")).unwrap(),
            r#"{"제목":"사업계획"}"#
        );
        assert_eq!(filled.replaced_count, 1);
        assert!(filled.command.contains(" fill "), "{}", filled.command);
        assert!(
            filled.unmatched_fields.is_empty(),
            "{:?}",
            filled.unmatched_fields
        );
        assert!(filled.validation_ok, "{:?}", filled.warnings);
        let section = read_section(&root.join("out/mixed.hwpx"));
        assert!(section.contains("사업계획"), "{section}");
        assert!(section.contains("홍길동"), "{section}");
    }

    #[cfg(unix)]
    #[test]
    fn phase08_21_template_fill_without_slot_keys_copies_the_template_for_kordoc() {
        let home = Home::new();
        let root = home.root.path().join("labels");
        std::fs::create_dir_all(root.join("templates")).unwrap();
        write_hwpx_fixture(&root.join("templates/form.hwpx"), FORM_LABEL_ONLY);
        let bin_dir = home.root.path().join("bin-labels");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let _env = EnvGuard::set_hwp(&fake_hwp(&bin_dir, &[]));

        let filled = run(ipc::template_fill_hwpx(
            text(&root),
            fill_request(
                BTreeMap::from([("성명".to_string(), "홍길동".to_string())]),
                Some("out/labels.hwpx".to_string()),
            ),
        ))
        .unwrap();
        assert!(!bin_dir.join("fill.log").exists(), "hwp fill must not run");
        assert_eq!(filled.replaced_count, 0);
        assert!(filled.command.starts_with("copy "), "{}", filled.command);
        assert!(
            filled.unmatched_fields.is_empty(),
            "{:?}",
            filled.unmatched_fields
        );
        assert!(read_section(&root.join("out/labels.hwpx")).contains("홍길동"));
    }

    #[cfg(unix)]
    #[test]
    fn phase08_21_template_fill_fails_closed_without_a_released_hwp() {
        let home = Home::new();
        let root = home.root.path().join("no-hwp");
        std::fs::create_dir_all(root.join("templates")).unwrap();
        write_hwpx_fixture(
            &root.join("templates/form.hwpx"),
            "<hp:sec><hp:p><hp:t>{{제목}}</hp:t></hp:p></hp:sec>",
        );
        let not_executable = home.root.path().join("hwp");
        std::fs::write(&not_executable, "not a binary").unwrap();
        let _env = EnvGuard::set_hwp(&not_executable);

        let err = run(ipc::template_fill_hwpx(
            text(&root),
            fill_request(values("x"), Some("out/filled.hwpx".to_string())),
        ))
        .unwrap_err();
        assert!(err.contains("cli_missing"), "{err}");
        assert!(!root.join("out/filled.hwpx").exists());
    }

    #[cfg(unix)]
    #[test]
    fn phase08_21_template_fields_scan_workspace_slots_with_and_without_hwp() {
        let home = Home::new();
        let root = home.root.path().join("fields");
        std::fs::create_dir_all(root.join("templates")).unwrap();
        std::fs::copy(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/hwp-cli-plan-template.hwpx"),
            root.join("templates/plan.hwpx"),
        )
        .unwrap();
        let request = || TemplateFieldRequest {
            template_key: None,
            template_path: Some("templates/plan.hwpx".to_string()),
        };
        let bin_dir = home.root.path().join("bin-fields");
        std::fs::create_dir_all(&bin_dir).unwrap();

        let fields = {
            let _env = EnvGuard::set_hwp(&fake_hwp(&bin_dir, &["사업명", "hwp_only_slot"]));
            run(ipc::template_get_fields(text(&root), request())).unwrap()
        };
        // hwp_only_slot is reported only by `hwp slots`, so its presence proves
        // the hwp result was merged with the kordoc_lite scan.
        assert!(fields
            .warnings
            .iter()
            .all(|w| !w.contains("kordoc_lite scan only")));
        let hwp_only = fields
            .fields
            .iter()
            .find(|field| field.key == "hwp_only_slot")
            .unwrap();
        assert_eq!(hwp_only.source.as_deref(), Some("placeholder"));
        assert!(fields.fields.iter().any(|field| field.key == "사업명"));

        let not_executable = home.root.path().join("hwp");
        std::fs::write(&not_executable, "not a binary").unwrap();
        let degraded = {
            let _env = EnvGuard::set_hwp(&not_executable);
            run(ipc::template_get_fields(text(&root), request())).unwrap()
        };
        assert!(
            degraded
                .warnings
                .iter()
                .any(|w| w.contains("cli_missing") && w.contains("kordoc_lite scan only")),
            "{:?}",
            degraded.warnings
        );
        assert!(degraded.fields.iter().any(|field| field.key == "사업명"));
        assert!(!degraded
            .fields
            .iter()
            .any(|field| field.key == "hwp_only_slot"));
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
