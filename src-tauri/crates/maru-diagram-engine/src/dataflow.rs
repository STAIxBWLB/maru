//! Data-flow document validity, independent of layout and routing.

use crate::common::{self, Card, Decoration, Meta, Point};
use crate::Diagnostic;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

const KIND: &str = "dataflow";
const TYPES: &[&str] = &[
    "frontend",
    "backend",
    "database",
    "cloud",
    "security",
    "messagebus",
    "external",
];
const VARIANTS: &[&str] = &["default", "emphasis", "security", "dashed"];
const SIDES: &[&str] = &["left", "right", "top", "bottom"];
const ROUTES: &[&str] = &[
    "auto",
    "straight",
    "vertical-channel",
    "bottom-channel",
    "top-channel",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
pub struct DataflowSpec {
    pub schema_version: u32,
    pub diagram_type: String,
    pub meta: Meta,
    pub stages: Vec<DataflowStage>,
    pub nodes: Vec<DataflowNode>,
    pub flows: Vec<DataflowFlow>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(as = "Option<_>", optional))]
    pub cards: Vec<Card>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
pub struct DataflowStage {
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
pub struct DataflowNode {
    pub id: String,
    #[serde(rename = "type")]
    pub component_type: String,
    pub label: String,
    pub stage: u32,
    pub row: f64,
    #[serde(flatten)]
    #[cfg_attr(feature = "typegen", ts(flatten))]
    pub decoration: Decoration,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub width: Option<f64>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub height: Option<f64>,
    #[serde(default, rename = "yOffset")]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub y_offset: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
pub struct DataflowFlow {
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub id: Option<String>,
    pub from: String,
    pub to: String,
    pub label: String,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub classification: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub variant: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub route: Option<String>,
    #[serde(default, rename = "fromSide")]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub from_side: Option<String>,
    #[serde(default, rename = "toSide")]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub to_side: Option<String>,
    #[serde(default, rename = "channelX")]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub channel_x: Option<f64>,
    #[serde(default, rename = "channelY")]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub channel_y: Option<f64>,
    #[serde(default, rename = "labelAt")]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub label_at: Option<Point>,
    #[serde(default, rename = "labelDx")]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub label_dx: Option<f64>,
    #[serde(default, rename = "labelDy")]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub label_dy: Option<f64>,
    #[serde(default, rename = "labelSegment")]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub label_segment: Option<f64>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub via: Option<Vec<Point>>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub width: Option<f64>,
}

fn child_fields(value: &Value, collection: &str, fields: &[&str], ctx: &mut common::Context) {
    if let Some(items) = value.get(collection).and_then(Value::as_array) {
        for (index, item) in items.iter().enumerate() {
            ctx.fields(item, &format!("/{collection}/{index}"), fields);
        }
    }
}

pub(crate) fn validate(value: Value) -> Vec<Diagnostic> {
    let mut ctx = common::base(
        &value,
        KIND,
        &[
            "schema_version",
            "diagram_type",
            "meta",
            "stages",
            "nodes",
            "flows",
            "cards",
        ],
        &[],
        (360.0, 360.0),
    );
    child_fields(&value, "stages", &["label"], &mut ctx);
    child_fields(
        &value,
        "nodes",
        &[
            "id", "type", "label", "sublabel", "tag", "icon", "brand", "sources", "stage", "row",
            "width", "height", "yOffset",
        ],
        &mut ctx,
    );
    child_fields(
        &value,
        "flows",
        &[
            "id",
            "from",
            "to",
            "label",
            "classification",
            "variant",
            "route",
            "fromSide",
            "toSide",
            "channelX",
            "channelY",
            "labelAt",
            "labelDx",
            "labelDy",
            "labelSegment",
            "via",
            "width",
        ],
        &mut ctx,
    );
    let Some(spec) = common::decode::<DataflowSpec>(&value, &mut ctx) else {
        return ctx.finish();
    };
    ctx.cardinality(spec.stages.len(), 2, "/stages");
    if spec.stages.len() > 5 {
        ctx.error(
            "cardinality",
            "/stages",
            "dataflow has more than five stages",
            "keep between two and five stages",
        );
    }
    ctx.cardinality(spec.nodes.len(), 2, "/nodes");
    for (index, stage) in spec.stages.iter().enumerate() {
        ctx.text(&stage.label, 1, None, &format!("/stages/{index}/label"));
    }
    let mut nodes = HashSet::new();
    for (index, node) in spec.nodes.iter().enumerate() {
        let path = format!("/nodes/{index}");
        ctx.insert_id(&mut nodes, &node.id, &format!("{path}/id"));
        ctx.enum_value(&node.component_type, TYPES, &format!("{path}/type"));
        ctx.text(&node.label, 1, None, &format!("{path}/label"));
        common::validate_decoration(&node.decoration, &path, &mut ctx);
        ctx.integer(node.row, Some(0.0), None, &format!("{path}/row"));
        if node.stage as usize >= spec.stages.len() {
            ctx.error(
                "stage-reference",
                &format!("{path}/stage"),
                "node stage does not identify a declared stage",
                "set stage to an existing zero-based stage index",
            );
        }
        if let Some(width) = node.width {
            ctx.range(width, Some(48.0), None, &format!("{path}/width"));
        }
        if let Some(height) = node.height {
            ctx.range(height, Some(36.0), None, &format!("{path}/height"));
        }
    }
    let mut focus_ids = nodes.clone();
    let mut flow_ids = HashSet::new();
    for (index, flow) in spec.flows.iter().enumerate() {
        let path = format!("/flows/{index}");
        if let Some(id) = &flow.id {
            ctx.insert_id(&mut flow_ids, id, &format!("{path}/id"));
            focus_ids.insert(id.clone());
        }
        ctx.reference(&flow.from, &nodes, &format!("{path}/from"), "reference");
        ctx.reference(&flow.to, &nodes, &format!("{path}/to"), "reference");
        ctx.text(&flow.label, 1, None, &format!("{path}/label"));
        if let Some(variant) = &flow.variant {
            ctx.enum_value(variant, VARIANTS, &format!("{path}/variant"));
        }
        if let Some(route) = &flow.route {
            ctx.enum_value(route, ROUTES, &format!("{path}/route"));
        }
        for (field, side) in [("fromSide", &flow.from_side), ("toSide", &flow.to_side)] {
            if let Some(side) = side {
                ctx.enum_value(side, SIDES, &format!("{path}/{field}"));
            }
        }
        if let Some(segment) = flow.label_segment {
            ctx.integer(segment, Some(0.0), None, &format!("{path}/labelSegment"));
        }
        if let Some(width) = flow.width {
            ctx.range(width, Some(0.5), None, &format!("{path}/width"));
        }
    }
    common::validate_meta_refs(&spec.meta, &focus_ids, &mut ctx);
    ctx.finish()
}

#[cfg(feature = "typegen")]
pub fn declarations(cfg: &ts_rs::Config) -> Vec<String> {
    use ts_rs::TS;
    vec![
        DataflowStage::decl(cfg),
        DataflowNode::decl(cfg),
        DataflowFlow::decl(cfg),
        DataflowSpec::decl(cfg),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn minimal() -> Value {
        json!({
            "schema_version": 1, "diagram_type": "dataflow",
            "meta": { "title": "Data flow", "output": "dataflow.html" },
            "stages": [{ "label": "Input" }, { "label": "Output" }],
            "nodes": [
                { "id": "input", "type": "frontend", "label": "Input", "stage": 0, "row": 0 },
                { "id": "output", "type": "backend", "label": "Output", "stage": 1, "row": 0 }
            ],
            "flows": [{ "from": "input", "to": "output", "label": "Data" }]
        })
    }

    #[test]
    fn accepts_minimal_dataflow_without_optional_node_and_flow_fields() {
        assert!(validate(minimal()).is_empty());
    }

    #[test]
    fn accepts_schema_unbounded_integer_fields_without_a_u32_cap() {
        let mut spec = minimal();
        spec["nodes"][1]["row"] = json!(1_000_000_000_000_f64);
        spec["flows"][0]["labelSegment"] = json!(1_000_000_000_000_f64);
        assert!(validate(spec).is_empty());
    }

    #[test]
    fn rejects_nonintegral_or_negative_unbounded_integer_fields() {
        let mut spec = minimal();
        spec["nodes"][1]["row"] = json!(0.5);
        spec["flows"][0]["labelSegment"] = json!(-1);
        let diagnostics = validate(spec);
        assert!(diagnostics.iter().any(|item| item.path == "/nodes/1/row"));
        assert!(diagnostics
            .iter()
            .any(|item| item.path == "/flows/0/labelSegment"));
    }

    #[test]
    fn rejects_missing_stage_or_endpoint_and_static_size_bounds() {
        let mut spec = minimal();
        spec["nodes"][0]["stage"] = json!(2);
        spec["nodes"][1]["width"] = json!(20);
        spec["flows"][0]["to"] = json!("missing");
        let diagnostics = validate(spec);
        assert!(diagnostics
            .iter()
            .any(|item| item.code == "dataflow/stage-reference"));
        assert!(diagnostics
            .iter()
            .any(|item| item.code == "dataflow/reference"));
        assert!(diagnostics.iter().any(|item| item.code == "dataflow/range"));
        assert!(diagnostics
            .iter()
            .all(|item| !item.message.is_empty() && !item.fix.is_empty()));
    }

    #[test]
    fn rejects_duplicate_authored_flow_ids_and_invalid_route_values() {
        let mut spec = minimal();
        spec["flows"][0]["id"] = json!("flow");
        spec["flows"][0]["route"] = json!("unsupported");
        spec["flows"].as_array_mut().unwrap().push(json!({
            "id": "flow", "from": "output", "to": "input", "label": "Return"
        }));
        let diagnostics = validate(spec);
        assert!(diagnostics
            .iter()
            .any(|item| item.code == "dataflow/duplicate-id"));
        assert!(diagnostics.iter().any(|item| item.code == "dataflow/enum"));
    }
}
