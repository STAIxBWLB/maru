//! Stable SVG syntax; array order is the E2 scene order, never a map traversal.
use super::{error, SvgOptions, FONT_FAMILY, MAX_SVG_BYTES};
use crate::geometry::{GeometryBox, GeometryDocument, GeometryLabel, GeometryRoute};
use crate::Diagnostic;
use serde::Deserialize;
use std::fmt::Write;

/// Exact terminating fixed-point decimal, including negative fractions.
pub(crate) fn fixed(value: i64) -> String {
    decimal(value, 64, 6)
}
fn decimal(value: i64, denominator: i64, digits: u32) -> String {
    let sign = if value < 0 { "-" } else { "" };
    let n = i128::from(value).abs();
    let d = i128::from(denominator);
    let whole = n / d;
    let remainder = n % d;
    if remainder == 0 {
        return format!("{sign}{whole}");
    }
    let fraction = format!(
        "{:0width$}",
        remainder * 10_i128.pow(digits) / d,
        width = digits as usize
    );
    format!("{sign}{whole}.{}", fraction.trim_end_matches('0'))
}
pub(crate) fn scale(size: i32, upem: u16) -> String {
    decimal(i64::from(size), 64 * i64::from(upem), 9)
}
pub(crate) fn id(kind: &str, source: &str) -> String {
    let mut value = format!("maru-{kind}-");
    for byte in source.bytes() {
        write!(value, "{byte:02x}").expect("String writes cannot fail");
    }
    value
}
pub(crate) fn label_key(label: &GeometryLabel, index: usize) -> String {
    label
        .id
        .as_ref()
        .map_or_else(|| format!("index:{index}"), |id| format!("id:{id}"))
}
pub(crate) fn route_key(route: &GeometryRoute, index: usize) -> String {
    route
        .id
        .as_ref()
        .map_or_else(|| format!("index:{index}"), |id| format!("id:{id}"))
}
fn escaped(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\r', "&#13;")
        .replace('\n', "&#10;")
        .replace('\t', "&#9;")
}
fn valid_xml(value: &str) -> bool {
    value.chars().all(|c| {
        matches!(c, '\t' | '\n' | '\r') || {
            let n = c as u32;
            (32..=55295).contains(&n)
                || (57344..=65533).contains(&n)
                || (65536..=1114111).contains(&n)
        }
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Notdef {
    pub path: String,
    pub units_per_em: u16,
    pub source_sha256: String,
}
pub(crate) fn notdef(weight: u16) -> Result<Notdef, Diagnostic> {
    let value: serde_json::Value =
        serde_json::from_str(include_str!("notdef.json")).map_err(|cause| {
            error(
                "font-data",
                "/font",
                format!("glyph 0 outline data is invalid: {cause}"),
                "regenerate the pinned outline data with diagram-engine-e3-fonts.mjs",
            )
        })?;
    serde_json::from_value(value[weight.to_string()].clone()).map_err(|cause| {
        error(
            "font-weight",
            "/font",
            format!("glyph 0 outline is missing for weight {weight}: {cause}"),
            "use the pinned Noto weights 400 or 700 and regenerate outline data",
        )
    })
}
fn rect(
    out: &mut String,
    kind: &str,
    b: GeometryBox,
    radius: i64,
    style: (&str, &str, &str),
    dash: Option<&str>,
) {
    let (fill, stroke, width) = style;
    write!(out,"<rect data-kind=\"{kind}\" x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" rx=\"{}\" fill=\"{fill}\" stroke=\"{stroke}\" stroke-width=\"{width}\"",fixed(b.x.into()),fixed(b.y.into()),fixed(b.width.into()),fixed(b.height.into()),fixed(radius)).unwrap();
    if let Some(dash) = dash {
        write!(out, " stroke-dasharray=\"{dash}\"").unwrap();
    }
    out.push_str("/>");
}
fn caption(g: &GeometryDocument, target: &str) -> String {
    let labels: Vec<_> = g
        .labels
        .iter()
        .filter(|l| {
            l.target_id == target
                && !l.text.is_empty()
                && l.id
                    .as_ref()
                    .is_some_and(|id| id.starts_with(&format!("container:{target}:")))
        })
        .map(|l| l.text.as_str())
        .collect();
    if labels.is_empty() {
        target.into()
    } else {
        labels.join("; ")
    }
}
fn activation_kind<'a>(
    context: &'a super::SemanticContext,
    id: &str,
) -> Result<&'a str, Diagnostic> {
    let record = context.activations.get(id).ok_or_else(|| {
        error(
            "activation-source",
            "/options/semantics/activations",
            "activation geometry has no matching source type record",
            "provide the matching source spec or recompute its semantic context",
        )
    })?;
    let accepted = |value: &str| crate::common::COMPONENT_TYPES.contains(&value);
    Ok(record
        .explicit_type
        .as_deref()
        .filter(|value| accepted(value))
        .or_else(|| {
            record
                .participant_type
                .as_deref()
                .filter(|value| accepted(value))
        })
        .unwrap_or("external"))
}
fn route_paint(theme: super::SvgTheme, variant: Option<&str>) -> (&'static str, &'static str) {
    let tokens = theme.tokens();
    match variant {
        Some("emphasis") => (tokens.emphasis, "arrow-emphasis"),
        Some("security") => (
            theme.kind("security").expect("security token").stroke,
            "arrow-security",
        ),
        Some("dashed") => (
            theme.kind("database").expect("database token").stroke,
            "arrow-dashed",
        ),
        _ => (tokens.arrow, "arrow"),
    }
}
fn write_primitive(
    s: &mut String,
    p: &super::primitives::Primitive,
    t: &super::theme::Tokens,
    o: &SvgOptions,
) {
    use super::primitives::{Paint, Shape};
    let (fill, stroke) = match p.paint {
        Paint::Line => ("none", t.arrow),
        Paint::AccentLine => ("none", t.emphasis),
        Paint::SecurityLine => (
            "none",
            o.theme.kind("security").expect("security token").stroke,
        ),
        Paint::DashedLine => (
            "none",
            o.theme.kind("database").expect("database token").stroke,
        ),
        Paint::Node => {
            let color = o
                .theme
                .kind(p.paint_kind(o.semantics.as_ref().expect("semantic context validated")))
                .expect("semantic kind validated");
            (color.fill, color.stroke)
        }
        Paint::OutlineNode => {
            let color = o
                .theme
                .kind(p.paint_kind(o.semantics.as_ref().expect("semantic context validated")))
                .expect("semantic kind validated");
            ("none", color.stroke)
        }
        Paint::AccentFill => (t.emphasis, "none"),
    };
    let tag = match p.shape {
        Shape::Rect { .. } => "rect",
        Shape::Line { .. } => "line",
        Shape::Polyline { .. } => "polyline",
        Shape::Circle { .. } => "circle",
        Shape::Polygon { .. } => "polygon",
    };
    write!(
        s,
        "<{tag} id=\"{}\" data-kind=\"{}\" data-target-id=\"{}\" aria-hidden=\"true\"",
        id("primitive", &format!("{}:{}", p.kind, p.owner)),
        p.kind,
        escaped(&p.owner)
    )
    .unwrap();
    match &p.shape {
        Shape::Rect { bounds: b, radius } => write!(
            s,
            " x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" rx=\"{}\"",
            fixed(b.x.into()),
            fixed(b.y.into()),
            fixed(b.width.into()),
            fixed(b.height.into()),
            fixed((*radius).into())
        )
        .unwrap(),
        Shape::Line { from, to } => write!(
            s,
            " x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\"",
            fixed(from.x.into()),
            fixed(from.y.into()),
            fixed(to.x.into()),
            fixed(to.y.into())
        )
        .unwrap(),
        Shape::Circle { center, radius } => write!(
            s,
            " cx=\"{}\" cy=\"{}\" r=\"{}\"",
            fixed(center.x.into()),
            fixed(center.y.into()),
            fixed((*radius).into())
        )
        .unwrap(),
        Shape::Polyline { points } | Shape::Polygon { points } => {
            s.push_str(" points=\"");
            for (i, p) in points.iter().enumerate() {
                if i > 0 {
                    s.push(' ');
                }
                write!(s, "{},{}", fixed(p.x.into()), fixed(p.y.into())).unwrap();
            }
            s.push('"');
        }
    }
    write!(
        s,
        " fill=\"{fill}\" stroke=\"{stroke}\" stroke-width=\"{}\"",
        p.stroke
    )
    .unwrap();
    if let Some(dash) = p.dash {
        write!(s, " stroke-dasharray=\"{dash}\"").unwrap();
    }
    if p.arrow {
        write!(
            s,
            " marker-end=\"url(#{})\"",
            match p.paint {
                Paint::AccentLine => "arrow-emphasis",
                Paint::SecurityLine => "arrow-security",
                Paint::DashedLine => "arrow-dashed",
                _ => "arrow",
            }
        )
        .unwrap();
    }
    s.push_str("/>");
}

fn validate(g: &GeometryDocument, o: &SvgOptions) -> Result<(), Diagnostic> {
    let texts = std::iter::once(o.title.as_str())
        .chain(std::iter::once(o.description.as_str()))
        .chain(g.nodes.iter().map(|n| n.id.as_str()))
        .chain(
            g.containers
                .iter()
                .flat_map(|c| [c.id.as_str(), c.kind.as_str()]),
        )
        .chain(
            g.routes
                .iter()
                .flat_map(|r| [r.from.as_str(), r.to.as_str()]),
        )
        .chain(
            g.labels
                .iter()
                .flat_map(|l| [l.text.as_str(), l.target_id.as_str()]),
        )
        .chain(
            g.legend
                .entries
                .iter()
                .flat_map(|e| [e.key.as_str(), e.label.as_str()]),
        );
    if texts.into_iter().any(|s| !valid_xml(s)) {
        return Err(error(
            "xml-text",
            "/",
            "scene text contains a character forbidden by XML 1.0",
            "remove XML control characters from ids and visible text before rendering",
        ));
    }
    if o.title.trim().is_empty() || o.description.trim().is_empty() {
        return Err(error(
            "accessibility",
            "/options",
            "SVG title or description is empty",
            "provide a nonempty title and description from the document metadata",
        ));
    }
    if g.page.bounds.width <= 0 || g.page.bounds.height <= 0 {
        return Err(error(
            "page",
            "/page",
            "SVG page has nonpositive dimensions",
            "provide a retained layout with positive page width and height",
        ));
    }
    for b in g
        .nodes
        .iter()
        .map(|n| n.bounds)
        .chain(g.containers.iter().map(|c| c.bounds))
        .chain(g.labels.iter().map(|l| l.bounds))
        .chain(std::iter::once(g.legend.bounds))
        .chain(g.legend.content_bounds)
        .chain(g.legend.entries.iter().flat_map(|entry| {
            [Some(entry.bounds), entry.swatch_bounds, entry.text_bounds]
                .into_iter()
                .flatten()
        }))
    {
        if b.width < 0 || b.height < 0 || b.right().is_err() || b.bottom().is_err() {
            return Err(error(
                "bounds",
                "/geometry",
                "scene contains negative dimensions or overflowing bounds",
                "recompute bounded fixed-point geometry before rendering",
            ));
        }
    }
    if g.routes
        .iter()
        .any(|route| route.width.is_some_and(|width| width <= 0))
    {
        return Err(error(
            "route-width",
            "/routes",
            "explicit SVG route width is not positive",
            "provide a positive fixed-point width or omit it for the family default",
        ));
    }
    for l in &g.labels {
        let font = crate::metrics::font_identity(l.font.weight)?;
        if font != l.font || l.font_size <= 0 {
            return Err(error(
                "font",
                "/labels",
                "a label does not use the pinned font identity or has nonpositive size",
                "render geometry with the matching Noto metric tables and a positive font size",
            ));
        }
        let original = l.text.replace('\n', "");
        let glyph_text: String = l.glyphs.iter().map(|glyph| glyph.input.as_str()).collect();
        if original != glyph_text {
            return Err(error(
                "glyph-text",
                "/labels",
                "label glyph inputs do not reconstruct its source text",
                "regenerate the scene with the pinned text metrics before rendering",
            ));
        }
    }
    Ok(())
}
pub(crate) fn write(g: &GeometryDocument, o: &SvgOptions) -> Result<String, Diagnostic> {
    validate(g, o)?;
    let semantics = super::primitives::context(g, o)?;
    let primitives = super::primitives::derive(g, o)?;
    let t = o.theme.tokens();
    let b = g.page.bounds;
    let mut s = String::new();
    write!(s,"<svg xmlns=\"http://www.w3.org/2000/svg\" id=\"maru-svg\" role=\"img\" aria-labelledby=\"maru-title maru-desc\" viewBox=\"{} {} {} {}\" width=\"{}\" height=\"{}\" data-theme=\"{}\"><title id=\"maru-title\">{}</title><desc id=\"maru-desc\">{}</desc>",fixed(b.x.into()),fixed(b.y.into()),fixed(b.width.into()),fixed(b.height.into()),fixed(b.width.into()),fixed(b.height.into()),o.theme.name(),escaped(&o.title),escaped(&o.description)).unwrap();
    rect(&mut s, "page", b, 0, (t.background, "none", "0"), None);
    s.push_str("<defs>");
    for (key, color) in [
        ("arrow", t.arrow),
        ("arrow-emphasis", t.emphasis),
        (
            "arrow-security",
            o.theme.kind("security").expect("security token").stroke,
        ),
        (
            "arrow-dashed",
            o.theme.kind("database").expect("database token").stroke,
        ),
    ] {
        write!(s,"<marker id=\"{key}\" markerWidth=\"10\" markerHeight=\"7\" refX=\"9\" refY=\"3.5\" orient=\"auto\" markerUnits=\"strokeWidth\"><polygon points=\"0,0 10,3.5 0,7\" fill=\"{color}\"/></marker>").unwrap();
    }
    s.push_str("</defs>");
    for c in g.containers.iter().filter(|c| c.kind != "activation") {
        let radius = match c.kind.as_str() {
            "region" => 12,
            "lane" | "segment" | "stage" => 10,
            "group" => 9,
            "security-group" | "exception-lane" => 8,
            "phase" => 4,
            "activation" => 3,
            _ => 6,
        };
        let frame = o.theme.frame(
            &c.kind,
            semantics.frame_variants.get(&c.id).map(String::as_str),
        );
        write!(s,"<g id=\"{}\" data-kind=\"container\" data-source-id=\"{}\" role=\"group\" aria-label=\"{}\">",id("container",&c.id),escaped(&c.id),escaped(&caption(g,&c.id))).unwrap();
        rect(
            &mut s,
            "container-box",
            c.bounds,
            radius * 64,
            if c.kind == "phase" {
                (t.mask, "none", "0")
            } else {
                (frame.fill, frame.stroke, "1")
            },
            if matches!(c.kind.as_str(), "phase" | "card") {
                None
            } else {
                super::primitives::frame_dash(&c.kind, semantics, &c.id).or(Some(frame.dash))
            },
        );
        s.push_str("</g>");
    }
    for p in primitives
        .iter()
        .filter(|p| p.layer == super::primitives::Layer::Underlay)
    {
        write_primitive(&mut s, p, &t, o);
    }
    for c in g.containers.iter().filter(|c| c.kind == "activation") {
        write!(s,"<g id=\"{}\" data-kind=\"container\" data-source-id=\"{}\" role=\"group\" aria-label=\"{}\">",id("container",&c.id),escaped(&c.id),escaped(&caption(g,&c.id))).unwrap();
        let token = o
            .theme
            .kind(activation_kind(semantics, &c.id)?)
            .expect("component token");
        rect(
            &mut s,
            "activation-mask",
            c.bounds,
            3 * 64,
            (t.mask, "none", "0"),
            None,
        );
        rect(
            &mut s,
            "container-box",
            c.bounds,
            3 * 64,
            (token.fill, token.stroke, "1"),
            super::primitives::frame_dash(&c.kind, semantics, &c.id),
        );
        s.push_str("</g>");
    }
    // Routes precede opaque node boxes so endpoint stubs cannot paint through them.
    for (i, r) in g.routes.iter().enumerate() {
        let key = route_key(r, i);
        let emphasis = r.variant.as_deref() == Some("emphasis");
        let (color, marker) = route_paint(o.theme, r.variant.as_deref());
        write!(s,"<g id=\"{}\" data-kind=\"route\" data-source-id=\"{}\" role=\"group\" aria-label=\"{} → {}\"",id("route",&key),escaped(&key),escaped(&r.from),escaped(&r.to)).unwrap();
        if let Some(role) = &r.role {
            write!(s, " data-route-role=\"{}\"", escaped(role)).unwrap();
        }
        if let Some(variant) = &r.variant {
            write!(s, " data-route-variant=\"{}\"", escaped(variant)).unwrap();
        }
        s.push_str("><polyline data-kind=\"route-path\" points=\"");
        for (j, p) in r.points.iter().enumerate() {
            if j > 0 {
                s.push(' ');
            }
            write!(s, "{},{}", fixed(p.x.into()), fixed(p.y.into())).unwrap();
        }
        write!(
            s,
            "\" fill=\"none\" stroke=\"{color}\" stroke-width=\"{}\" marker-end=\"url(#{})\"",
            r.width.map(|width| fixed(width.into())).unwrap_or_else(|| {
                let width = if emphasis {
                    match (semantics.family.as_str(), semantics.schema_version) {
                        ("lifecycle", 1) => "2",
                        ("lifecycle", _) => "1.6",
                        _ => "1.8",
                    }
                } else {
                    match semantics.family.as_str() {
                        "architecture" => "1.5",
                        "lifecycle" => "1.1",
                        _ => "1.4",
                    }
                };
                width.into()
            }),
            marker
        )
        .unwrap();
        if let Some(dash) = super::primitives::dash(r.variant.as_deref()) {
            write!(s, " stroke-dasharray=\"{dash}\"").unwrap();
        }
        s.push_str("/></g>");
    }
    for n in &g.nodes {
        let radius = if semantics.family == "lifecycle" {
            7 * 64
        } else {
            6 * 64
        };
        let color = o
            .theme
            .kind(&semantics.nodes[&n.id].kind)
            .expect("semantic kind validated");
        write!(s,"<g id=\"{}\" data-kind=\"node\" data-source-id=\"{}\" role=\"group\" aria-label=\"{}\">",id("node",&n.id),escaped(&n.id),escaped(&super::primitives::node_caption(g,semantics,&n.id))).unwrap();
        rect(
            &mut s,
            "node-mask",
            n.bounds,
            radius,
            (t.mask, "none", "0"),
            None,
        );
        rect(
            &mut s,
            "node-box",
            n.bounds,
            radius,
            (color.fill, color.stroke, "1.5"),
            None,
        );
        s.push_str("</g>");
    }
    for e in &g.legend.entries {
        write!(
            s,
            "<g id=\"{}\" data-kind=\"legend-entry\" role=\"listitem\" aria-label=\"{}\">",
            id("legend", &e.key),
            escaped(&e.label)
        )
        .unwrap();
        rect(
            &mut s,
            "legend-entry-box",
            e.bounds,
            0,
            ("none", "none", "0"),
            None,
        );
        s.push_str("</g>");
    }
    for p in primitives
        .iter()
        .filter(|p| p.layer == super::primitives::Layer::Overlay)
    {
        write_primitive(&mut s, p, &t, o);
    }
    for (i, l) in g.labels.iter().enumerate() {
        let key = label_key(l, i);
        let colors = super::label_paint::colors(g, o, l);
        let color = colors.first().copied().unwrap_or(if l.font.weight == 700 {
            t.text
        } else {
            t.muted
        });
        write!(s,"<g id=\"{}\" data-kind=\"label\" data-source-id=\"{}\" data-target-id=\"{}\" role=\"group\" aria-label=\"{}\">",id("label",&key),escaped(&key),escaped(&l.target_id),escaped(&l.text)).unwrap();
        rect(
            &mut s,
            "label-bounds",
            l.bounds,
            0,
            ("none", "none", "0"),
            None,
        );
        write!(s,"<text data-kind=\"label-text\" font-family=\"{FONT_FAMILY}\" font-size=\"{}\" font-weight=\"{}\" font-kerning=\"none\" font-variant-ligatures=\"none\" text-rendering=\"geometricPrecision\" style=\"font-feature-settings:'liga' 0,'clig' 0,'calt' 0,'locl' 0,'kern' 0,'mark' 0,'mkmk' 0\" xml:space=\"preserve\" fill=\"{color}\" aria-hidden=\"true\">",fixed(l.font_size.into()),l.font.weight).unwrap();
        for (j, p) in l
            .glyphs
            .iter()
            .enumerate()
            .filter(|(_, p)| !p.ignored && !p.replaced)
        {
            write!(
                s,
                "<tspan data-kind=\"glyph\" data-index=\"{j}\" x=\"{}\" y=\"{}\" fill=\"{}\">{}</tspan>",
                fixed(p.position.x.into()),
                fixed(p.position.y.into()),
                colors[j],
                escaped(&p.input)
            )
            .unwrap();
        }
        s.push_str("</text>");
        for (j, p) in l
            .glyphs
            .iter()
            .enumerate()
            .filter(|(_, p)| !p.ignored && p.replaced)
        {
            let color = colors[j];
            let outline = notdef(l.font.weight)?;
            if outline.units_per_em != l.font.units_per_em
                || outline.source_sha256 != l.font.font_sha256
            {
                return Err(error(
                    "font-outline",
                    "/font",
                    "glyph0 outline and label font identities differ",
                    "regenerate glyph0 data from the pinned font sources before rendering",
                ));
            }
            write!(s,"<path data-kind=\"notdef\" data-index=\"{j}\" d=\"{}\" transform=\"translate({} {}) scale({} -{})\" fill=\"{color}\" aria-hidden=\"true\"/>",outline.path,fixed(p.position.x.into()),fixed(p.position.y.into()),scale(l.font_size,outline.units_per_em),scale(l.font_size,outline.units_per_em)).unwrap();
        }
        s.push_str("</g>");
        if s.len() > MAX_SVG_BYTES {
            return Err(error(
                "size",
                "/",
                "SVG exceeds the 16 MiB artifact limit",
                "split the scene into smaller diagrams before rendering",
            ));
        }
    }
    s.push_str("</svg>");
    if s.len() > MAX_SVG_BYTES {
        return Err(error(
            "size",
            "/",
            "SVG exceeds the 16 MiB artifact limit",
            "split the scene into smaller diagrams before rendering",
        ));
    }
    Ok(s)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixed_decimals_are_exact_for_signed_limits() {
        for n in [i32::MIN, -65, -1, 0, 1, 65, i32::MAX] {
            let s = fixed(n.into());
            assert_eq!(s.parse::<f64>().unwrap() * 64.0, f64::from(n));
        }
        assert_eq!(scale(1, 1000), "0.000015625");
    }
}
