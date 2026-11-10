//! Geometry-based SVG/PNG and source-bound artifact orchestration, without host access.
mod artifact;
mod gate;
#[cfg(feature = "render-png")]
pub use artifact::render_png_artifact_json;
#[cfg(feature = "render-outline")]
pub use artifact::render_svg_artifact_json;
pub use artifact::{render_artifact_json, ArtifactFormat, ArtifactReport};
mod label_paint;
mod legend_gate;
#[cfg(feature = "render-outline")]
pub mod outline;
#[cfg(feature = "render-png")]
pub mod png;
#[cfg(feature = "png-corpus")]
pub mod png_corpus;
mod primitive_gate;
mod primitives;
pub mod semantics;
pub mod svg;
mod theme;
mod xml_gate;
use crate::{geometry::GeometryDocument, Diagnostic, API_VERSION};
pub use gate::check_svg_artifact;
pub use semantics::{NodeSemantic, SemanticContext};
use serde::{Deserialize, Serialize};
pub use theme::SvgTheme;

pub const FONT_FAMILY: &str = "Noto Sans CJK KR, sans-serif";
pub const MAX_SVG_BYTES: usize = 16 * 1024 * 1024;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SvgOptions {
    pub theme: SvgTheme,
    pub title: String,
    pub description: String,
    #[serde(default)]
    pub semantics: Option<SemanticContext>,
    /// How label text is emitted. `Text` is the pinned glyph run the viewer
    /// resolves with `FONT_FAMILY`; `Outlines` draws the same glyphs as paths
    /// from the pinned faces, so the artifact needs no installed font
    /// (`maru#552`). Absent reads as `Text`.
    #[serde(default)]
    pub text_mode: SvgTextMode,
}

/// Label emission for the SVG writer.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SvgTextMode {
    /// Positioned `<text>` runs that name `FONT_FAMILY`.
    #[default]
    Text,
    /// The same positions as glyph outlines, with no font dependency.
    Outlines,
}
impl SvgOptions {
    pub fn from_spec(spec: &serde_json::Value, theme: SvgTheme) -> Result<Self, Diagnostic> {
        Ok(Self {
            semantics: Some(SemanticContext::from_spec(spec)?),
            theme,
            text_mode: SvgTextMode::Text,
            title: spec
                .pointer("/meta/title")
                .and_then(|v| v.as_str())
                .unwrap_or("Diagram")
                .into(),
            description: spec
                .pointer("/meta/subtitle")
                .and_then(|v| v.as_str())
                .filter(|text| !text.trim().is_empty())
                .or_else(|| spec.get("diagram_type").and_then(|v| v.as_str()))
                .unwrap_or("Diagram geometry")
                .into(),
        })
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SvgReport {
    pub api_version: u32,
    pub ok: bool,
    pub svg: Option<String>,
    pub diagnostics: Vec<Diagnostic>,
}
pub(crate) fn error(suffix: &str, path: &str, cause: impl Into<String>, fix: &str) -> Diagnostic {
    Diagnostic {
        code: format!("document/svg-{suffix}"),
        path: path.into(),
        rule: format!("render-v1/svg-{suffix}"),
        message: cause.into(),
        fix: fix.into(),
    }
}
pub fn render_svg(geometry: &GeometryDocument, options: &SvgOptions) -> SvgReport {
    match svg::write(geometry, options) {
        Ok(svg) => {
            let diagnostics = check_svg_artifact(&svg, geometry, options);
            SvgReport {
                api_version: API_VERSION,
                ok: diagnostics.is_empty(),
                svg: Some(svg),
                diagnostics,
            }
        }
        Err(diagnostic) => SvgReport {
            api_version: API_VERSION,
            ok: false,
            svg: None,
            diagnostics: vec![diagnostic],
        },
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SvgRequest {
    geometry: GeometryDocument,
    options: SvgOptions,
    #[serde(default)]
    spec_json: Option<String>,
}
pub fn render_svg_json(input: &str) -> SvgReport {
    let failed = |diagnostic| SvgReport {
        api_version: API_VERSION,
        ok: false,
        svg: None,
        diagnostics: vec![diagnostic],
    };
    if input.len() > MAX_SVG_BYTES {
        return failed(error(
            "request-size",
            "/",
            "SVG request exceeds the 16 MiB rendering limit",
            "split the scene into smaller diagrams before rendering",
        ));
    }
    match serde_json::from_str::<SvgRequest>(input) {
        Ok(mut request) => {
            if let Some(source)=&request.spec_json {
                let spec:serde_json::Value=match serde_json::from_str(source) {
                    Ok(spec)=>spec,
                    Err(cause)=>return failed(error("semantic-source","/specJson",format!("source spec cannot be decoded: {cause}"),"provide the matching source snapshot as valid JSON")),
                };
                request.options.semantics=match SemanticContext::from_spec(&spec) {Ok(context)=>Some(context),Err(cause)=>return failed(cause)};
            }
            render_svg(&request.geometry,&request.options)
        },
        Err(cause)=>failed(error("request","/",format!("SVG request cannot be decoded: {cause}"),"provide geometry and options with theme, title and description in the render-v1 request")),
    }
}
