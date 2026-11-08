//! Complete family-specific routing intent resolution, before obstacle routing.
//! Generated channels use checked fixed-point coordinates. Authored channels
//! bypass their generated counterpart; authored sides are applied by the caller.

use crate::geometry::GeometryBox;
use crate::layout::fixed::Coord;
use crate::routing::RouteRequest;
use crate::Diagnostic;

const Q16: i64 = 65_536;
const CHANNEL_PADDING: Coord = 32 * 64;
const PORT_EXTRA_ESCAPE: Coord = 6 * 64;
const VERTICAL_CHANNEL_OFFSET: Coord = 44 * 64;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Preset {
    pub from_side: Option<&'static str>,
    pub to_side: Option<&'static str>,
    pub channel_x: Option<Coord>,
    pub channel_y: Option<Coord>,
}

/// The E1 validators and this resolver share the same accepted vocabulary.
/// Sequence messages do not accept a route-preset field.
pub(crate) fn accepted(kind: &str) -> Option<&'static [&'static str]> {
    match kind {
        "architecture" => Some(crate::architecture::ARCHITECTURE_ROUTES),
        "workflow" => Some(crate::workflow::WORKFLOW_ROUTES),
        "dataflow" => Some(crate::dataflow::ROUTES),
        "lifecycle" => Some(crate::lifecycle::LIFECYCLE_ROUTES),
        "sequence" => Some(&[]),
        _ => None,
    }
}

fn diagnostic(
    kind: &str,
    r: &RouteRequest,
    suffix: &str,
    cause: impl Into<String>,
    fix: &str,
) -> Diagnostic {
    let collection = match kind {
        "architecture" => "connections",
        "workflow" => "edges",
        "dataflow" => "flows",
        "lifecycle" => "transitions",
        "sequence" => "messages",
        _ => "routes",
    };
    let namespace = if accepted(kind).is_some() {
        kind
    } else {
        "document"
    };
    Diagnostic {
        code: format!("{namespace}/route-{suffix}"),
        path: format!(
            "/{collection}/{}/{}",
            r.source_index,
            if suffix == "bias" { "bias" } else { "route" }
        ),
        rule: format!("{namespace}-routing-v1/{suffix}"),
        message: cause.into(),
        fix: fix.into(),
    }
}
fn range_error(kind: &str, r: &RouteRequest) -> Diagnostic {
    diagnostic(kind, r, "range", "generated routing channel exceeds the fixed-point coordinate range", "move or shrink the endpoints, or provide an explicit channel inside signed 32-bit fixed-point bounds")
}
fn add(kind: &str, r: &RouteRequest, a: Coord, b: Coord) -> Result<Coord, Diagnostic> {
    a.checked_add(b).ok_or_else(|| range_error(kind, r))
}
fn channel_padding(kind: &str, r: &RouteRequest, clearance: Coord) -> Result<Coord, Diagnostic> {
    add(kind, r, clearance, CHANNEL_PADDING)
}
fn subtract(kind: &str, r: &RouteRequest, a: Coord, b: Coord) -> Result<Coord, Diagnostic> {
    a.checked_sub(b).ok_or_else(|| range_error(kind, r))
}
#[derive(Clone, Copy)]
struct Bounds {
    left: Coord,
    top: Coord,
    right: Coord,
    bottom: Coord,
    center_x: i64,
    center_y: i64,
}
fn bounds(kind: &str, r: &RouteRequest, b: GeometryBox) -> Result<Bounds, Diagnostic> {
    if b.width < 0 || b.height < 0 {
        return Err(diagnostic(
            kind,
            r,
            "bounds",
            "route endpoint has a negative box dimension",
            "restore nonnegative endpoint bounds before resolving the routing preset",
        ));
    }
    Ok(Bounds {
        left: b.x,
        top: b.y,
        right: add(kind, r, b.x, b.width)?,
        bottom: add(kind, r, b.y, b.height)?,
        center_x: i64::from(b.x) + i64::from(b.width) / 2,
        center_y: i64::from(b.y) + i64::from(b.height) / 2,
    })
}
fn interpolate(
    kind: &str,
    r: &RouteRequest,
    from: Coord,
    to: Coord,
    bias: f64,
) -> Result<Coord, Diagnostic> {
    if !bias.is_finite() || !(0.0..=1.0).contains(&bias) {
        return Err(diagnostic(
            kind,
            r,
            "bias",
            "drop bias must be finite and between 0 and 1",
            "set workflow bias to a value from 0 to 1, or omit it for the midpoint",
        ));
    }
    // Quantize the unitless bias once. Weighted sums stay in i64 and round only
    // once, retaining exact endpoints and half-away ties in either direction.
    let q = (bias * Q16 as f64).round() as i64;
    let weighted = i64::from(from)
        .checked_mul(Q16 - q)
        .and_then(|a| i64::from(to).checked_mul(q).and_then(|b| a.checked_add(b)))
        .ok_or_else(|| range_error(kind, r))?;
    let rounded = if weighted >= 0 {
        weighted
            .checked_add(Q16 / 2)
            .ok_or_else(|| range_error(kind, r))?
            / Q16
    } else {
        -weighted
            .checked_neg()
            .and_then(|a| a.checked_add(Q16 / 2))
            .ok_or_else(|| range_error(kind, r))?
            / Q16
    };
    Coord::try_from(rounded).map_err(|_| range_error(kind, r))
}
fn horizontal(from: Bounds, to: Bounds) -> (&'static str, &'static str) {
    if to.center_x >= from.center_x {
        ("right", "left")
    } else {
        ("left", "right")
    }
}
fn vertical(from: Bounds, to: Bounds) -> (&'static str, &'static str) {
    if to.center_y >= from.center_y {
        ("bottom", "top")
    } else {
        ("top", "bottom")
    }
}
fn effective_port_x(
    kind: &str,
    r: &RouteRequest,
    b: Bounds,
    side: &str,
    escape: Coord,
) -> Result<Coord, Diagnostic> {
    match side {
        "left" => subtract(kind, r, b.left, escape),
        "right" => add(kind, r, b.right, escape),
        "top" | "bottom" => Coord::try_from(b.center_x).map_err(|_| range_error(kind, r)),
        _ => Err(diagnostic(
            kind,
            r,
            "side",
            "authored route side is not left, right, top or bottom",
            "choose one of the four supported endpoint sides",
        )),
    }
}

fn effective_port_y(
    kind: &str,
    r: &RouteRequest,
    b: Bounds,
    side: &str,
    escape: Coord,
    authored_y: Option<Coord>,
) -> Result<Coord, Diagnostic> {
    if let Some(y) = authored_y {
        return Ok(y);
    }
    match side {
        "top" => subtract(kind, r, b.top, escape),
        "bottom" => add(kind, r, b.bottom, escape),
        "left" | "right" => Coord::try_from(b.center_y).map_err(|_| range_error(kind, r)),
        _ => Err(diagnostic(
            kind,
            r,
            "side",
            "authored route side is not left, right, top or bottom",
            "choose one of the four supported endpoint sides",
        )),
    }
}
fn midpoint(kind: &str, r: &RouteRequest, from: Coord, to: Coord) -> Result<Coord, Diagnostic> {
    crate::layout::fixed::checked_midpoint(from, to).map_err(|_| range_error(kind, r))
}

/// Resolve the named intent only. Obstacle avoidance still routes through these
/// channels, and caller-provided side strings take precedence over side defaults.
pub(crate) fn resolve(
    kind: &str,
    r: &RouteRequest,
    from: GeometryBox,
    to: GeometryBox,
    scene_bounds: GeometryBox,
    clearance: Coord,
) -> Result<Preset, Diagnostic> {
    let vocabulary = accepted(kind).ok_or_else(|| {
        diagnostic(
            kind,
            r,
            "preset",
            "diagram type has no routing preset resolver",
            "use a supported diagram type before resolving routes",
        )
    })?;
    let mut result = Preset {
        from_side: None,
        to_side: None,
        channel_x: r.channel_x,
        channel_y: r.channel_y,
    };
    let Some(route) = r.route.as_deref() else {
        return Ok(result);
    };
    if !vocabulary.contains(&route) {
        return Err(diagnostic(
            kind,
            r,
            "preset",
            format!("routing preset {route:?} is not accepted for {kind}"),
            "choose a route from this diagram type's documented preset list",
        ));
    }
    if route == "auto" || route == "straight" {
        return Ok(result);
    }
    if clearance < 0 {
        return Err(diagnostic(
            kind,
            r,
            "clearance",
            "routing clearance cannot be negative",
            "use a nonnegative fixed-point clearance before resolving presets",
        ));
    }
    let a = bounds(kind, r, from)?;
    let b = bounds(kind, r, to)?;
    let sides = match route {
        "orthogonal-h" | "vertical-channel" => horizontal(a, b),
        "orthogonal-v" | "drop" => vertical(a, b),
        "outside-right" | "right-channel" => ("right", "right"),
        "return-left" | "left-channel" => ("left", "left"),
        "bottom-channel" => ("bottom", "bottom"),
        "top-channel" | "up-channel" => ("top", "top"),
        // The validator vocabulary above is shared, so this guards future additions.
        _ => {
            return Err(diagnostic(
                kind,
                r,
                "preset",
                format!("accepted routing preset {route:?} has no geometric implementation"),
                "implement its channel and side intent before accepting it in the validator",
            ))
        }
    };
    result.from_side = Some(sides.0);
    result.to_side = Some(sides.1);
    // Explicit via points own traversal. Preserve named side intent but never
    // compute a channel which the caller will discard (including its overflow).
    if !r.waypoints.is_empty() {
        return Ok(result);
    }
    match route {
        "orthogonal-h" if result.channel_x.is_none() => {
            let escape = add(kind, r, clearance, PORT_EXTRA_ESCAPE)?;
            let start_x = effective_port_x(
                kind,
                r,
                a,
                r.from_side.as_deref().unwrap_or(sides.0),
                escape,
            )?;
            let end_x =
                effective_port_x(kind, r, b, r.to_side.as_deref().unwrap_or(sides.1), escape)?;
            result.channel_x = Some(midpoint(kind, r, start_x, end_x)?);
        }
        "orthogonal-v" if result.channel_y.is_none() => {
            let escape = add(kind, r, clearance, PORT_EXTRA_ESCAPE)?;
            let start_y = effective_port_y(
                kind,
                r,
                a,
                r.from_side.as_deref().unwrap_or(sides.0),
                escape,
                r.from_y,
            )?;
            let end_y = effective_port_y(
                kind,
                r,
                b,
                r.to_side.as_deref().unwrap_or(sides.1),
                escape,
                r.to_y,
            )?;
            result.channel_y = Some(midpoint(kind, r, start_y, end_y)?);
        }
        "outside-right" if result.channel_x.is_none() => {
            let right = add(kind, r, scene_bounds.x, scene_bounds.width)?
                .max(a.right)
                .max(b.right);
            result.channel_x = Some(add(kind, r, right, channel_padding(kind, r, clearance)?)?);
        }
        "return-left" | "left-channel" if result.channel_x.is_none() => {
            result.channel_x = Some(subtract(
                kind,
                r,
                a.left.min(b.left),
                channel_padding(kind, r, clearance)?,
            )?)
        }
        "right-channel" if result.channel_x.is_none() => {
            result.channel_x = Some(add(
                kind,
                r,
                a.right.max(b.right),
                channel_padding(kind, r, clearance)?,
            )?)
        }
        "bottom-channel" if result.channel_y.is_none() => {
            result.channel_y = Some(add(
                kind,
                r,
                a.bottom.max(b.bottom),
                channel_padding(kind, r, clearance)?,
            )?)
        }
        "top-channel" | "up-channel" if result.channel_y.is_none() => {
            result.channel_y = Some(subtract(
                kind,
                r,
                a.top.min(b.top),
                channel_padding(kind, r, clearance)?,
            )?)
        }
        "vertical-channel" if result.channel_x.is_none() => {
            let escape = add(kind, r, clearance, PORT_EXTRA_ESCAPE)?;
            let start_x = effective_port_x(
                kind,
                r,
                a,
                r.from_side.as_deref().unwrap_or(sides.0),
                escape,
            )?;
            let end_x =
                effective_port_x(kind, r, b, r.to_side.as_deref().unwrap_or(sides.1), escape)?;
            result.channel_x = Some(if end_x >= start_x {
                add(kind, r, start_x, VERTICAL_CHANNEL_OFFSET)?
            } else {
                subtract(kind, r, start_x, VERTICAL_CHANNEL_OFFSET)?
            });
        }
        "drop" if result.channel_y.is_none() => {
            let bias = if kind == "workflow" {
                r.bias.unwrap_or(0.5)
            } else {
                0.5
            };
            let escape = add(kind, r, clearance, PORT_EXTRA_ESCAPE)?;
            let gap = if a.bottom <= b.top {
                let low = add(kind, r, a.bottom, escape)?;
                let high = subtract(kind, r, b.top, escape)?;
                (low <= high).then_some((low, high))
            } else if b.bottom <= a.top {
                let high = subtract(kind, r, a.top, escape)?;
                let low = add(kind, r, b.bottom, escape)?;
                (low <= high).then_some((high, low))
            } else {
                None
            };
            if let Some((source_border, target_border)) = gap {
                result.channel_y = Some(interpolate(kind, r, source_border, target_border, bias)?);
            } else {
                // Overlapping vertical spans have no inter-box corridor. A
                // concrete bottom detour preserves drop intent without auto.
                result.from_side = Some("bottom");
                result.to_side = Some("bottom");
                result.channel_y = Some(add(
                    kind,
                    r,
                    a.bottom.max(b.bottom),
                    channel_padding(kind, r, clearance)?,
                )?);
            }
        }
        _ => {}
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn box_px(x: Coord, y: Coord, width: Coord, height: Coord) -> GeometryBox {
        GeometryBox {
            x: x * 64,
            y: y * 64,
            width: width * 64,
            height: height * 64,
        }
    }
    fn request(route: &str) -> RouteRequest {
        RouteRequest {
            route: Some(route.into()),
            ..Default::default()
        }
    }
    fn scene() -> GeometryBox {
        box_px(0, 0, 1000, 800)
    }

    #[test]
    fn every_validator_accepted_preset_has_concrete_intent_in_both_directions() {
        let a = box_px(100, 100, 80, 60);
        let b = box_px(500, 400, 80, 60);
        for kind in ["architecture", "workflow", "dataflow", "lifecycle"] {
            for route in accepted(kind).unwrap() {
                for (from, to) in [(a, b), (b, a)] {
                    let result = resolve(kind, &request(route), from, to, scene(), 4 * 64).unwrap();
                    if *route == "auto" || *route == "straight" {
                        assert_eq!(result, Preset::default());
                        continue;
                    }
                    assert!(
                        result.from_side.is_some() && result.to_side.is_some(),
                        "{kind}/{route}"
                    );
                    assert!(
                        result.channel_x.is_some() || result.channel_y.is_some(),
                        "{kind}/{route}"
                    );
                }
            }
        }
    }

    #[test]
    fn channel_presets_use_the_named_sides_and_correct_pair_or_scene_extents() {
        let a = box_px(100, 100, 80, 60);
        let b = box_px(500, 400, 80, 60);
        for (kind, name, sides, x, y) in [
            (
                "workflow",
                "outside-right",
                ("right", "right"),
                Some(1036 * 64),
                None,
            ),
            (
                "workflow",
                "return-left",
                ("left", "left"),
                Some(64 * 64),
                None,
            ),
            (
                "workflow",
                "up-channel",
                ("top", "top"),
                None,
                Some(64 * 64),
            ),
            (
                "workflow",
                "bottom-channel",
                ("bottom", "bottom"),
                None,
                Some(496 * 64),
            ),
            (
                "dataflow",
                "bottom-channel",
                ("bottom", "bottom"),
                None,
                Some(496 * 64),
            ),
            (
                "dataflow",
                "top-channel",
                ("top", "top"),
                None,
                Some(64 * 64),
            ),
            (
                "lifecycle",
                "bottom-channel",
                ("bottom", "bottom"),
                None,
                Some(496 * 64),
            ),
            (
                "lifecycle",
                "top-channel",
                ("top", "top"),
                None,
                Some(64 * 64),
            ),
            (
                "lifecycle",
                "right-channel",
                ("right", "right"),
                Some(616 * 64),
                None,
            ),
            (
                "lifecycle",
                "left-channel",
                ("left", "left"),
                Some(64 * 64),
                None,
            ),
        ] {
            for (from, to) in [(a, b), (b, a)] {
                let result = resolve(kind, &request(name), from, to, scene(), 4 * 64).unwrap();
                assert_eq!(
                    (result.from_side, result.to_side),
                    (Some(sides.0), Some(sides.1)),
                    "{kind}/{name}"
                );
                assert_eq!(
                    (result.channel_x, result.channel_y),
                    (x, y),
                    "{kind}/{name}"
                );
            }
        }
    }

    #[test]
    fn drop_bias_interpolates_clear_inter_lane_borders_from_source_to_target() {
        let a = box_px(100, 100, 80, 60);
        let b = box_px(500, 400, 80, 60);
        for (bias, forward, reverse) in [(0.0, 170, 390), (0.5, 280, 280), (1.0, 390, 170)] {
            let r = RouteRequest {
                bias: Some(bias),
                ..request("drop")
            };
            let forward_result = resolve("workflow", &r, a, b, scene(), 4 * 64).unwrap();
            let reverse_result = resolve("workflow", &r, b, a, scene(), 4 * 64).unwrap();
            assert_eq!(forward_result.channel_y, Some(forward * 64));
            assert_eq!(reverse_result.channel_y, Some(reverse * 64));
            assert_eq!(
                (forward_result.from_side, forward_result.to_side),
                (Some("bottom"), Some("top"))
            );
            assert_eq!(
                (reverse_result.from_side, reverse_result.to_side),
                (Some("top"), Some("bottom"))
            );
        }
        let lifecycle = resolve(
            "lifecycle",
            &RouteRequest {
                bias: Some(0.0),
                ..request("drop")
            },
            a,
            b,
            scene(),
            4 * 64,
        )
        .unwrap();
        assert_eq!(lifecycle.channel_y, Some(280 * 64));
    }

    #[test]
    fn q16_drop_interpolation_rounds_once_and_handles_full_coordinate_span() {
        let r = request("drop");
        assert_eq!(interpolate("workflow", &r, -2, 1, 0.5).unwrap(), -1);
        assert_eq!(interpolate("workflow", &r, 1, -2, 0.5).unwrap(), -1);
        assert_eq!(
            interpolate("workflow", &r, Coord::MIN, Coord::MAX, 0.5).unwrap(),
            -1
        );
        assert_eq!(
            interpolate("workflow", &r, Coord::MIN, Coord::MAX, 0.0).unwrap(),
            Coord::MIN
        );
        assert_eq!(
            interpolate("workflow", &r, Coord::MIN, Coord::MAX, 1.0).unwrap(),
            Coord::MAX
        );
    }

    #[test]
    fn horizontal_vertical_and_source_escape_presets_honor_direction() {
        let a = box_px(100, 100, 80, 60);
        let b = box_px(500, 400, 80, 60);
        for (from, to, h, v, cx) in [
            (a, b, ("right", "left"), ("bottom", "top"), 234),
            (b, a, ("left", "right"), ("top", "bottom"), 446),
        ] {
            let horizontal = resolve(
                "architecture",
                &request("orthogonal-h"),
                from,
                to,
                scene(),
                4 * 64,
            )
            .unwrap();
            let vertical = resolve(
                "architecture",
                &request("orthogonal-v"),
                from,
                to,
                scene(),
                4 * 64,
            )
            .unwrap();
            let channel = resolve(
                "dataflow",
                &request("vertical-channel"),
                from,
                to,
                scene(),
                4 * 64,
            )
            .unwrap();
            assert_eq!(
                (horizontal.from_side, horizontal.to_side),
                (Some(h.0), Some(h.1))
            );
            assert_eq!(
                (vertical.from_side, vertical.to_side),
                (Some(v.0), Some(v.1))
            );
            assert_eq!((channel.from_side, channel.to_side), (Some(h.0), Some(h.1)));
            assert_eq!(channel.channel_x, Some(cx * 64));
            assert_eq!(horizontal.channel_x, Some(340 * 64));
            assert_eq!(vertical.channel_y, Some(280 * 64));
        }
    }

    #[test]
    fn orthogonal_midpoints_use_effective_authored_ports() {
        let a = box_px(100, 100, 80, 60);
        let b = box_px(500, 400, 80, 60);
        let horizontal = resolve(
            "architecture",
            &RouteRequest {
                from_side: Some("left".into()),
                to_side: Some("left".into()),
                ..request("orthogonal-h")
            },
            a,
            b,
            scene(),
            4 * 64,
        )
        .unwrap();
        assert_eq!(horizontal.channel_x, Some(290 * 64));
        let vertical = resolve(
            "architecture",
            &RouteRequest {
                from_side: Some("top".into()),
                to_side: Some("top".into()),
                ..request("orthogonal-v")
            },
            a,
            b,
            scene(),
            4 * 64,
        )
        .unwrap();
        assert_eq!(vertical.channel_y, Some(240 * 64));
    }

    #[test]
    fn authored_channels_and_caller_side_precedence_survive_every_preset() {
        let a = box_px(100, 100, 80, 60);
        let b = box_px(500, 400, 80, 60);
        for kind in ["architecture", "workflow", "dataflow", "lifecycle"] {
            for name in accepted(kind).unwrap() {
                let r = RouteRequest {
                    from_side: Some("top".into()),
                    to_side: Some("bottom".into()),
                    channel_x: Some(-256),
                    channel_y: Some(512),
                    ..request(name)
                };
                let result = resolve(kind, &r, a, b, scene(), 4 * 64).unwrap();
                assert_eq!(
                    (result.channel_x, result.channel_y),
                    (r.channel_x, r.channel_y)
                );
                assert_eq!(r.from_side.as_deref().or(result.from_side), Some("top"));
                assert_eq!(r.to_side.as_deref().or(result.to_side), Some("bottom"));
            }
        }
        let near_limit = GeometryBox {
            x: Coord::MAX - 64,
            y: 0,
            width: 64,
            height: 64,
        };
        let r = RouteRequest {
            channel_x: Some(0),
            ..request("outside-right")
        };
        assert_eq!(
            resolve("workflow", &r, a, b, near_limit, 4 * 64)
                .unwrap()
                .channel_x,
            Some(0)
        );
        assert!(resolve(
            "workflow",
            &request("outside-right"),
            a,
            b,
            near_limit,
            4 * 64
        )
        .is_err());
    }

    #[test]
    fn authored_via_skips_discarded_channel_generation_and_preserves_side_intent() {
        let a = box_px(100, 100, 80, 60);
        let b = box_px(500, 400, 80, 60);
        let near_limit = GeometryBox {
            x: Coord::MAX - 64,
            y: 0,
            width: 64,
            height: 64,
        };
        let r = RouteRequest {
            waypoints: vec![crate::geometry::GeometryPoint { x: 0, y: 0 }],
            ..request("outside-right")
        };
        let preset = resolve("workflow", &r, a, b, near_limit, 4 * 64).unwrap();
        assert_eq!(
            (preset.from_side, preset.to_side),
            (Some("right"), Some("right"))
        );
        assert_eq!((preset.channel_x, preset.channel_y), (None, None));
    }

    #[test]
    fn overlapping_drop_spans_have_a_concrete_bottom_detour() {
        let a = box_px(100, 100, 80, 60);
        let b = box_px(500, 100, 80, 60);
        for (from, to) in [(a, b), (b, a)] {
            let preset = resolve("workflow", &request("drop"), from, to, scene(), 4 * 64).unwrap();
            assert_eq!(
                (preset.from_side, preset.to_side),
                (Some("bottom"), Some("bottom"))
            );
            assert_eq!(preset.channel_y, Some(196 * 64));
        }
    }

    #[test]
    fn unsupported_presets_and_invalid_bias_are_explicit_refusals() {
        let a = box_px(100, 100, 80, 60);
        let b = box_px(500, 400, 80, 60);
        for kind in [
            "architecture",
            "workflow",
            "dataflow",
            "lifecycle",
            "sequence",
            "unknown",
        ] {
            let error = resolve(kind, &request("misspelled"), a, b, scene(), 4 * 64).unwrap_err();
            assert!(error.code.ends_with("/route-preset"));
            assert!(!error.message.is_empty() && !error.fix.is_empty());
        }
        assert_eq!(
            resolve("sequence", &RouteRequest::default(), a, b, scene(), 4 * 64).unwrap(),
            Preset::default()
        );
        for bias in [-1.0, 2.0, f64::NAN] {
            assert!(resolve(
                "workflow",
                &RouteRequest {
                    bias: Some(bias),
                    ..request("drop")
                },
                a,
                b,
                scene(),
                4 * 64
            )
            .is_err());
        }
    }
}
