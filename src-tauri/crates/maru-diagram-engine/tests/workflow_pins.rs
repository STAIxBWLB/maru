#![cfg(feature = "geometry")]
use maru_diagram_engine::{layout::layout_json, validate_json};
use serde_json::{json, Value};
fn pinned(
    from_col: u32,
    to_col: u32,
    right_x: i32,
) -> maru_diagram_engine::geometry::GeometryReport {
    let source = json!({"schema_version":1,"diagram_type":"workflow","meta":{"title":"Pins","output":"pins.html"},
        "lanes":[{"id":"main","label":"Main"}],"nodes":[
        {"id":"a","lane":"main","col":from_col,"type":"backend","label":"A"},
        {"id":"b","lane":"main","col":to_col,"type":"backend","label":"B"}],
        "edges":[{"id":"go","from":"a","to":"b"}]});
    let spec_json = source.to_string();
    let validity = validate_json(&spec_json);
    assert!(validity.ok);
    // A pin is an authored source position, like the route hints beside it. The
    // first lane row is y=93 and the page's header offset moves it on the canvas
    // (maru#561).
    let pin = |id: &str, x: i32| -> Value {
        json!({"targetId":id,"targetKind":"node","position":{"x":x*64,"y":93*64}})
    };
    layout_json(&json!({"specJson":spec_json,"pinSet":{"sourceSpecSha256":validity.receipt.input_spec_sha256,"pins":[pin("a",100),pin("b",right_x)]}}).to_string())
}
#[test]
fn column_capacity_uses_pin_created_gap_instead_of_nominal_columns() {
    let close = pinned(0, 2, 201);
    assert!(!close.ok);
    assert!(close.geometry.is_some());
    assert!(
        close
            .diagnostics
            .iter()
            .any(|d| d.code == "workflow/geometry-column-capacity"),
        "{:?}",
        close.diagnostics
    );
    let separated = pinned(1, 2, 400);
    assert!(separated.ok, "{:?}", separated.diagnostics);
    let geometry = separated.geometry.as_ref().unwrap();
    let offset = geometry
        .page
        .content_offset
        .expect("a workflow page draws the header band inside itself")
        .y;
    assert_eq!(offset, 64 * 64);
    for id in ["a", "b"] {
        let node = geometry.nodes.iter().find(|node| node.id == id).unwrap();
        assert_eq!(
            node.bounds.y,
            93 * 64 + offset,
            "{id} lost its authored pin"
        );
    }
}
