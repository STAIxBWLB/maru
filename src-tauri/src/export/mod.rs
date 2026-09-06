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
use std::path::{Path, PathBuf};

#[cfg(test)]
use crate::atomic_file::PathTransactionLease;
use crate::atomic_file::{with_path_transactions, PathTransactionRequest};

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

    let workspace_abs = absolute_lexical(&workspace);
    let (bundle_dir, manifest_path) =
        plan_bundle_paths(&workspace_abs, &req.source_path, req.output_dir.as_deref());
    let request = PathTransactionRequest::new(vec![bundle_dir, manifest_path.clone()])?
        .require_parent(&workspace_abs)?
        .with_workspace_registry()?;
    with_path_transactions(request, |lease| {
        lease.ensure_workspace_registry()?;
        lease.ensure_covered(std::iter::once(manifest_path.clone()))?;
        lease.before_effect()?;
        let (planned_path, manifest) = plan_bundle(
            &workspace_abs,
            &req.source_path,
            &parsed_formats,
            req.output_dir.as_deref(),
        )
        .map_err(|e| e.to_string())?;
        lease.ensure_covered(std::iter::once(planned_path.clone()))?;
        Ok(ExportPlanResponse {
            manifest_path: planned_path.to_string_lossy().to_string(),
            manifest,
        })
    })
}

fn absolute_lexical(path: &Path) -> PathBuf {
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    crate::vault::lexical_normalize(&joined)
}

/// Mirror of `plan_bundle`'s destination resolution so the complete write set
/// (bundle directory + manifest.yaml) is admitted before any effect. Any drift
/// from `plan_bundle` fails closed via `PathTransactionLease::ensure_covered`.
fn plan_bundle_paths(
    workspace_root: &Path,
    source_rel_or_abs: &str,
    output_dir_override: Option<&str>,
) -> (PathBuf, PathBuf) {
    let source_path = if Path::new(source_rel_or_abs).is_absolute() {
        PathBuf::from(source_rel_or_abs)
    } else {
        workspace_root.join(source_rel_or_abs)
    };
    let bundle_dir = match output_dir_override {
        Some(rel) => workspace_root.join(rel),
        None => {
            let stem = source_path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "export".to_string());
            source_path
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join(format!("{stem}.exports"))
        }
    };
    let bundle_dir = crate::vault::lexical_normalize(&bundle_dir);
    (bundle_dir.clone(), bundle_dir.join("manifest.yaml"))
}

pub fn export_validate(manifest_path: String) -> Result<ValidationReport, String> {
    validate_manifest(&PathBuf::from(&manifest_path)).map_err(|e| e.to_string())
}

/// Owned IPC boundaries; the synchronous entry points remain available to Rust callers.
pub mod ipc {
    use super::*;
    #[tauri::command]
    pub async fn export_plan(req: ExportPlanRequest) -> Result<ExportPlanResponse, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&req.workspace_root)],
                "worker:export_plan",
            );
            super::export_plan(req)
        })
        .await
        .map_err(|err| format!("export_plan_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn export_validate(manifest_path: String) -> Result<ValidationReport, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&manifest_path)],
                "worker:export_validate",
            );
            super::export_validate(manifest_path)
        })
        .await
        .map_err(|err| format!("export_validate_task_failed: {err}"))?
    }
}

#[cfg(test)]
mod phase08_21 {
    use super::*;
    use crate::atomic_file::phase08_06::{boundary, run, Home};

    fn text(path: &std::path::Path) -> String {
        path.to_string_lossy().into_owned()
    }

    fn plan_request(root: &std::path::Path) -> ExportPlanRequest {
        ExportPlanRequest {
            workspace_root: text(root),
            source_path: "draft.md".to_string(),
            formats: vec!["docx".to_string(), "hwpx".to_string()],
            output_dir: None,
        }
    }

    #[test]
    fn phase08_21_export_plan_validate_yield_same_poll_and_map_join_failure() {
        let home = Home::new();
        let root = home.root.path();
        boundary(
            root.into(),
            "export_plan",
            ipc::export_plan(plan_request(root)),
        );
        boundary(
            root.join("draft.exports/manifest.yaml").into(),
            "export_validate",
            ipc::export_validate(text(&root.join("draft.exports/manifest.yaml"))),
        );
    }

    #[test]
    fn phase08_21_export_plan_validate_real_fixture_and_legacy_rejections() {
        let home = Home::new();
        let root = home.root.path().join("work");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("draft.md"), "# Title\n\nbody\n").unwrap();

        let planned = run(ipc::export_plan(plan_request(&root))).unwrap();
        assert_eq!(planned.manifest.outputs.len(), 2);
        assert!(PathBuf::from(&planned.manifest_path).is_file());
        for output in &planned.manifest.outputs {
            assert_eq!(output.status, manifest::ExportOutputStatus::Planned);
        }

        let report = run(ipc::export_validate(planned.manifest_path.clone())).unwrap();
        assert_eq!(report.entries.len(), 2);
        assert!(report
            .entries
            .iter()
            .all(|entry| entry.status == validate::ValidationStatus::Skipped));

        let err = run(ipc::export_plan(ExportPlanRequest {
            workspace_root: text(&home.root.path().join("missing")),
            source_path: "draft.md".to_string(),
            formats: vec!["docx".to_string()],
            output_dir: None,
        }))
        .unwrap_err();
        assert!(err.contains("workspace_root does not exist"), "{err}");

        let err = run(ipc::export_plan(ExportPlanRequest {
            workspace_root: text(&root),
            source_path: "draft.md".to_string(),
            formats: Vec::new(),
            output_dir: None,
        }))
        .unwrap_err();
        assert_eq!(err, "at least one format is required");

        let err = run(ipc::export_plan(ExportPlanRequest {
            workspace_root: text(&root),
            source_path: "draft.md".to_string(),
            formats: vec!["md".to_string()],
            output_dir: None,
        }))
        .unwrap_err();
        assert!(err.contains("unsupported format: md"), "{err}");

        assert!(run(ipc::export_validate(text(
            &home.root.path().join("missing/manifest.yaml")
        )))
        .is_err());
    }

    #[test]
    fn phase08_21_export_plan_error_releases_admission() {
        let home = Home::new();
        let root = home.root.path().join("error-release");
        std::fs::create_dir_all(&root).unwrap();

        // The source is missing, so plan_bundle fails inside the transaction;
        // the lease must release so the retry after the fix is admitted.
        let err = run(ipc::export_plan(plan_request(&root))).unwrap_err();
        assert!(err.contains("source not found"), "{err}");
        assert!(!root.join("draft.exports").exists());

        std::fs::write(root.join("draft.md"), "# Title\n\nbody\n").unwrap();
        let planned = run(ipc::export_plan(plan_request(&root))).unwrap();
        assert!(PathBuf::from(&planned.manifest_path).is_file());
    }
}
