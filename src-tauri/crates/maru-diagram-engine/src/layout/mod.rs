//! Test-only deterministic layout; production apply/canvas paths do not call it.
mod architecture;
mod dataflow;
pub mod fixed;
mod lifecycle;
mod presets;
mod sequence;
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

pub(crate) struct SceneBuilder {
    pub(crate) document: GeometryDocument,
    pub(crate) diagnostics: Vec<Diagnostic>,
    has_errors: bool,
    #[cfg(test)]
    route_budget: Option<usize>,
    request: LayoutRequest,
    kind: String,
    connections: Vec<RouteRequest>,
    cards: Vec<(String, common::Card)>,
    kinds: BTreeMap<String, String>,
    pins: BTreeMap<String, GeometryPin>,
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
                nodes: vec![],
                containers: vec![],
                routes: vec![],
                labels: vec![],
                legend: GeometryLegend {
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
                },
            },
            diagnostics: vec![],
            has_errors: false,
            #[cfg(test)]
            route_budget: None,
            request,
            kind: kind.into(),
            connections: vec![],
            cards: vec![],
            kinds: BTreeMap::new(),
            pins,
        }
    }
    pub(crate) fn pinned_position(&self, id: &str) -> Option<GeometryPoint> {
        self.pins.get(id).map(|p| p.position)
    }
    pub(crate) fn node_bounds(&self, id: &str) -> Option<GeometryBox> {
        self.document
            .nodes
            .iter()
            .find(|n| n.id == id)
            .map(|n| n.bounds)
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
        self.document.nodes.push(GeometryNode {
            id: id.into(),
            bounds,
            position_source: source,
        });
        self.kinds.insert(id.into(), kind.into());
        let x = add(position.x, 12 * 64)?;
        let mut y = add(position.y, 8 * 64)?;
        self.label(
            &format!("node:{id}:label"),
            id,
            label,
            GeometryPoint { x, y },
            700,
            13 * 64,
        )?;
        y = add(y, th)?;
        if let Some(detail) = detail {
            self.label(
                &format!("node:{id}:sublabel"),
                id,
                detail,
                GeometryPoint { x, y },
                400,
                11 * 64,
            )?;
            y = add(y, dh)?;
        }
        if let Some(tag) = tag {
            self.label(
                &format!("node:{id}:tag"),
                id,
                tag,
                GeometryPoint { x, y },
                400,
                10 * 64,
            )?;
        }
        Ok(bounds)
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
    fn route_points(
        &self,
        r: &RouteRequest,
    ) -> Result<(Vec<GeometryPoint>, Vec<GeometryBox>), Diagnostic> {
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
        let clearance = add(r.width.unwrap_or(2 * 64) / 2, 2 * 64)?.max(4 * 64);
        let scene_bounds = self
            .document
            .nodes
            .iter()
            .map(|n| n.bounds)
            .chain(self.document.containers.iter().map(|c| c.bounds))
            .try_fold(from, |extent, b| extent.union(b).map_err(arithmetic))?;
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
        let mut obstacles: Vec<_> = self
            .document
            .nodes
            .iter()
            .map(|n| inflate(n.bounds, clearance))
            .collect::<Result<_, _>>()?;
        obstacles.extend(
            self.document
                .containers
                .iter()
                .filter(|c| c.kind == "card")
                .map(|c| inflate(c.bounds, clearance))
                .collect::<Result<Vec<_>, _>>()?,
        );
        obstacles.extend(
            self.document
                .labels
                .iter()
                .map(|l| inflate(l.bounds, clearance))
                .collect::<Result<Vec<_>, _>>()?,
        );
        #[cfg(test)]
        let routed = match self.route_budget {
            Some(budget) => crate::routing::route_orthogonal_with_budget(
                start, end, &obstacles, &waypoints, budget,
            ),
            None => crate::routing::route_orthogonal(start, end, &obstacles, &waypoints),
        };
        #[cfg(not(test))]
        let routed = crate::routing::route_orthogonal(start, end, &obstacles, &waypoints);
        let mut points = routed?;
        points.insert(0, a);
        points.push(z);
        Ok((points, obstacles))
    }
    fn route_label(&mut self, r: &RouteRequest) -> Result<(), Diagnostic> {
        let (points, obstacles) = self.route_points(r)?;
        if let Some(text) = r.label.as_deref().filter(|s| !s.is_empty()) {
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
                    let offsets = if p[0].x == p[1].x {
                        [(-w - 6 * 64, -h / 2), (6 * 64, -h / 2)]
                    } else {
                        [(-w / 2, -h - 6 * 64), (-w / 2, 6 * 64)]
                    };
                    for (dx, dy) in offsets {
                        let candidate = rect(add(center.x, dx)?, add(center.y, dy)?, w, h)?;
                        if !obstacles.iter().any(|o| intersects(candidate, *o))
                            && !points
                                .iter()
                                .any(|p| candidate.contains(*p).unwrap_or(true))
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
            if obstacles.iter().any(|o| intersects(b, *o)) {
                return Err(failure(
                    "route-label-space",
                    "authored route label overlaps a node or label",
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
        Ok(())
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
        self.connections.sort_by(|a, b| a.id.cmp(&b.id));
        let mut failed = BTreeSet::new();
        for r in self.connections.clone() {
            let label_count = self.document.labels.len();
            let diagnostic_count = self.diagnostics.len();
            if let Err(diagnostic) = self.route_label(&r) {
                self.document.labels.truncate(label_count);
                self.diagnostics.truncate(diagnostic_count);
                failed.insert(r.source_index);
                self.route_error(&r, diagnostic);
            }
        }
        let mut final_routes = Vec::new();
        for r in self.connections.clone() {
            let points = if failed.contains(&r.source_index) {
                Vec::new()
            } else {
                let result = self.route_points(&r).and_then(|(points, _)| {
                    if points.windows(2).any(|pair| {
                        self.document
                            .nodes
                            .iter()
                            .map(|n| n.bounds)
                            .chain(self.document.labels.iter().map(|l| l.bounds))
                            .any(|b| segment_hits_box(pair[0], pair[1], b))
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
        let legend_y = add(extent.bottom().map_err(arithmetic)?, 32 * 64)?;
        let mut x = 32 * 64;
        let mut entries = vec![];
        let mut legend_height = 0;
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
        for kind in kinds {
            let entry = meta
                .legend
                .as_ref()
                .and_then(|l| l.entries.as_ref())
                .and_then(|entries| entries.get(&kind));
            if entry.and_then(|e| e.visible) == Some(false) {
                continue;
            }
            let label = entry.and_then(|e| e.label.as_deref()).unwrap_or(&kind);
            let (w, h) = self.text_size(label, 400, 12 * 64)?;
            let b = self.label(
                &format!("legend:{kind}"),
                "legend",
                label,
                GeometryPoint { x, y: legend_y },
                400,
                12 * 64,
            )?;
            entries.push(GeometryLegendEntry {
                key: kind.clone(),
                label: label.into(),
                bounds: b,
            });
            x = add(x, add(w, 32 * 64)?)?;
            legend_height = legend_height.max(h);
        }
        self.document.legend = GeometryLegend {
            bounds: if entries.is_empty() {
                rect(0, 0, 0, 0)?
            } else {
                rect(
                    16 * 64,
                    add(legend_y, -8 * 64)?,
                    x.max(32 * 64),
                    add(legend_height, 16 * 64)?,
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
        Ok((geometry, diagnostics, ok)) => {
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
            let expected: BTreeSet<_> = common::legend_keys(&kind).into_iter().collect();
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
        assert_eq!(report.diagnostics.len(), 1, "{:?}", report.diagnostics);
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
                    f64::from(node.bounds.y) / 64.0 + 10.0
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
            let (scene, diagnostics, ok) = builder.finish(&typed(&spec["meta"]).unwrap()).unwrap();
            assert!(!ok, "{kind}");
            assert_eq!(diagnostics.len(), 1, "{kind}: {diagnostics:?}");
            assert_eq!(diagnostics[0].path, format!("/{collection}/0"));
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
        match kind {
            "architecture" => spec["components"][1]["row"] = 2.into(),
            "workflow" => spec["nodes"][1]["yOffset"] = 220.into(),
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
            let nodes = baseline.geometry.unwrap().nodes;
            let a = nodes.iter().find(|n| n.id == "a").unwrap().bounds;
            let b = nodes.iter().find(|n| n.id == "b").unwrap().bounds;
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
                            ('x', b.right().unwrap() + 100 * 64)
                        } else if ["return-left", "left-channel"].contains(preset) {
                            ('x', a.x - 100 * 64)
                        } else if ["vertical-channel", "orthogonal-h"].contains(preset) {
                            ('x', gapx)
                        } else if ["top-channel", "up-channel"].contains(preset) {
                            ('y', a.y - 240 * 64)
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
                                    p.y == override_axis.1
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
        assert!(report.ok, "{:?}", report.diagnostics);
        assert!(report
            .diagnostics
            .iter()
            .all(|d| d.code != "document/pin-member-removed"));
        let geometry = report.geometry.unwrap();
        for (index, id) in ids.iter().enumerate() {
            let frame = geometry.containers.iter().find(|c| c.id == *id).unwrap();
            assert_eq!(
                (frame.bounds.x, frame.bounds.y),
                ((800 + index as i32 * 200) * 64, 600 * 64)
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
}
