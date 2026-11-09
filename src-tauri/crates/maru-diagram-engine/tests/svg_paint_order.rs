#![cfg(feature = "render-svg")]

use maru_diagram_engine::{
    geometry::GeometryDocument,
    layout::layout_json,
    render::{check_svg_artifact, render_svg, SvgOptions, SvgTheme},
};
use serde_json::{json, Value};

fn sequence() -> (Value, GeometryDocument, SvgOptions, String) {
    let mut spec: Value =
        serde_json::from_str(include_str!("../testdata/valid-sequence.json")).unwrap();
    spec["segments"] = json!([{"from":150,"to":250,"label":"Phase"}]);
    spec["activations"] = json!([{"participant":"b","from":170,"to":220,"type":"backend"}]);
    let geometry = layout_json(&json!({"specJson":spec.to_string()}).to_string())
        .geometry
        .expect("sequence fixture retains geometry");
    let options = SvgOptions::from_spec(&spec, SvgTheme::Light).unwrap();
    let report = render_svg(&geometry, &options);
    assert!(report.ok, "{:?}", report.diagnostics);
    let svg = report.svg.expect("fixture renders an SVG");
    assert!(check_svg_artifact(&svg, &geometry, &options).is_empty());
    (spec, geometry, options, svg)
}

fn fragment(svg: &str, marker: &str, grouped: bool) -> String {
    let marker_start = svg.find(marker).expect("mutation marker exists");
    let start = svg[..marker_start].rfind('<').unwrap();
    let end = if grouped {
        svg[marker_start..].find("</g>").unwrap() + marker_start + 4
    } else {
        svg[marker_start..].find("/>").unwrap() + marker_start + 2
    };
    svg[start..end].to_owned()
}

fn remove_fragment(svg: &str, marker: &str, grouped: bool) -> (String, String) {
    let value = fragment(svg, marker, grouped);
    (svg.replacen(&value, "", 1), value)
}

fn rejected(svg: &str, geometry: &GeometryDocument, options: &SvgOptions) {
    assert!(
        !check_svg_artifact(svg, geometry, options).is_empty(),
        "paint-order mutation must be rejected"
    );
}

#[test]
fn page_moved_to_end_is_rejected() {
    let (_, geometry, options, svg) = sequence();
    let (mut changed, page) = remove_fragment(&svg, "data-kind=\"page\"", false);
    let end = changed.rfind("</svg>").unwrap();
    changed.insert_str(end, &page);
    rejected(&changed, &geometry, &options);
}

#[test]
fn lifeline_moved_after_opaque_node_is_rejected() {
    let (_, geometry, options, svg) = sequence();
    let (mut changed, lifeline) = remove_fragment(&svg, "data-kind=\"sequence-lifeline\"", false);
    let node = &geometry.nodes[0];
    let node_marker = format!("data-kind=\"node\" data-source-id=\"{}\"", node.id);
    let node_group = fragment(&changed, &node_marker, true);
    let insert = changed.find(&node_group).unwrap() + node_group.len();
    changed.insert_str(insert, &lifeline);
    rejected(&changed, &geometry, &options);
}

#[test]
fn activation_moved_before_underlay_is_rejected() {
    let (_, geometry, options, svg) = sequence();
    let activation = geometry
        .containers
        .iter()
        .find(|container| container.kind == "activation")
        .expect("sequence fixture includes an activation");
    let marker = format!("data-source-id=\"{}\"", activation.id);
    let (mut changed, group) = remove_fragment(&svg, &marker, true);
    let underlay_marker = "data-kind=\"sequence-lifeline\"";
    let at = changed[..changed.find(underlay_marker).unwrap()]
        .rfind('<')
        .unwrap();
    changed.insert_str(at, &group);
    rejected(&changed, &geometry, &options);
}

#[test]
fn node_mask_moved_after_node_body_is_rejected() {
    let (_, geometry, options, svg) = sequence();
    let mask = fragment(&svg, "data-kind=\"node-mask\"", false);
    let body = fragment(&svg, "data-kind=\"node-box\"", false);
    let changed = svg
        .replacen(&mask, "", 1)
        .replacen(&body, &format!("{body}{mask}"), 1);
    rejected(&changed, &geometry, &options);
}

#[test]
fn label_moved_before_frames_is_rejected() {
    let (_, geometry, options, svg) = sequence();
    let label = geometry
        .labels
        .first()
        .expect("sequence fixture has labels");
    let marker = format!(
        "data-kind=\"label\" data-source-id=\"id:{}\"",
        label.id.as_ref().unwrap()
    );
    let (mut changed, group) = remove_fragment(&svg, &marker, true);
    let container = geometry
        .containers
        .iter()
        .find(|container| container.kind != "activation")
        .expect("sequence fixture has frames");
    let frame_marker = format!("data-source-id=\"{}\"", container.id);
    let at = changed[..changed.find(&frame_marker).unwrap()]
        .rfind('<')
        .unwrap();
    changed.insert_str(at, &group);
    rejected(&changed, &geometry, &options);
}
