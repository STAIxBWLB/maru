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

    // Boundary frames derive from members and are not independent pin targets.
    for (index, boundary) in spec.boundaries.iter().enumerate() {
        scene.container_for_members(
            &format!("boundary:{index}"),
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
    fn authored_positions_override_grid_and_boundary_ordinals_are_deterministic() {
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
        let boundary_id = "boundary:0";
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
    fn boundary_pin_is_ignored_even_after_membership_changes() {
        let mut source = serde_json::json!({"schema_version":1,"diagram_type":"architecture","meta":{"title":"Boundaries","output":"boundaries.html"},"components":[{"id":"a","type":"backend","label":"A","pos":[80,100]},{"id":"b","type":"database","label":"B","pos":[300,100]}],"boundaries":[{"kind":"region","label":"First","wraps":["a"]},{"kind":"security-group","label":"Second","wraps":["b"]}],"connections":[]});
        let old_hash = crate::spec_hash(&source.to_string());
        for iteration in 0..2 {
            if iteration == 1 {
                source["boundaries"][1]["wraps"]
                    .as_array_mut()
                    .unwrap()
                    .push("a".into());
            }
            let spec_json = source.to_string();
            let baseline = layout(&spec_json);
            assert!(baseline.ok, "{:?}", baseline.diagnostics);
            let report=crate::layout::layout_json(&serde_json::json!({"specJson":spec_json,"pinSet":{"sourceSpecSha256":old_hash,"pins":[{"targetId":"boundary:1","targetKind":"container","position":{"x":600*64,"y":400*64}}]}}).to_string());
            assert!(report.ok, "{:?}", report.diagnostics);
            assert_eq!(report.geometry, baseline.geometry);
            let dropped: Vec<_> = report
                .diagnostics
                .iter()
                .filter(|d| d.code == "document/pin-member-removed")
                .collect();
            assert_eq!(dropped.len(), 1);
            assert!(dropped[0]
                .message
                .contains("this container's position derives from its members"));
        }
    }
}
