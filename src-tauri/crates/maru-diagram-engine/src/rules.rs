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
