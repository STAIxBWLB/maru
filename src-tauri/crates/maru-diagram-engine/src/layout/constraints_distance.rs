//! Renderer-compatible minimum endpoint-span constraints.

use crate::geometry::{GeometryDocument, GeometryNode, GeometryPoint, GeometryPositionSource};
use crate::layout::fixed::quantize_pixels;
use crate::Diagnostic;
use serde_json::Value;
use std::collections::HashMap;

const SCALE: i64 = 64;

#[derive(Clone, Copy, PartialEq, Eq)]
struct Port {
    x: i64,
    y: i64,
}
impl From<GeometryPoint> for Port {
    fn from(point: GeometryPoint) -> Self {
        Self {
            x: i64::from(point.x),
            y: i64::from(point.y),
        }
    }
}

#[derive(Clone, Copy)]
struct Rect {
    x: i64,
    y: i64,
    width: i64,
    height: i64,
}

impl Rect {
    fn right(self) -> i64 {
        self.x + self.width
    }

    fn bottom(self) -> i64 {
        self.y + self.height
    }

    fn center(self) -> Port {
        Port {
            x: (self.x + self.width / 2),
            y: (self.y + self.height / 2),
        }
    }
}

fn records<'a>(spec: &'a Value, collection: &str) -> &'a [Value] {
    spec.get(collection)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn number(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

fn point(value: f64) -> Option<i64> {
    quantize_pixels(value).ok().map(i64::from)
}

fn source_rect(
    id: &str,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    geometry_nodes: &HashMap<&str, &GeometryNode>,
    source_position_override: bool,
) -> Option<Rect> {
    let actual = geometry_nodes.get(id).copied();
    let (x, y) = if source_position_override
        && actual.is_some_and(|node| {
            matches!(
                node.position_source,
                GeometryPositionSource::AuthoredPosition | GeometryPositionSource::PlannedPin
            )
        }) {
        let bounds = actual?.bounds;
        (i64::from(bounds.x), i64::from(bounds.y))
    } else {
        (point(x)?, point(y)?)
    };
    Some(Rect {
        x,
        y,
        width: point(width)?,
        height: point(height)?,
    })
}

fn anchor(rect: Rect, side: &str) -> Port {
    match side {
        "left" => Port {
            x: rect.x,
            y: (rect.y + rect.height / 2),
        },
        "right" => Port {
            x: rect.right(),
            y: (rect.y + rect.height / 2),
        },
        "top" => Port {
            x: (rect.x + rect.width / 2),
            y: rect.y,
        },
        "bottom" => Port {
            x: (rect.x + rect.width / 2),
            y: rect.bottom(),
        },
        _ => rect.center(),
    }
}

fn automatic_sides(from: Rect, to: Rect, dominant_axis: bool) -> (&'static str, &'static str) {
    let from = from.center();
    let to = to.center();
    let dx = to.x - from.x;
    let dy = to.y - from.y;
    if dominant_axis && (dx == 0 || dx.abs() < dy.abs()) {
        return if dy > 0 {
            ("bottom", "top")
        } else {
            ("top", "bottom")
        };
    }
    if dominant_axis {
        return if dx < 0 {
            ("left", "right")
        } else {
            ("right", "left")
        };
    }
    if dx < 0 {
        ("left", "right")
    } else if dx > 0 {
        ("right", "left")
    } else if dy > 0 {
        ("bottom", "top")
    } else {
        ("top", "bottom")
    }
}

fn node_rects(geometry: &GeometryDocument) -> HashMap<&str, &GeometryNode> {
    geometry
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect()
}

fn architecture_rects(spec: &Value, geometry: &GeometryDocument) -> HashMap<String, Rect> {
    let nodes = node_rects(geometry);
    let mut result = HashMap::new();
    let layout = spec.get("layout").unwrap_or(&Value::Null);
    let origin = layout
        .get("origin")
        .and_then(Value::as_array)
        .filter(|point| point.len() == 2)
        .and_then(|point| Some([point[0].as_f64()?, point[1].as_f64()?]))
        .unwrap_or([40.0, 80.0]);
    let cell_w = number(layout, "cellW").unwrap_or(130.0);
    let cell_h = number(layout, "cellH").unwrap_or(64.0);
    let gap_x = number(layout, "gapX").unwrap_or(30.0);
    let gap_y = number(layout, "gapY").unwrap_or(40.0);
    for component in records(spec, "components") {
        let Some(id) = string(component, "id") else {
            continue;
        };
        let (x, y) = if let Some(position) = component.get("pos").and_then(Value::as_array) {
            if position.len() != 2 {
                continue;
            }
            let (Some(x), Some(y)) = (position[0].as_f64(), position[1].as_f64()) else {
                continue;
            };
            (x, y)
        } else {
            let (Some(row), Some(col)) = (number(component, "row"), number(component, "col"))
            else {
                continue;
            };
            (
                origin[0] + col * (cell_w + gap_x),
                origin[1] + row * (cell_h + gap_y),
            )
        };
        let size = component.get("size").and_then(Value::as_array);
        let width = size
            .filter(|size| size.len() == 2)
            .and_then(|size| size[0].as_f64())
            .unwrap_or(120.0);
        let height = size
            .filter(|size| size.len() == 2)
            .and_then(|size| size[1].as_f64())
            .unwrap_or(60.0);
        if let Some(rect) = source_rect(id, x, y, width, height, &nodes, true) {
            result.insert(id.to_owned(), rect);
        }
    }
    result
}

fn dataflow_rects(spec: &Value, geometry: &GeometryDocument) -> HashMap<String, Rect> {
    let nodes = node_rects(geometry);
    let row_y = [128.0, 242.0, 356.0, 470.0, 584.0];
    let mut result = HashMap::new();
    for node in records(spec, "nodes") {
        let (Some(id), Some(stage), Some(row)) = (
            string(node, "id"),
            number(node, "stage"),
            number(node, "row"),
        ) else {
            continue;
        };
        if stage < 0.0 || row < 0.0 || row.fract() != 0.0 || row >= row_y.len() as f64 {
            continue;
        }
        let width = number(node, "width").unwrap_or(112.0);
        let height = number(node, "height").unwrap_or(58.0);
        let x = 100.0 + stage * 215.0 - width / 2.0;
        let y = row_y[row as usize] + number(node, "yOffset").unwrap_or(0.0);
        if let Some(rect) = source_rect(id, x, y, width, height, &nodes, true) {
            result.insert(id.to_owned(), rect);
        }
    }
    result
}

fn lifecycle_rects(spec: &Value, geometry: &GeometryDocument) -> HashMap<String, Rect> {
    let nodes = node_rects(geometry);
    let version = spec
        .get("schema_version")
        .and_then(Value::as_u64)
        .unwrap_or(1);
    let phase_x = [94.0, 248.0, 402.0, 556.0, 710.0];
    let band_x = [402.0, 556.0, 710.0];
    let mut result = HashMap::new();
    for state in records(spec, "states") {
        let (Some(id), Some(lane), Some(col)) = (
            string(state, "id"),
            string(state, "lane"),
            number(state, "col"),
        ) else {
            continue;
        };
        if col < 0.0 || col.fract() != 0.0 {
            continue;
        }
        let col = col as usize;
        let (cx, top, default_w, default_h) = if version == 2 {
            // For v2, an actual authored/pinned engine box is the only source
            // of absolute row placement; column widths remain source-sized.
            let width = number(state, "width").unwrap_or(140.0);
            let height = number(state, "height").unwrap_or(64.0);
            (60.0 + col as f64 * 184.0 + width / 2.0, 56.0, width, height)
        } else if lane == "main" {
            let Some(cx) = phase_x.get(col).copied() else {
                continue;
            };
            (cx, 126.0, 118.0, 62.0)
        } else if lane == "terminal" {
            let Some(cx) = band_x.get(col).copied() else {
                continue;
            };
            (cx, 450.0, 118.0, 58.0)
        } else {
            let Some(cx) = band_x.get(col).copied() else {
                continue;
            };
            (cx, 278.0, 126.0, 58.0)
        };
        let width = number(state, "width").unwrap_or(default_w);
        let height = number(state, "height").unwrap_or(default_h);
        let y = top + number(state, "yOffset").unwrap_or(0.0);
        if let Some(rect) = source_rect(id, cx - width / 2.0, y, width, height, &nodes, true) {
            result.insert(id.to_owned(), rect);
        }
    }
    result
}

fn source_sides(family: &str, relation: &Value, from: Rect, to: Rect) -> (String, String) {
    let (default_from, default_to) = automatic_sides(from, to, family == "architecture");
    let from_side = match string(relation, "fromSide") {
        Some("left" | "right" | "top" | "bottom") => string(relation, "fromSide")
            .unwrap_or(default_from)
            .to_owned(),
        _ => default_from.to_owned(),
    };
    let to_side = match string(relation, "toSide") {
        Some("left" | "right" | "top" | "bottom") => {
            string(relation, "toSide").unwrap_or(default_to).to_owned()
        }
        _ => default_to.to_owned(),
    };
    (from_side, to_side)
}

fn emit_short_span(
    diagnostics: &mut Vec<Diagnostic>,
    family: &str,
    collection: &str,
    index: usize,
    start: Port,
    end: Port,
    minimum: i64,
) {
    let dx = i128::from(start.x) - i128::from(end.x);
    let dy = i128::from(start.y) - i128::from(end.y);
    let span_sq = dx * dx + dy * dy;
    let min_sq = i128::from(minimum * SCALE) * i128::from(minimum * SCALE);
    if span_sq >= min_sq {
        return;
    }
    diagnostics.push(Diagnostic {
        code: format!("{family}/geometry-route-distance"),
        path: format!("/{collection}/{index}"),
        rule: "geometry-v1/source-port-span".into(),
        message: format!(
            "source port endpoints are closer than the {minimum}px renderer minimum"
        ),
        fix: "move the source and target farther apart, or change endpoint sides while preserving the relationship".into(),
    });
}

fn diagnostic_rects(
    spec: &Value,
    geometry: &GeometryDocument,
    family: &str,
) -> HashMap<String, Rect> {
    match family {
        "architecture" => architecture_rects(spec, geometry),
        "dataflow" => dataflow_rects(spec, geometry),
        "lifecycle" => lifecycle_rects(spec, geometry),
        _ => HashMap::new(),
    }
}

/// Check the pinned renderer's minimum source-port span while preserving the
/// completed S2 geometry for review.
pub(crate) fn source_distance_diagnostics(
    spec: &Value,
    geometry: &GeometryDocument,
) -> Vec<Diagnostic> {
    let Some(family) = string(spec, "diagram_type") else {
        return Vec::new();
    };
    let mut diagnostics = Vec::new();
    match family {
        "architecture" | "dataflow" | "lifecycle" => {
            let (collection, prefix, minimum) = match family {
                "architecture" => ("connections", "connection", 24),
                "dataflow" => ("flows", "flow", 34),
                _ => ("transitions", "transition", 32),
            };
            let rects = diagnostic_rects(spec, geometry, family);
            let relations = records(spec, collection);
            let route_ids = super::allocate_route_ids(
                prefix,
                relations.iter().map(|route| string(route, "id")),
            );
            for (index, (relation, route_id)) in relations.iter().zip(route_ids).enumerate() {
                let (Some(from), Some(to)) = (
                    string(relation, "from")
                        .and_then(|id| rects.get(id))
                        .copied(),
                    string(relation, "to").and_then(|id| rects.get(id)).copied(),
                ) else {
                    continue;
                };
                let (from_side, to_side) = source_sides(family, relation, from, to);
                let mut start = anchor(from, &from_side);
                let mut end = anchor(to, &to_side);
                let aliases_same_port =
                    string(relation, "from") == string(relation, "to") && start == end;
                // Some self-loop routers spread otherwise-identical same-side
                // ports. Use their scene endpoints only when the source-side
                // port model has no span of its own.
                if aliases_same_port {
                    if let Some(route) = geometry
                        .routes
                        .iter()
                        .find(|route| route.id.as_deref() == Some(route_id.as_str()))
                    {
                        if route.points.len() >= 2 {
                            start = (*route.points.first().unwrap()).into();
                            end = (*route.points.last().unwrap()).into();
                        }
                    }
                }
                emit_short_span(
                    &mut diagnostics,
                    family,
                    collection,
                    index,
                    start,
                    end,
                    minimum,
                );
            }
        }
        "sequence" => {
            let participants = records(spec, "participants");
            let participant_indices: HashMap<_, _> = participants
                .iter()
                .enumerate()
                .filter_map(|(index, participant)| string(participant, "id").map(|id| (id, index)))
                .collect();
            let messages = records(spec, "messages");
            for (index, message) in messages.iter().enumerate() {
                let (Some(from), Some(to)) = (string(message, "from"), string(message, "to"))
                else {
                    continue;
                };
                let (Some(from_column), Some(to_column)) =
                    (participant_indices.get(from), participant_indices.get(to))
                else {
                    continue;
                };
                let spread =
                    spec.get("meta").and_then(|meta| string(meta, "column_fit")) == Some("spread");
                let view_width = spec
                    .get("meta")
                    .and_then(|meta| meta.get("viewBox"))
                    .and_then(Value::as_array)
                    .and_then(|view| view.first())
                    .and_then(Value::as_f64)
                    .unwrap_or(920.0);
                let columns = super::source_budgets::sequence_columns(
                    point(view_width).unwrap_or(920 * SCALE),
                    participants.len(),
                    spread,
                );
                let gap = columns.pitch;
                let delta = (*from_column as i64 - *to_column as i64).abs();
                let span_fixed = i128::from(delta) * i128::from(gap);
                let minimum = i128::from(60 * SCALE);
                if span_fixed * span_fixed < minimum * minimum {
                    diagnostics.push(Diagnostic {
                        code: "sequence/geometry-route-distance".into(),
                        path: format!("/messages/{index}"),
                        rule: "geometry-v1/source-port-span".into(),
                        message: format!(
                            "message endpoints span less than the 60px renderer minimum (source columns {from_column} and {to_column})"
                        ),
                        fix: "send the message between separate participants with at least 60px of column distance".into(),
                    });
                }
            }
        }
        _ => {}
    }
    diagnostics
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::{
        GeometryContainer, GeometryLegend, GeometryNode, GeometryPage, GeometryRoute,
    };

    fn geometry(nodes: Vec<GeometryNode>, routes: Vec<GeometryRoute>) -> GeometryDocument {
        GeometryDocument {
            nodes,
            containers: Vec::<GeometryContainer>::new(),
            routes,
            labels: Vec::new(),
            legend: GeometryLegend {
                bounds: crate::geometry::GeometryBox {
                    x: 0,
                    y: 0,
                    width: 0,
                    height: 0,
                },
                entries: Vec::new(),
            },
            page: GeometryPage {
                bounds: crate::geometry::GeometryBox {
                    x: 0,
                    y: 0,
                    width: 920 * 64,
                    height: 760 * 64,
                },
            },
        }
    }

    fn has_distance(spec: Value, geometry: &GeometryDocument, code: &str) -> bool {
        source_distance_diagnostics(&spec, geometry)
            .iter()
            .any(|diagnostic| diagnostic.code == code)
    }

    #[test]
    fn refuses_confirmed_short_spans_for_architecture_dataflow_lifecycle_and_sequence() {
        let architecture = serde_json::json!({
            "schema_version":1,"diagram_type":"architecture","meta":{"title":"A","output":"a.html"},
            "components":[{"id":"a","type":"backend","label":"A","pos":[100,100],"size":[100,60]},
                {"id":"b","type":"database","label":"B","pos":[220,100],"size":[100,60]}],
            "connections":[{"from":"a","to":"b","label":"Call"}]
        });
        assert!(crate::validate_json(&architecture.to_string()).ok);
        assert!(has_distance(
            architecture,
            &geometry(Vec::new(), Vec::new()),
            "architecture/geometry-route-distance"
        ));

        let dataflow = serde_json::json!({
            "schema_version":1,"diagram_type":"dataflow","meta":{"title":"D","output":"d.html"},
            "stages":[{"label":"A"},{"label":"B"},{"label":"C"}],
            "nodes":[{"id":"x","type":"frontend","label":"X","stage":1,"row":0,"width":198,"height":58},
                {"id":"b","type":"backend","label":"B","stage":2,"row":0,"width":198,"height":58}],
            "flows":[{"from":"x","to":"b","label":"Data"}]
        });
        assert!(crate::validate_json(&dataflow.to_string()).ok);
        assert!(has_distance(
            dataflow,
            &geometry(Vec::new(), Vec::new()),
            "dataflow/geometry-route-distance"
        ));

        let lifecycle = serde_json::json!({
            "schema_version":1,"diagram_type":"lifecycle","meta":{"title":"L","output":"l.html"},
            "lanes":[{"id":"main","label":"Main"},{"id":"ordinary","label":"Ordinary"}],
            "states":[{"id":"a","type":"active","label":"A","lane":"ordinary","col":0},
                {"id":"b","type":"active","label":"B","lane":"ordinary","col":1}],
            "transitions":[{"from":"a","to":"b","label":"Go"}]
        });
        assert!(crate::validate_json(&lifecycle.to_string()).ok);
        assert!(has_distance(
            lifecycle,
            &geometry(Vec::new(), Vec::new()),
            "lifecycle/geometry-route-distance"
        ));

        let sequence = serde_json::json!({
            "schema_version":1,"diagram_type":"sequence","meta":{"title":"S","output":"s.html"},
            "participants":[{"id":"a","type":"backend","label":"A"},{"id":"b","type":"backend","label":"B"}],
            "messages":[{"from":"a","to":"a","y":180,"label":"Self"}]
        });
        assert!(crate::validate_json(&sequence.to_string()).ok);
        assert!(has_distance(
            sequence,
            &geometry(Vec::new(), Vec::new()),
            "sequence/geometry-route-distance"
        ));
    }

    #[test]
    fn accepts_separated_architecture_and_lifecycle_self_loop_ports() {
        let architecture = serde_json::json!({
            "schema_version":1,"diagram_type":"architecture","meta":{"title":"A","output":"a.html"},
            "components":[{"id":"a","type":"backend","label":"A","pos":[120,140],"size":[120,80]}],
            "connections":[{"from":"a","to":"a","label":"Loop","fromSide":"top","toSide":"right"}]
        });
        assert!(crate::validate_json(&architecture.to_string()).ok);
        assert!(!has_distance(
            architecture,
            &geometry(Vec::new(), Vec::new()),
            "architecture/geometry-route-distance"
        ));

        let lifecycle = serde_json::json!({
            "schema_version":1,"diagram_type":"lifecycle","meta":{"title":"L","output":"l.html"},
            "lanes":[{"id":"main","label":"Main"}],
            "states":[{"id":"a","type":"start","label":"A","lane":"main","col":0},
                {"id":"b","type":"active","label":"B","lane":"main","col":1}],
            "transitions":[{"from":"a","to":"a","label":"Loop"}]
        });
        assert!(crate::validate_json(&lifecycle.to_string()).ok);
        assert!(!has_distance(
            lifecycle,
            &geometry(Vec::new(), Vec::new()),
            "lifecycle/geometry-route-distance"
        ));
    }
}
