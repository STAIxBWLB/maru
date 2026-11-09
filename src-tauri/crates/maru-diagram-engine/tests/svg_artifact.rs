#![cfg(feature = "render-svg")]

use maru_diagram_engine::{
    layout::layout_json,
    render::{check_svg_artifact, render_svg, SvgOptions, SvgTheme},
};
use serde_json::json;

fn scene() -> (maru_diagram_engine::geometry::GeometryDocument, SvgOptions) {
    let report = layout_json(
        &json!({"specJson": include_str!("../testdata/valid-architecture.json")}).to_string(),
    );
    assert!(report.ok, "fixture layout failed: {:?}", report.diagnostics);
    (
        report.geometry.expect("successful fixture has geometry"),
        SvgOptions {
            theme: SvgTheme::Light,
            title: "SVG gate fixture".into(),
            description: "Artifact gate integration fixture".into(),
        },
    )
}

fn rendered() -> (
    String,
    maru_diagram_engine::geometry::GeometryDocument,
    SvgOptions,
) {
    let (geometry, options) = scene();
    let report = render_svg(&geometry, &options);
    assert!(report.ok, "render failed gate: {:?}", report.diagnostics);
    (
        report.svg.expect("successful render has SVG"),
        geometry,
        options,
    )
}

fn replace_attr(svg: &str, element: &str, attribute: &str, replacement: &str) -> String {
    let marker_start = svg.find(element).expect("fixture contains target element");
    let start = svg[..marker_start]
        .rfind('<')
        .expect("target marker is inside an element tag");
    let end = svg[start..]
        .find('>')
        .expect("element has a closing bracket")
        + start;
    let tag = &svg[start..end];
    let marker = format!("{attribute}=\"");
    let value_start = tag.find(&marker).expect("target attribute exists") + marker.len();
    let value_end = tag[value_start..].find('"').expect("attribute is quoted") + value_start;
    format!(
        "{}{}{}",
        &svg[..start + value_start],
        replacement,
        &svg[start + value_end..]
    )
}

fn add_attr(svg: &str, element: &str, attribute: &str, value: &str) -> String {
    let marker_start = svg.find(element).expect("fixture contains target element");
    let end = svg[marker_start..]
        .find('>')
        .expect("element has a closing bracket")
        + marker_start;
    format!("{} {attribute}=\"{value}\"{}", &svg[..end], &svg[end..])
}

fn move_first_glyph_to_second_label(svg: &str) -> String {
    let mut labels = svg.match_indices("<text data-kind=\"label-text\"");
    let first = labels.next().expect("fixture has a first label").0;
    let second = labels.next().expect("fixture has a second label").0;
    let glyph_start = svg[first..]
        .find("<tspan")
        .expect("first label has a glyph")
        + first;
    let glyph_end = svg[glyph_start..]
        .find("</tspan>")
        .expect("glyph is closed")
        + glyph_start
        + "</tspan>".len();
    let glyph = &svg[glyph_start..glyph_end];
    let without_first = format!("{}{}", &svg[..glyph_start], &svg[glyph_end..]);
    let second_after_removal = second - (glyph_end - glyph_start);
    let second_close = without_first[second_after_removal..]
        .find("</text>")
        .expect("second label is closed")
        + second_after_removal;
    format!(
        "{}{}{}",
        &without_first[..second_close],
        glyph,
        &without_first[second_close..]
    )
}

fn assert_rejected(
    svg: &str,
    geometry: &maru_diagram_engine::geometry::GeometryDocument,
    options: &SvgOptions,
) {
    let diagnostics = check_svg_artifact(svg, geometry, options);
    assert!(!diagnostics.is_empty(), "mutated SVG was accepted");
    assert!(diagnostics
        .iter()
        .all(|item| !item.message.is_empty() && !item.fix.is_empty()));
}

#[test]
fn rendered_artifact_satisfies_independent_geometry_gate() {
    let (svg, geometry, options) = rendered();
    assert!(check_svg_artifact(&svg, &geometry, &options).is_empty());
}

#[test]
fn rejects_coordinate_text_font_id_and_malformed_xml_mutations() {
    let (svg, geometry, options) = rendered();
    let coordinate = replace_attr(&svg, "data-kind=\"node-box\"", "x", "9876");
    assert_rejected(&coordinate, &geometry, &options);

    let tspan = svg.find("<tspan").expect("fixture has visible glyphs");
    let content_start = svg[tspan..].find('>').expect("tspan opens") + tspan + 1;
    let content_end = svg[content_start..].find("</tspan>").expect("tspan closes") + content_start;
    let tampered_text = format!("{}X{}", &svg[..content_start], &svg[content_end..]);
    assert_rejected(&tampered_text, &geometry, &options);

    let font = replace_attr(&svg, "data-kind=\"label-text\"", "font-size", "999");
    assert_rejected(&font, &geometry, &options);

    let id = replace_attr(&svg, "data-kind=\"node\"", "id", "wrong-id");
    assert_rejected(&id, &geometry, &options);

    let transformed = add_attr(&svg, "data-kind=\"node\"", "transform", "translate(9000)");
    assert_rejected(&transformed, &geometry, &options);

    let stroke = replace_attr(&svg, "data-kind=\"route-path\"", "stroke", "#ff00ff");
    assert_rejected(&stroke, &geometry, &options);

    let moved_glyph = move_first_glyph_to_second_label(&svg);
    assert_rejected(&moved_glyph, &geometry, &options);

    let extra_marker_paint = svg.replace(
        "</defs>",
        "<polygon points=\"0,0 10,3.5 0,7\" fill=\"#94a3b8\"/></defs>",
    );
    assert_rejected(&extra_marker_paint, &geometry, &options);
    assert_rejected("<svg>", &geometry, &options);
}
