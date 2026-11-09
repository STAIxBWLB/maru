#![cfg(feature = "geometry")]

use maru_diagram_engine::layout::layout_json;
use serde_json::{json, Value};

fn report(label: &str, width: f64) -> maru_diagram_engine::geometry::GeometryReport {
    let spec: Value = json!({
        "schema_version": 1,
        "diagram_type": "dataflow",
        "meta": {"title": "Text bounds", "output": "text-bounds.html", "viewBox": [940, 720]},
        "stages": [{"label": "Input"}, {"label": "Output"}],
        "nodes": [
            {"id": "a", "type": "frontend", "label": label, "stage": 1, "row": 0, "width": width, "height": 58},
            {"id": "b", "type": "backend", "label": "Output", "stage": 0, "row": 1}
        ],
        "flows": []
    });
    layout_json(&json!({"specJson": spec.to_string()}).to_string())
}

fn assert_refused_for_emitted_box(report: &maru_diagram_engine::geometry::GeometryReport) {
    assert!(!report.ok, "oversized emitted Noto text must refuse");
    let geometry = report.geometry.as_ref().expect("refusal retains geometry");
    let node = geometry.nodes.iter().find(|node| node.id == "a").unwrap();
    let label = geometry
        .labels
        .iter()
        .find(|label| label.id.as_deref() == Some("node:a:label"))
        .unwrap();
    let area_left = i64::from(node.bounds.x);
    let area_right = i64::from(node.bounds.x) + i64::from(node.bounds.width);
    assert!(
        i64::from(label.bounds.x) + i64::from(label.bounds.width) > area_right,
        "test input must exceed the emitted node text area"
    );
    assert!(
        report.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "dataflow/geometry-label-fit"
                && diagnostic.path == "/nodes/0/label"
                && diagnostic.message.contains("emitted Noto label box")
        }),
        "{:?}",
        report.diagnostics
    );
    assert!(i64::from(label.bounds.x) >= area_left);
}

fn assert_emitted_box_fits(report: &maru_diagram_engine::geometry::GeometryReport) {
    assert!(report.ok, "{:?}", report.diagnostics);
    let geometry = report
        .geometry
        .as_ref()
        .expect("accepted layout has geometry");
    let node = geometry.nodes.iter().find(|node| node.id == "a").unwrap();
    let label = geometry
        .labels
        .iter()
        .find(|label| label.id.as_deref() == Some("node:a:label"))
        .unwrap();
    let area_left = i64::from(node.bounds.x);
    let area_right = i64::from(node.bounds.x) + i64::from(node.bounds.width);
    assert!(i64::from(label.bounds.x) >= area_left);
    assert!(i64::from(label.bounds.x) + i64::from(label.bounds.width) <= area_right);
}

#[test]
fn long_latin_primary_label_uses_emitted_noto_width_at_narrow_and_wide_sizes() {
    let label = "BrandBrandBrandBrandBran";
    assert_refused_for_emitted_box(&report(label, 118.0));
    assert_emitted_box_fits(&report(label, 220.0));
}

#[test]
fn mixed_korean_and_english_primary_label_fits_only_when_the_actual_text_area_allows_it() {
    let label = "결제 Gateway API 2025";
    assert_refused_for_emitted_box(&report(label, 118.0));
    assert_emitted_box_fits(&report(label, 220.0));
}

#[test]
fn equal_length_latin_glyph_classes_have_distinct_physical_widths() {
    let narrow_i = "i".repeat(24);
    let wide_w = "W".repeat(24);
    assert_emitted_box_fits(&report(&narrow_i, 118.0));
    assert_refused_for_emitted_box(&report(&wide_w, 118.0));
    assert_emitted_box_fits(&report(&wide_w, 340.0));
}

#[test]
fn font_ink_bearings_may_use_node_padding_without_overflowing_the_node() {
    let report = report("A", 118.0);
    assert_emitted_box_fits(&report);
    let geometry = report.geometry.unwrap();
    let node = geometry.nodes.iter().find(|node| node.id == "a").unwrap();
    let label = geometry
        .labels
        .iter()
        .find(|label| label.id.as_deref() == Some("node:a:label"))
        .unwrap();
    assert!(
        label.bounds.x < node.bounds.x + 12 * 64,
        "this fixture must exercise ink left of the text origin"
    );
    assert!(
        label.bounds.x >= node.bounds.x,
        "the ink stays inside the actual node"
    );
}
