use super::*;

fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_string()).collect()
}

#[test]
fn legacy_edit_flags_are_closed_to_safe_operations() {
    assert_eq!(LEGACY_EDIT_FLAGS.len(), 26);
    for flag in LEGACY_EDIT_FLAGS {
        validate_legacy_edit_args(&args(&[flag, "value"])).unwrap();
    }
    validate_legacy_edit_args(&args(&[
        "--replace",
        "old=>new",
        "--set-cell",
        "0:1:2=내용",
        "--set-format",
        "word:bold=on",
        "--replace",
        "text=>--allow-partial",
    ]))
    .unwrap();
}

#[test]
fn legacy_control_and_file_flags_are_rejected_before_any_document_or_cli_access() {
    for flag in [
        "--report",
        "--report=/tmp/report",
        "--ops",
        "--output",
        "-o",
        "--verify",
        "--allow-partial",
        "--password",
        "--help",
        "--",
        "--insert-image",
        "--seal",
        "--unknown-operation",
    ] {
        let argv = args(&[flag, "fixture-only-path"]);
        let error = validate_legacy_edit_args(&argv).unwrap_err();
        assert!(
            error.starts_with("hwped_bad_request: opsArgv flag"),
            "{error}"
        );
        assert!(error.contains(flag), "{error}");
        let document = HwpedDocumentRef {
            name: "fixture.hwpx".to_string(),
            path: None,
            data_base64: None,
        };
        let command_error = edit_now(
            document,
            Some(serde_json::json!(argv)),
            None,
            None,
            None,
            None,
        )
        .unwrap_err()
        .to_string();
        assert_eq!(
            command_error, error,
            "rejection must precede CLI discovery and staging"
        );
    }
}

#[test]
fn legacy_values_cannot_smuggle_boolean_or_output_options() {
    for value in [
        "--allow-partial",
        "--verify",
        "--report=/tmp/report",
        "-o",
        "--ops",
        "-",
    ] {
        let error = validate_legacy_edit_args(&args(&["--replace", value])).unwrap_err();
        assert!(
            error.contains("value starts with a CLI option prefix"),
            "{error}"
        );
        assert!(error.contains("JSON ops channel"), "{error}");
    }
    assert!(validate_legacy_edit_args(&args(&["--replace"]))
        .unwrap_err()
        .contains("--flag value pairs"));
}
