use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::WebviewWindowBuilder;
use tauri_plugin_maru_diagram::{
    Builder, DiagramHost, DiagramSources, HostError, RenderStoreHost, SourceError, SourceQuery,
    SourceSnapshot, WriteAction,
};

struct FixtureHost;
impl DiagramHost for FixtureHost {
    fn workspace_root(&self) -> Result<PathBuf, HostError> {
        panic!("diagram commands must not discover a workspace for this fixture")
    }
    fn ensure_write(&self, _: &std::path::Path, _: WriteAction) -> Result<(), HostError> {
        panic!("diagram fixture has no filesystem write path")
    }
    fn scan_root(&self, _: &str) -> Result<PathBuf, HostError> {
        Err(HostError::new(
            "fixture_scan_refused",
            "the fixture host opens no workspace",
            "scan through a host that resolves a workspace",
        ))
    }
}

struct FixtureSources;
impl DiagramSources for FixtureSources {
    fn document_relations(&self, _: &SourceQuery) -> Result<SourceSnapshot, SourceError> {
        Err(SourceError::new(
            "fixture_unavailable",
            "no source fixture",
            "use a source-backed fixture",
        ))
    }
    fn workspace_structure(&self, _: &SourceQuery) -> Result<SourceSnapshot, SourceError> {
        Err(SourceError::new(
            "fixture_unavailable",
            "no source fixture",
            "use a source-backed fixture",
        ))
    }
    fn vault_concepts(&self, _: &SourceQuery) -> Result<SourceSnapshot, SourceError> {
        Err(SourceError::new(
            "fixture_unavailable",
            "no source fixture",
            "use a source-backed fixture",
        ))
    }
}

struct FixtureStore;
impl RenderStoreHost for FixtureStore {
    fn list_renders(
        &self,
        _: &str,
    ) -> Result<Vec<tauri_plugin_maru_diagram::RenderGroup>, HostError> {
        Ok(Vec::new())
    }
    fn prepare_render_view(
        &self,
        _: &str,
        _: &str,
        _: &str,
    ) -> Result<tauri_plugin_maru_diagram::RenderView, HostError> {
        Err(HostError::new(
            "fixture_render_missing",
            "no stored fixture",
            "render a fixture first",
        ))
    }
    fn delete_render(&self, _: &str, _: &str, _: &str) -> Result<(), HostError> {
        Ok(())
    }
    fn store_engine_render(
        &self,
        _: &str,
        _: tauri_plugin_maru_diagram::RenderDocumentContext,
        _: &str,
        _: maru_diagram_engine::render::ArtifactReport,
    ) -> Result<tauri_plugin_maru_diagram::StoredRender, HostError> {
        panic!("context-free evidence render must not store")
    }
}

fn invoke(
    view: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    name: &str,
    args: Value,
) -> Result<tauri::ipc::InvokeResponseBody, Value> {
    get_ipc_response(
        view,
        InvokeRequest {
            cmd: format!("plugin:maru-diagram|{name}"),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: view.url().unwrap(),
            body: InvokeBody::Json(args),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.into(),
        },
    )
}

#[test]
fn production_feature_commands_are_invokable_through_mock_runtime() {
    let mut commands = vec![
        "validate",
        "scan_repository",
        "render_png",
        "diagram_list_renders",
        "diagram_prepare_render_view",
        "diagram_delete_render",
        "render_and_store",
    ];
    #[cfg(feature = "outline")]
    commands.push("render_svg");
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    for command in commands.iter().copied() {
        context.runtime_authority_mut().__allow_command(
            format!("plugin:maru-diagram|{command}"),
            tauri::utils::acl::ExecutionContext::Local,
        );
    }
    let plugin = Builder::new(Arc::new(FixtureHost), Arc::new(FixtureSources))
        .with_render_store(Arc::new(FixtureStore))
        .build::<tauri::test::MockRuntime>();
    let app = tauri::test::mock_builder()
        .plugin(plugin)
        .build(context)
        .expect("production plugin builds");
    let main = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("main mock window builds");
    let source = include_str!("../../maru-diagram-engine/testdata/valid-architecture.json");
    let mut observed = Vec::new();

    let validated = invoke(&main, "validate", json!({"input":source}))
        .expect("validate command is registered")
        .deserialize::<maru_diagram_engine::ValidationReport>()
        .unwrap();
    assert!(validated.ok);
    observed.push("validate");

    let scan_refusal = invoke(
        &main,
        "scan_repository",
        json!({"workspace":"fixture","path":"."}),
    )
    .unwrap_err();
    assert_eq!(scan_refusal["code"], "fixture_scan_refused");
    observed.push("scan_repository");

    let png_request =
        json!({"specJson":source,"format":"png","theme":"light","pixelRatio":1}).to_string();
    let png = invoke(&main, "render_png", json!({"input":png_request}))
        .expect("PNG command is registered")
        .deserialize::<maru_diagram_engine::render::ArtifactReport>()
        .unwrap();
    assert!(png.ok, "{:?}", png.diagnostics);
    observed.push("render_png");

    let listed = invoke(
        &main,
        "diagram_list_renders",
        json!({"workspace":"fixture"}),
    )
    .expect("list command is registered")
    .deserialize::<Vec<tauri_plugin_maru_diagram::RenderGroup>>()
    .unwrap();
    assert!(listed.is_empty());
    observed.push("diagram_list_renders");

    let missing = invoke(
        &main,
        "diagram_prepare_render_view",
        json!({"workspace":"fixture","docId":"doc","renderId":"render"}),
    )
    .unwrap_err();
    assert_eq!(missing["code"], "fixture_render_missing");
    observed.push("diagram_prepare_render_view");

    invoke(
        &main,
        "diagram_delete_render",
        json!({"workspace":"fixture","docId":"doc","renderId":"render"}),
    )
    .expect("delete command is registered");
    observed.push("diagram_delete_render");

    let store_request = json!({"specJson":source,"format":"svg","theme":"light","pixelRatio":1,"textMode":"outlines"}).to_string();
    let stored = invoke(
        &main,
        "render_and_store",
        json!({"workspace":"fixture","input":store_request,"context":null}),
    )
    .expect("store command is registered")
    .deserialize::<tauri_plugin_maru_diagram::RenderAndStoreReport>()
    .unwrap();
    assert!(stored.report.ok, "{:?}", stored.report.diagnostics);
    assert!(stored.store_warning.is_none());
    observed.push("render_and_store");

    #[cfg(feature = "outline")]
    {
        let svg_request =
            json!({"specJson":source,"format":"svg","theme":"light","pixelRatio":1}).to_string();
        let svg = invoke(&main, "render_svg", json!({"input":svg_request}))
            .expect("outlined SVG command is registered")
            .deserialize::<maru_diagram_engine::render::ArtifactReport>()
            .unwrap();
        assert!(svg.ok, "{:?}", svg.diagnostics);
        assert_eq!(
            svg.text_mode,
            Some(maru_diagram_engine::render::SvgTextMode::Outlines)
        );
        assert!(!svg.svg.as_deref().unwrap_or_default().contains("<text "));
        observed.push("render_svg");
    }

    let evidence = json!({
        "schemaVersion": 1,
        "scope": "Tauri MockRuntime invoke responses from production-feature plugin builder; main window only; capability policy checked separately by command-isolation source gate",
        "windowLabel": "main",
        "pluginCommandsObserved": observed,
        "pluginCommandCount": commands.len(),
    });
    println!("DIAGRAM_PLUGIN_COMMAND_EVIDENCE {evidence}");
    if let Ok(path) = std::env::var("MARU_PLUGIN_COMMAND_EVIDENCE") {
        let path = PathBuf::from(path);
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            std::fs::create_dir_all(parent).expect("create requested evidence directory");
        }
        std::fs::write(path, serde_json::to_vec_pretty(&evidence).unwrap())
            .expect("write generated invocation evidence");
    }
}
