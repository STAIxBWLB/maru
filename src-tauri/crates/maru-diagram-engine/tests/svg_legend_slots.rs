#![cfg(feature = "render-svg")]

use maru_diagram_engine::{
    layout::layout_json,
    render::{render_svg, SvgOptions, SvgTheme},
};
use serde_json::{json, Value};

#[test]
fn each_family_places_its_swatch_before_text_and_reserves_the_source_slot() {
    for input in [
        include_str!("../testdata/valid-architecture.json"),
        include_str!("../testdata/valid-workflow.json"),
        include_str!("../testdata/valid-sequence.json"),
        include_str!("../testdata/valid-dataflow.json"),
        include_str!("../testdata/valid-lifecycle.json"),
    ] {
        let mut spec: Value = serde_json::from_str(input).unwrap();
        spec["meta"]["legend"] = json!({"mode":"all"});
        let report = layout_json(&json!({"specJson":spec.to_string()}).to_string());
        assert!(report.ok, "{:?}", report.diagnostics);
        let g = report.geometry.unwrap();
        let family = spec["diagram_type"].as_str().unwrap();
        assert!(!g.legend.entries.is_empty());
        for entry in &g.legend.entries {
            let swatch = entry.swatch_bounds.unwrap();
            let text = entry.text_bounds.unwrap();
            let route = family == "sequence" || (family == "dataflow" && entry.key != "database");
            let (slot, gap) = if route {
                (34, 9)
            } else if family == "lifecycle" && entry.key == "start" {
                (26, 8)
            } else if family == "lifecycle" && entry.key == "final" {
                (16, 8)
            } else {
                (14, 8)
            };
            assert_eq!(swatch.x, entry.bounds.x);
            assert_eq!(
                text.x,
                swatch.x + (slot + gap) * 64,
                "{family} {}",
                entry.key
            );
            assert!(swatch.right().unwrap() < text.x);
            assert!(entry.bounds.right().unwrap() >= text.right().unwrap());
        }
        let options = SvgOptions::from_spec(&spec, SvgTheme::Light).unwrap();
        let svg = render_svg(&g, &options);
        assert!(svg.ok, "{:?}", svg.diagnostics);
    }
}
