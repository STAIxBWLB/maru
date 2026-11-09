//! Independent structural and semantic checks for rendered SVG artifacts.

use crate::geometry::{GeometryBox, GeometryDocument, GeometryPoint};
use crate::Diagnostic;
use roxmltree::{Document, Node};
use std::collections::{BTreeMap, BTreeSet};

const SVG_NS: &str = "http://www.w3.org/2000/svg";

fn diagnostic(rule: &str, path: &str, cause: impl Into<String>, fix: &str) -> Diagnostic {
    super::error(&format!("artifact-{rule}"), path, cause, fix)
}

fn attr<'a, 'input>(node: Node<'a, 'input>, name: &str) -> Option<&'a str> {
    node.attribute(name)
}

fn require_attr<'a, 'input>(
    node: Node<'a, 'input>,
    name: &str,
    expected: &str,
    path: &str,
    errors: &mut Vec<Diagnostic>,
) {
    if attr(node, name) != Some(expected) {
        errors.push(diagnostic(
            "attribute",
            path,
            format!("SVG {name} does not match the expected artifact value"),
            "regenerate the SVG from the supplied geometry and render options",
        ));
    }
}

fn require_tag(node: Node<'_, '_>, expected: &str, path: &str, errors: &mut Vec<Diagnostic>) {
    if node.tag_name().name() != expected || node.tag_name().namespace() != Some(SVG_NS) {
        errors.push(diagnostic(
            "element-type",
            path,
            format!("geometry kind must be represented by an SVG {expected} element"),
            "restore the renderer's typed SVG element structure",
        ));
    }
}

fn elements<'a, 'input>(node: Node<'a, 'input>) -> impl Iterator<Item = Node<'a, 'input>> {
    node.children().filter(|child| child.is_element())
}

fn kind_nodes<'a, 'input>(doc: &'a Document<'input>, kind: &str) -> Vec<Node<'a, 'input>> {
    doc.descendants()
        .filter(|node| node.is_element() && node.attribute("data-kind") == Some(kind))
        .collect()
}

fn parse_number(value: Option<&str>) -> Option<f64> {
    let parsed = value?.trim().parse::<f64>().ok()?;
    parsed.is_finite().then_some(parsed)
}

fn near(actual: Option<&str>, expected: f64) -> bool {
    parse_number(actual).is_some_and(|actual| (actual - expected).abs() <= 1.0 / 64.0)
}

fn check_number(
    node: Node<'_, '_>,
    name: &str,
    expected: f64,
    path: &str,
    errors: &mut Vec<Diagnostic>,
) {
    if !near(attr(node, name), expected) {
        errors.push(diagnostic(
            "geometry",
            path,
            format!("SVG {name} is missing, non-finite, or differs from source geometry"),
            "regenerate SVG coordinates from the fixed-point geometry without changing placement",
        ));
    }
}

fn check_box(node: Node<'_, '_>, bounds: GeometryBox, path: &str, errors: &mut Vec<Diagnostic>) {
    require_tag(node, "rect", path, errors);
    for (name, value) in [
        ("x", bounds.x),
        ("y", bounds.y),
        ("width", bounds.width),
        ("height", bounds.height),
    ] {
        check_number(node, name, value as f64 / 64.0, path, errors);
    }
}

fn check_points(
    node: Node<'_, '_>,
    points: &[GeometryPoint],
    path: &str,
    errors: &mut Vec<Diagnostic>,
) {
    let actual = attr(node, "points").unwrap_or("");
    let parsed: Option<Vec<(f64, f64)>> = actual
        .split_whitespace()
        .map(|pair| {
            let (x, y) = pair.split_once(',')?;
            let x = parse_number(Some(x))?;
            let y = parse_number(Some(y))?;
            Some((x, y))
        })
        .collect();
    let correct = parsed.is_some_and(|actual| {
        actual.len() == points.len()
            && actual.iter().zip(points).all(|((x, y), point)| {
                (*x - point.x as f64 / 64.0).abs() <= 1.0 / 64.0
                    && (*y - point.y as f64 / 64.0).abs() <= 1.0 / 64.0
            })
    });
    if !correct {
        errors.push(diagnostic(
            "route-points",
            path,
            "route SVG points do not match the routed fixed-point geometry",
            "regenerate route points directly from the route geometry",
        ));
    }
}

fn check_count(doc: &Document<'_>, kind: &str, expected: usize, errors: &mut Vec<Diagnostic>) {
    let actual = kind_nodes(doc, kind).len();
    if actual != expected {
        errors.push(diagnostic(
            "count",
            &format!("/svg/{kind}"),
            format!("SVG contains {actual} {kind} element(s), expected {expected}"),
            "restore exactly one rendered element for each source geometry item",
        ));
    }
}

fn check_tag_count(doc: &Document<'_>, tag: &str, expected: usize, errors: &mut Vec<Diagnostic>) {
    let actual = doc
        .descendants()
        .filter(|node| node.is_element() && node.tag_name().name() == tag)
        .count();
    if actual != expected {
        errors.push(diagnostic(
            "definition-count",
            "/svg/defs",
            format!("SVG contains {actual} {tag} definition element(s), expected {expected}"),
            "restore the fixed local marker definitions and remove unexpected drawing elements",
        ));
    }
}

fn check_defs(doc: &Document<'_>, options: &super::SvgOptions, errors: &mut Vec<Diagnostic>) {
    let tokens = options.theme.tokens();
    let defs = doc
        .descendants()
        .find(|node| node.is_element() && node.tag_name().name() == "defs");
    let Some(defs) = defs else { return };
    if defs
        .parent_element()
        .is_none_or(|parent| parent.tag_name().name() != "svg")
    {
        errors.push(diagnostic(
            "definition-placement",
            "/svg/defs",
            "SVG definitions must be direct root children",
            "place marker definitions directly under the SVG root",
        ));
    }
    for (id, color) in [("arrow", tokens.arrow), ("arrow-emphasis", tokens.emphasis)] {
        let path = format!("/svg/defs/marker[@id={id:?}]");
        let Some(marker) = elements(defs)
            .find(|node| node.tag_name().name() == "marker" && node.attribute("id") == Some(id))
        else {
            errors.push(diagnostic(
                "marker",
                &path,
                "required local route marker definition is missing",
                "restore the fixed arrow marker definitions",
            ));
            continue;
        };
        for (name, value) in [
            ("markerWidth", "10"),
            ("markerHeight", "7"),
            ("refX", "9"),
            ("refY", "3.5"),
            ("orient", "auto"),
            ("markerUnits", "strokeWidth"),
        ] {
            require_attr(marker, name, value, &path, errors);
        }
        let Some(polygon) = elements(marker).find(|node| node.tag_name().name() == "polygon")
        else {
            errors.push(diagnostic(
                "marker-shape",
                &path,
                "route marker polygon is missing",
                "restore the fixed local arrowhead polygon",
            ));
            continue;
        };
        require_attr(polygon, "points", "0,0 10,3.5 0,7", &path, errors);
        require_attr(polygon, "fill", color, &path, errors);
    }
}

// Independent source policies: never call the writer's dash fallback helpers.
fn reference_dash(variant: Option<&str>) -> Option<&'static str> {
    match variant {
        Some("return") => Some("3 5"),
        Some("security") => Some("5 5"),
        Some("dashed") => Some("4 4"),
        _ => None,
    }
}
fn reference_frame_dash(kind: &str, c: &super::SemanticContext, id: &str) -> Option<&'static str> {
    match kind {
        "region" => Some("8 4"),
        "security-group" | "exception-lane" => Some("4 4"),
        "group"
            if c.frame_variants
                .get(id)
                .is_some_and(|variant| variant == "security") =>
        {
            Some("4 4")
        }
        "lane" | "group" | "stage" | "segment" => Some("6 6"),
        _ => None,
    }
}

fn reference_node_caption(
    g: &GeometryDocument,
    c: &super::SemanticContext,
    target: &str,
) -> String {
    let text = caption(g, target, "node");
    let kind = c
        .nodes
        .get(target)
        .map_or("node", |node| node.kind.as_str());
    if g.nodes
        .iter()
        .any(|node| node.id == target && node.final_state == Some(true))
    {
        format!("{text} ({kind}; final)")
    } else {
        format!("{text} ({kind})")
    }
}

fn check_rect_paint(
    node: Node<'_, '_>,
    kind: &str,
    radius: i64,
    options: &super::SvgOptions,
    path: &str,
    errors: &mut Vec<Diagnostic>,
) {
    if kind != "container-box" && node.attribute("stroke-dasharray").is_some() {
        errors.push(diagnostic(
            "paint",
            path,
            "a non-frame rectangle has an unexpected line pattern",
            "restore the fixed rectangle paint for this geometry kind",
        ));
    }
    let tokens = options.theme.tokens();
    let node_color = if kind == "node-box" {
        node.parent_element()
            .and_then(|parent| parent.attribute("data-source-id"))
            .and_then(|id| {
                options
                    .semantics
                    .as_ref()
                    .and_then(|context| context.nodes.get(id))
            })
            .and_then(|semantic| options.theme.kind(&semantic.kind))
    } else {
        None
    };
    if kind == "node-box" && node_color.is_none() {
        errors.push(diagnostic(
            "kind-token",
            path,
            "node paint has no matching source kind token",
            "restore the node source id and accepted type",
        ));
        return;
    }
    let (fill, stroke, width, radius) = match kind {
        "page" => (tokens.background, "none", "0", 0),
        "container-box" => (tokens.lane_fill, tokens.lane_stroke, "1", radius),
        "node-box" => {
            let color = node_color.expect("checked above");
            (color.fill, color.stroke, "1.5", radius)
        }
        "node-mask" => (tokens.mask, "none", "0", radius),
        "legend-box" => (tokens.lane_fill, tokens.lane_stroke, "1", radius),
        "legend-entry-box" | "label-bounds" => ("none", "none", "0", radius),
        _ => return,
    };
    for (name, expected) in [("fill", fill), ("stroke", stroke), ("stroke-width", width)] {
        require_attr(node, name, expected, path, errors);
    }
    require_attr(node, "rx", &super::svg::fixed(radius), path, errors);
}

fn check_unique_ids(doc: &Document<'_>, errors: &mut Vec<Diagnostic>) {
    let mut seen = BTreeSet::new();
    for node in doc.descendants().filter(|node| node.is_element()) {
        if let Some(id) = node.attribute("id") {
            if !seen.insert(id) {
                errors.push(diagnostic(
                    "duplicate-id",
                    &format!("//*[@id={id:?}]"),
                    format!("SVG id {id:?} is not unique"),
                    "give every SVG element a unique deterministic id",
                ));
            }
        }
    }
}

fn check_safe_tree(doc: &Document<'_>, errors: &mut Vec<Diagnostic>) {
    const ALLOWED: &[&str] = &[
        "svg", "title", "desc", "rect", "g", "polyline", "text", "tspan", "path", "defs", "marker",
        "polygon", "line", "circle",
    ];
    const KINDS: &[&str] = &[
        "page",
        "legend-box",
        "node",
        "node-box",
        "node-mask",
        "container",
        "container-box",
        "route",
        "route-path",
        "label",
        "label-bounds",
        "label-text",
        "glyph",
        "notdef",
        "legend-entry",
        "legend-entry-box",
    ];
    let allowed_attributes: &[(&str, &[&str])] = &[
        (
            "svg",
            &[
                "id",
                "role",
                "aria-labelledby",
                "viewBox",
                "width",
                "height",
                "data-theme",
            ],
        ),
        ("title", &["id"]),
        ("desc", &["id"]),
        ("defs", &[]),
        (
            "marker",
            &[
                "id",
                "markerWidth",
                "markerHeight",
                "refX",
                "refY",
                "orient",
                "markerUnits",
            ],
        ),
        ("polygon", &["points", "fill"]),
        (
            "rect",
            &[
                "data-kind",
                "x",
                "y",
                "width",
                "height",
                "rx",
                "stroke-dasharray",
                "fill",
                "stroke",
                "stroke-width",
            ],
        ),
        (
            "g",
            &[
                "id",
                "data-kind",
                "data-source-id",
                "data-route-role",
                "data-route-variant",
                "data-target-id",
                "role",
                "aria-label",
            ],
        ),
        (
            "polyline",
            &[
                "data-kind",
                "points",
                "fill",
                "stroke",
                "stroke-width",
                "marker-end",
                "stroke-dasharray",
            ],
        ),
        (
            "text",
            &[
                "data-kind",
                "font-family",
                "font-size",
                "font-weight",
                "font-kerning",
                "font-variant-ligatures",
                "text-rendering",
                "style",
                "space",
                "fill",
                "aria-hidden",
            ],
        ),
        ("tspan", &["data-kind", "data-index", "x", "y"]),
        (
            "path",
            &[
                "data-kind",
                "data-index",
                "d",
                "transform",
                "fill",
                "aria-hidden",
            ],
        ),
    ];
    for node in doc.descendants().filter(|node| node.is_element()) {
        if node.tag_name().namespace() != Some(SVG_NS) || !ALLOWED.contains(&node.tag_name().name())
        {
            errors.push(diagnostic(
                "element",
                "/svg",
                "SVG contains an element outside the supported SVG drawing vocabulary",
                "remove foreign, active, or untyped elements and regenerate the artifact",
            ));
        }
        let is_semantic = node
            .attribute("data-kind")
            .is_some_and(|kind| super::primitives::KINDS.contains(&kind));
        for attribute in node.attributes() {
            let name = attribute.name();
            let value = attribute.value().trim().to_ascii_lowercase();
            let allowed = if is_semantic {
                [
                    "id",
                    "data-kind",
                    "data-target-id",
                    "aria-hidden",
                    "x",
                    "y",
                    "width",
                    "height",
                    "rx",
                    "x1",
                    "y1",
                    "x2",
                    "y2",
                    "cx",
                    "cy",
                    "r",
                    "points",
                    "fill",
                    "stroke",
                    "stroke-width",
                    "stroke-dasharray",
                    "marker-end",
                ]
                .contains(&name)
            } else {
                allowed_attributes
                    .iter()
                    .find(|(tag, _)| *tag == node.tag_name().name())
                    .is_some_and(|(_, attributes)| attributes.contains(&name))
            };
            let is_xml_space = name == "space"
                && attribute.namespace() == Some("http://www.w3.org/XML/1998/namespace")
                && node.tag_name().name() == "text";
            if !allowed && !is_xml_space {
                errors.push(diagnostic(
                    "unexpected-attribute",
                    "/svg",
                    format!("SVG element has unsupported attribute {name:?}"),
                    "remove unrecognized transforms, paint overrides, and metadata attributes",
                ));
            }
            if name.len() > 2
                && name.as_bytes()[..2].eq_ignore_ascii_case(b"on")
                && name.as_bytes()[2].is_ascii_alphabetic()
                || (matches!(name, "href" | "xlink:href")
                    && !(value.is_empty() || value.starts_with('#')))
                || value.contains("@import")
                || value
                    .match_indices("url(")
                    .any(|(offset, _)| !value[offset..].starts_with("url(#"))
            {
                errors.push(diagnostic(
                    "unsafe-attribute",
                    "/svg",
                    format!("SVG attribute {name:?} contains active or external content"),
                    "remove scripts and external references from the SVG artifact",
                ));
            }
        }
        if let Some(kind) = node.attribute("data-kind") {
            let expected_parent = match kind {
                "node-box" | "node-mask" => Some("node"),
                "container-box" => Some("container"),
                "route-path" => Some("route"),
                "label-bounds" | "label-text" | "notdef" => Some("label"),
                "glyph" => Some("label-text"),
                "legend-entry-box" => Some("legend-entry"),
                "page" | "legend-box" | "node" | "container" | "route" | "label"
                | "legend-entry" => None,
                _ if is_semantic => None,
                _ => Some("__invalid__"),
            };
            let parent = node.parent_element();
            let parent_matches = match expected_parent {
                Some(parent_kind) => {
                    parent.is_some_and(|parent| parent.attribute("data-kind") == Some(parent_kind))
                }
                None => parent.is_some_and(|parent| parent.tag_name().name() == "svg"),
            };
            if !parent_matches {
                errors.push(diagnostic(
                    "element-hierarchy",
                    "/svg",
                    format!("SVG {kind} is outside its required semantic group"),
                    "restore the writer's typed SVG parent and child structure",
                ));
            }
        }
        if !matches!(node.tag_name().name(), "svg" | "title" | "desc")
            && node.attribute("data-kind").is_none()
            && !matches!(node.tag_name().name(), "defs" | "marker" | "polygon")
        {
            errors.push(diagnostic(
                "untyped-element",
                "/svg",
                "SVG contains an untyped drawable element that could add unverified paint",
                "emit drawing elements only for declared geometry kinds",
            ));
        }
        if node
            .attribute("data-kind")
            .is_some_and(|kind| !KINDS.contains(&kind) && !super::primitives::KINDS.contains(&kind))
        {
            errors.push(diagnostic(
                "unknown-kind",
                "/svg",
                "SVG contains an undeclared geometry kind",
                "emit only the supported geometry kinds from the retained scene",
            ));
        }
        if (node.tag_name().name() == "marker"
            || (node.tag_name().name() == "polygon" && !is_semantic))
            && !node
                .ancestors()
                .any(|parent| parent.tag_name().name() == "defs")
        {
            errors.push(diagnostic(
                "element-placement",
                "/svg",
                "marker geometry must be contained by SVG definitions",
                "keep marker shapes inside the artifact defs section",
            ));
        }
        if matches!(node.tag_name().name(), "title" | "desc")
            && node
                .parent_element()
                .is_some_and(|parent| parent.tag_name().name() != "svg")
        {
            errors.push(diagnostic(
                "element-placement",
                "/svg",
                "accessibility metadata elements must be direct SVG root children",
                "keep title and description directly under the root SVG element",
            ));
        }
    }
}

fn caption(geometry: &GeometryDocument, target: &str, namespace: &str) -> String {
    let prefix = format!("{namespace}:{target}:");
    let labels: Vec<_> = geometry
        .labels
        .iter()
        .filter(|label| {
            label.target_id == target
                && label.id.as_ref().is_some_and(|id| id.starts_with(&prefix))
                && !label.text.is_empty()
        })
        .map(|label| label.text.as_str())
        .collect();
    if labels.is_empty() {
        target.to_owned()
    } else {
        labels.join("; ")
    }
}

fn first_kind<'a, 'input>(
    doc: &'a Document<'input>,
    kind: &str,
    key: &str,
    errors: &mut Vec<Diagnostic>,
) -> Option<Node<'a, 'input>> {
    let nodes = kind_nodes(doc, kind);
    let found = nodes.into_iter().find(|node| node.attribute(key).is_some());
    if found.is_none() {
        errors.push(diagnostic(
            "missing-element",
            &format!("/svg/{kind}"),
            format!("SVG is missing a {kind} element with its required {key} attribute"),
            "regenerate the missing semantic SVG element",
        ));
    }
    found
}

fn check_child_box(
    parent: Node<'_, '_>,
    kind: &str,
    bounds: GeometryBox,
    path: &str,
    errors: &mut Vec<Diagnostic>,
) {
    let found = elements(parent).find(|child| child.attribute("data-kind") == Some(kind));
    match found {
        Some(node) if node.tag_name().name() == "rect" => check_box(node, bounds, path, errors),
        _ => errors.push(diagnostic(
            "bounds-frame",
            path,
            format!("expected child rect {kind:?} is missing"),
            "emit the source geometry bounds as the element's selection frame",
        )),
    }
}

fn check_label(
    doc: &Document<'_>,
    label: &crate::geometry::GeometryLabel,
    index: usize,
    errors: &mut Vec<Diagnostic>,
) {
    let key = super::svg::label_key(label, index);
    let path = format!("/labels/{index}");
    let Some(group) = kind_nodes(doc, "label")
        .into_iter()
        .find(|node| node.attribute("id") == Some(super::svg::id("label", &key).as_str()))
    else {
        errors.push(diagnostic(
            "label",
            &path,
            "label group id does not correspond to source geometry",
            "regenerate the label group with the stable geometry key",
        ));
        return;
    };
    require_attr(group, "data-source-id", &key, &path, errors);
    require_attr(group, "data-target-id", &label.target_id, &path, errors);
    require_attr(group, "aria-label", &label.text, &path, errors);
    check_child_box(group, "label-bounds", label.bounds, &path, errors);
    let text = elements(group).find(|child| child.attribute("data-kind") == Some("label-text"));
    let Some(text) = text else {
        errors.push(diagnostic(
            "label-text",
            &path,
            "label text element is missing",
            "emit positioned glyph runs from geometry glyph records",
        ));
        return;
    };
    require_attr(text, "font-family", super::FONT_FAMILY, &path, errors);
    require_attr(
        text,
        "style",
        "font-feature-settings:'liga' 0,'clig' 0,'calt' 0,'locl' 0,'kern' 0,'mark' 0,'mkmk' 0",
        &path,
        errors,
    );
    require_attr(text, "font-kerning", "none", &path, errors);
    require_attr(text, "font-variant-ligatures", "none", &path, errors);
    require_attr(text, "text-rendering", "geometricPrecision", &path, errors);
    require_attr(
        text,
        "font-size",
        &super::svg::fixed(label.font_size.into()),
        &path,
        errors,
    );
    require_attr(
        text,
        "font-weight",
        &label.font.weight.to_string(),
        &path,
        errors,
    );

    let expected: Vec<_> = label
        .glyphs
        .iter()
        .enumerate()
        .filter(|(_, glyph)| !glyph.ignored && !glyph.replaced)
        .collect();
    let actual: Vec<_> = elements(text)
        .filter(|child| child.attribute("data-kind") == Some("glyph"))
        .collect();
    if text
        .children()
        .any(|child| child.is_text() && !child.text().unwrap_or("").trim().is_empty())
    {
        errors.push(diagnostic(
            "label-text-node",
            &path,
            "label text contains unpositioned text outside its glyph elements",
            "emit visible label characters only in geometry-positioned glyph elements",
        ));
    }
    if actual.len() != expected.len() {
        errors.push(diagnostic(
            "glyph-count",
            &path,
            "visible SVG glyph runs do not match the known source glyphs",
            "emit one positioned text run for each known non-ignored glyph",
        ));
    }
    for (glyph_node, (source_index, glyph)) in actual.iter().zip(expected.iter()) {
        let glyph_path = format!("{path}/glyphs/{source_index}");
        if elements(*glyph_node).next().is_some() {
            errors.push(diagnostic(
                "glyph-shape",
                &glyph_path,
                "glyph text element contains nested markup",
                "emit the glyph input as plain text in its positioned glyph element",
            ));
        }
        require_attr(
            *glyph_node,
            "data-index",
            &source_index.to_string(),
            &glyph_path,
            errors,
        );
        if glyph_node.text() != Some(glyph.input.as_str()) {
            errors.push(diagnostic(
                "glyph-text",
                &glyph_path,
                "visible glyph text differs from the geometry input",
                "preserve the exact known glyph input from geometry",
            ));
        }
        check_number(
            *glyph_node,
            "x",
            glyph.position.x as f64 / 64.0,
            &glyph_path,
            errors,
        );
        check_number(
            *glyph_node,
            "y",
            glyph.position.y as f64 / 64.0,
            &glyph_path,
            errors,
        );
    }
    let replacements: Vec<_> = label
        .glyphs
        .iter()
        .enumerate()
        .filter(|(_, glyph)| glyph.replaced && !glyph.ignored)
        .collect();
    let notdefs: Vec<_> = elements(group)
        .filter(|child| child.attribute("data-kind") == Some("notdef"))
        .collect();
    if notdefs.len() != replacements.len() {
        errors.push(diagnostic(
            "notdef-count",
            &path,
            "replacement glyph paths do not match replaced geometry glyphs",
            "emit only the pinned notdef path for each replaced glyph",
        ));
    }
    for ((path_node, (index, _glyph)), _) in notdefs.iter().zip(replacements.iter()).zip(0..) {
        let glyph_path = format!("{path}/glyphs/{index}");
        require_attr(
            *path_node,
            "data-index",
            &index.to_string(),
            &glyph_path,
            errors,
        );
        match super::svg::notdef(label.font.weight) {
            Ok(expected) => {
                if expected.units_per_em != label.font.units_per_em
                    || expected.source_sha256 != label.font.font_sha256
                {
                    errors.push(diagnostic(
                        "notdef-font",
                        &glyph_path,
                        "pinned replacement outline does not match the label font identity",
                        "regenerate the pinned glyph-zero outline from the matching font source",
                    ));
                }
                require_attr(*path_node, "d", &expected.path, &glyph_path, errors);
                let glyph = &label.glyphs[*index];
                let scale = format!(
                    "{:.9}",
                    f64::from(label.font_size) / (64.0 * f64::from(expected.units_per_em))
                );
                let scale = scale.trim_end_matches('0').trim_end_matches('.');
                let transform = format!(
                    "translate({} {}) scale({scale} -{scale})",
                    super::svg::fixed(glyph.position.x.into()),
                    super::svg::fixed(glyph.position.y.into())
                );
                require_attr(*path_node, "transform", &transform, &glyph_path, errors);
            }
            Err(error) => errors.push(error),
        }
    }
    let emitted: String = actual
        .iter()
        .filter_map(|node| node.text())
        .flat_map(str::chars)
        .filter(|character| *character != '\n' && *character != '\r')
        .collect();
    let glyphs_without_newlines: String = label
        .glyphs
        .iter()
        .filter(|glyph| !glyph.ignored && !glyph.replaced)
        .flat_map(|glyph| glyph.input.chars())
        .filter(|character| *character != '\n' && *character != '\r')
        .collect();
    if emitted != glyphs_without_newlines {
        errors.push(diagnostic(
            "label-content",
            &path,
            "visible label content does not preserve the non-replaced source text",
            "emit known glyph inputs in source order and omit ignored or replaced original text",
        ));
    }
    let source_without_newlines: String = label
        .text
        .chars()
        .filter(|character| *character != '\n' && *character != '\r')
        .collect();
    let all_glyph_inputs: String = label
        .glyphs
        .iter()
        .flat_map(|glyph| glyph.input.chars())
        .filter(|character| *character != '\n' && *character != '\r')
        .collect();
    if all_glyph_inputs != source_without_newlines {
        errors.push(diagnostic(
            "label-source",
            &path,
            "geometry glyph inputs do not reconstruct the source label text",
            "repair the source glyph records before rendering the label",
        ));
    }
}

/// Check an SVG artifact against geometry without asking the renderer to produce
/// a second copy for comparison.
pub fn check_svg_artifact(
    svg: &str,
    geometry: &GeometryDocument,
    options: &super::SvgOptions,
) -> Vec<Diagnostic> {
    if svg.len() > super::MAX_SVG_BYTES {
        return vec![diagnostic(
            "size",
            "/",
            "SVG artifact exceeds the 16 MiB inspection limit",
            "split the scene into smaller diagrams before rendering",
        )];
    }
    if svg.to_ascii_uppercase().contains("<!DOCTYPE") {
        return vec![diagnostic(
            "doctype",
            "/",
            "SVG document type declarations are not supported by the artifact gate",
            "remove the document type declaration and render a self-contained SVG",
        )];
    }
    let semantics = match super::primitives::context(geometry, options) {
        Ok(context) => context,
        Err(cause) => return vec![cause],
    };
    let derived = super::primitive_gate::expected(geometry, options);
    let doc = match Document::parse(svg) {
        Ok(doc) => doc,
        Err(cause) => {
            return vec![diagnostic(
                "xml",
                "/",
                format!("SVG is not well-formed XML: {cause}"),
                "regenerate a well-formed SVG artifact",
            )]
        }
    };
    let mut errors = super::xml_gate::inspect(svg, &doc);
    check_safe_tree(&doc, &mut errors);
    check_unique_ids(&doc, &mut errors);
    let root = doc.root_element();
    if root.tag_name().name() != "svg" || root.tag_name().namespace() != Some(SVG_NS) {
        errors.push(diagnostic(
            "root",
            "/",
            "artifact root is not an SVG namespace element",
            "emit an SVG root with the standard namespace",
        ));
        return errors;
    }
    require_attr(root, "id", "maru-svg", "/svg", &mut errors);
    require_attr(root, "role", "img", "/svg", &mut errors);
    require_attr(
        root,
        "aria-labelledby",
        "maru-title maru-desc",
        "/svg",
        &mut errors,
    );
    require_attr(
        root,
        "data-theme",
        match options.theme {
            super::SvgTheme::Light => "light",
            super::SvgTheme::Dark => "dark",
        },
        "/svg",
        &mut errors,
    );
    let view_box = format!(
        "{} {} {} {}",
        super::svg::fixed(geometry.page.bounds.x.into()),
        super::svg::fixed(geometry.page.bounds.y.into()),
        super::svg::fixed(geometry.page.bounds.width.into()),
        super::svg::fixed(geometry.page.bounds.height.into())
    );
    require_attr(root, "viewBox", &view_box, "/svg", &mut errors);
    check_number(
        root,
        "width",
        geometry.page.bounds.width as f64 / 64.0,
        "/svg",
        &mut errors,
    );
    check_number(
        root,
        "height",
        geometry.page.bounds.height as f64 / 64.0,
        "/svg",
        &mut errors,
    );

    let title = elements(root).find(|node| node.tag_name().name() == "title");
    let desc = elements(root).find(|node| node.tag_name().name() == "desc");
    match title {
        Some(node) => {
            require_attr(node, "id", "maru-title", "/svg/title", &mut errors);
            if node.text() != Some(options.title.as_str()) {
                errors.push(diagnostic(
                    "title",
                    "/svg/title",
                    "SVG title differs from render options",
                    "regenerate the accessible title from render options",
                ));
            }
        }
        None => errors.push(diagnostic(
            "title",
            "/svg/title",
            "accessible SVG title is missing",
            "emit the configured title element",
        )),
    }
    match desc {
        Some(node) => {
            require_attr(node, "id", "maru-desc", "/svg/desc", &mut errors);
            if node.text() != Some(options.description.as_str()) {
                errors.push(diagnostic(
                    "description",
                    "/svg/desc",
                    "SVG description differs from render options",
                    "regenerate the accessible description from render options",
                ));
            }
        }
        None => errors.push(diagnostic(
            "description",
            "/svg/desc",
            "accessible SVG description is missing",
            "emit the configured description element",
        )),
    }

    let mut expected_counts = BTreeMap::from([
        ("page", 1),
        ("legend-box", 1),
        ("node", geometry.nodes.len()),
        ("node-box", geometry.nodes.len()),
        ("node-mask", geometry.nodes.len()),
        ("container", geometry.containers.len()),
        ("container-box", geometry.containers.len()),
        ("route", geometry.routes.len()),
        ("route-path", geometry.routes.len()),
        ("label", geometry.labels.len()),
        ("label-bounds", geometry.labels.len()),
        ("label-text", geometry.labels.len()),
        ("legend-entry", geometry.legend.entries.len()),
        ("legend-entry-box", geometry.legend.entries.len()),
    ]);
    let replacement_count: usize = geometry
        .labels
        .iter()
        .flat_map(|label| label.glyphs.iter())
        .filter(|glyph| glyph.replaced && !glyph.ignored)
        .count();
    let glyph_count: usize = geometry
        .labels
        .iter()
        .flat_map(|label| label.glyphs.iter())
        .filter(|glyph| !glyph.replaced && !glyph.ignored)
        .count();
    expected_counts.insert("glyph", glyph_count);
    expected_counts.insert("notdef", replacement_count);
    for (kind, expected) in expected_counts {
        check_count(&doc, kind, expected, &mut errors);
    }
    check_tag_count(&doc, "defs", 1, &mut errors);
    check_tag_count(&doc, "marker", 2, &mut errors);
    check_tag_count(
        &doc,
        "polygon",
        2 + derived
            .iter()
            .filter(|p| matches!(p.shape, super::primitives::Shape::Polygon { .. }))
            .count(),
        &mut errors,
    );
    check_defs(&doc, options, &mut errors);

    if let Some(page) = first_kind(&doc, "page", "data-kind", &mut errors) {
        check_box(page, geometry.page.bounds, "/page", &mut errors);
        check_rect_paint(page, "page", 0, options, "/page", &mut errors);
    }
    if let Some(legend) = first_kind(&doc, "legend-box", "data-kind", &mut errors) {
        check_box(legend, geometry.legend.bounds, "/legend", &mut errors);
        check_rect_paint(
            legend,
            "legend-box",
            6 * 64,
            options,
            "/legend",
            &mut errors,
        );
    }
    for (index, node) in geometry.nodes.iter().enumerate() {
        let path = format!("/nodes/{index}");
        let id = super::svg::id("node", &node.id);
        if let Some(group) = kind_nodes(&doc, "node")
            .into_iter()
            .find(|item| item.attribute("id") == Some(id.as_str()))
        {
            require_attr(group, "data-source-id", &node.id, &path, &mut errors);
            require_attr(group, "role", "group", &path, &mut errors);
            require_attr(
                group,
                "aria-label",
                &reference_node_caption(geometry, semantics, &node.id),
                &path,
                &mut errors,
            );
            check_child_box(group, "node-box", node.bounds, &path, &mut errors);
            check_child_box(group, "node-mask", node.bounds, &path, &mut errors);
            if let Some(mask) =
                elements(group).find(|child| child.attribute("data-kind") == Some("node-mask"))
            {
                check_rect_paint(
                    mask,
                    "node-mask",
                    if semantics.family == "lifecycle" {
                        7 * 64
                    } else {
                        6 * 64
                    },
                    options,
                    &path,
                    &mut errors,
                );
            }

            if let Some(box_node) =
                elements(group).find(|child| child.attribute("data-kind") == Some("node-box"))
            {
                check_rect_paint(
                    box_node,
                    "node-box",
                    if semantics.family == "lifecycle" {
                        7 * 64
                    } else {
                        6 * 64
                    },
                    options,
                    &path,
                    &mut errors,
                );
            }
        } else {
            errors.push(diagnostic(
                "node",
                &path,
                "node group id does not correspond to source geometry",
                "regenerate the node group with its stable source id",
            ));
        }
    }
    for (index, container) in geometry.containers.iter().enumerate() {
        let path = format!("/containers/{index}");
        let id = super::svg::id("container", &container.id);
        if let Some(group) = kind_nodes(&doc, "container")
            .into_iter()
            .find(|item| item.attribute("id") == Some(id.as_str()))
        {
            require_attr(group, "data-source-id", &container.id, &path, &mut errors);
            require_attr(group, "role", "group", &path, &mut errors);
            require_attr(
                group,
                "aria-label",
                &caption(geometry, &container.id, "container"),
                &path,
                &mut errors,
            );
            check_child_box(group, "container-box", container.bounds, &path, &mut errors);
            if let Some(frame) =
                elements(group).find(|n| n.attribute("data-kind") == Some("container-box"))
            {
                if let Some(dash) = reference_frame_dash(&container.kind, semantics, &container.id)
                {
                    require_attr(frame, "stroke-dasharray", dash, &path, &mut errors);
                } else if frame.attribute("stroke-dasharray").is_some() {
                    errors.push(diagnostic(
                        "frame-dash",
                        &path,
                        "frame has an unrequested line style",
                        "restore the semantic frame style from the source kind",
                    ));
                }
            }

            if let Some(box_node) =
                elements(group).find(|child| child.attribute("data-kind") == Some("container-box"))
            {
                let radius = match container.kind.as_str() {
                    "region" => 12,
                    "lane" | "segment" | "stage" => 10,
                    "group" => 9,
                    "security-group" | "exception-lane" => 8,
                    "phase" => 4,
                    "activation" => 3,
                    _ => 6,
                } * 64;
                check_rect_paint(
                    box_node,
                    "container-box",
                    radius,
                    options,
                    &path,
                    &mut errors,
                );
            }
        } else {
            errors.push(diagnostic(
                "container",
                &path,
                "container group id does not correspond to source geometry",
                "regenerate the container group with its stable source id",
            ));
        }
    }
    for (index, route) in geometry.routes.iter().enumerate() {
        let key = super::svg::route_key(route, index);
        let path = format!("/routes/{index}");
        let id = super::svg::id("route", &key);
        if let Some(group) = kind_nodes(&doc, "route")
            .into_iter()
            .find(|item| item.attribute("id") == Some(id.as_str()))
        {
            require_attr(group, "data-source-id", &key, &path, &mut errors);
            require_attr(group, "role", "group", &path, &mut errors);
            require_attr(
                group,
                "aria-label",
                &format!("{} → {}", route.from, route.to),
                &path,
                &mut errors,
            );
            for (name, value) in [
                ("data-route-role", route.role.as_deref()),
                ("data-route-variant", route.variant.as_deref()),
            ] {
                if let Some(value) = value {
                    require_attr(group, name, value, &path, &mut errors);
                } else if group.attribute(name).is_some() {
                    errors.push(diagnostic(
                        "route-semantic",
                        &path,
                        "route carries an unrequested semantic tag",
                        "restore the route role and variant from E2 geometry",
                    ));
                }
            }
            if let Some(polyline) =
                elements(group).find(|child| child.attribute("data-kind") == Some("route-path"))
            {
                require_tag(polyline, "polyline", &path, &mut errors);
                check_points(polyline, &route.points, &path, &mut errors);
                let tokens = options.theme.tokens();
                let emphasis = route.variant.as_deref() == Some("emphasis");
                require_attr(polyline, "fill", "none", &path, &mut errors);
                require_attr(
                    polyline,
                    "stroke",
                    if emphasis {
                        tokens.emphasis
                    } else {
                        tokens.arrow
                    },
                    &path,
                    &mut errors,
                );
                require_attr(
                    polyline,
                    "marker-end",
                    if emphasis {
                        "url(#arrow-emphasis)"
                    } else {
                        "url(#arrow)"
                    },
                    &path,
                    &mut errors,
                );
                check_number(
                    polyline,
                    "stroke-width",
                    route
                        .width
                        .map(|width| f64::from(width) / 64.0)
                        .unwrap_or_else(|| {
                            if emphasis {
                                if semantics.family == "lifecycle" {
                                    if semantics.schema_version == 1 {
                                        2.0
                                    } else {
                                        1.6
                                    }
                                } else {
                                    1.8
                                }
                            } else {
                                match semantics.family.as_str() {
                                    "architecture" => 1.5,
                                    "lifecycle" => 1.1,
                                    _ => 1.4,
                                }
                            }
                        }),
                    &path,
                    &mut errors,
                );
                if let Some(dash) = reference_dash(route.variant.as_deref()) {
                    require_attr(polyline, "stroke-dasharray", dash, &path, &mut errors);
                } else if attr(polyline, "stroke-dasharray").is_some() {
                    errors.push(diagnostic(
                        "route-style",
                        &path,
                        "route has an unexpected dash pattern",
                        "restore the route style from its geometry variant",
                    ));
                }
            } else {
                errors.push(diagnostic(
                    "route-path",
                    &path,
                    "route polyline is missing",
                    "emit a polyline containing all source route points",
                ));
            }
        } else {
            errors.push(diagnostic(
                "route",
                &path,
                "route group id does not correspond to source geometry",
                "regenerate the route group with its stable route key",
            ));
        }
    }
    for (index, label) in geometry.labels.iter().enumerate() {
        check_label(&doc, label, index, &mut errors);
        if let Some(group) = kind_nodes(&doc, "label").into_iter().find(|node| {
            node.attribute("id")
                == Some(super::svg::id("label", &super::svg::label_key(label, index)).as_str())
        }) {
            if let Some(bounds) =
                elements(group).find(|node| node.attribute("data-kind") == Some("label-bounds"))
            {
                check_rect_paint(
                    bounds,
                    "label-bounds",
                    0,
                    options,
                    &format!("/labels/{index}"),
                    &mut errors,
                );
            }
            let tokens = options.theme.tokens();
            let color = if label.font.weight == 700 {
                tokens.text
            } else {
                tokens.muted
            };
            if let Some(text) =
                elements(group).find(|node| node.attribute("data-kind") == Some("label-text"))
            {
                require_attr(
                    text,
                    "fill",
                    color,
                    &format!("/labels/{index}"),
                    &mut errors,
                );
                require_attr(
                    text,
                    "aria-hidden",
                    "true",
                    &format!("/labels/{index}"),
                    &mut errors,
                );
            }
            for path_node in
                elements(group).filter(|node| node.attribute("data-kind") == Some("notdef"))
            {
                require_attr(
                    path_node,
                    "fill",
                    color,
                    &format!("/labels/{index}"),
                    &mut errors,
                );
                require_attr(
                    path_node,
                    "aria-hidden",
                    "true",
                    &format!("/labels/{index}"),
                    &mut errors,
                );
            }
        }
    }
    for (index, entry) in geometry.legend.entries.iter().enumerate() {
        let path = format!("/legend/entries/{index}");
        let id = super::svg::id("legend", &entry.key);
        if let Some(group) = kind_nodes(&doc, "legend-entry")
            .into_iter()
            .find(|item| item.attribute("id") == Some(id.as_str()))
        {
            require_attr(group, "role", "listitem", &path, &mut errors);
            require_attr(group, "aria-label", &entry.label, &path, &mut errors);
            check_child_box(group, "legend-entry-box", entry.bounds, &path, &mut errors);
            if let Some(box_node) = elements(group)
                .find(|child| child.attribute("data-kind") == Some("legend-entry-box"))
            {
                check_rect_paint(box_node, "legend-entry-box", 0, options, &path, &mut errors);
            }
        } else {
            errors.push(diagnostic(
                "legend-entry",
                &path,
                "legend entry id does not correspond to source geometry",
                "regenerate the legend entry using its stable key",
            ));
        }
    }
    errors.extend(super::primitive_gate::check_primitives(
        &doc, geometry, options,
    ));
    errors
}
