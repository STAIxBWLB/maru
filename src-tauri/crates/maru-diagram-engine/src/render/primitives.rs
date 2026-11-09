//! Meaning-bearing drawing primitives derived from placed geometry, not source coordinates.
use super::{error, SemanticContext, SvgOptions};
use crate::geometry::{GeometryBox, GeometryDocument, GeometryPoint};
use crate::Diagnostic;
use std::collections::BTreeMap;

pub(crate) const KINDS: &[&str] = &[
    "sequence-lifeline",
    "workflow-phase-span",
    "lifecycle-initial-dot",
    "lifecycle-initial-stem",
    "lifecycle-initial-head",
    "lifecycle-final-border",
    "lifecycle-rail",
    "lifecycle-band",
    "legend-node-swatch",
    "legend-route-swatch",
    "legend-initial-dot",
    "legend-initial-stem",
    "legend-initial-head",
    "legend-final-outer",
    "legend-final-inner",
];
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Layer {
    Underlay,
    Overlay,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Paint {
    Line,
    AccentLine,
    Node,
    OutlineNode,
    AccentFill,
}
#[derive(Debug, Clone)]
pub(crate) enum Shape {
    Rect {
        bounds: GeometryBox,
        radius: i32,
    },
    Line {
        from: GeometryPoint,
        to: GeometryPoint,
    },
    Polyline {
        points: Vec<GeometryPoint>,
    },
    Circle {
        center: GeometryPoint,
        radius: i32,
    },
    Polygon {
        points: Vec<GeometryPoint>,
    },
}
#[derive(Debug, Clone)]
pub(crate) struct Primitive {
    pub kind: &'static str,
    pub owner: String,
    pub shape: Shape,
    pub paint: Paint,
    pub stroke: &'static str,
    pub dash: Option<&'static str>,
    pub arrow: bool,
    pub layer: Layer,
}
pub(crate) fn context<'a>(
    g: &GeometryDocument,
    o: &'a SvgOptions,
) -> Result<&'a SemanticContext, Diagnostic> {
    let c = o.semantics.as_ref().ok_or_else(|| {
        error(
            "semantic-source",
            "/specJson",
            "SVG semantic context is missing",
            "provide the matching source spec JSON or build SvgOptions with from_spec",
        )
    })?;
    if ![
        "architecture",
        "workflow",
        "sequence",
        "dataflow",
        "lifecycle",
    ]
    .contains(&c.family.as_str())
    {
        return Err(error(
            "semantic-family",
            "/options/semantics",
            "SVG semantic family is unsupported",
            "use one of the five E3 diagram families",
        ));
    }
    if ![1, 2].contains(&c.schema_version) {
        return Err(error(
            "semantic-version",
            "/options/semantics/schemaVersion",
            "semantic schema version is unsupported",
            "provide an accepted version 1 or 2 source snapshot",
        ));
    }
    for entry in &g.legend.entries {
        let route = c.family == "sequence" || (c.family == "dataflow" && entry.key != "database");
        if !route && o.theme.kind(&entry.key).is_none() {
            return Err(error(
                "semantic-kind",
                "/legend",
                "legend kind has no semantic theme token",
                "use the accepted legend catalog for the matching diagram family",
            ));
        }
    }
    for n in &g.nodes {
        if c.nodes
            .get(&n.id)
            .is_some_and(|node| o.theme.kind(&node.kind).is_none())
        {
            return Err(error(
                "semantic-kind",
                "/nodes",
                "node kind has no semantic theme token",
                "use an accepted semantic node type and the matching source snapshot",
            ));
        }
        if !c.nodes.contains_key(&n.id) {
            return Err(error(
                "semantic-node",
                "/options/semantics/nodes",
                format!("placed node {:?} has no source semantic type", n.id),
                "provide the matching source spec snapshot rather than a different diagram",
            ));
        }
        if c.family == "lifecycle" && n.final_state.is_none() {
            return Err(error(
                "semantic-final",
                "/nodes",
                "lifecycle geometry has no final-state classification",
                "recompute layout with the E3-capable API v1 producer before rendering",
            ));
        }
    }
    Ok(c)
}
pub(crate) fn dash(variant: Option<&str>) -> Option<&'static str> {
    match variant {
        Some("return") => Some("3 5"),
        Some("security") => Some("5 5"),
        Some("dashed") => Some("4 4"),
        _ => None,
    }
}
pub(crate) fn frame_dash(kind: &str, c: &SemanticContext, id: &str) -> Option<&'static str> {
    match kind {
        "region" => Some("8 4"),
        "security-group" | "exception-lane" => Some("4 4"),
        "group" if c.frame_variants.get(id).is_some_and(|v| v == "security") => Some("4 4"),
        "lane" | "group" | "stage" | "segment" => Some("6 6"),
        _ => None,
    }
}
fn at(x: i64, y: i64) -> Result<GeometryPoint, Diagnostic> {
    let convert = |v| {
        i32::try_from(v).map_err(|_| {
            error(
                "semantic-range",
                "/geometry",
                "a derived semantic primitive exceeds signed fixed-point coordinates",
                "reduce extreme pinned positions or page dimensions and recompute layout",
            )
        })
    };
    Ok(GeometryPoint {
        x: convert(x)?,
        y: convert(y)?,
    })
}
fn box_at(x: i64, y: i64, w: i64, h: i64) -> Result<GeometryBox, Diagnostic> {
    let p = at(x, y)?;
    let size = at(w, h)?;
    GeometryBox::new(p.x, p.y, size.x, size.y).map_err(|cause| {
        error(
            "semantic-box",
            "/geometry",
            cause.to_string(),
            "use nonnegative placed dimensions and recompute layout",
        )
    })
}
fn middle(b: GeometryBox) -> Result<GeometryPoint, Diagnostic> {
    at(
        i64::from(b.x) + i64::from(b.width) / 2,
        i64::from(b.y) + i64::from(b.height) / 2,
    )
}
fn primitive(
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
fn initial(
    out: &mut Vec<Primitive>,
    owner: &str,
    dot: GeometryPoint,
    tip: GeometryPoint,
    legend: bool,
) -> Result<(), Diagnostic> {
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
    out.push(primitive(
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
    out.push(primitive(
        kinds[1],
        owner,
        Shape::Line {
            from: at(i64::from(dot.x) + 288, dot.y.into())?,
            to: at(i64::from(tip.x) - 384, tip.y.into())?,
        },
        Paint::AccentLine,
        "1.4",
        Layer::Overlay,
    ));
    out.push(primitive(
        kinds[2],
        owner,
        Shape::Polygon {
            points: vec![
                at(i64::from(tip.x) - 448, i64::from(tip.y) - 224)?,
                tip,
                at(i64::from(tip.x) - 448, i64::from(tip.y) + 224)?,
            ],
        },
        Paint::AccentFill,
        "0",
        Layer::Overlay,
    ));
    Ok(())
}
fn legend_width(c: &SemanticContext, key: &str) -> &'static str {
    if key == "emphasis" {
        match c.family.as_str() {
            "lifecycle" if c.schema_version == 1 => "2",
            "lifecycle" => "1.6",
            _ => "1.8",
        }
    } else {
        match c.family.as_str() {
            "sequence" | "dataflow" => "1.4",
            "lifecycle" => "1.1",
            _ => "1.5",
        }
    }
}
pub(crate) fn derive(g: &GeometryDocument, o: &SvgOptions) -> Result<Vec<Primitive>, Diagnostic> {
    let c = context(g, o)?;
    let mut out = Vec::new();
    if c.family == "workflow" {
        for frame in g.containers.iter().filter(|frame| frame.kind == "phase") {
            let variant = c.frame_variants.get(&frame.id).map(String::as_str);
            let y = i64::from(frame.bounds.y) + i64::from(frame.bounds.height) / 2;
            let mut p = primitive(
                "workflow-phase-span",
                &frame.id,
                Shape::Line {
                    from: at(frame.bounds.x.into(), y)?,
                    to: at(i64::from(frame.bounds.x) + i64::from(frame.bounds.width), y)?,
                },
                if variant == Some("emphasis") {
                    Paint::AccentLine
                } else {
                    Paint::Line
                },
                "1.1",
                Layer::Underlay,
            );
            p.dash = dash(variant);
            out.push(p);
        }
    }
    if c.family == "sequence" {
        let page_end = i64::from(g.page.bounds.y) + i64::from(g.page.bounds.height) - 65 * 64;
        let end = if g.legend.entries.is_empty() {
            page_end
        } else {
            page_end.min(i64::from(g.legend.bounds.y) - 22 * 64)
        };
        let timeline_end = g
            .routes
            .iter()
            .flat_map(|route| route.points.iter().map(|p| i64::from(p.y)))
            .chain(
                g.containers
                    .iter()
                    .filter(|frame| matches!(frame.kind.as_str(), "activation" | "segment"))
                    .map(|frame| i64::from(frame.bounds.y) + i64::from(frame.bounds.height)),
            )
            .max()
            .unwrap_or(0);
        let end = g
            .containers
            .iter()
            .filter(|frame| frame.kind == "card")
            .map(|frame| i64::from(frame.bounds.y) - 22 * 64)
            .min()
            .map_or(end, |limit| end.min(limit))
            .max(timeline_end);
        for n in &g.nodes {
            let center = middle(n.bounds)?;
            let bottom = i64::from(n.bounds.y) + i64::from(n.bounds.height);
            let mut p = primitive(
                "sequence-lifeline",
                &n.id,
                Shape::Line {
                    from: at(center.x.into(), bottom)?,
                    to: at(center.x.into(), end.max(bottom))?,
                },
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
                let center = middle(n.bounds)?;
                initial(
                    &mut out,
                    &n.id,
                    at(i64::from(n.bounds.x) - 22 * 64, center.y.into())?,
                    at(i64::from(n.bounds.x) - 64, center.y.into())?,
                    false,
                )?;
            }
            if n.final_state == Some(true) {
                let inset = (3 * 64).min(n.bounds.width.min(n.bounds.height) / 4).max(0);
                let b = box_at(
                    i64::from(n.bounds.x) + i64::from(inset),
                    i64::from(n.bounds.y) + i64::from(inset),
                    i64::from(n.bounds.width) - 2 * i64::from(inset),
                    i64::from(n.bounds.height) - 2 * i64::from(inset),
                )?;
                out.push(primitive(
                    "lifecycle-final-border",
                    &n.id,
                    Shape::Rect {
                        bounds: b,
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
            for (band, nodes) in &bands {
                let lanes: Vec<_> = g
                    .containers
                    .iter()
                    .filter(|f| {
                        f.kind == "lane"
                            && nodes.iter().any(|n| {
                                c.nodes[&n.id]
                                    .lane
                                    .as_ref()
                                    .is_some_and(|lane| f.id == format!("lane:{lane}"))
                            })
                    })
                    .collect();
                if let Some(first) = lanes.first() {
                    let left = lanes.iter().map(|f| i64::from(f.bounds.x)).min().unwrap() + 12 * 64;
                    let right = lanes
                        .iter()
                        .map(|f| i64::from(f.bounds.x) + i64::from(f.bounds.width))
                        .max()
                        .unwrap()
                        - 12 * 64;
                    let caption = g.labels.iter().find(|l| {
                        l.id.as_deref() == Some(format!("container:{}:label", first.id).as_str())
                    });
                    let baseline = caption
                        .and_then(|l| l.glyphs.first().map(|p| i64::from(p.position.y)))
                        .unwrap_or(i64::from(first.bounds.y) + 22 * 64);
                    let mut p = primitive(
                        "lifecycle-band",
                        band,
                        Shape::Line {
                            from: at(left, baseline + 12 * 64)?,
                            to: at(right.max(left), baseline + 12 * 64)?,
                        },
                        Paint::Line,
                        "0.8",
                        Layer::Underlay,
                    );
                    p.dash = Some("3 8");
                    out.push(p);
                }
            }
            if let Some(main) = bands.get("phase") {
                let mut nodes = main.clone();
                if nodes.iter().any(|n| n.phase_order.is_none()) {
                    return Err(error("semantic-order", "/nodes", "lifecycle phase geometry has no authored order", "recompute layout with the E3-capable producer before rendering pinned phases"));
                }
                nodes.sort_by(|a, b| (a.phase_order, &a.id).cmp(&(b.phase_order, &b.id)));
                let mut points = Vec::new();
                for node in nodes {
                    let center = middle(node.bounds)?;
                    if let Some(previous) = points.last().copied() {
                        let previous: GeometryPoint = previous;
                        if previous.y != center.y {
                            points.push(GeometryPoint {
                                x: center.x,
                                y: previous.y,
                            });
                        }
                    }
                    points.push(center);
                }
                if points.len() == 1 {
                    points.push(points[0]);
                }
                let mut p = primitive(
                    "lifecycle-rail",
                    "main",
                    Shape::Polyline { points },
                    Paint::AccentLine,
                    "2.2",
                    Layer::Underlay,
                );
                p.arrow = true;
                out.push(p);
            }
        }
    }
    for (entry_index, entry) in g.legend.entries.iter().enumerate() {
        // Fit symbols in the existing trailing slot. This never moves a label
        // or creates a second legend layout when row spacing differs by family.
        let right = i64::from(entry.bounds.x) + i64::from(entry.bounds.width);
        let limit = g
            .legend
            .entries
            .iter()
            .skip(entry_index + 1)
            .filter(|next| next.bounds.y == entry.bounds.y)
            .map(|next| i64::from(next.bounds.x))
            .min()
            .unwrap_or(i64::from(g.legend.bounds.x) + i64::from(g.legend.bounds.width) - 16 * 64);
        let slot = limit - right;
        let y = i64::from(entry.bounds.y) + i64::from(entry.bounds.height) / 2;
        let route = c.family == "sequence" || (c.family == "dataflow" && entry.key != "database");
        let symbol = if route {
            (34 * 64).min(slot - 4 * 64)
        } else if c.family == "lifecycle" && entry.key == "start" {
            24 * 64
        } else {
            14 * 64
        };
        if symbol <= 0 || symbol > slot {
            return Err(error(
                "semantic-legend-space",
                "/legend",
                "legend geometry leaves no room for its semantic symbol",
                "recompute legend geometry with the matching producer before rendering",
            ));
        }
        let x = right + (slot - symbol) / 2;
        if route {
            let mut p = primitive(
                "legend-route-swatch",
                &entry.key,
                Shape::Line {
                    from: at(x, y)?,
                    to: at(x + symbol, y)?,
                },
                if entry.key == "emphasis" {
                    Paint::AccentLine
                } else {
                    Paint::Line
                },
                legend_width(c, &entry.key),
                Layer::Overlay,
            );
            p.dash = dash(Some(&entry.key));
            p.arrow = true;
            out.push(p);
        } else if c.family == "lifecycle" && entry.key == "start" {
            initial(
                &mut out,
                &entry.key,
                at(x + 288, y)?,
                at(x + 24 * 64, y)?,
                true,
            )?;
        } else if c.family == "lifecycle" && entry.key == "final" {
            out.push(primitive(
                "legend-final-outer",
                &entry.key,
                Shape::Rect {
                    bounds: box_at(x, y - 288, 14 * 64, 9 * 64)?,
                    radius: 2 * 64,
                },
                Paint::Node,
                "1",
                Layer::Overlay,
            ));
            out.push(primitive(
                "legend-final-inner",
                &entry.key,
                Shape::Rect {
                    bounds: box_at(x + 160, y - 128, 9 * 64, 4 * 64)?,
                    radius: 64,
                },
                Paint::OutlineNode,
                "0.8",
                Layer::Overlay,
            ));
        } else {
            out.push(primitive(
                "legend-node-swatch",
                &entry.key,
                Shape::Rect {
                    bounds: box_at(x, y - 288, 14 * 64, 9 * 64)?,
                    radius: 2 * 64,
                },
                Paint::Node,
                "1",
                Layer::Overlay,
            ));
        }
    }
    Ok(out)
}

pub(crate) fn node_caption(g: &GeometryDocument, c: &SemanticContext, target: &str) -> String {
    let labels: Vec<_> = g
        .labels
        .iter()
        .filter(|l| {
            l.target_id == target
                && !l.text.is_empty()
                && l.id
                    .as_ref()
                    .is_some_and(|id| id.starts_with(&format!("node:{target}:")))
        })
        .map(|l| l.text.as_str())
        .collect();
    let text = if labels.is_empty() {
        target.into()
    } else {
        labels.join("; ")
    };
    let kind = c
        .nodes
        .get(target)
        .map(|n| n.kind.as_str())
        .unwrap_or("node");
    if g.nodes
        .iter()
        .any(|n| n.id == target && n.final_state == Some(true))
    {
        format!("{text} ({kind}; final)")
    } else {
        format!("{text} ({kind})")
    }
}

impl Primitive {
    pub(crate) fn paint_kind<'a>(&'a self, c: &'a SemanticContext) -> &'a str {
        if self.kind == "lifecycle-final-border" {
            &c.nodes[&self.owner].kind
        } else {
            &self.owner
        }
    }
}
