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
    let mut commands = vec!["validate", "render_png"];
    #[cfg(feature = "outline")]
    commands.push("render_svg");
    for command in commands {
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
fn ipc_error(value: serde_json::Value) -> IpcError {
    serde_json::from_value(value).expect("PNG IPC rejection has the structured error shape")
}
#[test]
fn png_ipc_worker_receipts_and_real_fixture_evidence() {
    let (app, view) = fixture();
    let caller = std::thread::current().id();
    let typical = include_str!("../../maru-diagram-engine/testdata/valid-architecture.json");
    let thousand = include_str!("../../maru-diagram-engine/testdata/bench-1000.json");
    let validation = invoke(&view, "validate", typical)
        .unwrap()
        .deserialize::<maru_diagram_engine::ValidationReport>()
        .unwrap();
    assert!(validation.ok);
    let mut observed = vec!["validate"];
    let mut cases = Vec::new();
    for (name, source) in [("typical", typical), ("1000", thousand)] {
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
    // The native SVG command is the only way an outlined artifact is produced,
    // so its own registered invoke is recorded rather than inferred from PNG.
    #[cfg(feature = "outline")]
    let svg_cases = {
        let mut svg_cases = Vec::new();
        for (name, source) in [("typical", typical), ("1000", thousand)] {
            let input = json!({"specJson":source,"format":"svg","theme":"light","pixelRatio":1})
                .to_string();
            let mut samples = Vec::new();
            let mut response_bytes = 0;
            let mut svg_bytes = 0;
            let mut svg_sha = String::new();
            for _ in 0..4 {
                let started = Instant::now();
                let report = invoke(&view, "render_svg", &input)
                    .unwrap()
                    .deserialize::<ArtifactReport>()
                    .unwrap();
                samples.push(started.elapsed().as_secs_f64() * 1000.0);
                assert!(report.ok, "{:?}", report.diagnostics);
                assert_eq!(report.receipt.engine.id, "maru-diagram-engine");
                assert_eq!(
                    report.text_mode,
                    Some(maru_diagram_engine::render::SvgTextMode::Outlines)
                );
                let svg = report.svg.clone().expect("native export carries SVG bytes");
                assert!(
                    !svg.contains("<text "),
                    "the native export draws labels from glyph outlines"
                );
                response_bytes = serde_json::to_vec(&report).unwrap().len();
                svg_bytes = svg.len();
                if !svg_sha.is_empty() {
                    assert_eq!(svg_sha, report.receipt.output_sha256.clone().unwrap());
                }
                svg_sha = report.receipt.output_sha256.unwrap();
            }
            if !observed.contains(&"render_svg") {
                observed.push("render_svg");
            }
            svg_cases.push(json!({"name":name,"requestBytes":input.len(),"responseBytes":response_bytes,"roundTripMs":samples,"svgBytes":svg_bytes,"svgSha256":svg_sha,"textMode":"outlines"}));
        }
        svg_cases
    };
    let worker = app
        .state::<PluginState>()
        .worker_thread
        .lock()
        .unwrap()
        .unwrap();
    let different_worker_thread = worker != caller;
    assert!(different_worker_thread);
    let state = app.state::<PluginState>();
    state
        .rendering
        .store(true, std::sync::atomic::Ordering::Release);
    let busy = ipc_error(invoke(&view, "render_png", "{}").unwrap_err());
    let busy_observed = busy.code == "diagram_export_busy"
        && busy.message.contains("already running")
        && !busy.next_step.is_empty()
        && busy.diagnostics.is_empty();
    state
        .rendering
        .store(false, std::sync::atomic::Ordering::Release);
    assert!(busy_observed);
    // One permit bounds both native exports: the flag PNG refuses on is the one
    // the outlined SVG export refuses on, so the two cannot rasterize at once.
    #[cfg(feature = "outline")]
    let shared_permit = {
        state
            .rendering
            .store(true, std::sync::atomic::Ordering::Release);
        let refused = ipc_error(invoke(&view, "render_svg", "{}").unwrap_err());
        state
            .rendering
            .store(false, std::sync::atomic::Ordering::Release);
        refused.code == "diagram_export_busy" && refused.message.contains("already running")
    };
    #[cfg(feature = "outline")]
    assert!(shared_permit, "both native exports share one render permit");
    let mut evidence = json!({"schemaVersion":1,"scope":"Tauri MockRuntime registered IPC -> awaited spawn_blocking; no real WebView/OS transport claim","pluginCommandsObserved":observed,"pluginCommandCount":observed.len(),"command":"plugin:maru-diagram|render_png","differentWorkerThread":different_worker_thread,"hostFilesystemAccess":"none; fixture host panics on any access","singleInFlight":busy_observed,"cases":cases});
    #[cfg(feature = "outline")]
    {
        evidence["svgCases"] = json!(svg_cases);
        evidence["sharedPermit"] = json!(shared_permit);
    }
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
    let busy = ipc_error(invoke(&view, "render_png", "{}").unwrap_err());
    assert_eq!(busy.code, "diagram_export_busy");
    assert!(busy.message.contains("already running"));
    assert!(!busy.next_step.is_empty());
    assert!(busy.diagnostics.is_empty());
    flag.store(false, std::sync::atomic::Ordering::Release);
    let huge = "x".repeat(maru_diagram_engine::render::MAX_SVG_BYTES + 1);
    let oversized = ipc_error(invoke(&view, "render_png", &huge).unwrap_err());
    assert_eq!(oversized.code, "diagram_export_size_invalid");
    assert!(oversized.message.contains("16 MiB"));
    assert!(!oversized.next_step.is_empty());
    assert_eq!(oversized.diagnostics.len(), 1);
    let mut invalid_spec: serde_json::Value = serde_json::from_str(include_str!(
        "../../maru-diagram-engine/testdata/valid-architecture.json"
    ))
    .unwrap();
    invalid_spec["connections"][0]["to"] = serde_json::json!("missing-node");
    let rejected_layout = json!({"specJson":invalid_spec.to_string(),"format":"png"}).to_string();
    let expected_diagnostics =
        maru_diagram_engine::render::render_png_artifact_json(&rejected_layout).diagnostics;
    let refused_value = invoke(&view, "render_png", &rejected_layout).unwrap_err();
    assert!(refused_value.get("bytes").is_none());
    let refused = ipc_error(refused_value);
    assert!(!refused.code.is_empty());
    assert!(!refused.message.is_empty());
    assert!(!refused.next_step.is_empty());
    assert!(!refused.diagnostics.is_empty());
    assert_eq!(refused.code, refused.diagnostics[0].code);
    assert_eq!(refused.message, refused.diagnostics[0].message);
    assert_eq!(refused.next_step, refused.diagnostics[0].fix);
    assert_eq!(refused.diagnostics, expected_diagnostics);
    let svg=json!({"specJson":include_str!("../../maru-diagram-engine/testdata/valid-architecture.json"),"format":"svg"}).to_string();
    let svg_refused = ipc_error(invoke(&view, "render_png", &svg).unwrap_err());
    assert_eq!(svg_refused.code, "document/svg-png-command-format");
    assert!(svg_refused.message.contains("does not export SVG"));
    assert_eq!(svg_refused.diagnostics.len(), 1);
    assert!(!app
        .state::<PluginState>()
        .rendering
        .load(std::sync::atomic::Ordering::Acquire));
}
#[cfg(feature = "outline")]
#[test]
fn svg_ipc_rejects_busy_oversized_and_invalid_layout_requests() {
    let (app, view) = fixture();
    let state = app.state::<PluginState>();
    let flag = &state.rendering;
    flag.store(true, std::sync::atomic::Ordering::Release);
    let busy = ipc_error(invoke(&view, "render_svg", "{}").unwrap_err());
    assert_eq!(busy.code, "diagram_export_busy");
    assert!(busy.message.contains("already running"));
    assert!(!busy.next_step.is_empty());
    assert!(busy.diagnostics.is_empty());
    flag.store(false, std::sync::atomic::Ordering::Release);
    let huge = "x".repeat(maru_diagram_engine::render::MAX_SVG_BYTES + 1);
    let oversized = ipc_error(invoke(&view, "render_svg", &huge).unwrap_err());
    assert_eq!(oversized.code, "diagram_export_size_invalid");
    assert!(oversized.message.contains("16 MiB"));
    assert!(!oversized.next_step.is_empty());
    assert_eq!(oversized.diagnostics.len(), 1);
    let mut invalid_spec: serde_json::Value = serde_json::from_str(include_str!(
        "../../maru-diagram-engine/testdata/valid-architecture.json"
    ))
    .unwrap();
    invalid_spec["connections"][0]["to"] = serde_json::json!("missing-node");
    let rejected_layout = json!({"specJson":invalid_spec.to_string(),"format":"svg"}).to_string();
    let expected_diagnostics =
        maru_diagram_engine::render::render_svg_artifact_json(&rejected_layout).diagnostics;
    let refused_value = invoke(&view, "render_svg", &rejected_layout).unwrap_err();
    assert!(refused_value.get("svg").is_none());
    let refused = ipc_error(refused_value);
    assert_eq!(refused.code, refused.diagnostics[0].code);
    assert_eq!(refused.message, refused.diagnostics[0].message);
    assert_eq!(refused.next_step, refused.diagnostics[0].fix);
    assert_eq!(refused.diagnostics, expected_diagnostics);
    assert!(!app
        .state::<PluginState>()
        .rendering
        .load(std::sync::atomic::Ordering::Acquire));
}
