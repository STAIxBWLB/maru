#![cfg(feature = "render-svg")]
use maru_diagram_engine::{
    layout::layout_json,
    render::{render_svg, SvgOptions, SvgTheme},
};
use serde_json::{json, Value};
#[test]
fn semantic_label_colors_follow_namespaced_roles_not_colliding_source_ids() {
    for route_id in ["a", "document"] {
        let mut spec: Value =
            serde_json::from_str(include_str!("../testdata/valid-architecture.json")).unwrap();
        spec["connections"][0]["id"] = json!(route_id);
        spec["connections"][0]["variant"] = json!("security");
        let g = layout_json(&json!({"specJson":spec.to_string()}).to_string())
            .geometry
            .unwrap();
        for (theme, text, security) in [
            (SvgTheme::Light, "#111827", "#e11d48"),
            (SvgTheme::Dark, "#ffffff", "#fb7185"),
        ] {
            let result = render_svg(&g, &SvgOptions::from_spec(&spec, theme).unwrap());
            assert!(result.ok, "{:?}", result.diagnostics);
            let svg = result.svg.unwrap();
            let doc = roxmltree::Document::parse(&svg).unwrap();
            for (key, expected) in [
                ("id:title".to_owned(), text),
                ("id:node:a:label".to_owned(), text),
                (format!("id:edge:{route_id}:label"), security),
            ] {
                let group = doc
                    .descendants()
                    .find(|node| {
                        node.attribute("data-kind") == Some("label")
                            && node.attribute("data-source-id") == Some(key.as_str())
                    })
                    .unwrap();
                let color = group
                    .descendants()
                    .find(|node| node.attribute("data-kind") == Some("glyph"))
                    .unwrap()
                    .attribute("fill");
                assert_eq!(color, Some(expected));
            }
        }
    }
}

#[test]
fn node_tag_uses_its_kind_token_in_both_themes() {
    let mut spec: Value =
        serde_json::from_str(include_str!("../testdata/valid-architecture.json")).unwrap();
    spec["components"][0]["tag"] = json!("Public");
    let g = layout_json(&json!({"specJson":spec.to_string()}).to_string())
        .geometry
        .unwrap();
    for (theme, stroke) in [(SvgTheme::Light, "#0891b2"), (SvgTheme::Dark, "#22d3ee")] {
        let options = SvgOptions::from_spec(&spec, theme).unwrap();
        let rendered = render_svg(&g, &options);
        assert!(rendered.ok, "{:?}", rendered.diagnostics);
        let svg = rendered.svg.unwrap();
        let doc = roxmltree::Document::parse(&svg).unwrap();
        let tag = doc
            .descendants()
            .find(|node| {
                node.attribute("data-kind") == Some("label")
                    && node.attribute("data-source-id") == Some("id:node:a:tag")
            })
            .unwrap();
        assert_eq!(
            tag.descendants()
                .find(|node| node.attribute("data-kind") == Some("glyph"))
                .unwrap()
                .attribute("fill"),
            Some(stroke)
        );
    }
}
