//! E6 T1 (maru#554): the oracle is frozen into the corpus.
//!
//! Every corpus case carries the verdict the pinned Archify oracle returned,
//! recorded by `node scripts/diagram-engine-freeze-oracle.mjs --write` (the
//! `frozenOracle.command` below). E6 T2 removed that script with the sidecar,
//! so the command is provenance only and these recorded verdicts are the
//! oracle. The differential tests compare the engine
//! against these recorded verdicts only; no test runs a sidecar. This test
//! holds the frozen data to its own contract:
//! - the corpus names which oracle and pin produced it, and keeps the command
//!   that recorded it as provenance only (the script was removed in E6 T2);
//! - every case says where its verdict came from (`label.source`);
//! - an oracle-labelled case keeps a full verdict, its comparison agrees with
//!   the layer it was derived from, and `comparison.inputJson` is the input
//!   that layer judged (the evidence-stripped input for a public case);
//! - `frozenOracle.verdictsSha256` digests every oracle-labelled case's inputs,
//!   all six verdict layers (ok, codes and diagnostics) and its whole
//!   `comparison` (accepted, equivalentCodes, oracleLayer, oracleMapping,
//!   currentScope and inputJson) and `geometryComparison`, so any edit to a frozen verdict or to the expectation the
//!   engine is tested against fails, even one that keeps the case internally
//!   consistent;
//! - a case added after E6 is labelled `maru-engine` and names the PR that
//!   reviewed its expected result, since no oracle exists to label it.
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Corpus {
    frozen_oracle: FrozenOracle,
    oracle: Value,
    cases: Vec<Case>,
    boundary_cases: Vec<Case>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FrozenOracle {
    id: String,
    version: String,
    revision: String,
    pin_sha256: String,
    command: String,
    verdicts_sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    label: Option<Label>,
    input_json: String,
    validity_input_json: Option<String>,
    oracle: Option<Verdict>,
    schema_oracle: Option<Verdict>,
    document_oracle: Option<Verdict>,
    validity_oracle: Option<Verdict>,
    validity_schema_oracle: Option<Verdict>,
    validity_document_oracle: Option<Verdict>,
    comparison: Comparison,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Label {
    source: String,
    reviewed_in: Option<String>,
}

#[derive(Deserialize)]
struct Verdict {
    ok: bool,
    codes: Vec<String>,
    diagnostics: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Comparison {
    accepted: bool,
    input_json: String,
    oracle_layer: Option<String>,
    current_scope: Scope,
}

#[derive(Deserialize)]
struct Scope {
    kind: String,
}

const PARITY: &str = include_str!("../testdata/parity.json");

fn corpus() -> Corpus {
    serde_json::from_str(PARITY).unwrap()
}

/// The oracle-produced fields of one case that the digest covers.
const FROZEN_FIELDS: &[&str] = &[
    "id",
    "inputJson",
    "validityInputJson",
    "oracle",
    "schemaOracle",
    "documentOracle",
    "validityOracle",
    "validitySchemaOracle",
    "validityDocumentOracle",
    "comparison",
    "geometryComparison",
];

/// JSON with object keys sorted (independent of serde_json's map feature)
/// and non-integer numbers fixed to six decimals.
fn canonical(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let body: Vec<String> = keys
                .into_iter()
                .map(|key| format!("{}:{}", Value::from(key.as_str()), canonical(&map[key])))
                .collect();
            format!("{{{}}}", body.join(","))
        }
        Value::Array(items) => {
            let body: Vec<String> = items.iter().map(canonical).collect();
            format!("[{}]", body.join(","))
        }
        // serde_json's default float parsing may be off by one ulp, and a
        // dependency enabling `float_roundtrip` would change it; six decimals
        // keeps the digest independent of that (geometry is 1/64 px).
        Value::Number(number) if !number.is_i64() && !number.is_u64() => {
            format!("{:.6}", number.as_f64().unwrap_or(f64::NAN))
        }
        other => other.to_string(),
    }
}

/// sha256 over the frozen fields of every `archify-oracle` case, in corpus
/// order (`cases`, then `boundaryCases`). Absent fields are hashed as null.
fn verdicts_sha256(value: &Value) -> String {
    let mut hasher = Sha256::new();
    for list in ["cases", "boundaryCases"] {
        for case in value[list].as_array().into_iter().flatten() {
            if case["label"]["source"] != "archify-oracle" {
                continue;
            }
            let frozen: serde_json::Map<String, Value> = FROZEN_FIELDS
                .iter()
                .map(|field| {
                    (
                        field.to_string(),
                        case.get(*field).cloned().unwrap_or(Value::Null),
                    )
                })
                .collect();
            hasher.update(canonical(&Value::Object(frozen)).as_bytes());
            hasher.update(b"\n");
        }
    }
    format!("{:x}", hasher.finalize())
}

#[test]
fn the_corpus_names_the_oracle_that_produced_it_and_its_recording_command() {
    let corpus = corpus();
    let frozen = &corpus.frozen_oracle;
    assert_eq!(frozen.id, "archify");
    assert_eq!(corpus.oracle["id"], frozen.id.as_str());
    assert_eq!(corpus.oracle["version"], frozen.version.as_str());
    assert_eq!(corpus.oracle["revision"], frozen.revision.as_str());
    assert_eq!(frozen.revision.len(), 40, "a full pinned commit");
    let pin = include_bytes!("../testdata/legacy-archify-pin.json");
    assert_eq!(
        frozen.pin_sha256,
        format!("{:x}", Sha256::digest(pin)),
        "pinSha256 must be the sha256 of the kept legacy Archify pin; restore testdata/legacy-archify-pin.json from git history"
    );
    assert_eq!(
        frozen.command,
        "node scripts/diagram-engine-freeze-oracle.mjs --write"
    );
}

/// Every per-case contract failure in `corpus`. The main test and the
/// mutation regressions below both run exactly this.
fn contract_failures(corpus: &Corpus) -> Vec<String> {
    let mut failures = Vec::new();
    for case in corpus.cases.iter().chain(&corpus.boundary_cases) {
        let Some(label) = &case.label else {
            failures.push(format!(
                "{}: no label; add {{\"source\":\"maru-engine\",\"reviewedIn\":\"#<PR>\"}} for a case added after E6",
                case.id
            ));
            continue;
        };
        match label.source.as_str() {
            "archify-oracle" => {
                let mut layers = vec![
                    ("oracle", &case.oracle),
                    ("schemaOracle", &case.schema_oracle),
                    ("documentOracle", &case.document_oracle),
                ];
                // A public case also keeps its evidence-stripped verdicts; the
                // stripped input stays alongside, so all three are required.
                if case.validity_input_json.is_some() {
                    layers.extend([
                        ("validityOracle", &case.validity_oracle),
                        ("validitySchemaOracle", &case.validity_schema_oracle),
                        ("validityDocumentOracle", &case.validity_document_oracle),
                    ]);
                }
                for (name, verdict) in layers {
                    match verdict {
                        None => failures.push(format!("{}: frozen {name} missing", case.id)),
                        Some(verdict) => {
                            if verdict.codes.len() > verdict.diagnostics.len().max(1) {
                                failures.push(format!(
                                    "{}: {name} has more codes than diagnostics",
                                    case.id
                                ));
                            }
                            if !verdict.ok && verdict.codes.is_empty() {
                                failures.push(format!("{}: {name} refused with no code", case.id));
                            }
                        }
                    }
                }
                let judged = case
                    .validity_input_json
                    .as_ref()
                    .unwrap_or(&case.input_json);
                if &case.comparison.input_json != judged {
                    failures.push(format!(
                        "{}: comparison.inputJson is not the input its oracle layer judged",
                        case.id
                    ));
                }
                match frozen_accepted(case) {
                    Ok(Some(expected)) if expected != case.comparison.accepted => {
                        failures.push(format!(
                            "{}: comparison accepted={} but the frozen {} verdict says {}",
                            case.id,
                            case.comparison.accepted,
                            case.comparison.oracle_layer.as_deref().unwrap_or("full"),
                            expected
                        ));
                    }
                    Ok(_) => {}
                    Err(cause) => failures.push(format!("{}: {cause}", case.id)),
                }
            }
            "maru-engine" => {
                if !label
                    .reviewed_in
                    .as_deref()
                    .is_some_and(|pr| pr.starts_with('#') && pr.len() > 1)
                {
                    failures.push(format!(
                        "{}: an engine-labelled case must name its reviewing PR (reviewedIn: \"#123\")",
                        case.id
                    ));
                }
            }
            other => failures.push(format!("{}: unknown label source {other:?}", case.id)),
        }
    }
    failures
}

fn oracle_case_count(corpus: &Corpus) -> usize {
    corpus
        .cases
        .iter()
        .chain(&corpus.boundary_cases)
        .filter(|case| {
            case.label
                .as_ref()
                .is_some_and(|label| label.source == "archify-oracle")
        })
        .count()
}

#[test]
fn every_case_is_labelled_and_oracle_cases_keep_a_consistent_frozen_verdict() {
    let corpus = corpus();
    let failures = contract_failures(&corpus);
    assert!(
        failures.is_empty(),
        "Frozen oracle contract:\n{}",
        failures.join("\n")
    );
    let oracle_cases = oracle_case_count(&corpus);
    assert!(
        oracle_cases >= 620,
        "the frozen corpus lost oracle cases: {oracle_cases}"
    );
}

#[test]
fn the_frozen_verdicts_match_their_recorded_digest() {
    let value: Value = serde_json::from_str(PARITY).unwrap();
    let actual = verdicts_sha256(&value);
    assert_eq!(
        corpus().frozen_oracle.verdicts_sha256,
        actual,
        "a frozen archify-oracle field changed (inputs, the six verdict layers, comparison.{{accepted,equivalentCodes,oracleLayer,oracleMapping,currentScope,inputJson}} or geometryComparison); restore testdata/parity.json from git history, or add the new expectation as a maru-engine case reviewed in a PR"
    );
}

/// The scopes whose comparison records its own named reason instead of an
/// oracle layer; the differential tests check those by reason id.
const SCOPED_DIFFERENCES: &[&str] = &["e2-geometry", "e5-floorplan"];

/// The acceptance the frozen verdict implies for the layer the comparison was
/// derived from (the same choice as `comparisonFor` in
/// `scripts/diagram-engine-e1-cases.mjs`). `Ok(None)` only for a named scoped
/// difference; a document-validity case whose layer or verdict is missing is
/// an error, never a skipped comparison.
fn frozen_accepted(case: &Case) -> Result<Option<bool>, String> {
    let scope = case.comparison.current_scope.kind.as_str();
    if scope != "document-validity" {
        return if SCOPED_DIFFERENCES.contains(&scope) {
            Ok(None)
        } else {
            Err(format!("unknown comparison scope {scope:?}"))
        };
    }
    let verdict = |name: &str, layer: &Option<Verdict>| {
        layer
            .as_ref()
            .map(|verdict| verdict.ok)
            .ok_or_else(|| format!("comparison needs the frozen {name}, which is missing"))
    };
    let public = case.validity_input_json.is_some();
    let schema = || {
        if public {
            verdict("validitySchemaOracle", &case.validity_schema_oracle)
        } else {
            verdict("schemaOracle", &case.schema_oracle)
        }
    };
    let document = || {
        if public {
            verdict("validityDocumentOracle", &case.validity_document_oracle)
        } else {
            verdict("documentOracle", &case.document_oracle)
        }
    };
    let accepted = match case.comparison.oracle_layer.as_deref() {
        Some("schema") => schema()?,
        // A refused schema decides first, then a refused document profile;
        // geometry probes (document-valid) compare as accepted.
        Some("document-profile") => schema()? && document()?,
        Some("evidence-stripped-full") => verdict("validityOracle", &case.validity_oracle)?,
        Some("full") => verdict("oracle", &case.oracle)?,
        Some(other) => return Err(format!("unknown oracle layer {other:?}")),
        None => return Err("document-validity comparison names no oracleLayer".to_string()),
    };
    Ok(Some(accepted))
}

/// What each guard reports after an edit, kept apart so one guard can never
/// stand in for the other in a regression.
struct Outcome {
    /// `contract_failures` for the edited case only.
    contract: Vec<String>,
    /// Whether `verdicts_sha256` moved.
    digest_changed: bool,
}

/// Applies `edit` to the named case of a corpus copy and runs both guards.
fn outcome_after(id: &str, edit: impl Fn(&mut serde_json::Map<String, Value>)) -> Outcome {
    let mut value: Value = serde_json::from_str(PARITY).unwrap();
    let recorded = verdicts_sha256(&value);
    let mut found = false;
    for list in ["cases", "boundaryCases"] {
        for case in value[list].as_array_mut().unwrap() {
            if case["id"] == id {
                found = true;
                edit(case.as_object_mut().unwrap());
            }
        }
    }
    assert!(found, "{id} is not in the corpus");
    let digest_changed = verdicts_sha256(&value) != recorded;
    let corpus: Corpus = serde_json::from_value(value).unwrap();
    let prefix = format!("{id}:");
    let contract = contract_failures(&corpus)
        .into_iter()
        .filter(|failure| failure.starts_with(&prefix))
        .collect();
    Outcome {
        contract,
        digest_changed,
    }
}

/// The contract failures after removing `fields`; the digest is not consulted.
fn contract_after_removing(id: &str, fields: &[&str]) -> Vec<String> {
    outcome_after(id, |case| {
        for field in fields {
            case.remove(*field);
        }
    })
    .contract
}

/// Asserts that only the digest catches an edit: the contract stays clean,
/// so the regression fails if the digest guard is removed.
fn assert_digest_only(id: &str, what: &str, edit: impl Fn(&mut serde_json::Map<String, Value>)) {
    let outcome = outcome_after(id, edit);
    assert!(
        outcome.contract.is_empty(),
        "{what}: the edit must stay contract-consistent so only the digest can catch it: {:?}",
        outcome.contract
    );
    assert!(outcome.digest_changed, "{what} on {id} went unnoticed");
}

/// Flips a verdict layer consistently: `ok` together with matching codes and
/// diagnostics, so the per-layer contract rules still hold.
fn flip_layer(case: &mut serde_json::Map<String, Value>, layer: &str) {
    let verdict = case.get_mut(layer).unwrap();
    if verdict["ok"].as_bool().unwrap() {
        verdict["ok"] = Value::Bool(false);
        verdict["codes"] = serde_json::json!(["edited/code"]);
        verdict["diagnostics"] = serde_json::json!([{"code": "edited/code"}]);
    } else {
        verdict["ok"] = Value::Bool(true);
        verdict["codes"] = serde_json::json!([]);
        verdict["diagnostics"] = serde_json::json!([]);
    }
}

#[test]
fn deleting_a_public_case_validity_layer_fails_the_contract() {
    let public = corpus()
        .cases
        .into_iter()
        .find(|case| case.validity_input_json.is_some())
        .expect("a public case")
        .id;
    for field in [
        "validityOracle",
        "validitySchemaOracle",
        "validityDocumentOracle",
    ] {
        let contract = contract_after_removing(&public, &[field]);
        assert!(
            contract
                .iter()
                .any(|failure| failure.contains(&format!("frozen {field} missing"))),
            "removing {field} from {public} went unnoticed by the contract: {contract:?}"
        );
    }
    let all = contract_after_removing(
        &public,
        &[
            "validityOracle",
            "validitySchemaOracle",
            "validityDocumentOracle",
        ],
    );
    assert!(all.len() >= 3, "{all:?}");
}

#[test]
fn deleting_a_verdict_or_label_of_any_layer_fails_the_contract() {
    let corpus = corpus();
    for layer in ["schema", "document-profile", "full"] {
        let case = corpus
            .cases
            .iter()
            .find(|case| case.comparison.oracle_layer.as_deref() == Some(layer))
            .unwrap_or_else(|| panic!("a {layer} case"));
        for field in ["oracle", "schemaOracle", "documentOracle", "label"] {
            let contract = contract_after_removing(&case.id, &[field]);
            let expected = if field == "label" {
                "no label".to_string()
            } else {
                format!("frozen {field} missing")
            };
            assert!(
                contract.iter().any(|failure| failure.contains(&expected)),
                "removing {field} from {} ({layer}) went unnoticed by the contract: {contract:?}",
                case.id
            );
        }
    }
}

#[test]
fn a_consistent_edit_to_a_frozen_verdict_still_fails() {
    let corpus = corpus();
    let case = corpus
        .cases
        .iter()
        .find(|case| case.comparison.oracle_layer.as_deref() == Some("full"))
        .expect("a full-layer case");
    assert_digest_only(&case.id, "a verdict flipped with its comparison", |case| {
        flip_layer(case, "oracle");
        let accepted = case["comparison"]["accepted"].as_bool().unwrap();
        case.get_mut("comparison").unwrap()["accepted"] = Value::Bool(!accepted);
    });
    assert_digest_only(
        &case.id,
        "a flip of a layer the comparison does not read",
        |case| {
            flip_layer(case, "schemaOracle");
        },
    );
    assert_digest_only(&case.id, "a codes and diagnostics edit", |case| {
        let verdict = case.get_mut("oracle").unwrap();
        let code = if verdict["ok"].as_bool().unwrap() {
            "edited/warning"
        } else {
            "edited/code"
        };
        verdict["codes"] = serde_json::json!([code]);
        verdict["diagnostics"] = serde_json::json!([{ "code": code }]);
    });
    let input = outcome_after(&case.id, |case| {
        case.get_mut("comparison").unwrap()["inputJson"] = Value::from("{}");
    });
    assert!(
        input
            .contract
            .iter()
            .any(|failure| failure.contains("comparison.inputJson")),
        "{:?}",
        input.contract
    );
}

#[test]
fn loosening_the_comparison_expectation_still_fails() {
    let corpus = corpus();
    let full = corpus
        .cases
        .iter()
        .find(|case| {
            case.comparison.current_scope.kind == "document-validity"
                && case.comparison.oracle_layer.as_deref() == Some("full")
        })
        .expect("a document-validity case");
    // Each edit below changes exactly one comparison field and stays
    // contract-consistent, so only the digest can catch it.
    // Rescope alone: a named difference is not compared by the contract.
    assert_digest_only(&full.id, "a rescoped comparison", |case| {
        case.get_mut("comparison").unwrap()["currentScope"] =
            serde_json::json!({"kind": "e2-geometry", "reasonId": "edited", "reason": "edited"});
    });
    // Repoint oracleLayer alone, to a layer whose frozen verdict equals the
    // full one, so `accepted` still matches.
    let repointed = corpus
        .cases
        .iter()
        .find(|case| {
            case.comparison.current_scope.kind == "document-validity"
                && case.validity_input_json.is_none()
                && case.comparison.oracle_layer.as_deref() == Some("full")
                && case.schema_oracle.as_ref().map(|verdict| verdict.ok)
                    == case.oracle.as_ref().map(|verdict| verdict.ok)
        })
        .expect("a full-layer case whose schema verdict is the same");
    assert_digest_only(&repointed.id, "a repointed oracleLayer", |case| {
        case.get_mut("comparison").unwrap()["oracleLayer"] = Value::from("schema");
    });
    // Equivalent codes the differential tests match against.
    assert_digest_only(&full.id, "an equivalentCodes edit", |case| {
        case.get_mut("comparison").unwrap()["equivalentCodes"] = serde_json::json!(["edited/code"]);
    });
}

#[test]
fn loosening_the_geometry_expectation_still_fails() {
    let corpus = corpus();
    // A boundary case, so omitting boundaryCases from the digest is caught too.
    let id = corpus
        .boundary_cases
        .first()
        .expect("a boundary case")
        .id
        .clone();
    assert_digest_only(&id, "a flipped geometryComparison.accepted", |case| {
        let geometry = case.get_mut("geometryComparison").unwrap();
        let accepted = geometry["accepted"].as_bool().unwrap();
        geometry["accepted"] = Value::Bool(!accepted);
    });
    assert_digest_only(&id, "a geometryComparison.equivalentCodes edit", |case| {
        case.get_mut("geometryComparison").unwrap()["equivalentCodes"] =
            serde_json::json!(["edited/code"]);
    });
}

#[test]
fn a_public_case_comparison_must_judge_the_evidence_stripped_input() {
    let corpus = corpus();
    let public = corpus
        .cases
        .iter()
        .find(|case| case.validity_input_json.is_some())
        .expect("a public case");
    let original = public.input_json.clone();
    let failures = outcome_after(&public.id, move |case| {
        case.get_mut("comparison").unwrap()["inputJson"] = Value::from(original.clone());
    })
    .contract;
    assert!(
        failures
            .iter()
            .any(|failure| failure.contains("comparison.inputJson")),
        "{failures:?}"
    );
}
