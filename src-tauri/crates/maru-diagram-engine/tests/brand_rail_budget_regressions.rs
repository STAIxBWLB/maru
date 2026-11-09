#![cfg(feature = "geometry")]

use maru_diagram_engine::layout::layout_json;
use serde_json::{json, Value};

fn boundary_case(id: &str) -> (bool, Value) {
    let corpus: Value = serde_json::from_str(include_str!("../testdata/parity.json")).unwrap();
    let case = corpus["boundaryCases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["id"].as_str() == Some(id))
        .unwrap_or_else(|| panic!("restore pinned boundary case {id}"));
    let oracle = case["oracle"]["ok"]
        .as_bool()
        .expect("pinned case retains original oracle verdict");
    let input = case["geometryComparison"]["inputJson"]
        .as_str()
        .expect("pinned case retains exact geometry source");
    (oracle, serde_json::from_str(input).unwrap())
}

#[test]
fn pinned_brand_rail_cases_refuse_with_retained_geometry_and_role_cause() {
    for (id, cause) in [
        (
            "e2-boundary-architecture-brand-rail-71",
            "architecture/geometry-label-fit",
        ),
        (
            "e2-boundary-dataflow-brand-rail-71",
            "dataflow/geometry-label-fit",
        ),
        (
            "e2-boundary-lifecycle-brand-rail-71",
            "lifecycle/geometry-label-fit",
        ),
        (
            "e2-boundary-workflow-brand-rail-71",
            "workflow/geometry-label-fit",
        ),
        (
            "e2-boundary-workflow-brand-rail-73",
            "workflow/geometry-label-fit",
        ),
    ] {
        let (oracle_ok, spec) = boundary_case(id);
        assert!(!oracle_ok, "{id}: preserve the original oracle refusal");
        let report = layout_json(&json!({"specJson":spec.to_string()}).to_string());
        assert!(
            !report.ok,
            "{id}: narrow branded rail still fails measured capacity"
        );
        assert!(report.geometry.is_some(), "{id}: retain placed geometry");
        assert!(
            report
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == cause),
            "{id}: expected {cause}, got {:?}",
            report.diagnostics
        );
    }
}
