//! Stage columns, unbounded authored rows, and explicit data-flow channels.

use super::{point, px, RouteRequest, SceneBuilder};
use crate::dataflow::DataflowSpec;
use crate::geometry::{GeometryBox, GeometryPoint};
use crate::Diagnostic;

const NODE_WIDTH: f64 = 180.0;
const NODE_HEIGHT: f64 = 88.0;
const STAGE_GAP: f64 = 100.0;
const ROW_GAP: f64 = 64.0;
const PADDING: f64 = 24.0;

fn geometry_error(path: &str, cause: impl Into<String>) -> Diagnostic {
    crate::diagnostic(
        "dataflow/layout-range",
        path,
        "dataflow-layout-v1/range",
        cause,
        "use a finite stage, row, size, or channel inside the supported fixed-point extent",
    )
}

fn node_position(
    stage_left: f64,
    stage_width: f64,
    width: f64,
    row: f64,
    row_step: f64,
    offset: f64,
) -> Result<GeometryPoint, Diagnostic> {
    // Do not narrow a schema-unbounded row to an integer index. The checked
    // pixel boundary rejects a position that cannot be represented.
    point(
        stage_left + (stage_width - width) / 2.0,
        160.0 + row * row_step + offset,
    )
}

fn label_segment(value: Option<f64>) -> Result<Option<usize>, Diagnostic> {
    value
        .map(|value| {
            if !value.is_finite()
                || value < 0.0
                || value.fract() != 0.0
                || value > f64::from(u32::MAX)
            {
                return Err(geometry_error(
                    "/flows/labelSegment",
                    "label segment is not a representable nonnegative index",
                ));
            }
            Ok(value as usize)
        })
        .transpose()
}

pub(crate) fn place(spec: &DataflowSpec, scene: &mut SceneBuilder) -> Result<(), Diagnostic> {
    let mut widths = vec![NODE_WIDTH; spec.stages.len()];
    let mut row_height = NODE_HEIGHT;
    for (index, node) in spec.nodes.iter().enumerate() {
        let stage = usize::try_from(node.stage)
            .map_err(|error| geometry_error(&format!("/nodes/{index}/stage"), error.to_string()))?;
        let stage_width = widths.get_mut(stage).ok_or_else(|| {
            geometry_error(
                &format!("/nodes/{index}/stage"),
                "node stage does not exist",
            )
        })?;
        let width = node.width.unwrap_or(NODE_WIDTH);
        let height = node.height.unwrap_or(NODE_HEIGHT);
        px(width)?;
        px(height)?;
        *stage_width = stage_width.max(width);
        row_height = row_height.max(height);
    }
    let mut lefts = Vec::with_capacity(widths.len());
    let mut next_left = 64.0;
    for width in &widths {
        lefts.push(next_left);
        px(next_left + width)?;
        next_left += width + STAGE_GAP;
    }
    for node in &spec.nodes {
        let stage = usize::try_from(node.stage)
            .map_err(|error| geometry_error("/nodes/stage", error.to_string()))?;
        let width = node.width.unwrap_or(NODE_WIDTH);
        let height = node.height.unwrap_or(NODE_HEIGHT);
        scene.add_node(
            &node.id,
            &node.component_type,
            &node.label,
            node.decoration.sublabel.as_deref(),
            node.decoration.tag.as_deref(),
            None,
            if let Some(pin) = scene.pinned_position(&node.id) {
                pin
            } else {
                node_position(
                    lefts[stage],
                    widths[stage],
                    width,
                    node.row,
                    row_height + ROW_GAP,
                    node.y_offset.unwrap_or(0.0),
                )?
            },
            Some([width, height]),
        )?;
    }
    let stage_ids = super::anonymous_ids("stage", &spec.stages)?;
    for (index, stage) in spec.stages.iter().enumerate() {
        let members: Vec<String> = spec
            .nodes
            .iter()
            .filter(|node| usize::try_from(node.stage).ok() == Some(index))
            .map(|node| node.id.clone())
            .collect();
        let id = &stage_ids[index];
        if members.is_empty() {
            scene.add_container(
                id,
                "stage",
                &stage.label,
                GeometryBox {
                    x: px(lefts[index] - PADDING)?,
                    y: px(136.0)?,
                    width: px(widths[index] + PADDING * 2.0)?,
                    height: px(NODE_HEIGHT + PADDING * 2.0)?,
                },
            )?;
        } else {
            scene.container_for_members(id, "stage", &stage.label, &members, PADDING)?;
        }
    }
    for (index, flow) in spec.flows.iter().enumerate() {
        scene.connection(RouteRequest {
            id: flow.id.clone().unwrap_or_else(|| format!("flow:{index}")),
            from: flow.from.clone(),
            to: flow.to.clone(),
            label: Some(flow.label.clone()),
            from_side: flow.from_side.clone(),
            to_side: flow.to_side.clone(),
            waypoints: flow
                .via
                .as_deref()
                .unwrap_or_default()
                .iter()
                .map(|value| point(value[0], value[1]))
                .collect::<Result<Vec<_>, _>>()?,
            route: flow.route.clone(),
            channel_x: flow.channel_x.map(px).transpose()?,
            channel_y: flow.channel_y.map(px).transpose()?,
            label_dx: flow.label_dx.map(px).transpose()?,
            label_dy: flow.label_dy.map(px).transpose()?,
            label_segment: label_segment(flow.label_segment)?,
            variant: flow.variant.clone(),
            width: flow.width.map(px).transpose()?,
            label_at: flow
                .label_at
                .map(|value| point(value[0], value[1]))
                .transpose()?,
            ..Default::default()
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> serde_json::Value {
        serde_json::json!({
            "schema_version":1,"diagram_type":"dataflow",
            "meta":{"title":"Data","output":"data.html"},
            "stages":[{"label":"Input"},{"label":"Output"}],
            "nodes":[{"id":"a","type":"frontend","label":"A","stage":0,"row":0},{"id":"b","type":"backend","label":"B","stage":1,"row":1,"yOffset":12}],
            "flows":[{"id":"f","from":"a","to":"b","label":"F"}]
        })
    }

    fn layout(
        spec: &serde_json::Value,
        pins: Option<serde_json::Value>,
    ) -> crate::geometry::GeometryDocument {
        let validity = crate::validate_json(&spec.to_string());
        assert!(validity.ok, "{:?}", validity.diagnostics);
        let mut request = serde_json::json!({"specJson":spec.to_string()});
        if let Some(pins) = pins {
            request["pinSet"] = pins;
        }
        let report = super::super::layout_json(&request.to_string());
        assert!(report.ok, "{:?}", report.diagnostics);
        report.geometry.unwrap()
    }

    #[test]
    fn dataflow_layout_uses_rows_offsets_and_actual_stage_bounds() {
        let geometry = layout(&spec(), None);
        let node = geometry.nodes.iter().find(|node| node.id == "b").unwrap();
        assert_eq!(node.bounds.y, px(324.0).unwrap());
        let stage = geometry
            .containers
            .iter()
            .find(|container| {
                container.kind == "stage"
                    && container
                        .bounds
                        .contains(GeometryPoint {
                            x: node.bounds.x,
                            y: node.bounds.y,
                        })
                        .unwrap()
            })
            .unwrap();
        assert!(stage
            .bounds
            .contains(GeometryPoint {
                x: node.bounds.x,
                y: node.bounds.y
            })
            .unwrap());
        assert!(stage
            .bounds
            .contains(GeometryPoint {
                x: node.bounds.right().unwrap(),
                y: node.bounds.bottom().unwrap()
            })
            .unwrap());
        assert!(geometry.routes.iter().all(|route| route
            .points
            .windows(2)
            .all(|pair| pair[0].x == pair[1].x || pair[0].y == pair[1].y)));
    }

    #[test]
    fn dataflow_node_pin_survives_an_unrelated_flow_edit() {
        let mut source = spec();
        let original = crate::validate_json(&source.to_string())
            .receipt
            .input_spec_sha256;
        let pins = serde_json::json!({"sourceSpecSha256":original,"pins":[{"targetId":"a","targetKind":"node","position":{"x":px(64.0).unwrap(),"y":px(500.0).unwrap()}}]});
        let before = layout(&source, Some(pins.clone()));
        source["flows"][0]["label"] = "Edited".into();
        let after = layout(&source, Some(pins));
        let bounds = |geometry: &crate::geometry::GeometryDocument| {
            geometry
                .nodes
                .iter()
                .find(|node| node.id == "a")
                .unwrap()
                .bounds
        };
        assert_eq!(bounds(&before), bounds(&after));
        assert_eq!(bounds(&after).y, px(500.0).unwrap());
        let stage = after
            .containers
            .iter()
            .find(|container| {
                container.kind == "stage"
                    && container
                        .bounds
                        .contains(GeometryPoint {
                            x: bounds(&after).x,
                            y: bounds(&after).y,
                        })
                        .unwrap()
            })
            .unwrap();
        assert!(stage
            .bounds
            .contains(GeometryPoint {
                x: bounds(&after).x,
                y: bounds(&after).y
            })
            .unwrap());
    }

    #[test]
    fn row_layout_keeps_fractional_math_without_narrowing_large_rows() {
        let at = node_position(64.0, 200.0, 160.0, 3.0, 152.0, 12.0).unwrap();
        assert_eq!(at, point(84.0, 628.0).unwrap());
        assert!(node_position(64.0, 180.0, 180.0, 1e20, 152.0, 0.0).is_err());
    }

    #[test]
    fn label_segment_index_never_saturates_to_another_segment() {
        assert_eq!(label_segment(Some(3.0)).unwrap(), Some(3));
        assert!(label_segment(Some(1e30)).is_err());
        assert!(label_segment(Some(0.5)).is_err());
    }
}
