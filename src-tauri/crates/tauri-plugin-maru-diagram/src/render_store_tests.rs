use super::*;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::WebviewWindowBuilder;

struct NoPathHost;

impl DiagramHost for NoPathHost {
    fn workspace_root(&self) -> Result<PathBuf, HostError> {
        panic!("render-store commands must use the explicit workspace argument")
    }

    fn ensure_write(&self, _: &Path, _: WriteAction) -> Result<(), HostError> {
        panic!("render-store delegates writes to the verified store adapter")
    }
}

struct StoreFixture;

impl RenderStoreHost for StoreFixture {
    fn list_renders(&self, _: &str) -> Result<Vec<RenderGroup>, HostError> {
        Ok(Vec::new())
    }

    fn prepare_render_view(&self, _: &str, _: &str, _: &str) -> Result<RenderView, HostError> {
        Err(HostError::new(
            "fixture_render_missing",
            "fixture has no stored render",
            "render the fixture before preparing a view",
        ))
    }

    fn delete_render(&self, _: &str, _: &str, _: &str) -> Result<(), HostError> {
        Ok(())
    }

    fn store_engine_render(
        &self,
        _: &str,
        _: RenderDocumentContext,
        _: &str,
        _: maru_diagram_engine::render::ArtifactReport,
    ) -> Result<StoredRender, HostError> {
        panic!("invalid request must be refused before host storage")
    }
}

fn fixture() -> (
    tauri::App<tauri::test::MockRuntime>,
    tauri::WebviewWindow<tauri::test::MockRuntime>,
) {
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    for command in [
        "diagram_list_renders",
        "diagram_prepare_render_view",
        "diagram_delete_render",
        "render_and_store",
    ] {
        context.runtime_authority_mut().__allow_command(
            format!("plugin:maru-diagram|{command}"),
            tauri::utils::acl::ExecutionContext::Local,
        );
    }
    let plugin = Builder::new(Arc::new(NoPathHost), Arc::new(FixtureSources))
        .with_render_store(Arc::new(StoreFixture))
        .build::<tauri::test::MockRuntime>();
    let app = tauri::test::mock_builder()
        .plugin(plugin)
        .build(context)
        .expect("render-store plugin builds in the mock host");
    let view = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("main mock view builds");
    (app, view)
}

fn invoke(
    view: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    command: &str,
    args: Value,
) -> Result<tauri::ipc::InvokeResponseBody, Value> {
    get_ipc_response(
        view,
        InvokeRequest {
            cmd: format!("plugin:maru-diagram|{command}"),
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
fn registered_render_store_commands_reach_the_typed_host_adapter() {
    let (_app, view) = fixture();
    let groups = invoke(
        &view,
        "diagram_list_renders",
        json!({"workspace":"/fixture"}),
    )
    .expect("registered list command responds")
    .deserialize::<Vec<RenderGroup>>()
    .unwrap();
    assert!(groups.is_empty());

    let error = invoke(
        &view,
        "render_and_store",
        json!({"workspace":"/fixture", "input":"{}", "context":null}),
    )
    .unwrap_err();
    let error: IpcError = serde_json::from_value(error).unwrap();
    assert_eq!(error.code, "diagram_export_request_invalid");
}
