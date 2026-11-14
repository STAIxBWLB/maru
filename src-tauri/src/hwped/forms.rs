//! Source-bound form binding (agent-hwp 2.0.0, maru#626).
//!
//! The contract is hwp-editor `docs/integration-maru.md` §"Source-bound forms",
//! and this is a port of its HTTP adapter (`packages/server/src/form-engine.ts`):
//!
//!   hwped_discover_forms       ahwp slots <in> --forms --occurrences --json
//!   hwped_apply_form_bindings  ahwp edit <in> -o <out> --ops <one op> --verify [--dry-run]
//!
//! The binding op is exclusive and its receipt and preview paths are made here,
//! inside a private per-call directory that is removed when the call returns.
//! Nothing the caller sends can name an artifact path, no other op rides along,
//! and `--report` is never passed: released 2.0.0 refuses it for this op. No
//! staged path, and no engine prose, crosses the bridge.

use super::{
    ensure_version, hwp_bin, parse_version, run_hwp_feature_ok, safe_output_name, stage_document,
    version_at_least, HwpedDocumentRef, BASE64,
};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::path::Path;

/// The first engine release whose `slots --occurrences` and
/// `apply_form_bindings` match the client's v1 parsers. A prerelease such as
/// `2.0.0-rc.1` does not parse as a version triplet, so it never qualifies.
pub(super) const FORM_BINDINGS_MIN_VERSION: (u64, u64, u64) = (2, 0, 0);

/// Fields the client's `parseFormBindingPlan` admits. Anything else is refused
/// rather than forwarded, so a plan cannot smuggle an op field to the engine.
const PLAN_FIELDS: &[&str] = &[
    "version",
    "source_sha256",
    "structural_sha256",
    "bindings",
    "repeats",
    "constraints",
];

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HwpedFormOptions {
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HwpedFormResult {
    pub receipt: Value,
    pub preview: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_base64: Option<String>,
}

pub(super) fn supports_form_bindings(version: &str) -> bool {
    parse_version(version.as_bytes())
        .is_some_and(|version| version_at_least(version, FORM_BINDINGS_MIN_VERSION))
}

fn require_form_bindings(version: &str) -> Result<(), String> {
    if supports_form_bindings(version) {
        return Ok(());
    }
    Err(format!(
        "hwp_version: form binding requires agent-hwp 2.0.0; detected {version}. Upgrade the engine, then rediscover targets."
    ))
}

/// `.hwp` or `.hwpx` from a file name, exactly; unlike `sniff_extension` an
/// unknown name is not assumed to be HWPX, because the output has to keep the
/// source format.
fn form_format(name: &str) -> Option<&'static str> {
    let lower = name.to_lowercase();
    if lower.ends_with(".hwpx") {
        Some(".hwpx")
    } else if lower.ends_with(".hwp") {
        Some(".hwp")
    } else {
        None
    }
}

/// The format the staged bytes actually are: HWP 5 is a CFB container, HWPX a
/// ZIP. A misleading name cannot convert formats.
fn staged_format(path: &Path) -> Result<Option<&'static str>, String> {
    use std::io::Read as _;
    let mut head = [0u8; 4];
    let mut file = std::fs::File::open(path).map_err(|err| format!("hwp_stage_failed: {err}"))?;
    let read = file
        .read(&mut head)
        .map_err(|err| format!("hwp_stage_failed: {err}"))?;
    Ok(match &head[..read] {
        [0xD0, 0xCF, 0x11, 0xE0] => Some(".hwp"),
        [b'P', b'K', 0x03, 0x04] => Some(".hwpx"),
        _ => None,
    })
}

fn bad_request(message: &str) -> String {
    format!("hwped_bad_request: {message}")
}

fn parse_discovery(stdout: &[u8]) -> Result<Value, String> {
    let invalid = || {
        "hwp_parse_failed: invalid form payload from the engine; upgrade agent-hwp to 2.0.0 and rediscover targets"
            .to_string()
    };
    let value: Value = serde_json::from_slice(stdout).map_err(|_| invalid())?;
    let object = value.as_object().ok_or_else(invalid)?;
    let shaped = object.get("version").and_then(Value::as_u64) == Some(1)
        && object.get("source_sha256").is_some_and(Value::is_string)
        && object
            .get("structural_sha256")
            .is_some_and(Value::is_string)
        && object.get("occurrences").is_some_and(Value::is_array);
    if !shaped {
        return Err(invalid());
    }
    Ok(value)
}

/// Shape checks the host owns. The engine and the client parser validate the
/// plan in depth; the host only refuses what would let a request reach past
/// the one op: unknown plan fields, values that are not literal strings, and
/// keys that do not match the bindings.
fn checked_plan(plan: Value, values: Value) -> Result<(Value, Map<String, Value>), String> {
    let object = plan.as_object().ok_or_else(|| {
        bad_request("plan must be a FormBindingPlan v1 object; rediscover targets and retry")
    })?;
    if let Some(field) = object
        .keys()
        .find(|key| !PLAN_FIELDS.contains(&key.as_str()))
    {
        return Err(bad_request(&format!(
            "plan field {field:?} is not part of FormBindingPlan v1; send only the reviewed plan"
        )));
    }
    if object.get("version").and_then(Value::as_u64) != Some(1)
        || !object.get("source_sha256").is_some_and(Value::is_string)
        || !object
            .get("structural_sha256")
            .is_some_and(Value::is_string)
    {
        return Err(bad_request(
            "plan must be FormBindingPlan version 1 with source and structural hashes; rediscover targets and retry",
        ));
    }
    let bindings = object
        .get("bindings")
        .and_then(Value::as_array)
        .filter(|bindings| !bindings.is_empty())
        .ok_or_else(|| bad_request("plan needs at least one binding; select a target and retry"))?;
    let mut keys = BTreeSet::new();
    for binding in bindings {
        let key = binding.get("key").and_then(Value::as_str).ok_or_else(|| {
            bad_request("every binding needs a string key; rediscover targets and retry")
        })?;
        if !keys.insert(key.to_string()) {
            return Err(bad_request(&format!(
                "binding key {key:?} occurs more than once; give each binding its own key"
            )));
        }
    }
    let Value::Object(values) = values else {
        return Err(bad_request(
            "values must be an object of literal strings keyed by binding",
        ));
    };
    if values.values().any(|value| !value.is_string()) {
        return Err(bad_request(
            "every value must be a literal string; send text, not structured data",
        ));
    }
    if values.keys().cloned().collect::<BTreeSet<_>>() != keys {
        return Err(bad_request(
            "values must name exactly the plan's binding keys; send one value per binding",
        ));
    }
    Ok((plan, values))
}

/// The typed reflow preflight the HTTP adapter runs: against a fresh discovery
/// of the same source, a target without reflow permission may not grow past its
/// original UTF-16 length. It is skipped for a stale plan, which the engine
/// refuses on its own.
fn check_growth(
    discovery: &Value,
    plan: &Value,
    values: &Map<String, Value>,
) -> Result<(), String> {
    let same = ["source_sha256", "structural_sha256"]
        .iter()
        .all(|field| discovery.get(field).is_some() && discovery.get(field) == plan.get(field));
    if !same {
        return Ok(());
    }
    let occurrences: BTreeMap<&str, &Value> = discovery["occurrences"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| Some((item.get("id")?.as_str()?, item)))
        .collect();
    for binding in plan["bindings"].as_array().into_iter().flatten() {
        let value = binding
            .get("key")
            .and_then(Value::as_str)
            .and_then(|key| values.get(key))
            .and_then(Value::as_str)
            .unwrap_or_default();
        for target in binding
            .get("targets")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if target.get("allow_reflow").and_then(Value::as_bool) != Some(false) {
                continue;
            }
            let Some(occurrence) = target
                .get("occurrence_id")
                .and_then(Value::as_str)
                .and_then(|id| occurrences.get(id))
            else {
                continue;
            };
            if occurrence.get("bindable").and_then(Value::as_bool) != Some(true) {
                continue;
            }
            let limit = occurrence
                .get("old_text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .encode_utf16()
                .count();
            if value.encode_utf16().count() > limit {
                return Err(bad_request(&format!(
                    "Form binding refused (growth_without_reflow; limit={limit}); allow reflow, or keep the value within {limit} characters (UTF-16 units), then preview again."
                )));
            }
        }
    }
    Ok(())
}

/// A refused binding is reported by class only. Released 2.0.0 emits no
/// structured refusal for this op, and its prose may name staged paths.
fn refused(command: &str) -> impl FnOnce(String) -> String + '_ {
    move |error| {
        if error.starts_with("hwp_failed:") {
            format!("hwp_failed: Form binding refused (engine_refused); {command} failed without a supported structured refusal. Rediscover targets, review the plan and values, then preview again.")
        } else {
            error
        }
    }
}

fn discover(bin: &Path, input: &Path, work_dir: &str) -> Result<Value, String> {
    let stdout = run_hwp_feature_ok(
        bin,
        &[
            OsString::from("slots"),
            input.as_os_str().to_os_string(),
            OsString::from("--forms"),
            OsString::from("--occurrences"),
            OsString::from("--json"),
        ],
        Some(work_dir),
    )
    .map_err(refused("ahwp slots"))?;
    parse_discovery(&stdout)
}

fn work_dir() -> Result<(tempfile::TempDir, String), String> {
    let tmp = tempfile::tempdir().map_err(|err| format!("hwp_stage_failed: {err}"))?;
    let dir = super::edit_stage_dir(tmp.path())?;
    Ok((tmp, dir))
}

pub(super) fn discover_now(
    document: HwpedDocumentRef,
    workspace_root: Option<String>,
) -> Result<Value, String> {
    let bin = hwp_bin()?;
    require_form_bindings(&ensure_version(&bin)?)?;
    let (_tmp, dir) = work_dir()?;
    let input = stage_document(Path::new(&dir), &document, workspace_root.as_deref())?;
    discover(&bin, &input, &dir)
}

fn read_artifact(path: &Path, what: &str) -> Result<Value, String> {
    let bytes = std::fs::read(path).map_err(|_| {
        format!("hwp_parse_failed: the engine wrote no form {what}; upgrade agent-hwp to 2.0.0 and preview again")
    })?;
    serde_json::from_slice::<Value>(&bytes)
        .ok()
        .filter(Value::is_object)
        .ok_or_else(|| {
            format!("hwp_parse_failed: invalid form {what} from the engine; upgrade agent-hwp to 2.0.0 and preview again")
        })
}

pub(super) fn apply_now(
    document: HwpedDocumentRef,
    workspace_root: Option<String>,
    plan: Value,
    values: Value,
    options: HwpedFormOptions,
) -> Result<HwpedFormResult, String> {
    // Everything decidable from the request is refused before the engine runs.
    let format = form_format(&document.name).ok_or_else(|| {
        bad_request("form binding needs a .hwp or .hwpx source; open the document in its own format and retry")
    })?;
    let name = options
        .name
        .clone()
        .unwrap_or_else(|| document.name.clone());
    if form_format(&name) != Some(format) {
        return Err(bad_request(
            "Form binding requires same-format output; choose the source format and retry",
        ));
    }
    let (plan, values) = checked_plan(plan, values)?;

    let bin = hwp_bin()?;
    require_form_bindings(&ensure_version(&bin)?)?;
    let (_tmp, dir) = work_dir()?;
    let stage = Path::new(&dir);
    let input = stage_document(stage, &document, workspace_root.as_deref())?;
    if staged_format(&input)? != Some(format) {
        return Err(bad_request(
            "Form source name and bytes disagree; use the actual source format and retry",
        ));
    }
    let discovery = discover(&bin, &input, &dir)?;
    check_growth(&discovery, &plan, &values)?;

    let output = stage.join(format!("bound{format}"));
    let receipt = stage.join("receipt.json");
    let preview = stage.join("preview.json");
    let ops = stage.join("bindings.json");
    let op = serde_json::json!([{
        "op": "apply_form_bindings",
        "plan": plan,
        "values": values,
        "receipt": receipt.to_string_lossy(),
        "preview": preview.to_string_lossy(),
    }]);
    write_private(
        &ops,
        &serde_json::to_vec(&op).map_err(|err| format!("hwp_stage_failed: {err}"))?,
    )?;
    let mut args = vec![
        OsString::from("edit"),
        input.into_os_string(),
        OsString::from("-o"),
        output.clone().into_os_string(),
        OsString::from("--ops"),
        ops.into_os_string(),
        OsString::from("--verify"),
    ];
    if options.dry_run {
        args.push(OsString::from("--dry-run"));
    }
    run_hwp_feature_ok(&bin, &args, Some(&dir)).map_err(refused("ahwp edit"))?;

    let receipt = read_artifact(&receipt, "receipt")?;
    let preview = read_artifact(&preview, "preview")?;
    if receipt.get("published").and_then(Value::as_bool) != Some(!options.dry_run) {
        return Err("hwp_parse_failed: Form publication receipt disagrees with requested mode; rediscover targets and retry".to_string());
    }
    if options.dry_run {
        return Ok(HwpedFormResult {
            receipt,
            preview,
            name: None,
            data_base64: None,
        });
    }
    let data = std::fs::read(&output).map_err(|err| format!("hwp_stage_failed: {err}"))?;
    Ok(HwpedFormResult {
        receipt,
        preview,
        name: Some(safe_output_name(&name, format)),
        data_base64: Some(BASE64.encode(&data)),
    })
}

/// The ops file names the receipt and preview paths and carries document
/// values, so it is readable by its owner only.
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write as _;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|err| {
        format!("hwp_stage_failed: could not write the per-call binding op: {err}")
    })?;
    file.write_all(bytes)
        .map_err(|err| format!("hwp_stage_failed: could not write the per-call binding op: {err}"))
}

#[cfg(test)]
mod tests;
