//! Independent E0 architecture validation slice for the Maru diagram engine.
//!
//! This crate validates typed JSON only. It intentionally does not perform
//! layout, routing, rendering, filesystem access, or Tauri integration.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;

pub const API_VERSION: u32 = 1;
pub const ENGINE_ID: &str = "maru-diagram-engine";
pub const ENGINE_REVISION: &str = "e0-architecture-v1";
pub const ARCHITECTURE_SCHEMA_VERSION: u32 = 1;
const MAX_GRID_COLUMNS: u32 = 12;

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

/// Typed input for the E0 architecture slice. Unknown renderer/layout
/// extensions are ignored and are outside this receipt's validation scope.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
pub struct ArchitectureSpec {
    #[serde(rename = "schema_version")]
    #[cfg_attr(feature = "typegen", ts(rename = "schema_version"))]
    pub schema_version: u32,
    #[serde(rename = "diagram_type")]
    #[cfg_attr(feature = "typegen", ts(rename = "diagram_type"))]
    pub diagram_type: String,
    pub meta: ArchitectureMeta,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub layout: Option<ArchitectureLayout>,
    pub components: Vec<ArchitectureComponent>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(as = "Option<_>", optional))]
    pub connections: Vec<ArchitectureConnection>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(as = "Option<_>", optional))]
    pub boundaries: Vec<ArchitectureBoundary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
pub struct ArchitectureMeta {
    pub title: String,
    pub output: String,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub locale: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
pub struct ArchitectureLayout {
    pub mode: String,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub cols: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
pub struct ArchitectureComponent {
    pub id: String,
    #[serde(rename = "type")]
    #[cfg_attr(feature = "typegen", ts(rename = "type"))]
    pub component_type: String,
    pub label: String,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub row: Option<u32>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub col: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
pub struct ArchitectureConnection {
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub id: Option<String>,
    pub from: String,
    pub to: String,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
pub struct ArchitectureBoundary {
    pub kind: String,
    pub label: String,
    pub wraps: Vec<String>,
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

fn valid_id(value: &str) -> bool {
    let mut bytes = value.bytes();
    bytes
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic())
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn validate_architecture(spec: ArchitectureSpec) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();
    if spec.schema_version != ARCHITECTURE_SCHEMA_VERSION {
        diagnostics.push(diagnostic(
            "schema/version",
            "/schema_version",
            "architecture-v1/schema-version",
            format!(
                "architecture schema version {} is unsupported",
                spec.schema_version
            ),
            "set schema_version to 1 or migrate the document before validating",
        ));
    }
    if spec.diagram_type != "architecture" {
        diagnostics.push(diagnostic(
            "schema/diagram-type",
            "/diagram_type",
            "architecture-v1/type",
            format!(
                "diagram_type must be architecture, found {}",
                spec.diagram_type
            ),
            "submit an architecture spec or select the matching engine type",
        ));
    }
    if spec.meta.title.trim().is_empty() {
        diagnostics.push(diagnostic(
            "schema/title-required",
            "/meta/title",
            "architecture-v1/title",
            "diagram title is empty",
            "add a nonempty title to meta.title",
        ));
    }
    if spec.meta.output.trim().is_empty() {
        diagnostics.push(diagnostic(
            "schema/output-required",
            "/meta/output",
            "architecture-v1/output",
            "diagram output name is empty",
            "add an output filename to meta.output",
        ));
    }
    if let Some(locale) = spec.meta.locale.as_deref() {
        if locale.trim().is_empty() {
            diagnostics.push(diagnostic(
                "schema/locale-empty",
                "/meta/locale",
                "architecture-v1/locale",
                "locale is present but empty",
                "remove meta.locale or provide a locale tag",
            ));
        }
    }
    if let Some(layout) = &spec.layout {
        if layout.mode != "grid" {
            diagnostics.push(diagnostic(
                "layout/mode",
                "/layout/mode",
                "architecture-v1/grid-mode",
                format!("architecture E0 supports grid mode, found {}", layout.mode),
                "set layout.mode to grid",
            ));
        }
        if layout
            .cols
            .is_some_and(|cols| cols == 0 || cols > MAX_GRID_COLUMNS)
        {
            diagnostics.push(diagnostic(
                "layout/columns",
                "/layout/cols",
                "architecture-v1/grid-columns",
                format!("declared grid columns must be between 1 and {MAX_GRID_COLUMNS}"),
                format!("set layout.cols to an integer from 1 through {MAX_GRID_COLUMNS}"),
            ));
        }
    }

    let mut component_ids = HashSet::new();
    for (index, component) in spec.components.iter().enumerate() {
        let path = format!("/components/{index}");
        if !valid_id(&component.id) {
            diagnostics.push(diagnostic(
                "component/id-syntax",
                &format!("{path}/id"),
                "architecture-v1/component-id",
                format!(
                    "component ID {:?} is empty or has unsupported characters",
                    component.id
                ),
                "use an ASCII letter followed by letters, digits, underscores, or hyphens",
            ));
        }
        if !component_ids.insert(component.id.as_str()) {
            diagnostics.push(diagnostic(
                "component/id-duplicate",
                &format!("{path}/id"),
                "architecture-v1/component-id-unique",
                format!("component ID {:?} is duplicated", component.id),
                "assign a unique component ID",
            ));
        }
        if component.label.trim().is_empty() {
            diagnostics.push(diagnostic(
                "component/label-required",
                &format!("{path}/label"),
                "architecture-v1/component-label",
                "component label is empty",
                "add a nonempty label",
            ));
        }
        if !matches!(
            component.component_type.as_str(),
            "frontend" | "backend" | "database" | "cloud" | "security" | "messagebus" | "external"
        ) {
            diagnostics.push(diagnostic(
                "component/type",
                &format!("{path}/type"),
                "architecture-v1/component-type",
                format!(
                    "component type {:?} is unsupported",
                    component.component_type
                ),
                "select a supported architecture component type",
            ));
        }
        if let (Some(col), Some(layout)) = (component.col, spec.layout.as_ref()) {
            if layout.cols.is_some_and(|columns| col >= columns) {
                diagnostics.push(diagnostic(
                    "grid/column-out-of-bounds",
                    &format!("{path}/col"),
                    "architecture-v1/declared-grid-bounds",
                    format!("component column {col} is outside the declared grid"),
                    "increase layout.cols or move the component into the declared columns",
                ));
            }
        }
    }
    if spec.components.is_empty() {
        diagnostics.push(diagnostic(
            "component/empty",
            "/components",
            "architecture-v1/components-required",
            "architecture requires at least one component",
            "add a component before validating the diagram",
        ));
    }
    for (index, connection) in spec.connections.iter().enumerate() {
        for (field, id) in [
            ("from", connection.from.as_str()),
            ("to", connection.to.as_str()),
        ] {
            if !component_ids.contains(id) {
                diagnostics.push(diagnostic(
                    "connection/endpoint-missing",
                    &format!("/connections/{index}/{field}"),
                    "architecture-v1/connection-reference",
                    format!("connection endpoint {id:?} does not name a component"),
                    "use the ID of an existing component or add the missing component",
                ));
            }
        }
        if connection.id.as_deref().is_some_and(|id| !valid_id(id)) {
            diagnostics.push(diagnostic(
                "connection/id-syntax",
                &format!("/connections/{index}/id"),
                "architecture-v1/connection-id",
                "connection ID has unsupported characters",
                "use an ASCII letter followed by letters, digits, underscores, or hyphens",
            ));
        }
    }
    for (index, boundary) in spec.boundaries.iter().enumerate() {
        if boundary.label.trim().is_empty() {
            diagnostics.push(diagnostic(
                "boundary/label-required",
                &format!("/boundaries/{index}/label"),
                "architecture-v1/boundary-label",
                "boundary label is empty",
                "add a nonempty boundary label",
            ));
        }
        for (wrap_index, id) in boundary.wraps.iter().enumerate() {
            if !component_ids.contains(id.as_str()) {
                diagnostics.push(diagnostic(
                    "boundary/wrap-reference-missing",
                    &format!("/boundaries/{index}/wraps/{wrap_index}"),
                    "architecture-v1/boundary-reference",
                    format!("boundary member {id:?} does not name a component"),
                    "use the ID of an existing component",
                ));
            }
        }
    }
    diagnostics
}

fn make_report(
    input: &str,
    diagram_type: Option<String>,
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
                schema: gate(
                    if ok { "passed" } else { "failed" },
                    "architecture-v1-validation-slice",
                ),
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

/// Validate only the declared E0 architecture slice. A passing report means
/// these rules passed; it is not a full-schema, layout, or render proof.
pub fn validate_json(input: &str) -> ValidationReport {
    let value: serde_json::Value = match serde_json::from_str(input) {
        Ok(value) => value,
        Err(error) => {
            return make_report(
                input,
                None,
                vec![diagnostic(
                    "json/parse",
                    "$",
                    "architecture-v1/json",
                    format!(
                        "input is not valid JSON at line {}, column {}: {error}",
                        error.line(),
                        error.column()
                    ),
                    "repair JSON syntax and submit the architecture spec again",
                )],
            );
        }
    };
    let diagram_type = value
        .get("diagram_type")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    match serde_json::from_value::<ArchitectureSpec>(value) {
        Ok(spec) => make_report(input, diagram_type, validate_architecture(spec)),
        Err(error) => make_report(
            input,
            diagram_type,
            vec![diagnostic(
                "schema/type",
                "$",
                "architecture-v1/typed-structure",
                format!("architecture JSON does not match the supported typed fields: {error}"),
                "use the architecture v1 typed fields and retry",
            )],
        ),
    }
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
pub fn validate_architecture_json(input: &str) -> String {
    serde_json::to_string(&validate_json(input))
        .unwrap_or_else(|error| format!("{{\"error\":\"serialization failed: {error}\"}}"))
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

#[cfg(feature = "typegen")]
pub fn typescript_declarations() -> String {
    use ts_rs::{Config, TS};
    let config = Config::default();
    [
        EngineIdentity::decl(&config),
        ReceiptGate::decl(&config),
        ReceiptGates::decl(&config),
        ReceiptConversion::decl(&config),
        EngineReceipt::decl(&config),
        Diagnostic::decl(&config),
        ValidationReport::decl(&config),
        ArchitectureMeta::decl(&config),
        ArchitectureLayout::decl(&config),
        ArchitectureComponent::decl(&config),
        ArchitectureConnection::decl(&config),
        ArchitectureBoundary::decl(&config),
        ArchitectureSpec::decl(&config),
    ]
    .into_iter()
    .map(|declaration| format!("export {declaration}"))
    .collect::<Vec<_>>()
    .join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ParityCorpus {
        cases: Vec<ParityCase>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ParityCase {
        id: String,
        diagram_type: String,
        input_json: String,
        expected_core_ok: Option<bool>,
    }

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
            "architecture-v1-validation-slice"
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
        assert!(codes.contains(&"component/id-syntax"));
        assert!(codes.contains(&"component/id-duplicate"));
        assert!(codes.contains(&"grid/column-out-of-bounds"));
        assert!(codes.contains(&"connection/endpoint-missing"));
        assert!(report
            .diagnostics
            .iter()
            .all(|item| !item.message.is_empty() && !item.fix.is_empty()));
    }

    #[test]
    fn malformed_input_has_a_cause_and_next_step() {
        let report = validate_json("{");
        assert!(!report.ok);
        assert_eq!(report.diagnostics[0].code, "json/parse");
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
            .any(|item| item.code == "schema/diagram-type"));
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

    #[test]
    fn parses_thirty_case_parity_corpus_and_checks_declared_architecture_slice() {
        let corpus: ParityCorpus =
            serde_json::from_str(include_str!("../testdata/parity.json")).unwrap();
        assert!(corpus.cases.len() >= 30);

        let mut architecture_inputs = 0;
        let mut expected_subset = 0;
        for case in corpus.cases {
            if case.diagram_type != "architecture" {
                continue;
            }
            architecture_inputs += 1;
            let report = validate_json(&case.input_json);
            let Some(expected) = case.expected_core_ok else {
                continue;
            };
            assert_eq!(
                report.ok, expected,
                "parity case {}: {:?}",
                case.id, report.diagnostics
            );
            expected_subset += 1;
        }
        assert!(architecture_inputs >= 22);
        assert_eq!(expected_subset, 12);
    }

    #[cfg(feature = "typegen")]
    #[test]
    fn generated_typescript_declarations_are_module_exports() {
        let declarations = typescript_declarations();
        assert!(declarations.starts_with("export type EngineIdentity"));
        assert!(declarations.contains("export type EngineReceipt"));
        assert!(declarations.contains("export type ValidationReport"));
    }
}
