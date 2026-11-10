//! Receipt-bearing exports always derive geometry from this request's source.
use super::{render_svg, SvgOptions, SvgTextMode, SvgTheme, MAX_SVG_BYTES};
use crate::{
    geometry::{LayoutRequest, PinSet},
    Diagnostic, EngineReceipt, ReceiptConversion, API_VERSION,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ArtifactFormat {
    Svg,
    Png,
}
fn light() -> SvgTheme {
    SvgTheme::Light
}
fn one() -> u32 {
    1
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    spec_json: String,
    format: ArtifactFormat,
    #[serde(default = "light")]
    theme: SvgTheme,
    #[serde(default = "one")]
    pixel_ratio: u32,
    #[serde(default)]
    pin_set: Option<PinSet>,
    /// `text` or `outlines`. Absent uses the entry point's default, so the
    /// native export reads as `outlines` while the browser entry stays `text`
    /// (`maru#552`).
    #[serde(default)]
    text_mode: Option<SvgTextMode>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactReport {
    pub api_version: u32,
    pub ok: bool,
    pub bytes: Option<Vec<u8>>,
    pub svg: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub pixels_sha256: Option<String>,
    pub diagnostics: Vec<Diagnostic>,
    /// Label emission the artifact was produced with, so a caller can tell an
    /// outlined export from a text run. Absent in older receipts reads as
    /// text (`maru#552`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_mode: Option<SvgTextMode>,
    pub receipt: EngineReceipt,
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn failed(mut receipt: EngineReceipt, diagnostics: Vec<Diagnostic>, scope: &str) -> ArtifactReport {
    receipt.gates.artifact = crate::gate("failed", scope);
    ArtifactReport {
        api_version: API_VERSION,
        ok: false,
        bytes: None,
        svg: None,
        width: None,
        height: None,
        pixels_sha256: None,
        diagnostics,
        text_mode: None,
        receipt,
    }
}
pub fn render_artifact_json(input: &str) -> ArtifactReport {
    render(input, false, SvgTextMode::Text)
}
/// Native SVG export: the same receipt-bearing request path as PNG, with
/// outlined labels unless the caller asks for text (`maru#552`).
#[cfg(feature = "render-outline")]
pub fn render_svg_artifact_json(input: &str) -> ArtifactReport {
    render(input, false, SvgTextMode::Outlines)
}
#[cfg(feature = "render-png")]
pub fn render_png_artifact_json(input: &str) -> ArtifactReport {
    render(input, true, SvgTextMode::Text)
}
fn render(input: &str, png_only: bool, default_text_mode: SvgTextMode) -> ArtifactReport {
    let bad = |cause: Diagnostic| {
        let mut receipt = crate::make_report(input, None, Vec::new()).receipt;
        receipt.gates.schema = crate::gate("not-run", "render-request");
        failed(receipt, vec![cause], "render-request")
    };
    if input.len() > MAX_SVG_BYTES {
        return bad(super::error(
            "export-size",
            "/",
            "export request exceeds 16 MiB",
            "reduce the source scene and retry",
        ));
    }
    let request: Request = match serde_json::from_str(input) {
        Ok(request) => request,
        Err(cause) => {
            return bad(super::error(
                "export-request",
                "/",
                format!("export request cannot be decoded: {cause}"),
                "provide specJson, format svg/png, theme and an integer pixelRatio",
            ))
        }
    };
    if png_only && !matches!(request.format, ArtifactFormat::Png) {
        return bad(super::error(
            "png-command-format",
            "/format",
            "native PNG command does not export SVG",
            "use the WASM SVG renderer or request format png",
        ));
    }
    let layout = crate::layout::layout_json(
        &serde_json::to_string(&LayoutRequest {
            spec_json: request.spec_json.clone(),
            pin_set: request.pin_set,
        })
        .expect("layout request serializes"),
    );
    let mut receipt = layout.receipt;
    receipt.engine_output_sha256 = None;
    receipt.gates.browser = crate::gate("not-run", "non-browser-rasterization");
    receipt.readback = Some(crate::gate("not-run", "saved-file-byte-comparison"));
    if !layout.ok {
        return failed(receipt, layout.diagnostics, "independent-layout-geometry");
    }
    if !(1..=4).contains(&request.pixel_ratio)
        || matches!(request.format, ArtifactFormat::Svg) && request.pixel_ratio != 1
    {
        return failed(
            receipt,
            vec![super::error(
                "export-ratio",
                "/pixelRatio",
                "SVG requires pixelRatio 1; PNG requires an integer from 1 through 4",
                "use pixelRatio 1 for SVG or 1..4 for PNG",
            )],
            "export-options",
        );
    }
    let geometry = layout.geometry.expect("successful layout retains geometry");
    let spec = serde_json::from_str(&request.spec_json).expect("validated spec JSON");
    let text_mode = request.text_mode.unwrap_or(default_text_mode);
    let options = match SvgOptions::from_spec(&spec, request.theme) {
        Ok(mut options) => {
            options.text_mode = text_mode;
            options
        }
        Err(error) => return failed(receipt, vec![error], "independent-svg-artifact"),
    };
    let svg = render_svg(&geometry, &options);
    if !svg.ok {
        return failed(receipt, svg.diagnostics, "independent-svg-artifact");
    }
    let svg = svg.svg.expect("successful SVG has bytes");
    receipt.engine_output_sha256 = Some(crate::spec_hash(&svg));
    let (bytes, width, height, mime, scope, pixels_sha256) = match request.format {
        ArtifactFormat::Svg => (
            svg.as_bytes().to_vec(),
            u32::try_from(geometry.page.bounds.width)
                .expect("positive SVG width")
                .div_ceil(64),
            u32::try_from(geometry.page.bounds.height)
                .expect("positive SVG height")
                .div_ceil(64),
            "image/svg+xml",
            "independent-svg-artifact",
            None,
        ),
        ArtifactFormat::Png => {
            #[cfg(feature = "render-png")]
            {
                let config = super::png::PngOptions {
                    pixel_ratio: request.pixel_ratio,
                };
                let (width, height) = match super::png::dimensions(&geometry, config) {
                    Ok(size) => size,
                    Err(error) => {
                        return failed(receipt, vec![error], "independent-svg-and-png-artifacts")
                    }
                };
                match super::png::rasterize(&svg, width, height, &options, config) {
                    Ok(png) => (
                        png.bytes,
                        png.width,
                        png.height,
                        "image/png",
                        "independent-svg-and-png-artifacts",
                        Some(png.pixels_sha256),
                    ),
                    Err(error) => {
                        return failed(receipt, vec![error], "independent-svg-and-png-artifacts")
                    }
                }
            }
            #[cfg(not(feature = "render-png"))]
            {
                return failed(
                    receipt,
                    vec![super::error(
                        "png-disabled",
                        "/format",
                        "PNG rasterization is not included in this SVG-only artifact",
                        "load the separate PNG artifact and retry",
                    )],
                    "independent-svg-and-png-artifacts",
                );
            }
        }
    };
    receipt.output_sha256 = Some(hash(&bytes));
    receipt.output_mime_type = Some(mime.into());
    receipt.conversion = Some(ReceiptConversion {
        format: match request.format {
            ArtifactFormat::Svg => "svg",
            ArtifactFormat::Png => "png",
        }
        .into(),
        theme: request.theme.name().into(),
        pixel_ratio: request.pixel_ratio,
    });
    receipt.gates.artifact = crate::gate("passed", scope);
    ArtifactReport {
        api_version: API_VERSION,
        ok: true,
        bytes: Some(bytes),
        svg: Some(svg),
        width: Some(width),
        height: Some(height),
        pixels_sha256,
        diagnostics: layout.diagnostics,
        text_mode: Some(text_mode),
        receipt,
    }
}
