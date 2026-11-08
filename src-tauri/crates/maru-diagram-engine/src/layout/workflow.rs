//! Deterministic workflow lane, phase, group, and edge placement.

use crate::geometry::GeometryBox;
use crate::layout::{point, px, RouteRequest, SceneBuilder};
use crate::workflow::WorkflowSpec;
use crate::Diagnostic;
use std::collections::HashMap;

const LAYOUT_X: f64 = 120.0;
const LAYOUT_Y: f64 = 144.0;
const COLUMN_STEP: f64 = 236.0;
const LANE_STEP: f64 = 208.0;
const NODE_WIDTH: f64 = 184.0;
const NODE_HEIGHT: f64 = 76.0;

fn geometry_error(path: &str, cause: impl Into<String>) -> Diagnostic {
    crate::diagnostic(
        "workflow/layout-range",
        path,
        "workflow-layout-v1/range",
        cause,
        "reduce authored workflow coordinates or dimensions to fit the fixed-point range",
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

pub(crate) fn place(spec: &WorkflowSpec, scene: &mut SceneBuilder) -> Result<(), Diagnostic> {
    let lane_indices: HashMap<_, _> = spec
        .lanes
        .iter()
        .enumerate()
        .map(|(index, lane)| (lane.id.as_str(), index))
        .collect();
    let max_col = spec
        .nodes
        .iter()
        .map(|node| node.col)
        .chain(
            spec.phases
                .as_deref()
                .unwrap_or_default()
                .iter()
                .map(|phase| phase.to_col),
        )
        .chain(
            spec.groups
                .as_deref()
                .unwrap_or_default()
                .iter()
                .map(|group| group.to_col),
        )
        .max()
        .unwrap_or(0);
    let total_width = LAYOUT_X + f64::from(max_col + 1) * COLUMN_STEP;
    let fallback_bottom =
        LAYOUT_Y + spec.lanes.len().saturating_sub(1) as f64 * LANE_STEP + NODE_HEIGHT;

    for (index, node) in spec.nodes.iter().enumerate() {
        let lane = *lane_indices.get(node.lane.as_str()).ok_or_else(|| {
            geometry_error(&format!("/nodes/{index}/lane"), "node lane is missing")
        })?;
        let width = node.width.unwrap_or(NODE_WIDTH);
        let height = node.height.unwrap_or(NODE_HEIGHT);
        let auto = point(
            LAYOUT_X + f64::from(node.col) * COLUMN_STEP,
            LAYOUT_Y + lane as f64 * LANE_STEP + node.y_offset.unwrap_or(0.0),
        )?;
        let size = (node.width.is_some() || node.height.is_some()).then_some([width, height]);
        scene.add_node(
            &node.id,
            &node.node_type,
            &node.label,
            node.sublabel.as_deref(),
            node.tag.as_deref(),
            None,
            auto,
            size,
        )?;
    }

    // Phase frames span their declared inclusive column range and all lanes,
    // even when a phase contains no node. Keep them behind lane/group frames.
    for (index, phase) in spec
        .phases
        .as_deref()
        .unwrap_or_default()
        .iter()
        .enumerate()
    {
        let path = format!("/phases/{index}");
        let mut left = LAYOUT_X + f64::from(phase.from_col) * COLUMN_STEP - 24.0;
        let mut right = LAYOUT_X + f64::from(phase.to_col) * COLUMN_STEP + NODE_WIDTH + 24.0;
        for node in spec
            .nodes
            .iter()
            .filter(|node| (phase.from_col..=phase.to_col).contains(&node.col))
        {
            if let Some(bounds) = scene.node_bounds(&node.id) {
                left = left.min(f64::from(bounds.x) / 64.0);
                let node_right = bounds
                    .right()
                    .map_err(|error| geometry_error(&path, error.to_string()))?;
                right = right.max(f64::from(node_right) / 64.0);
            }
        }
        let mut top = LAYOUT_Y;
        let mut bottom = fallback_bottom;
        if let Some(first) = scene.document.nodes.first() {
            top = f64::from(first.bounds.y) / 64.0;
            bottom = f64::from(
                first
                    .bounds
                    .bottom()
                    .map_err(|error| geometry_error(&path, error.to_string()))?,
            ) / 64.0;
        }
        for node in scene.document.nodes.iter().skip(1) {
            top = top.min(f64::from(node.bounds.y) / 64.0);
            bottom = bottom.max(
                f64::from(
                    node.bounds
                        .bottom()
                        .map_err(|error| geometry_error(&path, error.to_string()))?,
                ) / 64.0,
            );
        }
        let container_top = top - 58.0;
        let container_bottom = bottom + 24.0;
        let bounds = pixel_box(
            left,
            container_top,
            right - left,
            container_bottom - container_top,
            &path,
        )?;
        scene.add_container(
            &format!("phase:{}", phase.id),
            "phase",
            &phase.label,
            bounds,
        )?;
    }

    for lane in &spec.lanes {
        let members: Vec<_> = spec
            .nodes
            .iter()
            .filter(|node| node.lane == lane.id)
            .map(|node| node.id.clone())
            .collect();
        let id = format!("lane:{}", lane.id);
        if members.is_empty() {
            let lane_index = lane_indices[lane.id.as_str()];
            scene.add_container(
                &id,
                "lane",
                &lane.label,
                pixel_box(
                    LAYOUT_X - 24.0,
                    LAYOUT_Y + lane_index as f64 * LANE_STEP - 24.0,
                    total_width - LAYOUT_X + 24.0,
                    NODE_HEIGHT + 48.0,
                    &format!("/lanes/{}", lane.id),
                )?,
            )?;
        } else {
            scene.container_for_members(&id, "lane", &lane.label, &members, 24.0)?;
        }
    }

    for (index, group) in spec
        .groups
        .as_deref()
        .unwrap_or_default()
        .iter()
        .enumerate()
    {
        let members: Vec<_> = spec
            .nodes
            .iter()
            .filter(|node| {
                node.lane == group.lane && (group.from_col..=group.to_col).contains(&node.col)
            })
            .map(|node| node.id.clone())
            .collect();
        scene
            .container_for_members(
                &format!("group:{}", group.id),
                "group",
                &group.label,
                &members,
                18.0,
            )
            .map_err(|error| geometry_error(&format!("/groups/{index}"), error.message))?;
    }

    for (index, edge) in spec.edges.iter().enumerate() {
        let path = format!("/edges/{index}");
        let waypoints = edge
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
        let label_at = edge
            .label_at
            .map(|coordinates| point(coordinates[0], coordinates[1]))
            .transpose()
            .map_err(|error| geometry_error(&format!("{path}/labelAt"), error.message))?;
        scene.connection(RouteRequest {
            id: edge.id.clone().unwrap_or_else(|| format!("edge:{index}")),
            from: edge.from.clone(),
            to: edge.to.clone(),
            label: edge.label.clone(),
            from_side: edge.from_side.clone(),
            to_side: edge.to_side.clone(),
            waypoints,
            label_at,
            route: edge.route.clone(),
            channel_x: edge
                .channel_x
                .map(px)
                .transpose()
                .map_err(|error| geometry_error(&format!("{path}/channelX"), error.message))?,
            channel_y: edge
                .channel_y
                .map(px)
                .transpose()
                .map_err(|error| geometry_error(&format!("{path}/channelY"), error.message))?,
            label_dx: edge
                .label_dx
                .map(px)
                .transpose()
                .map_err(|error| geometry_error(&format!("{path}/labelDx"), error.message))?,
            label_dy: edge
                .label_dy
                .map(px)
                .transpose()
                .map_err(|error| geometry_error(&format!("{path}/labelDy"), error.message))?,
            label_segment: segment_index(edge.label_segment, &format!("{path}/labelSegment"))?,
            variant: edge.variant.clone(),
            role: edge.role.clone(),
            width: edge
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
    fn places_nodes_and_all_declared_workflow_containers() {
        let report = layout(
            r#"{"schema_version":2,"diagram_type":"workflow","meta":{"title":"Workflow","output":"workflow.html"},"lanes":[{"id":"main","label":"Main"},{"id":"empty","label":"Empty lane"}],"phases":[{"id":"build","label":"Build","fromCol":0,"toCol":1}],"groups":[{"id":"review","label":"Review","lane":"main","fromCol":1,"toCol":1}],"nodes":[{"id":"start","lane":"main","col":0,"type":"frontend","label":"Start"},{"id":"review-node","lane":"main","col":1,"type":"backend","label":"Review"}],"edges":[{"id":"continue","from":"start","to":"review-node","role":"main","variant":"dashed","label":"continue","labelAt":[320,40]}],"mainPath":["start","review-node"]}"#,
        );
        assert!(report.ok, "{:?}", report.diagnostics);
        let geometry = report.geometry.unwrap();
        assert_eq!(geometry.nodes.len(), 2);
        assert_eq!(geometry.routes.len(), 1);
        assert!(geometry
            .containers
            .iter()
            .any(|container| container.id == "lane:main"));
        assert!(geometry
            .containers
            .iter()
            .any(|container| container.id == "lane:empty"));
        assert!(geometry
            .containers
            .iter()
            .any(|container| container.id == "phase:build"));
        assert!(geometry
            .containers
            .iter()
            .any(|container| container.id == "group:review"));
    }

    #[test]
    fn rejects_lane_coordinate_overflow_without_narrowing() {
        let error = crate::layout::point(1e30, 0.0);
        assert!(error.is_err());
    }
}
