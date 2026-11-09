#![cfg(feature = "render-svg")]

use maru_diagram_engine::{
    layout::layout_json,
    render::{check_svg_artifact, render_svg, SvgOptions, SvgTheme},
};
use serde_json::json;

fn rendered() -> (
    String,
    maru_diagram_engine::geometry::GeometryDocument,
    SvgOptions,
) {
    let spec: serde_json::Value =
        serde_json::from_str(include_str!("../testdata/valid-architecture.json")).unwrap();
    let report = layout_json(&json!({"specJson": spec.to_string()}).to_string());
    assert!(report.ok, "fixture layout failed: {:?}", report.diagnostics);
    let geometry = report.geometry.expect("successful fixture has geometry");
    let options = SvgOptions::from_spec(&spec, SvgTheme::Light).unwrap();
    let report = render_svg(&geometry, &options);
    assert!(report.ok, "fixture render failed: {:?}", report.diagnostics);
    (
        report.svg.expect("successful render has SVG"),
        geometry,
        options,
    )
}

fn assert_rejected(
    svg: &str,
    geometry: &maru_diagram_engine::geometry::GeometryDocument,
    options: &SvgOptions,
) {
    let diagnostics = check_svg_artifact(svg, geometry, options);
    assert!(!diagnostics.is_empty(), "mutated XML was accepted");
    assert!(diagnostics
        .iter()
        .all(|item| !item.message.is_empty() && !item.fix.is_empty()));
}

#[test]
fn rejects_processing_instructions_comments_declarations_doctypes_cdata_and_stray_text() {
    let (svg, geometry, options) = rendered();
    let root_end = svg.find('>').expect("root element opens") + 1;
    let stray_text = format!("{}stray text{}", &svg[..root_end], &svg[root_end..]);
    let title_start = svg.find("<title").expect("fixture has title");
    let title_content = svg[title_start..].find('>').expect("title opens") + title_start + 1;
    let title_end = svg[title_content..].find("</title>").expect("title closes") + title_content;
    let cdata = format!(
        "{}<![CDATA[{}]]>{}",
        &svg[..title_content],
        &svg[title_content..title_end],
        &svg[title_end..]
    );
    for mutation in [
        format!("<?xml-stylesheet href=\"https://example.invalid/a.css\"?>{svg}"),
        svg.replacen("<svg", "<?local instruction?><svg", 1),
        svg.replacen("<svg", "<!-- injected comment --><svg", 1),
        format!("<?xml version=\"1.0\"?>{svg}"),
        svg.replacen("<svg", "<!DOCTYPE svg [<!ENTITY injected \"x\">]><svg", 1),
        cdata,
        stray_text,
    ] {
        assert_rejected(&mutation, &geometry, &options);
    }
}

#[test]
fn accepts_renderer_text_whitespace_and_escaped_xml_like_label_text() {
    let (svg, geometry, mut options) = rendered();
    assert!(check_svg_artifact(&svg, &geometry, &options).is_empty());

    let mut spec: serde_json::Value =
        serde_json::from_str(include_str!("../testdata/valid-architecture.json")).unwrap();
    spec["components"][0]["label"] = json!("<?xml?>");
    let report = layout_json(&json!({"specJson": spec.to_string()}).to_string());
    assert!(
        report.ok,
        "XML-like label layout failed: {:?}",
        report.diagnostics
    );
    let geometry = report.geometry.expect("successful fixture has geometry");
    options = SvgOptions::from_spec(&spec, SvgTheme::Light).unwrap();
    let report = render_svg(&geometry, &options);
    assert!(
        report.ok,
        "escaped label text failed: {:?}",
        report.diagnostics
    );
    let escaped = report.svg.expect("successful render has SVG");
    assert!(escaped.contains("&lt;?xml?&gt;"));
    assert!(check_svg_artifact(&escaped, &geometry, &options).is_empty());
}
