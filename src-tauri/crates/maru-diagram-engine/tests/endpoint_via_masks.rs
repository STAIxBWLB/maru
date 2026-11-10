#![cfg(feature = "geometry")]

use maru_diagram_engine::layout::layout_json;
use serde_json::{json, Value};

fn oracle_green_spec(id: &str) -> Value {
    let corpus: Value = serde_json::from_str(include_str!("../testdata/parity.json")).unwrap();
    let case = corpus["boundaryCases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["id"].as_str() == Some(id))
        .unwrap_or_else(|| panic!("restore pinned boundary case {id}"));
    assert_eq!(case["oracle"]["ok"], true, "{id} must stay Oracle-green");
    assert_eq!(case["boundary"]["layer"], "model-difference");
    serde_json::from_str(
        case["geometryComparison"]["inputJson"]
            .as_str()
            .expect("case retains its exact compared source"),
    )
    .unwrap()
}

fn layout(spec: &Value) -> maru_diagram_engine::geometry::GeometryReport {
    layout_json(&json!({"specJson":spec.to_string()}).to_string())
}

fn content_offset(
    geometry: &maru_diagram_engine::geometry::GeometryDocument,
) -> maru_diagram_engine::geometry::GeometryPoint {
    geometry
        .page
        .content_offset
        .unwrap_or(maru_diagram_engine::geometry::GeometryPoint { x: 0, y: 0 })
}

fn source_point_to_rendered(
    geometry: &maru_diagram_engine::geometry::GeometryDocument,
    point: maru_diagram_engine::geometry::GeometryPoint,
) -> maru_diagram_engine::geometry::GeometryPoint {
    let offset = content_offset(geometry);
    point.checked_translate(offset.x, offset.y).unwrap()
}

fn authored_via_from_rendered(
    geometry: &maru_diagram_engine::geometry::GeometryDocument,
    point: maru_diagram_engine::geometry::GeometryPoint,
) -> [f64; 2] {
    let offset = content_offset(geometry);
    [
        f64::from(point.x - offset.x) / 64.0,
        f64::from(point.y - offset.y) / 64.0,
    ]
}

fn authored_via_to_rendered(
    geometry: &maru_diagram_engine::geometry::GeometryDocument,
    point: [f64; 2],
) -> maru_diagram_engine::geometry::GeometryPoint {
    source_point_to_rendered(
        geometry,
        maru_diagram_engine::geometry::GeometryPoint::from_pixels(point[0], point[1]).unwrap(),
    )
}

#[test]
fn oracle_green_dataflow_routes_keep_vias_inside_the_target_endpoint_mask() {
    for id in [
        "e2-boundary-dataflow-label-route-3",
        "e2-boundary-dataflow-label-route-5",
    ] {
        let spec = oracle_green_spec(id);
        let report = layout(&spec);
        assert!(report.ok, "{id}: {:?}", report.diagnostics);
        let geometry = report.geometry.expect("accepted layout retains geometry");
        assert_eq!(geometry.routes.len(), 2, "{id}");
        let target = geometry.nodes.iter().find(|node| node.id == "b").unwrap();
        let source_via = maru_diagram_engine::geometry::GeometryPoint {
            x: 270 * 64,
            y: 157 * 64,
        };
        let final_via = source_point_to_rendered(&geometry, source_via);
        assert!(
            final_via.x > target.bounds.x
                && final_via.x < target.bounds.x + target.bounds.width
                && final_via.y > target.bounds.y
                && final_via.y < target.bounds.y + target.bounds.height,
            "{id}: pinned fixture must place a via anchor inside target b"
        );
        for route in &geometry.routes {
            assert!(
                !route.points.is_empty(),
                "{id}: {:?} must keep route geometry",
                route.id
            );
        }
        assert!(
            geometry
                .routes
                .iter()
                .any(|route| route.points.contains(&final_via)),
            "{id}: endpoint-mask via remains a mandatory route point"
        );
    }
}

#[test]
fn oracle_green_sequence_messages_keep_auto_labels_clear_of_fixed_ports() {
    let spec = oracle_green_spec("e2-boundary-sequence-family-label-route-above");
    let report = layout(&spec);
    assert!(report.ok, "{:?}", report.diagnostics);
    let geometry = report.geometry.expect("accepted layout retains geometry");
    let first = geometry
        .routes
        .iter()
        .find(|route| route.id.as_deref() == Some("message:0"))
        .expect("first authored message route");
    let second = geometry
        .routes
        .iter()
        .find(|route| route.id.as_deref() == Some("message:1"))
        .expect("second authored message route");
    assert!(
        !first.points.is_empty(),
        "first route retains its fixed timeline ports"
    );
    assert!(
        !second.points.is_empty(),
        "second route retains its fixed timeline ports"
    );
    let label = geometry
        .labels
        .iter()
        .find(|label| label.id.as_deref() == Some("edge:message:1:label"))
        .expect("the automatic second message label remains visible");
    let left = label.bounds.x - 4 * 64;
    let top = label.bounds.y - 4 * 64;
    let right = label.bounds.x + label.bounds.width + 4 * 64;
    let bottom = label.bounds.y + label.bounds.height + 4 * 64;
    assert!(
        first.points.iter().all(|point| {
            point.x <= left || point.x >= right || point.y <= top || point.y >= bottom
        }),
        "the automatic label must stay at least 4px from every first-message port/escape: label={:?}, route={:?}",
        label.bounds,
        first.points
    );
}

#[test]
fn third_party_node_and_its_owned_label_remain_obstacles_to_endpoint_vias() {
    let mut spec = oracle_green_spec("e2-boundary-dataflow-label-route-3");
    spec["nodes"].as_array_mut().unwrap().push(json!({
        "id":"c","type":"backend","label":"C","stage":1,"row":2
    }));
    let report = layout(&spec);
    assert!(
        !report.ok,
        "a third-party node label cannot use an endpoint-mask exemption"
    );
    assert!(report.geometry.is_some(), "refusal retains placed geometry");
    assert!(
        report.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "dataflow/route-blocked"
                && diagnostic.message.contains("route anchor")
        }),
        "{:?}",
        report.diagnostics
    );
}

#[test]
fn endpoint_id_collision_does_not_mask_an_edge_owned_label_obstacle() {
    let mut spec = oracle_green_spec("e2-boundary-dataflow-label-route-3");
    spec["flows"] = json!([
        {
            "id":"a",
            "from":"a",
            "to":"b",
            "label":"Obstacle",
            "labelAt":[270,400]
        },
        {
            "id":"second",
            "from":"a",
            "to":"b",
            "label":"Data",
            "labelAt":[700,500],
            "via":[[180,157],[180,400],[270,400],[270,157]]
        }
    ]);
    let report = layout(&spec);
    assert!(
        !report.ok,
        "an edge label with a node-colliding target ID remains an obstacle"
    );
    assert!(report.geometry.is_some());
    assert!(
        report.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "dataflow/route-blocked"
                && diagnostic.message.contains("route anchor")
        }),
        "{:?}",
        report.diagnostics
    );
}

#[test]
fn explicit_wrong_side_still_refuses_a_via_route_into_an_endpoint_mask() {
    let mut spec = oracle_green_spec("e2-boundary-dataflow-label-route-3");
    spec["flows"][0]["fromSide"] = json!("left");
    let report = layout(&spec);
    assert!(
        !report.ok,
        "endpoint masks must not weaken authored side contracts"
    );
    assert!(
        report.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "dataflow/geometry-route-quality"
                && diagnostic.message.contains("authored-endpoint-direction")
        }),
        "{:?}",
        report.diagnostics
    );
}

#[test]
fn authored_route_label_inside_endpoint_body_remains_an_overlap() {
    let mut spec = oracle_green_spec("e2-boundary-dataflow-label-route-3");
    spec["flows"][0]["labelAt"] = json!([315, 157]);
    let report = layout(&spec);
    assert!(
        !report.ok,
        "endpoint route masks must not exempt authored relationship labels"
    );
    assert!(report.geometry.is_some(), "refusal retains placed geometry");
    assert!(
        report.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "dataflow/geometry-label-overlap"
                && diagnostic.message.contains("label-node-overlap")
        }),
        "{:?}",
        report.diagnostics
    );
}

fn axis_segment_hits(
    bounds: maru_diagram_engine::geometry::GeometryBox,
    from: maru_diagram_engine::geometry::GeometryPoint,
    to: maru_diagram_engine::geometry::GeometryPoint,
) -> bool {
    let right = bounds.x + bounds.width;
    let bottom = bounds.y + bounds.height;
    if from.y == to.y {
        from.y > bounds.y
            && from.y < bottom
            && from.x.min(to.x) < right
            && bounds.x < from.x.max(to.x)
    } else if from.x == to.x {
        from.x > bounds.x
            && from.x < right
            && from.y.min(to.y) < bottom
            && bounds.y < from.y.max(to.y)
    } else {
        true
    }
}

fn endpoint_mask_dataflow(via: Vec<[f64; 2]>) -> Value {
    json!({
        "schema_version":1,
        "diagram_type":"dataflow",
        "meta":{"title":"Endpoint via mask","output":"endpoint-mask.html","viewBox":[940,720]},
        "stages":[{"label":"Input"},{"label":"Output"}],
        "nodes":[
            {"id":"a","type":"backend","label":"A","stage":0,"row":0},
            {"id":"b","type":"backend","label":"B","stage":1,"row":0}
        ],
        "flows":[{
            "id":"f","from":"a","to":"b","label":"Flow",
            "via":via,"labelAt":[700,500]
        }]
    })
}

#[test]
fn via_outside_source_does_not_exempt_a_route_that_would_cut_through_source_ink() {
    let spec = endpoint_mask_dataflow(vec![[10.0, 157.0], [230.0, 157.0]]);
    let report = layout(&spec);
    let geometry = report.geometry.expect("accepted layout retains geometry");
    let source = geometry.nodes.iter().find(|node| node.id == "a").unwrap();
    let source_label = geometry
        .labels
        .iter()
        .find(|label| label.id.as_deref() == Some("node:a:label"))
        .unwrap();
    let route = geometry
        .routes
        .iter()
        .find(|route| route.id.as_deref() == Some("f"))
        .expect("authored route is retained");
    if !report.ok {
        assert!(
            report.diagnostics.iter().any(|diagnostic| matches!(
                diagnostic.code.as_str(),
                "dataflow/route-blocked" | "dataflow/route-port-blocked"
            )),
            "refusal must identify the blocked authored route: {:?}",
            report.diagnostics
        );
    }
    if route.points.is_empty() {
        assert!(
            report.diagnostics.iter().any(|diagnostic| matches!(
                diagnostic.code.as_str(),
                "dataflow/route-blocked" | "dataflow/route-port-blocked"
            )),
            "an empty retained route requires an actionable route refusal: {:?}",
            report.diagnostics
        );
    } else {
        for segment in route.points.windows(2) {
            assert!(
                !axis_segment_hits(source.bounds, segment[0], segment[1]),
                "outside via route crossed source body: {:?}",
                route.points
            );
            assert!(
                !axis_segment_hits(source_label.bounds, segment[0], segment[1]),
                "outside via route crossed source label ink box: {:?}",
                route.points
            );
        }
    }
}

#[test]
fn clearance_ring_and_visible_boundaries_never_authorize_endpoint_masks() {
    let probe = endpoint_mask_dataflow(vec![[230.0, 157.0]]);
    let probe_report = layout(&probe);
    assert!(
        probe_report.ok,
        "probe layout refused: {:?}",
        probe_report.diagnostics
    );
    let probe_geometry = probe_report
        .geometry
        .expect("probe layout retains geometry");
    let source = probe_geometry
        .nodes
        .iter()
        .find(|node| node.id == "a")
        .unwrap();
    let label = probe_geometry
        .labels
        .iter()
        .find(|label| label.id.as_deref() == Some("node:a:label"))
        .unwrap();
    let center_y = source.bounds.y + source.bounds.height / 2;
    let label_ring = maru_diagram_engine::geometry::GeometryPoint {
        x: label.bounds.x - 64,
        y: label.bounds.y + label.bounds.height / 2,
    };
    assert!(source.bounds.contains(label_ring).unwrap_or(false));
    assert!(!label.bounds.contains(label_ring).unwrap_or(false));
    let label_ring_xy = authored_via_from_rendered(&probe_geometry, label_ring);
    let visible_boundary_xy = authored_via_from_rendered(
        &probe_geometry,
        maru_diagram_engine::geometry::GeometryPoint {
            x: source.bounds.x,
            y: center_y,
        },
    );
    let inflated_corner_xy = authored_via_from_rendered(
        &probe_geometry,
        maru_diagram_engine::geometry::GeometryPoint {
            x: source.bounds.x - 2 * 64,
            y: source.bounds.y - 2 * 64,
        },
    );
    let cases = [
        ("node-clearance-ring", [43.0, 175.0]),
        ("visible-node-boundary", visible_boundary_xy),
        ("inflated-node-corner", inflated_corner_xy),
        ("label-clearance-ring", label_ring_xy),
    ];

    for (name, first_via) in cases {
        let report = layout(&endpoint_mask_dataflow(vec![
            first_via,
            [230.0, first_via[1]],
        ]));
        let geometry = report
            .geometry
            .unwrap_or_else(|| panic!("{name}: refusal must retain geometry"));
        let source = geometry.nodes.iter().find(|node| node.id == "a").unwrap();
        let source_label = geometry
            .labels
            .iter()
            .find(|label| label.id.as_deref() == Some("node:a:label"))
            .unwrap();
        let route = geometry
            .routes
            .iter()
            .find(|route| route.id.as_deref() == Some("f"))
            .unwrap_or_else(|| panic!("{name}: authored route record is retained"));
        if name == "inflated-node-corner" {
            assert!(!report.ok, "diagonal source pin remains refused");
            assert!(
                report.diagnostics.iter().any(|diagnostic| {
                    diagnostic.code == "dataflow/geometry-route-quality"
                        && diagnostic.message.contains("non-orthogonal")
                }),
                "corner control must retain the source diagonal cause: {:?}",
                report.diagnostics
            );
        } else if name != "label-clearance-ring" {
            assert!(
                !report.ok,
                "a via inside only planning padding must not authorize its visible obstacle"
            );
            assert!(
                report.diagnostics.iter().any(|diagnostic| matches!(
                    diagnostic.code.as_str(),
                    "dataflow/route-blocked" | "dataflow/route-port-blocked"
                )),
                "{name}: refusal must name the blocked route, got {:?}",
                report.diagnostics
            );
        } else if !report.ok {
            assert!(
                report.diagnostics.iter().any(|diagnostic| matches!(
                    diagnostic.code.as_str(),
                    "dataflow/route-blocked" | "dataflow/route-port-blocked"
                )),
                "label-ring refusal must name the blocked route: {:?}",
                report.diagnostics
            );
        }
        if report.ok {
            assert!(
                !route.points.is_empty(),
                "accepted route must retain its points"
            );
            let authored_via = authored_via_to_rendered(&geometry, first_via);
            assert!(
                route.points.contains(&authored_via),
                "{name}: accepted route must retain its authored via"
            );
        }
        for segment in route.points.windows(2) {
            assert!(
                !axis_segment_hits(source_label.bounds, segment[0], segment[1]),
                "{name}: route crossed visible source label: {:?}",
                route.points
            );
            if name != "label-clearance-ring" {
                assert!(
                    !axis_segment_hits(source.bounds, segment[0], segment[1]),
                    "{name}: route crossed visible source body: {:?}",
                    route.points
                );
            }
        }
    }
}

#[test]
fn via_inside_source_body_can_enter_and_exit_its_endpoint_mask() {
    let probe = endpoint_mask_dataflow(vec![[230.0, 157.0]]);
    let probe_report = layout(&probe);
    assert!(
        probe_report.ok,
        "probe layout refused: {:?}",
        probe_report.diagnostics
    );
    let probe_geometry = probe_report
        .geometry
        .expect("probe layout retains geometry");
    let source = probe_geometry
        .nodes
        .iter()
        .find(|node| node.id == "a")
        .unwrap();
    let inside_rendered = maru_diagram_engine::geometry::GeometryPoint {
        x: source.bounds.x + source.bounds.width - 5 * 64,
        y: source.bounds.y + source.bounds.height / 2,
    };
    let inside_xy = authored_via_from_rendered(&probe_geometry, inside_rendered);
    assert!(source.bounds.contains(inside_rendered).unwrap_or(false));
    let spec = endpoint_mask_dataflow(vec![inside_xy, [230.0, inside_xy[1]]]);
    let report = layout(&spec);
    assert!(
        report.ok,
        "inside-source via remains a valid authored path: {:?}",
        report.diagnostics
    );
    let geometry = report.geometry.expect("accepted layout retains geometry");
    let source = geometry.nodes.iter().find(|node| node.id == "a").unwrap();
    let inside = authored_via_to_rendered(&geometry, inside_xy);
    assert!(source.bounds.contains(inside).unwrap_or(false));
    let route = geometry
        .routes
        .iter()
        .find(|route| route.id.as_deref() == Some("f"))
        .expect("authored route is retained");
    let via_index = route
        .points
        .iter()
        .position(|point| *point == inside)
        .expect("inside via remains a mandatory route point");
    assert!(
        route.points[..=via_index]
            .windows(2)
            .any(|segment| axis_segment_hits(source.bounds, segment[0], segment[1])),
        "incoming leg should be allowed to enter the authored endpoint node mask"
    );
    assert!(
        route.points[via_index..]
            .windows(2)
            .any(|segment| axis_segment_hits(source.bounds, segment[0], segment[1])),
        "outgoing leg should be allowed to exit the authored endpoint node mask"
    );
}

#[test]
fn automatic_self_edge_keeps_distinct_ports_and_avoids_an_unrelated_participant() {
    let mut spec: Value =
        serde_json::from_str(include_str!("../testdata/valid-workflow.json")).unwrap();
    spec["edges"] = json!([
        {"id":"self","from":"a","to":"a","role":"main","label":"Self"}
    ]);
    let report = layout(&spec);
    assert!(report.ok, "{:?}", report.diagnostics);
    let geometry = report.geometry.unwrap();
    let route = geometry
        .routes
        .iter()
        .find(|route| route.id.as_deref() == Some("self"))
        .unwrap();
    assert_eq!(route.from, "a");
    assert_eq!(route.to, "a");
    assert!(route.points.len() >= 3);
    assert_ne!(
        route.points.first(),
        route.points.last(),
        "automatic self-loop must retain distinct source and target ports"
    );
    let unrelated = geometry
        .nodes
        .iter()
        .find(|node| node.id == "b")
        .unwrap()
        .bounds;
    assert!(
        route
            .points
            .windows(2)
            .all(|segment| { !axis_segment_hits(unrelated, segment[0], segment[1]) }),
        "automatic self-loop crossed an unrelated participant"
    );
}
