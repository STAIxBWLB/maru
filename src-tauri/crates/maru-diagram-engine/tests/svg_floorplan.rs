//! A Floorplan map rendered through the E3 writer (`maru#553` E5 T2).
//!
//! The map is synthetic: a nested tree with Korean, English and mixed labels, one
//! edge that leaves its frame, a flow and a tour. It is a `floorplan/architecture@1`
//! document, which carries no `diagram_type`, so the artifact path has to reach
//! the family's own layout entry point and the writer has to paint the result
//! without a Floorplan branch of its own.

#![cfg(all(feature = "render-svg", feature = "geometry"))]

use maru_diagram_engine::{
    layout::layout_floorplan_json,
    render::{render_artifact_json, render_svg, SvgOptions, SvgTheme},
};
use serde_json::{json, Value};

fn map() -> Value {
    json!({
        "$schema": "floorplan/architecture@1",
        "project": {
            "name": "중첩 지도 렌더",
            "summary": "Frames sized from the cells they hold, edges that cross their borders."
        },
        "nodes": [
            { "id": "web", "label": "웹 애플리케이션", "kind": "service" },
            { "id": "web.ui", "parent": "web", "label": "UI (React)", "kind": "ui",
              "summary": "화면과 입력 처리 계층" },
            { "id": "web.api", "parent": "web", "label": "API server", "kind": "service" },
            { "id": "web.api.auth", "parent": "web.api", "label": "인증 auth", "kind": "feature" },
            { "id": "web.adapters", "parent": "web", "label": "Adapters", "kind": "library" },
            { "id": "store", "label": "데이터 저장소", "kind": "data", "summary": "Postgres" }
        ],
        "edges": [
            { "from": "web.api.auth", "to": "store", "kind": "data" },
            { "from": "web.adapters", "to": "web.api", "kind": "event" }
        ],
        "flows": [
            { "id": "sign-in", "title": "로그인", "steps": [
                { "node": "web.ui" }, { "node": "web.api.auth" }, { "node": "store" } ] }
        ],
        "tour": [ { "node": "web", "title": "입구" } ]
    })
}

fn laid_out() -> (maru_diagram_engine::geometry::GeometryDocument, Value) {
    let spec = map();
    let report = layout_floorplan_json(&json!({ "specJson": spec.to_string() }).to_string());
    assert!(report.ok, "{:?}", report.diagnostics);
    (
        report.geometry.expect("a passing layout retains geometry"),
        spec,
    )
}

#[test]
fn the_map_renders_with_its_nested_parts_and_an_edge_that_leaves_them() {
    let (geometry, spec) = laid_out();
    let options = SvgOptions::from_source(&spec, SvgTheme::Light).expect("floorplan options");
    let report = render_svg(&geometry, &options);
    assert!(report.ok, "{:?}", report.diagnostics);
    let svg = report.svg.expect("a passing render retains its SVG");

    // Both frames are drawn as containers, and the nested one inside the outer.
    let outer = geometry
        .containers
        .iter()
        .find(|container| container.id == "web:section")
        .expect("the outer frame is a container");
    let inner = geometry
        .containers
        .iter()
        .find(|container| container.id == "web.api:section")
        .expect("the nested frame is a container");
    for container in [outer, inner] {
        assert!(
            svg.contains(&format!("data-source-id=\"{}\"", container.id)),
            "container {} is missing from the artifact",
            container.id
        );
    }
    assert!(
        i64::from(outer.bounds.x) < i64::from(inner.bounds.x)
            && i64::from(outer.bounds.y) < i64::from(inner.bounds.y),
        "the nested frame sits inside the outer one"
    );

    // The map's own title and both node kinds reach the emitted text.
    assert!(
        svg.contains("중첩 지도 렌더"),
        "the project name is the title"
    );
    assert!(
        svg.contains("인증 auth"),
        "a nested member's label is painted"
    );
    assert!(
        svg.contains("데이터 저장소"),
        "a top-level member's label is painted"
    );

    // One route per edge, and the one leaving the outer frame has a path.
    assert_eq!(geometry.routes.len(), 2);
    let leaving = geometry
        .routes
        .iter()
        .find(|route| route.id.as_deref() == Some("edge:0"))
        .expect("the first edge is routed");
    assert!(
        !leaving.points.is_empty(),
        "an edge across a frame border has a path"
    );
    assert!(
        svg.contains("data-kind=\"route-path\""),
        "the artifact carries route polylines"
    );
}

#[test]
fn the_artifact_path_reaches_the_sixth_family() {
    // The export command's request shape: the same envelope every family uses,
    // with a document that has no `diagram_type`.
    let spec = map();
    let request = json!({
        "specJson": spec.to_string(),
        "format": "svg",
        "theme": "light",
        "pixelRatio": 1
    });
    let report = render_artifact_json(&request.to_string());
    assert!(report.ok, "{:?}", report.diagnostics);
    let svg = report
        .svg
        .clone()
        .expect("a passing artifact retains its SVG");
    assert!(svg.contains("data-source-id=\"web:section\""));
    assert!(report.width.is_some() && report.height.is_some());

    // Two runs of the same request produce the same bytes.
    let again = render_artifact_json(&request.to_string());
    assert_eq!(report.bytes, again.bytes);
}

#[test]
fn flows_and_a_tour_change_no_painted_byte() {
    let spec = map();
    let mut without = spec.clone();
    without.as_object_mut().unwrap().remove("flows");
    without.as_object_mut().unwrap().remove("tour");
    let documents: Vec<_> = [spec, without]
        .iter()
        .map(|spec| {
            let report =
                layout_floorplan_json(&json!({ "specJson": spec.to_string() }).to_string());
            assert!(report.ok, "{:?}", report.diagnostics);
            let geometry = report.geometry.expect("geometry");
            let options = SvgOptions::from_source(spec, SvgTheme::Light).expect("options");
            render_svg(&geometry, &options)
                .svg
                .expect("a passing render retains its SVG")
        })
        .collect();
    assert_eq!(
        documents[0], documents[1],
        "an overlay changed the drawing, so it is a layout input"
    );
}
