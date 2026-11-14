//! Standalone Tauri 2 adapter for `maru-diagram-engine`.
//!
//! The plugin owns no Maru paths or data. Host integrations are passed through
//! stable traits so this crate can be split from the application unchanged.

use maru_diagram_engine::{Diagnostic, ValidationReport};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{plugin::TauriPlugin, Manager, Runtime};

pub mod scan;
pub use scan::{ScanReport, ScanStats};

#[cfg(feature = "render-store")]
pub mod render_store;
#[cfg(feature = "render-store")]
pub use render_store::{
    DiagramRenderReceipt, LegacyArchifyEnginePin, LegacyArchifyReceipt, RenderAndStoreReport,
    RenderDocumentContext, RenderEntry, RenderGate, RenderGates, RenderGroup, RenderStoreHost,
    RenderView, StoredRender, StoredRenderReceipt,
};

pub const PLUGIN_NAME: &str = "maru-diagram";
pub const API_VERSION: u32 = 1;
pub const MAX_SOURCE_DEPTH: u8 = 16;
pub const MAX_SOURCE_NODES: usize = 5_000;
pub const DEFAULT_SOURCE_DEPTH: u8 = 2;
pub const DEFAULT_SOURCE_NODES: usize = 250;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WriteAction {
    Create,
    Modify,
    Delete,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostError {
    pub code: String,
    pub message: String,
    pub next_step: String,
}

/// Structured command failure returned across the plugin IPC boundary.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IpcError {
    pub code: String,
    pub message: String,
    pub next_step: String,
    pub diagnostics: Vec<Diagnostic>,
}

#[cfg(any(feature = "png", feature = "outline", feature = "render-store"))]
impl IpcError {
    fn new(
        code: impl Into<String>,
        message: impl Into<String>,
        next_step: impl Into<String>,
        diagnostics: Vec<Diagnostic>,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            next_step: next_step.into(),
            diagnostics,
        }
    }

    fn from_diagnostics(diagnostics: Vec<Diagnostic>) -> Self {
        let first = diagnostics.first().cloned();
        if let Some(first) = first {
            Self::new(first.code, first.message, first.fix, diagnostics)
        } else {
            Self::new(
                "diagram_export_refused",
                "the pinned diagram engine refused the PNG export without a diagnostic",
                "retry the export; if it repeats, report the failed engine receipt",
                diagnostics,
            )
        }
    }
}

impl HostError {
    pub fn new(
        code: impl Into<String>,
        message: impl Into<String>,
        next_step: impl Into<String>,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            next_step: next_step.into(),
        }
    }
}

/// Services owned by the host application. The engine and plugin never
/// discover workspace paths or write permissions themselves.
pub trait DiagramHost: Send + Sync + 'static {
    /// Return the host-selected workspace root; callers never supply it to
    /// engine validation or source queries.
    fn workspace_root(&self) -> Result<PathBuf, HostError>;
    /// Authorize one workspace-relative write before a future store command.
    fn ensure_write(&self, relative_path: &Path, action: WriteAction) -> Result<(), HostError>;
    /// Resolve the caller-named workspace to the root a read-only repository
    /// scan may read. The host decides which workspaces are open; the scanner
    /// reads nothing outside the returned root. The default refuses, so a host
    /// without scan support never exposes the filesystem.
    fn scan_root(&self, workspace: &str) -> Result<PathBuf, HostError> {
        let _ = workspace;
        Err(HostError::new(
            "diagram_scan_unavailable",
            "this host does not provide repository scans",
            "open the workspace in the Maru desktop app and scan again",
        ))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceQuery {
    #[serde(default)]
    pub anchor: Option<String>,
    pub max_depth: u8,
    pub max_nodes: usize,
}

impl Default for SourceQuery {
    fn default() -> Self {
        Self {
            anchor: None,
            max_depth: DEFAULT_SOURCE_DEPTH,
            max_nodes: DEFAULT_SOURCE_NODES,
        }
    }
}

impl SourceQuery {
    pub fn new(
        anchor: Option<String>,
        max_depth: u8,
        max_nodes: usize,
    ) -> Result<Self, SourceError> {
        let query = Self {
            anchor,
            max_depth,
            max_nodes,
        };
        query.validate()?;
        Ok(query)
    }

    pub fn validate(&self) -> Result<(), SourceError> {
        if self.max_depth > MAX_SOURCE_DEPTH {
            return Err(SourceError::new(
                "diagram_source_depth_invalid",
                format!(
                    "maxDepth {} exceeds the bound {MAX_SOURCE_DEPTH}",
                    self.max_depth
                ),
                "use a shallower source query and retry",
            ));
        }
        if self.max_nodes == 0 || self.max_nodes > MAX_SOURCE_NODES {
            return Err(SourceError::new(
                "diagram_source_node_limit_invalid",
                format!("maxNodes must be between 1 and {MAX_SOURCE_NODES}"),
                "use a bounded maxNodes value and retry",
            ));
        }
        if self.anchor.as_ref().is_some_and(|anchor| {
            anchor.is_empty() || anchor.len() > 512 || anchor.chars().any(char::is_control)
        }) {
            return Err(SourceError::new(
                "diagram_source_anchor_invalid",
                "anchor is empty, too long, or contains control characters",
                "select a valid source anchor and retry",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum SourceKind {
    DocumentRelations,
    WorkspaceStructure,
    VaultConcepts,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceProvenance {
    pub source_kind: SourceKind,
    pub source_id: String,
    pub revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceNode {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub properties: BTreeMap<String, Value>,
    pub provenance: SourceProvenance,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceRelation {
    pub id: String,
    pub from: String,
    pub to: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub properties: BTreeMap<String, Value>,
    pub provenance: SourceProvenance,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceSnapshot {
    pub source_kind: SourceKind,
    pub revision: String,
    pub nodes: Vec<SourceNode>,
    pub relations: Vec<SourceRelation>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceError {
    pub code: String,
    pub message: String,
    pub next_step: String,
}

impl SourceError {
    pub fn new(
        code: impl Into<String>,
        message: impl Into<String>,
        next_step: impl Into<String>,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            next_step: next_step.into(),
        }
    }
}

/// Read-only source adapters for derived diagram phases. Implementations must
/// respect the query bounds and preserve provenance for every returned fact.
pub trait DiagramSources: Send + Sync + 'static {
    /// Document relation IDs and targets (for example links or entity refs).
    fn document_relations(&self, query: &SourceQuery) -> Result<SourceSnapshot, SourceError>;
    /// Workspace folder/project/task structure, with stable source IDs.
    fn workspace_structure(&self, query: &SourceQuery) -> Result<SourceSnapshot, SourceError>;
    /// Vault concepts, maps, or groups, with stable source IDs.
    fn vault_concepts(&self, query: &SourceQuery) -> Result<SourceSnapshot, SourceError>;
}

/// Synthetic source adapter for tests and contract examples only. It contains
/// no user or workspace data.
#[derive(Debug, Clone, Default)]
pub struct FixtureSources;

impl FixtureSources {
    fn snapshot(kind: SourceKind, query: &SourceQuery) -> Result<SourceSnapshot, SourceError> {
        query.validate()?;
        let provenance = |source_id: &str| SourceProvenance {
            source_kind: kind,
            source_id: source_id.to_string(),
            revision: "fixture-v1".into(),
        };
        let all_nodes = vec![
            SourceNode {
                id: "fixture-alpha".into(),
                label: "Fixture Alpha".into(),
                kind: "document".into(),
                properties: BTreeMap::from([("fixture".into(), Value::Bool(true))]),
                provenance: provenance("fixture-alpha"),
            },
            SourceNode {
                id: "fixture-beta".into(),
                label: "Fixture Beta".into(),
                kind: "document".into(),
                properties: BTreeMap::from([("fixture".into(), Value::Bool(true))]),
                provenance: provenance("fixture-beta"),
            },
        ];
        let selected_nodes: Vec<_> = if let Some(anchor) = query.anchor.as_deref() {
            all_nodes
                .into_iter()
                .filter(|node| node.id == anchor)
                .collect()
        } else {
            all_nodes
        };
        let truncated = selected_nodes.len() > query.max_nodes;
        let nodes: Vec<_> = selected_nodes.into_iter().take(query.max_nodes).collect();
        let relations = if nodes.len() >= 2 && query.max_depth > 0 {
            vec![SourceRelation {
                id: "fixture-alpha-to-beta".into(),
                from: "fixture-alpha".into(),
                to: "fixture-beta".into(),
                kind: match kind {
                    SourceKind::DocumentRelations => "links-to",
                    SourceKind::WorkspaceStructure => "contains",
                    SourceKind::VaultConcepts => "related-to",
                }
                .into(),
                label: None,
                properties: BTreeMap::new(),
                provenance: provenance("fixture-alpha-to-beta"),
            }]
        } else {
            Vec::new()
        };
        Ok(SourceSnapshot {
            source_kind: kind,
            revision: "fixture-v1".into(),
            nodes,
            relations,
            truncated,
        })
    }
}

impl DiagramSources for FixtureSources {
    fn document_relations(&self, query: &SourceQuery) -> Result<SourceSnapshot, SourceError> {
        Self::snapshot(SourceKind::DocumentRelations, query)
    }

    fn workspace_structure(&self, query: &SourceQuery) -> Result<SourceSnapshot, SourceError> {
        Self::snapshot(SourceKind::WorkspaceStructure, query)
    }

    fn vault_concepts(&self, query: &SourceQuery) -> Result<SourceSnapshot, SourceError> {
        Self::snapshot(SourceKind::VaultConcepts, query)
    }
}

#[derive(Clone)]
pub struct PluginState {
    pub host: Arc<dyn DiagramHost>,
    pub sources: Arc<dyn DiagramSources>,
    #[cfg(feature = "render-store")]
    render_store: Option<Arc<dyn RenderStoreHost>>,
    #[cfg(any(feature = "png", feature = "outline", feature = "render-store"))]
    rendering: Arc<std::sync::atomic::AtomicBool>,
    #[cfg(all(any(feature = "png", feature = "outline"), test))]
    worker_thread: Arc<std::sync::Mutex<Option<std::thread::ThreadId>>>,
}

pub struct Builder {
    host: Arc<dyn DiagramHost>,
    sources: Arc<dyn DiagramSources>,
    #[cfg(feature = "render-store")]
    render_store: Option<Arc<dyn RenderStoreHost>>,
}

impl Builder {
    pub fn new(host: Arc<dyn DiagramHost>, sources: Arc<dyn DiagramSources>) -> Self {
        Self {
            host,
            sources,
            #[cfg(feature = "render-store")]
            render_store: None,
        }
    }

    #[cfg(feature = "render-store")]
    pub fn with_render_store(mut self, render_store: Arc<dyn RenderStoreHost>) -> Self {
        self.render_store = Some(render_store);
        self
    }

    pub fn build<R: Runtime>(self) -> TauriPlugin<R> {
        let state = PluginState {
            host: self.host,
            sources: self.sources,
            #[cfg(feature = "render-store")]
            render_store: self.render_store,
            #[cfg(any(feature = "png", feature = "outline", feature = "render-store"))]
            rendering: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            #[cfg(all(any(feature = "png", feature = "outline"), test))]
            worker_thread: Arc::new(std::sync::Mutex::new(None)),
        };
        let builder = tauri::plugin::Builder::new(PLUGIN_NAME);
        #[cfg(all(feature = "png", feature = "outline", feature = "render-store"))]
        let builder = builder.invoke_handler(tauri::generate_handler![
            commands::validate,
            commands::scan_repository,
            commands::render_png,
            commands::render_svg,
            commands::diagram_list_renders,
            commands::diagram_prepare_render_view,
            commands::diagram_delete_render,
            commands::render_and_store
        ]);
        #[cfg(all(feature = "png", feature = "outline", not(feature = "render-store")))]
        let builder = builder.invoke_handler(tauri::generate_handler![
            commands::validate,
            commands::scan_repository,
            commands::render_png,
            commands::render_svg
        ]);
        #[cfg(all(feature = "png", not(feature = "outline"), feature = "render-store"))]
        let builder = builder.invoke_handler(tauri::generate_handler![
            commands::validate,
            commands::scan_repository,
            commands::render_png,
            commands::diagram_list_renders,
            commands::diagram_prepare_render_view,
            commands::diagram_delete_render,
            commands::render_and_store
        ]);
        #[cfg(all(
            feature = "png",
            not(feature = "outline"),
            not(feature = "render-store")
        ))]
        let builder = builder.invoke_handler(tauri::generate_handler![
            commands::validate,
            commands::scan_repository,
            commands::render_png
        ]);
        #[cfg(all(not(feature = "png"), feature = "outline", feature = "render-store"))]
        let builder = builder.invoke_handler(tauri::generate_handler![
            commands::validate,
            commands::scan_repository,
            commands::render_svg,
            commands::diagram_list_renders,
            commands::diagram_prepare_render_view,
            commands::diagram_delete_render,
            commands::render_and_store
        ]);
        #[cfg(all(
            not(feature = "png"),
            feature = "outline",
            not(feature = "render-store")
        ))]
        let builder = builder.invoke_handler(tauri::generate_handler![
            commands::validate,
            commands::scan_repository,
            commands::render_svg
        ]);
        #[cfg(all(
            not(feature = "png"),
            not(feature = "outline"),
            feature = "render-store"
        ))]
        let builder = builder.invoke_handler(tauri::generate_handler![
            commands::validate,
            commands::scan_repository,
            commands::diagram_list_renders,
            commands::diagram_prepare_render_view,
            commands::diagram_delete_render,
            commands::render_and_store
        ]);
        #[cfg(all(
            not(feature = "png"),
            not(feature = "outline"),
            not(feature = "render-store")
        ))]
        let builder = builder.invoke_handler(tauri::generate_handler![
            commands::validate,
            commands::scan_repository
        ]);
        builder
            .setup(move |app, _api| {
                app.manage(state.clone());
                Ok(())
            })
            .build()
    }
}

pub fn init<R: Runtime>(
    host: Arc<dyn DiagramHost>,
    sources: Arc<dyn DiagramSources>,
) -> TauriPlugin<R> {
    Builder::new(host, sources).build()
}

#[cfg(any(feature = "png", feature = "outline", feature = "render-store"))]
struct RenderPermit(Arc<std::sync::atomic::AtomicBool>);

#[cfg(any(feature = "png", feature = "outline", feature = "render-store"))]
impl Drop for RenderPermit {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::Release);
    }
}

#[cfg(any(feature = "png", feature = "outline", feature = "render-store"))]
fn acquire_render_permit(
    flag: &Arc<std::sync::atomic::AtomicBool>,
) -> Result<RenderPermit, IpcError> {
    if flag
        .compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::AcqRel,
            std::sync::atomic::Ordering::Acquire,
        )
        .is_err()
    {
        return Err(IpcError::new(
            "diagram_export_busy",
            "a diagram render is already running",
            "wait for the current render to finish and retry",
            Vec::new(),
        ));
    }
    Ok(RenderPermit(Arc::clone(flag)))
}

mod commands {
    use super::*;

    #[cfg(feature = "render-store")]
    fn store_host(state: &PluginState) -> Result<Arc<dyn RenderStoreHost>, IpcError> {
        state.render_store.clone().ok_or_else(|| {
            IpcError::new(
                "diagram_render_store_unavailable",
                "the host has not configured diagram render storage",
                "reopen the workspace in Maru; update the app if storage remains unavailable",
                Vec::new(),
            )
        })
    }

    #[cfg(feature = "render-store")]
    fn map_host_error(error: HostError) -> IpcError {
        IpcError::new(error.code, error.message, error.next_step, Vec::new())
    }

    #[cfg(feature = "render-store")]
    #[tauri::command]
    pub async fn diagram_list_renders(
        state: tauri::State<'_, PluginState>,
        workspace: String,
    ) -> Result<Vec<RenderGroup>, IpcError> {
        let host = store_host(&state)?;
        tauri::async_runtime::spawn_blocking(move || {
            host.list_renders(&workspace).map_err(map_host_error)
        })
        .await
        .map_err(|cause| {
            IpcError::new(
                "diagram_list_renders_worker_failed",
                format!("render listing worker failed: {cause}"),
                "refresh the render list; if it repeats, restart Maru and retry",
                Vec::new(),
            )
        })?
    }

    #[cfg(feature = "render-store")]
    #[tauri::command]
    pub async fn diagram_prepare_render_view(
        state: tauri::State<'_, PluginState>,
        workspace: String,
        doc_id: String,
        render_id: String,
    ) -> Result<RenderView, IpcError> {
        let host = store_host(&state)?;
        tauri::async_runtime::spawn_blocking(move || {
            host.prepare_render_view(&workspace, &doc_id, &render_id)
                .map_err(map_host_error)
        })
        .await
        .map_err(|cause| {
            IpcError::new(
                "diagram_prepare_render_view_worker_failed",
                format!("render verification worker failed: {cause}"),
                "refresh the render and retry",
                Vec::new(),
            )
        })?
    }

    #[cfg(feature = "render-store")]
    #[tauri::command]
    pub async fn diagram_delete_render(
        state: tauri::State<'_, PluginState>,
        workspace: String,
        doc_id: String,
        render_id: String,
    ) -> Result<(), IpcError> {
        let host = store_host(&state)?;
        tauri::async_runtime::spawn_blocking(move || {
            host.delete_render(&workspace, &doc_id, &render_id)
                .map_err(map_host_error)
        })
        .await
        .map_err(|cause| {
            IpcError::new(
                "diagram_delete_render_worker_failed",
                format!("render deletion worker failed: {cause}"),
                "refresh the render list and retry",
                Vec::new(),
            )
        })?
    }

    #[cfg(feature = "render-store")]
    #[tauri::command]
    pub async fn render_and_store(
        state: tauri::State<'_, PluginState>,
        workspace: String,
        input: String,
        context: Option<RenderDocumentContext>,
    ) -> Result<RenderAndStoreReport, IpcError> {
        if input.len() > maru_diagram_engine::render::MAX_SVG_BYTES {
            let diagnostic = Diagnostic {
                code: "diagram_export_size_invalid".into(),
                path: "/".into(),
                rule: "render-v1/request-size".into(),
                message: "render request exceeds 16 MiB".into(),
                fix: "reduce the source scene and retry".into(),
            };
            return Err(IpcError::from_diagnostics(vec![diagnostic]));
        }
        let permit = acquire_render_permit(&state.rendering)?;
        let host = state.render_store.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _permit = permit;
            let worker_input = render_store::prepare_render_store_request(&input)?;
            let source_request_json = worker_input.clone();
            let report = maru_diagram_engine::render::render_artifact_json(&worker_input);
            if !report.ok {
                return Err(IpcError::from_diagnostics(report.diagnostics));
            }
            let store_warning = if let Some(context) = context {
                match host {
                    Some(host) => host
                        .store_engine_render(&workspace, context, &source_request_json, report.clone())
                        .err()
                        .map(|error| format!("Render was generated but not saved: {}; next step: {}", error.message, error.next_step)),
                    None => Some("Render was generated but not saved: host storage is unavailable; next step: reopen Maru with the workspace render-store adapter enabled".into()),
                }
            } else {
                None
            };
            Ok(RenderAndStoreReport {
                report,
                store_warning,
            })
        })
        .await
        .map_err(|cause| {
            IpcError::new(
                "diagram_render_store_worker_failed",
                format!("render-and-store worker failed: {cause}"),
                "retry the export; if it repeats, restart Maru and retry",
                Vec::new(),
            )
        })?
    }
    #[cfg(feature = "png")]
    #[tauri::command]
    pub async fn render_png(
        state: tauri::State<'_, PluginState>,
        input: String,
    ) -> Result<maru_diagram_engine::render::ArtifactReport, IpcError> {
        if input.len() > maru_diagram_engine::render::MAX_SVG_BYTES {
            let diagnostic = Diagnostic {
                code: "diagram_export_size_invalid".into(),
                path: "/".into(),
                rule: "render-v1/request-size".into(),
                message: "PNG request exceeds 16 MiB".into(),
                fix: "reduce the source scene and retry".into(),
            };
            return Err(IpcError::new(
                diagnostic.code.clone(),
                diagnostic.message.clone(),
                diagnostic.fix.clone(),
                vec![diagnostic],
            ));
        }
        let permit = acquire_render_permit(&state.rendering)?;
        #[cfg(test)]
        let trace = Arc::clone(&state.worker_thread);
        let report = tauri::async_runtime::spawn_blocking(move || {
            let _permit = permit;
            #[cfg(test)]
            {
                *trace.lock().expect("test worker trace mutex") = Some(std::thread::current().id());
            }
            maru_diagram_engine::render::render_png_artifact_json(&input)
        })
        .await
        .map_err(|cause| {
            IpcError::new(
                "diagram_export_worker_failed",
                format!("PNG worker failed: {cause}"),
                "retry the export; if it repeats, update Maru and report the failure",
                Vec::new(),
            )
        })?;
        if !report.ok {
            return Err(IpcError::from_diagnostics(report.diagnostics));
        }
        Ok(report)
    }
    #[cfg(feature = "outline")]
    #[tauri::command]
    pub async fn render_svg(
        state: tauri::State<'_, PluginState>,
        input: String,
    ) -> Result<maru_diagram_engine::render::ArtifactReport, IpcError> {
        if input.len() > maru_diagram_engine::render::MAX_SVG_BYTES {
            let diagnostic = Diagnostic {
                code: "diagram_export_size_invalid".into(),
                path: "/".into(),
                rule: "render-v1/request-size".into(),
                message: "SVG request exceeds 16 MiB".into(),
                fix: "reduce the source scene and retry".into(),
            };
            return Err(IpcError::new(
                diagnostic.code.clone(),
                diagnostic.message.clone(),
                diagnostic.fix.clone(),
                vec![diagnostic],
            ));
        }
        let flag = Arc::clone(&state.rendering);
        if flag
            .compare_exchange(
                false,
                true,
                std::sync::atomic::Ordering::AcqRel,
                std::sync::atomic::Ordering::Acquire,
            )
            .is_err()
        {
            return Err(IpcError::new(
                "diagram_export_busy",
                "another diagram export is already running",
                "wait for that export to finish and retry",
                Vec::new(),
            ));
        }
        let permit = RenderPermit(flag);
        #[cfg(test)]
        let trace = Arc::clone(&state.worker_thread);
        let report = tauri::async_runtime::spawn_blocking(move || {
            let _permit = permit;
            #[cfg(test)]
            {
                *trace.lock().expect("test worker trace mutex") = Some(std::thread::current().id());
            }
            maru_diagram_engine::render::render_svg_artifact_json(&input)
        })
        .await
        .map_err(|cause| {
            IpcError::new(
                "diagram_export_worker_failed",
                format!("SVG worker failed: {cause}"),
                "retry the export; if it repeats, update Maru and report the failure",
                Vec::new(),
            )
        })?;
        if !report.ok {
            return Err(IpcError::from_diagnostics(report.diagnostics));
        }
        Ok(report)
    }
    /// Propose a floorplan map from a folder inside the caller-named
    /// workspace. Read-only: nothing is written, no process runs and no
    /// network is used; the host resolves the only root the scan may read.
    #[tauri::command]
    pub async fn scan_repository(
        state: tauri::State<'_, PluginState>,
        workspace: String,
        path: String,
        max_files: Option<usize>,
        max_depth: Option<u8>,
    ) -> Result<ScanReport, IpcError> {
        let host = Arc::clone(&state.host);
        tauri::async_runtime::spawn_blocking(move || {
            let limits = scan::ScanLimits::new(max_files, max_depth).map_err(scan_error)?;
            let root = host.scan_root(&workspace).map_err(|error| IpcError {
                code: error.code,
                message: error.message,
                next_step: error.next_step,
                diagnostics: Vec::new(),
            })?;
            scan::scan(&root, &path, limits).map_err(scan_error)
        })
        .await
        .map_err(|cause| IpcError {
            code: "diagram_scan_worker_failed".into(),
            message: format!("repository scan worker failed: {cause}"),
            next_step: "scan again; if it repeats, restart Maru".into(),
            diagnostics: Vec::new(),
        })?
    }

    fn scan_error(error: scan::ScanError) -> IpcError {
        IpcError {
            code: error.code,
            message: error.message,
            next_step: error.next_step,
            diagnostics: Vec::new(),
        }
    }

    #[tauri::command]
    pub async fn validate(
        _state: tauri::State<'_, PluginState>,
        input: String,
    ) -> Result<ValidationReport, String> {
        tauri::async_runtime::spawn_blocking(move || Ok(maru_diagram_engine::validate_json(&input)))
            .await
            .map_err(|error| {
                format!("diagram_validate_task_failed: {error}; retry validation in Maru")
            })?
    }
}

#[cfg(all(test, feature = "render-store"))]
#[path = "render_store_tests.rs"]
mod render_store_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{get_ipc_response, INVOKE_KEY};
    use tauri::webview::InvokeRequest;
    use tauri::{Manager, WebviewWindowBuilder};

    #[derive(Clone)]
    struct FixtureHost {
        root: PathBuf,
    }

    impl DiagramHost for FixtureHost {
        fn workspace_root(&self) -> Result<PathBuf, HostError> {
            Ok(self.root.clone())
        }

        fn ensure_write(
            &self,
            relative_path: &Path,
            _action: WriteAction,
        ) -> Result<(), HostError> {
            if relative_path.is_absolute()
                || relative_path
                    .components()
                    .any(|part| part == std::path::Component::ParentDir)
            {
                return Err(HostError::new(
                    "fixture_path_refused",
                    "fixture host only accepts workspace-relative paths",
                    "use a relative test path",
                ));
            }
            Ok(())
        }
    }

    #[test]
    fn mock_runtime_plugin_installs_state_and_one_validation_command() {
        let host = Arc::new(FixtureHost {
            root: PathBuf::from("/fixture/workspace"),
        });
        let sources = Arc::new(FixtureSources);
        let plugin =
            Builder::new(host.clone(), sources.clone()).build::<tauri::test::MockRuntime>();
        let app = tauri::test::mock_builder()
            .plugin(plugin)
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock runtime plugin should build without a real workspace");
        let state = app.state::<PluginState>();
        assert_eq!(state.host.workspace_root().unwrap(), host.root);
        assert_eq!(
            state
                .sources
                .document_relations(&SourceQuery::default())
                .unwrap()
                .nodes
                .len(),
            2
        );
    }

    #[test]
    fn source_query_rejects_unbounded_limits() {
        assert!(SourceQuery::new(None, MAX_SOURCE_DEPTH + 1, 1).is_err());
        assert!(SourceQuery::new(None, 0, MAX_SOURCE_NODES + 1).is_err());
        assert!(SourceQuery::new(Some("bad\nanchor".into()), 1, 10).is_err());
    }

    #[test]
    fn mock_runtime_invokes_the_registered_validation_command() {
        let host = Arc::new(FixtureHost {
            root: PathBuf::from("/fixture/workspace"),
        });
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.runtime_authority_mut().__allow_command(
            "plugin:maru-diagram|validate".into(),
            tauri::utils::acl::ExecutionContext::Local,
        );
        let app = tauri::test::mock_builder()
            .plugin(
                Builder::new(host, Arc::new(FixtureSources)).build::<tauri::test::MockRuntime>(),
            )
            .build(context)
            .expect("mock runtime plugin should build");
        let view = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview should build");
        let inputs = [
            r#"{"schema_version":1,"diagram_type":"architecture","meta":{"title":"A","output":"a.html"},"components":[{"id":"a","type":"backend","label":"A","pos":[50,160]}]}"#,
            r#"{"schema_version":1,"diagram_type":"workflow","meta":{"title":"W","output":"w.html"},"lanes":[{"id":"main","label":"Main"}],"nodes":[{"id":"a","lane":"main","col":0,"type":"backend","label":"A"}],"edges":[]}"#,
            r#"{"schema_version":1,"diagram_type":"sequence","meta":{"title":"S","output":"s.html"},"participants":[{"id":"a","type":"frontend","label":"A"},{"id":"b","type":"backend","label":"B"}],"messages":[{"from":"a","to":"b","y":180,"label":"Call"}]}"#,
            r#"{"schema_version":1,"diagram_type":"dataflow","meta":{"title":"D","output":"d.html"},"stages":[{"label":"Input"},{"label":"Output"}],"nodes":[{"id":"a","type":"frontend","label":"A","stage":0,"row":0},{"id":"b","type":"backend","label":"B","stage":1,"row":0}],"flows":[{"from":"a","to":"b","label":"Data"}]}"#,
            r#"{"schema_version":1,"diagram_type":"lifecycle","meta":{"title":"L","output":"l.html"},"lanes":[{"id":"main","label":"Main"}],"states":[{"id":"a","type":"start","label":"A","lane":"main","col":0},{"id":"b","type":"success","label":"B","lane":"main","col":1}],"transitions":[{"from":"a","to":"b"}]}"#,
        ];
        for input in inputs {
            let request = InvokeRequest {
                cmd: "plugin:maru-diagram|validate".into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: view.url().unwrap(),
                body: InvokeBody::Json(serde_json::json!({
                    "input": input
                })),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.into(),
            };
            let response = get_ipc_response(&view, request)
                .expect("registered validation command should respond")
                .deserialize::<ValidationReport>()
                .expect("validation response should have the public report shape");
            assert!(response.ok, "{:?}", response.diagnostics);
            assert_eq!(response.api_version, API_VERSION);
            assert_eq!(response.receipt.engine.id, maru_diagram_engine::ENGINE_ID);
            let kind: serde_json::Value = serde_json::from_str(input).unwrap();
            assert_eq!(
                response.receipt.diagram_type.as_deref(),
                kind["diagram_type"].as_str()
            );
        }
    }
}

#[cfg(all(test, feature = "png"))]
mod png_tests;
