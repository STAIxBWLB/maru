// M4 Export Pipeline (Phase 4 W8-W10).
//
// Markdown/structured source = SSOT. Maru plans a deterministic output
// bundle (`source.md` + `output.{docx,hwpx,pdf}` + `manifest.yaml`) under
// a sibling directory of the source document. W10 dispatch runs deterministic
// local converter commands from that manifest; later Studio/skill integrations
// can provide richer format-specific preparation before this module records and
// validates the outputs.
//
// Spec: plan §M4, _sys/rules/frontmatter-schema.md.
//
// Commands:
//   - `export_plan`: compute the output bundle paths, hash the source,
//     and write a baseline manifest.yaml with `status: planned` for each
//     requested format. The Studio (M2) or palette commands stage the
//     conversion afterwards.
//   - `export_validate`: cross-check a manifest against on-disk outputs
//     (file present + sha256 still matches the recorded value).
//   - `export_dispatch` (dispatch.rs): run deterministic local converters
//     from the manifest, then record and validate outputs. It owns the
//     whole pending → ready/failed lifecycle, so the W9 manual record_*
//     transition commands were removed.
//
// Later weeks can layer Studio state, hwpx field mapping, OOXML validation,
// and PDF font checks on top of the same manifest lifecycle.

pub mod dispatch;
pub mod manifest;
pub mod validate;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub use dispatch::export_dispatch;
pub use manifest::{plan_bundle, ExportFormat, ExportManifest};
pub use validate::{validate_manifest, ValidationReport};

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

    let (manifest_path, manifest) = plan_bundle(
        &workspace,
        &req.source_path,
        &parsed_formats,
        req.output_dir.as_deref(),
    )
    .map_err(|e| e.to_string())?;

    Ok(ExportPlanResponse {
        manifest_path: manifest_path.to_string_lossy().to_string(),
        manifest,
    })
}

#[tauri::command]
pub fn export_validate(manifest_path: String) -> Result<ValidationReport, String> {
    validate_manifest(&PathBuf::from(manifest_path)).map_err(|e| e.to_string())
}
