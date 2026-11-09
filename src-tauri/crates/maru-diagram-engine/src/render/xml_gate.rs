//! Reject XML constructs that the structural SVG gate does not interpret.

use crate::Diagnostic;
use roxmltree::{Document, Node};

fn diagnostic(path: &str, cause: &str) -> Diagnostic {
    super::error(
        "artifact-xml-node",
        path,
        cause,
        "remove non-renderer XML constructs and regenerate the SVG from its geometry and options",
    )
}

fn is_allowed_text_parent(node: Node<'_, '_>) -> bool {
    node.is_element() && matches!(node.tag_name().name(), "title" | "desc" | "tspan")
}

/// Checks XML constructs and node kinds omitted by the SVG element gate.
///
/// `roxmltree` does not preserve whether text came from CDATA and does not
/// expose declarations or doctypes as ordinary child nodes, so those forms
/// are rejected lexically before walking the parsed document.
pub(crate) fn inspect(svg: &str, doc: &Document<'_>) -> Vec<Diagnostic> {
    let mut errors = Vec::new();

    let declaration_start = svg.contains("<?xml");
    let forbidden_lexical = [
        (
            "<!DOCTYPE",
            "document type declarations are not allowed in rendered SVG",
        ),
        (
            "<!ENTITY",
            "entity declarations are not allowed in rendered SVG",
        ),
        (
            "<![CDATA[",
            "CDATA sections are not allowed in rendered SVG",
        ),
    ];
    if declaration_start {
        errors.push(diagnostic(
            "/",
            "XML declarations are not part of the canonical rendered SVG document",
        ));
    }
    for (token, cause) in forbidden_lexical {
        if svg.contains(token) {
            errors.push(diagnostic("/", cause));
        }
    }

    for node in doc.descendants() {
        let path = node
            .parent()
            .filter(|parent| parent.is_element())
            .map(|parent| format!("/{}", parent.tag_name().name()))
            .unwrap_or_else(|| "/".to_owned());
        if node.is_pi() {
            errors.push(diagnostic(
                &path,
                "processing instructions are not allowed in rendered SVG",
            ));
        } else if node.is_comment() {
            errors.push(diagnostic(
                &path,
                "XML comments are not allowed in rendered SVG",
            ));
        } else if node.is_text() {
            let text = node.text().unwrap_or_default();
            if !text.trim().is_empty()
                && node
                    .parent()
                    .is_none_or(|parent| !is_allowed_text_parent(parent))
            {
                errors.push(diagnostic(
                    &path,
                    "non-whitespace text is only allowed in SVG title, description, and glyph nodes",
                ));
            }
        }
    }

    errors
}
