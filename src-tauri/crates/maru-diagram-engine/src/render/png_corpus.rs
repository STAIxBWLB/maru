//! Deterministic, source-pinned PNG corpus shared by native and test-featured WASM.
use super::png::{render_png, PngOptions};
use super::{SvgOptions, SvgTheme};
use crate::{layout::layout_json, metrics, Diagnostic};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const ARCHITECTURE: &str = include_str!("../../testdata/valid-architecture.json");
const DATAFLOW: &str = include_str!("../../testdata/valid-dataflow.json");
const LIFECYCLE: &str = include_str!("../../testdata/valid-lifecycle.json");
const SEQUENCE: &str = include_str!("../../testdata/valid-sequence.json");
const WORKFLOW: &str = include_str!("../../testdata/valid-workflow.json");
const BENCH_1000: &str = include_str!("../../testdata/bench-1000.json");

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn error(rule: &str, path: &str, cause: impl Into<String>, fix: &str) -> Diagnostic {
    Diagnostic {
        code: format!("document/png-corpus-{rule}"),
        path: path.to_owned(),
        rule: format!("render-v1/png-corpus-{rule}"),
        message: cause.into(),
        fix: fix.to_owned(),
    }
}

fn fixture(
    name: &str,
    source: &'static str,
    mutate_cjk: bool,
) -> Result<(String, Value), Diagnostic> {
    let mut spec: Value = serde_json::from_str(source).map_err(|cause| {
        error(
            "fixture-json",
            &format!("/fixtures/{name}"),
            format!("checked-in PNG fixture is invalid JSON: {cause}"),
            "repair the checked-in fixture JSON and regenerate the PNG corpus",
        )
    })?;
    if mutate_cjk {
        let family = spec
            .get("diagram_type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let collection = match family {
            "architecture" => "components",
            "dataflow" | "workflow" => "nodes",
            "lifecycle" => "states",
            "sequence" => "participants",
            _ => {
                return Err(error(
                    "fixture-family",
                    &format!("/fixtures/{name}"),
                    "CJK raster fixture has an unsupported semantic family",
                    "use one of the checked-in E3 diagram-family fixtures",
                ));
            }
        };
        let first = spec
            .get_mut(collection)
            .and_then(Value::as_array_mut)
            .and_then(|items| items.first_mut())
            .and_then(Value::as_object_mut)
            .ok_or_else(|| {
                error(
                    "fixture-shape",
                    &format!("/fixtures/{name}/{collection}/0"),
                    "CJK raster fixture has no first semantic item to localize",
                    "restore the first source node in the checked-in fixture",
                )
            })?;
        first.insert("label".into(), Value::String("한글".into()));
        let meta = spec
            .get_mut("meta")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| {
                error(
                    "fixture-shape",
                    &format!("/fixtures/{name}/meta"),
                    "CJK raster fixture has no metadata object",
                    "restore fixture metadata before measuring PNG output",
                )
            })?;
        meta.insert("title".into(), Value::String("마루 PNG".into()));
    }
    let serialized = serde_json::to_string(&spec).map_err(|cause| {
        error(
            "fixture-serialize",
            &format!("/fixtures/{name}"),
            format!("fixture spec could not be serialized for layout: {cause}"),
            "repair the fixture value before generating a deterministic scene hash",
        )
    })?;
    Ok((serialized, spec))
}

fn fixture_sources() -> [(&'static str, &'static str, bool); 6] {
    [
        ("architecture", ARCHITECTURE, true),
        ("dataflow", DATAFLOW, true),
        ("lifecycle", LIFECYCLE, true),
        ("sequence", SEQUENCE, true),
        ("workflow", WORKFLOW, true),
        ("bench-1000", BENCH_1000, false),
    ]
}

/// Emit the same manifest as `png_corpus_manifest` while streaming one PNG at
/// a time to an optional host-owned diagnostic sink. Core generation performs
/// no filesystem access and retains only the current scene artifact.
pub fn png_corpus_manifest_with_sink(
    sink: &mut dyn FnMut(&str, &[u8]) -> Result<(), String>,
) -> Result<String, Diagnostic> {
    let mut scenes = Vec::with_capacity(12);
    for (fixture_name, source, mutate_cjk) in fixture_sources() {
        let (spec_json, spec) = fixture(fixture_name, source, mutate_cjk)?;
        let report = layout_json(&json!({"specJson":spec_json}).to_string());
        if !report.ok {
            if let Some(diagnostic) = report.diagnostics.into_iter().next() {
                return Err(diagnostic);
            }
            return Err(error(
                "layout",
                &format!("/fixtures/{fixture_name}"),
                "PNG fixture layout was refused without a diagnostic",
                "repair the source fixture and regenerate the geometry report",
            ));
        }
        let geometry = report.geometry.ok_or_else(|| {
            error(
                "geometry",
                &format!("/fixtures/{fixture_name}"),
                "accepted PNG fixture did not retain scene geometry",
                "regenerate the fixture through the geometry-enabled layout API",
            )
        })?;
        for theme in [SvgTheme::Light, SvgTheme::Dark] {
            let options = SvgOptions::from_spec(&spec, theme)?;
            let name = format!("{}-{}", fixture_name, theme.name());
            let first =
                render_png(&geometry, &options, PngOptions::default()).map_err(|diagnostics| {
                    diagnostics.into_iter().next().unwrap_or_else(|| {
                        error(
                            "render",
                            &format!("/scenes/{name}"),
                            "PNG render failed without a diagnostic",
                            "repair the source scene or rasterizer and rerun the PNG manifest",
                        )
                    })
                })?;
            let repeat =
                render_png(&geometry, &options, PngOptions::default()).map_err(|diagnostics| {
                    diagnostics.into_iter().next().unwrap_or_else(|| {
                        error(
                            "repeat-render",
                            &format!("/scenes/{name}"),
                            "repeat PNG render failed without a diagnostic",
                            "repair the source scene or rasterizer and rerun the PNG manifest",
                        )
                    })
                })?;
            let repeat_byte_equal = first.bytes == repeat.bytes;
            sink(&name, &first.bytes).map_err(|cause| {
                error(
                    "artifact-write",
                    &format!("/scenes/{name}"),
                    format!("optional PNG diagnostic sink failed: {cause}"),
                    "choose a writable PNG artifact directory and rerun png-manifest",
                )
            })?;
            scenes.push(json!({
                "name": name,
                "theme": theme.name(),
                "sceneInputSha256": hash(spec_json.as_bytes()),
                "repeatByteEqual": repeat_byte_equal,
                "pngSha256": hash(&first.bytes),
                "pixelsSha256": first.pixels_sha256,
                "svgSha256": first.svg_sha256,
                "pngBytes": first.bytes.len(),
                "width": first.width,
                "height": first.height,
            }));
        }
    }
    let mut font_pin = serde_json::Map::new();
    for weight in [400_u16, 700_u16] {
        let identity = metrics::font_identity(weight)?;
        font_pin.insert(
            weight.to_string(),
            serde_json::to_value(identity).map_err(|cause| {
                error(
                    "font-pin",
                    "/fontPin",
                    format!("pinned font identity could not be serialized: {cause}"),
                    "repair the metrics font identity contract before reporting PNG hashes",
                )
            })?,
        );
    }
    serde_json::to_string(&json!({
        "schemaVersion": 1,
        "scope": "pinned-png-raster-determinism",
        "sceneCount": scenes.len(),
        "fontPin": font_pin,
        "scenes": scenes,
    }))
    .map_err(|cause| {
        error(
            "manifest-serialize",
            "/",
            format!("PNG determinism manifest could not be encoded: {cause}"),
            "repair the PNG manifest schema and regenerate all platform reports",
        )
    })
}

/// Generate the fixture manifest without host filesystem or environment access.
pub fn png_corpus_manifest() -> Result<String, Diagnostic> {
    png_corpus_manifest_with_sink(&mut |_, _| Ok(()))
}
