//! `hwped_edit`'s failure line carries its stage dir as `[work dir <json>]`, the
//! one form a transport can redact exactly instead of guessing at a path inside
//! the text. The JSON spelling is what lets a space, a quote and a backslash
//! round-trip, and the argv paths are built from the same string, so the reported
//! dir is the prefix the engine prints (maru#605).

use super::*;
use std::path::{Path, PathBuf};

/// `MARU_HWP_BIN` for the test's lifetime, held under the fixture lock the
/// sibling modules use so a parallel staged run cannot read another's binary.
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

/// Fake engine that fails the way the real one does: it names the path it was
/// handed, and `edit` exits nonzero.
#[cfg(unix)]
fn failing_engine() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let binary = dir.path().join("hwp");
    let script = r#"#!/bin/sh
printf '%s\n' "$*" >> "$(dirname "$0")/invocations"
case "$1" in
  --version) echo "hwp 0.20.0" ;;
  edit)
    printf 'Error: %s: HWP(CFB)도 HWPX(ZIP)도 아닙니다\n' "$2" >&2
    exit 3 ;;
  cat)
    printf 'Error: %s: unreadable\n' "$2" >&2
    exit 4 ;;
  *) exit 2 ;;
esac
"#;
    crate::test_support::write_executable_fixture(&binary, script, 0o755).unwrap();
    (dir, binary)
}

/// The `[work dir ...]` field decoded, which is how a transport reads it: the
/// script started by `serde_json`, so a quote inside the dir is escaped and the
/// closing quote is the first unescaped one that follows it.
fn reported_work_dir(error: &str) -> String {
    let field = error
        .split_once("[work dir \"")
        .map(|(_, rest)| rest)
        .unwrap_or_else(|| panic!("no work dir field: {error}"));
    let mut quoted = String::from("\"");
    let mut escaped = false;
    for character in field.chars() {
        quoted.push(character);
        if escaped {
            escaped = false;
        } else if character == '\\' {
            escaped = true;
        } else if character == '"' {
            break;
        }
    }
    serde_json::from_str(&quoted).expect("the field is a JSON string")
}

fn flattened_document() -> HwpedDocumentRef {
    HwpedDocumentRef {
        name: "문서.hwpx".to_string(),
        path: None,
        data_base64: Some(BASE64.encode(b"not an hwp file")),
    }
}

fn one_op() -> Value {
    serde_json::json!([{
        "op": "set_format",
        "address": {"at": {"section": 0, "paragraph": 99, "run": 0}},
        "bold": "on"
    }])
}

#[cfg(unix)]
#[test]
fn a_failing_edit_reports_the_stage_dir_its_argv_carries() {
    let (fixture, binary) = failing_engine();
    let _env = BinEnv::set(&binary);

    let error = edit_now(flattened_document(), None, Some(one_op()), None, None, None)
        .unwrap_err()
        .to_string();

    // The exit text and the raw stderr keep their shape; the dir sits between.
    assert!(
        error.starts_with("hwp_failed: hwp edit failed (exit 3) [work dir \""),
        "{error}"
    );
    assert!(error.contains(": Error: "), "{error}");
    let work_dir = reported_work_dir(&error);

    // The decoded dir is the prefix of the path the engine printed, because the
    // input and output argv were built from that same string.
    let staged_input = format!("{work_dir}/in.hwpx");
    assert!(
        error.ends_with(&format!(
            ": Error: {staged_input}: HWP(CFB)도 HWPX(ZIP)도 아닙니다"
        )),
        "{error}"
    );
    let invocations = std::fs::read_to_string(fixture.path().join("invocations")).unwrap();
    assert!(
        invocations.contains(&format!("edit {staged_input} -o {work_dir}/out.hwpx")),
        "{invocations}"
    );
}

#[cfg(unix)]
#[test]
fn a_stage_dir_with_a_space_a_quote_and_a_backslash_round_trips_through_json() {
    let (fixture, binary) = failing_engine();
    let tricky = fixture.path().join("stage \"q\" \\ b");
    std::fs::create_dir_all(&tricky).unwrap();
    let work_dir = tricky.to_string_lossy().into_owned();
    assert!(work_dir.contains(' ') && work_dir.contains('"') && work_dir.contains('\\'));

    let error = run_hwp_ok(
        &binary,
        &[OsString::from("edit"), OsString::from("in.hwpx")],
        Some(&work_dir),
    )
    .unwrap_err();

    // A raw `[work dir {dir}]` would end at the quote and read back wrong.
    assert_eq!(reported_work_dir(&error), work_dir, "{error}");
    assert!(error.contains("[work dir \""), "{error}");
    assert!(error.contains("\\\""), "{error}");
    assert!(error.contains("\\\\"), "{error}");
}

#[cfg(unix)]
#[test]
fn a_failure_outside_edit_carries_no_work_dir_field() {
    let (_fixture, binary) = failing_engine();
    let _env = BinEnv::set(&binary);

    let error = read_now(flattened_document(), None)
        .unwrap_err()
        .to_string();

    assert!(
        error.starts_with("hwp_failed: hwp cat failed (exit 4): "),
        "{error}"
    );
    assert!(!error.contains("[work dir"), "{error}");
}

/// macOS reaches the temp dir through `/var`, which `canonicalize` resolves to
/// `/private/var`; Windows keeps the tempdir path, where `canonicalize` would
/// hand back a `\\?\` verbatim path the engine never prints.
#[cfg(unix)]
#[test]
fn the_reported_stage_dir_is_the_canonical_temp_path() {
    let raw = std::env::temp_dir();
    let expected = std::fs::canonicalize(&raw).unwrap();
    assert_eq!(
        edit_stage_dir(&raw).unwrap(),
        expected.to_string_lossy().into_owned()
    );
}

/// Opt-in against a checksum-verified released binary. Only this case proves the
/// prefix property against the engine's own output rather than a fixture's.
#[cfg(unix)]
#[test]
#[ignore = "requires MARU_HWPED_REAL_TEST_BIN pointing to checksum-verified hwp-cli >= 1.3.1"]
fn released_hwp_prints_the_stage_dir_the_edit_reports() {
    let binary = std::env::var_os("MARU_HWPED_REAL_TEST_BIN")
        .map(PathBuf::from)
        .expect("set MARU_HWPED_REAL_TEST_BIN to the verified release binary");
    let _env = BinEnv::set(&binary);

    // Bytes that are neither HWP nor HWPX: the engine names the staged input it
    // cannot open, which is the stage path this field exists to redact.
    let error = edit_now(flattened_document(), None, Some(one_op()), None, None, None)
        .unwrap_err()
        .to_string();

    assert!(
        error.starts_with("hwp_failed: hwp edit failed (exit "),
        "{error}"
    );
    let work_dir = reported_work_dir(&error);
    assert!(
        error.contains(&format!(
            ": Error: {work_dir}/in.hwpx: HWP(CFB)도 HWPX(ZIP)도 아닙니다"
        )),
        "the engine prints the staged input under the reported dir: {error}"
    );
    // The engine repeats the path under `Caused by:`; still the reported dir, and
    // a `/var` tempdir would have printed `/private/var` without the canonicalize.
    assert!(
        error.contains(&format!("\n    {work_dir}/in.hwpx: ")),
        "{error}"
    );
}
