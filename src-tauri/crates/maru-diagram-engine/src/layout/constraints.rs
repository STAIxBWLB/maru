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
    #[cfg(any(test, feature = "geometry-corpus"))]
    crate::work::record_constraint_evaluation();

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
    #[cfg(any(test, feature = "geometry-corpus"))]
    crate::work::record_constraint_evaluation();

    fixed(bounds.x) >= 0.0
        && fixed(bounds.y) >= 0.0
        && right(bounds) <= width
        && bottom(bounds) <= height
}

fn view_box(spec: &Value, family: Family) -> Option<(f64, f64)> {
    let authored = spec
        .get("meta")
        .and_then(|meta| meta.get("viewBox"))
        .and_then(Value::as_array)
        .filter(|value| value.len() == 2)
        .and_then(|value| Some((value[0].as_f64()?, value[1].as_f64()?)));
    if let Some((width, height)) = authored {
        return Some((width, height));
    }
    match family.name {
        "dataflow" => Some((940.0, 720.0)),
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
            #[cfg(any(test, feature = "geometry-corpus"))]
            crate::work::record_constraint_evaluation();
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
            #[cfg(any(test, feature = "geometry-corpus"))]
            crate::work::record_constraint_evaluation();
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
            #[cfg(any(test, feature = "geometry-corpus"))]
            crate::work::record_constraint_evaluation();
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
    if family.name == "workflow" {
        diagnostics.extend(super::constraints_workflow_page::workflow_page_diagnostics(
            spec, geometry,
        ));
        return;
    }
    // Sequence timeline/range rules own its source canvas budget.
    if family.name == "sequence" {
        return;
    }
    let (width, height) = view_box(spec, family).unwrap_or((f64::INFINITY, f64::INFINITY));
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
        #[cfg(any(test, feature = "geometry-corpus"))]
        crate::work::record_constraint_evaluation();
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

fn check_workflow_column_capacity(
    spec: &Value,
    geometry: &GeometryDocument,
    diagnostics: &mut Vec<Diagnostic>,
) {
    if spec["schema_version"].as_u64() != Some(1) {
        return;
    }
    let sources: BTreeMap<_, _> = items(spec, "nodes")
        .iter()
        .filter_map(|node| text(node, "id").map(|id| (id, node)))
        .collect();
    let placed: BTreeMap<_, _> = geometry
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node.bounds))
        .collect();
    for (index, edge) in items(spec, "edges").iter().enumerate() {
        #[cfg(any(test, feature = "geometry-corpus"))]
        crate::work::record_constraint_evaluation();
        let (Some(from_id), Some(to_id)) = (text(edge, "from"), text(edge, "to")) else {
            continue;
        };
        let (Some(from), Some(to), Some(a), Some(b)) = (
            sources.get(from_id),
            sources.get(to_id),
            placed.get(from_id),
            placed.get(to_id),
        ) else {
            continue;
        };
        if from["lane"] != to["lane"] {
            continue;
        }
        let center_x = |bounds: &GeometryBox| 2 * i64::from(bounds.x) + i64::from(bounds.width);
        let center_y = |bounds: &GeometryBox| 2 * i64::from(bounds.y) + i64::from(bounds.height);
        if center_x(a) == center_x(b) {
            continue;
        }
        if (center_y(a) - center_y(b)).abs() >= i64::from(a.height) + i64::from(b.height) + 16 * 64
        {
            continue;
        }
        let direct = !edge.get("via").is_some_and(Value::is_array)
            && text(edge, "route").is_none_or(|route| route == "auto" || route == "straight")
            && center_y(a) == center_y(b);
        let required = if direct { 28 } else { 8 };
        let clearance = (center_x(a) - center_x(b)).abs() - i64::from(a.width) - i64::from(b.width);
        if clearance < 2 * required * 64 {
            push(
                diagnostics,
                Family {
                    name: "workflow",
                    node_collection: "nodes",
                },
                "geometry-column-capacity",
                format!("/edges/{index}"),
                format!(
                    "placed fixed-v1 nodes leave less than {required}px of horizontal clearance"
                ),
                "move pinned nodes apart, reduce their widths, or choose a schema-version-2 layout",
            );
        }
    }
}

fn check_dataflow(spec: &Value, geometry: &GeometryDocument, diagnostics: &mut Vec<Diagnostic>) {
    let nodes = items(spec, "nodes");
    for (index, node) in nodes.iter().enumerate() {
        let row = number(node, "row").unwrap_or(-1.0);
        #[cfg(any(test, feature = "geometry-corpus"))]
        crate::work::record_constraint_evaluation();
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
    #[cfg(any(test, feature = "geometry-corpus"))]
    crate::work::record_constraint_evaluation();
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
    #[cfg(any(test, feature = "geometry-corpus"))]
    crate::work::record_constraint_evaluation();
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
            #[cfg(any(test, feature = "geometry-corpus"))]
            crate::work::record_constraint_evaluation();
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
    if !text(spec.get("meta").unwrap_or(&Value::Null), "quality_profile")
        .is_some_and(|profile| !profile.is_empty())
    {
        return;
    }
    for (index, boundary) in items(spec, "boundaries").iter().enumerate() {
        let Some(label_text) = text(boundary, "label") else {
            continue;
        };
        let boundary_id = format!("boundary:{index}");
        let title_id = format!("container:{boundary_id}:label");
        let Some(title) = geometry
            .labels
            .iter()
            .find(|label| label.id.as_deref() == Some(title_id.as_str()))
        else {
            continue;
        };
        let Some(frame) = geometry
            .containers
            .iter()
            .find(|container| container.id == boundary_id)
        else {
            continue;
        };
        // The architecture placer reserves the renderer's 4px frame inset on
        // each side and 10px for the title mask before this final fit check.
        #[cfg(any(test, feature = "geometry-corpus"))]
        crate::work::record_constraint_evaluation();
        let available = fixed(frame.bounds.width) - 8.0;
        let measured_width =
            label_text
                .split('\n')
                .try_fold(0_i64, |width, line| -> Result<i64, String> {
                    let metrics = crate::metrics::measure_text(line, 700, 6 * 64)
                        .map_err(|error| error.message)?;
                    let ink_right = metrics.ink.right().map_err(|error| error.to_string())?;
                    Ok(width.max(
                        i64::from(metrics.advance.max(ink_right)) - i64::from(metrics.ink.x.min(0)),
                    ))
                });
        let measured_width = match measured_width {
            Ok(width) => width as f64 / UNITS,
            Err(error) => {
                push(
                    diagnostics,
                    Family {
                        name: "architecture",
                        node_collection: "components",
                    },
                    "geometry-boundary-title-fit",
                    format!("/boundaries/{index}/label"),
                    format!(
                        "boundary title cannot be measured within its coordinate range: {error}"
                    ),
                    "restore the pinned font tables or shorten the title, then retry",
                );
                continue;
            }
        };
        let required_at_minimum = (measured_width + 10.0).max(30.0);
        let mask_width = fixed(title.bounds.width);
        let authored = spec
            .get("meta")
            .and_then(|meta| meta.get("viewBox"))
            .and_then(Value::as_array);
        let outside_page = title.bounds.x < 0
            || title.bounds.y < 0
            || authored.is_some_and(|page| {
                page.first()
                    .and_then(Value::as_f64)
                    .is_some_and(|width| fixed(title.bounds.x) + mask_width > width)
                    || page
                        .get(1)
                        .and_then(Value::as_f64)
                        .is_some_and(|height| bottom(title.bounds) > height)
            });
        if outside_page {
            push(diagnostics,Family{name:"architecture",node_collection:"components"},
                "geometry-boundary-title-fit",format!("/boundaries/{index}/label"),
                "boundary title mask extends before the canvas origin or outside its authored viewBox",
                "move wrapped components inward or shorten the title; enlarge meta.viewBox only for right or bottom overflow");
        } else if required_at_minimum > available {
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
    let participant_bounds: BTreeMap<_, _> = geometry
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node.bounds))
        .collect();
    let span = |message: &Value| {
        let from = participant_bounds.get(text(message, "from")?)?;
        let to = participant_bounds.get(text(message, "to")?)?;
        let from_x = i64::from(from.x) + i64::from(from.width) / 2;
        let to_x = i64::from(to.x) + i64::from(to.width) / 2;
        Some((from_x.min(to_x), from_x.max(to_x)))
    };
    let messages = items(spec, "messages");
    for (left_index, left_message) in messages.iter().enumerate() {
        let Some(left_y) = number(left_message, "y").and_then(|y| super::px(y).ok()) else {
            continue;
        };
        let Some(left_span) = span(left_message) else {
            continue;
        };
        for (right_index, right_message) in messages.iter().enumerate().skip(left_index + 1) {
            #[cfg(any(test, feature = "geometry-corpus"))]
            crate::work::record_constraint_evaluation();
            let Some(right_y) = number(right_message, "y").and_then(|y| super::px(y).ok()) else {
                continue;
            };
            if (i64::from(right_y) - i64::from(left_y)).abs() >= 28 * 64 {
                continue;
            }
            let Some(right_span) = span(right_message) else {
                continue;
            };
            if left_span.0 >= right_span.1 || right_span.0 >= left_span.1 {
                continue;
            }
            push(
                diagnostics,
                Family {
                    name: "sequence",
                    node_collection: "participants",
                },
                "geometry-message-spacing",
                format!("/messages/{right_index}/y"),
                format!("messages at y={:.3} and y={:.3} share placed horizontal space with less than 28px of vertical separation", fixed(left_y), fixed(right_y)),
                "separate their y values or move the pinned participants so the message spans do not overlap",
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
            check_workflow_column_capacity(spec, geometry, &mut diagnostics);
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
    fn architecture_grid_checks_the_authored_page_not_its_grown_diagnostic_page() {
        for (row, col) in [(1, 0), (0, 2)] {
            let spec = serde_json::json!({"schema_version":1,"diagram_type":"architecture",
                "meta":{"title":"Grid bounds","output":"grid.html","viewBox":[320,240]},
                "layout":{"mode":"grid","cols":3},
                "components":[{"id":"a","type":"backend","label":"A","row":row,"col":col}],"connections":[]});
            let report = crate::layout::layout_json(
                &serde_json::json!({"specJson":spec.to_string()}).to_string(),
            );
            assert!(!report.ok);
            assert!(report.geometry.is_some());
            assert!(
                report
                    .diagnostics
                    .iter()
                    .any(|d| d.code == "architecture/geometry-node-viewbox"
                        && d.path == "/components/0"),
                "{:?}",
                report.diagnostics
            );
        }
    }

    #[test]
    fn duplicate_boundary_captions_are_checked_by_namespaced_identity() {
        let spec = serde_json::json!({"schema_version":1,"diagram_type":"architecture",
            "meta":{"title":"Boundary identity","output":"boundaries.html","quality_profile":"showcase","viewBox":[400,300]},
            "components":[{"id":"a","type":"backend","label":"A","pos":[100,100]},
                {"id":"b","type":"database","label":"B","pos":[500,100]}],
            "boundaries":[{"kind":"region","label":"Repeated","wraps":["a"]},
                {"kind":"region","label":"Repeated","wraps":["b"]}],"connections":[]});
        let report = crate::layout::layout_json(
            &serde_json::json!({"specJson":spec.to_string()}).to_string(),
        );
        assert!(report.geometry.is_some());
        assert!(
            report
                .diagnostics
                .iter()
                .any(|d| d.code == "architecture/geometry-boundary-title-fit"
                    && d.path == "/boundaries/1/label"),
            "{:?}",
            report.diagnostics
        );
        assert!(!report
            .diagnostics
            .iter()
            .any(|d| d.code == "architecture/geometry-boundary-title-fit"
                && d.path == "/boundaries/0/label"));
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
