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

#[test]
fn missing_route_label_semantics_fails_closed() {
    let spec: Value =
        serde_json::from_str(include_str!("../testdata/valid-architecture.json")).unwrap();
    let g = layout_json(&json!({"specJson":spec.to_string()}).to_string())
        .geometry
        .unwrap();
    let mut options = SvgOptions::from_spec(&spec, SvgTheme::Light).unwrap();
    options.semantics.as_mut().unwrap().route_labels.clear();
    let result = render_svg(&g, &options);
    assert!(!result.ok);
    assert!(result
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == "document/svg-label-source"));
}

#[test]
fn authored_legend_ids_are_not_legend_labels_even_when_legend_is_hidden() {
    for mode in ["hidden", "all"] {
        let mut spec: Value =
            serde_json::from_str(include_str!("../testdata/valid-architecture.json")).unwrap();
        spec["components"][0]["id"] = json!("legend");
        spec["connections"][0]["from"] = json!("legend");
        spec["connections"][0]["id"] = json!("legend");
        spec["meta"]["legend"] = json!({"mode":mode});
        let report = layout_json(&json!({"specJson":spec.to_string()}).to_string());
        assert!(report.ok, "{:?}", report.diagnostics);
        let g = report.geometry.unwrap();
        for theme in [SvgTheme::Light, SvgTheme::Dark] {
            let result = render_svg(&g, &SvgOptions::from_spec(&spec, theme).unwrap());
            assert!(result.ok, "{:?}", result.diagnostics);
        }
        if mode == "hidden" {
            assert!(g.legend.content_bounds.is_none());
        } else {
            assert!(g.legend.content_bounds.unwrap().y > g.nodes[0].bounds.y);
        }
    }
}
#[test]
fn nested_internal_frame_ids_preserve_roles_without_widening_source_ids() {
    fn nested(id: &str) -> String {
        for prefix in ["lane:", "phase:", "group:"] {
            if let Some(rest) = id.strip_prefix(prefix) {
                return format!("{prefix}{prefix}{rest}");
            }
        }
        id.to_owned()
    }
    let mut invalid: Value =
        serde_json::from_str(include_str!("../testdata/valid-workflow.json")).unwrap();
    invalid["lanes"][0]["id"] = json!("lane:main");
    assert!(!maru_diagram_engine::validate_json(&invalid.to_string()).ok);
    assert!(
        layout_json(&json!({"specJson":invalid.to_string()}).to_string())
            .geometry
            .is_none()
    );
    let mut spec: Value =
        serde_json::from_str(include_str!("../testdata/valid-workflow.json")).unwrap();
    spec["lanes"][0]["variant"] = json!("exception");
    for node in spec["nodes"].as_array_mut().unwrap() {
        node["width"] = json!(64);
    }
    spec["phases"] = json!([{"id":"p","label":"Phase","fromCol":0,"toCol":4,"variant":"security"}]);
    spec["groups"] = json!([{"id":"g","label":"Group","lane":"main","fromCol":2,"toCol":2,"variant":"security"}]);
    let report = layout_json(&json!({"specJson":spec.to_string()}).to_string());
    assert!(report.ok, "{:?}", report.diagnostics);
    let mut g = report.geometry.unwrap();
    let ids: std::collections::BTreeMap<_, _> = g
        .containers
        .iter()
        .map(|container| (container.id.clone(), nested(&container.id)))
        .collect();
    for container in &mut g.containers {
        container.id = ids[&container.id].clone();
    }
    for label in &mut g.labels {
        if let Some(target) = ids.get(&label.target_id) {
            label.target_id = target.clone();
            label.id = Some(format!("container:{target}:label"));
        }
    }
    for (theme, color) in [(SvgTheme::Light, "#e11d48"), (SvgTheme::Dark, "#fb7185")] {
        let mut options = SvgOptions::from_spec(&spec, theme).unwrap();
        let context = options.semantics.as_mut().unwrap();
        context.frame_variants = std::mem::take(&mut context.frame_variants)
            .into_iter()
            .map(|(key, value)| (nested(&key), value))
            .collect();
        let result = render_svg(&g, &options);
        assert!(result.ok, "{:?}", result.diagnostics);
        let svg = result.svg.unwrap();
        let doc = roxmltree::Document::parse(&svg).unwrap();
        for key in ["lane:lane:main", "phase:phase:p", "group:group:g"] {
            let label = doc
                .descendants()
                .find(|node| {
                    node.attribute("data-kind") == Some("label")
                        && node.attribute("data-target-id") == Some(key)
                })
                .unwrap();
            assert_eq!(
                label
                    .descendants()
                    .find(|node| node.attribute("data-kind") == Some("glyph"))
                    .unwrap()
                    .attribute("fill"),
                Some(color)
            );
        }
    }
}
