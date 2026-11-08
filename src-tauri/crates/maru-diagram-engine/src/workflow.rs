//! Independent E1 structural and semantic validation for workflow documents.

use crate::common::{
    self, Context, Decoration, Meta, Point, SourceReference, COMPONENT_TYPES, SIDES, VARIANTS,
};
use crate::Diagnostic;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};

const WORKFLOW_ROUTES: &[&str] = &[
    "auto",
    "straight",
    "drop",
    "outside-right",
    "return-left",
    "bottom-channel",
    "up-channel",
];
const WORKFLOW_ROLES: &[&str] = &["main", "branch", "async", "return", "error"];
const MAX_COLUMN: u32 = 5;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "typegen", ts(rename_all = "camelCase"))]
pub struct WorkflowSpec {
    #[serde(rename = "schema_version")]
    #[cfg_attr(feature = "typegen", ts(rename = "schema_version"))]
    pub schema_version: u32,
    #[serde(rename = "diagram_type")]
    #[cfg_attr(feature = "typegen", ts(rename = "diagram_type"))]
    pub diagram_type: String,
    pub meta: Meta,
    pub lanes: Vec<WorkflowLane>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub phases: Option<Vec<WorkflowPhase>>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub groups: Option<Vec<WorkflowGroup>>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub main_path: Option<Vec<String>>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub semantic_checks: Option<WorkflowSemanticChecks>,
    pub nodes: Vec<WorkflowNode>,
    pub edges: Vec<WorkflowEdge>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub cards: Option<Vec<crate::common::Card>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "typegen", ts(rename_all = "camelCase"))]
pub struct WorkflowLane {
    pub id: String,
    pub label: String,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub variant: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "typegen", ts(rename_all = "camelCase"))]
pub struct WorkflowPhase {
    pub id: String,
    pub label: String,
    pub from_col: u32,
    pub to_col: u32,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub variant: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "typegen", ts(rename_all = "camelCase"))]
pub struct WorkflowGroup {
    pub id: String,
    pub label: String,
    pub lane: String,
    pub from_col: u32,
    pub to_col: u32,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub variant: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "typegen", ts(rename_all = "camelCase"))]
pub struct WorkflowNode {
    pub id: String,
    pub lane: String,
    pub col: u32,
    #[serde(rename = "type")]
    #[cfg_attr(feature = "typegen", ts(rename = "type"))]
    pub node_type: String,
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
    pub width: Option<f64>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub height: Option<f64>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub y_offset: Option<f64>,
}

impl WorkflowNode {
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
pub struct WorkflowEdge {
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
    pub variant: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub role: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub from_side: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub to_side: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub route: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub via: Option<Vec<Point>>,
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
    pub channel_x: Option<f64>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub channel_y: Option<f64>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub bias: Option<f64>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub width: Option<f64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "typegen", ts(rename_all = "camelCase"))]
pub struct WorkflowSemanticRelation {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "typegen", ts(rename_all = "camelCase"))]
pub struct WorkflowSemanticChecks {
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub allowed_roots: Option<Vec<String>>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub allowed_terminals: Option<Vec<String>>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub required_edges: Option<Vec<WorkflowSemanticRelation>>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub required_paths: Option<Vec<WorkflowSemanticRelation>>,
}

fn collection_fields(value: &Value, key: &str, fields: &[&str], ctx: &mut Context) {
    if let Some(items) = value.get(key).and_then(Value::as_array) {
        for (index, item) in items.iter().enumerate() {
            ctx.fields(item, &format!("/{key}/{index}"), fields);
        }
    }
}

fn semantic_fields(value: &Value, ctx: &mut Context) {
    let Some(checks) = value.get("semanticChecks") else {
        return;
    };
    ctx.fields(
        checks,
        "/semanticChecks",
        &[
            "allowedRoots",
            "allowedTerminals",
            "requiredEdges",
            "requiredPaths",
        ],
    );
    for key in ["requiredEdges", "requiredPaths"] {
        if let Some(items) = checks.get(key).and_then(Value::as_array) {
            for (index, item) in items.iter().enumerate() {
                ctx.fields(
                    item,
                    &format!("/semanticChecks/{key}/{index}"),
                    &["from", "to"],
                );
            }
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
    collection_fields(value, "lanes", &["id", "label", "variant"], ctx);
    collection_fields(
        value,
        "phases",
        &["id", "label", "fromCol", "toCol", "variant"],
        ctx,
    );
    collection_fields(
        value,
        "groups",
        &["id", "label", "lane", "fromCol", "toCol", "variant"],
        ctx,
    );
    collection_fields(
        value,
        "nodes",
        &[
            "id", "lane", "col", "type", "label", "sublabel", "tag", "icon", "brand", "sources",
            "width", "height", "yOffset",
        ],
        ctx,
    );
    if let Some(nodes) = value.get("nodes").and_then(Value::as_array) {
        for (index, node) in nodes.iter().enumerate() {
            decoration_fields(node, &format!("/nodes/{index}"), ctx);
        }
    }
    collection_fields(
        value,
        "edges",
        &[
            "id",
            "from",
            "to",
            "label",
            "variant",
            "role",
            "fromSide",
            "toSide",
            "route",
            "via",
            "labelAt",
            "labelDx",
            "labelDy",
            "labelSegment",
            "channelX",
            "channelY",
            "bias",
            "width",
        ],
        ctx,
    );
    semantic_fields(value, ctx);
}

fn validate_ids_and_references(spec: &WorkflowSpec, ctx: &mut Context) -> HashSet<String> {
    // The shared base checks both shared header fields; retain them in the typed document model.
    let _shared_header = (spec.schema_version, spec.diagram_type.as_str());
    let mut lane_ids = HashSet::new();
    for (index, lane) in spec.lanes.iter().enumerate() {
        let path = format!("/lanes/{index}");
        ctx.insert_id(&mut lane_ids, &lane.id, &format!("{path}/id"));
        ctx.text(&lane.label, 1, None, &format!("{path}/label"));
        if let Some(variant) = &lane.variant {
            ctx.enum_value(
                variant,
                &["normal", "exception"],
                &format!("{path}/variant"),
            );
        }
    }

    let mut node_ids = HashSet::new();
    let mut node_cols = HashMap::new();
    for (index, node) in spec.nodes.iter().enumerate() {
        let path = format!("/nodes/{index}");
        ctx.insert_id(&mut node_ids, &node.id, &format!("{path}/id"));
        node_cols.entry(node.id.clone()).or_insert(node.col);
        ctx.id(&node.lane, &format!("{path}/lane"));
        ctx.reference(
            &node.lane,
            &lane_ids,
            &format!("{path}/lane"),
            "lane-reference",
        );
        ctx.range(
            node.col as f64,
            Some(0.0),
            Some(MAX_COLUMN as f64),
            &format!("{path}/col"),
        );
        ctx.enum_value(&node.node_type, COMPONENT_TYPES, &format!("{path}/type"));
        ctx.text(&node.label, 1, None, &format!("{path}/label"));
        common::validate_decoration(&node.decoration(), &path, ctx);
        if let Some(width) = node.width {
            ctx.range(width, Some(32.0), None, &format!("{path}/width"));
        }
        if let Some(height) = node.height {
            ctx.range(height, Some(32.0), None, &format!("{path}/height"));
        }
        if let Some(y_offset) = node.y_offset {
            ctx.range(y_offset, None, None, &format!("{path}/yOffset"));
        }
    }

    let mut phase_ids = HashSet::new();
    let mut valid_phases = Vec::new();
    for (index, phase) in spec
        .phases
        .as_deref()
        .unwrap_or_default()
        .iter()
        .enumerate()
    {
        let path = format!("/phases/{index}");
        ctx.insert_id(&mut phase_ids, &phase.id, &format!("{path}/id"));
        ctx.text(&phase.label, 1, None, &format!("{path}/label"));
        validate_range(phase.from_col, phase.to_col, &path, "phase-range", ctx);
        if let Some(variant) = &phase.variant {
            ctx.enum_value(variant, VARIANTS, &format!("{path}/variant"));
        }
        if phase.from_col <= phase.to_col && phase.to_col <= MAX_COLUMN {
            valid_phases.push((index, phase));
        }
    }
    valid_phases.sort_by_key(|(_, phase)| (phase.from_col, phase.to_col));
    for pair in valid_phases.windows(2) {
        let (_, previous) = pair[0];
        let (index, phase) = pair[1];
        if phase.from_col <= previous.to_col {
            ctx.error(
                "phase-overlap",
                &format!("/phases/{index}"),
                format!("phase {:?} overlaps phase {:?}", phase.id, previous.id),
                format!("move this phase to column {} or later, or end the earlier phase before that column", previous.to_col + 1),
            );
        }
    }

    let mut group_ids = HashSet::new();
    let groups = spec.groups.as_deref().unwrap_or_default();
    for (index, group) in groups.iter().enumerate() {
        let path = format!("/groups/{index}");
        ctx.insert_id(&mut group_ids, &group.id, &format!("{path}/id"));
        ctx.text(&group.label, 1, None, &format!("{path}/label"));
        ctx.id(&group.lane, &format!("{path}/lane"));
        ctx.reference(
            &group.lane,
            &lane_ids,
            &format!("{path}/lane"),
            "lane-reference",
        );
        validate_range(group.from_col, group.to_col, &path, "group-range", ctx);
        if let Some(variant) = &group.variant {
            ctx.enum_value(variant, VARIANTS, &format!("{path}/variant"));
        }
        if group.from_col <= group.to_col
            && group.to_col <= MAX_COLUMN
            && !spec.nodes.iter().any(|node| {
                node.lane == group.lane && (group.from_col..=group.to_col).contains(&node.col)
            })
        {
            ctx.error(
                "empty-group",
                &path,
                format!(
                    "group {:?} contains no node in its lane and column range",
                    group.id
                ),
                "align the group lane and range with at least one workflow node",
            );
        }
    }

    let mut edge_ids = HashSet::new();
    for (index, edge) in spec.edges.iter().enumerate() {
        let path = format!("/edges/{index}");
        if let Some(id) = &edge.id {
            ctx.insert_id(&mut edge_ids, id, &format!("{path}/id"));
        }
        for (field, id) in [("from", &edge.from), ("to", &edge.to)] {
            ctx.id(id, &format!("{path}/{field}"));
            ctx.reference(id, &node_ids, &format!("{path}/{field}"), "edge-endpoint");
        }
        if let Some(label) = &edge.label {
            ctx.text(label, 0, None, &format!("{path}/label"));
        }
        if let Some(variant) = &edge.variant {
            ctx.enum_value(variant, VARIANTS, &format!("{path}/variant"));
        }
        if let Some(role) = &edge.role {
            ctx.enum_value(role, WORKFLOW_ROLES, &format!("{path}/role"));
        }
        for (field, side) in [("fromSide", &edge.from_side), ("toSide", &edge.to_side)] {
            if let Some(side) = side {
                ctx.enum_value(side, SIDES, &format!("{path}/{field}"));
            }
        }
        if let Some(route) = &edge.route {
            ctx.enum_value(route, WORKFLOW_ROUTES, &format!("{path}/route"));
        }
        validate_points(edge.via.as_deref(), &format!("{path}/via"), ctx);
        if edge.label_at.is_some() {
            validate_points(
                edge.label_at.as_ref().map(std::slice::from_ref),
                &format!("{path}/labelAt"),
                ctx,
            );
        }
        for (field, value) in [
            ("labelDx", edge.label_dx),
            ("labelDy", edge.label_dy),
            ("channelX", edge.channel_x),
            ("channelY", edge.channel_y),
        ] {
            if let Some(value) = value {
                ctx.range(value, None, None, &format!("{path}/{field}"));
            }
        }
        if let Some(segment) = edge.label_segment {
            ctx.integer(segment, Some(0.0), None, &format!("{path}/labelSegment"));
        }
        if let Some(bias) = edge.bias {
            ctx.range(bias, Some(0.0), Some(1.0), &format!("{path}/bias"));
        }
        if let Some(width) = edge.width {
            ctx.range(width, Some(0.5), None, &format!("{path}/width"));
        }
    }

    if let Some(main_path) = &spec.main_path {
        ctx.cardinality(main_path.len(), 2, "/mainPath");
        for (index, id) in main_path.iter().enumerate() {
            ctx.id(id, &format!("/mainPath/{index}"));
            ctx.reference(
                id,
                &node_ids,
                &format!("/mainPath/{index}"),
                "main-path-node",
            );
        }
        for (index, pair) in main_path.windows(2).enumerate() {
            if !spec
                .edges
                .iter()
                .any(|edge| edge.from == pair[0] && edge.to == pair[1])
            {
                ctx.error(
                    "main-path-edge",
                    &format!("/mainPath/{index}"),
                    format!(
                        "main path step {:?} -> {:?} has no matching directed edge",
                        pair[0], pair[1]
                    ),
                    "add the directed edge or remove the broken consecutive step",
                );
            }
            if let (Some(from), Some(to)) = (node_cols.get(&pair[0]), node_cols.get(&pair[1])) {
                if to < from {
                    ctx.error(
                        "main-path-order",
                        &format!("/mainPath/{}", index + 1),
                        format!("main path moves backward from column {from} to {to}"),
                        "keep the main path left-to-right and put loops on a separate edge",
                    );
                }
            }
        }
    }

    common::validate_meta_refs(&spec.meta, &node_ids, ctx);
    node_ids
}

fn validate_range(from: u32, to: u32, path: &str, rule: &str, ctx: &mut Context) {
    ctx.range(
        from as f64,
        Some(0.0),
        Some(MAX_COLUMN as f64),
        &format!("{path}/fromCol"),
    );
    ctx.range(
        to as f64,
        Some(0.0),
        Some(MAX_COLUMN as f64),
        &format!("{path}/toCol"),
    );
    if from > to {
        ctx.error(
            rule,
            path,
            format!("range starts at column {from}, after its end column {to}"),
            "set fromCol to a value no greater than toCol",
        );
    }
}

fn validate_points(points: Option<&[Point]>, path: &str, ctx: &mut Context) {
    if let Some(points) = points {
        for (index, point) in points.iter().enumerate() {
            for (axis, value) in [point[0], point[1]].into_iter().enumerate() {
                ctx.range(value, None, None, &format!("{path}/{index}/{axis}"));
            }
        }
    }
}

fn validate_semantic_checks(spec: &WorkflowSpec, node_ids: &HashSet<String>, ctx: &mut Context) {
    let Some(checks) = &spec.semantic_checks else {
        return;
    };
    if checks.allowed_roots.is_none()
        && checks.allowed_terminals.is_none()
        && checks.required_edges.is_none()
        && checks.required_paths.is_none()
    {
        ctx.error(
            "semantic-checks-empty",
            "/semanticChecks",
            "semanticChecks must declare at least one graph check",
            "add an allowed root, allowed terminal, required edge or required path",
        );
    }
    let mut incoming: HashMap<&str, usize> = spec
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), 0))
        .collect();
    let mut outgoing = incoming.clone();
    let mut adjacency: HashMap<&str, HashSet<&str>> = spec
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), HashSet::new()))
        .collect();
    let mut authored_edges = HashSet::new();
    for edge in &spec.edges {
        if !node_ids.contains(&edge.from) || !node_ids.contains(&edge.to) {
            continue;
        }
        *outgoing.entry(&edge.from).or_default() += 1;
        *incoming.entry(&edge.to).or_default() += 1;
        adjacency.entry(&edge.from).or_default().insert(&edge.to);
        authored_edges.insert((edge.from.as_str(), edge.to.as_str()));
    }

    if let Some(roots) = &checks.allowed_roots {
        let allowed: HashSet<_> = roots.iter().map(String::as_str).collect();
        for (index, id) in roots.iter().enumerate() {
            ctx.id(id, &format!("/semanticChecks/allowedRoots/{index}"));
            ctx.reference(
                id,
                node_ids,
                &format!("/semanticChecks/allowedRoots/{index}"),
                "semantic-node-reference",
            );
        }
        for (id, count) in &incoming {
            if *count == 0 && !allowed.contains(id) {
                ctx.error(
                    "unexpected-root",
                    "/semanticChecks/allowedRoots",
                    format!("node {id:?} has no incoming edge and is not an allowed root"),
                    format!("add an incoming edge to {id:?} or include it in allowedRoots"),
                );
            }
        }
    }
    if let Some(terminals) = &checks.allowed_terminals {
        let allowed: HashSet<_> = terminals.iter().map(String::as_str).collect();
        for (index, id) in terminals.iter().enumerate() {
            ctx.id(id, &format!("/semanticChecks/allowedTerminals/{index}"));
            ctx.reference(
                id,
                node_ids,
                &format!("/semanticChecks/allowedTerminals/{index}"),
                "semantic-node-reference",
            );
        }
        for (id, count) in &outgoing {
            if *count == 0 && !allowed.contains(id) {
                ctx.error(
                    "unexpected-terminal",
                    "/semanticChecks/allowedTerminals",
                    format!("node {id:?} has no outgoing edge and is not an allowed terminal"),
                    format!("add an outgoing edge from {id:?} or include it in allowedTerminals"),
                );
            }
        }
    }
    if let Some(required_edges) = &checks.required_edges {
        for (index, relation) in required_edges.iter().enumerate() {
            let path = format!("/semanticChecks/requiredEdges/{index}");
            ctx.id(&relation.from, &format!("{path}/from"));
            ctx.id(&relation.to, &format!("{path}/to"));
            ctx.reference(
                &relation.from,
                node_ids,
                &format!("{path}/from"),
                "semantic-node-reference",
            );
            ctx.reference(
                &relation.to,
                node_ids,
                &format!("{path}/to"),
                "semantic-node-reference",
            );
            if node_ids.contains(&relation.from)
                && node_ids.contains(&relation.to)
                && !authored_edges.contains(&(relation.from.as_str(), relation.to.as_str()))
            {
                ctx.error(
                    "required-edge",
                    &path,
                    format!(
                        "required edge {:?} -> {:?} is not present",
                        relation.from, relation.to
                    ),
                    "add the directed edge without removing this requirement",
                );
            }
        }
    }
    if let Some(required_paths) = &checks.required_paths {
        for (index, relation) in required_paths.iter().enumerate() {
            let path = format!("/semanticChecks/requiredPaths/{index}");
            ctx.id(&relation.from, &format!("{path}/from"));
            ctx.id(&relation.to, &format!("{path}/to"));
            ctx.reference(
                &relation.from,
                node_ids,
                &format!("{path}/from"),
                "semantic-node-reference",
            );
            ctx.reference(
                &relation.to,
                node_ids,
                &format!("{path}/to"),
                "semantic-node-reference",
            );
            if node_ids.contains(&relation.from)
                && node_ids.contains(&relation.to)
                && !reachable(&relation.from, &relation.to, &adjacency)
            {
                ctx.error(
                    "required-path",
                    &path,
                    format!(
                        "no directed path exists from {:?} to {:?}",
                        relation.from, relation.to
                    ),
                    "restore a directed path without weakening the semantic requirement",
                );
            }
        }
    }
}

fn reachable<'a>(from: &'a str, to: &str, adjacency: &HashMap<&'a str, HashSet<&'a str>>) -> bool {
    let mut visited = HashSet::from([from]);
    let mut pending = VecDeque::from([from]);
    while let Some(current) = pending.pop_front() {
        if current == to {
            return true;
        }
        if let Some(next_nodes) = adjacency.get(current) {
            for next in next_nodes {
                if visited.insert(next) {
                    pending.push_back(next);
                }
            }
        }
    }
    false
}

/// Validate the E1 workflow document contract without routing or layout checks.
pub(crate) fn validate(value: Value) -> Vec<Diagnostic> {
    let mut ctx = common::base(
        &value,
        "workflow",
        &[
            "schema_version",
            "diagram_type",
            "meta",
            "lanes",
            "phases",
            "groups",
            "mainPath",
            "semanticChecks",
            "nodes",
            "edges",
            "cards",
        ],
        &[],
        (700.0, 240.0),
    );
    validate_shape_fields(&value, &mut ctx);
    if let Some(lanes) = value.get("lanes").and_then(Value::as_array) {
        ctx.cardinality(lanes.len(), 1, "/lanes");
    }
    if let Some(nodes) = value.get("nodes").and_then(Value::as_array) {
        ctx.cardinality(nodes.len(), 1, "/nodes");
    }
    let Some(spec) = common::decode::<WorkflowSpec>(&value, &mut ctx) else {
        return ctx.finish();
    };
    let node_ids = validate_ids_and_references(&spec, &mut ctx);
    validate_semantic_checks(&spec, &node_ids, &mut ctx);
    ctx.finish()
}

#[cfg(feature = "typegen")]
pub fn declarations(cfg: &ts_rs::Config) -> Vec<String> {
    use ts_rs::TS;
    vec![
        WorkflowSpec::decl(cfg),
        WorkflowLane::decl(cfg),
        WorkflowPhase::decl(cfg),
        WorkflowGroup::decl(cfg),
        WorkflowNode::decl(cfg),
        WorkflowEdge::decl(cfg),
        WorkflowSemanticRelation::decl(cfg),
        WorkflowSemanticChecks::decl(cfg),
    ]
}

#[cfg(test)]
mod tests {
    use super::validate;

    fn v2_spec() -> serde_json::Value {
        serde_json::json!({
            "schema_version": 2,
            "diagram_type": "workflow",
            "meta": {"title": "Workflow v2", "output": "workflow-v2.html", "viewBox": [900, 600]},
            "lanes": [{"id": "main", "label": "Main"}],
            "nodes": [
                {"id": "request", "lane": "main", "col": 0, "type": "frontend", "label": "Request"},
                {"id": "reply", "lane": "main", "col": 1, "type": "backend", "label": "Reply"}
            ],
            "edges": [{"from": "request", "to": "reply"}]
        })
    }

    #[test]
    fn accepts_v2_documents_with_schema_supported_authored_coordinate_fields() {
        let diagnostics = validate(v2_spec());
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
    }

    #[test]
    fn rejects_undeclared_absolute_node_coordinates_in_v2() {
        let mut spec = v2_spec();
        spec["nodes"][0]["x"] = serde_json::json!(120);
        let diagnostics = validate(spec);
        assert!(diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "workflow/unknown-field"));
    }
}
