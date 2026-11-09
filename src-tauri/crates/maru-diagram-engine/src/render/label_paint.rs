//! Semantic label colors derived independently for SVG writing and checking.

use super::SvgOptions;
use crate::geometry::{GeometryDocument, GeometryLabel};

/// Returns one color per glyph for the SVG writer.
pub(crate) fn colors(
    geometry: &GeometryDocument,
    options: &SvgOptions,
    label: &GeometryLabel,
) -> Vec<&'static str> {
    let tokens = options.theme.tokens();
    let Some(semantics) = options.semantics.as_ref() else {
        return vec![
            if label.font.weight == 700 {
                tokens.text
            } else {
                tokens.muted
            };
            label.glyphs.len()
        ];
    };

    let route_primary = label
        .id
        .as_deref()
        .filter(|id| *id == format!("edge:{}:label", label.target_id))
        .and_then(|_| {
            semantics
                .route_labels
                .get(&label.target_id)
                .and_then(|source| {
                    let route = geometry
                        .routes
                        .iter()
                        .find(|route| route.id.as_deref() == Some(label.target_id.as_str()))?;
                    let variant = route.variant.as_deref().unwrap_or("default");
                    let color = match variant {
                        "security" => options.theme.kind("security").map(|kind| kind.stroke),
                        "emphasis" => Some(tokens.emphasis),
                        "dashed" => options.theme.kind("database").map(|kind| kind.stroke),
                        "default" | "return" if semantics.family == "sequence" => {
                            Some(tokens.muted)
                        }
                        _ => Some(tokens.arrow),
                    }?;
                    Some((source.primary_lines, color))
                })
        });

    let is_frame =
        label.id.as_deref() == Some(format!("container:{}:label", label.target_id).as_str());
    let frame_color = if is_frame && semantics.family == "workflow" {
        geometry
            .containers
            .iter()
            .find(|container| container.id == label.target_id)
            .and_then(|container| {
                let variant_key = match container.kind.as_str() {
                    "lane" => format!("lane:{}", container.id.trim_start_matches("lane:")),
                    "phase" => format!("phase:{}", container.id.trim_start_matches("phase:")),
                    "group" => format!("group:{}", container.id.trim_start_matches("group:")),
                    _ => return None,
                };
                let variant = semantics
                    .frame_variants
                    .get(&variant_key)
                    .map(String::as_str);
                if container.kind == "lane" && variant == Some("exception") {
                    return options.theme.kind("security").map(|kind| kind.stroke);
                }
                Some(match variant {
                    Some("security") => options.theme.kind("security")?.stroke,
                    Some("emphasis") => options.theme.kind("backend")?.stroke,
                    Some("dashed") => options.theme.kind("messagebus")?.stroke,
                    _ => tokens.muted,
                })
            })
    } else if is_frame && semantics.family == "architecture" {
        geometry
            .containers
            .iter()
            .find(|container| container.id == label.target_id)
            .and_then(|container| match container.kind.as_str() {
                "security-group" => options.theme.kind("security").map(|kind| kind.stroke),
                "region" => options.theme.kind("cloud").map(|kind| kind.stroke),
                _ => None,
            })
    } else {
        None
    };

    let tag_color = if label.id.as_deref() == Some(format!("node:{}:tag", label.target_id).as_str())
    {
        semantics
            .nodes
            .get(&label.target_id)
            .and_then(|node| options.theme.kind(&node.kind))
            .map(|kind| kind.stroke)
    } else {
        None
    };
    let source_line_lengths: Vec<usize> = label
        .text
        .split('\n')
        .map(|line| line.chars().count())
        .collect();
    let mut line_index = 0;
    let mut scalars_in_line = 0;
    label
        .glyphs
        .iter()
        .map(|glyph| {
            while line_index + 1 < source_line_lengths.len()
                && scalars_in_line >= source_line_lengths[line_index]
            {
                line_index += 1;
                scalars_in_line = 0;
            }
            scalars_in_line += glyph.input.chars().count();
            if let Some((primary_lines, color)) = route_primary {
                if line_index < primary_lines {
                    return color;
                }
                return tokens.muted;
            }
            tag_color.or(frame_color).unwrap_or({
                if label.font.weight == 700 {
                    tokens.text
                } else {
                    tokens.muted
                }
            })
        })
        .collect()
}

/// Independently derives reference colors for the artifact gate.
pub(crate) fn reference_colors(
    geometry: &GeometryDocument,
    options: &SvgOptions,
    label: &GeometryLabel,
) -> Vec<&'static str> {
    let tokens = options.theme.tokens();
    let Some(semantics) = options.semantics.as_ref() else {
        return vec![
            if label.font.weight == 700 {
                tokens.text
            } else {
                tokens.muted
            };
            label.glyphs.len()
        ];
    };

    let route_primary = if let Some(primary) = semantics
        .route_labels
        .get(label.target_id.as_str())
        .filter(|_| label.id.as_deref() == Some(format!("edge:{}:label", label.target_id).as_str()))
    {
        geometry
            .routes
            .iter()
            .find(|route| route.id.as_deref() == Some(label.target_id.as_str()))
            .and_then(|route| {
                let effective_variant = if semantics.family == "lifecycle" {
                    semantics
                        .lifecycle_variants
                        .get(&label.target_id)
                        .and_then(Option::as_deref)
                        .map(str::to_owned)
                        .unwrap_or_else(|| {
                            let from = geometry.nodes.iter().find(|node| node.id == route.from);
                            let to = geometry.nodes.iter().find(|node| node.id == route.to);
                            if semantics.schema_version == 2
                                && semantics
                                    .nodes
                                    .get(&route.from)
                                    .is_some_and(|node| node.lane.as_deref() == Some("main"))
                                && semantics
                                    .nodes
                                    .get(&route.to)
                                    .is_some_and(|node| node.lane.as_deref() == Some("main"))
                                && from
                                    .and_then(|node| node.phase_order)
                                    .zip(to.and_then(|node| node.phase_order))
                                    .is_some_and(|(from, to)| to > from)
                            {
                                "emphasis".to_owned()
                            } else {
                                "default".to_owned()
                            }
                        })
                } else {
                    route
                        .variant
                        .clone()
                        .unwrap_or_else(|| "default".to_owned())
                };
                let color = if effective_variant == "security" {
                    options.theme.kind("security").map(|kind| kind.stroke)
                } else if effective_variant == "emphasis" {
                    Some(tokens.emphasis)
                } else if effective_variant == "dashed" {
                    options.theme.kind("database").map(|kind| kind.stroke)
                } else if semantics.family == "sequence"
                    && matches!(effective_variant.as_str(), "default" | "return")
                {
                    Some(tokens.muted)
                } else {
                    Some(tokens.arrow)
                }?;
                Some((primary.primary_lines, color))
            })
    } else {
        None
    };

    let frame_family =
        if label.id.as_deref() == Some(format!("container:{}:label", label.target_id).as_str()) {
            semantics.family.as_str()
        } else {
            ""
        };
    let frame_color = match frame_family {
        "workflow" => geometry
            .containers
            .iter()
            .find(|container| container.id == label.target_id)
            .and_then(|container| {
                let key = match container.kind.as_str() {
                    "lane" => format!("lane:{}", container.id.trim_start_matches("lane:")),
                    "phase" => format!("phase:{}", container.id.trim_start_matches("phase:")),
                    "group" => format!("group:{}", container.id.trim_start_matches("group:")),
                    _ => return None,
                };
                let frame_variant = semantics.frame_variants.get(&key).map(String::as_str);
                if container.kind == "lane" && frame_variant == Some("exception") {
                    options.theme.kind("security").map(|kind| kind.stroke)
                } else {
                    Some(match frame_variant {
                        Some("security") => options.theme.kind("security")?.stroke,
                        Some("emphasis") => options.theme.kind("backend")?.stroke,
                        Some("dashed") => options.theme.kind("messagebus")?.stroke,
                        _ => tokens.muted,
                    })
                }
            }),
        "architecture" => geometry
            .containers
            .iter()
            .find(|container| container.id == label.target_id)
            .and_then(|container| {
                let component = match container.kind.as_str() {
                    "security-group" => "security",
                    "region" => "cloud",
                    _ => return None,
                };
                options.theme.kind(component).map(|kind| kind.stroke)
            }),
        _ => None,
    };

    let expected_tag = label
        .id
        .as_ref()
        .filter(|id| id.as_str() == format!("node:{}:tag", label.target_id))
        .and_then(|_| semantics.nodes.get(label.target_id.as_str()))
        .and_then(|node| options.theme.kind(node.kind.as_str()))
        .map(|token| token.stroke);
    let source_line_sizes: Vec<usize> = label
        .text
        .split('\n')
        .map(|line| line.chars().count())
        .collect();
    let mut current_line = 0;
    let mut consumed_scalars = 0;
    let mut output = Vec::with_capacity(label.glyphs.len());
    for glyph in &label.glyphs {
        while current_line + 1 < source_line_sizes.len()
            && consumed_scalars >= source_line_sizes[current_line]
        {
            current_line += 1;
            consumed_scalars = 0;
        }
        consumed_scalars += glyph.input.chars().count();
        let color = match route_primary {
            Some((primary_lines, color)) if current_line < primary_lines => color,
            Some(_) => tokens.muted,
            None => expected_tag.or(frame_color).unwrap_or({
                if label.font.weight == 700 {
                    tokens.text
                } else {
                    tokens.muted
                }
            }),
        };
        output.push(color);
    }
    output
}
