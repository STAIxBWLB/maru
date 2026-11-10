//! Deterministic lifecycle lane/state placement and transition requests.

use crate::geometry::GeometryBox;
use crate::layout::{point, px, RouteRequest, SceneBuilder};
use crate::lifecycle::LifecycleSpec;
use crate::Diagnostic;

const PHASE_COLUMNS: [f64; 5] = [94.0, 248.0, 402.0, 556.0, 710.0];
const EVENT_COLUMNS: [f64; 3] = [402.0, 556.0, 710.0];
const PHASE_TOP: f64 = 126.0;
const EVENT_TOP: f64 = 278.0;
const OUTCOME_TOP: f64 = 450.0;
const V2_MARGIN_X: f64 = 60.0;
const V2_STATE_WIDTH: f64 = 140.0;
const V2_STATE_HEIGHT: f64 = 64.0;
const V2_MIN_GAP: f64 = 64.0;
const V2_FIRST_ROW_TOP: f64 = 56.0;
const V2_ROW_PITCH: f64 = 184.0;

fn geometry_error(path: &str, cause: impl Into<String>) -> Diagnostic {
    crate::diagnostic(
        "lifecycle/layout-range",
        path,
        "lifecycle-layout-v1/range",
        cause,
        "reduce authored lifecycle coordinates or dimensions to fit the fixed-point range",
    )
}

fn segment_index(value: Option<f64>, path: &str) -> Result<Option<usize>, Diagnostic> {
    let Some(value) = value else {
        return Ok(None);
    };
    if !value.is_finite() || value < 0.0 || value.fract() != 0.0 || value > f64::from(u32::MAX) {
        return Err(geometry_error(
            path,
            "label segment is not a representable nonnegative index",
        ));
    }
    Ok(Some(value as usize))
}

fn pixel_box(
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    path: &str,
) -> Result<GeometryBox, Diagnostic> {
    if width < 0.0 || height < 0.0 {
        return Err(geometry_error(
            path,
            "container dimensions cannot be negative",
        ));
    }
    let bounds = GeometryBox {
        x: px(x).map_err(|error| geometry_error(path, error.message))?,
        y: px(y).map_err(|error| geometry_error(path, error.message))?,
        width: px(width).map_err(|error| geometry_error(path, error.message))?,
        height: px(height).map_err(|error| geometry_error(path, error.message))?,
    };
    bounds
        .right()
        .and_then(|_| bounds.bottom())
        .map_err(|error| geometry_error(path, error.to_string()))?;
    Ok(bounds)
}

fn default_state_size(version: u32, lane: &str) -> (f64, f64) {
    if version == 2 {
        (V2_STATE_WIDTH, V2_STATE_HEIGHT)
    } else if lane == "main" {
        (118.0, 62.0)
    } else if lane == "terminal" {
        (118.0, 58.0)
    } else {
        (126.0, 58.0)
    }
}

fn lifecycle_row_order(spec: &LifecycleSpec) -> Vec<String> {
    let populated: std::collections::HashSet<_> = spec
        .states
        .iter()
        .map(|state| state.lane.as_str())
        .collect();
    let mut order = Vec::new();
    if populated.contains("main") {
        order.push("main".to_owned());
    }
    order.extend(
        spec.lanes
            .iter()
            .filter(|lane| lane.id != "main" && lane.id != "terminal")
            .filter(|lane| populated.contains(lane.id.as_str()))
            .map(|lane| lane.id.clone()),
    );
    if populated.contains("terminal") {
        order.push("terminal".to_owned());
    }
    order
}

fn lifecycle_v2_centers(spec: &LifecycleSpec) -> [f64; 5] {
    let mut widths = [V2_STATE_WIDTH; 5];
    for state in &spec.states {
        let column = state.col as usize;
        if column < widths.len() {
            widths[column] = widths[column].max(state.width.unwrap_or(0.0));
        }
    }
    let mut centers = [0.0; 5];
    let mut left = V2_MARGIN_X;
    for column in 0..centers.len() {
        centers[column] = left + widths[column] / 2.0;
        left += widths[column] + V2_MIN_GAP;
    }
    centers
}

fn state_position(
    spec: &LifecycleSpec,
    state: &crate::lifecycle::LifecycleState,
    row_order: &[String],
    centers: &[f64; 5],
) -> Option<(f64, f64)> {
    let version = spec.schema_version;
    let (width, _) = default_state_size(version, &state.lane);
    let width = state.width.unwrap_or(width);
    if version == 2 {
        let column = *centers.get(state.col as usize)?;
        let row = row_order.iter().position(|lane| lane == &state.lane)?;
        return Some((
            column - width / 2.0,
            V2_FIRST_ROW_TOP + row as f64 * V2_ROW_PITCH + state.y_offset.unwrap_or(0.0),
        ));
    }
    let columns = if state.lane == "main" {
        &PHASE_COLUMNS[..]
    } else {
        &EVENT_COLUMNS[..]
    };
    let center = columns.get(state.col as usize).or_else(|| columns.last())?;
    let top = if state.lane == "main" {
        PHASE_TOP
    } else if state.lane == "terminal" {
        OUTCOME_TOP
    } else {
        EVENT_TOP
    } + state.y_offset.unwrap_or(0.0);
    Some((*center - width / 2.0, top))
}

fn empty_lane_top(
    spec: &LifecycleSpec,
    lane: &crate::lifecycle::LifecycleLane,
    lane_index: usize,
    version: u32,
    row_order: &[String],
) -> f64 {
    if version == 2 {
        row_order
            .iter()
            .position(|row| row == &lane.id)
            .map(|row| V2_FIRST_ROW_TOP + row as f64 * V2_ROW_PITCH)
            .unwrap_or(V2_FIRST_ROW_TOP + lane_index as f64 * V2_ROW_PITCH)
    } else if lane.id == "main" {
        PHASE_TOP
    } else if lane.id == "terminal" {
        OUTCOME_TOP
    } else {
        let _ = spec;
        EVENT_TOP
    }
}

type StateSemanticFlags<'a> = std::collections::BTreeMap<&'a str, (bool, Option<u32>)>;
fn state_semantic_flags(spec: &LifecycleSpec) -> StateSemanticFlags<'_> {
    let version = spec.schema_version;
    // Preserve final-state and authored-column meaning before source inputs are
    // discarded. The SVG projection must not infer either from pinned positions.
    let outgoing: std::collections::BTreeSet<_> = spec
        .transitions
        .iter()
        .map(|edge| edge.from.as_str())
        .collect();
    let last_main = spec
        .states
        .iter()
        .filter(|state| state.lane == "main")
        .map(|state| state.col)
        .max();
    let final_states: std::collections::BTreeMap<_, _> = spec
        .states
        .iter()
        .map(|state| {
            (
                state.id.as_str(),
                !outgoing.contains(state.id.as_str())
                    && (version == 2 || state.lane != "main" || Some(state.col) == last_main),
            )
        })
        .collect();
    spec.states
        .iter()
        .map(|state| {
            let ordinal = if state.lane == "main" {
                // Retain authored column identity for both schema versions.
                // It is independent of pin-adjusted placement and lets the
                // SVG projection recover forward-main transition semantics.
                Some(state.col)
            } else {
                None
            };
            (
                state.id.as_str(),
                (final_states[state.id.as_str()], ordinal),
            )
        })
        .collect()
}

fn effective_transition_variant(
    spec: &LifecycleSpec,
    transition: &crate::lifecycle::LifecycleTransition,
) -> String {
    if let Some(variant) = &transition.variant {
        return variant.clone();
    }
    if spec.schema_version == 2 {
        if let (Some(from), Some(to)) = (
            spec.states.iter().find(|state| state.id == transition.from),
            spec.states.iter().find(|state| state.id == transition.to),
        ) {
            if from.lane == "main" && to.lane == "main" && to.col > from.col {
                return "emphasis".into();
            }
        }
    }
    "default".into()
}
fn attach_state_semantics(scene: &mut SceneBuilder, id: &str, flags: &StateSemanticFlags<'_>) {
    if let Some(node) = scene.document.nodes.last_mut().filter(|node| node.id == id) {
        let &(final_state, phase_order) = flags
            .get(id)
            .expect("every placed state has classified semantics");
        node.final_state = Some(final_state);
        node.phase_order = phase_order;
    }
}

pub(crate) fn place(spec: &LifecycleSpec, scene: &mut SceneBuilder) -> Result<(), Diagnostic> {
    let version = spec.schema_version;
    if version == 1 {
        if let Some(column) = spec
            .states
            .iter()
            .filter(|state| state.lane == "main")
            .map(|state| state.col)
            .max()
        {
            let source_x = *PHASE_COLUMNS.get(column as usize).ok_or_else(|| {
                geometry_error(
                    "/states",
                    "main phase column has no reference rail endpoint",
                )
            })?;
            scene.document.lifecycle_rail = Some(crate::geometry::GeometryLine {
                from: point(154.0, PHASE_TOP + 31.0)?,
                to: point(source_x + 38.0, PHASE_TOP + 31.0)?,
            });
        }
    }
    let lane_indices: std::collections::HashMap<_, _> = spec
        .lanes
        .iter()
        .enumerate()
        .map(|(index, lane)| (lane.id.as_str(), index))
        .collect();
    let row_order = lifecycle_row_order(spec);
    let centers = lifecycle_v2_centers(spec);
    let max_right = spec
        .states
        .iter()
        .filter_map(|state| {
            state_position(spec, state, &row_order, &centers).map(|(x, _)| {
                x + state
                    .width
                    .unwrap_or(default_state_size(version, &state.lane).0)
            })
        })
        .fold(0.0_f64, f64::max);
    let total_width = max_right.max(980.0);

    let semantic_flags = state_semantic_flags(spec);

    for (index, state) in spec.states.iter().enumerate() {
        let _lane = *lane_indices.get(state.lane.as_str()).ok_or_else(|| {
            geometry_error(&format!("/states/{index}/lane"), "state lane is missing")
        })?;
        let (default_width, default_height) = default_state_size(version, &state.lane);
        let width = state.width.unwrap_or(default_width);
        let height = state.height.unwrap_or(default_height);
        let auto = if let Some(position) = scene.pinned_position(&state.id) {
            position
        } else {
            let (x, y) = state_position(spec, state, &row_order, &centers).ok_or_else(|| {
                geometry_error(
                    &format!("/states/{index}/col"),
                    "state column has no source layout position",
                )
            })?;
            point(x, y)?
        };
        let detail = match (state.sublabel.as_deref(), state.step.as_deref()) {
            (Some(sublabel), Some(step)) if sublabel != step => Some(format!("{sublabel}\n{step}")),
            (Some(sublabel), _) => Some(sublabel.to_owned()),
            (None, Some(step)) => Some(step.to_owned()),
            (None, None) => None,
        };
        let placed = scene.add_node(
            &state.id,
            &state.state_type,
            &state.label,
            detail.as_deref(),
            state.tag.as_deref(),
            None,
            auto,
            Some([width, height]),
            // Authored heights are respected; a taller default state stops one
            // 10px separation inside the next row.
            match state.height {
                Some(_) => None,
                None => Some(px(if version == 2 { 184.0 } else { 176.0 } - 10.0)?),
            },
        );
        attach_state_semantics(scene, &state.id, &semantic_flags);
        placed?;
    }

    for (index, lane) in spec.lanes.iter().enumerate() {
        let members: Vec<_> = spec
            .states
            .iter()
            .filter(|state| state.lane == lane.id)
            .map(|state| state.id.clone())
            .collect();
        let id = format!("lane:{}", lane.id);
        if members.is_empty() {
            scene.add_container(
                &id,
                "lane",
                &lane.label,
                pixel_box(
                    64.0,
                    empty_lane_top(spec, lane, index, version, &row_order),
                    total_width - 64.0,
                    if version == 2 {
                        V2_STATE_HEIGHT + 48.0
                    } else {
                        106.0
                    },
                    &format!("/lanes/{index}"),
                )?,
            )?;
        } else {
            scene.container_for_members(&id, "lane", &lane.label, &members, 24.0)?;
        }
    }

    let route_ids = super::allocate_route_ids(
        "transition",
        spec.transitions
            .iter()
            .map(|transition| transition.id.as_deref()),
    );
    for (index, (transition, id)) in spec.transitions.iter().zip(route_ids).enumerate() {
        let path = format!("/transitions/{index}");
        let label = match (&transition.label, &transition.note) {
            (Some(label), Some(note)) if !note.is_empty() => format!("{label}\n{note}"),
            (Some(label), _) => label.clone(),
            (None, Some(note)) => note.clone(),
            (None, None) => String::new(),
        };
        let waypoints = transition
            .via
            .as_deref()
            .unwrap_or_default()
            .iter()
            .enumerate()
            .map(|(point_index, coordinates)| {
                point(coordinates[0], coordinates[1]).map_err(|error| {
                    geometry_error(&format!("{path}/via/{point_index}"), error.message)
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let label_at = transition
            .label_at
            .map(|coordinates| point(coordinates[0], coordinates[1]))
            .transpose()
            .map_err(|error| geometry_error(&format!("{path}/labelAt"), error.message))?;
        scene.connection(RouteRequest {
            id,
            from: transition.from.clone(),
            to: transition.to.clone(),
            label: (!label.is_empty()).then_some(label),
            from_side: transition.from_side.clone(),
            to_side: transition.to_side.clone(),
            waypoints,
            label_at,
            route: transition.route.clone(),
            channel_x: transition
                .channel_x
                .map(px)
                .transpose()
                .map_err(|error| geometry_error(&format!("{path}/channelX"), error.message))?,
            channel_y: transition
                .channel_y
                .map(px)
                .transpose()
                .map_err(|error| geometry_error(&format!("{path}/channelY"), error.message))?,
            label_dx: transition
                .label_dx
                .map(px)
                .transpose()
                .map_err(|error| geometry_error(&format!("{path}/labelDx"), error.message))?,
            label_dy: transition
                .label_dy
                .map(px)
                .transpose()
                .map_err(|error| geometry_error(&format!("{path}/labelDy"), error.message))?,
            label_segment: segment_index(
                transition.label_segment,
                &format!("{path}/labelSegment"),
            )?,
            variant: Some(effective_transition_variant(spec, transition)),
            width: transition
                .width
                .map(px)
                .transpose()
                .map_err(|error| geometry_error(&format!("{path}/width"), error.message))?,
            ..Default::default()
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    fn layout(spec: &str) -> crate::geometry::GeometryReport {
        let request = serde_json::json!({ "specJson": spec });
        crate::layout::layout_json(&request.to_string())
    }

    #[test]
    fn places_states_lanes_and_transition_geometry_deterministically() {
        let spec = r#"{"schema_version":2,"diagram_type":"lifecycle","meta":{"title":"Lifecycle","output":"lifecycle.html"},"lanes":[{"id":"main","label":"Main"}],"states":[{"id":"begin","type":"start","label":"Begin","sublabel":"Current","lane":"main","col":0,"step":"Entry"},{"id":"done","type":"success","label":"Done","lane":"main","col":1}],"transitions":[{"id":"complete","from":"begin","to":"done","label":"complete","note":"after review","route":"auto","fromSide":"right","toSide":"left","labelAt":[500,200]}]}"#;
        let report = layout(spec);
        assert!(report.ok, "{:?}", report.diagnostics);
        let geometry = report.geometry.unwrap();
        assert_eq!(geometry.nodes.len(), 2);
        assert_eq!(geometry.routes.len(), 1);
        let begin = geometry
            .nodes
            .iter()
            .find(|node| node.id == "begin")
            .unwrap();
        let done = geometry
            .nodes
            .iter()
            .find(|node| node.id == "done")
            .unwrap();
        assert_eq!((begin.bounds.x, begin.bounds.y), (60 * 64, 56 * 64));
        assert_eq!(
            (begin.bounds.width, begin.bounds.height),
            (140 * 64, 64 * 64)
        );
        assert_eq!((done.bounds.x, done.bounds.y), (264 * 64, 56 * 64));
        assert!(geometry
            .containers
            .iter()
            .any(|container| container.id == "lane:main"));
        assert!(geometry
            .labels
            .iter()
            .any(|label| label.text == "Current\nEntry"));
        assert!(geometry
            .labels
            .iter()
            .any(|label| label.text == "complete\nafter review"));
    }

    #[test]
    fn rejects_nonrepresentable_fixed_point_positions() {
        assert!(super::point(0.0, 1e30).is_err());
    }

    #[test]
    fn v1_defaults_use_reserved_bands_and_format_state_sizes() {
        let spec = r#"{"schema_version":1,"diagram_type":"lifecycle","meta":{"title":"Lifecycle","output":"lifecycle.html"},"lanes":[{"id":"main","label":"Main"},{"id":"ordinary","label":"Ordinary"}],"states":[{"id":"phase","type":"start","label":"Phase","lane":"main","col":0},{"id":"event","type":"active","label":"Event","lane":"ordinary","col":0}],"transitions":[]}"#;
        let report = layout(spec);
        assert!(report.ok, "{:?}", report.diagnostics);
        let nodes = report.geometry.unwrap().nodes;
        let phase = nodes.iter().find(|node| node.id == "phase").unwrap();
        let event = nodes.iter().find(|node| node.id == "event").unwrap();
        assert_eq!((phase.bounds.x, phase.bounds.y), (35 * 64, 126 * 64));
        assert_eq!(
            (phase.bounds.width, phase.bounds.height),
            (118 * 64, 62 * 64)
        );
        assert_eq!((event.bounds.x, event.bounds.y), (339 * 64, 278 * 64));
        assert_eq!(
            (event.bounds.width, event.bounds.height),
            (126 * 64, 58 * 64)
        );
    }

    #[test]
    fn a_valid_pin_skips_unrepresentable_automatic_offset() {
        let spec = r#"{"schema_version":1,"diagram_type":"lifecycle","meta":{"title":"Pinned lifecycle","output":"pinned-lifecycle.html"},"lanes":[{"id":"main","label":"Main"}],"states":[{"id":"pinned","type":"start","label":"Pinned","lane":"main","col":0,"yOffset":1e30},{"id":"done","type":"success","label":"Done","lane":"main","col":1}],"transitions":[]}"#;
        assert!(crate::validate_json(spec).ok);
        let unpinned = serde_json::json!({ "specJson": spec });
        assert!(
            !crate::layout::layout_json(&unpinned.to_string()).ok,
            "un-pinned automatic placement must reject overflow"
        );
        let request = serde_json::json!({
            "specJson": spec,
            "pinSet": {
                "sourceSpecSha256": crate::spec_hash(spec),
                "pins": [{
                    "targetId": "pinned",
                    "targetKind": "node",
                    "position": {"x": 35 * 64, "y": 100 * 64}
                }]
            }
        });
        let report = crate::layout::layout_json(&request.to_string());
        assert!(report.ok, "{:?}", report.diagnostics);
        let node = report
            .geometry
            .unwrap()
            .nodes
            .into_iter()
            .find(|node| node.id == "pinned")
            .unwrap();
        assert_eq!(
            node.position_source,
            crate::geometry::GeometryPositionSource::PlannedPin
        );
        assert_eq!((node.bounds.x, node.bounds.y), (35 * 64, 100 * 64));
    }
}
