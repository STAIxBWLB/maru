//! Deterministic participant columns and authored-time sequence ranges.

use super::{point, px, RouteRequest, SceneBuilder};
use crate::geometry::{GeometryBox, GeometryPoint};
use crate::sequence::SequenceSpec;
use crate::Diagnostic;

const HEADER_WIDTH: f64 = 180.0;
const HEADER_HEIGHT: f64 = 72.0;
const MARGIN: f64 = 64.0;
const COLUMN_STEP: f64 = 244.0;

fn geometry_error(path: &str, cause: impl Into<String>) -> Diagnostic {
    crate::diagnostic(
        "sequence/layout-range",
        path,
        "sequence-layout-v1/range",
        cause,
        "keep sequence coordinates and ranges inside the supported fixed-point extent",
    )
}

fn center(bounds: GeometryBox) -> Result<GeometryPoint, Diagnostic> {
    let x = f64::from(bounds.x) / 64.0 + f64::from(bounds.width) / 128.0;
    let y = f64::from(bounds.y) / 64.0 + f64::from(bounds.height) / 128.0;
    point(x, y)
}

fn range_box(
    x: f64,
    width: f64,
    from: f64,
    to: f64,
    path: &str,
) -> Result<GeometryBox, Diagnostic> {
    if to <= from {
        return Err(geometry_error(
            path,
            "sequence range end is not after its start",
        ));
    }
    let bounds = GeometryBox {
        x: px(x)?,
        y: px(from)?,
        width: px(width)?,
        height: px(to - from)?,
    };
    bounds
        .right()
        .and_then(|_| bounds.bottom())
        .map_err(|error| geometry_error(path, error.to_string()))?;
    Ok(bounds)
}

pub(crate) fn place(spec: &SequenceSpec, scene: &mut SceneBuilder) -> Result<(), Diagnostic> {
    let count = spec.participants.len();
    if count == 0 {
        return Err(geometry_error(
            "/participants",
            "sequence has no participants to place",
        ));
    }
    let spread = spec.meta.column_fit.as_deref() == Some("spread");
    let step = if spread && count > 1 {
        spec.meta
            .view_box
            .map(|size| (size[0] - MARGIN * 2.0 - HEADER_WIDTH) / (count - 1) as f64)
            .unwrap_or(COLUMN_STEP)
            .max(COLUMN_STEP)
    } else {
        COLUMN_STEP
    };
    let mut left = f64::INFINITY;
    let mut right = f64::NEG_INFINITY;
    for (index, participant) in spec.participants.iter().enumerate() {
        let bounds = scene.add_node(
            &participant.id,
            &participant.component_type,
            &participant.label,
            participant.decoration.sublabel.as_deref(),
            participant.decoration.tag.as_deref(),
            None,
            point(MARGIN + index as f64 * step, 64.0)?,
            Some([HEADER_WIDTH, HEADER_HEIGHT]),
        )?;
        left = left.min(f64::from(bounds.x) / 64.0);
        right = right.max(
            f64::from(
                bounds
                    .right()
                    .map_err(|error| geometry_error("/participants", error.to_string()))?,
            ) / 64.0,
        );
    }
    let route_ids = super::allocate_route_ids(
        "message",
        spec.messages.iter().map(|message| message.id.as_deref()),
    );
    for (index, message) in spec.messages.iter().enumerate() {
        let label = match &message.note {
            Some(note) if !note.is_empty() => format!("{}\n{note}", message.label),
            _ => message.label.clone(),
        };
        let y = px(message.y)?;
        scene.connection(RouteRequest {
            id: route_ids[index].clone(),
            from: message.from.clone(),
            to: message.to.clone(),
            label: Some(label),
            from_y: Some(y),
            to_y: Some(y),
            variant: message.variant.clone(),
            ..Default::default()
        });
    }
    for (index, segment) in spec.segments.iter().enumerate() {
        scene.add_container(
            &format!("segment:{index}"),
            "segment",
            &segment.label,
            range_box(
                left - 24.0,
                right - left + 48.0,
                segment.from,
                segment.to,
                &format!("/segments/{index}"),
            )?,
        )?;
    }
    for (index, activation) in spec.activations.iter().enumerate() {
        let bounds = scene.node_bounds(&activation.participant).ok_or_else(|| {
            geometry_error(
                &format!("/activations/{index}/participant"),
                "activation participant has no placed header",
            )
        })?;
        let midpoint = center(bounds)?;
        scene.add_container(
            &format!("activation:{index}"),
            "activation",
            "",
            range_box(
                f64::from(midpoint.x) / 64.0 - 7.0,
                14.0,
                activation.from,
                activation.to,
                &format!("/activations/{index}"),
            )?,
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> serde_json::Value {
        serde_json::json!({
            "schema_version":1,"diagram_type":"sequence",
            "meta":{"title":"Sequence","output":"sequence.html"},
            "participants":[{"id":"client","type":"frontend","label":"Client"},{"id":"api","type":"backend","label":"API"}],
            "messages":[{"id":"request","from":"client","to":"api","y":300,"label":"Request"}],
            "segments":[{"from":150,"to":700,"label":"Session"}],
            "activations":[{"participant":"api","from":220,"to":800}]
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
    fn sequence_text_includes_participant_details_message_notes_and_segment_labels() {
        let mut source = spec();
        source["participants"][0]["sublabel"] = "Browser".into();
        source["messages"][0]["note"] = "PII".into();
        let geometry = layout(&source, None);
        for text in ["Client", "Browser", "API", "Request\nPII", "Session"] {
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
        assert!(!geometry
            .labels
            .iter()
            .any(|label| label.target_id == "activation:0"));
    }

    #[test]
    fn sequence_anonymous_route_id_does_not_alias_an_authored_id() {
        let mut source = spec();
        source["messages"][0].as_object_mut().unwrap().remove("id");
        source["messages"].as_array_mut().unwrap().push(serde_json::json!({"id":"message-0","from":"api","to":"client","y":450,"label":"Reply"}));
        let geometry = layout(&source, None);
        let ids: std::collections::HashSet<_> = geometry
            .routes
            .iter()
            .map(|route| route.id.as_deref().unwrap())
            .collect();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains("message-0"));
    }

    #[test]
    fn sequence_layout_uses_lifeline_centers_and_full_authored_ranges() {
        let geometry = layout(&spec(), None);
        let route = geometry
            .routes
            .iter()
            .find(|route| route.id.as_deref() == Some("request"))
            .unwrap();
        assert!(route
            .points
            .windows(2)
            .all(|pair| pair[0].x == pair[1].x || pair[0].y == pair[1].y));
        let client = geometry
            .nodes
            .iter()
            .find(|node| node.id == "client")
            .unwrap();
        let api = geometry.nodes.iter().find(|node| node.id == "api").unwrap();
        assert_eq!(
            route.points.first().unwrap().x,
            center(client.bounds).unwrap().x
        );
        assert_eq!(
            route.points.last().unwrap().x,
            center(api.bounds).unwrap().x
        );
        assert_eq!(route.points.first().unwrap().y, px(300.0).unwrap());
        let segment = geometry
            .containers
            .iter()
            .find(|container| container.id == "segment:0")
            .unwrap();
        let activation = geometry
            .containers
            .iter()
            .find(|container| container.id == "activation:0")
            .unwrap();
        assert_eq!(segment.bounds.y, px(150.0).unwrap());
        assert_eq!(segment.bounds.bottom().unwrap(), px(700.0).unwrap());
        assert_eq!(activation.bounds.bottom().unwrap(), px(800.0).unwrap());
    }

    #[test]
    fn sequence_pin_survives_an_unrelated_message_edit() {
        let mut source = spec();
        let original = crate::validate_json(&source.to_string())
            .receipt
            .input_spec_sha256;
        let pins = serde_json::json!({"sourceSpecSha256":original,"pins":[{"targetId":"api","targetKind":"node","position":{"x":px(600.0).unwrap(),"y":px(64.0).unwrap()}}]});
        let before = layout(&source, Some(pins.clone()));
        source["messages"][0]["label"] = "Updated".into();
        let after = layout(&source, Some(pins));
        let bounds = |geometry: &crate::geometry::GeometryDocument| {
            geometry
                .nodes
                .iter()
                .find(|node| node.id == "api")
                .unwrap()
                .bounds
        };
        assert_eq!(bounds(&before), bounds(&after));
        assert_eq!(bounds(&after).x, px(600.0).unwrap());
        let activation = after
            .containers
            .iter()
            .find(|container| container.id == "activation:0")
            .unwrap();
        assert_eq!(
            activation.bounds.x + activation.bounds.width / 2,
            center(bounds(&after)).unwrap().x
        );
    }

    #[test]
    fn ranges_keep_authored_extents_outside_the_message_timeline() {
        let bounds = range_box(50.0, 300.0, 120.0, 900.0, "/segments/0").unwrap();
        assert_eq!(bounds.y, px(120.0).unwrap());
        assert_eq!(bounds.bottom().unwrap(), px(900.0).unwrap());
    }

    #[test]
    fn range_conversion_refuses_overflow_instead_of_clamping() {
        assert!(range_box(0.0, 100.0, 160.0, 1e20, "/segments/0").is_err());
        assert!(range_box(0.0, 100.0, 200.0, 160.0, "/segments/0").is_err());
    }
}
