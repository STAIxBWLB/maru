//! Text-ink evidence shared by the geometry corpus tests.
//!
//! Two guards live here. `assert_accepted_text_ink_fits` holds the original
//! rule: an accepted scene never paints a node's text outside that node.
//! `assert_auto_fit_readable` records the deliberate inverse: engine auto-fit
//! (`maru#552` T6) accepts some cases the JS reference model still refuses, and
//! each of those has to be named and proved readable from the engine's own
//! output rather than waived.
//!
//! Each test binary includes this file separately and uses the part it needs,
//! so the unused-in-this-binary items are expected rather than dead.
#![allow(dead_code)]

use maru_diagram_engine::geometry::{
    GeometryDocument, GeometryLabel, GeometryNode, GeometryReport,
};
use serde_json::Value;

/// The readable floor auto-fit may shrink to: Maru's `--type-micro-size`, the
/// smallest type step the product ships (`src/foundations.css`).
pub const READABLE_FLOOR_TICKS: i64 = 10 * 64;

/// Engine refusals that were once allowed because they were measured Noto ink
/// overflows. Auto-fit (`maru#560` follow-up, `maru#552` T6) makes every one of
/// them readable, so the list is empty and any new measured-ink refusal fails.
pub const SOURCE_GREEN_INK_CASES: &[&str] = &[];

/// Cases where auto-fit accepts what the reference model refuses, one entry per
/// case: the case id and the fit actions the engine applied, in the canonical
/// form `kind:node[:role][:ticks]` produced by [`observed_auto_fit_actions`].
pub const AUTO_FIT_BEYOND_MODEL: &[(&str, &[&str])] = &[
    (
        "e2-architecture-geometry-label-fit-primary",
        &["grow:a:3840", "shrink:a:label:640", "wrap:a"],
    ),
    (
        "e2-dataflow-geometry-label-fit-primary",
        &["grow:a:3712", "shrink:a:label:640", "wrap:a"],
    ),
    (
        "e2-lifecycle-geometry-label-fit-primary",
        // The main band leaves 142px below its own top, so this label grows
        // into the band instead of past it and takes the 12px step.
        &["grow:a:3968", "shrink:a:label:768", "wrap:a"],
    ),
    (
        "e2-lifecycle-geometry-label-fit-detail",
        &[
            "grow:a:3968",
            "shrink:a:label:768",
            "shrink:a:sublabel:640",
            "wrap:a",
        ],
    ),
    (
        "e2-lifecycle-geometry-label-fit-tag",
        &["grow:a:3968", "wrap:a"],
    ),
    // Boundary cases: the same refusal on the model's character-estimate side,
    // accepted because the engine measures the real Noto ink instead.
    (
        "e2-boundary-dataflow-primary-width-below",
        &["grow:a:3712", "wrap:a"],
    ),
    (
        "e2-boundary-dataflow-detail-width-sublabel-below",
        &["grow:a:3712", "wrap:a"],
    ),
    (
        "e2-boundary-dataflow-detail-width-tag-below",
        &["grow:a:3712", "wrap:a"],
    ),
    (
        "e2-boundary-lifecycle-v1-primary-width-below",
        &["grow:a:3968", "wrap:a"],
    ),
    (
        "e2-boundary-lifecycle-v1-detail-width-sublabel-below",
        &["grow:a:3968", "wrap:a"],
    ),
    (
        "e2-boundary-lifecycle-v1-detail-width-tag-below",
        &["grow:a:3968", "wrap:a"],
    ),
    ("e2-boundary-lifecycle-v2-primary-width-below", &["wrap:a"]),
    (
        "e2-boundary-lifecycle-v2-detail-width-sublabel-below",
        &["grow:a:4096", "wrap:a"],
    ),
    (
        "e2-boundary-lifecycle-v2-detail-width-tag-below",
        &["grow:a:4096", "wrap:a"],
    ),
    (
        "e2-boundary-sequence-spread-primary-header-below",
        &["shrink:a:label:768", "wrap:a"],
    ),
    ("e2-boundary-sequence-brand-rail-9", &["wrap:a"]),
];

/// Boundary cases the engine already accepted beyond the reference model at the
/// `#567` head, before auto-fit existed. Real measurement alone clears them, so
/// each must carry no auto-fit action; naming them keeps the T6 allowance above
/// from absorbing a difference it did not create.
pub const BOUNDARY_ACCEPTED_BEFORE_AUTO_FIT: &[&str] = &[
    "e2-boundary-architecture-brand-rail-71",
    "e2-boundary-dataflow-brand-rail-71",
    "e2-boundary-lifecycle-brand-rail-71",
    "e2-boundary-lifecycle-physical-corridor-7",
    "e2-boundary-lifecycle-band-title-113.984375",
    "e2-boundary-sequence-family-label-route-below",
    "e2-boundary-sequence-label-pair-193.984375",
    "e2-boundary-workflow-brand-rail-71",
    "e2-boundary-workflow-brand-rail-73",
    "e2-boundary-workflow-v2-arrow-spacing-8",
    "e2-boundary-workflow-v2-turn-7",
    "e2-boundary-workflow-v2-route-legend-191",
    "e2-boundary-workflow-v2-label-legend-187",
];

fn owned_node_labels<'a>(
    geometry: &'a GeometryDocument,
    node: &GeometryNode,
) -> Vec<&'a GeometryLabel> {
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

fn ink_bounds(labels: &[&GeometryLabel]) -> Option<(i64, i64, i64, i64)> {
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
            let labels = owned_node_labels(geometry, node);
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

/// The height a node would carry without auto-fit: the source's authored height
/// or the family's own default, copied from the layout constants (`120x60`
/// architecture, `92/52/68` workflow, `112x58` dataflow, `118/62/58/140x64`
/// lifecycle, `60` sequence header).
fn base_height_ticks(spec: &Value, node_id: &str) -> i64 {
    fn authored(items: Option<&Value>, node_id: &str, key: &str) -> Option<f64> {
        items
            .and_then(Value::as_array)
            .and_then(|items| items.iter().find(|item| item["id"] == node_id))
            .and_then(|item| item[key].as_f64())
    }
    let family = spec["diagram_type"].as_str().unwrap_or_default();
    let collection = match family {
        "architecture" => "components",
        "workflow" | "dataflow" => "nodes",
        "lifecycle" => "states",
        _ => "",
    };
    let items = spec.get(collection);
    let fallback = match family {
        "architecture" => 60.0,
        "workflow" => {
            let tagged = items
                .and_then(Value::as_array)
                .and_then(|items| items.iter().find(|item| item["id"] == node_id))
                .is_some_and(|item| item.get("tag").is_some_and(|tag| !tag.is_null()));
            if tagged {
                68.0
            } else {
                52.0
            }
        }
        "dataflow" => 58.0,
        "lifecycle" => {
            if spec["schema_version"].as_u64().unwrap_or(1) == 2 {
                64.0
            } else {
                let lane = items
                    .and_then(Value::as_array)
                    .and_then(|items| items.iter().find(|item| item["id"] == node_id))
                    .and_then(|item| item["lane"].as_str().map(str::to_owned))
                    .unwrap_or_default();
                if lane == "main" {
                    62.0
                } else {
                    58.0
                }
            }
        }
        _ => 60.0,
    };
    let key = if family == "architecture" {
        "size"
    } else {
        "height"
    };
    let authored = if family == "architecture" {
        items
            .and_then(Value::as_array)
            .and_then(|items| items.iter().find(|item| item["id"] == node_id))
            .and_then(|item| item["size"][1].as_f64())
    } else {
        authored(items, node_id, key)
    };
    ((authored.unwrap_or(fallback)) * 64.0).round() as i64
}

/// The fit actions this scene proves from its own output, in the canonical form
/// `grow:node:baseHeightTicks`, `shrink:node:role:sizeTicks` and `wrap:node`.
pub fn observed_auto_fit_actions(report: &GeometryReport, spec: &Value) -> Vec<String> {
    let Some(geometry) = report.geometry.as_ref() else {
        return Vec::new();
    };
    let mut actions = Vec::new();
    for node in &geometry.nodes {
        let labels = owned_node_labels(geometry, node);
        if !labels.is_empty() && i64::from(node.bounds.height) > base_height_ticks(spec, &node.id) {
            actions.push(format!(
                "grow:{}:{}",
                node.id,
                base_height_ticks(spec, &node.id)
            ));
        }
        for label in labels {
            let role = label
                .id
                .as_deref()
                .and_then(|id| id.rsplit(':').next())
                .unwrap_or("label");
            let base = match role {
                "label" => 832,
                "sublabel" => 704,
                _ => 640,
            };
            if i64::from(label.font_size) < base {
                actions.push(format!("shrink:{}:{}:{}", node.id, role, label.font_size));
            }
            if label.text.contains('\n') {
                actions.push(format!("wrap:{}", node.id));
            }
        }
    }
    actions.sort();
    actions.dedup();
    actions
}

/// Prove that a scene the reference model refuses is nevertheless accepted and
/// readable as Maru draws it, and report the fit actions it applied.
pub fn assert_auto_fit_readable(
    report: &GeometryReport,
    spec: &Value,
    case_id: &str,
) -> Vec<String> {
    assert!(report.ok, "case {case_id} is not accepted as claimed");
    assert_accepted_text_ink_fits(report);
    assert_readable_floors(report, case_id);
    let actions = observed_auto_fit_actions(report, spec);
    assert!(
        !actions.is_empty(),
        "case {case_id} accepts beyond the model without naming a fit action: {:?}",
        observed_witnesses(report)
    );
    actions
}

/// No auto-fit placement draws node text below the readable floor.
pub fn assert_readable_floors(report: &GeometryReport, case_id: &str) {
    let Some(geometry) = report.geometry.as_ref() else {
        return;
    };
    for node in &geometry.nodes {
        for label in owned_node_labels(geometry, node) {
            assert!(
                i64::from(label.font_size) >= READABLE_FLOOR_TICKS,
                "case {case_id}: node {} label {:?} is {} ticks, below the {} tick readable floor",
                node.id,
                label.id,
                label.font_size,
                READABLE_FLOOR_TICKS
            );
        }
    }
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
        if let Some(ink) = ink_bounds(&owned_node_labels(geometry, node)) {
            assert_eq!(
                overflow_ticks(node, ink),
                0,
                "accepted layout has painted text outside node {} bounds",
                node.id
            );
        }
    }
}
