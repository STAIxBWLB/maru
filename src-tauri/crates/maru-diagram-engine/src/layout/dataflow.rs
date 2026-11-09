//! Stage columns, unbounded authored rows, and explicit data-flow channels.

use super::{point, px, RouteRequest, SceneBuilder};
use crate::dataflow::DataflowSpec;
use crate::geometry::{GeometryBox, GeometryPoint};
use crate::Diagnostic;

const NODE_WIDTH: f64 = 112.0;
const NODE_HEIGHT: f64 = 58.0;
const STAGE_X: f64 = 100.0;
const STAGE_STEP: f64 = 215.0;
const STAGE_Y: f64 = 46.0;
const STAGE_WIDTH: f64 = 168.0;
const STAGE_BOTTOM_PAD: f64 = 74.0;

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
    stage: f64,
    width: f64,
    row: f64,
    offset: f64,
) -> Result<GeometryPoint, Diagnostic> {
    // Do not narrow a schema-unbounded row to an integer index. The checked
    // pixel boundary rejects a position that cannot be represented.
    point(
        STAGE_X + stage * STAGE_STEP - width / 2.0,
        128.0 + row * 114.0 + offset,
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
    let view_height = spec.meta.view_box.map(|view| view[1]).unwrap_or(720.0);
    for node in &spec.nodes {
        let width = node.width.unwrap_or(NODE_WIDTH);
        let height = node.height.unwrap_or(NODE_HEIGHT);
        px(width)?;
        px(height)?;
        let stage = f64::from(node.stage);
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
                node_position(stage, width, node.row, node.y_offset.unwrap_or(0.0))?
            },
            Some([width, height]),
        )?;
    }
    for (index, stage) in spec.stages.iter().enumerate() {
        let center_x = STAGE_X + index as f64 * STAGE_STEP;
        scene.add_container(
            &format!("stage:{index}"),
            "stage",
            &format!("{:02} / {}", index + 1, stage.label),
            GeometryBox {
                x: px(center_x - STAGE_WIDTH / 2.0)?,
                y: px(STAGE_Y)?,
                width: px(STAGE_WIDTH)?,
                height: px((view_height - STAGE_Y - STAGE_BOTTOM_PAD).max(0.0))?,
            },
        )?;
    }
    let route_ids =
        super::allocate_route_ids("flow", spec.flows.iter().map(|flow| flow.id.as_deref()));
    for (index, flow) in spec.flows.iter().enumerate() {
        let label = match flow
            .classification
            .as_deref()
            .filter(|text| !text.is_empty())
        {
            Some(classification) => format!("{}\n{classification}", flow.label),
            None => flow.label.clone(),
        };
        scene.connection(RouteRequest {
            id: route_ids[index].clone(),
            from: flow.from.clone(),
            to: flow.to.clone(),
            label: Some(label),
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
    fn dataflow_classification_is_measured_with_the_route_text() {
        let mut source = spec();
        source["flows"][0]["classification"] = "PII".into();
        source["flows"][0]["labelAt"] = serde_json::json!([650, 500]);
        source["nodes"][0]["sublabel"] = "Browser".into();
        source["nodes"][0]["tag"] = "Source".into();
        let geometry = layout(&source, None);
        for text in [
            "01 / Input",
            "02 / Output",
            "A",
            "Browser",
            "Source",
            "B",
            "F\nPII",
        ] {
            let label = geometry
                .labels
                .iter()
                .find(|label| label.text == text)
                .unwrap_or_else(|| panic!("missing visible text {text}"));
            let glyph_text: String = label
                .glyphs
                .iter()
                .map(|glyph| glyph.input.as_str())
                .collect();
            assert_eq!(glyph_text, text.replace('\n', ""));
        }
        let label = geometry
            .labels
            .iter()
            .find(|label| label.target_id == "f")
            .unwrap();
        assert_eq!(label.text, "F\nPII");
        assert!(label.bounds.height >= label.font_size * 2);
        let expected = crate::metrics::measure_text("PII", 400, label.font_size).unwrap();
        let actual: i64 = label
            .glyphs
            .iter()
            .skip(1)
            .map(|glyph| i64::from(glyph.advance))
            .sum();
        assert_eq!(actual, i64::from(expected.advance));
    }

    #[test]
    fn dataflow_anonymous_route_id_does_not_alias_an_authored_id() {
        let mut source = spec();
        source["flows"][0].as_object_mut().unwrap().remove("id");
        source["flows"][0]["labelAt"] = serde_json::json!([650, 500]);
        source["flows"].as_array_mut().unwrap().push(serde_json::json!({"id":"flow-0","from":"b","to":"a","label":"Return","labelAt":[650,600]}));
        let geometry = layout(&source, None);
        let ids: std::collections::HashSet<_> = geometry
            .routes
            .iter()
            .map(|route| route.id.as_deref().unwrap())
            .collect();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains("flow-0"));
    }

    #[test]
    fn dataflow_layout_uses_rows_offsets_and_actual_stage_bounds() {
        let geometry = layout(&spec(), None);
        let node = geometry.nodes.iter().find(|node| node.id == "b").unwrap();
        assert_eq!(node.bounds.y, px(254.0).unwrap());
        let stage = geometry
            .containers
            .iter()
            .find(|container| container.id == "stage:1")
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
            .find(|container| container.id == "stage:0")
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
        let at = node_position(1.0, 160.0, 3.0, 12.0).unwrap();
        assert_eq!(at, point(235.0, 482.0).unwrap());
        assert!(node_position(0.0, 112.0, 1e20, 0.0).is_err());
    }

    #[test]
    fn default_nodes_and_stage_frames_use_documented_geometry() {
        let geometry = layout(&spec(), None);
        let first = geometry.nodes.iter().find(|node| node.id == "a").unwrap();
        assert_eq!((first.bounds.x, first.bounds.y), (44 * 64, 128 * 64));
        assert_eq!(
            (first.bounds.width, first.bounds.height),
            (112 * 64, 58 * 64)
        );
        let stage = geometry
            .containers
            .iter()
            .find(|container| container.id == "stage:0")
            .unwrap();
        assert_eq!((stage.bounds.x, stage.bounds.y), (16 * 64, 46 * 64));
        assert_eq!(
            (stage.bounds.width, stage.bounds.height),
            (168 * 64, 600 * 64)
        );
    }

    #[test]
    fn label_segment_index_never_saturates_to_another_segment() {
        assert_eq!(label_segment(Some(3.0)).unwrap(), Some(3));
        assert!(label_segment(Some(1e30)).is_err());
        assert!(label_segment(Some(0.5)).is_err());
    }
}
