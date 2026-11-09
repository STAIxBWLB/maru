//! Sequence endpoint/crowding rules follow the placed scene, not source ordinals.
#![cfg(feature = "geometry")]
use maru_diagram_engine::{geometry::GeometryReport, layout::layout_json, validate_json};
use serde_json::{json, Value};

fn source(messages: Value) -> Value {
    json!({
        "schema_version":1,"diagram_type":"sequence",
        "meta":{"title":"S","output":"sequence-pins.html"},
        "participants":[{"id":"a","type":"backend","label":"A"},
                        {"id":"b","type":"backend","label":"B"},
                        {"id":"c","type":"backend","label":"C"},
                        {"id":"d","type":"backend","label":"D"}],
        "messages":messages
    })
}

fn report(source: &Value, pins: Value) -> GeometryReport {
    let spec_json = source.to_string();
    let validity = validate_json(&spec_json);
    assert!(validity.ok, "{:?}", validity.diagnostics);
    layout_json(
        &json!({"specJson":spec_json,"pinSet":{
            "sourceSpecSha256":validity.receipt.input_spec_sha256,"pins":pins
        }})
        .to_string(),
    )
}

fn pin(id: &str, x: i32, y: i32) -> Value {
    json!({"targetId":id,"targetKind":"node","position":{"x":x*64,"y":y*64}})
}

fn has(report: &GeometryReport, code: &str) -> bool {
    report
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == code)
}

#[test]
fn pin_can_make_an_unchanged_ordinal_pair_shorter_than_60_pixels() {
    let source = source(json!([{"from":"a","to":"b","y":300,"label":"G"}]));
    let ordinal_snapshot = source["participants"].clone();
    let automatic = report(&source, json!([]));
    assert!(!has(&automatic, "sequence/geometry-route-distance"));
    // Default a bounds are x19,width86 => center62. Pin b bounds at x69
    // leaves center112, an actual 50px span despite its unchanged ordinal 1.
    let pinned = report(&source, json!([pin("b", 69, 72)]));
    assert!(
        has(&pinned, "sequence/geometry-route-distance"),
        "{:?}",
        pinned.diagnostics
    );
    let scene = pinned
        .geometry
        .expect("distance refusal must retain placed geometry");
    let center = |id: &str| {
        let node = scene.nodes.iter().find(|node| node.id == id).unwrap();
        i64::from(node.bounds.x) + i64::from(node.bounds.width) / 2
    };
    assert_eq!((center("b") - center("a")).abs(), 50 * 64);
    assert_eq!(source["participants"], ordinal_snapshot);
}

#[test]
fn pin_can_make_formerly_disjoint_ordinal_spans_overlap() {
    let source = source(json!([
        {"from":"a","to":"b","y":300,"label":"G"},
        {"from":"c","to":"d","y":320,"label":"H"}
    ]));
    let automatic = report(&source, json!([]));
    assert!(
        !has(&automatic, "sequence/geometry-message-spacing"),
        "{:?}",
        automatic.diagnostics
    );
    // Moving only b to center494 makes a->b cover c->d, while every
    // participant still has its original source-array ordinal.
    let pinned = report(&source, json!([pin("b", 451, 72)]));
    assert!(
        has(&pinned, "sequence/geometry-message-spacing"),
        "{:?}",
        pinned.diagnostics
    );
    assert!(pinned.geometry.is_some());
}

#[test]
fn pins_can_separate_spans_that_overlap_in_source_ordinal_order() {
    let source = source(json!([
        {"from":"a","to":"c","y":300,"label":"G"},
        {"from":"b","to":"d","y":320,"label":"H"}
    ]));
    let automatic = report(&source, json!([]));
    assert!(
        has(&automatic, "sequence/geometry-message-spacing"),
        "{:?}",
        automatic.diagnostics
    );
    // Actual a->c remains 62..278; the two retained pins move b->d to
    // centers 602..710. Ordinals alone would still report a false overlap.
    let separated = report(&source, json!([pin("b", 559, 72), pin("d", 667, 72)]));
    assert!(
        !has(&separated, "sequence/geometry-message-spacing"),
        "{:?}",
        separated.diagnostics
    );
    assert!(separated.geometry.is_some());
}

#[test]
fn placed_headers_must_keep_the_page_origin_and_right_reserve_after_pinning() {
    let base = source(json!([{"from":"a","to":"b","y":300,"label":"G"}]));
    for page in [None, Some(480)] {
        let mut source = base.clone();
        if let Some(width) = page {
            source["meta"]["viewBox"] = json!([width, 760]);
        }
        let width = page.unwrap_or(920);
        let automatic = report(&source, json!([]));
        assert!(
            !has(&automatic, "sequence/geometry-participant-canvas-width"),
            "{:?}",
            automatic.diagnostics
        );
        // Headers remain86px wide. A retained pin must not be mistaken for
        // its old ordinal slot when its left edge crosses the origin.
        let left = report(&source, json!([pin("a", -1, 72)]));
        assert!(
            has(&left, "sequence/geometry-participant-canvas-width"),
            "{:?}",
            left.diagnostics
        );
        assert!(left.geometry.is_some());
        // Exact right reserve is allowed; one pixel farther is refused.
        let fits = report(&source, json!([pin("d", width - 86 - 40, 72)]));
        assert!(
            !has(&fits, "sequence/geometry-participant-canvas-width"),
            "{:?}",
            fits.diagnostics
        );
        let outside = report(&source, json!([pin("d", width - 86 - 40 + 1, 72)]));
        assert!(
            has(&outside, "sequence/geometry-participant-canvas-width"),
            "{:?}",
            outside.diagnostics
        );
        let scene = outside
            .geometry
            .expect("header page refusal retains the actual placed scene");
        let header = scene.nodes.iter().find(|node| node.id == "d").unwrap();
        assert_eq!(header.bounds.x, (width - 86 - 40 + 1) * 64);
    }
}
