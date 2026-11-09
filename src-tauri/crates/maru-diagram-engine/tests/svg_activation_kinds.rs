#![cfg(feature = "render-svg")]

use maru_diagram_engine::{
    layout::layout_json,
    render::{check_svg_artifact, render_svg, semantics::ActivationSemantic, SvgOptions, SvgTheme},
};
use serde_json::{json, Value};

fn spec(activation_type: Option<&str>) -> Value {
    let mut spec: Value =
        serde_json::from_str(include_str!("../testdata/valid-sequence.json")).unwrap();
    let mut activation = json!({"participant":"a", "from":180, "to":280});
    if let Some(kind) = activation_type {
        activation["type"] = json!(kind);
    }
    spec["activations"] = json!([activation]);
    spec
}

fn expected_paint(theme: SvgTheme, kind: &str) -> (&'static str, &'static str) {
    match (theme, kind) {
        (SvgTheme::Light, "frontend") => ("rgba(34,211,238,0.15)", "#0891b2"),
        (SvgTheme::Light, "database") => ("rgba(167,139,250,0.2)", "#7c3aed"),
        (SvgTheme::Light, "security") => ("rgba(251,113,133,0.15)", "#e11d48"),
        (SvgTheme::Light, "external") => ("rgba(148,163,184,0.18)", "#64748b"),
        (SvgTheme::Dark, "frontend") => ("rgba(8,51,68,0.4)", "#22d3ee"),
        (SvgTheme::Dark, "database") => ("rgba(76,29,149,0.4)", "#a78bfa"),
        (SvgTheme::Dark, "security") => ("rgba(136,19,55,0.4)", "#fb7185"),
        (SvgTheme::Dark, "external") => ("rgba(30,41,59,0.5)", "#94a3b8"),
        _ => unreachable!("test covers known activation component types"),
    }
}

fn assert_activation_kind(
    mut options: SvgOptions,
    geometry: &maru_diagram_engine::geometry::GeometryDocument,
    theme: SvgTheme,
    expected_kind: &str,
) {
    options.theme = theme;
    let report = render_svg(geometry, &options);
    assert!(
        report.ok,
        "activation render failed: {:?}",
        report.diagnostics
    );
    let svg = report.svg.expect("successful render has SVG");
    let document = roxmltree::Document::parse(&svg).expect("rendered SVG is valid XML");
    let activation = document
        .descendants()
        .find(|node| {
            node.attribute("data-kind") == Some("container")
                && node.attribute("data-source-id") == Some("activation:0")
        })
        .expect("activation has a container group");
    let rect = activation
        .children()
        .find(|node| node.attribute("data-kind") == Some("container-box"))
        .expect("activation has a box");
    let (fill, stroke) = expected_paint(theme, expected_kind);
    assert_eq!(rect.attribute("fill"), Some(fill), "{expected_kind} fill");
    assert_eq!(
        rect.attribute("stroke"),
        Some(stroke),
        "{expected_kind} stroke"
    );
    assert!(check_svg_artifact(&svg, geometry, &options).is_empty());
}

fn layout_and_options(
    source: &Value,
) -> (maru_diagram_engine::geometry::GeometryDocument, SvgOptions) {
    let report = layout_json(&json!({"specJson": source.to_string()}).to_string());
    assert!(report.ok, "fixture layout failed: {:?}", report.diagnostics);
    let geometry = report.geometry.expect("successful fixture has geometry");
    let options = SvgOptions::from_spec(source, SvgTheme::Light).unwrap();
    (geometry, options)
}

#[test]
fn activation_kind_uses_explicit_type_then_participant_type_then_external_in_both_themes() {
    let explicit = spec(Some("security"));
    let (geometry, options) = layout_and_options(&explicit);
    let activation = options
        .semantics
        .as_ref()
        .unwrap()
        .activations
        .get("activation:0")
        .unwrap();
    assert_eq!(activation.explicit_type.as_deref(), Some("security"));
    assert_eq!(activation.participant_type.as_deref(), Some("frontend"));
    for theme in [SvgTheme::Light, SvgTheme::Dark] {
        assert_activation_kind(options.clone(), &geometry, theme, "security");
    }

    let fallback = spec(None);
    let (geometry, options) = layout_and_options(&fallback);
    for theme in [SvgTheme::Light, SvgTheme::Dark] {
        assert_activation_kind(options.clone(), &geometry, theme, "frontend");
    }

    // Invalid source values cannot pass the sequence validator. Set them in
    // the direct semantic context to exercise the renderer's independent
    // accepted-type fallback while preserving the valid participant node kind.
    let mut options = options.clone();
    let semantic = options.semantics.as_mut().unwrap();
    semantic.activations.insert(
        "activation:0".into(),
        ActivationSemantic {
            explicit_type: Some("unknown-explicit".into()),
            participant_type: Some("frontend".into()),
        },
    );
    assert_eq!(semantic.nodes.get("a").unwrap().kind, "frontend");
    for theme in [SvgTheme::Light, SvgTheme::Dark] {
        assert_activation_kind(options.clone(), &geometry, theme, "frontend");
    }

    for unknown in [
        ActivationSemantic {
            explicit_type: Some("unknown-explicit".into()),
            participant_type: Some("unknown-participant".into()),
        },
        ActivationSemantic {
            explicit_type: None,
            participant_type: None,
        },
    ] {
        let mut direct = options.clone();
        direct
            .semantics
            .as_mut()
            .unwrap()
            .activations
            .insert("activation:0".into(), unknown);
        for theme in [SvgTheme::Light, SvgTheme::Dark] {
            assert_activation_kind(direct.clone(), &geometry, theme, "external");
        }
    }
}
