//! E6 T1 (maru#554): the oracle is frozen into the corpus.
//!
//! Every corpus case carries the verdict the pinned Archify oracle returned,
//! recorded by `node scripts/diagram-engine-freeze-oracle.mjs --write` (the
//! `frozenOracle.command` below). E6 T2 removed that script with the sidecar,
//! so the command is provenance only and these recorded verdicts are the
//! oracle. The differential tests compare the engine
//! against these recorded verdicts only; no test runs a sidecar. This test
//! holds the frozen data to its own contract:
//! - the corpus names which oracle and pin produced it and how to reproduce it;
//! - every case says where its verdict came from (`label.source`);
//! - an oracle-labelled case keeps a full verdict and its comparison agrees
//!   with that verdict, so a later edit cannot silently flip one side;
//! - a case added after E6 is labelled `maru-engine` and names the PR that
//!   reviewed its expected result, since no oracle exists to label it.
use serde::Deserialize;
use serde_json::Value;

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
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    label: Option<Label>,
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
    oracle_layer: Option<String>,
    current_scope: Scope,
}

#[derive(Deserialize)]
struct Scope {
    kind: String,
}

fn corpus() -> Corpus {
    serde_json::from_str(include_str!("../testdata/parity.json")).unwrap()
}

#[test]
fn the_corpus_names_the_oracle_that_produced_it_and_how_to_reproduce_it() {
    let corpus = corpus();
    let frozen = &corpus.frozen_oracle;
    assert_eq!(frozen.id, "archify");
    assert_eq!(corpus.oracle["id"], frozen.id.as_str());
    assert_eq!(corpus.oracle["version"], frozen.version.as_str());
    assert_eq!(corpus.oracle["revision"], frozen.revision.as_str());
    assert_eq!(frozen.revision.len(), 40, "a full pinned commit");
    assert_eq!(frozen.pin_sha256.len(), 64, "the sha256 of the pin file");
    assert_eq!(
        frozen.command,
        "node scripts/diagram-engine-freeze-oracle.mjs --write"
    );
}

#[test]
fn every_case_is_labelled_and_oracle_cases_keep_a_consistent_frozen_verdict() {
    let corpus = corpus();
    let mut failures = Vec::new();
    let mut oracle_cases = 0;
    for case in corpus.cases.iter().chain(&corpus.boundary_cases) {
        let Some(label) = &case.label else {
            failures.push(format!(
                "{}: no label; record it with the freeze command",
                case.id
            ));
            continue;
        };
        match label.source.as_str() {
            "archify-oracle" => {
                oracle_cases += 1;
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
    assert!(
        failures.is_empty(),
        "Frozen oracle contract:\n{}",
        failures.join("\n")
    );
    assert!(
        oracle_cases >= 620,
        "the frozen corpus lost oracle cases: {oracle_cases}"
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

/// Removes `fields` from the named case of a corpus copy and returns the
/// contract failures; used by the deletion regressions below.
fn failures_after_removing(id: &str, fields: &[&str]) -> Vec<String> {
    let mut value: Value = serde_json::from_str(include_str!("../testdata/parity.json")).unwrap();
    let mut found = false;
    for list in ["cases", "boundaryCases"] {
        for case in value[list].as_array_mut().unwrap() {
            if case["id"] == id {
                found = true;
                let object = case.as_object_mut().unwrap();
                for field in fields {
                    object.remove(*field);
                }
            }
        }
    }
    assert!(found, "{id} is not in the corpus");
    let corpus: Corpus = serde_json::from_value(value).unwrap();
    let mut failures = Vec::new();
    for case in corpus.cases.iter().chain(&corpus.boundary_cases) {
        if case.id != id {
            continue;
        }
        if case.label.is_none() {
            failures.push("label missing".to_string());
        }
        let mut layers = vec![&case.oracle, &case.schema_oracle, &case.document_oracle];
        if case.validity_input_json.is_some() {
            layers.extend([
                &case.validity_oracle,
                &case.validity_schema_oracle,
                &case.validity_document_oracle,
            ]);
        }
        failures.extend(
            layers
                .iter()
                .filter(|layer| layer.is_none())
                .map(|_| "layer missing".to_string()),
        );
        if let Err(cause) = frozen_accepted(case) {
            failures.push(cause);
        }
    }
    failures
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
        assert!(
            !failures_after_removing(&public, &[field]).is_empty(),
            "removing {field} from {public} went unnoticed"
        );
    }
    let all = failures_after_removing(
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
            assert!(
                !failures_after_removing(&case.id, &[field]).is_empty(),
                "removing {field} from {} ({layer}) went unnoticed",
                case.id
            );
        }
    }
}
