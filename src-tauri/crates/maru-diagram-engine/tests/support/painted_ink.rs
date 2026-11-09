use maru_diagram_engine::geometry::GeometryReport;

fn node_has_ink_outside_bounds(
    geometry: &maru_diagram_engine::geometry::GeometryDocument,
    node: &maru_diagram_engine::geometry::GeometryNode,
) -> bool {
    let left = i64::from(node.bounds.x);
    let top = i64::from(node.bounds.y);
    let right = left + i64::from(node.bounds.width);
    let bottom = top + i64::from(node.bounds.height);
    let prefix = format!("node:{}:", node.id);
    geometry
        .labels
        .iter()
        .filter(|label| {
            label.target_id == node.id
                && label
                    .id
                    .as_deref()
                    .is_some_and(|id| id.starts_with(&prefix))
        })
        .flat_map(|label| &label.glyphs)
        .filter(|glyph| glyph.ink.width > 0 && glyph.ink.height > 0)
        .any(|glyph| {
            let ink_left = i64::from(glyph.ink.x);
            let ink_top = i64::from(glyph.ink.y);
            let ink_right = ink_left + i64::from(glyph.ink.width);
            let ink_bottom = ink_top + i64::from(glyph.ink.height);
            ink_left < left || ink_top < top || ink_right > right || ink_bottom > bottom
        })
}

pub fn assert_accepted_text_ink_fits(report: &GeometryReport) {
    if !report.ok {
        return;
    }
    let geometry = report
        .geometry
        .as_ref()
        .expect("accepted layout retains placed geometry");
    for node in &geometry.nodes {
        assert!(
            !node_has_ink_outside_bounds(geometry, node),
            "accepted layout has painted text outside node {} bounds",
            node.id
        );
    }
}

/// Permit a source-green refusal only when the retained Noto glyph ink itself
/// crosses a node box and the report names that node with a geometry-label-fit
/// cause and an actionable width/height fix.
pub fn assert_measured_ink_overflow_refusal(report: &GeometryReport, diagram_type: &str) {
    assert!(!report.ok, "paint overflow must not be admitted");
    let geometry = report
        .geometry
        .as_ref()
        .expect("measured text refusal retains placed geometry");
    let mut overflowed_nodes = Vec::new();

    for node in &geometry.nodes {
        if !node_has_ink_outside_bounds(geometry, node) {
            continue;
        }

        overflowed_nodes.push(&node.id);
        assert!(
            report.diagnostics.iter().any(|diagnostic| {
                diagnostic.code == format!("{diagram_type}/geometry-label-fit")
                    && diagnostic.message.contains(&format!("{:?}", node.id))
                    && !diagnostic.path.is_empty()
                    && !diagnostic.rule.is_empty()
                    && !diagnostic.message.is_empty()
                    && diagnostic.fix.contains("shorten")
                    && diagnostic.fix.contains("width/height")
            }),
            "node {} has painted ink outside its retained box without its geometry-label-fit cause and fix: {:?}",
            node.id,
            report.diagnostics
        );
    }

    assert!(
        !overflowed_nodes.is_empty(),
        "source-green refusal needs measured glyph ink outside a retained node box"
    );
    for diagnostic in &report.diagnostics {
        if diagnostic.code == format!("{diagram_type}/geometry-route-quality-notice") {
            continue;
        }
        assert!(
            diagnostic.code == format!("{diagram_type}/geometry-label-fit")
                && overflowed_nodes
                    .iter()
                    .any(|id| diagnostic.message.contains(&format!("{id:?}"))),
            "measured text overflow must not excuse an unrelated refusal: {diagnostic:?}"
        );
    }
}
