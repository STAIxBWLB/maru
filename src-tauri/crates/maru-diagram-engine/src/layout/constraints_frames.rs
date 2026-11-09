//! S3 checks for source-owned frames and their measured text.

use crate::geometry::{GeometryBox, GeometryDocument, GeometryLabel};
use crate::Diagnostic;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

const UNITS: f64 = 64.0;

fn records<'a>(spec: &'a Value, key: &str) -> &'a [Value] {
    spec.get(key)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn number(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

fn integer(value: &Value, key: &str) -> Option<u32> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
}

fn diag(
    kind: &str,
    suffix: &str,
    path: impl Into<String>,
    cause: impl Into<String>,
    fix: impl Into<String>,
) -> Diagnostic {
    Diagnostic {
        code: crate::rules::geometry_qualified(kind, suffix).0,
        path: path.into(),
        rule: crate::rules::geometry_qualified(kind, suffix).1,
        message: cause.into(),
        fix: fix.into(),
    }
}

fn right(bounds: GeometryBox) -> i64 {
    i64::from(bounds.x) + i64::from(bounds.width)
}

fn bottom(bounds: GeometryBox) -> i64 {
    i64::from(bounds.y) + i64::from(bounds.height)
}

fn contained(outer: GeometryBox, inner: GeometryBox) -> bool {
    i64::from(outer.x) <= i64::from(inner.x)
        && i64::from(outer.y) <= i64::from(inner.y)
        && right(outer) >= right(inner)
        && bottom(outer) >= bottom(inner)
}

fn overlaps(left: GeometryBox, right_box: GeometryBox) -> bool {
    i64::from(left.x) < right(right_box)
        && i64::from(right_box.x) < right(left)
        && i64::from(left.y) < bottom(right_box)
        && i64::from(right_box.y) < bottom(left)
}

fn frame<'a>(geometry: &'a GeometryDocument, id: &str) -> Option<&'a GeometryBox> {
    geometry
        .containers
        .iter()
        .find(|container| container.id == id)
        .map(|container| &container.bounds)
}

fn frame_label<'a>(geometry: &'a GeometryDocument, id: &str) -> Option<&'a GeometryLabel> {
    let label_id = format!("container:{id}:label");
    geometry
        .labels
        .iter()
        .find(|label| label.target_id == id && label.id.as_deref() == Some(label_id.as_str()))
}

fn architecture_boundary_ids(spec: &Value) -> Option<Vec<String>> {
    Some(
        (0..records(spec, "boundaries").len())
            .map(|index| format!("boundary:{index}"))
            .collect(),
    )
}

fn architecture_frames(spec: &Value, geometry: &GeometryDocument) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();
    let boundaries = records(spec, "boundaries");
    let Some(ids) = architecture_boundary_ids(spec) else {
        return diagnostics;
    };
    let node_bounds: BTreeMap<_, _> = geometry
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node.bounds))
        .collect();
    let profile = spec
        .get("meta")
        .and_then(|meta| string(meta, "engineering_profile"))
        == Some("deployment-ownership");
    let title_checks = spec
        .get("meta")
        .and_then(|meta| string(meta, "quality_profile"))
        .is_some();
    let authored_view_box = spec
        .get("meta")
        .and_then(|meta| meta.get("viewBox"))
        .and_then(Value::as_array)
        .filter(|value| value.len() == 2)
        .and_then(|value| Some((value[0].as_f64()?, value[1].as_f64()?)));
    let mut members_by_id = BTreeMap::<String, BTreeSet<String>>::new();
    for (index, (boundary, id)) in boundaries.iter().zip(ids.iter()).enumerate() {
        let Some(bounds) = frame(geometry, id).copied() else {
            continue;
        };
        let authored_overflow = authored_view_box.is_some_and(|(width, height)| {
            right(bounds) as f64 / UNITS > width || bottom(bounds) as f64 / UNITS > height
        });
        // Automatic growth repairs only the right and bottom extents; the
        // canvas origin remains a boundary even without an authored viewBox.
        if bounds.x < 0 || bounds.y < 0 || authored_overflow {
            diagnostics.push(diag(
                "architecture", "geometry-container-containment", format!("/boundaries/{index}"),
                format!("boundary {:?} extends before the canvas origin or outside the authored viewBox",string(boundary,"label").unwrap_or("")),
                "move wrapped components inward, reduce padding or shorten the title; enlarge meta.viewBox only for right or bottom overflow",
            ));
        }
        let members: BTreeSet<String> = records(boundary, "wraps")
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        for member in &members {
            if let Some(node) = node_bounds.get(member.as_str()) {
                if !contained(bounds, *node) {
                    diagnostics.push(diag(
                        "architecture",
                        "geometry-container-containment",
                        format!("/boundaries/{index}/wraps"),
                        format!("boundary {:?} does not contain wrapped component {member:?}", string(boundary, "label").unwrap_or("")),
                        "increase boundary padding or move the wrapped component fully inside its frame",
                    ));
                }
            }
        }
        if title_checks {
            if let Some(title) = frame_label(geometry, id) {
                if !contained(bounds, title.bounds) {
                    diagnostics.push(diag(
                        "architecture",
                        "geometry-container-containment",
                        format!("/boundaries/{index}/label"),
                        "boundary title extends outside its own frame",
                        "shorten the title or increase boundary padding",
                    ));
                }
                for node in &geometry.nodes {
                    if members.contains(&node.id) {
                        continue;
                    }
                    if overlaps(title.bounds, node.bounds) {
                        diagnostics.push(diag(
                            "architecture",
                            "geometry-container-containment",
                            format!("/boundaries/{index}/label"),
                            format!("boundary title overlaps component {:?}", node.id),
                            "move the wrapped components, add boundary title space, or shorten the title",
                        ));
                    }
                }
            }
        }
        members_by_id.insert(id.clone(), members);
    }

    // The opt-in ownership profile makes frame nesting part of the document
    // contract. Ordinary architecture scopes may overlap freely.
    if profile {
        for left_index in 0..boundaries.len() {
            for right_index in left_index + 1..boundaries.len() {
                let left_id = &ids[left_index];
                let right_id = &ids[right_index];
                let (Some(left), Some(right_box)) =
                    (frame(geometry, left_id), frame(geometry, right_id))
                else {
                    continue;
                };
                let left_members = &members_by_id[left_id];
                let right_members = &members_by_id[right_id];
                let left_in_right = left_members.is_subset(right_members);
                let right_in_left = right_members.is_subset(left_members);
                if left_in_right && !contained(*right_box, *left) {
                    diagnostics.push(diag(
                        "architecture",
                        "geometry-container-containment",
                        format!("/boundaries/{left_index}"),
                        "nested boundary memberships do not have matching nested frame geometry",
                        "move the inner boundary's wrapped components or adjust frame padding",
                    ));
                } else if right_in_left && !contained(*left, *right_box) {
                    diagnostics.push(diag(
                        "architecture",
                        "geometry-container-containment",
                        format!("/boundaries/{right_index}"),
                        "nested boundary memberships do not have matching nested frame geometry",
                        "move the inner boundary's wrapped components or adjust frame padding",
                    ));
                } else if left_members.is_disjoint(right_members) && overlaps(*left, *right_box) {
                    diagnostics.push(diag(
                        "architecture",
                        "geometry-container-containment",
                        format!("/boundaries/{right_index}"),
                        "disjoint ownership boundaries overlap in the rendered scene",
                        "reposition the wrapped components or adjust boundary padding so frames are separate",
                    ));
                }
            }
        }
    }
    if title_checks {
        let titles: Vec<_> = ids
            .iter()
            .filter_map(|id| frame_label(geometry, id).map(|label| (id, label)))
            .collect();
        for left_index in 0..titles.len() {
            for right_index in left_index + 1..titles.len() {
                if overlaps(titles[left_index].1.bounds, titles[right_index].1.bounds) {
                    let index = ids
                        .iter()
                        .position(|id| id == titles[right_index].0)
                        .unwrap_or(0);
                    diagnostics.push(diag(
                        "architecture",
                        "geometry-container-containment",
                        format!("/boundaries/{index}/label"),
                        "boundary title labels overlap one another",
                        "shorten one title or reposition the wrapped component sets",
                    ));
                }
            }
        }
    }
    diagnostics
}

fn workflow_frames(spec: &Value, geometry: &GeometryDocument) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();
    let nodes: BTreeMap<_, _> = geometry
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node.bounds))
        .collect();
    let lanes = records(spec, "lanes");

    for (index, phase) in records(spec, "phases").iter().enumerate() {
        let Some(id) = string(phase, "id") else {
            continue;
        };
        let frame_id = format!("phase:{id}");
        let Some(bounds) = frame(geometry, &frame_id).copied() else {
            continue;
        };
        if let Some(label) = frame_label(geometry, &frame_id) {
            // The format's 16px phase rail is decorative, not a text-height
            // clipping box. Noto line height may extend below it; only the
            // authored horizontal range constrains this heading.
            if label.bounds.x < bounds.x || right(label.bounds) > right(bounds) {
                diagnostics.push(diag(
                    "workflow",
                    "geometry-phase-range",
                    format!("/phases/{index}/label"),
                    format!("phase title {id:?} extends outside its phase frame"),
                    "widen the phase range or shorten its label",
                ));
            }
        }
        let (Some(from), Some(to)) = (integer(phase, "fromCol"), integer(phase, "toCol")) else {
            continue;
        };
        if from > to {
            continue;
        }
        for (node_index, node) in records(spec, "nodes").iter().enumerate() {
            let Some(col) = integer(node, "col") else {
                continue;
            };
            if col < from || col > to {
                continue;
            }
            let Some(node_id) = string(node, "id") else {
                continue;
            };
            let Some(node_bounds) = nodes.get(node_id) else {
                continue;
            };
            if node_bounds.x < bounds.x || right(*node_bounds) > right(bounds) {
                diagnostics.push(diag(
                    "workflow",
                    "geometry-phase-range",
                    format!("/phases/{index}"),
                    format!("phase {:?} does not span the geometry for node {node_id:?} in columns {from}..{to}", id),
                    format!("extend the phase range to cover column {col} or reposition the node"),
                ));
                let _ = node_index;
                break;
            }
        }
    }

    for (index, group) in records(spec, "groups").iter().enumerate() {
        let (Some(id), Some(lane), Some(from), Some(to)) = (
            string(group, "id"),
            string(group, "lane"),
            integer(group, "fromCol"),
            integer(group, "toCol"),
        ) else {
            continue;
        };
        if from > to {
            continue;
        }
        let frame_id = format!("group:{id}");
        let Some(bounds) = frame(geometry, &frame_id).copied() else {
            continue;
        };
        for node in records(spec, "nodes") {
            if string(node, "lane") != Some(lane) {
                continue;
            }
            let Some(col) = integer(node, "col") else {
                continue;
            };
            if col < from || col > to {
                continue;
            }
            let Some(node_id) = string(node, "id") else {
                continue;
            };
            let Some(node_bounds) = nodes.get(node_id) else {
                continue;
            };
            if !contained(bounds, *node_bounds) {
                diagnostics.push(diag(
                    "workflow",
                    "geometry-group-containment",
                    format!("/groups/{index}"),
                    format!("group {id:?} does not contain member node {node_id:?}"),
                    "widen the group range or reposition the member node inside its frame",
                ));
                break;
            }
        }
        if let Some(label) = frame_label(geometry, &frame_id) {
            if !contained(bounds, label.bounds) {
                diagnostics.push(diag(
                    "workflow",
                    "geometry-group-containment",
                    format!("/groups/{index}/label"),
                    format!("group title {id:?} extends outside its frame"),
                    "shorten the title or widen the group range",
                ));
            }
        }
    }

    // Lane title rails are reserved above member geometry. Check the measured
    // title boxes against nodes rather than assuming the S2 lane frame is enough.
    for (index, lane) in lanes.iter().enumerate() {
        let Some(id) = string(lane, "id") else {
            continue;
        };
        let frame_id = format!("lane:{id}");
        let Some(label) = frame_label(geometry, &frame_id) else {
            continue;
        };
        let lane_bounds = frame(geometry, &frame_id).copied();
        for node in records(spec, "nodes") {
            if string(node, "lane") != Some(id) {
                continue;
            }
            let Some(node_id) = string(node, "id") else {
                continue;
            };
            let Some(node_bounds) = nodes.get(node_id) else {
                continue;
            };
            if lane_bounds.is_some_and(|bounds| !contained(bounds, *node_bounds)) {
                diagnostics.push(diag(
                    "workflow",
                    "geometry-container-containment",
                    format!("/lanes/{index}"),
                    format!("lane frame {id:?} does not contain node {node_id:?}"),
                    "move the node into the lane frame or expand the frame bounds",
                ));
            }
            if overlaps(label.bounds, *node_bounds) {
                diagnostics.push(diag(
                    "workflow",
                    "geometry-container-containment",
                    format!("/lanes/{index}/label"),
                    format!("lane title {id:?} overlaps node {node_id:?}"),
                    "move lane content down or shorten the lane title",
                ));
                break;
            }
        }
    }
    diagnostics
}

fn sequence_legend(spec: &Value, geometry: &GeometryDocument) -> Vec<Diagnostic> {
    let meta = spec.get("meta").unwrap_or(&Value::Null);
    if string(meta, "quality_profile") != Some("showcase") || meta.get("legend").is_some() {
        return Vec::new();
    }
    let Some(view_box) = meta.get("viewBox").and_then(Value::as_array) else {
        return Vec::new();
    };
    if view_box.len() != 2 {
        return Vec::new();
    }
    let Some(height) = view_box[1].as_f64() else {
        return Vec::new();
    };
    let mut content_bottom: f64 = 0.0;
    for message in records(spec, "messages") {
        if let Some(y) = number(message, "y") {
            content_bottom = content_bottom.max(
                y + if string(message, "note").is_some() {
                    22.0
                } else {
                    6.0
                },
            );
        }
    }
    for activation in records(spec, "activations") {
        if let Some(to) = number(activation, "to") {
            content_bottom = content_bottom.max(to);
        }
    }
    for segment in records(spec, "segments") {
        if let Some(to) = number(segment, "to") {
            content_bottom = content_bottom.max(to);
        }
    }
    let required_height = (content_bottom + 12.0 + 86.0).ceil();
    let measured_bottom = (i64::from(geometry.legend.bounds.y)
        + i64::from(geometry.legend.bounds.height)) as f64
        / UNITS;
    if required_height > height || measured_bottom > height {
        return vec![diag(
            "sequence",
            "geometry-legend-clearance",
            "/meta/viewBox/1",
            format!("sequence content ends near y={content_bottom:.0}; the implicit legend needs about {required_height:.0}px but the authored canvas is {height:.0}px high"),
            "increase meta.viewBox[1] or omit the authored height so the renderer can grow the canvas",
        )];
    }
    Vec::new()
}

pub(crate) fn frame_geometry_diagnostics(
    spec: &Value,
    geometry: &GeometryDocument,
) -> Vec<Diagnostic> {
    match string(spec, "diagram_type") {
        Some("architecture") => architecture_frames(spec, geometry),
        Some("workflow") => workflow_frames(spec, geometry),
        Some("sequence") => sequence_legend(spec, geometry),
        Some("lifecycle") | Some("dataflow") => Vec::new(),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::{
        GeometryContainer, GeometryLegend, GeometryNode, GeometryPage, GeometryPositionSource,
    };

    fn geometry(
        nodes: Vec<GeometryNode>,
        containers: Vec<GeometryContainer>,
        labels: Vec<GeometryLabel>,
    ) -> GeometryDocument {
        GeometryDocument {
            nodes,
            containers,
            routes: Vec::new(),
            labels,
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
                    width: 920 * 64,
                    height: 900 * 64,
                },
            },
        }
    }

    fn node(id: &str, x: i32, y: i32, width: i32, height: i32) -> GeometryNode {
        GeometryNode {
            id: id.into(),
            bounds: GeometryBox {
                x,
                y,
                width,
                height,
            },
            position_source: GeometryPositionSource::Automatic,
        }
    }

    #[test]
    fn automatic_page_growth_cannot_hide_a_negative_boundary_origin() {
        let source = serde_json::json!({"schema_version":1,"diagram_type":"architecture","meta":{"title":"Frame","output":"frame.html"},
            "components":[{"id":"a","type":"backend","label":"A","pos":[10,100]}],
            "boundaries":[{"kind":"region","label":"Region","wraps":["a"],"pad":30}],"connections":[]});
        let report = crate::layout::layout_json(
            &serde_json::json!({"specJson":source.to_string()}).to_string(),
        );
        assert!(!report.ok);
        assert!(report.geometry.is_some());
        assert!(report
            .diagnostics
            .iter()
            .any(|d| d.code == "architecture/geometry-container-containment"
                && d.path == "/boundaries/0"));
    }

    #[test]
    fn reports_boundary_member_containment_without_removing_geometry() {
        let spec = serde_json::json!({
            "diagram_type":"architecture","meta":{"quality_profile":"showcase"},
            "components":[{"id":"a","type":"backend","label":"A","pos":[100,100]}],
            "boundaries":[{"kind":"region","label":"Region","wraps":["a"]}]
        });
        let boundary_id = architecture_boundary_ids(&spec).unwrap().remove(0);
        let scene = geometry(
            vec![node("a", 100 * 64, 100 * 64, 80 * 64, 60 * 64)],
            vec![GeometryContainer {
                id: boundary_id,
                kind: "region".into(),
                bounds: GeometryBox {
                    x: 0,
                    y: 0,
                    width: 32 * 64,
                    height: 32 * 64,
                },
            }],
            Vec::new(),
        );
        let diagnostics = frame_geometry_diagnostics(&spec, &scene);
        assert!(diagnostics
            .iter()
            .any(|d| d.code == "architecture/geometry-container-containment"));
        assert_eq!(scene.nodes.len(), 1);
    }

    #[test]
    fn reports_workflow_group_member_and_lane_title_conflicts() {
        let spec = serde_json::json!({
            "diagram_type":"workflow","meta":{"title":"W"},
            "lanes":[{"id":"main","label":"Main"}],
            "nodes":[{"id":"a","lane":"main","col":0,"type":"backend","label":"A"}],
            "groups":[{"id":"g","lane":"main","fromCol":0,"toCol":0,"label":"Group"}],"phases":[]
        });
        let scene = geometry(
            vec![node("a", 100 * 64, 100 * 64, 80 * 64, 60 * 64)],
            vec![
                GeometryContainer {
                    id: "group:g".into(),
                    kind: "group".into(),
                    bounds: GeometryBox {
                        x: 0,
                        y: 0,
                        width: 20 * 64,
                        height: 20 * 64,
                    },
                },
                GeometryContainer {
                    id: "lane:main".into(),
                    kind: "lane".into(),
                    bounds: GeometryBox {
                        x: 0,
                        y: 0,
                        width: 500 * 64,
                        height: 200 * 64,
                    },
                },
            ],
            vec![GeometryLabel {
                id: Some("container:lane:main:label".into()),
                target_id: "lane:main".into(),
                text: "Main".into(),
                bounds: GeometryBox {
                    x: 100 * 64,
                    y: 100 * 64,
                    width: 20 * 64,
                    height: 12 * 64,
                },
                font: crate::metrics::font_identity(400).unwrap(),
                font_size: 10 * 64,
                glyphs: Vec::new(),
            }],
        );
        let diagnostics = frame_geometry_diagnostics(&spec, &scene);
        assert!(diagnostics
            .iter()
            .any(|d| d.code == "workflow/geometry-group-containment"));
        assert!(diagnostics
            .iter()
            .any(|d| d.code == "workflow/geometry-container-containment"));
    }

    #[test]
    fn reports_sequence_showcase_legend_that_cannot_fit_authored_height() {
        let spec = serde_json::json!({
            "diagram_type":"sequence",
            "meta":{"title":"Sequence","quality_profile":"showcase","viewBox":[920,760]},
            "participants":[{"id":"a","type":"frontend","label":"A"},{"id":"b","type":"backend","label":"B"}],
            "messages":[{"from":"a","to":"b","y":650,"label":"Call","note":"Detail"}]
        });
        let mut scene = geometry(Vec::new(), Vec::new(), Vec::new());
        scene.legend.bounds.y = 750 * 64;
        scene.legend.bounds.height = 20 * 64;
        let diagnostics = sequence_legend(&spec, &scene);
        assert!(diagnostics
            .iter()
            .any(|d| d.code == "sequence/geometry-legend-clearance"));
    }
}
