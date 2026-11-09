//! Host-generated renderer verdicts; the standalone SDK uses neither Node nor Archify.
#![cfg(feature = "geometry")]
use maru_diagram_engine::layout::layout_json;
use serde::Deserialize;
use std::collections::{BTreeMap, HashSet};

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
fn renderer_verdicts_have_equivalent_geometry_rules_and_preserve_placed_scenes() {
    let corpus: Corpus = serde_json::from_str(include_str!("../testdata/parity.json")).unwrap();
    let mut failures = Vec::new();
    let mut deferred = HashSet::new();
    for case in corpus.cases {
        let expected = case.geometry_comparison;
        let request = serde_json::json!({"specJson":expected.input_json});
        let report = layout_json(&request.to_string());
        if report.ok != expected.accepted {
            failures.push(format!(
                "{}: expected ok={}, got {:?}",
                case.id, expected.accepted, report.diagnostics
            ));
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
}
