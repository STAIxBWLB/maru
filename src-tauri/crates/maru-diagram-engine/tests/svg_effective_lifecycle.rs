#![cfg(feature = "render-svg")]

use maru_diagram_engine::{
    geometry::GeometryDocument,
    layout::layout_json,
    render::{check_svg_artifact, render_svg, SvgOptions, SvgTheme},
    validate_json,
};
use serde_json::{json, Value};

fn spec(version: u32) -> Value {
    json!({
        "schema_version": version,
        "diagram_type": "lifecycle",
        "meta": {"title":"Effective lifecycle variants","output":"effective.html"},
        "lanes": [
            {"id":"main","label":"Main"},
            {"id":"event","label":"Event"}
        ],
        "states": [
            {"id":"a","type":"active","label":"A","lane":"main","col":0},
            {"id":"b","type":"success","label":"B","lane":"main","col":2},
            {"id":"c","type":"active","label":"C","lane":"main","col":0,"yOffset":120},
            {"id":"d","type":"active","label":"D","lane":"event","col":1},
            {"id":"e","type":"active","label":"E","lane":"main","col":3},
            {"id":"f","type":"active","label":"F","lane":"main","col":4}
        ],
        "transitions": [
            {"id":"forward","from":"a","to":"b"},
            {"id":"backward","from":"b","to":"a"},
            {"id":"equal","from":"a","to":"c"},
            {"id":"crosslane","from":"a","to":"d"},
            {"id":"override-default","from":"a","to":"e","variant":"default"},
            {"id":"override-emphasis","from":"b","to":"f","variant":"emphasis"},
            {"id":"override-security","from":"c","to":"d","variant":"security"},
            {"id":"override-dashed","from":"d","to":"b","variant":"dashed"}
        ]
    })
}

fn layout(spec: &Value, pins: bool) -> GeometryDocument {
    let source = spec.to_string();
    let mut request = json!({"specJson":source});
    if pins {
        request["pinSet"] = json!({
            "sourceSpecSha256": validate_json(&source).receipt.input_spec_sha256,
            "pins": [
                {"targetId":"a","targetKind":"node","position":{"x":700*64,"y":300*64}},
                {"targetId":"b","targetKind":"node","position":{"x":100*64,"y":160*64}},
                {"targetId":"c","targetKind":"node","position":{"x":520*64,"y":360*64}},
                {"targetId":"d","targetKind":"node","position":{"x":300*64,"y":480*64}},
                {"targetId":"e","targetKind":"node","position":{"x":550*64,"y":100*64}},
                {"targetId":"f","targetKind":"node","position":{"x":800*64,"y":200*64}}
            ]
        });
    }
    layout_json(&request.to_string())
        .geometry
        .expect("valid source retains lifecycle geometry")
}

fn expected(version: u32) -> [(&'static str, &'static str); 8] {
    [
        ("forward", if version == 2 { "emphasis" } else { "default" }),
        ("backward", "default"),
        ("equal", "default"),
        ("crosslane", "default"),
        ("override-default", "default"),
        ("override-emphasis", "emphasis"),
        ("override-security", "security"),
        ("override-dashed", "dashed"),
    ]
}

fn assert_variants_and_gate(
    version: u32,
    pins: bool,
) -> (Value, GeometryDocument, SvgOptions, String) {
    let source = spec(version);
    let geometry = layout(&source, pins);
    let a = geometry.nodes.iter().find(|node| node.id == "a").unwrap();
    let b = geometry.nodes.iter().find(|node| node.id == "b").unwrap();
    let c = geometry.nodes.iter().find(|node| node.id == "c").unwrap();
    let d = geometry.nodes.iter().find(|node| node.id == "d").unwrap();
    let e = geometry.nodes.iter().find(|node| node.id == "e").unwrap();
    let f = geometry.nodes.iter().find(|node| node.id == "f").unwrap();
    assert_eq!(a.phase_order, Some(0));
    assert_eq!(b.phase_order, Some(2));
    assert_eq!(c.phase_order, Some(0));
    assert_eq!(
        d.phase_order, None,
        "non-main state has no main-column ordinal"
    );
    assert_eq!(e.phase_order, Some(3));
    assert_eq!(f.phase_order, Some(4));
    assert_eq!(
        a.bounds.x > b.bounds.x,
        pins,
        "screen order follows pins only"
    );

    for (id, variant) in expected(version) {
        let route = geometry
            .routes
            .iter()
            .find(|route| route.id.as_deref() == Some(id))
            .unwrap_or_else(|| panic!("missing transition {id}"));
        assert_eq!(route.variant.as_deref(), Some(variant), "transition {id}");
    }

    let options = SvgOptions::from_spec(&source, SvgTheme::Light).unwrap();
    let report = render_svg(&geometry, &options);
    assert!(report.ok, "{:?}", report.diagnostics);
    let svg = report.svg.expect("successful render has an SVG");
    assert!(
        check_svg_artifact(&svg, &geometry, &options).is_empty(),
        "reference gate accepts effective variants"
    );
    let document = roxmltree::Document::parse(&svg).unwrap();
    for (id, variant) in expected(version) {
        let route = document
            .descendants()
            .find(|node| {
                node.attribute("data-kind") == Some("route")
                    && node.attribute("data-source-id") == Some(format!("id:{id}").as_str())
            })
            .unwrap_or_else(|| panic!("missing rendered transition {id}"));
        assert_eq!(route.attribute("data-route-variant"), Some(variant));
    }
    (source, geometry, options, svg)
}

#[test]
fn implicit_and_explicit_lifecycle_variants_match_source_with_and_without_pins() {
    for version in [1, 2] {
        for pins in [false, true] {
            let _ = assert_variants_and_gate(version, pins);
        }
    }
}

#[test]
fn v2_forward_route_variant_tampering_fails_even_when_writer_uses_tampered_value() {
    let (_, mut geometry, options, _) = assert_variants_and_gate(2, true);
    let route = geometry
        .routes
        .iter_mut()
        .find(|route| route.id.as_deref() == Some("forward"))
        .unwrap();
    route.variant = Some("default".into());
    let rendered = render_svg(&geometry, &options);
    assert!(
        !rendered.ok,
        "semantic gate must reject tampered source projection"
    );
    let svg = rendered
        .svg
        .expect("writer preserves the inspected artifact");
    assert!(
        !check_svg_artifact(&svg, &geometry, &options).is_empty(),
        "source semantics still require implicit emphasis"
    );
}

#[test]
fn removing_explicit_override_from_semantic_metadata_fails_closed() {
    let (_, geometry, options, svg) = assert_variants_and_gate(2, true);
    let mut changed_options = options.clone();
    changed_options
        .semantics
        .as_mut()
        .unwrap()
        .lifecycle_variants
        .insert("override-security".into(), None);
    assert!(
        !check_svg_artifact(&svg, &geometry, &changed_options).is_empty(),
        "removing explicit source override must change the independent expectation"
    );
}
