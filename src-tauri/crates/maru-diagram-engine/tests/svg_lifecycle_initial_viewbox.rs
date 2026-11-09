#![cfg(feature = "render-svg")]

use maru_diagram_engine::{
    geometry::{GeometryDocument, GeometryPositionSource},
    layout::layout_json,
    render::{check_svg_artifact, render_svg, SvgOptions, SvgTheme},
    validate_json,
};
use serde_json::{json, Value};

const INITIAL_OFFSET_X: i32 = 22 * 64;
const INITIAL_RADIUS: i32 = 288;

fn spec(version: u32) -> Value {
    json!({
        "schema_version": version,
        "diagram_type": "lifecycle",
        "meta": {"title":"Initial marker extent", "output":"initial.html"},
        "lanes": [{"id":"main", "label":"Main"}],
        "states": [
            {"id":"start", "type":"start", "label":"Start", "lane":"main", "col":0},
            {"id":"done", "type":"success", "label":"Done", "lane":"main", "col":1}
        ],
        "transitions": []
    })
}

fn pinned_layout(source: &Value, start_x: i32) -> GeometryDocument {
    let source_json = source.to_string();
    let validity = validate_json(&source_json);
    assert!(
        validity.ok,
        "fixture validation failed: {:?}",
        validity.diagnostics
    );
    let request = json!({
        "specJson": source_json,
        "pinSet": {
            "sourceSpecSha256": validity.receipt.input_spec_sha256,
            "pins": [{
                "targetId":"start",
                "targetKind":"node",
                "position":{"x":start_x, "y":160 * 64}
            }]
        }
    });
    let report = layout_json(&request.to_string());
    // Boundary pins retain geometry while the existing lifecycle readable-area
    // rule refuses their source placement. Rendering must preserve that geometry.
    assert!(
        !report.ok,
        "boundary pin unexpectedly bypassed the E2 refusal"
    );
    assert!(!report.diagnostics.is_empty());
    assert!(
        report
            .diagnostics
            .iter()
            .all(|diagnostic| diagnostic.code == "lifecycle/geometry-node-viewbox"),
        "unexpected fixture diagnostics: {:?}",
        report.diagnostics
    );
    report.geometry.expect("refused layout retains geometry")
}

fn assert_marker_inside_page(geometry: &GeometryDocument, svg: &str) {
    let start = geometry
        .nodes
        .iter()
        .find(|node| node.id == "start")
        .expect("fixture has pinned start state");
    let dot_x = start.bounds.x - INITIAL_OFFSET_X;
    let dot_y = start.bounds.y + start.bounds.height / 2;
    let page = geometry.page.bounds;
    assert!(dot_x - INITIAL_RADIUS >= page.x);
    assert!(dot_y - INITIAL_RADIUS >= page.y);
    assert!(dot_x + INITIAL_RADIUS <= page.right().unwrap());
    assert!(dot_y + INITIAL_RADIUS <= page.bottom().unwrap());

    let document = roxmltree::Document::parse(svg).expect("rendered SVG is valid XML");
    let view_box: Vec<i32> = document
        .root_element()
        .attribute("viewBox")
        .expect("SVG has viewBox")
        .split_whitespace()
        .map(|part| (part.parse::<f64>().unwrap() * 64.0).round() as i32)
        .collect();
    assert_eq!(view_box, [page.x, page.y, page.width, page.height]);
    let dot = document
        .descendants()
        .find(|node| {
            node.attribute("data-kind") == Some("lifecycle-initial-dot")
                && node.attribute("data-target-id") == Some("start")
        })
        .expect("start state has its initial marker dot");
    let center_x = (dot.attribute("cx").unwrap().parse::<f64>().unwrap() * 64.0).round() as i32;
    let center_y = (dot.attribute("cy").unwrap().parse::<f64>().unwrap() * 64.0).round() as i32;
    let radius = (dot.attribute("r").unwrap().parse::<f64>().unwrap() * 64.0).round() as i32;
    assert_eq!((center_x, center_y, radius), (dot_x, dot_y, INITIAL_RADIUS));
    assert!(center_x - radius >= view_box[0]);
    assert!(center_y - radius >= view_box[1]);
    assert!(center_x + radius <= view_box[0] + view_box[2]);
    assert!(center_y + radius <= view_box[1] + view_box[3]);
    for divider in document
        .descendants()
        .filter(|node| node.attribute("data-kind") == Some("lifecycle-band"))
    {
        let x1 = (divider.attribute("x1").unwrap().parse::<f64>().unwrap() * 64.0).round() as i32;
        let x2 = (divider.attribute("x2").unwrap().parse::<f64>().unwrap() * 64.0).round() as i32;
        assert!(x1 >= view_box[0]);
        assert!(x2 <= view_box[0] + view_box[2]);
    }
}

#[test]
fn pinned_v1_and_v2_initial_markers_extend_page_without_moving_nodes() {
    for version in [1, 2] {
        for pinned_x in [0, -64] {
            let source = spec(version);
            let geometry = pinned_layout(&source, pinned_x);
            let start = geometry
                .nodes
                .iter()
                .find(|node| node.id == "start")
                .unwrap();
            assert_eq!(start.bounds.x, pinned_x, "lifecycle v{version}");
            assert_eq!(start.position_source, GeometryPositionSource::PlannedPin);

            let options = SvgOptions::from_spec(&source, SvgTheme::Light).unwrap();
            let report = render_svg(&geometry, &options);
            assert!(report.ok, "lifecycle v{version}: {:?}", report.diagnostics);
            let svg = report.svg.expect("successful render has SVG");
            assert_marker_inside_page(&geometry, &svg);
            assert!(check_svg_artifact(&svg, &geometry, &options).is_empty());

            let mut clipped = geometry.clone();
            clipped.page.bounds.x = 0;
            let rejected = render_svg(&clipped, &options);
            assert!(!rejected.ok, "clipped initial marker was accepted");
            assert!(rejected.diagnostics.iter().any(|diagnostic| {
                diagnostic.rule.contains("primitive-page-containment")
                    && !diagnostic.message.is_empty()
                    && !diagnostic.fix.is_empty()
            }));
        }
    }
}

#[test]
fn containment_gate_checks_non_initial_primitives_and_arrowhead_paint() {
    let source = spec(1);
    let geometry = pinned_layout(&source, 0);
    let options = SvgOptions::from_spec(&source, SvgTheme::Light).unwrap();

    let mut clipped_band = geometry.clone();
    clipped_band.page.bounds.y = 264 * 64;
    let band_report = render_svg(&clipped_band, &options);
    assert!(!band_report.ok);
    assert!(band_report.diagnostics.iter().any(|diagnostic| {
        diagnostic.rule.contains("primitive-page-containment")
            && diagnostic.path.contains("lifecycle-band")
    }));

    let rail_end_x = geometry
        .lifecycle_rail
        .as_ref()
        .expect("v1 main lane has a rail")
        .to
        .x;
    let mut clipped_arrow = geometry;
    // The path stroke fits, but the marker tip extends beyond its endpoint.
    clipped_arrow.page.bounds.width = rail_end_x + 96 - clipped_arrow.page.bounds.x;
    let arrow_report = render_svg(&clipped_arrow, &options);
    assert!(!arrow_report.ok);
    assert!(arrow_report.diagnostics.iter().any(|diagnostic| {
        diagnostic.rule.contains("primitive-page-containment")
            && diagnostic.path.contains("lifecycle-rail")
    }));
}

#[cfg(feature = "render-png")]
#[test]
fn pinned_initial_dot_is_visible_at_the_viewbox_edge_in_png() {
    use maru_diagram_engine::render::png::{render_png, PngOptions};

    for theme in [SvgTheme::Light, SvgTheme::Dark] {
        let source = spec(1);
        let geometry = pinned_layout(&source, 0);
        let options = SvgOptions::from_spec(&source, theme).unwrap();
        let artifact = render_png(&geometry, &options, PngOptions::default()).unwrap();
        let pixmap = resvg::tiny_skia::Pixmap::decode_png(&artifact.bytes).unwrap();
        let start = geometry
            .nodes
            .iter()
            .find(|node| node.id == "start")
            .unwrap();
        let dot_x = start.bounds.x - INITIAL_OFFSET_X;
        let dot_y = start.bounds.y + start.bounds.height / 2;
        let x = ((dot_x - geometry.page.bounds.x) / 64) as u32;
        let y = ((dot_y - geometry.page.bounds.y) / 64) as u32;
        let offset = ((y * pixmap.width() + x) * 4) as usize;
        let pixel = &pixmap.data()[offset..offset + 4];
        let expected = match theme {
            SvgTheme::Light => [5, 150, 105],
            SvgTheme::Dark => [52, 211, 153],
        };
        assert_eq!(&pixel[..3], &expected);
        assert_eq!(pixel[3], 255);
    }
}
