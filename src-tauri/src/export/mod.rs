// M4 Export Pipeline (Phase 4 W8 scaffold).
//
// Markdown/structured source = SSOT. Anchor plans a deterministic output
// bundle (`source.md` + `output.{docx,hwpx,pdf}` + `manifest.yaml`) under
// a sibling directory of the source document. The actual docx/hwpx/pdf
// conversion is performed by the existing skills (hwpx / docx /
// hwp-toolkit / pptx-toolkit); this module owns the layout, manifest
// writing, and post-conversion validation.
//
// Spec: plan §M4, _sys/rules/frontmatter-schema.md.
//
// W8 scope (this commit):
//   - `export_plan`: compute the output bundle paths, hash the source,
//     and write a baseline manifest.yaml with `status: planned` for each
//     requested format. The Studio (M2) or palette commands stage the
//     conversion afterwards.
//   - `export_manifest_load`: read an existing manifest.
//   - `export_validate`: cross-check a manifest against on-disk outputs
//     (file present + sha256 still matches the recorded value).
//
// Future weeks layer the actual skill dispatch + hwpx-validate + OOXML
// validate + PDF font-embed checks on top of this manifest.

pub mod manifest;
pub mod validate;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub use manifest::{
    compute_source_sha256, plan_bundle, record_output_failure, record_output_pending,
    record_output_success, ExportFormat, ExportManifest, ExportOutputEntry, ExportOutputStatus,
};
pub use validate::{validate_manifest, ValidationReport, ValidationStatus};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportPlanRequest {
    pub workspace_root: String,
    /// Source markdown path, workspace-relative or absolute (inside the workspace).
    pub source_path: String,
    /// Requested formats (subset of: docx | hwpx | pdf).
    pub formats: Vec<String>,
    /// Override the output directory (default: `<source-stem>.exports/`
    /// sitting next to the source markdown).
    #[serde(default)]
    pub output_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportPlanResponse {
    pub manifest_path: String,
    pub manifest: ExportManifest,
}

#[tauri::command]
pub fn export_plan(req: ExportPlanRequest) -> Result<ExportPlanResponse, String> {
    let workspace = PathBuf::from(&req.workspace_root);
    if !workspace.exists() {
        return Err(format!(
            "workspace_root does not exist: {}",
            workspace.display()
        ));
    }

    let parsed_formats: Vec<ExportFormat> = req
        .formats
        .iter()
        .map(|s| ExportFormat::parse(s))
        .collect::<Result<Vec<_>, _>>()?;
    if parsed_formats.is_empty() {
        return Err("at least one format is required".to_string());
    }

    let (manifest_path, manifest) =
        plan_bundle(&workspace, &req.source_path, &parsed_formats, req.output_dir.as_deref())
            .map_err(|e| e.to_string())?;

    Ok(ExportPlanResponse {
        manifest_path: manifest_path.to_string_lossy().to_string(),
        manifest,
    })
}

#[tauri::command]
pub fn export_manifest_load(manifest_path: String) -> Result<ExportManifest, String> {
    manifest::load_manifest(&PathBuf::from(manifest_path)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn export_validate(manifest_path: String) -> Result<ValidationReport, String> {
    validate_manifest(&PathBuf::from(manifest_path)).map_err(|e| e.to_string())
}

// ---------- W9 transition commands ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportRecordPendingRequest {
    pub manifest_path: String,
    pub format: String,
}

#[tauri::command]
pub fn export_record_pending(req: ExportRecordPendingRequest) -> Result<ExportManifest, String> {
    let format = ExportFormat::parse(&req.format)?;
    record_output_pending(&PathBuf::from(req.manifest_path), format).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportRecordSuccessRequest {
    pub manifest_path: String,
    pub format: String,
    /// Absolute path to the generated output file.
    pub output_path: String,
}

#[tauri::command]
pub fn export_record_success(req: ExportRecordSuccessRequest) -> Result<ExportManifest, String> {
    let format = ExportFormat::parse(&req.format)?;
    record_output_success(
        &PathBuf::from(req.manifest_path),
        format,
        &PathBuf::from(req.output_path),
    )
    .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportRecordFailureRequest {
    pub manifest_path: String,
    pub format: String,
    pub reason: String,
}

#[tauri::command]
pub fn export_record_failure(req: ExportRecordFailureRequest) -> Result<ExportManifest, String> {
    let format = ExportFormat::parse(&req.format)?;
    record_output_failure(&PathBuf::from(req.manifest_path), format, &req.reason)
        .map_err(|e| e.to_string())
}
