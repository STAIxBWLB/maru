//! `hwped_edit` forwards a refused edit's structured `edit-report-v1` 1.1
//! refusal (maru#620). A fake engine replays exact ahwp 2.0.0 reports
//! (`refusal_reports/`), so the test drives the real `edit_now` path: the
//! `--report` flag, the read before the stage dir is removed, sanitizing and
//! the rejection shape hwp-editor's Tauri client reads.

use super::*;
use std::path::{Path, PathBuf};

const UNAPPLIED_REPORT: &str = include_str!("refusal_reports/unapplied-replace.json");
const UNAPPLIED_STDERR: &str = include_str!("refusal_reports/unapplied-replace.stderr.txt");
const FONT_REPORT: &str = include_str!("refusal_reports/preservation-font.json");
const FONT_STDERR: &str = include_str!("refusal_reports/preservation-font.stderr.txt");

struct BinEnv {
    _lock: std::sync::MutexGuard<'static, ()>,
}

impl BinEnv {
    fn set(bin: &Path) -> Self {
        let lock = super::PHASE08_21_ENV_LOCK
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        std::env::set_var("MARU_HWP_BIN", bin);
        Self { _lock: lock }
    }
}

impl Drop for BinEnv {
    fn drop(&mut self) {
        std::env::remove_var("MARU_HWP_BIN");
    }
}

/// What the fake engine does on `edit`.
enum Edit<'a> {
    /// Refuse, writing `report` (with `{STAGE}` replaced by the stage dir) to
    /// the `--report` path when one is given.
    Refuse { report: &'a str, stderr: &'a str },
    /// Refuse without writing any report.
    RefuseWithoutReport { stderr: &'a str },
    /// Succeed, writing the output and a report when asked.
    Succeed,
}

/// A fake `hwp` reporting `version`. It records each invocation, so a test
/// can see whether `--report` was passed.
fn engine(version: &str, edit: Edit<'_>) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let binary = dir.path().join("hwp");
    let report_file = dir.path().join("report.json");
    let stderr_file = dir.path().join("stderr.txt");
    let action = match edit {
        Edit::Refuse { report, stderr } => {
            std::fs::write(&report_file, report).unwrap();
            std::fs::write(&stderr_file, stderr).unwrap();
            "refuse"
        }
        Edit::RefuseWithoutReport { stderr } => {
            std::fs::write(&stderr_file, stderr).unwrap();
            "bare"
        }
        Edit::Succeed => "ok",
    };
    let script = format!(
        r#"#!/bin/sh
here="$(dirname "$0")"
printf '%s\n' "$*" >> "$here/invocations"
if [ "$1" = "--version" ]; then echo "ahwp {version}"; exit 0; fi
[ "$1" = "edit" ] || exit 2
out=""; report=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) shift; out="$1" ;;
    --report) shift; report="$1" ;;
  esac
  shift
done
stage="$(dirname "$out")"
case "{action}" in
  refuse)
    if [ -n "$report" ]; then sed "s|{{STAGE}}|$stage|g" "$here/report.json" > "$report"; fi
    cat "$here/stderr.txt" >&2; exit 1 ;;
  bare) cat "$here/stderr.txt" >&2; exit 1 ;;
  ok)
    printf 'edited' > "$out"
    if [ -n "$report" ]; then printf '{{"schema_version":"1.1","contract":"hwp-edit-report-v1","output":"%s","dry_run":false,"ops":[],"applied_count":0,"failed_count":0}}' "$out" > "$report"; fi
    exit 0 ;;
esac
"#
    );
    crate::test_support::write_executable_fixture(&binary, &script, 0o755).unwrap();
    (dir, binary)
}

fn document() -> HwpedDocumentRef {
    HwpedDocumentRef {
        name: "보고서.hwpx".to_string(),
        path: None,
        data_base64: Some(BASE64.encode(b"document bytes")),
    }
}

fn replace_argv() -> Value {
    serde_json::json!(["--replace", "absent string=>y"])
}

/// The edit as a client that reads refused edit reports sends it:
/// `structuredRefusal: true`.
fn refused_edit(document: HwpedDocumentRef) -> Result<HwpedEditResponse, HwpedBridgeError> {
    edit_now(
        document,
        EditRequest {
            ops_argv: Some(replace_argv()),
            structured_refusal: true,
            ..EditRequest::default()
        },
        None,
    )
}

fn refused(error: HwpedBridgeError) -> HwpedRefusedEdit {
    match error {
        HwpedBridgeError::RefusedEdit(refused) => refused,
        other => panic!("expected a structured refusal, got {other:?}"),
    }
}

#[test]
fn an_unmatched_replace_rejects_with_the_engines_refusal_report() {
    let (fixture, binary) = engine(
        "2.0.0",
        Edit::Refuse {
            report: UNAPPLIED_REPORT,
            stderr: UNAPPLIED_STDERR,
        },
    );
    let _env = BinEnv::set(&binary);
    let error = refused_edit(document()).unwrap_err();
    let refused = refused(error);
    assert_eq!(refused.code, "failed");
    assert_eq!(refused.engine_version, "2.0.0");
    // The legacy string is kept unchanged as the message, so a client that does
    // not read `report` classifies the refusal exactly as before.
    assert!(
        refused
            .message
            .starts_with("hwp_failed: hwp edit failed (exit 1) [work dir \""),
        "{}",
        refused.message
    );
    assert!(refused
        .message
        .contains("적용되지 않은 편집 요청이 있습니다"));
    assert_eq!(refused.report["refusal"]["code"], "unapplied_requests");
    assert_eq!(refused.report["ops"][0]["op"], "replace");
    assert_eq!(refused.report["ops"][0]["status"], "failed");
    // The caller's name replaces the staged output path.
    assert_eq!(refused.report["output"], "보고서.hwpx");
    let invocations = std::fs::read_to_string(fixture.path().join("invocations")).unwrap();
    assert!(invocations.contains(" --report "), "{invocations}");
    assert!(invocations.contains("edit-report.json"), "{invocations}");
}

#[test]
fn a_font_preservation_refusal_keeps_its_event_codes() {
    let (_fixture, binary) = engine(
        "2.0.0",
        Edit::Refuse {
            report: FONT_REPORT,
            stderr: FONT_STDERR,
        },
    );
    let _env = BinEnv::set(&binary);
    let error = refused_edit(document()).unwrap_err();
    let refused = refused(error);
    assert_eq!(refused.report["refusal"]["code"], "preservation_loss");
    assert_eq!(
        refused.report["refusal"]["values"]["events"][0]["code"],
        "font_type_info_unrepresentable"
    );
}

#[test]
fn the_rejection_serializes_as_the_object_hwp_editor_reads() {
    let (_fixture, binary) = engine(
        "2.0.0",
        Edit::Refuse {
            report: UNAPPLIED_REPORT,
            stderr: UNAPPLIED_STDERR,
        },
    );
    let _env = BinEnv::set(&binary);
    let error = refused_edit(document()).unwrap_err();
    let wire = serde_json::to_value(&error).unwrap();
    // `toEngineError` in @hwp-editor/core reads exactly these keys.
    assert_eq!(wire["code"], "failed");
    assert!(wire["message"].as_str().unwrap().starts_with("hwp_failed:"));
    assert_eq!(wire["engineVersion"], "2.0.0");
    assert_eq!(wire["report"]["refusal"]["code"], "unapplied_requests");
    assert_eq!(wire.as_object().unwrap().len(), 4, "{wire}");
}

#[test]
fn staging_paths_are_removed_from_report_diagnostics() {
    // A report whose diagnostics name the stage dir, as a real engine's can.
    let report = serde_json::json!({
        "schema_version": "1.1",
        "contract": "hwp-edit-report-v1",
        "output": "{STAGE}/out.hwpx",
        "dry_run": false,
        "ops": [{
            "index": 0, "op": "insert_blocks", "status": "failed", "pieces_touched": 0,
            "changed": [], "reason": "cannot read {STAGE}/in.hwpx",
            "refusal": {"code": "insert_blocks.invalid_definition",
                "values": {"style": "{STAGE}-is-a-style-name", "detail": "at {STAGE}/x"},
                "message": "invalid at {STAGE}/y"}
        }],
        "applied_count": 0,
        "failed_count": 1,
        "refusal": {"code": "insert_blocks.invalid_definition",
            "values": {"issues": [{"path": ["{STAGE}"], "message": "bad {STAGE}/z"}]},
            "message": "refused in {STAGE}"}
    })
    .to_string();
    let (_fixture, binary) = engine(
        "2.0.0",
        Edit::Refuse {
            report: &report,
            stderr: "Error: refused",
        },
    );
    let _env = BinEnv::set(&binary);
    let error = refused_edit(document()).unwrap_err();
    let report = refused(error).report;
    assert_eq!(report["output"], "보고서.hwpx");
    let op = &report["ops"][0];
    assert_eq!(op["reason"], "cannot read <work dir>/in.hwpx");
    assert_eq!(op["refusal"]["message"], "invalid at <work dir>/y");
    assert_eq!(op["refusal"]["values"]["detail"], "at <work dir>/x");
    assert_eq!(report["refusal"]["message"], "refused in <work dir>");
    assert_eq!(
        report["refusal"]["values"]["issues"][0]["message"],
        "bad <work dir>/z"
    );
    // User-valued identifiers are data, not diagnostics: they stay exact.
    let style = op["refusal"]["values"]["style"].as_str().unwrap();
    assert!(
        style.ends_with("-is-a-style-name")
            && !style.starts_with("<work dir>")
            && !style.starts_with("<path>")
    );
    assert!(!report["refusal"]["values"]["issues"][0]["path"][0]
        .as_str()
        .unwrap()
        .contains("<work dir>"));
}

#[test]
fn engines_before_1_6_3_get_no_report_flag_and_keep_the_string_error() {
    let (fixture, binary) = engine(
        "1.6.2",
        Edit::Refuse {
            report: UNAPPLIED_REPORT,
            stderr: UNAPPLIED_STDERR,
        },
    );
    let _env = BinEnv::set(&binary);
    let error = refused_edit(document()).unwrap_err();
    assert!(
        matches!(error, HwpedBridgeError::Legacy(ref message) if message.starts_with("hwp_failed:")),
        "{error:?}"
    );
    let invocations = std::fs::read_to_string(fixture.path().join("invocations")).unwrap();
    assert!(!invocations.contains("--report"), "{invocations}");
}

#[test]
fn a_refusal_without_a_report_keeps_the_string_error() {
    let (_fixture, binary) = engine(
        "2.0.0",
        Edit::RefuseWithoutReport {
            stderr: UNAPPLIED_STDERR,
        },
    );
    let _env = BinEnv::set(&binary);
    let error = refused_edit(document()).unwrap_err();
    assert!(
        matches!(error, HwpedBridgeError::Legacy(ref message) if message.starts_with("hwp_failed:")),
        "{error:?}"
    );
}

#[test]
fn an_unreadable_report_keeps_the_string_error() {
    let (_fixture, binary) = engine(
        "2.0.0",
        Edit::Refuse {
            report: "not json",
            stderr: UNAPPLIED_STDERR,
        },
    );
    let _env = BinEnv::set(&binary);
    let error = refused_edit(document()).unwrap_err();
    assert!(matches!(error, HwpedBridgeError::Legacy(_)), "{error:?}");
}

#[test]
fn a_successful_edit_is_unchanged_with_the_report_requested() {
    let (fixture, binary) = engine("2.0.0", Edit::Succeed);
    let _env = BinEnv::set(&binary);
    let response = refused_edit(document()).unwrap();
    assert_eq!(response.name, "보고서.hwpx");
    assert_eq!(BASE64.decode(response.data_base64).unwrap(), b"edited");
    let invocations = std::fs::read_to_string(fixture.path().join("invocations")).unwrap();
    assert!(invocations.contains(" --report "), "{invocations}");
}

/// Writes the exact wire objects this host rejects with, so the client-side
/// check in hwp-editor can classify them (run with MARU_HWPED_WIRE_OUT=<dir>).
#[test]
fn record_the_wire_rejections_for_the_client_check() {
    let Some(out) = std::env::var_os("MARU_HWPED_WIRE_OUT") else {
        return;
    };
    for (name, report, stderr) in [
        ("unapplied-replace", UNAPPLIED_REPORT, UNAPPLIED_STDERR),
        ("preservation-font", FONT_REPORT, FONT_STDERR),
    ] {
        let (_fixture, binary) = engine("2.0.0", Edit::Refuse { report, stderr });
        let _env = BinEnv::set(&binary);
        let error = refused_edit(document()).unwrap_err();
        let wire = serde_json::to_vec_pretty(&error).unwrap();
        std::fs::write(Path::new(&out).join(format!("{name}.wire.json")), wire).unwrap();
    }
}

#[test]
fn a_client_that_did_not_signal_structured_refusals_keeps_the_string_error() {
    // Released core (maru pins 1.4.0) sends `report: true` for preset batches
    // and block inserts but never `structuredRefusal`; its object branch skips
    // the string classifier, so it must keep getting the string.
    let (fixture, binary) = engine(
        "2.0.0",
        Edit::Refuse {
            report: UNAPPLIED_REPORT,
            stderr: UNAPPLIED_STDERR,
        },
    );
    let _env = BinEnv::set(&binary);
    let error =
        edit_legacy_now(document(), Some(replace_argv()), None, None, None, None).unwrap_err();
    assert!(
        matches!(error, HwpedBridgeError::Legacy(ref message) if message.starts_with("hwp_failed:")),
        "{error:?}"
    );
    // The report is still requested on every call (the read is gated, not the flag).
    let invocations = std::fs::read_to_string(fixture.path().join("invocations")).unwrap();
    assert!(invocations.contains(" --report "), "{invocations}");
}

#[test]
fn home_and_windows_paths_anywhere_in_the_report_are_redacted() {
    let report = serde_json::json!({
        "schema_version": "1.1",
        "contract": "hwp-edit-report-v1",
        "output": "/Users/someone/out.hwpx",
        "dry_run": false,
        "ops": [{
            "index": 0, "op": "insert_image", "status": "failed", "pieces_touched": 0,
            "changed": [], "reason": r"cannot read C:\Users\someone\Pictures\a.png",
            "refusal": {"code": "unclassified", "values": {},
                "message": "cannot read /Users/someone/workspace/image.png"}
        }],
        "applied_count": 0,
        "failed_count": 1,
        "future_field": {"nested": ["see /home/someone/notes.txt", r"\\server\share\x.json"]},
        "refusal": {"code": "add_table.anchor_not_found",
            "values": {"anchor": "/Users/someone/typed anchor"},
            "message": "anchor missing; input was /var/folders/zz/doc.hwpx"}
    })
    .to_string();
    let (_fixture, binary) = engine(
        "2.0.0",
        Edit::Refuse {
            report: &report,
            stderr: "Error: refused",
        },
    );
    let _env = BinEnv::set(&binary);
    let report = refused(refused_edit(document()).unwrap_err()).report;
    let text = report.to_string();
    for leaked in [
        "/Users/someone/workspace",
        r"Pictures",
        "/home/someone",
        "server",
        "/var/folders",
    ] {
        assert!(!text.contains(leaked), "{leaked} leaked: {text}");
    }
    assert_eq!(report["output"], "보고서.hwpx");
    assert_eq!(report["ops"][0]["refusal"]["message"], "cannot read <path>");
    assert_eq!(report["ops"][0]["reason"], "cannot read <path>");
    assert_eq!(report["future_field"]["nested"][0], "see <path>");
    assert_eq!(
        report["refusal"]["message"],
        "anchor missing; input was <path>"
    );
    // The typed anchor is an identifier and stays exact, even if path-shaped.
    assert_eq!(
        report["refusal"]["values"]["anchor"],
        "/Users/someone/typed anchor"
    );
}

#[test]
fn an_oversized_report_keeps_the_string_error() {
    let big = format!(
        "{{\"schema_version\":\"1.1\",\"pad\":\"{}\"}}",
        "x".repeat((EDIT_REPORT_MAX_BYTES as usize) + 16)
    );
    let (_fixture, binary) = engine(
        "2.0.0",
        Edit::Refuse {
            report: &big,
            stderr: UNAPPLIED_STDERR,
        },
    );
    let _env = BinEnv::set(&binary);
    assert!(matches!(
        refused_edit(document()).unwrap_err(),
        HwpedBridgeError::Legacy(_)
    ));
}
