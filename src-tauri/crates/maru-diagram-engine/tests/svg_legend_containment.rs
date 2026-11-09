#![cfg(feature = "render-svg")]
use maru_diagram_engine::{
    layout::layout_json,
    render::{check_svg_artifact, render_svg, SvgOptions, SvgTheme},
};
use serde_json::{json, Value};
#[test]
fn legend_has_no_visible_frame_and_checks_all_paint_and_labels() {
    for input in [
        include_str!("../testdata/valid-architecture.json"),
        include_str!("../testdata/valid-workflow.json"),
        include_str!("../testdata/valid-sequence.json"),
        include_str!("../testdata/valid-dataflow.json"),
        include_str!("../testdata/valid-lifecycle.json"),
    ] {
        let mut spec: Value = serde_json::from_str(input).unwrap();
        spec["meta"]["legend"] = json!({"mode":"all"});
        let geometry = layout_json(&json!({"specJson":spec.to_string()}).to_string())
            .geometry
            .unwrap();
        for theme in [SvgTheme::Light, SvgTheme::Dark] {
            let options = SvgOptions::from_spec(&spec, theme).unwrap();
            let result = render_svg(&geometry, &options);
            assert!(result.ok, "{:?}", result.diagnostics);
            let svg = result.svg.unwrap();
            assert!(!svg.contains("data-kind=\"legend-box\""));
            assert!(check_svg_artifact(&svg, &geometry, &options).is_empty());
            let mut broken = geometry.clone();
            let b = broken.legend.content_bounds.as_mut().unwrap();
            b.width = 64;
            let errors = check_svg_artifact(&svg, &broken, &options);
            assert!(errors
                .iter()
                .any(|error| error.code == "document/svg-legend-containment"));
            let mut missing = geometry.clone();
            missing.legend.content_bounds = None;
            assert!(!check_svg_artifact(&svg, &missing, &options).is_empty());
        }
    }
}
