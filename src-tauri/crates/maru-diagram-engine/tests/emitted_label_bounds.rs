#![cfg(feature = "geometry")]

use maru_diagram_engine::geometry::GeometryReport;
use maru_diagram_engine::layout::layout_json;
use serde_json::{json, Value};
#[path = "support/painted_ink.rs"]
mod painted_ink;

fn spec(label: &str, width: f64) -> Value {
    json!({
        "schema_version": 1,
        "diagram_type": "dataflow",
        "meta": {"title": "Text bounds", "output": "text-bounds.html", "viewBox": [940, 720]},
        "stages": [{"label": "Input"}, {"label": "Output"}],
        "nodes": [
            {"id": "a", "type": "frontend", "label": label, "stage": 1, "row": 0, "width": width, "height": 58},
            {"id": "b", "type": "backend", "label": "Output", "stage": 0, "row": 1}
        ],
        "flows": []
    })
}

fn report(label: &str, width: f64) -> GeometryReport {
    layout_json(&json!({"specJson": spec(label, width).to_string()}).to_string())
}

struct FittedLabel {
    text: String,
    lines: usize,
    font_size: i64,
    ink_width: i64,
}

/// The result of placing this label: accepted, holding its own painted glyph ink
/// inside the node it belongs to, with no line below the readable floor. The
/// width that decided the fit is the emitted Noto ink, so equal character counts
/// and different glyph classes can land on different line counts.
fn fitted_primary_label(report: &GeometryReport) -> FittedLabel {
    assert!(
        report.ok,
        "auto-fit must make this label readable: {:?}",
        report.diagnostics
    );
    let geometry = report
        .geometry
        .as_ref()
        .expect("accepted layout has geometry");
    let node = geometry.nodes.iter().find(|node| node.id == "a").unwrap();
    let label = geometry
        .labels
        .iter()
        .find(|label| label.id.as_deref() == Some("node:a:label"))
        .unwrap();
    let area_left = i64::from(node.bounds.x);
    let area_top = i64::from(node.bounds.y);
    let area_right = area_left + i64::from(node.bounds.width);
    let area_bottom = area_top + i64::from(node.bounds.height);
    let painted = label
        .glyphs
        .iter()
        .filter(|glyph| glyph.ink.width > 0 && glyph.ink.height > 0)
        .map(|glyph| {
            let left = i64::from(glyph.ink.x);
            let top = i64::from(glyph.ink.y);
            (
                left,
                top,
                left + i64::from(glyph.ink.width),
                top + i64::from(glyph.ink.height),
            )
        })
        .reduce(|a, b| (a.0.min(b.0), a.1.min(b.1), a.2.max(b.2), a.3.max(b.3)))
        .expect("a fitted label paints at least one glyph");
    assert!(
        painted.0 >= area_left && painted.1 >= area_top,
        "fitted ink {:?} starts outside node a {:?}",
        painted,
        node.bounds
    );
    assert!(
        painted.2 <= area_right && painted.3 <= area_bottom,
        "fitted ink {:?} runs past node a {:?}",
        painted,
        node.bounds
    );
    let font_size = i64::from(label.font_size);
    assert!(
        font_size >= painted_ink::READABLE_FLOOR_TICKS,
        "fitted label is {font_size} ticks, below the {} tick readable floor",
        painted_ink::READABLE_FLOOR_TICKS
    );
    FittedLabel {
        text: label.text.clone(),
        lines: label.text.split('\n').count(),
        font_size,
        ink_width: painted.2 - painted.0,
    }
}

fn assert_emitted_box_fits(report: &GeometryReport) {
    assert!(report.ok, "{:?}", report.diagnostics);
    let geometry = report
        .geometry
        .as_ref()
        .expect("accepted layout has geometry");
    let node = geometry.nodes.iter().find(|node| node.id == "a").unwrap();
    let label = geometry
        .labels
        .iter()
        .find(|label| label.id.as_deref() == Some("node:a:label"))
        .unwrap();
    let area_left = i64::from(node.bounds.x);
    let area_right = i64::from(node.bounds.x) + i64::from(node.bounds.width);
    assert!(i64::from(label.bounds.x) >= area_left);
    assert!(i64::from(label.bounds.x) + i64::from(label.bounds.width) <= area_right);
}

#[test]
fn long_latin_primary_label_uses_emitted_noto_width_at_narrow_and_wide_sizes() {
    // One unbroken Latin word: no space and no Hangul syllable to break at, so
    // only the box and the type ladder can hold it. At 118px the emitted Noto
    // ink overflows the text area and the engine re-breaks the word; at 220px
    // the same text stays on one line, which is the measured width deciding.
    let label = "BrandBrandBrandBrandBran";
    let narrow = fitted_primary_label(&report(label, 118.0));
    assert_eq!(narrow.lines, 2, "narrow box: {:?}", narrow.text);
    assert_eq!(narrow.font_size, 832, "13px holds it once re-broken");
    let wide = fitted_primary_label(&report(label, 220.0));
    assert_eq!(wide.lines, 1, "wide box keeps one line: {:?}", wide.text);
    assert!(wide.ink_width > narrow.ink_width);
}

#[test]
fn mixed_korean_and_english_primary_label_fits_only_when_the_actual_text_area_allows_it() {
    let label = "결제 Gateway API 2025";
    let narrow = fitted_primary_label(&report(label, 118.0));
    assert_eq!(narrow.lines, 2, "narrow box: {:?}", narrow.text);
    assert_eq!(
        narrow.text, "결제 Gateway\nAPI 2025",
        "the space is the break point, so the Hangul word stays whole"
    );
    assert_eq!(narrow.font_size, 832);
    let wide = fitted_primary_label(&report(label, 220.0));
    assert_eq!(wide.lines, 1, "wide box keeps one line: {:?}", wide.text);
}

#[test]
fn equal_length_latin_glyph_classes_have_distinct_physical_widths() {
    // Both labels are 24 characters; only the emitted Noto widths differ.
    let narrow_i = "i".repeat(24);
    let wide_w = "W".repeat(24);
    let short = fitted_primary_label(&report(&narrow_i, 118.0));
    assert_eq!(short.lines, 1, "i-class ink fits the narrow box whole");
    assert_eq!(short.font_size, 832);
    let tall = fitted_primary_label(&report(&wide_w, 118.0));
    assert_eq!(
        tall.lines, 3,
        "W-class ink needs three lines: {:?}",
        tall.text
    );
    assert_eq!(tall.font_size, 768, "and the ladder drops one step to 12px");
    let roomy = fitted_primary_label(&report(&wide_w, 340.0));
    assert_eq!(roomy.lines, 1, "a wide box holds the same text on one line");
    assert!(
        roomy.ink_width > short.ink_width,
        "equal character counts, different physical widths: {} vs {}",
        roomy.ink_width,
        short.ink_width
    );
}

#[test]
fn font_ink_bearings_may_use_node_padding_without_overflowing_the_node() {
    let report = report("A", 118.0);
    assert_emitted_box_fits(&report);
    let geometry = report.geometry.unwrap();
    let node = geometry.nodes.iter().find(|node| node.id == "a").unwrap();
    let label = geometry
        .labels
        .iter()
        .find(|label| label.id.as_deref() == Some("node:a:label"))
        .unwrap();
    assert!(
        label.bounds.x < node.bounds.x + 12 * 64,
        "this fixture must exercise ink left of the text origin"
    );
    assert!(
        label.bounds.x >= node.bounds.x,
        "the ink stays inside the actual node"
    );
}

#[test]
fn unpainted_line_leading_does_not_refuse_visible_text_inside_the_node() {
    let mut input = spec("A", 118.0);
    input["nodes"][0]["sublabel"] = json!("Browser");
    input["nodes"][0]["tag"] = json!("Source");
    let result = layout_json(&json!({"specJson": input.to_string()}).to_string());
    assert!(result.ok, "{:?}", result.diagnostics);
    let geometry = result.geometry.unwrap();
    let node = geometry.nodes.iter().find(|node| node.id == "a").unwrap();
    let labels: Vec<_> = geometry
        .labels
        .iter()
        .filter(|label| label.target_id == "a")
        .collect();
    assert!(
        labels
            .iter()
            .any(|label| label.bounds.y + label.bounds.height > node.bounds.y + node.bounds.height),
        "fixture must exercise nonpainting line leading"
    );
    for glyph in labels
        .iter()
        .flat_map(|label| &label.glyphs)
        .filter(|glyph| glyph.ink.width > 0 && glyph.ink.height > 0)
    {
        assert!(glyph.ink.x >= node.bounds.x && glyph.ink.y >= node.bounds.y);
        assert!(glyph.ink.x + glyph.ink.width <= node.bounds.x + node.bounds.width);
        assert!(glyph.ink.y + glyph.ink.height <= node.bounds.y + node.bounds.height);
    }
}
