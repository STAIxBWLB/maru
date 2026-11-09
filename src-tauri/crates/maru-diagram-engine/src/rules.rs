//! Stable API-v1 diagnostic namespace. The host corpus rule table enumerates
//! and differentially exercises reachable constraints for each family.
pub const DOCUMENT_TYPES: &[&str] = &[
    "architecture",
    "workflow",
    "sequence",
    "dataflow",
    "lifecycle",
];
pub(crate) fn qualified(kind: &str, constraint: &str) -> (String, String) {
    (
        format!("{kind}/{constraint}"),
        format!("{kind}-v1/{constraint}"),
    )
}

/// Geometry keeps the API-v1 family code namespace while identifying the
/// deterministic constraint contract independently of implementation stages.
#[cfg(feature = "geometry")]
pub(crate) fn geometry_qualified(kind: &str, constraint: &str) -> (String, String) {
    (
        format!("{kind}/{constraint}"),
        format!("geometry-v1/{constraint}"),
    )
}

/// Family-scoped geometry codes, independent of host oracle regexes/cases.
/// Document-validity codes remain in the separately checked E1 rule inventory.
#[cfg(feature = "geometry")]
pub fn geometry_rule_codes(kind: &str) -> Vec<String> {
    let specific: &[&str] = match kind {
        "architecture" => &[
            "geometry-route-viewbox",
            "geometry-node-overlap",
            "geometry-node-viewbox",
            "geometry-boundary-title-fit",
            "geometry-container-containment",
            "geometry-route-distance",
        ],
        "workflow" => &[
            "geometry-route-viewbox",
            "geometry-column-capacity",
            "geometry-node-overlap",
            "geometry-node-lane",
            "geometry-container-containment",
            "geometry-phase-range",
            "geometry-group-containment",
        ],
        "sequence" => &[
            "geometry-message-time",
            "geometry-message-spacing",
            "geometry-segment-range",
            "geometry-segment-label-fit",
            "geometry-participant-canvas-width",
            "geometry-legend-clearance",
            "geometry-route-distance",
        ],
        "dataflow" => &[
            "geometry-node-overlap",
            "geometry-node-viewbox",
            "fixed-row-slots",
            "stage-canvas-width",
            "geometry-route-distance",
        ],
        "lifecycle" => &[
            "geometry-node-overlap",
            "geometry-node-viewbox",
            "geometry-state-column",
            "reserved-main-lane",
            "geometry-route-distance",
        ],
        _ => return Vec::new(),
    };
    specific
        .iter()
        .copied()
        .chain([
            "geometry-label-fit",
            "geometry-label-viewbox",
            "geometry-label-overlap",
            "geometry-route-clearance",
            "geometry-route-quality",
            "geometry-route-quality-notice",
            "route-endpoint",
            "route-label-space",
            "route-port-blocked",
            "route-blocked",
            "route-budget",
            "layout-range",
        ])
        .map(|suffix| format!("{kind}/{suffix}"))
        .collect()
}
