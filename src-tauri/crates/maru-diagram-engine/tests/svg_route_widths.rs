#![cfg(feature = "render-svg")]

use maru_diagram_engine::{
    geometry::GeometryDocument,
    layout::layout_json,
    render::{check_svg_artifact, render_svg, SvgOptions, SvgTheme},
};
use serde_json::{json, Value};

fn fixture(family: &str, version: u32) -> Value {
    let filename = match family {
        "architecture" => "valid-architecture.json",
        "workflow" => "valid-workflow.json",
        "sequence" => "valid-sequence.json",
        "dataflow" => "valid-dataflow.json",
        "lifecycle" => "valid-lifecycle.json",
        _ => unreachable!("known diagram family"),
    };
    let input = match filename {
        "valid-architecture.json" => include_str!("../testdata/valid-architecture.json"),
        "valid-workflow.json" => include_str!("../testdata/valid-workflow.json"),
        "valid-sequence.json" => include_str!("../testdata/valid-sequence.json"),
        "valid-dataflow.json" => include_str!("../testdata/valid-dataflow.json"),
        "valid-lifecycle.json" => include_str!("../testdata/valid-lifecycle.json"),
        _ => unreachable!("known fixture"),
    };
    let mut spec: Value = serde_json::from_str(input).unwrap();
    spec["schema_version"] = json!(version);
    spec
}

fn layout(spec: &Value) -> GeometryDocument {
    let report = layout_json(&json!({"specJson": spec.to_string()}).to_string());
    assert!(report.ok, "fixture layout failed: {:?}", report.diagnostics);
    report.geometry.expect("successful fixture has geometry")
}

fn render_with_route(
    spec: &Value,
    variant: Option<&str>,
    width: Option<i32>,
) -> (String, GeometryDocument, SvgOptions) {
    let mut source = spec.clone();
    let collection = match source["diagram_type"].as_str().unwrap() {
        "architecture" => "connections",
        "workflow" => "edges",
        "sequence" => "messages",
        "dataflow" => "flows",
        _ => "transitions",
    };
    source[collection][0]["variant"] = json!(variant.unwrap_or("default"));
    let mut geometry = layout(&source);
    let route = geometry.routes.first_mut().expect("fixture has a route");
    route.width = width;
    let options = SvgOptions::from_spec(&source, SvgTheme::Light).expect("fixture has semantics");
    let report = render_svg(&geometry, &options);
    assert!(report.ok, "route render failed: {:?}", report.diagnostics);
    (
        report.svg.expect("successful render has SVG"),
        geometry,
        options,
    )
}

fn first_route_width(svg: &str) -> f64 {
    let doc = roxmltree::Document::parse(svg).expect("rendered SVG is XML");
    let path = doc
        .descendants()
        .find(|node| node.attribute("data-kind") == Some("route-path"))
        .expect("rendered SVG has a route path");
    path.attribute("stroke-width")
        .expect("route path has a stroke width")
        .parse()
        .expect("stroke width is numeric")
}

fn replace_first_route_width(svg: &str, value: &str) -> String {
    let marker = "data-kind=\"route-path\"";
    let marker_start = svg.find(marker).expect("fixture has route path");
    let tag_start = svg[..marker_start]
        .rfind('<')
        .expect("marker is inside a tag");
    let tag_end = svg[tag_start..].find('>').expect("route tag closes") + tag_start;
    let tag = &svg[tag_start..tag_end];
    let attribute = "stroke-width=\"";
    let start = tag.find(attribute).expect("route path has stroke-width") + attribute.len();
    let end = tag[start..].find('"').expect("stroke-width is quoted") + start;
    format!(
        "{}{}{}",
        &svg[..tag_start + start],
        value,
        &svg[tag_start + end..]
    )
}

fn assert_family_widths(family: &str, version: u32, normal: f64, emphasis: f64) {
    let spec = fixture(family, version);
    for (variant, expected) in [(None, normal), (Some("emphasis"), emphasis)] {
        let (svg, geometry, options) = render_with_route(&spec, variant, None);
        assert_eq!(
            first_route_width(&svg),
            expected,
            "{family} v{version} {variant:?}"
        );
        assert!(check_svg_artifact(&svg, &geometry, &options).is_empty());

        let wrong = replace_first_route_width(&svg, "9.9");
        assert!(
            !check_svg_artifact(&wrong, &geometry, &options).is_empty(),
            "{family} v{version} {variant:?} accepted a wrong stroke width"
        );
    }

    let (svg, geometry, options) = render_with_route(&spec, None, Some(128));
    assert_eq!(
        first_route_width(&svg),
        2.0,
        "{family} v{version} explicit width"
    );
    assert!(check_svg_artifact(&svg, &geometry, &options).is_empty());
    let wrong = replace_first_route_width(&svg, "9.9");
    assert!(!check_svg_artifact(&wrong, &geometry, &options).is_empty());
}

#[test]
fn route_width_defaults_and_explicit_geometry_widths_match_each_family() {
    assert_family_widths("architecture", 1, 1.5, 1.8);
    assert_family_widths("workflow", 1, 1.4, 1.8);
    assert_family_widths("sequence", 1, 1.4, 1.8);
    assert_family_widths("dataflow", 1, 1.4, 1.8);
    assert_family_widths("lifecycle", 1, 1.1, 2.0);
    assert_family_widths("lifecycle", 2, 1.1, 1.6);
}
