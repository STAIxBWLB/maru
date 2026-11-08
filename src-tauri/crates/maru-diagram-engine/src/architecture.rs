//! Architecture document validity; no placement or routing computation.
use super::common::{self, Card, Decoration, Meta, Point, COMPONENT_TYPES, SIDES, VARIANTS};
use crate::Diagnostic;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

pub type ArchitectureMeta = Meta;

pub(crate) const ARCHITECTURE_ROUTES: &[&str] =
    &["auto", "straight", "orthogonal-h", "orthogonal-v"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[serde(deny_unknown_fields)]
pub struct ArchitectureSpec {
    pub schema_version: u32,
    pub diagram_type: String,
    pub meta: Meta,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub layout: Option<ArchitectureLayout>,
    pub components: Vec<ArchitectureComponent>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(as = "Option<_>", optional))]
    pub connections: Vec<ArchitectureConnection>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(as = "Option<_>", optional))]
    pub boundaries: Vec<ArchitectureBoundary>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(as = "Option<_>", optional))]
    pub cards: Vec<Card>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[serde(deny_unknown_fields)]
pub struct ArchitectureLayout {
    pub mode: String,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub origin: Option<Point>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub cols: Option<u32>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    #[serde(rename = "gapX")]
    pub gap_x: Option<f64>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    #[serde(rename = "gapY")]
    pub gap_y: Option<f64>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    #[serde(rename = "cellW")]
    pub cell_w: Option<f64>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    #[serde(rename = "cellH")]
    pub cell_h: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
pub struct ArchitectureComponent {
    pub id: String,
    #[serde(rename = "type")]
    pub component_type: String,
    pub label: String,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub row: Option<f64>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub col: Option<f64>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub pos: Option<Point>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub size: Option<Point>,
    #[serde(flatten)]
    #[cfg_attr(feature = "typegen", ts(flatten))]
    pub decoration: Decoration,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[serde(deny_unknown_fields)]
pub struct ArchitectureBoundary {
    pub kind: String,
    pub label: String,
    pub wraps: Vec<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub pad: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[serde(deny_unknown_fields)]
pub struct ArchitectureConnection {
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub id: Option<String>,
    pub from: String,
    pub to: String,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub label: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub variant: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    #[serde(rename = "fromSide")]
    pub from_side: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    #[serde(rename = "toSide")]
    pub to_side: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub route: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub via: Option<Vec<Point>>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    #[serde(rename = "labelAt")]
    pub label_at: Option<Point>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    #[serde(rename = "labelDx")]
    pub label_dx: Option<f64>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    #[serde(rename = "labelDy")]
    pub label_dy: Option<f64>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    #[serde(rename = "labelSegment")]
    pub label_segment: Option<f64>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub width: Option<f64>,
}

pub(crate) fn validate(value: Value) -> Vec<Diagnostic> {
    let mut ctx = common::base(
        &value,
        "architecture",
        &[
            "schema_version",
            "diagram_type",
            "meta",
            "layout",
            "components",
            "connections",
            "boundaries",
            "cards",
        ],
        &["engineering_profile"],
        (320.0, 240.0),
    );
    if let Some(items) = value["components"].as_array() {
        for (i, item) in items.iter().enumerate() {
            ctx.fields(
                item,
                &format!("/components/{i}"),
                &[
                    "id", "type", "label", "sublabel", "tag", "icon", "brand", "sources", "row",
                    "col", "pos", "size",
                ],
            );
        }
    }
    let Some(spec) = common::decode::<ArchitectureSpec>(&value, &mut ctx) else {
        return ctx.finish();
    };
    ctx.cardinality(spec.components.len(), 1, "/components");
    let mut ids = HashSet::new();
    for (i, node) in spec.components.iter().enumerate() {
        let p = format!("/components/{i}");
        ctx.insert_id(&mut ids, &node.id, &format!("{p}/id"));
        ctx.enum_value(&node.component_type, COMPONENT_TYPES, &format!("{p}/type"));
        ctx.text(&node.label, 1, None, &format!("{p}/label"));
        common::validate_decoration(&node.decoration, &p, &mut ctx);
        for (n, k) in [(node.row, "row"), (node.col, "col")] {
            if let Some(n) = n {
                ctx.integer(n, Some(0.0), None, &format!("{p}/{k}"));
            }
        }
        if let Some(size) = node.size {
            for (j, n) in size.iter().enumerate() {
                if *n <= 0.0 {
                    ctx.error(
                        "range",
                        &format!("{p}/size/{j}"),
                        "component size must be positive",
                        "choose a positive width and height",
                    );
                }
            }
        }
    }
    let mut cells = HashSet::new();
    for (i, node) in spec.components.iter().enumerate() {
        if node.pos.is_none() {
            if spec.layout.is_none() || node.row.is_none() || node.col.is_none() {
                ctx.error(
                    "placement-input",
                    &format!("/components/{i}"),
                    "component lacks explicit position or a complete declared grid cell",
                    "provide pos [x,y], or enable grid layout and provide both row and col",
                );
            } else if let (Some(row), Some(col)) = (node.row, node.col) {
                if !cells.insert((row.to_bits(), col.to_bits())) {
                    ctx.error(
                        "grid-cell",
                        &format!("/components/{i}"),
                        "two components declare the same grid cell",
                        "choose distinct row/col pairs or supply explicit positions",
                    );
                }
            }
        }
    }
    if let Some(layout) = &spec.layout {
        ctx.enum_value(&layout.mode, &["grid"], "/layout/mode");
        if let Some(cols) = layout.cols {
            ctx.range(cols as f64, Some(1.0), Some(12.0), "/layout/cols");
        }
        for (value, min, key) in [
            (layout.gap_x, 0.0, "gapX"),
            (layout.gap_y, 0.0, "gapY"),
            (layout.cell_w, 40.0, "cellW"),
            (layout.cell_h, 24.0, "cellH"),
        ] {
            if let Some(n) = value {
                ctx.range(n, Some(min), None, &format!("/layout/{key}"));
            }
        }
        let cols = layout.cols.unwrap_or(4);
        for (i, node) in spec.components.iter().enumerate() {
            if node.pos.is_none() && node.col.is_some_and(|col| col >= cols as f64) {
                ctx.error(
                    "grid-column",
                    &format!("/components/{i}/col"),
                    format!("column exceeds the declared {cols}-column grid"),
                    "choose a column below layout.cols or increase layout.cols within its limit",
                );
            }
        }
    }
    for (i, boundary) in spec.boundaries.iter().enumerate() {
        let p = format!("/boundaries/{i}");
        ctx.enum_value(
            &boundary.kind,
            &["region", "security-group"],
            &format!("{p}/kind"),
        );
        ctx.text(&boundary.label, 1, None, &format!("{p}/label"));
        ctx.cardinality(boundary.wraps.len(), 1, &format!("{p}/wraps"));
        for (j, id) in boundary.wraps.iter().enumerate() {
            ctx.id(id, &format!("{p}/wraps/{j}"));
            ctx.reference(id, &ids, &format!("{p}/wraps/{j}"), "reference");
        }
        if let Some(pad) = boundary.pad {
            ctx.range(pad, Some(0.0), None, &format!("{p}/pad"));
        }
    }
    if spec.meta.engineering_profile.as_deref() == Some("deployment-ownership") {
        validate_deployment_ownership(&spec, &mut ctx);
        for (i, left) in spec.boundaries.iter().enumerate() {
            let a: HashSet<_> = left.wraps.iter().collect();
            for (j, right) in spec.boundaries.iter().enumerate().skip(i + 1) {
                let b: HashSet<_> = right.wraps.iter().collect();
                if !a.is_disjoint(&b) && !a.is_subset(&b) && !b.is_subset(&a) {
                    ctx.error("ownership",&format!("/boundaries/{j}/wraps"),format!("boundary memberships {i} and {j} partially overlap in deployment-ownership mode"),"make one membership a subset of the other, or separate their members");
                }
            }
        }
    }
    let mut edge_ids = HashSet::new();
    for (i, edge) in spec.connections.iter().enumerate() {
        let p = format!("/connections/{i}");
        if let Some(id) = &edge.id {
            ctx.insert_id(&mut edge_ids, id, &format!("{p}/id"));
        }
        ctx.id(&edge.from, &format!("{p}/from"));
        ctx.id(&edge.to, &format!("{p}/to"));
        ctx.reference(&edge.from, &ids, &format!("{p}/from"), "reference");
        ctx.reference(&edge.to, &ids, &format!("{p}/to"), "reference");
        if let Some(v) = &edge.variant {
            ctx.enum_value(v, VARIANTS, &format!("{p}/variant"));
        }
        for (v, k) in [(&edge.from_side, "fromSide"), (&edge.to_side, "toSide")] {
            if let Some(v) = v {
                ctx.enum_value(v, SIDES, &format!("{p}/{k}"));
            }
        }
        if let Some(v) = &edge.route {
            ctx.enum_value(v, ARCHITECTURE_ROUTES, &format!("{p}/route"));
        }
        if let Some(n) = edge.label_segment {
            ctx.integer(n, Some(0.0), None, &format!("{p}/labelSegment"));
        }
        if let Some(width) = edge.width {
            ctx.range(width, Some(0.5), None, &format!("{p}/width"));
        }
    }
    ids.extend(edge_ids);
    common::validate_meta_refs(&spec.meta, &ids, &mut ctx);
    ctx.finish()
}

fn boundary_memberships(
    boundaries: &[ArchitectureBoundary],
    component_id: &str,
    kind: &str,
) -> Vec<usize> {
    boundaries
        .iter()
        .enumerate()
        .filter_map(|(index, boundary)| {
            (boundary.kind == kind && boundary.wraps.iter().any(|member| member == component_id))
                .then_some(index)
        })
        .collect()
}

fn validate_deployment_ownership(spec: &ArchitectureSpec, ctx: &mut common::Context) {
    for kind in ["region", "security-group"] {
        if !spec.boundaries.iter().any(|boundary| boundary.kind == kind) {
            ctx.error(
                "deployment-boundary-kind",
                "/boundaries",
                format!("deployment ownership requires at least one {kind} boundary"),
                format!("add a {kind} boundary with an explicit wraps list"),
            );
        }
    }

    for (index, component) in spec.components.iter().enumerate() {
        if component.component_type == "external" {
            continue;
        }
        let path = format!("/components/{index}");
        if component
            .decoration
            .tag
            .as_deref()
            .is_none_or(|owner| owner.trim().is_empty())
        {
            ctx.error(
                "deployment-owner-missing",
                &format!("{path}/tag"),
                format!("component {:?} does not name an owner in tag", component.id),
                "set tag to the responsible team or owner",
            );
        }

        let regions = boundary_memberships(&spec.boundaries, &component.id, "region");
        match regions.len() {
            0 => ctx.error(
                "deployment-region-scope",
                &path,
                format!(
                    "component {:?} is not assigned to a region boundary",
                    component.id
                ),
                "add the component id to its real region boundary wraps list",
            ),
            1 => {}
            count => ctx.error(
                "deployment-region-ambiguous",
                &path,
                format!(
                    "component {:?} belongs to {count} region boundaries",
                    component.id
                ),
                "keep the component id in exactly one region boundary wraps list",
            ),
        }

        if component.component_type == "database"
            && boundary_memberships(&spec.boundaries, &component.id, "security-group").is_empty()
        {
            ctx.error(
                "deployment-private-state",
                &path,
                format!(
                    "database component {:?} is not inside a security-group boundary",
                    component.id
                ),
                "add the database id to its real security-group boundary wraps list",
            );
        }
    }

    for (index, boundary) in spec.boundaries.iter().enumerate() {
        if boundary.kind != "security-group" {
            continue;
        }
        let mut shared_region = None;
        let mut consistent = !boundary.wraps.is_empty();
        for component_id in &boundary.wraps {
            let regions = boundary_memberships(&spec.boundaries, component_id, "region");
            if regions.len() != 1 {
                consistent = false;
                continue;
            }
            match shared_region {
                Some(region) if region != regions[0] => consistent = false,
                None => shared_region = Some(regions[0]),
                _ => {}
            }
        }
        if !consistent {
            ctx.error(
                "deployment-private-region-consistency",
                &format!("/boundaries/{index}/wraps"),
                format!(
                    "security-group {:?} must contain members from exactly one shared region",
                    boundary.label
                ),
                "assign every security-group member to exactly one shared region boundary",
            );
        }
    }

    for (index, connection) in spec.connections.iter().enumerate() {
        let crosses_boundary = spec.boundaries.iter().any(|boundary| {
            matches!(boundary.kind.as_str(), "region" | "security-group")
                && boundary
                    .wraps
                    .iter()
                    .any(|member| member == &connection.from)
                    != boundary.wraps.iter().any(|member| member == &connection.to)
        });
        if crosses_boundary
            && connection
                .label
                .as_deref()
                .is_none_or(|label| label.trim().is_empty())
        {
            ctx.error(
                "deployment-crossing-mechanism",
                &format!("/connections/{index}/label"),
                "cross-boundary connection does not name its mechanism",
                "set label to the real mechanism that crosses the boundary",
            );
        }
    }
}

#[cfg(feature = "typegen")]
pub fn declarations(cfg: &ts_rs::Config) -> Vec<String> {
    use ts_rs::TS;
    vec![
        ArchitectureSpec::decl(cfg),
        ArchitectureLayout::decl(cfg),
        ArchitectureComponent::decl(cfg),
        ArchitectureBoundary::decl(cfg),
        ArchitectureConnection::decl(cfg),
    ]
}
#[cfg(test)]
mod tests {
    use super::*;

    fn valid_deployment_profile() -> Value {
        serde_json::json!({
            "schema_version": 1,
            "diagram_type": "architecture",
            "meta": {
                "title": "Deployment",
                "output": "deployment.html",
                "engineering_profile": "deployment-ownership"
            },
            "components": [
                {"id": "web", "type": "frontend", "label": "Web", "tag": "team-web", "pos": [50, 100]},
                {"id": "db", "type": "database", "label": "DB", "tag": "team-data", "pos": [250, 100]},
                {"id": "external", "type": "external", "label": "User", "pos": [450, 100]}
            ],
            "boundaries": [
                {"kind": "region", "label": "West", "wraps": ["web", "db"]},
                {"kind": "security-group", "label": "Private", "wraps": ["db"]}
            ],
            "connections": [
                {"from": "web", "to": "db", "label": "TLS"}
            ]
        })
    }

    fn has_profile_rule(value: Value, rule: &str) -> bool {
        validate(value)
            .iter()
            .any(|diagnostic| diagnostic.code == format!("architecture/{rule}"))
    }

    #[test]
    fn validates_free_and_grid_document_fields_without_layout_geometry() {
        let value = serde_json::json!({"schema_version":1,"diagram_type":"architecture","meta":{"title":"A","output":"a.html"},"components":[{"id":"a","type":"backend","label":"A","pos":[50,160]}]});
        assert!(validate(value.clone()).is_empty());
        let mut bad = value;
        bad["components"][0]["type"] = Value::from("other");
        assert!(validate(bad).iter().any(|d| d.code == "architecture/enum"));
    }

    #[test]
    fn accepts_a_complete_deployment_ownership_profile() {
        assert!(validate(valid_deployment_profile()).is_empty());
    }

    #[test]
    fn deployment_profile_requires_both_boundary_kinds() {
        let mut missing_region = valid_deployment_profile();
        missing_region["boundaries"]
            .as_array_mut()
            .unwrap()
            .remove(0);
        assert!(has_profile_rule(missing_region, "deployment-boundary-kind"));

        let mut missing_security_group = valid_deployment_profile();
        missing_security_group["boundaries"]
            .as_array_mut()
            .unwrap()
            .remove(1);
        assert!(has_profile_rule(
            missing_security_group,
            "deployment-boundary-kind"
        ));
    }

    #[test]
    fn deployment_profile_requires_nonblank_owner_tags_for_nonexternal_components() {
        let mut missing_owner = valid_deployment_profile();
        missing_owner["components"][0]
            .as_object_mut()
            .unwrap()
            .remove("tag");
        assert!(has_profile_rule(missing_owner, "deployment-owner-missing"));

        let mut blank_owner = valid_deployment_profile();
        blank_owner["components"][0]["tag"] = Value::from("   ");
        assert!(has_profile_rule(blank_owner, "deployment-owner-missing"));
    }

    #[test]
    fn deployment_profile_requires_exactly_one_region_per_nonexternal_component() {
        let mut missing_region = valid_deployment_profile();
        missing_region["boundaries"][0]["wraps"] = serde_json::json!(["db"]);
        assert!(has_profile_rule(missing_region, "deployment-region-scope"));

        let mut multiple_regions = valid_deployment_profile();
        multiple_regions["boundaries"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "kind": "region", "label": "Also West", "wraps": ["web"]
            }));
        assert!(has_profile_rule(
            multiple_regions,
            "deployment-region-ambiguous"
        ));
    }

    #[test]
    fn deployment_profile_requires_databases_inside_security_groups() {
        let mut outside_private = valid_deployment_profile();
        outside_private["boundaries"][1]["wraps"] = serde_json::json!(["web"]);
        assert!(has_profile_rule(
            outside_private,
            "deployment-private-state"
        ));
    }

    #[test]
    fn deployment_profile_requires_each_security_group_to_share_one_region() {
        let mut mixed_regions = serde_json::json!({
            "schema_version": 1,
            "diagram_type": "architecture",
            "meta": {
                "title": "Deployment",
                "output": "deployment.html",
                "engineering_profile": "deployment-ownership"
            },
            "components": [
                {"id": "db-a", "type": "database", "label": "A", "tag": "team-data", "pos": [50, 100]},
                {"id": "db-b", "type": "database", "label": "B", "tag": "team-data", "pos": [250, 100]}
            ],
            "boundaries": [
                {"kind": "region", "label": "West", "wraps": ["db-a"]},
                {"kind": "region", "label": "East", "wraps": ["db-b"]},
                {"kind": "security-group", "label": "Private", "wraps": ["db-a", "db-b"]}
            ],
            "connections": []
        });
        assert!(has_profile_rule(
            mixed_regions,
            "deployment-private-region-consistency"
        ));
    }

    #[test]
    fn deployment_profile_requires_labels_on_cross_boundary_connections() {
        let mut unlabeled_crossing = valid_deployment_profile();
        unlabeled_crossing["connections"][0]
            .as_object_mut()
            .unwrap()
            .remove("label");
        assert!(has_profile_rule(
            unlabeled_crossing,
            "deployment-crossing-mechanism"
        ));
    }
}
