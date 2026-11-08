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
