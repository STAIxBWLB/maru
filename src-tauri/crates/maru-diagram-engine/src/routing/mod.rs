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
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};

const BEND_COST: i64 = 16 * 64;
const MAX_AXIS_COORDINATES: usize = 8192;
const MAX_SEARCH_STATES: usize = 131_072;
const MAX_WAYPOINTS: usize = 4096;
const MAX_OBSTACLES: usize = 65_536;
const MAX_QUEUED_STATES: usize = 4 * MAX_SEARCH_STATES;

/// An endpoint's node/label mask may contain this authored via anchor. The
/// obstacle indexes are exempt only on the two route legs incident to it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EndpointObstacleMask {
    pub owner_id: String,
    pub waypoint_index: usize,
    pub obstacle_indices: Vec<usize>,
}

/// A routed path retains the leg owning each segment and the output index of
/// every mandatory waypoint. Layout uses these to keep endpoint exemptions
/// local to the legs that actually touch an authorized via anchor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MaskedRoute {
    pub points: Vec<GeometryPoint>,
    pub segment_legs: Vec<usize>,
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

fn add_outer_axis(axis: &mut Vec<Coord>) {
    if let Some(minimum) = axis.iter().copied().min().and_then(|n| n.checked_sub(1)) {
        axis.push(minimum);
    }
    if let Some(maximum) = axis.iter().copied().max().and_then(|n| n.checked_add(1)) {
        axis.push(maximum);
    }
    axis.sort_unstable();
    axis.dedup();
}

fn search_leg(
    start: GeometryPoint,
    end: GeometryPoint,
    obstacles: &[Rect],
    masked_obstacle_indices: &[usize],
    max_search_states: usize,
) -> Result<Vec<GeometryPoint>, Diagnostic> {
    if start == end {
        return Ok(vec![start]);
    }
    if segment_clear_except(start, end, obstacles, masked_obstacle_indices) {
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
        if point_clear_except(corner, obstacles, masked_obstacle_indices)
            && segment_clear_except(start, corner, obstacles, masked_obstacle_indices)
            && segment_clear_except(corner, end, obstacles, masked_obstacle_indices)
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
    let mut xs = vec![start.x, end.x];
    let mut ys = vec![start.y, end.y];
    let capacity = obstacles
        .len()
        .checked_mul(2)
        .and_then(|n| n.checked_add(2))
        .ok_or_else(budget)?;
    xs.try_reserve(capacity).map_err(|_| budget())?;
    ys.try_reserve(capacity).map_err(|_| budget())?;
    for rect in obstacles {
        xs.extend([rect.left, rect.right]);
        ys.extend([rect.top, rect.bottom]);
    }
    add_outer_axis(&mut xs);
    add_outer_axis(&mut ys);
    if xs.len() > MAX_AXIS_COORDINATES || ys.len() > MAX_AXIS_COORDINATES {
        return Err(budget());
    }
    // Both coordinates were inserted above, so these searches cannot fail.
    let initial = State {
        x: xs.binary_search(&start.x).map_err(|_| budget())?,
        y: ys.binary_search(&start.y).map_err(|_| budget())?,
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
        if !masked_obstacle_indices.is_empty() {
            crate::work::record_masked_astar_expansion();
        }
        let point = GeometryPoint {
            x: xs[state.x],
            y: ys[state.y],
        };
        if point == end {
            let mut path = Vec::new();
            let mut cursor = Some(state);
            while let Some(item) = cursor {
                path.push(GeometryPoint {
                    x: xs[item.x],
                    y: ys[item.y],
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
            (state.x + 1 < xs.len()).then_some(State {
                x: state.x + 1,
                y: state.y,
                axis: 0,
            }),
            state.y.checked_sub(1).map(|y| State {
                x: state.x,
                y,
                axis: 1,
            }),
            (state.y + 1 < ys.len()).then_some(State {
                x: state.x,
                y: state.y + 1,
                axis: 1,
            }),
        ];
        for next in candidates.into_iter().flatten() {
            let target = GeometryPoint {
                x: xs[next.x],
                y: ys[next.y],
            };
            if !point_clear_except(target, obstacles, masked_obstacle_indices)
                || !segment_clear_except(point, target, obstacles, masked_obstacle_indices)
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
    if waypoints.len() > MAX_WAYPOINTS {
        return Err(budget());
    }
    let raw_obstacles = obstacles;
    let obstacles = normalize(raw_obstacles)?;
    let source_to_normalized = if endpoint_masks.is_empty() {
        Vec::new()
    } else {
        normalized_obstacle_indexes(raw_obstacles)
    };
    let (via_masked_indexes, leg_masked_indexes) =
        endpoint_mask_indexes(endpoint_masks, &source_to_normalized, waypoints.len());
    if !point_clear(start, &obstacles) {
        return Err(diagnostic(
            "blocked",
            "route anchor 0 lies inside a node or label obstacle",
            "move the port or authored waypoint outside all node and label bounds",
        ));
    }
    for (index, anchor) in waypoints.iter().enumerate() {
        if !point_clear_except(*anchor, &obstacles, &via_masked_indexes[index]) {
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
    if !point_clear(end, &obstacles) {
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
    let mut segment_legs = Vec::new();
    let mut waypoint_point_indices = Vec::with_capacity(waypoints.len());
    let mut previous = start;
    for (leg_index, target) in waypoints
        .iter()
        .copied()
        .chain(std::iter::once(end))
        .enumerate()
    {
        let leg_masks = leg_masked_indexes
            .get(leg_index)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let leg = search_leg(previous, target, &obstacles, leg_masks, max_search_states)?;
        if route.is_empty() {
            route.extend(leg.iter().copied());
            segment_legs.extend(std::iter::repeat_n(leg_index, leg.len().saturating_sub(1)));
        } else {
            for point in leg.into_iter().skip(1) {
                if route.last() != Some(&point) {
                    route.push(point);
                    segment_legs.push(leg_index);
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
        segment_legs,
        waypoint_point_indices,
    })
}

fn normalized_obstacle_indexes(source: &[GeometryBox]) -> Vec<Option<usize>> {
    // normalize omits zero-area boxes, retaining the source order of every
    // painted obstacle. The caller-provided indexes refer to that source list.
    let mut next = 0;
    source
        .iter()
        .map(|bounds| {
            if bounds.width == 0 || bounds.height == 0 {
                None
            } else {
                let index = next;
                next += 1;
                Some(index)
            }
        })
        .collect()
}

fn endpoint_mask_indexes(
    masks: &[EndpointObstacleMask],
    source_to_normalized: &[Option<usize>],
    waypoint_count: usize,
) -> (Vec<Vec<usize>>, Vec<Vec<usize>>) {
    let mut by_via = vec![Vec::new(); waypoint_count];
    for mask in masks {
        let Some(allowed) = by_via.get_mut(mask.waypoint_index) else {
            continue;
        };
        for source_index in &mask.obstacle_indices {
            if let Some(Some(index)) = source_to_normalized.get(*source_index) {
                if !allowed.contains(index) {
                    allowed.push(*index);
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
            owner_id: "target".into(),
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
        assert_eq!(route.segment_legs, [0, 1]);
        assert_eq!(route.waypoint_point_indices, [1]);
    }

    #[test]
    fn endpoint_mask_is_limited_to_the_two_legs_incident_to_its_inside_via() {
        let endpoint = rect(40, 40, 40, 40);
        let mask = EndpointObstacleMask {
            owner_id: "source".into(),
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
        assert_eq!(route.segment_legs.len(), route.points.len() - 1);
        let normalized = normalize(&[endpoint]).unwrap();
        assert!(
            route
                .segment_legs
                .iter()
                .enumerate()
                .filter(|(_, leg)| **leg < 2)
                .any(|(index, _)| {
                    !segment_clear(route.points[index], route.points[index + 1], &normalized)
                }),
            "an incident leg must be allowed to enter or leave its endpoint mask"
        );
        for (index, leg) in route.segment_legs.iter().enumerate() {
            if *leg == 2 {
                assert!(
                    segment_clear(route.points[index], route.points[index + 1], &normalized),
                    "outside-to-outside leg must keep the endpoint obstacle active: {:?}",
                    route.points
                );
            }
        }
    }

    #[test]
    fn endpoint_mask_never_exempts_a_co_located_third_party_obstacle() {
        let inflated = rect(75, -15, 40, 30);
        let mask = EndpointObstacleMask {
            owner_id: "target".into(),
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
