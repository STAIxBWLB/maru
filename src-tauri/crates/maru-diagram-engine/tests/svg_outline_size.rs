#![cfg(all(feature = "render-svg", feature = "render-outline"))]
//! Byte cost of outlined labels (`maru#552`), so the export budget is recorded
//! next to the scenes it was measured on instead of being assumed. Measured on
//! the pinned faces: the 50-component scene goes from 105,047 to 193,709 bytes
//! (1.84x) and the 1,000-component scene from 2,108,529 to 4,079,636 bytes
//! (1.93x); the same scenes with half their labels carrying Hangul reach 2.12x
//! and 2.15x, because each Hangul glyph is several CFF contours.
use maru_diagram_engine::{
    layout::layout_json,
    render::{render_svg, SvgOptions, SvgTextMode, SvgTheme},
};
use serde_json::{json, Value};

/// Outlining replaces one text run with one path per glyph. Anything far above
/// this ratio means the artifact stopped carrying glyph paths and started
/// carrying a face.
const MAX_OUTLINE_RATIO: f64 = 3.0;
/// The 1,000-component scene must stay well below the 16 MiB export request cap.
const MAX_THOUSAND_BYTES: usize = 8 * 1024 * 1024;

const MIXED_LABELS: [&str; 4] = [
    "주문 처리 Order flow",
    "결제 Payment",
    "배송 shipping",
    "재고 Inventory",
];

fn scene(name: &str) -> Value {
    serde_json::from_str(&match name {
        "bench-50" => include_str!("../testdata/bench-50.json"),
        "bench-1000" => include_str!("../testdata/bench-1000.json"),
        other => panic!("unknown scene {other}"),
    })
    .expect("scene fixture parses")
}

/// Replaces every `every`-th label with a mixed Korean/English one, so the
/// measurement carries the Hangul glyphs that cost the most per character.
fn koreanize(spec: &mut Value, every: usize) {
    let components = spec["components"]
        .as_array_mut()
        .expect("scene carries components");
    for (index, component) in components.iter_mut().enumerate() {
        if index % every == 0 {
            component["label"] = json!(MIXED_LABELS[index % MIXED_LABELS.len()]);
        }
    }
}

fn measure(spec: &Value) -> (usize, usize) {
    let layout = layout_json(&json!({"specJson": spec.to_string()}).to_string());
    let geometry = layout.geometry.expect("scene retains geometry");
    let options = |text_mode| SvgOptions {
        semantics: Some(
            maru_diagram_engine::render::SemanticContext::from_spec(spec)
                .expect("scene carries valid semantics"),
        ),
        theme: SvgTheme::Light,
        title: "주문 처리 Order flow".into(),
        description: "Outlined export size fixture".into(),
        text_mode,
    };
    let text = render_svg(&geometry, &options(SvgTextMode::Text));
    assert!(text.ok, "{:?}", text.diagnostics);
    let outlined = render_svg(&geometry, &options(SvgTextMode::Outlines));
    assert!(outlined.ok, "{:?}", outlined.diagnostics);
    let outlined_svg = outlined.svg.expect("outline mode has bytes");
    assert!(
        !outlined_svg.contains("<text "),
        "the measured artifact is drawn from glyph paths only"
    );
    (
        text.svg.expect("text mode has bytes").len(),
        outlined_svg.len(),
    )
}

fn assert_cost(name: &str, spec: &Value, ceiling: usize) {
    let (text, outlined) = measure(spec);
    let ratio = outlined as f64 / text as f64;
    println!("OUTLINE_SIZE {name} text={text} outlined={outlined} ratio={ratio:.2}");
    assert!(
        ratio <= MAX_OUTLINE_RATIO,
        "{name}: outlined labels cost {ratio:.2}x the text run ({text} -> {outlined} bytes); \
         a glyph path per character must not carry a face"
    );
    assert!(
        outlined <= ceiling,
        "{name}: outlined export is {outlined} bytes, above the {ceiling} byte ceiling"
    );
}

#[test]
fn outlined_exports_stay_within_the_recorded_export_budget() {
    assert_cost("typical", &scene("bench-50"), 300_000);
    let mut korean_typical = scene("bench-50");
    koreanize(&mut korean_typical, 2);
    assert_cost("typical-korean", &korean_typical, 400_000);
    assert_cost("thousand", &scene("bench-1000"), MAX_THOUSAND_BYTES);
    let mut korean_thousand = scene("bench-1000");
    koreanize(&mut korean_thousand, 2);
    assert_cost("thousand-korean", &korean_thousand, MAX_THOUSAND_BYTES);
}
