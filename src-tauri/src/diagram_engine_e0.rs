//! Default-off measurement integration. No product apply/render path uses this plugin.
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::Manager;
use tauri_plugin_maru_diagram::{DiagramHost, HostError, WriteAction};

struct Host;
impl DiagramHost for Host {
    fn workspace_root(&self) -> Result<PathBuf, HostError> {
        let registry = crate::vault_list::load_registry().map_err(|error| {
            HostError::new(
                "workspace_lookup_failed",
                error,
                "select a workspace and retry",
            )
        })?;
        registry
            .active_by_visibility
            .private
            .or(registry.active_by_visibility.public)
            .map(PathBuf::from)
            .ok_or_else(|| {
                HostError::new(
                    "workspace_unavailable",
                    "no workspace is selected",
                    "select a workspace and retry",
                )
            })
    }
    fn ensure_write(&self, relative: &Path, action: WriteAction) -> Result<(), HostError> {
        let root = self.workspace_root()?;
        let relative = relative.to_str().ok_or_else(|| {
            HostError::new(
                "workspace_path_invalid",
                "the relative path is not UTF-8",
                "choose a UTF-8 workspace path",
            )
        })?;
        crate::vault::resolve_inside_vault(&root.to_string_lossy(), relative).map_err(|error| {
            HostError::new(
                "workspace_path_refused",
                error,
                "choose a path inside the selected workspace",
            )
        })?;
        let action = match action {
            WriteAction::Create => crate::vault_list::WorkspaceWriteAction::Create,
            WriteAction::Modify => crate::vault_list::WorkspaceWriteAction::Modify,
            WriteAction::Delete => crate::vault_list::WorkspaceWriteAction::Delete,
        };
        crate::vault_list::assert_maru_can_write(&root.to_string_lossy(), action).map_err(|error| {
            HostError::new(
                "workspace_write_refused",
                error,
                "check the selected workspace write permissions",
            )
        })
    }
}

pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_maru_diagram::Builder::new(
        Arc::new(Host),
        Arc::new(tauri_plugin_maru_diagram::FixtureSources),
    )
    .build()
}

pub fn allow_measurement(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // Local main webview only. Remote Sites frames never receive this permission.
    app.add_capability(r#"{"identifier":"engine-e0","webviews":["main"],"permissions":["maru-diagram:allow-validate"]}"#)?;
    Ok(())
}
