//! Independent document validity engine for the Maru diagram engine.
//!
//! The default feature validates typed JSON only. Opt-in geometry foundations
//! add fixed-point contracts and pinned font metrics, with no rendering or app access.

// Glyph outlines need the two pinned OTFs (33.4 MiB), which belong to native
// exports only: E3 S2 moved PNG out of WASM for the same reason, and the browser
// payload is measured per lazy chunk (`maru#552`). This is a build error rather
// than a size regression someone has to notice later.
#[cfg(all(
    feature = "render-outline",
    any(
        feature = "wasm",
        feature = "wasm-layout",
        feature = "wasm-render",
        feature = "wasm-png",
        feature = "bindgen-web"
    )
))]
compile_error!(
    "render-outline cannot be built for WASM: it embeds the pinned Noto CJK OTFs. \
     Produce outlined SVG natively through tauri-plugin-maru-diagram and keep the \
     WASM artifacts in text mode."
);

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub mod architecture;
mod common;
pub mod dataflow;
/// Floorplan document validity (`floorplan/architecture@1`). It is not part of
/// the `validate_json` dispatch yet: that dispatcher's families are the E1
/// differential corpus, which is checked against the pinned renderer oracle and
/// has no Floorplan counterpart, so the apply-gate switch owns the dispatch
/// (`maru#553` E5 T4). Its entry point is [`validate_floorplan_json`].
pub mod floorplan;
#[cfg(feature = "geometry")]
pub mod geometry;
#[cfg(feature = "geometry-corpus")]
pub mod geometry_corpus;
#[cfg(feature = "geometry")]
pub mod layout;
pub mod lifecycle;
#[cfg(feature = "geometry")]
pub mod metrics;
/// The writing primitives that are not members, containers or routes. They are
/// derived in one place so the layout publishes them and the SVG writer paints
/// the same list (`maru#552` E4).
#[cfg(feature = "geometry")]
pub(crate) mod primitives;
/// The vocabulary a published [`geometry::GeometryPrimitive`] can carry.
#[cfg(feature = "geometry")]
pub use primitives::KINDS as RENDER_PRIMITIVE_KINDS;
#[cfg(feature = "render-svg")]
pub mod render;
#[cfg(feature = "geometry")]
pub mod routing;
pub mod rules;
/// Semantic projection of an accepted source spec: the node kinds, lanes and
/// variants the render primitives are derived from. It lives outside `render`
/// so the layout build can publish those primitives too (`maru#552` E4).
#[cfg(feature = "geometry")]
pub mod semantics;
pub mod sequence;
#[cfg(all(feature = "geometry", any(test, feature = "geometry-corpus")))]
pub mod work;
pub mod workflow;
pub use architecture::{
    ArchitectureBoundary, ArchitectureComponent, ArchitectureConnection, ArchitectureLayout,
    ArchitectureMeta, ArchitectureSpec,
};

#[cfg(any(feature = "wasm", feature = "wasm-layout"))]
use wasm_bindgen::prelude::*;

pub const API_VERSION: u32 = 1;
pub const ENGINE_ID: &str = "maru-diagram-engine";
pub const ENGINE_REVISION: &str = "e1-document-validity-v1";
pub const ARCHITECTURE_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "typegen", ts(rename_all = "camelCase"))]
pub struct EngineIdentity {
    pub id: String,
    pub version: String,
    pub revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "typegen", ts(rename_all = "camelCase"))]
pub struct ReceiptGate {
    pub status: String,
    pub scope: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "typegen", ts(rename_all = "camelCase"))]
pub struct ReceiptGates {
    pub schema: ReceiptGate,
    pub artifact: ReceiptGate,
    pub browser: ReceiptGate,
    pub visual_review: ReceiptGate,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "typegen", ts(rename_all = "camelCase"))]
pub struct ReceiptConversion {
    pub format: String,
    pub theme: String,
    pub pixel_ratio: u32,
}

/// Canonical engine-neutral receipt. Legacy Archify aliases are accepted only
/// by `parse_receipt_json`; serialization always uses `engine.id`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "typegen", ts(rename_all = "camelCase"))]
pub struct EngineReceipt {
    pub schema_version: u32,
    pub input_spec_sha256: String,
    pub engine: EngineIdentity,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine_output_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversion: Option<ReceiptConversion>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_mime_type: Option<String>,
    pub gates: ReceiptGates,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub readback: Option<ReceiptGate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub doc_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document_revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rendered_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagram_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dataset_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "typegen", ts(rename_all = "camelCase"))]
pub struct Diagnostic {
    pub code: String,
    pub path: String,
    pub rule: String,
    pub message: String,
    pub fix: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "typegen", ts(rename_all = "camelCase"))]
pub struct ValidationReport {
    pub api_version: u32,
    pub ok: bool,
    pub diagnostics: Vec<Diagnostic>,
    pub receipt: EngineReceipt,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReceiptInput {
    schema_version: u32,
    input_spec_sha256: String,
    #[serde(default)]
    engine: Option<EngineIdentityInput>,
    #[serde(default)]
    engine_pin: Option<EngineIdentityInput>,
    #[serde(default)]
    engine_output_sha256: Option<String>,
    #[serde(default)]
    conversion: Option<ReceiptConversion>,
    #[serde(default)]
    output_sha256: Option<String>,
    #[serde(default)]
    output_mime_type: Option<String>,
    gates: ReceiptGates,
    #[serde(default)]
    readback: Option<ReceiptGate>,
    #[serde(default)]
    doc_id: Option<String>,
    #[serde(default)]
    document_name: Option<String>,
    #[serde(default)]
    document_revision: Option<String>,
    #[serde(default)]
    rendered_at: Option<String>,
    #[serde(default)]
    diagram_type: Option<String>,
    #[serde(default)]
    dataset_id: Option<String>,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct EngineIdentityInput {
    #[serde(alias = "name")]
    id: String,
    version: String,
    revision: String,
}

fn engine_identity() -> EngineIdentity {
    EngineIdentity {
        id: ENGINE_ID.into(),
        version: env!("CARGO_PKG_VERSION").into(),
        revision: option_env!("MARU_DIAGRAM_ENGINE_REVISION")
            .unwrap_or(ENGINE_REVISION)
            .into(),
    }
}

fn gate(status: &str, scope: &str) -> ReceiptGate {
    ReceiptGate {
        status: status.into(),
        scope: scope.into(),
    }
}

fn spec_hash(input: &str) -> String {
    format!("{:x}", Sha256::digest(input.as_bytes()))
}

fn diagnostic(
    code: &str,
    path: &str,
    rule: &str,
    message: impl Into<String>,
    fix: impl Into<String>,
) -> Diagnostic {
    Diagnostic {
        code: code.into(),
        path: path.into(),
        rule: rule.into(),
        message: message.into(),
        fix: fix.into(),
    }
}

fn make_report(
    input: &str,
    diagram_type: Option<String>,
    diagnostics: Vec<Diagnostic>,
) -> ValidationReport {
    let scope = format!(
        "{}-document-validity",
        diagram_type
            .as_deref()
            .filter(|kind| rules::DOCUMENT_TYPES.contains(kind))
            .unwrap_or("document")
    );
    report_with_scope(input, diagram_type, scope, diagnostics)
}

/// Build the report envelope. `scope` names the gate that produced the verdict,
/// which lets a family outside the E1 dispatch list keep its own receipt scope.
fn report_with_scope(
    input: &str,
    diagram_type: Option<String>,
    scope: String,
    diagnostics: Vec<Diagnostic>,
) -> ValidationReport {
    let ok = diagnostics.is_empty();
    ValidationReport {
        api_version: API_VERSION,
        ok,
        diagnostics,
        receipt: EngineReceipt {
            schema_version: 1,
            input_spec_sha256: spec_hash(input),
            engine: engine_identity(),
            engine_output_sha256: None,
            conversion: None,
            output_sha256: None,
            output_mime_type: None,
            gates: ReceiptGates {
                schema: gate(if ok { "passed" } else { "failed" }, &scope),
                artifact: gate("not-run", "none"),
                browser: gate("not-run", "none"),
                visual_review: gate("not-run", "manual"),
            },
            readback: None,
            doc_id: None,
            document_name: None,
            document_revision: None,
            rendered_at: None,
            diagram_type,
            dataset_id: None,
        },
    }
}

/// Dispatch document validation by diagram_type. A passing report covers the
/// declared document rules, not layout geometry, rendering or artifact gates.
pub fn validate_json(input: &str) -> ValidationReport {
    let value: serde_json::Value = match serde_json::from_str(input) {
        Ok(value) => value,
        Err(error) => {
            return make_report(
                input,
                None,
                vec![diagnostic(
                    "document/json",
                    "/",
                    "document-v1/json",
                    format!("input is not valid JSON: {error}"),
                    "repair the JSON syntax and retry",
                )],
            )
        }
    };
    let kind = value
        .get("diagram_type")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    let diagnostics = match kind.as_deref() {
        Some("architecture") => architecture::validate(value),
        Some("workflow") => workflow::validate(value),
        Some("sequence") => sequence::validate(value),
        Some("dataflow") => dataflow::validate(value),
        Some("lifecycle") => lifecycle::validate(value),
        _ => vec![diagnostic(
            "document/diagram-type",
            "/diagram_type",
            "document-v1/diagram-type",
            "diagram_type is missing or unsupported",
            "choose architecture, workflow, sequence, dataflow or lifecycle",
        )],
    };
    make_report(input, kind, diagnostics)
}

/// Validate a `floorplan/architecture@1` document as authored. The input is the
/// upstream interchange JSON itself (`$schema`, `project`, `nodes`, …), not a
/// `diagram_type` envelope. E5 T1 covers the document contract; layout and
/// rendering are T2, and the apply gate calls this through T4.
pub fn validate_floorplan_json(input: &str) -> ValidationReport {
    let value: serde_json::Value = match serde_json::from_str(input) {
        Ok(value) => value,
        Err(error) => {
            return report_with_scope(
                input,
                Some("floorplan".into()),
                "floorplan-document-validity".into(),
                vec![diagnostic(
                    "document/json",
                    "/",
                    "floorplan-v1/json",
                    format!("input is not valid JSON: {error}"),
                    "repair the JSON syntax and retry",
                )],
            )
        }
    };
    report_with_scope(
        input,
        Some("floorplan".into()),
        "floorplan-document-validity".into(),
        floorplan::validate(value),
    )
}

/// Parse a receipt without claiming renderer parity. Archify-era
/// `enginePin.name` and `engine.name` identities are canonicalized to
/// `engine.id` on output.
pub fn parse_receipt_json(input: &str) -> Result<EngineReceipt, String> {
    let raw: ReceiptInput = serde_json::from_str(input).map_err(|error| {
        format!("receipt JSON is invalid: {error}; inspect the receipt and retry")
    })?;
    let engine_input = match (raw.engine, raw.engine_pin) {
        (Some(engine), Some(legacy)) if engine != legacy => {
            return Err("receipt has conflicting engine and enginePin identities; keep one engine identity and retry".into());
        }
        (Some(engine), _) | (None, Some(engine)) => engine,
        (None, None) => return Err(
            "receipt is missing its engine identity; include engine.id or legacy enginePin.name"
                .into(),
        ),
    };
    Ok(EngineReceipt {
        schema_version: raw.schema_version,
        input_spec_sha256: raw.input_spec_sha256,
        engine: EngineIdentity {
            id: engine_input.id,
            version: engine_input.version,
            revision: engine_input.revision,
        },
        engine_output_sha256: raw.engine_output_sha256,
        conversion: raw.conversion,
        output_sha256: raw.output_sha256,
        output_mime_type: raw.output_mime_type,
        gates: raw.gates,
        readback: raw.readback,
        doc_id: raw.doc_id,
        document_name: raw.document_name,
        document_revision: raw.document_revision,
        rendered_at: raw.rendered_at,
        diagram_type: raw.diagram_type,
        dataset_id: raw.dataset_id,
    })
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn validate_diagram_json(input: &str) -> String {
    serde_json::to_string(&validate_json(input))
        .unwrap_or_else(|error| format!("{{\"error\":\"serialization failed: {error}\"}}"))
}

// Compatibility alias for E0 callers; both transports use the dispatcher.
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn validate_architecture_json(input: &str) -> String {
    validate_diagram_json(input)
}

#[cfg(feature = "wasm")]
#[wasm_bindgen(js_name = parse_receipt_json)]
pub fn parse_receipt_json_for_wasm(input: &str) -> String {
    match parse_receipt_json(input) {
        Ok(receipt) => serde_json::to_string(&receipt)
            .unwrap_or_else(|error| format!("{{\"error\":\"serialization failed: {error}\"}}")),
        Err(error) => serde_json::json!({ "error": error }).to_string(),
    }
}

/// The lazy geometry slice exposes layout and text metrics; the scene-layout API is added after placement/routing.
#[cfg(feature = "wasm-layout")]
#[wasm_bindgen]
pub fn measure_text_json(text: &str, weight: u16, size: i32) -> String {
    match metrics::measure_text(text, weight, size) {
        Ok(metrics) => serde_json::json!({ "ok": true, "metrics": metrics }).to_string(),
        Err(diagnostic) => serde_json::json!({ "ok": false, "diagnostic": diagnostic }).to_string(),
    }
}

#[cfg(feature = "wasm-layout")]
#[wasm_bindgen(js_name = layout_json)]
pub fn layout_json_wasm(input: &str) -> String {
    serde_json::to_string(&layout::layout_json(input)).expect("integer geometry report serializes")
}

/// The sixth family's layout, in the same envelope: Floorplan documents carry no
/// `diagram_type`, so they have their own entry point rather than a dispatch arm
/// (`maru#553` E5 T2, switch in T4).
#[cfg(feature = "wasm-layout")]
#[wasm_bindgen(js_name = layout_floorplan_json)]
pub fn layout_floorplan_json_wasm(input: &str) -> String {
    serde_json::to_string(&layout::layout_floorplan_json(input))
        .expect("integer geometry report serializes")
}

#[cfg(all(feature = "wasm-layout", feature = "geometry-corpus"))]
#[wasm_bindgen(js_name = scene_corpus_hashes)]
pub fn scene_corpus_hashes_wasm(input: &str) -> String {
    match geometry_corpus::scene_corpus_hashes(input) {
        Ok(report) => report,
        Err(diagnostic) => serde_json::json!({"error":diagnostic}).to_string(),
    }
}

#[cfg(feature = "wasm-render")]
#[wasm_bindgen(js_name = render_scene_svg)]
pub fn render_scene_svg_wasm(input: &str) -> String {
    serde_json::to_string(&render::render_svg_json(input)).expect("integer SVG report serializes")
}

#[cfg(feature = "wasm-render")]
#[wasm_bindgen(js_name=render_artifact)]
pub fn render_artifact_wasm(input: &str) -> String {
    serde_json::to_string(&render::render_artifact_json(input))
        .expect("bounded artifact report serializes")
}

#[cfg(all(feature = "wasm-png", feature = "png-corpus"))]
#[wasm_bindgen(js_name=png_corpus_manifest)]
pub fn png_corpus_manifest_wasm() -> String {
    match render::png_corpus::png_corpus_manifest() {
        Ok(report) => report,
        Err(error) => serde_json::json!({"error":error}).to_string(),
    }
}

#[cfg(feature = "typegen")]
pub fn typescript_declarations() -> String {
    use ts_rs::{Config, TS};
    let cfg = Config::default();
    let mut declarations = vec![
        EngineIdentity::decl(&cfg),
        ReceiptGate::decl(&cfg),
        ReceiptGates::decl(&cfg),
        ReceiptConversion::decl(&cfg),
        EngineReceipt::decl(&cfg),
        Diagnostic::decl(&cfg),
        ValidationReport::decl(&cfg),
    ];
    declarations.extend(common::declarations(&cfg));
    declarations.extend(architecture::declarations(&cfg));
    declarations.extend(workflow::declarations(&cfg));
    declarations.extend(sequence::declarations(&cfg));
    declarations.extend(dataflow::declarations(&cfg));
    declarations.extend(lifecycle::declarations(&cfg));
    declarations.extend(floorplan::declarations(&cfg));
    #[cfg(feature = "geometry")]
    {
        declarations.extend(geometry::declarations(&cfg));
        declarations.extend(metrics::declarations(&cfg));
    }
    declarations
        .into_iter()
        .map(|s| {
            format!(
                "export {}",
                s.lines().map(str::trim_end).collect::<Vec<_>>().join("\n")
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALID: &str = r#"{
      "schema_version":1,
      "diagram_type":"architecture",
      "meta":{"title":"한日中 overview","output":"overview.html","locale":"en"},
      "layout":{"mode":"grid","cols":2},
      "components":[
        {"id":"web","type":"frontend","label":"한日中","row":0,"col":0},
        {"id":"api","type":"backend","label":"API","row":0,"col":1}
      ],
      "connections":[{"from":"web","to":"api","label":"request"}],
      "boundaries":[{"kind":"region","label":"App","wraps":["api"]}]
    }"#;

    #[test]
    fn validates_architecture_ids_references_and_declared_grid_bounds() {
        let report = validate_json(VALID);
        assert!(report.ok, "{:?}", report.diagnostics);
        assert_eq!(report.api_version, API_VERSION);
        assert_eq!(report.receipt.engine.id, ENGINE_ID);
        assert_eq!(report.receipt.engine.version, env!("CARGO_PKG_VERSION"));
        assert_eq!(report.receipt.input_spec_sha256, spec_hash(VALID));
        assert_eq!(
            report.receipt.gates.schema.scope,
            "architecture-document-validity"
        );
        assert_eq!(report.receipt.gates.artifact.status, "not-run");
    }

    #[test]
    fn rejects_invalid_component_ids_duplicates_missing_connections_and_bounds() {
        let invalid = r#"{
          "schema_version":1,"diagram_type":"architecture",
          "meta":{"title":"T","output":"t.html"},
          "layout":{"mode":"grid","cols":1},
          "components":[
            {"id":"1bad","type":"backend","label":"A","col":0},
            {"id":"same","type":"backend","label":"B","col":1},
            {"id":"same","type":"backend","label":"C","col":0}
          ],
          "connections":[{"from":"same","to":"absent"}]
        }"#;
        let report = validate_json(invalid);
        assert!(!report.ok);
        let codes: Vec<_> = report
            .diagnostics
            .iter()
            .map(|item| item.code.as_str())
            .collect();
        assert!(codes.contains(&"architecture/id"));
        assert!(codes.contains(&"architecture/duplicate-id"));
        assert!(codes.contains(&"architecture/grid-column"));
        assert!(codes.contains(&"architecture/reference"));
        assert!(report
            .diagnostics
            .iter()
            .all(|item| !item.message.is_empty() && !item.fix.is_empty()));
    }

    #[test]
    fn malformed_input_has_a_cause_and_next_step() {
        let report = validate_json("{");
        assert!(!report.ok);
        assert_eq!(report.diagnostics[0].code, "document/json");
        assert_eq!(report.receipt.diagram_type, None);
        assert!(!report.diagnostics[0].message.is_empty());
        assert!(!report.diagnostics[0].fix.is_empty());
    }

    #[test]
    fn rejected_other_diagram_type_is_retained_in_the_receipt() {
        let other_type = r#"{
          "schema_version":1,"diagram_type":"workflow",
          "meta":{"title":"T","output":"t.html"},
          "components":[{"id":"api","type":"backend","label":"API"}]
        }"#;
        let report = validate_json(other_type);
        assert!(!report.ok);
        assert_eq!(report.receipt.diagram_type.as_deref(), Some("workflow"));
        assert!(report
            .diagnostics
            .iter()
            .any(|item| item.code == "workflow/shape"));
    }

    #[test]
    fn parses_archify_engine_pin_name_into_canonical_engine_id() {
        let legacy = r#"{
          "schemaVersion":1,"inputSpecSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "enginePin":{"name":"archify","version":"3.0.0","revision":"0123456789abcdef0123456789abcdef01234567"},
          "engineOutputSha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          "conversion":{"format":"png","theme":"dark","pixelRatio":2},
          "readback":{"status":"passed","scope":"native-file-readback"},
          "outputSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "outputMimeType":"text/html",
          "gates":{"schema":{"status":"passed","scope":"pinned-engine-validation"},"artifact":{"status":"passed","scope":"pinned-engine-rendered-html"},"browser":{"status":"not-run","scope":"none"},"visualReview":{"status":"not-run","scope":"manual"}}
        }"#;
        let receipt = parse_receipt_json(legacy).unwrap();
        assert_eq!(receipt.engine.id, "archify");
        assert_eq!(receipt.engine.version, "3.0.0");
        assert_eq!(
            receipt.engine_output_sha256.as_deref(),
            Some("cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc")
        );
        assert_eq!(receipt.conversion.as_ref().unwrap().format, "png");
        assert_eq!(receipt.conversion.as_ref().unwrap().theme, "dark");
        assert_eq!(receipt.conversion.as_ref().unwrap().pixel_ratio, 2);
        assert_eq!(
            receipt.readback.as_ref().unwrap().scope,
            "native-file-readback"
        );
        let canonical = serde_json::to_value(receipt).unwrap();
        assert_eq!(canonical["engine"]["id"], "archify");
        assert_eq!(
            canonical["engineOutputSha256"],
            "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
        );
        assert_eq!(canonical["conversion"]["pixelRatio"], 2);
        assert_eq!(canonical["readback"]["status"], "passed");
        assert!(canonical.get("enginePin").is_none());
    }

    // Full corpus equivalence and rule coverage are asserted in tests/differential.rs.

    #[cfg(feature = "typegen")]
    #[test]
    fn generated_typescript_declarations_are_module_exports() {
        let declarations = typescript_declarations();
        assert!(declarations.starts_with("export type EngineIdentity"));
        assert!(declarations.contains("export type EngineReceipt"));
        assert!(declarations.contains("export type ValidationReport"));
    }
}
