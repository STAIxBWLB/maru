//! Independent checks for SVG elements that carry diagram-family meaning.

use super::primitives::{self, Layer, Paint, Primitive, Shape};
use super::{error, svg, SvgOptions};
use crate::geometry::{GeometryDocument, GeometryPoint};
use crate::Diagnostic;
use roxmltree::{Document, Node};
use std::collections::BTreeMap;

const NS: &str = "http://www.w3.org/2000/svg";

fn fail(rule: &str, path: &str, cause: impl Into<String>) -> Diagnostic {
    error(
        &format!("primitive-{rule}"),
        path,
        cause,
        "regenerate the semantic SVG primitive from retained source geometry and semantics",
    )
}

fn elements<'a, 'input>(node: Node<'a, 'input>) -> impl Iterator<Item = Node<'a, 'input>> {
    node.children().filter(|child| child.is_element())
}

fn number(node: Node<'_, '_>, name: &str) -> Option<f64> {
    let value = node.attribute(name)?.trim().parse::<f64>().ok()?;
    value.is_finite().then_some(value)
}

fn close(actual: Option<f64>, expected: f64) -> bool {
    actual.is_some_and(|actual| (actual - expected).abs() <= 1.0 / 64.0)
}

fn check_number(
    node: Node<'_, '_>,
    name: &str,
    expected: i32,
    path: &str,
    errors: &mut Vec<Diagnostic>,
) {
    if !close(number(node, name), expected as f64 / 64.0) {
        errors.push(fail(
            "coordinate",
            path,
            format!("primitive {name} is missing, non-finite, or differs from derived geometry"),
        ));
    }
}

fn check_points(
    actual: Option<&str>,
    expected: &[GeometryPoint],
    path: &str,
    errors: &mut Vec<Diagnostic>,
) {
    let parsed: Option<Vec<(f64, f64)>> = actual
        .unwrap_or_default()
        .split_whitespace()
        .map(|point| {
            let (x, y) = point.split_once(',')?;
            let x = x.parse::<f64>().ok()?;
            let y = y.parse::<f64>().ok()?;
            (x.is_finite() && y.is_finite()).then_some((x, y))
        })
        .collect();
    let matches = parsed.is_some_and(|points| {
        points.len() == expected.len()
            && points.iter().zip(expected).all(|((x, y), point)| {
                x.is_finite()
                    && y.is_finite()
                    && (*x - point.x as f64 / 64.0).abs() <= 1.0 / 64.0
                    && (*y - point.y as f64 / 64.0).abs() <= 1.0 / 64.0
            })
    });
    if !matches {
        errors.push(fail(
            "points",
            path,
            "primitive point sequence differs from the semantic geometry model",
        ));
    }
}

fn expected_element(primitive: &Primitive) -> &'static str {
    match &primitive.shape {
        Shape::Rect { .. } => "rect",
        Shape::Line { .. } => "line",
        Shape::Polyline { .. } => "polyline",
        Shape::Circle { .. } => "circle",
        Shape::Polygon { .. } => "polygon",
    }
}

fn expected_paint(primitive: &Primitive, options: &SvgOptions) -> (&'static str, &'static str) {
    let theme = options.theme.tokens();
    match primitive.paint {
        Paint::Line => ("none", theme.arrow),
        Paint::AccentLine => ("none", theme.emphasis),
        Paint::Node => {
            let color = options
                .theme
                .kind(primitive.paint_kind(options.semantics.as_ref().expect("context validated")))
                .expect("kind validated");
            (color.fill, color.stroke)
        }
        Paint::OutlineNode => {
            let color = options
                .theme
                .kind(primitive.paint_kind(options.semantics.as_ref().expect("context validated")))
                .expect("kind validated");
            ("none", color.stroke)
        }
        Paint::AccentFill => (theme.emphasis, "none"),
    }
}

fn validate_one(
    node: Node<'_, '_>,
    primitive: &Primitive,
    options: &SvgOptions,
    errors: &mut Vec<Diagnostic>,
) {
    let path = format!("/primitives/{}/{}", primitive.kind, primitive.owner);
    let expected_id = svg::id(
        "primitive",
        &format!("{}:{}", primitive.kind, primitive.owner),
    );
    for (name, expected) in [
        ("id", expected_id.as_str()),
        ("data-kind", primitive.kind),
        ("data-target-id", primitive.owner.as_str()),
        ("aria-hidden", "true"),
    ] {
        if node.attribute(name) != Some(expected) {
            errors.push(fail(
                "identity",
                &path,
                format!("primitive {name} does not identify its semantic owner and kind"),
            ));
        }
    }
    if node.tag_name().namespace() != Some(NS)
        || node.tag_name().name() != expected_element(primitive)
    {
        errors.push(fail(
            "element",
            &path,
            format!(
                "{} primitive must use an SVG {} element",
                primitive.kind,
                expected_element(primitive)
            ),
        ));
    }
    if node
        .parent_element()
        .is_none_or(|parent| parent.tag_name().name() != "svg")
    {
        errors.push(fail(
            "placement",
            &path,
            "semantic primitive is not a direct child of the SVG root",
        ));
    }
    let shape_attributes: &[&str] = match &primitive.shape {
        Shape::Rect { .. } => &["x", "y", "width", "height", "rx"],
        Shape::Line { .. } => &["x1", "y1", "x2", "y2"],
        Shape::Polyline { .. } | Shape::Polygon { .. } => &["points"],
        Shape::Circle { .. } => &["cx", "cy", "r"],
    };
    for attribute in node.attributes() {
        if attribute.namespace().is_some()
            || (!matches!(
                attribute.name(),
                "id" | "data-kind"
                    | "data-target-id"
                    | "aria-hidden"
                    | "fill"
                    | "stroke"
                    | "stroke-width"
                    | "stroke-dasharray"
                    | "marker-end"
            ) && !shape_attributes.contains(&attribute.name()))
        {
            errors.push(fail(
                "attribute",
                &path,
                format!("primitive has unsupported attribute {:?}", attribute.name()),
            ));
        }
    }
    if elements(node).next().is_some()
        || node
            .children()
            .any(|child| child.is_text() && !child.text().unwrap_or("").trim().is_empty())
    {
        errors.push(fail(
            "content",
            &path,
            "semantic primitive contains unexpected nested or text content",
        ));
    }
    let (fill, stroke) = expected_paint(primitive, options);
    for (name, expected) in [
        ("fill", fill),
        ("stroke", stroke),
        ("stroke-width", primitive.stroke),
    ] {
        if node.attribute(name) != Some(expected) {
            errors.push(fail(
                "paint",
                &path,
                format!("primitive {name} does not match its semantic paint contract"),
            ));
        }
    }
    if node.attribute("stroke-dasharray") != primitive.dash {
        errors.push(fail(
            "dash",
            &path,
            "primitive dash pattern differs from semantic variant",
        ));
    }
    let arrow = if primitive.arrow {
        Some(if primitive.paint == Paint::AccentLine {
            "url(#arrow-emphasis)"
        } else {
            "url(#arrow)"
        })
    } else {
        None
    };
    if node.attribute("marker-end") != arrow {
        errors.push(fail(
            "arrow",
            &path,
            "primitive arrow marker differs from semantic variant",
        ));
    }

    match &primitive.shape {
        Shape::Rect { bounds, radius } => {
            for (name, expected) in [
                ("x", bounds.x),
                ("y", bounds.y),
                ("width", bounds.width),
                ("height", bounds.height),
                ("rx", *radius),
            ] {
                check_number(node, name, expected, &path, errors);
            }
        }
        Shape::Line { from, to } => {
            for (name, expected) in [("x1", from.x), ("y1", from.y), ("x2", to.x), ("y2", to.y)] {
                check_number(node, name, expected, &path, errors);
            }
        }
        Shape::Polyline { points } | Shape::Polygon { points } => {
            check_points(node.attribute("points"), points, &path, errors);
        }
        Shape::Circle { center, radius } => {
            for (name, expected) in [("cx", center.x), ("cy", center.y), ("r", *radius)] {
                check_number(node, name, expected, &path, errors);
            }
        }
    }
}

/// Check primitive SVG elements against the semantic model derived from source geometry.
pub(crate) fn check_primitives(
    doc: &Document<'_>,
    geometry: &GeometryDocument,
    options: &SvgOptions,
) -> Vec<Diagnostic> {
    let expected = match primitives::derive(geometry, options) {
        Ok(primitives) => primitives,
        Err(diagnostic) => return vec![diagnostic],
    };
    let mut errors = Vec::new();
    let actual: Vec<_> = doc
        .descendants()
        .filter(|node| {
            node.is_element()
                && node
                    .attribute("data-kind")
                    .is_some_and(|kind| primitives::KINDS.contains(&kind))
        })
        .collect();
    let mut expected_counts = BTreeMap::<&str, usize>::new();
    let mut actual_counts = BTreeMap::<&str, usize>::new();
    for primitive in &expected {
        *expected_counts.entry(primitive.kind).or_default() += 1;
    }
    for node in &actual {
        if let Some(kind) = node.attribute("data-kind") {
            *actual_counts.entry(kind).or_default() += 1;
        }
    }
    for kind in primitives::KINDS {
        let expected_count = expected_counts.get(kind).copied().unwrap_or(0);
        let actual_count = actual_counts.get(kind).copied().unwrap_or(0);
        if expected_count != actual_count {
            errors.push(fail(
                "count",
                &format!("/svg/primitives/{kind}"),
                format!("SVG has {actual_count} {kind} primitive(s), expected {expected_count}"),
            ));
        }
    }
    for primitive in &expected {
        let id = svg::id(
            "primitive",
            &format!("{}:{}", primitive.kind, primitive.owner),
        );
        match actual
            .iter()
            .find(|node| node.attribute("id") == Some(id.as_str()))
        {
            Some(node) => validate_one(*node, primitive, options, &mut errors),
            None => errors.push(fail(
                "missing",
                &format!("/primitives/{}/{}", primitive.kind, primitive.owner),
                "semantic primitive id is absent from the SVG artifact",
            )),
        }
    }
    let mut expected_order = Vec::new();
    expected_order.extend(expected.iter().filter(|p| p.layer == Layer::Underlay));
    expected_order.extend(expected.iter().filter(|p| p.layer == Layer::Overlay));
    let actual_order: Vec<_> = actual
        .iter()
        .filter_map(|node| node.attribute("id"))
        .collect();
    let expected_ids: Vec<_> = expected_order
        .iter()
        .map(|p| svg::id("primitive", &format!("{}:{}", p.kind, p.owner)))
        .collect();
    if actual_order.len() != expected_ids.len()
        || actual_order
            .iter()
            .zip(expected_ids.iter())
            .any(|(actual, expected)| *actual != expected)
    {
        errors.push(fail(
            "order",
            "/svg/primitives",
            "semantic primitives are not in the derived underlay and overlay order",
        ));
    }
    errors
}
