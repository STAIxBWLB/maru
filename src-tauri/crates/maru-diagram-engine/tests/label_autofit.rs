//! T6 auto-fit: measured wrapping, box growth, the readable floor and the order
//! they are applied in (`maru#552`).
#![cfg(feature = "geometry")]

use maru_diagram_engine::geometry::GeometryReport;
use maru_diagram_engine::layout::layout_json;
use maru_diagram_engine::metrics::{measure_text, wrap_label_lines};
use maru_diagram_engine::Diagnostic;
use serde_json::{json, Value};
#[path = "support/painted_ink.rs"]
mod painted_ink;

/// `layout/mod.rs`: left inset of a node's text origin, top inset of its first
/// line, and the four whole-pixel steps auto-fit may take.
const TEXT_INSET: i32 = 12 * 64;
const TOP_INSET: i32 = 8 * 64;
const FLOOR: i32 = 10 * 64;

fn report(spec: &Value) -> GeometryReport {
    layout_json(&json!({"specJson": spec.to_string()}).to_string())
}

fn fixture(input: &str) -> Value {
    serde_json::from_str(input).unwrap()
}

fn owned_label<'a>(
    report: &'a GeometryReport,
    node_id: &str,
) -> &'a maru_diagram_engine::geometry::GeometryLabel {
    role_label(report, node_id, "label")
}

fn role_label<'a>(
    report: &'a GeometryReport,
    node_id: &str,
    role: &str,
) -> &'a maru_diagram_engine::geometry::GeometryLabel {
    report
        .geometry
        .as_ref()
        .expect("accepted layout retains geometry")
        .labels
        .iter()
        .find(|label| label.id.as_deref() == Some(&format!("node:{node_id}:{role}")))
        .unwrap_or_else(|| panic!("missing node:{node_id}:{role}"))
}

fn node_bounds(
    report: &GeometryReport,
    node_id: &str,
) -> maru_diagram_engine::geometry::GeometryBox {
    report
        .geometry
        .as_ref()
        .expect("accepted layout retains geometry")
        .nodes
        .iter()
        .find(|node| node.id == node_id)
        .unwrap_or_else(|| panic!("missing node {node_id}"))
        .bounds
}

fn dataflow(label: &str, width: f64, height: f64) -> Value {
    json!({
        "schema_version": 1,
        "diagram_type": "dataflow",
        "meta": {"title": "auto-fit", "output": "auto-fit.html", "viewBox": [940, 720]},
        "stages": [{"label": "Input"}, {"label": "Output"}],
        "nodes": [
            {"id": "a", "type": "frontend", "label": label, "stage": 1, "row": 0, "width": width, "height": height},
            {"id": "b", "type": "backend", "label": "Out", "stage": 0, "row": 1}
        ],
        "flows": []
    })
}

fn architecture(label: &str, size: Option<[f64; 2]>) -> Value {
    let mut component = json!({"id": "a", "type": "frontend", "label": label, "row": 0, "col": 0});
    if let Some(size) = size {
        component["size"] = json!(size);
    }
    json!({
        "schema_version": 1,
        "diagram_type": "architecture",
        "meta": {"title": "auto-fit", "output": "auto-fit.html"},
        "layout": {"mode": "grid", "cols": 4},
        "components": [component],
        "connections": []
    })
}

fn workflow(label: &str, tag: Option<&str>) -> Value {
    let mut node =
        json!({"id": "a", "type": "backend", "label": label, "lane": "orders", "col": 0});
    if let Some(tag) = tag {
        node["tag"] = json!(tag);
    }
    json!({
        "schema_version": 2,
        "diagram_type": "workflow",
        "meta": {"title": "auto-fit", "output": "auto-fit.html"},
        "lanes": [{"id": "orders", "label": "Orders"}, {"id": "delivery", "label": "Delivery"}],
        "nodes": [node, {"id": "b", "type": "backend", "label": "B", "lane": "delivery", "col": 0}],
        "phases": [],
        "edges": []
    })
}

fn lifecycle_v1(label: &str) -> Value {
    json!({
        "schema_version": 1,
        "diagram_type": "lifecycle",
        "meta": {"title": "auto-fit", "output": "auto-fit.html"},
        "lanes": [{"id": "main", "label": "Main"}],
        "states": [
            {"id": "a", "type": "start", "label": label, "lane": "main", "col": 0},
            {"id": "b", "type": "active", "label": "B", "lane": "main", "col": 1}
        ],
        "transitions": []
    })
}

fn lifecycle_v2(label: &str, view_box_height: f64) -> Value {
    json!({
        "schema_version": 2,
        "diagram_type": "lifecycle",
        "meta": {"title": "auto-fit", "output": "auto-fit.html", "viewBox": [980, view_box_height]},
        "lanes": [
            {"id": "main", "label": "Main"},
            {"id": "active", "label": "Active"},
            {"id": "closed", "label": "Closed"}
        ],
        "states": [
            {"id": "a", "type": "start", "label": "A", "lane": "main", "col": 0},
            {"id": "b", "type": "active", "label": "B", "lane": "active", "col": 0},
            {"id": "c", "type": "success", "label": label, "lane": "closed", "col": 0}
        ],
        "transitions": []
    })
}

/// Whether any placement at the readable floor can hold this text in a box of
/// this size. This re-derives the producer's own floor placement from the same
/// public metrics (`wrap_label_lines` at the floor, then the per-line baseline
/// stack `Scene::label` uses), so a refusal can be checked against real ink
/// instead of being taken on trust.
fn floor_placement_fits(label: &str, box_width: i32, box_height: i32) -> bool {
    let available = box_width - TEXT_INSET;
    let Ok(lines) = wrap_label_lines(label, 700, FLOOR, available, true) else {
        return false;
    };
    let mut line_top = TOP_INSET;
    for line in &lines {
        let metrics = measure_text(line, 700, FLOOR).expect("the pinned face measures");
        let baseline = line_top + metrics.ascender;
        for glyph in metrics
            .glyphs
            .iter()
            .filter(|glyph| glyph.ink.width > 0 && glyph.ink.height > 0)
        {
            let left = TEXT_INSET + glyph.ink.x;
            let top = baseline + glyph.ink.y;
            if left < 0
                || top < 0
                || left + glyph.ink.width > box_width
                || top + glyph.ink.height > box_height
            {
                return false;
            }
        }
        line_top += (metrics.ascender - metrics.descender).max(FLOOR + FLOOR / 2);
    }
    true
}

fn fit_diagnostic<'a>(report: &'a GeometryReport) -> &'a Diagnostic {
    report
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.code == "dataflow/geometry-label-fit")
        .unwrap_or_else(|| panic!("missing fit diagnostic: {:?}", report.diagnostics))
}

#[test]
fn mixed_korean_and_english_labels_are_readable_in_all_five_families() {
    // One mixed label on the node each family sizes itself, so every family's
    // own default box is measured against the same Korean/Latin ink.
    let label = "결제 Gateway 확인";
    let cases: [(&str, Value, &str); 5] = [
        (
            "architecture",
            {
                let mut spec = fixture(include_str!("../testdata/valid-architecture.json"));
                spec["components"][0]["label"] = json!(label);
                spec
            },
            "a",
        ),
        (
            "workflow",
            {
                let mut spec = fixture(include_str!("../testdata/valid-workflow.json"));
                spec["nodes"][0]["label"] = json!(label);
                spec
            },
            "a",
        ),
        (
            "dataflow",
            {
                let mut spec = fixture(include_str!("../testdata/valid-dataflow.json"));
                spec["nodes"][0]["label"] = json!(label);
                spec
            },
            "a",
        ),
        (
            "lifecycle",
            {
                let mut spec = fixture(include_str!("../testdata/valid-lifecycle.json"));
                spec["states"][0]["label"] = json!(label);
                spec
            },
            "a",
        ),
        (
            "sequence",
            {
                let mut spec = fixture(include_str!("../testdata/valid-sequence.json"));
                spec["participants"][0]["label"] = json!(label);
                spec
            },
            "a",
        ),
    ];
    for (family, spec, node_id) in cases {
        let result = report(&spec);
        assert!(
            result.ok,
            "{family}: a mixed label must fit its own default box: {:?}",
            result.diagnostics
        );
        painted_ink::assert_accepted_text_ink_fits(&result);
        painted_ink::assert_readable_floors(&result, family);
        let placed = owned_label(&result, node_id);
        assert_eq!(
            placed.font.id, "noto-sans-cjk-kr",
            "{family}: the fitted label keeps the pinned face"
        );
        // Re-breaking moves the breaks; it never drops or duplicates a scalar.
        let joined: String = placed
            .text
            .split('\n')
            .map(str::trim_end)
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(joined, label, "{family}: wrapped text {:?}", placed.text);
    }
}

#[test]
fn auto_fit_wraps_before_it_grows_or_shrinks() {
    // Authored dataflow box, spaced label: the space break alone fits it, so no
    // height is added and no step is dropped.
    let result = report(&dataflow("Deploy the service now", 118.0, 58.0));
    assert!(result.ok, "{:?}", result.diagnostics);
    let placed = owned_label(&result, "a");
    assert!(
        placed.text.contains('\n'),
        "the label is re-broken: {:?}",
        placed.text
    );
    assert_eq!(
        placed.font_size,
        13 * 64,
        "wrap alone keeps the 13px label role"
    );
    assert_eq!(
        node_bounds(&result, "a").height,
        58 * 64,
        "the authored height is untouched"
    );
}

#[test]
fn auto_fit_grows_the_box_before_it_shrinks_the_type() {
    // Same shape of text in a box the source does not size: the wrapped lines
    // need more height, so the box grows and the label keeps 13px.
    let default_box = report(&architecture("Deploy the payment service now please", None));
    assert!(default_box.ok, "{:?}", default_box.diagnostics);
    let grown = node_bounds(&default_box, "a");
    assert!(
        grown.height > 60 * 64,
        "the box absorbs the extra line instead of dropping the size: {grown:?}"
    );
    let placed = owned_label(&default_box, "a");
    assert_eq!(placed.text.split('\n').count(), 3, "{:?}", placed.text);
    assert_eq!(placed.font_size, 13 * 64, "growth comes before any shrink");
}

#[test]
fn auto_fit_shrinks_only_when_the_authored_box_blocks_growth() {
    // The identical label with an authored 120x60 box: growth is the source's
    // decision to make, so auto-fit takes the ladder down instead.
    let authored = report(&architecture(
        "Deploy the payment service now please",
        Some([120.0, 60.0]),
    ));
    assert!(authored.ok, "{:?}", authored.diagnostics);
    assert_eq!(
        node_bounds(&authored, "a").height,
        60 * 64,
        "an authored size is never grown"
    );
    let placed = owned_label(&authored, "a");
    assert_eq!(placed.text.split('\n').count(), 3, "{:?}", placed.text);
    assert_eq!(
        placed.font_size,
        11 * 64,
        "one ladder step below the label role"
    );
}

#[test]
fn a_latin_word_is_cut_only_after_the_whole_word_fails_every_box_and_size() {
    // The floor still holds this word on one line, so it is never cut.
    let whole = report(&dataflow("DeploymentService", 118.0, 58.0));
    assert!(whole.ok, "{:?}", whole.diagnostics);
    let placed = owned_label(&whole, "a");
    assert!(
        !placed.text.contains('\n'),
        "shrinking to the floor is preferred over cutting a word: {:?}",
        placed.text
    );
    assert_eq!(
        placed.font_size, FLOOR,
        "the ladder reaches its floor first"
    );

    // Two characters longer and no size holds it, so the word is cut - but at
    // the 13px label role, not at the floor it already failed.
    let cut = report(&dataflow("DeploymentServiceGateway", 118.0, 58.0));
    assert!(cut.ok, "{:?}", cut.diagnostics);
    let placed = owned_label(&cut, "a");
    assert_eq!(placed.text.split('\n').count(), 2, "{:?}", placed.text);
    assert!(
        placed.text.lines().all(|line| !line.is_empty()),
        "{:?}",
        placed.text
    );
    assert_eq!(
        placed.text.replace('\n', ""),
        "DeploymentServiceGateway",
        "a cut only moves a break inside the word"
    );
    assert_eq!(placed.font_size, 13 * 64);
}

#[test]
fn a_cut_is_granted_only_to_the_role_whose_own_word_fails() {
    // Both roles carry the same kind of Latin word, but only the sublabel's is
    // too wide for every box and size. The primary keeps its word whole: a
    // sibling's cut is not a licence to split it.
    let mut spec = dataflow("DeploymentService", 118.0, 120.0);
    spec["nodes"][0]["sublabel"] = json!("DeploymentServiceGateway");
    let result = report(&spec);
    assert!(result.ok, "{:?}", result.diagnostics);
    let primary = owned_label(&result, "a");
    assert_eq!(
        primary.text, "DeploymentService",
        "the primary never needed a cut, so it keeps one whole word"
    );
    assert_eq!(
        primary.font_size, FLOOR,
        "the primary steps down to the floor rather than cut its word"
    );
    let sublabel = role_label(&result, "a", "sublabel");
    assert!(
        sublabel.text.contains('\n'),
        "the sublabel's word alone fails every box and size, so it is cut: {:?}",
        sublabel.text
    );
    assert_eq!(sublabel.text.replace('\n', ""), "DeploymentServiceGateway");
}

#[test]
fn refusal_happens_only_when_the_floor_cannot_hold_the_text() {
    let label = "결제 Gateway 확인 처리 모듈";
    let mut refused = 0;
    let mut accepted = 0;
    for height in [36.0_f64, 48.0, 58.0, 80.0] {
        for width in [
            48.0_f64, 60.0, 80.0, 100.0, 118.0, 140.0, 160.0, 200.0, 240.0,
        ] {
            let result = report(&dataflow(label, width, height));
            let fits = floor_placement_fits(
                label,
                (width * 64.0).round() as i32,
                (height * 64.0).round() as i32,
            );
            assert_eq!(
                result.ok, fits,
                "{width}x{height}: engine ok={} but the floor placement at {}px fits={fits}; diagnostics={:?}",
                result.ok, FLOOR / 64, result.diagnostics
            );
            if result.ok {
                accepted += 1;
                painted_ink::assert_accepted_text_ink_fits(&result);
                painted_ink::assert_readable_floors(&result, "scan");
            } else {
                refused += 1;
                let diagnostic = fit_diagnostic(&result);
                assert_eq!(diagnostic.path, "/nodes/0/label");
                assert!(
                    !diagnostic.fix.is_empty() && !diagnostic.message.is_empty(),
                    "a refusal carries a cause and a fix"
                );
            }
        }
    }
    assert!(
        accepted > 0 && refused > 0,
        "the scan must exercise both verdicts: {accepted} accepted, {refused} refused"
    );
}

/// Repeatable label text long enough to force box growth.
fn long_label(words: usize) -> String {
    const WORDS: [&str; 7] = [
        "Deploy", "the", "payment", "service", "now", "please", "again",
    ];
    WORDS
        .iter()
        .cycle()
        .take(words)
        .cloned()
        .collect::<Vec<_>>()
        .join(" ")
}

fn dataflow_row(label: &str, view_box_height: f64) -> Value {
    json!({
        "schema_version": 1,
        "diagram_type": "dataflow",
        "meta": {"title": "auto-fit", "output": "auto-fit.html", "viewBox": [940, view_box_height]},
        "stages": [{"label": "Input"}, {"label": "Output"}],
        "nodes": [
            {"id": "a", "type": "frontend", "label": label, "stage": 0, "row": 3},
            {"id": "b", "type": "backend", "label": "Out", "stage": 1, "row": 1}
        ],
        "flows": []
    })
}

/// A grown node stops where its own slot ends, measured from its own top: the
/// workflow lane body below the node, the lifecycle band or row below it, or the
/// readable area the frame leaves. Growing into the slot the node does not own
/// would refuse the scene for a limit the auto-fit itself broke.
#[test]
fn a_grown_node_stops_at_the_body_below_its_own_top() {
    // Workflow: the lane body ends at 156px and an untagged default node starts
    // at 93, so 63px is left under it - not the whole 74px body.
    let lane = report(&workflow(&long_label(4), None));
    assert!(lane.ok, "{:?}", lane.diagnostics);
    let bounds = node_bounds(&lane, "a");
    assert!(
        bounds.height > 52 * 64,
        "the box absorbs the extra line: {bounds:?}"
    );
    assert!(
        bounds.y + bounds.height <= 156 * 64,
        "growth stays inside the lane body: {bounds:?}"
    );
    // One line further and the lane cannot hold the text: the refusal must name
    // the label, not blame the authored lane offset for a self-made overflow.
    let over = report(&workflow(&long_label(6), None));
    assert!(!over.ok, "the lane body cannot hold four lines: {over:?}");
    assert!(
        over.diagnostics
            .iter()
            .all(|diagnostic| !diagnostic.code.contains("lane")),
        "growth never manufactures a lane refusal: {:?}",
        over.diagnostics
    );

    // Lifecycle v1: the main band starts at 126 and the event band at 278, so a
    // main state may grow to 142px and no further.
    let band = report(&lifecycle_v1(&long_label(13)));
    assert!(band.ok, "{:?}", band.diagnostics);
    let state = node_bounds(&band, "a");
    assert!(state.height > 120 * 64, "the state grew: {state:?}");
    assert!(
        state.y + state.height <= 278 * 64,
        "the grown state never reaches the event band: {state:?}"
    );
    assert!(state.height <= 142 * 64, "{state:?}");

    // Lifecycle v2, third row: the canvas leaves 640-96-424 = 120px above the
    // frame, so a state that needs more steps down instead of being clipped.
    let canvas = report(&lifecycle_v2(&long_label(15), 640.0));
    assert!(canvas.ok, "{:?}", canvas.diagnostics);
    let third = node_bounds(&canvas, "c");
    assert_eq!(third.y, 424 * 64, "{third:?}");
    assert!(
        third.y + third.height <= (640.0 - 96.0) as i32 * 64,
        "the third row state stays inside the authored canvas: {third:?}"
    );
    painted_ink::assert_accepted_text_ink_fits(&canvas);
    painted_ink::assert_readable_floors(&canvas, "lifecycle-v2");

    // Dataflow: row 3 starts at 470 and the readable area ends at 640-74 = 566,
    // so the row pitch alone would grow past the canvas.
    let flow = report(&dataflow_row(&long_label(8), 640.0));
    assert!(flow.ok, "{:?}", flow.diagnostics);
    let node = node_bounds(&flow, "a");
    assert_eq!(node.y, 470 * 64, "{node:?}");
    assert!(
        node.y + node.height <= (640.0 - 74.0) as i32 * 64,
        "the grown node stays inside the readable area: {node:?}"
    );
}

/// Growth moves the ports: a left/right port sits at `bounds.y + height/2` and
/// the bottom port at `bounds.bottom()`. Routing reads the emitted bounds, so a
/// route authored across the old port still reaches the new one and is admitted.
#[test]
fn growth_moves_a_port_and_the_authored_route_still_reaches_it() {
    let route_between = |label: &str, via: Option<Vec<[f64; 2]>>| {
        let mut connection = json!({"id": "r", "from": "a", "to": "b"});
        if let Some(via) = via {
            connection["via"] = json!(via);
        }
        json!({
            "schema_version": 1,
            "diagram_type": "architecture",
            "meta": {"title": "ports", "output": "ports.html"},
            "layout": {"mode": "grid", "cols": 2},
            "components": [
                {"id": "a", "type": "backend", "label": label, "pos": [60, 80]},
                {"id": "b", "type": "frontend", "label": "Out", "pos": [360, 80], "size": [120, 60]}
            ],
            "connections": [connection]
        })
    };
    let short = report(&route_between("A", None));
    assert!(short.ok, "{:?}", short.diagnostics);
    let short_node = node_bounds(&short, "a");
    let short_route = &short.geometry.as_ref().expect("geometry").routes[0];
    let start = short_route.points[0];
    assert_eq!(
        start.x,
        short_node.x + short_node.width,
        "the route leaves the right port"
    );
    assert_eq!(
        start.y,
        short_node.y + short_node.height / 2,
        "a left/right port sits at the middle of the emitted height"
    );

    // Keep the middle of that route as an authored via, then grow the source.
    let via: Vec<[f64; 2]> = short_route.points[1..short_route.points.len() - 1]
        .iter()
        .map(|point| [f64::from(point.x) / 64.0, f64::from(point.y) / 64.0])
        .collect();
    assert!(!via.is_empty(), "the route needs an interior leg to author");
    let grown = report(&route_between("Deploy the payment service now", Some(via)));
    assert!(
        grown.ok,
        "an authored via route stays admitted when its endpoint grows: {:?}",
        grown.diagnostics
    );
    let grown_node = node_bounds(&grown, "a");
    assert!(
        grown_node.height > short_node.height,
        "the source grew: {grown_node:?}"
    );
    let grown_route = &grown.geometry.as_ref().expect("geometry").routes[0];
    assert_eq!(
        grown_route.points[0].x,
        grown_node.x + grown_node.width,
        "the route still starts on the emitted right port"
    );
    assert_eq!(
        grown_route.points[0].y,
        grown_node.y + grown_node.height / 2,
        "and on the port the grown height moved"
    );
}
