//! Pure SVG output from retained fixed-point geometry. No layout or host access.
mod gate;
mod primitive_gate;
mod primitives;
pub mod semantics;
pub mod svg;
mod theme;
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
}
impl SvgOptions {
    pub fn from_spec(spec: &serde_json::Value, theme: SvgTheme) -> Result<Self, Diagnostic> {
        Ok(Self {
            semantics: Some(SemanticContext::from_spec(spec)?),
            theme,
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
