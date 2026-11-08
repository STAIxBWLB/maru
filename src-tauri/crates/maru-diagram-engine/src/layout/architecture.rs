//! Deterministic architecture node placement, boundaries, and route requests.

use crate::architecture::ArchitectureSpec;
use crate::common::Point;
use crate::geometry::GeometryPoint;
use crate::layout::{point, px, RouteRequest, SceneBuilder};
use crate::Diagnostic;

fn geometry_error(path: &str, cause: impl Into<String>) -> Diagnostic {
    crate::diagnostic(
        "architecture/layout-range",
        path,
        "architecture-layout-v1/range",
        cause,
        "reduce authored coordinates or grid spacing to fit the supported fixed-point range",
    )
}

fn automatic_point(
    origin: Point,
    row: f64,
    col: f64,
    cell: Point,
    gap: Point,
    path: &str,
) -> Result<GeometryPoint, Diagnostic> {
    let [cell_w, cell_h] = cell;
    let [gap_x, gap_y] = gap;
    let x = origin[0] + col * (cell_w + gap_x);
    let y = origin[1] + row * (cell_h + gap_y);
    if !x.is_finite() || !y.is_finite() {
        return Err(geometry_error(path, "grid position is not finite"));
    }
    point(x, y).map_err(|error| geometry_error(path, error.message))
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

pub(crate) fn place(spec: &ArchitectureSpec, scene: &mut SceneBuilder) -> Result<(), Diagnostic> {
    let layout = spec.layout.as_ref();
    let origin = layout
        .and_then(|layout| layout.origin)
        .unwrap_or([60.0, 160.0]);
    let cell_w = layout.and_then(|layout| layout.cell_w).unwrap_or(220.0);
    let cell_h = layout.and_then(|layout| layout.cell_h).unwrap_or(100.0);
    let gap_x = layout.and_then(|layout| layout.gap_x).unwrap_or(80.0);
    let gap_y = layout.and_then(|layout| layout.gap_y).unwrap_or(60.0);
    let cols = f64::from(layout.and_then(|layout| layout.cols).unwrap_or(4));

    for (index, component) in spec.components.iter().enumerate() {
        let path = format!("/components/{index}");
        let auto = if let Some(pin) = scene.pinned_position(&component.id) {
            pin
        } else if let Some(pos) = component.pos {
            point(pos[0], pos[1])?
        } else {
            automatic_point(
                origin,
                component.row.unwrap_or((index as f64 / cols).floor()),
                component.col.unwrap_or(index as f64 % cols),
                [cell_w, cell_h],
                [gap_x, gap_y],
                &path,
            )?
        };
        scene.add_node(
            &component.id,
            &component.component_type,
            &component.label,
            component.decoration.sublabel.as_deref(),
            component.decoration.tag.as_deref(),
            component.pos,
            auto,
            component.size,
        )?;
    }

    // Anonymous identity survives removals before this boundary.
    let boundary_ids = super::anonymous_ids("boundary", &spec.boundaries)?;
    for (boundary, id) in spec.boundaries.iter().zip(boundary_ids) {
        scene.container_for_members(
            &id,
            &boundary.kind,
            &boundary.label,
            &boundary.wraps,
            boundary.pad.unwrap_or(16.0),
        )?;
    }

    for (index, connection) in spec.connections.iter().enumerate() {
        let path = format!("/connections/{index}");
        let waypoints = connection
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
        let label_at = connection
            .label_at
            .map(|coordinates| point(coordinates[0], coordinates[1]))
            .transpose()
            .map_err(|error| geometry_error(&format!("{path}/labelAt"), error.message))?;
        scene.connection(RouteRequest {
            id: connection
                .id
                .clone()
                .unwrap_or_else(|| format!("connection:{index}")),
            from: connection.from.clone(),
            to: connection.to.clone(),
            label: connection.label.clone(),
            from_side: connection.from_side.clone(),
            to_side: connection.to_side.clone(),
            waypoints,
            label_at,
            route: connection.route.clone(),
            label_dx: connection
                .label_dx
                .map(px)
                .transpose()
                .map_err(|error| geometry_error(&format!("{path}/labelDx"), error.message))?,
            label_dy: connection
                .label_dy
                .map(px)
                .transpose()
                .map_err(|error| geometry_error(&format!("{path}/labelDy"), error.message))?,
            label_segment: segment_index(
                connection.label_segment,
                &format!("{path}/labelSegment"),
            )?,
            variant: connection.variant.clone(),
            width: connection
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
    use super::*;
    use crate::geometry::GeometryPositionSource;

    fn layout(spec: &str) -> crate::geometry::GeometryReport {
        let request = serde_json::json!({ "specJson": spec });
        crate::layout::layout_json(&request.to_string())
    }

    #[test]
    fn authored_positions_override_grid_and_boundary_keys_are_stable() {
        let report = layout(
            r#"{"schema_version":1,"diagram_type":"architecture","meta":{"title":"Architecture","output":"architecture.html"},"layout":{"mode":"grid","cols":2,"origin":[30,50],"cellW":100,"cellH":80,"gapX":20,"gapY":15},"components":[{"id":"authored","type":"backend","label":"Authored","pos":[400,80]},{"id":"grid","type":"database","label":"Grid","row":0,"col":1}],"boundaries":[{"kind":"region","label":"Region","wraps":["authored","grid"]}],"connections":[{"id":"connect","from":"grid","to":"authored","fromSide":"right","toSide":"left","route":"orthogonal-h"}]}"#,
        );
        assert!(report.ok, "{:?}", report.diagnostics);
        let geometry = report.geometry.unwrap();
        let authored = geometry
            .nodes
            .iter()
            .find(|node| node.id == "authored")
            .unwrap();
        let grid = geometry
            .nodes
            .iter()
            .find(|node| node.id == "grid")
            .unwrap();
        assert_eq!(
            authored.position_source,
            GeometryPositionSource::AuthoredPosition
        );
        assert_eq!((authored.bounds.x, authored.bounds.y), (400 * 64, 80 * 64));
        assert_eq!(grid.position_source, GeometryPositionSource::Automatic);
        assert_eq!((grid.bounds.x, grid.bounds.y), (150 * 64, 50 * 64));
        let typed: ArchitectureSpec = serde_json::from_str(
            r#"{"schema_version":1,"diagram_type":"architecture","meta":{"title":"Architecture","output":"architecture.html"},"layout":{"mode":"grid","cols":2,"origin":[30,50],"cellW":100,"cellH":80,"gapX":20,"gapY":15},"components":[{"id":"authored","type":"backend","label":"Authored","pos":[400,80]},{"id":"grid","type":"database","label":"Grid","row":0,"col":1}],"boundaries":[{"kind":"region","label":"Region","wraps":["authored","grid"]}],"connections":[]}"#,
        )
        .unwrap();
        let boundary_id = super::super::anonymous_ids("boundary", &typed.boundaries)
            .unwrap()
            .remove(0);
        assert_eq!(geometry.routes.len(), 1);
        assert_eq!(geometry.routes[0].id.as_deref(), Some("connect"));
        assert!(geometry
            .containers
            .iter()
            .any(|container| container.id == boundary_id));
    }

    #[test]
    fn rejects_grid_positions_outside_the_fixed_point_range() {
        assert!(automatic_point(
            [0.0, 0.0],
            1e30,
            0.0,
            [220.0, 100.0],
            [80.0, 60.0],
            "/components/0"
        )
        .is_err());
    }

    #[test]
    fn removing_an_earlier_boundary_preserves_survivor_identity_and_pin() {
        let full: ArchitectureSpec = serde_json::from_str(
            r#"{"schema_version":1,"diagram_type":"architecture","meta":{"title":"Boundaries","output":"boundaries.html"},"components":[{"id":"a","type":"backend","label":"A","pos":[80,100]},{"id":"b","type":"database","label":"B","pos":[300,100]}],"boundaries":[{"kind":"region","label":"First","wraps":["a"]},{"kind":"security-group","label":"Second","wraps":["b"]}],"connections":[]}"#,
        )
        .unwrap();
        let original_ids = super::super::anonymous_ids("boundary", &full.boundaries).unwrap();
        let survivor_id = original_ids[1].clone();
        let mut remaining = full.clone();
        remaining.boundaries.remove(0);
        let remaining_ids = super::super::anonymous_ids("boundary", &remaining.boundaries).unwrap();
        assert_eq!(remaining_ids[0], survivor_id);

        // Keep source omission semantics; serializing the Rust model would
        // introduce explicit nulls that document validation correctly refuses.
        let mut source = serde_json::json!({"schema_version":1,"diagram_type":"architecture","meta":{"title":"Boundaries","output":"boundaries.html"},"components":[{"id":"a","type":"backend","label":"A","pos":[80,100]},{"id":"b","type":"database","label":"B","pos":[300,100]}],"boundaries":[{"kind":"region","label":"First","wraps":["a"]},{"kind":"security-group","label":"Second","wraps":["b"]}],"connections":[]});
        source["boundaries"].as_array_mut().unwrap().remove(0);
        let spec_json = source.to_string();
        let request = serde_json::json!({
            "specJson": spec_json,
            "pinSet": {
                "sourceSpecSha256": crate::spec_hash(&spec_json),
                "pins": [{
                    "targetId": survivor_id,
                    "targetKind": "container",
                    "position": {"x": 600 * 64, "y": 400 * 64}
                }]
            }
        });
        let report = crate::layout::layout_json(&request.to_string());
        assert!(report.ok, "{:?}", report.diagnostics);
        let container = report
            .geometry
            .unwrap()
            .containers
            .into_iter()
            .find(|container| container.id == survivor_id)
            .unwrap();
        assert_eq!(
            (container.bounds.x, container.bounds.y),
            (600 * 64, 400 * 64)
        );
    }
}
