#![cfg(feature = "render-svg")]

use maru_diagram_engine::{
    layout::layout_json,
    render::{check_svg_artifact, render_svg, SvgOptions, SvgTheme},
};
use serde_json::{json, Value};

#[test]
fn css_like_source_text_is_not_interpreted_as_active_svg_content() {
    let mut spec: Value =
        serde_json::from_str(include_str!("../testdata/valid-architecture.json")).unwrap();
    spec["components"][0]["label"] = json!("@import");
    spec["meta"]["title"] = json!("url(https://example.com)");

    let report = layout_json(&json!({"specJson": spec.to_string()}).to_string());
    assert!(report.ok, "fixture layout failed: {:?}", report.diagnostics);
    let geometry = report.geometry.expect("successful fixture has geometry");
    assert!(geometry.nodes.iter().any(|node| node.id == "a"));
    assert!(geometry.nodes.iter().any(|node| node.id == "b"));

    let mut options = SvgOptions::from_spec(&spec, SvgTheme::Light).unwrap();
    options.title = "@import".into();
    options.description = "url(https://example.com)".into();
    let rendered = render_svg(&geometry, &options);
    assert!(
        rendered.ok,
        "text values must remain text: {:?}",
        rendered.diagnostics
    );
    let svg = rendered.svg.expect("successful render has SVG");
    assert!(svg.contains("<title id=\"maru-title\">@import</title>"));
    assert!(svg.contains("url(https://example.com)"));
    assert!(check_svg_artifact(&svg, &geometry, &options).is_empty());
}
