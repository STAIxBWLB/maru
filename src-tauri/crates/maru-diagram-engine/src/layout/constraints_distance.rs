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
    // Share width-aware columns, populated-lane rows and pin overrides with
    // the other lifecycle source constraints. SourceRect uses 1/128px, while
    // distance predicates and emitted geometry use 1/64px.
    super::source_budgets::lifecycle_state_rects(spec, geometry)
        .into_iter()
        .filter_map(|(id, rect)| {
            Some((
                id,
                Rect {
                    x: point(rect.x as f64 / 128.0)?,
                    y: point(rect.y as f64 / 128.0)?,
                    width: point(rect.width as f64 / 128.0)?,
                    height: point(rect.height as f64 / 128.0)?,
                },
            ))
        })
        .collect()
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
    #[cfg(any(test, feature = "geometry-corpus"))]
    crate::work::record_constraint_evaluation();

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
            let participants = node_rects(geometry);
            for (index, message) in records(spec, "messages").iter().enumerate() {
                let (Some(from), Some(to)) = (string(message, "from"), string(message, "to"))
                else {
                    continue;
                };
                // The lifeline port sits at the placed header's center. Its
                // x coordinate includes the actual width and every retained
                // pin/authored placement; source ordinals are not positions.
                let centers = participants
                    .get(from)
                    .zip(participants.get(to))
                    .map(|(from, to)| {
                        (
                            i64::from(from.bounds.x) + i64::from(from.bounds.width) / 2,
                            i64::from(to.bounds.x) + i64::from(to.bounds.width) / 2,
                        )
                    });
                let (start_x, end_x) = match centers {
                    Some(centers) => centers,
                    // Self identity alone proves a zero horizontal span. Do
                    // not invent positions when a partial scene lacks nodes.
                    None if from == to => (0, 0),
                    None => continue,
                };
                let y = number(message, "y").and_then(point).unwrap_or(0);
                emit_short_span(
                    &mut diagnostics,
                    "sequence",
                    "messages",
                    index,
                    Port { x: start_x, y },
                    Port { x: end_x, y },
                    60,
                );
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
            lifecycle_rail: None,
            nodes,
            containers: Vec::<GeometryContainer>::new(),
            routes,
            labels: Vec::new(),
            primitives: Vec::new(),
            legend: GeometryLegend {
                content_bounds: None,
                title_y: None,
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
                content_offset: None,
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
