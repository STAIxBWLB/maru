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
fn run() -> Result<(), String> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 2 {
        return Err("expected SPEC_JSON OUTPUT_PNG; provide a readable scene fixture and writable output path".into());
    }
    let source = std::fs::read_to_string(&args[0]).map_err(|cause| {
        format!(
            "cannot read fixture {}: {cause}; provide a readable UTF-8 scene file",
            args[0]
        )
    })?;
    let start = std::time::Instant::now();
    let scene = layout_json(&json!({"specJson":source}).to_string());
    if !scene.ok {
        return Err(format!(
            "fixture layout was refused: {:?}; apply each diagnostic fix before probing",
            scene.diagnostics
        ));
    }
    let g = scene
        .geometry
        .ok_or("layout returned no geometry; repair the layout producer before probing")?;
    let spec: Value = serde_json::from_str(&source)
        .map_err(|cause| format!("fixture JSON is invalid: {cause}; repair the scene file"))?;
    let layout_ms = start.elapsed().as_secs_f64() * 1000.0;
    let options = SvgOptions::from_spec(&spec, SvgTheme::Light).map_err(|cause| {
        format!("SVG options were refused: {cause:?}; repair source metadata before probing")
    })?;
    let cold = std::time::Instant::now();
    let first = render_png(&g, &options, PngOptions::default()).map_err(|diagnostics| {
        format!(
            "PNG gate refused the fixture: {diagnostics:?}; apply diagnostic fixes before probing"
        )
    })?;
    let cold_ms = cold.elapsed().as_secs_f64() * 1000.0;
    let mut warm = Vec::new();
    for _ in 0..5 {
        let t = std::time::Instant::now();
        let repeat = render_png(&g, &options, PngOptions::default()).map_err(|diagnostics| format!("repeated PNG gate refused the fixture: {diagnostics:?}; apply diagnostic fixes before probing"))?;
        if first.bytes != repeat.bytes {
            return Err("repeated PNG bytes differ; fix raster determinism before accepting transport measurements".into());
        }
        warm.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    std::fs::write(&args[1], &first.bytes).map_err(|cause| {
        format!(
            "cannot write PNG {}: {cause}; provide a writable artifact path",
            args[1]
        )
    })?;
    println!(
        "{}",
        json!({"width":first.width,"height":first.height,"pngBytes":first.bytes.len(),"pngSha256":format!("{:x}",Sha256::digest(&first.bytes)),"svgSha256":first.svg_sha256,"pixelsSha256":first.pixels_sha256,"layoutMs":layout_ms,"coldRenderMs":cold_ms,"warmRenderMs":warm})
    );
    Ok(())
}

fn main() {
    if let Err(cause) = run() {
        eprintln!("PNG probe failed: {cause}");
        std::process::exit(1);
    }
}
