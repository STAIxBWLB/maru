#![cfg(feature = "render-svg")]

use maru_diagram_engine::{
    geometry::GeometryDocument,
    layout::layout_json,
    render::{check_svg_artifact, render_svg, SvgOptions, SvgTheme},
};
use serde_json::{json, Value};

fn retained(spec: &Value) -> GeometryDocument {
    let report = layout_json(&json!({"specJson":spec.to_string()}).to_string());
    report
        .geometry
        .expect("layout retains geometry, even for source diagnostics")
}

fn artifact(spec: &Value, geometry: &GeometryDocument) -> String {
    let options = SvgOptions::from_spec(spec, SvgTheme::Light).unwrap();
    let report = render_svg(geometry, &options);
    assert!(report.ok, "{:?}", report.diagnostics);
    report
        .svg
        .expect("semantic writer retains the artifact for gate inspection")
}

fn element<'a, 'input>(
    doc: &'a roxmltree::Document<'input>,
    kind: &str,
    target: &str,
) -> roxmltree::Node<'a, 'input> {
    doc.descendants()
        .find(|n| {
            n.attribute("data-kind") == Some(kind) && n.attribute("data-target-id") == Some(target)
        })
        .expect("expected primitive")
}

fn px(node: roxmltree::Node<'_, '_>, name: &str) -> f64 {
    node.attribute(name).unwrap().parse().unwrap()
}

#[test]
fn sequence_lifelines_match_retained_geometry_and_mutations_fail() {
    let spec: Value =
        serde_json::from_str(include_str!("../testdata/valid-sequence.json")).unwrap();
    let g = retained(&spec);
    let svg = artifact(&spec, &g);
    let doc = roxmltree::Document::parse(&svg).unwrap();
    let participant = &g.nodes[0];
    let line = element(&doc, "sequence-lifeline", &participant.id);
    let expected_x = (participant.bounds.x + participant.bounds.width / 2) as f64 / 64.0;
    let expected_y = (participant.bounds.y + participant.bounds.height) as f64 / 64.0;
    assert_eq!(px(line, "x1"), expected_x);
    assert_eq!(px(line, "y1"), expected_y);
    let corrupted = svg.replacen(
        &format!("x1=\"{}\"", line.attribute("x1").unwrap()),
        "x1=\"9999\"",
        1,
    );
    let options = SvgOptions::from_spec(&spec, SvgTheme::Light).unwrap();
    assert!(!check_svg_artifact(&corrupted, &g, &options).is_empty());
}

#[test]
fn singleton_participant_without_messages_still_gets_a_lifeline() {
    let mut spec: Value =
        serde_json::from_str(include_str!("../testdata/valid-sequence.json")).unwrap();
    let mut g = retained(&spec);
    spec["participants"] = json!([spec["participants"][0].clone()]);
    spec["messages"] = json!([]);
    spec["segments"] = json!([]);
    spec["activations"] = json!([]);
    // This source cardinality is intentionally rejected by E1. Exercise the
    // SVG projection seam with a singleton DTO without widening admission.
    assert!(
        layout_json(&json!({"specJson":spec.to_string()}).to_string())
            .geometry
            .is_none()
    );
    g.nodes.truncate(1);
    g.routes.clear();
    g.containers
        .retain(|frame| !matches!(frame.kind.as_str(), "activation" | "segment"));
    assert_eq!(g.nodes.len(), 1);
    assert!(g.routes.is_empty());
    let svg = artifact(&spec, &g);
    let doc = roxmltree::Document::parse(&svg).unwrap();
    let lifeline = element(&doc, "sequence-lifeline", &g.nodes[0].id);
    assert_eq!(
        px(lifeline, "x1"),
        (g.nodes[0].bounds.x + g.nodes[0].bounds.width / 2) as f64 / 64.0
    );
    assert_eq!(
        px(lifeline, "y1"),
        (g.nodes[0].bounds.y + g.nodes[0].bounds.height) as f64 / 64.0
    );
}

#[test]
fn lifecycle_rail_uses_authored_nonzero_endpoints_for_single_main_phase() {
    let mut spec: Value =
        serde_json::from_str(include_str!("../testdata/valid-lifecycle.json")).unwrap();
    spec["lanes"] = json!([
        {"id":"main","label":"Main"},
        {"id":"event","label":"Event"}
    ]);
    spec["states"] = json!([
        {"id":"only","type":"active","label":"Only","lane":"main","col":0},
        {"id":"other","type":"active","label":"Other","lane":"event","col":0}
    ]);
    spec["transitions"] = json!([]);
    let g = retained(&spec);
    let rail = g
        .lifecycle_rail
        .as_ref()
        .expect("V1 geometry carries the source-derived lifecycle rail");
    assert_ne!(
        rail.from, rail.to,
        "one authored main phase still spans the source rail"
    );
    assert_eq!((rail.from.x, rail.from.y), (154 * 64, 157 * 64));
    assert_eq!((rail.to.x, rail.to.y), (132 * 64, 157 * 64));
    let svg = artifact(&spec, &g);
    let doc = roxmltree::Document::parse(&svg).unwrap();
    let primitive = element(&doc, "lifecycle-rail", "main");
    assert_eq!(
        primitive.attribute("points").unwrap(),
        format!(
            "{},{} {},{}",
            rail.from.x as f64 / 64.0,
            rail.from.y as f64 / 64.0,
            rail.to.x as f64 / 64.0,
            rail.to.y as f64 / 64.0
        )
    );
    let options = SvgOptions::from_spec(&spec, SvgTheme::Light).unwrap();
    let corrupted = svg.replacen(primitive.attribute("points").unwrap(), "0,0 0,0", 1);
    assert!(!check_svg_artifact(&corrupted, &g, &options).is_empty());
    let page_width = g.page.bounds.width as f64 / 64.0;
    for (band, y) in [("phase", 112.0), ("event", 264.0)] {
        let divider = element(&doc, "lifecycle-band", band);
        assert_eq!(px(divider, "x1"), 72.0);
        assert_eq!(px(divider, "x2"), page_width - 72.0);
        assert_eq!(px(divider, "y1"), y);
        assert_eq!(px(divider, "y2"), y);
    }
}

#[test]
fn empty_legend_emits_no_symbols_and_passes_reference_gate() {
    let mut spec: Value =
        serde_json::from_str(include_str!("../testdata/valid-sequence.json")).unwrap();
    spec["meta"]["legend"]["mode"] = json!("hidden");
    let g = retained(&spec);
    let svg = artifact(&spec, &g);
    let doc = roxmltree::Document::parse(&svg).unwrap();
    assert!(!doc.descendants().any(|n| n
        .attribute("data-kind")
        .is_some_and(|k| k.starts_with("legend-"))));
    let options = SvgOptions::from_spec(&spec, SvgTheme::Light).unwrap();
    assert!(check_svg_artifact(&svg, &g, &options).is_empty());
}

#[test]
fn one_stage_dataflow_keeps_geometry_and_swatch_at_explicit_paint_bounds() {
    let mut spec: Value =
        serde_json::from_str(include_str!("../testdata/valid-dataflow.json")).unwrap();
    let mut g = retained(&spec);
    spec["stages"] = json!([{"label":"Only"}]);
    spec["nodes"] = json!([{"id":"a","type":"frontend","label":"A","stage":0,"row":0}]);
    spec["flows"] = json!([]);
    // One-stage source is below E1 minimum cardinality. The artifact seam
    // must still handle a DTO reduced to one stage and an empty route list.
    assert!(
        layout_json(&json!({"specJson":spec.to_string()}).to_string())
            .geometry
            .is_none()
    );
    g.containers
        .retain(|frame| frame.kind != "stage" || frame.id == "stage:0");
    g.nodes.retain(|node| node.id == "a");
    g.routes.clear();
    assert_eq!(
        g.containers
            .iter()
            .filter(|frame| frame.kind == "stage")
            .count(),
        1
    );
    let svg = artifact(&spec, &g);
    let doc = roxmltree::Document::parse(&svg).unwrap();
    for entry in &g.legend.entries {
        let Some(bounds) = entry.swatch_bounds else {
            panic!("swatch bounds are required")
        };
        if entry.key == "database" {
            continue;
        }
        let line = element(&doc, "legend-route-swatch", &entry.key);
        assert_eq!(px(line, "x1"), bounds.x as f64 / 64.0);
        assert_eq!(px(line, "x2"), (bounds.x + bounds.width) as f64 / 64.0);
    }
    let options = SvgOptions::from_spec(&spec, SvgTheme::Light).unwrap();
    assert!(check_svg_artifact(&svg, &g, &options).is_empty());
}

#[test]
fn tiny_retained_final_box_uses_the_explicit_safe_inset() {
    let spec: Value =
        serde_json::from_str(include_str!("../testdata/valid-lifecycle.json")).unwrap();
    let mut g = retained(&spec);
    let (node_id, original_x, original_y) = {
        let node = g
            .nodes
            .iter_mut()
            .find(|node| node.final_state == Some(true))
            .unwrap();
        let original_x = node.bounds.x;
        let original_y = node.bounds.y;
        node.bounds.width = 64;
        node.bounds.height = 128;
        (node.id.clone(), original_x, original_y)
    };
    let svg = artifact(&spec, &g);
    let doc = roxmltree::Document::parse(&svg).unwrap();
    let border = element(&doc, "lifecycle-final-border", &node_id);
    assert_eq!(px(border, "x"), (original_x + 16) as f64 / 64.0);
    assert_eq!(px(border, "y"), (original_y + 16) as f64 / 64.0);
    assert_eq!(px(border, "width"), 32.0 / 64.0);
    assert_eq!(px(border, "height"), 96.0 / 64.0);
}

#[test]
fn zero_size_workflow_phase_span_is_checked_without_relayout() {
    use maru_diagram_engine::geometry::{GeometryBox, GeometryContainer};
    let spec: Value =
        serde_json::from_str(include_str!("../testdata/valid-workflow.json")).unwrap();
    let mut g = retained(&spec);
    g.containers.push(GeometryContainer {
        id: "phase:degenerate".into(),
        kind: "phase".into(),
        bounds: GeometryBox {
            x: 12800,
            y: 16000,
            width: 0,
            height: 0,
        },
    });
    let svg = artifact(&spec, &g);
    let doc = roxmltree::Document::parse(&svg).unwrap();
    let line = element(&doc, "workflow-phase-span", "phase:degenerate");
    assert_eq!(px(line, "x1"), 200.0);
    assert_eq!(px(line, "x2"), 200.0);
    assert_eq!(px(line, "y1"), 250.0);
    assert_eq!(px(line, "y2"), 250.0);
    let options = SvgOptions::from_spec(&spec, SvgTheme::Light).unwrap();
    assert!(check_svg_artifact(&svg, &g, &options).is_empty());
}
