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
fn an_overlong_word_that_no_box_or_floor_can_hold_names_its_family_size_field() {
    // Auto-fit wraps, grows the box and shrinks to the 10px floor first; what is
    // left is a word too wide for the node even then, and the repair names the
    // field that would fix it.
    let architecture = corpus_spec("e2-architecture-geometry-label-fit-detail");
    let architecture_report = report(&architecture);
    let diagnostic = fit(&architecture_report, "/components/0/sublabel");
    assert!(diagnostic.fix.contains("size[0]") || diagnostic.fix.contains("size[1]"));
    assert!(!diagnostic.message.is_empty());

    let dataflow = corpus_spec("e2-dataflow-geometry-label-fit-detail");
    let dataflow_report = report(&dataflow);
    fit(&dataflow_report, "/nodes/0/sublabel");
}

#[test]
fn vertical_repair_reports_available_height_and_the_height_size_entry() {
    let mut spec: Value =
        serde_json::from_str(include_str!("../testdata/valid-architecture.json")).unwrap();
    spec["components"][0]["size"] = json!([160, 2]);
    spec["connections"] = json!([]);
    // One node only: auto-fit grows the box, and a neighbour a cell away would
    // report its own separation refusal instead of the label fit.
    spec["components"] = json!([spec["components"][0].clone()]);
    let result = report(&spec);
    let diagnostic = fit(&result, "/components/0/label");
    assert!(diagnostic.message.contains("available height"));
    assert!(!diagnostic.message.contains("available width"));
    assert!(diagnostic.fix.contains("components[0].size[1]"));
}

#[test]
fn a_label_that_auto_fit_makes_readable_is_accepted_and_wraps_its_own_text() {
    let result = report(&corpus_spec("public-01"));
    assert!(
        result.ok,
        "auto-fit makes this source readable: {:?}",
        result.diagnostics
    );
    let geometry = result.geometry.expect("accepted layout retains geometry");
    let wrapped = geometry
        .labels
        .iter()
        .filter(|label| label.target_id == "system")
        .any(|label| label.text.contains('\n'));
    assert!(
        wrapped,
        "the overflowing detail is re-broken to fit instead of refused: {:?}",
        geometry
            .labels
            .iter()
            .filter(|label| label.target_id == "system")
            .map(|label| (&label.id, &label.text))
            .collect::<Vec<_>>()
    );
    assert!(
        geometry
            .labels
            .iter()
            .filter(|label| label.target_id == "system")
            .all(|label| label.font.id == "noto-sans-cjk-kr"),
        "the fitted lines stay in the pinned face"
    );
}
