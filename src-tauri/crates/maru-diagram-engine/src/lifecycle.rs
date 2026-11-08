//! Independent E1 structural and reference validation for lifecycle documents.

use crate::common::{self, Context, Decoration, Meta, Point, SourceReference, SIDES, VARIANTS};
use crate::Diagnostic;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

const STATE_TYPES: &[&str] = &[
    "start", "active", "waiting", "decision", "success", "failure", "neutral", "external",
];
const LIFECYCLE_ROUTES: &[&str] = &[
    "auto",
    "straight",
    "drop",
    "bottom-channel",
    "top-channel",
    "right-channel",
    "left-channel",
];
const MAX_COLUMN: u32 = 4;
const MAX_LANES: usize = 4;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "typegen", ts(rename_all = "camelCase"))]
pub struct LifecycleSpec {
    #[serde(rename = "schema_version")]
    #[cfg_attr(feature = "typegen", ts(rename = "schema_version"))]
    pub schema_version: u32,
    #[serde(rename = "diagram_type")]
    #[cfg_attr(feature = "typegen", ts(rename = "diagram_type"))]
    pub diagram_type: String,
    pub meta: Meta,
    pub lanes: Vec<LifecycleLane>,
    pub states: Vec<LifecycleState>,
    pub transitions: Vec<LifecycleTransition>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub cards: Option<Vec<crate::common::Card>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
pub struct LifecycleLane {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "typegen", ts(rename_all = "camelCase"))]
pub struct LifecycleState {
    pub id: String,
    #[serde(rename = "type")]
    #[cfg_attr(feature = "typegen", ts(rename = "type"))]
    pub state_type: String,
    pub label: String,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub sublabel: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub tag: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub icon: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub brand: Option<crate::common::Brand>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub sources: Option<Vec<SourceReference>>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub step: Option<String>,
    pub lane: String,
    pub col: u32,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub width: Option<f64>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub height: Option<f64>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub y_offset: Option<f64>,
}

impl LifecycleState {
    fn decoration(&self) -> Decoration {
        Decoration {
            sublabel: self.sublabel.clone(),
            tag: self.tag.clone(),
            icon: self.icon.clone(),
            brand: self.brand.clone(),
            sources: self.sources.clone(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "typegen", ts(rename_all = "camelCase"))]
pub struct LifecycleTransition {
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub id: Option<String>,
    pub from: String,
    pub to: String,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub label: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub note: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub variant: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub route: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub from_side: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub to_side: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub channel_x: Option<f64>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub channel_y: Option<f64>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub corner_radius: Option<f64>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub label_at: Option<Point>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub label_dx: Option<f64>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub label_dy: Option<f64>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub label_segment: Option<f64>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub via: Option<Vec<Point>>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub width: Option<f64>,
}

fn collection_fields(value: &Value, key: &str, fields: &[&str], ctx: &mut Context) {
    if let Some(items) = value.get(key).and_then(Value::as_array) {
        for (index, item) in items.iter().enumerate() {
            ctx.fields(item, &format!("/{key}/{index}"), fields);
        }
    }
}

fn decoration_fields(value: &Value, path: &str, ctx: &mut Context) {
    if value.get("brand").is_some_and(Value::is_object) {
        ctx.fields(
            &value["brand"],
            &format!("{path}/brand"),
            &["url", "sha256"],
        );
    }
    if let Some(sources) = value.get("sources").and_then(Value::as_array) {
        for (index, source) in sources.iter().enumerate() {
            ctx.fields(
                source,
                &format!("{path}/sources/{index}"),
                &["path", "line", "end_line", "label"],
            );
        }
    }
}

fn validate_shape_fields(value: &Value, ctx: &mut Context) {
    collection_fields(value, "lanes", &["id", "label"], ctx);
    collection_fields(
        value,
        "states",
        &[
            "id", "type", "label", "sublabel", "tag", "icon", "brand", "sources", "step", "lane",
            "col", "width", "height", "yOffset",
        ],
        ctx,
    );
    if let Some(states) = value.get("states").and_then(Value::as_array) {
        for (index, state) in states.iter().enumerate() {
            decoration_fields(state, &format!("/states/{index}"), ctx);
        }
    }
    collection_fields(
        value,
        "transitions",
        &[
            "id",
            "from",
            "to",
            "label",
            "note",
            "variant",
            "route",
            "fromSide",
            "toSide",
            "channelX",
            "channelY",
            "cornerRadius",
            "labelAt",
            "labelDx",
            "labelDy",
            "labelSegment",
            "via",
            "width",
        ],
        ctx,
    );
}

fn validate_document(spec: &LifecycleSpec, ctx: &mut Context) {
    // The shared base validates these fields; retain them in the typed model.
    let _shared_header = (spec.schema_version, spec.diagram_type.as_str());
    let mut lane_ids = HashSet::new();
    ctx.cardinality(spec.lanes.len(), 1, "/lanes");
    if spec.lanes.len() > MAX_LANES {
        ctx.error(
            "lane-count",
            "/lanes",
            format!(
                "lifecycle has {} lanes; the schema permits at most {MAX_LANES}",
                spec.lanes.len()
            ),
            format!("remove lanes until at most {MAX_LANES} remain"),
        );
    }
    for (index, lane) in spec.lanes.iter().enumerate() {
        let path = format!("/lanes/{index}");
        ctx.insert_id(&mut lane_ids, &lane.id, &format!("{path}/id"));
        ctx.text(&lane.label, 1, None, &format!("{path}/label"));
    }

    let mut state_ids = HashSet::new();
    ctx.cardinality(spec.states.len(), 2, "/states");
    for (index, state) in spec.states.iter().enumerate() {
        let path = format!("/states/{index}");
        ctx.insert_id(&mut state_ids, &state.id, &format!("{path}/id"));
        ctx.enum_value(&state.state_type, STATE_TYPES, &format!("{path}/type"));
        ctx.text(&state.label, 1, None, &format!("{path}/label"));
        ctx.id(&state.lane, &format!("{path}/lane"));
        ctx.reference(
            &state.lane,
            &lane_ids,
            &format!("{path}/lane"),
            "lane-reference",
        );
        ctx.range(
            state.col as f64,
            Some(0.0),
            Some(MAX_COLUMN as f64),
            &format!("{path}/col"),
        );
        common::validate_decoration(&state.decoration(), &path, ctx);
        if let Some(step) = &state.step {
            ctx.text(step, 0, None, &format!("{path}/step"));
        }
        if let Some(width) = state.width {
            ctx.range(width, Some(48.0), None, &format!("{path}/width"));
        }
        if let Some(height) = state.height {
            ctx.range(height, Some(36.0), None, &format!("{path}/height"));
        }
        if let Some(y_offset) = state.y_offset {
            ctx.range(y_offset, None, None, &format!("{path}/yOffset"));
        }
    }

    let mut transition_ids = HashSet::new();
    for (index, transition) in spec.transitions.iter().enumerate() {
        let path = format!("/transitions/{index}");
        if let Some(id) = &transition.id {
            ctx.insert_id(&mut transition_ids, id, &format!("{path}/id"));
        }
        for (field, id) in [("from", &transition.from), ("to", &transition.to)] {
            ctx.id(id, &format!("{path}/{field}"));
            ctx.reference(
                id,
                &state_ids,
                &format!("{path}/{field}"),
                "transition-endpoint",
            );
        }
        if let Some(label) = &transition.label {
            ctx.text(label, 0, None, &format!("{path}/label"));
        }
        if let Some(note) = &transition.note {
            ctx.text(note, 0, None, &format!("{path}/note"));
        }
        if let Some(variant) = &transition.variant {
            ctx.enum_value(variant, VARIANTS, &format!("{path}/variant"));
        }
        if let Some(route) = &transition.route {
            ctx.enum_value(route, LIFECYCLE_ROUTES, &format!("{path}/route"));
        }
        for (field, side) in [
            ("fromSide", &transition.from_side),
            ("toSide", &transition.to_side),
        ] {
            if let Some(side) = side {
                ctx.enum_value(side, SIDES, &format!("{path}/{field}"));
            }
        }
        for (field, value) in [
            ("channelX", transition.channel_x),
            ("channelY", transition.channel_y),
            ("cornerRadius", transition.corner_radius),
            ("labelDx", transition.label_dx),
            ("labelDy", transition.label_dy),
        ] {
            if let Some(value) = value {
                let minimum = if field == "cornerRadius" {
                    Some(0.0)
                } else {
                    None
                };
                ctx.range(value, minimum, None, &format!("{path}/{field}"));
            }
        }
        if let Some(label_segment) = transition.label_segment {
            ctx.integer(
                label_segment,
                Some(0.0),
                None,
                &format!("{path}/labelSegment"),
            );
        }
        if let Some(width) = transition.width {
            ctx.range(width, Some(0.5), None, &format!("{path}/width"));
        }
        if let Some(label_at) = transition.label_at {
            for (axis, value) in label_at.into_iter().enumerate() {
                ctx.range(value, None, None, &format!("{path}/labelAt/{axis}"));
            }
        }
        if let Some(via) = &transition.via {
            for (point_index, point) in via.iter().enumerate() {
                for (axis, value) in point.iter().enumerate() {
                    ctx.range(
                        *value,
                        None,
                        None,
                        &format!("{path}/via/{point_index}/{axis}"),
                    );
                }
            }
        }
    }
    common::validate_meta_refs(&spec.meta, &state_ids, ctx);
}

/// Validate the E1 lifecycle document contract without geometry or renderer checks.
pub(crate) fn validate(value: Value) -> Vec<Diagnostic> {
    let mut ctx = common::base(
        &value,
        "lifecycle",
        &[
            "schema_version",
            "diagram_type",
            "meta",
            "lanes",
            "states",
            "transitions",
            "cards",
        ],
        &[],
        (420.0, 300.0),
    );
    validate_shape_fields(&value, &mut ctx);
    let Some(spec) = common::decode::<LifecycleSpec>(&value, &mut ctx) else {
        return ctx.finish();
    };
    validate_document(&spec, &mut ctx);
    ctx.finish()
}

#[cfg(feature = "typegen")]
pub fn declarations(cfg: &ts_rs::Config) -> Vec<String> {
    use ts_rs::TS;
    vec![
        LifecycleSpec::decl(cfg),
        LifecycleLane::decl(cfg),
        LifecycleState::decl(cfg),
        LifecycleTransition::decl(cfg),
    ]
}

#[cfg(test)]
mod tests {
    use super::validate;

    fn v2_spec() -> serde_json::Value {
        serde_json::json!({
            "schema_version": 2,
            "diagram_type": "lifecycle",
            "meta": {"title": "Lifecycle v2", "output": "lifecycle-v2.html", "viewBox": [800, 600]},
            "lanes": [{"id": "main", "label": "Main"}],
            "states": [
                {"id": "start", "type": "start", "label": "Start", "lane": "main", "col": 0},
                {"id": "done", "type": "success", "label": "Done", "lane": "main", "col": 1}
            ],
            "transitions": [{"from": "start", "to": "done"}]
        })
    }

    #[test]
    fn accepts_v2_documents_with_schema_supported_authored_coordinate_fields() {
        let diagnostics = validate(v2_spec());
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
    }

    #[test]
    fn rejects_undeclared_absolute_state_coordinates_in_v2() {
        let mut spec = v2_spec();
        spec["states"][0]["x"] = serde_json::json!(120);
        let diagnostics = validate(spec);
        assert!(diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "lifecycle/unknown-field"));
    }
}
