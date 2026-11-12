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
    for case in corpus.cases {
        let expected = case.geometry_comparison;
        let request = serde_json::json!({"specJson":expected.input_json});
        let report = layout_json(&request.to_string());
        painted_ink::assert_accepted_text_ink_fits(&report);
        if report.ok != expected.accepted {
            if expected.accepted {
                failures.push(format!(
                    "{}: the engine refuses a case the reference model accepts, and auto-fit leaves no measured-ink refusal allowance: {:?}",
                    case.id, report.diagnostics
                ));
            } else {
                // Auto-fit accepts what the reference model refuses. That is the
                // point of the task (`maru#552` T6), but only for a case named
                // here and proved readable from the scene the engine emitted.
                let spec: serde_json::Value =
                    serde_json::from_str(&expected.input_json).expect("case input is JSON");
                let observed = painted_ink::assert_auto_fit_readable(&report, &spec, &case.id);
                match painted_ink::AUTO_FIT_BEYOND_MODEL
                    .iter()
                    .find(|(id, _)| *id == case.id)
                {
                    None => failures.push(format!(
                        "{}: engine accepts where the model refuses with no recorded auto-fit entry ({observed:?})",
                        case.id
                    )),
                    Some((_, recorded)) if observed != *recorded => failures.push(format!(
                        "{}: auto-fit actions changed, expected {recorded:?}, observed {observed:?}",
                        case.id
                    )),
                    Some(_) => {}
                }
            }
        }
        if expected.geometry_expected && report.geometry.is_none() {
            failures.push(format!(
                "{}: renderer rule erased placement geometry: {:?}",
                case.id, report.diagnostics
            ));
        }
        // A case auto-fit accepts beyond the model has that model's refusal code
        // recorded as required; the point of the entry is that it is gone.
        let beyond_model = painted_ink::AUTO_FIT_BEYOND_MODEL
            .iter()
            .any(|(id, _)| *id == case.id);
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
            if !beyond_model
                && !report
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
    assert!(
        painted_ink::SOURCE_GREEN_INK_CASES.is_empty(),
        "auto-fit makes every measured-ink overflow readable, so the allowance stays empty and any new refusal fails above"
    );
}

#[test]
fn only_recorded_cases_may_accept_beyond_the_reference_model() {
    let corpus: serde_json::Value =
        serde_json::from_str(include_str!("../testdata/parity.json")).unwrap();
    let mut failures = Vec::new();
    let mut observed = std::collections::BTreeSet::new();
    // Both verdict collections count: an auto-fit case and a boundary case are
    // the same claim - the engine accepts, the reference model refuses - and each
    // one needs its own entry and its own proof from real output.
    for collection in ["cases", "boundaryCases"] {
        for case in corpus[collection]
            .as_array()
            .unwrap_or_else(|| panic!("corpus collection {collection} is missing"))
        {
            let Some(expected) = case.get("geometryComparison") else {
                continue;
            };
            let Some(input) = expected["inputJson"].as_str() else {
                continue;
            };
            let report = layout_json(&serde_json::json!({"specJson": input}).to_string());
            if expected["accepted"] != serde_json::Value::Bool(false) || !report.ok {
                continue;
            }
            let id = case["id"].as_str().expect("case has an id").to_owned();
            let spec: serde_json::Value = serde_json::from_str(input).expect("case input is JSON");
            // Ink inside its own node and never below the readable floor: the
            // part of the proof that does not depend on how the case was won.
            painted_ink::assert_accepted_text_ink_fits(&report);
            painted_ink::assert_readable_floors(&report, &id);
            let actions = painted_ink::observed_auto_fit_actions(&report, &spec);
            match painted_ink::AUTO_FIT_BEYOND_MODEL
                .iter()
                .find(|(recorded, _)| *recorded == id)
            {
                Some((_, recorded)) => {
                    if actions != *recorded {
                        failures.push(format!(
                            "{id}: auto-fit actions changed, expected {recorded:?}, observed {actions:?}"
                        ));
                    }
                }
                None => {
                    if !painted_ink::BOUNDARY_ACCEPTED_BEFORE_AUTO_FIT.contains(&id.as_str()) {
                        failures.push(format!(
                            "{id}: engine accepts where the model refuses with no recorded entry ({actions:?})"
                        ));
                    } else if !actions.is_empty() {
                        failures.push(format!(
                            "{id}: recorded as a pre-auto-fit difference but now shows auto-fit actions {actions:?}"
                        ));
                    }
                }
            }
            observed.insert(id);
        }
    }
    assert!(
        failures.is_empty(),
        "Geometry acceptances beyond the reference model:\n{}",
        failures.join("\n")
    );
    let mut recorded: std::collections::BTreeSet<String> = painted_ink::AUTO_FIT_BEYOND_MODEL
        .iter()
        .map(|(id, _)| (*id).to_owned())
        .collect();
    recorded.extend(
        painted_ink::BOUNDARY_ACCEPTED_BEFORE_AUTO_FIT
            .iter()
            .map(|id| (*id).to_owned()),
    );
    assert_eq!(
        observed.len(),
        recorded.len(),
        "two recorded acceptances describe one case; keep each case in exactly one list: missing {:?}",
        recorded.difference(&observed).collect::<Vec<_>>()
    );
    assert_eq!(
        observed, recorded,
        "the recorded cases must be exactly the cases the engine accepts beyond the model"
    );
    assert!(
        !painted_ink::AUTO_FIT_BEYOND_MODEL.is_empty()
            && painted_ink::AUTO_FIT_BEYOND_MODEL
                .iter()
                .all(|(_, actions)| !actions.is_empty()),
        "every auto-fit acceptance names the actions that won it"
    );
}

#[test]
fn the_dense_workflow_seed_is_accepted_and_readable_after_auto_fit() {
    // The densest workflow fixture in the E1 seed set is where auto-fit has the
    // least room: 200 nodes, so a grown or shrunk label has neighbours on every
    // side. It has to come out accepted, with its ink inside its nodes and every
    // label at or above the readable floor - not merely without a refusal.
    let dense: serde_json::Value =
        serde_json::from_str(include_str!("../testdata/dense-scenes.json")).unwrap();
    let id = "dense-workflow-seed-5502027";
    let case = dense["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["id"] == id)
        .unwrap_or_else(|| panic!("regenerate the E1 dense seed set to restore {id}"));
    let spec = &case["spec"];
    let report = layout_json(&serde_json::json!({"specJson": spec.to_string()}).to_string());
    assert!(report.ok, "{id}: {:?}", report.diagnostics);
    let geometry = report
        .geometry
        .as_ref()
        .expect("an accepted scene keeps geometry");
    assert_eq!(
        geometry.nodes.len(),
        200,
        "{id}: every seeded node is placed"
    );
    painted_ink::assert_accepted_text_ink_fits(&report);
    painted_ink::assert_readable_floors(&report, id);
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
