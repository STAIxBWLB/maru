#![cfg(feature = "render-outline")]
//! Font-independent SVG output (`maru#552`): outlined labels carry the same
//! positions and accessibility text as the positioned text runs, and never
//! reference a font family that has to resolve at view time.
use maru_diagram_engine::{
    layout::layout_json,
    render::{render_svg, SvgOptions, SvgTextMode, SvgTheme},
};
use serde_json::{json, Value};

fn spec_with_mixed_label() -> Value {
    let mut spec: Value =
        serde_json::from_str(include_str!("../testdata/valid-architecture.json")).unwrap();
    spec["components"][0]["label"] = json!("주문 처리 Order flow");
    spec
}

fn options(spec: &Value, text_mode: SvgTextMode) -> SvgOptions {
    SvgOptions {
        semantics: Some(
            maru_diagram_engine::render::SemanticContext::from_spec(spec)
                .expect("fixture carries valid semantics"),
        ),
        theme: SvgTheme::Light,
        title: "주문 처리 Order flow".into(),
        description: "Font-independent output fixture".into(),
        text_mode,
    }
}

#[test]
fn outlined_labels_keep_accessibility_and_reference_no_font() {
    let spec = spec_with_mixed_label();
    let layout = layout_json(&json!({"specJson": spec.to_string()}).to_string());
    let geometry = layout.geometry.expect("fixture retains geometry");
    let report = render_svg(&geometry, &options(&spec, SvgTextMode::Outlines));
    assert!(report.ok, "{:?}", report.diagnostics);
    let svg = report.svg.expect("successful outline render has bytes");

    assert!(
        svg.contains("data-render=\"outline\""),
        "outline mode marks its label container"
    );
    assert!(
        !svg.contains("<text "),
        "an outlined artifact must not carry text runs a fallback font would draw"
    );
    assert!(
        svg.contains("aria-label=\"주문 처리 Order flow\""),
        "the label text stays available to assistive technology"
    );

    let parsed = roxmltree::Document::parse(&svg).expect("outlined SVG is well-formed");
    let glyphs: Vec<_> = parsed
        .descendants()
        .filter(|node| node.attribute("data-kind") == Some("glyph"))
        .collect();
    assert!(!glyphs.is_empty(), "the fixture draws visible glyphs");
    for glyph in glyphs {
        assert_eq!(
            glyph.tag_name().name(),
            "path",
            "a glyph is drawn as a path"
        );
        assert!(
            glyph.attribute("d").is_some(),
            "every glyph path carries path data, even when it draws nothing"
        );
        assert!(
            glyph
                .attribute("transform")
                .is_some_and(|value| value.starts_with("translate(")),
            "every glyph path is positioned by its measured origin"
        );
    }
    assert_eq!(
        Some(svg.clone()),
        render_svg(&geometry, &options(&spec, SvgTextMode::Outlines)).svg,
        "outline output is deterministic for the same geometry"
    );
}

#[test]
fn outlined_glyphs_sit_where_the_text_run_placed_them() {
    let spec = spec_with_mixed_label();
    let layout = layout_json(&json!({"specJson": spec.to_string()}).to_string());
    let geometry = layout.geometry.expect("fixture retains geometry");
    let text = render_svg(&geometry, &options(&spec, SvgTextMode::Text));
    let outlined = render_svg(&geometry, &options(&spec, SvgTextMode::Outlines));
    assert!(text.ok, "{:?}", text.diagnostics);
    assert!(outlined.ok, "{:?}", outlined.diagnostics);
    let text_svg = text.svg.expect("text mode has bytes");
    let outlined_svg = outlined.svg.expect("outline mode has bytes");

    let text_doc = roxmltree::Document::parse(&text_svg).expect("text SVG is well-formed");
    let outline_doc =
        roxmltree::Document::parse(&outlined_svg).expect("outlined SVG is well-formed");
    let run_origins: Vec<(String, String)> = text_doc
        .descendants()
        .filter(|node| node.attribute("data-kind") == Some("glyph"))
        .map(|node| {
            (
                node.attribute("x").unwrap_or_default().to_owned(),
                node.attribute("y").unwrap_or_default().to_owned(),
            )
        })
        .collect();
    let path_origins: Vec<(String, String)> = outline_doc
        .descendants()
        .filter(|node| node.attribute("data-kind") == Some("glyph"))
        .map(|node| {
            let transform = node.attribute("transform").unwrap_or_default();
            let inner = transform
                .strip_prefix("translate(")
                .and_then(|rest| rest.split(')').next())
                .unwrap_or_default();
            let mut parts = inner.split(' ');
            (
                parts.next().unwrap_or_default().to_owned(),
                parts.next().unwrap_or_default().to_owned(),
            )
        })
        .collect();
    assert_eq!(
        run_origins.len(),
        path_origins.len(),
        "both modes draw the same glyphs"
    );
    assert_eq!(
        run_origins, path_origins,
        "an outlined glyph keeps the fixed-point origin E2 measured"
    );
}

#[test]
fn the_native_svg_entry_defaults_to_outlines_and_the_shared_entry_keeps_text() {
    use maru_diagram_engine::render::{
        render_artifact_json, render_svg_artifact_json, SvgTextMode,
    };
    let spec = spec_with_mixed_label();
    let request =
        json!({"specJson": spec.to_string(), "format": "svg", "theme": "light"}).to_string();

    let native = render_svg_artifact_json(&request);
    assert!(native.ok, "{:?}", native.diagnostics);
    assert_eq!(native.text_mode, Some(SvgTextMode::Outlines));
    assert!(
        native
            .svg
            .expect("native export has bytes")
            .contains("data-render=\"outline\""),
        "a native SVG export carries outlined labels by default"
    );

    let shared = render_artifact_json(&request);
    assert!(shared.ok, "{:?}", shared.diagnostics);
    assert_eq!(shared.text_mode, Some(SvgTextMode::Text));
    assert!(
        !shared
            .svg
            .expect("shared entry has bytes")
            .contains("data-render"),
        "the shared entry keeps the browser text runs"
    );

    let explicit =
        json!({"specJson": spec.to_string(), "format": "svg", "textMode": "text"}).to_string();
    assert_eq!(
        render_svg_artifact_json(&explicit).text_mode,
        Some(SvgTextMode::Text),
        "a caller can still ask the native export for text runs"
    );
}
