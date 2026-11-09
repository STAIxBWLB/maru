//! Deterministic architecture node placement, boundaries, and route requests.

use crate::architecture::ArchitectureSpec;
use crate::common::Point;
use crate::geometry::{GeometryBox, GeometryPoint};
use crate::layout::fixed::{checked_add, checked_sub};
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
        .unwrap_or([40.0, 80.0]);
    let cell_w = layout.and_then(|layout| layout.cell_w).unwrap_or(130.0);
    let cell_h = layout.and_then(|layout| layout.cell_h).unwrap_or(64.0);
    let gap_x = layout.and_then(|layout| layout.gap_x).unwrap_or(30.0);
    let gap_y = layout.and_then(|layout| layout.gap_y).unwrap_or(40.0);
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
            Some(component.size.unwrap_or([120.0, 60.0])),
        )?;
    }

    // Boundary frames use the format's outer padding and extra bottom rail.
    for (index, boundary) in spec.boundaries.iter().enumerate() {
        let bounds = boundary_bounds(boundary, scene, index)?;
        scene.add_container(
            &format!("boundary:{index}"),
            &boundary.kind,
            &boundary.label,
            bounds,
        )?;
    }

    let route_ids = super::allocate_route_ids(
        "connection",
        spec.connections
            .iter()
            .map(|connection| connection.id.as_deref()),
    );
    for (index, (connection, id)) in spec.connections.iter().zip(route_ids).enumerate() {
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
            id,
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

fn boundary_bounds(
    boundary: &crate::architecture::ArchitectureBoundary,
    scene: &SceneBuilder,
    index: usize,
) -> Result<GeometryBox, Diagnostic> {
    let path = format!("/boundaries/{index}");
    let mut left = None;
    let mut top = None;
    let mut right = None;
    let mut bottom = None;
    for member in &boundary.wraps {
        let Some(bounds) = scene.node_bounds(member) else {
            return Err(geometry_error(
                &format!("{path}/wraps"),
                "wrapped component has no placed geometry",
            ));
        };
        let member_right = bounds
            .right()
            .map_err(|error| geometry_error(&path, error.to_string()))?;
        let member_bottom = bounds
            .bottom()
            .map_err(|error| geometry_error(&path, error.to_string()))?;
        left = Some(left.map_or(bounds.x, |value: i32| value.min(bounds.x)));
        top = Some(top.map_or(bounds.y, |value: i32| value.min(bounds.y)));
        right = Some(right.map_or(member_right, |value: i32| value.max(member_right)));
        bottom = Some(bottom.map_or(member_bottom, |value: i32| value.max(member_bottom)));
    }
    let (Some(left), Some(top), Some(right), Some(bottom)) = (left, top, right, bottom) else {
        return Err(geometry_error(
            &format!("{path}/wraps"),
            "boundary has no placed members",
        ));
    };
    let pad = px(boundary.pad.unwrap_or(30.0))?;
    let top_pad = px(boundary.pad.unwrap_or(30.0).max(22.0))?;
    let bottom_extra = px(20.0)?;
    let width = checked_add(
        checked_sub(right, left).map_err(|error| geometry_error(&path, error.to_string()))?,
        checked_add(pad, pad).map_err(|error| geometry_error(&path, error.to_string()))?,
    )
    .map_err(|error| geometry_error(&path, error.to_string()))?;
    let height = checked_add(
        checked_sub(bottom, top).map_err(|error| geometry_error(&path, error.to_string()))?,
        checked_add(top_pad, bottom_extra)
            .map_err(|error| geometry_error(&path, error.to_string()))?,
    )
    .map_err(|error| geometry_error(&path, error.to_string()))?;
    let bounds = GeometryBox {
        x: checked_sub(left, pad).map_err(|error| geometry_error(&path, error.to_string()))?,
        y: checked_sub(top, top_pad).map_err(|error| geometry_error(&path, error.to_string()))?,
        width,
        height,
    };
    bounds
        .right()
        .and_then(|_| bounds.bottom())
        .map_err(|error| geometry_error(&path, error.to_string()))?;
    Ok(bounds)
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
            r#"{"schema_version":1,"diagram_type":"architecture","meta":{"title":"Architecture","output":"architecture.html"},"layout":{"mode":"grid","cols":2,"origin":[30,50],"cellW":100,"cellH":80,"gapX":20,"gapY":15},"components":[{"id":"authored","type":"backend","label":"Authored","sublabel":"Details","tag":"Primary","pos":[400,80]},{"id":"grid","type":"database","label":"Grid","row":0,"col":1}],"boundaries":[{"kind":"region","label":"Region","wraps":["authored","grid"]}],"connections":[{"id":"connect","from":"grid","to":"authored","fromSide":"right","toSide":"left","route":"orthogonal-h"}]}"#,
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
        assert!(geometry.labels.iter().any(|label| label.text == "Details"));
        assert!(geometry.labels.iter().any(|label| label.text == "Primary"));
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
    fn default_grid_uses_documented_origin_step_and_component_size() {
        let report = layout(
            r#"{"schema_version":1,"diagram_type":"architecture","meta":{"title":"Architecture","output":"architecture.html"},"layout":{"mode":"grid","cols":2},"components":[{"id":"first","type":"backend","label":"First","row":0,"col":0},{"id":"second","type":"database","label":"Second","row":0,"col":1}],"connections":[]}"#,
        );
        assert!(report.ok, "{:?}", report.diagnostics);
        let nodes = report.geometry.unwrap().nodes;
        let first = nodes.iter().find(|node| node.id == "first").unwrap();
        let second = nodes.iter().find(|node| node.id == "second").unwrap();
        assert_eq!((first.bounds.x, first.bounds.y), (40 * 64, 80 * 64));
        assert_eq!(
            (first.bounds.width, first.bounds.height),
            (120 * 64, 60 * 64)
        );
        assert_eq!((second.bounds.x, second.bounds.y), (200 * 64, 80 * 64));
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
