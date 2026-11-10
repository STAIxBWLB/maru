#![cfg(all(feature = "render-svg", feature = "render-outline"))]
//! The outlined viewer artifact is engine output, not a hand-written SVG; this
//! keeps it exact. Set `MARU_WRITE_VIEWER_OUTLINE_FIXTURE=1` to regenerate it.
//! Both files live in this crate's `testdata/`: the app may read the SDK, never
//! the other way round, so the test never reaches into `src/lib`.
use maru_diagram_engine::{
    layout::layout_json,
    render::{render_svg, SvgOptions, SvgTextMode, SvgTheme},
};
use serde_json::json;
use std::path::PathBuf;

const SPEC: &str = include_str!("../testdata/viewer-architecture-light.spec.json");
const FIXTURE: &str = "testdata/architecture-light-outlines.svg";

#[test]
fn the_outlined_viewer_fixture_is_current_engine_output() {
    let spec: serde_json::Value = serde_json::from_str(SPEC).expect("viewer spec parses");
    let layout = layout_json(&json!({"specJson": spec.to_string()}).to_string());
    let geometry = layout.geometry.expect("viewer spec lays out");
    let options = SvgOptions {
        semantics: Some(
            maru_diagram_engine::render::SemanticContext::from_spec(&spec)
                .expect("viewer spec carries valid semantics"),
        ),
        theme: SvgTheme::Light,
        title: "마루 architecture 렌더".into(),
        description: "결정적 SVG · 접근성 검증".into(),
        text_mode: SvgTextMode::Outlines,
    };
    let report = render_svg(&geometry, &options);
    assert!(report.ok, "{:?}", report.diagnostics);
    let svg = report.svg.expect("outlined render has bytes");
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(FIXTURE);
    if std::env::var("MARU_WRITE_VIEWER_OUTLINE_FIXTURE").is_ok() {
        std::fs::write(&path, &svg).expect("write the outlined viewer fixture");
        return;
    }
    let committed =
        std::fs::read_to_string(&path).expect("the outlined viewer fixture is committed");
    assert_eq!(
        committed, svg,
        "the outlined viewer fixture drifted; regenerate it with MARU_WRITE_VIEWER_OUTLINE_FIXTURE=1"
    );
}
