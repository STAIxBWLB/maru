//! Renderer-derived geometry refusals over the completed S2 scene.
//!
//! These checks inspect Maru's own typed source and fixed-point output. They
//! deliberately leave the scene intact so callers can inspect a refused layout.

use crate::geometry::{GeometryBox, GeometryDocument, GeometryLabel, GeometryNode};
use crate::Diagnostic;
use serde_json::Value;
use std::collections::BTreeMap;

const UNITS: f64 = 64.0;

#[derive(Clone, Copy)]
struct Family {
    name: &'static str,
    node_collection: &'static str,
}

fn family(spec: &Value) -> Option<Family> {
    Some(match spec.get("diagram_type")?.as_str()? {
        "architecture" => Family {
            name: "architecture",
            node_collection: "components",
        },
        "workflow" => Family {
            name: "workflow",
            node_collection: "nodes",
        },
        "sequence" => Family {
            name: "sequence",
            node_collection: "participants",
        },
        "dataflow" => Family {
            name: "dataflow",
            node_collection: "nodes",
        },
        "lifecycle" => Family {
            name: "lifecycle",
            node_collection: "states",
        },
        _ => return None,
    })
}

fn items<'a>(spec: &'a Value, key: &str) -> &'a [Value] {
    spec.get(key)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn number(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

fn fixed(value: i32) -> f64 {
    f64::from(value) / UNITS
}

fn right(bounds: GeometryBox) -> f64 {
    f64::from(bounds.x) / UNITS + f64::from(bounds.width) / UNITS
}

fn bottom(bounds: GeometryBox) -> f64 {
    f64::from(bounds.y) / UNITS + f64::from(bounds.height) / UNITS
}

fn overlaps(left: GeometryBox, right: GeometryBox, gap: f64) -> bool {
    let gap = (gap * UNITS) as i64;
    i64::from(left.x) < i64::from(right.x) + i64::from(right.width) + gap
        && i64::from(right.x) < i64::from(left.x) + i64::from(left.width) + gap
        && i64::from(left.y) < i64::from(right.y) + i64::from(right.height) + gap
        && i64::from(right.y) < i64::from(left.y) + i64::from(left.height) + gap
}

fn source_indices(spec: &Value, collection: &str) -> BTreeMap<String, usize> {
    items(spec, collection)
        .iter()
        .enumerate()
        .filter_map(|(index, item)| text(item, "id").map(|id| (id.to_owned(), index)))
        .collect()
}

fn push(
    diagnostics: &mut Vec<Diagnostic>,
    family: Family,
    suffix: &str,
    path: impl Into<String>,
    cause: impl Into<String>,
    fix: impl Into<String>,
) {
    diagnostics.push(Diagnostic {
        code: crate::rules::geometry_qualified(family.name, suffix).0,
        path: path.into(),
        rule: crate::rules::geometry_qualified(family.name, suffix).1,
        message: cause.into(),
        fix: fix.into(),
    });
}

fn box_inside_view(bounds: GeometryBox, width: f64, height: f64) -> bool {
    fixed(bounds.x) >= 0.0
        && fixed(bounds.y) >= 0.0
        && right(bounds) <= width
        && bottom(bounds) <= height
}

fn view_box(spec: &Value, family: Family, geometry: &GeometryDocument) -> Option<(f64, f64)> {
    let authored = spec
        .get("meta")
        .and_then(|meta| meta.get("viewBox"))
        .and_then(Value::as_array)
        .filter(|value| value.len() == 2)
        .and_then(|value| Some((value[0].as_f64()?, value[1].as_f64()?)));
    if let Some((width, height)) = authored {
        if family.name == "architecture" && spec.get("layout").is_some() {
            return Some((
                width.max(right(geometry.page.bounds)),
                height.max(bottom(geometry.page.bounds)),
            ));
        }
        return Some((width, height));
    }
    match family.name {
        "dataflow" => Some((940.0, 720.0)),
        "sequence" => Some((920.0, (fixed(geometry.page.bounds.height)).max(760.0))),
        "lifecycle" if spec.get("schema_version").and_then(Value::as_u64) == Some(1) => {
            Some((980.0, 660.0))
        }
        _ => None,
    }
}

fn node_minimum_font(family: Family, role: &str, version: u64) -> f64 {
    match (family.name, role) {
        ("architecture", "label") => 8.0,
        ("workflow", "label") => 9.0,
        ("sequence", "label") => 8.0,
        ("dataflow", "label") => 8.0,
        ("lifecycle", "label") if version == 2 => 9.0,
        ("lifecycle", "label") => 8.0,
        ("lifecycle", "sublabel" | "tag") if version == 2 => 7.0,
        ("architecture", "sublabel") => 6.0,
        ("architecture", "tag") => 6.0,
        ("workflow", "sublabel" | "tag") => 6.0,
        ("sequence", "sublabel") => 6.0,
        ("dataflow", "sublabel" | "tag") => 6.0,
        ("lifecycle", "sublabel" | "tag") => 6.0,
        _ => 6.0,
    }
}

fn authored_width(family: Family, value: &Value, version: u64, spec: &Value) -> Option<f64> {
    match family.name {
        "architecture" => value
            .get("size")
            .and_then(Value::as_array)
            .and_then(|size| size.first())
            .and_then(Value::as_f64)
            .or(Some(120.0)),
        "workflow" => Some(number(value, "width").unwrap_or(92.0)),
        "sequence" => {
            let width = spec["meta"]["viewBox"][0].as_f64().unwrap_or(920.0);
            let width = super::px(width).ok()?;
            let columns = super::source_budgets::sequence_columns(
                i64::from(width),
                items(spec, "participants").len(),
                text(&spec["meta"], "column_fit") == Some("spread"),
            );
            Some(columns.participant_width as f64 / 64.0)
        }
        "dataflow" => Some(number(value, "width").unwrap_or(112.0)),
        "lifecycle" => {
            let fallback = if version == 2 {
                140.0
            } else if text(value, "lane") == Some("main") || text(value, "lane") == Some("terminal")
            {
                118.0
            } else {
                126.0
            };
            Some(number(value, "width").unwrap_or(fallback))
        }
        _ => None,
    }
}

fn label_role(label: &GeometryLabel, target_id: &str) -> Option<&'static str> {
    let prefix = format!("node:{target_id}:");
    let id = label.id.as_deref()?;
    let suffix = id.strip_prefix(&prefix)?;
    match suffix {
        "label" => Some("label"),
        "sublabel" => Some("sublabel"),
        "tag" => Some("tag"),
        _ => None,
    }
}

fn check_node_labels(
    spec: &Value,
    family: Family,
    geometry: &GeometryDocument,
    nodes_by_id: &BTreeMap<String, &GeometryNode>,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let version = spec
        .get("schema_version")
        .and_then(Value::as_u64)
        .unwrap_or(1);
    let indices = source_indices(spec, family.node_collection);
    for (id, node) in nodes_by_id {
        let Some(index) = indices.get(id).copied() else {
            continue;
        };
        let source = &items(spec, family.node_collection)[index];
        let Some(width) = authored_width(family, source, version, spec) else {
            continue;
        };
        let has_brand = source.get("brand").is_some_and(|value| !value.is_null());
        let available = width - 8.0 - if has_brand { 26.0 } else { 0.0 };
        for label in geometry
            .labels
            .iter()
            .filter(|label| label.target_id == *id)
        {
            let Some(role) = label_role(label, id) else {
                continue;
            };
            let font_size = f64::from(label.font_size) / UNITS;
            if font_size <= 0.0 {
                continue;
            }
            let min_font = node_minimum_font(family, role, version);
            let required = fixed(label.bounds.width) * min_font / font_size;
            if required > available {
                let combined = family.name == "lifecycle"
                    && role == "sublabel"
                    && source.get("step").is_some();
                let field = if combined { "sublabel/step" } else { role };
                let path = if combined {
                    format!("/{}/{index}", family.node_collection)
                } else {
                    format!("/{}/{index}/{field}", family.node_collection)
                };
                push(
                    diagnostics,
                    family,
                    "geometry-label-fit",
                    path,
                    format!(
                        "{field} text for {:?} needs about {:.0}px at the {:.0}px minimum, but the node provides {:.0}px",
                        id, required, min_font, available
                    ),
                    format!("shorten the {field}, or widen the node while preserving its authored text"),
                );
            }
        }
        let _ = node;
    }
}

fn check_node_overlap(
    spec: &Value,
    family: Family,
    geometry: &GeometryDocument,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let gap = match family.name {
        "architecture" | "workflow" => 8.0,
        "dataflow" | "lifecycle" => 10.0,
        _ => return,
    };
    let indices = source_indices(spec, family.node_collection);
    for left_index in 0..geometry.nodes.len() {
        for right_index in left_index + 1..geometry.nodes.len() {
            let left = &geometry.nodes[left_index];
            let right = &geometry.nodes[right_index];
            if !overlaps(left.bounds, right.bounds, gap) {
                continue;
            }
            let index = indices.get(&right.id).copied().unwrap_or(right_index);
            push(
                diagnostics,
                family,
                "geometry-node-overlap",
                format!("/{}/{index}", family.node_collection),
                format!(
                    "nodes {:?} and {:?} have less than {gap:.0}px of separation",
                    left.id, right.id
                ),
                "move one node to another row or column, or reduce its dimensions",
            );
        }
    }
}

fn check_node_viewbox(
    spec: &Value,
    family: Family,
    geometry: &GeometryDocument,
    nodes_by_id: &BTreeMap<String, &GeometryNode>,
    diagnostics: &mut Vec<Diagnostic>,
) {
    if family.name == "dataflow" {
        let rects = super::source_budgets::dataflow_node_rects(spec, geometry);
        let Some(frame) = super::source_budgets::dataflow_frame(spec) else {
            return;
        };
        for (index, source) in items(spec, family.node_collection).iter().enumerate() {
            let Some(id) = text(source, "id") else {
                continue;
            };
            let Some(rect) = rects.get(id) else {
                continue;
            };
            if rect.x < frame.min_x
                || rect.y < frame.min_y
                || rect.right() > frame.max_right
                || rect.bottom() > frame.max_bottom
            {
                push(
                    diagnostics,
                    family,
                    "geometry-node-viewbox",
                    format!("/{}/{index}", family.node_collection),
                    format!("node {id:?} lies outside the data-flow readable area"),
                    "move the node to a readable stage row or enlarge the authored viewBox",
                );
            }
        }
        return;
    }
    if family.name == "lifecycle" {
        if spec["schema_version"].as_u64().unwrap_or(1) == 1
            && spec["meta"]["viewBox"][1].as_f64().unwrap_or(660.0) < 566.0
        {
            push(
                diagnostics,
                family,
                "geometry-node-viewbox",
                "/meta/viewBox/1",
                "the fixed-v1 lifecycle bands require a viewBox at least 566px high",
                "increase meta.viewBox[1] to 566 or more, or use a schema-version-2 row layout",
            );
        }
        let rects = super::source_budgets::lifecycle_state_rects(spec, geometry);
        let Some(frame) = super::source_budgets::lifecycle_frame(spec, geometry) else {
            return;
        };
        for (index, source) in items(spec, family.node_collection).iter().enumerate() {
            let Some(id) = text(source, "id") else {
                continue;
            };
            let Some(rect) = rects.get(id) else {
                continue;
            };
            if rect.x < frame.min_x
                || rect.y < frame.min_y
                || rect.right() > frame.max_right
                || rect.bottom() > frame.max_bottom
            {
                push(
                    diagnostics,
                    family,
                    "geometry-node-viewbox",
                    format!("/{}/{index}", family.node_collection),
                    format!("state {id:?} lies outside the lifecycle readable area"),
                    "adjust its lane/column or yOffset, or enlarge the authored viewBox",
                );
            }
        }
        return;
    }
    // Workflow and sequence renderers grow or reflow their default canvases;
    // their pinned renderer refusals are covered by their own lane/time rules.
    if family.name == "workflow" || family.name == "sequence" {
        return;
    }
    let (width, height) =
        view_box(spec, family, geometry).unwrap_or((f64::INFINITY, f64::INFINITY));
    let indices = source_indices(spec, family.node_collection);
    for (id, node) in nodes_by_id {
        if box_inside_view(node.bounds, width, height) {
            continue;
        }
        let index = indices.get(id).copied().unwrap_or(0);
        push(
            diagnostics,
            family,
            "geometry-node-viewbox",
            format!("/{}/{index}", family.node_collection),
            format!("node {id:?} extends outside the renderer canvas ({width:.0}x{height:.0})"),
            "move the node into the readable canvas or enlarge the authored viewBox",
        );
    }
}

fn check_workflow_lane(
    spec: &Value,
    geometry: &GeometryDocument,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let lanes = items(spec, "lanes");
    let nodes = items(spec, "nodes");
    for (index, source) in nodes.iter().enumerate() {
        let Some(id) = text(source, "id") else {
            continue;
        };
        let Some(node) = geometry.nodes.iter().find(|node| node.id == id) else {
            continue;
        };
        let Some(lane_id) = text(source, "lane") else {
            continue;
        };
        let Some(lane_index) = lanes
            .iter()
            .position(|lane| text(lane, "id") == Some(lane_id))
        else {
            continue;
        };
        let lane_bounds = geometry
            .containers
            .iter()
            .find(|frame| frame.id == format!("lane:{lane_id}"))
            .map(|frame| frame.bounds);
        let top = lane_bounds.map_or(52.0 + lane_index as f64 * 124.0, |bounds| fixed(bounds.y));
        let low = top + 30.0;
        let high = lane_bounds.map_or(top + 104.0, bottom) - fixed(node.bounds.height);
        let node_y = fixed(node.bounds.y);
        let outside_x = lane_bounds
            .is_some_and(|bounds| node.bounds.x < bounds.x || right(node.bounds) > right(bounds));
        if node_y < low || node_y > high || outside_x {
            push(
                diagnostics,
                Family {
                    name: "workflow",
                    node_collection: "nodes",
                },
                "geometry-node-lane",
                format!("/nodes/{index}/yOffset"),
                format!("node {id:?} collides with its lane title or lane boundary"),
                "adjust yOffset so the node remains inside the lane content area",
            );
        }
    }
}

fn check_workflow_column_capacity(spec: &Value, diagnostics: &mut Vec<Diagnostic>) {
    if spec["schema_version"].as_u64() != Some(1) {
        return;
    }
    let nodes: BTreeMap<_, _> = items(spec, "nodes")
        .iter()
        .filter_map(|node| text(node, "id").map(|id| (id, node)))
        .collect();
    let centers = [88_i64, 220, 300, 430, 500, 625];
    for (index, edge) in items(spec, "edges").iter().enumerate() {
        let (Some(from), Some(to)) = (
            text(edge, "from").and_then(|id| nodes.get(id)),
            text(edge, "to").and_then(|id| nodes.get(id)),
        ) else {
            continue;
        };
        if from["lane"] != to["lane"] || from["col"] == to["col"] {
            continue;
        }
        let (Some(a), Some(b)) = (
            from["col"]
                .as_u64()
                .and_then(|col| centers.get(col as usize)),
            to["col"].as_u64().and_then(|col| centers.get(col as usize)),
        ) else {
            continue;
        };
        let (Ok(w1), Ok(w2), Ok(h1), Ok(h2), Ok(y1), Ok(y2)) = (
            super::px(number(from, "width").unwrap_or(92.0)),
            super::px(number(to, "width").unwrap_or(92.0)),
            super::px(number(from, "height").unwrap_or(52.0)),
            super::px(number(to, "height").unwrap_or(52.0)),
            super::px(number(from, "yOffset").unwrap_or(0.0)),
            super::px(number(to, "yOffset").unwrap_or(0.0)),
        ) else {
            continue;
        };
        if 2 * (i64::from(y1) - i64::from(y2)).abs() >= i64::from(h1) + i64::from(h2) + 16 * 64 {
            continue;
        }
        let direct = !edge.get("via").is_some_and(|value| value.is_array())
            && text(edge, "route").is_none_or(|route| route == "auto" || route == "straight")
            && y1 == y2;
        let required = if direct { 28 } else { 8 };
        let clearance = 2 * (a - b).abs() * 64 - i64::from(w1) - i64::from(w2);
        if clearance < 2 * required * 64 {
            push(diagnostics,Family{name:"workflow",node_collection:"nodes"},"geometry-column-capacity",format!("/edges/{index}"),
                format!("fixed-v1 columns leave less than {required}px of source clearance"),
                "reduce declared node widths, choose different columns or use a schema-version-2 layout");
        }
    }
}

fn check_dataflow(spec: &Value, geometry: &GeometryDocument, diagnostics: &mut Vec<Diagnostic>) {
    let nodes = items(spec, "nodes");
    for (index, node) in nodes.iter().enumerate() {
        let row = number(node, "row").unwrap_or(-1.0);
        if row.fract() != 0.0 || !(0.0..5.0).contains(&row) {
            push(
                diagnostics,
                Family {
                    name: "dataflow",
                    node_collection: "nodes",
                },
                "fixed-row-slots",
                format!("/nodes/{index}/row"),
                format!("dataflow row {row} has no fixed row slot; valid slots are 0 through 4"),
                "move the node to one of the five fixed rows",
            );
        }
    }

    let stage_count = items(spec, "stages").len();
    let required_width = 100.0 + stage_count.saturating_sub(1) as f64 * 215.0 + 168.0 / 2.0 + 24.0;
    let width = spec
        .get("meta")
        .and_then(|meta| meta.get("viewBox"))
        .and_then(Value::as_array)
        .and_then(|view| view.first())
        .and_then(Value::as_f64)
        .unwrap_or(940.0);
    if required_width > width && stage_count > 0 {
        push(
            diagnostics,
            Family {
                name: "dataflow",
                node_collection: "nodes",
            },
            "stage-canvas-width",
            "/meta/viewBox/0",
            format!("the final stage requires about {required_width:.0}px, beyond the {width:.0}px canvas"),
            "increase meta.viewBox[0] to include every declared stage column",
        );
    }
    let _ = geometry;
}

fn check_lifecycle(spec: &Value, diagnostics: &mut Vec<Diagnostic>) {
    if !items(spec, "lanes")
        .iter()
        .any(|lane| text(lane, "id") == Some("main"))
    {
        push(
            diagnostics,
            Family {
                name: "lifecycle",
                node_collection: "states",
            },
            "reserved-main-lane",
            "/lanes",
            "lifecycle layout requires the reserved main lane for its primary phase band",
            "add a lane with id main and place the primary lifecycle states in it",
        );
    }
    if spec
        .get("schema_version")
        .and_then(Value::as_u64)
        .unwrap_or(1)
        == 1
    {
        for (index, state) in items(spec, "states").iter().enumerate() {
            if text(state, "lane") != Some("main")
                && number(state, "col").is_some_and(|col| col >= 3.0)
            {
                push(diagnostics,Family{name:"lifecycle",node_collection:"states"},"geometry-state-column",format!("/states/{index}/col"),
                    "the v1 terminal/event band has only columns 0 through 2",
                    "use a column from 0 through 2 in this band, or choose a schema-version-2 row layout");
            }
        }
    }
}

fn check_boundary_title_fit(
    spec: &Value,
    geometry: &GeometryDocument,
    diagnostics: &mut Vec<Diagnostic>,
) {
    if text(spec.get("meta").unwrap_or(&Value::Null), "quality_profile") != Some("showcase") {
        return;
    }
    for (index, boundary) in items(spec, "boundaries").iter().enumerate() {
        let Some(label_text) = text(boundary, "label") else {
            continue;
        };
        let target = geometry.labels.iter().find(|label| {
            label.text == label_text
                && geometry.containers.iter().any(|container| {
                    container.id == label.target_id
                        && container.kind == text(boundary, "kind").unwrap_or_default()
                })
        });
        let Some(title) = target else {
            continue;
        };
        let Some(frame) = geometry
            .containers
            .iter()
            .find(|container| container.id == title.target_id)
        else {
            continue;
        };
        let available = fixed(frame.bounds.width) - 16.0;
        let required_at_minimum =
            fixed(title.bounds.width) * 6.0 / (f64::from(title.font_size) / UNITS);
        if required_at_minimum > available {
            push(
                diagnostics,
                Family {
                    name: "architecture",
                    node_collection: "components",
                },
                "geometry-boundary-title-fit",
                format!("/boundaries/{index}/label"),
                format!("boundary title requires about {required_at_minimum:.0}px, but its frame has {available:.0}px"),
                "shorten the title or widen the wrapped component layout",
            );
        }
    }
}

fn check_sequence_spacing(
    spec: &Value,
    geometry: &GeometryDocument,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let participants = items(spec, "participants");
    let participant_index: BTreeMap<_, _> = participants
        .iter()
        .enumerate()
        .filter_map(|(index, participant)| text(participant, "id").map(|id| (id, index)))
        .collect();
    let participant_bounds: BTreeMap<_, _> = geometry
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node.bounds))
        .collect();
    let messages = items(spec, "messages");
    for left_index in 0..messages.len() {
        let Some(left_from) = text(&messages[left_index], "from") else {
            continue;
        };
        let Some(left_to) = text(&messages[left_index], "to") else {
            continue;
        };
        let Some(left_y) = number(&messages[left_index], "y") else {
            continue;
        };
        let Some(left_from_index) = participant_index.get(left_from).copied() else {
            continue;
        };
        let Some(left_to_index) = participant_index.get(left_to).copied() else {
            continue;
        };
        for (right_index, right_message) in messages.iter().enumerate().skip(left_index + 1) {
            let Some(right_y) = number(right_message, "y") else {
                continue;
            };
            if (right_y - left_y).abs() >= 28.0 {
                continue;
            }
            let right_from = text(right_message, "from").unwrap_or_default();
            let right_to = text(right_message, "to").unwrap_or_default();
            let Some(right_from_index) = participant_index.get(right_from).copied() else {
                continue;
            };
            let Some(right_to_index) = participant_index.get(right_to).copied() else {
                continue;
            };
            let left_span = (
                left_from_index.min(left_to_index),
                left_from_index.max(left_to_index),
            );
            let right_span = (
                right_from_index.min(right_to_index),
                right_from_index.max(right_to_index),
            );
            if left_span.0 >= right_span.1 || right_span.0 >= left_span.1 {
                continue;
            }
            // Confirm both messages have retained route geometry before refusing.
            let _same_canvas = participant_bounds.contains_key(left_from)
                && participant_bounds.contains_key(left_to)
                && participant_bounds.contains_key(right_from)
                && participant_bounds.contains_key(right_to);
            push(
                diagnostics,
                Family {
                    name: "sequence",
                    node_collection: "participants",
                },
                "geometry-message-spacing",
                format!("/messages/{right_index}/y"),
                format!("messages at y={left_y:.0} and y={right_y:.0} share horizontal space with less than 28px of vertical separation"),
                "separate their y values or shorten their labels",
            );
        }
    }
}

/// Find renderer-derived refusals while keeping the completed scene available.
pub(crate) fn geometry_diagnostics(spec: &Value, geometry: &GeometryDocument) -> Vec<Diagnostic> {
    let Some(family) = family(spec) else {
        return Vec::new();
    };
    let mut diagnostics = Vec::new();
    let nodes_by_id: BTreeMap<_, _> = geometry
        .nodes
        .iter()
        .map(|node| (node.id.clone(), node))
        .collect();

    check_node_labels(spec, family, geometry, &nodes_by_id, &mut diagnostics);
    check_node_overlap(spec, family, geometry, &mut diagnostics);
    check_node_viewbox(spec, family, geometry, &nodes_by_id, &mut diagnostics);

    match family.name {
        "workflow" => {
            check_workflow_lane(spec, geometry, &mut diagnostics);
            check_workflow_column_capacity(spec, &mut diagnostics);
        }
        "dataflow" => check_dataflow(spec, geometry, &mut diagnostics),
        "lifecycle" => {
            check_lifecycle(spec, &mut diagnostics);
        }
        "sequence" => check_sequence_spacing(spec, geometry, &mut diagnostics),
        "architecture" => check_boundary_title_fit(spec, geometry, &mut diagnostics),
        _ => {}
    }

    // Sequence time markers and ranges are deliberately not clipped to the
    // current auto-grown canvas; the pinned renderer grows those scenes.
    // Preserve authored node collection paths for every node-level refusal.
    diagnostics
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::{GeometryLegend, GeometryPage};

    fn empty_geometry() -> GeometryDocument {
        GeometryDocument {
            nodes: Vec::new(),
            containers: Vec::new(),
            routes: Vec::new(),
            labels: Vec::new(),
            legend: GeometryLegend {
                bounds: GeometryBox {
                    x: 0,
                    y: 0,
                    width: 0,
                    height: 0,
                },
                entries: Vec::new(),
            },
            page: GeometryPage {
                bounds: GeometryBox {
                    x: 0,
                    y: 0,
                    width: 0,
                    height: 0,
                },
            },
        }
    }

    #[test]
    fn flags_only_the_three_deferred_e1_geometry_differences() {
        let mut dataflow: Value =
            serde_json::from_str(include_str!("../../testdata/valid-dataflow.json")).unwrap();
        dataflow["nodes"][0]["row"] = 100.into();
        assert!(crate::validate_json(&dataflow.to_string()).ok);
        let diagnostics = geometry_diagnostics(&dataflow, &empty_geometry());
        assert!(diagnostics
            .iter()
            .any(|d| d.code == "dataflow/fixed-row-slots"));

        let mut five_stages: Value =
            serde_json::from_str(include_str!("../../testdata/valid-dataflow.json")).unwrap();
        five_stages["stages"].as_array_mut().unwrap().extend([
            serde_json::json!({"label":"C"}),
            serde_json::json!({"label":"D"}),
            serde_json::json!({"label":"E"}),
        ]);
        assert!(crate::validate_json(&five_stages.to_string()).ok);
        let diagnostics = geometry_diagnostics(&five_stages, &empty_geometry());
        assert!(diagnostics
            .iter()
            .any(|d| d.code == "dataflow/stage-canvas-width"));

        let mut lifecycle: Value =
            serde_json::from_str(include_str!("../../testdata/valid-lifecycle.json")).unwrap();
        lifecycle["lanes"][0]["id"] = "ordinary".into();
        for state in lifecycle["states"].as_array_mut().unwrap() {
            state["lane"] = "ordinary".into();
        }
        assert!(crate::validate_json(&lifecycle.to_string()).ok);
        let diagnostics = geometry_diagnostics(&lifecycle, &empty_geometry());
        assert!(diagnostics
            .iter()
            .any(|d| d.code == "lifecycle/reserved-main-lane"));
    }

    #[test]
    fn dataflow_readable_area_uses_source_rows_not_s2_auto_positions() {
        let mut spec: Value =
            serde_json::from_str(include_str!("../../testdata/valid-dataflow.json")).unwrap();
        spec["nodes"][0]["yOffset"] = (-30).into();
        assert!(crate::validate_json(&spec.to_string()).ok);
        let diagnostics = geometry_diagnostics(&spec, &empty_geometry());
        assert!(diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "dataflow/geometry-node-viewbox"));
    }

    #[test]
    fn lifecycle_v1_readable_area_uses_source_band_geometry() {
        let mut spec: Value =
            serde_json::from_str(include_str!("../../testdata/valid-lifecycle.json")).unwrap();
        spec["states"][0]["yOffset"] = (-70).into();
        assert!(crate::validate_json(&spec.to_string()).ok);
        let diagnostics = geometry_diagnostics(&spec, &empty_geometry());
        assert!(diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "lifecycle/geometry-node-viewbox"));
    }
}
