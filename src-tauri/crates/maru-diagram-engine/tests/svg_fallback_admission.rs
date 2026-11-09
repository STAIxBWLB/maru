#![cfg(feature = "render-svg")]

use maru_diagram_engine::{
    layout::layout_json,
    render::{check_svg_artifact, render_svg, SvgOptions, SvgTheme},
    validate_json,
};
use serde_json::{json, Value};

const FAMILIES: [&str; 5] = [
    "architecture",
    "workflow",
    "sequence",
    "dataflow",
    "lifecycle",
];

fn fixture(family: &str) -> Value {
    serde_json::from_str(match family {
        "architecture" => include_str!("../testdata/valid-architecture.json"),
        "workflow" => include_str!("../testdata/valid-workflow.json"),
        "sequence" => include_str!("../testdata/valid-sequence.json"),
        "dataflow" => include_str!("../testdata/valid-dataflow.json"),
        "lifecycle" => include_str!("../testdata/valid-lifecycle.json"),
        _ => unreachable!(),
    })
    .unwrap()
}

fn route_collection(family: &str) -> &'static str {
    match family {
        "architecture" => "connections",
        "workflow" => "edges",
        "sequence" => "messages",
        "dataflow" => "flows",
        "lifecycle" => "transitions",
        _ => unreachable!(),
    }
}

fn node_collection(family: &str) -> &'static str {
    match family {
        "architecture" => "components",
        "workflow" | "dataflow" => "nodes",
        "sequence" => "participants",
        "lifecycle" => "states",
        _ => unreachable!(),
    }
}

fn reject_source(spec: &Value, label: &str) {
    let source = spec.to_string();
    let validation = validate_json(&source);
    assert!(!validation.ok, "{label} unexpectedly passed E1 validation");
    let report = layout_json(&json!({"specJson":source}).to_string());
    assert!(
        report.geometry.is_none(),
        "{label} must be refused before layout admission: {:?}",
        report.diagnostics
    );
}

#[test]
fn unsupported_types_variants_widths_and_boundary_kinds_are_refused() {
    for family in FAMILIES {
        let mut unknown_type = fixture(family);
        unknown_type[node_collection(family)][0]["type"] = json!("unknown-kind");
        reject_source(&unknown_type, &format!("{family} unknown node/state type"));

        let mut unknown_variant = fixture(family);
        unknown_variant[route_collection(family)][0]["variant"] = json!("unknown-variant");
        reject_source(&unknown_variant, &format!("{family} unknown route variant"));

        for width in [0.0, 0.25] {
            let mut invalid_width = fixture(family);
            invalid_width[route_collection(family)][0]["width"] = json!(width);
            reject_source(&invalid_width, &format!("{family} route width {width}"));
        }
    }

    let mut unknown_boundary = fixture("architecture");
    unknown_boundary["boundaries"] = json!([
        {"kind":"unrecognized-boundary","label":"Unknown","wraps":["a"]}
    ]);
    reject_source(&unknown_boundary, "architecture unknown boundary kind");
}

fn set_variant(spec: &mut Value, family: &str, variant: Option<&str>) {
    let route = &mut spec[route_collection(family)][0];
    if let Some(variant) = variant {
        route["variant"] = json!(variant);
    } else {
        route.as_object_mut().unwrap().remove("variant");
    }
}

fn route_path<'a>(document: &'a roxmltree::Document<'a>) -> roxmltree::Node<'a, 'a> {
    document
        .descendants()
        .find(|node| node.attribute("data-kind") == Some("route-path"))
        .expect("fixture renders a route path")
}

fn replace_route_attribute(svg: &str, name: &str, value: &str) -> String {
    let start = svg.find("<polyline data-kind=\"route-path\"").unwrap();
    let end = svg[start..].find('>').unwrap() + start;
    let tag = &svg[start..end];
    let marker = format!("{name}=\"");
    let value_start = tag.find(&marker).unwrap() + marker.len();
    let value_end = tag[value_start..].find('"').unwrap() + value_start;
    format!(
        "{}{}{}",
        &svg[..start + value_start],
        value,
        &svg[start + value_end..]
    )
}

fn route_style(
    variant: Option<&str>,
    theme: SvgTheme,
) -> (&'static str, &'static str, Option<&'static str>) {
    let (arrow, emphasis) = match theme {
        SvgTheme::Light => ("#94a3b8", "#059669"),
        SvgTheme::Dark => ("#64748b", "#34d399"),
    };
    match variant.unwrap_or("default") {
        "emphasis" => (emphasis, "url(#arrow-emphasis)", None),
        "security" => (
            match theme {
                SvgTheme::Light => "#e11d48",
                SvgTheme::Dark => "#fb7185",
            },
            "url(#arrow-security)",
            Some("5 5"),
        ),
        "dashed" => (
            match theme {
                SvgTheme::Light => "#7c3aed",
                SvgTheme::Dark => "#a78bfa",
            },
            "url(#arrow-dashed)",
            Some("4 4"),
        ),
        "return" => (arrow, "url(#arrow)", Some("3 5")),
        _ => (arrow, "url(#arrow)", None),
    }
}

#[test]
fn valid_route_branches_render_source_colors_markers_and_patterns_in_both_themes() {
    for family in FAMILIES {
        let mut variants = vec![
            None,
            Some("default"),
            Some("emphasis"),
            Some("security"),
            Some("dashed"),
        ];
        if family == "sequence" {
            variants.push(Some("return"));
        }
        for variant in variants {
            let mut spec = fixture(family);
            set_variant(&mut spec, family, variant);
            let source = spec.to_string();
            assert!(
                validate_json(&source).ok,
                "valid {family} {variant:?} source"
            );
            let layout = layout_json(&json!({"specJson":source}).to_string());
            assert!(
                layout.ok,
                "{} {:?}: {:?}",
                family, variant, layout.diagnostics
            );
            let geometry = layout.geometry.unwrap();
            for theme in [SvgTheme::Light, SvgTheme::Dark] {
                let options = SvgOptions::from_spec(&spec, theme).unwrap();
                let report = render_svg(&geometry, &options);
                assert!(
                    report.ok,
                    "{} {:?} {:?}: {:?}",
                    family, variant, theme, report.diagnostics
                );
                let svg = report.svg.unwrap();
                assert!(check_svg_artifact(&svg, &geometry, &options).is_empty());
                let document = roxmltree::Document::parse(&svg).unwrap();
                let path = route_path(&document);
                let (stroke, marker, dash) = route_style(variant, theme);
                assert_eq!(
                    path.attribute("stroke"),
                    Some(stroke),
                    "{family} {variant:?} {theme:?}"
                );
                assert_eq!(
                    path.attribute("marker-end"),
                    Some(marker),
                    "{family} {variant:?} {theme:?}"
                );
                assert_eq!(
                    path.attribute("stroke-dasharray"),
                    dash,
                    "{family} {variant:?} {theme:?}"
                );

                let wrong_marker = if marker == "url(#arrow-emphasis)" {
                    "url(#arrow)"
                } else {
                    "url(#arrow-emphasis)"
                };
                let corrupted_marker = replace_route_attribute(&svg, "marker-end", wrong_marker);
                assert!(!check_svg_artifact(&corrupted_marker, &geometry, &options).is_empty());
                let corrupted_color = replace_route_attribute(&svg, "stroke", "#000000");
                assert!(!check_svg_artifact(&corrupted_color, &geometry, &options).is_empty());
            }
        }
    }
}

fn sequence_with_activation() -> Value {
    let mut spec = fixture("sequence");
    spec["activations"] = json!([
        {"participant":"a","from":180,"to":280,"type":"security"}
    ]);
    spec
}

fn activation_fragment(svg: &str, marker: &str) -> String {
    let marker_start = svg.find(marker).unwrap();
    let start = svg[..marker_start].rfind('<').unwrap();
    let end = svg[marker_start..].find("/>").unwrap() + marker_start + 2;
    svg[start..end].to_owned()
}

#[test]
fn activation_mask_is_required_and_must_precede_kind_painted_body() {
    let spec = sequence_with_activation();
    let layout = layout_json(&json!({"specJson":spec.to_string()}).to_string());
    assert!(layout.ok, "{:?}", layout.diagnostics);
    let geometry = layout.geometry.unwrap();
    let options = SvgOptions::from_spec(&spec, SvgTheme::Light).unwrap();
    let report = render_svg(&geometry, &options);
    assert!(report.ok, "{:?}", report.diagnostics);
    let svg = report.svg.unwrap();
    let activation = svg.find("data-source-id=\"activation:0\"").unwrap();
    let group_start = svg[..activation].rfind("<g ").unwrap();
    let group_end = svg[activation..].find("</g>").unwrap() + activation + 4;
    let group = &svg[group_start..group_end];
    let mask = activation_fragment(group, "data-kind=\"activation-mask\"");
    let body = activation_fragment(group, "data-kind=\"container-box\"");
    assert!(
        svg[activation..].find("activation-mask").unwrap()
            < svg[activation..].find("container-box").unwrap()
    );

    let without_mask = svg.replacen(&mask, "", 1);
    assert!(!check_svg_artifact(&without_mask, &geometry, &options).is_empty());
    let reversed = svg.replacen(&format!("{mask}{body}"), &format!("{body}{mask}"), 1);
    assert!(!check_svg_artifact(&reversed, &geometry, &options).is_empty());
}
