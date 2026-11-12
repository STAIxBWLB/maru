//! Integer-only orthogonal routing around node and label interiors.
//!
//! The caller supplies clearance-inflated rectangles and outside ports. Their
//! boundaries are traversable; the original painted objects therefore retain
//! the caller's clearance. The implicit grid uses every obstacle edge and every
//! endpoint axis without allocating the Cartesian product. Stable A* ordering
//! makes ties independent of obstacle input order and hash-map iteration.

use crate::geometry::{GeometryBox, GeometryPoint};
use crate::layout::fixed::Coord;
use crate::Diagnostic;
use std::cell::{RefCell, RefMut};
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};

const BEND_COST: i64 = 16 * 64;
const MAX_AXIS_COORDINATES: usize = 8192;
const MAX_SEARCH_STATES: usize = 131_072;
/// The production search budget, for callers that share the planner.
pub(crate) const SEARCH_STATES: usize = MAX_SEARCH_STATES;
const MAX_WAYPOINTS: usize = 4096;
const MAX_OBSTACLES: usize = 65_536;
const MAX_QUEUED_STATES: usize = 4 * MAX_SEARCH_STATES;

/// An endpoint's node/label mask may contain this authored via anchor. The
/// obstacle indexes are exempt only on the two route legs incident to it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EndpointObstacleMask {
    pub waypoint_index: usize,
    pub obstacle_indices: Vec<usize>,
}

/// A routed path retains the output index of every mandatory waypoint. Layout
/// uses these to scope the final exemption to the visible inside run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MaskedRoute {
    pub points: Vec<GeometryPoint>,
    pub waypoint_point_indices: Vec<usize>,
}

/// Authored connection hints. The scene builder resolves ports, translates
/// channels into mandatory points, and positions labels before calling routing.
#[derive(Debug, Clone, Default)]
pub struct RouteRequest {
    pub id: String,
    pub from: String,
    pub to: String,
    pub label: Option<String>,
    pub from_side: Option<String>,
    pub to_side: Option<String>,
    pub waypoints: Vec<GeometryPoint>,
    pub label_at: Option<GeometryPoint>,
    pub from_y: Option<Coord>,
    pub to_y: Option<Coord>,
    pub route: Option<String>,
    pub bias: Option<f64>,
    pub source_index: usize,
    pub channel_x: Option<Coord>,
    pub channel_y: Option<Coord>,
    pub label_dx: Option<Coord>,
    pub label_dy: Option<Coord>,
    pub label_segment: Option<usize>,
    pub variant: Option<String>,
    pub role: Option<String>,
    pub width: Option<Coord>,
}

#[derive(Clone, Copy)]
struct Rect {
    left: Coord,
    top: Coord,
    right: Coord,
    bottom: Coord,
}

fn diagnostic(suffix: &str, message: impl Into<String>, fix: &str) -> Diagnostic {
    Diagnostic {
        code: format!("document/route-{suffix}"),
        path: "/route".into(),
        rule: format!("geometry-v1/route-{suffix}"),
        message: message.into(),
        fix: fix.into(),
    }
}

fn budget() -> Diagnostic {
    diagnostic(
        "budget",
        "orthogonal routing exceeded its deterministic search budget",
        "spread tightly packed objects apart, reduce obstacle count, or add an outside channel waypoint",
    )
}

fn normalize(obstacles: &[GeometryBox]) -> Result<Vec<Rect>, Diagnostic> {
    if obstacles.len() > MAX_OBSTACLES {
        return Err(budget());
    }
    let mut result = Vec::new();
    result.try_reserve(obstacles.len()).map_err(|_| budget())?;
    for bounds in obstacles {
        if bounds.width < 0 || bounds.height < 0 {
            return Err(diagnostic(
                "obstacle",
                "a routing obstacle has a negative dimension",
                "use nonnegative node and label bounds before routing",
            ));
        }
        let right = bounds.x.checked_add(bounds.width).ok_or_else(|| {
            diagnostic(
                "obstacle",
                "a routing obstacle extends beyond the fixed-point coordinate range",
                "move or shrink the object to keep its bounds inside signed 32-bit fixed-point coordinates",
            )
        })?;
        let bottom = bounds.y.checked_add(bounds.height).ok_or_else(|| {
            diagnostic(
                "obstacle",
                "a routing obstacle extends beyond the fixed-point coordinate range",
                "move or shrink the object to keep its bounds inside signed 32-bit fixed-point coordinates",
            )
        })?;
        // Empty text/ink boxes are not painted obstacles.
        if bounds.width != 0 && bounds.height != 0 {
            result.push(Rect {
                left: bounds.x,
                top: bounds.y,
                right,
                bottom,
            });
        }
    }
    Ok(result)
}

fn point_clear(point: GeometryPoint, obstacles: &[Rect]) -> bool {
    !obstacles.iter().any(|rect| {
        point.x > rect.left && point.x < rect.right && point.y > rect.top && point.y < rect.bottom
    })
}

fn point_clear_except(point: GeometryPoint, obstacles: &[Rect], masked: &[usize]) -> bool {
    if masked.is_empty() {
        return point_clear(point, obstacles);
    }
    !obstacles.iter().enumerate().any(|(index, rect)| {
        !masked.contains(&index)
            && point.x > rect.left
            && point.x < rect.right
            && point.y > rect.top
            && point.y < rect.bottom
    })
}

/// The scan every cache answers with, also the exact predicate for the label
/// suffix a route adds on top of its cached obstacle set.
fn segment_clear(from: GeometryPoint, to: GeometryPoint, obstacles: &[Rect]) -> bool {
    if from.y == to.y {
        let (left, right) = (from.x.min(to.x), from.x.max(to.x));
        !obstacles.iter().any(|rect| {
            from.y > rect.top && from.y < rect.bottom && left.max(rect.left) < right.min(rect.right)
        })
    } else if from.x == to.x {
        let (top, bottom) = (from.y.min(to.y), from.y.max(to.y));
        !obstacles.iter().any(|rect| {
            from.x > rect.left && from.x < rect.right && top.max(rect.top) < bottom.min(rect.bottom)
        })
    } else {
        false
    }
}

fn segment_clear_except(
    from: GeometryPoint,
    to: GeometryPoint,
    obstacles: &[Rect],
    masked: &[usize],
) -> bool {
    if masked.is_empty() {
        return segment_clear(from, to, obstacles);
    }
    if from.y == to.y {
        let (left, right) = (from.x.min(to.x), from.x.max(to.x));
        !obstacles.iter().enumerate().any(|(index, rect)| {
            !masked.contains(&index)
                && from.y > rect.top
                && from.y < rect.bottom
                && left.max(rect.left) < right.min(rect.right)
        })
    } else if from.x == to.x {
        let (top, bottom) = (from.y.min(to.y), from.y.max(to.y));
        !obstacles.iter().enumerate().any(|(index, rect)| {
            !masked.contains(&index)
                && from.x > rect.left
                && from.x < rect.right
                && top.max(rect.top) < bottom.min(rect.bottom)
        })
    } else {
        false
    }
}

fn distance(from: GeometryPoint, to: GeometryPoint) -> i64 {
    (i64::from(from.x) - i64::from(to.x)).abs() + (i64::from(from.y) - i64::from(to.y)).abs()
}

/// A route leg is simplified independently, so mandatory waypoints shared by
/// adjacent legs are retained even when they are collinear with their neighbors.
fn simplify(points: Vec<GeometryPoint>) -> Vec<GeometryPoint> {
    let mut result: Vec<GeometryPoint> = Vec::new();
    for point in points {
        if result.last() == Some(&point) {
            continue;
        }
        while result.len() >= 2 {
            let a = result[result.len() - 2];
            let b = result[result.len() - 1];
            if (a.x == b.x && b.x == point.x) || (a.y == b.y && b.y == point.y) {
                result.pop();
            } else {
                break;
            }
        }
        result.push(point);
    }
    result
}

// Axis is the direction of the incoming segment: horizontal, vertical, none.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
struct State {
    x: usize,
    y: usize,
    axis: u8,
}

#[derive(Clone, Copy)]
struct Visit {
    cost: i64,
    bends: u32,
    parent: Option<State>,
}

/// A* repeatedly tests the same grid rows and columns. Retain only obstacles
/// whose open interior reaches that axis coordinate, preserving the original
/// predicates and normalized mask indexes. This never materializes the
/// Cartesian grid.
///
/// One cache serves every leg of a scene, so a bucket is a property of the
/// scene's axis rather than of a leg's grid: a bucket holds an obstacle when
/// that obstacle's closed interval [`crossing`] covers the coordinate, and a
/// query reads the bucket of the first coordinate strictly above it, or the
/// last bucket when no coordinate is above.
///
/// That bucket is a superset because an obstacle can only cover the query
/// strictly when its far edge is an axis coordinate above the query, and the
/// first coordinate above the query is then at or below that edge and still
/// above the obstacle's near edge. The caller's exact predicate rejects the
/// obstacles that only touch a boundary, so every coordinate has a bucket and
/// no covering obstacle is missed.
struct AxisCandidates {
    /// The sorted, deduplicated axis the buckets are indexed by.
    axis: Vec<Coord>,
    /// `spans[i]..spans[i + 1]` is the candidate range of `axis[i]`.
    spans: Vec<u32>,
    flat: Vec<Rect>,
    /// False when the buckets were dropped for wide overlapping obstacles.
    /// Every lookup then scans.
    retained: bool,
}

/// The degenerate rectangle a bucket slot starts as; spans decide what is read.
const EMPTY_RECT: Rect = Rect {
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
};

/// The interval a candidate must straddle openly to cross this axis.
fn crossing(rect: &Rect, horizontal: bool) -> (Coord, Coord) {
    if horizontal {
        (rect.top, rect.bottom)
    } else {
        (rect.left, rect.right)
    }
}

fn copy_axis(axis: &[Coord]) -> Result<Vec<Coord>, Diagnostic> {
    let mut out = Vec::new();
    out.try_reserve(axis.len()).map_err(|_| budget())?;
    out.extend_from_slice(axis);
    Ok(out)
}

/// A sorted axis plus its one-step outer bounds, in order.
fn pad_axis(axis: &[Coord]) -> Result<Vec<Coord>, Diagnostic> {
    let mut out = Vec::new();
    out.try_reserve(axis.len() + 2).map_err(|_| budget())?;
    if let Some(minimum) = axis.first().copied().and_then(|n| n.checked_sub(1)) {
        out.push(minimum);
    }
    out.extend_from_slice(axis);
    if let Some(maximum) = axis.last().copied().and_then(|n| n.checked_add(1)) {
        out.push(maximum);
    }
    Ok(out)
}

impl AxisCandidates {
    /// A cache whose every lookup scans: the bounded fallback for wide
    /// overlapping obstacles, which would otherwise retain the whole grid.
    fn scanning(axis: &[Coord]) -> Result<Self, Diagnostic> {
        Ok(Self {
            axis: copy_axis(axis)?,
            spans: Vec::new(),
            flat: Vec::new(),
            retained: false,
        })
    }

    fn build(
        axis: &[Coord],
        obstacles: &[Rect],
        masked: &[usize],
        horizontal: bool,
    ) -> Result<Self, Diagnostic> {
        // A difference array, so one obstacle costs two deltas instead of one
        // increment per axis slot it covers: a wide overlapping set would
        // otherwise hold obstacles times axis before the cap below is read.
        let mut deltas = Vec::new();
        deltas.try_reserve(axis.len() + 1).map_err(|_| budget())?;
        deltas.resize(axis.len() + 1, 0_i64);
        for (index, rect) in obstacles.iter().enumerate() {
            if masked.contains(&index) {
                continue;
            }
            let (start, end) = crossing(rect, horizontal);
            let first = axis.partition_point(|coordinate| *coordinate < start);
            let last = axis.partition_point(|coordinate| *coordinate <= end);
            if first >= last {
                continue;
            }
            deltas[first] += 1;
            deltas[last] -= 1;
        }
        let mut spans = Vec::new();
        spans.try_reserve(axis.len() + 1).map_err(|_| budget())?;
        spans.resize(axis.len() + 1, 0_u32);
        let mut covered: i64 = 0;
        let mut total: i64 = 0;
        for index in 0..axis.len() {
            covered += deltas[index];
            total += covered;
            if total > MAX_OBSTACLES as i64 {
                // Wide overlapping obstacles reach the retained-record cap. The
                // running total only grows, so stopping here reaches the same
                // verdict as the old end-of-pass check, without ever counting
                // the slots the retained form would consume: scan per lookup
                // instead.
                return Self::scanning(axis);
            }
            spans[index + 1] = total as u32;
        }
        let total = usize::try_from(total).map_err(|_| budget())?;
        let mut cursor = Vec::new();
        cursor.try_reserve(axis.len()).map_err(|_| budget())?;
        cursor.extend_from_slice(&spans[..axis.len()]);
        let mut flat = Vec::new();
        flat.try_reserve(total).map_err(|_| budget())?;
        flat.resize(total, EMPTY_RECT);
        for (index, rect) in obstacles.iter().enumerate() {
            if masked.contains(&index) {
                continue;
            }
            let (start, end) = crossing(rect, horizontal);
            let first = axis.partition_point(|coordinate| *coordinate < start);
            let last = axis.partition_point(|coordinate| *coordinate <= end);
            for position in &mut cursor[first..last] {
                let slot = usize::try_from(*position).map_err(|_| budget())?;
                flat[slot] = *rect;
                *position = position.saturating_add(1);
            }
        }
        Ok(Self {
            axis: copy_axis(axis)?,
            spans,
            flat,
            retained: true,
        })
    }

    fn candidates<'a>(
        &'a self,
        coordinate: Coord,
        obstacles: &'a [Rect],
        masked: &'a [usize],
        horizontal: bool,
    ) -> Candidates<'a> {
        if self.retained && !self.axis.is_empty() {
            // `partition_point` counts the coordinates at or below the query,
            // so this is the first coordinate strictly above it, clamped to the
            // last bucket when no coordinate is above. That bucket still holds
            // every obstacle whose closed interval can cover the query: such an
            // obstacle's far edge is an axis coordinate above the query, and it
            // is not below the first one.
            let position = self
                .axis
                .partition_point(|held| *held <= coordinate)
                .min(self.axis.len() - 1);
            let start = self.spans[position] as usize;
            let end = self.spans[position + 1] as usize;
            return Candidates::Retained(self.flat[start..end].iter());
        }
        Candidates::Scan {
            obstacles,
            masked,
            horizontal,
            coordinate,
            index: 0,
        }
    }
}

/// The obstacles crossing one axis coordinate: a retained bucket, or the
/// bounded scan that keeps an uncached coordinate allocation-free.
enum Candidates<'a> {
    Retained(std::slice::Iter<'a, Rect>),
    Scan {
        obstacles: &'a [Rect],
        masked: &'a [usize],
        horizontal: bool,
        coordinate: Coord,
        index: usize,
    },
}

impl<'a> Iterator for Candidates<'a> {
    type Item = &'a Rect;

    fn next(&mut self) -> Option<&'a Rect> {
        match self {
            Candidates::Retained(iter) => iter.next(),
            Candidates::Scan {
                obstacles,
                masked,
                horizontal,
                coordinate,
                index,
            } => {
                while *index < obstacles.len() {
                    let position = *index;
                    *index += 1;
                    let rect: &'a Rect = &(*obstacles)[position];
                    let (start, end) = crossing(rect, *horizontal);
                    if !masked.contains(&position) && *coordinate > start && *coordinate < end {
                        return Some(rect);
                    }
                }
                None
            }
        }
    }
}

/// Clearance lookups over one obstacle set and one mask set, built once for a
/// scene. Every query reads only the bucket of its own row or column.
struct ClearanceCache {
    rows: AxisCandidates,
    columns: AxisCandidates,
}

impl ClearanceCache {
    fn build(
        xs: &[Coord],
        ys: &[Coord],
        obstacles: &[Rect],
        masked: &[usize],
    ) -> Result<Self, Diagnostic> {
        Ok(Self {
            rows: AxisCandidates::build(ys, obstacles, masked, true)?,
            columns: AxisCandidates::build(xs, obstacles, masked, false)?,
        })
    }

    fn point_clear(&self, point: GeometryPoint, obstacles: &[Rect], masked: &[usize]) -> bool {
        !self
            .rows
            .candidates(point.y, obstacles, masked, true)
            .any(|rect| {
                point.x > rect.left
                    && point.x < rect.right
                    && point.y > rect.top
                    && point.y < rect.bottom
            })
    }

    fn segment_clear(
        &self,
        from: GeometryPoint,
        to: GeometryPoint,
        obstacles: &[Rect],
        masked: &[usize],
    ) -> bool {
        if from.y == to.y {
            let (left, right) = (from.x.min(to.x), from.x.max(to.x));
            !self
                .rows
                .candidates(from.y, obstacles, masked, true)
                .any(|rect| {
                    from.y > rect.top
                        && from.y < rect.bottom
                        && left.max(rect.left) < right.min(rect.right)
                })
        } else if from.x == to.x {
            let (top, bottom) = (from.y.min(to.y), from.y.max(to.y));
            !self
                .columns
                .candidates(from.x, obstacles, masked, false)
                .any(|rect| {
                    from.x > rect.left
                        && from.x < rect.right
                        && top.max(rect.top) < bottom.min(rect.bottom)
                })
        } else {
            false
        }
    }
}

/// One leg's implicit grid: the scene's obstacle axis, merged with the label
/// suffix this route adds, plus the two endpoint coordinates it must offer and
/// the one-step outer bounds. Both inputs are sorted and deduplicated, so the
/// result is the same set a from-scratch axis build over base plus suffix
/// yields, without re-sorting the scene's edges per leg.
fn leg_axis(
    base: &[Coord],
    suffix: &[Coord],
    endpoints: [Coord; 2],
) -> Result<Vec<Coord>, Diagnostic> {
    let mut axis = Vec::new();
    axis.try_reserve(base.len() + suffix.len() + 4)
        .map_err(|_| budget())?;
    let (mut base_index, mut suffix_index) = (0, 0);
    while base_index < base.len() || suffix_index < suffix.len() {
        let take_suffix = base_index >= base.len()
            || (suffix_index < suffix.len() && suffix[suffix_index] < base[base_index]);
        let coordinate = if take_suffix {
            suffix_index += 1;
            suffix[suffix_index - 1]
        } else {
            base_index += 1;
            base[base_index - 1]
        };
        if axis.last() != Some(&coordinate) {
            axis.push(coordinate);
        }
    }
    for coordinate in endpoints {
        if let Err(position) = axis.binary_search(&coordinate) {
            axis.insert(position, coordinate);
        }
    }
    if let Some(minimum) = axis.first().copied().and_then(|n| n.checked_sub(1)) {
        if let Err(position) = axis.binary_search(&minimum) {
            axis.insert(position, minimum);
        }
    }
    if let Some(maximum) = axis.last().copied().and_then(|n| n.checked_add(1)) {
        if let Err(position) = axis.binary_search(&maximum) {
            axis.insert(position, maximum);
        }
    }
    Ok(axis)
}

fn search_leg(
    start: GeometryPoint,
    end: GeometryPoint,
    leg: &LegObstacles<'_>,
    max_search_states: usize,
) -> Result<Vec<GeometryPoint>, Diagnostic> {
    if start == end {
        return Ok(vec![start]);
    }
    if leg
        .clearance
        .segment_clear(start, end, leg.base_masked, leg.suffix_masked)
    {
        return Ok(vec![start, end]);
    }
    // One bend is globally shortest in distance and bends whenever available.
    // Checking both corners is a fast path, not the failure fallback.
    let mut corners = [
        GeometryPoint {
            x: start.x,
            y: end.y,
        },
        GeometryPoint {
            x: end.x,
            y: start.y,
        },
    ];
    corners.sort_by_key(|point| (point.x, point.y));
    for corner in corners {
        if leg
            .clearance
            .point_clear(corner, leg.base_masked, leg.suffix_masked)
            && leg
                .clearance
                .segment_clear(start, corner, leg.base_masked, leg.suffix_masked)
            && leg
                .clearance
                .segment_clear(corner, end, leg.base_masked, leg.suffix_masked)
        {
            return Ok(simplify(vec![start, corner, end]));
        }
    }

    // Explicit local budgets are a test seam only; production always passes
    // MAX_SEARCH_STATES. Fast visible paths above consume no A* states.
    let max_search_states = max_search_states.min(MAX_SEARCH_STATES);
    if max_search_states == 0 {
        return Err(budget());
    }
    let max_queued_states = max_search_states
        .saturating_mul(4)
        .clamp(1, MAX_QUEUED_STATES);
    let x_axis = leg_axis(leg.xs, leg.suffix_x, [start.x, end.x])?;
    let y_axis = leg_axis(leg.ys, leg.suffix_y, [start.y, end.y])?;
    if x_axis.len() > MAX_AXIS_COORDINATES || y_axis.len() > MAX_AXIS_COORDINATES {
        return Err(budget());
    }
    // A search asks hundreds of clearance questions, so bucket the suffix over
    // this leg's axis once instead of walking it per question. A bucket is a
    // superset that the same exact predicate filters, so no answer moves.
    let suffix_cache = (!leg.clearance.suffix.is_empty())
        .then(|| ClearanceCache::build(&x_axis, &y_axis, leg.clearance.suffix, leg.suffix_masked))
        .transpose()?;
    let clearance = ClearanceMap {
        suffix_cache: suffix_cache.as_ref(),
        ..leg.clearance
    };
    // Both coordinates were inserted above, so these searches cannot fail.
    let initial = State {
        x: x_axis.binary_search(&start.x).map_err(|_| budget())?,
        y: y_axis.binary_search(&start.y).map_err(|_| budget())?,
        axis: 2,
    };
    let mut visits = HashMap::new();
    visits.insert(
        initial,
        Visit {
            cost: 0,
            bends: 0,
            parent: None,
        },
    );
    let mut queue = BinaryHeap::new();
    queue.push(Reverse((distance(start, end), 0_i64, 0_u32, initial)));
    while let Some(Reverse((_, cost, bends, state))) = queue.pop() {
        let current = visits[&state];
        if current.cost != cost || current.bends != bends {
            continue;
        }
        // Count only live expansions, including the terminal goal state.
        // Queue entries superseded by a better path consume no expansion.
        #[cfg(any(test, feature = "geometry-corpus"))]
        crate::work::record_astar_expansion();
        #[cfg(any(test, feature = "geometry-corpus"))]
        if !(leg.base_masked.is_empty() && leg.suffix_masked.is_empty()) {
            crate::work::record_masked_astar_expansion();
        }
        let point = GeometryPoint {
            x: x_axis[state.x],
            y: y_axis[state.y],
        };
        if point == end {
            let mut path = Vec::new();
            let mut cursor = Some(state);
            while let Some(item) = cursor {
                path.push(GeometryPoint {
                    x: x_axis[item.x],
                    y: y_axis[item.y],
                });
                cursor = visits[&item].parent;
            }
            path.reverse();
            return Ok(simplify(path));
        }
        // Neighbor order and queue tie keys are explicit and platform-stable.
        let candidates = [
            state.x.checked_sub(1).map(|x| State {
                x,
                y: state.y,
                axis: 0,
            }),
            (state.x + 1 < x_axis.len()).then_some(State {
                x: state.x + 1,
                y: state.y,
                axis: 0,
            }),
            state.y.checked_sub(1).map(|y| State {
                x: state.x,
                y,
                axis: 1,
            }),
            (state.y + 1 < y_axis.len()).then_some(State {
                x: state.x,
                y: state.y + 1,
                axis: 1,
            }),
        ];
        for next in candidates.into_iter().flatten() {
            let target = GeometryPoint {
                x: x_axis[next.x],
                y: y_axis[next.y],
            };
            if !clearance.point_clear(target, leg.base_masked, leg.suffix_masked)
                || !clearance.segment_clear(point, target, leg.base_masked, leg.suffix_masked)
            {
                continue;
            }
            let turn = u32::from(state.axis != 2 && state.axis != next.axis);
            let next_bends = bends.checked_add(turn).ok_or_else(budget)?;
            let next_cost = cost
                .checked_add(distance(point, target))
                .and_then(|value| value.checked_add(i64::from(turn) * BEND_COST))
                .ok_or_else(budget)?;
            if visits
                .get(&next)
                .is_some_and(|old| (old.cost, old.bends) <= (next_cost, next_bends))
            {
                continue;
            }
            if !visits.contains_key(&next) && visits.len() >= max_search_states {
                return Err(budget());
            }
            if queue.len() >= max_queued_states {
                return Err(budget());
            }
            visits.try_reserve(1).map_err(|_| budget())?;
            queue.try_reserve(1).map_err(|_| budget())?;
            visits.insert(
                next,
                Visit {
                    cost: next_cost,
                    bends: next_bends,
                    parent: Some(state),
                },
            );
            let estimate = next_cost
                .checked_add(distance(target, end))
                .ok_or_else(budget)?;
            queue.push(Reverse((estimate, next_cost, next_bends, next)));
        }
    }
    Err(diagnostic(
        "blocked",
        "no orthogonal corridor connects the requested route anchors",
        "move overlapping objects or place channel waypoints in an open corridor",
    ))
}

/// Route each consecutive mandatory anchor through the obstacle visibility grid.
/// No fallback path may cross an obstacle. Identical inputs produce identical
/// vertices, and obstacle permutation does not affect the selected geometry.
pub fn route_orthogonal(
    start: GeometryPoint,
    end: GeometryPoint,
    obstacles: &[GeometryBox],
    waypoints: &[GeometryPoint],
) -> Result<Vec<GeometryPoint>, Diagnostic> {
    route_with_budget(start, end, obstacles, waypoints, &[], MAX_SEARCH_STATES)
        .map(|route| route.points)
}

/// Route an authored endpoint via through its own opaque node/label mask while
/// keeping every unrelated node and label obstacle active.
pub(crate) fn route_orthogonal_with_endpoint_masks(
    start: GeometryPoint,
    end: GeometryPoint,
    obstacles: &[GeometryBox],
    waypoints: &[GeometryPoint],
    endpoint_masks: &[EndpointObstacleMask],
) -> Result<MaskedRoute, Diagnostic> {
    route_with_budget(
        start,
        end,
        obstacles,
        waypoints,
        endpoint_masks,
        MAX_SEARCH_STATES,
    )
}

#[cfg(test)]
pub(crate) fn route_orthogonal_with_endpoint_masks_and_budget(
    start: GeometryPoint,
    end: GeometryPoint,
    obstacles: &[GeometryBox],
    waypoints: &[GeometryPoint],
    endpoint_masks: &[EndpointObstacleMask],
    max_search_states: usize,
) -> Result<MaskedRoute, Diagnostic> {
    route_with_budget(
        start,
        end,
        obstacles,
        waypoints,
        endpoint_masks,
        max_search_states,
    )
}

/// Local deterministic failure injection, without a process-global setting or
/// a production request field. A* and its queue use the same implementation.
#[cfg(test)]
pub(crate) fn route_orthogonal_with_budget(
    start: GeometryPoint,
    end: GeometryPoint,
    obstacles: &[GeometryBox],
    waypoints: &[GeometryPoint],
    max_search_states: usize,
) -> Result<Vec<GeometryPoint>, Diagnostic> {
    route_with_budget(start, end, obstacles, waypoints, &[], max_search_states)
        .map(|route| route.points)
}

fn route_with_budget(
    start: GeometryPoint,
    end: GeometryPoint,
    obstacles: &[GeometryBox],
    waypoints: &[GeometryPoint],
    endpoint_masks: &[EndpointObstacleMask],
    max_search_states: usize,
) -> Result<MaskedRoute, Diagnostic> {
    RoutePlanner::new(obstacles)?.route(start, end, waypoints, endpoint_masks, max_search_states)
}

/// One obstacle set's routing inputs: the normalized obstacles, plus — built on
/// the scene's first clearance query — the obstacle axis and a clearance cache
/// per mask set.
///
/// The grid is not conditional on a leg searching. `route` tests both anchors
/// and `search_leg` reads the cache before its straight and one-bend checks, so
/// the first route of a scene builds it whatever its path turns out to be; a
/// clear straight or one-bend leg saves only the per-leg axis and the A*
/// search. The axis is sorted once for the whole obstacle set and a cache
/// bucket answers about a coordinate rather than about a leg: the search still
/// sees the same coordinate set and the same candidates as a per-leg build.
pub(crate) struct RoutePlanner {
    obstacles: Vec<Rect>,
    /// Source obstacle index to normalized index (`None` for a zero-area box).
    source_to_normalized: Vec<Option<usize>>,
    prepared: RefCell<Option<Prepared>>,
}

struct Prepared {
    /// The scene's obstacle edges, sorted and deduplicated. A leg inserts its
    /// own endpoints into these to form its grid.
    xs: Vec<Coord>,
    ys: Vec<Coord>,
    /// `xs`/`ys` plus the one-step outer bounds. A cache buckets exactly these
    /// coordinates; any other coordinate scans its candidates instead.
    grid_xs: Vec<Coord>,
    grid_ys: Vec<Coord>,
    /// Keyed by the leg's normalized mask indexes, so an endpoint-masked leg
    /// never reads an unmasked candidate bucket.
    caches: HashMap<Vec<usize>, ClearanceCache>,
}

/// One mask set's key. Every allocation of the candidate cache goes through
/// `try_reserve` so an exhausted heap refuses with the budget diagnostic
/// instead of aborting the process.
fn cache_key(masked: &[usize]) -> Result<Vec<usize>, Diagnostic> {
    let mut key = Vec::new();
    key.try_reserve(masked.len()).map_err(|_| budget())?;
    key.extend_from_slice(masked);
    Ok(key)
}

/// The clearance cache of one mask set, built on its first use.
fn leg_cache<'a>(
    caches: &'a mut HashMap<Vec<usize>, ClearanceCache>,
    grid_xs: &[Coord],
    grid_ys: &[Coord],
    obstacles: &[Rect],
    masked: &[usize],
) -> Result<&'a ClearanceCache, Diagnostic> {
    // The cached case borrows the key it already holds; only a miss allocates.
    if !caches.contains_key(masked) {
        let cache = ClearanceCache::build(grid_xs, grid_ys, obstacles, masked)?;
        caches.try_reserve(1).map_err(|_| budget())?;
        caches.insert(cache_key(masked)?, cache);
    }
    Ok(caches.get(masked).expect("cache inserted above"))
}

/// The obstacles one route clears against: the planner's cached base set, read
/// through its clearance cache, plus the label suffix that route appended, which
/// is small and scanned directly.
///
/// The two halves answer the same predicate the scene's own set would have, in
/// the same order, because the suffix's rects come after every base rect.
#[derive(Clone, Copy)]
struct ClearanceMap<'a> {
    cache: &'a ClearanceCache,
    base: &'a [Rect],
    suffix: &'a [Rect],
    /// The suffix's own buckets over the leg axis. A visible leg asks four
    /// questions and scans, but a search asks hundreds, so it buckets the suffix
    /// once per leg instead of walking it per question.
    suffix_cache: Option<&'a ClearanceCache>,
}

impl ClearanceMap<'_> {
    fn point_clear(
        &self,
        point: GeometryPoint,
        base_masked: &[usize],
        suffix_masked: &[usize],
    ) -> bool {
        self.cache.point_clear(point, self.base, base_masked)
            && match self.suffix_cache {
                Some(cache) => cache.point_clear(point, self.suffix, suffix_masked),
                None => point_clear_except(point, self.suffix, suffix_masked),
            }
    }

    fn segment_clear(
        &self,
        from: GeometryPoint,
        to: GeometryPoint,
        base_masked: &[usize],
        suffix_masked: &[usize],
    ) -> bool {
        self.cache.segment_clear(from, to, self.base, base_masked)
            && match self.suffix_cache {
                Some(cache) => cache.segment_clear(from, to, self.suffix, suffix_masked),
                None => segment_clear_except(from, to, self.suffix, suffix_masked),
            }
    }
}

/// One leg's routing inputs: where each clearance is read, the masks in the
/// combined namespace the endpoint masks use, and the axis pieces.
struct LegObstacles<'a> {
    clearance: ClearanceMap<'a>,
    base_masked: &'a [usize],
    suffix_masked: &'a [usize],
    xs: &'a [Coord],
    ys: &'a [Coord],
    suffix_x: &'a [Coord],
    suffix_y: &'a [Coord],
}

/// The obstacles a route appends after the scene was prepared: a relationship
/// label placed during routing, which cannot be part of the scene's cached set.
struct SuffixObstacles {
    rects: Vec<Rect>,
    /// Source suffix index to normalized index, already offset into the
    /// combined namespace so one mask list covers both halves.
    source_to_normalized: Vec<Option<usize>>,
    x_edges: Vec<Coord>,
    y_edges: Vec<Coord>,
}

impl SuffixObstacles {
    fn new(
        suffix: &[GeometryBox],
        base_source_len: usize,
        base_len: usize,
    ) -> Result<Self, Diagnostic> {
        // The combined set is what a from-scratch planner would normalize, so
        // the same cap refuses it, and with the same diagnostic.
        if base_source_len.saturating_add(suffix.len()) > MAX_OBSTACLES {
            return Err(budget());
        }
        let rects = normalize(suffix)?;
        let mut source_to_normalized = normalized_obstacle_indexes(suffix)?;
        for index in source_to_normalized.iter_mut().flatten() {
            *index += base_len;
        }
        Ok(Self {
            x_edges: obstacle_axis(&rects, false)?,
            y_edges: obstacle_axis(&rects, true)?,
            rects,
            source_to_normalized,
        })
    }
}

/// One leg's masks, split into the base-relative half the cache keys on and the
/// suffix-relative half the suffix scan applies.
fn split_masks(masked: &[usize], base_len: usize) -> Result<(Vec<usize>, Vec<usize>), Diagnostic> {
    let mut base = Vec::new();
    let mut suffix = Vec::new();
    base.try_reserve(masked.len()).map_err(|_| budget())?;
    suffix.try_reserve(masked.len()).map_err(|_| budget())?;
    for index in masked {
        match index.checked_sub(base_len) {
            None => base.push(*index),
            Some(index) => suffix.push(index),
        }
    }
    Ok((base, suffix))
}

/// A route anchor is tested against the whole obstacle set, so it reads the
/// unmasked bucket of its row like any other clearance query.
fn anchor_clear(
    prepared: &mut Prepared,
    base: &[Rect],
    suffix: &[Rect],
    point: GeometryPoint,
) -> Result<bool, Diagnostic> {
    let Prepared {
        grid_xs,
        grid_ys,
        caches,
        ..
    } = prepared;
    let cache = leg_cache(caches, grid_xs.as_slice(), grid_ys.as_slice(), base, &[])?;
    let clearance = ClearanceMap {
        cache,
        base,
        suffix,
        suffix_cache: None,
    };
    Ok(clearance.point_clear(point, &[], &[]))
}

impl RoutePlanner {
    pub(crate) fn new(obstacles: &[GeometryBox]) -> Result<Self, Diagnostic> {
        Ok(Self {
            obstacles: normalize(obstacles)?,
            source_to_normalized: normalized_obstacle_indexes(obstacles)?,
            prepared: RefCell::new(None),
        })
    }

    fn build_prepared(&self) -> Result<Prepared, Diagnostic> {
        let xs = obstacle_axis(&self.obstacles, false)?;
        let ys = obstacle_axis(&self.obstacles, true)?;
        let grid_xs = pad_axis(&xs)?;
        let grid_ys = pad_axis(&ys)?;
        let mut caches = HashMap::new();
        caches.try_reserve(1).map_err(|_| budget())?;
        caches.insert(
            Vec::new(),
            ClearanceCache::build(&grid_xs, &grid_ys, &self.obstacles, &[])?,
        );
        Ok(Prepared {
            xs,
            ys,
            grid_xs,
            grid_ys,
            caches,
        })
    }

    fn prepared_mut(&self) -> Result<RefMut<'_, Prepared>, Diagnostic> {
        if self.prepared.borrow().is_none() {
            let prepared = self.build_prepared()?;
            *self.prepared.borrow_mut() = Some(prepared);
        }
        Ok(RefMut::map(self.prepared.borrow_mut(), |slot| {
            slot.as_mut().expect("prepared above")
        }))
    }

    /// Route one connection through the scene's obstacles.
    pub(crate) fn route(
        &self,
        start: GeometryPoint,
        end: GeometryPoint,
        waypoints: &[GeometryPoint],
        endpoint_masks: &[EndpointObstacleMask],
        max_search_states: usize,
    ) -> Result<MaskedRoute, Diagnostic> {
        self.route_with_suffix(
            &[],
            start,
            end,
            waypoints,
            endpoint_masks,
            max_search_states,
        )
    }

    /// Route one connection, treating `suffix` as obstacles appended to the
    /// scene's set. A relationship label placed after the scene was prepared is
    /// exactly that, so the cached axis, buckets and offsets still describe the
    /// scene: the suffix is merged into the leg axis and scanned on top of every
    /// clearance, instead of rebuilding a planner for one route.
    pub(crate) fn route_with_suffix(
        &self,
        suffix: &[GeometryBox],
        start: GeometryPoint,
        end: GeometryPoint,
        waypoints: &[GeometryPoint],
        endpoint_masks: &[EndpointObstacleMask],
        max_search_states: usize,
    ) -> Result<MaskedRoute, Diagnostic> {
        if waypoints.len() > MAX_WAYPOINTS {
            return Err(budget());
        }
        let suffix = SuffixObstacles::new(
            suffix,
            self.source_to_normalized.len(),
            self.obstacles.len(),
        )?;
        let base_len = self.obstacles.len();
        let (via_masked_indexes, leg_masked_indexes) = endpoint_mask_indexes(
            endpoint_masks,
            &self.source_to_normalized,
            &suffix.source_to_normalized,
            waypoints.len(),
        );
        let mut prepared = self.prepared_mut()?;
        if !anchor_clear(&mut prepared, &self.obstacles, &suffix.rects, start)? {
            return Err(diagnostic(
                "blocked",
                "route anchor 0 lies inside a node or label obstacle",
                "move the port or authored waypoint outside all node and label bounds",
            ));
        }
        for (index, anchor) in waypoints.iter().enumerate() {
            let masks = via_masked_indexes
                .get(index)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            let (base_masked, suffix_masked) = split_masks(masks, base_len)?;
            if !point_clear_except(*anchor, &self.obstacles, &base_masked)
                || !point_clear_except(*anchor, &suffix.rects, &suffix_masked)
            {
                return Err(diagnostic(
                    "blocked",
                    format!(
                        "route anchor {} lies inside a node or label obstacle",
                        index + 1
                    ),
                    "move the port or authored waypoint outside all node and label bounds",
                ));
            }
        }
        if !anchor_clear(&mut prepared, &self.obstacles, &suffix.rects, end)? {
            return Err(diagnostic(
                "blocked",
                format!(
                    "route anchor {} lies inside a node or label obstacle",
                    waypoints.len() + 1
                ),
                "move the port or authored waypoint outside all node and label bounds",
            ));
        }
        let mut route = Vec::new();
        let mut waypoint_point_indices = Vec::with_capacity(waypoints.len());
        let mut previous = start;
        for (leg_index, target) in waypoints
            .iter()
            .copied()
            .chain(std::iter::once(end))
            .enumerate()
        {
            let masks = leg_masked_indexes
                .get(leg_index)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            let (base_masked, suffix_masked) = split_masks(masks, base_len)?;
            let leg_points = {
                let Prepared {
                    xs,
                    ys,
                    grid_xs,
                    grid_ys,
                    caches,
                } = &mut *prepared;
                let cache = leg_cache(
                    caches,
                    grid_xs.as_slice(),
                    grid_ys.as_slice(),
                    &self.obstacles,
                    &base_masked,
                )?;
                let leg = LegObstacles {
                    clearance: ClearanceMap {
                        cache,
                        base: &self.obstacles,
                        suffix: &suffix.rects,
                        suffix_cache: None,
                    },
                    base_masked: &base_masked,
                    suffix_masked: &suffix_masked,
                    xs: xs.as_slice(),
                    ys: ys.as_slice(),
                    suffix_x: &suffix.x_edges,
                    suffix_y: &suffix.y_edges,
                };
                search_leg(previous, target, &leg, max_search_states)?
            };
            if route.is_empty() {
                route.extend(leg_points.iter().copied());
            } else {
                for point in leg_points.into_iter().skip(1) {
                    if route.last() != Some(&point) {
                        route.push(point);
                    }
                }
            }
            if leg_index < waypoints.len() {
                waypoint_point_indices.push(route.len() - 1);
            }
            previous = target;
        }
        Ok(MaskedRoute {
            points: route,
            waypoint_point_indices,
        })
    }
}

/// The sorted, deduplicated obstacle edges of one axis. Endpoint coordinates
/// are added per leg, so the axis itself is a property of the scene.
fn obstacle_axis(obstacles: &[Rect], horizontal: bool) -> Result<Vec<Coord>, Diagnostic> {
    let capacity = obstacles.len().checked_mul(2).ok_or_else(budget)?;
    let mut axis = Vec::new();
    axis.try_reserve(capacity).map_err(|_| budget())?;
    for rect in obstacles {
        let (start, end) = crossing(rect, horizontal);
        axis.extend([start, end]);
    }
    axis.sort_unstable();
    axis.dedup();
    Ok(axis)
}

fn normalized_obstacle_indexes(source: &[GeometryBox]) -> Result<Vec<Option<usize>>, Diagnostic> {
    // normalize omits zero-area boxes, retaining the source order of every
    // painted obstacle. The caller-provided indexes refer to that source list.
    let mut indexes = Vec::new();
    indexes.try_reserve(source.len()).map_err(|_| budget())?;
    let mut next = 0;
    for bounds in source {
        if bounds.width == 0 || bounds.height == 0 {
            indexes.push(None);
        } else {
            indexes.push(Some(next));
            next += 1;
        }
    }
    Ok(indexes)
}

/// Resolve one authored mask into indexes of the combined normalized namespace:
/// the planner's own obstacles first, then the source obstacles this route
/// appended after them.
fn endpoint_mask_indexes(
    masks: &[EndpointObstacleMask],
    base_to_normalized: &[Option<usize>],
    suffix_to_normalized: &[Option<usize>],
    waypoint_count: usize,
) -> (Vec<Vec<usize>>, Vec<Vec<usize>>) {
    let mut by_via = vec![Vec::new(); waypoint_count];
    for mask in masks {
        let Some(allowed) = by_via.get_mut(mask.waypoint_index) else {
            continue;
        };
        for source_index in &mask.obstacle_indices {
            let resolved = match source_index.checked_sub(base_to_normalized.len()) {
                None => base_to_normalized.get(*source_index).copied().flatten(),
                Some(suffix_index) => suffix_to_normalized.get(suffix_index).copied().flatten(),
            };
            if let Some(index) = resolved {
                if !allowed.contains(&index) {
                    allowed.push(index);
                }
            }
        }
    }
    let mut by_leg = vec![Vec::new(); waypoint_count + 1];
    for (via_index, indexes) in by_via.iter().enumerate() {
        for leg_index in [via_index, via_index + 1] {
            for index in indexes {
                if !by_leg[leg_index].contains(index) {
                    by_leg[leg_index].push(*index);
                }
            }
        }
    }
    (by_via, by_leg)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(x: Coord, y: Coord) -> GeometryPoint {
        GeometryPoint { x, y }
    }
    fn rect(x: Coord, y: Coord, width: Coord, height: Coord) -> GeometryBox {
        GeometryBox {
            x,
            y,
            width,
            height,
        }
    }
    fn assert_clear(route: &[GeometryPoint], obstacles: &[GeometryBox]) {
        let normalized = normalize(obstacles).unwrap();
        assert!(route
            .iter()
            .copied()
            .all(|point| point_clear(point, &normalized)));
        assert!(route
            .windows(2)
            .all(|segment| segment_clear(segment[0], segment[1], &normalized)));
    }

    #[test]
    fn cached_clearance_matches_scans_at_boundaries_and_with_endpoint_masks() {
        let obstacles = normalize(&[
            rect(-4, -3, 6, 5),
            rect(0, 0, 4, 6),
            rect(2, -4, 3, 7),
            rect(-1, 2, 4, 3),
            rect(0, 0, 0, 0),
        ])
        .unwrap();
        let axis: Vec<_> = (-6..=8).collect();
        for masked in [vec![], vec![0], vec![1, 3], vec![0, 1, 2, 3]] {
            let cache = ClearanceCache::build(&axis, &axis, &obstacles, &masked).unwrap();
            for x in -6..=7 {
                for y in -6..=8 {
                    let from = p(x, y);
                    assert_eq!(
                        cache.point_clear(from, &obstacles, &masked),
                        point_clear_except(from, &obstacles, &masked),
                        "point ({x}, {y}) masked {masked:?}"
                    );
                    for other in -6..=8 {
                        for to in [p(other, y), p(x, other), p(other, other)] {
                            assert_eq!(
                                cache.segment_clear(from, to, &obstacles, &masked),
                                segment_clear_except(from, to, &obstacles, &masked),
                                "segment ({x}, {y}) -> ({}, {}) masked {masked:?}",
                                to.x,
                                to.y
                            );
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn wide_obstacle_cache_fallback_preserves_clearance() {
        let obstacles = normalize(&[rect(-1, -1, 9000, 9000); 9]).unwrap();
        let axis: Vec<_> = (0..MAX_AXIS_COORDINATES as Coord).collect();
        // Nine unmasked boxes reach every axis coordinate, so their retained
        // product exceeds MAX_OBSTACLES and the cache must fall back to
        // scanning. Masking two of them keeps seven under the same ceiling and
        // retains them, so one obstacle set covers both lookups.
        for (masked, retained) in [(vec![], false), (vec![0, 1], true)] {
            let cache = ClearanceCache::build(&axis, &axis, &obstacles, &masked).unwrap();
            assert_eq!(cache.rows.retained, retained, "rows masked {masked:?}");
            assert_eq!(
                cache.columns.retained, retained,
                "columns masked {masked:?}"
            );
            for from in [p(-1, -1), p(0, 0), p(1, 4096), p(8191, 8191), p(8999, 8999)] {
                assert_eq!(
                    cache.point_clear(from, &obstacles, &masked),
                    point_clear_except(from, &obstacles, &masked),
                    "point ({}, {}) masked {masked:?}",
                    from.x,
                    from.y
                );
                for to in [p(from.x, 9000), p(9000, from.y)] {
                    assert_eq!(
                        cache.segment_clear(from, to, &obstacles, &masked),
                        segment_clear_except(from, to, &obstacles, &masked),
                        "segment ({}, {}) -> ({}, {}) masked {masked:?}",
                        from.x,
                        from.y,
                        to.x,
                        to.y
                    );
                }
            }
        }
    }

    #[test]
    fn wide_overlap_build_reaches_scanning_fallback_in_bounded_work() {
        // The counting pass's worst case: the largest obstacle set the cap
        // admits, each obstacle covering every axis slot. Counting one
        // increment per obstacle per slot would be 65,536 x 32,768, so only a
        // pass that reads the cap off its running total reaches the fallback.
        let axis: Vec<_> = (0..32_768).collect();
        let obstacles = normalize(&vec![rect(0, 0, 32_768, 32_768); MAX_OBSTACLES]).unwrap();
        let started = std::time::Instant::now();
        let candidates = AxisCandidates::build(&axis, &obstacles, &[], true).unwrap();
        let elapsed = started.elapsed();
        assert!(!candidates.retained, "wide overlap must scan per lookup");
        assert_eq!(
            candidates.candidates(16_384, &obstacles, &[], true).count(),
            obstacles.len(),
            "the fallback still sees every obstacle"
        );
        assert!(
            elapsed < std::time::Duration::from_secs(1),
            "the counting pass read the cap after {elapsed:?}"
        );
    }

    #[test]
    fn suffix_route_matches_a_from_scratch_planner() {
        // A route that appended a label keeps the scene's cached planner and
        // takes the label as a suffix. Every path it chooses must be the path a
        // planner built from both sets chooses, and must clear both sets. The
        // second suffix rect plugs the only corridor the base set leaves open,
        // so a search that ignored the suffix would return the base-only path.
        let base = [rect(-6, -12, 12, 10), rect(-6, 2, 12, 10)];
        let suffix = [rect(-2, -2, 4, 4), rect(-16, 10, 4, 4)];
        let mut full = base.to_vec();
        full.extend_from_slice(&suffix);
        let planner = RoutePlanner::new(&base).unwrap();
        let mut detours = 0;
        for start in [p(-16, 0), p(-20, -16), p(0, -20), p(18, 18), p(-20, 18)] {
            for end in [p(16, 0), p(20, 16), p(0, 20), p(-18, 18)] {
                let with_suffix = planner
                    .route_with_suffix(&suffix, start, end, &[], &[], MAX_SEARCH_STATES)
                    .map(|route| route.points)
                    .map_err(|error| error.code);
                let scratch = route_orthogonal(start, end, &full, &[]).map_err(|error| error.code);
                assert_eq!(
                    with_suffix, scratch,
                    "({}, {}) -> ({}, {})",
                    start.x, start.y, end.x, end.y
                );
                let points = with_suffix.expect("both planners agree above");
                assert_clear(&points, &full);
                if points.len() > 2 {
                    detours += 1;
                }
            }
        }
        assert!(detours > 0, "the sweep must force real detours");
        let with_suffix = planner
            .route_with_suffix(&suffix, p(-16, 0), p(16, 0), &[], &[], MAX_SEARCH_STATES)
            .expect("the corridor detour routes")
            .points;
        let base_only = planner
            .route(p(-16, 0), p(16, 0), &[], &[], MAX_SEARCH_STATES)
            .expect("the open corridor routes")
            .points;
        assert_ne!(
            with_suffix, base_only,
            "the suffix must change a path the base set alone leaves straight"
        );
        assert_clear(&with_suffix, &full);
    }

    #[test]
    fn suffix_mask_covers_an_obstacle_the_route_appended() {
        // A mask index past the base set names a suffix obstacle, so the route
        // must exempt it exactly as a planner over both sets does. Only the
        // suffix puts an anchor inside an obstacle here, so a route that ignored
        // the suffix would also succeed without the mask.
        let base = [rect(24, -40, 8, 80)];
        let suffix = [rect(-3, -3, 6, 6)];
        let mut full = base.to_vec();
        full.extend_from_slice(&suffix);
        let planner = RoutePlanner::new(&base).unwrap();
        let waypoints = [p(0, 0)];
        let masks = [EndpointObstacleMask {
            waypoint_index: 0,
            obstacle_indices: vec![base.len()],
        }];
        assert!(
            planner
                .route_with_suffix(
                    &suffix,
                    p(-20, 0),
                    p(20, 0),
                    &waypoints,
                    &[],
                    MAX_SEARCH_STATES,
                )
                .is_err(),
            "the waypoint lies inside the suffix and no mask exempts it"
        );
        // An endpoint anchor carries no mask, so it must read the suffix too.
        assert!(
            planner
                .route_with_suffix(&suffix, p(-20, 0), p(0, 0), &[], &[], MAX_SEARCH_STATES)
                .is_err(),
            "an endpoint inside the suffix is refused, not routed through"
        );
        let with_suffix = planner
            .route_with_suffix(
                &suffix,
                p(-20, 0),
                p(20, 0),
                &waypoints,
                &masks,
                MAX_SEARCH_STATES,
            )
            .map(|route| (route.points, route.waypoint_point_indices))
            .map_err(|error| error.code);
        let scratch =
            route_orthogonal_with_endpoint_masks(p(-20, 0), p(20, 0), &full, &waypoints, &masks)
                .map(|route| (route.points, route.waypoint_point_indices))
                .map_err(|error| error.code);
        assert_eq!(with_suffix, scratch);
        let (points, indices) = with_suffix.expect("both planners agree above");
        assert_eq!(indices, vec![1], "the waypoint is kept in the path");
        assert_eq!(points[1], p(0, 0), "the route reaches the masked waypoint");
    }

    #[test]
    fn routes_straight_and_one_bend_when_visible() {
        assert_eq!(
            route_orthogonal(p(0, 0), p(100, 0), &[], &[]).unwrap(),
            [p(0, 0), p(100, 0)]
        );
        assert_eq!(
            route_orthogonal(p(0, 0), p(100, 50), &[], &[]).unwrap(),
            [p(0, 0), p(0, 50), p(100, 50)]
        );
    }

    #[test]
    fn finds_a_real_detour_around_node_and_label_rectangles() {
        let obstacles = [rect(20, -10, 60, 20), rect(10, -30, 80, 15)];
        let route = route_orthogonal(p(0, 0), p(100, 0), &obstacles, &[]).unwrap();
        assert_eq!(route.first(), Some(&p(0, 0)));
        assert_eq!(route.last(), Some(&p(100, 0)));
        assert!(route.len() >= 4);
        assert_clear(&route, &obstacles);
    }

    #[test]
    fn routes_between_outside_ports_of_the_same_node() {
        let obstacles = [rect(20, 20, 60, 60)];
        let route = route_orthogonal(p(80, 50), p(50, 20), &obstacles, &[]).unwrap();
        assert_clear(&route, &obstacles);
        assert!(route.len() >= 3);
    }

    #[test]
    fn retains_even_collinear_mandatory_waypoints() {
        let route = route_orthogonal(p(0, 0), p(100, 0), &[], &[p(30, 0), p(60, 0)]).unwrap();
        assert_eq!(route, [p(0, 0), p(30, 0), p(60, 0), p(100, 0)]);
    }

    #[test]
    fn authored_via_can_enter_only_its_indexed_endpoint_mask() {
        let inflated = rect(75, -15, 40, 30);
        let mask = EndpointObstacleMask {
            waypoint_index: 0,
            obstacle_indices: vec![0],
        };
        let route = route_orthogonal_with_endpoint_masks(
            p(0, 0),
            p(120, 0),
            &[inflated],
            &[p(90, 0)],
            &[mask],
        )
        .unwrap();
        assert_eq!(route.points, [p(0, 0), p(90, 0), p(120, 0)]);
        assert_eq!(route.waypoint_point_indices, [1]);
    }

    #[test]
    fn endpoint_mask_is_limited_to_the_two_legs_incident_to_its_inside_via() {
        let endpoint = rect(40, 40, 40, 40);
        let mask = EndpointObstacleMask {
            waypoint_index: 0,
            obstacle_indices: vec![0],
        };
        let route = route_orthogonal_with_endpoint_masks(
            p(0, 60),
            p(0, 0),
            &[endpoint],
            &[p(60, 60), p(100, 60)],
            &[mask],
        )
        .unwrap();

        assert_eq!(route.waypoint_point_indices.len(), 2);
        let inside_via = route.waypoint_point_indices[0];
        let outside_via = route.waypoint_point_indices[1];
        let normalized = normalize(&[endpoint]).unwrap();
        assert!(
            route.points[..=inside_via]
                .windows(2)
                .any(|segment| { !segment_clear(segment[0], segment[1], &normalized) }),
            "an incident leg must be allowed to enter or leave its endpoint mask"
        );
        assert!(route.points[inside_via..=outside_via]
            .windows(2)
            .any(|segment| !segment_clear(segment[0], segment[1], &normalized)));
        assert!(
            route.points[outside_via..]
                .windows(2)
                .all(|segment| segment_clear(segment[0], segment[1], &normalized)),
            "outside-to-outside leg must keep the endpoint obstacle active: {:?}",
            route.points
        );
    }

    #[test]
    fn endpoint_mask_never_exempts_a_co_located_third_party_obstacle() {
        let inflated = rect(75, -15, 40, 30);
        let mask = EndpointObstacleMask {
            waypoint_index: 0,
            obstacle_indices: vec![0],
        };
        let error = route_orthogonal_with_endpoint_masks(
            p(0, 0),
            p(120, 0),
            &[inflated, inflated],
            &[p(90, 0)],
            &[mask],
        )
        .unwrap_err();
        assert_eq!(error.code, "document/route-blocked");
        assert!(error.message.contains("route anchor 1"));
    }

    #[test]
    fn refuses_blocked_anchors_and_invalid_bounds_with_cause_and_fix() {
        let error = route_orthogonal(p(0, 0), p(100, 0), &[rect(20, -10, 60, 20)], &[p(50, 0)])
            .unwrap_err();
        assert_eq!(error.code, "document/route-blocked");
        assert!(!error.message.is_empty() && !error.fix.is_empty());
        assert!(route_orthogonal(p(0, 0), p(1, 1), &[rect(Coord::MAX, 0, 1, 1)], &[]).is_err());
        assert!(route_orthogonal(p(0, 0), p(1, 1), &[rect(0, 0, -1, 1)], &[]).is_err());
    }

    #[test]
    fn refuses_a_closed_corridor_instead_of_crossing_a_wall() {
        let obstacles = [
            rect(-10, -10, 20, 5),
            rect(-10, 5, 20, 5),
            rect(-10, -10, 5, 20),
            rect(5, -10, 5, 20),
        ];
        let error = route_orthogonal(p(0, 0), p(20, 0), &obstacles, &[]).unwrap_err();
        assert_eq!(error.code, "document/route-blocked");
        assert!(error.message.contains("no orthogonal corridor"));
        let error = route_orthogonal(p(0, 0), p(20, 0), &[], &vec![p(1, 1); MAX_WAYPOINTS + 1])
            .unwrap_err();
        assert_eq!(error.code, "document/route-budget");
        assert!(!error.fix.is_empty());
    }

    #[test]
    fn routes_repeatably_independent_of_obstacle_order() {
        let obstacles = [
            rect(20, -10, 60, 20),
            rect(5, -25, 80, 10),
            rect(45, 25, 40, 10),
        ];
        let mut reversed = obstacles;
        reversed.reverse();
        let first = route_orthogonal(p(0, 0), p(100, 0), &obstacles, &[]).unwrap();
        assert_eq!(
            first,
            route_orthogonal(p(0, 0), p(100, 0), &obstacles, &[]).unwrap()
        );
        assert_eq!(
            first,
            route_orthogonal(p(0, 0), p(100, 0), &reversed, &[]).unwrap()
        );
    }

    #[test]
    fn explicit_search_budget_refuses_the_same_astar_detour_deterministically() {
        // A horizontal obstacle blocks the direct segment and both degenerate
        // one-bend candidates; the valid detour must enter the A* grid.
        let obstacles = [rect(20, -10, 60, 20)];
        let first =
            route_orthogonal_with_budget(p(0, 0), p(100, 0), &obstacles, &[], 1).unwrap_err();
        let second =
            route_orthogonal_with_budget(p(0, 0), p(100, 0), &obstacles, &[], 1).unwrap_err();
        assert_eq!(first, second);
        assert_eq!(first.code, "document/route-budget");
        assert!(!first.message.is_empty() && !first.fix.is_empty());
        assert_clear(
            &route_orthogonal(p(0, 0), p(100, 0), &obstacles, &[]).unwrap(),
            &obstacles,
        );
    }

    #[test]
    fn visible_fast_paths_do_not_spend_the_astar_budget() {
        assert_eq!(
            route_orthogonal_with_budget(p(0, 0), p(100, 0), &[], &[], 0).unwrap(),
            [p(0, 0), p(100, 0)]
        );
        assert_eq!(
            route_orthogonal_with_budget(p(0, 0), p(100, 50), &[], &[], 0).unwrap(),
            [p(0, 0), p(0, 50), p(100, 50)]
        );
    }

    #[test]
    fn integer_extremes_do_not_overflow_distance_or_outer_axes() {
        let route = route_orthogonal(p(Coord::MIN, 0), p(Coord::MAX, 0), &[], &[]).unwrap();
        assert_eq!(route, [p(Coord::MIN, 0), p(Coord::MAX, 0)]);
        assert_clear(&route, &[]);
    }
}
