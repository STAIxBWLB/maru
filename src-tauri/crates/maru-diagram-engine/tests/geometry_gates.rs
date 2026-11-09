//! Gate-off controls must be positively accepted, not merely agree false/false.
#![cfg(feature = "geometry")]
use maru_diagram_engine::layout::layout_json;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
#[test]
fn every_audited_gate_control_is_recorded_and_accepted_by_both_engines() {
    let corpus: Value = serde_json::from_str(include_str!("../testdata/parity.json")).unwrap();
    let audit = corpus["gateAdjustmentAudit"]
        .as_array()
        .expect("regenerate the audited gate corpus");
    assert_eq!(audit.len(), 132);
    let controls: BTreeMap<_, _> = corpus["boundaryCases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["boundary"]["expectedOracleAccepted"] == true)
        .map(|c| (c["id"].as_str().unwrap(), c))
        .collect();
    assert!(!controls.is_empty());
    let mut seen = BTreeSet::new();
    for row in audit {
        assert!(seen.insert(row["key"].as_str().unwrap()));
        assert!(!row["gate"].as_str().unwrap().is_empty());
        if row["requiresUngatedControl"] == true {
            assert!(!row["controlIds"].as_array().unwrap().is_empty());
        }
        for id in row["controlIds"].as_array().unwrap() {
            let id = id.as_str().unwrap();
            let case = controls
                .get(id)
                .unwrap_or_else(|| panic!("{} references missing control {id}", row["key"]));
            assert!(case["boundary"]["coveredAuditSites"]
                .as_array()
                .unwrap()
                .contains(&row["key"]));
        }
    }
    for (id, case) in &controls {
        assert_eq!(
            case["geometryComparison"]["accepted"], true,
            "{id}: the actual renderer must accept a gate-off control"
        );
        for reference in case["boundary"]["gateOnNegativeRefs"].as_array().unwrap() {
            let id = reference.as_str().unwrap();
            let active = corpus["cases"]
                .as_array()
                .unwrap()
                .iter()
                .chain(corpus["boundaryCases"].as_array().unwrap().iter())
                .find(|candidate| candidate["id"] == id)
                .unwrap_or_else(|| panic!("missing gate-on reference {id}"));
            assert_eq!(
                active.get("validityOracle").unwrap_or(&active["oracle"])["ok"],
                false,
                "{id}: a gate-on negative reference must contain an actual renderer refusal"
            );
        }
        let input = case["geometryComparison"]["inputJson"].as_str().unwrap();
        let report = layout_json(&serde_json::json!({"specJson":input}).to_string());
        assert!(
            report.ok,
            "{id}: engine refused ungated control: {:?}",
            report.diagnostics
        );
        assert!(report.geometry.is_some());
    }
    println!(
        "ENGINE_E2_GATES {}",
        serde_json::json!({"auditedRows":audit.len(),"acceptedControls":controls.len()})
    );
}
