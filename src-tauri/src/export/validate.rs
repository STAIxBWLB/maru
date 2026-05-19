// Validates an existing export manifest against the on-disk bundle.
//
// W8 scope: structural validation only — confirms each manifest output
// exists, hashes it, and compares against the recorded sha256. Phase 4
// W9+ adds the format-specific checks (hwpx-validate, OOXML schema,
// font-embed for PDFs).

use serde::{Deserialize, Serialize};
use std::io;
use std::path::{Path, PathBuf};

use super::manifest::{compute_source_sha256, load_manifest, ExportFormat, ExportOutputStatus};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ValidationStatus {
    /// File exists and (when applicable) sha256 matches the manifest entry.
    Pass,
    /// File missing.
    Missing,
    /// sha256 in the manifest no longer matches the file on disk.
    HashMismatch,
    /// Entry is still `planned` / `pending` — no output produced yet.
    Skipped,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidationEntry {
    pub format: ExportFormat,
    pub path: String,
    pub status: ValidationStatus,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidationReport {
    pub manifest_path: String,
    pub source_path: String,
    pub source_status: ValidationStatus,
    pub entries: Vec<ValidationEntry>,
}

pub fn validate_manifest(manifest_path: &Path) -> io::Result<ValidationReport> {
    let manifest = load_manifest(manifest_path)?;
    let workspace_root = workspace_root_from_manifest(manifest_path)?;

    let source_abs = workspace_root.join(&manifest.source);
    let source_status = match source_abs.exists() {
        false => ValidationStatus::Missing,
        true => match compute_source_sha256(&source_abs) {
            Ok((sha, _)) if sha == manifest.source_sha256 => ValidationStatus::Pass,
            Ok(_) => ValidationStatus::HashMismatch,
            Err(_) => ValidationStatus::Missing,
        },
    };

    let mut entries: Vec<ValidationEntry> = Vec::with_capacity(manifest.outputs.len());
    for out in manifest.outputs.iter() {
        let abs = workspace_root.join(&out.path);
        let (status, reason) = match out.status {
            ExportOutputStatus::Planned | ExportOutputStatus::Pending => (
                ValidationStatus::Skipped,
                Some(format!("status: {:?}", out.status)),
            ),
            ExportOutputStatus::Failed => (
                ValidationStatus::Skipped,
                out.reason
                    .clone()
                    .or_else(|| Some("conversion failed".to_string())),
            ),
            ExportOutputStatus::Ready => {
                if !abs.exists() {
                    (
                        ValidationStatus::Missing,
                        Some(format!("missing: {}", out.path)),
                    )
                } else if let Some(expected) = &out.sha256 {
                    match compute_source_sha256(&abs) {
                        Ok((actual, _)) if &actual == expected => (ValidationStatus::Pass, None),
                        Ok(_) => (
                            ValidationStatus::HashMismatch,
                            Some("on-disk sha256 differs".to_string()),
                        ),
                        Err(e) => (ValidationStatus::Missing, Some(e.to_string())),
                    }
                } else {
                    (
                        ValidationStatus::Pass,
                        Some("ready without recorded sha256".to_string()),
                    )
                }
            }
        };
        entries.push(ValidationEntry {
            format: out.format,
            path: out.path.clone(),
            status,
            reason,
        });
    }

    Ok(ValidationReport {
        manifest_path: manifest_path.to_string_lossy().to_string(),
        source_path: manifest.source.clone(),
        source_status,
        entries,
    })
}

/// Recover the workspace root from the manifest path by walking up until
/// we exit the bundle directory. The manifest lives at
/// `<workspace_root>/<bundle_dir>/manifest.yaml`. We treat the parent of
/// the bundle directory as the workspace anchor.
///
/// Callers can also pass an absolute path that already resolves correctly.
fn workspace_root_from_manifest(manifest_path: &Path) -> io::Result<PathBuf> {
    let manifest = load_manifest(manifest_path)?;
    let bundle_dir = manifest_path.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "manifest path has no parent")
    })?;
    for ancestor in bundle_dir.ancestors().skip(1) {
        if ancestor.join(&manifest.source).exists() {
            return Ok(ancestor.to_path_buf());
        }
    }
    bundle_dir
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "bundle dir has no parent"))
}

#[cfg(test)]
mod tests {
    use super::super::manifest::{plan_bundle, save_manifest, ExportFormat, ExportOutputStatus};
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn setup() -> (TempDir, PathBuf, PathBuf) {
        let tmp = TempDir::new().unwrap();
        let source = tmp.path().join("draft.md");
        fs::write(&source, "# Title\n\nbody\n").unwrap();
        let (manifest_path, _) = plan_bundle(
            tmp.path(),
            source.to_string_lossy().as_ref(),
            &[ExportFormat::Docx],
            None,
        )
        .unwrap();
        (tmp, source, manifest_path)
    }

    #[test]
    fn validate_reports_planned_outputs_as_skipped() {
        let (_tmp, _source, manifest_path) = setup();
        let report = validate_manifest(&manifest_path).unwrap();
        assert_eq!(report.source_status, ValidationStatus::Pass);
        assert_eq!(report.entries[0].status, ValidationStatus::Skipped);
    }

    #[test]
    fn validate_recovers_workspace_root_for_nested_bundle() {
        let tmp = TempDir::new().unwrap();
        let source = tmp.path().join("projects/x/draft.md");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::write(&source, "# Title\n\nbody\n").unwrap();
        let (manifest_path, _) = plan_bundle(
            tmp.path(),
            "projects/x/draft.md",
            &[ExportFormat::Docx],
            None,
        )
        .unwrap();

        let report = validate_manifest(&manifest_path).unwrap();
        assert_eq!(report.source_status, ValidationStatus::Pass);
        assert_eq!(report.source_path, "projects/x/draft.md");
    }

    #[test]
    fn validate_flags_hash_mismatch_after_source_edit() {
        let (_tmp, source, manifest_path) = setup();
        // Mutate the source after plan — sha256 should no longer match.
        fs::write(&source, "# Title\n\nedited body\n").unwrap();
        let report = validate_manifest(&manifest_path).unwrap();
        assert_eq!(report.source_status, ValidationStatus::HashMismatch);
    }

    #[test]
    fn validate_pass_for_ready_output_with_matching_sha() {
        let (_tmp, _source, manifest_path) = setup();
        let mut manifest = load_manifest(&manifest_path).unwrap();
        // Materialize the output and record its sha.
        let bundle_dir = manifest_path.parent().unwrap();
        let workspace_root = workspace_root_from_manifest(&manifest_path).unwrap();
        let docx_abs = workspace_root.join(&manifest.outputs[0].path);
        fs::create_dir_all(docx_abs.parent().unwrap()).unwrap();
        fs::write(&docx_abs, "fake docx bytes").unwrap();
        let (sha, size) = compute_source_sha256(&docx_abs).unwrap();
        manifest.outputs[0].status = ExportOutputStatus::Ready;
        manifest.outputs[0].sha256 = Some(sha);
        manifest.outputs[0].byte_size = Some(size);
        save_manifest(&manifest_path, &manifest).unwrap();

        let _ = bundle_dir;
        let report = validate_manifest(&manifest_path).unwrap();
        assert_eq!(report.entries[0].status, ValidationStatus::Pass);
    }

    #[test]
    fn validate_flags_missing_when_output_is_promised_but_absent() {
        let (_tmp, _source, manifest_path) = setup();
        let mut manifest = load_manifest(&manifest_path).unwrap();
        manifest.outputs[0].status = ExportOutputStatus::Ready;
        manifest.outputs[0].sha256 = Some("a".repeat(64));
        save_manifest(&manifest_path, &manifest).unwrap();
        let report = validate_manifest(&manifest_path).unwrap();
        assert_eq!(report.entries[0].status, ValidationStatus::Missing);
    }
}
