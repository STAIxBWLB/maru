//! The writer's view of the render primitives.
//!
//! The rules themselves live in `crate::primitives`, which the layout build also
//! compiles so it can publish the same list as part of the geometry report
//! (`maru#552` E4). This module keeps the writer-side validation that needs the
//! theme, and paints the primitives the shared rules produced.
use super::{error, SvgOptions};
use crate::geometry::GeometryDocument;
pub(crate) use crate::primitives::{
    dash, frame_dash, node_caption, Layer, Paint, Primitive, Shape, KINDS,
};
use crate::semantics::SemanticContext;
use crate::Diagnostic;

/// Validate the injected semantic context against the theme and the retained
/// geometry, then hand it to the shared derivation.
pub(crate) fn context<'a>(
    g: &GeometryDocument,
    o: &'a SvgOptions,
) -> Result<&'a SemanticContext, Diagnostic> {
    let c = o.semantics.as_ref().ok_or_else(|| {
        error(
            "semantic-source",
            "/specJson",
            "SVG semantic context is missing",
            "provide the matching source spec JSON or build SvgOptions with from_spec",
        )
    })?;
    if ![
        "architecture",
        "workflow",
        "sequence",
        "dataflow",
        "lifecycle",
    ]
    .contains(&c.family.as_str())
    {
        return Err(error(
            "semantic-family",
            "/options/semantics",
            "SVG semantic family is unsupported",
            "use one of the five E3 diagram families",
        ));
    }
    if ![1, 2].contains(&c.schema_version) {
        return Err(error(
            "semantic-version",
            "/options/semantics/schemaVersion",
            "semantic schema version is unsupported",
            "provide an accepted version 1 or 2 source snapshot",
        ));
    }
    for entry in &g.legend.entries {
        let route = c.family == "sequence" || (c.family == "dataflow" && entry.key != "database");
        if !route && o.theme.kind(&entry.key).is_none() {
            return Err(error(
                "semantic-kind",
                "/legend",
                "legend kind has no semantic theme token",
                "use the accepted legend catalog for the matching diagram family",
            ));
        }
    }
    for label in &g.labels {
        if label.id.as_deref() == Some(format!("edge:{}:label", label.target_id).as_str())
            && g.routes
                .iter()
                .any(|route| route.id.as_deref() == Some(label.target_id.as_str()))
            && !c.route_labels.contains_key(&label.target_id)
        {
            return Err(error(
                "label-source",
                "/options/semantics/routeLabels",
                "route label lacks its matching primary/detail semantic record",
                "provide the matching source spec to retain label role and variant accents",
            ));
        }
    }
    for n in &g.nodes {
        if c.nodes
            .get(&n.id)
            .is_some_and(|node| o.theme.kind(&node.kind).is_none())
        {
            return Err(error(
                "semantic-kind",
                "/nodes",
                "node kind has no semantic theme token",
                "use an accepted semantic node type and the matching source snapshot",
            ));
        }
        if !c.nodes.contains_key(&n.id) {
            return Err(error(
                "semantic-node",
                "/options/semantics/nodes",
                format!("placed node {:?} has no source semantic type", n.id),
                "provide the matching source spec snapshot rather than a different diagram",
            ));
        }
        if c.family == "lifecycle" && n.final_state.is_none() {
            return Err(error(
                "semantic-final",
                "/nodes",
                "lifecycle geometry has no final-state classification",
                "recompute layout with the E3-capable API v1 producer before rendering",
            ));
        }
    }
    Ok(c)
}

pub(crate) fn derive(g: &GeometryDocument, o: &SvgOptions) -> Result<Vec<Primitive>, Diagnostic> {
    let c = context(g, o)?;
    crate::primitives::derive(g, c)
}
