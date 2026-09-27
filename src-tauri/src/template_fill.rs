use crate::artifact_checks::{self, ArtifactCheck};
use crate::atomic_file::{
    with_path_transactions, write_atomic, PathTransactionLease, PathTransactionRequest,
};
use crate::hwp_cli_template;
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
    pub validation_checks: Vec<ArtifactCheck>,
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

    // hwp's `fields` already merges every {{slot}} (under its normalized key)
    // with the label cells and inline labels, one entry per key.
    let hwp = hwp_cli_template::hwp_bin()?;
    let scan = hwp_cli_template::form_scan(&hwp, &template_path)?;
    let mut warnings = Vec::new();
    if scan.fields.is_empty() {
        warnings.push("hwp found no placeholders or form labels".to_string());
    }
    let fields = scan
        .fields
        .into_iter()
        .map(|field| TemplateField {
            key: field.key,
            label: field.label,
            required: field.required,
            occurrences: field.occurrences,
            source: Some(field.source),
            confidence: Some(field.confidence),
            matched_key: None,
        })
        .collect();

    Ok(TemplateFieldResponse {
        template_path: template_path.to_string_lossy().to_string(),
        source,
        fields,
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
    if output_path == template_path || same_file(&output_path, &template_path) {
        return Err("Template fill output must not overwrite its template".to_string());
    }
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
    let parent = output_path
        .parent()
        .ok_or_else(|| "Template fill output path has no parent".to_string())?
        .to_path_buf();
    lease.ensure_covered(vec![output_path.clone(), parent.clone()])?;
    let hwp = hwp_cli_template::hwp_bin()?;
    fs::create_dir_all(&parent).map_err(|err| format!("Cannot create output directory: {err}"))?;

    // Build and check the fill in a sibling staging directory; the output is
    // published only once every requested {{slot}} is filled.
    let stage = tempfile::Builder::new()
        .prefix(".maru-template-fill-")
        .tempdir_in(&parent)
        .map_err(|err| format!("Cannot stage template fill: {err}"))?;
    let staged = stage.path().join("filled.hwpx");

    // One `hwp fill --forms` pass fills the slots and the form fields. A
    // requested slot it cannot fill is an error; a form key it cannot match
    // stays in `unmatched_fields`.
    let scan = hwp_cli_template::form_scan(&hwp, &template_path)?;
    let data_file = write_temp_values(&request.values)?;
    let report = hwp_cli_template::fill_forms(
        &hwp,
        &template_path,
        data_file.path(),
        &staged,
        &request.values,
    )?;
    let (slot_counts, form_counts): (Vec<_>, Vec<_>) =
        report.counts.iter().partition(|(key, _)| scan.is_slot(key));
    let unfilled = slot_counts
        .iter()
        .filter(|(_, count)| **count == 0)
        .map(|(key, _)| key.as_str())
        .collect::<Vec<_>>();
    if !unfilled.is_empty() {
        return Err(format!(
            "template_fill_unfilled_slots: {}",
            unfilled.join(", ")
        ));
    }
    let replaced_count = slot_counts.iter().map(|(_, count)| **count).sum();
    let form_filled_count = form_counts.iter().map(|(_, count)| **count).sum();

    let (validation_checks, _) = artifact_checks::hwpx_checks(Ok(hwp.as_path()), &staged);
    let validation_ok = validation_checks.iter().all(|check| check.status == "pass");
    let filled = fs::read(&staged).map_err(|err| format!("Cannot read staged fill: {err}"))?;
    write_atomic(&output_path, &filled).map_err(|err| format!("Cannot publish fill: {err}"))?;
    let mut warnings = report.warnings;
    if !validation_ok {
        warnings.push("Filled HWPX was written but hwp validation did not pass".to_string());
    }

    Ok(TemplateFillResponse {
        output_path: output_path.to_string_lossy().to_string(),
        replaced_count,
        validation_ok,
        command: command_label(
            &hwp,
            &hwp_cli_template::fill_args(
                &template_path,
                Path::new("<values.json>"),
                &output_path,
                &["--forms", "--allow-partial"],
            ),
        ),
        form_filled_count,
        unmatched_fields: report.unmatched,
        validation_checks,
        warnings,
    })
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

/// Whether two existing paths name the same file, so a symlink or a
/// case-insensitive spelling of the template cannot pass as a new output.
fn same_file(a: &Path, b: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        matches!(
            (fs::metadata(a), fs::metadata(b)),
            (Ok(x), Ok(y)) if x.dev() == y.dev() && x.ino() == y.ino()
        )
    }
    #[cfg(not(unix))]
    {
        matches!(
            (fs::canonicalize(a), fs::canonicalize(b)),
            (Ok(x), Ok(y)) if x == y
        )
    }
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
}

#[cfg(test)]
mod phase08_21 {
    use super::*;
    use crate::atomic_file::phase08_06::{boundary, run, Held, Home};
    use serde_json::json;
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

    /// The stub hwp reads nothing from the template, so its bytes are opaque.
    fn write_template(root: &Path) {
        std::fs::create_dir_all(root.join("templates")).unwrap();
        std::fs::write(root.join("templates/form.hwpx"), "template bytes").unwrap();
    }

    /// `hwp slots --forms --json` output: `slots` as placeholders (each also a
    /// required `placeholder` field) plus the given form fields.
    fn scan(slots: &[&str], forms: &[(&str, &str, &str)]) -> serde_json::Value {
        let mut fields = slots
            .iter()
            .map(|name| {
                json!({"key": name, "label": name, "source": "placeholder",
                       "confidence": 1.0, "occurrences": 1, "required": true})
            })
            .collect::<Vec<_>>();
        fields.extend(forms.iter().map(|(key, label, source)| {
            let confidence = if *source == "formLabel" { 0.72 } else { 0.64 };
            json!({"key": key, "label": label, "source": source,
                   "confidence": confidence, "occurrences": 1, "required": false})
        }));
        json!({
            "placeholders": slots
                .iter()
                .map(|name| json!({"name": name, "occurrences": 1}))
                .collect::<Vec<_>>(),
            "fields": fields,
        })
    }

    /// A well-formed `hwp fill --forms --json` report for `counts`.
    fn report(counts: &[(&str, u32)], unmatched: &[&str]) -> serde_json::Value {
        json!({
            "output": "filled.hwpx",
            "mode": "forms",
            "replaced": counts.iter().map(|(_, count)| count).sum::<u32>(),
            "counts": counts
                .iter()
                .map(|(name, count)| (name.to_string(), *count))
                .collect::<BTreeMap<_, _>>(),
            "unmatched": unmatched,
            "warnings": ["hwp warning"],
        })
    }

    /// Stub released hwp. `slots` prints `scan`; `fill` requires `--forms`,
    /// `--allow-partial` and `--json`, appends the values JSON it received to
    /// fill.log, publishes that JSON as the output (so the last admitted
    /// writer is visible in the published bytes) and prints `report`.
    #[cfg(unix)]
    fn fake_hwp(dir: &Path, scan: &serde_json::Value, report: &serde_json::Value) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let binary = dir.join("hwp");
        let script = format!(
            r#"#!/bin/sh
case "$1" in
  --version) echo "hwp 1.3.0" ;;
  slots)
    [ "$3" = "--forms" ] && [ "$4" = "--json" ] || exit 2
    printf '%s\n' '{scan}' ;;
  fill)
    template="$2"; output=""; data=""; forms=false; partial=false; json=false
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -o) shift; output="$1" ;;
        --data) shift; data="$1" ;;
        --forms) forms=true ;;
        --allow-partial) partial=true ;;
        --json) json=true ;;
      esac
      shift
    done
    [ -n "$output" ] && [ -f "$template" ] && [ -f "$data" ] && [ "$forms" = true ] && [ "$partial" = true ] && [ "$json" = true ] || exit 2
    cat "$data" >> "{log}"
    printf '\n' >> "{log}"
    cp "$data" "$output"
    printf '%s\n' '{report}' ;;
  validate) printf '%s\n' '{{"valid":true,"format":"hwpx","errors":[]}}' ;;
  info) printf '%s\n' '{{"sections":1}}' ;;
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

    fn fill_log(dir: &Path) -> Vec<String> {
        std::fs::read_to_string(dir.join("fill.log"))
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect()
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

    fn published(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap()
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
        write_template(&root);
        let bin_dir = home.root.path().join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let _env = EnvGuard::set_hwp(&fake_hwp(
            &bin_dir,
            &scan(&["제목"], &[]),
            &report(&[("제목", 1)], &[]),
        ));
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
            published(&root.join("out/filled.hwpx")).contains("제목값"),
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
        let _env = EnvGuard::set_hwp(&fake_hwp(
            &bin_dir,
            &scan(&["제목"], &[]),
            &report(&[("제목", 1)], &[]),
        ));
        for swap in [false, true] {
            let root = home.root.path().join(format!("fill-{swap}"));
            write_template(&root);
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
                published(&target).contains(second_marker),
                "second admitted writer must own the final bytes"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn phase08_21_template_denied_and_error_release_admission() {
        let home = Home::new();
        let root = home.root.path().join("policy");
        write_template(&root);
        let bin_dir = home.root.path().join("bin-policy");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let _env = EnvGuard::set_hwp(&fake_hwp(
            &bin_dir,
            &scan(&["제목"], &[]),
            &report(&[("제목", 1)], &[]),
        ));
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
            published(&root.join("blocked/published.hwpx")).contains("recovered"),
            "retry after admission error must publish the recovered fill"
        );
    }

    /// A slot, a label cell and an inline label fill from one `hwp fill
    /// --forms` call, and the counts split into slots and form fields.
    #[cfg(unix)]
    #[test]
    fn phase08_21_template_fill_one_forms_pass_splits_slot_and_form_counts() {
        let home = Home::new();
        let root = home.root.path().join("mixed");
        write_template(&root);
        let bin_dir = home.root.path().join("bin-mixed");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let _env = EnvGuard::set_hwp(&fake_hwp(
            &bin_dir,
            &scan(
                &["제목"],
                &[
                    ("성명", "성명", "formLabel"),
                    ("담당자", "담당자", "inlineLabel"),
                ],
            ),
            &report(&[("담당자", 1), ("성명", 2), ("제목", 1)], &[]),
        ));
        let values = BTreeMap::from([
            ("제목".to_string(), "사업계획".to_string()),
            ("성명".to_string(), "홍길동".to_string()),
            ("담당자".to_string(), "이영준".to_string()),
        ]);

        let filled = run(ipc::template_fill_hwpx(
            text(&root),
            fill_request(values.clone(), Some("out/mixed.hwpx".to_string())),
        ))
        .unwrap();
        assert_eq!(
            fill_log(&bin_dir),
            vec![serde_json::to_string(&values).unwrap()],
            "one hwp fill receives every requested value"
        );
        assert_eq!(filled.replaced_count, 1);
        assert_eq!(filled.form_filled_count, 3);
        assert!(filled.command.contains(" fill "), "{}", filled.command);
        assert!(filled.command.contains("--forms"), "{}", filled.command);
        assert!(filled.unmatched_fields.is_empty());
        assert!(filled.validation_ok, "{:?}", filled.warnings);
        assert_eq!(filled.warnings, vec!["hwp warning"]);
        assert_eq!(
            filled
                .validation_checks
                .iter()
                .map(|check| (check.name.as_str(), check.status.as_str()))
                .collect::<Vec<_>>(),
            [("zip-safety", "pass"), ("hwpx-sections", "pass")]
        );
        let output = published(&root.join("out/mixed.hwpx"));
        assert!(
            output.contains("사업계획") && output.contains("홍길동"),
            "{output}"
        );
    }

    /// #363: a padded `{{ 제목 }}`, even in an all-padded template, fills in the
    /// one pass; hwp reports slot names trimmed and fills them padded.
    #[cfg(unix)]
    #[test]
    fn phase08_21_template_fill_all_padded_slots_fill_in_one_pass() {
        let home = Home::new();
        let root = home.root.path().join("all-padded");
        write_template(&root);
        let bin_dir = home.root.path().join("bin-all-padded");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let _env = EnvGuard::set_hwp(&fake_hwp(
            &bin_dir,
            &scan(&["기관", "제목"], &[]),
            &report(&[("기관", 1), ("제목", 1)], &[]),
        ));

        let filled = run(ipc::template_fill_hwpx(
            text(&root),
            fill_request(
                BTreeMap::from([
                    ("제목".to_string(), "패딩값".to_string()),
                    ("기관".to_string(), "기관값".to_string()),
                ]),
                Some("out/all-padded.hwpx".to_string()),
            ),
        ))
        .unwrap();
        assert_eq!(fill_log(&bin_dir).len(), 1, "no second pass or fallback");
        assert_eq!(filled.replaced_count, 2);
        assert_eq!(filled.form_filled_count, 0);
        assert!(filled.unmatched_fields.is_empty());
        let output = published(&root.join("out/all-padded.hwpx"));
        assert!(
            output.contains("패딩값") && output.contains("기관값"),
            "{output}"
        );
    }

    /// A form key hwp cannot match stays in `unmatched_fields`, and a zero
    /// count outside `unmatched` (a checkbox left unchecked) is matched.
    #[cfg(unix)]
    #[test]
    fn phase08_21_template_fill_keeps_unmatched_form_keys_as_warnings() {
        let home = Home::new();
        let root = home.root.path().join("labels");
        write_template(&root);
        let bin_dir = home.root.path().join("bin-labels");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let _env = EnvGuard::set_hwp(&fake_hwp(
            &bin_dir,
            &scan(&[], &[("성명", "성명", "formLabel")]),
            &report(&[("동의", 0), ("성명", 1), ("없는키", 0)], &["없는키"]),
        ));

        let filled = run(ipc::template_fill_hwpx(
            text(&root),
            fill_request(
                BTreeMap::from([
                    ("성명".to_string(), "홍길동".to_string()),
                    ("동의".to_string(), "false".to_string()),
                    ("없는키".to_string(), "x".to_string()),
                ]),
                Some("out/labels.hwpx".to_string()),
            ),
        ))
        .unwrap();
        assert_eq!(filled.replaced_count, 0);
        assert_eq!(filled.form_filled_count, 1);
        assert_eq!(filled.unmatched_fields, vec!["없는키"]);
        assert!(published(&root.join("out/labels.hwpx")).contains("홍길동"));
    }

    #[cfg(unix)]
    #[test]
    fn phase08_21_template_fill_fails_closed_on_a_slot_nothing_filled() {
        let home = Home::new();
        let root = home.root.path().join("unfillable");
        write_template(&root);
        let bin_dir = home.root.path().join("bin-unfillable");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let _env = EnvGuard::set_hwp(&fake_hwp(
            &bin_dir,
            &scan(&["제목"], &[("성명", "성명", "formLabel")]),
            &report(&[("성명", 1), ("제목", 0)], &["제목"]),
        ));

        let err = run(ipc::template_fill_hwpx(
            text(&root),
            fill_request(
                BTreeMap::from([
                    ("제목".to_string(), "x".to_string()),
                    ("성명".to_string(), "홍길동".to_string()),
                ]),
                Some("out/unfillable.hwpx".to_string()),
            ),
        ))
        .unwrap_err();
        assert_eq!(err, "template_fill_unfilled_slots: 제목");
        assert!(!root.join("out/unfillable.hwpx").exists());
    }

    #[cfg(unix)]
    #[test]
    fn phase08_21_template_fill_rejects_a_malformed_forms_report() {
        let home = Home::new();
        let root = home.root.path().join("malformed");
        write_template(&root);
        let bin_dir = home.root.path().join("bin-malformed");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let mut total_disagrees = report(&[("제목", 1)], &[]);
        total_disagrees["replaced"] = json!(2);
        for (bad, expected) in [
            (report(&[], &[]), "omitted counts for 제목"),
            (total_disagrees, "replaced 2 does not match counts total 1"),
            (
                report(&[("제목", 1)], &["제목"]),
                "unmatched 제목 without a zero count",
            ),
        ] {
            let _env = EnvGuard::set_hwp(&fake_hwp(&bin_dir, &scan(&["제목"], &[]), &bad));
            let err = run(ipc::template_fill_hwpx(
                text(&root),
                fill_request(values("x"), Some("out/malformed.hwpx".to_string())),
            ))
            .unwrap_err();
            assert!(err.starts_with("hwp_fill_invalid_report"), "{err}");
            assert!(err.contains(expected), "{err}");
            assert!(!root.join("out/malformed.hwpx").exists());
        }
    }

    #[cfg(unix)]
    #[test]
    fn phase08_21_template_fill_fails_closed_without_a_released_hwp() {
        let home = Home::new();
        let root = home.root.path().join("no-hwp");
        write_template(&root);
        let not_executable = home.root.path().join("hwp");
        std::fs::write(&not_executable, "not a binary").unwrap();
        let _env = EnvGuard::set_hwp(&not_executable);

        let err = run(ipc::template_fill_hwpx(
            text(&root),
            fill_request(values("x"), Some("out/filled.hwpx".to_string())),
        ))
        .unwrap_err();
        assert!(err.contains("cli_missing"), "{err}");
        assert!(
            !root.join("out").exists(),
            "a cli_missing fill leaves nothing behind"
        );
    }

    #[test]
    fn phase08_21_template_fill_refuses_to_overwrite_its_template() {
        let home = Home::new();
        let root = home.root.path().join("same-path");
        write_template(&root);
        let before = std::fs::read(root.join("templates/form.hwpx")).unwrap();
        let err = run(ipc::template_fill_hwpx(
            text(&root),
            fill_request(values("x"), Some("templates/form.hwpx".to_string())),
        ))
        .unwrap_err();
        assert!(err.contains("must not overwrite its template"), "{err}");
        #[cfg(unix)]
        {
            // A symlink to the template is the template too.
            std::os::unix::fs::symlink(root.join("templates/form.hwpx"), root.join("alias.hwpx"))
                .unwrap();
            let err = run(ipc::template_fill_hwpx(
                text(&root),
                fill_request(values("x"), Some("alias.hwpx".to_string())),
            ))
            .unwrap_err();
            assert!(err.contains("must not overwrite its template"), "{err}");
        }
        assert_eq!(
            std::fs::read(root.join("templates/form.hwpx")).unwrap(),
            before
        );
    }

    /// hwp's form scan maps onto placeholder, formLabel and inlineLabel fields
    /// as it reports them.
    #[cfg(unix)]
    #[test]
    fn phase08_21_template_fields_map_the_hwp_form_scan_and_need_hwp() {
        let home = Home::new();
        let root = home.root.path().join("fields");
        write_template(&root);
        let request = || TemplateFieldRequest {
            template_key: None,
            template_path: Some("templates/form.hwpx".to_string()),
        };
        let bin_dir = home.root.path().join("bin-fields");
        std::fs::create_dir_all(&bin_dir).unwrap();

        let fields = {
            let mut scan = scan(
                &["제목"],
                &[
                    ("담당자", "담당자", "inlineLabel"),
                    ("한문", "(한문:   )", "formLabel"),
                ],
            );
            // One key seen as a slot and as a label cell: hwp merges it.
            scan["fields"].as_array_mut().unwrap().push(json!({
                "key": "성명", "label": "성명", "source": "formLabel",
                "confidence": 0.72, "occurrences": 2, "required": true
            }));
            let _env = EnvGuard::set_hwp(&fake_hwp(&bin_dir, &scan, &report(&[], &[])));
            run(ipc::template_get_fields(text(&root), request())).unwrap()
        };
        let by_key = |key: &str| {
            fields
                .fields
                .iter()
                .find(|field| field.key == key)
                .unwrap_or_else(|| panic!("{key} in {:?}", fields.fields))
        };
        assert_eq!(fields.fields.len(), 4);
        assert!(fields.warnings.is_empty(), "{:?}", fields.warnings);
        let title = by_key("제목");
        assert_eq!(title.source.as_deref(), Some("placeholder"));
        assert_eq!(title.confidence, Some(1.0));
        assert!(title.required);
        let name = by_key("성명");
        assert_eq!(name.source.as_deref(), Some("formLabel"));
        assert_eq!(name.occurrences, 2);
        assert!(name.required);
        assert!(name.matched_key.is_none());
        assert_eq!(by_key("담당자").source.as_deref(), Some("inlineLabel"));
        assert_eq!(by_key("한문").label, "(한문:   )");

        let not_executable = home.root.path().join("hwp");
        std::fs::write(&not_executable, "not a binary").unwrap();
        let err = {
            let _env = EnvGuard::set_hwp(&not_executable);
            run(ipc::template_get_fields(text(&root), request())).unwrap_err()
        };
        assert!(err.contains("cli_missing"), "{err}");
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
