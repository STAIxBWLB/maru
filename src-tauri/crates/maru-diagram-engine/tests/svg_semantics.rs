#![cfg(feature = "render-svg")]

use maru_diagram_engine::{
    geometry::GeometryDocument,
    layout::layout_json,
    render::{check_svg_artifact, render_svg, SvgOptions, SvgTheme},
};
use serde_json::{json, Value};

fn render_spec(spec: Value) -> (String, GeometryDocument) {
    let report = layout_json(&json!({"specJson": spec.to_string()}).to_string());
    assert!(report.ok, "source layout failed: {:?}", report.diagnostics);
    let geometry = report.geometry.expect("successful layout has geometry");
    let source_geometry = geometry.clone();
    let options =
        SvgOptions::from_spec(&spec, SvgTheme::Light).expect("fixture has semantic context");
    let rendered = render_svg(&geometry, &options);
    assert!(
        rendered.ok,
        "semantic render failed: {:?}",
        rendered.diagnostics
    );
    assert_eq!(
        geometry, source_geometry,
        "rendering must not rewrite source geometry"
    );
    (rendered.svg.expect("successful render has SVG"), geometry)
}

fn sequence_spec() -> Value {
    json!({
        "schema_version": 1,
        "diagram_type": "sequence",
        "meta": {"title": "Sequence semantics", "output": "sequence.html", "legend": {"mode": "all"}},
        "participants": [
            {"id": "client", "type": "frontend", "label": "Client"},
            {"id": "service", "type": "security", "label": "Service"},
            {"id": "store", "type": "database", "label": "Store"}
        ],
        "messages": [
            {"id": "secure-call", "from": "client", "to": "service", "y": 180, "label": "Secure call", "variant": "security"},
            {"id": "response", "from": "service", "to": "client", "y": 240, "label": "Return", "variant": "return"},
            {"id": "query", "from": "service", "to": "store", "y": 300, "label": "Query", "variant": "dashed"}
        ],
        "segments": [{"from": 160, "to": 340, "label": "Request phase"}],
        "activations": [{"participant": "service", "from": 180, "to": 280, "type": "backend"}]
    })
}

fn lifecycle_spec(version: u32) -> Value {
    json!({
        "schema_version": version,
        "diagram_type": "lifecycle",
        "meta": {"title": "Lifecycle semantics", "output": "lifecycle.html", "legend": {"mode": "all"}},
        "lanes": [{"id": "main", "label": "Main"}],
        "states": [
            {"id": "start", "type": "start", "label": "Start", "lane": "main", "col": 0},
            {"id": "work", "type": "active", "label": "Work", "lane": "main", "col": 1},
            {"id": "sink", "type": "success", "label": "Sink", "lane": "main", "col": 2}
        ],
        "transitions": [
            {"id": "begin", "from": "start", "to": "work", "label": "Begin"},
            {"id": "finish", "from": "work", "to": "sink", "label": "Finish", "variant": "dashed"}
        ]
    })
}

fn replace_attr(svg: &str, kind: &str, attribute: &str, value: &str) -> String {
    let marker = format!("data-kind=\"{kind}\"");
    let marker_start = svg.find(&marker).expect("fixture contains primitive kind");
    let tag_start = svg[..marker_start].rfind('<').expect("marker is in a tag");
    let tag_end = svg[tag_start..].find('>').expect("tag closes") + tag_start;
    let tag = &svg[tag_start..tag_end];
    let attr = format!("{attribute}=\"");
    let value_start = tag.find(&attr).expect("primitive has target attribute") + attr.len();
    let value_end = tag[value_start..].find('"').expect("attribute is quoted") + value_start;
    format!(
        "{}{}{}",
        &svg[..tag_start + value_start],
        value,
        &svg[tag_start + value_end..]
    )
}

fn remove_element(svg: &str, kind: &str) -> String {
    let marker = format!("data-kind=\"{kind}\"");
    let marker_start = svg.find(&marker).expect("fixture contains primitive kind");
    let start = svg[..marker_start].rfind('<').expect("marker is in a tag");
    let end = svg[marker_start..]
        .find("/>")
        .expect("primitive is self closing")
        + marker_start
        + 2;
    format!("{}{}", &svg[..start], &svg[end..])
}

fn assert_rejected(svg: &str, geometry: &GeometryDocument, spec: &Value) {
    let options = SvgOptions::from_spec(spec, SvgTheme::Light).unwrap();
    let diagnostics = check_svg_artifact(svg, geometry, &options);
    assert!(!diagnostics.is_empty(), "mutated semantic SVG was accepted");
    assert!(diagnostics
        .iter()
        .all(|diagnostic| !diagnostic.message.is_empty() && !diagnostic.fix.is_empty()));
}

fn px(element: roxmltree::Node<'_, '_>, name: &str) -> f64 {
    element.attribute(name).unwrap().parse::<f64>().unwrap()
}

#[test]
fn sequence_primitives_preserve_lifeline_positions_and_variant_meanings() {
    let spec = sequence_spec();
    let (svg, geometry) = render_spec(spec);
    assert!(geometry
        .containers
        .iter()
        .any(|item| item.kind == "activation"));
    assert!(geometry
        .containers
        .iter()
        .any(|item| item.kind == "segment"));
    assert!(svg.contains("data-kind=\"sequence-lifeline\""));
    assert!(svg.contains("stroke-dasharray=\"3 7\""));
    assert!(svg.contains("stroke-dasharray=\"5 5\""));
    assert!(svg.contains("stroke-dasharray=\"4 4\""));
    assert!(svg.contains("stroke-dasharray=\"3 5\""));
    assert!(svg.contains("stroke=\"#059669\""));
    let document = roxmltree::Document::parse(&svg).unwrap();
    for node in &geometry.nodes {
        let lifeline = document
            .descendants()
            .find(|element| {
                element.attribute("data-kind") == Some("sequence-lifeline")
                    && element.attribute("data-target-id") == Some(node.id.as_str())
            })
            .expect("every sequence participant has a lifeline");
        assert!(
            (px(lifeline, "x1") * 64.0 - (node.bounds.x + node.bounds.width / 2) as f64).abs()
                < 0.01
        );
        assert!(
            (px(lifeline, "y1") * 64.0 - (node.bounds.y + node.bounds.height) as f64).abs() < 0.01
        );
    }
}

#[test]
fn sequence_primitive_missing_extra_coordinate_dash_and_owner_mutations_fail() {
    let spec = sequence_spec();
    let (svg, geometry) = render_spec(spec.clone());
    assert_rejected(&remove_element(&svg, "sequence-lifeline"), &geometry, &spec);

    let marker = "data-kind=\"sequence-lifeline\"";
    let marker_start = svg.find(marker).unwrap();
    let start = svg[..marker_start].rfind('<').unwrap();
    let end = svg[marker_start..].find("/>").unwrap() + marker_start + 2;
    let copied = &svg[start..end];
    let extra = svg.replace("</svg>", &format!("{copied}</svg>"));
    assert_rejected(&extra, &geometry, &spec);

    assert_rejected(
        &replace_attr(&svg, "sequence-lifeline", "x1", "9999"),
        &geometry,
        &spec,
    );
    assert_rejected(
        &replace_attr(&svg, "sequence-lifeline", "stroke-dasharray", "1 1"),
        &geometry,
        &spec,
    );
    assert_rejected(
        &replace_attr(&svg, "sequence-lifeline", "data-target-id", "wrong-owner"),
        &geometry,
        &spec,
    );
}

#[test]
fn lifecycle_v1_and_v2_emit_initial_final_and_final_legend_symbols() {
    for version in [1, 2] {
        let spec = lifecycle_spec(version);
        let (svg, geometry) = render_spec(spec);
        assert!(geometry
            .nodes
            .iter()
            .any(|node| node.id == "sink" && node.final_state == Some(true)));
        for kind in [
            "lifecycle-initial-dot",
            "lifecycle-initial-stem",
            "lifecycle-initial-head",
            "lifecycle-final-border",
            "legend-final-outer",
            "legend-final-inner",
        ] {
            assert!(
                svg.contains(&format!("data-kind=\"{kind}\"")),
                "missing {kind} for schema {version}"
            );
        }
        let sink = geometry
            .nodes
            .iter()
            .find(|node| node.id == "sink")
            .unwrap();
        let inset = (3 * 64)
            .min(sink.bounds.width.min(sink.bounds.height) / 4)
            .max(0);
        let document = roxmltree::Document::parse(&svg).unwrap();
        let border = document
            .descendants()
            .find(|element| element.attribute("data-kind") == Some("lifecycle-final-border"))
            .expect("final state has a visible semantic border");
        assert!((px(border, "x") * 64.0 - (sink.bounds.x + inset) as f64).abs() < 0.01);
        assert!((px(border, "y") * 64.0 - (sink.bounds.y + inset) as f64).abs() < 0.01);
        assert!((px(border, "width") * 64.0 - (sink.bounds.width - 2 * inset) as f64).abs() < 0.01);
        assert!(
            (px(border, "height") * 64.0 - (sink.bounds.height - 2 * inset) as f64).abs() < 0.01
        );
    }
}

#[test]
fn lifecycle_final_marker_and_radius_mutations_fail() {
    let spec = lifecycle_spec(2);
    let (svg, geometry) = render_spec(spec.clone());
    assert_rejected(
        &remove_element(&svg, "lifecycle-final-border"),
        &geometry,
        &spec,
    );
    assert_rejected(
        &replace_attr(&svg, "lifecycle-final-border", "rx", "0"),
        &geometry,
        &spec,
    );
    assert_rejected(
        &replace_attr(&svg, "legend-final-outer", "fill", "none"),
        &geometry,
        &spec,
    );
}

#[test]
fn semantic_markers_follow_placed_pins_without_reclassifying_authored_lifecycle_order() {
    let spec = sequence_spec();
    let spec_json = spec.to_string();
    let request = json!({"specJson":spec_json,"pinSet":{"sourceSpecSha256":maru_diagram_engine::validate_json(&spec_json).receipt.input_spec_sha256,"pins":[{"targetId":"client","targetKind":"node","position":{"x":32000,"y":6400}}]}});
    let g = layout_json(&request.to_string()).geometry.unwrap();
    let o = SvgOptions::from_spec(&spec, SvgTheme::Light).unwrap();
    let result = render_svg(&g, &o);
    assert!(result.ok, "{:?}", result.diagnostics);
    let svg = result.svg.unwrap();
    let parsed = roxmltree::Document::parse(&svg).unwrap();
    let line = parsed
        .descendants()
        .find(|n| {
            n.attribute("data-kind") == Some("sequence-lifeline")
                && n.attribute("data-target-id") == Some("client")
        })
        .unwrap();
    let node = g.nodes.iter().find(|n| n.id == "client").unwrap();
    assert_eq!(
        line.attribute("x1").unwrap().parse::<f64>().unwrap(),
        (node.bounds.x + node.bounds.width / 2) as f64 / 64.0
    );
    assert_eq!(
        line.attribute("y1").unwrap().parse::<f64>().unwrap(),
        (node.bounds.y + node.bounds.height) as f64 / 64.0
    );

    let spec: Value =
        serde_json::from_str(include_str!("../testdata/valid-lifecycle.json")).unwrap();
    let source = spec.to_string();
    let g=layout_json(&json!({"specJson":source,"pinSet":{"sourceSpecSha256":maru_diagram_engine::validate_json(&source).receipt.input_spec_sha256,"pins":[{"targetId":"b","targetKind":"node","position":{"x":0,"y":8064}}]}}).to_string()).geometry.unwrap();
    let b = g.nodes.iter().find(|n| n.id == "b").unwrap();
    let a = g.nodes.iter().find(|n| n.id == "a").unwrap();
    assert_eq!(b.final_state, Some(true));
    assert_eq!(a.final_state, Some(false));
    assert!(
        a.phase_order < b.phase_order,
        "authored phase order must survive swapped screen positions"
    );
    let o = SvgOptions::from_spec(&spec, SvgTheme::Light).unwrap();
    let result = render_svg(&g, &o);
    assert!(result.ok, "{:?}", result.diagnostics);
}
