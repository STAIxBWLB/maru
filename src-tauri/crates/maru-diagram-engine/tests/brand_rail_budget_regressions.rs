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

fn assert_node_ink_is_contained_or_reported(
    report: &maru_diagram_engine::geometry::GeometryReport,
) {
    let geometry = report
        .geometry
        .as_ref()
        .expect("readability refusal retains placed geometry");
    assert!(geometry
        .labels
        .iter()
        .any(|label| label.target_id == geometry.nodes[0].id));
    for node in &geometry.nodes {
        let left = i64::from(node.bounds.x);
        let top = i64::from(node.bounds.y);
        let right = left + i64::from(node.bounds.width);
        let bottom = top + i64::from(node.bounds.height);
        for glyph in geometry
            .labels
            .iter()
            .filter(|label| label.target_id == node.id)
            .flat_map(|label| &label.glyphs)
            .filter(|glyph| glyph.ink.width > 0 && glyph.ink.height > 0)
        {
            let ink_left = i64::from(glyph.ink.x);
            let ink_top = i64::from(glyph.ink.y);
            let ink_right = ink_left + i64::from(glyph.ink.width);
            let ink_bottom = ink_top + i64::from(glyph.ink.height);
            let overflow =
                ink_left < left || ink_top < top || ink_right > right || ink_bottom > bottom;
            if overflow {
                assert!(
                    !report.ok,
                    "painted text overflow for node {} was admitted",
                    node.id
                );
                assert!(
                    report.diagnostics.iter().any(|diagnostic| {
                        diagnostic.code.ends_with("/geometry-label-fit")
                            && diagnostic.message.contains(&format!("{:?}", node.id))
                    }),
                    "painted text overflow for node {} needs its geometry-label-fit diagnostic: {:?}",
                    node.id,
                    report.diagnostics
                );
            }
        }
    }
}

#[test]
fn pinned_brand_rail_cases_keep_oracle_evidence_and_enforce_actual_painted_bounds() {
    for id in [
        "e2-boundary-architecture-brand-rail-71",
        "e2-boundary-dataflow-brand-rail-71",
        "e2-boundary-lifecycle-brand-rail-71",
        "e2-boundary-workflow-brand-rail-71",
        "e2-boundary-workflow-brand-rail-73",
    ] {
        let (oracle_ok, spec) = boundary_case(id);
        assert!(!oracle_ok, "{id}: preserve the original oracle refusal");
        let report = layout_json(&json!({"specJson":spec.to_string()}).to_string());
        // The original oracle verdict remains reference evidence. Admission
        // now checks actual paint, not a legacy virtual brand-rail budget.
        assert_node_ink_is_contained_or_reported(&report);
    }
}
