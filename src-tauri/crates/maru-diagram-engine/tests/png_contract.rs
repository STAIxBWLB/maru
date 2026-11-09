#![cfg(feature = "render-png")]
use maru_diagram_engine::{
    geometry::GeometryDocument,
    layout::layout_json,
    render::{
        png::{dimensions, render_png, PngOptions, MAX_PNG_PIXELS},
        render_artifact_json, SvgOptions, SvgTheme,
    },
    API_VERSION,
};
use serde_json::{json, Value};
fn scene(input: &str) -> (Value, GeometryDocument) {
    let mut source: Value = serde_json::from_str(input).unwrap();
    source["meta"]["legend"] = json!({"mode":"hidden"});
    let collection = match source["diagram_type"].as_str().unwrap() {
        "architecture" => "components",
        "sequence" => "participants",
        "lifecycle" => "states",
        _ => "nodes",
    };
    source[collection][0]["label"] = json!("한글");
    let layout = layout_json(&json!({"specJson":source.to_string()}).to_string());
    assert!(layout.ok, "{:?}", layout.diagnostics);
    (source, layout.geometry.unwrap())
}
#[test]
fn all_families_rasterize_with_bundled_cjk_and_repeat_bytes() {
    for input in [
        include_str!("../testdata/valid-architecture.json"),
        include_str!("../testdata/valid-workflow.json"),
        include_str!("../testdata/valid-sequence.json"),
        include_str!("../testdata/valid-dataflow.json"),
        include_str!("../testdata/valid-lifecycle.json"),
    ] {
        let (source, g) = scene(input);
        for theme in [SvgTheme::Light, SvgTheme::Dark] {
            let o = SvgOptions::from_spec(&source, theme).unwrap();
            let first = render_png(&g, &o, PngOptions::default()).unwrap();
            let second = render_png(&g, &o, PngOptions::default()).unwrap();
            assert_eq!(first.bytes, second.bytes);
            assert_eq!(first.pixels_sha256, second.pixels_sha256);
            assert_eq!(&first.bytes[..8], &[137, 80, 78, 71, 13, 10, 26, 10]);
            let decoded = resvg::tiny_skia::Pixmap::decode_png(&first.bytes).unwrap();
            assert_eq!(
                (decoded.width(), decoded.height()),
                (first.width, first.height)
            );
            assert!(decoded.data().chunks_exact(4).all(|pixel| pixel[3] == 255));
        }
    }
}
#[test]
fn font_text_and_pixel_ratio_are_real_rendering_inputs() {
    let (source, g) = scene(include_str!("../testdata/valid-architecture.json"));
    let o = SvgOptions::from_spec(&source, SvgTheme::Light).unwrap();
    let a = render_png(&g, &o, PngOptions::default()).unwrap();
    let b = render_png(&g, &o, PngOptions { pixel_ratio: 2 }).unwrap();
    assert_eq!((b.width, b.height), (a.width * 2, a.height * 2));
    let mut shapes = g.clone();
    shapes.labels.clear();
    let no_text = render_png(&shapes, &o, PngOptions::default()).unwrap();
    assert_ne!(
        a.pixels_sha256, no_text.pixels_sha256,
        "CJK text cannot silently disappear from the rasterizer"
    );
}
#[test]
fn oversized_pixels_and_invalid_ratios_fail_before_allocation() {
    let (_, mut g) = scene(include_str!("../testdata/valid-architecture.json"));
    for ratio in [0, 5, u32::MAX] {
        assert!(dimensions(&g, PngOptions { pixel_ratio: ratio }).is_err());
    }
    g.page.bounds.width = 10_000 * 64;
    g.page.bounds.height = 10_000 * 64;
    assert!(100_000_000 > MAX_PNG_PIXELS);
    let error = dimensions(&g, PngOptions::default()).unwrap_err();
    assert!(!error.message.is_empty() && !error.fix.is_empty());
    g.page.bounds.width = i32::MAX;
    assert!(dimensions(&g, PngOptions::default()).is_err());
}
#[test]
fn receipt_export_derives_source_geometry_and_hashes_in_rust() {
    let (source, _) = scene(include_str!("../testdata/valid-architecture.json"));
    for format in ["svg", "png"] {
        let report = render_artifact_json(
            &json!({"specJson":source.to_string(),"format":format,"theme":"dark","pixelRatio":1})
                .to_string(),
        );
        assert!(report.ok, "{:?}", report.diagnostics);
        assert_eq!(report.api_version, API_VERSION);
        assert_eq!(report.receipt.schema_version, 1);
        assert_eq!(report.receipt.engine.id, "maru-diagram-engine");
        assert_eq!(report.receipt.gates.artifact.status, "passed");
        assert!(report.receipt.engine_output_sha256.is_some());
        assert!(report.receipt.output_sha256.is_some());
        assert!(report.svg.is_some() && report.bytes.is_some());
    }
    let refused = render_artifact_json(
        &json!({"specJson":source.to_string(),"format":"svg","pixelRatio":2}).to_string(),
    );
    assert!(!refused.ok && refused.bytes.is_none());
    let mut bad = source;
    bad["components"][0]["type"] = json!("invalid");
    let refused =
        render_artifact_json(&json!({"specJson":bad.to_string(),"format":"png"}).to_string());
    assert!(!refused.ok && refused.bytes.is_none());
}
