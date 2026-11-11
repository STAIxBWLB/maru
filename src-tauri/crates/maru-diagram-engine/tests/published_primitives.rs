//! The geometry report publishes the shapes the writer paints but no member,
//! container or route covers — a sequence lifeline, a workflow phase span, a
//! lifecycle initial marker, rail or band, a lifecycle final border, a legend
//! swatch — so the canvas can draw the engine's whole scene (`maru#552` E4).
//!
//! The report and the SVG are two consumers of one derivation, so this test
//! holds them against each other: every published primitive is painted, in the
//! published order within its layer, at the published coordinates, and the
//! writer paints no primitive the report left out.
#![cfg(all(feature = "geometry", feature = "render-svg"))]
use maru_diagram_engine::geometry::{GeometryDocument, GeometryPrimitiveShape};
use maru_diagram_engine::layout::layout_json;
use maru_diagram_engine::render::{render_svg, SvgOptions, SvgTheme};
use roxmltree::{Document, Node};
use serde_json::{json, Value};

const FAMILIES: [(&str, &str); 5] = [
    (
        "architecture",
        include_str!("../testdata/valid-architecture.json"),
    ),
    ("workflow", include_str!("../testdata/valid-workflow.json")),
    ("sequence", include_str!("../testdata/valid-sequence.json")),
    ("dataflow", include_str!("../testdata/valid-dataflow.json")),
    (
        "lifecycle",
        include_str!("../testdata/valid-lifecycle.json"),
    ),
];

fn layout(source: &str) -> GeometryDocument {
    let report = layout_json(&json!({ "specJson": source }).to_string());
    assert!(report.ok, "{:?}", report.diagnostics);
    report.geometry.expect("accepted layout retains geometry")
}

fn px(value: i32) -> f64 {
    f64::from(value) / 64.0
}

fn close(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() <= 1e-9,
        "expected {expected}, got {actual}"
    );
}

fn painted<'a, 'input>(document: &'a Document<'input>) -> Vec<Node<'a, 'input>> {
    let kinds = maru_diagram_engine::RENDER_PRIMITIVE_KINDS;
    document
        .descendants()
        .filter(|node| {
            node.attribute("data-kind")
                .is_some_and(|kind| kinds.contains(&kind))
        })
        .collect()
}

fn assert_shape(primitive: &maru_diagram_engine::geometry::GeometryPrimitive, node: Node<'_, '_>) {
    let attr = |name: &str| {
        node.attribute(name)
            .unwrap_or_else(|| panic!("{} is missing {name}", primitive.kind))
            .parse::<f64>()
            .unwrap_or_else(|_| panic!("{} {name} is not numeric", primitive.kind))
    };
    match &primitive.shape {
        GeometryPrimitiveShape::Rect { bounds, radius } => {
            assert_eq!(node.tag_name().name(), "rect");
            close(attr("x"), px(bounds.x));
            close(attr("y"), px(bounds.y));
            close(attr("width"), px(bounds.width));
            close(attr("height"), px(bounds.height));
            close(attr("rx"), px(*radius));
        }
        GeometryPrimitiveShape::Line { from, to } => {
            assert_eq!(node.tag_name().name(), "line");
            close(attr("x1"), px(from.x));
            close(attr("y1"), px(from.y));
            close(attr("x2"), px(to.x));
            close(attr("y2"), px(to.y));
        }
        GeometryPrimitiveShape::Circle { center, radius } => {
            assert_eq!(node.tag_name().name(), "circle");
            close(attr("cx"), px(center.x));
            close(attr("cy"), px(center.y));
            close(attr("r"), px(*radius));
        }
        GeometryPrimitiveShape::Ellipse { center, rx, ry } => {
            assert_eq!(node.tag_name().name(), "ellipse");
            close(attr("cx"), px(center.x));
            close(attr("cy"), px(center.y));
            close(attr("rx"), px(*rx));
            close(attr("ry"), px(*ry));
        }
        GeometryPrimitiveShape::Polyline { points } => {
            assert_eq!(node.tag_name().name(), "polyline");
            let actual = node.attribute("points").expect("polyline carries points");
            let expected = points
                .iter()
                .map(|point| format!("{},{}", px(point.x), px(point.y)))
                .collect::<Vec<_>>()
                .join(" ");
            assert_eq!(actual, expected, "{} polyline points", primitive.kind);
        }
        GeometryPrimitiveShape::Polygon { points } => {
            assert_eq!(node.tag_name().name(), "polygon");
            let actual = node.attribute("points").expect("polygon carries points");
            let expected = points
                .iter()
                .map(|point| format!("{},{}", px(point.x), px(point.y)))
                .collect::<Vec<_>>()
                .join(" ");
            assert_eq!(actual, expected, "{} polygon points", primitive.kind);
        }
    }
    assert_eq!(
        node.attribute("data-target-id"),
        Some(primitive.owner.as_str()),
        "{} owner",
        primitive.kind
    );
}

#[test]
fn every_published_primitive_is_painted_and_nothing_else_is() {
    for (family, source) in FAMILIES {
        let geometry = layout(source);
        let spec: Value = serde_json::from_str(source).expect("fixture is JSON");
        let options =
            SvgOptions::from_spec(&spec, SvgTheme::Light).expect("fixture semantics are valid");
        let rendered = render_svg(&geometry, &options);
        assert!(rendered.ok, "{family}: {:?}", rendered.diagnostics);
        let svg = rendered.svg.expect("accepted SVG has bytes");
        let document = Document::parse(&svg).expect("rendered SVG is XML");
        let nodes = painted(&document);
        assert_eq!(
            nodes.len(),
            geometry.primitives.len(),
            "{family}: the report publishes {} primitives and the SVG paints {}",
            geometry.primitives.len(),
            nodes.len()
        );
        for (primitive, node) in geometry.primitives.iter().zip(nodes) {
            assert_eq!(
                node.attribute("data-kind"),
                Some(primitive.kind.as_str()),
                "{family}: painted primitive order"
            );
            assert_shape(primitive, node);
        }
        assert!(
            geometry
                .primitives
                .iter()
                .all(|primitive| !primitive.kind.is_empty()),
            "{family}: a primitive lost its kind"
        );
    }
}

#[test]
fn a_sequence_scene_publishes_one_lifeline_per_participant() {
    let geometry = layout(FAMILIES[2].1);
    let lifelines: Vec<_> = geometry
        .primitives
        .iter()
        .filter(|primitive| primitive.kind == "sequence-lifeline")
        .collect();
    assert_eq!(
        lifelines.len(),
        geometry.nodes.len(),
        "every participant needs a lifeline, or its messages float"
    );
    for lifeline in lifelines {
        // The lifeline hangs from its participant's own bottom edge, at its
        // centre, which is what makes it read as that participant's timeline.
        let participant = geometry
            .nodes
            .iter()
            .find(|node| node.id == lifeline.owner)
            .unwrap_or_else(|| panic!("lifeline owner {} is not a participant", lifeline.owner));
        let GeometryPrimitiveShape::Line { from, to } = lifeline.shape else {
            panic!("a lifeline is a line");
        };
        let centre = i64::from(participant.bounds.x) + i64::from(participant.bounds.width) / 2;
        let bottom = i64::from(participant.bounds.y) + i64::from(participant.bounds.height);
        assert_eq!(i64::from(from.x), centre, "{} lifeline x", participant.id);
        assert_eq!(i64::from(from.y), bottom, "{} lifeline top", participant.id);
        assert_eq!(
            i64::from(to.x),
            centre,
            "{} lifeline stays vertical",
            participant.id
        );
        assert!(
            i64::from(to.y) > bottom,
            "{} lifeline descends",
            participant.id
        );
    }
}

#[test]
fn primitives_are_published_in_emitted_coordinates() {
    // A lifecycle page moves below its emitted header band; the primitives have
    // to be in the same coordinates as the nodes, or the canvas would draw the
    // initial marker and the band beside the states.
    let geometry = layout(FAMILIES[4].1);
    let shift = geometry
        .page
        .content_offset
        .expect("a lifecycle page reports its header band")
        .y;
    assert!(shift > 0, "the emitted title band did not move the drawing");
    let marker = geometry
        .primitives
        .iter()
        .find(|primitive| primitive.kind == "lifecycle-initial-dot")
        .expect("a lifecycle scene draws its initial marker");
    let state = geometry
        .nodes
        .iter()
        .find(|node| node.id == marker.owner)
        .expect("the marker belongs to a state");
    let GeometryPrimitiveShape::Circle { center, .. } = marker.shape else {
        panic!("the initial marker is a dot");
    };
    assert!(
        i64::from(center.y) > i64::from(state.bounds.y),
        "the marker sits beside its state, in emitted coordinates"
    );
    assert!(
        i64::from(state.bounds.y) >= i64::from(shift),
        "the state itself moved below the band"
    );
}

fn lifecycle_scene(done: Value) -> String {
    json!({
        "schema_version": 2,
        "diagram_type": "lifecycle",
        "meta": {"title": "Shapes", "output": "shapes.html"},
        "lanes": [{"id": "main", "label": "Main"}],
        "states": [
            {"id": "start", "type": "start", "label": "Start", "lane": "main", "col": 0},
            {"id": "work", "type": "active", "label": "Work", "lane": "main", "col": 1},
            done,
        ],
        "transitions": [
            {"id": "begin", "from": "start", "to": "work", "label": "Begin"},
            {"id": "finish", "from": "work", "to": "done", "label": "Finish"},
        ],
    })
    .to_string()
}

/// The shape the engine drew each state as is published on the node, and the
/// final border follows it. A state whose label fit inside the curve keeps the
/// oval and an oval border around it; a state whose label needed the whole box
/// is published as a box and gets the inset rectangle, so the canvas and the
/// writer never draw a curve across text the engine placed as a box.
#[test]
fn a_lifecycle_state_publishes_the_shape_it_was_drawn_as() {
    let kept = layout(&lifecycle_scene(json!({
        "id": "done",
        "type": "success",
        "label": "Done",
        "lane": "main",
        "col": 2,
    })));
    let demoted = layout(&lifecycle_scene(json!({
        "id": "done",
        "type": "success",
        "label": "A comprehensive validation checkpoint",
        "lane": "main",
        "col": 2,
        "width": 180,
        "height": 72,
    })));
    for (geometry, shape) in [(&kept, Some(true)), (&demoted, Some(false))] {
        let node = geometry
            .nodes
            .iter()
            .find(|node| node.id == "done")
            .expect("done is placed");
        assert_eq!(node.ellipse, shape, "published shape of the done state");
        assert_eq!(node.final_state, Some(true), "done is the final state");
        // A state the family never draws as a curve says nothing at all.
        let active = geometry
            .nodes
            .iter()
            .find(|node| node.id == "work")
            .expect("work is placed");
        assert_eq!(active.ellipse, None, "an active state has no oval decision");
        assert_eq!(
            geometry
                .nodes
                .iter()
                .find(|node| node.id == "start")
                .expect("start is placed")
                .ellipse,
            Some(true),
            "a start state is an oval"
        );
        let inset = (3 * 64).min(node.bounds.width.min(node.bounds.height) / 4);
        let border = geometry
            .primitives
            .iter()
            .find(|primitive| primitive.kind == "lifecycle-final-border")
            .expect("the final state has a border");
        assert_eq!(border.owner, "done");
        match (&border.shape, shape) {
            (GeometryPrimitiveShape::Ellipse { center, rx, ry }, Some(true)) => {
                assert_eq!(
                    i64::from(center.x) * 2,
                    i64::from(node.bounds.x) * 2 + i64::from(node.bounds.width),
                    "the border is concentric with the oval"
                );
                assert_eq!(
                    i64::from(center.y) * 2,
                    i64::from(node.bounds.y) * 2 + i64::from(node.bounds.height)
                );
                assert_eq!(
                    i64::from(*rx),
                    i64::from(node.bounds.width) / 2 - i64::from(inset)
                );
                assert_eq!(
                    i64::from(*ry),
                    i64::from(node.bounds.height) / 2 - i64::from(inset)
                );
            }
            (GeometryPrimitiveShape::Rect { bounds, .. }, Some(false)) => {
                assert_eq!(bounds.x, node.bounds.x + inset);
                assert_eq!(bounds.y, node.bounds.y + inset);
                assert_eq!(bounds.width, node.bounds.width - 2 * inset);
                assert_eq!(bounds.height, node.bounds.height - 2 * inset);
            }
            (shape, state) => panic!("{state:?} state published a {shape:?} border"),
        }
    }
}
