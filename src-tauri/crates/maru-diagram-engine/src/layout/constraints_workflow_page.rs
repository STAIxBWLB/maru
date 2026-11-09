//! Workflow page admission uses the authored page, never the grown diagnostic
//! scene page. All coordinates come from resolved engine geometry; this module
//! does not introduce a second readable-v2 placement model.
use crate::geometry::{GeometryBox, GeometryDocument};
use crate::layout::fixed::quantize_pixels;
use crate::Diagnostic;
use serde_json::Value;

const U: i64 = 64;
fn right(bounds: GeometryBox) -> i64 {
    i64::from(bounds.x) + i64::from(bounds.width)
}
fn bottom(bounds: GeometryBox) -> i64 {
    i64::from(bounds.y) + i64::from(bounds.height)
}
fn ceil_pixel(value: i64) -> i64 {
    value.div_euclid(U) + i64::from(value.rem_euclid(U) != 0)
}
fn error(axis: usize, actual: i64, required: i64, owner: &str) -> Diagnostic {
    Diagnostic {code:"workflow/geometry-viewbox-capacity".into(),path:format!("/meta/viewBox/{axis}"),rule:"geometry-v1/workflow-authored-page".into(),
        message:format!("workflow canvas {} {}px cannot contain {owner}; at least {}px is required",if axis==0{"width"}else{"height"},actual as f64/64.0,ceil_pixel(required)),
        fix:"increase meta.viewBox to contain the measured content, or move pinned nodes and frames inside the canvas".into()}
}
fn legend_extra(g: &GeometryDocument) -> i64 {
    // One measured single-line legend occupies18px plus its16px frame rail.
    // Count only additional resolved rows/lines; do not import foreign text
    // heuristics or infer a required page from the already grown page bounds.
    if g.legend.entries.is_empty() {
        0
    } else {
        (i64::from(g.legend.bounds.height) - 34 * U).max(0)
    }
}

fn lane_metrics(spec: &Value, g: &GeometryDocument) -> (i64, i64, i64) {
    let count = spec["lanes"].as_array().map_or(1, Vec::len).max(1) as i64;
    let lanes = g
        .containers
        .iter()
        .filter(|frame| frame.kind == "lane")
        .map(|frame| frame.bounds);
    let (mut max_right, mut max_bottom) = (None, None);
    for bounds in lanes {
        max_right = Some(max_right.unwrap_or(i64::MIN).max(right(bounds)));
        max_bottom = Some(max_bottom.unwrap_or(i64::MIN).max(bottom(bounds)));
    }
    (
        max_right.unwrap_or(680 * U),
        max_bottom.unwrap_or((52 + 104 * count + 20 * (count - 1)) * U),
        legend_extra(g),
    )
}
/// Fixed-v1 auto pages fit lanes and the legend, not arbitrary labels/routes.
/// V2 has no finite right/bottom budget when its page is omitted.
pub(crate) fn workflow_source_page(spec: &Value, g: &GeometryDocument) -> Option<[i64; 2]> {
    if spec["diagram_type"].as_str() != Some("workflow") {
        return None;
    }
    if let Some(page) = spec["meta"]["viewBox"].as_array().filter(|p| p.len() == 2) {
        return Some([
            i64::from(quantize_pixels(page[0].as_f64()?).ok()?),
            i64::from(quantize_pixels(page[1].as_f64()?).ok()?),
        ]);
    }
    if spec["schema_version"].as_u64().unwrap_or(1) != 1 {
        return None;
    }
    let (_, lane_bottom, extra) = lane_metrics(spec, g);
    Some([720 * U, lane_bottom + 124 * U + extra])
}

pub(crate) fn workflow_page_diagnostics(spec: &Value, g: &GeometryDocument) -> Vec<Diagnostic> {
    if spec["diagram_type"].as_str() != Some("workflow") {
        return Vec::new();
    }
    let source_page = workflow_source_page(spec, g);
    let (lane_right, lane_bottom, extra) = lane_metrics(spec, g);
    let mut output = Vec::new();
    if spec["schema_version"].as_u64().unwrap_or(1) == 1 {
        let Some([width, height]) = source_page else {
            return output;
        };
        // Fixed-v1 compiler checks lanes+16 and legendY()+18 regardless of
        // profile/legend visibility. legendY is lastLaneBottom+44+extra rows.
        let required_width = lane_right + 16 * U;
        let required_height = lane_bottom + 62 * U + extra;
        if width < required_width {
            output.push(error(
                0,
                width,
                required_width,
                "fixed-v1 lanes and16px right padding",
            ));
        }
        if height < required_height {
            output.push(error(
                1,
                height,
                required_height,
                "fixed-v1 legend position and18px bottom padding",
            ));
        }
        return output;
    }
    // The readable compiler includes nodes, routes, masks, structural frames
    // and resolved legend boxes before adding16px right/18px bottom padding.
    // Minimum intrinsic height is the resolved lane stack plus124px and rows.
    let mut required_right = lane_right;
    let mut required_bottom = lane_bottom + 62 * U + extra;
    let mut min_x = 0_i64;
    let mut min_y = 0_i64;
    let mut right_owner = "resolved lanes".to_owned();
    let mut bottom_owner = "resolved lanes and legend reserve".to_owned();
    let mut include = |bounds: GeometryBox, owner: String| {
        min_x = min_x.min(i64::from(bounds.x));
        min_y = min_y.min(i64::from(bounds.y));
        if right(bounds) > required_right {
            required_right = right(bounds);
            right_owner = owner.clone();
        }
        if bottom(bounds) > required_bottom {
            required_bottom = bottom(bounds);
            bottom_owner = owner;
        }
    };
    for node in &g.nodes {
        include(node.bounds, format!("node {:?}", node.id));
    }
    for frame in &g.containers {
        include(frame.bounds, format!("frame {:?}", frame.id));
    }
    for label in &g.labels {
        include(label.bounds, format!("label target {:?}", label.target_id));
    }
    if !g.legend.entries.is_empty() {
        include(g.legend.bounds, "resolved legend".into());
    }
    for route in &g.routes {
        for point in &route.points {
            include(
                GeometryBox {
                    x: point.x,
                    y: point.y,
                    width: 0,
                    height: 0,
                },
                format!("route {:?}", route.id),
            );
        }
    }
    if min_x < 0 || min_y < 0 {
        output.push(Diagnostic{code:"workflow/geometry-viewbox-capacity".into(),path:"/meta/viewBox".into(),rule:"geometry-v1/workflow-authored-page".into(),
            message:format!("resolved workflow geometry starts before the page origin at [{},{}]px",min_x as f64/64.0,min_y as f64/64.0),
            fix:"move the offending authored node, frame, route or label inside the origin; enlarging the page cannot repair left/top overflow".into()});
    }
    // Omitted v2 pages grow right/bottom, but cannot repair a negative origin.
    let Some([width, height]) = source_page else {
        return output;
    };
    let required_width = ceil_pixel(required_right + 16 * U) * U;
    let required_height =
        (ceil_pixel(required_bottom + 18 * U) * U).max(lane_bottom + 124 * U + extra);
    if width < required_width {
        output.push(error(0, width, required_width, &right_owner));
    }
    if height < required_height {
        output.push(error(1, height, required_height, &bottom_owner));
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn source(version: u64) -> Value {
        json!({"schema_version":version,"diagram_type":"workflow","meta":{"title":"Page","output":"page.html"},"lanes":[{"id":"main","label":"Main"}],"nodes":[{"id":"a","type":"frontend","label":"A","lane":"main","col":0},{"id":"b","type":"backend","label":"B","lane":"main","col":2}],"edges":[]})
    }
    fn scene(spec: &Value) -> GeometryDocument {
        crate::layout::layout_json(&json!({"specJson":spec.to_string()}).to_string())
            .geometry
            .expect("diagnostic scene remains available")
    }
    #[test]
    fn auto_v2_growth_still_refuses_resolved_negative_origins() {
        let spec = source(2);
        let mut g = scene(&spec);
        g.nodes[0].bounds.x = -5 * 64;
        assert!(workflow_source_page(&spec, &g).is_none());
        let diagnostics = workflow_page_diagnostics(&spec, &g);
        assert!(
            diagnostics.iter().any(
                |d| d.code == "workflow/geometry-viewbox-capacity" && d.path == "/meta/viewBox"
            ),
            "{diagnostics:?}"
        );
    }

    #[test]
    fn fixed_v1_authored_bottom_does_not_use_the_grown_scene_height() {
        let mut spec = source(1);
        spec["lanes"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"other","label":"Other"}));
        spec["meta"]["viewBox"] = json!([700, 341]);
        assert!(crate::validate_json(&spec.to_string()).ok);
        let g = scene(&spec);
        assert!(g.page.bounds.height > 341 * 64);
        assert!(workflow_page_diagnostics(&spec, &g)
            .iter()
            .any(|d| d.path == "/meta/viewBox/1"));
        spec["meta"]["viewBox"] = json!([700, 343]);
        assert!(workflow_page_diagnostics(&spec, &scene(&spec)).is_empty());
    }
    #[test]
    fn fixed_v1_resolved_lane_pin_can_exceed_an_authored_right_edge() {
        let mut spec = source(1);
        spec["meta"]["viewBox"] = json!([700, 300]);
        let mut g = scene(&spec);
        g.containers
            .iter_mut()
            .find(|f| f.kind == "lane")
            .unwrap()
            .bounds
            .x = 100 * 64;
        assert!(workflow_page_diagnostics(&spec, &g)
            .iter()
            .any(|d| d.path == "/meta/viewBox/0"));
        spec["meta"].as_object_mut().unwrap().remove("viewBox");
        assert!(workflow_page_diagnostics(&spec, &g)
            .iter()
            .any(|d| d.path == "/meta/viewBox/0"));
        // Default v1 lane right+16=696 is below E1's700px minimum, so a
        // source-only narrow-width refusal is unreachable after E1 admission.
    }
    #[test]
    fn readable_v2_authored_right_uses_resolved_nodes_and_frames() {
        let mut spec = source(2);
        spec["nodes"][1]["col"] = json!(5);
        spec["meta"]["viewBox"] = json!([700, 300]);
        assert!(crate::validate_json(&spec.to_string()).ok);
        assert!(workflow_page_diagnostics(&spec, &scene(&spec))
            .iter()
            .any(|d| d.path == "/meta/viewBox/0"));
    }
    #[test]
    fn readable_v2_authored_bottom_counts_labels_but_auto_page_is_allowed() {
        let mut spec = source(2);
        spec["meta"]["viewBox"] = json!([1000, 300]);
        spec["edges"] = json!([{"from":"a","to":"b","label":"Call","labelAt":[700,500]}]);
        assert!(crate::validate_json(&spec.to_string()).ok);
        let g = scene(&spec);
        assert!(g.page.bounds.height > 300 * 64);
        assert!(workflow_page_diagnostics(&spec, &g)
            .iter()
            .any(|d| d.path == "/meta/viewBox/1"));
        spec["meta"].as_object_mut().unwrap().remove("viewBox");
        assert!(workflow_page_diagnostics(&spec, &scene(&spec)).is_empty());
    }
    #[test]
    fn fixed_v1_implicit_page_budget_does_not_follow_a_far_label() {
        let mut spec = source(1);
        spec["meta"]["quality_profile"] = json!("showcase");
        spec["edges"] = json!([{"from":"a","to":"b","label":"Call","labelAt":[900,200]}]);
        let g = scene(&spec);
        assert!(g.page.bounds.width > 720 * 64);
        assert_eq!(workflow_source_page(&spec, &g).unwrap()[0], 720 * 64);
        assert!(
            crate::layout::layout_json(&json!({"specJson":spec.to_string()}).to_string())
                .diagnostics
                .iter()
                .any(|d| d.code == "workflow/geometry-label-viewbox")
        );
    }
}
