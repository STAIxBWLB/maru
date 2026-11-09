use super::*;
use maru_diagram_engine::render::ArtifactReport;
use serde_json::json;
use std::time::Instant;
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::WebviewWindowBuilder;
struct NoFilesystemHost;
impl DiagramHost for NoFilesystemHost {
    fn workspace_root(&self) -> Result<PathBuf, HostError> {
        panic!("PNG cannot discover host filesystem paths")
    }
    fn ensure_write(&self, _: &Path, _: WriteAction) -> Result<(), HostError> {
        panic!("PNG cannot request filesystem writes")
    }
}
fn fixture() -> (
    tauri::App<tauri::test::MockRuntime>,
    tauri::WebviewWindow<tauri::test::MockRuntime>,
) {
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    for command in ["validate", "render_png"] {
        context.runtime_authority_mut().__allow_command(
            format!("plugin:maru-diagram|{command}"),
            tauri::utils::acl::ExecutionContext::Local,
        );
    }
    let app = tauri::test::mock_builder()
        .plugin(
            Builder::new(Arc::new(NoFilesystemHost), Arc::new(FixtureSources))
                .build::<tauri::test::MockRuntime>(),
        )
        .build(context)
        .expect("mock plugin builds");
    let view = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("mock webview builds");
    (app, view)
}
fn invoke(
    view: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    command: &str,
    input: &str,
) -> Result<tauri::ipc::InvokeResponseBody, serde_json::Value> {
    get_ipc_response(
        view,
        InvokeRequest {
            cmd: format!("plugin:maru-diagram|{command}"),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: view.url().unwrap(),
            body: InvokeBody::Json(json!({"input":input})),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.into(),
        },
    )
}
#[test]
fn png_ipc_worker_receipts_and_real_fixture_evidence() {
    let (app, view) = fixture();
    let caller = std::thread::current().id();
    let typical = include_str!("../../maru-diagram-engine/testdata/valid-architecture.json");
    let validation = invoke(&view, "validate", typical)
        .unwrap()
        .deserialize::<maru_diagram_engine::ValidationReport>()
        .unwrap();
    assert!(validation.ok);
    let mut observed = vec!["validate"];
    let mut cases = Vec::new();
    for (name, source) in [
        ("typical", typical),
        (
            "1000",
            include_str!("../../maru-diagram-engine/testdata/bench-1000.json"),
        ),
    ] {
        let input =
            json!({"specJson":source,"format":"png","theme":"light","pixelRatio":1}).to_string();
        let mut samples = Vec::new();
        let mut response_bytes = 0;
        let mut png_sha = String::new();
        for _ in 0..4 {
            let started = Instant::now();
            let report = invoke(&view, "render_png", &input)
                .unwrap()
                .deserialize::<ArtifactReport>()
                .unwrap();
            samples.push(started.elapsed().as_secs_f64() * 1000.0);
            assert!(report.ok, "{:?}", report.diagnostics);
            assert_eq!(report.receipt.engine.id, "maru-diagram-engine");
            response_bytes = serde_json::to_vec(&report).unwrap().len();
            if !png_sha.is_empty() {
                assert_eq!(png_sha, report.receipt.output_sha256.clone().unwrap());
            }
            png_sha = report.receipt.output_sha256.unwrap();
        }
        if !observed.contains(&"render_png") {
            observed.push("render_png");
        }
        cases.push(json!({"name":name,"requestBytes":input.len(),"responseBytes":response_bytes,"roundTripMs":samples,"pngSha256":png_sha}));
    }
    let worker = app
        .state::<PluginState>()
        .worker_thread
        .lock()
        .unwrap()
        .unwrap();
    assert_ne!(worker, caller);
    let state = app.state::<PluginState>();
    state
        .rendering
        .store(true, std::sync::atomic::Ordering::Release);
    let busy_observed = invoke(&view, "render_png", "{}")
        .unwrap_err()
        .to_string()
        .contains("already running");
    state
        .rendering
        .store(false, std::sync::atomic::Ordering::Release);
    assert!(busy_observed);
    let evidence = json!({"schemaVersion":1,"scope":"Tauri MockRuntime registered IPC -> awaited spawn_blocking; no real WebView/OS transport claim","pluginCommandsObserved":observed,"pluginCommandCount":observed.len(),"command":"plugin:maru-diagram|render_png","differentWorkerThread":true,"hostFilesystemAccess":"none; fixture host panics on any access","singleInFlight":busy_observed,"cases":cases});
    println!("PNG_IPC_EVIDENCE {}", evidence);
    if let Ok(output) = std::env::var("MARU_PNG_IPC_EVIDENCE") {
        let output = PathBuf::from(output);
        if let Some(parent) = output
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            std::fs::create_dir_all(parent).expect("create requested fixture evidence directory");
        }
        std::fs::write(output, serde_json::to_vec_pretty(&evidence).unwrap())
            .expect("write requested fixture evidence file");
    }
}
#[test]
fn png_ipc_rejects_busy_oversized_and_svg_requests() {
    let (app, view) = fixture();
    let state = app.state::<PluginState>();
    let flag = &state.rendering;
    flag.store(true, std::sync::atomic::Ordering::Release);
    let busy = invoke(&view, "render_png", "{}").unwrap_err();
    assert!(busy.to_string().contains("already running"));
    flag.store(false, std::sync::atomic::Ordering::Release);
    let huge = "x".repeat(maru_diagram_engine::render::MAX_SVG_BYTES + 1);
    assert!(invoke(&view, "render_png", &huge)
        .unwrap_err()
        .to_string()
        .contains("16 MiB"));
    let svg=json!({"specJson":include_str!("../../maru-diagram-engine/testdata/valid-architecture.json"),"format":"svg"}).to_string();
    let report = invoke(&view, "render_png", &svg)
        .unwrap()
        .deserialize::<ArtifactReport>()
        .unwrap();
    assert!(!report.ok && report.bytes.is_none());
    assert!(report.diagnostics[0]
        .message
        .contains("does not export SVG"));
    assert!(!app
        .state::<PluginState>()
        .rendering
        .load(std::sync::atomic::Ordering::Acquire));
}
