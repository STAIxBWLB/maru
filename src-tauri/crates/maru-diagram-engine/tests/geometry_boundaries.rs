//! Exact format quantities gate acceptance; renderer-model differences are
//! measured evidence, not AC1 parity members or expected-verdict waivers.
#![cfg(feature = "geometry")]
use maru_diagram_engine::layout::layout_json;
use serde::Deserialize;
use std::collections::{BTreeMap, HashSet};
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Corpus {
    boundary_cases: Vec<Case>,
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
    boundary: Boundary,
    geometry_comparison: Comparison,
}
#[derive(Deserialize)]
struct Boundary {
    layer: String,
    category: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Comparison {
    input_json: String,
    accepted: bool,
    equivalent_codes: Vec<String>,
}
#[test]
fn exact_boundaries_agree_and_model_differences_are_reported() {
    let corpus: Corpus = serde_json::from_str(include_str!("../testdata/parity.json")).unwrap();
    assert!(
        !corpus.boundary_cases.is_empty(),
        "regenerate the host boundary corpus before running its checks"
    );
    let mut failures = Vec::new();
    let mut exact = 0;
    let mut models = BTreeMap::<String, serde_json::Value>::new();
    for case in corpus.boundary_cases {
        let expected = case.geometry_comparison;
        let report = layout_json(&serde_json::json!({"specJson":expected.input_json}).to_string());
        match case.boundary.layer.as_str() {
            "exact" => {
                exact += 1;
                if report.ok != expected.accepted {
                    failures.push(format!(
                        "{}: oracle accepted={} engine accepted={}, diagnostics {:?}",
                        case.id, expected.accepted, report.ok, report.diagnostics
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
                for code in expected.equivalent_codes {
                    assert!(
                        known.contains(&code),
                        "{} unknown expected code {code}",
                        case.id
                    );
                    if !report.diagnostics.iter().any(|d| d.code == code) {
                        failures.push(format!(
                            "{}: required {code} absent; got {:?}",
                            case.id, report.diagnostics
                        ));
                    }
                }
            }
            "model-difference" => {
                let entry=models.entry(case.boundary.category).or_insert_with(||serde_json::json!({"cases":0,"agreements":0,"oracleGreenEngineRefused":0,"oracleRedEngineAdmitted":0,"examples":[]}));
                entry["cases"] = serde_json::json!(entry["cases"].as_u64().unwrap() + 1);
                let key = if expected.accepted == report.ok {
                    "agreements"
                } else if expected.accepted {
                    "oracleGreenEngineRefused"
                } else {
                    "oracleRedEngineAdmitted"
                };
                entry[key] = serde_json::json!(entry[key].as_u64().unwrap() + 1);
                if expected.accepted != report.ok && entry["examples"].as_array().unwrap().len() < 6
                {
                    entry["examples"].as_array_mut().unwrap().push(serde_json::json!({"case":case.id,"oracleAccepted":expected.accepted,"engineAccepted":report.ok,"diagnosticCodes":report.diagnostics.iter().map(|d|&d.code).collect::<Vec<_>>()}));
                }
            }
            other => panic!("{} has unknown boundary layer {other}", case.id),
        }
    }
    println!(
        "ENGINE_E2_BOUNDARIES {}",
        serde_json::json!({"exactCases":exact,"exactFailures":failures.len(),"modelCategories":models})
    );
    assert!(
        failures.is_empty(),
        "Exact geometry boundary drift:\n{}",
        failures.join("\n")
    );
}
