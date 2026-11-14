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
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::Path;

/// The first engine release whose `slots --occurrences` and
/// `apply_form_bindings` match the client's v1 parsers. A prerelease such as
/// `2.0.0-rc.1` does not parse as a version triplet, so it never qualifies.
pub(super) const FORM_BINDINGS_MIN_VERSION: (u64, u64, u64) = (2, 0, 0);

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
    let failed = |err: std::io::Error| {
        format!(
            "hwp_stage_failed: could not read the staged form source to check its format ({}); check the document is readable, then retry",
            err.kind()
        )
    };
    let mut file = std::fs::File::open(path).map_err(failed)?;
    let read = file.read(&mut head).map_err(failed)?;
    Ok(match &head[..read] {
        [0xD0, 0xCF, 0x11, 0xE0] => Some(".hwp"),
        [b'P', b'K', 0x03, 0x04] => Some(".hwpx"),
        _ => None,
    })
}

fn bad_request(message: &str) -> String {
    format!("hwped_bad_request: {message}")
}

/// Largest receipt, preview or discovery the host reads back. The client caps
/// occurrences and changes at 20,000 rows, which fits well inside this.
const ARTIFACT_LIMIT: u64 = 32 * 1024 * 1024;

/// Largest bound document the host returns; the same cap as a saved document.
const OUTPUT_LIMIT: u64 = 32 * 1024 * 1024;

fn invalid_payload(what: &str, error: &wire::FormDataError) -> String {
    format!(
        "hwp_parse_failed: the engine's form {what} does not match the v1 contract ({error}); upgrade agent-hwp to 2.0.0 and rediscover targets"
    )
}

fn parse_discovery(stdout: &[u8]) -> Result<Value, String> {
    let value: Value = serde_json::from_slice(stdout).map_err(|_| {
        "hwp_parse_failed: the engine's form discovery is not JSON; upgrade agent-hwp to 2.0.0 and rediscover targets".to_string()
    })?;
    wire::parse_discovery(&value).map_err(|error| invalid_payload("discovery", &error))
}

/// `parseFormBindingPlan` and `validateFormValues`, as the client and the HTTP
/// adapter run them: the host refuses what they refuse, and forwards only the
/// normalized plan they would send.
fn checked_plan(plan: Value, values: Value) -> Result<(Value, Map<String, Value>), String> {
    let plan = wire::parse_plan(&plan).map_err(|error| {
        bad_request(&format!("{error}; the plan is not FormBindingPlan v1, so rediscover targets and review the plan again"))
    })?;
    let values = wire::validate_values(&plan, &values).map_err(|error| {
        bad_request(&format!("{error}; send one literal string per binding key, within each target's max_chars, then preview again"))
    })?;
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
    #[cfg(unix)]
    let tmp = {
        use std::os::unix::fs::PermissionsExt;
        tempfile::Builder::new()
            .permissions(std::fs::Permissions::from_mode(0o700))
            .tempdir()
    };
    #[cfg(not(unix))]
    let tmp = tempfile::tempdir();
    let tmp = tmp.map_err(|err| {
        format!(
            "hwp_stage_failed: could not create the private form binding directory ({}); check temporary storage permissions and free space, then retry",
            err.kind()
        )
    })?;
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

/// Read one engine product through a single handle, refusing it past `limit`
/// instead of buffering whatever the engine wrote (maru#626 T126-R1). The cause
/// names the product, never its staged path.
fn read_bounded(path: &Path, limit: u64, what: &str) -> Result<Vec<u8>, String> {
    use std::io::Read as _;
    let file = std::fs::File::open(path).map_err(|err| {
        if err.kind() == std::io::ErrorKind::NotFound {
            format!("hwp_parse_failed: ahwp edit exited successfully but wrote no form {what}; upgrade agent-hwp to 2.0.0, then rediscover targets and preview again")
        } else {
            format!("hwp_stage_failed: could not open the form {what} the engine wrote ({}); check temporary storage permissions, then preview again", err.kind())
        }
    })?;
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes).map_err(|err| {
        format!("hwp_stage_failed: could not read the form {what} the engine wrote ({}); check temporary storage, then preview again", err.kind())
    })?;
    if bytes.len() as u64 > limit {
        return Err(format!(
            "hwp_output_limit: the form {what} the engine wrote exceeds {} MiB; bind fewer targets or split the document, then preview again",
            limit / (1024 * 1024)
        ));
    }
    Ok(bytes)
}

fn read_artifact(
    path: &Path,
    what: &str,
    parse: fn(&Value) -> Result<Value, wire::FormDataError>,
) -> Result<Value, String> {
    let bytes = read_bounded(path, ARTIFACT_LIMIT, what)?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| {
        format!("hwp_parse_failed: the engine's form {what} is not JSON; upgrade agent-hwp to 2.0.0 and preview again")
    })?;
    parse(&value).map_err(|error| invalid_payload(what, &error))
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
    let encoded = serde_json::to_vec(&op).map_err(|_| {
        "hwp_stage_failed: could not encode the form binding op; rediscover targets and review the plan, then preview again".to_string()
    })?;
    write_private(&ops, &encoded)?;
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

    let receipt = read_artifact(&receipt, "receipt", wire::parse_receipt)?;
    let preview = read_artifact(&preview, "preview", wire::parse_preview)?;
    if receipt.get("published").and_then(Value::as_bool) != Some(!options.dry_run) {
        return Err("hwp_parse_failed: Form publication receipt disagrees with requested mode; rediscover targets and retry".to_string());
    }
    // `decodeFormResult`: both artifacts describe this source, plan and values.
    let source = plan.get("source_sha256");
    let agrees = receipt.get("source_sha256") == source
        && preview.get("source_sha256") == source
        && receipt.get("plan_sha256") == preview.get("plan_sha256")
        && receipt.get("values_sha256") == preview.get("values_sha256");
    if !agrees {
        return Err("hwp_parse_failed: Form receipt and preview identities disagree; rediscover targets and preview again".to_string());
    }
    if options.dry_run {
        return Ok(HwpedFormResult {
            receipt,
            preview,
            name: None,
            data_base64: None,
        });
    }
    let data = read_bounded(&output, OUTPUT_LIMIT, "document")?;
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
    let failed = |err: std::io::Error| {
        format!(
            "hwp_stage_failed: could not write the per-call form binding op ({}); check temporary storage permissions and free space, then preview again",
            err.kind()
        )
    };
    let mut file = options.open(path).map_err(failed)?;
    file.write_all(bytes).map_err(failed)
}

mod wire;

#[cfg(test)]
mod tests;
