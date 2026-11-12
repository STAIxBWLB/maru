#![cfg(feature = "render-svg")]

use maru_diagram_engine::{
    layout::layout_json,
    render::{render_svg, SvgOptions, SvgTheme},
};
use roxmltree::{Document, Node};
use serde_json::{json, Value};

const CASE_ID: &str = "e2-boundary-lifecycle-band-title-113.984375";
const PARITY: &str = include_str!("../testdata/parity.json");

fn parity_case() -> Value {
    let corpus: Value = serde_json::from_str(PARITY).expect("parity corpus is valid JSON");
    corpus["boundaryCases"]
        .as_array()
        .expect("parity corpus has boundaryCases")
        .iter()
        .find(|case| case["id"].as_str() == Some(CASE_ID))
        .cloned()
        .unwrap_or_else(|| panic!("pinned parity corpus is missing {CASE_ID}"))
}

fn px(units: i32) -> f64 {
    f64::from(units) / 64.0
}

fn attr_px(node: Node<'_, '_>, name: &str) -> f64 {
    node.attribute(name)
        .unwrap_or_else(|| panic!("{} is missing {name}", node.tag_name().name()))
        .parse::<f64>()
        .unwrap_or_else(|_| panic!("{} {name} is not numeric", node.tag_name().name()))
}

fn close(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() <= 1e-9,
        "expected {expected}, got {actual}"
    );
}

fn label_group<'a, 'input>(doc: &'a Document<'input>, label_id: &str) -> Node<'a, 'input> {
    let source_id = format!("id:{label_id}");
    doc.descendants()
        .find(|node| {
            node.has_tag_name("g")
                && node.attribute("data-kind") == Some("label")
                && node.attribute("data-source-id") == Some(source_id.as_str())
        })
        .unwrap_or_else(|| panic!("rendered SVG is missing geometry label {label_id}"))
}

fn assert_rendered_from_geometry(
    doc: &Document<'_>,
    geometry: &maru_diagram_engine::geometry::GeometryDocument,
) {
    // svg.rs emits visible text only from GeometryDocument.labels. Semantic
    // primitives are geometric shapes, never independent text runs.
    let text_nodes: Vec<_> = doc
        .descendants()
        .filter(|node| node.has_tag_name("text"))
        .collect();
    assert_eq!(
        text_nodes.len(),
        geometry.labels.len(),
        "the writer must emit visible text only for GeometryDocument labels"
    );
    assert!(text_nodes
        .iter()
        .all(|node| node.attribute("data-kind") == Some("label-text")));

    for label in &geometry.labels {
        let id = label.id.as_deref().expect("placed labels have stable ids");
        let group = label_group(doc, id);
        assert_eq!(
            group.attribute("data-target-id"),
            Some(label.target_id.as_str())
        );
        assert_eq!(group.attribute("aria-label"), Some(label.text.as_str()));

        let bounds = group
            .children()
            .find(|node| {
                node.has_tag_name("rect") && node.attribute("data-kind") == Some("label-bounds")
            })
            .expect("label group writes its measured bounds");
        close(attr_px(bounds, "x"), px(label.bounds.x));
        close(attr_px(bounds, "y"), px(label.bounds.y));
        close(attr_px(bounds, "width"), px(label.bounds.width));
        close(attr_px(bounds, "height"), px(label.bounds.height));

        let text = group
            .children()
            .find(|node| {
                node.has_tag_name("text") && node.attribute("data-kind") == Some("label-text")
            })
            .expect("label group writes Noto text runs");
        let expected: Vec<_> = label
            .glyphs
            .iter()
            .filter(|glyph| !glyph.ignored && !glyph.replaced)
            .collect();
        let actual: Vec<_> = text
            .children()
            .filter(|node| node.has_tag_name("tspan"))
            .collect();
        assert_eq!(actual.len(), expected.len(), "glyph count for {id}");
        for (span, glyph) in actual.iter().zip(expected) {
            assert_eq!(span.attribute("data-kind"), Some("glyph"));
            assert_eq!(span.text(), Some(glyph.input.as_str()));
            close(attr_px(*span, "x"), px(glyph.position.x));
            close(attr_px(*span, "y"), px(glyph.position.y));
        }
    }
}

#[test]
fn lifecycle_band_title_is_not_a_second_legacy_text_path() {
    let case = parity_case();
    assert_eq!(case["oracle"]["ok"], json!(false));
    assert!(case["oracle"]["codes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|code| code == "composition/label-band-title-overlap"));
    assert_eq!(case["geometryComparison"]["accepted"], json!(false));

    let input = case["geometryComparison"]["inputJson"]
        .as_str()
        .expect("case retains its original source JSON");
    let spec: Value = serde_json::from_str(input).expect("source case is valid JSON");
    let layout = layout_json(&json!({ "specJson": input }).to_string());
    assert!(
        layout.ok,
        "E2 keeps its Noto placement: {:?}",
        layout.diagnostics
    );
    let geometry = layout.geometry.expect("accepted layout retains geometry");
    // The recorded parity numbers below are the pinned source drawing's. A
    // lifecycle scene now moves below the emitted header band like workflow and
    // dataflow already did, and `page.contentOffset` is the only retained field
    // that says by how much, so every expectation here is source + offset.
    let shift = i64::from(
        geometry
            .page
            .content_offset
            .expect("a shifted lifecycle page reports its content offset")
            .y,
    );
    assert!(shift > 0, "the emitted title band did not move the drawing");

    let main = geometry
        .labels
        .iter()
        .find(|label| label.target_id == "lane:main" && label.text == "Main")
        .expect("lifecycle lane title is represented by measured Noto geometry");
    let go = geometry
        .labels
        .iter()
        .find(|label| label.target_id == "transition:0" && label.text == "Go")
        .expect("transition label is represented by measured Noto geometry");
    assert_eq!(
        (
            main.bounds.x,
            i64::from(main.bounds.y) - shift,
            main.bounds.width,
            main.bounds.height
        ),
        (1472, 5120, 1988, 1248)
    );
    assert_eq!(
        (
            go.bounds.x,
            i64::from(go.bounds.y) - shift,
            go.bounds.width,
            go.bounds.height
        ),
        (5903, 6719, 995, 1152)
    );
    let main_bottom = i64::from(main.bounds.y) + i64::from(main.bounds.height);
    let gap_units = i64::from(go.bounds.y) - main_bottom;
    assert_eq!(gap_units, 351);
    close(gap_units as f64 / 64.0, 5.484375);

    let source_band = &case["oracle"]["diagnostics"][0]["evidence"]["bandTitle"];
    let source_label = &case["oracle"]["diagnostics"][0]["evidence"]["labelRect"];
    assert_eq!(source_band["label"], "01 / Main");
    close(source_band["x"].as_f64().unwrap(), 72.0);
    close(source_band["y"].as_f64().unwrap(), 89.0);
    close(source_band["height"].as_f64().unwrap(), 14.0);
    let source_go_top = source_label["y"].as_f64().unwrap();
    let source_band_bottom =
        source_band["y"].as_f64().unwrap() + source_band["height"].as_f64().unwrap();
    close(source_band_bottom - source_go_top, 0.015625);

    let options =
        SvgOptions::from_spec(&spec, SvgTheme::Light).expect("source semantics are valid");
    let rendered = render_svg(&geometry, &options);
    assert!(
        rendered.ok,
        "S1 SVG writer rejected Noto geometry: {:?}",
        rendered.diagnostics
    );
    let svg = rendered.svg.expect("accepted SVG has bytes");
    let doc = Document::parse(&svg).expect("rendered SVG is XML");
    assert_rendered_from_geometry(&doc, &geometry);

    let main_group = label_group(&doc, main.id.as_deref().unwrap());
    assert_eq!(main_group.attribute("aria-label"), Some("Main"));
    let go_group = label_group(&doc, go.id.as_deref().unwrap());
    assert_eq!(go_group.attribute("aria-label"), Some("Go"));
    let rendered_labels: Vec<_> = doc
        .descendants()
        .filter(|node| node.attribute("data-kind") == Some("label-text"))
        .map(|node| {
            node.descendants()
                .filter(|span| span.has_tag_name("tspan"))
                .filter_map(|span| span.text())
                .collect::<String>()
        })
        .collect();
    assert!(rendered_labels.contains(&"Main".to_owned()));
    assert!(rendered_labels.contains(&"Go".to_owned()));
    assert!(!rendered_labels.iter().any(|text| text == "01 / Main"));

    let band_primitives: Vec<_> = doc
        .descendants()
        .filter(|node| node.attribute("data-kind") == Some("lifecycle-band"))
        .collect();
    assert_eq!(band_primitives.len(), 1);
    assert!(band_primitives[0].has_tag_name("line"));
    assert_eq!(band_primitives[0].attribute("aria-hidden"), Some("true"));
    assert!(!geometry
        .labels
        .iter()
        .any(|label| label.text == "01 / Main"));
    assert!(!doc.descendants().any(|node| {
        node.has_tag_name("text")
            && node.attribute("x") == Some("72")
            && node.attribute("y") == Some("100")
    }));
}
