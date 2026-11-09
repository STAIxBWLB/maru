//! Containment of the invisible legend content extent, independent of writing.
use super::primitives::{Primitive, Shape};
use crate::{
    geometry::{GeometryBox, GeometryDocument},
    Diagnostic,
};

fn contains(bounds: GeometryBox, left: f64, top: f64, right: f64, bottom: f64) -> bool {
    let unit = 64.0;
    let tolerance = 1.0 / unit;
    left >= f64::from(bounds.x) / unit - tolerance
        && top >= f64::from(bounds.y) / unit - tolerance
        && right <= (f64::from(bounds.x) + f64::from(bounds.width)) / unit + tolerance
        && bottom <= (f64::from(bounds.y) + f64::from(bounds.height)) / unit + tolerance
}
fn error(cause: impl Into<String>) -> Diagnostic {
    super::error("legend-containment","/legend/contentBounds",cause,"recompute legend content bounds from all title, text and swatch paint extents before rendering")
}
fn box_inside(outer: GeometryBox, inner: GeometryBox) -> bool {
    contains(
        outer,
        f64::from(inner.x) / 64.0,
        f64::from(inner.y) / 64.0,
        (f64::from(inner.x) + f64::from(inner.width)) / 64.0,
        (f64::from(inner.y) + f64::from(inner.height)) / 64.0,
    )
}
pub(crate) fn check(g: &GeometryDocument, primitives: &[Primitive]) -> Vec<Diagnostic> {
    let labels: Vec<_> = g
        .labels
        .iter()
        .filter(|label| label.target_id == "legend")
        .collect();
    let items: Vec<_> = primitives
        .iter()
        .filter(|primitive| primitive.kind.starts_with("legend-"))
        .collect();
    if g.legend.entries.is_empty() && labels.is_empty() && items.is_empty() {
        return Vec::new();
    }
    let Some(bounds) = g.legend.content_bounds else {
        return vec![error("visible legend has no retained content bounds")];
    };
    let mut errors = Vec::new();
    if bounds.width < 0 || bounds.height < 0 || bounds.right().is_err() || bounds.bottom().is_err()
    {
        return vec![error(
            "legend content bounds have negative dimensions or overflow",
        )];
    }
    for label in labels {
        if !box_inside(bounds, label.bounds) {
            errors.push(error(format!(
                "legend label {:?} exceeds its content extent",
                label.id
            )));
        }
    }
    for entry in &g.legend.entries {
        for part in [Some(entry.bounds), entry.text_bounds, entry.swatch_bounds]
            .into_iter()
            .flatten()
        {
            if !box_inside(bounds, part) {
                errors.push(error(format!(
                    "legend entry {:?} exceeds its content extent",
                    entry.key
                )));
            }
        }
    }
    for primitive in items {
        let stroke = primitive.stroke.parse::<f64>().unwrap_or(f64::INFINITY);
        let mut points = Vec::<(f64, f64)>::new();
        match &primitive.shape {
            Shape::Rect { bounds, .. } => {
                points.push((f64::from(bounds.x) / 64.0, f64::from(bounds.y) / 64.0));
                points.push((
                    (f64::from(bounds.x) + f64::from(bounds.width)) / 64.0,
                    (f64::from(bounds.y) + f64::from(bounds.height)) / 64.0,
                ));
            }
            Shape::Circle { center, radius } => {
                let (x, y, r) = (
                    f64::from(center.x) / 64.0,
                    f64::from(center.y) / 64.0,
                    f64::from(*radius) / 64.0,
                );
                points.extend([(x - r, y - r), (x + r, y + r)]);
            }
            Shape::Line { from, to } => {
                points.push((f64::from(from.x) / 64.0, f64::from(from.y) / 64.0));
                points.push((f64::from(to.x) / 64.0, f64::from(to.y) / 64.0));
            }
            Shape::Polyline { points: source } | Shape::Polygon { points: source } => {
                points.extend(
                    source
                        .iter()
                        .map(|point| (f64::from(point.x) / 64.0, f64::from(point.y) / 64.0)),
                );
            }
        }
        if primitive.arrow && points.len() >= 2 {
            let tip = points[points.len() - 1];
            let from = points[points.len() - 2];
            let dx = tip.0 - from.0;
            let dy = tip.1 - from.1;
            let length = dx.hypot(dy);
            if length > 0.0 {
                for (x, y) in [(-9.0, -3.5), (1.0, 0.0), (-9.0, 3.5)] {
                    points.push((
                        tip.0 + (x * dx - y * dy) / length * stroke,
                        tip.1 + (x * dy + y * dx) / length * stroke,
                    ));
                }
            }
        }
        let left = points
            .iter()
            .map(|point| point.0)
            .fold(f64::INFINITY, f64::min)
            - stroke / 2.0;
        let right = points
            .iter()
            .map(|point| point.0)
            .fold(f64::NEG_INFINITY, f64::max)
            + stroke / 2.0;
        let top = points
            .iter()
            .map(|point| point.1)
            .fold(f64::INFINITY, f64::min)
            - stroke / 2.0;
        let bottom = points
            .iter()
            .map(|point| point.1)
            .fold(f64::NEG_INFINITY, f64::max)
            + stroke / 2.0;
        if ![left, top, right, bottom]
            .iter()
            .all(|value| value.is_finite())
            || !contains(bounds, left, top, right, bottom)
        {
            errors.push(error(format!(
                "legend {} {:?} paint exceeds its content extent",
                primitive.kind, primitive.owner
            )));
        }
    }
    errors
}
