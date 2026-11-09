//! Original route/label predicates over fixed-point scenes and authored intent.
//! No renderer implementation is imported. Explicit quality profiles select
//! composition checks. Each offending witness independently determines whether
//! authored controls are refused or generated geometry receives a notice.

use crate::geometry::{GeometryDocument, GeometryPoint};
use crate::layout::fixed::quantize_pixels;
use crate::Diagnostic;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// Exact nonfatal allowlist. Unknown or forged diagnostic codes remain errors.
pub(crate) fn is_route_quality_notice(diagnostic: &Diagnostic) -> bool {
    matches!(
        diagnostic.code.as_str(),
        "architecture/geometry-route-quality-notice"
            | "workflow/geometry-route-quality-notice"
            | "sequence/geometry-route-quality-notice"
            | "dataflow/geometry-route-quality-notice"
            | "lifecycle/geometry-route-quality-notice"
    )
}

const U: i64 = 64;
type Point = (i64, i64);
#[derive(Clone, Copy)]
struct Rect {
    x: i64,
    y: i64,
    w: i64,
    h: i64,
}
impl Rect {
    fn right(self) -> i64 {
        self.x + self.w
    }
    fn bottom(self) -> i64 {
        self.y + self.h
    }
}
#[derive(Clone, Copy)]
struct Family {
    name: &'static str,
    nodes: &'static str,
    routes: &'static str,
    prefix: &'static str,
}
fn family(spec: &Value) -> Option<Family> {
    Some(match spec.get("diagram_type")?.as_str()? {
        "architecture" => Family {
            name: "architecture",
            nodes: "components",
            routes: "connections",
            prefix: "connection",
        },
        "workflow" => Family {
            name: "workflow",
            nodes: "nodes",
            routes: "edges",
            prefix: "edge",
        },
        "sequence" => Family {
            name: "sequence",
            nodes: "participants",
            routes: "messages",
            prefix: "message",
        },
        "dataflow" => Family {
            name: "dataflow",
            nodes: "nodes",
            routes: "flows",
            prefix: "flow",
        },
        "lifecycle" => Family {
            name: "lifecycle",
            nodes: "states",
            routes: "transitions",
            prefix: "transition",
        },
        _ => return None,
    })
}
fn array<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v.get(key)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}
fn text<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}
fn number(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64)
}
fn q(v: f64) -> Option<i64> {
    quantize_pixels(v).ok().map(i64::from)
}
fn point(v: &Value) -> Option<Point> {
    let a = v.as_array()?;
    if a.len() != 2 {
        return None;
    }
    Some((q(a[0].as_f64()?)?, q(a[1].as_f64()?)?))
}
fn gp(p: GeometryPoint) -> Point {
    (i64::from(p.x), i64::from(p.y))
}
fn rect(b: crate::geometry::GeometryBox) -> Rect {
    Rect {
        x: i64::from(b.x),
        y: i64::from(b.y),
        w: i64::from(b.width),
        h: i64::from(b.height),
    }
}
fn normalize(points: &[Point]) -> Vec<Point> {
    let mut out: Vec<Point> = Vec::new();
    for &p in points {
        if out.last() == Some(&p) {
            continue;
        }
        while out.len() >= 2 {
            let a = out[out.len() - 2];
            let b = out[out.len() - 1];
            let first = (i128::from(b.0 - a.0), i128::from(b.1 - a.1));
            let next = (i128::from(p.0 - b.0), i128::from(p.1 - b.1));
            if first.0 * next.1 == first.1 * next.0 && first.0 * next.0 + first.1 * next.1 > 0 {
                out.pop();
            } else {
                break;
            }
        }
        out.push(p);
    }
    out
}
fn axis(a: Point, b: Point) -> bool {
    a.0 == b.0 || a.1 == b.1
}
fn length(a: Point, b: Point) -> i64 {
    (a.0 - b.0).abs() + (a.1 - b.1).abs()
}
fn overlap(a: Rect, b: Rect, inset: i64) -> bool {
    #[cfg(any(test, feature = "geometry-corpus"))]
    crate::work::record_constraint_evaluation();

    a.x < b.right() - inset
        && b.x < a.right() - inset
        && a.y < b.bottom() - inset
        && b.y < a.bottom() - inset
}
fn source_boxes(spec: &Value, f: Family, geometry: &GeometryDocument) -> BTreeMap<String, Rect> {
    let mut boxes: BTreeMap<_, _> = geometry
        .nodes
        .iter()
        .map(|n| (n.id.clone(), rect(n.bounds)))
        .collect();
    // These fixed v1 layout baselines are input-format semantics needed to
    // inspect absolute authored pins before the S2 solver can repair a path.
    for n in array(spec, f.nodes) {
        let Some(id) = text(n, "id") else {
            continue;
        };
        if geometry.nodes.iter().any(|node| {
            node.id == id
                && node.position_source == crate::geometry::GeometryPositionSource::PlannedPin
        }) {
            continue;
        }
        let reference = if f.name == "dataflow" {
            let Some(stage) = number(n, "stage") else {
                continue;
            };
            let Some(row) = number(n, "row") else {
                continue;
            };
            if !(0.0..=4.0).contains(&row) || row.fract() != 0.0 {
                continue;
            }
            let w = number(n, "width").unwrap_or(112.0);
            let h = number(n, "height").unwrap_or(58.0);
            Some((
                100.0 + 215.0 * stage - w / 2.0,
                128.0 + 114.0 * row + number(n, "yOffset").unwrap_or(0.0),
                w,
                h,
            ))
        } else if f.name == "lifecycle"
            && spec.get("schema_version").and_then(Value::as_u64) == Some(1)
        {
            let col = number(n, "col").unwrap_or(0.0);
            let lane = text(n, "lane").unwrap_or("main");
            let (cx, y, w, h) = if lane == "main" {
                (94.0 + 154.0 * col, 126.0, 118.0, 62.0)
            } else if lane == "terminal" {
                (402.0 + 154.0 * col.min(2.0), 450.0, 118.0, 58.0)
            } else {
                (402.0 + 154.0 * col.min(2.0), 278.0, 126.0, 58.0)
            };
            let w = number(n, "width").unwrap_or(w);
            let h = number(n, "height").unwrap_or(h);
            Some((cx - w / 2.0, y + number(n, "yOffset").unwrap_or(0.0), w, h))
        } else {
            None
        };
        if let Some((x, y, w, h)) = reference {
            if let (Some(x), Some(y), Some(w), Some(h)) = (q(x), q(y), q(w), q(h)) {
                boxes.insert(id.into(), Rect { x, y, w, h });
            }
        }
    }
    boxes
}
fn port(b: Rect, side: Option<&str>, toward: Point) -> Point {
    let center = (b.x + b.w / 2, b.y + b.h / 2);
    let dx = toward.0 - center.0;
    let dy = toward.1 - center.1;
    match side.unwrap_or(if dx.abs() >= dy.abs() {
        if dx >= 0 {
            "right"
        } else {
            "left"
        }
    } else if dy >= 0 {
        "bottom"
    } else {
        "top"
    }) {
        "left" => (b.x, center.1),
        "top" => (center.0, b.y),
        "bottom" => (center.0, b.bottom()),
        _ => (b.right(), center.1),
    }
}
struct Relation<'a> {
    index: usize,
    raw: &'a Value,
    from: &'a str,
    to: &'a str,
    scene: Vec<Point>,
    scene_raw: Vec<Point>,
    scene_ranges: Vec<(usize, usize)>,
    from_fixed: bool,
    to_fixed: bool,
    from_anchor: Option<Point>,
    to_anchor: Option<Point>,
    via: Vec<Point>,
    owned_channel_x: Option<i64>,
    owned_channel_y: Option<i64>,
    authored: Vec<Point>,
    authored_includes_ports: bool,
    reference: Vec<Point>,
    label: Option<Rect>,
    reference_label: Option<Rect>,
}
fn label_text(raw: &Value, f: Family) -> String {
    let mut parts = Vec::new();
    if let Some(s) = text(raw, "label").filter(|s| !s.is_empty()) {
        parts.push(s);
    }
    let detail = if f.name == "dataflow" {
        "classification"
    } else {
        "note"
    };
    if let Some(s) = text(raw, detail).filter(|s| !s.is_empty()) {
        parts.push(s);
    }
    parts.join("\n")
}
fn raw_label(raw: &Value, f: Family) -> Option<Rect> {
    let center = point(raw.get("labelAt")?)?;
    let value = label_text(raw, f);
    if value.is_empty() {
        return None;
    }
    let mut width = if f.name == "dataflow" { 34 * U } else { 32 * U };
    let mut lines = 0_i64;
    for line in value.split('\n') {
        let metrics = crate::metrics::measure_text(line, 400, 12 * 64).ok()?;
        width = width.max(i64::from(metrics.advance) + 12 * U);
        lines += 1;
    }
    let height = (16 + 11 * (lines - 1)) * U;
    Some(Rect {
        x: center.0 - width / 2,
        y: center.1 - 11 * U,
        w: width,
        h: height,
    })
}
fn scene_analysis(points: &[Point]) -> (Vec<Point>, Vec<(usize, usize)>) {
    let mut kept: Vec<(Point, usize)> = Vec::new();
    for (index, &point) in points.iter().enumerate() {
        if kept.last().is_some_and(|(last, _)| *last == point) {
            continue;
        }
        while kept.len() >= 2 {
            let a = kept[kept.len() - 2].0;
            let b = kept[kept.len() - 1].0;
            let first = (i128::from(b.0 - a.0), i128::from(b.1 - a.1));
            let next = (i128::from(point.0 - b.0), i128::from(point.1 - b.1));
            if first.0 * next.1 == first.1 * next.0 && first.0 * next.0 + first.1 * next.1 > 0 {
                kept.pop();
            } else {
                break;
            }
        }
        kept.push((point, index));
    }
    (
        kept.iter().map(|(p, _)| *p).collect(),
        kept.windows(2).map(|s| (s[0].1, s[1].1)).collect(),
    )
}
fn fixed_node(g: &GeometryDocument, id: &str) -> bool {
    g.nodes.iter().any(|node| {
        node.id == id
            && matches!(
                node.position_source,
                crate::geometry::GeometryPositionSource::PlannedPin
                    | crate::geometry::GeometryPositionSource::AuthoredPosition
            )
    })
}
fn relations<'a>(
    spec: &'a Value,
    f: Family,
    g: &GeometryDocument,
    boxes: &BTreeMap<String, Rect>,
) -> Vec<Relation<'a>> {
    let source = array(spec, f.routes);
    let ids = super::allocate_route_ids(f.prefix, source.iter().map(|r| text(r, "id")));
    let routes: BTreeMap<_, _> = g
        .routes
        .iter()
        .filter_map(|r| r.id.as_ref().map(|id| (id.as_str(), r)))
        .collect();
    source
        .iter()
        .enumerate()
        .map(|(index, raw)| {
            let id = ids[index].clone();
            let scene_raw = routes.get(id.as_str()).map_or_else(Vec::new, |r| {
                r.points.iter().copied().map(gp).collect::<Vec<_>>()
            });
            let (scene, scene_ranges) = scene_analysis(&scene_raw);
            let from = text(raw, "from").unwrap_or("");
            let to = text(raw, "to").unwrap_or("");
            let via: Vec<_> = array(raw, "via").iter().filter_map(point).collect();
            let mut reference = Vec::new();
            let mut authored = via.clone();
            let mut authored_includes_ports = false;
            if let (Some(a), Some(b)) = (boxes.get(from), boxes.get(to)) {
                if f.name == "architecture"
                    && !via.is_empty()
                    && (text(raw, "fromSide").is_some() || text(raw, "toSide").is_some())
                {
                    let start = port(*a, text(raw, "fromSide"), via[0]);
                    let end = port(*b, text(raw, "toSide"), *via.last().unwrap());
                    authored = vec![start];
                    authored.extend(via.iter().copied());
                    authored.push(end);
                    authored_includes_ports = true;
                }
                if f.name == "dataflow"
                    || (f.name == "lifecycle"
                        && spec.get("schema_version").and_then(Value::as_u64) == Some(1))
                {
                    let target = via
                        .first()
                        .copied()
                        .unwrap_or((b.x + b.w / 2, b.y + b.h / 2));
                    let origin = via
                        .last()
                        .copied()
                        .unwrap_or((a.x + a.w / 2, a.y + a.h / 2));
                    let start = port(*a, text(raw, "fromSide"), target);
                    let end = port(*b, text(raw, "toSide"), origin);
                    if !via.is_empty() {
                        authored = vec![start];
                        authored.extend(via.iter().copied());
                        authored.push(end);
                        reference = normalize(&authored);
                    } else if axis(start, end)
                        && number(raw, "channelX").is_none()
                        && number(raw, "channelY").is_none()
                        && text(raw, "route").is_none_or(|v| v == "auto" || v == "straight")
                    {
                        reference = vec![start, end];
                    }
                }
            }
            let owned_channel_x = if via.is_empty() {
                number(raw, "channelX").and_then(q)
            } else {
                None
            };
            let mut owned_channel_y = if via.is_empty() {
                number(raw, "channelY").and_then(q)
            } else {
                None
            };
            if via.is_empty()
                && f.name == "workflow"
                && text(raw, "route") == Some("drop")
                && owned_channel_y.is_none()
            {
                if let (Some(bias), Some(a), Some(b)) = (
                    number(raw, "bias"),
                    g.nodes.iter().find(|n| n.id == from),
                    g.nodes.iter().find(|n| n.id == to),
                ) {
                    let width = number(raw, "width").and_then(q).unwrap_or(2 * U);
                    let clearance = (width / 2 + 2 * U).max(4 * U);
                    if let Ok(clearance) = i32::try_from(clearance) {
                        let request = crate::routing::RouteRequest {
                            route: Some("drop".into()),
                            bias: Some(bias),
                            ..Default::default()
                        };
                        if let Ok(preset) = super::presets::resolve(
                            f.name,
                            &request,
                            a.bounds,
                            b.bounds,
                            g.page.bounds,
                            clearance,
                        ) {
                            owned_channel_y = preset.channel_y.map(i64::from);
                        }
                    }
                }
            }
            let label_id = format!("edge:{id}:label");
            let label = g
                .labels
                .iter()
                .find(|l| l.id.as_deref() == Some(label_id.as_str()))
                .map(|l| rect(l.bounds));
            Relation {
                index,
                raw,
                from,
                to,
                scene,
                scene_raw,
                scene_ranges,
                from_fixed: fixed_node(g, from),
                to_fixed: fixed_node(g, to),
                from_anchor: g
                    .nodes
                    .iter()
                    .find(|node| node.id == from && fixed_node(g, from))
                    .map(|node| (i64::from(node.bounds.x), i64::from(node.bounds.y))),
                to_anchor: g
                    .nodes
                    .iter()
                    .find(|node| node.id == to && fixed_node(g, to))
                    .map(|node| (i64::from(node.bounds.x), i64::from(node.bounds.y))),
                via,
                owned_channel_x,
                owned_channel_y,
                authored: normalize(&authored),
                authored_includes_ports,
                reference,
                label,
                reference_label: raw_label(raw, f),
            }
        })
        .collect()
}
#[allow(clippy::too_many_arguments)]
fn emit(
    out: &mut BTreeMap<(usize, String, usize), Diagnostic>,
    f: Family,
    index: usize,
    code: &str,
    cause: &str,
    other: usize,
    message: String,
    fix: &str,
    authored: bool,
) {
    let pair = matches!(
        cause,
        "label-label-overlap"
            | "label-route-clearance"
            | "proper-crossing"
            | "ambiguous-corridor"
            | "arrowhead-collision"
    );
    let key = if pair {
        (index.min(other), cause.into(), index.max(other))
    } else {
        (index, cause.into(), other)
    };
    let diagnostic = Diagnostic {
        code: if authored {
            crate::rules::geometry_qualified(f.name, code).0
        } else {
            format!("{}/geometry-route-quality-notice", f.name)
        },
        path: format!("/{}/{}", f.routes, index),
        rule: crate::rules::geometry_qualified(f.name, cause).1,
        message: if authored {
            format!("authored relationship {index} [{cause}]: {message}")
        } else {
            format!("engine-generated route/label geometry [{cause}]: {message}")
        },
        fix: if authored {
            fix.into()
        } else {
            "add via points or an explicit channel to control this route".into()
        },
    };
    match out.entry(key) {
        std::collections::btree_map::Entry::Vacant(slot) => {
            slot.insert(diagnostic);
        }
        std::collections::btree_map::Entry::Occupied(mut slot) => {
            let previous = slot.get();
            let previous_index = previous
                .path
                .rsplit('/')
                .next()
                .and_then(|s| s.parse::<usize>().ok())
                .unwrap_or(usize::MAX);
            if authored && (is_route_quality_notice(previous) || index < previous_index) {
                slot.insert(diagnostic);
            }
        }
    }
}
fn rhythm(
    out: &mut BTreeMap<(usize, String, usize), Diagnostic>,
    f: Family,
    r: &Relation<'_>,
    points: &[Point],
    domain: Domain,
) {
    for (i, segment) in points.windows(2).enumerate() {
        #[cfg(any(test, feature = "geometry-corpus"))]
        crate::work::record_constraint_evaluation();
        let n = length(segment[0], segment[1]);
        if n == 0 {
            continue;
        }
        let micro = n < 8 * U;
        // First/last segments are stubs only when the path includes physical
        // ports. A via-only list still contains interior segments at its ends.
        let complete = !matches!(domain, Domain::Authored)
            || r.authored_includes_ports
            || !r.reference.is_empty();
        let source_stub = i == 0 && (complete || points.first() == r.scene_raw.first());
        let target_stub =
            i + 2 == points.len() && (complete || points.last() == r.scene_raw.last());
        let interior = !source_stub && !target_stub && n < 16 * U;
        if micro || interior {
            let cause = if micro {
                "micro-segment"
            } else {
                "short-interior-segment"
            };
            let owned = path_authored(r, points, i, domain, segment[0], segment[1], false);
            emit(
                out,
                f,
                r.index,
                "geometry-route-quality",
                cause,
                0,
                format!(
                    "relationship {} has a {}px {cause} at segment {i}",
                    r.index,
                    n as f64 / 64.0
                ),
                "add via points or an explicit channel to control this route",
                owned,
            );
        }
    }
}

fn shared_endpoint(a: &Relation<'_>, b: &Relation<'_>) -> bool {
    [a.from, a.to].iter().any(|id| *id == b.from || *id == b.to)
}
fn label_authored(r: &Relation<'_>) -> bool {
    point(r.raw.get("labelAt").unwrap_or(&Value::Null)).is_some()
        || ["labelDx", "labelDy", "labelSegment"]
            .iter()
            .any(|key| number(r.raw, key).is_some_and(f64::is_finite))
}
fn active_channels(r: &Relation<'_>) -> (Option<i64>, Option<i64>) {
    (r.owned_channel_x, r.owned_channel_y)
}
fn authored_route(r: &Relation<'_>) -> bool {
    let (x, y) = active_channels(r);
    !r.via.is_empty()
        || x.is_some()
        || y.is_some()
        || text(r.raw, "fromSide").is_some_and(|v| !v.is_empty())
        || text(r.raw, "toSide").is_some_and(|v| !v.is_empty())
}
fn auto_architecture(r: &Value) -> bool {
    !array(r, "via").iter().any(|v| point(v).is_some())
        && number(r, "channelX").is_none()
        && number(r, "channelY").is_none()
        && text(r, "route").is_none_or(|v| v == "auto" || v.is_empty())
}
#[derive(Clone, Copy)]
enum Domain {
    Scene,
    Reference,
    Authored,
}
fn explicit_path(r: &Relation<'_>, domain: Domain) -> bool {
    !r.via.is_empty() && matches!(domain, Domain::Authored | Domain::Reference)
}
fn on_segment(p: Point, a: Point, b: Point) -> bool {
    #[cfg(any(test, feature = "geometry-corpus"))]
    crate::work::record_constraint_evaluation();

    let ab = (i128::from(b.0 - a.0), i128::from(b.1 - a.1));
    let ap = (i128::from(p.0 - a.0), i128::from(p.1 - a.1));
    ab.0 * ap.1 == ab.1 * ap.0
        && (a.0.min(b.0)..=a.0.max(b.0)).contains(&p.0)
        && (a.1.min(b.1)..=a.1.max(b.1)).contains(&p.1)
}
fn side_control(r: &Relation<'_>, source: bool) -> bool {
    let key = if source { "fromSide" } else { "toSide" };
    text(r.raw, key).is_some_and(|v| matches!(v, "left" | "right" | "top" | "bottom"))
        || text(r.raw, "route").is_some_and(|v| !v.is_empty() && v != "auto" && v != "straight")
        || if source { r.from_fixed } else { r.to_fixed }
}
fn relevant_stub(r: &Relation<'_>, index: usize, source: bool) -> Option<(Point, Point)> {
    if r.scene_raw.len() < 2 || !side_control(r, source) {
        return None;
    }
    let slot = if source { 0 } else { r.scene_raw.len() - 2 };
    let (start, end) = *r.scene_ranges.get(index)?;
    if !(start..end).contains(&slot) {
        return None;
    }
    Some((r.scene_raw[slot], r.scene_raw[slot + 1]))
}
fn touches_stub(r: &Relation<'_>, index: usize, a: Point, b: Point, _position: bool) -> bool {
    [true, false].into_iter().any(|source| {
        let anchor = if source { r.from_anchor } else { r.to_anchor };
        let Some(anchor) = anchor else {
            return false;
        };
        let Some((start, end)) = relevant_stub(r, index, source) else {
            return false;
        };
        let physical_tip = if source { start } else { end };
        // A node origin pin is not an authored free port slot along its face.
        // Only exact involvement of that input coordinate owns this witness.
        anchor == physical_tip && on_segment(anchor, a, b)
    })
}
/// Provenance belongs to the witness, not to the entire relationship. Position
/// spans have already been clipped to the crossing/corridor/clearance witness.
fn path_authored(
    r: &Relation<'_>,
    points: &[Point],
    index: usize,
    domain: Domain,
    a: Point,
    b: Point,
    position: bool,
) -> bool {
    if explicit_path(r, domain) {
        return true;
    }
    let Some(pair) = points.get(index..index + 2) else {
        return false;
    };
    let sa = pair[0];
    let sb = pair[1];
    if r.via.windows(2).any(|v| {
        if a == b {
            on_segment(a, v[0], v[1])
        } else {
            corridor(a, b, v[0], v[1]) > 0
        }
    }) || (!position && r.via.iter().any(|p| *p == sa || *p == sb))
    {
        return true;
    }
    let (cx, cy) = active_channels(r);
    if cx.is_some_and(|x| sa.0 == x && sb.0 == x) || cy.is_some_and(|y| sa.1 == y && sb.1 == y) {
        return true;
    }
    if !position
        && (cx.is_some_and(|x| sa.0 == x || sb.0 == x)
            || cy.is_some_and(|y| sa.1 == y || sb.1 == y))
    {
        return true;
    }
    if position && sa.1 == sb.1 && number(r.raw, "y").and_then(q).is_some_and(|y| sa.1 == y) {
        return true;
    }
    matches!(domain, Domain::Scene) && touches_stub(r, index, a, b, position)
}

fn raw_via_endpoint_counts(routes: &[Relation<'_>]) -> BTreeMap<Point, usize> {
    let mut counts = BTreeMap::new();
    for route in routes {
        let route_points: BTreeSet<_> = route.via.iter().copied().collect();
        for point in route_points {
            *counts.entry(point).or_insert(0) += 1;
        }
    }
    counts
}

/// An endpoint via owns only a scene witness that reaches the same raw
/// first/last via point explicitly present on at least two distinct raw edges.
/// The scene-to-raw range prevents an upstream bend or later detour from
/// inheriting provenance merely because the route contains a shared via.
fn shared_via_endpoint_witness(
    route: &Relation<'_>,
    segment_index: usize,
    domain: Domain,
    witness_start: Point,
    witness_end: Point,
    via_counts: &BTreeMap<Point, usize>,
) -> Option<Point> {
    if !matches!(domain, Domain::Scene) {
        return None;
    }
    let &(raw_start, raw_end) = route.scene_ranges.get(segment_index)?;
    let candidates: BTreeSet<_> = route
        .via
        .first()
        .copied()
        .into_iter()
        .chain(route.via.last().copied())
        .collect();
    candidates.into_iter().find(|point| {
        via_counts.get(point).copied().unwrap_or(0) >= 2
            && (*point == witness_start || *point == witness_end)
            && (raw_start..=raw_end).any(|raw_index| route.scene_raw.get(raw_index) == Some(point))
    })
}

fn near_ownership(
    r: &Relation<'_>,
    points: &[Point],
    domain: Domain,
    bounds: Rect,
    limit: i64,
    inclusive: bool,
) -> Option<bool> {
    let mut found = None;
    for (index, s) in points.windows(2).enumerate() {
        if let Some((a, b)) = near_span(s[0], s[1], bounds, limit, inclusive) {
            let owned = path_authored(r, points, index, domain, a, b, true);
            found = Some(found.unwrap_or(false) || owned);
        }
    }
    found
}
fn pair_owner(
    a: &Relation<'_>,
    a_owned: bool,
    b: &Relation<'_>,
    b_owned: bool,
) -> (usize, usize, bool) {
    if b_owned && !a_owned {
        (b.index, a.index, true)
    } else {
        (a.index, b.index, a_owned || b_owned)
    }
}
fn coordinate_px(value: i64) -> String {
    let mut result = format!("{:.6}", value as f64 / U as f64);
    while result.ends_with('0') {
        result.pop();
    }
    if result.ends_with('.') {
        result.pop();
    }
    result
}
fn point_px(point: Point) -> String {
    format!("[{},{}]", coordinate_px(point.0), coordinate_px(point.1))
}
fn overlap_span(a: Point, b: Point, c: Point, d: Point) -> Option<(Point, Point)> {
    if corridor(a, b, c, d) <= 0 {
        return None;
    }
    if a.1 == b.1 {
        Some((
            (a.0.min(b.0).max(c.0.min(d.0)), a.1),
            (a.0.max(b.0).min(c.0.max(d.0)), a.1),
        ))
    } else {
        Some((
            (a.0, a.1.min(b.1).max(c.1.min(d.1))),
            (a.0, a.1.max(b.1).min(c.1.max(d.1))),
        ))
    }
}
fn crossing_point(a: Point, b: Point, c: Point, d: Point) -> Option<Point> {
    #[cfg(any(test, feature = "geometry-corpus"))]
    crate::work::record_constraint_evaluation();

    if !proper_cross(a, b, c, d) {
        None
    } else if a.1 == b.1 {
        Some((c.0, a.1))
    } else {
        Some((a.0, c.1))
    }
}
fn integer_sqrt(n: i128) -> i64 {
    let mut low = 0_i128;
    let mut high = n.min(i128::from(i64::MAX));
    while low < high {
        let mid = (low + high + 1) / 2;
        if mid * mid <= n {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    low as i64
}
fn near_span(a: Point, b: Point, r: Rect, limit: i64, inclusive: bool) -> Option<(Point, Point)> {
    #[cfg(any(test, feature = "geometry-corpus"))]
    crate::work::record_constraint_evaluation();

    if !axis(a, b) {
        return None;
    }
    let horizontal = a.1 == b.1;
    let perpendicular = if horizontal {
        (r.y - a.1).max(a.1 - r.bottom()).max(0)
    } else {
        (r.x - a.0).max(a.0 - r.right()).max(0)
    };
    let remaining = i128::from(limit) * i128::from(limit)
        - i128::from(perpendicular) * i128::from(perpendicular)
        - i128::from(!inclusive);
    if remaining < 0 {
        return None;
    }
    let gap = integer_sqrt(remaining);
    let (low, high) = if horizontal {
        (
            a.0.min(b.0).max(r.x - gap),
            a.0.max(b.0).min(r.right() + gap),
        )
    } else {
        (
            a.1.min(b.1).max(r.y - gap),
            a.1.max(b.1).min(r.bottom() + gap),
        )
    };
    if low > high {
        return None;
    }
    Some(if horizontal {
        ((low, a.1), (high, a.1))
    } else {
        ((a.0, low), (a.0, high))
    })
}
fn frame_spans(a: Point, b: Point, r: Rect) -> Vec<(Point, Point)> {
    [
        ((r.x, r.y), (r.right(), r.y)),
        ((r.right(), r.y), (r.right(), r.bottom())),
        ((r.right(), r.bottom()), (r.x, r.bottom())),
        ((r.x, r.bottom()), (r.x, r.y)),
    ]
    .into_iter()
    .filter_map(|(p, q)| overlap_span(a, b, p, q))
    .collect()
}
fn proper_cross(a: Point, b: Point, c: Point, d: Point) -> bool {
    if a.1 == b.1 && c.0 == d.0 {
        c.0 > a.0.min(b.0) && c.0 < a.0.max(b.0) && a.1 > c.1.min(d.1) && a.1 < c.1.max(d.1)
    } else if a.0 == b.0 && c.1 == d.1 {
        proper_cross(c, d, a, b)
    } else {
        false
    }
}
fn corridor(a: Point, b: Point, c: Point, d: Point) -> i64 {
    #[cfg(any(test, feature = "geometry-corpus"))]
    crate::work::record_constraint_evaluation();

    if a.1 == b.1 && c.1 == d.1 && a.1 == c.1 {
        a.0.max(b.0).min(c.0.max(d.0)) - a.0.min(b.0).max(c.0.min(d.0))
    } else if a.0 == b.0 && c.0 == d.0 && a.0 == c.0 {
        a.1.max(b.1).min(c.1.max(d.1)) - a.1.min(b.1).max(c.1.min(d.1))
    } else {
        0
    }
}
fn forward(a: Point, b: Point, c: Point, d: Point) -> bool {
    i128::from(b.0 - a.0) * i128::from(d.0 - c.0) + i128::from(b.1 - a.1) * i128::from(d.1 - c.1)
        > 0
}
fn trunk(
    a: &Relation<'_>,
    b: &Relation<'_>,
    pa: &[Point],
    pb: &[Point],
    i: usize,
    j: usize,
    n: i64,
) -> bool {
    #[cfg(any(test, feature = "geometry-corpus"))]
    crate::work::record_constraint_evaluation();

    if n > 24 * U
        || text(a.raw, "variant").unwrap_or("default")
            != text(b.raw, "variant").unwrap_or("default")
        || number(a.raw, "width") != number(b.raw, "width")
        || text(a.raw, "role") != text(b.raw, "role")
    {
        return false;
    }
    let source = a.from == b.from && i == 0 && j == 0 && pa.first() == pb.first();
    let target = a.to == b.to && i + 2 == pa.len() && j + 2 == pb.len() && pa.last() == pb.last();
    (source || target) && forward(pa[i], pa[i + 1], pb[j], pb[j + 1])
}
fn endpoint_side(p: Point, b: Rect) -> Option<&'static str> {
    #[cfg(any(test, feature = "geometry-corpus"))]
    crate::work::record_constraint_evaluation();

    if p.0 == b.x && (b.y..=b.bottom()).contains(&p.1) {
        Some("left")
    } else if p.0 == b.right() && (b.y..=b.bottom()).contains(&p.1) {
        Some("right")
    } else if p.1 == b.y && (b.x..=b.right()).contains(&p.0) {
        Some("top")
    } else if p.1 == b.bottom() && (b.x..=b.right()).contains(&p.0) {
        Some("bottom")
    } else {
        None
    }
}
fn outward(p: Point, next: Point, side: &str) -> bool {
    #[cfg(any(test, feature = "geometry-corpus"))]
    crate::work::record_constraint_evaluation();

    match side {
        "left" => next.1 == p.1 && next.0 < p.0,
        "right" => next.1 == p.1 && next.0 > p.0,
        "top" => next.0 == p.0 && next.1 < p.1,
        "bottom" => next.0 == p.0 && next.1 > p.1,
        _ => false,
    }
}
fn endpoints(
    f: Family,
    r: &Relation<'_>,
    boxes: &BTreeMap<&str, Rect>,
    out: &mut BTreeMap<(usize, String, usize), Diagnostic>,
) {
    if f.name == "sequence"
        || f.name == "lifecycle" && r.raw.get("via").is_some_and(Value::is_array)
        || r.scene.len() < 2
    {
        return;
    }
    for (name, id, point, next, authored_side, fixed) in [
        (
            "source",
            r.from,
            r.scene[0],
            r.scene[1],
            text(r.raw, "fromSide"),
            r.from_fixed,
        ),
        (
            "target",
            r.to,
            *r.scene.last().unwrap(),
            r.scene[r.scene.len() - 2],
            text(r.raw, "toSide"),
            r.to_fixed,
        ),
    ] {
        let Some(b) = boxes.get(id) else {
            continue;
        };
        let side = endpoint_side(point, *b);
        if side.is_none()
            || side.is_some_and(|side| !outward(point, next, side))
            || authored_side.is_some_and(|expected| !expected.is_empty() && Some(expected) != side)
        {
            let owned = authored_side
                .is_some_and(|value| matches!(value, "left" | "right" | "top" | "bottom"))
                || fixed
                || text(r.raw, "route").is_some_and(|value| {
                    !value.is_empty() && value != "auto" && value != "straight"
                });
            emit(out,f,r.index,"geometry-route-quality",if name=="source"{"source-endpoint-side"}else{"target-endpoint-side"},0,format!("relationship {} {name} stub does not truthfully leave/enter its endpoint side",r.index),"choose matching authored endpoint sides, or retain the notice until the engine places an outward perpendicular stub",owned);
        }
    }
}
fn tip_authored(r: &Relation<'_>) -> bool {
    if r.scene.len() < 2 {
        return false;
    }
    let tip = *r.scene.last().unwrap();
    let previous = r.scene[r.scene.len() - 2];
    // A chosen destination face owns a collision on that face even when the
    // engine selected the individual slot along it.
    if text(r.raw, "toSide").is_some_and(|side| matches!(side, "left" | "right" | "top" | "bottom"))
        || r.via.contains(&tip)
        || r.to_anchor == Some(tip)
    {
        return true;
    }
    let (x, y) = active_channels(r);
    (tip.0 == previous.0 && x == Some(tip.0))
        || (tip.1 == previous.1 && y == Some(tip.1))
        || number(r.raw, "y").and_then(q) == Some(tip.1)
}
fn stroke(r: &Relation<'_>, workflow_v2: bool) -> i64 {
    number(r.raw, "width").and_then(q).unwrap_or_else(|| {
        if text(r.raw, "variant") == Some("emphasis") {
            115
        } else if workflow_v2 {
            90
        } else {
            96
        }
    })
}
fn arrows(
    f: Family,
    routes: &[Relation<'_>],
    workflow_v2: bool,
    out: &mut BTreeMap<(usize, String, usize), Diagnostic>,
) {
    for (i, a) in routes.iter().enumerate() {
        for b in routes.iter().skip(i + 1) {
            #[cfg(any(test, feature = "geometry-corpus"))]
            crate::work::record_constraint_evaluation();
            if a.to != b.to || a.scene.len() < 2 || b.scene.len() < 2 {
                continue;
            }
            if !workflow_v2
                && !(f.name == "architecture"
                    && auto_architecture(a.raw)
                    && auto_architecture(b.raw)
                    && a.raw.get("labelAt").is_none()
                    && b.raw.get("labelAt").is_none())
            {
                continue;
            }
            let (tip_a, prev_a) = (*a.scene.last().unwrap(), a.scene[a.scene.len() - 2]);
            let (tip_b, prev_b) = (*b.scene.last().unwrap(), b.scene[b.scene.len() - 2]);
            let horizontal_a = tip_a.1 == prev_a.1;
            let horizontal_b = tip_b.1 == prev_b.1;
            if horizontal_a != horizontal_b {
                continue;
            }
            let (travel_a, travel_b, distance) = if horizontal_a {
                if tip_a.0 != tip_b.0 {
                    continue;
                }
                (
                    tip_a.0 - prev_a.0,
                    tip_b.0 - prev_b.0,
                    (tip_a.1 - tip_b.1).abs(),
                )
            } else {
                if tip_a.1 != tip_b.1 {
                    continue;
                }
                (
                    tip_a.1 - prev_a.1,
                    tip_b.1 - prev_b.1,
                    (tip_a.0 - tip_b.0).abs(),
                )
            };
            if travel_a.signum() != travel_b.signum() {
                continue;
            }
            let overlap = corridor(prev_a, tip_a, prev_b, tip_b);
            if workflow_v2
                && overlap > 0
                && trunk(
                    a,
                    b,
                    &a.scene,
                    &b.scene,
                    a.scene.len() - 2,
                    b.scene.len() - 2,
                    overlap,
                )
            {
                continue;
            }
            let minimum = 7 * (stroke(a, workflow_v2) + stroke(b, workflow_v2));
            if 2 * distance < minimum {
                let (index, other, owned) = pair_owner(a, tip_authored(a), b, tip_authored(b));
                emit(out,f,index,"geometry-route-quality","arrowhead-collision",other,format!("relationships {} and {} have overlapping incoming arrow markers at their shared target",a.index,b.index),"move an offending authored tip/channel; for generated face slots retain the notice until the engine separates its arrow markers",owned);
            }
        }
    }
}

fn node_and_label_safety(
    spec: &Value,
    f: Family,
    g: &GeometryDocument,
    routes: &[Relation<'_>],
    boxes: &BTreeMap<String, Rect>,
    out: &mut BTreeMap<(usize, String, usize), Diagnostic>,
) {
    let reference_family = f.name == "dataflow"
        || (f.name == "lifecycle" && spec.get("schema_version").and_then(Value::as_u64) == Some(1));
    let actual: BTreeMap<_, _> = g
        .nodes
        .iter()
        .map(|n| (n.id.as_str(), rect(n.bounds)))
        .collect();
    for r in routes {
        endpoints(f, r, &actual, out);
        for (id, b) in &actual {
            if *id == r.from || *id == r.to {
                continue;
            }
            if let Some(owned) = near_ownership(r, &r.scene, Domain::Scene, *b, 2 * U, true) {
                emit(
                    out,
                    f,
                    r.index,
                    "geometry-route-clearance",
                    "route-node-clearance",
                    0,
                    format!(
                        "relationship {} enters unrelated node {id:?}'s 2px clearance",
                        r.index
                    ),
                    "move an offending authored via/channel outside the unrelated node",
                    owned,
                );
            }
        }
        for (id, b) in boxes {
            if id.as_str() == r.from || id.as_str() == r.to {
                continue;
            }
            if let Some(owned) = near_ownership(r, &r.authored, Domain::Authored, *b, 2 * U, true) {
                emit(
                    out,
                    f,
                    r.index,
                    "geometry-route-clearance",
                    "route-node-clearance",
                    0,
                    format!(
                        "raw relationship {} enters unrelated node {id:?}'s 2px clearance",
                        r.index
                    ),
                    "move the authored via/channel outside the unrelated node",
                    owned,
                );
            }
        }
        if let Some(label) = r.label {
            if actual.values().any(|b| overlap(label, *b, 2 * U)) {
                emit(
                    out,
                    f,
                    r.index,
                    "geometry-label-overlap",
                    "label-node-overlap",
                    0,
                    format!(
                        "relationship {} label overlaps a node beyond 2px tolerance",
                        r.index
                    ),
                    "move the offending authored labelAt/labelDx/labelDy/labelSegment",
                    label_authored(r),
                );
            }
        }
        if reference_family {
            if let Some(label) = r.reference_label {
                if boxes.values().any(|b| overlap(label, *b, 2 * U)) {
                    emit(
                        out,
                        f,
                        r.index,
                        "geometry-label-overlap",
                        "label-node-overlap",
                        0,
                        format!(
                            "relationship {} authored labelAt mask overlaps a reference node/state",
                            r.index
                        ),
                        "move labelAt or remove the absolute label pin",
                        label_authored(r),
                    );
                }
            }
        }
    }
    for (i, a) in routes.iter().enumerate() {
        for b in routes.iter().skip(i + 1) {
            #[cfg(any(test, feature = "geometry-corpus"))]
            crate::work::record_constraint_evaluation();
            let scene_hit = a
                .label
                .zip(b.label)
                .is_some_and(|(x, y)| overlap(x, y, 2 * U));
            let source_hit = a
                .reference_label
                .zip(b.reference_label)
                .is_some_and(|(x, y)| overlap(x, y, 2 * U));
            if scene_hit || source_hit {
                let (index, other, owned) = pair_owner(a, label_authored(a), b, label_authored(b));
                emit(out,f,index,"geometry-label-overlap","label-label-overlap",other,format!("relationship labels {} and {} overlap beyond 2px tolerance",a.index,b.index),"separate the offending authored label position or segment without changing the text",owned);
            }
        }
    }
}
fn pair_quality(
    spec: &Value,
    f: Family,
    routes: &[Relation<'_>],
    showcase: bool,
    out: &mut BTreeMap<(usize, String, usize), Diagnostic>,
) {
    let workflow_v2 =
        f.name == "workflow" && spec.get("schema_version").and_then(Value::as_u64) == Some(2);
    for a in routes {
        for b in routes {
            if a.index == b.index {
                continue;
            }
            #[cfg(any(test, feature = "geometry-corpus"))]
            crate::work::record_constraint_evaluation();
            let explicit_pair = workflow_v2 && (label_authored(a) || authored_route(b));
            if !showcase && !explicit_pair {
                continue;
            }
            for (label, points, domain) in [
                (a.label, &b.scene, Domain::Scene),
                (a.reference_label, &b.reference, Domain::Reference),
                (
                    if explicit_pair {
                        a.reference_label
                    } else {
                        None
                    },
                    &b.authored,
                    Domain::Authored,
                ),
            ] {
                if let Some(label) = label {
                    if let Some(path_owned) = near_ownership(b, points, domain, label, 4 * U, false)
                    {
                        let (index, other, owned) = pair_owner(a, label_authored(a), b, path_owned);
                        emit(out,f,index,"geometry-route-clearance","label-route-clearance",other,format!("relationship {} label is less than 4px from relationship {} or masks its path",a.index,b.index),"move the offending authored label position or the other authored route control",owned);
                    }
                }
            }
        }
    }
    if !showcase {
        return;
    }
    let via_counts = raw_via_endpoint_counts(routes);
    arrows(f, routes, workflow_v2, out);
    for (i, a) in routes.iter().enumerate() {
        for b in routes.iter().skip(i + 1) {
            let shared = shared_endpoint(a, b);
            let independent = f.name == "architecture"
                && auto_architecture(a.raw)
                && auto_architecture(b.raw)
                && point(a.raw.get("labelAt").unwrap_or(&Value::Null)).is_none()
                && point(b.raw.get("labelAt").unwrap_or(&Value::Null)).is_none();
            for (pa, pb, domain) in [
                (&a.scene, &b.scene, Domain::Scene),
                (&a.reference, &b.reference, Domain::Reference),
                (&a.authored, &b.authored, Domain::Authored),
            ] {
                for (ia, sa) in pa.windows(2).enumerate() {
                    for (ib, sb) in pb.windows(2).enumerate() {
                        if (!shared || workflow_v2)
                            && !(f.name == "architecture"
                                && auto_architecture(a.raw)
                                && auto_architecture(b.raw))
                        {
                            if let Some(p) = crossing_point(sa[0], sa[1], sb[0], sb[1]) {
                                let (index, other, owned) = pair_owner(
                                    a,
                                    path_authored(a, pa, ia, domain, p, p, true),
                                    b,
                                    path_authored(b, pb, ib, domain, p, p, true),
                                );
                                emit(out,f,index,"geometry-route-quality","proper-crossing",other,format!("relationships {} and {} cross at an interior point",a.index,b.index),"move an offending authored via/channel away from the other path",owned);
                            }
                        }
                        let n = corridor(sa[0], sa[1], sb[0], sb[1]);
                        if (!shared || workflow_v2 || independent)
                            && n >= 8 * U
                            && !(workflow_v2 && trunk(a, b, pa, pb, ia, ib, n))
                        {
                            let (p, q) = overlap_span(sa[0], sa[1], sb[0], sb[1])
                                .expect("positive corridor has overlap span");
                            let via_a =
                                shared_via_endpoint_witness(a, ia, domain, p, q, &via_counts);
                            let via_b =
                                shared_via_endpoint_witness(b, ib, domain, p, q, &via_counts);
                            let shared_via = via_a.or(via_b);
                            let (index, other, owned) = pair_owner(
                                a,
                                path_authored(a, pa, ia, domain, p, q, true) || via_a.is_some(),
                                b,
                                path_authored(b, pb, ib, domain, p, q, true) || via_b.is_some(),
                            );
                            let (message, fix) = if let Some(point) = shared_via {
                                let point = point_px(point);
                                (
                                    format!(
                                        "relationships {} and {} share at least 8px of a corridor at shared authored via {point}",
                                        a.index, b.index
                                    ),
                                    format!(
                                        "move shared authored via {point} so its first/last endpoint pieces do not share a corridor"
                                    ),
                                )
                            } else {
                                (
                                    format!(
                                        "relationships {} and {} share at least 8px of a corridor",
                                        a.index, b.index
                                    ),
                                    "separate the offending authored route/channel coordinate"
                                        .into(),
                                )
                            };
                            emit(
                                out,
                                f,
                                index,
                                "geometry-route-quality",
                                "ambiguous-corridor",
                                other,
                                message,
                                &fix,
                                owned,
                            );
                        }
                    }
                }
            }
        }
    }
}

// These source assertions are independent of the generated candidate path.
// In particular, a repaired scene must not erase contradictory via/channel input.
fn asserted_path(r: &Relation<'_>, boxes: &BTreeMap<String, Rect>) -> Vec<Point> {
    if r.via.is_empty() {
        return r.scene.clone();
    }
    let (Some(a), Some(b)) = (boxes.get(r.from), boxes.get(r.to)) else {
        return r.via.clone();
    };
    let mut points = vec![port(*a, text(r.raw, "fromSide"), r.via[0])];
    points.extend(r.via.iter().copied());
    points.push(port(*b, text(r.raw, "toSide"), *r.via.last().unwrap()));
    normalize(&points)
}
fn corridor_pattern(points: &[Point], vertical: bool, coordinate: i64) -> bool {
    let (Some(start), Some(end)) = (points.first().copied(), points.last().copied()) else {
        return false;
    };
    let expected = normalize(&if vertical {
        vec![start, (coordinate, start.1), (coordinate, end.1), end]
    } else {
        vec![start, (start.0, coordinate), (end.0, coordinate), end]
    });
    let orientations = |vertices: &[Point]| {
        vertices
            .windows(2)
            .map(|s| {
                if s[0].0 == s[1].0 {
                    0
                } else if s[0].1 == s[1].1 {
                    1
                } else {
                    2
                }
            })
            .collect::<Vec<_>>()
    };
    orientations(points) == orientations(&expected)
}
fn source_presets(
    spec: &Value,
    f: Family,
    r: &Relation<'_>,
    boxes: &BTreeMap<String, Rect>,
    out: &mut BTreeMap<(usize, String, usize), Diagnostic>,
) {
    #[cfg(any(test, feature = "geometry-corpus"))]
    crate::work::record_constraint_evaluation();

    if f.name != "workflow" || spec.get("schema_version").and_then(Value::as_u64) != Some(2) {
        return;
    }
    let preset = text(r.raw, "route").unwrap_or("auto");
    let permitted = match preset {
        "auto" => &["channelX", "channelY"][..],
        "outside-right" | "return-left" => &["channelX"][..],
        "drop" | "bottom-channel" | "up-channel" => &["channelY"][..],
        _ => &[][..],
    };
    for field in ["channelX", "channelY"] {
        if number(r.raw, field).is_some() && !permitted.contains(&field) {
            emit(
                out,
                f,
                r.index,
                "geometry-route-quality",
                "route-preset-compatibility",
                0,
                format!("route preset {preset:?} cannot preserve authored {field}"),
                "remove the incompatible channel or select a preset that uses its axis",
                true,
            );
        }
    }
    if r.via.is_empty() {
        return;
    }
    let points = asserted_path(r, boxes);
    let duplicate = r.via.windows(2).any(|s| s[0] == s[1])
        || boxes.contains_key(r.from)
            && boxes.contains_key(r.to)
            && (points.first().is_some_and(|p| r.via.first() == Some(p))
                || points.last().is_some_and(|p| r.via.last() == Some(p)));
    if duplicate {
        emit(
            out,
            f,
            r.index,
            "geometry-route-quality",
            "non-zero-route-segments",
            0,
            "authored via contains a duplicate anchor or a zero-length endpoint stub".into(),
            "remove the repeated via point while preserving the other authored route controls",
            true,
        );
    }
    for (field, vertical) in [("channelX", true), ("channelY", false)] {
        let Some(coordinate) = number(r.raw, field).and_then(q) else {
            continue;
        };
        let present = points.windows(2).any(|s| {
            if vertical {
                s[0].0 == coordinate && s[1].0 == coordinate && s[0].1 != s[1].1
            } else {
                s[0].1 == coordinate && s[1].1 == coordinate && s[0].0 != s[1].0
            }
        });
        if !present {
            emit(
                out,
                f,
                r.index,
                "geometry-route-quality",
                "channel-pin-preservation",
                0,
                format!(
                    "authored via path never traverses {field}={}px",
                    coordinate as f64 / 64.0
                ),
                "move the via path onto the authored channel or remove that channel assertion",
                true,
            );
        }
    }
    if preset == "auto" {
        return;
    }
    let (Some(a), Some(b)) = (boxes.get(r.from), boxes.get(r.to)) else {
        return;
    };
    let fits = match preset {
        "straight" => points.len() == 2,
        "drop" => {
            let nodes = array(spec, "nodes");
            let lanes_differ = nodes
                .iter()
                .find(|n| text(n, "id") == Some(r.from))
                .and_then(|n| text(n, "lane"))
                != nodes
                    .iter()
                    .find(|n| text(n, "id") == Some(r.to))
                    .and_then(|n| text(n, "lane"));
            let (upper, lower) = if a.y + a.h / 2 <= b.y + b.h / 2 {
                (a, b)
            } else {
                (b, a)
            };
            lanes_differ
                && (points.len() == 2 && points[0].0 == points[1].0
                    || points.windows(2).any(|s| {
                        s[0].1 == s[1].1
                            && s[0].0 != s[1].0
                            && s[0].1 >= upper.bottom()
                            && s[0].1 <= lower.y
                            && corridor_pattern(&points, false, s[0].1)
                    }))
        }
        "outside-right" => points.windows(2).any(|s| {
            s[0].0 == s[1].0
                && s[0].1 != s[1].1
                && s[0].0 > a.right().max(b.right())
                && corridor_pattern(&points, true, s[0].0)
        }),
        "return-left" => points.windows(2).any(|s| {
            s[0].0 == s[1].0
                && s[0].1 != s[1].1
                && s[0].0 < a.x.min(b.x)
                && corridor_pattern(&points, true, s[0].0)
        }),
        "bottom-channel" => points.windows(2).any(|s| {
            s[0].1 == s[1].1
                && s[0].0 != s[1].0
                && s[0].1 > a.bottom().max(b.bottom())
                && corridor_pattern(&points, false, s[0].1)
        }),
        "up-channel" => points.windows(2).any(|s| {
            s[0].1 == s[1].1
                && s[0].0 != s[1].0
                && s[0].1 < a.y.min(b.y)
                && corridor_pattern(&points, false, s[0].1)
        }),
        _ => false,
    };
    if !fits {
        emit(
            out,
            f,
            r.index,
            "geometry-route-quality",
            "route-preset-compatibility",
            0,
            format!("authored via path does not have the corridor required by preset {preset:?}"),
            "remove the preset assertion or move the authored via corridor to that preset's side",
            true,
        );
    }
}
fn page_checks(
    spec: &Value,
    f: Family,
    r: &Relation<'_>,
    g: &GeometryDocument,
    boxes: &BTreeMap<String, Rect>,
    out: &mut BTreeMap<(usize, String, usize), Diagnostic>,
) {
    let showcase = spec.get("meta").and_then(|m| text(m, "quality_profile")) == Some("showcase");
    let page = array(spec.get("meta").unwrap_or(&Value::Null), "viewBox");
    let source_page =
        super::constraints_workflow_page::workflow_source_page(spec, g).or_else(|| match f.name {
            "dataflow" => Some([940 * U, 720 * U]),
            "lifecycle" if spec.get("schema_version").and_then(Value::as_u64) == Some(1) => {
                Some([980 * U, 660 * U])
            }
            "sequence" => Some([920 * U, i64::from(g.page.bounds.height)]),
            _ => None,
        });
    let width = page
        .first()
        .and_then(Value::as_f64)
        .and_then(q)
        .or_else(|| source_page.map(|size| size[0]))
        .unwrap_or(i64::from(g.page.bounds.width));
    let height = page
        .get(1)
        .and_then(Value::as_f64)
        .and_then(q)
        .or_else(|| source_page.map(|size| size[1]))
        .unwrap_or(i64::from(g.page.bounds.height));
    if showcase && f.name == "architecture" {
        let points = asserted_path(r, boxes);
        for (i, p) in points.iter().copied().enumerate() {
            #[cfg(any(test, feature = "geometry-corpus"))]
            crate::work::record_constraint_evaluation();
            if p.0 >= 0 && p.1 >= 0 && p.0 <= width && p.1 <= height {
                continue;
            }
            let owned = !r.via.is_empty()
                || points.len() > 1
                    && path_authored(
                        r,
                        &points,
                        i.min(points.len() - 2),
                        Domain::Scene,
                        p,
                        p,
                        true,
                    );
            emit(out,f,r.index,"geometry-route-viewbox","route-canvas-containment",0,
                format!("route point [{},{}]px lies outside the {}x{}px canvas",p.0 as f64/64.0,p.1 as f64/64.0,width as f64/64.0,height as f64/64.0),
                "move the offending authored point inside the canvas; enlarge an authored viewBox only for right or bottom overflow",owned);
        }
    }
    let v2 = f.name == "workflow" && spec.get("schema_version").and_then(Value::as_u64) == Some(2);
    if !showcase && !v2 {
        return;
    }
    // Readable-v2 may grow only when the source omitted its page. An authored
    // viewBox remains a hard right/bottom budget, including outside showcase.
    let grow_v2 = v2 && page.is_empty();
    let tolerance = if v2 { 0 } else { U / 2 };
    for label in [r.label, r.reference_label].into_iter().flatten() {
        #[cfg(any(test, feature = "geometry-corpus"))]
        crate::work::record_constraint_evaluation();
        if label.x >= -tolerance
            && label.y >= -tolerance
            && (grow_v2
                || label.right() <= width + tolerance && label.bottom() <= height + tolerance)
        {
            continue;
        }
        emit(out,f,r.index,"geometry-label-viewbox","label-canvas-containment",0,
            format!("relationship label extends outside its {}x{}px canvas beyond the {}px tolerance",width as f64/64.0,height as f64/64.0,tolerance as f64/64.0),
            "move the authored label position inward or enlarge the authored canvas for right/bottom overflow",label_authored(r));
    }
}
fn path_length(points: &[Point]) -> Option<i64> {
    points.windows(2).try_fold(0_i64, |total, s| {
        axis(s[0], s[1])
            .then(|| total.checked_add(length(s[0], s[1])))
            .flatten()
    })
}
fn bounds_of(rects: impl IntoIterator<Item = Rect>) -> Option<Rect> {
    rects.into_iter().fold(None, |acc: Option<Rect>, r| {
        Some(match acc {
            None => r,
            Some(a) => {
                let x = a.x.min(r.x);
                let y = a.y.min(r.y);
                Rect {
                    x,
                    y,
                    w: a.right().max(r.right()) - x,
                    h: a.bottom().max(r.bottom()) - y,
                }
            }
        })
    })
}
fn checked_gp(p: Point) -> Option<GeometryPoint> {
    Some(GeometryPoint {
        x: i32::try_from(p.0).ok()?,
        y: i32::try_from(p.1).ok()?,
    })
}
fn detour_shortest(points: &[Point], boxes: &BTreeMap<String, Rect>) -> Option<i64> {
    let start = *points.first()?;
    let end = *points.last()?;
    let first = points.get(1)?;
    let previous = points.get(points.len().checked_sub(2)?)?;
    let escape = |p: Point, toward: Point| -> Option<Point> {
        if !axis(p, toward) || p == toward {
            return None;
        }
        Some((
            p.0.checked_add((toward.0 - p.0).signum() * 4 * U)?,
            p.1.checked_add((toward.1 - p.1).signum() * 4 * U)?,
        ))
    };
    let a = checked_gp(escape(start, *first)?)?;
    let b = checked_gp(escape(end, *previous)?)?;
    let obstacles = boxes
        .values()
        .map(|r| {
            Some(crate::geometry::GeometryBox {
                x: i32::try_from(r.x.checked_sub(4 * U)?).ok()?,
                y: i32::try_from(r.y.checked_sub(4 * U)?).ok()?,
                width: i32::try_from(r.w.checked_add(8 * U)?).ok()?,
                height: i32::try_from(r.h.checked_add(8 * U)?).ok()?,
            })
        })
        .collect::<Option<Vec<_>>>()?;
    let result = crate::routing::route_orthogonal(a, b, &obstacles, &[]).ok()?;
    path_length(&result.into_iter().map(gp).collect::<Vec<_>>())?.checked_add(8 * U)
}
fn detour_checks(
    spec: &Value,
    f: Family,
    r: &Relation<'_>,
    g: &GeometryDocument,
    boxes: &BTreeMap<String, Rect>,
    routes: &[Relation<'_>],
    out: &mut BTreeMap<(usize, String, usize), Diagnostic>,
) {
    #[cfg(any(test, feature = "geometry-corpus"))]
    crate::work::record_constraint_evaluation();

    // The pinned architecture renderer is the only caller of this opt-in rule.
    if f.name != "architecture"
        || spec.get("meta").and_then(|m| text(m, "quality_profile")) != Some("showcase")
        || r.via.is_empty()
        || boxes.len() > 80
    {
        return;
    }
    let points = asserted_path(r, boxes);
    let Some(actual) = path_length(&points) else {
        return;
    };
    if points.len() < 3 {
        return;
    }
    let direct = length(points[0], *points.last().unwrap());
    if i128::from(actual) * 2 < i128::from(direct) * 5 || actual - direct < 200 * U {
        return;
    }
    let Some(content) = bounds_of(
        boxes
            .values()
            .copied()
            .chain(g.containers.iter().map(|frame| rect(frame.bounds))),
    ) else {
        return;
    };
    let outside = |p: Point| {
        p.0 < content.x || p.0 > content.right() || p.1 < content.y || p.1 > content.bottom()
    };
    let excursion = points
        .iter()
        .map(|p| {
            (content.x - p.0)
                .max(p.0 - content.right())
                .max(content.y - p.1)
                .max(p.1 - content.bottom())
                .max(0)
        })
        .max()
        .unwrap_or(0);
    let empty = points
        .iter()
        .map(|p| {
            boxes
                .values()
                .map(|b| {
                    let dx = (b.x - p.0).max(p.0 - b.right()).max(0);
                    let dy = (b.y - p.1).max(p.1 - b.bottom()).max(0);
                    integer_sqrt(i128::from(dx) * i128::from(dx) + i128::from(dy) * i128::from(dy))
                })
                .min()
                .unwrap_or(0)
        })
        .max()
        .unwrap_or(0);
    if excursion.max(empty) < 96 * U {
        return;
    }
    for other in routes {
        if other.index == r.index || !shared_endpoint(r, other) {
            continue;
        }
        let others = asserted_path(other, boxes);
        if points.windows(2).any(|s| {
            outside(((s[0].0 + s[1].0) / 2, (s[0].1 + s[1].1) / 2))
                && others
                    .windows(2)
                    .any(|t| corridor(s[0], s[1], t[0], t[1]) >= 32 * U)
        }) {
            return;
        }
    }
    let Some(shortest) = detour_shortest(&points, boxes) else {
        return;
    };
    if shortest <= 0
        || i128::from(actual) * 2 < i128::from(shortest) * 5
        || actual - shortest < 200 * U
    {
        return;
    }
    emit(out,f,r.index,"geometry-route-quality","excessive-route-detour",0,
        format!("authored via route travels {}px instead of the {}px obstacle-clearing reference (minimum ratio2.5, excess200px, empty excursion96px)",actual as f64/64.0,shortest as f64/64.0),
        "remove the distant via points or move the authored corridor near its connected nodes while preserving endpoints and labels",true);
}

/// Return authored refusals and exact-allowlisted generated-geometry notices.
pub(crate) fn route_geometry_diagnostics(
    spec: &Value,
    geometry: &GeometryDocument,
) -> Vec<Diagnostic> {
    let Some(f) = family(spec) else {
        return Vec::new();
    };
    let profile = spec.get("meta").and_then(|m| text(m, "quality_profile"));
    let showcase = profile == Some("showcase");
    let border_gate = profile.is_some();
    let boxes = source_boxes(spec, f, geometry);
    let routes = relations(spec, f, geometry, &boxes);
    let mut out = BTreeMap::new();
    for r in &routes {
        // Inspect authored connectors before routing repairs or discards them.
        let raw_path = if !r.authored.is_empty() {
            &r.authored
        } else if text(r.raw, "route") == Some("straight") {
            &r.reference
        } else {
            &r.authored
        };
        if (f.name == "dataflow"
            || f.name == "lifecycle" && !r.raw.get("via").is_some_and(Value::is_array)
            || f.name == "architecture"
                && (text(r.raw, "fromSide").is_some() || text(r.raw, "toSide").is_some()))
            && raw_path.len() >= 2
        {
            let has_authored_route_geometry = r.raw.get("via").is_some_and(Value::is_array)
                || text(r.raw, "route").is_some_and(|route| !route.is_empty() && route != "auto");
            for (id, tip, next, key) in [
                (
                    r.from,
                    raw_path[0],
                    raw_path
                        .iter()
                        .copied()
                        .skip(1)
                        .find(|p| *p != raw_path[0])
                        .unwrap_or(raw_path[0]),
                    "fromSide",
                ),
                (
                    r.to,
                    raw_path[raw_path.len() - 1],
                    raw_path
                        .iter()
                        .copied()
                        .rev()
                        .skip(1)
                        .find(|p| *p != raw_path[raw_path.len() - 1])
                        .unwrap_or(raw_path[raw_path.len() - 1]),
                    "toSide",
                ),
            ] {
                if let Some(bounds) = boxes.get(id) {
                    let explicit_side =
                        text(r.raw, key).filter(|side| !side.is_empty() && *side != "auto");
                    let inferred_side = (!has_authored_route_geometry)
                        .then(|| endpoint_side(tip, *bounds))
                        .flatten();
                    let requested = explicit_side.or(inferred_side);
                    if let Some(side) = requested {
                        if !outward(tip, next, side) {
                            emit(&mut out, f, r.index, "geometry-route-quality",
                                "authored-endpoint-direction", 0,
                                format!("authored route {} does not leave its {side} endpoint outward", r.index),
                                "move the first or last via point outward from the authored side, or choose a matching endpoint side", true);
                        }
                    }
                }
            }
        }
        source_presets(spec, f, r, &boxes, &mut out);
        page_checks(spec, f, r, geometry, &boxes, &mut out);
        detour_checks(spec, f, r, geometry, &boxes, &routes, &mut out);
        let enforce_origin = f.name == "architecture" && showcase
            || f.name == "workflow"
                && spec.get("schema_version").and_then(Value::as_u64) == Some(2);
        if enforce_origin {
            let negative_via = array(r.raw, "via")
                .iter()
                .filter_map(point)
                .any(|p| p.0 < 0 || p.1 < 0);
            let negative_channel = f.name == "workflow"
                && ["channelX", "channelY"]
                    .iter()
                    .any(|key| number(r.raw, key).is_some_and(|v| v < 0.0));
            if negative_via || negative_channel {
                emit(
                    &mut out,
                    f,
                    r.index,
                    "geometry-route-viewbox",
                    "source-origin-containment",
                    0,
                    format!(
                        "authored route {} includes a coordinate before the page origin",
                        r.index
                    ),
                    "move the authored via/channel coordinates to zero or positive values",
                    true,
                );
            }
        }
        if border_gate && f.name != "lifecycle" {
            for frame in &geometry.containers {
                if frame.kind == "activation" || frame.kind == "card" {
                    continue;
                }
                for (points, domain) in [(&r.scene, Domain::Scene), (&r.authored, Domain::Authored)]
                {
                    for (index, s) in points.windows(2).enumerate() {
                        for (a, b) in frame_spans(s[0], s[1], rect(frame.bounds)) {
                            let owned = path_authored(r, points, index, domain, a, b, true);
                            emit(&mut out,f,r.index,"geometry-route-quality","container-border-run",0,format!("relationship {} follows a structural frame border",r.index),"move the offending authored control so it crosses the frame perpendicularly",owned);
                        }
                    }
                }
            }
        }
        if f.name == "workflow"
            && r.from != r.to
            && r.scene.len() == 2
            && length(r.scene[0], r.scene[1]) < 28 * U
        {
            let owned = path_authored(r, &r.scene, 0, Domain::Scene, r.scene[0], r.scene[1], false);
            emit(
                &mut out,
                f,
                r.index,
                "geometry-route-quality",
                "short-direct-route",
                0,
                format!(
                    "relationship {} is shorter than the 28px direct-route minimum",
                    r.index
                ),
                "move the authored endpoints or use a readable authored multi-segment route",
                owned,
            );
        }
        for (points, domain) in [(&r.scene, Domain::Scene), (&r.authored, Domain::Authored)] {
            for (index, s) in points.windows(2).enumerate() {
                if !axis(s[0], s[1])
                    && !(text(r.raw, "route") == Some("straight")
                        && points.len() == 2
                        && matches!(domain, Domain::Scene))
                {
                    let owned = path_authored(r, points, index, domain, s[0], s[1], false);
                    emit(&mut out,f,r.index,"geometry-route-quality","non-orthogonal",0,format!("relationship {} contains a diagonal segment",r.index),"replace the offending authored diagonal via with orthogonal controls or a direct straight route",owned);
                }
            }
            if showcase {
                rhythm(&mut out, f, r, points, domain);
            }
        }
        if border_gate && f.name == "sequence" {
            if let Some(y) = number(r.raw, "y").and_then(q) {
                for segment in array(spec, "segments") {
                    if [number(segment, "from"), number(segment, "to")]
                        .into_iter()
                        .flatten()
                        .filter_map(q)
                        .any(|edge| edge == y)
                    {
                        emit(
                            &mut out,
                            f,
                            r.index,
                            "geometry-route-quality",
                            "container-border-run",
                            0,
                            format!(
                                "message {} follows an authored segment border at y={}px",
                                r.index,
                                y as f64 / 64.0
                            ),
                            "move message y or the authored segment range",
                            true,
                        );
                    }
                }
            }
        }
    }
    node_and_label_safety(spec, f, geometry, &routes, &boxes, &mut out);
    pair_quality(spec, f, &routes, showcase, &mut out);
    let ids = super::allocate_route_ids(
        f.prefix,
        array(spec, f.routes).iter().map(|route| text(route, "id")),
    );
    out.into_values()
        .map(|mut diagnostic| {
            if !is_route_quality_notice(&diagnostic) {
                if let Some(id) = diagnostic
                    .path
                    .rsplit('/')
                    .next()
                    .and_then(|value| value.parse::<usize>().ok())
                    .and_then(|index| ids.get(index))
                {
                    diagnostic
                        .message
                        .push_str(&format!("; authored route {id:?}"));
                }
            }
            diagnostic
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn via_relation<'a>(
        index: usize,
        raw: &'a Value,
        via: Vec<Point>,
        scene_raw: Vec<Point>,
    ) -> Relation<'a> {
        let (scene, scene_ranges) = scene_analysis(&scene_raw);
        Relation {
            index,
            raw,
            from: "from",
            to: "to",
            scene,
            scene_raw,
            scene_ranges,
            from_fixed: false,
            to_fixed: false,
            from_anchor: None,
            to_anchor: None,
            via,
            owned_channel_x: None,
            owned_channel_y: None,
            authored: Vec::new(),
            authored_includes_ports: false,
            reference: Vec::new(),
            label: None,
            reference_label: None,
        }
    }

    fn seed(kind: &str) -> Value {
        serde_json::from_str(match kind {
            "sequence" => include_str!("../../testdata/valid-sequence.json"),
            "dataflow" => include_str!("../../testdata/valid-dataflow.json"),
            _ => include_str!("../../testdata/valid-lifecycle.json"),
        })
        .unwrap()
    }
    fn geometry(spec: &Value) -> GeometryDocument {
        crate::layout::layout_json(&json!({"specJson":spec.to_string()}).to_string())
            .geometry
            .expect("layout retains a diagnostic scene")
    }
    #[test]
    fn architecture_rhythm_separates_source_target_and_interior_segments() {
        for (points, cause) in [
            (vec![(0, 0), (9, 0), (9, 20), (29, 20)], None),
            (vec![(0, 0), (20, 0), (20, 20), (29, 20)], None),
            (vec![(0, 0), (8, 0), (8, 16), (16, 16)], None),
            (
                vec![(0, 0), (7, 0), (7, 20), (27, 20)],
                Some("micro-segment"),
            ),
            (
                vec![(0, 0), (20, 0), (20, 20), (27, 20)],
                Some("micro-segment"),
            ),
            (
                vec![(0, 0), (20, 0), (20, 15), (40, 15)],
                Some("short-interior-segment"),
            ),
        ] {
            let (spec, scene) = fixture(
                "architecture",
                vec![serde_json::json!({"via":points})],
                vec![points],
            );
            let diagnostics = route_geometry_diagnostics(&spec, &scene);
            let rhythm = diagnostics
                .iter()
                .filter(|d| {
                    d.rule.ends_with("/micro-segment")
                        || d.rule.ends_with("/short-interior-segment")
                })
                .collect::<Vec<_>>();
            if let Some(expected) = cause {
                assert!(
                    rhythm.iter().any(|d| d.rule.ends_with(expected)),
                    "{diagnostics:?}"
                );
            } else {
                assert!(rhythm.is_empty(), "{diagnostics:?}");
            }
        }
    }

    #[test]
    fn relationship_labels_do_not_alias_node_labels_with_the_same_source_id() {
        let mut spec = serde_json::json!({"schema_version":1,"diagram_type":"architecture",
            "meta":{"title":"Label identity","output":"identity.html","quality_profile":"showcase"},
            "components":[{"id":"shared","type":"backend","label":"Source","pos":[100,100]},
                {"id":"target","type":"database","label":"Target","pos":[480,100]}],
            "connections":[{"id":"shared","from":"shared","to":"target","label":"Edge","labelAt":[400,300]}]});
        assert!(crate::validate_json(&spec.to_string()).ok);
        let clear = crate::layout::layout_json(
            &serde_json::json!({"specJson":spec.to_string()}).to_string(),
        );
        assert!(clear.ok, "{:?}", clear.diagnostics);
        let mut scene = clear.geometry.unwrap();
        let node_label = scene
            .labels
            .iter_mut()
            .find(|l| l.id.as_deref() == Some("node:shared:label"))
            .unwrap();
        node_label.bounds.x = 1000 * 64;
        node_label.bounds.y = 1000 * 64;
        let edge_label = scene
            .labels
            .iter_mut()
            .find(|l| l.id.as_deref() == Some("edge:shared:label"))
            .unwrap();
        edge_label.bounds.x = 140 * 64;
        edge_label.bounds.y = 120 * 64;
        spec["connections"][0]["labelAt"] = serde_json::json!([160, 130]);
        let diagnostics = route_geometry_diagnostics(&spec, &scene);
        assert!(
            diagnostics
                .iter()
                .any(|d| d.code == "architecture/geometry-label-overlap"
                    && d.path == "/connections/0"),
            "{diagnostics:?}"
        );
        let overlap = crate::layout::layout_json(
            &serde_json::json!({"specJson":spec.to_string()}).to_string(),
        );
        assert!(!overlap.ok);
        assert!(overlap.geometry.is_some());
        assert!(overlap
            .diagnostics
            .iter()
            .any(|d| d.code == "architecture/route-label-space" && d.path == "/connections/0"));
    }

    #[test]
    fn lifecycle_endpoint_side_checks_skip_explicit_via_arrays() {
        let (mut spec, geometry) = fixture(
            "lifecycle",
            vec![json!({"fromSide":"left","toSide":"left","via":[[10,0],[90,0]]})],
            vec![vec![(10, 0), (20, 0), (80, 0), (90, 0)]],
        );
        for via in [json!([[10, 0], [90, 0]]), json!([])] {
            spec["transitions"][0]["via"] = via;
            let diagnostics = route_geometry_diagnostics(&spec, &geometry);
            assert!(cause(&diagnostics, "source-endpoint-side").is_empty());
            assert!(cause(&diagnostics, "target-endpoint-side").is_empty());
            assert!(cause(&diagnostics, "authored-endpoint-direction").is_empty());
        }
    }

    #[test]
    fn route_origin_refusals_follow_the_profile_and_version_gate() {
        let (mut arch, geometry) = fixture(
            "architecture",
            vec![json!({"via":[[-1,30],[20,30]]})],
            vec![vec![(-1, 30), (20, 30)]],
        );
        arch["meta"]["quality_profile"] = json!("standard");
        assert!(cause(
            &route_geometry_diagnostics(&arch, &geometry),
            "source-origin-containment"
        )
        .is_empty());
        arch["meta"]["quality_profile"] = json!("showcase");
        assert_authored(&arch, &geometry, "source-origin-containment", 0);
        let (mut workflow, geometry) = fixture(
            "workflow",
            vec![json!({"channelY":-1,"via":[[-1,30],[20,30]]})],
            vec![vec![(-1, 30), (20, 30)]],
        );
        assert!(cause(
            &route_geometry_diagnostics(&workflow, &geometry),
            "source-origin-containment"
        )
        .is_empty());
        workflow["schema_version"] = json!(2);
        assert_authored(&workflow, &geometry, "source-origin-containment", 0);
    }

    #[test]
    fn authored_micro_and_short_interior_segments_are_not_hidden_by_repair() {
        let mut dataflow = seed("dataflow");
        dataflow["meta"]["quality_profile"] = json!("showcase");
        dataflow["flows"][0]["via"] = json!([[160, 157], [160, 160], [200, 160], [200, 157]]);
        dataflow["flows"][0]["labelAt"] = json!([500, 400]);
        let diagnostics = route_geometry_diagnostics(&dataflow, &geometry(&dataflow));
        assert!(
            diagnostics
                .iter()
                .any(|d| d.code == "dataflow/geometry-route-quality"
                    && d.message.contains("micro-segment")),
            "{diagnostics:?}"
        );
        let mut lifecycle = seed("lifecycle");
        lifecycle["meta"]["quality_profile"] = json!("showcase");
        lifecycle["transitions"][0]["via"] =
            json!([[157, 157], [157, 167], [175, 167], [175, 157]]);
        lifecycle["transitions"][0]["labelAt"] = json!([350, 220]);
        let diagnostics = route_geometry_diagnostics(&lifecycle, &geometry(&lifecycle));
        assert!(
            diagnostics
                .iter()
                .any(|d| d.message.contains("micro-segment")),
            "{diagnostics:?}"
        );
        assert!(
            diagnostics
                .iter()
                .any(|d| d.message.contains("short-interior-segment")),
            "{diagnostics:?}"
        );
        dataflow["meta"]["quality_profile"] = json!("standard");
        assert!(!route_geometry_diagnostics(&dataflow, &geometry(&dataflow))
            .iter()
            .any(|d| d.message.contains("micro-segment")
                || d.message.contains("short-interior-segment")));
    }
    #[test]
    fn a_message_along_a_segment_border_has_the_actual_border_cause() {
        let mut spec = seed("sequence");
        spec["meta"]["quality_profile"] = json!("showcase");
        spec["segments"] = json!([{"from":180,"to":300,"label":"Phase"}]);
        let diagnostics = route_geometry_diagnostics(&spec, &geometry(&spec));
        assert!(
            diagnostics
                .iter()
                .any(|d| d.code == "sequence/geometry-route-quality"
                    && d.message.contains("container-border-run")),
            "{diagnostics:?}"
        );
        spec["meta"]
            .as_object_mut()
            .unwrap()
            .remove("quality_profile");
        assert!(!route_geometry_diagnostics(&spec, &geometry(&spec))
            .iter()
            .any(|d| d.message.contains("container-border-run")));
    }
    #[test]
    fn explicit_source_label_masks_are_checked_against_reference_route_and_state_geometry() {
        let mut df = seed("dataflow");
        df["meta"]["quality_profile"] = json!("showcase");
        df["flows"] = json!([{"from":"a","to":"b","label":"Data","labelAt":[200,170]},{"from":"b","to":"a","label":"Return","labelAt":[220,230]}]);
        let diagnostics = route_geometry_diagnostics(&df, &geometry(&df));
        assert!(
            diagnostics
                .iter()
                .any(|d| d.code == "dataflow/geometry-route-clearance"
                    && d.message.contains("label-route-clearance")),
            "{diagnostics:?}"
        );
        let mut life = seed("lifecycle");
        life["transitions"][0]["labelAt"] = json!([94, 150]);
        let diagnostics = route_geometry_diagnostics(&life, &geometry(&life));
        assert!(
            diagnostics
                .iter()
                .any(|d| d.code == "lifecycle/geometry-label-overlap"),
            "{diagnostics:?}"
        );
    }
    #[test]
    fn classification_and_note_lines_participate_in_reference_label_boxes() {
        for (kind, detail) in [
            ("dataflow", "classification"),
            ("sequence", "note"),
            ("lifecycle", "note"),
        ] {
            let f = family(&json!({"diagram_type":kind})).unwrap();
            let short = json!({"label":"A","labelAt":[100,100]});
            let mut long = short.clone();
            long[detail] = json!("Long secondary line");
            let short = raw_label(&short, f).unwrap();
            let long = raw_label(&long, f).unwrap();
            assert!(long.w > short.w && long.h > short.h);
        }
    }
    #[test]
    fn planned_pins_override_legacy_source_boxes_and_do_not_leave_ghost_overlap() {
        let mut spec = seed("dataflow");
        spec["flows"][0]["labelAt"] = json!([100, 157]);
        let source = spec.to_string();
        let request = json!({"specJson":source,"pinSet":{"sourceSpecSha256":crate::spec_hash(&source),"pins":[{"targetId":"a","targetKind":"node","position":{"x":500*64,"y":400*64}}]}});
        let scene = crate::layout::layout_json(&request.to_string())
            .geometry
            .unwrap();
        let boxes = source_boxes(&spec, family(&spec).unwrap(), &scene);
        assert_eq!(boxes["a"].x, 500 * 64);
        let diagnostics = route_geometry_diagnostics(&spec, &scene);
        assert!(
            !diagnostics
                .iter()
                .any(|d| d.message.contains("label-node-overlap")),
            "{diagnostics:?}"
        );
    }
    #[test]
    fn normalization_removes_only_forward_collinear_points() {
        assert_eq!(normalize(&[(0, 0), (3, 0), (10, 0)]), [(0, 0), (10, 0)]);
        assert_eq!(
            normalize(&[(0, 0), (10, 0), (3, 0)]),
            [(0, 0), (10, 0), (3, 0)]
        );
    }

    fn fixture(
        kind: &str,
        mut raw: Vec<Value>,
        paths: Vec<Vec<(i32, i32)>>,
    ) -> (Value, GeometryDocument) {
        let f = family(&json!({"diagram_type":kind})).unwrap();
        for (index, item) in raw.iter_mut().enumerate() {
            item["id"] = json!(format!("r{index}"));
            if item.get("from").is_none() {
                item["from"] = json!(format!("s{index}"));
            }
            if item.get("to").is_none() {
                item["to"] = json!(format!("t{index}"));
            }
        }
        let routes = paths
            .into_iter()
            .enumerate()
            .map(|(index, points)| crate::geometry::GeometryRoute {
                id: Some(format!("r{index}")),
                from: raw[index]["from"].as_str().unwrap().into(),
                to: raw[index]["to"].as_str().unwrap().into(),
                points: points
                    .into_iter()
                    .map(|(x, y)| crate::geometry::GeometryPoint {
                        x: x * 64,
                        y: y * 64,
                    })
                    .collect(),
                variant: None,
                role: None,
                width: None,
            })
            .collect();
        let mut spec =
            json!({"diagram_type":kind,"schema_version":1,"meta":{"quality_profile":"showcase"}});
        spec[f.nodes] = json!([]);
        spec[f.routes] = Value::Array(raw);
        let bounds = crate::geometry::GeometryBox {
            x: 0,
            y: 0,
            width: 1000 * 64,
            height: 1000 * 64,
        };
        (
            spec,
            GeometryDocument {
                lifecycle_rail: None,
                nodes: vec![],
                containers: vec![],
                routes,
                labels: vec![],
                legend: crate::geometry::GeometryLegend {
                    content_bounds: None,
                    title_y: None,
                    bounds,
                    entries: vec![],
                },
                page: crate::geometry::GeometryPage { bounds },
            },
        )
    }
    fn label_for(index: usize, x: i32, y: i32, w: i32, h: i32) -> crate::geometry::GeometryLabel {
        crate::geometry::GeometryLabel {
            id: Some(format!("edge:r{index}:label")),
            target_id: format!("r{index}"),
            text: "Label".into(),
            bounds: crate::geometry::GeometryBox {
                x: x * 64,
                y: y * 64,
                width: w * 64,
                height: h * 64,
            },
            font: crate::metrics::font_identity(400).unwrap(),
            font_size: 12 * 64,
            glyphs: vec![],
        }
    }
    fn cause<'a>(diagnostics: &'a [Diagnostic], name: &str) -> Vec<&'a Diagnostic> {
        diagnostics
            .iter()
            .filter(|d| d.rule == format!("geometry-v1/{name}"))
            .collect()
    }
    fn assert_notice(spec: &Value, g: &GeometryDocument, name: &str) {
        let diagnostics = route_geometry_diagnostics(spec, g);
        let hits = cause(&diagnostics, name);
        assert!(!hits.is_empty(), "missing {name}: {diagnostics:?}");
        assert!(
            hits.iter().all(|d| is_route_quality_notice(d)),
            "{diagnostics:?}"
        );
    }
    fn assert_authored(spec: &Value, g: &GeometryDocument, name: &str, index: usize) {
        let diagnostics = route_geometry_diagnostics(spec, g);
        let hits = cause(&diagnostics, name);
        let source_family = family(spec).unwrap();
        let ids = super::super::allocate_route_ids(
            source_family.prefix,
            array(spec, source_family.routes)
                .iter()
                .map(|route| text(route, "id")),
        );
        assert!(
            hits.iter().any(|d| !is_route_quality_notice(d)
                && d.message
                    .contains(&format!("authored route {:?}", ids[index]))
                && d.path == format!("/{}/{index}", source_family.routes)),
            "{name}: {diagnostics:?}"
        );
    }

    #[test]
    fn notice_allowlist_is_exact_and_unknown_codes_remain_fatal() {
        for family in [
            "architecture",
            "workflow",
            "sequence",
            "dataflow",
            "lifecycle",
        ] {
            let d = Diagnostic {
                code: format!("{family}/geometry-route-quality-notice"),
                path: "/".into(),
                rule: "geometry-v1/micro-segment".into(),
                message: "automatic".into(),
                fix: "inspect".into(),
            };
            assert!(is_route_quality_notice(&d));
        }
        for code in [
            "unknown/geometry-route-quality-notice",
            "workflow/geometry-route-quality-notice-extra",
            "workflow/geometry-route-quality",
        ] {
            assert!(!is_route_quality_notice(&Diagnostic {
                code: code.into(),
                path: "/".into(),
                rule: "".into(),
                message: "".into(),
                fix: "".into()
            }));
        }
    }
    #[test]
    fn a_later_authored_pair_witness_upgrades_and_repoints_an_earlier_notice() {
        let f = family(&json!({"diagram_type":"workflow"})).unwrap();
        let mut out = BTreeMap::new();
        emit(
            &mut out,
            f,
            0,
            "geometry-route-quality",
            "ambiguous-corridor",
            1,
            "auto witness".into(),
            "fix",
            false,
        );
        emit(
            &mut out,
            f,
            1,
            "geometry-route-quality",
            "ambiguous-corridor",
            0,
            "authored witness".into(),
            "fix",
            true,
        );
        emit(
            &mut out,
            f,
            0,
            "geometry-route-quality",
            "ambiguous-corridor",
            1,
            "later auto".into(),
            "fix",
            false,
        );
        let diagnostics: Vec<_> = out.into_values().collect();
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].path, "/edges/1");
        assert!(!is_route_quality_notice(&diagnostics[0]));
        assert_eq!(diagnostics[0].rule, "geometry-v1/ambiguous-corridor");
        assert!(diagnostics[0].message.contains("authored relationship 1"));
    }
    #[test]
    fn crossing_and_mid_corridor_provenance_is_not_inherited_from_sides() {
        for (name, paths, control) in [
            (
                "proper-crossing",
                vec![
                    vec![(-30, 0), (-20, 0), (20, 0), (30, 0)],
                    vec![(0, -30), (0, -20), (0, 20), (0, 30)],
                ],
                json!({"channelX":0}),
            ),
            (
                "ambiguous-corridor",
                vec![
                    vec![(-30, 0), (-20, 0), (30, 0), (40, 0)],
                    vec![(-10, 0), (0, 0), (20, 0), (30, 0)],
                ],
                json!({"channelY":0}),
            ),
        ] {
            let (mut spec, g) = fixture(
                "workflow",
                vec![json!({"fromSide":"right"}), json!({})],
                paths,
            );
            assert_notice(&spec, &g, name);
            for (key, value) in control.as_object().unwrap() {
                spec["edges"][1][key] = value.clone();
            }
            assert_authored(&spec, &g, name, 1);
        }
    }
    #[test]
    fn shared_first_via_junction_owns_only_the_endpoint_corridor_piece() {
        let corpus: Value =
            serde_json::from_str(include_str!("../../testdata/parity.json")).unwrap();
        let case = corpus["boundaryCases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|case| case["id"].as_str() == Some("e2-boundary-workflow-v2-shared-trunk-25"))
            .expect("pinned Oracle-red shared-trunk witness");
        assert_eq!(case["oracle"]["ok"], false);
        assert!(case["oracle"]["codes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "composition/ambiguous-corridor"));
        let source_json = case["geometryComparison"]["inputJson"]
            .as_str()
            .expect("case retains exact compared source");
        let spec: Value = serde_json::from_str(source_json).unwrap();
        let report = crate::layout::layout_json(&json!({"specJson":source_json}).to_string());
        assert!(!report.ok, "the explicitly shared junction is fatal");
        let scene = report
            .geometry
            .expect("fatal route finding retains geometry");
        let diagnostics = route_geometry_diagnostics(&spec, &scene);
        let shared = cause(&diagnostics, "ambiguous-corridor");
        assert!(
            shared.iter().any(|diagnostic| {
                diagnostic.code == "workflow/geometry-route-quality"
                    && diagnostic.path == "/edges/0"
                    && diagnostic.message.contains("shared authored via [169,119]")
                    && diagnostic
                        .fix
                        .contains("move shared authored via [169,119]")
            }),
            "{diagnostics:?}"
        );

        // Keep the produced scene fixed. Removing the matching first via from
        // the second raw edge makes the same scene corridor engine-owned.
        let mut unshared = spec.clone();
        unshared["edges"][1].as_object_mut().unwrap().remove("via");
        let control = route_geometry_diagnostics(&unshared, &scene);
        let notices = cause(&control, "ambiguous-corridor");
        assert!(!notices.is_empty(), "{control:?}");
        assert!(
            notices.iter().copied().all(is_route_quality_notice),
            "{control:?}"
        );
        assert!(notices
            .iter()
            .all(|diagnostic| !diagnostic.message.contains("shared authored via")));
    }

    #[test]
    fn shared_trunk_23_preserves_the_oracle_green_engine_refusal() {
        let corpus: Value =
            serde_json::from_str(include_str!("../../testdata/parity.json")).unwrap();
        let case = corpus["boundaryCases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|case| case["id"].as_str() == Some("e2-boundary-workflow-v2-shared-trunk-23"))
            .expect("pinned Oracle-green placement boundary");
        assert_eq!(case["oracle"]["ok"], true);
        let source_json = case["geometryComparison"]["inputJson"]
            .as_str()
            .expect("case retains exact compared source");
        let report = crate::layout::layout_json(&json!({"specJson":source_json}).to_string());
        assert!(
            !report.ok,
            "the shifted E2 25px shared piece is authored/fatal"
        );
        let scene = report.geometry.expect("refusal retains placed geometry");
        let diagnostics =
            route_geometry_diagnostics(&serde_json::from_str(source_json).unwrap(), &scene);
        assert!(
            diagnostics.iter().any(|diagnostic| {
                diagnostic.code == "workflow/geometry-route-quality"
                    && diagnostic.path == "/edges/0"
                    && diagnostic.message.contains("shared authored via [167,119]")
            }),
            "{diagnostics:?}"
        );
    }

    #[test]
    fn shared_via_ownership_uses_the_actual_bent_scene_piece_and_raw_edge_count() {
        let via = (100 * U, 50 * U);
        let a_raw = json!({"via":[[100,50],[100,100]]});
        let b_raw = json!({"via":[[20,20],[100,50],[200,50]]});
        let duplicate_raw = json!({"via":[[100,50],[100,50]]});
        let duplicate_waypoints =
            via_relation(0, &duplicate_raw, vec![via, via], vec![(0, 0), via]);
        assert_eq!(
            raw_via_endpoint_counts(&[duplicate_waypoints]).get(&via),
            Some(&1),
            "repeated points on one raw edge count as one edge"
        );
        let a = via_relation(
            0,
            &a_raw,
            vec![via, (100 * U, 100 * U)],
            vec![
                (0, 0),
                (50 * U, 0),
                (50 * U, 50 * U),
                via,
                (100 * U, 100 * U),
            ],
        );
        // This distinct raw edge contains the shared point internally. It
        // still contributes one raw-edge vote for the first edge's endpoint.
        let b = via_relation(
            1,
            &b_raw,
            vec![(20 * U, 20 * U), via, (200 * U, 50 * U)],
            vec![(0, 0), (20 * U, 20 * U), via, (200 * U, 50 * U)],
        );
        let routes = [a, b];
        let counts = raw_via_endpoint_counts(&routes);
        assert_eq!(counts.get(&via), Some(&2));
        let a = &routes[0];
        let bent_piece = a
            .scene_ranges
            .iter()
            .position(|(_, end)| a.scene_raw[*end] == via)
            .expect("scene range ends at the actual shared via");
        assert_eq!(
            shared_via_endpoint_witness(
                a,
                bent_piece,
                Domain::Scene,
                (50 * U, 50 * U),
                via,
                &counts,
            ),
            Some(via)
        );
        let upstream_piece = a
            .scene_ranges
            .iter()
            .position(|(_, end)| a.scene_raw[*end] == (50 * U, 0))
            .expect("scene range ends at the earlier bend");
        assert_eq!(
            shared_via_endpoint_witness(
                a,
                upstream_piece,
                Domain::Scene,
                (0, 0),
                (50 * U, 0),
                &counts,
            ),
            None,
            "a shared endpoint elsewhere on the route cannot own an upstream span"
        );
    }
    #[test]
    fn generated_short_segments_stay_notices_despite_authored_side_or_label() {
        let (mut spec, g) = fixture(
            "workflow",
            vec![json!({"fromSide":"right"})],
            vec![vec![(0, 0), (10, 0), (4, 0), (4, 30)]],
        );
        assert_notice(&spec, &g, "micro-segment");
        spec["edges"][0]["labelAt"] = json!([500, 500]);
        spec["edges"][0]["label"] = json!("L");
        assert_notice(&spec, &g, "micro-segment");
        spec["edges"][0]["channelX"] = json!(4);
        assert_authored(&spec, &g, "micro-segment", 0);
        let (spec, g) = fixture(
            "workflow",
            vec![json!({"fromSide":"right"})],
            vec![vec![(0, 0), (6, 0), (6, 30)]],
        );
        assert_notice(&spec, &g, "micro-segment");
    }
    #[test]
    fn endpoint_direction_is_fatal_only_for_an_authored_side_or_endpoint_bound() {
        let (mut spec, mut g) = fixture(
            "workflow",
            vec![json!({"from":"source"})],
            vec![vec![(10, 10), (30, 10), (40, 10)]],
        );
        g.nodes.push(crate::geometry::GeometryNode {
            final_state: None,
            phase_order: None,
            id: "source".into(),
            bounds: crate::geometry::GeometryBox {
                x: 0,
                y: 0,
                width: 20 * 64,
                height: 20 * 64,
            },
            position_source: crate::geometry::GeometryPositionSource::Automatic,
        });
        assert_notice(&spec, &g, "source-endpoint-side");
        spec["edges"][0]["fromSide"] = json!("right");
        assert_authored(&spec, &g, "source-endpoint-side", 0);
        spec["edges"][0]["fromSide"] = Value::Null;
        for provenance in [
            crate::geometry::GeometryPositionSource::PlannedPin,
            crate::geometry::GeometryPositionSource::AuthoredPosition,
        ] {
            g.nodes[0].position_source = provenance;
            assert_authored(&spec, &g, "source-endpoint-side", 0);
        }
    }
    #[test]
    fn arrow_face_slot_collision_is_owned_by_an_authored_destination_side() {
        let (mut spec, mut g) = fixture(
            "workflow",
            vec![
                json!({"to":"target","toSide":"left"}),
                json!({"to":"target","toSide":"left"}),
            ],
            vec![
                vec![(0, 0), (10, 0), (90, 0), (100, 0)],
                vec![(0, 4), (10, 4), (90, 4), (100, 4)],
            ],
        );
        spec["schema_version"] = json!(2);
        spec["edges"][0]["width"] = json!(8);
        spec["edges"][1]["width"] = json!(7);
        assert_authored(&spec, &g, "arrowhead-collision", 0);
        spec["edges"][0]["toSide"] = Value::Null;
        assert_authored(&spec, &g, "arrowhead-collision", 1);
        spec["edges"][1]["toSide"] = Value::Null;
        assert_notice(&spec, &g, "arrowhead-collision");
        spec["edges"][1]["via"] = json!([[100, 4]]);
        assert_authored(&spec, &g, "arrowhead-collision", 1);
        // Authored faces do not invent an oracle-only slot collision.
        spec["edges"][1]["toSide"] = json!("left");
        for point in &mut g.routes[1].points {
            point.y = 100 * 64;
        }
        assert!(cause(
            &route_geometry_diagnostics(&spec, &g),
            "arrowhead-collision"
        )
        .is_empty());
    }
    #[test]
    fn a_generated_border_run_is_a_notice_but_an_authored_channel_is_refused() {
        let (mut spec, mut g) = fixture(
            "workflow",
            vec![json!({"fromSide":"right"})],
            vec![vec![(10, 0), (20, 0), (80, 0), (90, 0)]],
        );
        g.containers.push(crate::geometry::GeometryContainer {
            id: "frame".into(),
            kind: "group".into(),
            bounds: crate::geometry::GeometryBox {
                x: 0,
                y: 0,
                width: 100 * 64,
                height: 100 * 64,
            },
        });
        assert_notice(&spec, &g, "container-border-run");
        spec["edges"][0]["channelY"] = json!(0);
        assert_authored(&spec, &g, "container-border-run", 0);
    }
    #[test]
    fn label_node_and_label_pair_provenance_belongs_only_to_label_controls() {
        let (mut spec, mut g) = fixture(
            "workflow",
            vec![json!({"label":"L0"}), json!({"label":"L1"})],
            vec![vec![(0, 100), (100, 100)], vec![(0, 200), (100, 200)]],
        );
        g.labels.push(label_for(0, 15, 15, 10, 10));
        g.nodes.push(crate::geometry::GeometryNode {
            final_state: None,
            phase_order: None,
            id: "obstacle".into(),
            bounds: crate::geometry::GeometryBox {
                x: 10 * 64,
                y: 10 * 64,
                width: 20 * 64,
                height: 20 * 64,
            },
            position_source: crate::geometry::GeometryPositionSource::Automatic,
        });
        assert_notice(&spec, &g, "label-node-overlap");
        spec["edges"][0]["labelDx"] = json!(0);
        assert_authored(&spec, &g, "label-node-overlap", 0);
        spec["edges"][0]["labelDx"] = Value::Null;
        g.nodes.clear();
        g.labels.push(label_for(1, 16, 16, 10, 10));
        assert_notice(&spec, &g, "label-label-overlap");
        spec["edges"][1]["labelSegment"] = json!(0);
        assert_authored(&spec, &g, "label-label-overlap", 1);
    }
    #[test]
    fn label_route_clearance_uses_the_clipped_mid_witness_and_repoints_authored_owner() {
        let (mut spec, mut g) = fixture(
            "workflow",
            vec![json!({"label":"L0"}), json!({"fromSide":"right"})],
            vec![
                vec![(0, 100), (100, 100)],
                vec![(0, 0), (10, 0), (90, 0), (100, 0)],
            ],
        );
        g.labels.push(label_for(0, 40, -2, 20, 4));
        assert_notice(&spec, &g, "label-route-clearance");
        spec["edges"][1]["channelY"] = json!(0);
        assert_authored(&spec, &g, "label-route-clearance", 1);
        spec["edges"][1]["channelY"] = Value::Null;
        spec["edges"][0]["labelDy"] = json!(0);
        assert_authored(&spec, &g, "label-route-clearance", 0);
    }
    #[test]
    fn orthogonality_keeps_auto_and_authored_witnesses_separate() {
        let (spec, g) = fixture(
            "workflow",
            vec![json!({}), json!({"via":[[0,50],[10,60]]})],
            vec![
                vec![(0, 0), (10, 10), (20, 10)],
                vec![(0, 50), (10, 60), (20, 60)],
            ],
        );
        let diagnostics = route_geometry_diagnostics(&spec, &g);
        let hits = cause(&diagnostics, "non-orthogonal");
        assert!(hits
            .iter()
            .any(|d| is_route_quality_notice(d) && d.path == "/edges/0"));
        assert!(hits
            .iter()
            .any(|d| !is_route_quality_notice(d) && d.path == "/edges/1"));
    }
    #[test]
    fn null_and_empty_controls_do_not_claim_a_generated_witness() {
        let (spec, g) = fixture(
            "workflow",
            vec![
                json!({"route":null,"fromSide":null,"toSide":null,"via":[],"channelX":null,"channelY":null,"labelAt":null,"labelDx":null,"labelDy":null,"labelSegment":null}),
            ],
            vec![vec![(0, 0), (10, 0), (4, 0), (4, 30)]],
        );
        assert_notice(&spec, &g, "micro-segment");
    }
    #[test]
    fn a_valid_self_loop_has_no_false_direct_distance_refusal() {
        let mut spec: Value =
            serde_json::from_str(include_str!("../../testdata/valid-workflow.json")).unwrap();
        spec["edges"][0]["to"] = spec["edges"][0]["from"].clone();
        spec["edges"][0]["label"] = json!("Loop");
        let g = geometry(&spec);
        let diagnostics = route_geometry_diagnostics(&spec, &g);
        assert!(!diagnostics
            .iter()
            .any(|d| d.rule == "geometry-v1/short-direct-route"));
    }
    #[test]
    fn unrelated_node_clearance_has_auto_and_authored_witnesses_without_a_side_shortcut() {
        let (mut spec, mut g) = fixture(
            "workflow",
            vec![json!({"fromSide":"right"})],
            vec![vec![(0, 20), (10, 20), (90, 20), (100, 20)]],
        );
        g.nodes.push(crate::geometry::GeometryNode {
            final_state: None,
            phase_order: None,
            id: "obstacle".into(),
            bounds: crate::geometry::GeometryBox {
                x: 40 * 64,
                y: 10 * 64,
                width: 20 * 64,
                height: 20 * 64,
            },
            position_source: crate::geometry::GeometryPositionSource::Automatic,
        });
        assert_notice(&spec, &g, "route-node-clearance");
        spec["edges"][0]["via"] = json!([[30, 20], [70, 20]]);
        assert_authored(&spec, &g, "route-node-clearance", 0);
    }
    #[test]
    fn fixed_node_origins_do_not_own_a_generated_middle_crossing() {
        let (spec, mut g) = fixture(
            "workflow",
            vec![json!({"fromSide":"right"}), json!({})],
            vec![
                vec![(-30, 0), (-20, 0), (20, 0), (30, 0)],
                vec![(0, -30), (0, -20), (0, 20), (0, 30)],
            ],
        );
        g.nodes.push(crate::geometry::GeometryNode {
            final_state: None,
            phase_order: None,
            id: "s0".into(),
            bounds: crate::geometry::GeometryBox {
                x: -50 * 64,
                y: -10 * 64,
                width: 20 * 64,
                height: 20 * 64,
            },
            position_source: crate::geometry::GeometryPositionSource::PlannedPin,
        });
        for provenance in [
            crate::geometry::GeometryPositionSource::PlannedPin,
            crate::geometry::GeometryPositionSource::AuthoredPosition,
        ] {
            g.nodes[0].position_source = provenance;
            assert_notice(&spec, &g, "proper-crossing");
        }
    }
    fn detour_fixture(depth: f64, small: bool, snake: bool) -> (Value, GeometryDocument) {
        let (sx, tx, width) = if small {
            (100, 180, 40)
        } else {
            (140, 540, 120)
        };
        let via = if snake {
            json!([
                [sx, 120.0 + depth],
                [tx, 120.0 + depth],
                [tx, 140.0 + depth],
                [sx, 140.0 + depth],
                [sx, 160.0 + depth],
                [tx, 160.0 + depth]
            ])
        } else {
            json!([[sx, 160.0 + depth], [tx, 160.0 + depth]])
        };
        let (spec, mut g) = fixture(
            "architecture",
            vec![json!({"from":"a","to":"b","fromSide":"bottom","toSide":"bottom","via":via})],
            vec![vec![(sx, 160), (tx, 160)]],
        );
        g.nodes = [("a", 80), ("b", if small { 160 } else { 480 })]
            .into_iter()
            .map(|(id, x)| crate::geometry::GeometryNode {
                final_state: None,
                phase_order: None,
                id: id.into(),
                bounds: crate::geometry::GeometryBox {
                    x: x * 64,
                    y: 100 * 64,
                    width: width * 64,
                    height: 60 * 64,
                },
                position_source: crate::geometry::GeometryPositionSource::AuthoredPosition,
            })
            .collect();
        (spec, g)
    }
    #[test]
    fn detour_reference_uses_four_pixel_endpoint_clearance() {
        let (spec, g) = detour_fixture(310.0, false, false);
        let f = family(&spec).unwrap();
        let boxes = source_boxes(&spec, f, &g);
        let rs = relations(&spec, f, &g, &boxes);
        assert_eq!(
            detour_shortest(&asserted_path(&rs[0], &boxes), &boxes),
            Some(408 * 64)
        );
    }
    #[test]
    fn detour_ratio_excess_and_empty_boundaries_are_independently_enforced() {
        for (depth, small, snake, reject) in [
            (309.5, false, false, false),
            (310.5, false, false, true),
            (103.5, true, false, false),
            (104.5, true, false, true),
            (95.0, false, true, false),
            (97.0, false, true, true),
        ] {
            let (spec, g) = detour_fixture(depth, small, snake);
            let d = route_geometry_diagnostics(&spec, &g);
            assert_eq!(
                !cause(&d, "excessive-route-detour").is_empty(),
                reject,
                "depth{depth} small{small} snake{snake}: {d:?}"
            );
        }
    }
    #[test]
    fn v2_presets_and_channel_preservation_are_source_assertions() {
        let (mut spec, g) = fixture(
            "workflow",
            vec![
                json!({"route":"bottom-channel","channelX":200,"via":[[100,10],[100,30],[200,30]]}),
            ],
            vec![vec![(0, 10), (200, 10)]],
        );
        spec["schema_version"] = json!(2);
        assert_authored(&spec, &g, "route-preset-compatibility", 0);
        spec["edges"][0]["route"] = json!("auto");
        assert_authored(&spec, &g, "channel-pin-preservation", 0);
        spec["edges"][0]["channelX"] = json!(100);
        assert!(cause(
            &route_geometry_diagnostics(&spec, &g),
            "channel-pin-preservation"
        )
        .is_empty());
        spec["edges"][0]["channelX"] = Value::Null;
        assert!(cause(
            &route_geometry_diagnostics(&spec, &g),
            "channel-pin-preservation"
        )
        .is_empty());
    }
    #[test]
    fn page_label_collision_preserves_generated_notice_and_authored_failure() {
        let (mut spec, mut g) = fixture(
            "architecture",
            vec![json!({})],
            vec![vec![(10, 10), (100, 10)]],
        );
        spec["meta"]["viewBox"] = json!([200, 200]);
        g.labels.push(label_for(0, 190, 50, 20, 14));
        assert_notice(&spec, &g, "label-canvas-containment");
        spec["connections"][0]["labelAt"] = json!([200, 50]);
        assert_authored(&spec, &g, "label-canvas-containment", 0);
    }
    #[test]
    fn shared_outer_corridor_exempts_related_detours() {
        let (mut spec, g) = detour_fixture(310.5, false, false);
        let mut other = spec["connections"][0].clone();
        other["id"] = json!("shared");
        spec["connections"].as_array_mut().unwrap().push(other);
        assert!(cause(
            &route_geometry_diagnostics(&spec, &g),
            "excessive-route-detour"
        )
        .is_empty());
    }
    #[test]
    fn preset_corridor_requires_its_full_turn_pattern() {
        assert!(corridor_pattern(
            &[(0, 0), (0, 20), (80, 20), (80, 0)],
            false,
            20
        ));
        assert!(!corridor_pattern(
            &[(0, 0), (0, 20), (20, 20), (20, 40), (80, 40), (80, 0)],
            false,
            20
        ));
    }
}
