//! Sequence source budgets over a completed, inspectable geometry scene.
//!
//! Automatic height is intentionally open ended. Only an authored page imposes
//! an upper timeline/range/legend budget; the fixed horizontal column contract
//! still uses the default page width when no page was authored.

use crate::geometry::GeometryDocument;
use crate::{metrics, Diagnostic};
use serde_json::Value;

const UNIT: i64 = 64;

fn items<'a>(spec: &'a Value, field: &str) -> &'a [Value] {
    spec.get(field)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn coord(value: &Value) -> Option<i64> {
    super::px(value.as_f64()?).ok().map(i64::from)
}

fn source_coord(value: &Value, field: &str) -> Option<i64> {
    value.get(field).and_then(coord)
}

fn push(out: &mut Vec<Diagnostic>, suffix: &str, path: String, cause: String, fix: &str) {
    out.push(Diagnostic {
        code: crate::rules::geometry_qualified("sequence", suffix).0,
        path,
        rule: crate::rules::geometry_qualified("sequence", suffix).1,
        message: cause,
        fix: fix.into(),
    });
}

/// Sequence-specific timeline and frame budgets. The caller keeps `geometry`
/// even when these diagnostics refuse the scene.
pub(crate) fn sequence_geometry_diagnostics(
    spec: &Value,
    geometry: &GeometryDocument,
) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();
    let meta = &spec["meta"];
    let authored = meta
        .get("viewBox")
        .and_then(Value::as_array)
        .and_then(|page| Some((coord(page.first()?)?, coord(page.get(1)?)?)));
    let width = authored.map_or(920 * UNIT, |page| page.0);
    let placed_headers: std::collections::BTreeMap<_, _> = geometry
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node.bounds))
        .collect();
    for (index, participant) in items(spec, "participants").iter().enumerate() {
        let Some(id) = participant.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some(bounds) = placed_headers.get(id) else {
            continue;
        };
        let left = i64::from(bounds.x);
        let required_right = left + i64::from(bounds.width) + 40 * UNIT;
        #[cfg(any(test, feature = "geometry-corpus"))]
        crate::work::record_constraint_evaluation();
        if left < 0 || required_right > width {
            push(&mut diagnostics, "geometry-participant-canvas-width", format!("/participants/{index}"),
                format!("placed participant {id:?} starts at {:.3}px and needs {:.3}px of page width including its40px right reserve, but the page is {:.3}px wide", left as f64 / UNIT as f64, required_right as f64 / UNIT as f64, width as f64 / UNIT as f64),
                "move its retained pin inside the page, remove the pin for automatic placement, or increase meta.viewBox[0]");
        }
    }

    let mut content_bottom = 0_i64;
    for (index, message) in items(spec, "messages").iter().enumerate() {
        let Some(y) = source_coord(message, "y") else {
            continue;
        };
        let has_note = message
            .get("note")
            .and_then(Value::as_str)
            .is_some_and(|note| !note.is_empty());
        content_bottom =
            content_bottom.max(y.saturating_add(if has_note { 22 * UNIT } else { 6 * UNIT }));
        if let Some((_, height)) = authored {
            #[cfg(any(test, feature = "geometry-corpus"))]
            crate::work::record_constraint_evaluation();
            if y < 160 * UNIT || y > height - 83 * UNIT {
                push(&mut diagnostics, "geometry-message-time", format!("/messages/{index}/y"),
                    format!("message time {} is outside the authored page's readable timeline (160 through {} pixels)", y / UNIT, (height - 83 * UNIT) / UNIT),
                    "move the message inside the readable timeline, increase meta.viewBox[1], or omit viewBox for automatic height");
            }
        }
    }
    for activation in items(spec, "activations") {
        if let Some(end) = source_coord(activation, "to") {
            content_bottom = content_bottom.max(end);
        }
    }
    for (index, segment) in items(spec, "segments").iter().enumerate() {
        let from = source_coord(segment, "from");
        let to = source_coord(segment, "to");
        if let Some(end) = to {
            content_bottom = content_bottom.max(end);
        }
        #[cfg(any(test, feature = "geometry-corpus"))]
        crate::work::record_constraint_evaluation();
        if from.is_some_and(|start| start < 72 * UNIT)
            || authored.is_some_and(|(_, height)| to.is_some_and(|end| end > height - 45 * UNIT))
        {
            push(&mut diagnostics, "geometry-segment-range", format!("/segments/{index}"),
                "segment range extends beyond the sequence frame's vertical budget".into(),
                "keep segment.from at or after the header baseline (72 pixels) and segment.to within meta.viewBox[1] minus 45, or omit viewBox for automatic height");
        }
        if let Some(label) = segment.get("label").and_then(Value::as_str) {
            match metrics::measure_text(label, 700, 9 * 64) {
                Ok(measured) => {
                    let title_width = (i64::from(measured.advance.max(measured.ink.width)) + 14 * UNIT).max(42 * UNIT);
                    #[cfg(any(test, feature = "geometry-corpus"))]
                    crate::work::record_constraint_evaluation();
                    if title_width > width - 104 * UNIT {
                        push(&mut diagnostics, "geometry-segment-label-fit", format!("/segments/{index}/label"),
                            format!("segment title needs {} pixels including padding, but its frame has {} pixels", (title_width + UNIT - 1) / UNIT, (width - 104 * UNIT).max(0) / UNIT),
                            "shorten the segment title or increase meta.viewBox[0] so the complete title fits");
                    }
                }
                Err(error) => push(&mut diagnostics, "geometry-segment-label-fit", format!("/segments/{index}/label"),
                    format!("segment title could not be measured with the bundled font: {}", error.message),
                    "restore the bundled font metrics or reduce unsupported coordinate magnitudes and retry"),
            }
        }
    }

    // Consume the completed scene's resolved legend text rather than maintain
    // a second catalog. Preserve its emitted catalog order while measuring
    // explicit overrides and multiline labels with bundled font metrics.
    let legend_entries = &geometry.legend.entries;
    let mut row_width = 0_i64;
    let mut row_height = 22 * UNIT;
    let mut total_row_height = 0_i64;
    for entry in legend_entries {
        #[cfg(any(test, feature = "geometry-corpus"))]
        crate::work::record_constraint_evaluation();
        let key = &entry.key;
        let mut label_width = 0_i64;
        let mut label_height = 0_i64;
        for line in entry.label.split('\n') {
            match metrics::measure_text(line, 400, 8 * 64) {
                Ok(measured) => {
                    let ink_right = i64::from(measured.ink.x) + i64::from(measured.ink.width);
                    let ink_left = i64::from(measured.ink.x).min(0);
                    let measured_width = i64::from(measured.advance)
                        .max(ink_right)
                        .saturating_sub(ink_left);
                    label_width = label_width.max(measured_width);
                    label_height += (i64::from(measured.ascender) - i64::from(measured.descender))
                        .max(12 * UNIT);
                }
                Err(error) => push(
                    &mut diagnostics,
                    "geometry-legend-clearance",
                    format!("/meta/legend/entries/{key}/label"),
                    format!(
                        "legend text cannot be measured with the bundled font: {}",
                        error.message
                    ),
                    "restore the bundled font metric tables and retry",
                ),
            }
        }
        let item_width = label_width + 43 * UNIT;
        if meta.get("legend").is_some() && item_width > width - 80 * UNIT {
            push(
                &mut diagnostics,
                "geometry-legend-clearance",
                format!("/meta/legend/entries/{key}/label"),
                "explicit legend label is wider than the available legend row".into(),
                "shorten the legend override label or increase meta.viewBox[0]",
            );
        }
        let gap = if row_width == 0 { 0 } else { 22 * UNIT };
        if row_width > 0 && row_width + gap + item_width > width - 80 * UNIT {
            total_row_height += row_height;
            row_height = 22 * UNIT;
            row_width = 0;
        }
        row_width += if row_width == 0 {
            item_width
        } else {
            22 * UNIT + item_width
        };
        row_height = row_height.max(label_height);
    }
    if !legend_entries.is_empty() {
        total_row_height += row_height;
    }
    if let Some((_, height)) = authored {
        let enforce = meta.get("legend").is_some()
            || meta.get("quality_profile").and_then(Value::as_str) == Some("showcase");
        if enforce && !legend_entries.is_empty() {
            let required = content_bottom
                // The source's conservative growth hint reserves 98px, but
                // its actual legend placement still fits at content+96px.
                .saturating_add(96 * UNIT)
                .saturating_add(total_row_height.saturating_sub(22 * UNIT));
            #[cfg(any(test, feature = "geometry-corpus"))]
            crate::work::record_constraint_evaluation();
            if required > height {
                push(&mut diagnostics, "geometry-legend-clearance", "/meta/viewBox/1".into(),
                    format!("sequence content ends at {} pixels and leaves no room for the resolved legend text; at least {} pixels of page height are required", content_bottom / UNIT, (required + UNIT - 1) / UNIT),
                    "increase meta.viewBox[1], shorten legend overrides, hide optional entries, or omit viewBox so the page grows below the sequence content");
            }
        }
    }
    diagnostics.sort_by(|left, right| (&left.path, &left.code).cmp(&(&right.path, &right.code)));
    diagnostics
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> Value {
        serde_json::from_str(include_str!("../../testdata/valid-sequence.json")).unwrap()
    }
    fn geometry() -> GeometryDocument {
        serde_json::from_value(serde_json::json!({"nodes":[],"containers":[],"routes":[],"labels":[],"legend":{"bounds":{"x":0,"y":0,"width":0,"height":0},"entries":[{"key":"default","label":"default","bounds":{"x":0,"y":0,"width":0,"height":0}}]},"page":{"bounds":{"x":0,"y":0,"width":920*64,"height":760*64}}})).unwrap()
    }
    fn codes(spec: &Value) -> Vec<String> {
        sequence_geometry_diagnostics(spec, &geometry())
            .into_iter()
            .map(|diagnostic| diagnostic.code)
            .collect()
    }

    #[test]
    fn automatic_timeline_and_ranges_stay_open_ended() {
        let mut source = spec();
        source["messages"][0]["y"] = 2000.into();
        source["segments"] = serde_json::json!([{"from":160,"to":2200,"label":"W".repeat(80)}]);
        assert!(codes(&source).is_empty());
    }
    #[test]
    fn authored_page_refuses_late_message_and_segment() {
        let mut source = spec();
        source["meta"]["viewBox"] = serde_json::json!([920, 760]);
        source["messages"][0]["y"] = 2000.into();
        source["segments"] = serde_json::json!([{"from":160,"to":2000,"label":"Phase"}]);
        let found = codes(&source);
        assert!(found.contains(&"sequence/geometry-message-time".into()));
        assert!(found.contains(&"sequence/geometry-segment-range".into()));
    }
    #[test]
    fn segment_title_uses_bundled_metrics_inside_authored_width() {
        let mut source = spec();
        source["meta"]["viewBox"] = serde_json::json!([480, 760]);
        source["segments"] = serde_json::json!([{"from":160,"to":300,"label":"W".repeat(80)}]);
        assert!(codes(&source).contains(&"sequence/geometry-segment-label-fit".into()));
    }
    #[test]
    fn showcase_note_reserves_legend_space_but_auto_height_does_not_refuse() {
        let mut source = spec();
        source["meta"]["quality_profile"] = "showcase".into();
        source["meta"]["viewBox"] = serde_json::json!([920, 760]);
        source["messages"][0]["y"] = 650.into();
        source["messages"][0]["note"] = "Detail".into();
        assert!(codes(&source).contains(&"sequence/geometry-legend-clearance".into()));
        source["meta"].as_object_mut().unwrap().remove("viewBox");
        assert!(codes(&source).is_empty());
    }
    #[test]
    fn effective_legend_reserve_is_96_not_the_conservative_98_pixel_hint() {
        let mut source = spec();
        source["meta"]["quality_profile"] = "showcase".into();
        source["messages"][0]["y"] = 650.into();
        source["messages"][0]["note"] = "Detail".into();
        for height in [768.0, 768.0 + 1.0 / 64.0, 770.0 - 1.0 / 64.0] {
            source["meta"]["viewBox"] = serde_json::json!([920, height]);
            assert!(!codes(&source).contains(&"sequence/geometry-legend-clearance".into()));
        }
        source["meta"]["viewBox"] = serde_json::json!([920, 768.0 - 1.0 / 64.0]);
        assert!(codes(&source).contains(&"sequence/geometry-legend-clearance".into()));
    }

    #[test]
    fn resolved_explicit_legend_overrides_count_width_and_multiline_height() {
        let mut source = spec();
        source["meta"]["viewBox"] = serde_json::json!([480, 760]);
        let long = "W".repeat(80);
        source["meta"]["legend"] = serde_json::json!({"entries":{"default":{"label":long}}});
        let mut scene = geometry();
        scene.legend.entries[0].label = long;
        let found = sequence_geometry_diagnostics(&source, &scene);
        assert!(found.iter().any(|diagnostic| diagnostic.code
            == "sequence/geometry-legend-clearance"
            && diagnostic.path.ends_with("/default/label")));

        source["meta"]["viewBox"] = serde_json::json!([920, 760]);
        source["messages"][0]["y"] = 400.into();
        let multiline = format!("{}X", "X\n".repeat(39));
        source["meta"]["legend"]["entries"]["default"]["label"] = multiline.clone().into();
        scene.legend.entries[0].label = multiline;
        assert!(sequence_geometry_diagnostics(&source, &scene)
            .iter()
            .any(
                |diagnostic| diagnostic.code == "sequence/geometry-legend-clearance"
                    && diagnostic.path == "/meta/viewBox/1"
            ));
    }

    fn emitted_legend_scene(source: &Value) -> GeometryDocument {
        let request = crate::geometry::LayoutRequest {
            spec_json: source.to_string(),
            pin_set: None,
        };
        let mut builder = super::super::SceneBuilder::new(request, "sequence");
        let typed = serde_json::from_value(source.clone()).unwrap();
        super::super::sequence::place(&typed, &mut builder).unwrap();
        let meta = serde_json::from_value(source["meta"].clone()).unwrap();
        builder.finish(&meta).unwrap().0
    }

    #[test]
    fn catalog_order_wraps_two_rows_where_alphabetical_order_needs_three() {
        let mut source = spec();
        source["meta"]["viewBox"] = serde_json::json!([480, 735]);
        source["meta"]["quality_profile"] = "showcase".into();
        source["messages"][0]["y"] = 600.into();
        source["meta"]["legend"] = serde_json::json!({"mode":"all","entries":{
            "emphasis":{"label":"W"},"return":{"label":"W"},"security":{"label":"W"},
            "dashed":{"label":"W".repeat(5)},"default":{"label":"W".repeat(40)}
        }});
        let scene = emitted_legend_scene(&source);
        let keys: Vec<_> = scene
            .legend
            .entries
            .iter()
            .map(|entry| entry.key.as_str())
            .collect();
        assert_eq!(
            keys,
            ["emphasis", "return", "security", "dashed", "default"]
        );
        let mut emitted_rows: Vec<_> = scene
            .legend
            .entries
            .iter()
            .map(|entry| entry.bounds.y)
            .collect();
        emitted_rows.sort_unstable();
        emitted_rows.dedup();
        assert_eq!(emitted_rows.len(), 2);
        assert_eq!(emitted_rows[1] - emitted_rows[0], 22 * 64);
        for (index, entry) in scene.legend.entries.iter().enumerate() {
            if index == 0 || scene.legend.entries[index - 1].bounds.y != entry.bounds.y {
                assert_eq!(entry.bounds.x, 32 * 64);
            } else {
                let previous = &scene.legend.entries[index - 1];
                assert_eq!(
                    entry.bounds.x,
                    previous.bounds.right().unwrap() + (43 + 22) * 64
                );
            }
        }
        for entry in &scene.legend.entries {
            let id = format!("legend:{}", entry.key);
            let label = scene
                .labels
                .iter()
                .find(|label| label.id.as_deref() == Some(id.as_str()))
                .unwrap();
            assert_eq!(label.font_size, 8 * 64);
        }
        assert!(scene.legend.bounds.bottom().unwrap() <= scene.page.bounds.bottom().unwrap());
        // At400px row width these same measured labels use2 rows in catalog
        // order (height724), but3 alphabetically (height746). The735px page
        // lies between those budgets, so the old re-sort is observable.
        let refused = |source: &Value, scene: &GeometryDocument| {
            sequence_geometry_diagnostics(source, scene)
                .iter()
                .any(|diagnostic| diagnostic.code == "sequence/geometry-legend-clearance")
        };
        assert!(!refused(&source, &scene));
        let mut alphabetical = scene.clone();
        alphabetical
            .legend
            .entries
            .sort_by(|left, right| left.key.cmp(&right.key));
        assert!(refused(&source, &alphabetical));

        // Explicit legend layout remains enforced with a standard profile.
        source["meta"]["quality_profile"] = "standard".into();
        assert!(!refused(&source, &scene));
        assert!(refused(&source, &alphabetical));
        source["meta"]["legend"]["mode"] = "auto".into();
        let auto = emitted_legend_scene(&source);
        assert_eq!(
            auto.legend
                .entries
                .iter()
                .map(|entry| entry.key.as_str())
                .collect::<Vec<_>>(),
            ["default"]
        );
        assert!(!refused(&source, &auto));
        source["meta"]["legend"]["mode"] = "hidden".into();
        source["meta"]["viewBox"] = serde_json::json!([480, 700]);
        let hidden = emitted_legend_scene(&source);
        assert!(hidden.legend.entries.is_empty());
        assert!(!refused(&source, &hidden));
    }

    #[test]
    fn participant_columns_cannot_escape_the_default_width() {
        let mut source = spec();
        source["participants"]
            .as_array_mut()
            .unwrap()
            .extend((0..7).map(
                |index| serde_json::json!({"id":format!("p{index}"),"type":"backend","label":"P"}),
            ));
        let has_header_refusal = |source: &Value| {
            sequence_geometry_diagnostics(source, &emitted_legend_scene(source))
                .iter()
                .any(|diagnostic| diagnostic.code == "sequence/geometry-participant-canvas-width")
        };
        assert!(has_header_refusal(&source));
        source["meta"]["viewBox"] = serde_json::json!([1200, 760]);
        assert!(!has_header_refusal(&source));
    }
}
