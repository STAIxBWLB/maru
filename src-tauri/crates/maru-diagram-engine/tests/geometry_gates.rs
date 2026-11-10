//! Keep source gate-off controls intact while refusing actual painted overflow.
#![cfg(feature = "geometry")]
use maru_diagram_engine::layout::layout_json;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
#[path = "support/painted_ink.rs"]
mod painted_ink;
#[test]
fn audited_controls_preserve_source_verdicts_and_check_actual_text_bounds() {
    let corpus: Value = serde_json::from_str(include_str!("../testdata/parity.json")).unwrap();
    let audit = corpus["gateAdjustmentAudit"]
        .as_array()
        .expect("regenerate the audited gate corpus");
    assert_eq!(audit.len(), 132);
    let controls: BTreeMap<_, _> = corpus["boundaryCases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| {
            matches!(
                c["boundary"]["category"].as_str(),
                Some("ungated-control" | "adjustment-control")
            )
        })
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
    let mut measured_text_refusals = 0;
    let mut measured_text_refusal_ids = BTreeSet::new();
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
        painted_ink::assert_accepted_text_ink_fits(&report);
        if !report.ok {
            measured_text_refusals += 1;
            measured_text_refusal_ids.insert(id.to_owned());
            painted_ink::assert_source_green_overflow_exception(
                &report,
                id,
                case["diagramType"].as_str().unwrap(),
            );
        }
        assert!(report.geometry.is_some());
    }
    assert_eq!(
        measured_text_refusal_ids,
        BTreeSet::from(["gate-sequence-brand-absent"]),
        "only the named sequence gate control may have measured text overflow"
    );
    println!(
        "ENGINE_E2_GATES {}",
        serde_json::json!({"auditedRows":audit.len(),"sourceAcceptedControls":controls.len(),"engineAcceptedControls":controls.len()-measured_text_refusals,"measuredTextRefusals":measured_text_refusals})
    );
}
