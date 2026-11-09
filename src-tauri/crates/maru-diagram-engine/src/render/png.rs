//! Bounded rasterization of gate-approved engine SVG with pinned bundled fonts.
use super::{render_svg, SvgOptions};
use crate::{geometry::GeometryDocument, Diagnostic};
use resvg::{tiny_skia, usvg};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::{Arc, OnceLock};

pub const MAX_PNG_DIMENSION: u32 = 16_384;
pub const MAX_PNG_PIXELS: u64 = 64 * 1024 * 1024;
pub const MAX_PNG_BYTES: usize = 32 * 1024 * 1024;
const FAMILY: &str = "Noto Sans CJK KR";
const REGULAR: &[u8] = include_bytes!("fonts/NotoSansCJKkr-Regular.otf");
const BOLD: &[u8] = include_bytes!("fonts/NotoSansCJKkr-Bold.otf");
#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PngOptions {
    pub pixel_ratio: u32,
}
impl Default for PngOptions {
    fn default() -> Self {
        Self { pixel_ratio: 1 }
    }
}
#[derive(Debug, Clone)]
pub struct PngArtifact {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub pixels_sha256: String,
    pub svg_sha256: String,
}
fn error(kind: &str, cause: impl Into<String>, fix: &str) -> Diagnostic {
    super::error(&format!("png-{kind}"), "/png", cause, fix)
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn fonts() -> Result<Arc<usvg::fontdb::Database>, Diagnostic> {
    static DATABASE: OnceLock<Result<Arc<usvg::fontdb::Database>, Diagnostic>> = OnceLock::new();
    DATABASE
        .get_or_init(|| {
            let mut database = usvg::fontdb::Database::new();
            for (weight, data) in [(400, REGULAR), (700, BOLD)] {
                let identity = crate::metrics::font_identity(weight)?;
                if hash(data) != identity.font_sha256 {
                    return Err(error(
                        "font-hash",
                        format!(
                            "bundled Noto weight {weight} differs from its pinned metric source"
                        ),
                        "restore the bundled font from the pinned metrics manifest and rebuild",
                    ));
                }
                database.load_font_data(data.to_vec());
            }
            database.set_sans_serif_family(FAMILY);
            database.set_serif_family(FAMILY);
            database.set_monospace_family(FAMILY);
            if database.faces().count() != 2 {
                return Err(error(
                    "font-load",
                    "bundled Noto fonts did not yield both pinned faces",
                    "restore the original regular and bold font files and rebuild",
                ));
            }
            Ok(Arc::new(database))
        })
        .as_ref()
        .map(Arc::clone)
        .map_err(Clone::clone)
}
pub fn dimensions(g: &GeometryDocument, options: PngOptions) -> Result<(u32, u32), Diagnostic> {
    if !(1..=4).contains(&options.pixel_ratio) {
        return Err(error(
            "ratio",
            "PNG pixelRatio must be an integer from 1 through 4",
            "use pixelRatio 1, 2, 3 or 4 and retry",
        ));
    }
    let dimension = |value: i32| -> Result<u32, Diagnostic> {
        if value <= 0 {
            return Err(error(
                "size",
                "PNG page dimension is not positive",
                "recompute positive engine geometry before rasterizing",
            ));
        }
        let numerator = u64::try_from(value)
            .expect("positive i32")
            .checked_mul(u64::from(options.pixel_ratio))
            .expect("bounded ratio");
        let pixels = numerator.div_ceil(64);
        if pixels > u64::from(MAX_PNG_DIMENSION) {
            return Err(error(
                "size",
                format!("PNG dimension {pixels} exceeds {MAX_PNG_DIMENSION}px"),
                "reduce the scene extent or pixelRatio and retry",
            ));
        }
        Ok(pixels as u32)
    };
    let (width, height) = (
        dimension(g.page.bounds.width)?,
        dimension(g.page.bounds.height)?,
    );
    if u64::from(width) * u64::from(height) > MAX_PNG_PIXELS {
        return Err(error(
            "pixels",
            format!(
                "PNG needs {} pixels, exceeding {MAX_PNG_PIXELS}",
                u64::from(width) * u64::from(height)
            ),
            "reduce the scene extent or pixelRatio and retry",
        ));
    }
    Ok((width, height))
}
pub fn render_png(
    g: &GeometryDocument,
    svg_options: &SvgOptions,
    options: PngOptions,
) -> Result<PngArtifact, Vec<Diagnostic>> {
    let (width, height) = dimensions(g, options).map_err(|error| vec![error])?;
    let svg = render_svg(g, svg_options);
    if !svg.ok {
        return Err(svg.diagnostics);
    }
    let svg = svg.svg.expect("successful SVG includes bytes");
    rasterize(&svg, width, height, svg_options, options).map_err(|error| vec![error])
}
pub(crate) fn rasterize(
    svg: &str,
    width: u32,
    height: u32,
    svg_options: &SvgOptions,
    options: PngOptions,
) -> Result<PngArtifact, Diagnostic> {
    // These resolvers cannot load files, URLs or data images, even if the SVG
    // gate is accidentally relaxed later. Only our two bundled font faces exist.
    let parser = usvg::Options {
        font_family: FAMILY.into(),
        fontdb: fonts()?,
        image_href_resolver: usvg::ImageHrefResolver {
            resolve_data: Box::new(|_, _, _| None),
            resolve_string: Box::new(|_, _| None),
        },
        ..usvg::Options::default()
    };
    let tree = usvg::Tree::from_str(svg, &parser).map_err(|cause| {
        error(
            "parse",
            format!("gate-approved SVG could not be parsed for PNG: {cause}"),
            "rebuild matching SVG and rasterizer versions and retry",
        )
    })?;
    let mut pixmap = tiny_skia::Pixmap::new(width, height).ok_or_else(|| {
        error(
            "allocation",
            "PNG pixel buffer could not be allocated",
            "reduce pixelRatio or scene size, close other exports, and retry",
        )
    })?;
    let background = svg_options.theme.tokens().background;
    let rgb =
        u32::from_str_radix(background.strip_prefix('#').unwrap_or(""), 16).map_err(|_| {
            error(
                "background",
                "theme background is not a six-digit RGB token",
                "restore the named theme tokens and rebuild",
            )
        })?;
    pixmap.fill(tiny_skia::Color::from_rgba8(
        (rgb >> 16) as u8,
        (rgb >> 8) as u8,
        rgb as u8,
        255,
    ));
    resvg::render(
        &tree,
        tiny_skia::Transform::from_scale(options.pixel_ratio as f32, options.pixel_ratio as f32),
        &mut pixmap.as_mut(),
    );
    let bytes = pixmap.encode_png().map_err(|cause| {
        error(
            "encode",
            format!("PNG encoding failed: {cause}"),
            "reduce scene size or rebuild the rasterizer and retry",
        )
    })?;
    if bytes.len() > MAX_PNG_BYTES {
        return Err(error(
            "bytes",
            format!("PNG size {} exceeds {MAX_PNG_BYTES} bytes", bytes.len()),
            "reduce scene size or pixelRatio and retry",
        ));
    }
    let decoded = tiny_skia::Pixmap::decode_png(&bytes).map_err(|cause| {
        error(
            "readback",
            format!("encoded PNG failed its decode gate: {cause}"),
            "rebuild the PNG encoder and retry",
        )
    })?;
    if decoded.width() != width || decoded.height() != height || decoded.data() != pixmap.data() {
        return Err(error(
            "readback",
            "decoded PNG pixels differ from the rasterized page",
            "rebuild matching rasterizer/encoder versions and retry",
        ));
    }
    Ok(PngArtifact {
        pixels_sha256: hash(decoded.data()),
        svg_sha256: crate::spec_hash(svg),
        bytes,
        width,
        height,
    })
}
