//! Deterministic lifecycle lane/state placement and transition requests.

use crate::geometry::GeometryBox;
use crate::layout::{point, px, RouteRequest, SceneBuilder};
use crate::lifecycle::LifecycleSpec;
use crate::Diagnostic;

const LAYOUT_X: f64 = 120.0;
const LAYOUT_Y: f64 = 144.0;
const COLUMN_STEP: f64 = 236.0;
const LANE_STEP: f64 = 208.0;
const NODE_WIDTH: f64 = 184.0;
const NODE_HEIGHT: f64 = 76.0;

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

pub(crate) fn place(spec: &LifecycleSpec, scene: &mut SceneBuilder) -> Result<(), Diagnostic> {
    let lane_indices: std::collections::HashMap<_, _> = spec
        .lanes
        .iter()
        .enumerate()
        .map(|(index, lane)| (lane.id.as_str(), index))
        .collect();
    let max_col = spec.states.iter().map(|state| state.col).max().unwrap_or(0);
    let total_width = LAYOUT_X + f64::from(max_col + 1) * COLUMN_STEP;

    for (index, state) in spec.states.iter().enumerate() {
        let lane = *lane_indices.get(state.lane.as_str()).ok_or_else(|| {
            geometry_error(&format!("/states/{index}/lane"), "state lane is missing")
        })?;
        let width = state.width.unwrap_or(NODE_WIDTH);
        let height = state.height.unwrap_or(NODE_HEIGHT);
        let auto = if let Some(position) = scene.pinned_position(&state.id) {
            position
        } else {
            point(
                LAYOUT_X + f64::from(state.col) * COLUMN_STEP,
                LAYOUT_Y + lane as f64 * LANE_STEP + state.y_offset.unwrap_or(0.0),
            )?
        };
        let size = (state.width.is_some() || state.height.is_some()).then_some([width, height]);
        let detail = match (state.sublabel.as_deref(), state.step.as_deref()) {
            (Some(sublabel), Some(step)) if sublabel != step => Some(format!("{sublabel}\n{step}")),
            (Some(sublabel), _) => Some(sublabel.to_owned()),
            (None, Some(step)) => Some(step.to_owned()),
            (None, None) => None,
        };
        scene.add_node(
            &state.id,
            &state.state_type,
            &state.label,
            detail.as_deref(),
            state.tag.as_deref(),
            None,
            auto,
            size,
        )?;
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
                    LAYOUT_X - 24.0,
                    LAYOUT_Y + index as f64 * LANE_STEP - 24.0,
                    total_width - LAYOUT_X + 24.0,
                    NODE_HEIGHT + 48.0,
                    &format!("/lanes/{index}"),
                )?,
            )?;
        } else {
            scene.container_for_members(&id, "lane", &lane.label, &members, 24.0)?;
        }
    }

    for (index, transition) in spec.transitions.iter().enumerate() {
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
            id: transition
                .id
                .clone()
                .unwrap_or_else(|| format!("transition:{index}")),
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
            variant: transition.variant.clone(),
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
        let spec = r#"{"schema_version":2,"diagram_type":"lifecycle","meta":{"title":"Lifecycle","output":"lifecycle.html"},"lanes":[{"id":"main","label":"Main"}],"states":[{"id":"begin","type":"start","label":"Begin","lane":"main","col":0,"step":"Entry"},{"id":"done","type":"success","label":"Done","lane":"main","col":1}],"transitions":[{"id":"complete","from":"begin","to":"done","label":"complete","note":"after review","route":"auto","fromSide":"right","toSide":"left","labelAt":[320,40]}]}"#;
        let report = layout(spec);
        assert!(report.ok, "{:?}", report.diagnostics);
        let geometry = report.geometry.unwrap();
        assert_eq!(geometry.nodes.len(), 2);
        assert_eq!(geometry.routes.len(), 1);
        assert!(geometry
            .containers
            .iter()
            .any(|container| container.id == "lane:main"));
        assert!(geometry.labels.iter().any(|label| label.text == "Entry"));
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
                    "position": {"x": 17 * 64, "y": 29 * 64}
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
        assert_eq!((node.bounds.x, node.bounds.y), (17 * 64, 29 * 64));
    }
}
