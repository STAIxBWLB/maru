//! Host-generated renderer verdicts; the standalone SDK uses neither Node nor Archify.
#![cfg(feature = "geometry")]
use maru_diagram_engine::layout::layout_json;
use serde::Deserialize;
use std::collections::{BTreeMap, HashSet};
#[path = "support/painted_ink.rs"]
mod painted_ink;

#[derive(Deserialize)]
struct Corpus {
    cases: Vec<Case>,
    rules: BTreeMap<String, Vec<Rule>>,
}
#[derive(Deserialize)]
struct Rule {
    code: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    diagram_type: String,
    geometry_comparison: Comparison,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Comparison {
    input_json: String,
    accepted: bool,
    equivalent_codes: Vec<String>,
    geometry_expected: bool,
}

#[test]
fn reference_verdicts_and_actual_text_bounds_preserve_placed_scenes() {
    let corpus: Corpus = serde_json::from_str(include_str!("../testdata/parity.json")).unwrap();
    let mut failures = Vec::new();
    let mut deferred = HashSet::new();
    let mut measured_text_refusals = HashSet::new();
    for case in corpus.cases {
        let expected = case.geometry_comparison;
        let request = serde_json::json!({"specJson":expected.input_json});
        let report = layout_json(&request.to_string());
        painted_ink::assert_accepted_text_ink_fits(&report);
        if report.ok != expected.accepted {
            if expected.accepted && !report.ok {
                painted_ink::assert_source_green_overflow_exception(
                    &report,
                    &case.id,
                    &case.diagram_type,
                );
                measured_text_refusals.insert(case.id.clone());
            } else {
                failures.push(format!(
                    "{}: expected ok={}, got {:?}",
                    case.id, expected.accepted, report.diagnostics
                ));
            }
        }
        if expected.geometry_expected && report.geometry.is_none() {
            failures.push(format!(
                "{}: renderer rule erased placement geometry: {:?}",
                case.id, report.diagnostics
            ));
        }
        let mut known: HashSet<_> = corpus
            .rules
            .get(&case.diagram_type)
            .into_iter()
            .flatten()
            .map(|rule| rule.code.clone())
            .collect();
        known.extend(maru_diagram_engine::rules::geometry_rule_codes(
            &case.diagram_type,
        ));
        known.insert("document/diagram-type".into());
        for code in &expected.equivalent_codes {
            assert!(
                known.contains(code),
                "{}: unknown expected code {code} for {}",
                case.id,
                case.diagram_type
            );
            if !report
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == *code)
            {
                failures.push(format!(
                    "{}: required code {code} was not emitted; got {:?}",
                    case.id, report.diagnostics
                ));
            }
        }
        assert!(
            expected.accepted || !expected.equivalent_codes.is_empty(),
            "{}: rejection lacks a required code",
            case.id
        );
        for diagnostic in &report.diagnostics {
            assert!(
                !diagnostic.code.is_empty()
                    && !diagnostic.path.is_empty()
                    && !diagnostic.rule.is_empty(),
                "{}: incomplete diagnostic identity",
                case.id
            );
            assert!(
                !diagnostic.message.is_empty() && !diagnostic.fix.is_empty(),
                "{}: diagnostic lacks cause or fix",
                case.id
            );
            if [
                "dataflow/fixed-row-slots",
                "dataflow/stage-canvas-width",
                "lifecycle/reserved-main-lane",
            ]
            .contains(&diagnostic.code.as_str())
            {
                deferred.insert(diagnostic.code.clone());
            }
        }
    }
    assert!(
        failures.is_empty(),
        "Geometry differential counterexamples:\n{}",
        failures.join("\n")
    );
    assert_eq!(
        deferred.len(),
        3,
        "all three E1 geometry deferrals must now be actual rule agreements"
    );
    assert_eq!(
        measured_text_refusals,
        HashSet::from(["public-01".to_string()]),
        "only public-01 has a measured source-green text refusal in this corpus"
    );
}

#[test]
fn only_named_source_green_cases_can_refuse_for_measured_noto_ink_overflow() {
    let corpus: serde_json::Value =
        serde_json::from_str(include_str!("../testdata/parity.json")).unwrap();
    let dense: serde_json::Value =
        serde_json::from_str(include_str!("../testdata/dense-scenes.json")).unwrap();
    let mut observed = HashSet::new();

    for id in painted_ink::SOURCE_GREEN_INK_CASES {
        let (spec, diagram_type) = match *id {
            "public-01" => {
                let case = corpus["cases"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|case| case["id"] == *id)
                    .unwrap();
                assert_eq!(case["geometryComparison"]["accepted"], true);
                (
                    case["geometryComparison"]["inputJson"]
                        .as_str()
                        .unwrap()
                        .to_owned(),
                    case["diagramType"].as_str().unwrap().to_owned(),
                )
            }
            "gate-sequence-brand-absent" | "e2-boundary-sequence-brand-rail-7" => {
                let case = corpus["boundaryCases"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|case| case["id"] == *id)
                    .unwrap();
                assert_eq!(case["oracle"]["ok"], true);
                assert_eq!(case["geometryComparison"]["accepted"], true);
                (
                    case["geometryComparison"]["inputJson"]
                        .as_str()
                        .unwrap()
                        .to_owned(),
                    case["diagramType"].as_str().unwrap().to_owned(),
                )
            }
            "dense-workflow-seed-5502027" => {
                let case = dense["cases"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|case| case["id"] == *id)
                    .unwrap();
                let spec = case["spec"].to_string();
                assert!(
                    maru_diagram_engine::validate_json(&spec).ok,
                    "dense source fixture remains accepted"
                );
                (spec, "workflow".to_string())
            }
            other => panic!("source-green overflow case {other:?} is not wired to a fixture"),
        };
        let report = layout_json(&serde_json::json!({"specJson":spec}).to_string());
        assert!(
            !report.ok,
            "listed case {id} must retain its measured refusal"
        );
        painted_ink::assert_source_green_report(&report, id, &diagram_type);
        observed.insert(*id);
    }

    assert_eq!(observed.len(), painted_ink::SOURCE_GREEN_INK_CASES.len());
}

#[test]
fn lifecycle_v2_row_and_width_controls_remain_oracle_accepted() {
    let corpus: serde_json::Value =
        serde_json::from_str(include_str!("../testdata/parity.json")).unwrap();
    for suffix in [
        "v2-cross-row-same-side-positive",
        "v2-width-aware-column-positive",
    ] {
        let id = format!("e2-lifecycle-geometry-route-distance-{suffix}");
        let case = corpus["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|case| case["id"] == id)
            .unwrap_or_else(|| panic!("regenerate the pinned oracle corpus to restore {id}"));
        assert_eq!(case["oracle"]["ok"], true, "{id}: oracle must accept");
        assert_eq!(case["geometryComparison"]["accepted"], true);
        let input = case["geometryComparison"]["inputJson"].as_str().unwrap();
        let report = layout_json(&serde_json::json!({"specJson": input}).to_string());
        assert!(report.ok, "{id}: {:?}", report.diagnostics);
        let geometry = report.geometry.unwrap();
        assert_eq!(geometry.nodes.len(), 2);
        assert_eq!(geometry.routes.len(), 1);
    }
}
