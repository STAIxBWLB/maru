//! The host port against hwp-editor's own parsers. Every row of `parity.json`
//! was recorded by `scripts/record-hwped-form-parity.mjs` running the upstream
//! functions (hwp-editor 7c430d2, `packages/core/src/forms.ts`) on a fixed
//! corpus. Regenerate by running upstream again, never by hand.

use super::*;

#[test]
fn every_parser_matches_the_recorded_upstream_outputs() {
    let rows: Vec<Value> = serde_json::from_str(include_str!("parity.json")).unwrap();
    assert!(
        rows.len() >= 100,
        "the recorded corpus shrank: {}",
        rows.len()
    );
    for (index, row) in rows.iter().enumerate() {
        let input = &row["input"];
        let actual = match row["fn"].as_str().unwrap() {
            "discovery" => parse_discovery(input),
            "plan" => parse_plan(input),
            "values" => validate_values(&row["plan"], input).map(Value::Object),
            "receipt" => parse_receipt(input),
            "preview" => parse_preview(input),
            other => panic!("unknown recorded parser {other}"),
        };
        let label = format!("row {index} ({}): {input}", row["fn"]);
        if row["ok"] == true {
            let output = actual.unwrap_or_else(|error| panic!("{label}: refused at {}", error.0));
            assert_eq!(output, row["output"], "{label}");
            // Same keys in the same order, not only equal maps.
            assert_eq!(output.to_string(), row["output"].to_string(), "{label}");
        } else {
            let error = actual.expect_err(&label);
            assert_eq!(error.0, row["path"].as_str().unwrap(), "{label}");
        }
    }
}

#[test]
fn a_preview_never_carries_native_warnings_across_the_bridge() {
    let rows: Vec<Value> = serde_json::from_str(include_str!("parity.json")).unwrap();
    let with_paths = rows
        .iter()
        .find(|row| {
            row["fn"] == "preview"
                && row["input"]["native_warnings"]
                    .as_array()
                    .is_some_and(|warnings| {
                        warnings
                            .iter()
                            .any(|w| w.as_str().is_some_and(|w| w.contains("/Users/")))
                    })
        })
        .expect("the corpus has a path-bearing native warning");
    let output = parse_preview(&with_paths["input"]).unwrap();
    assert_eq!(output["native_warnings"], serde_json::json!([]));
    assert!(!output.to_string().contains("/Users/"), "{output}");
    assert!(!output.to_string().contains("C:\\\\Users"), "{output}");
}
