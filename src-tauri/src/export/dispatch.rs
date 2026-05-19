// W10 export auto-dispatch.
//
// This layer keeps the export manifest as the SSOT and drives deterministic
// local converters for each requested format. It intentionally stays outside
// the AI skill proposal flow: exporting a bundle is an explicit user command,
// and every output is still recorded through the W9 manifest transitions.

use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use super::manifest::{
    compute_source_sha256, load_manifest, record_output_failure, record_output_pending,
    record_output_success, ExportFormat, ExportManifest, ExportOutputEntry,
};
use super::validate::{validate_manifest, ValidationReport};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportDispatchRequest {
    pub workspace_root: String,
    pub manifest_path: String,
    /// Optional subset of manifest formats to run. Empty or omitted means all.
    #[serde(default)]
    pub formats: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportDispatchResult {
    pub format: ExportFormat,
    pub output_path: String,
    pub success: bool,
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportDispatchResponse {
    pub manifest_path: String,
    pub manifest: ExportManifest,
    pub validation: ValidationReport,
    pub results: Vec<ExportDispatchResult>,
}

#[tauri::command]
pub fn export_dispatch(req: ExportDispatchRequest) -> Result<ExportDispatchResponse, String> {
    dispatch_bundle(
        &PathBuf::from(req.workspace_root),
        &PathBuf::from(req.manifest_path),
        &req.formats,
    )
    .map_err(|err| err.to_string())
}

pub fn dispatch_bundle(
    workspace_root: &Path,
    manifest_path: &Path,
    requested_formats: &[String],
) -> io::Result<ExportDispatchResponse> {
    let mut manifest = load_manifest(manifest_path)?;
    let formats = select_formats(&manifest, requested_formats)?;
    let source_abs = workspace_root.join(&manifest.source);
    let mut results = Vec::new();

    if source_changed(&source_abs, &manifest)? {
        for format in formats {
            let output_path = output_path_for(workspace_root, &manifest, format)?;
            let reason = "source sha256 changed; re-plan the export bundle".to_string();
            manifest = record_output_failure(manifest_path, format, &reason)?;
            results.push(ExportDispatchResult {
                format,
                output_path: output_path.to_string_lossy().to_string(),
                success: false,
                command: "preflight".to_string(),
                reason: Some(reason),
            });
        }
        let validation = validate_manifest(manifest_path)?;
        return Ok(ExportDispatchResponse {
            manifest_path: manifest_path.to_string_lossy().to_string(),
            manifest,
            validation,
            results,
        });
    }

    for format in formats {
        manifest = record_output_pending(manifest_path, format)?;
        let output_path = output_path_for(workspace_root, &manifest, format)?;
        if let Some(parent) = output_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let run = match format {
            ExportFormat::Docx => convert_docx(&source_abs, &output_path),
            ExportFormat::Hwpx => convert_hwpx(&source_abs, &output_path),
            ExportFormat::Pdf => convert_pdf(workspace_root, &manifest, &source_abs, &output_path),
        };

        let command_label = run.command;
        match run.result {
            Ok(()) if output_path.exists() => {
                let _ = record_output_success(manifest_path, format, &output_path)?;
                results.push(ExportDispatchResult {
                    format,
                    output_path: output_path.to_string_lossy().to_string(),
                    success: true,
                    command: command_label,
                    reason: None,
                });
            }
            Ok(()) => {
                let reason = format!(
                    "converter finished but output is missing: {}",
                    output_path.display()
                );
                let _ = record_output_failure(manifest_path, format, &reason)?;
                results.push(ExportDispatchResult {
                    format,
                    output_path: output_path.to_string_lossy().to_string(),
                    success: false,
                    command: command_label,
                    reason: Some(reason),
                });
            }
            Err(err) => {
                let reason = err.to_string();
                let _ = record_output_failure(manifest_path, format, &reason)?;
                results.push(ExportDispatchResult {
                    format,
                    output_path: output_path.to_string_lossy().to_string(),
                    success: false,
                    command: command_label,
                    reason: Some(reason),
                });
            }
        }
    }

    let manifest = load_manifest(manifest_path)?;
    let validation = validate_manifest(manifest_path)?;
    Ok(ExportDispatchResponse {
        manifest_path: manifest_path.to_string_lossy().to_string(),
        manifest,
        validation,
        results,
    })
}

struct ConverterRun {
    command: String,
    result: io::Result<()>,
}

fn select_formats(
    manifest: &ExportManifest,
    requested_formats: &[String],
) -> io::Result<Vec<ExportFormat>> {
    let wanted = if requested_formats.is_empty() {
        manifest.outputs.iter().map(|entry| entry.format).collect()
    } else {
        requested_formats
            .iter()
            .map(|value| ExportFormat::parse(value).map_err(invalid_input))
            .collect::<io::Result<Vec<_>>>()?
    };
    for format in &wanted {
        if !manifest.outputs.iter().any(|entry| entry.format == *format) {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("manifest has no entry for format {:?}", format),
            ));
        }
    }
    Ok(order_formats(wanted))
}

fn order_formats(mut formats: Vec<ExportFormat>) -> Vec<ExportFormat> {
    formats.sort_by_key(|format| match format {
        ExportFormat::Docx => 0,
        ExportFormat::Hwpx => 1,
        ExportFormat::Pdf => 2,
    });
    formats.dedup();
    formats
}

fn source_changed(source_abs: &Path, manifest: &ExportManifest) -> io::Result<bool> {
    let (sha, size) = compute_source_sha256(source_abs)?;
    Ok(sha != manifest.source_sha256 || size != manifest.source_byte_size)
}

fn output_path_for(
    workspace_root: &Path,
    manifest: &ExportManifest,
    format: ExportFormat,
) -> io::Result<PathBuf> {
    let entry = entry_for(manifest, format)?;
    Ok(workspace_root.join(&entry.path))
}

fn entry_for(manifest: &ExportManifest, format: ExportFormat) -> io::Result<&ExportOutputEntry> {
    manifest
        .outputs
        .iter()
        .find(|entry| entry.format == format)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                format!("manifest has no entry for format {:?}", format),
            )
        })
}

fn convert_docx(source: &Path, output: &Path) -> ConverterRun {
    let Some(pandoc) = find_program("pandoc") else {
        return ConverterRun {
            command: "pandoc".to_string(),
            result: Err(not_found("pandoc")),
        };
    };
    run(
        &pandoc,
        &[
            source.as_os_str().to_os_string(),
            OsString::from("--from"),
            OsString::from("markdown"),
            OsString::from("--to"),
            OsString::from("docx"),
            OsString::from("-o"),
            output.as_os_str().to_os_string(),
        ],
    )
}

fn convert_hwpx(source: &Path, output: &Path) -> ConverterRun {
    let Some(hwpx) = find_hwpx_tool() else {
        return ConverterRun {
            command: "hwpx".to_string(),
            result: Err(not_found("hwpx")),
        };
    };

    let styled = run(
        &hwpx,
        &[
            OsString::from("styled"),
            OsString::from("--preset"),
            OsString::from("bogoseo"),
            OsString::from("--markdown"),
            source.as_os_str().to_os_string(),
            OsString::from("-o"),
            output.as_os_str().to_os_string(),
        ],
    );
    if styled.result.is_ok() {
        return styled;
    }

    run(
        &hwpx,
        &[
            OsString::from("write-java"),
            output.as_os_str().to_os_string(),
            OsString::from("--markdown"),
            source.as_os_str().to_os_string(),
        ],
    )
}

fn convert_pdf(
    workspace_root: &Path,
    manifest: &ExportManifest,
    source: &Path,
    output: &Path,
) -> ConverterRun {
    if let Some(hwpx_entry) = manifest
        .outputs
        .iter()
        .find(|entry| entry.format == ExportFormat::Hwpx)
    {
        let hwpx_path = workspace_root.join(&hwpx_entry.path);
        if hwpx_path.exists() && find_soffice().is_some() {
            if let Some(hwpx) = find_hwpx_tool() {
                let via_hwpx = run(
                    &hwpx,
                    &[
                        OsString::from("to-pdf"),
                        hwpx_path.as_os_str().to_os_string(),
                        OsString::from("-o"),
                        output.as_os_str().to_os_string(),
                    ],
                );
                if via_hwpx.result.is_ok() {
                    return via_hwpx;
                }
            }
        }
    }

    let Some(pandoc) = find_program("pandoc") else {
        return ConverterRun {
            command: "pandoc".to_string(),
            result: Err(not_found("pandoc")),
        };
    };
    run(
        &pandoc,
        &[
            source.as_os_str().to_os_string(),
            OsString::from("--from"),
            OsString::from("markdown"),
            OsString::from("-o"),
            output.as_os_str().to_os_string(),
            OsString::from("--pdf-engine=lualatex"),
        ],
    )
}

fn run(program: &Path, args: &[OsString]) -> ConverterRun {
    let command = command_label(program, args);
    let output = Command::new(program).args(args).output();
    ConverterRun {
        command,
        result: output.and_then(check_output),
    }
}

fn check_output(output: Output) -> io::Result<()> {
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let message = stderr
        .lines()
        .chain(stdout.lines())
        .find(|line| !line.trim().is_empty())
        .unwrap_or("converter failed");
    Err(io::Error::new(
        io::ErrorKind::Other,
        format!("converter failed: {message}"),
    ))
}

fn command_label(program: &Path, args: &[OsString]) -> String {
    let mut parts = vec![program.to_string_lossy().to_string()];
    parts.extend(args.iter().map(|arg| arg.to_string_lossy().to_string()));
    parts.join(" ")
}

fn find_soffice() -> Option<PathBuf> {
    find_program("soffice").or_else(|| find_program("libreoffice"))
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

fn invalid_input(message: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

fn not_found(program: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::NotFound,
        format!("{program} is not available on PATH"),
    )
}

#[cfg(test)]
mod tests {
    use super::super::manifest::{plan_bundle, ExportFormat, ExportOutputStatus};
    use super::*;
    use tempfile::TempDir;

    fn setup_workspace() -> (TempDir, PathBuf, PathBuf) {
        let tmp = TempDir::new().unwrap();
        let source = tmp.path().join("projects/x/draft.md");
        std::fs::create_dir_all(source.parent().unwrap()).unwrap();
        std::fs::write(&source, "# Title\n\nbody\n").unwrap();
        let (manifest_path, _) = plan_bundle(
            tmp.path(),
            "projects/x/draft.md",
            &[ExportFormat::Docx],
            None,
        )
        .unwrap();
        (tmp, source, manifest_path)
    }

    #[test]
    fn dispatch_marks_requested_format_failed_when_source_changed() {
        let (tmp, source, manifest_path) = setup_workspace();
        std::fs::write(&source, "# Title\n\nedited body\n").unwrap();

        let response =
            dispatch_bundle(tmp.path(), &manifest_path, &[String::from("docx")]).unwrap();

        assert_eq!(response.results.len(), 1);
        assert!(!response.results[0].success);
        let docx = response
            .manifest
            .outputs
            .iter()
            .find(|entry| entry.format == ExportFormat::Docx)
            .unwrap();
        assert_eq!(docx.status, ExportOutputStatus::Failed);
        assert!(docx
            .reason
            .as_deref()
            .unwrap_or_default()
            .contains("source sha256 changed"));
    }

    #[test]
    fn dispatch_rejects_format_missing_from_manifest() {
        let (tmp, _source, manifest_path) = setup_workspace();
        let err = dispatch_bundle(tmp.path(), &manifest_path, &[String::from("pdf")]).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
    }
}
