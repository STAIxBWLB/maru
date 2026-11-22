//! E6 T1 (maru#554): the oracle is frozen into the corpus.
//!
//! Every corpus case carries the verdict the pinned Archify oracle returned,
//! recorded by `node scripts/diagram-engine-freeze-oracle.mjs --write` (the
//! `frozenOracle.command` below). The differential tests compare the engine
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
                let layers = [
                    ("oracle", &case.oracle),
                    ("schemaOracle", &case.schema_oracle),
                    ("documentOracle", &case.document_oracle),
                ];
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
                if let Some(expected) = frozen_accepted(case) {
                    if expected != case.comparison.accepted {
                        failures.push(format!(
                            "{}: comparison accepted={} but the frozen {} verdict says {}",
                            case.id,
                            case.comparison.accepted,
                            case.comparison.oracle_layer.as_deref().unwrap_or("full"),
                            expected
                        ));
                    }
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

/// The acceptance the frozen verdict implies for the layer the comparison was
/// derived from, when that layer decides it. Geometry probes and scoped
/// differences record their own reason and are checked by the differential
/// tests instead.
fn frozen_accepted(case: &Case) -> Option<bool> {
    if case.comparison.current_scope.kind != "document-validity" {
        return None;
    }
    let pick = |validity: &Option<Verdict>, plain: &Option<Verdict>| {
        validity
            .as_ref()
            .or(plain.as_ref())
            .map(|verdict| verdict.ok)
    };
    match case.comparison.oracle_layer.as_deref() {
        Some("schema") => pick(&case.validity_schema_oracle, &case.schema_oracle),
        Some("document-profile") => {
            // comparisonFor: a refused schema decides first, then a refused
            // document profile; geometry probes (document-valid) are accepted.
            let schema = pick(&case.validity_schema_oracle, &case.schema_oracle)?;
            let document = pick(&case.validity_document_oracle, &case.document_oracle)?;
            Some(schema && document)
        }
        Some("evidence-stripped-full") => case.validity_oracle.as_ref().map(|verdict| verdict.ok),
        Some("full") | None => case.oracle.as_ref().map(|verdict| verdict.ok),
        Some(_) => None,
    }
}
