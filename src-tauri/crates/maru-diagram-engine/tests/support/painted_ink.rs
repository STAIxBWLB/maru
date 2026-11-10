use maru_diagram_engine::geometry::{GeometryDocument, GeometryNode, GeometryReport};

#[derive(Clone, Copy)]
struct OverflowAllowance {
    case_id: &'static str,
    diagram_type: &'static str,
    node_id: &'static str,
    label: &'static str,
    font_size_ticks: i64,
    overflow_ticks: Option<i64>,
}

pub const SOURCE_GREEN_INK_CASES: &[&str] = &[
    "public-01",
    "gate-sequence-brand-absent",
    "e2-boundary-sequence-brand-rail-7",
    "dense-workflow-seed-5502027",
];

const OVERFLOW_ALLOWLIST: &[OverflowAllowance] = &[
    OverflowAllowance {
        case_id: "public-01",
        diagram_type: "architecture",
        node_id: "system",
        label: "apt, systemd, /etc, homes",
        font_size_ticks: 704,
        overflow_ticks: Some(226),
    },
    OverflowAllowance {
        case_id: "gate-sequence-brand-absent",
        diagram_type: "sequence",
        node_id: "a",
        label: "BrandBrand",
        font_size_ticks: 832,
        overflow_ticks: Some(180),
    },
    OverflowAllowance {
        case_id: "e2-boundary-sequence-brand-rail-7",
        diagram_type: "sequence",
        node_id: "a",
        label: "WWWWWWW",
        font_size_ticks: 832,
        overflow_ticks: Some(577),
    },
    OverflowAllowance {
        case_id: "dense-workflow-seed-5502027",
        diagram_type: "workflow",
        node_id: "",
        label: "",
        font_size_ticks: 0,
        overflow_ticks: None,
    },
];

fn owned_node_label<'a>(
    geometry: &'a GeometryDocument,
    node: &GeometryNode,
) -> Vec<&'a maru_diagram_engine::geometry::GeometryLabel> {
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
        .collect()
}

fn ink_bounds(
    labels: &[&maru_diagram_engine::geometry::GeometryLabel],
) -> Option<(i64, i64, i64, i64)> {
    labels
        .iter()
        .flat_map(|label| &label.glyphs)
        .filter(|glyph| glyph.ink.width > 0 && glyph.ink.height > 0)
        .map(|glyph| {
            let left = i64::from(glyph.ink.x);
            let top = i64::from(glyph.ink.y);
            (
                left,
                top,
                left + i64::from(glyph.ink.width),
                top + i64::from(glyph.ink.height),
            )
        })
        .reduce(|a, b| (a.0.min(b.0), a.1.min(b.1), a.2.max(b.2), a.3.max(b.3)))
}

fn overflow_ticks(node: &GeometryNode, ink: (i64, i64, i64, i64)) -> i64 {
    let left = i64::from(node.bounds.x);
    let top = i64::from(node.bounds.y);
    let right = left + i64::from(node.bounds.width);
    let bottom = top + i64::from(node.bounds.height);
    (left - ink.0)
        .max(0)
        .max((ink.2 - right).max(0))
        .max((top - ink.1).max(0))
        .max((ink.3 - bottom).max(0))
}

fn observed_witnesses(report: &GeometryReport) -> String {
    let Some(geometry) = report.geometry.as_ref() else {
        return format!("geometry absent; diagnostics={:?}", report.diagnostics);
    };
    let candidates: Vec<_> = geometry
        .nodes
        .iter()
        .filter_map(|node| {
            let labels = owned_node_label(geometry, node);
            let ink = ink_bounds(&labels)?;
            let overflow = overflow_ticks(node, ink);
            let diagnostic_target = report
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.message.contains(&format!("{:?}", node.id)));
            (overflow > 0 || diagnostic_target).then(|| {
                format!(
                    "node={:?} bounds={:?} ink={ink:?} overflowTicks={overflow} labels={:?}",
                    node.id,
                    node.bounds,
                    labels
                        .iter()
                        .map(|label| (&label.id, &label.text, label.font_size, &label.font.id))
                        .collect::<Vec<_>>()
                )
            })
        })
        .collect();
    format!(
        "geometryCandidates={candidates:?}; diagnostics={:?}",
        report.diagnostics
    )
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
        if let Some(ink) = ink_bounds(&owned_node_label(geometry, node)) {
            assert_eq!(
                overflow_ticks(node, ink),
                0,
                "accepted layout has painted text outside node {} bounds",
                node.id
            );
        }
    }
}

/// Permit only a named source-green case with its independently measured Noto
/// font, label and fixed-point ink overflow. All diagnostic classes remain active.
pub fn assert_source_green_overflow_exception(
    report: &GeometryReport,
    case_id: &str,
    diagram_type: &str,
) {
    let Some(allowance) = OVERFLOW_ALLOWLIST
        .iter()
        .find(|allowance| allowance.case_id == case_id)
    else {
        panic!(
            "unlisted source-green engine refusal {case_id:?}: {}",
            observed_witnesses(report)
        );
    };
    assert_eq!(allowance.diagram_type, diagram_type, "case {case_id}");
    assert!(!report.ok, "paint overflow must not be admitted");
    let geometry = report
        .geometry
        .as_ref()
        .expect("measured text refusal retains placed geometry");
    let Some(expected_overflow) = allowance.overflow_ticks else {
        panic!(
            "case {case_id} is listed but its numeric witness is not confirmed: {}",
            observed_witnesses(report)
        );
    };
    let node = geometry
        .nodes
        .iter()
        .find(|node| !allowance.node_id.is_empty() && node.id == allowance.node_id)
        .unwrap_or_else(|| {
            panic!(
                "case {case_id} has no allowlisted target node {:?}: {}",
                allowance.node_id,
                observed_witnesses(report)
            )
        });
    let labels = owned_node_label(geometry, node);
    let label = labels
        .iter()
        .find(|label| label.text == allowance.label)
        .copied()
        .unwrap_or_else(|| {
            panic!(
                "case {case_id} has no allowlisted Noto label {:?} for node {:?}: {}",
                allowance.label,
                node.id,
                observed_witnesses(report)
            )
        });
    assert_eq!(label.font.id, "noto-sans-cjk-kr", "case {case_id}");
    assert_eq!(
        i64::from(label.font_size),
        allowance.font_size_ticks,
        "case {case_id}"
    );
    let Some(ink) = ink_bounds(&[label]) else {
        panic!("case {case_id} has no positioned painted glyphs");
    };
    let observed_overflow = overflow_ticks(node, ink);
    assert_eq!(
        observed_overflow,
        expected_overflow,
        "case {case_id} must retain its pinned 1/64px outer-node overflow; {}",
        observed_witnesses(report)
    );

    assert!(
        report.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == format!("{diagram_type}/geometry-label-fit")
                && diagnostic.message.contains(&format!("{:?}", node.id))
                && !diagnostic.path.is_empty()
                && !diagnostic.rule.is_empty()
                && !diagnostic.message.is_empty()
                && !diagnostic.fix.is_empty()
                && match diagram_type {
                    "sequence" => {
                        diagnostic.fix.contains("shorten")
                            && diagnostic.fix.contains("meta.column_fit")
                            && diagnostic.fix.contains("meta.viewBox")
                    }
                    "architecture" => diagnostic.fix.contains("size["),
                    _ => diagnostic.fix.contains("width") || diagnostic.fix.contains("height"),
                }
        }),
        "case {case_id} needs a per-node geometry-label-fit cause and family-specific fix: {:?}",
        report.diagnostics
    );

    for diagnostic in &report.diagnostics {
        if diagnostic.code == format!("{diagram_type}/geometry-route-quality-notice") {
            continue;
        }
        assert!(
            diagnostic.code == format!("{diagram_type}/geometry-label-fit")
                && diagnostic.message.contains(&format!("{:?}", node.id)),
            "measured text overflow must not excuse an unrelated refusal: {diagnostic:?}"
        );
    }
}

pub fn assert_source_green_report(report: &GeometryReport, case_id: &str, diagram_type: &str) {
    if report.ok {
        assert_accepted_text_ink_fits(report);
    } else {
        assert_source_green_overflow_exception(report, case_id, diagram_type);
    }
}
