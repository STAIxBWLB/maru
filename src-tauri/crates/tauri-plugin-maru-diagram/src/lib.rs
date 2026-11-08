//! Standalone Tauri 2 adapter for `maru-diagram-engine`.
//!
//! The plugin owns no Maru paths or data. Host integrations are passed through
//! stable traits so this crate can be split from the application unchanged.

use maru_diagram_engine::ValidationReport;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{plugin::TauriPlugin, Manager, Runtime};

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
}

pub struct Builder {
    host: Arc<dyn DiagramHost>,
    sources: Arc<dyn DiagramSources>,
}

impl Builder {
    pub fn new(host: Arc<dyn DiagramHost>, sources: Arc<dyn DiagramSources>) -> Self {
        Self { host, sources }
    }

    pub fn build<R: Runtime>(self) -> TauriPlugin<R> {
        let state = PluginState {
            host: self.host,
            sources: self.sources,
        };
        tauri::plugin::Builder::new(PLUGIN_NAME)
            .invoke_handler(tauri::generate_handler![commands::validate])
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

mod commands {
    use super::*;

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
