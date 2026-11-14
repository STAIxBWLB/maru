//! Host tests for the form-binding commands (maru#626 AC3), against a fake
//! engine that follows the agent-hwp 2.0.0 contract: `slots --forms
//! --occurrences --json` prints a discovery, and `edit --ops` writes the
//! receipt and preview the one `apply_form_bindings` op names. The fake keeps a
//! copy of every ops file and its argv so the tests can read what the host sent.

use super::super::{hwped_apply_form_bindings, hwped_capabilities, hwped_discover_forms};
use super::*;
use std::path::PathBuf;

const SOURCE: &str = "a47e3bd7aab96d0ba170549f650b27be8f088835c8a05b76d0534b872bf5d809";
const STRUCTURE: &str = "e12b515427aa4cec7cd7af1d8b1e825565fc8fdee09470449dacfc9b67a08fab";
const STALE: &str = "0000000000000000000000000000000000000000000000000000000000000000";
const HWPX: &[u8] = b"PK\x03\x04hwpx form";
const HWP: &[u8] = b"\xD0\xCF\x11\xE0hwp form";

struct Engine {
    dir: tempfile::TempDir,
    _lock: std::sync::MutexGuard<'static, ()>,
}

impl Engine {
    fn invocations(&self) -> Vec<String> {
        std::fs::read_to_string(self.dir.path().join("invocations"))
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect()
    }
    fn ops(&self) -> Value {
        let text = std::fs::read_to_string(self.dir.path().join("ops-copy.json"))
            .expect("the engine received an ops file");
        serde_json::from_str(&text).unwrap()
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        std::env::remove_var("MARU_HWP_BIN");
    }
}

#[cfg(unix)]
fn engine(version: &str) -> Engine {
    let lock = super::super::PHASE08_21_ENV_LOCK
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let dir = tempfile::tempdir().unwrap();
    let binary = dir.path().join("ahwp");
    let script = r#"#!/bin/sh
here="$(dirname "$0")"
case "$1" in
  --version) echo "ahwp __VERSION__"; exit 0 ;;
esac
printf '%s\n' "$*" >> "$here/invocations"
case "$1" in
  slots)
    printf '{"version":1,"source_sha256":"__SOURCE__","structural_sha256":"__STRUCTURE__","occurrences":[{"id":"occ-a","kind":"cell_text","old_text":"AB","bindable":true},{"id":"occ-b","kind":"cell_text","old_text":"","bindable":false,"cause":"merged cell","next_step":"bind another cell"}]}'
    ;;
  edit)
    out=""; ops=""; dry=0
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -o) shift; out="$1" ;;
        --ops) shift; ops="$1" ;;
        --dry-run) dry=1 ;;
        --report) echo "error: --report is not accepted with apply_form_bindings" >&2; exit 2 ;;
      esac
      shift
    done
    cp "$ops" "$here/ops-copy.json"
    ls -l "$ops" | cut -c1-10 > "$here/ops-mode"
    if grep -q '__STALE__' "$ops"; then
      echo "error: plan source does not match $ops (refused)" >&2; exit 3
    fi
    receipt=$(sed -n 's/.*"receipt":"\([^"]*\)".*/\1/p' "$ops")
    preview=$(sed -n 's/.*"preview":"\([^"]*\)".*/\1/p' "$ops")
    if [ "$dry" = 1 ]; then published=false; else published=true; printf 'PK\003\004bound' > "$out"; fi
    printf '{"version":1,"published":%s,"source_sha256":"__SOURCE__","plan_sha256":"p","values_sha256":"v"}' "$published" > "$receipt"
    printf '{"version":1,"source_sha256":"__SOURCE__","plan_sha256":"p","values_sha256":"v","changes":[{"occurrence_id":"occ-a","new_text":"Lee"}]}' > "$preview"
    ;;
  *) exit 2 ;;
esac
"#
    .replace("__VERSION__", version)
    .replace("__SOURCE__", SOURCE)
    .replace("__STRUCTURE__", STRUCTURE)
    .replace("__STALE__", STALE);
    crate::test_support::write_executable_fixture(&binary, &script, 0o755).unwrap();
    std::env::set_var("MARU_HWP_BIN", &binary);
    Engine { dir, _lock: lock }
}

fn document(name: &str, bytes: &[u8]) -> HwpedDocumentRef {
    HwpedDocumentRef {
        name: name.to_string(),
        path: None,
        data_base64: Some(BASE64.encode(bytes)),
    }
}

fn plan(source: &str, allow_reflow: bool) -> Value {
    serde_json::json!({
        "version": 1,
        "source_sha256": source,
        "structural_sha256": STRUCTURE,
        "bindings": [{
            "key": "name",
            "targets": [{ "occurrence_id": "occ-a", "max_chars": 30, "allow_reflow": allow_reflow }]
        }]
    })
}

fn values(text: &str) -> Value {
    serde_json::json!({ "name": text })
}

fn options(dry_run: bool, name: Option<&str>) -> Option<HwpedFormOptions> {
    Some(HwpedFormOptions {
        dry_run,
        name: name.map(str::to_string),
    })
}

fn run<F: std::future::Future>(future: F) -> F::Output {
    tauri::async_runtime::block_on(future)
}

/// The per-call directory the engine was handed, read back from its argv.
fn staged_dir(engine: &Engine) -> PathBuf {
    let edit = engine
        .invocations()
        .into_iter()
        .find(|line| line.starts_with("edit "))
        .expect("edit ran");
    let input = edit.split(' ').nth(1).unwrap();
    PathBuf::from(input).parent().unwrap().to_path_buf()
}

#[cfg(unix)]
#[test]
fn capabilities_advertise_form_bindings_only_from_engine_2_0_0() {
    for (version, expected) in [
        ("2.0.0", Some("v1")),
        ("2.1.3", Some("v1")),
        ("1.9.9", None),
        ("0.20.0", None),
    ] {
        let _engine = engine(version);
        let capabilities = run(hwped_capabilities()).unwrap();
        assert_eq!(capabilities.form_bindings, expected, "{version}");
        let wire = serde_json::to_value(&capabilities).unwrap();
        assert_eq!(
            wire.get("formBindings").and_then(Value::as_str),
            expected,
            "{version}"
        );
    }
}

#[cfg(unix)]
#[test]
fn discovery_returns_the_engine_catalogue_and_removes_its_directory() {
    let engine = engine("2.0.0");
    let discovery = run(hwped_discover_forms(document("양식.hwpx", HWPX), None)).unwrap();
    assert_eq!(discovery["version"], 1);
    assert_eq!(discovery["source_sha256"], SOURCE);
    assert_eq!(discovery["occurrences"][1]["cause"], "merged cell");
    let slots = engine.invocations();
    assert_eq!(slots.len(), 1);
    assert!(slots[0].starts_with("slots "), "{slots:?}");
    assert!(
        slots[0].ends_with(" --forms --occurrences --json"),
        "{slots:?}"
    );
    let staged = PathBuf::from(slots[0].split(' ').nth(1).unwrap());
    assert!(
        !staged.parent().unwrap().exists(),
        "the per-call directory outlived the call"
    );
}

#[cfg(unix)]
#[test]
fn discovery_on_an_older_engine_is_refused_by_version() {
    let engine = engine("1.6.3");
    let error = run(hwped_discover_forms(document("양식.hwpx", HWPX), None)).unwrap_err();
    assert!(error.starts_with("hwp_version:"), "{error}");
    assert!(error.contains("2.0.0"), "{error}");
    assert!(engine.invocations().is_empty());
}

#[cfg(unix)]
#[test]
fn a_dry_run_returns_receipt_and_preview_without_document_bytes() {
    let engine = engine("2.0.0");
    let result = run(hwped_apply_form_bindings(
        document("양식.hwpx", HWPX),
        None,
        plan(SOURCE, true),
        values("Lee"),
        options(true, None),
    ))
    .unwrap();
    assert_eq!(result.receipt["published"], false);
    assert_eq!(result.preview["changes"][0]["new_text"], "Lee");
    let wire = serde_json::to_value(&result).unwrap();
    assert!(
        wire.get("dataBase64").is_none() && wire.get("name").is_none(),
        "{wire}"
    );

    let calls = engine.invocations();
    let edit = calls.iter().find(|line| line.starts_with("edit ")).unwrap();
    assert!(edit.contains(" --verify"), "{edit}");
    assert!(edit.ends_with(" --dry-run"), "{edit}");
    assert!(!edit.contains("--report"), "{edit}");
    // Discovery ran first, for the reflow preflight, on the same staged source.
    assert!(calls[0].starts_with("slots "), "{calls:?}");
    assert!(
        !staged_dir(&engine).exists(),
        "the per-call directory outlived the call"
    );
}

#[cfg(unix)]
#[test]
fn an_apply_returns_same_format_bytes_and_one_exclusive_host_owned_op() {
    let engine = engine("2.0.0");
    let result = run(hwped_apply_form_bindings(
        document("양식.hwpx", HWPX),
        None,
        plan(SOURCE, true),
        values("Lee"),
        options(false, None),
    ))
    .unwrap();
    assert_eq!(result.receipt["published"], true);
    assert_eq!(result.name.as_deref(), Some("양식.hwpx"));
    assert_eq!(
        BASE64.decode(result.data_base64.unwrap()).unwrap(),
        b"PK\x03\x04bound"
    );
    let edit = engine
        .invocations()
        .into_iter()
        .find(|line| line.starts_with("edit "))
        .unwrap();
    assert!(
        !edit.contains("--dry-run") && !edit.contains("--report"),
        "{edit}"
    );

    let ops = engine.ops();
    let ops = ops.as_array().unwrap();
    assert_eq!(ops.len(), 1, "the binding op travels alone");
    let op = ops[0].as_object().unwrap();
    assert_eq!(
        op.keys().map(String::as_str).collect::<Vec<_>>(),
        vec!["op", "plan", "preview", "receipt", "values"]
    );
    assert_eq!(op["op"], "apply_form_bindings");
    let stage = staged_dir(&engine);
    for field in ["receipt", "preview"] {
        let path = PathBuf::from(op[field].as_str().unwrap());
        assert_eq!(
            path.parent().unwrap(),
            stage,
            "{field} is outside the per-call dir"
        );
    }
    let mode = std::fs::read_to_string(engine.dir.path().join("ops-mode")).unwrap();
    assert_eq!(mode.trim(), "-rw-------", "the ops file is private");
    assert!(!stage.exists(), "the per-call directory outlived the call");
}

#[cfg(unix)]
#[test]
fn a_refused_plan_is_reported_by_class_without_engine_prose_or_paths() {
    let engine = engine("2.0.0");
    let error = run(hwped_apply_form_bindings(
        document("양식.hwpx", HWPX),
        None,
        plan(STALE, true),
        values("Lee"),
        options(true, None),
    ))
    .unwrap_err();
    assert!(error.starts_with("hwp_failed:"), "{error}");
    assert!(error.contains("engine_refused"), "{error}");
    assert!(error.contains("Rediscover targets"), "{error}");
    let stage = staged_dir(&engine);
    assert!(
        !error.contains(&*stage.to_string_lossy()),
        "a staged path crossed: {error}"
    );
    assert!(
        !error.contains("does not match"),
        "engine prose crossed: {error}"
    );
}

#[cfg(unix)]
#[test]
fn growth_without_reflow_is_refused_before_the_edit_runs() {
    let engine = engine("2.0.0");
    let error = run(hwped_apply_form_bindings(
        document("양식.hwpx", HWPX),
        None,
        plan(SOURCE, false),
        values("ABCDE"),
        options(true, None),
    ))
    .unwrap_err();
    assert!(error.starts_with("hwped_bad_request:"), "{error}");
    assert!(error.contains("growth_without_reflow; limit=2"), "{error}");
    assert!(
        error.contains("allow reflow") && error.contains("within 2 characters"),
        "{error}"
    );
    assert!(engine
        .invocations()
        .iter()
        .all(|line| !line.starts_with("edit ")));

    // Within the original length, the same plan previews.
    let result = run(hwped_apply_form_bindings(
        document("양식.hwpx", HWPX),
        None,
        plan(SOURCE, false),
        values("가나"),
        options(true, None),
    ));
    assert!(result.is_ok(), "{result:?}");
}

#[cfg(unix)]
#[test]
fn a_cross_format_request_is_refused_before_the_engine_runs() {
    let engine = engine("2.0.0");
    for (source, bytes, name) in [
        ("양식.hwpx", HWPX, Some("양식.hwp")),
        ("양식.hwp", HWP, Some("양식.hwpx")),
        ("양식.pdf", HWPX, None),
    ] {
        let error = run(hwped_apply_form_bindings(
            document(source, bytes),
            None,
            plan(SOURCE, true),
            values("Lee"),
            options(false, name),
        ))
        .unwrap_err();
        assert!(error.starts_with("hwped_bad_request:"), "{source}: {error}");
    }
    assert!(
        engine.invocations().is_empty(),
        "{:?}",
        engine.invocations()
    );

    // A name that disagrees with the bytes is refused once they are staged,
    // still before discovery or edit.
    let error = run(hwped_apply_form_bindings(
        document("양식.hwp", HWPX),
        None,
        plan(SOURCE, true),
        values("Lee"),
        options(false, None),
    ))
    .unwrap_err();
    assert!(error.contains("name and bytes disagree"), "{error}");
    assert!(
        engine.invocations().is_empty(),
        "{:?}",
        engine.invocations()
    );
}

#[cfg(unix)]
#[test]
fn caller_artifact_paths_and_non_literal_values_never_reach_the_engine() {
    let engine = engine("2.0.0");
    let mut smuggled = plan(SOURCE, true);
    smuggled["receipt"] = Value::from("/private/escape.json");
    let mut not_v1 = plan(SOURCE, true);
    not_v1["version"] = Value::from(2);
    for (plan, values) in [
        (smuggled, values("Lee")),
        (not_v1, values("Lee")),
        (
            plan(SOURCE, true),
            serde_json::json!({ "name": { "path": "/etc/passwd" } }),
        ),
        (
            plan(SOURCE, true),
            serde_json::json!({ "name": "Lee", "extra": "x" }),
        ),
        (plan(SOURCE, true), serde_json::json!(["Lee"])),
    ] {
        let error = run(hwped_apply_form_bindings(
            document("양식.hwpx", HWPX),
            None,
            plan,
            values,
            options(true, None),
        ))
        .unwrap_err();
        assert!(error.starts_with("hwped_bad_request:"), "{error}");
    }
    assert!(
        engine.invocations().is_empty(),
        "{:?}",
        engine.invocations()
    );

    // Options are a closed shape too: a caller cannot add a receipt path there.
    let parsed = serde_json::from_value::<HwpedFormOptions>(
        serde_json::json!({ "dryRun": true, "receipt": "/tmp/r.json" }),
    );
    assert!(parsed.is_err());
}

#[cfg(unix)]
#[test]
fn a_workspace_document_path_keeps_the_json_edit_containment() {
    let engine = engine("2.0.0");
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("양식.hwpx"), HWPX).unwrap();
    let escape = HwpedDocumentRef {
        name: "양식.hwpx".to_string(),
        path: Some("../outside.hwpx".to_string()),
        data_base64: None,
    };
    let error = run(hwped_discover_forms(
        escape,
        Some(root.path().to_string_lossy().into_owned()),
    ))
    .unwrap_err();
    assert!(error.contains("escapes workspaceRoot"), "{error}");
    assert!(engine.invocations().is_empty());

    let inside = HwpedDocumentRef {
        name: "양식.hwpx".to_string(),
        path: Some("양식.hwpx".to_string()),
        data_base64: None,
    };
    let result = run(hwped_apply_form_bindings(
        inside,
        Some(root.path().to_string_lossy().into_owned()),
        plan(SOURCE, true),
        values("Lee"),
        options(false, None),
    ))
    .unwrap();
    assert_eq!(result.receipt["published"], true);
    // The workspace source is read in place and never rewritten by an apply.
    assert_eq!(std::fs::read(root.path().join("양식.hwpx")).unwrap(), HWPX);
}

/// Opt-in against the released engine and hwp-editor's form fixture
/// (`packages/server/test/fixtures/form-g5.hwpx`): the same discover, preview,
/// apply and stale-plan sequence hwp-editor's own server test runs.
#[cfg(unix)]
#[test]
#[ignore = "requires MARU_HWPED_REAL_TEST_BIN (agent-hwp 2.0.0) and MARU_HWPED_FORM_FIXTURE (hwp-editor form-g5.hwpx)"]
fn released_engine_discovers_previews_applies_and_refuses_a_stale_plan() {
    let binary = std::env::var_os("MARU_HWPED_REAL_TEST_BIN").expect("MARU_HWPED_REAL_TEST_BIN");
    let fixture = std::env::var_os("MARU_HWPED_FORM_FIXTURE").expect("MARU_HWPED_FORM_FIXTURE");
    let _lock = super::super::PHASE08_21_ENV_LOCK
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    std::env::set_var("MARU_HWP_BIN", &binary);
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            std::env::remove_var("MARU_HWP_BIN");
        }
    }
    let _reset = Reset;
    let bytes = std::fs::read(fixture).unwrap();
    let source = || document("form.hwpx", &bytes);

    assert_eq!(run(hwped_capabilities()).unwrap().form_bindings, Some("v1"));
    let discovery = run(hwped_discover_forms(source(), None)).unwrap();
    let target = discovery["occurrences"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["bindable"] == true)
        .expect("a bindable occurrence");
    let plan = serde_json::json!({
        "version": 1,
        "source_sha256": discovery["source_sha256"],
        "structural_sha256": discovery["structural_sha256"],
        "bindings": [{ "key": "reviewed", "targets": [{
            "occurrence_id": target["id"], "copies": [0], "max_chars": 100, "allow_reflow": true
        }] }]
    });
    let values = serde_json::json!({ "reviewed": "Reviewed binding" });

    let preview = run(hwped_apply_form_bindings(
        source(),
        None,
        plan.clone(),
        values.clone(),
        options(true, None),
    ))
    .unwrap();
    assert_eq!(preview.receipt["published"], false);
    assert!(preview.data_base64.is_none());
    assert_eq!(
        preview.preview["changes"][0]["new_text"],
        "Reviewed binding"
    );
    for field in ["source_sha256", "plan_sha256", "values_sha256"] {
        assert_eq!(preview.receipt[field], preview.preview[field], "{field}");
    }

    let applied = run(hwped_apply_form_bindings(
        source(),
        None,
        plan.clone(),
        values.clone(),
        options(false, None),
    ))
    .unwrap();
    assert_eq!(applied.receipt["published"], true);
    let data = BASE64.decode(applied.data_base64.unwrap()).unwrap();
    assert!(data.starts_with(b"PK\x03\x04"), "same-format HWPX bytes");
    let rediscovered = run(hwped_discover_forms(document("form.hwpx", &data), None)).unwrap();
    assert!(
        rediscovered.to_string().contains("Reviewed binding"),
        "the applied value is in the published document"
    );

    let mut stale = plan;
    stale["source_sha256"] = Value::from(STALE);
    let error = run(hwped_apply_form_bindings(
        source(),
        None,
        stale,
        serde_json::json!({ "reviewed": "x" }),
        options(true, None),
    ))
    .unwrap_err();
    assert!(
        error.contains("engine_refused") && error.contains("Rediscover"),
        "{error}"
    );
}
