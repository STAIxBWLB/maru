#![cfg(feature = "render-svg")]

use maru_diagram_engine::{
    layout::layout_json,
    render::{check_svg_artifact, render_svg, semantics::RouteLabelSemantic, SvgOptions, SvgTheme},
};
use serde_json::{json, Value};

fn fixture(family: &str) -> Value {
    let source = match family {
        "architecture" => include_str!("../testdata/valid-architecture.json"),
        "workflow" => include_str!("../testdata/valid-workflow.json"),
        "sequence" => include_str!("../testdata/valid-sequence.json"),
        "dataflow" => include_str!("../testdata/valid-dataflow.json"),
        "lifecycle" => include_str!("../testdata/valid-lifecycle.json"),
        _ => unreachable!("known diagram family"),
    };
    serde_json::from_str(source).unwrap()
}

fn render(
    spec: &Value,
    theme: SvgTheme,
) -> (
    String,
    maru_diagram_engine::geometry::GeometryDocument,
    SvgOptions,
) {
    let report = layout_json(&json!({"specJson": spec.to_string()}).to_string());
    assert!(report.ok, "fixture layout failed: {:?}", report.diagnostics);
    let geometry = report.geometry.expect("successful layout has geometry");
    let mut options = SvgOptions::from_spec(spec, theme).unwrap();
    options.theme = theme;
    let rendered = render_svg(&geometry, &options);
    assert!(
        rendered.ok,
        "fixture render failed: {:?}",
        rendered.diagnostics
    );
    (
        rendered.svg.expect("successful render has SVG"),
        geometry,
        options,
    )
}

fn glyphs_for_target(svg: &str, target: &str) -> Vec<(String, String)> {
    let document = roxmltree::Document::parse(svg).expect("SVG is valid XML");
    let label = document
        .descendants()
        .find(|node| {
            node.attribute("data-kind") == Some("label")
                && node.attribute("data-target-id") == Some(target)
        })
        .expect("target label exists");
    let text = label
        .descendants()
        .find(|node| node.attribute("data-kind") == Some("label-text"))
        .expect("label has a text node");
    text.children()
        .filter(|node| node.is_element() && node.attribute("data-kind") == Some("glyph"))
        .map(|node| {
            (
                node.attribute("y").unwrap().to_owned(),
                node.attribute("fill")
                    .expect("glyph has accent fill")
                    .to_owned(),
            )
        })
        .collect()
}

fn first_glyph_fill_replaced(svg: &str, target: &str) -> String {
    let target_marker = format!("data-target-id=\"{target}\"");
    let target_offset = svg.find(&target_marker).expect("target label exists");
    let glyph_offset = svg[target_offset..]
        .find("<tspan data-kind=\"glyph\"")
        .expect("target has visible glyphs")
        + target_offset;
    let tag_end = svg[glyph_offset..].find('>').expect("glyph span opens") + glyph_offset;
    let tag = &svg[glyph_offset..tag_end];
    let fill_start = tag.find("fill=\"").expect("glyph has fill") + "fill=\"".len();
    let fill_end = tag[fill_start..].find('"').expect("fill is quoted") + fill_start;
    format!(
        "{}#ff00ff{}",
        &svg[..glyph_offset + fill_start],
        &svg[glyph_offset + fill_end..]
    )
}

fn muted(theme: SvgTheme) -> &'static str {
    match theme {
        SvgTheme::Light => "#5b6474",
        SvgTheme::Dark => "#94a3b8",
    }
}

fn route_accent(theme: SvgTheme, variant: &str, family: &str) -> &'static str {
    match variant {
        "security" => match theme {
            SvgTheme::Light => "#e11d48",
            SvgTheme::Dark => "#fb7185",
        },
        "emphasis" => match theme {
            SvgTheme::Light => "#059669",
            SvgTheme::Dark => "#34d399",
        },
        "dashed" => match theme {
            SvgTheme::Light => "#7c3aed",
            SvgTheme::Dark => "#a78bfa",
        },
        "return" | "default" if family == "sequence" => muted(theme),
        _ => match theme {
            SvgTheme::Light => "#94a3b8",
            SvgTheme::Dark => "#64748b",
        },
    }
}

fn assert_color_and_mutation_rejected(
    svg: &str,
    geometry: &maru_diagram_engine::geometry::GeometryDocument,
    options: &SvgOptions,
    target: &str,
    expected: &str,
) {
    let glyphs = glyphs_for_target(svg, target);
    assert!(!glyphs.is_empty());
    assert!(glyphs.iter().all(|(_, fill)| fill == expected));
    let changed = first_glyph_fill_replaced(svg, target);
    assert!(!check_svg_artifact(&changed, geometry, options).is_empty());
}

#[test]
fn route_label_primary_lines_use_variant_accents_and_keep_details_muted() {
    for theme in [SvgTheme::Light, SvgTheme::Dark] {
        for variant in ["security", "emphasis", "dashed", "default", "return"] {
            let mut source = fixture("sequence");
            source["messages"][0]["id"] = json!("m1");
            source["messages"][0]["label"] = json!("Primary");
            source["messages"][0]["note"] = json!("Details");
            source["messages"][0]["variant"] = json!(variant);
            let (svg, geometry, options) = render(&source, theme);
            let glyphs = glyphs_for_target(&svg, "m1");
            let mut line_colors = Vec::<(String, String)>::new();
            for (baseline, fill) in &glyphs {
                if !line_colors.iter().any(|(line, _)| line == baseline) {
                    line_colors.push((baseline.clone(), fill.clone()));
                }
            }
            assert_eq!(line_colors.len(), 2, "source note is a separate line");
            assert_eq!(line_colors[0].1, route_accent(theme, variant, "sequence"));
            assert_eq!(line_colors[1].1, muted(theme));
            assert!(check_svg_artifact(&svg, &geometry, &options).is_empty());
            if variant == "security" {
                let changed = first_glyph_fill_replaced(&svg, "m1");
                assert!(!check_svg_artifact(&changed, &geometry, &options).is_empty());
            }
        }
    }
}

#[test]
fn route_line_mapping_counts_source_scalars_across_leading_and_empty_lines() {
    for theme in [SvgTheme::Light, SvgTheme::Dark] {
        let mut source = fixture("sequence");
        source["messages"][0]["id"] = json!("m-lines");
        source["messages"][0]["label"] = json!("\nPrimary\n\n");
        source["messages"][0]["note"] = json!("Details");
        source["messages"][0]["variant"] = json!("security");
        let (svg, geometry, options) = render(&source, theme);
        let glyphs = glyphs_for_target(&svg, "m-lines");
        let mut line_colors = Vec::<(String, String)>::new();
        for (baseline, fill) in &glyphs {
            if !line_colors.iter().any(|(line, _)| line == baseline) {
                line_colors.push((baseline.clone(), fill.clone()));
            }
        }
        assert_eq!(line_colors.len(), 2, "empty source lines have no glyphs");
        assert_eq!(
            line_colors[0].1,
            route_accent(theme, "security", "sequence")
        );
        assert_eq!(line_colors[1].1, muted(theme));
        assert!(check_svg_artifact(&svg, &geometry, &options).is_empty());

        let mut note_only_semantics = options.clone();
        note_only_semantics
            .semantics
            .as_mut()
            .unwrap()
            .route_labels
            .insert("m-lines".into(), RouteLabelSemantic { primary_lines: 0 });
        let rendered = render_svg(&geometry, &note_only_semantics);
        assert!(
            rendered.ok,
            "note-only projection failed: {:?}",
            rendered.diagnostics
        );
        let note_only = rendered.svg.expect("successful render has SVG");
        assert!(glyphs_for_target(&note_only, "m-lines")
            .iter()
            .all(|(_, fill)| fill == muted(theme)));
        assert!(check_svg_artifact(&note_only, &geometry, &note_only_semantics).is_empty());
    }
}

#[test]
fn route_labels_use_other_family_default_arrow_and_capture_primary_line_counts() {
    let cases = [
        (
            "architecture",
            "connections",
            "connection:0",
            "label",
            "First\nSecond",
            2,
        ),
        ("workflow", "edges", "edge:0", "label", "First\nSecond", 2),
        ("sequence", "messages", "message:0", "label", "First", 1),
        ("dataflow", "flows", "flow:0", "label", "First", 1),
        (
            "lifecycle",
            "transitions",
            "transition:0",
            "label",
            "First",
            1,
        ),
    ];
    for (family, collection, route_id, label_key, label, expected_lines) in cases {
        let mut source = fixture(family);
        source[collection][0][label_key] = json!(label);
        let options = SvgOptions::from_spec(&source, SvgTheme::Light).unwrap();
        assert_eq!(
            options.semantics.unwrap().route_labels[route_id].primary_lines,
            expected_lines,
            "{family} route label line count"
        );
    }

    for theme in [SvgTheme::Light, SvgTheme::Dark] {
        let mut source = fixture("architecture");
        source["connections"][0]["variant"] = json!("default");
        source["connections"][0]["label"] = json!("Call");
        let (svg, geometry, options) = render(&source, theme);
        assert_color_and_mutation_rejected(
            &svg,
            &geometry,
            &options,
            "connection:0",
            route_accent(theme, "default", "architecture"),
        );

        let mut note_only = fixture("lifecycle");
        note_only["transitions"][0]["label"] = Value::Null;
        note_only["transitions"][0]["note"] = json!("Details only");
        let options = SvgOptions::from_spec(&note_only, theme).unwrap();
        assert_eq!(
            options.semantics.unwrap().route_labels["transition:0"].primary_lines,
            0
        );
    }
}

#[test]
fn workflow_frame_captions_and_architecture_boundary_captions_get_semantic_accents() {
    for theme in [SvgTheme::Light, SvgTheme::Dark] {
        let mut workflow = fixture("workflow");
        workflow["lanes"][0]["variant"] = json!("exception");
        for node in workflow["nodes"].as_array_mut().unwrap() {
            node["width"] = json!(64);
        }
        workflow["phases"] = json!([{
            "id":"p", "label":"Phase", "fromCol":0, "toCol":4, "variant":"security"
        }]);
        workflow["groups"] = json!([
            {"id":"em", "lane":"main", "label":"Emphasis", "fromCol":2, "toCol":2, "variant":"emphasis"},
            {"id":"ds", "lane":"main", "label":"Dashed", "fromCol":4, "toCol":4, "variant":"dashed"}
        ]);
        let (svg, geometry, options) = render(&workflow, theme);
        let (security, backend, messagebus) = match theme {
            SvgTheme::Light => ("#e11d48", "#059669", "#ea580c"),
            SvgTheme::Dark => ("#fb7185", "#34d399", "#fb923c"),
        };
        for (target, expected) in [
            ("lane:main", security),
            ("phase:p", security),
            ("group:em", backend),
            ("group:ds", messagebus),
        ] {
            assert_color_and_mutation_rejected(&svg, &geometry, &options, target, expected);
        }

        let mut architecture = fixture("architecture");
        architecture["boundaries"] = json!([
            {"kind":"region", "label":"Region", "wraps":["a"]},
            {"kind":"security-group", "label":"Security", "wraps":["b"]}
        ]);
        let (svg, geometry, options) = render(&architecture, theme);
        let (cloud, security) = match theme {
            SvgTheme::Light => ("#d97706", "#e11d48"),
            SvgTheme::Dark => ("#fbbf24", "#fb7185"),
        };
        assert_color_and_mutation_rejected(&svg, &geometry, &options, "boundary:0", cloud);
        assert_color_and_mutation_rejected(&svg, &geometry, &options, "boundary:1", security);
    }
}

#[test]
fn source_primary_label_presence_preserves_nonempty_whitespace() {
    for family in [
        "architecture",
        "workflow",
        "sequence",
        "dataflow",
        "lifecycle",
    ] {
        let mut spec = fixture(family);
        let (collection, prefix) = match family {
            "architecture" => ("connections", "connection"),
            "workflow" => ("edges", "edge"),
            "sequence" => ("messages", "message"),
            "dataflow" => ("flows", "flow"),
            _ => ("transitions", "transition"),
        };
        spec[collection][0]["label"] = json!(" \n ");
        let options = SvgOptions::from_spec(&spec, SvgTheme::Light).unwrap();
        assert_eq!(
            options.semantics.unwrap().route_labels[&format!("{prefix}:0")].primary_lines,
            2
        );
    }
}
