//! Test-only deterministic layout; production apply/canvas paths do not call it.
mod architecture;
mod constraints;
mod constraints_distance;
mod constraints_frames;
mod constraints_routes;
#[cfg(feature = "geometry-corpus")]
pub(crate) use constraints_routes::is_route_quality_notice;
mod constraints_sequence;
mod constraints_workflow_page;
mod dataflow;
pub mod fixed;
mod lifecycle;
mod presets;
mod sequence;
mod source_budgets;
mod workflow;

pub use crate::geometry::{GeometryBox, GeometryPoint};
pub use crate::routing::RouteRequest;
use crate::{
    common::{self, Meta, Point},
    geometry::*,
    metrics, Diagnostic,
};
pub use fixed::{Coord, FixedPointError, FIXED_UNITS_PER_PIXEL};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// Distance from a node's left edge to its text origin, which is also the span
/// a wrapped node line may not paint past (T6 auto-fit).
const NODE_TEXT_INSET: Coord = 12 * 64;
/// Distance from a node's top edge to the first line's origin.
const NODE_TOP_INSET: Coord = 8 * 64;

/// The three node text roles at one auto-fit step.
#[derive(Clone, Copy)]
struct NodeLabelSizes {
    label: Coord,
    detail: Coord,
    tag: Coord,
}

/// Whole-pixel steps the T6 auto-fit may shrink node text by. The floor is
/// `--type-micro-size` (10px), the smallest type step Maru ships, so auto-fit
/// never draws text smaller than the product already does.
const NODE_LABEL_STEPS: [NodeLabelSizes; 4] = [
    NodeLabelSizes {
        label: 13 * 64,
        detail: 11 * 64,
        tag: 10 * 64,
    },
    NodeLabelSizes {
        label: 12 * 64,
        detail: 10 * 64,
        tag: 10 * 64,
    },
    NodeLabelSizes {
        label: 11 * 64,
        detail: 10 * 64,
        tag: 10 * 64,
    },
    NodeLabelSizes {
        label: 10 * 64,
        detail: 10 * 64,
        tag: 10 * 64,
    },
];

/// Which text roles may have one of their words cut. A cut is the last resort
/// and costs legibility, so it is granted per role: a role whose words all wrap
/// whole keeps them whole even when a sibling role in the same node needs one
/// cut.
#[derive(Clone, Copy)]
struct RoleCuts {
    label: bool,
    detail: bool,
    tag: bool,
}

impl RoleCuts {
    const NONE: Self = Self {
        label: false,
        detail: false,
        tag: false,
    };

    fn any(self) -> bool {
        self.label || self.detail || self.tag
    }
}

/// Whether `text` alone still paints past `available` after every break the
/// whole-word rule can take at the smallest size the ladder tries. Growth only
/// adds height and a larger size only paints wider, so such a word fails every
/// box and size and is the one case that earns a cut.
fn role_needs_cut(
    text: &str,
    weight: u16,
    floor: Coord,
    available: Coord,
) -> Result<bool, Diagnostic> {
    for line in metrics::wrap_label_lines(text, weight, floor, available, false)? {
        if metrics::painted_width(&line, weight, floor)? > i64::from(available) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn smallest_size(role: impl Fn(&NodeLabelSizes) -> Coord) -> Coord {
    NODE_LABEL_STEPS
        .iter()
        .map(role)
        .min()
        .expect("auto-fit has at least one size step")
}

pub(crate) fn failure(rule: &str, cause: impl Into<String>, fix: &str) -> Diagnostic {
    Diagnostic {
        code: format!("document/{rule}"),
        path: "/".into(),
        rule: format!("geometry-v1/{rule}"),
        message: cause.into(),
        fix: fix.into(),
    }
}
fn arithmetic(e: FixedPointError) -> Diagnostic {
    failure("coordinate", e.cause(), e.fix())
}
pub(crate) fn px(value: f64) -> Result<Coord, Diagnostic> {
    fixed::quantize_pixels(value).map_err(arithmetic)
}
pub(crate) fn point(x: f64, y: f64) -> Result<GeometryPoint, Diagnostic> {
    Ok(GeometryPoint {
        x: px(x)?,
        y: px(y)?,
    })
}
fn add(a: Coord, b: Coord) -> Result<Coord, Diagnostic> {
    fixed::checked_add(a, b).map_err(arithmetic)
}
fn rect(x: Coord, y: Coord, w: Coord, h: Coord) -> Result<GeometryBox, Diagnostic> {
    GeometryBox::new(x, y, w, h).map_err(arithmetic)
}
fn inflate(b: GeometryBox, p: Coord) -> Result<GeometryBox, Diagnostic> {
    rect(
        add(b.x, -p)?,
        add(b.y, -p)?,
        add(b.width, add(p, p)?)?,
        add(b.height, add(p, p)?)?,
    )
}

fn contains_bounds(outer: GeometryBox, inner: GeometryBox) -> bool {
    let left = i64::from(outer.x);
    let top = i64::from(outer.y);
    let right = left + i64::from(outer.width);
    let bottom = top + i64::from(outer.height);
    i64::from(inner.x) >= left
        && i64::from(inner.y) >= top
        && i64::from(inner.x) + i64::from(inner.width) <= right
        && i64::from(inner.y) + i64::from(inner.height) <= bottom
}

fn is_node_label(label: &GeometryLabel, node_id: &str) -> bool {
    let prefix = format!("node:{node_id}:");
    label
        .id
        .as_deref()
        .is_some_and(|id| matches!(id.strip_prefix(&prefix), Some("label" | "sublabel" | "tag")))
}

/// Space a standalone SVG keeps between the emitted header band (title plus
/// optional subtitle) and the first content band below it.
pub(crate) const HEADER_GAP: Coord = 12 * 64;

fn is_header_label(label: &GeometryLabel) -> bool {
    matches!(label.id.as_deref(), Some("title") | Some("subtitle"))
}

/// The bottom of the emitted header band, plus the gap that follows it, or 0
/// when the document carries no header text.
///
/// The pinned renderers keep the title (`<h1>`) and the subtitle
/// (`<p class="subtitle">`) in the page template outside the SVG
/// (`sidecars/archify/renderers/shared/utils.mjs`, `applyTemplate`), so their
/// own coordinates start at the band top: workflow `laneY: 52`
/// (`workflow-compiler.mjs:107`), dataflow stage `y=46`
/// (`render-dataflow.mjs`). A Maru SVG carries the header inside its own
/// coordinate space, so the source drawing moves below the measured band. The
/// band is measured from the pinned font metrics rather than assumed, because
/// CJK and multi-line labels are taller than the text length suggests. maru#561.
pub(crate) fn header_floor(geometry: &GeometryDocument) -> Result<Coord, Diagnostic> {
    let mut floor: Option<Coord> = None;
    for label in geometry
        .labels
        .iter()
        .filter(|label| is_header_label(label))
    {
        let bottom = label.bounds.bottom().map_err(arithmetic)?;
        floor = Some(floor.map_or(bottom, |current: Coord| current.max(bottom)));
    }
    match floor {
        Some(bottom) if bottom > 0 => add(bottom, HEADER_GAP),
        _ => Ok(0),
    }
}

/// How far the completed source drawing moves down to clear the emitted header
/// band. The band is added above the drawing, so nothing the source drew in its
/// own top margin ends up under the header. Families that do not reserve it
/// return 0.
pub(crate) fn header_shift(geometry: &GeometryDocument, kind: &str) -> Result<Coord, Diagnostic> {
    match kind {
        "workflow" | "dataflow" => header_floor(geometry),
        _ => Ok(0),
    }
}

/// Move the finished source drawing below the emitted header band.
///
/// Placement, routing and every geometry rule run on the pinned source drawing,
/// where authored coordinates, pins and the source budgets all agree. The header
/// band is Maru page chrome above that drawing, so the shift happens once here:
/// a rigid translation of every source-derived box, route and glyph that leaves
/// the header labels in place and grows the page by the same amount. Translation
/// preserves every source-relative predicate (corridor, spacing, clearance,
/// label fit), which is why the recorded corpus verdicts do not move.
fn translate_drawing(geometry: &mut GeometryDocument, shift: Coord) -> Result<(), Diagnostic> {
    if shift == 0 {
        return Ok(());
    }
    for node in &mut geometry.nodes {
        node.bounds = node
            .bounds
            .checked_translate(0, shift)
            .map_err(arithmetic)?;
    }
    for frame in &mut geometry.containers {
        frame.bounds = frame
            .bounds
            .checked_translate(0, shift)
            .map_err(arithmetic)?;
    }
    for route in &mut geometry.routes {
        for point in &mut route.points {
            *point = point.checked_translate(0, shift).map_err(arithmetic)?;
        }
    }
    for label in geometry
        .labels
        .iter_mut()
        .filter(|label| !is_header_label(label))
    {
        label.bounds = label
            .bounds
            .checked_translate(0, shift)
            .map_err(arithmetic)?;
        for glyph in &mut label.glyphs {
            glyph.position = glyph
                .position
                .checked_translate(0, shift)
                .map_err(arithmetic)?;
            glyph.ink = glyph.ink.checked_translate(0, shift).map_err(arithmetic)?;
        }
    }
    let legend = &mut geometry.legend;
    // An empty legend is a (0,0,0,0) sentinel, not a drawing: translating it
    // would claim a legend below the band that nothing paints.
    if !legend.entries.is_empty() {
        legend.bounds = legend
            .bounds
            .checked_translate(0, shift)
            .map_err(arithmetic)?;
        if let Some(bounds) = legend.content_bounds {
            legend.content_bounds = Some(bounds.checked_translate(0, shift).map_err(arithmetic)?);
        }
        legend.title_y = match legend.title_y {
            Some(y) => Some(add(y, shift)?),
            None => None,
        };
        for entry in &mut legend.entries {
            entry.bounds = entry
                .bounds
                .checked_translate(0, shift)
                .map_err(arithmetic)?;
            if let Some(bounds) = entry.swatch_bounds {
                entry.swatch_bounds = Some(bounds.checked_translate(0, shift).map_err(arithmetic)?);
            }
            if let Some(bounds) = entry.text_bounds {
                entry.text_bounds = Some(bounds.checked_translate(0, shift).map_err(arithmetic)?);
            }
        }
    }
    // The page keeps its origin and grows by the band, which also covers the
    // header the drawing moved away from.
    geometry.page.bounds.height = add(geometry.page.bounds.height, shift)?;
    // Emitted = source + offset. Every authored coordinate (pins, `via`,
    // `channelX/Y`, `labelAt`) stays in source space, so a consumer writing a
    // pin from an emitted canvas position subtracts this offset instead of
    // guessing the header band (maru#561).
    geometry.page.content_offset = Some(GeometryPoint { x: 0, y: shift });
    if let Some(line) = geometry.lifecycle_rail.as_mut() {
        line.from = line.from.checked_translate(0, shift).map_err(arithmetic)?;
        line.to = line.to.checked_translate(0, shift).map_err(arithmetic)?;
    }
    Ok(())
}

/// Label-box assertions the family tests make about the header band.
#[cfg(test)]
pub(crate) mod header_support {
    use crate::geometry::{GeometryBox, GeometryDocument, GeometryLabel};

    pub(crate) fn label<'a>(geometry: &'a GeometryDocument, id: &str) -> &'a GeometryLabel {
        geometry
            .labels
            .iter()
            .find(|label| label.id.as_deref() == Some(id))
            .unwrap_or_else(|| panic!("missing label {id}"))
    }

    /// True when the two measured label boxes share any area: the one property a
    /// header band has to guarantee for every caption below it.
    pub(crate) fn overlap(left: GeometryBox, right: GeometryBox) -> bool {
        left.x < right.x + right.width
            && right.x < left.x + left.width
            && left.y < right.y + right.height
            && right.y < left.y + left.height
    }
}

/// Preserve authored names and reserve them all before naming anonymous routes.
/// Source ordinals, not these display IDs, own failure and diagnostic state.
pub(crate) fn allocate_route_ids<'a>(
    prefix: &str,
    authored: impl IntoIterator<Item = Option<&'a str>>,
) -> Vec<String> {
    let authored: Vec<_> = authored.into_iter().collect();
    let mut used: BTreeSet<String> = authored
        .iter()
        .flatten()
        .map(|id| (*id).to_owned())
        .collect();
    authored
        .into_iter()
        .enumerate()
        .map(|(index, id)| match id {
            Some(id) => id.to_owned(),
            None => {
                let mut candidate = format!("{prefix}:{index}");
                while used.contains(&candidate) {
                    candidate.push_str(":generated");
                }
                used.insert(candidate.clone());
                candidate
            }
        })
        .collect()
}

fn route_clearance(route: &RouteRequest) -> Result<Coord, Diagnostic> {
    // Authored coordinates use the format's 2px centerline clearance. Extra
    // automatic clearance must not turn a valid 3px authored corridor into a
    // repair-induced micro-turn or blocked waypoint.
    if !route.waypoints.is_empty() || route.channel_x.is_some() || route.channel_y.is_some() {
        Ok(2 * 64)
    } else {
        Ok(add(route.width.unwrap_or(2 * 64) / 2, 2 * 64)?.max(4 * 64))
    }
}

pub(crate) struct SceneBuilder {
    pub(crate) document: GeometryDocument,
    pub(crate) diagnostics: Vec<Diagnostic>,
    has_errors: bool,
    #[cfg(test)]
    route_budget: Option<usize>,
    request: LayoutRequest,
    kind: String,
    quality_profile: Option<String>,
    connections: Vec<RouteRequest>,
    routing_nodes: BTreeMap<String, GeometryBox>,
    routing_bounds: Option<Result<GeometryBox, Diagnostic>>,
    routing_obstacles: BTreeMap<Coord, Result<Vec<GeometryBox>, Diagnostic>>,
    routing_label_base: usize,
    cache_enabled: bool,
    cards: Vec<(String, common::Card)>,
    kinds: BTreeMap<String, String>,
    pins: BTreeMap<String, GeometryPin>,
    grown: Vec<GrownNode>,
}

/// A node auto-fit grew before every other node was placed, kept so the scene
/// can settle its growth against the neighbours it ended up with.
#[derive(Clone)]
struct GrownNode {
    index: usize,
    id: String,
    label: String,
    detail: Option<String>,
    tag: Option<String>,
    base: GeometryBox,
    limit: Option<Coord>,
    labels: std::ops::Range<usize>,
}

#[derive(Clone, Copy)]
struct SequenceMessageAnchor {
    route_index: usize,
    point: GeometryPoint,
    clearance: Coord,
}

#[derive(Default)]
struct SequenceMessageAnchorIndex {
    anchors: Vec<SequenceMessageAnchor>,
    max_clearance: Coord,
}

/// Visible endpoint bounds authorize a mask; routing-clearance padding never
/// does. The indexes remain tied to the current node/label order.
#[derive(Debug, Clone)]
struct EndpointMaskBounds {
    bounds: GeometryBox,
    waypoint_indices: BTreeSet<usize>,
}

#[derive(Debug, Clone, Default)]
struct EndpointViaMask {
    nodes: BTreeSet<usize>,
    labels_by_node: BTreeMap<usize, BTreeSet<usize>>,
}

/// Per-via ownership for routing and piece-local ownership for the final
/// centerline check. Endpoint indexes are never exempted globally.
#[derive(Debug, Clone, Default)]
struct EndpointMasks {
    by_via: Vec<EndpointViaMask>,
    nodes: BTreeMap<usize, EndpointMaskBounds>,
    labels: BTreeMap<usize, EndpointMaskBounds>,
    segment_nodes: Vec<BTreeSet<usize>>,
    segment_labels: Vec<BTreeSet<usize>>,
}

fn point_inside_box(bounds: GeometryBox, point: GeometryPoint) -> bool {
    let left = i64::from(bounds.x);
    let top = i64::from(bounds.y);
    let right = left + i64::from(bounds.width);
    let bottom = top + i64::from(bounds.height);
    i64::from(point.x) > left
        && i64::from(point.x) < right
        && i64::from(point.y) > top
        && i64::from(point.y) < bottom
}

/// Mark only the inside run containing an authorized via, including the
/// entering/exiting segment. An outside-to-outside chord through the box has no
/// inside seed and therefore remains blocked.
fn mark_seeded_endpoint_segments(
    points: &[GeometryPoint],
    bounds: GeometryBox,
    seeds: impl IntoIterator<Item = usize>,
    obstacle_index: usize,
    segments: &mut [BTreeSet<usize>],
) {
    if points.is_empty() || segments.is_empty() {
        return;
    }
    let mut seeded = vec![false; points.len()];
    for index in seeds {
        if let Some(value) = seeded.get_mut(index) {
            *value = true;
        }
    }
    let inside: Vec<_> = points
        .iter()
        .map(|point| point_inside_box(bounds, *point))
        .collect();
    let mut index = 0;
    while index < points.len() {
        if !inside[index] {
            index += 1;
            continue;
        }
        let start = index;
        while index + 1 < points.len() && inside[index + 1] {
            index += 1;
        }
        let end = index;
        if seeded[start..=end].iter().any(|seed| *seed) {
            let first_segment = start.saturating_sub(1);
            let last_segment = end.min(segments.len() - 1);
            for segment in &mut segments[first_segment..=last_segment] {
                segment.insert(obstacle_index);
            }
        }
        index += 1;
    }
}

impl SceneBuilder {
    fn new(request: LayoutRequest, kind: &str) -> Self {
        let pins = request
            .pin_set
            .as_ref()
            .map(|s| {
                s.pins
                    .iter()
                    .map(|p| (p.target_id.clone(), p.clone()))
                    .collect()
            })
            .unwrap_or_default();
        Self {
            document: GeometryDocument {
                lifecycle_rail: None,
                nodes: vec![],
                containers: vec![],
                routes: vec![],
                labels: vec![],
                legend: GeometryLegend {
                    content_bounds: None,
                    title_y: None,
                    bounds: GeometryBox {
                        x: 0,
                        y: 0,
                        width: 0,
                        height: 0,
                    },
                    entries: vec![],
                },
                page: GeometryPage {
                    bounds: GeometryBox {
                        x: 0,
                        y: 0,
                        width: 0,
                        height: 0,
                    },
                    content_offset: None,
                },
            },
            diagnostics: vec![],
            has_errors: false,
            #[cfg(test)]
            route_budget: None,
            request,
            kind: kind.into(),
            quality_profile: None,
            connections: vec![],
            routing_nodes: BTreeMap::new(),
            routing_bounds: None,
            routing_obstacles: BTreeMap::new(),
            routing_label_base: 0,
            cache_enabled: true,
            cards: vec![],
            kinds: BTreeMap::new(),
            pins,
            grown: vec![],
        }
    }
    pub(crate) fn pinned_position(&self, id: &str) -> Option<GeometryPoint> {
        self.pins.get(id).map(|p| p.position)
    }
    pub(crate) fn node_bounds(&self, id: &str) -> Option<GeometryBox> {
        self.routing_nodes.get(id).copied().or_else(|| {
            self.document
                .nodes
                .iter()
                .find(|n| n.id == id)
                .map(|n| n.bounds)
        })
    }
    fn text_size(
        &self,
        text: &str,
        weight: u16,
        size: Coord,
    ) -> Result<(Coord, Coord), Diagnostic> {
        if text.is_empty() {
            return Ok((0, 0));
        }
        let mut width = 0;
        let mut height = 0;
        for line in text.split('\n') {
            let m = metrics::measure_text(line, weight, size)?;
            let right = m.advance.max(m.ink.right().map_err(arithmetic)?);
            let left = m.ink.x.min(0);
            width = width.max(fixed::checked_sub(right, left).map_err(arithmetic)?);
            height = add(
                height,
                add(m.ascender, -m.descender)?.max(add(size, size / 2)?),
            )?;
        }
        Ok((width, height))
    }
    fn label(
        &mut self,
        id: &str,
        target: &str,
        text: &str,
        origin: GeometryPoint,
        weight: u16,
        size: Coord,
    ) -> Result<GeometryBox, Diagnostic> {
        let (width, height) = self.text_size(text, weight, size)?;
        let mut bounds = rect(origin.x, origin.y, width, height)?;
        let font = metrics::font_identity(weight)?;
        let mut glyphs = Vec::new();
        let mut top = origin.y;
        for line in text.split('\n') {
            let m = metrics::measure_text(line, weight, size)?;
            let baseline = add(top, m.ascender)?;
            for g in m.glyphs {
                glyphs.push(GeometryGlyph {
                    glyph_id: g.glyph_id,
                    input: g.input,
                    position: GeometryPoint {
                        x: add(origin.x, g.position.x)?,
                        y: add(baseline, g.position.y)?,
                    },
                    ink: g
                        .ink
                        .checked_translate(origin.x, baseline)
                        .map_err(arithmetic)?,
                    advance: g.advance,
                    ignored: g.ignored,
                    replaced: g.replaced,
                });
            }
            self.diagnostics.extend(m.diagnostics);
            top = add(
                top,
                add(m.ascender, -m.descender)?.max(add(size, size / 2)?),
            )?;
        }
        for glyph in &glyphs {
            if glyph.ink.width > 0 && glyph.ink.height > 0 {
                bounds = bounds.union(glyph.ink).map_err(arithmetic)?;
            }
        }
        self.document.labels.push(GeometryLabel {
            id: Some(id.into()),
            target_id: target.into(),
            text: text.into(),
            bounds,
            font,
            font_size: size,
            glyphs,
        });
        Ok(bounds)
    }
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn add_node(
        &mut self,
        id: &str,
        kind: &str,
        label: &str,
        detail: Option<&str>,
        tag: Option<&str>,
        authored: Option<Point>,
        automatic: GeometryPoint,
        size: Option<Point>,
        grow_height_to: Option<Coord>,
    ) -> Result<GeometryBox, Diagnostic> {
        let (tw, th) = self.text_size(label, 700, 13 * 64)?;
        let (dw, dh) = match detail {
            Some(s) => self.text_size(s, 400, 11 * 64)?,
            None => (0, 0),
        };
        let (gw, gh) = match tag {
            Some(s) => self.text_size(s, 400, 10 * 64)?,
            None => (0, 0),
        };
        let desired_w = add(tw.max(dw).max(gw), 32 * 64)?.max(180 * 64);
        let desired_h = add(add(add(th, dh)?, gh)?, 28 * 64)?.max(72 * 64);
        let (width, height) = match size {
            Some(p) => (px(p[0])?, px(p[1])?),
            None => (desired_w, desired_h),
        };
        if width <= 0 || height <= 0 {
            return Err(failure(
                "node-size",
                "node size must be positive",
                "use positive authored dimensions or remove the size override",
            ));
        }
        // T6 auto-fit. The text origin sits one inset inside the node and the
        // admission rule measures painted ink against the node's own edge, so a
        // line wrapped to the same span is admissible by construction. A label
        // that already fits is returned unchanged and keeps its exact bytes.
        let (position, source) = if let Some(pin) = self.pins.get(id) {
            (pin.position, GeometryPositionSource::PlannedPin)
        } else if let Some(p) = authored {
            (point(p[0], p[1])?, GeometryPositionSource::AuthoredPosition)
        } else {
            (automatic, GeometryPositionSource::Automatic)
        };
        let bounds = rect(position.x, position.y, width, height)?;
        bounds.right().map_err(arithmetic)?;
        bounds.bottom().map_err(arithmetic)?;
        let label_mark = self.document.labels.len();
        let bounds = self.place_node_labels(id, label, detail, tag, bounds, grow_height_to)?;
        if bounds.height > height {
            // Every other node's top is fixed before this one grows and growth
            // only extends this box downward, so `settle_grown_nodes` can settle
            // the whole scene in one pass once the family is placed.
            self.grown.push(GrownNode {
                index: self.document.nodes.len(),
                id: id.into(),
                label: label.into(),
                detail: detail.map(str::to_owned),
                tag: tag.map(str::to_owned),
                base: rect(position.x, position.y, width, height)?,
                limit: grow_height_to,
                labels: label_mark..self.document.labels.len(),
            });
        }
        self.document.nodes.push(GeometryNode {
            final_state: None,
            phase_order: None,
            id: id.into(),
            bounds,
            position_source: source,
        });
        self.kinds.insert(id.into(), kind.into());
        Ok(bounds)
    }

    /// Give back the height a grown node took from a neighbour.
    ///
    /// The per-family ceiling is only an upper bound: it describes the slot the
    /// node was meant to own, not what its neighbours actually left free. A
    /// grown candidate that reaches into another node's separation would refuse
    /// the scene for a breach auto-fit made itself, so the ladder runs again
    /// from the same box with the neighbour's edge as its ceiling and steps the
    /// text down until it fits, refusing when no size does.
    fn settle_grown_nodes(&mut self) -> Result<(), Diagnostic> {
        let gap = self.node_overlap_gap();
        for position in (0..self.grown.len()).rev() {
            let record = self.grown[position].clone();
            let Some(limit) = record.limit else {
                continue;
            };
            let bottom = self.document.nodes[record.index]
                .bounds
                .bottom()
                .map_err(arithmetic)?;
            let allowed = self.separation_bottom(&record, gap)?;
            if bottom <= allowed {
                continue;
            }
            let available = Coord::try_from(i64::from(allowed) - i64::from(record.base.y))
                .map_err(|_| {
                    failure(
                        "node-fit-separation",
                        "the separation below this node does not fit a coordinate",
                        "move the node, or reduce its text or dimensions",
                    )
                })?
                .max(record.base.height)
                .min(limit);
            self.document.labels.drain(record.labels.clone());
            let mark = self.document.labels.len();
            let fitted = self.place_node_labels(
                &record.id,
                &record.label,
                record.detail.as_deref(),
                record.tag.as_deref(),
                record.base,
                Some(available),
            )?;
            // Re-placed labels go back where the node's own labels were, so the
            // document keeps its deterministic label order.
            let appended = self.document.labels.split_off(mark);
            self.document
                .labels
                .splice(record.labels.start..record.labels.start, appended);
            self.document.nodes[record.index].bounds = fitted;
        }
        Ok(())
    }

    /// The gap the admission overlap rule requires for this family, in ticks.
    fn node_overlap_gap(&self) -> Coord {
        match self.kind.as_str() {
            "dataflow" | "lifecycle" => 10 * 64,
            _ => 8 * 64,
        }
    }

    /// The lowest bottom this node may reach: its own family ceiling, or the
    /// edge of the first node that shares its columns and sits below it.
    fn separation_bottom(&self, record: &GrownNode, gap: Coord) -> Result<Coord, Diagnostic> {
        let left = i64::from(record.base.x);
        let right = left + i64::from(record.base.width);
        let base_bottom = i64::from(record.base.y) + i64::from(record.base.height);
        let cap = record.limit.map_or(base_bottom, |limit| {
            i64::from(record.base.y) + i64::from(limit)
        });
        let mut allowed = cap;
        for other in &self.document.nodes {
            if other.id == record.id {
                continue;
            }
            let other_top = i64::from(other.bounds.y);
            if other_top < base_bottom {
                // Above, or beside and overlapping the box it started as: growth
                // downward cannot reach it.
                continue;
            }
            let other_left = i64::from(other.bounds.x);
            let other_right = other_left + i64::from(other.bounds.width);
            if other_right + i64::from(gap) <= left || other_left >= right + i64::from(gap) {
                continue;
            }
            allowed = allowed.min(other_top - i64::from(gap));
        }
        Coord::try_from(allowed).map_err(|_| {
            failure(
                "node-fit-separation",
                "the separation below this node is not a representable height",
                "move the node, or reduce its text or dimensions",
            )
        })
    }
    /// Place the three node text roles under the T6 auto-fit ladder.
    ///
    /// The box grows down first, because a taller box keeps the readable
    /// default size; growth stops at the caller's slot ceiling and leaves the
    /// width alone, because wrapping - not a wider box - is what makes a line
    /// fit. Then each step wraps at its own size and keeps the first step whose
    /// painted ink stays inside the node, down to the readable floor. Cutting a
    /// word runs last, after a whole word has failed at every box and size, and
    /// the readable default is placed when nothing fits at all, so the admission
    /// check refuses the geometry Maru would actually draw. The cut is granted
    /// per role, so one role's unbreakable word never splits a sibling's.
    fn place_node_labels(
        &mut self,
        id: &str,
        label: &str,
        detail: Option<&str>,
        tag: Option<&str>,
        bounds: GeometryBox,
        grow_height_to: Option<Coord>,
    ) -> Result<GeometryBox, Diagnostic> {
        let label_mark = self.document.labels.len();
        let diagnostic_mark = self.diagnostics.len();
        if let Some(fitted) = self.place_node_labels_pass(
            id,
            label,
            detail,
            tag,
            bounds,
            grow_height_to,
            RoleCuts::NONE,
            label_mark,
            diagnostic_mark,
        )? {
            return Ok(fitted);
        }
        // Every word kept whole and nothing fit. A role earns a cut only when
        // its own word alone overflows the width at the floor size, so a node
        // whose primary fits whole is never cut because its sublabel did not.
        let available = bounds.width - NODE_TEXT_INSET;
        let cuts = RoleCuts {
            label: role_needs_cut(label, 700, smallest_size(|sizes| sizes.label), available)?,
            detail: match detail {
                Some(text) => {
                    role_needs_cut(text, 400, smallest_size(|sizes| sizes.detail), available)?
                }
                None => false,
            },
            tag: match tag {
                Some(text) => {
                    role_needs_cut(text, 400, smallest_size(|sizes| sizes.tag), available)?
                }
                None => false,
            },
        };
        if cuts.any() {
            if let Some(fitted) = self.place_node_labels_pass(
                id,
                label,
                detail,
                tag,
                bounds,
                grow_height_to,
                cuts,
                label_mark,
                diagnostic_mark,
            )? {
                return Ok(fitted);
            }
        }
        self.place_node_labels_at(
            id,
            label,
            detail,
            tag,
            bounds,
            NODE_LABEL_STEPS[0],
            RoleCuts::NONE,
        )?;
        Ok(bounds)
    }

    /// One full ladder - grow, then every size step - under the given cut
    /// permissions. Labels left by a failed attempt are discarded so the caller
    /// sees only the placement that was accepted.
    #[allow(clippy::too_many_arguments)]
    fn place_node_labels_pass(
        &mut self,
        id: &str,
        label: &str,
        detail: Option<&str>,
        tag: Option<&str>,
        bounds: GeometryBox,
        grow_height_to: Option<Coord>,
        roles: RoleCuts,
        label_mark: usize,
        diagnostic_mark: usize,
    ) -> Result<Option<GeometryBox>, Diagnostic> {
        let mut candidate = bounds;
        self.place_node_labels_at(
            id,
            label,
            detail,
            tag,
            candidate,
            NODE_LABEL_STEPS[0],
            roles,
        )?;
        let (_, overflow_y) = self.placed_node_label_overflow(id, candidate);
        self.document.labels.truncate(label_mark);
        self.diagnostics.truncate(diagnostic_mark);
        if overflow_y > 0 {
            // The wrapped lines are fixed once the width is, so one growth
            // step absorbs the whole overflow; only the ceiling limits it.
            let grown = i64::from(candidate.height) + overflow_y;
            let ceiling = grow_height_to.map_or(i64::from(candidate.height), i64::from);
            let grown = grown.min(ceiling.max(i64::from(candidate.height)));
            candidate.height = Coord::try_from(grown).map_err(|error| {
                failure(
                    "coordinate",
                    error.to_string(),
                    "use a smaller node box or shorter label text",
                )
            })?;
            candidate.bottom().map_err(arithmetic)?;
        }
        for &sizes in NODE_LABEL_STEPS.iter() {
            self.place_node_labels_at(id, label, detail, tag, candidate, sizes, roles)?;
            if self.placed_node_labels_fit(id, candidate) {
                return Ok(Some(candidate));
            }
            self.document.labels.truncate(label_mark);
            self.diagnostics.truncate(diagnostic_mark);
        }
        Ok(None)
    }

    fn place_node_labels_at(
        &mut self,
        id: &str,
        label: &str,
        detail: Option<&str>,
        tag: Option<&str>,
        bounds: GeometryBox,
        sizes: NodeLabelSizes,
        roles: RoleCuts,
    ) -> Result<(), Diagnostic> {
        let available = bounds.width - NODE_TEXT_INSET;
        let x = add(bounds.x, NODE_TEXT_INSET)?;
        let mut y = add(bounds.y, NODE_TOP_INSET)?;
        let (wrapped, height) =
            self.wrap_node_text(label, 700, sizes.label, available, roles.label)?;
        self.label(
            &format!("node:{id}:label"),
            id,
            &wrapped,
            GeometryPoint { x, y },
            700,
            sizes.label,
        )?;
        y = add(y, height)?;
        if let Some(text) = detail {
            let (wrapped, height) =
                self.wrap_node_text(text, 400, sizes.detail, available, roles.detail)?;
            self.label(
                &format!("node:{id}:sublabel"),
                id,
                &wrapped,
                GeometryPoint { x, y },
                400,
                sizes.detail,
            )?;
            y = add(y, height)?;
        }
        if let Some(text) = tag {
            let (wrapped, _) = self.wrap_node_text(text, 400, sizes.tag, available, roles.tag)?;
            self.label(
                &format!("node:{id}:tag"),
                id,
                &wrapped,
                GeometryPoint { x, y },
                400,
                sizes.tag,
            )?;
        }
        Ok(())
    }
    /// How far this node's painted glyphs reach past its own bounds, which is
    /// the span the admission check measures. Zero on both axes means the text
    /// fits as drawn.
    fn placed_node_label_overflow(&self, id: &str, bounds: GeometryBox) -> (i64, i64) {
        let prefix = format!("node:{id}:");
        let left = i64::from(bounds.x);
        let top = i64::from(bounds.y);
        let right = left + i64::from(bounds.width);
        let bottom = top + i64::from(bounds.height);
        let mut overflow_x = 0;
        let mut overflow_y = 0;
        for label in self.document.labels.iter().filter(|label| {
            label
                .id
                .as_deref()
                .is_some_and(|label_id| label_id.starts_with(&prefix))
        }) {
            for glyph in label
                .glyphs
                .iter()
                .filter(|glyph| glyph.ink.width > 0 && glyph.ink.height > 0)
            {
                let glyph_left = i64::from(glyph.ink.x);
                let glyph_top = i64::from(glyph.ink.y);
                let glyph_right = glyph_left + i64::from(glyph.ink.width);
                let glyph_bottom = glyph_top + i64::from(glyph.ink.height);
                overflow_x = overflow_x.max(left - glyph_left).max(glyph_right - right);
                overflow_y = overflow_y.max(top - glyph_top).max(glyph_bottom - bottom);
            }
        }
        (overflow_x.max(0), overflow_y.max(0))
    }
    fn placed_node_labels_fit(&self, id: &str, bounds: GeometryBox) -> bool {
        self.placed_node_label_overflow(id, bounds) == (0, 0)
    }
    /// Wrap one node text role into `available` and report the height of the
    /// lines it produced, so the next role stacks below them.
    fn wrap_node_text(
        &self,
        text: &str,
        weight: u16,
        size: Coord,
        available: Coord,
        allow_token_split: bool,
    ) -> Result<(String, Coord), Diagnostic> {
        let lines = metrics::wrap_label_lines(text, weight, size, available, allow_token_split)?;
        let wrapped = lines.join("\n");
        let (_, height) = self.text_size(&wrapped, weight, size)?;
        Ok((wrapped, height))
    }
    pub(crate) fn add_container(
        &mut self,
        id: &str,
        kind: &str,
        label: &str,
        mut bounds: GeometryBox,
    ) -> Result<GeometryBox, Diagnostic> {
        if !is_derived_container_id(id) {
            if let Some(pin) = self.pins.get(id) {
                bounds.x = pin.position.x;
                bounds.y = pin.position.y;
            }
        }
        bounds.right().map_err(arithmetic)?;
        bounds.bottom().map_err(arithmetic)?;
        self.document.containers.push(GeometryContainer {
            id: id.into(),
            kind: kind.into(),
            bounds,
        });
        if !label.is_empty() {
            self.label(
                &format!("container:{id}:label"),
                id,
                label,
                GeometryPoint {
                    x: add(bounds.x, 12 * 64)?,
                    y: add(bounds.y, 6 * 64)?,
                },
                700,
                13 * 64,
            )?;
        }
        Ok(bounds)
    }
    pub(crate) fn container_for_members(
        &mut self,
        id: &str,
        kind: &str,
        label: &str,
        members: &[String],
        padding: f64,
    ) -> Result<GeometryBox, Diagnostic> {
        let mut union = None;
        for member in members {
            if let Some(b) = self.node_bounds(member) {
                union = Some(match union {
                    None => b,
                    Some(u) => GeometryBox::union(u, b).map_err(arithmetic)?,
                });
            }
        }
        let b = inflate(
            union.unwrap_or(rect(40 * 64, 140 * 64, 200 * 64, 100 * 64)?),
            px(padding)?,
        )?;
        let b = rect(b.x, add(b.y, -28 * 64)?, b.width, add(b.height, 28 * 64)?)?;
        self.add_container(id, kind, label, b)
    }
    fn queue_card(&mut self, id: &str, card: &common::Card) {
        self.cards.push((id.into(), card.clone()));
    }
    fn card(&mut self, id: &str, card: &common::Card) -> Result<(), Diagnostic> {
        let bottom = self
            .document
            .nodes
            .iter()
            .map(|n| n.bounds)
            .chain(self.document.containers.iter().map(|c| c.bounds))
            .try_fold(120 * 64, |value, b| {
                Ok::<_, Diagnostic>(value.max(b.bottom().map_err(arithmetic)?))
            })?;
        let mut bottom = bottom;
        for p in self.document.routes.iter().flat_map(|r| &r.points) {
            bottom = bottom.max(p.y);
        }
        for label in &self.document.labels {
            bottom = bottom.max(label.bounds.bottom().map_err(arithmetic)?);
        }
        let body = card.items.join("\n");
        let (tw, th) = self.text_size(&card.title, 700, 13 * 64)?;
        let (bw, bh) = self.text_size(&body, 400, 12 * 64)?;

        let b = rect(
            32 * 64,
            add(bottom, 40 * 64)?,
            add(tw.max(bw), 32 * 64)?.max(320 * 64),
            add(add(th, bh)?, 32 * 64)?,
        )?;
        let b = self.add_container(id, "card", &card.title, b)?;
        self.label(
            &format!("{id}:items"),
            id,
            &body,
            GeometryPoint {
                x: add(b.x, 16 * 64)?,
                y: add(add(b.y, th)?, 16 * 64)?,
            },
            400,
            12 * 64,
        )?;
        Ok(())
    }
    pub(crate) fn connection(&mut self, mut request: RouteRequest) {
        request.source_index = self.connections.len();
        self.connections.push(request);
    }
    fn route_error(&mut self, route: &RouteRequest, mut diagnostic: Diagnostic) {
        if let Some(suffix) = diagnostic.code.strip_prefix("document/") {
            diagnostic.code = format!("{}/{suffix}", self.kind);
        }
        let collection = match self.kind.as_str() {
            "architecture" => "connections",
            "workflow" => "edges",
            "sequence" => "messages",
            "dataflow" => "flows",
            "lifecycle" => "transitions",
            _ => "routes",
        };
        diagnostic.path = format!("/{collection}/{}", route.source_index);
        diagnostic.message = format!("edge {:?}: {}", route.id, diagnostic.message);
        self.has_errors = true;
        self.diagnostics.push(diagnostic);
    }
    fn route_record(route: &RouteRequest, points: Vec<GeometryPoint>) -> GeometryRoute {
        GeometryRoute {
            id: Some(route.id.clone()),
            from: route.from.clone(),
            to: route.to.clone(),
            points,
            variant: route.variant.clone(),
            role: route.role.clone(),
            width: route.width,
        }
    }
    fn port(
        &self,
        b: GeometryBox,
        side: &str,
        y: Option<Coord>,
        escape: Coord,
    ) -> Result<(GeometryPoint, GeometryPoint), Diagnostic> {
        let midx = add(b.x, b.width / 2)?;
        let midy = y.unwrap_or(add(b.y, b.height / 2)?);
        if let Some(y) = y {
            let dx = if side == "left" { -escape } else { escape };
            let p = GeometryPoint { x: midx, y };
            return Ok((p, p.checked_translate(dx, 0).map_err(arithmetic)?));
        }
        let (p, dx, dy) = match side {
            "left" => (GeometryPoint { x: b.x, y: midy }, -escape, 0),
            "top" => (GeometryPoint { x: midx, y: b.y }, 0, -escape),
            "bottom" => (
                GeometryPoint {
                    x: midx,
                    y: b.bottom().map_err(arithmetic)?,
                },
                0,
                escape,
            ),
            _ => (
                GeometryPoint {
                    x: b.right().map_err(arithmetic)?,
                    y: midy,
                },
                escape,
                0,
            ),
        };
        Ok((p, p.checked_translate(dx, dy).map_err(arithmetic)?))
    }
    /// Placement is complete before routing. Cache only immutable geometry;
    /// relationship labels remain a separate append-only obstacle suffix.
    fn prepare_routing(&mut self) {
        if !self.cache_enabled {
            return;
        }
        self.routing_nodes = self
            .document
            .nodes
            .iter()
            .map(|node| (node.id.clone(), node.bounds))
            .collect();
        self.routing_label_base = self.document.labels.len();
        if let Some(first) = self.document.nodes.first() {
            self.routing_bounds = Some(
                self.document
                    .nodes
                    .iter()
                    .map(|node| node.bounds)
                    .chain(self.document.containers.iter().map(|frame| frame.bounds))
                    .try_fold(first.bounds, |extent, bounds| {
                        extent.union(bounds).map_err(arithmetic)
                    }),
            );
        }
        for route in &self.connections {
            let Ok(clearance) = route_clearance(route) else {
                continue;
            };
            if self.routing_obstacles.contains_key(&clearance) || self.routing_obstacles.len() >= 8
            {
                continue;
            }
            let obstacles = self
                .document
                .nodes
                .iter()
                .map(|node| node.bounds)
                .chain(
                    self.document
                        .containers
                        .iter()
                        .filter(|frame| frame.kind == "card")
                        .map(|frame| frame.bounds),
                )
                .chain(self.document.labels.iter().map(|label| label.bounds))
                .map(|bounds| inflate(bounds, clearance))
                .collect();
            self.routing_obstacles.insert(clearance, obstacles);
        }
    }
    fn endpoint_masks(
        &self,
        r: &RouteRequest,
        clearance: Coord,
    ) -> Result<EndpointMasks, Diagnostic> {
        if r.waypoints.is_empty() {
            return Ok(EndpointMasks::default());
        }

        let mut masks = EndpointMasks {
            by_via: vec![EndpointViaMask::default(); r.waypoints.len()],
            ..EndpointMasks::default()
        };
        let mut endpoint_by_id = BTreeMap::new();
        for (node_index, node) in self.document.nodes.iter().enumerate() {
            #[cfg(any(test, feature = "geometry-corpus"))]
            crate::work::record_endpoint_mask_evaluation();
            if node.id == r.from || node.id == r.to {
                let via_indices: BTreeSet<_> = r
                    .waypoints
                    .iter()
                    .enumerate()
                    .filter_map(|(index, point)| {
                        point_inside_box(node.bounds, *point).then_some(index)
                    })
                    .collect();
                if !via_indices.is_empty() {
                    masks.nodes.insert(
                        node_index,
                        EndpointMaskBounds {
                            bounds: node.bounds,
                            waypoint_indices: via_indices.clone(),
                        },
                    );
                    for via_index in &via_indices {
                        masks.by_via[*via_index].nodes.insert(node_index);
                    }
                    endpoint_by_id.insert(node.id.as_str(), (node_index, node.bounds));
                }
            }
        }
        for (label_index, label) in self.document.labels.iter().enumerate() {
            #[cfg(any(test, feature = "geometry-corpus"))]
            crate::work::record_endpoint_mask_evaluation();
            let Some((node_index, node_bounds)) = endpoint_by_id.get(label.target_id.as_str())
            else {
                continue;
            };
            if !is_node_label(label, label.target_id.as_str())
                || !contains_bounds(*node_bounds, label.bounds)
            {
                continue;
            }
            let node_via_indices = masks
                .nodes
                .get(node_index)
                .into_iter()
                .flat_map(|node| node.waypoint_indices.iter().copied())
                .collect::<Vec<_>>();
            let planning_bounds = inflate(label.bounds, clearance)?;
            let routing_via_indices: BTreeSet<_> = node_via_indices
                .iter()
                .copied()
                .filter(|via_index| point_inside_box(planning_bounds, r.waypoints[*via_index]))
                .collect();
            // The planning obstacle includes clearance. An endpoint via may
            // sit in that padding without owning the visible label itself.
            for via_index in &routing_via_indices {
                masks.by_via[*via_index]
                    .labels_by_node
                    .entry(*node_index)
                    .or_default()
                    .insert(label_index);
            }
            let visible_via_indices: BTreeSet<_> = node_via_indices
                .into_iter()
                .filter(|via_index| point_inside_box(label.bounds, r.waypoints[*via_index]))
                .collect();
            if !visible_via_indices.is_empty() {
                masks.labels.insert(
                    label_index,
                    EndpointMaskBounds {
                        bounds: label.bounds,
                        waypoint_indices: visible_via_indices,
                    },
                );
            }
        }
        Ok(masks)
    }

    fn scope_endpoint_masks_to_path(
        masks: &mut EndpointMasks,
        points: &[GeometryPoint],
        waypoint_point_indices: &[usize],
    ) {
        let segment_count = points.len().saturating_sub(1);
        masks.segment_nodes = vec![BTreeSet::new(); segment_count];
        masks.segment_labels = vec![BTreeSet::new(); segment_count];
        for (node_index, obstacle) in &masks.nodes {
            let seeds = obstacle
                .waypoint_indices
                .iter()
                .filter_map(|waypoint| waypoint_point_indices.get(*waypoint))
                // route_points prefixes the A* path with the physical source tip.
                .map(|point_index| *point_index + 1);
            mark_seeded_endpoint_segments(
                points,
                obstacle.bounds,
                seeds,
                *node_index,
                &mut masks.segment_nodes,
            );
        }
        for (label_index, obstacle) in &masks.labels {
            let seeds = obstacle
                .waypoint_indices
                .iter()
                .filter_map(|waypoint| waypoint_point_indices.get(*waypoint))
                .map(|point_index| *point_index + 1);
            mark_seeded_endpoint_segments(
                points,
                obstacle.bounds,
                seeds,
                *label_index,
                &mut masks.segment_labels,
            );
        }
    }

    fn route_points(
        &self,
        r: &RouteRequest,
    ) -> Result<(Vec<GeometryPoint>, Vec<GeometryBox>, EndpointMasks), Diagnostic> {
        #[cfg(any(test, feature = "geometry-corpus"))]
        crate::work::record_route_evaluation();
        let from = self.node_bounds(&r.from).ok_or_else(|| {
            failure(
                "route-endpoint",
                "route source is missing",
                "restore the referenced node",
            )
        })?;
        let to = self.node_bounds(&r.to).ok_or_else(|| {
            failure(
                "route-endpoint",
                "route target is missing",
                "restore the referenced node",
            )
        })?;
        let dx = i64::from(to.x) + i64::from(to.width) / 2
            - i64::from(from.x)
            - i64::from(from.width) / 2;
        let dy = i64::from(to.y) + i64::from(to.height) / 2
            - i64::from(from.y)
            - i64::from(from.height) / 2;
        let horizontal = if dx >= 0 {
            ("right", "left")
        } else {
            ("left", "right")
        };
        let vertical = if dy >= 0 {
            ("bottom", "top")
        } else {
            ("top", "bottom")
        };
        let clearance = route_clearance(r)?;
        let scene_bounds = match &self.routing_bounds {
            Some(bounds) => bounds.clone()?,
            None => self
                .document
                .nodes
                .iter()
                .map(|node| node.bounds)
                .chain(self.document.containers.iter().map(|frame| frame.bounds))
                .try_fold(from, |extent, bounds| {
                    extent.union(bounds).map_err(arithmetic)
                })?,
        };
        let preset = presets::resolve(&self.kind, r, from, to, scene_bounds, clearance)?;
        let auto_sides = if r.from == r.to {
            ("right", "bottom")
        } else if dy.abs() > dx.abs() {
            vertical
        } else {
            horizontal
        };
        let default_sides = if r.from_y.is_some() {
            if r.from == r.to {
                ("right", "bottom")
            } else {
                horizontal
            }
        } else {
            (
                preset.from_side.unwrap_or(auto_sides.0),
                preset.to_side.unwrap_or(auto_sides.1),
            )
        };
        let escape = add(clearance, 6 * 64)?;
        let (mut a, mut start) = self.port(
            from,
            r.from_side.as_deref().unwrap_or(default_sides.0),
            r.from_y,
            escape,
        )?;
        let to_y = match (r.from == r.to, r.from_y, r.to_y) {
            (true, Some(from), Some(to)) if from == to => Some(add(from, 32 * 64)?),
            _ => r.to_y,
        };
        let (mut z, mut end) = self.port(
            to,
            r.to_side.as_deref().unwrap_or(default_sides.1),
            to_y,
            escape,
        )?;
        if r.from == r.to && r.from_y.is_none() && a == z {
            let side = r.from_side.as_deref().unwrap_or(default_sides.0);
            let horizontal_side = side == "left" || side == "right";
            let spread = (if horizontal_side {
                from.height
            } else {
                from.width
            }) / 4;
            let spread = spread.min(12 * 64);
            let (sx, sy) = if horizontal_side {
                (0, spread)
            } else {
                (spread, 0)
            };
            a = a.checked_translate(-sx, -sy).map_err(arithmetic)?;
            start = start.checked_translate(-sx, -sy).map_err(arithmetic)?;
            z = z.checked_translate(sx, sy).map_err(arithmetic)?;
            end = end.checked_translate(sx, sy).map_err(arithmetic)?;
        }
        let mut waypoints = r.waypoints.clone();
        let channel_x = preset.channel_x;
        let channel_y = preset.channel_y;
        let channels = match (channel_x, channel_y) {
            (Some(x), Some(y)) => vec![
                GeometryPoint { x, y: start.y },
                GeometryPoint { x, y },
                GeometryPoint { x: end.x, y },
            ],
            (Some(x), None) => vec![
                GeometryPoint { x, y: start.y },
                GeometryPoint { x, y: end.y },
            ],
            (None, Some(y)) => vec![
                GeometryPoint { x: start.x, y },
                GeometryPoint { x: end.x, y },
            ],
            _ => vec![],
        };
        if waypoints.is_empty() {
            waypoints = channels;
        }
        let cached = self.routing_obstacles.get(&clearance);
        let mut obstacles = match cached {
            Some(value) => value.clone()?,
            None => self
                .document
                .nodes
                .iter()
                .map(|node| node.bounds)
                .chain(
                    self.document
                        .containers
                        .iter()
                        .filter(|frame| frame.kind == "card")
                        .map(|frame| frame.bounds),
                )
                .map(|bounds| inflate(bounds, clearance))
                .collect::<Result<Vec<_>, _>>()?,
        };
        let first_label = if cached.is_some() {
            self.routing_label_base
        } else {
            0
        };
        let base_obstacle_count = obstacles.len();
        obstacles.extend(
            self.document
                .labels
                .iter()
                .skip(first_label)
                .map(|label| inflate(label.bounds, clearance))
                .collect::<Result<Vec<_>, _>>()?,
        );
        let mut endpoint_masks = self.endpoint_masks(r, clearance)?;
        let routing_endpoint_masks = if endpoint_masks
            .by_via
            .iter()
            .all(|mask| mask.nodes.is_empty())
        {
            Vec::new()
        } else {
            let card_count = self
                .document
                .containers
                .iter()
                .filter(|frame| frame.kind == "card")
                .count();
            let cached_label_count = if cached.is_some() {
                self.routing_label_base
            } else {
                0
            };
            let label_obstacle_index = |label_index: usize| {
                if label_index < cached_label_count {
                    Some(self.document.nodes.len() + card_count + label_index)
                } else if label_index >= first_label {
                    Some(base_obstacle_count + label_index - first_label)
                } else {
                    None
                }
            };
            let mut routing_masks = Vec::new();
            for (waypoint_index, via_mask) in endpoint_masks.by_via.iter().enumerate() {
                for node_index in &via_mask.nodes {
                    let mut obstacle_indices = vec![*node_index];
                    if let Some(label_indices) = via_mask.labels_by_node.get(node_index) {
                        for label_index in label_indices {
                            if let Some(index) = label_obstacle_index(*label_index) {
                                obstacle_indices.push(index);
                            }
                        }
                    }
                    routing_masks.push(crate::routing::EndpointObstacleMask {
                        waypoint_index,
                        obstacle_indices,
                    });
                }
            }
            routing_masks
        };
        let automatic_ports = r.waypoints.is_empty()
            && r.channel_x.is_none()
            && r.channel_y.is_none()
            && preset.channel_x.is_none()
            && preset.channel_y.is_none()
            && r.from_y.is_none()
            && r.to_y.is_none()
            && matches!(r.route.as_deref(), None | Some("auto") | Some("straight"));
        // Target-face slots are a pure function of the whole source graph,
        // not label-placement order. An authored side keeps its orientation;
        // only the otherwise automatic coordinate along that face is spread.
        let target_face = r.to_side.as_deref().unwrap_or(default_sides.1);
        let face_vertical = matches!(target_face, "left" | "right");
        let face_span = if face_vertical { to.height } else { to.width };
        let face_origin = if face_vertical { to.y } else { to.x };
        let mut incoming = Vec::new();
        if automatic_ports {
            for peer in self.connections.iter().filter(|peer| peer.to == r.to) {
                let Some(source) = self.node_bounds(&peer.from) else {
                    continue;
                };
                let peer_dx = i64::from(to.x) + i64::from(to.width) / 2
                    - i64::from(source.x)
                    - i64::from(source.width) / 2;
                let peer_dy = i64::from(to.y) + i64::from(to.height) / 2
                    - i64::from(source.y)
                    - i64::from(source.height) / 2;
                let inferred = if peer.from == peer.to {
                    "bottom"
                } else if peer.from_y.is_none() && peer_dy.abs() > peer_dx.abs() {
                    if peer_dy >= 0 {
                        "top"
                    } else {
                        "bottom"
                    }
                } else if peer_dx >= 0 {
                    "left"
                } else {
                    "right"
                };
                let face = peer.to_side.as_deref().unwrap_or(inferred);
                if face != target_face {
                    continue;
                }
                let movable = peer.waypoints.is_empty()
                    && peer.channel_x.is_none()
                    && peer.channel_y.is_none()
                    && peer.from_y.is_none()
                    && peer.to_y.is_none()
                    && matches!(
                        peer.route.as_deref(),
                        None | Some("auto") | Some("straight")
                    );
                let stroke = peer
                    .width
                    .unwrap_or(if peer.variant.as_deref() == Some("emphasis") {
                        115
                    } else {
                        96
                    });
                incoming.push((peer.source_index, movable, stroke));
            }
        }
        incoming.sort_by_key(|entry| entry.0);
        let mut target_reservations = Vec::new();
        if incoming.len() > 1 {
            for (rank, (ordinal, movable, stroke)) in incoming.iter().enumerate() {
                let along = if *movable {
                    i32::try_from(
                        i64::from(face_span) * (rank as i64 + 1) / (incoming.len() as i64 + 1),
                    )
                    .map_err(|_| {
                        failure(
                            "coordinate",
                            "target slot exceeds the coordinate range",
                            "reduce node dimensions or incoming edge count",
                        )
                    })?
                } else {
                    face_span / 2
                };
                let coordinate = add(face_origin, along)?;
                if *ordinal == r.source_index {
                    let shift =
                        fixed::checked_sub(coordinate, if face_vertical { z.y } else { z.x })
                            .map_err(arithmetic)?;
                    let (sx, sy) = if face_vertical {
                        (0, shift)
                    } else {
                        (shift, 0)
                    };
                    z = z.checked_translate(sx, sy).map_err(arithmetic)?;
                    end = end.checked_translate(sx, sy).map_err(arithmetic)?;
                } else {
                    target_reservations.push((coordinate, *stroke));
                }
            }
        }
        let segment_clear = |tip, outside| {
            !self
                .document
                .nodes
                .iter()
                .map(|n| n.bounds)
                .chain(self.document.labels.iter().map(|l| l.bounds))
                .any(|bounds| segment_hits_box(tip, outside, bounds))
                && !obstacles.iter().any(|o| {
                    i64::from(outside.x) > i64::from(o.x)
                        && i64::from(outside.x) < i64::from(o.x) + i64::from(o.width)
                        && i64::from(outside.y) > i64::from(o.y)
                        && i64::from(outside.y) < i64::from(o.y) + i64::from(o.height)
                })
        };
        let endpoint_candidates =
            |bounds: GeometryBox,
             declared: Option<&str>,
             default: &str,
             first: (GeometryPoint, GeometryPoint)|
             -> Result<Vec<(GeometryPoint, GeometryPoint)>, Diagnostic> {
                let mut result = vec![first];
                if !automatic_ports {
                    return Ok(result);
                }
                let mut sides = vec![declared.unwrap_or(default)];
                if declared.is_none() {
                    for side in ["top", "bottom", "left", "right"] {
                        if !sides.contains(&side) {
                            sides.push(side);
                        }
                    }
                }
                for side in sides {
                    let (tip, outside) = self.port(bounds, side, None, escape)?;
                    let vertical_face = matches!(side, "left" | "right");
                    let span = if vertical_face {
                        bounds.height
                    } else {
                        bounds.width
                    };
                    let near_corner = (span / 2 - 2 * 64).max(0);
                    for shift in [0, -span / 4, span / 4, -near_corner, near_corner] {
                        let (dx, dy) = if vertical_face {
                            (0, shift)
                        } else {
                            (shift, 0)
                        };
                        let pair = (
                            tip.checked_translate(dx, dy).map_err(arithmetic)?,
                            outside.checked_translate(dx, dy).map_err(arithmetic)?,
                        );
                        if !result.contains(&pair) {
                            result.push(pair);
                        }
                    }
                }
                Ok(result)
            };
        let from_candidates =
            endpoint_candidates(from, r.from_side.as_deref(), default_sides.0, (a, start))?;
        let to_candidates =
            endpoint_candidates(to, r.to_side.as_deref(), default_sides.1, (z, end))?;
        let mut last_error = None;
        for (tip, source) in from_candidates {
            for &(target_tip, target) in &to_candidates {
                let same_target_face = match target_face {
                    "left" => target_tip.x == to.x,
                    "right" => target_tip.x == to.right().map_err(arithmetic)?,
                    "top" => target_tip.y == to.y,
                    _ => target_tip.y == to.bottom().map_err(arithmetic)?,
                };
                let our_stroke = r
                    .width
                    .unwrap_or(if r.variant.as_deref() == Some("emphasis") {
                        115
                    } else {
                        96
                    });
                let crowded = same_target_face
                    && target_reservations.iter().any(|(coordinate, stroke)| {
                        let along = if face_vertical {
                            target_tip.y
                        } else {
                            target_tip.x
                        };
                        (i64::from(along) - i64::from(*coordinate)).abs() * 2
                            < 7 * (i64::from(our_stroke) + i64::from(*stroke))
                    });
                if automatic_ports
                    && (crowded
                        || !segment_clear(tip, source)
                        || !segment_clear(target_tip, target)
                        || r.from == r.to && tip == target_tip)
                {
                    continue;
                }
                #[cfg(test)]
                let routed = match self.route_budget {
                    Some(budget) if !routing_endpoint_masks.is_empty() => {
                        crate::routing::route_orthogonal_with_endpoint_masks_and_budget(
                            source,
                            target,
                            &obstacles,
                            &waypoints,
                            &routing_endpoint_masks,
                            budget,
                        )
                        .map(|route| (route.points, route.waypoint_point_indices))
                    }
                    Some(budget) => crate::routing::route_orthogonal_with_budget(
                        source, target, &obstacles, &waypoints, budget,
                    )
                    .map(|points| (points, Vec::new())),
                    None if !routing_endpoint_masks.is_empty() => {
                        crate::routing::route_orthogonal_with_endpoint_masks(
                            source,
                            target,
                            &obstacles,
                            &waypoints,
                            &routing_endpoint_masks,
                        )
                        .map(|route| (route.points, route.waypoint_point_indices))
                    }
                    None => {
                        crate::routing::route_orthogonal(source, target, &obstacles, &waypoints)
                            .map(|points| (points, Vec::new()))
                    }
                };
                #[cfg(not(test))]
                let routed = if routing_endpoint_masks.is_empty() {
                    crate::routing::route_orthogonal(source, target, &obstacles, &waypoints)
                        .map(|points| (points, Vec::new()))
                } else {
                    crate::routing::route_orthogonal_with_endpoint_masks(
                        source,
                        target,
                        &obstacles,
                        &waypoints,
                        &routing_endpoint_masks,
                    )
                    .map(|route| (route.points, route.waypoint_point_indices))
                };
                match routed {
                    Ok((mut points, waypoint_point_indices)) => {
                        points.insert(0, tip);
                        points.push(target_tip);
                        if !routing_endpoint_masks.is_empty() {
                            Self::scope_endpoint_masks_to_path(
                                &mut endpoint_masks,
                                &points,
                                &waypoint_point_indices,
                            );
                        }
                        return Ok((points, obstacles, endpoint_masks));
                    }
                    Err(error) => {
                        // A single edge owns one search budget. Alternative
                        // ports must not multiply that budget or hide exhaustion.
                        if error.code.ends_with("/route-budget") {
                            return Err(error);
                        }
                        last_error = Some(error);
                    }
                }
            }
        }
        Err(last_error.unwrap_or_else(||failure("route-blocked",
            "no automatic endpoint port has an unobstructed escape from its node and labels",
            "move overlapping nodes or labels apart, or provide an unobstructed authored endpoint side")))
    }

    fn label_admission_blocked(&self, bounds: GeometryBox) -> bool {
        // Route search uses inflated obstacles, but label admission uses the
        // format's actual 2px overlap tolerance and profile-gated title masks.
        let overlaps = |other: GeometryBox| {
            let right = i64::from(bounds.x) + i64::from(bounds.width);
            let bottom = i64::from(bounds.y) + i64::from(bounds.height);
            let other_right = i64::from(other.x) + i64::from(other.width);
            let other_bottom = i64::from(other.y) + i64::from(other.height);
            i64::from(bounds.x) < other_right - 2 * 64
                && i64::from(other.x) < right - 2 * 64
                && i64::from(bounds.y) < other_bottom - 2 * 64
                && i64::from(other.y) < bottom - 2 * 64
        };
        self.document.nodes.iter().any(|node| overlaps(node.bounds))
            || self.document.labels.iter().any(|label| {
                let unchecked_title = self.kind == "architecture"
                    && self.quality_profile.is_none()
                    && label.target_id.starts_with("boundary:")
                    || self.kind == "lifecycle"
                        && self.quality_profile.as_deref() != Some("showcase")
                        && label.target_id.starts_with("lane:");
                !unchecked_title && overlaps(label.bounds)
            })
    }

    fn sequence_message_anchors(&self) -> Result<SequenceMessageAnchorIndex, Diagnostic> {
        if self.kind != "sequence" {
            return Ok(SequenceMessageAnchorIndex::default());
        }
        let mut index = SequenceMessageAnchorIndex {
            anchors: Vec::with_capacity(self.connections.len().saturating_mul(4)),
            max_clearance: 0,
        };
        for route in &self.connections {
            let (Some(from_y), Some(authored_to_y)) = (route.from_y, route.to_y) else {
                continue;
            };
            let Some(from) = self.node_bounds(&route.from) else {
                continue;
            };
            let Some(to) = self.node_bounds(&route.to) else {
                continue;
            };
            let from_center = add(from.x, from.width / 2)?;
            let to_center = add(to.x, to.width / 2)?;
            let (default_from, default_to) = if route.from == route.to {
                ("right", "bottom")
            } else if to_center >= from_center {
                ("right", "left")
            } else {
                ("left", "right")
            };
            let from_side = route.from_side.as_deref().unwrap_or(default_from);
            let to_side = route.to_side.as_deref().unwrap_or(default_to);
            let to_y = if route.from == route.to && from_y == authored_to_y {
                add(from_y, 32 * 64)?
            } else {
                authored_to_y
            };
            let clearance = route_clearance(route)?;
            index.max_clearance = index.max_clearance.max(clearance);
            let escape = add(clearance, 6 * 64)?;
            let from_tip = GeometryPoint {
                x: from_center,
                y: from_y,
            };
            let to_tip = GeometryPoint {
                x: to_center,
                y: to_y,
            };
            let from_dx = if from_side == "left" { -escape } else { escape };
            let to_dx = if to_side == "left" { -escape } else { escape };
            index.anchors.push(SequenceMessageAnchor {
                route_index: route.source_index,
                point: from_tip,
                clearance,
            });
            index.anchors.push(SequenceMessageAnchor {
                route_index: route.source_index,
                point: from_tip.checked_translate(from_dx, 0).map_err(arithmetic)?,
                clearance,
            });
            index.anchors.push(SequenceMessageAnchor {
                route_index: route.source_index,
                point: to_tip,
                clearance,
            });
            index.anchors.push(SequenceMessageAnchor {
                route_index: route.source_index,
                point: to_tip.checked_translate(to_dx, 0).map_err(arithmetic)?,
                clearance,
            });
        }
        index
            .anchors
            .sort_by_key(|anchor| (anchor.point.x, anchor.point.y, anchor.route_index));
        Ok(index)
    }

    fn label_near_sequence_anchor(
        &self,
        bounds: GeometryBox,
        route_index: usize,
        sequence_anchors: &SequenceMessageAnchorIndex,
    ) -> Result<bool, Diagnostic> {
        if sequence_anchors.anchors.is_empty() {
            return Ok(false);
        }
        let max_clearance = i64::from(sequence_anchors.max_clearance);
        let search_left = i64::from(bounds.x) - max_clearance;
        let search_right = i64::from(bounds.right().map_err(arithmetic)?) + max_clearance;
        let first = sequence_anchors
            .anchors
            .partition_point(|anchor| i64::from(anchor.point.x) <= search_left);
        let bounds_left = i64::from(bounds.x);
        let bounds_top = i64::from(bounds.y);
        let bounds_right = i64::from(bounds.right().map_err(arithmetic)?);
        let bounds_bottom = i64::from(bounds.bottom().map_err(arithmetic)?);
        Ok(sequence_anchors.anchors[first..]
            .iter()
            .take_while(|anchor| i64::from(anchor.point.x) < search_right)
            .any(|anchor| {
                if anchor.route_index == route_index {
                    return false;
                }
                let clearance = i64::from(anchor.clearance);
                i64::from(anchor.point.x) > bounds_left - clearance
                    && i64::from(anchor.point.x) < bounds_right + clearance
                    && i64::from(anchor.point.y) > bounds_top - clearance
                    && i64::from(anchor.point.y) < bounds_bottom + clearance
            }))
    }

    fn route_label(
        &mut self,
        r: &RouteRequest,
        sequence_anchors: &SequenceMessageAnchorIndex,
    ) -> Result<(Vec<GeometryPoint>, EndpointMasks), Diagnostic> {
        let (points, obstacles, endpoint_masks) = self.route_points(r)?;
        if let Some(text) = r.label.as_deref().filter(|s| !s.is_empty()) {
            let sequence_keepout = self.kind == "sequence"
                && r.label_at.is_none()
                && r.label_dx.is_none()
                && r.label_dy.is_none()
                && r.label_segment.is_none();
            let (w, h) = self.text_size(text, 400, 12 * 64)?;
            let position = if let Some(p) = r.label_at {
                // Authored labelAt is the label center, not its top-left.
                p.checked_translate(-w / 2, -h / 2).map_err(arithmetic)?
            } else {
                let mut candidates: Vec<_> = points
                    .windows(2)
                    .enumerate()
                    .map(|(i, p)| {
                        (
                            i,
                            (i64::from(p[0].x) - i64::from(p[1].x)).abs()
                                + (i64::from(p[0].y) - i64::from(p[1].y)).abs(),
                        )
                    })
                    .collect();
                if let Some(selected) = r.label_segment {
                    candidates.retain(|(i, _)| *i == selected);
                }
                candidates.sort_by_key(|(i, length)| (std::cmp::Reverse(*length), *i));
                let mut found = None;
                for (i, _) in candidates {
                    let p = &points[i..=i + 1];
                    let center = GeometryPoint {
                        x: fixed::checked_midpoint(p[0].x, p[1].x).map_err(arithmetic)?,
                        y: fixed::checked_midpoint(p[0].y, p[1].y).map_err(arithmetic)?,
                    };
                    let flexible =
                        r.label_segment.is_none() && r.label_dx.is_none() && r.label_dy.is_none();
                    let rings = if flexible { 8 } else { 1 };
                    for ring in 0..rings {
                        let step = add(h.max(16 * 64), 8 * 64)?;
                        let gap = add(
                            6 * 64,
                            fixed::checked_scale(step, i64::from(ring), 1).map_err(arithmetic)?,
                        )?;
                        let offsets = if p[0].x == p[1].x {
                            [(add(-w, -gap)?, -h / 2), (gap, -h / 2)]
                        } else {
                            [(-w / 2, add(-h, -gap)?), (-w / 2, gap)]
                        };
                        for (dx, dy) in offsets {
                            let candidate = rect(add(center.x, dx)?, add(center.y, dy)?, w, h)?;
                            if candidate.x < 0 || candidate.y < 0 {
                                continue;
                            }
                            if !obstacles.iter().any(|o| intersects(candidate, *o))
                                && !points
                                    .iter()
                                    .any(|p| candidate.contains(*p).unwrap_or(true))
                                && (!sequence_keepout
                                    || !self.label_near_sequence_anchor(
                                        candidate,
                                        r.source_index,
                                        sequence_anchors,
                                    )?)
                            {
                                found = Some(GeometryPoint {
                                    x: candidate.x,
                                    y: candidate.y,
                                });
                                break;
                            }
                        }
                        if found.is_some() {
                            break;
                        }
                    }
                    if found.is_some() {
                        break;
                    }
                }
                found.ok_or_else(|| {
                    failure(
                        "route-label-space",
                        "no unobstructed route label box is available",
                        "move nodes apart or provide a clear labelAt position",
                    )
                })?
            };
            let position = if r.label_at.is_some() {
                position
            } else {
                position
                    .checked_translate(r.label_dx.unwrap_or(0), r.label_dy.unwrap_or(0))
                    .map_err(arithmetic)?
            };
            let b = rect(position.x, position.y, w, h)?;
            if self.label_admission_blocked(b) {
                return Err(failure(
                    "route-label-space",
                    "authored route label overlaps a node or checked label by more than 2px",
                    "move labelAt or remove the label offset override",
                ));
            }
            self.label(
                &format!("edge:{}:label", r.id),
                &r.id,
                text,
                position,
                400,
                12 * 64,
            )?;
        }
        Ok((points, endpoint_masks))
    }
    fn finish(
        mut self,
        meta: &Meta,
    ) -> Result<(GeometryDocument, Vec<Diagnostic>, bool), Diagnostic> {
        let members = self
            .document
            .nodes
            .iter()
            .map(|n| (GeometryTargetKind::Node, n.id.as_str()))
            .chain(
                self.document
                    .containers
                    .iter()
                    .map(|c| (GeometryTargetKind::Container, c.id.as_str())),
            )
            .chain(
                self.cards
                    .iter()
                    .map(|(id, _)| (GeometryTargetKind::Container, id.as_str())),
            );
        self.diagnostics
            .extend(resolve_pins(&self.request, members).diagnostics);
        self.quality_profile = meta.quality_profile.clone();
        self.connections.sort_by(|a, b| a.id.cmp(&b.id));
        self.settle_grown_nodes()?;
        self.prepare_routing();
        let sequence_anchors = self.sequence_message_anchors()?;
        let mut first_routes = BTreeMap::new();
        let mut cached_points = 0;
        let mut failed = BTreeSet::new();
        for r in self.connections.clone() {
            let label_count = self.document.labels.len();
            let diagnostic_count = self.diagnostics.len();
            match self.route_label(&r, &sequence_anchors) {
                Ok((points, endpoint_masks)) => {
                    if self.cache_enabled && points.len() <= 65_536 - cached_points {
                        cached_points += points.len();
                        first_routes.insert(r.source_index, (label_count, points, endpoint_masks));
                    }
                }
                Err(diagnostic) => {
                    self.document.labels.truncate(label_count);
                    self.diagnostics.truncate(diagnostic_count);
                    failed.insert(r.source_index);
                    self.route_error(&r, diagnostic);
                }
            }
        }
        let mut final_routes = Vec::new();
        for r in self.connections.clone() {
            let points = if failed.contains(&r.source_index) {
                Vec::new()
            } else {
                let reusable = first_routes
                    .remove(&r.source_index)
                    .filter(|(labels, _, _)| {
                        self.cache_enabled && *labels == self.document.labels.len()
                    });
                let (routed, endpoint_masks) = match reusable {
                    Some((_, points, endpoint_masks)) => (Ok(points), endpoint_masks),
                    None => match self.route_points(&r) {
                        Ok((points, _, endpoint_masks)) => (Ok(points), endpoint_masks),
                        Err(error) => (Err(error), EndpointMasks::default()),
                    },
                };
                let result = routed.and_then(|points| {
                    if points.windows(2).enumerate().any(|(segment_index, pair)| {
                        let segment_node_masks = endpoint_masks.segment_nodes.get(segment_index);
                        let segment_label_masks = endpoint_masks.segment_labels.get(segment_index);
                        self.document.nodes.iter().enumerate().any(|(index, node)| {
                            #[cfg(any(test, feature = "geometry-corpus"))]
                            if !r.waypoints.is_empty() {
                                crate::work::record_endpoint_clearance_evaluation();
                            }
                            !segment_node_masks.is_some_and(|masked| masked.contains(&index))
                                && segment_hits_box(pair[0], pair[1], node.bounds)
                        }) || self
                            .document
                            .labels
                            .iter()
                            .enumerate()
                            .any(|(index, label)| {
                                #[cfg(any(test, feature = "geometry-corpus"))]
                                if !r.waypoints.is_empty() {
                                    crate::work::record_endpoint_clearance_evaluation();
                                }
                                !segment_label_masks.is_some_and(|masked| masked.contains(&index))
                                    && segment_hits_box(pair[0], pair[1], label.bounds)
                            })
                    }) {
                        Err(failure(
                            "route-port-blocked",
                            "an endpoint escape crosses a node or label",
                            "move overlapping nodes/labels or choose a clear endpoint side",
                        ))
                    } else {
                        Ok(points)
                    }
                });
                match result {
                    Ok(points) => points,
                    Err(diagnostic) => {
                        self.route_error(&r, diagnostic);
                        Vec::new()
                    }
                }
            };
            if r.route.as_deref() == Some("straight") && !points.is_empty() {
                let first = points[0];
                let collinear =
                    points.iter().all(|p| p.x == first.x) || points.iter().all(|p| p.y == first.y);
                if !collinear {
                    let collection = match self.kind.as_str() {
                        "architecture" => "connections",
                        "workflow" => "edges",
                        "sequence" => "messages",
                        "dataflow" => "flows",
                        _ => "transitions",
                    };
                    self.diagnostics.push(Diagnostic{code:format!("{}/route-preset-adjusted",self.kind),path:format!("/{collection}/{}",r.source_index),rule:"geometry-v1/orthogonal-straight-preference".into(),message:format!("edge {:?} preset straight requires bends to keep its route orthogonal and obstacle-free",r.id),fix:"align endpoints on a clear axis for a straight segment, or select an orthogonal/channel preset".into()});
                }
            }
            final_routes.push(Self::route_record(&r, points));
        }
        self.document.routes = final_routes;
        for (id, card) in self.cards.clone() {
            self.card(&id, &card)?;
        }
        let mut extent = rect(0, 0, 64, 64)?;
        for b in self
            .document
            .nodes
            .iter()
            .map(|n| n.bounds)
            .chain(self.document.containers.iter().map(|c| c.bounds))
            .chain(self.document.labels.iter().map(|l| l.bounds))
        {
            extent = extent.union(b).map_err(arithmetic)?;
        }
        for p in self.document.routes.iter().flat_map(|r| &r.points) {
            extent = extent.union(rect(p.x, p.y, 0, 0)?).map_err(arithmetic)?;
        }
        if self.kind == "lifecycle" {
            // Pinned render-lifecycle.mjs:784-786,851-853: x-22px, radius 4.5px.
            const INITIAL_DOT_RADIUS: Coord = 288;
            const INITIAL_DOT_OFFSET_X: Coord = 22 * 64;
            for node in self
                .document
                .nodes
                .iter()
                .filter(|node| self.kinds.get(&node.id).is_some_and(|kind| kind == "start"))
            {
                let center_x = add(node.bounds.x, -INITIAL_DOT_OFFSET_X)?;
                let center_y = add(node.bounds.y, node.bounds.height / 2)?;
                let marker_bounds = rect(
                    add(center_x, -INITIAL_DOT_RADIUS)?,
                    add(center_y, -INITIAL_DOT_RADIUS)?,
                    2 * INITIAL_DOT_RADIUS,
                    2 * INITIAL_DOT_RADIUS,
                )?;
                extent = extent.union(marker_bounds).map_err(arithmetic)?;
            }
        }
        let legend_y = add(extent.bottom().map_err(arithmetic)?, 32 * 64)?;
        let row_start_x = 40 * 64;
        let sequence_legend = self.kind == "sequence";
        let legend_font_size = if sequence_legend { 8 * 64 } else { 12 * 64 };
        let row_width_limit = px(meta.view_box.unwrap_or([920.0, 640.0])[0])? - 80 * 64;
        let mut x = row_start_x;
        let mut row_y = legend_y;
        let mut entries = vec![];
        let mut row_height = if sequence_legend { 22 * 64 } else { 0 };
        let mut total_row_height = 0;
        let mut max_row_right = row_start_x;
        let mut kinds: BTreeSet<String> = if self.kind == "sequence" || self.kind == "dataflow" {
            let mut entries: BTreeSet<_> = self
                .connections
                .iter()
                .map(|r| r.variant.clone().unwrap_or_else(|| "default".into()))
                .collect();
            if self.kind == "dataflow" && self.kinds.values().any(|k| k == "database") {
                entries.insert("database".into());
            }
            entries
        } else {
            self.kinds.values().cloned().collect()
        };
        let present = kinds.clone();
        if meta.legend.as_ref().and_then(|l| l.mode.as_deref()) == Some("all") {
            kinds.extend(
                common::legend_keys(&self.kind)
                    .into_iter()
                    .map(str::to_owned),
            );
        }
        if let Some(entries) = meta.legend.as_ref().and_then(|l| l.entries.as_ref()) {
            kinds.extend(
                entries
                    .iter()
                    .filter(|(_, e)| e.visible == Some(true))
                    .map(|(key, _)| key.clone()),
            );
        }
        if meta.legend.as_ref().and_then(|l| l.mode.as_deref()) == Some("hidden") {
            kinds.clear();
        }
        // Pinned catalog order, with per-entry overrides applied below.
        let catalog: &[&str] = match self.kind.as_str() {
            "architecture" => &[
                "frontend",
                "backend",
                "database",
                "cloud",
                "security",
                "messagebus",
                "external",
            ],
            "workflow" => &[
                "frontend",
                "backend",
                "security",
                "messagebus",
                "database",
                "cloud",
                "external",
            ],
            "sequence" => &["emphasis", "return", "security", "dashed", "default"],
            "dataflow" => &["emphasis", "security", "dashed", "database", "default"],
            _ => &[
                "start", "active", "waiting", "decision", "success", "failure", "neutral",
                "external",
            ],
        };
        let mut ordered_kinds = Vec::new();
        for kind in catalog {
            if kinds.remove(*kind) {
                ordered_kinds.push((*kind).to_owned());
            }
        }
        ordered_kinds.extend(kinds);
        if self.kind == "lifecycle"
            && !ordered_kinds.is_empty()
            && self
                .document
                .nodes
                .iter()
                .any(|node| node.final_state == Some(true))
            && !ordered_kinds.iter().any(|kind| kind == "final")
        {
            ordered_kinds.push("final".into());
        }
        for kind in ordered_kinds {
            let entry = meta
                .legend
                .as_ref()
                .and_then(|l| l.entries.as_ref())
                .and_then(|entries| entries.get(&kind));
            if entry.and_then(|e| e.visible) == Some(false) {
                continue;
            }
            let label = entry.and_then(|e| e.label.as_deref()).unwrap_or(&kind);
            let (w, h) = self.text_size(label, 400, legend_font_size)?;
            let route = self.kind == "sequence" || (self.kind == "dataflow" && kind != "database");
            let slot_width = if route {
                34
            } else if self.kind == "lifecycle" && kind == "start" {
                26
            } else if self.kind == "lifecycle" && kind == "final" {
                16
            } else {
                14
            };
            let swatch_gap = if route { 9 } else { 8 };
            // Same footprint composition as legendFootprint; Noto metrics remain
            // authoritative for the text term instead of the oracle's em model.
            let interactive = !route && kind != "final" && present.contains(&kind);
            let item_width = add(
                w,
                (slot_width + swatch_gap + if interactive { 21 } else { 0 }) * 64,
            )?;
            let item_width = add(item_width, 63)? / 64 * 64;
            let gap = if x != row_start_x { 22 * 64 } else { 0 };
            if x != row_start_x && add(x - row_start_x, add(gap, item_width)?)? > row_width_limit {
                total_row_height = add(total_row_height, row_height.max(22 * 64))?;
                row_y = add(row_y, row_height.max(22 * 64))?;
                row_height = if sequence_legend { 22 * 64 } else { 0 };
                x = row_start_x;
            } else {
                x = add(x, gap)?;
            }
            let b = self.label(
                &format!("legend:{kind}"),
                "legend",
                label,
                GeometryPoint {
                    x: add(x, (slot_width + swatch_gap) * 64)?,
                    y: row_y,
                },
                400,
                legend_font_size,
            )?;
            let (swatch_width, swatch_height) = if self.kind == "architecture" {
                (16, 10)
            } else if route {
                (34, 0)
            } else if self.kind == "lifecycle" && kind == "start" {
                (24, 9)
            } else {
                (14, 9)
            };
            let swatch_bounds = rect(
                x,
                add(
                    add(
                        row_y,
                        metrics::measure_text("", 400, legend_font_size)?.ascender,
                    )?,
                    -(if self.kind == "architecture" {
                        9
                    } else if route {
                        3
                    } else {
                        8
                    }) * 64,
                )?,
                swatch_width * 64,
                swatch_height * 64,
            )?;
            entries.push(GeometryLegendEntry {
                swatch_bounds: Some(swatch_bounds),
                text_bounds: Some(b),
                key: kind.clone(),
                label: label.into(),
                bounds: rect(x, row_y, item_width, h.max(swatch_height * 64))?,
            });
            row_height = row_height.max(h);
            x = add(x, item_width)?;
            max_row_right = max_row_right.max(x);
        }
        if !entries.is_empty() {
            total_row_height = add(total_row_height, row_height)?;
        }
        let title_y = if entries.is_empty() {
            None
        } else {
            let title = if meta.locale.as_deref() == Some("ko") {
                "범례"
            } else {
                "Legend"
            };
            // Header baseline is 20px above the first row baseline. The
            // selection frame encloses entries; the header has its own label box.
            let title_baseline = add(
                add(
                    legend_y,
                    metrics::measure_text("", 400, legend_font_size)?.ascender,
                )?,
                -20 * 64,
            )?;
            let title_top = add(
                title_baseline,
                -metrics::measure_text(title, 700, 12 * 64)?.ascender,
            )?;
            self.label(
                "legend:title",
                "legend",
                title,
                GeometryPoint {
                    x: row_start_x,
                    y: title_top,
                },
                700,
                12 * 64,
            )?;
            Some(title_baseline)
        };
        let content_bounds = if entries.is_empty() {
            None
        } else {
            let mut bounds = entries[0].bounds;
            for entry in &entries {
                for part in [Some(entry.bounds), entry.swatch_bounds, entry.text_bounds]
                    .into_iter()
                    .flatten()
                {
                    bounds = bounds.union(part).map_err(arithmetic)?;
                }
            }
            for label in self.document.labels.iter().filter(|label| {
                label.target_id == "legend"
                    && label
                        .id
                        .as_ref()
                        .is_some_and(|id| id.starts_with("legend:"))
            }) {
                bounds = bounds.union(label.bounds).map_err(arithmetic)?;
            }
            // Logical bounds only: cover stroke widths and local arrowheads;
            // the reference renderer does not draw an enclosing legend frame.
            Some(inflate(bounds, 8 * 64)?)
        };
        self.document.legend = GeometryLegend {
            content_bounds,
            title_y,
            bounds: if entries.is_empty() {
                rect(0, 0, 0, 0)?
            } else {
                rect(
                    row_start_x,
                    add(legend_y, -8 * 64)?,
                    max_row_right - row_start_x,
                    add(total_row_height, 16 * 64)?,
                )?
            },
            entries,
        };
        extent = extent
            .union(self.document.legend.bounds)
            .map_err(arithmetic)?;
        for label in &self.document.labels {
            extent = extent.union(label.bounds).map_err(arithmetic)?;
        }
        let minimum = meta.view_box.unwrap_or([920.0, 640.0]);
        self.document.page = GeometryPage {
            bounds: rect(
                extent.x.min(0),
                extent.y.min(0),
                add(extent.width, 48 * 64)?.max(px(minimum[0])?),
                add(extent.height, 48 * 64)?.max(px(minimum[1])?),
            )?,
            content_offset: None,
        };
        self.document.nodes.sort_by(|a, b| a.id.cmp(&b.id));
        self.document.containers.sort_by(|a, b| a.id.cmp(&b.id));
        self.document.labels.sort_by(|a, b| a.id.cmp(&b.id));
        Ok((self.document, self.diagnostics, !self.has_errors))
    }
}
fn segment_hits_box(a: GeometryPoint, b: GeometryPoint, r: GeometryBox) -> bool {
    let (l, t, right, bottom) = (
        i64::from(r.x),
        i64::from(r.y),
        i64::from(r.x) + i64::from(r.width),
        i64::from(r.y) + i64::from(r.height),
    );
    if a.x == b.x {
        let x = i64::from(a.x);
        x > l && x < right && i64::from(a.y.min(b.y)) < bottom && i64::from(a.y.max(b.y)) > t
    } else if a.y == b.y {
        let y = i64::from(a.y);
        y > t && y < bottom && i64::from(a.x.min(b.x)) < right && i64::from(a.x.max(b.x)) > l
    } else {
        true
    }
}
fn intersects(a: GeometryBox, b: GeometryBox) -> bool {
    i64::from(a.x) < i64::from(b.x) + i64::from(b.width)
        && i64::from(b.x) < i64::from(a.x) + i64::from(a.width)
        && i64::from(a.y) < i64::from(b.y) + i64::from(b.height)
        && i64::from(b.y) < i64::from(a.y) + i64::from(a.height)
}
fn typed<T: DeserializeOwned + Serialize>(v: &Value) -> Result<T, Diagnostic> {
    let mut context = common::Context::new("document");
    common::decode(v, &mut context).ok_or_else(|| {
        context.finish().into_iter().next().unwrap_or_else(|| {
            failure(
                "shape",
                "layout model cannot be decoded",
                "repair the spec fields",
            )
        })
    })
}
#[derive(Clone, Copy, Default)]
struct LayoutOptions {
    #[cfg(test)]
    route_budget: Option<usize>,
    #[cfg(test)]
    disable_routing_cache: bool,
}
pub fn layout_json(input: &str) -> GeometryReport {
    layout_with_options(input, LayoutOptions::default())
}
#[cfg(test)]
fn layout_json_with_route_budget(input: &str, budget: usize) -> GeometryReport {
    layout_with_options(
        input,
        LayoutOptions {
            route_budget: Some(budget),
            ..LayoutOptions::default()
        },
    )
}
fn layout_with_options(input: &str, options: LayoutOptions) -> GeometryReport {
    let _ = options;
    let request = match parse_layout_request(input) {
        Ok(r) => r,
        Err(diagnostics) => {
            return GeometryReport {
                api_version: 1,
                ok: false,
                geometry: None,
                diagnostics: diagnostics.clone(),
                receipt: crate::make_report(input, None, diagnostics).receipt,
            }
        }
    };
    let validity = crate::validate_json(&request.spec_json);
    if !validity.ok {
        return GeometryReport {
            api_version: 1,
            ok: false,
            geometry: None,
            diagnostics: validity.diagnostics,
            receipt: validity.receipt,
        };
    }
    let spec: Value = serde_json::from_str(&request.spec_json).expect("validated JSON");
    let kind = spec["diagram_type"]
        .as_str()
        .unwrap_or("document")
        .to_string();
    let mut scene = SceneBuilder::new(request, &kind);
    #[cfg(test)]
    {
        scene.route_budget = options.route_budget;
        scene.cache_enabled = !options.disable_routing_cache;
    }
    let result = (|| {
        let meta: Meta = typed(&spec["meta"])?;
        scene.label(
            "title",
            "document",
            &meta.title,
            point(32.0, 16.0)?,
            700,
            24 * 64,
        )?;
        if let Some(subtitle) = &meta.subtitle {
            scene.label(
                "subtitle",
                "document",
                subtitle,
                point(32.0, 54.0)?,
                400,
                12 * 64,
            )?;
        }
        // The header band is emitted first, into this scene's own coordinates,
        // but every authored coordinate stays in the source drawing's space:
        // pins, `via`, `channelX/Y` and `labelAt` describe the same drawing, so
        // the rigid translation moves them together and a title edit can never
        // separate or refuse them (maru#561).
        match kind.as_str() {
            "architecture" => architecture::place(&typed(&spec)?, &mut scene)?,
            "workflow" => workflow::place(&typed(&spec)?, &mut scene)?,
            "sequence" => sequence::place(&typed(&spec)?, &mut scene)?,
            "dataflow" => dataflow::place(&typed(&spec)?, &mut scene)?,
            "lifecycle" => lifecycle::place(&typed(&spec)?, &mut scene)?,
            _ => unreachable!(),
        };
        if let Some(raw) = spec.get("cards").filter(|v| !v.is_null()) {
            let cards: Vec<common::Card> = typed(raw)?;
            for (index, card) in cards.iter().enumerate() {
                scene.queue_card(&format!("card:{index}"), card);
            }
        }
        scene.finish(&meta)
    })();
    match result {
        Ok((mut geometry, mut diagnostics, mut ok)) => {
            let mut geometry_errors = constraints::geometry_diagnostics(&spec, &geometry);
            if kind == "sequence" {
                geometry_errors.extend(constraints_sequence::sequence_geometry_diagnostics(
                    &spec, &geometry,
                ));
            }
            if kind == "architecture" || kind == "workflow" {
                geometry_errors.extend(constraints_frames::frame_geometry_diagnostics(
                    &spec, &geometry,
                ));
            }
            geometry_errors.extend(constraints_distance::source_distance_diagnostics(
                &spec, &geometry,
            ));
            geometry_errors.extend(constraints_routes::route_geometry_diagnostics(
                &spec, &geometry,
            ));
            if geometry_errors
                .iter()
                .any(|diagnostic| !constraints_routes::is_route_quality_notice(diagnostic))
            {
                ok = false;
            }
            diagnostics.extend(geometry_errors);
            // Every source-relative rule above has now judged the pinned source
            // drawing. The emitted header band is page chrome above it, so the
            // finished drawing moves below the band in one rigid step (maru#561).
            let shift = header_shift(&geometry, &kind);
            let translated = shift.and_then(|shift| translate_drawing(&mut geometry, shift));
            if let Err(diagnostic) = translated {
                return GeometryReport {
                    api_version: 1,
                    ok: false,
                    geometry: None,
                    diagnostics: vec![diagnostic],
                    receipt: validity.receipt,
                };
            }
            let mut receipt = validity.receipt;
            receipt.engine_output_sha256 = Some(crate::spec_hash(
                &serde_json::to_string(&geometry).expect("integer geometry serializes"),
            ));
            GeometryReport {
                api_version: 1,
                ok,
                geometry: Some(geometry),
                diagnostics,
                receipt,
            }
        }
        Err(mut d) => {
            if let Some(suffix) = d.code.strip_prefix("document/") {
                d.code = format!("{kind}/{suffix}");
            }
            GeometryReport {
                api_version: 1,
                ok: false,
                geometry: None,
                diagnostics: vec![d],
                receipt: validity.receipt,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixtures() -> [&'static str; 5] {
        [
            include_str!("../../testdata/valid-architecture.json"),
            include_str!("../../testdata/valid-workflow.json"),
            include_str!("../../testdata/valid-sequence.json"),
            include_str!("../../testdata/valid-dataflow.json"),
            include_str!("../../testdata/valid-lifecycle.json"),
        ]
    }
    fn layout(spec: &str) -> GeometryReport {
        layout_json(&serde_json::json!({"specJson":spec}).to_string())
    }
    #[test]
    fn all_five_fixture_scenes_repeat_exactly_and_contain_their_geometry() {
        for spec in fixtures() {
            let first = layout(spec);
            assert!(first.ok, "{:?}", first.diagnostics);
            let second = layout(spec);
            assert_eq!(first, second);
            assert_eq!(first.receipt.input_spec_sha256, crate::spec_hash(spec));
            let scene = first.geometry.unwrap();
            assert!(!scene.nodes.is_empty());
            for b in scene
                .nodes
                .iter()
                .map(|n| n.bounds)
                .chain(scene.containers.iter().map(|c| c.bounds))
                .chain(scene.labels.iter().map(|l| l.bounds))
                .chain(std::iter::once(scene.legend.bounds))
            {
                assert!(scene
                    .page
                    .bounds
                    .contains(GeometryPoint { x: b.x, y: b.y })
                    .unwrap());
                assert!(scene
                    .page
                    .bounds
                    .contains(GeometryPoint {
                        x: b.right().unwrap(),
                        y: b.bottom().unwrap()
                    })
                    .unwrap());
            }
            for route in &scene.routes {
                for pair in route.points.windows(2) {
                    assert!(pair[0].x == pair[1].x || pair[0].y == pair[1].y);
                    for b in scene
                        .nodes
                        .iter()
                        .map(|n| n.bounds)
                        .chain(scene.labels.iter().map(|l| l.bounds))
                    {
                        assert!(
                            !segment_hits_box(pair[0], pair[1], b),
                            "route {:?} hits {:?}",
                            route.id,
                            b
                        );
                    }
                }
            }
            for label in &scene.labels {
                for glyph in &label.glyphs {
                    if glyph.ink.width > 0 && glyph.ink.height > 0 {
                        assert!(label
                            .bounds
                            .contains(GeometryPoint {
                                x: glyph.ink.x,
                                y: glyph.ink.y
                            })
                            .unwrap());
                        assert!(label
                            .bounds
                            .contains(GeometryPoint {
                                x: glyph.ink.right().unwrap(),
                                y: glyph.ink.bottom().unwrap()
                            })
                            .unwrap());
                    }
                }
            }
        }
    }
    #[test]
    fn coverage_notices_are_nonfatal_in_actual_scenes() {
        for spec in fixtures() {
            let mut value: Value = serde_json::from_str(spec).unwrap();
            value["meta"]["title"] = "🚀 ✔ ⚠️ 👩‍💻".into();
            let report = layout(&value.to_string());
            assert!(report.ok, "{:?}", report.diagnostics);
            assert!(report
                .diagnostics
                .iter()
                .any(|d| d.code == "document/font-replacement-notice"));
            let scene = report.geometry.unwrap();
            let title = scene
                .labels
                .iter()
                .find(|l| l.id.as_deref() == Some("title"))
                .unwrap();
            assert!(title
                .glyphs
                .iter()
                .any(|g| g.glyph_id == 0 && g.replaced && !g.ignored));
            assert!(title.glyphs.iter().any(|g| g.ignored));
        }
    }
    #[test]
    fn legend_modes_use_the_same_vocabulary_as_validation_and_measure_multiline_boxes() {
        for input in fixtures() {
            let mut spec: Value = serde_json::from_str(input).unwrap();
            let kind = spec["diagram_type"].as_str().unwrap().to_string();
            let key = common::legend_keys(&kind)[0];
            spec["meta"]["legend"] =
                serde_json::json!({"mode":"all","entries":{(key):{"label":"Custom\nLegend"}}});
            let report = layout(&spec.to_string());
            assert!(report.ok, "{:?}", report.diagnostics);
            let scene = report.geometry.unwrap();
            let mut expected: BTreeSet<_> = common::legend_keys(&kind).into_iter().collect();
            if kind == "lifecycle"
                && scene
                    .nodes
                    .iter()
                    .any(|node| node.final_state == Some(true))
            {
                expected.insert("final");
            }
            assert_eq!(
                scene
                    .legend
                    .entries
                    .iter()
                    .map(|e| e.key.as_str())
                    .collect::<BTreeSet<_>>(),
                expected
            );
            for entry in &scene.legend.entries {
                assert!(scene
                    .legend
                    .bounds
                    .contains(GeometryPoint {
                        x: entry.bounds.right().unwrap(),
                        y: entry.bounds.bottom().unwrap()
                    })
                    .unwrap());
            }
            spec["meta"]["legend"]["mode"] = "hidden".into();
            let hidden = layout(&spec.to_string());
            assert!(hidden.ok, "{:?}", hidden.diagnostics);
            assert!(hidden.geometry.unwrap().legend.entries.is_empty());
        }
    }

    fn assert_partial_route(report: GeometryReport, code: &str) {
        assert!(!report.ok);
        let expected_count = if code == "architecture/route-blocked" {
            2
        } else {
            1
        };
        assert_eq!(
            report.diagnostics.len(),
            expected_count,
            "{:?}",
            report.diagnostics
        );
        if expected_count == 2 {
            assert_eq!(
                report.diagnostics[1].code,
                "architecture/geometry-node-overlap"
            );
            assert_eq!(report.diagnostics[1].path, "/components/2");
        }
        let diagnostic = &report.diagnostics[0];
        assert_eq!(diagnostic.code, code);
        assert_eq!(diagnostic.path, "/connections/0");
        assert!(diagnostic.message.contains("blocked"));
        assert!(!diagnostic.fix.is_empty());
        let geometry = report
            .geometry
            .expect("placed geometry is never erased by a route error");
        assert_eq!(geometry.nodes.len(), 5);
        assert_eq!(geometry.routes.len(), 2);
        assert!(geometry
            .routes
            .iter()
            .find(|r| r.id.as_deref() == Some("blocked"))
            .unwrap()
            .points
            .is_empty());
        assert!(
            geometry
                .routes
                .iter()
                .find(|r| r.id.as_deref() == Some("clear"))
                .unwrap()
                .points
                .len()
                >= 2
        );
        assert!(!geometry.labels.is_empty());
        assert!(geometry.page.bounds.width > 0);
    }
    #[test]
    fn enclosed_endpoint_keeps_nodes_and_other_routes_with_one_unrouted_edge() {
        let input = include_str!("../../testdata/partial-route.json");
        assert!(crate::validate_json(input).ok);
        let first = layout(input);
        assert_eq!(first, layout(input));
        assert_partial_route(first, "architecture/route-blocked");
    }
    #[test]
    fn exhausted_test_budget_keeps_geometry_and_does_not_stop_a_clear_route() {
        let mut spec: Value =
            serde_json::from_str(include_str!("../../testdata/partial-route.json")).unwrap();
        spec["components"][2]["pos"] = serde_json::json!([260, 170]);
        spec["components"][2]["size"] = serde_json::json!([80, 120]);
        let source = spec.to_string();
        assert!(layout(&source).ok, "production budget can find the detour");
        let request = serde_json::json!({"specJson":source}).to_string();
        let first = layout_json_with_route_budget(&request, 1);
        assert_eq!(first, layout_json_with_route_budget(&request, 1));
        assert_partial_route(first, "architecture/route-budget");
    }

    fn preset_scene(preset: &str) -> GeometryDocument {
        let mut spec: Value = serde_json::from_str(if preset == "vertical-channel" {
            fixtures()[3]
        } else {
            fixtures()[1]
        })
        .unwrap();
        let collection = if preset == "vertical-channel" {
            "flows"
        } else {
            "edges"
        };
        spec[collection][0]["route"] = preset.into();
        if collection == "edges" {
            // Keep the corridor audit clear of the lane's numbered title rail.
            for (i, node) in spec["nodes"].as_array_mut().unwrap().iter_mut().enumerate() {
                node["col"] = (1 + 2 * i).into();
            }
        }
        if preset != "vertical-channel" {
            spec[collection][0].as_object_mut().unwrap().remove("label");
        }
        if preset == "vertical-channel" {
            spec["nodes"][1]["row"] = 2.into();
        }
        let report = layout(&spec.to_string());
        assert!(report.ok, "{:?}", report.diagnostics);
        report.geometry.unwrap()
    }
    #[test]
    fn outside_right_preset_uses_right_ports_and_an_outer_channel() {
        let scene = preset_scene("outside-right");
        let edge = &scene.routes[0];
        let from = scene
            .nodes
            .iter()
            .find(|n| n.id == edge.from)
            .unwrap()
            .bounds;
        let to = scene.nodes.iter().find(|n| n.id == edge.to).unwrap().bounds;
        let right = scene
            .nodes
            .iter()
            .map(|n| n.bounds.right().unwrap())
            .max()
            .unwrap();
        assert_eq!(edge.points.first().unwrap().x, from.right().unwrap());
        assert_eq!(edge.points.last().unwrap().x, to.right().unwrap());
        assert!(edge.points.iter().any(|p| p.x > right));
    }
    #[test]
    fn return_left_preset_uses_left_ports_and_a_left_channel() {
        let scene = preset_scene("return-left");
        let edge = &scene.routes[0];
        let from = scene
            .nodes
            .iter()
            .find(|n| n.id == edge.from)
            .unwrap()
            .bounds;
        let to = scene.nodes.iter().find(|n| n.id == edge.to).unwrap().bounds;
        assert_eq!(edge.points.first().unwrap().x, from.x);
        assert_eq!(edge.points.last().unwrap().x, to.x);
        assert!(edge.points.iter().any(|p| p.x < from.x.min(to.x)));
    }
    #[test]
    fn up_channel_preset_uses_top_ports_and_an_upper_channel() {
        let scene = preset_scene("up-channel");
        let edge = &scene.routes[0];
        let from = scene
            .nodes
            .iter()
            .find(|n| n.id == edge.from)
            .unwrap()
            .bounds;
        let to = scene.nodes.iter().find(|n| n.id == edge.to).unwrap().bounds;
        assert_eq!(edge.points.first().unwrap().y, from.y);
        assert_eq!(edge.points.last().unwrap().y, to.y);
        assert!(edge.points.iter().any(|p| p.y < from.y.min(to.y)));
    }
    #[test]
    fn vertical_channel_preset_uses_horizontal_ports_and_an_explicit_vertical_corridor() {
        let scene = preset_scene("vertical-channel");
        let edge = &scene.routes[0];
        let from = scene
            .nodes
            .iter()
            .find(|n| n.id == edge.from)
            .unwrap()
            .bounds;
        let to = scene.nodes.iter().find(|n| n.id == edge.to).unwrap().bounds;
        assert_eq!(edge.points.first().unwrap().x, from.right().unwrap());
        assert_eq!(edge.points.last().unwrap().x, to.x);
        let channel = from.right().unwrap() + 10 * 64 + 44 * 64;
        assert!(edge
            .points
            .windows(2)
            .any(|p| p[0].x == channel && p[1].x == channel && p[0].y != p[1].y));
    }

    #[test]
    fn authored_preset_channels_are_not_replaced_by_automatic_channels() {
        let mut spec: Value = serde_json::from_str(fixtures()[1]).unwrap();
        spec["edges"][0]["route"] = "outside-right".into();
        spec["edges"][0]["channelX"] = 1500.into();
        spec["edges"][0].as_object_mut().unwrap().remove("label");
        let report = layout(&spec.to_string());
        assert!(report.ok, "{:?}", report.diagnostics);
        assert!(report.geometry.unwrap().routes[0]
            .points
            .iter()
            .any(|p| p.x == 1500 * 64));
    }

    #[test]
    fn seeded_dense_scenes_exercise_real_astar_and_keep_clear_edges_on_budget_exhaustion() {
        let corpus: Value =
            serde_json::from_str(include_str!("../../testdata/dense-scenes.json")).unwrap();
        for case in corpus["cases"].as_array().unwrap() {
            let source = case["spec"].to_string();
            assert!(crate::validate_json(&source).ok, "{}", case["id"]);
            let normal = layout(&source);
            let scene = normal.geometry.expect("dense placement retained");
            assert_eq!(scene.nodes.len(), 200);
            assert!(
                scene.routes.iter().any(|r| r
                    .id
                    .as_deref()
                    .is_some_and(|id| id.starts_with("long-"))
                    && r.points.len() >= 4),
                "{} no long edge routed",
                case["id"]
            );
            let routed_ids: BTreeSet<_> = scene
                .routes
                .iter()
                .filter(|r| !r.points.is_empty())
                .filter_map(|r| r.id.clone())
                .collect();
            let request = serde_json::json!({"specJson":source}).to_string();
            let small = layout_json_with_route_budget(&request, 0);
            assert!(!small.ok, "{} did not exercise A*", case["id"]);
            assert!(
                small
                    .diagnostics
                    .iter()
                    .any(|d| d.code.ends_with("/route-budget")),
                "{} no A* budget failure",
                case["id"]
            );
            let budget_ids: BTreeSet<_> = small
                .diagnostics
                .iter()
                .filter(|d| d.code.ends_with("/route-budget"))
                .map(|d| d.message.clone())
                .collect();
            let scene = small.geometry.unwrap();
            assert_eq!(scene.nodes.len(), 200);
            assert!(
                scene.routes.iter().any(|r| r.points.is_empty()
                    && r.id.as_deref().is_some_and(|id| routed_ids.contains(id)
                        && budget_ids
                            .iter()
                            .any(|message| message.starts_with(&format!("edge {id:?}:"))))),
                "{} no successful production A* detour proven",
                case["id"]
            );
            assert!(
                scene.routes.iter().any(|r| r
                    .id
                    .as_deref()
                    .is_some_and(|id| id.starts_with("adjacent-"))
                    && !r.points.is_empty()),
                "{} no visible adjacent path",
                case["id"]
            );
        }
    }

    #[test]
    fn routing_cache_matches_uncached_labels_routes_errors_and_pins() {
        let mut inputs: Vec<_> = fixtures().into_iter().map(str::to_owned).collect();
        inputs.push(include_str!("../../testdata/partial-route.json").to_owned());
        let mut styled: Value = serde_json::from_str(fixtures()[0]).unwrap();
        styled["connections"] = serde_json::json!([
            {"id":"thin","from":"a","to":"b","label":"Thin","width":2,"labelAt":[450,360]},
            {"id":"thick","from":"b","to":"a","label":"Thick","width":8,"labelAt":[450,420]}
        ]);
        for index in 0..10 {
            styled["connections"]
                .as_array_mut()
                .unwrap()
                .push(serde_json::json!({
                    "id":format!("wide-{index}"),"from":"a","to":"b","width":10+index*2
                }));
        }
        assert!(crate::validate_json(&styled.to_string()).ok);
        inputs.push(styled.to_string());
        for spec in inputs {
            for pinned in [false, true] {
                let mut request = serde_json::json!({"specJson":spec});
                if pinned {
                    request["pinSet"] = serde_json::json!({"sourceSpecSha256":"0".repeat(64),"pins":[{"targetId":"a","targetKind":"node","position":{"x":120*64,"y":180*64}}]});
                }
                let input = request.to_string();
                let cached = layout_json(&input);
                let uncached = layout_with_options(
                    &input,
                    LayoutOptions {
                        disable_routing_cache: true,
                        ..LayoutOptions::default()
                    },
                );
                assert_eq!(cached, uncached, "{}", request["specJson"]);
            }
        }
    }

    #[test]
    fn generated_route_ids_reserve_authored_ids_even_when_they_appear_later() {
        let ids = allocate_route_ids(
            "connection",
            [
                None,
                Some("connection:0"),
                Some("connection:0:generated"),
                None,
            ],
        );
        assert_eq!(ids[1], "connection:0");
        assert_eq!(ids[2], "connection:0:generated");
        assert_eq!(ids.iter().collect::<BTreeSet<_>>().len(), 4);
    }
    #[test]
    fn authored_generated_id_collisions_do_not_share_failures_or_source_paths() {
        for input in fixtures() {
            let mut spec: Value = serde_json::from_str(input).unwrap();
            let kind = spec["diagram_type"].as_str().unwrap().to_string();
            let (collection, prefix) = match kind.as_str() {
                "architecture" => ("connections", "connection"),
                "workflow" => ("edges", "edge"),
                "sequence" => ("messages", "message"),
                "dataflow" => ("flows", "flow"),
                _ => ("transitions", "transition"),
            };
            let base = layout(input);
            assert!(base.ok);
            // The direct builder path below has no emitted header, so authored
            // coordinates stay in the source drawing's space (maru#561).
            let band = header_shift(base.geometry.as_ref().unwrap(), &kind).unwrap();
            let node = base
                .geometry
                .unwrap()
                .nodes
                .into_iter()
                .find(|n| n.id == "a")
                .unwrap();
            let mut blocked = spec[collection][0].clone();
            blocked["id"] = format!("{prefix}:1").into();
            let mut clear = spec[collection][0].clone();
            clear.as_object_mut().unwrap().remove("id");
            clear.as_object_mut().unwrap().remove("via");
            let pins = if kind == "sequence" {
                blocked["y"] = 180.into();
                clear["y"] = 360.into();
                Some(
                    serde_json::json!([{"targetId":"a","targetKind":"node","position":{"x":node.bounds.x,"y":160*64}}]),
                )
            } else {
                blocked["via"] = serde_json::json!([[
                    f64::from(node.bounds.x) / 64.0 + 10.0,
                    f64::from(node.bounds.y - band) / 64.0 + 10.0
                ]]);
                None
            };
            spec[collection] = serde_json::json!([blocked, clear]);
            let source = spec.to_string();
            let mut request = serde_json::json!({"specJson":source});
            if let Some(pins) = pins {
                request["pinSet"] =
                    serde_json::json!({"sourceSpecSha256":crate::spec_hash(&source),"pins":pins});
            }
            // Exercise naming and routing directly: current E1 ID syntax already
            // rejects colons, but internal/generated IDs must remain safe even
            // when a typed caller supplies an authored fallback-shaped name.
            let request: LayoutRequest = serde_json::from_value(request).unwrap();
            let mut builder = SceneBuilder::new(request, &kind);
            match kind.as_str() {
                "architecture" => architecture::place(&typed(&spec).unwrap(), &mut builder),
                "workflow" => workflow::place(&typed(&spec).unwrap(), &mut builder),
                "sequence" => sequence::place(&typed(&spec).unwrap(), &mut builder),
                "dataflow" => dataflow::place(&typed(&spec).unwrap(), &mut builder),
                _ => lifecycle::place(&typed(&spec).unwrap(), &mut builder),
            }
            .unwrap();
            if kind != "sequence" {
                let via = blocked["via"][0].as_array().unwrap();
                let anchor = point(via[0].as_f64().unwrap(), via[1].as_f64().unwrap()).unwrap();
                builder.document.containers.push(GeometryContainer {
                    id: "unrelated-card".into(),
                    kind: "card".into(),
                    bounds: rect(anchor.x - 64, anchor.y - 64, 128, 128).unwrap(),
                });
            }
            let (scene, diagnostics, ok) = builder.finish(&typed(&spec["meta"]).unwrap()).unwrap();
            assert!(!ok, "{kind}");
            assert_eq!(diagnostics.len(), 1, "{kind}: {diagnostics:?}");
            assert_eq!(diagnostics[0].path, format!("/{collection}/0"));
            if kind != "sequence" {
                assert_eq!(diagnostics[0].code, format!("{kind}/route-blocked"));
            }
            assert_eq!(scene.routes.len(), 2);
            assert_eq!(
                scene
                    .routes
                    .iter()
                    .filter_map(|r| r.id.as_deref())
                    .collect::<BTreeSet<_>>()
                    .len(),
                2
            );
            assert!(scene
                .routes
                .iter()
                .find(|r| r.id.as_deref() == Some(&format!("{prefix}:1")))
                .unwrap()
                .points
                .is_empty());
            assert!(
                scene
                    .routes
                    .iter()
                    .find(|r| r.id.as_deref() != Some(&format!("{prefix}:1")))
                    .unwrap()
                    .points
                    .len()
                    >= 2,
                "{kind}"
            );
        }
    }

    fn preset_audit_spec(kind: &str) -> Value {
        let index = match kind {
            "architecture" => 0,
            "workflow" => 1,
            "dataflow" => 3,
            _ => 4,
        };
        let mut spec: Value = serde_json::from_str(fixtures()[index]).unwrap();
        if kind == "workflow" {
            // Preset intent is tested independently of title-rail collisions.
            for (i, node) in spec["nodes"].as_array_mut().unwrap().iter_mut().enumerate() {
                node["col"] = (1 + 2 * i).into();
            }
        }
        match kind {
            "architecture" => spec["components"][1]["row"] = 2.into(),
            "workflow" => {
                spec["lanes"]
                    .as_array_mut()
                    .unwrap()
                    .push(serde_json::json!({"id":"lower","label":"Lower"}));
                spec["nodes"][1]["lane"] = "lower".into();
            }
            "dataflow" => spec["nodes"][1]["row"] = 2.into(),
            _ => spec["states"][1]["yOffset"] = 220.into(),
        };
        spec
    }
    #[test]
    fn every_validated_preset_routes_both_directions_and_honors_authored_channels() {
        for kind in ["architecture", "workflow", "dataflow", "lifecycle"] {
            let source = preset_audit_spec(kind);
            let baseline = layout(&source.to_string());
            assert!(baseline.ok);
            // Authored channels are source-drawing coordinates, and the emitted
            // scene sits below the header band: convert the scene-derived
            // expectations back into that space (maru#561).
            let band = header_shift(baseline.geometry.as_ref().unwrap(), kind).unwrap();
            let nodes = baseline.geometry.unwrap().nodes;
            let place = |id: &str| {
                nodes
                    .iter()
                    .find(|n| n.id == id)
                    .unwrap()
                    .bounds
                    .checked_translate(0, -band)
                    .unwrap()
            };
            let a = place("a");
            let b = place("b");
            let gapx = fixed::checked_midpoint(a.right().unwrap(), b.x).unwrap();
            let gapy = fixed::checked_midpoint(a.bottom().unwrap(), b.y).unwrap();
            let collection = match kind {
                "architecture" => "connections",
                "workflow" => "edges",
                "dataflow" => "flows",
                _ => "transitions",
            };
            for preset in presets::accepted(kind).unwrap() {
                for reverse in [false, true] {
                    for authored in [false, true] {
                        let mut spec = source.clone();
                        let mut edge = serde_json::json!({"id":"audit","from":if reverse{"b"}else{"a"},"to":if reverse{"a"}else{"b"},"route":preset});
                        if kind == "dataflow" {
                            edge["label"] = "F".into();
                        }
                        let override_axis = if ["outside-right", "right-channel"].contains(preset) {
                            (
                                'x',
                                nodes
                                    .iter()
                                    .map(|node| node.bounds.right().unwrap())
                                    .max()
                                    .unwrap()
                                    + 100 * 64,
                            )
                        } else if ["return-left", "left-channel"].contains(preset) {
                            ('x', 10 * 64)
                        } else if ["vertical-channel", "orthogonal-h"].contains(preset) {
                            ('x', gapx)
                        } else if ["top-channel", "up-channel"].contains(preset) {
                            ('y', 10 * 64)
                        } else if *preset == "bottom-channel" {
                            ('y', b.bottom().unwrap() + 100 * 64)
                        } else {
                            ('y', gapy)
                        };
                        if authored && kind == "architecture" {
                            let x = f64::from(override_axis.1) / 64.0;
                            edge["via"] = if override_axis.0 == 'x' {
                                serde_json::json!([
                                    [x, f64::from(a.y + a.height / 2) / 64.0],
                                    [x, f64::from(b.y + b.height / 2) / 64.0]
                                ])
                            } else {
                                serde_json::json!([
                                    [f64::from(a.x + a.width / 2) / 64.0, x],
                                    [f64::from(b.x + b.width / 2) / 64.0, x]
                                ])
                            };
                        } else if authored {
                            edge[if override_axis.0 == 'x' {
                                "channelX"
                            } else {
                                "channelY"
                            }] = serde_json::json!(f64::from(override_axis.1) / 64.0);
                        }
                        spec[collection] = serde_json::json!([edge]);
                        let report = layout(&spec.to_string());
                        assert!(
                            report.ok,
                            "{kind}/{preset} reverse={reverse} authored={authored}: {:?}",
                            report.diagnostics
                        );
                        let scene = report.geometry.unwrap();
                        let route = &scene.routes[0];
                        assert!(!route.points.is_empty());
                        assert!(route
                            .points
                            .windows(2)
                            .all(|p| p[0].x == p[1].x || p[0].y == p[1].y));
                        if authored {
                            assert!(
                                route.points.iter().any(|p| if override_axis.0 == 'x' {
                                    p.x == override_axis.1
                                } else {
                                    p.y == override_axis.1 + band
                                }),
                                "{kind}/{preset} ignored override"
                            );
                        }
                    }
                }
            }
        }
    }
    #[test]
    fn workflow_drop_bias_reaches_the_actual_horizontal_corridor_in_both_directions() {
        let source = preset_audit_spec("workflow");
        let scene = layout(&source.to_string()).geometry.unwrap();
        let a = scene.nodes.iter().find(|n| n.id == "a").unwrap().bounds;
        let b = scene.nodes.iter().find(|n| n.id == "b").unwrap().bounds;
        let upper = a.bottom().unwrap() + 10 * 64;
        let lower = b.y - 10 * 64;
        for reverse in [false, true] {
            for bias in [0.0, 0.5, 1.0] {
                let mut spec = source.clone();
                spec["edges"] = serde_json::json!([{"from":if reverse{"b"}else{"a"},"to":if reverse{"a"}else{"b"},"route":"drop","bias":bias}]);
                let report = layout(&spec.to_string());
                assert!(report.ok, "{:?}", report.diagnostics);
                let scene = report.geometry.unwrap();
                let fraction = if reverse { 1.0 - bias } else { bias };
                let expected =
                    px(f64::from(upper) / 64.0 + f64::from(lower - upper) / 64.0 * fraction)
                        .unwrap();
                assert!(
                    scene.routes[0]
                        .points
                        .windows(2)
                        .any(|p| p[0].y == expected && p[1].y == expected && p[0].x != p[1].x),
                    "reverse={reverse} bias={bias}"
                );
            }
        }
    }

    #[test]
    fn shared_authored_text_fields_are_measured_and_preserved_as_glyphs_in_every_family() {
        for input in fixtures() {
            let mut spec: Value = serde_json::from_str(input).unwrap();
            let kind = spec["diagram_type"].as_str().unwrap().to_string();
            spec["meta"]["title"] = "AuditTitle".into();
            spec["meta"]["subtitle"] = "AuditSubtitle".into();
            let key = common::legend_keys(&kind)[0];
            spec["meta"]["legend"] =
                serde_json::json!({"mode":"all","entries":{(key):{"label":"AuditLegend"}}});
            spec["cards"] = serde_json::json!([{"dot":"cyan","title":"AuditCard","items":["FirstItem","SecondItem"]}]);
            let report = layout(&spec.to_string());
            assert!(report.ok, "{kind}: {:?}", report.diagnostics);
            let scene = report.geometry.unwrap();
            for text in [
                "AuditTitle",
                "AuditSubtitle",
                "AuditLegend",
                "AuditCard",
                "FirstItem",
                "SecondItem",
            ] {
                let label = scene
                    .labels
                    .iter()
                    .find(|l| l.text.contains(text))
                    .unwrap_or_else(|| panic!("{kind}: missing{text}"));
                assert!(label
                    .glyphs
                    .iter()
                    .map(|g| g.input.as_str())
                    .collect::<String>()
                    .contains(text));
                assert!(label.bounds.width > 0 && label.bounds.height > 0);
            }
        }
    }
    #[test]
    fn a_straight_preference_that_needs_bends_is_disclosed_without_hiding_the_scene() {
        let mut spec = preset_audit_spec("architecture");
        spec["connections"][0]["route"] = "straight".into();
        let report = layout(&spec.to_string());
        assert!(report.ok, "{:?}", report.diagnostics);
        assert!(report.geometry.is_some());
        assert!(report
            .diagnostics
            .iter()
            .any(|d| d.code == "architecture/route-preset-adjusted"
                && d.message.contains("straight")));
    }

    #[test]
    fn invalid_requests_keep_a_failure_receipt_for_the_actual_input() {
        let input = "[]";
        let report = layout_json(input);
        assert!(!report.ok);
        assert!(report.geometry.is_none());
        assert_eq!(report.receipt.input_spec_sha256, crate::spec_hash(input));
    }
    #[test]
    fn derived_frames_ignore_pins_and_report_each_target_without_changing_geometry() {
        for input in fixtures() {
            let mut spec: Value = serde_json::from_str(input).unwrap();
            let kind = spec["diagram_type"].as_str().unwrap().to_string();
            if kind == "architecture" {
                spec["boundaries"] =
                    serde_json::json!([{"kind":"region","label":"Region","wraps":["a","b"]}]);
            }
            if kind == "sequence" {
                spec["segments"] = serde_json::json!([{"from":160,"to":350,"label":"Segment"}]);
                spec["activations"] = serde_json::json!([{"participant":"a","from":170,"to":270}]);
            }
            spec["cards"] = serde_json::json!([{"dot":"cyan","title":"Note","items":["Content"]}]);
            let source = spec.to_string();
            let baseline = layout(&source);
            assert!(baseline.ok, "{:?}", baseline.diagnostics);
            let targets: Vec<_> = baseline
                .geometry
                .as_ref()
                .unwrap()
                .containers
                .iter()
                .filter(|c| is_derived_container_id(&c.id))
                .map(|c| c.id.clone())
                .collect();
            assert!(!targets.is_empty());
            let pins:Vec<_>=targets.iter().map(|id|serde_json::json!({"targetId":id,"targetKind":"container","position":{"x":900000,"y":800000}})).collect();
            let report=layout_json(&serde_json::json!({"specJson":source,"pinSet":{"sourceSpecSha256":crate::spec_hash(&source),"pins":pins}}).to_string());
            assert!(report.ok, "{:?}", report.diagnostics);
            assert_eq!(report.geometry, baseline.geometry);
            assert_eq!(
                report
                    .diagnostics
                    .iter()
                    .filter(|d| d.code == "document/pin-member-removed"
                        && d.message
                            .contains("this container's position derives from its members"))
                    .count(),
                targets.len()
            );
        }
    }

    #[test]
    fn authored_lane_group_and_phase_frames_keep_their_pins() {
        let mut spec: Value = serde_json::from_str(fixtures()[1]).unwrap();
        spec["edges"] = serde_json::json!([]);
        spec["phases"] =
            serde_json::json!([{"id":"delivery","label":"Delivery","fromCol":0,"toCol":2}]);
        spec["groups"] = serde_json::json!([{"id":"workers","label":"Workers","lane":"main","fromCol":0,"toCol":2}]);
        let source = spec.to_string();
        let ids = ["lane:main", "group:workers", "phase:delivery"];
        let pins:Vec<_>=ids.iter().enumerate().map(|(i,id)|serde_json::json!({"targetId":id,"targetKind":"container","position":{"x":(800+i as i32*200)*64,"y":600*64}})).collect();
        let report=layout_json(&serde_json::json!({"specJson":source,"pinSet":{"sourceSpecSha256":crate::spec_hash(&source),"pins":pins}}).to_string());
        // These explicit pins intentionally move frames away from their members.
        // Geometry rules flag the mismatch but must retain every exact user pin.
        assert!(!report.ok);
        for code in [
            "workflow/geometry-phase-range",
            "workflow/geometry-group-containment",
            "workflow/geometry-container-containment",
        ] {
            assert!(
                report.diagnostics.iter().any(|d| d.code == code),
                "{:?}",
                report.diagnostics
            );
        }
        assert!(report
            .diagnostics
            .iter()
            .all(|d| d.code != "document/pin-member-removed"));
        let geometry = report.geometry.unwrap();
        // A container pin is an authored source coordinate too, so the page's
        // header offset moves it with the rest of the drawing (maru#561).
        let offset = geometry
            .page
            .content_offset
            .expect("a workflow page draws the header band inside itself")
            .y;
        for (index, id) in ids.iter().enumerate() {
            let frame = geometry.containers.iter().find(|c| c.id == *id).unwrap();
            assert_eq!(
                (frame.bounds.x, frame.bounds.y),
                ((800 + index as i32 * 200) * 64, 600 * 64 + offset)
            );
        }
    }

    #[test]
    fn a_pin_wins_over_authored_position_without_evaluating_unused_grid_overflow() {
        let mut spec: Value = serde_json::from_str(fixtures()[0]).unwrap();
        spec["components"][0]["pos"] = serde_json::json!([80, 180]);
        spec["components"][0]["row"] = serde_json::json!(1e30);
        let report=layout_json(&serde_json::json!({"specJson":spec.to_string(),"pinSet":{"sourceSpecSha256":"0".repeat(64),"pins":[{"targetId":"a","targetKind":"node","position":{"x":80*64,"y":180*64}}]}}).to_string());
        assert!(report.ok, "{:?}", report.diagnostics);
        let scene = report.geometry.unwrap();
        let node = scene.nodes.iter().find(|n| n.id == "a").unwrap();
        assert_eq!(node.position_source, GeometryPositionSource::PlannedPin);
        assert_eq!((node.bounds.x, node.bounds.y), (80 * 64, 180 * 64));
    }
    #[test]
    fn automatic_ports_and_remote_label_candidates_keep_original_corpus_routes_visible() {
        let corpus: serde_json::Value =
            serde_json::from_str(include_str!("../../testdata/parity.json")).unwrap();
        for id in [
            "app-architecture",
            "e1-architecture-valid-deployment-profile",
            "public-05",
            "public-07",
        ] {
            let case = corpus["cases"]
                .as_array()
                .unwrap()
                .iter()
                .find(|case| case["id"] == id)
                .expect("original regression fixture remains in corpus");
            let source = case
                .get("validityInputJson")
                .and_then(serde_json::Value::as_str)
                .or_else(|| case["comparison"]["inputJson"].as_str())
                .or_else(|| case["inputJson"].as_str())
                .unwrap();
            let report = layout(source);
            assert!(report.ok, "{id}: {:?}", report.diagnostics);
            let geometry = report.geometry.expect("complete original scene");
            assert!(
                geometry.routes.iter().all(|route| !route.points.is_empty()),
                "{id}: some original relationships vanished"
            );
            if id == "public-05" {
                let tip = |name: &str| {
                    *geometry
                        .routes
                        .iter()
                        .find(|route| route.id.as_deref() == Some(name))
                        .unwrap()
                        .points
                        .last()
                        .unwrap()
                };
                let a = tip("commands-to-fs");
                let b = tip("mcp-to-fs");
                let target = geometry
                    .nodes
                    .iter()
                    .find(|node| node.id == "fs")
                    .unwrap()
                    .bounds;
                assert_eq!(a.x, target.x);
                assert_eq!(b.x, target.x);
                assert!(
                    (i64::from(a.y) - i64::from(b.y)).abs() >= 11 * 64,
                    "same authored left face must retain separate arrow slots"
                );
            }
        }
    }
}
