//! Source-sized canvas budgets used by renderer-compatibility refusals.

use crate::geometry::{GeometryDocument, GeometryNode, GeometryPositionSource};
use serde_json::Value;
use std::collections::BTreeMap;

const SCALE: i64 = 64;
const SOURCE_SCALE: i64 = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SourceRect {
    /// Source-space fixed coordinates at 1/128px; output geometry stays 1/64px.
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
}

impl SourceRect {
    pub fn right(self) -> i64 {
        self.x + self.width
    }

    pub fn bottom(self) -> i64 {
        self.y + self.height
    }
}

/// The emitted box of a placed node in source space, so the readable-area check
/// measures what the renderer draws rather than the pre-auto-fit source box. A
/// grown node keeps its source top and left, so the union with the source
/// rectangle below is the growth-extended box.
pub(crate) fn emitted_source_rect(node: &GeometryNode) -> SourceRect {
    let bounds = node.bounds;
    SourceRect {
        x: i64::from(bounds.x) * 2,
        y: i64::from(bounds.y) * 2,
        width: i64::from(bounds.width) * 2,
        height: i64::from(bounds.height) * 2,
    }
}

/// Farthest-reaching of two source rectangles. Admission measures the emitted
/// box wherever auto-fit moved it outward, and never less than the source box
/// the format authored.
pub(crate) fn union_source_rects(left: SourceRect, right: SourceRect) -> SourceRect {
    let x = left.x.min(right.x);
    let y = left.y.min(right.y);
    let max_right = left.right().max(right.right());
    let max_bottom = left.bottom().max(right.bottom());
    SourceRect {
        x,
        y,
        width: max_right - x,
        height: max_bottom - y,
    }
}

/// The given source rectangles as admission must measure them, each unioned
/// with the placed node of the same id.
pub(crate) fn emitted_rects(
    rects: &BTreeMap<String, SourceRect>,
    geometry: &GeometryDocument,
) -> BTreeMap<String, SourceRect> {
    rects
        .iter()
        .map(|(id, rect)| {
            let rect = geometry
                .nodes
                .iter()
                .find(|node| node.id == *id)
                .map_or(*rect, |node| {
                    union_source_rects(*rect, emitted_source_rect(node))
                });
            (id.clone(), rect)
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SourceFrame {
    pub width: i64,
    pub height: i64,
    pub min_x: i64,
    pub min_y: i64,
    pub max_right: i64,
    pub max_bottom: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SequenceColumns {
    pub participant_width: i64,
    pub first_center: i64,
    pub pitch: i64,
}

pub(crate) fn sequence_columns(
    view_width: i64,
    participant_count: usize,
    spread: bool,
) -> SequenceColumns {
    let count = i64::try_from(participant_count.max(1)).unwrap_or(i64::MAX / SCALE);
    if !spread {
        return SequenceColumns {
            participant_width: 86 * SCALE,
            first_center: 62 * SCALE,
            pitch: 108 * SCALE,
        };
    }

    // Math.round((viewBoxWidth - 124) / count) - 24, quantized to pixels.
    let numerator = view_width.saturating_sub(124 * SCALE);
    let denominator = count.saturating_mul(SCALE).max(1);
    let rounded_slot_px = if numerator <= 0 {
        0
    } else {
        numerator.saturating_add(denominator / 2) / denominator
    };
    let participant_width = rounded_slot_px
        .saturating_sub(24)
        .saturating_mul(SCALE)
        .clamp(86 * SCALE, 190 * SCALE);
    let first_center = 62 * SCALE + participant_width / 2;
    let pitch = if count > 1 {
        view_width
            .saturating_sub(102 * SCALE)
            .saturating_sub(participant_width)
            .checked_div(count - 1)
            .unwrap_or(i64::MAX)
            .max(108 * SCALE)
    } else {
        108 * SCALE
    };
    SequenceColumns {
        participant_width,
        first_center,
        pitch,
    }
}

fn number(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn records<'a>(spec: &'a Value, collection: &str) -> &'a [Value] {
    spec.get(collection)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn source_coord(value: f64) -> Option<i64> {
    let scaled = value * SOURCE_SCALE as f64;
    if !scaled.is_finite() {
        return None;
    }
    let rounded = scaled.round();
    let upper_exclusive = -(i64::MIN as f64);
    if rounded < i64::MIN as f64 || rounded >= upper_exclusive {
        return None;
    }
    Some(rounded as i64)
}

fn authored_view_box(spec: &Value, fallback: (f64, f64)) -> Option<(i64, i64)> {
    let value = spec
        .get("meta")
        .and_then(|meta| meta.get("viewBox"))
        .and_then(Value::as_array)
        .filter(|view| view.len() == 2);
    let width = value
        .and_then(|view| view[0].as_f64())
        .unwrap_or(fallback.0);
    let height = value
        .and_then(|view| view[1].as_f64())
        .unwrap_or(fallback.1);
    Some((source_coord(width)?, source_coord(height)?))
}

fn scene_node<'a>(geometry: &'a GeometryDocument, id: &str) -> Option<&'a GeometryNode> {
    geometry.nodes.iter().find(|node| node.id == id)
}

fn pin_position(geometry: &GeometryDocument, id: &str) -> Option<(i64, i64)> {
    let node = scene_node(geometry, id)?;
    (node.position_source == GeometryPositionSource::PlannedPin)
        .then_some((i64::from(node.bounds.x) * 2, i64::from(node.bounds.y) * 2))
}

pub(crate) fn dataflow_node_rects(
    spec: &Value,
    geometry: &GeometryDocument,
) -> BTreeMap<String, SourceRect> {
    const ROW_Y: [f64; 5] = [128.0, 242.0, 356.0, 470.0, 584.0];
    let mut result = BTreeMap::new();
    for node in records(spec, "nodes") {
        let (Some(id), Some(stage), Some(row)) =
            (text(node, "id"), number(node, "stage"), number(node, "row"))
        else {
            continue;
        };
        if stage < 0.0 || row < 0.0 || row.fract() != 0.0 || row >= ROW_Y.len() as f64 {
            continue;
        }
        let width = number(node, "width")
            .filter(|value| *value != 0.0)
            .unwrap_or(112.0);
        let height = number(node, "height")
            .filter(|value| *value != 0.0)
            .unwrap_or(58.0);
        let x = 100.0 + stage * 215.0 - width / 2.0;
        let y = ROW_Y[row as usize] + number(node, "yOffset").unwrap_or(0.0);
        let Some((x, y)) =
            pin_position(geometry, id).or_else(|| Some((source_coord(x)?, source_coord(y)?)))
        else {
            continue;
        };
        let (Some(width), Some(height)) = (source_coord(width), source_coord(height)) else {
            continue;
        };
        result.insert(
            id.to_owned(),
            SourceRect {
                x,
                y,
                width,
                height,
            },
        );
    }
    result
}

fn lane_order(spec: &Value) -> Vec<String> {
    let populated: std::collections::BTreeSet<_> = records(spec, "states")
        .iter()
        .filter_map(|state| text(state, "lane").map(str::to_owned))
        .collect();
    let lanes: Vec<_> = records(spec, "lanes")
        .iter()
        .filter_map(|lane| text(lane, "id").map(str::to_owned))
        .collect();
    let mut order = Vec::new();
    if populated.contains("main") {
        order.push("main".to_owned());
    }
    order.extend(
        lanes
            .iter()
            .filter(|lane| lane.as_str() != "main" && lane.as_str() != "terminal")
            .filter(|lane| populated.contains(*lane))
            .cloned(),
    );
    if populated.contains("terminal") {
        order.push("terminal".to_owned());
    }
    order
}

fn v2_centers(spec: &Value) -> [f64; 5] {
    let mut widths = [140.0_f64; 5];
    for state in records(spec, "states") {
        let Some(column) = number(state, "col") else {
            continue;
        };
        if column < 0.0 || column.fract() != 0.0 || column > 4.0 {
            continue;
        }
        widths[column as usize] =
            widths[column as usize].max(number(state, "width").unwrap_or(0.0));
    }
    let mut centers = [0.0_f64; 5];
    let mut x = 60.0;
    for column in 0..5 {
        centers[column] = x + widths[column] / 2.0;
        x += widths[column] + 64.0;
    }
    centers
}

pub(crate) fn lifecycle_state_rects(
    spec: &Value,
    geometry: &GeometryDocument,
) -> BTreeMap<String, SourceRect> {
    let version = spec
        .get("schema_version")
        .and_then(Value::as_u64)
        .unwrap_or(1);
    let centers = (version == 2).then(|| v2_centers(spec));
    let rows = lane_order(spec);
    let mut result = BTreeMap::new();
    for state in records(spec, "states") {
        let (Some(id), Some(lane), Some(column)) =
            (text(state, "id"), text(state, "lane"), number(state, "col"))
        else {
            continue;
        };
        if column < 0.0 || column.fract() != 0.0 {
            continue;
        }
        let width_default = if version == 2 {
            140.0
        } else if lane == "main" || lane == "terminal" {
            118.0
        } else {
            126.0
        };
        let height_default = if version == 2 {
            64.0
        } else if lane == "main" {
            62.0
        } else {
            58.0
        };
        let width = number(state, "width")
            .filter(|value| *value != 0.0)
            .unwrap_or(width_default);
        let height = number(state, "height")
            .filter(|value| *value != 0.0)
            .unwrap_or(height_default);
        let (x, y) = if version == 2 {
            let Some(center) = centers.and_then(|centers| centers.get(column as usize).copied())
            else {
                continue;
            };
            let Some(row) = rows.iter().position(|candidate| candidate == lane) else {
                continue;
            };
            (
                center - width / 2.0,
                56.0 + row as f64 * 184.0 + number(state, "yOffset").unwrap_or(0.0),
            )
        } else {
            let center = if lane == "main" {
                [94.0, 248.0, 402.0, 556.0, 710.0]
                    .get(column as usize)
                    .copied()
            } else {
                [402.0, 556.0, 710.0].get(column as usize).copied()
            };
            let Some(center) = center else {
                continue;
            };
            let top = if lane == "main" {
                126.0
            } else if lane == "terminal" {
                450.0
            } else {
                278.0
            } + number(state, "yOffset").unwrap_or(0.0);
            (center - width / 2.0, top)
        };
        let Some((x, y)) =
            pin_position(geometry, id).or_else(|| Some((source_coord(x)?, source_coord(y)?)))
        else {
            continue;
        };
        let (Some(width), Some(height)) = (source_coord(width), source_coord(height)) else {
            continue;
        };
        result.insert(
            id.to_owned(),
            SourceRect {
                x,
                y,
                width,
                height,
            },
        );
    }
    result
}

pub(crate) fn dataflow_frame(spec: &Value) -> Option<SourceFrame> {
    let (width, height) = authored_view_box(spec, (940.0, 720.0))?;
    Some(SourceFrame {
        width,
        height,
        min_x: 24 * SOURCE_SCALE,
        min_y: 104 * SOURCE_SCALE,
        max_right: width - 24 * SOURCE_SCALE,
        max_bottom: height - 74 * SOURCE_SCALE,
    })
}

pub(crate) fn lifecycle_frame(spec: &Value, geometry: &GeometryDocument) -> Option<SourceFrame> {
    let version = spec
        .get("schema_version")
        .and_then(Value::as_u64)
        .unwrap_or(1);
    if version == 1 {
        let (width, height) = authored_view_box(spec, (980.0, 660.0))?;
        return Some(SourceFrame {
            width,
            height,
            min_x: 32 * SOURCE_SCALE,
            min_y: 64 * SOURCE_SCALE,
            max_right: width - 32 * SOURCE_SCALE,
            max_bottom: height - 122 * SOURCE_SCALE,
        });
    }

    let rects = emitted_rects(&lifecycle_state_rects(spec, geometry), geometry);
    let max_right = rects.values().map(|rect| rect.right()).max().unwrap_or(0);
    let max_bottom = rects.values().map(|rect| rect.bottom()).max().unwrap_or(0);
    let view = spec
        .get("meta")
        .and_then(|meta| meta.get("viewBox"))
        .and_then(Value::as_array)
        .filter(|view| view.len() == 2);
    let width = view
        .and_then(|view| view[0].as_f64())
        .and_then(source_coord)
        .unwrap_or((640 * SOURCE_SCALE).max(max_right + 60 * SOURCE_SCALE));
    let legend_extra = (i64::from(geometry.legend.bounds.height) * 2 - 40 * SOURCE_SCALE).max(0);
    let height = view
        .and_then(|view| view[1].as_f64())
        .and_then(source_coord)
        .unwrap_or(max_bottom + legend_extra + 96 * SOURCE_SCALE);
    Some(SourceFrame {
        width,
        height,
        min_x: 28 * SOURCE_SCALE,
        min_y: 44 * SOURCE_SCALE,
        max_right: width - 28 * SOURCE_SCALE,
        max_bottom: height - legend_extra - 96 * SOURCE_SCALE,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_sequence_columns_keep_renderer_minimums_and_spread_rounding() {
        let fixed = sequence_columns(920 * SCALE, 4, false);
        assert_eq!(fixed.participant_width, 86 * SCALE);
        assert_eq!(fixed.first_center, 62 * SCALE);
        assert_eq!(fixed.pitch, 108 * SCALE);

        let spread = sequence_columns(920 * SCALE, 4, true);
        assert_eq!(spread.participant_width, 175 * SCALE);
        assert!(spread.pitch >= 108 * SCALE);
        let wide = sequence_columns(1200 * SCALE, 4, true);
        assert_eq!(wide.participant_width, 190 * SCALE);
    }

    #[test]
    fn source_rectangles_retain_half_quantum_boundary_differences() {
        let dataflow = serde_json::json!({
            "diagram_type":"dataflow","stages":[{"label":"Input"},{"label":"Output"}],
            "nodes":[{"id":"edge","type":"backend","label":"Edge","stage":0,"row":0,"width":152.015625,"height":58}]
        });
        let dataflow_rect = dataflow_node_rects(&dataflow, &empty_geometry())
            .remove("edge")
            .unwrap();
        assert_eq!(dataflow_rect.x, 24 * SOURCE_SCALE - 1);
        assert!(dataflow_rect.x < dataflow_frame(&dataflow).unwrap().min_x);

        let lifecycle = serde_json::json!({
            "schema_version":1,"diagram_type":"lifecycle",
            "lanes":[{"id":"main","label":"Main"}],
            "states":[{"id":"edge","type":"active","label":"Edge","lane":"main","col":0,"width":124.015625}]
        });
        let lifecycle_rect = lifecycle_state_rects(&lifecycle, &empty_geometry())
            .remove("edge")
            .unwrap();
        assert_eq!(lifecycle_rect.x, 32 * SOURCE_SCALE - 1);
        assert!(
            lifecycle_rect.x
                < lifecycle_frame(&lifecycle, &empty_geometry())
                    .unwrap()
                    .min_x
        );
    }

    fn empty_geometry() -> GeometryDocument {
        use crate::geometry::{GeometryBox, GeometryContainer, GeometryLegend, GeometryPage};
        GeometryDocument {
            lifecycle_rail: None,
            nodes: Vec::new(),
            containers: Vec::<GeometryContainer>::new(),
            routes: Vec::new(),
            labels: Vec::new(),
            legend: GeometryLegend {
                content_bounds: None,
                title_y: None,
                bounds: GeometryBox {
                    x: 0,
                    y: 0,
                    width: 0,
                    height: 40 * 64,
                },
                entries: Vec::new(),
            },
            page: GeometryPage {
                bounds: GeometryBox {
                    x: 0,
                    y: 0,
                    width: 0,
                    height: 0,
                },
                content_offset: None,
            },
        }
    }
}
