//! Deterministic workflow lane, phase, group, and edge placement.

use crate::geometry::GeometryBox;
use crate::layout::{point, px, RouteRequest, SceneBuilder};
use crate::workflow::WorkflowSpec;
use crate::Diagnostic;
use std::collections::HashMap;

const LEGACY_COLUMN_CENTERS: [f64; 6] = [88.0, 220.0, 300.0, 430.0, 500.0, 625.0];
const READABLE_COLUMN_START: f64 = 94.0;
const READABLE_COLUMN_PITCH: f64 = 120.0;
const LANE_X: f64 = 40.0;
const LANE_Y: f64 = 52.0;
const LANE_WIDTH: f64 = 640.0;
const LANE_HEIGHT: f64 = 104.0;
const LANE_GAP: f64 = 20.0;
const LANE_TITLE_HEIGHT: f64 = 30.0;
const NODE_WIDTH: f64 = 92.0;
const NODE_HEIGHT: f64 = 52.0;
const TAGGED_NODE_HEIGHT: f64 = 68.0;

fn column_center(version: u32, col: u32) -> f64 {
    if version == 1 {
        LEGACY_COLUMN_CENTERS
            .get(col as usize)
            .copied()
            .unwrap_or_else(|| LEGACY_COLUMN_CENTERS[5] + (f64::from(col) - 5.0) * 125.0)
    } else {
        READABLE_COLUMN_START + f64::from(col) * READABLE_COLUMN_PITCH
    }
}

fn lane_top(index: usize) -> f64 {
    LANE_Y + index as f64 * (LANE_HEIGHT + LANE_GAP)
}

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
    let version = spec.schema_version;

    for (index, node) in spec.nodes.iter().enumerate() {
        let lane = *lane_indices.get(node.lane.as_str()).ok_or_else(|| {
            geometry_error(&format!("/nodes/{index}/lane"), "node lane is missing")
        })?;
        let width = node.width.unwrap_or(NODE_WIDTH);
        let height = node.height.unwrap_or(if node.tag.is_some() {
            TAGGED_NODE_HEIGHT
        } else {
            NODE_HEIGHT
        });
        let auto = if let Some(position) = scene.pinned_position(&node.id) {
            position
        } else {
            point(
                column_center(version, node.col) - width / 2.0,
                lane_top(lane)
                    + LANE_TITLE_HEIGHT
                    + (LANE_HEIGHT - LANE_TITLE_HEIGHT - height) / 2.0
                    + node.y_offset.unwrap_or(0.0),
            )?
        };
        scene.add_node(
            &node.id,
            &node.node_type,
            &node.label,
            node.sublabel.as_deref(),
            node.tag.as_deref(),
            None,
            auto,
            Some([width, height]),
        )?;
    }

    // Phase headers span their declared inclusive column range.
    for (index, phase) in spec
        .phases
        .as_deref()
        .unwrap_or_default()
        .iter()
        .enumerate()
    {
        let left = column_center(version, phase.from_col) - 46.0;
        let right = column_center(version, phase.to_col) + 46.0;
        let bounds = pixel_box(left, 27.0, right - left, 16.0, &format!("/phases/{index}"))?;
        scene.add_container(
            &format!("phase:{}", phase.id),
            "phase",
            &phase.label,
            bounds,
        )?;
    }

    for (index, lane) in spec.lanes.iter().enumerate() {
        let id = format!("lane:{}", lane.id);
        let lane_label = if lane.variant.as_deref() == Some("exception") {
            format!("EX / {}", lane.label)
        } else {
            format!("{:02} / {}", index + 1, lane.label)
        };
        scene.add_container(
            &id,
            "lane",
            &lane_label,
            pixel_box(
                LANE_X,
                lane_top(index),
                LANE_WIDTH,
                LANE_HEIGHT,
                &format!("/lanes/{index}"),
            )?,
        )?;
        if lane.variant.as_deref() == Some("exception") {
            scene.add_container(
                &format!("lane:{}:exception", lane.id),
                "exception-lane",
                "",
                pixel_box(
                    LANE_X + 6.0,
                    lane_top(index) + 6.0,
                    LANE_WIDTH - 12.0,
                    LANE_HEIGHT - 12.0,
                    &format!("/lanes/{index}"),
                )?,
            )?;
        }
    }

    for (index, group) in spec
        .groups
        .as_deref()
        .unwrap_or_default()
        .iter()
        .enumerate()
    {
        let lane = *lane_indices.get(group.lane.as_str()).ok_or_else(|| {
            geometry_error(&format!("/groups/{index}/lane"), "group lane is missing")
        })?;
        let left = column_center(version, group.from_col) - 50.0;
        let right = column_center(version, group.to_col) + 50.0;
        let bounds = pixel_box(
            left,
            lane_top(lane) + LANE_TITLE_HEIGHT + 8.0,
            right - left,
            LANE_HEIGHT - LANE_TITLE_HEIGHT - 16.0,
            &format!("/groups/{index}"),
        )?;
        scene.add_container(
            &format!("group:{}", group.id),
            "group",
            &group.label,
            bounds,
        )?;
    }

    let route_ids =
        super::allocate_route_ids("edge", spec.edges.iter().map(|edge| edge.id.as_deref()));
    for (index, (edge, id)) in spec.edges.iter().zip(route_ids).enumerate() {
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
            id,
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
            bias: edge.bias,
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
    use crate::layout::header_support::{label, overlap};

    fn layout(spec: &str) -> crate::geometry::GeometryReport {
        let request = serde_json::json!({ "specJson": spec });
        crate::layout::layout_json(&request.to_string())
    }

    #[test]
    fn places_nodes_and_all_declared_workflow_containers() {
        let report = layout(
            r#"{"schema_version":2,"diagram_type":"workflow","meta":{"title":"Workflow","output":"workflow.html"},"lanes":[{"id":"main","label":"Main"},{"id":"empty","label":"Empty lane"}],"phases":[{"id":"build","label":"Build","fromCol":0,"toCol":1}],"groups":[{"id":"review","label":"Review","lane":"main","fromCol":1,"toCol":1}],"nodes":[{"id":"start","lane":"main","col":0,"type":"frontend","label":"Start","sublabel":"Request","tag":"API"},{"id":"review-node","lane":"main","col":1,"type":"backend","label":"Review"}],"edges":[{"id":"continue","from":"start","to":"review-node","role":"main","variant":"dashed","label":"continue","labelAt":[320,40]}],"mainPath":["start","review-node"]}"#,
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
        assert!(geometry.labels.iter().any(|label| label.text == "Request"));
        assert!(geometry.labels.iter().any(|label| label.text == "API"));
    }

    #[test]
    fn v1_defaults_match_documented_column_and_lane_geometry() {
        let report = layout(
            r#"{"schema_version":1,"diagram_type":"workflow","meta":{"title":"Workflow","output":"workflow.html"},"lanes":[{"id":"main","label":"Main"}],"nodes":[{"id":"first","lane":"main","col":0,"type":"frontend","label":"First"},{"id":"fourth","lane":"main","col":3,"type":"backend","label":"Fourth"}],"edges":[]}"#,
        );
        assert!(report.ok, "{:?}", report.diagnostics);
        let nodes = report.geometry.unwrap().nodes;
        let first = nodes.iter().find(|node| node.id == "first").unwrap();
        let fourth = nodes.iter().find(|node| node.id == "fourth").unwrap();
        // The lane stack keeps the pinned geometry and the emitted header band
        // moves it down: a one-line 24px title ends at 52, plus the 12px gap, is
        // a 64px band above the pinned y=93 first row (maru#561).
        assert_eq!((first.bounds.x, first.bounds.y), (42 * 64, 157 * 64));
        assert_eq!(
            (first.bounds.width, first.bounds.height),
            (92 * 64, 52 * 64)
        );
        assert_eq!((fourth.bounds.x, fourth.bounds.y), (384 * 64, 157 * 64));
    }

    fn header_spec(subtitle: &str) -> serde_json::Value {
        serde_json::json!({
            "schema_version": 2,
            "diagram_type": "workflow",
            "meta": {
                "title": "마루 workflow 렌더",
                "subtitle": subtitle,
                "output": "workflow.html",
            },
            "lanes": [{ "id": "main", "label": "메인 흐름" }],
            "phases": [{ "id": "build", "label": "빌드 단계", "fromCol": 0, "toCol": 1 }],
            "groups": [{ "id": "review", "label": "검토", "lane": "main", "fromCol": 2, "toCol": 2 }],
            "nodes": [
                { "id": "a", "lane": "main", "col": 0, "type": "frontend", "label": "입력" },
                { "id": "b", "lane": "main", "col": 2, "type": "backend", "label": "출력" },
            ],
            "edges": [{ "id": "ab", "from": "a", "to": "b", "role": "main" }],
            "mainPath": ["a", "b"],
        })
    }

    fn assert_header_clear(spec: &serde_json::Value) -> crate::geometry::GeometryDocument {
        let report = layout(&spec.to_string());
        assert!(report.ok, "{:?}", report.diagnostics);
        let geometry = report.geometry.unwrap();
        let header = [label(&geometry, "title"), label(&geometry, "subtitle")];
        for caption in [
            "container:lane:main:label",
            "container:phase:build:label",
            "container:group:review:label",
        ] {
            let caption = label(&geometry, caption);
            for header in header {
                assert!(
                    !overlap(header.bounds, caption.bounds),
                    "header {:?} overlaps caption {:?}: {:?} vs {:?}",
                    header.text,
                    caption.text,
                    header.bounds,
                    caption.bounds,
                );
            }
        }
        for header in header {
            assert!(
                header.bounds.y >= 0 && header.bounds.height > 0,
                "header {:?} has no measured box",
                header.text
            );
        }
        geometry
    }

    /// maru#561: the title and subtitle are emitted into the SVG's own
    /// coordinates, so the producer reserves their measured band before the
    /// lane stack. A CJK subtitle and a multi-line subtitle must both clear the
    /// lane, phase and group captions, and nothing in the SVG writer moves.
    #[test]
    fn header_subtitle_clears_lane_phase_and_group_captions() {
        let geometry = assert_header_clear(&header_spec("결정적 SVG · 접근성 검증"));
        // The lane caption sits below the measured header, not over it.
        let title = label(&geometry, "title").bounds;
        let subtitle = label(&geometry, "subtitle").bounds;
        let lane = label(&geometry, "container:lane:main:label").bounds;
        assert!(lane.y >= subtitle.y + subtitle.height, "{lane:?}");
        assert!(lane.y >= title.y + title.height, "{lane:?}");
        // Light and dark both render the same reserved geometry.
        #[cfg(feature = "render-svg")]
        for theme in [
            crate::render::SvgTheme::Light,
            crate::render::SvgTheme::Dark,
        ] {
            let options = crate::render::SvgOptions::from_spec(
                &header_spec("결정적 SVG · 접근성 검증"),
                theme,
            )
            .unwrap();
            let report = crate::render::render_svg(&geometry, &options);
            assert!(report.ok, "{theme:?}: {:?}", report.diagnostics);
            let svg = report.svg.unwrap();
            assert!(
                svg.contains("결정적 SVG · 접근성 검증"),
                "{theme:?} lost the subtitle"
            );
            assert!(svg.contains("메인 흐름"), "{theme:?} lost the lane caption");
        }
    }

    #[test]
    fn a_multi_line_header_reserves_every_line() {
        let single = assert_header_clear(&header_spec("결정적 SVG · 접근성 검증"));
        let multi = assert_header_clear(&header_spec("결정적 SVG\n접근성 검증\n다국어 라벨"));
        let lane = |geometry: &crate::geometry::GeometryDocument| {
            label(geometry, "container:lane:main:label").bounds.y
        };
        assert!(
            lane(&multi) > lane(&single),
            "a three-line subtitle must reserve more band than a one-line subtitle"
        );
        assert!(label(&multi, "subtitle").bounds.height > label(&single, "subtitle").bounds.height);
    }

    #[test]
    fn rejects_lane_coordinate_overflow_without_narrowing() {
        let error = crate::layout::point(1e30, 0.0);
        assert!(error.is_err());
    }

    #[test]
    fn a_valid_pin_skips_unrepresentable_automatic_offset() {
        let spec = r#"{"schema_version":1,"diagram_type":"workflow","meta":{"title":"Pinned workflow","output":"pinned-workflow.html"},"lanes":[{"id":"main","label":"Main"}],"nodes":[{"id":"pinned","lane":"main","col":0,"type":"backend","label":"Pinned","yOffset":1e30}],"edges":[]}"#;
        assert!(crate::validate_json(spec).ok);
        assert!(
            !layout(spec).ok,
            "un-pinned automatic placement must reject overflow"
        );
        let request = serde_json::json!({
            "specJson": spec,
            "pinSet": {
                "sourceSpecSha256": crate::spec_hash(spec),
                "pins": [{
                    "targetId": "pinned",
                    "targetKind": "node",
                    "position": {"x": 120 * 64, "y": 152 * 64}
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
        // A pin is a canvas position: it is converted into the source drawing's
        // space for the lane rules and returned exactly after the header band
        // moves the drawing (maru#561).
        assert_eq!((node.bounds.x, node.bounds.y), (120 * 64, 152 * 64));
    }
}
