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

use crate::atomic_file::{with_path_transactions, PathTransactionLease, PathTransactionRequest};
use crate::win_process::NoWindow;

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

pub fn export_dispatch(req: ExportDispatchRequest) -> Result<ExportDispatchResponse, String> {
    dispatch_bundle(
        &PathBuf::from(req.workspace_root),
        &PathBuf::from(req.manifest_path),
        &req.formats,
    )
    .map_err(|err| err.to_string())
}

/// The complete admitted write set for one dispatch: the manifest and every
/// selected output path, converted to absolute lexical form.
struct DispatchPlan {
    workspace_root: PathBuf,
    manifest_path: PathBuf,
    formats: Vec<ExportFormat>,
    output_paths: Vec<PathBuf>,
}

impl DispatchPlan {
    fn load(
        workspace_root: &Path,
        manifest_path: &Path,
        requested_formats: &[String],
    ) -> io::Result<Self> {
        let workspace_root = absolute_lexical(workspace_root);
        let manifest_path = absolute_lexical(manifest_path);
        let manifest = load_manifest(&manifest_path)?;
        let formats = select_formats(&manifest, requested_formats)?;
        let output_paths = formats
            .iter()
            .map(|format| output_path_for(&workspace_root, &manifest, *format))
            .collect::<io::Result<Vec<_>>>()?;
        Ok(Self {
            workspace_root,
            manifest_path,
            formats,
            output_paths,
        })
    }

    fn admission_paths(&self) -> Vec<PathBuf> {
        std::iter::once(self.manifest_path.clone())
            .chain(self.output_paths.iter().cloned())
            .collect()
    }
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

pub fn dispatch_bundle(
    workspace_root: &Path,
    manifest_path: &Path,
    requested_formats: &[String],
) -> io::Result<ExportDispatchResponse> {
    let plan = DispatchPlan::load(workspace_root, manifest_path, requested_formats)?;
    let request = PathTransactionRequest::new(plan.admission_paths())
        .and_then(|request| request.require_parent(&plan.workspace_root))
        .and_then(PathTransactionRequest::with_workspace_registry)
        .map_err(io::Error::other)?;
    with_path_transactions(request, |lease| {
        lease.ensure_workspace_registry()?;
        lease.ensure_covered(plan.admission_paths())?;
        lease.before_effect()?;
        dispatch_bundle_in_transaction(&plan, lease).map_err(|err| err.to_string())
    })
    .map_err(io::Error::other)
}

fn dispatch_bundle_in_transaction(
    plan: &DispatchPlan,
    lease: &PathTransactionLease,
) -> io::Result<ExportDispatchResponse> {
    let mut manifest = load_manifest(&plan.manifest_path)?;
    let source_abs = plan.workspace_root.join(&manifest.source);
    let mut results = Vec::new();

    if source_changed(&source_abs, &manifest)? {
        for (format, output_path) in plan.formats.iter().zip(&plan.output_paths) {
            let reason = "source sha256 changed; re-plan the export bundle".to_string();
            manifest = record_output_failure(&plan.manifest_path, *format, &reason)?;
            results.push(ExportDispatchResult {
                format: *format,
                output_path: output_path.to_string_lossy().to_string(),
                success: false,
                command: "preflight".to_string(),
                reason: Some(reason),
            });
        }
        let validation = validate_manifest(&plan.manifest_path)?;
        return Ok(ExportDispatchResponse {
            manifest_path: plan.manifest_path.to_string_lossy().to_string(),
            manifest,
            validation,
            results,
        });
    }

    for (format, output_path) in plan.formats.iter().zip(&plan.output_paths) {
        lease
            .ensure_covered(std::iter::once(output_path.clone()))
            .map_err(io::Error::other)?;
        manifest = record_output_pending(&plan.manifest_path, *format)?;
        if let Some(parent) = output_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let run = match format {
            ExportFormat::Docx => convert_docx(&source_abs, output_path),
            ExportFormat::Hwpx => convert_hwpx(&source_abs, output_path),
            ExportFormat::Pdf => {
                convert_pdf(&plan.workspace_root, &manifest, &source_abs, output_path)
            }
        };

        let command_label = run.command;
        match run.result {
            Ok(()) if output_path.exists() => {
                let _ = record_output_success(&plan.manifest_path, *format, output_path)?;
                results.push(ExportDispatchResult {
                    format: *format,
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
                let _ = record_output_failure(&plan.manifest_path, *format, &reason)?;
                results.push(ExportDispatchResult {
                    format: *format,
                    output_path: output_path.to_string_lossy().to_string(),
                    success: false,
                    command: command_label,
                    reason: Some(reason),
                });
            }
            Err(err) => {
                let reason = err.to_string();
                let _ = record_output_failure(&plan.manifest_path, *format, &reason)?;
                results.push(ExportDispatchResult {
                    format: *format,
                    output_path: output_path.to_string_lossy().to_string(),
                    success: false,
                    command: command_label,
                    reason: Some(reason),
                });
            }
        }
    }

    let manifest = load_manifest(&plan.manifest_path)?;
    let validation = validate_manifest(&plan.manifest_path)?;
    Ok(ExportDispatchResponse {
        manifest_path: plan.manifest_path.to_string_lossy().to_string(),
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
    let output = Command::new(program).args(args).no_window().output();
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
    Err(io::Error::other(format!("converter failed: {message}")))
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
    if let Some(path) = std::env::var_os("MARU_HWPX_BIN").map(PathBuf::from) {
        if is_executable(&path) {
            return Some(path);
        }
    }
    find_program("hwpx").or_else(|| {
        let mut candidates = Vec::new();
        if let Some(home) = dirs::home_dir() {
            candidates.push(home.join(".maru/skills/hwpx/hwpx"));
            candidates.push(home.join(".maru/skills/_builtin/skills/hwpx/hwpx"));
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

/// Owned IPC boundary; the synchronous entry point remains available to Rust callers.
pub mod ipc {
    use super::*;
    #[tauri::command]
    pub async fn export_dispatch(
        req: ExportDispatchRequest,
    ) -> Result<ExportDispatchResponse, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&req.workspace_root)],
                "worker:export_dispatch",
            );
            super::export_dispatch(req)
        })
        .await
        .map_err(|err| format!("export_dispatch_task_failed: {err}"))?
    }
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

#[cfg(test)]
mod phase08_21 {
    use super::*;
    use crate::atomic_file::phase08_06::{boundary, run, Held, Home};
    use std::sync::mpsc;
    use std::time::Duration;

    fn text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    fn plan_request(root: &Path) -> ExportDispatchRequest {
        ExportDispatchRequest {
            workspace_root: text(root),
            manifest_path: text(&root.join("draft.exports/manifest.yaml")),
            formats: Vec::new(),
        }
    }

    fn setup_workspace(home: &Home) -> PathBuf {
        let root = home.root.path().join("work");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("draft.md"), "# Title\n\nbody\n").unwrap();
        root
    }

    fn start<F, T>(future: F) -> mpsc::Receiver<T>
    where
        F: std::future::Future<Output = T> + Send + 'static,
        T: Send + 'static,
    {
        let (tx, rx) = mpsc::channel();
        tauri::async_runtime::spawn(async move {
            let _ = tx.send(future.await);
        });
        rx
    }

    fn done<T>(rx: mpsc::Receiver<T>) -> T {
        rx.recv_timeout(Duration::from_secs(10))
            .expect("export fixture completion")
    }

    #[test]
    fn phase08_21_export_dispatch_yields_same_poll_and_maps_join_failure() {
        let home = Home::new();
        let root = home.root.path();
        boundary(
            root.into(),
            "export_dispatch",
            ipc::export_dispatch(ExportDispatchRequest {
                workspace_root: text(root),
                manifest_path: text(&root.join("draft.exports/manifest.yaml")),
                formats: Vec::new(),
            }),
        );
    }

    #[test]
    fn phase08_21_export_dispatch_real_fixture_and_legacy_rejections() {
        let home = Home::new();
        let root = setup_workspace(&home);
        let planned = run(crate::export::ipc::export_plan(
            crate::export::ExportPlanRequest {
                workspace_root: text(&root),
                source_path: "draft.md".to_string(),
                formats: vec!["docx".to_string()],
                output_dir: None,
            },
        ))
        .unwrap();
        assert!(PathBuf::from(&planned.manifest_path).is_file());

        let response = run(ipc::export_dispatch(plan_request(&root))).unwrap();
        assert_eq!(response.results.len(), 1);
        assert_eq!(response.results[0].format, ExportFormat::Docx);
        let docx = response
            .manifest
            .outputs
            .iter()
            .find(|entry| entry.format == ExportFormat::Docx)
            .unwrap();
        assert_ne!(
            docx.status,
            super::super::manifest::ExportOutputStatus::Planned
        );

        // Source edit triggers the deterministic preflight failure path.
        std::fs::write(root.join("draft.md"), "# Title\n\nedited\n").unwrap();
        let response = run(ipc::export_dispatch(plan_request(&root))).unwrap();
        assert_eq!(response.results.len(), 1);
        assert!(!response.results[0].success);
        assert!(response.results[0]
            .reason
            .as_deref()
            .unwrap_or_default()
            .contains("source sha256 changed"));

        let err = run(ipc::export_dispatch(ExportDispatchRequest {
            workspace_root: text(&root),
            manifest_path: text(&root.join("draft.exports/manifest.yaml")),
            formats: vec!["md".to_string()],
        }))
        .unwrap_err();
        assert!(err.contains("unsupported format: md"), "{err}");

        let err = run(ipc::export_dispatch(ExportDispatchRequest {
            workspace_root: text(&root),
            manifest_path: text(&root.join("draft.exports/manifest.yaml")),
            formats: vec!["pdf".to_string()],
        }))
        .unwrap_err();
        assert!(
            err.contains("manifest has no entry for format Pdf"),
            "{err}"
        );
    }

    #[test]
    fn phase08_21_export_plan_dispatch_serialize_manifest_both_orders() {
        let home = Home::new();
        for plan_first in [false, true] {
            let root = setup_workspace(&home);
            run(crate::export::ipc::export_plan(
                crate::export::ExportPlanRequest {
                    workspace_root: text(&root),
                    source_path: "draft.md".to_string(),
                    formats: vec!["docx".to_string()],
                    output_dir: None,
                },
            ))
            .unwrap();
            let manifest = root.join("draft.exports/manifest.yaml");
            if plan_first {
                let held = Held::new(manifest.clone(), "admitted");
                let first = start(crate::export::ipc::export_plan(
                    crate::export::ExportPlanRequest {
                        workspace_root: text(&root),
                        source_path: "draft.md".to_string(),
                        formats: vec!["docx".to_string()],
                        output_dir: None,
                    },
                ));
                held.wait();
                let waiting = Held::new(manifest.clone(), "before-admission");
                let second = start(ipc::export_dispatch(plan_request(&root)));
                waiting.wait();
                waiting.release();
                assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
                held.release();
                done(first).unwrap();
                done(second).unwrap();
                // Dispatch ran last: the entry left the planned state.
                let docx = load_manifest(&manifest)
                    .unwrap()
                    .outputs
                    .into_iter()
                    .find(|entry| entry.format == ExportFormat::Docx)
                    .unwrap();
                assert_ne!(
                    docx.status,
                    super::super::manifest::ExportOutputStatus::Planned
                );
            } else {
                let held = Held::new(manifest.clone(), "admitted");
                let first = start(ipc::export_dispatch(plan_request(&root)));
                held.wait();
                let waiting = Held::new(manifest.clone(), "before-admission");
                let second = start(crate::export::ipc::export_plan(
                    crate::export::ExportPlanRequest {
                        workspace_root: text(&root),
                        source_path: "draft.md".to_string(),
                        formats: vec!["docx".to_string()],
                        output_dir: None,
                    },
                ));
                waiting.wait();
                waiting.release();
                assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
                held.release();
                done(first).unwrap();
                done(second).unwrap();
                // The re-plan ran last and restored the planned baseline.
                let docx = load_manifest(&manifest)
                    .unwrap()
                    .outputs
                    .into_iter()
                    .find(|entry| entry.format == ExportFormat::Docx)
                    .unwrap();
                assert_eq!(
                    docx.status,
                    super::super::manifest::ExportOutputStatus::Planned
                );
            }
        }
    }
}
