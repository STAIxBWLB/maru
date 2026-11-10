//! Maru's host adapter for the standalone diagram plugin.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Runtime};
use tauri_plugin_maru_diagram::{
    Builder, DiagramHost, DiagramSources, HostError, RenderDocumentContext, RenderGroup,
    RenderStoreHost, RenderView, SourceError, SourceKind, SourceQuery, SourceSnapshot, StoredRender,
    WriteAction,
};

#[derive(Clone)]
struct EngineHost<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> DiagramHost for EngineHost<R> {
    fn workspace_root(&self) -> Result<PathBuf, HostError> {
        Err(HostError::new(
            "workspace_argument_required",
            "diagram render operations require the caller-selected workspace identity",
            "resend the operation with its workspace argument",
        ))
    }

    fn ensure_write(&self, _relative_path: &Path, _action: WriteAction) -> Result<(), HostError> {
        Err(HostError::new(
            "workspace_argument_required",
            "diagram writes require the caller-selected workspace identity",
            "use the render-store host operation with its workspace argument",
        ))
    }
}

impl<R: Runtime> RenderStoreHost for EngineHost<R> {
    fn list_renders(&self, workspace: &str) -> Result<Vec<RenderGroup>, HostError> {
        crate::diagram::renders::list_renders(workspace).map_err(|error| {
            HostError::new(
                "diagram_render_list_failed",
                error,
                "refresh the render list and retry",
            )
        })
    }

    fn prepare_render_view(
        &self,
        workspace: &str,
        doc_id: &str,
        render_id: &str,
    ) -> Result<RenderView, HostError> {
        crate::diagram::renders::prepare_render_view(&self.app, workspace, doc_id, render_id)
            .map_err(|error| {
                HostError::new(
                    "diagram_render_view_refused",
                    error,
                    "refresh the render list and retry opening the render",
                )
            })
    }

    fn delete_render(
        &self,
        workspace: &str,
        doc_id: &str,
        render_id: &str,
    ) -> Result<(), HostError> {
        crate::diagram::renders::delete_render(workspace, doc_id, render_id).map_err(|error| {
            HostError::new(
                "diagram_render_delete_refused",
                error,
                "refresh the render list and retry deletion",
            )
        })
    }

    fn store_engine_render(
        &self,
        workspace: &str,
        context: RenderDocumentContext,
        source_request_json: &str,
        report: maru_diagram_engine::render::ArtifactReport,
    ) -> Result<StoredRender, HostError> {
        crate::diagram::renders::store_engine_render(
            workspace,
            context,
            source_request_json,
            report,
        )
        .map_err(|error| {
            HostError::new(
                "diagram_render_store_refused",
                error,
                "repair the render destination or refresh the source and retry",
            )
        })
    }
}

struct UnavailableSources;

impl UnavailableSources {
    fn unavailable(kind: SourceKind) -> SourceError {
        SourceError::new(
            "diagram_source_unavailable",
            format!("{kind:?} is not connected to the native render host"),
            "select an available source provider and retry",
        )
    }
}

impl DiagramSources for UnavailableSources {
    fn document_relations(&self, _query: &SourceQuery) -> Result<SourceSnapshot, SourceError> {
        Err(Self::unavailable(SourceKind::DocumentRelations))
    }

    fn workspace_structure(&self, _query: &SourceQuery) -> Result<SourceSnapshot, SourceError> {
        Err(Self::unavailable(SourceKind::WorkspaceStructure))
    }

    fn vault_concepts(&self, _query: &SourceQuery) -> Result<SourceSnapshot, SourceError> {
        Err(Self::unavailable(SourceKind::VaultConcepts))
    }
}

/// Build the production plugin with host services bound to this app handle.
/// Workspace identifiers remain per-invocation arguments; no global active
/// workspace is captured here.
pub fn plugin<R: Runtime>(app: AppHandle<R>) -> tauri::plugin::TauriPlugin<R> {
    let host = Arc::new(EngineHost { app });
    Builder::new(host.clone(), Arc::new(UnavailableSources))
        .with_render_store(host)
        .build()
}
