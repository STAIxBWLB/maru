//! Independent checks for SVG elements that carry diagram-family meaning.

use super::primitives::{self, Layer, Paint, Primitive, Shape};
use super::{error, svg, SvgOptions};
use crate::geometry::{GeometryDocument, GeometryPoint};
use crate::Diagnostic;
use roxmltree::{Document, Node};
use std::collections::BTreeMap;

// This intentionally does not call primitives::derive(): it is the oracle for
// that writer. Keep geometry formulas here tied to the retained E2 fields and
// the source semantic context, not to the writer's fallback/layout helpers.
fn expected_primitive(
    kind: &'static str,
    owner: &str,
    shape: Shape,
    paint: Paint,
    stroke: &'static str,
    layer: Layer,
) -> Primitive {
    Primitive {
        kind,
        owner: owner.into(),
        shape,
        paint,
        stroke,
        dash: None,
        arrow: false,
        layer,
    }
}

fn reference_dash(variant: Option<&str>) -> Option<&'static str> {
    match variant {
        Some("return") => Some("3 5"),
        Some("security") => Some("5 5"),
        Some("dashed") => Some("4 4"),
        _ => None,
    }
}

fn point(x: i64, y: i64) -> GeometryPoint {
    GeometryPoint {
        x: x as i32,
        y: y as i32,
    }
}

fn line_primitive(
    kind: &'static str,
    owner: &str,
    from: GeometryPoint,
    to: GeometryPoint,
    paint: Paint,
    stroke: &'static str,
    layer: Layer,
) -> Primitive {
    expected_primitive(kind, owner, Shape::Line { from, to }, paint, stroke, layer)
}

fn initial_reference(
    out: &mut Vec<Primitive>,
    owner: &str,
    dot: GeometryPoint,
    tip: GeometryPoint,
    legend: bool,
) {
    let kinds = if legend {
        [
            "legend-initial-dot",
            "legend-initial-stem",
            "legend-initial-head",
        ]
    } else {
        [
            "lifecycle-initial-dot",
            "lifecycle-initial-stem",
            "lifecycle-initial-head",
        ]
    };
    out.push(expected_primitive(
        kinds[0],
        owner,
        Shape::Circle {
            center: dot,
            radius: 288,
        },
        Paint::AccentFill,
        "0",
        Layer::Overlay,
    ));
    let mut stem = line_primitive(
        kinds[1],
        owner,
        point(i64::from(dot.x) + 288, i64::from(dot.y)),
        point(i64::from(tip.x) - 384, i64::from(tip.y)),
        Paint::AccentLine,
        "1.4",
        Layer::Overlay,
    );
    stem.arrow = false;
    out.push(stem);
    out.push(expected_primitive(
        kinds[2],
        owner,
        Shape::Polygon {
            points: vec![
                point(i64::from(tip.x) - 448, i64::from(tip.y) - 224),
                tip,
                point(i64::from(tip.x) - 448, i64::from(tip.y) + 224),
            ],
        },
        Paint::AccentFill,
        "0",
        Layer::Overlay,
    ));
}

fn reference_width(family: &str, version: u32, key: &str) -> &'static str {
    if key == "emphasis" {
        if family == "lifecycle" {
            if version == 1 {
                "2"
            } else {
                "1.6"
            }
        } else {
            "1.8"
        }
    } else if family == "sequence" || family == "dataflow" {
        "1.4"
    } else if family == "lifecycle" {
        "1.1"
    } else if family == "workflow" {
        "1.4"
    } else {
        "1.5"
    }
}

pub(crate) fn expected(g: &GeometryDocument, options: &SvgOptions) -> Vec<Primitive> {
    let c = options
        .semantics
        .as_ref()
        .expect("context validated by SVG writer");
    let mut out = Vec::new();
    if c.family == "workflow" {
        for frame in g.containers.iter().filter(|f| f.kind == "phase") {
            let variant = c.frame_variants.get(&frame.id).map(String::as_str);
            let y = i64::from(frame.bounds.y) + i64::from(frame.bounds.height) / 2;
            let mut p = line_primitive(
                "workflow-phase-span",
                &frame.id,
                point(i64::from(frame.bounds.x), y),
                point(i64::from(frame.bounds.x) + i64::from(frame.bounds.width), y),
                if variant == Some("emphasis") {
                    Paint::AccentLine
                } else {
                    Paint::Line
                },
                "1.1",
                Layer::Underlay,
            );
            p.dash = reference_dash(variant);
            out.push(p);
        }
    }
    if c.family == "sequence" {
        let page_bottom = i64::from(g.page.bounds.y) + i64::from(g.page.bounds.height) - 65 * 64;
        let legend_clearance = g.legend.title_y.map_or(page_bottom, |title_y| {
            page_bottom.min(i64::from(title_y) - 22 * 64)
        });
        let route_bottom = g
            .routes
            .iter()
            .flat_map(|r| r.points.iter().map(|p| i64::from(p.y)))
            .chain(
                g.containers
                    .iter()
                    .filter(|f| f.kind == "activation" || f.kind == "segment")
                    .map(|f| i64::from(f.bounds.y) + i64::from(f.bounds.height)),
            )
            .max()
            .unwrap_or(0);
        let card_clearance = g
            .containers
            .iter()
            .filter(|f| f.kind == "card")
            .map(|f| i64::from(f.bounds.y) - 22 * 64)
            .min()
            .unwrap_or(legend_clearance);
        let end = legend_clearance.min(card_clearance).max(route_bottom);
        for n in &g.nodes {
            let center_x = i64::from(n.bounds.x) + i64::from(n.bounds.width) / 2;
            let bottom = i64::from(n.bounds.y) + i64::from(n.bounds.height);
            let mut p = line_primitive(
                "sequence-lifeline",
                &n.id,
                point(center_x, bottom),
                point(center_x, end.max(bottom)),
                Paint::Line,
                "0.8",
                Layer::Underlay,
            );
            p.dash = Some("3 7");
            out.push(p);
        }
    }
    if c.family == "lifecycle" {
        let mut bands: BTreeMap<&str, Vec<&crate::geometry::GeometryNode>> = BTreeMap::new();
        for n in &g.nodes {
            let semantic = &c.nodes[&n.id];
            if semantic.kind == "start" {
                let y = i64::from(n.bounds.y) + i64::from(n.bounds.height) / 2;
                initial_reference(
                    &mut out,
                    &n.id,
                    point(i64::from(n.bounds.x) - 22 * 64, y),
                    point(i64::from(n.bounds.x) - 64, y),
                    false,
                );
            }
            if n.final_state == Some(true) {
                let inset = (3 * 64).min(n.bounds.width.min(n.bounds.height) / 4).max(0);
                out.push(expected_primitive(
                    "lifecycle-final-border",
                    &n.id,
                    Shape::Rect {
                        bounds: crate::geometry::GeometryBox {
                            x: n.bounds.x + inset,
                            y: n.bounds.y + inset,
                            width: n.bounds.width - 2 * inset,
                            height: n.bounds.height - 2 * inset,
                        },
                        radius: 4 * 64,
                    },
                    Paint::OutlineNode,
                    "1",
                    Layer::Overlay,
                ));
            }
            let band = match semantic.lane.as_deref() {
                Some("main") => "phase",
                Some("terminal") => "outcome",
                _ => "event",
            };
            bands.entry(band).or_default().push(n);
        }
        if c.schema_version == 1 {
            for band in bands.keys() {
                let y = match *band {
                    "phase" => 112 * 64,
                    "event" => 264 * 64,
                    "outcome" => 436 * 64,
                    _ => continue,
                };
                let left = 72 * 64;
                let right = i64::from(g.page.bounds.width) - 72 * 64;
                let mut p = line_primitive(
                    "lifecycle-band",
                    band,
                    point(left, y),
                    point(right, y),
                    Paint::Line,
                    "0.8",
                    Layer::Underlay,
                );
                p.dash = Some("3 8");
                out.push(p);
            }
            if bands.contains_key("phase") {
                // The producer supplies the authored source rail endpoints. This
                // must stay nonzero for a singleton phase and other-lane states.
                if let Some(rail) = &g.lifecycle_rail {
                    if rail.from != rail.to {
                        out.push({
                            let mut p = expected_primitive(
                                "lifecycle-rail",
                                "main",
                                Shape::Polyline {
                                    points: vec![rail.from, rail.to],
                                },
                                Paint::AccentLine,
                                "2.2",
                                Layer::Underlay,
                            );
                            p.arrow = true;
                            p
                        });
                    }
                }
            }
        }
    }
    for entry in &g.legend.entries {
        let Some(bounds) = entry.swatch_bounds else {
            continue;
        };
        let x = i64::from(bounds.x);
        let y = i64::from(bounds.y) + i64::from(bounds.height) / 2;
        let route = c.family == "sequence" || (c.family == "dataflow" && entry.key != "database");
        if route {
            let width = i64::from(bounds.width);
            let mut p = line_primitive(
                "legend-route-swatch",
                &entry.key,
                point(x, y),
                point(x + width, y),
                if entry.key == "emphasis" {
                    Paint::AccentLine
                } else {
                    Paint::Line
                },
                reference_width(&c.family, c.schema_version, &entry.key),
                Layer::Overlay,
            );
            p.dash = reference_dash(Some(&entry.key));
            p.arrow = true;
            out.push(p);
        } else if c.family == "lifecycle" && entry.key == "start" {
            initial_reference(
                &mut out,
                &entry.key,
                point(x + 288, y),
                point(x + i64::from(bounds.width), y),
                true,
            );
        } else if c.family == "lifecycle" && entry.key == "final" {
            out.push(expected_primitive(
                "legend-final-outer",
                &entry.key,
                Shape::Rect {
                    bounds,
                    radius: 2 * 64,
                },
                Paint::Node,
                "1",
                Layer::Overlay,
            ));
            out.push(expected_primitive(
                "legend-final-inner",
                &entry.key,
                Shape::Rect {
                    bounds: crate::geometry::GeometryBox {
                        x: (x + 160) as i32,
                        y: (y - 128) as i32,
                        width: 9 * 64,
                        height: 4 * 64,
                    },
                    radius: 64,
                },
                Paint::OutlineNode,
                "0.8",
                Layer::Overlay,
            ));
        } else {
            out.push(expected_primitive(
                "legend-node-swatch",
                &entry.key,
                Shape::Rect {
                    bounds,
                    radius: if c.family == "architecture" {
                        2 * 64 + 32
                    } else {
                        2 * 64
                    },
                },
                Paint::Node,
                "1",
                Layer::Overlay,
            ));
        }
    }
    out
}

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
    let context = options.semantics.as_ref().expect("context validated");
    let kind = if primitive.kind == "lifecycle-final-border" {
        context
            .nodes
            .get(&primitive.owner)
            .map(|node| node.kind.as_str())
            .unwrap_or("node")
    } else {
        primitive.owner.as_str()
    };
    match primitive.paint {
        Paint::Line => ("none", theme.arrow),
        Paint::AccentLine => ("none", theme.emphasis),
        Paint::Node => {
            let color = options.theme.kind(kind).expect("kind validated");
            (color.fill, color.stroke)
        }
        Paint::OutlineNode => {
            let color = options.theme.kind(kind).expect("kind validated");
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

fn identity_token(node: Node<'_, '_>) -> String {
    if let Some(id) = node.attribute("id") {
        format!("id:{id}")
    } else if let Some(kind) = node.attribute("data-kind") {
        format!("kind:{kind}")
    } else {
        format!("tag:{}", node.tag_name().name())
    }
}

fn element_id(kind: &str, source: &str) -> String {
    format!("id:{}", svg::id(kind, source))
}

fn check_paint_order(
    doc: &Document<'_>,
    geometry: &GeometryDocument,
    primitives: &[Primitive],
    errors: &mut Vec<Diagnostic>,
) {
    let mut expected = vec![
        "id:maru-title".to_owned(),
        "id:maru-desc".to_owned(),
        "kind:page".to_owned(),
        "tag:defs".to_owned(),
    ];
    expected.extend(
        geometry
            .containers
            .iter()
            .filter(|container| container.kind != "activation")
            .map(|container| element_id("container", &container.id)),
    );
    expected.extend(
        primitives
            .iter()
            .filter(|primitive| primitive.layer == Layer::Underlay)
            .map(|primitive| {
                element_id(
                    "primitive",
                    &format!("{}:{}", primitive.kind, primitive.owner),
                )
            }),
    );
    expected.extend(
        geometry
            .containers
            .iter()
            .filter(|container| container.kind == "activation")
            .map(|container| element_id("container", &container.id)),
    );
    expected.extend(
        geometry
            .routes
            .iter()
            .enumerate()
            .map(|(index, route)| element_id("route", &svg::route_key(route, index))),
    );
    expected.extend(
        geometry
            .nodes
            .iter()
            .map(|node| element_id("node", &node.id)),
    );
    expected.push("kind:legend-box".to_owned());
    expected.extend(
        geometry
            .legend
            .entries
            .iter()
            .map(|entry| element_id("legend", &entry.key)),
    );
    expected.extend(
        primitives
            .iter()
            .filter(|primitive| primitive.layer == Layer::Overlay)
            .map(|primitive| {
                element_id(
                    "primitive",
                    &format!("{}:{}", primitive.kind, primitive.owner),
                )
            }),
    );
    expected.extend(
        geometry
            .labels
            .iter()
            .enumerate()
            .map(|(index, label)| element_id("label", &svg::label_key(label, index))),
    );
    let actual: Vec<_> = doc
        .root_element()
        .children()
        .filter(|child| child.is_element())
        .map(identity_token)
        .collect();
    if actual != expected {
        errors.push(fail(
            "paint-order",
            "/svg",
            "SVG root elements do not follow the geometry-backed paint sequence",
        ));
    }

    for node in doc
        .descendants()
        .filter(|node| node.is_element() && node.attribute("data-kind") == Some("node"))
    {
        let children: Vec<_> = elements(node)
            .map(|child| child.attribute("data-kind").unwrap_or_default())
            .collect();
        if children != ["node-mask", "node-box"] {
            errors.push(fail(
                "node-paint-order",
                &format!(
                    "/nodes/{}",
                    node.attribute("data-source-id").unwrap_or_default()
                ),
                "opaque node mask must paint before its node body",
            ));
        }
    }
}

/// Check primitive SVG elements against the semantic model derived from source geometry.
pub(crate) fn check_primitives(
    doc: &Document<'_>,
    geometry: &GeometryDocument,
    options: &SvgOptions,
) -> Vec<Diagnostic> {
    let mut errors = Vec::new();
    let expected = expected(geometry, options);
    check_paint_order(doc, geometry, &expected, &mut errors);
    for entry in &geometry.legend.entries {
        if entry.swatch_bounds.is_none() || entry.text_bounds.is_none() {
            errors.push(fail(
                "legend-reference",
                &format!("/legend/{}", entry.key),
                "semantic legend entry lacks explicit retained swatch or text bounds",
            ));
        }
    }
    if options
        .semantics
        .as_ref()
        .is_some_and(|context| context.family == "sequence")
        && !geometry.legend.entries.is_empty()
        && geometry.legend.title_y.is_none()
    {
        errors.push(fail(
            "legend-reference",
            "/legend/titleY",
            "visible sequence legend has no retained title baseline for lifeline clearance",
        ));
    }
    if options.semantics.as_ref().is_some_and(|c| {
        c.family == "lifecycle"
            && c.schema_version == 1
            && geometry.nodes.iter().any(|n| {
                options
                    .semantics
                    .as_ref()
                    .and_then(|c| c.nodes.get(&n.id))
                    .is_some_and(|s| s.lane.as_deref() == Some("main"))
            })
    }) && geometry
        .lifecycle_rail
        .as_ref()
        .is_none_or(|rail| rail.from == rail.to)
    {
        errors.push(fail(
            "rail",
            "/geometry/lifecycleRail",
            "V1 main phase rail is absent or has identical endpoints",
        ));
    }
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
