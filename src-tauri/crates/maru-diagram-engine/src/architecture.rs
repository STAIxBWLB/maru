//! Architecture document validity; no placement or routing computation.
use super::common::{self, Card, Decoration, Meta, Point, COMPONENT_TYPES, SIDES, VARIANTS};
use crate::Diagnostic;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

pub type ArchitectureMeta = Meta;

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
            ctx.enum_value(
                v,
                &["auto", "straight", "orthogonal-h", "orthogonal-v"],
                &format!("{p}/route"),
            );
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
    #[test]
    fn validates_free_and_grid_document_fields_without_layout_geometry() {
        let value = serde_json::json!({"schema_version":1,"diagram_type":"architecture","meta":{"title":"A","output":"a.html"},"components":[{"id":"a","type":"backend","label":"A","pos":[50,160]}]});
        assert!(validate(value.clone()).is_empty());
        let mut bad = value;
        bad["components"][0]["type"] = Value::from("other");
        assert!(validate(bad).iter().any(|d| d.code == "architecture/enum"));
    }
}
