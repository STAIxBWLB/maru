//! Measured model evidence and well-separated text controls. Near-threshold
//! differences stay in the model corpus; these tests do not assert a legacy
//! character-width heuristic as the SDK's capacity predicate.
#![cfg(feature = "geometry")]

use maru_diagram_engine::{layout::layout_json, metrics::measure_text, validate_json};
use serde_json::{json, Value};

#[test]
fn separated_text_controls_gate_both_recorded_oracle_and_engine() {
    let corpus: Value = serde_json::from_str(include_str!("../testdata/parity.json")).unwrap();
    let cases = corpus["boundaryCases"]
        .as_array()
        .expect("regenerate the boundary corpus before running metric model controls");
    for kind in [
        "architecture",
        "workflow",
        "sequence",
        "dataflow",
        "lifecycle",
    ] {
        for long in [false, true] {
            let id = format!("e2-boundary-{kind}-clear-margin-text-{}", u8::from(long));
            let case = cases
                .iter()
                .find(|case| case["id"].as_str() == Some(id.as_str()))
                .unwrap_or_else(|| panic!("missing {id}; regenerate the host boundary corpus"));
            let comparison = &case["geometryComparison"];
            let oracle_accepted = comparison["accepted"]
                .as_bool()
                .expect("host oracle comparison must record a real boolean verdict");
            let input = comparison["inputJson"]
                .as_str()
                .expect("host oracle comparison must preserve the exact compared input");
            assert!(validate_json(input).ok, "{id} must remain document-valid");
            assert_eq!(
                oracle_accepted, !long,
                "{id}: separated text control must have the intended actual pinned oracle verdict"
            );
            let report = layout_json(&json!({"specJson":input}).to_string());
            assert_eq!(report.ok, oracle_accepted, "{id}: separated text control must agree with its oracle even though near-threshold model cases are report-only: {:?}",report.diagnostics);
            if long {
                assert!(
                    report
                        .diagnostics
                        .iter()
                        .any(|diagnostic| diagnostic.code == format!("{kind}/geometry-label-fit")),
                    "{id}: intended text refusal was preempted: {:?}",
                    report.diagnostics
                );
            }
        }
    }
}

#[test]
fn emit_measured_noto_and_stated_legacy_metric_evidence() {
    let text = "W".repeat(20);
    // SceneBuilder measures primary labels at13px bold. Its dataflow capacity
    // gate rescales that actual box to the8px minimum, with8px node padding.
    let actual = measure_text(&text, 700, 13 * 64).unwrap();
    let short = measure_text("OK", 700, 13 * 64).unwrap();
    let long = measure_text(&"W".repeat(80), 700, 13 * 64).unwrap();
    let min_required = |advance: i32, ink: i32| f64::from(advance.max(ink)) / 64.0 * 8.0 / 13.0;
    assert!(min_required(short.advance, short.ink.width) < 112.0 - 8.0);
    assert!(min_required(long.advance, long.ink.width) > 80.0 - 8.0);
    println!(
        "ENGINE_E2_METRIC_MODEL {}",
        json!({
            "category":"text-capacity", "text":text, "weight":700,"fontSizePx":13,
            "notoAdvanceFixed":actual.advance,"notoAdvancePx":f64::from(actual.advance)/64.0,
            "notoInkWidthFixed":actual.ink.width,
            "engineRequiredAtMinimum8Px":min_required(actual.advance,actual.ink.width),
            "statedLegacyDataflowPrimaryHeuristicPx":20.0*6.2,
            "legacyFormula":"20 ASCII W text units *6.2px; explanatory reference, not an engine assertion",
            "measurementSource":"bundled pinned Noto CJK KR bold metrics"
        })
    );
}

#[test]
fn emit_actual_engine_readable_v2_source_ports() {
    let source = json!({
        "schema_version":2,"diagram_type":"workflow",
        "meta":{"title":"V2 ports","output":"v2-ports.html"},
        "lanes":[{"id":"main","label":"Main"}],
        "nodes":[{"id":"a","lane":"main","col":0,"type":"frontend","label":"A"},
                 {"id":"b","lane":"main","col":1,"type":"backend","label":"B"}],
        "edges":[{"id":"go","from":"a","to":"b","role":"main"}]
    });
    let spec_json = source.to_string();
    assert!(validate_json(&spec_json).ok);
    let report = layout_json(&json!({"specJson":spec_json}).to_string());
    assert!(report.ok, "{:?}", report.diagnostics);
    let scene = report.geometry.unwrap();
    let route = scene
        .routes
        .iter()
        .find(|route| route.id.as_deref() == Some("go"))
        .unwrap();
    let source_port = *route.points.first().unwrap();
    let target_port = *route.points.last().unwrap();
    assert!(scene.nodes.iter().any(|node| node.id == "a"));
    assert!(route
        .points
        .windows(2)
        .all(|points| points[0].x == points[1].x || points[0].y == points[1].y));
    println!(
        "ENGINE_E2_METRIC_MODEL {}",
        json!({
            "category":"readable-v2-implicit-placement","inputSpec":source,
            "engineNodes":scene.nodes,"engineSourcePortFixed":source_port,"engineTargetPortFixed":target_port,
            "engineSourcePortPx":{"x":f64::from(source_port.x)/64.0,"y":f64::from(source_port.y)/64.0},
            "engineTargetPortPx":{"x":f64::from(target_port.x)/64.0,"y":f64::from(target_port.y)/64.0},
            "comparisonScope":"engine-only measurement; compare this exact embedded input against a separately recorded pinned oracle layout receipt"
        })
    );
}
