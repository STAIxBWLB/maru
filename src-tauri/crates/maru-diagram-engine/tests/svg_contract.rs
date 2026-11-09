#![cfg(feature = "render-svg")]
use maru_diagram_engine::{
    layout::layout_json,
    render::{check_svg_artifact, render_svg, SvgOptions, SvgTheme},
};
use serde_json::Value;
#[test]
fn cjk_xml_multiline_replacement_and_ignorable_glyphs_preserve_metric_positions() {
    let mut spec: Value =
        serde_json::from_str(include_str!("../testdata/valid-architecture.json")).unwrap();
    spec["components"][0]["label"] = serde_json::json!("한글 & <>\n🛸‍");
    let layout = layout_json(&serde_json::json!({"specJson":spec.to_string()}).to_string());
    let geometry = layout
        .geometry
        .expect("fixture must retain placed geometry");
    assert!(geometry
        .labels
        .iter()
        .flat_map(|l| &l.glyphs)
        .any(|g| g.replaced));
    assert!(geometry
        .labels
        .iter()
        .flat_map(|l| &l.glyphs)
        .any(|g| g.ignored));
    let mut outputs = Vec::new();
    for theme in [SvgTheme::Light, SvgTheme::Dark] {
        let options = SvgOptions {
            semantics: Some(
                maru_diagram_engine::render::SemanticContext::from_spec(&spec).unwrap(),
            ),
            theme,
            title: "검증 & <제목>".into(),
            description: "CJK 줄바꿈·대체 글리프".into(),
        };
        let report = render_svg(&geometry, &options);
        assert!(report.ok, "{:?}", report.diagnostics);
        let svg = report.svg.unwrap();
        assert_eq!(Some(svg.clone()), render_svg(&geometry, &options).svg);
        let parsed = roxmltree::Document::parse(&svg).unwrap();
        let labels: Vec<_> = parsed
            .descendants()
            .filter(|n| n.attribute("data-kind") == Some("label"))
            .collect();
        assert!(labels
            .iter()
            .any(|n| n.attribute("aria-label") == Some("한글 & <>\n🛸‍")));
        let replacement = parsed
            .descendants()
            .find(|n| n.attribute("data-kind") == Some("notdef"))
            .unwrap();
        assert_eq!(replacement.tag_name().name(), "path");
        assert!(!parsed
            .descendants()
            .filter(|n| n.attribute("data-kind") == Some("glyph"))
            .any(|n| n.text().is_some_and(|s| s.contains('🛸') || s.contains('‍'))));
        let path = replacement.attribute("d").unwrap();
        let corrupt = svg.replacen(path, "M 0 0 L 1 1", 1);
        assert!(!check_svg_artifact(&corrupt, &geometry, &options).is_empty());
        outputs.push(svg);
    }
    assert_ne!(outputs[0], outputs[1]);
}
#[test]
fn namespaced_ids_and_captions_survive_node_edge_identity_collisions() {
    let mut spec: Value =
        serde_json::from_str(include_str!("../testdata/valid-architecture.json")).unwrap();
    spec["connections"][0]["id"] = serde_json::json!("a");
    spec["connections"][0]["label"] = serde_json::json!("Edge caption");
    let layout = layout_json(&serde_json::json!({"specJson":spec.to_string()}).to_string());
    let options = SvgOptions {
        semantics: Some(maru_diagram_engine::render::SemanticContext::from_spec(&spec).unwrap()),
        theme: SvgTheme::Light,
        title: "Collision".into(),
        description: "Node and edge have the same source id".into(),
    };
    let result = render_svg(&layout.geometry.unwrap(), &options);
    assert!(result.ok, "{:?}", result.diagnostics);
    let svg = result.svg.unwrap();
    let parsed = roxmltree::Document::parse(&svg).unwrap();
    let node = parsed
        .descendants()
        .find(|n| {
            n.attribute("data-kind") == Some("node") && n.attribute("data-source-id") == Some("a")
        })
        .unwrap();
    assert!(!node
        .attribute("aria-label")
        .unwrap()
        .contains("Edge caption"));
    let ids: Vec<_> = parsed
        .descendants()
        .filter_map(|n| n.attribute("id"))
        .collect();
    let unique: std::collections::BTreeSet<_> = ids.iter().copied().collect();
    assert_eq!(ids.len(), unique.len());
}

#[test]
fn every_component_kind_and_legend_swatch_share_the_theme_token() {
    for theme in [SvgTheme::Light, SvgTheme::Dark] {
        let mut spec: Value =
            serde_json::from_str(include_str!("../testdata/valid-architecture.json")).unwrap();
        let kinds = [
            "frontend",
            "backend",
            "database",
            "cloud",
            "security",
            "messagebus",
            "external",
        ];
        spec["components"]=serde_json::json!(kinds.iter().enumerate().map(|(index,kind)|serde_json::json!({"id":format!("n{index}"),"type":kind,"label":kind,"row":index/4,"col":index%4})).collect::<Vec<_>>());
        spec["connections"] = serde_json::json!([]);
        let g = layout_json(&serde_json::json!({"specJson":spec.to_string()}).to_string())
            .geometry
            .unwrap();
        let o = SvgOptions::from_spec(&spec, theme).unwrap();
        let report = render_svg(&g, &o);
        assert!(report.ok, "{:?}", report.diagnostics);
        let svg = report.svg.unwrap();
        let parsed = roxmltree::Document::parse(&svg).unwrap();
        let fill = |id: &str| {
            let group = parsed
                .descendants()
                .find(|n| {
                    n.attribute("data-kind") == Some("node")
                        && n.attribute("data-source-id") == Some(id)
                })
                .unwrap();
            group
                .children()
                .find(|n| n.attribute("data-kind") == Some("node-box"))
                .unwrap()
                .attribute("fill")
                .unwrap()
        };
        assert_ne!(fill("n0"), fill("n1"));
        for (index, kind) in kinds.iter().enumerate() {
            let id = format!("n{index}");
            let swatch = parsed
                .descendants()
                .find(|n| {
                    n.attribute("data-kind") == Some("legend-node-swatch")
                        && n.attribute("data-target-id") == Some(kind)
                })
                .unwrap();
            assert_eq!(fill(&id), swatch.attribute("fill").unwrap());
        }
        let wrong = svg.replacen(fill("n0"), fill("n1"), 1);
        assert!(
            !check_svg_artifact(&wrong, &g, &o).is_empty(),
            "node fill corruption must fail artifact gate"
        );
    }
}
