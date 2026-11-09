//! Host-only PNG transport/determinism probe; never linked by product builds.
use maru_diagram_engine::{
    layout::layout_json,
    render::{
        png::{render_png, PngOptions},
        SvgOptions, SvgTheme,
    },
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 2 {
        eprintln!("usage: png-probe SPEC_JSON OUTPUT_PNG; provide a scene fixture and output artifact path");
        std::process::exit(2);
    }
    let source = std::fs::read_to_string(&args[0]).expect("read fixture source");
    let start = std::time::Instant::now();
    let scene = layout_json(&json!({"specJson":source}).to_string());
    assert!(scene.ok, "{:?}", scene.diagnostics);
    let g = scene.geometry.unwrap();
    let spec: Value = serde_json::from_str(&source).unwrap();
    let layout_ms = start.elapsed().as_secs_f64() * 1000.0;
    let options = SvgOptions::from_spec(&spec, SvgTheme::Light).unwrap();
    let cold = std::time::Instant::now();
    let first = render_png(&g, &options, PngOptions::default()).expect("PNG gate passes");
    let cold_ms = cold.elapsed().as_secs_f64() * 1000.0;
    let mut warm = Vec::new();
    for _ in 0..5 {
        let t = std::time::Instant::now();
        let repeat = render_png(&g, &options, PngOptions::default()).unwrap();
        assert_eq!(first.bytes, repeat.bytes);
        warm.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    std::fs::write(&args[1], &first.bytes).expect("write requested probe artifact");
    println!(
        "{}",
        json!({"width":first.width,"height":first.height,"pngBytes":first.bytes.len(),"pngSha256":format!("{:x}",Sha256::digest(&first.bytes)),"svgSha256":first.svg_sha256,"pixelsSha256":first.pixels_sha256,"layoutMs":layout_ms,"coldRenderMs":cold_ms,"warmRenderMs":warm})
    );
}
