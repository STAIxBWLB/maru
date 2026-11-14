//! Deterministic nested Floorplan placement and its layout entry point
//! (`maru#553` E5 T2).
//!
//! A Floorplan map is a tree, not a row of peers: the document nests nodes with
//! `parent`, and the drawing has to show that nesting. The construction is the
//! application's own nested layout (`layoutFloorplan` in
//! `src/lib/diagram/floorplan.ts`, drawn on the canvas since `maru#535`) moved
//! into the engine: a leaf is one grid cell, a node with children is a frame
//! around them, children sit in rows of three, and every frame is sized from the
//! cells it holds rather than from an authored canvas size. Only the cell size
//! and the vertical origin differ from the canvas, because the emitted header
//! band above the map is Maru page chrome that the canvas does not carry.
//!
//! Edges reuse E2's route requests, so an edge crosses frame borders: a frame is
//! a container, and the router treats only `card` containers as obstacles. The
//! E3 writer paints the finished document, so a rendered map needs no Floorplan
//! branch in the writer.
//!
//! Flows and tours stay overlays: they are part of the document and never an
//! input to placed geometry, so adding, editing or removing one cannot move a
//! cell (`flows_and_tours_are_overlays_the_layout_ignores`).

use super::{
    add, arithmetic, failure, point, px, rect, typed, Coord, RouteRequest, SceneBuilder,
    HEADER_GAP, NODE_TEXT_INSET,
};
use crate::common::Meta;
use crate::floorplan::{FloorplanNode, FloorplanSpec};
use crate::geometry::{GeometryPoint, GeometryPrimitive, GeometryReport};
use crate::Diagnostic;
use std::collections::{HashMap, HashSet};

/// Columns the reference layout puts top-level cells in.
const TOP_COLUMNS: usize = 3;
/// Columns a frame puts its children in.
const CHILD_COLUMNS: usize = 3;
/// One leaf cell's width: the reference's `NODE_W`.
const COLUMN_W: Coord = 160 * 64;
/// The reference's `NODE_H`, kept as the floor a measured cell height holds.
const MIN_NODE_H: Coord = 64 * 64;
/// The reference's `GAP`, between cells and between rows.
const GAP: Coord = 16 * 64;
/// The reference's `INSET`, as the padding a frame keeps on each side.
const INSET: Coord = 24 * 64;
/// The reference's `HEADER`, kept as the shortest title band a frame may have.
const HEADER_MIN: Coord = 32 * 64;
/// Vertical padding inside a frame's title band, above and below its text.
const HEADER_PAD: Coord = 8 * 64;
/// Left edge of the map: the reference's `ORIGIN.x`. The vertical origin is the
/// measured header band instead, so a two-line project summary cannot land on
/// the first row of cells.
const ORIGIN_X: f64 = 40.0;
/// A leaf's vertical padding: `add_node`'s 28 px, which that call adds to the
/// measured label and detail heights.
const LEAF_PAD: Coord = 28 * 64;
/// The band a map's title and subtitle are emitted at, and the type they use,
/// matching every other family.
const TITLE_SIZE: Coord = 24 * 64;
const SUBTITLE_SIZE: Coord = 12 * 64;
const SUBTITLE_WRAP_X: f64 = 920.0;
/// Deepest nesting the layout will place. `measure` and `place_rows` walk one
/// level per call, and validation only requires that a parent exists and forms no
/// cycle, so an acyclic chain past this would overflow the stack: the app or the
/// WASM instance aborts instead of refusing. Real maps nest a handful of levels.
const MAX_NESTING_DEPTH: usize = 64;

/// One placed cell, in emitted coordinates.
#[derive(Clone, Copy)]
struct Cell {
    x: Coord,
    y: Coord,
    width: Coord,
    height: Coord,
    /// Height of the title band a frame keeps above its children; 0 for a leaf.
    header: Coord,
    /// Nesting depth, so parents paint before the cells they hold.
    depth: usize,
}

/// The document's nesting as a tree: a first-occurrence id map, one parent per
/// node, and the children of each node.
struct Tree {
    roots: Vec<usize>,
    children: Vec<Vec<usize>>,
}

impl Tree {
    /// Build the tree the way the reference does, so a document the layout is
    /// asked to draw without validation cannot loop: a node whose parent is
    /// itself, whose parent id is absent, or whose parent chain returns to it is
    /// placed at the top level, and a later duplicate of an id is not placed.
    fn new(spec: &FloorplanSpec) -> Self {
        let mut index_of: HashMap<&str, usize> = HashMap::new();
        for (index, node) in spec.nodes.iter().enumerate() {
            index_of.entry(node.id.as_str()).or_insert(index);
        }
        let mut roots = Vec::new();
        let mut children: Vec<Vec<usize>> = vec![Vec::new(); spec.nodes.len()];
        for (index, node) in spec.nodes.iter().enumerate() {
            if index_of.get(node.id.as_str()) != Some(&index) {
                continue;
            }
            let parent = node
                .parent
                .as_deref()
                .and_then(|id| index_of.get(id).copied())
                .filter(|parent| {
                    *parent != index && !Self::cycles(spec, &index_of, index, *parent)
                });
            match parent {
                Some(parent) => children[parent].push(index),
                None => roots.push(index),
            }
        }
        Self { roots, children }
    }

    fn cycles(
        spec: &FloorplanSpec,
        index_of: &HashMap<&str, usize>,
        index: usize,
        parent: usize,
    ) -> bool {
        let mut seen = HashSet::new();
        seen.insert(index);
        let mut current = Some(parent);
        while let Some(step) = current {
            if !seen.insert(step) {
                return true;
            }
            current = spec.nodes[step]
                .parent
                .as_deref()
                .and_then(|id| index_of.get(id).copied());
        }
        false
    }
}

/// Rows of at most `columns` items, in document order.
fn rows(items: &[usize], columns: usize) -> Vec<Vec<usize>> {
    let mut rows: Vec<Vec<usize>> = Vec::new();
    for (position, item) in items.iter().enumerate() {
        if position % columns == 0 {
            rows.push(Vec::new());
        }
        rows.last_mut()
            .expect("a row was pushed for this position")
            .push(*item);
    }
    rows
}

/// The deepest level any node sits at, walked with an explicit stack so the check
/// itself cannot overflow the stack it is guarding.
fn nesting_depth(tree: &Tree) -> usize {
    let mut deepest = 0;
    let mut pending: Vec<(usize, usize)> = tree.roots.iter().map(|root| (*root, 0)).collect();
    while let Some((index, depth)) = pending.pop() {
        deepest = deepest.max(depth);
        pending.extend(tree.children[index].iter().map(|child| (*child, depth + 1)));
    }
    deepest
}

/// A leaf's cell: the reference's fixed column, and the height its own label and
/// summary need at the same type and wrapping `add_node` will use.
fn leaf_size(scene: &SceneBuilder, node: &FloorplanNode) -> Result<(Coord, Coord), Diagnostic> {
    let available = COLUMN_W - NODE_TEXT_INSET;
    let label = scene
        .wrap_node_text(&node.label, 700, 13 * 64, available, false)?
        .1;
    let detail = match node.summary.as_deref().filter(|text| !text.is_empty()) {
        Some(text) => {
            scene
                .wrap_node_text(text, 400, 11 * 64, available, false)?
                .1
        }
        None => 0,
    };
    let height = add(add(label, detail)?, LEAF_PAD)?.max(MIN_NODE_H);
    Ok((COLUMN_W, height))
}

/// A frame's title band: its label wrapped inside the frame's own inner width,
/// one inset above the children, and never shorter than the reference's header.
fn header_height(scene: &SceneBuilder, label: &str, inner: Coord) -> Result<Coord, Diagnostic> {
    if label.is_empty() {
        return Ok(HEADER_MIN);
    }
    let available = add(inner, -NODE_TEXT_INSET)?;
    let text = scene
        .wrap_node_text(label, 700, 13 * 64, available, false)?
        .1;
    Ok(add(add(text, HEADER_PAD)?, HEADER_PAD)?.max(HEADER_MIN))
}

fn coord_px(value: Coord) -> Result<f64, Diagnostic> {
    Ok(f64::from(value) / super::FIXED_UNITS_PER_PIXEL as f64)
}

/// The page metadata a map is finished with: its project name and summary, and
/// nothing the other families' presets or quality profiles turn on.
fn meta(title: String, subtitle: Option<String>) -> Meta {
    Meta {
        title,
        output: "svg".into(),
        locale: None,
        translations: None,
        subtitle,
        animation: None,
        visual_preset: None,
        quality_profile: None,
        engineering_profile: None,
        column_fit: None,
        repository: None,
        views: None,
        legend: None,
        view_box: None,
    }
}

/// Measure one subtree, bottom up. A frame is sized from the cells it will hold,
/// which is what makes the nesting compound rather than fixed.
fn measure(
    scene: &SceneBuilder,
    spec: &FloorplanSpec,
    tree: &Tree,
    sizes: &mut [Option<(Coord, Coord, Coord)>],
    index: usize,
) -> Result<(Coord, Coord, Coord), Diagnostic> {
    if let Some(size) = sizes[index] {
        return Ok(size);
    }
    let children = &tree.children[index];
    let size = if children.is_empty() {
        let (width, height) = leaf_size(scene, &spec.nodes[index])?;
        (width, height, 0)
    } else {
        let mut widest = COLUMN_W;
        let mut tallest = Vec::new();
        for row in rows(children, CHILD_COLUMNS) {
            let mut width = 0;
            let mut height = 0;
            for (position, child) in row.iter().enumerate() {
                let (cell_width, cell_height, _) = measure(scene, spec, tree, sizes, *child)?;
                if position > 0 {
                    width = add(width, GAP)?;
                }
                width = add(width, cell_width)?;
                height = height.max(cell_height);
            }
            widest = widest.max(width);
            tallest.push(height);
        }
        let header = header_height(scene, &spec.nodes[index].label, widest)?;
        let mut height = header;
        for (position, row_height) in tallest.iter().enumerate() {
            if position > 0 {
                height = add(height, GAP)?;
            }
            height = add(height, *row_height)?;
        }
        // One inset below the last row closes the frame's padding.
        height = add(height, INSET)?;
        let width = add(widest, add(INSET, INSET)?)?;
        (width, height, header)
    };
    sizes[index] = Some(size);
    Ok(size)
}

#[allow(clippy::too_many_arguments)]
fn place_rows(
    tree: &Tree,
    sizes: &[Option<(Coord, Coord, Coord)>],
    items: &[usize],
    x0: Coord,
    y0: Coord,
    depth: usize,
    columns: usize,
    cells: &mut [Option<Cell>],
) -> Result<(), Diagnostic> {
    let mut y = y0;
    for row in rows(items, columns) {
        let mut x = x0;
        let mut row_height = 0;
        for item in &row {
            let (width, height, header) =
                sizes[*item].expect("every node is measured before anything is placed");
            cells[*item] = Some(Cell {
                x,
                y,
                width,
                height,
                header,
                depth,
            });
            if !tree.children[*item].is_empty() {
                let inner_x = add(x, INSET)?;
                let inner_y = add(y, header)?;
                place_rows(
                    tree,
                    sizes,
                    &tree.children[*item],
                    inner_x,
                    inner_y,
                    depth + 1,
                    CHILD_COLUMNS,
                    cells,
                )?;
            }
            x = add(x, width)?;
            x = add(x, GAP)?;
            row_height = row_height.max(height);
        }
        y = add(y, row_height)?;
        y = add(y, GAP)?;
    }
    Ok(())
}

/// Place one map: frames around their children, one member per node, and one
/// route request per edge.
pub(crate) fn place(
    spec: &FloorplanSpec,
    scene: &mut SceneBuilder,
    origin: GeometryPoint,
) -> Result<(), Diagnostic> {
    let tree = Tree::new(spec);
    let deepest = nesting_depth(&tree);
    if deepest > MAX_NESTING_DEPTH {
        let fix = format!(
            "flatten the deepest frames to {MAX_NESTING_DEPTH} levels or fewer, or split the map into several documents"
        );
        return Err(failure(
            "nesting-depth",
            format!(
                "the map nests {deepest} levels deep, past the {MAX_NESTING_DEPTH} levels this layout places"
            ),
            &fix,
        ));
    }
    let mut sizes: Vec<Option<(Coord, Coord, Coord)>> = vec![None; spec.nodes.len()];
    for index in 0..spec.nodes.len() {
        measure(scene, spec, &tree, &mut sizes, index)?;
    }
    let mut cells: Vec<Option<Cell>> = vec![None; spec.nodes.len()];
    place_rows(
        &tree,
        &sizes,
        &tree.roots,
        origin.x,
        origin.y,
        0,
        TOP_COLUMNS,
        &mut cells,
    )?;

    // Parents paint before the cells they hold, so a frame never covers a child.
    let mut order: Vec<usize> = (0..spec.nodes.len())
        .filter(|index| cells[*index].is_some())
        .collect();
    order.sort_by_key(|index| (cells[*index].expect("filtered above").depth, *index));
    for index in order {
        let cell = cells[index].expect("filtered above");
        let node = &spec.nodes[index];
        let automatic = GeometryPoint {
            x: cell.x,
            y: cell.y,
        };
        if cell.header > 0 {
            // A frame is a container, so a route may cross its border, and the
            // node itself is the title band inside it: that keeps the section an
            // edge endpoint the router can reach without making the frame an
            // obstacle around its own children.
            let inner = add(cell.width, add(-INSET, -INSET)?)?;
            scene.add_container(
                &format!("{}:section", node.id),
                "group",
                "",
                rect(cell.x, cell.y, cell.width, cell.height)?,
            )?;
            scene.add_node(
                &node.id,
                &node.kind,
                &node.label,
                None,
                None,
                None,
                GeometryPoint {
                    x: add(cell.x, INSET)?,
                    y: cell.y,
                },
                Some([coord_px(inner)?, coord_px(cell.header)?]),
                None,
            )?;
        } else {
            scene.add_node(
                &node.id,
                &node.kind,
                &node.label,
                node.summary.as_deref(),
                None,
                None,
                automatic,
                Some([coord_px(cell.width)?, coord_px(cell.height)?]),
                None,
            )?;
        }
    }

    let resolver = crate::floorplan::Resolver::new(spec);
    let edges = spec.edges.as_deref().unwrap_or_default();
    // Upstream edges mint no ids, so every route is named by its source ordinal.
    let ids = super::allocate_route_ids("edge", edges.iter().map(|_| None::<&str>));
    for (index, (edge, id)) in edges.iter().zip(ids).enumerate() {
        let (Some(from), Some(to)) = (resolver.resolve(&edge.from), resolver.resolve(&edge.to))
        else {
            // Document validity refuses an unresolvable endpoint before a scene
            // is placed, so this is only reachable on an unvalidated call.
            return Err(failure(
                "edge-reference",
                format!("edge {index} names no node and no file a node claims"),
                "point the edge at an existing node id, or add the file to the paths of the node that owns it",
            ));
        };
        scene.connection(RouteRequest {
            id,
            from: from.to_owned(),
            to: to.to_owned(),
            // The upstream kinds are the map's own vocabulary, not the writer's
            // variants: the kind travels as the route's role, and the two
            // asynchronous kinds take the dashed variant the canvas dashes.
            role: edge.kind.clone(),
            variant: match edge.kind.as_deref() {
                Some("event") | Some("queue") => Some("dashed".into()),
                _ => None,
            },
            // `edge.label` is validated and kept in the document but not
            // carried: no canvas paints a Floorplan edge label yet, and a route
            // label is placed before routing where an unplaceable one refuses
            // the map, so the painting decision stays with that canvas.
            ..RouteRequest::default()
        });
    }
    Ok(())
}

/// The header band's subtitle: the project summary wrapped to the page width the
/// band is laid out in, so a long summary is several lines rather than one line
/// thousands of pixels wide.
fn subtitle_lines(summary: Option<&str>) -> Result<Option<String>, Diagnostic> {
    let Some(text) = summary.filter(|text| !text.trim().is_empty()) else {
        return Ok(None);
    };
    let lines = crate::metrics::wrap_label_lines(
        text,
        400,
        SUBTITLE_SIZE,
        add(px(SUBTITLE_WRAP_X)?, -64 * 64)?,
        false,
    )?;
    Ok(Some(lines.join("\n")))
}

/// Lay out one `floorplan/architecture@1` document.
///
/// The request is the envelope the other families use (`{"specJson": …}`), so
/// the source hash and a pin set travel with it, but the document inside is the
/// upstream interchange JSON itself: it has no `diagram_type` and no `meta`. So
/// this entry point validates it with [`crate::validate_floorplan_json`] and
/// places it here, rather than through `layout_json`'s dispatch, which belongs to
/// the apply-gate switch (`maru#553` E5 T4).
pub fn layout_floorplan_json(input: &str) -> GeometryReport {
    let request = match crate::geometry::parse_layout_request(input) {
        Ok(request) => request,
        Err(diagnostics) => {
            return GeometryReport {
                api_version: 1,
                ok: false,
                geometry: None,
                diagnostics: diagnostics.clone(),
                receipt: crate::make_report(input, None, diagnostics).receipt,
            }
        }
    };
    let validity = crate::validate_floorplan_json(&request.spec_json);
    if !validity.ok {
        return GeometryReport {
            api_version: 1,
            ok: false,
            geometry: None,
            diagnostics: validity.diagnostics,
            receipt: validity.receipt,
        };
    }
    let value: serde_json::Value =
        serde_json::from_str(&request.spec_json).expect("validated JSON");
    let spec: FloorplanSpec = match typed(&value) {
        Ok(spec) => spec,
        Err(diagnostic) => {
            return GeometryReport {
                api_version: 1,
                ok: false,
                geometry: None,
                diagnostics: vec![diagnostic],
                receipt: validity.receipt,
            }
        }
    };
    let title = spec.project.name.clone();
    let subtitle = match subtitle_lines(spec.project.summary.as_deref()) {
        Ok(subtitle) => subtitle,
        Err(diagnostic) => {
            return GeometryReport {
                api_version: 1,
                ok: false,
                geometry: None,
                diagnostics: vec![diagnostic],
                receipt: validity.receipt,
            }
        }
    };
    let mut scene = SceneBuilder::new(request, "floorplan");
    let result = (|| {
        let mut band = scene
            .label(
                "title",
                "document",
                &title,
                point(32.0, 16.0)?,
                700,
                TITLE_SIZE,
            )?
            .bottom()
            .map_err(arithmetic)?;
        if let Some(text) = &subtitle {
            let subtitle_box = scene.label(
                "subtitle",
                "document",
                text,
                point(32.0, 54.0)?,
                400,
                SUBTITLE_SIZE,
            )?;
            band = band.max(subtitle_box.bottom().map_err(arithmetic)?);
        }
        // The map starts below the measured band, so a summary that wraps to
        // three lines still cannot land on the first row of cells.
        let origin_y = add(band, HEADER_GAP)?.max(72 * 64);
        place(
            &spec,
            &mut scene,
            GeometryPoint {
                x: px(ORIGIN_X)?,
                y: origin_y,
            },
        )?;
        scene.finish(&meta(title, subtitle))
    })();
    match result {
        Ok((mut geometry, mut diagnostics, ok)) => {
            // The map draws its members, frames, routes and labels from the
            // geometry itself; the only writing primitives the family has are
            // the legend swatches, and they come from the same pass every family
            // uses.
            let context = crate::floorplan::semantic_context(&spec);
            match crate::primitives::derive(&geometry, &context) {
                Ok(derived) => {
                    geometry.primitives = derived
                        .iter()
                        .filter(|primitive| primitive.layer == crate::primitives::Layer::Underlay)
                        .chain(
                            derived
                                .iter()
                                .filter(|primitive| {
                                    primitive.layer == crate::primitives::Layer::Overlay
                                }),
                        )
                        .map(GeometryPrimitive::from_derived)
                        .collect();
                }
                Err(cause) => diagnostics.push(Diagnostic {
                    code: "floorplan/primitive-source".into(),
                    path: "/specJson".into(),
                    rule: "geometry-v1/primitive-source".into(),
                    message: format!(
                        "the map's drawing primitives cannot be derived: {}",
                        cause.message
                    ),
                    fix: "repair the source document so the canvas can draw the legend the writer paints".into(),
                }),
            }
            let mut receipt = validity.receipt;
            receipt.engine_output_sha256 = Some(crate::spec_hash(
                &serde_json::to_string(&geometry).expect("integer geometry serializes"),
            ));
            GeometryReport {
                api_version: 1,
                ok,
                geometry: Some(geometry),
                diagnostics,
                receipt,
            }
        }
        Err(mut diagnostic) => {
            if let Some(suffix) = diagnostic.code.strip_prefix("document/") {
                diagnostic.code = format!("floorplan/{suffix}");
            }
            GeometryReport {
                api_version: 1,
                ok: false,
                geometry: None,
                diagnostics: vec![diagnostic],
                receipt: validity.receipt,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::{GeometryBox, GeometryDocument};

    fn layout(spec: &serde_json::Value) -> GeometryReport {
        layout_floorplan_json(&serde_json::json!({ "specJson": spec.to_string() }).to_string())
    }

    fn scene(spec: &serde_json::Value) -> GeometryDocument {
        let report = layout(spec);
        assert!(report.ok, "{:?}", report.diagnostics);
        report.geometry.expect("a passing layout retains geometry")
    }

    fn node<'a>(geometry: &'a GeometryDocument, id: &str) -> &'a GeometryBox {
        &geometry
            .nodes
            .iter()
            .find(|node| node.id == id)
            .unwrap_or_else(|| panic!("no placed node {id}"))
            .bounds
    }

    fn frame<'a>(geometry: &'a GeometryDocument, id: &str) -> &'a GeometryBox {
        let key = format!("{id}:section");
        &geometry
            .containers
            .iter()
            .find(|container| container.id == key)
            .unwrap_or_else(|| panic!("no placed frame {key}"))
            .bounds
    }

    fn contains(outer: GeometryBox, inner: GeometryBox) -> bool {
        i64::from(outer.x) <= i64::from(inner.x)
            && i64::from(outer.y) <= i64::from(inner.y)
            && i64::from(outer.right().unwrap()) >= i64::from(inner.right().unwrap())
            && i64::from(outer.bottom().unwrap()) >= i64::from(inner.bottom().unwrap())
    }

    fn overlaps(left: GeometryBox, right: GeometryBox) -> bool {
        i64::from(left.x) < i64::from(right.right().unwrap())
            && i64::from(right.x) < i64::from(left.right().unwrap())
            && i64::from(left.y) < i64::from(right.bottom().unwrap())
            && i64::from(right.y) < i64::from(left.bottom().unwrap())
    }

    /// A three-level map with Korean, English and mixed labels, one edge that
    /// stays inside a frame and one that leaves it, a flow and a tour.
    fn nested() -> serde_json::Value {
        serde_json::json!({
            "$schema": "floorplan/architecture@1",
            "project": {
                "name": "중첩 지도",
                "summary": "A compound map whose frames are sized from the cells they hold."
            },
            "nodes": [
                { "id": "web", "label": "웹 애플리케이션", "kind": "service", "paths": ["web/**"] },
                { "id": "web.ui", "parent": "web", "label": "UI (React)", "kind": "ui",
                  "summary": "화면과 입력 처리" },
                { "id": "web.api", "parent": "web", "label": "API server", "kind": "service" },
                { "id": "web.api.auth", "parent": "web.api", "label": "인증 auth", "kind": "feature",
                  "summary": "세션 검증과 권한 확인" },
                { "id": "store", "label": "데이터 저장소", "kind": "data",
                  "summary": "Postgres" }
            ],
            "edges": [
                { "from": "web.api.auth", "to": "store", "kind": "data" },
                { "from": "web.ui", "to": "web.api", "kind": "call", "label": "fetch" },
                { "from": "web.api", "to": "web", "kind": "event" }
            ],
            "flows": [
                { "id": "sign-in", "title": "로그인", "steps": [
                    { "node": "web.ui" }, { "node": "web.api.auth" }, { "node": "store" } ] }
            ],
            "tour": [ { "node": "web", "title": "입구" } ]
        })
    }

    #[test]
    fn every_child_sits_inside_the_frame_sized_from_it() {
        let spec = nested();
        let geometry = scene(&spec);
        let web = frame(&geometry, "web");
        let api = frame(&geometry, "web.api");
        for child in ["web.ui", "web.api", "web:section"] {
            let bounds = if child == "web:section" {
                *web
            } else {
                *node(&geometry, child)
            };
            assert!(contains(*web, bounds), "{child} escaped its frame");
        }
        assert!(contains(*web, *api), "the nested frame escaped its parent");
        assert!(contains(*api, *node(&geometry, "web.api.auth")));
        assert!(contains(*api, *node(&geometry, "web.api")));
        for placed in geometry.nodes.iter() {
            assert!(
                contains(geometry.page.bounds, placed.bounds),
                "{} left the page",
                placed.id
            );
        }
    }

    #[test]
    fn sibling_cells_do_not_overlap_and_the_frames_never_do() {
        let geometry = scene(&nested());
        let ui = *node(&geometry, "web.ui");
        let api = *frame(&geometry, "web.api");
        assert!(!overlaps(ui, api), "two cells in one row overlap");
        let store = *node(&geometry, "store");
        assert!(
            !overlaps(*frame(&geometry, "web"), store),
            "a top-level cell overlaps the frame beside it"
        );
        // The title band of a frame is its own member, above its children.
        let band = *node(&geometry, "web");
        assert!(contains(*frame(&geometry, "web"), band));
        assert!(
            !overlaps(band, *node(&geometry, "web.ui")),
            "a frame's title band lands on its first row"
        );
    }

    #[test]
    fn a_long_korean_and_mixed_label_wraps_inside_its_cell() {
        let mut spec = nested();
        spec["nodes"][1]["label"] =
            serde_json::json!("사용자 인터페이스 (React 19 + TypeScript) 그리고 접근성 계층");
        spec["nodes"][1]["summary"] = serde_json::json!(
            "Every screen, the input handling and the focus order for keyboard users."
        );
        let geometry = scene(&spec);
        let bounds = *node(&geometry, "web.ui");
        for label in geometry
            .labels
            .iter()
            .filter(|label| label.target_id == "web.ui")
        {
            assert!(
                label.text.contains('\n'),
                "a label this long wraps: {:?}",
                label.text
            );
            assert!(
                contains(bounds, label.bounds),
                "label {:?} overflowed its cell",
                label.id
            );
        }
    }

    #[test]
    fn the_map_lays_out_identically_twice_and_the_receipt_names_the_source() {
        let spec = nested();
        let first = layout(&spec);
        let second = layout(&spec);
        assert_eq!(first, second);
        assert_eq!(
            first.receipt.input_spec_sha256,
            crate::spec_hash(&spec.to_string())
        );
    }

    #[test]
    fn flows_and_tours_are_overlays_the_layout_ignores() {
        let spec = nested();
        let mut without = spec.clone();
        without["flows"] = serde_json::json!([]);
        without["tour"] = serde_json::json!([]);
        let mut edited = spec.clone();
        edited["flows"][0]["steps"] =
            serde_json::json!([{ "node": "store" }, { "node": "web.ui" }]);
        edited["flows"][0]["title"] = serde_json::json!("다른 흐름");
        edited["tour"] = serde_json::json!([{ "node": "store" }]);
        let drawn = scene(&spec);
        assert_eq!(drawn, scene(&without));
        assert_eq!(drawn, scene(&edited));
    }

    #[test]
    fn an_edge_crosses_a_frame_border_on_an_orthogonal_path() {
        let geometry = scene(&nested());
        let route = geometry
            .routes
            .iter()
            .find(|route| route.id.as_deref() == Some("edge:0"))
            .expect("the first edge is routed");
        assert_eq!(route.from, "web.api.auth");
        assert_eq!(route.to, "store");
        assert!(route.points.len() >= 2, "a routed edge has a path");
        for pair in route.points.windows(2) {
            assert!(
                pair[0].x == pair[1].x || pair[0].y == pair[1].y,
                "a route segment is not orthogonal: {:?}",
                pair
            );
        }
        // The path leaves the nested frame, so some segment crosses its border.
        let web = frame(&geometry, "web");
        let crosses = route
            .points
            .windows(2)
            .any(|pair| cross_cut(*web, pair[0], pair[1]));
        assert!(crosses, "the edge stayed inside its own frame");
    }

    /// Whether a segment crosses one of the box's four borders, which is what
    /// leaving a frame means for an orthogonal path.
    fn cross_cut(bounds: GeometryBox, from: GeometryPoint, to: GeometryPoint) -> bool {
        let (left, top) = (i64::from(bounds.x), i64::from(bounds.y));
        let (right, bottom) = (
            i64::from(bounds.right().unwrap()),
            i64::from(bounds.bottom().unwrap()),
        );
        let (ax, ay) = (i64::from(from.x), i64::from(from.y));
        let (bx, by) = (i64::from(to.x), i64::from(to.y));
        let inside_x = ax > left && ax < right && bx > left && bx < right;
        let inside_y = ay > top && ay < bottom && by > top && by < bottom;
        if ay == by {
            return inside_y
                && (ax.min(bx) <= left && ax.max(bx) >= left
                    || ax.min(bx) <= right && ax.max(bx) >= right);
        }
        inside_x
            && (ay.min(by) <= top && ay.max(by) >= top
                || ay.min(by) <= bottom && ay.max(by) >= bottom)
    }

    #[test]
    fn a_file_path_endpoint_is_drawn_on_the_node_that_owns_the_file() {
        let mut spec = nested();
        spec["edges"] = serde_json::json!([
            { "from": "web/api/session.ts", "to": "store", "kind": "import" }
        ]);
        // Only the top frame claims the tree, so the edge lands on it.
        assert_eq!(scene(&spec).routes[0].from, "web");
        // The deeper claim wins once a nested node names the file, which is the
        // upstream assignment rule the canvas draws with.
        spec["nodes"][3]["paths"] = serde_json::json!(["web/api/**"]);
        let geometry = scene(&spec);
        assert_eq!(
            geometry.routes[0].from, "web.api.auth",
            "the deepest node claiming the path draws the edge"
        );
    }

    #[test]
    fn a_section_endpoint_routes_to_its_title_band() {
        let mut spec = nested();
        spec["edges"] = serde_json::json!([{ "from": "web", "to": "store", "kind": "rpc" }]);
        let geometry = scene(&spec);
        let route = &geometry.routes[0];
        assert_eq!((route.from.as_str(), route.to.as_str()), ("web", "store"));
        assert!(!route.points.is_empty(), "a section endpoint is routable");
    }

    #[test]
    fn an_unvalidated_map_is_refused_rather_than_placed() {
        let report = layout(&serde_json::json!({
            "project": { "name": "" },
            "nodes": [{ "id": "a", "label": "A", "kind": "nonsense" }]
        }));
        assert!(!report.ok);
        assert!(report.geometry.is_none());
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.path.contains("/project/name")));
    }

    /// One acyclic parent chain whose deepest node sits at `depth`, which is the
    /// shape validation accepts however long it gets.
    fn chain(depth: usize) -> serde_json::Value {
        let nodes: Vec<serde_json::Value> = (0..=depth)
            .map(|level| {
                let mut node = serde_json::json!({
                    "id": format!("n{level}"),
                    "label": format!("L{level}"),
                    "kind": "service",
                });
                if level > 0 {
                    node["parent"] = serde_json::json!(format!("n{}", level - 1));
                }
                node
            })
            .collect();
        serde_json::json!({ "project": { "name": "사슬" }, "nodes": nodes })
    }

    #[test]
    fn a_parent_chain_deeper_than_the_cap_is_refused_instead_of_overflowing() {
        // The cap itself still places, so the refusal is about the level past it
        // and not about nesting in general.
        let allowed = layout(&chain(MAX_NESTING_DEPTH));
        assert!(allowed.ok, "{:?}", allowed.diagnostics);

        let report = layout(&chain(MAX_NESTING_DEPTH + 1));
        assert!(!report.ok, "a chain past the cap is refused, never placed");
        assert!(report.geometry.is_none());
        let diagnostic = report
            .diagnostics
            .first()
            .expect("a refusal carries its cause");
        assert_eq!(diagnostic.code, "floorplan/nesting-depth");
        assert!(
            diagnostic
                .message
                .contains(&(MAX_NESTING_DEPTH + 1).to_string()),
            "the cause names the depth it found: {}",
            diagnostic.message
        );
        assert!(
            diagnostic.fix.contains(&MAX_NESTING_DEPTH.to_string()),
            "the fix names the limit to flatten to: {}",
            diagnostic.fix
        );
    }

    #[test]
    fn a_non_ascii_prefix_tie_breaks_the_way_the_canvas_does() {
        // Both claimants are top level, so depth ties and the literal prefix
        // decides. In UTF-16 code units "[가]" is 3 and "가나" is 2, so the canvas
        // keeps the first (`literalPrefixLength`); counting bytes would invert it
        // at 5 against 6 and draw the edge somewhere else.
        let spec = serde_json::json!({
            "project": { "name": "tie" },
            "nodes": [
                { "id": "bracket", "label": "가", "kind": "service", "paths": ["[가]*"] },
                { "id": "plain", "label": "나", "kind": "service", "paths": ["가나*"] },
                { "id": "store", "label": "저장", "kind": "data" }
            ],
            "edges": [{ "from": "가나x", "to": "store", "kind": "import" }]
        });
        assert_eq!(scene(&spec).routes[0].from, "bracket");
    }
}
