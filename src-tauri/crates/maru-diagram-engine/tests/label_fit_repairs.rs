#![cfg(feature = "geometry")]

use maru_diagram_engine::{geometry::GeometryReport, layout::layout_json, Diagnostic};
use serde_json::{json, Value};

fn report(spec: &Value) -> GeometryReport {
    layout_json(&json!({"specJson": spec.to_string()}).to_string())
}

fn fit<'a>(report: &'a GeometryReport, path: &str) -> &'a Diagnostic {
    assert!(!report.ok);
    assert!(
        report.geometry.is_some(),
        "refusal must retain the measured scene"
    );
    report
        .diagnostics
        .iter()
        .find(|diagnostic| {
            diagnostic.code.ends_with("/geometry-label-fit") && diagnostic.path == path
        })
        .unwrap_or_else(|| panic!("missing fit diagnostic at {path}: {:?}", report.diagnostics))
}

fn corpus_spec(id: &str) -> Value {
    let corpus: Value = serde_json::from_str(include_str!("../testdata/parity.json")).unwrap();
    let case = corpus["cases"]
        .as_array()
        .unwrap()
        .iter()
        .chain(corpus["boundaryCases"].as_array().unwrap())
        .find(|case| case["id"] == id)
        .unwrap();
    serde_json::from_str(case["geometryComparison"]["inputJson"].as_str().unwrap()).unwrap()
}

#[test]
fn sequence_repair_names_spread_and_viewbox_instead_of_nonexistent_participant_sizes() {
    let result = report(&corpus_spec("gate-sequence-brand-absent"));
    let diagnostic = fit(&result, "/participants/0/label");
    assert!(diagnostic.fix.contains("shorten"));
    assert!(diagnostic.fix.contains("meta.column_fit") && diagnostic.fix.contains("spread"));
    assert!(diagnostic.fix.contains("meta.viewBox"));
    assert!(
        !diagnostic.fix.contains("participant.width")
            && !diagnostic.fix.contains("node width/height")
    );
}

#[test]
fn architecture_horizontal_repair_names_the_size_field() {
    let result = report(&corpus_spec("public-01"));
    let diagnostic = fit(&result, "/components/4/sublabel");
    assert!(diagnostic.fix.contains("components[4].size[0]"));
    assert!(diagnostic.message.contains("available width"));
}

#[test]
fn vertical_repair_reports_available_height_and_the_height_size_entry() {
    let mut spec: Value =
        serde_json::from_str(include_str!("../testdata/valid-architecture.json")).unwrap();
    spec["components"][0]["size"] = json!([160, 2]);
    spec["connections"] = json!([]);
    let result = report(&spec);
    let diagnostic = fit(&result, "/components/0/label");
    assert!(diagnostic.message.contains("available height"));
    assert!(!diagnostic.message.contains("available width"));
    assert!(diagnostic.fix.contains("components[0].size[1]"));
}

#[test]
fn dataflow_repair_names_its_width_field() {
    let mut spec: Value =
        serde_json::from_str(include_str!("../testdata/valid-dataflow.json")).unwrap();
    spec["nodes"][0]["label"] = json!("BrandBrandBrandBrandBran");
    spec["nodes"][0]["width"] = json!(118);
    spec["flows"] = json!([]);
    let result = report(&spec);
    assert!(fit(&result, "/nodes/0/label")
        .fix
        .contains("nodes[0].width"));
}
