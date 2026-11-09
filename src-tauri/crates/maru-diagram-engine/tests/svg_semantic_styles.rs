#![cfg(feature = "render-svg")]

use maru_diagram_engine::{
    geometry::GeometryDocument,
    layout::layout_json,
    render::{render_svg, SvgOptions, SvgTheme},
};
use serde_json::{json, Value};

fn layout(spec: &Value) -> GeometryDocument {
    let report = layout_json(&json!({"specJson":spec.to_string()}).to_string());
    assert!(report.ok, "fixture layout failed: {:?}", report.diagnostics);
    report.geometry.expect("successful fixture has geometry")
}

fn render(spec: &Value, geometry: &GeometryDocument, theme: SvgTheme) -> String {
    let options = SvgOptions::from_spec(spec, theme).unwrap();
    let report = render_svg(geometry, &options);
    assert!(
        report.ok,
        "semantic style render failed: {:?}",
        report.diagnostics
    );
    report.svg.expect("successful render has SVG")
}

fn find<'a>(doc: &'a roxmltree::Document<'a>, kind: &str, target: &str) -> roxmltree::Node<'a, 'a> {
    doc.descendants()
        .find(|node| {
            node.attribute("data-kind") == Some(kind)
                && node.attribute("data-target-id") == Some(target)
        })
        .unwrap_or_else(|| panic!("missing {kind} for {target}"))
}

fn find_container_box<'a>(
    doc: &'a roxmltree::Document<'a>,
    target: &str,
) -> roxmltree::Node<'a, 'a> {
    let container = doc
        .descendants()
        .find(|node| {
            node.attribute("data-kind") == Some("container")
                && node.attribute("data-source-id") == Some(target)
        })
        .unwrap_or_else(|| panic!("missing container {target}"));
    container
        .children()
        .find(|node| node.attribute("data-kind") == Some("container-box"))
        .unwrap_or_else(|| panic!("missing container box {target}"))
}

fn route_spec() -> Value {
    let mut spec: Value =
        serde_json::from_str(include_str!("../testdata/valid-dataflow.json")).unwrap();
    spec["meta"]["legend"]["mode"] = json!("all");
    spec["stages"] = json!([
        {"label":"Input"},
        {"label":"Process"},
        {"label":"Output"}
    ]);
    spec["nodes"].as_array_mut().unwrap().push(json!({
        "id":"c", "type":"database", "label":"Store", "stage":2, "row":0
    }));
    spec["flows"] = json!([
        {"from":"a", "to":"b", "label":"Secure", "variant":"security"},
        {"from":"b", "to":"c", "label":"Query", "variant":"dashed"}
    ]);
    spec
}

#[test]
fn route_and_legend_variant_paints_match_both_themes() {
    let spec = route_spec();
    let geometry = layout(&spec);
    for (theme, security, database) in [
        (SvgTheme::Light, "#e11d48", "#7c3aed"),
        (SvgTheme::Dark, "#fb7185", "#a78bfa"),
    ] {
        let svg = render(&spec, &geometry, theme);
        let doc = roxmltree::Document::parse(&svg).unwrap();
        for (variant, color, dash, marker) in [
            ("security", security, "5 5", "url(#arrow-security)"),
            ("dashed", database, "4 4", "url(#arrow-dashed)"),
        ] {
            let route = doc
                .descendants()
                .find(|node| {
                    node.attribute("data-kind") == Some("route")
                        && node.attribute("data-route-variant") == Some(variant)
                })
                .expect("variant route is emitted");
            let path = route
                .children()
                .find(|node| node.attribute("data-kind") == Some("route-path"))
                .expect("route path is emitted");
            assert_eq!(path.attribute("stroke"), Some(color));
            assert_eq!(path.attribute("stroke-dasharray"), Some(dash));
            assert_eq!(path.attribute("marker-end"), Some(marker));

            let swatch = find(&doc, "legend-route-swatch", variant);
            assert_eq!(swatch.attribute("stroke"), Some(color));
            assert_eq!(swatch.attribute("stroke-dasharray"), Some(dash));
            assert_eq!(swatch.attribute("marker-end"), Some(marker));
        }
    }
}

#[test]
fn workflow_phase_variant_uses_route_semantic_color_in_both_themes() {
    let mut spec: Value =
        serde_json::from_str(include_str!("../testdata/valid-workflow.json")).unwrap();
    spec["phases"] = json!([
        {"id":"secure", "label":"Secure", "fromCol":0, "toCol":1, "variant":"security"},
        {"id":"async", "label":"Async", "fromCol":3, "toCol":4, "variant":"dashed"}
    ]);
    let geometry = layout(&spec);
    for (theme, security, database) in [
        (SvgTheme::Light, "#e11d48", "#7c3aed"),
        (SvgTheme::Dark, "#fb7185", "#a78bfa"),
    ] {
        let svg = render(&spec, &geometry, theme);
        let doc = roxmltree::Document::parse(&svg).unwrap();
        for (id, color, dash) in [("secure", security, "5 5"), ("async", database, "4 4")] {
            let phase = find(&doc, "workflow-phase-span", &format!("phase:{id}"));
            assert_eq!(phase.attribute("stroke"), Some(color));
            assert_eq!(phase.attribute("stroke-dasharray"), Some(dash));
        }
    }
}

fn architecture_with_boundaries() -> Value {
    let mut spec: Value =
        serde_json::from_str(include_str!("../testdata/valid-architecture.json")).unwrap();
    spec["boundaries"] = json!([
        {"kind":"region", "label":"Public", "wraps":["a"]},
        {"kind":"security-group", "label":"Private", "wraps":["b"]}
    ]);
    spec
}

#[test]
fn architecture_frame_kinds_and_unknown_frame_fallback_are_theme_stable() {
    let spec = architecture_with_boundaries();
    let geometry = layout(&spec);
    for (theme, cloud, security, lane_fill, lane_stroke) in [
        (
            SvgTheme::Light,
            "#d97706",
            "#e11d48",
            "rgba(248,250,252,0.65)",
            "#cbd5e1",
        ),
        (
            SvgTheme::Dark,
            "#fbbf24",
            "#fb7185",
            "rgba(15,23,42,0.22)",
            "#334155",
        ),
    ] {
        let svg = render(&spec, &geometry, theme);
        let doc = roxmltree::Document::parse(&svg).unwrap();
        let region = find_container_box(&doc, "boundary:0");
        assert_eq!(region.attribute("fill"), Some("rgba(251,191,36,0.05)"));
        assert_eq!(region.attribute("stroke"), Some(cloud));
        assert_eq!(region.attribute("stroke-dasharray"), Some("8 4"));
        let security_group = find_container_box(&doc, "boundary:1");
        assert_eq!(security_group.attribute("fill"), Some("transparent"));
        assert_eq!(security_group.attribute("stroke"), Some(security));
        assert_eq!(security_group.attribute("stroke-dasharray"), Some("4 4"));

        let mut malformed = geometry.clone();
        malformed
            .containers
            .iter_mut()
            .find(|container| container.id == "boundary:0")
            .unwrap()
            .kind = "unrecognized-frame".into();
        let svg = render(&spec, &malformed, theme);
        let doc = roxmltree::Document::parse(&svg).unwrap();
        let fallback = find_container_box(&doc, "boundary:0");
        assert_eq!(fallback.attribute("fill"), Some(lane_fill));
        assert_eq!(fallback.attribute("stroke"), Some(lane_stroke));
        assert_eq!(fallback.attribute("stroke-dasharray"), Some("6 6"));
    }
}
