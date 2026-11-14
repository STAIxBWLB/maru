//! Independent E5 document validity for `floorplan/architecture@1`.
//!
//! The document is the upstream interchange JSON, validated as authored: no
//! layout, no renderer and no Floorplan code, which the spec allows as a
//! reference only. The rules mirror the local floor the application already
//! applies (`src/lib/diagram/floorplan.ts` in maru): schema and enum shape,
//! unique node ids, parents that exist and do not cycle, edge endpoints that
//! resolve, flows with at least two resolvable steps and resolvable tour stops.
//! Layout is E5 T2, the repository scanner T3 and the apply-gate switch T4.
//!
//! An edge endpoint, flow step or tour stop names a node id, or a file that some
//! node's `paths` claim, which is why the upstream glob subset is matched here.
//! It is written by hand because the crate carries no regex dependency and the
//! WASM build is measured per chunk.

use crate::common::{self, Context};
use crate::Diagnostic;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

/// The schema identifier the document must declare.
pub const FLOORPLAN_SCHEMA_ID: &str = "floorplan/architecture@1";

/// Node kinds the upstream schema documents.
pub const NODE_KINDS: &[&str] = &[
    "ui", "service", "worker", "library", "feature", "data", "config", "test", "script", "infra",
    "external",
];

/// Edge kinds the upstream schema documents.
pub const EDGE_KINDS: &[&str] = &[
    "import", "call", "http", "rpc", "event", "queue", "data", "config",
];

/// Audience values the schema documents; absent means everyone.
pub const AUDIENCES: &[&str] = &["everyone", "developers"];

const TOP_FIELDS: &[&str] = &[
    "$schema",
    "project",
    "nodes",
    "edges",
    "annotations",
    "flows",
    "tour",
    "audience",
    "include",
    "ignore",
];
const PROJECT_FIELDS: &[&str] = &["name", "summary", "entrypoints"];
const NODE_FIELDS: &[&str] = &[
    "id", "label", "kind", "parent", "summary", "details", "paths", "exclude", "packages", "hosts",
    "tags",
];
const EDGE_FIELDS: &[&str] = &["from", "to", "kind", "label", "description"];
const ANNOTATION_FIELDS: &[&str] = &["path", "note", "tags"];
const FLOW_FIELDS: &[&str] = &["id", "title", "description", "steps"];
const FLOW_STEP_FIELDS: &[&str] = &["node", "note"];
const TOUR_STOP_FIELDS: &[&str] = &["node", "title", "note"];

/// One `floorplan/architecture@1` document. Optional collections stay optional
/// so a map without edges, flows, annotations or a tour validates.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
pub struct FloorplanSpec {
    #[serde(rename = "$schema")]
    #[cfg_attr(feature = "typegen", ts(rename = "$schema"))]
    pub schema: String,
    pub project: FloorplanProject,
    pub nodes: Vec<FloorplanNode>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub edges: Option<Vec<FloorplanEdge>>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub annotations: Option<Vec<FloorplanAnnotation>>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub flows: Option<Vec<FloorplanFlow>>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub tour: Option<Vec<FloorplanTourStop>>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub audience: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub include: Option<Vec<String>>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub ignore: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
pub struct FloorplanProject {
    pub name: String,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub summary: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub entrypoints: Option<Vec<String>>,
}

/// One map node. `parent` nests it under another node; `paths` claims the files
/// it owns, in the upstream glob subset.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
pub struct FloorplanNode {
    pub id: String,
    pub label: String,
    pub kind: String,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub parent: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub summary: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub details: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub paths: Option<Vec<String>>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub exclude: Option<Vec<String>>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub packages: Option<Vec<String>>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub hosts: Option<Vec<String>>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
pub struct FloorplanEdge {
    pub from: String,
    pub to: String,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub kind: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub label: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
pub struct FloorplanAnnotation {
    pub path: String,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub note: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
pub struct FloorplanFlow {
    pub id: String,
    pub title: String,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub description: Option<String>,
    pub steps: Vec<FloorplanFlowStep>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
pub struct FloorplanFlowStep {
    pub node: String,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
pub struct FloorplanTourStop {
    pub node: String,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub title: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub note: Option<String>,
}

// ---------------------------------------------------------------------------
// The upstream glob subset
// ---------------------------------------------------------------------------

/// Whether `text` holds the upstream glob syntax. A whole path segment in
/// brackets (`[id]`, `[...slug]`, `[[...slug]]`) is a literal folder name, so it
/// does not count, exactly as the application's matcher decides it.
fn has_wildcard(pattern: &str) -> bool {
    let chars: Vec<char> = pattern.chars().collect();
    let mut at = 0;
    while at < chars.len() {
        let segment_start = at == 0 || chars[at - 1] == '/';
        if chars[at] == '[' && segment_start {
            let mut end = at;
            while end < chars.len() && chars[end] != '/' {
                end += 1;
            }
            let segment: String = chars[at..end].iter().collect();
            let literal =
                segment.ends_with(']') && !segment.chars().any(|ch| matches!(ch, '{' | '}' | ','));
            if literal {
                at = end;
                continue;
            }
        }
        if matches!(chars[at], '*' | '?' | '{') {
            return true;
        }
        at += 1;
    }
    false
}

/// Expand `{a,b}` alternations, recursively, leaving bracketed literal segments
/// and character classes alone. An unclosed `{` is a literal brace.
fn expand_braces(pattern: &str) -> Vec<String> {
    let Some(open) = pattern.find('{') else {
        return vec![pattern.to_string()];
    };
    let mut depth = 0usize;
    let mut close = None;
    for (offset, ch) in pattern[open..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    close = Some(open + offset);
                    break;
                }
            }
            _ => {}
        }
    }
    let Some(close) = close else {
        return vec![pattern.to_string()];
    };
    let prefix = &pattern[..open];
    let suffix = &pattern[close + 1..];
    let body = &pattern[open + 1..close];
    let mut members = Vec::new();
    let mut depth = 0usize;
    let mut start = 0usize;
    for (offset, ch) in body.char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => depth -= 1,
            ',' if depth == 0 => {
                members.push(&body[start..offset]);
                start = offset + 1;
            }
            _ => {}
        }
    }
    members.push(&body[start..]);
    let mut expanded = Vec::new();
    for member in members {
        for tail in expand_braces(suffix) {
            expanded.extend(expand_braces(&format!("{prefix}{member}{tail}")));
        }
    }
    expanded
}

/// Whether one character is listed by a class body, which takes ranges (`a-z`),
/// a leading `\` escape and every other character literally.
fn class_matches(body: &[char], ch: char) -> bool {
    let mut at = 0;
    while at < body.len() {
        let mut first = body[at];
        if first == '\\' && at + 1 < body.len() {
            at += 1;
            first = body[at];
        }
        if at + 2 < body.len() && body[at + 1] == '-' {
            let last = body[at + 2];
            if first <= ch && ch <= last {
                return true;
            }
            at += 3;
            continue;
        }
        if first == ch {
            return true;
        }
        at += 1;
    }
    false
}

/// Match one path segment against one pattern segment: `*` any run inside the
/// segment, `?` one character, `[abc]` an allowed set, `[!abc]` or `[^abc]` a
/// refused set, an unclosed `[` a literal bracket.
fn segment_matches(pattern: &[char], text: &[char]) -> bool {
    match pattern.split_first() {
        None => text.is_empty(),
        Some(('*', rest)) => (0..=text.len()).any(|skip| segment_matches(rest, &text[skip..])),
        Some(('?', rest)) => !text.is_empty() && segment_matches(rest, &text[1..]),
        Some(('[', rest)) => {
            let Some(close) = rest.iter().position(|ch| *ch == ']') else {
                return text.first() == Some(&'[') && segment_matches(rest, &text[1..]);
            };
            let body = &rest[..close];
            let (negated, members) = match body.first() {
                Some('!') | Some('^') => (true, &body[1..]),
                _ => (false, body),
            };
            let Some(first) = text.first() else {
                return false;
            };
            if negated == class_matches(members, *first) {
                return false;
            }
            segment_matches(&rest[close + 1..], &text[1..])
        }
        Some((literal, rest)) => text.first() == Some(literal) && segment_matches(rest, &text[1..]),
    }
}

fn split_segments(value: &str) -> Vec<&str> {
    value.split('/').collect()
}

/// A whole segment in brackets is a literal folder name (`[id]`, `[...slug]`,
/// `[[...slug]]`), the Next-style routes the upstream syntax keeps literal.
fn literal_bracket_segment(segment: &str) -> bool {
    segment.starts_with('[')
        && segment.ends_with(']')
        && !segment.chars().any(|ch| matches!(ch, '{' | '}' | ','))
}

fn segments_match(pattern: &[&str], text: &[&str]) -> bool {
    let Some((head, rest)) = pattern.split_first() else {
        return text.is_empty();
    };
    let segment = *head;
    if segment == "**" {
        // A trailing `**` needs at least one segment, which is what the
        // application's `a/**` pattern means; elsewhere it spans zero or more.
        if rest.is_empty() {
            return !text.is_empty();
        }
        return (0..=text.len()).any(|skip| segments_match(rest, &text[skip..]));
    }
    let Some((first, tail)) = text.split_first() else {
        return false;
    };
    let matched = if literal_bracket_segment(segment) {
        segment == *first
    } else {
        let pattern_chars: Vec<char> = segment.chars().collect();
        let text_chars: Vec<char> = first.chars().collect();
        segment_matches(&pattern_chars, &text_chars)
    };
    matched && segments_match(rest, tail)
}

/// The upstream glob subset: `**` any depth, `*` within a segment, `?` one
/// character, `{a,b}` alternation, a whole segment in brackets literal and
/// elsewhere `[abc]` / `[!abc]` a class. A pattern with no wildcard also claims
/// everything under that directory.
pub(crate) fn glob_matches(pattern: &str, path: &str) -> bool {
    let wildcard = has_wildcard(pattern);
    for alternative in expand_braces(pattern) {
        let segments = split_segments(&alternative);
        if segments_match(&segments, &split_segments(path)) {
            return true;
        }
        if !wildcard && path.starts_with(&format!("{alternative}/")) {
            return true;
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/// Floorplan ids may carry dots and start with a digit (`ahub.hub.tasks`), which
/// the shared identifier rule refuses; everything else matches it.
fn floorplan_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
}

fn insert_floorplan_id(ctx: &mut Context, ids: &mut HashSet<String>, id: &str, path: &str) {
    if !floorplan_id(id) {
        ctx.error(
            "id",
            path,
            format!("ID {id:?} is not a floorplan identifier"),
            "use letters, digits, dots, underscores or hyphens, for example ahub.hub.tasks",
        );
    }
    if !ids.insert(id.to_string()) {
        ctx.error(
            "duplicate-id",
            path,
            format!("ID {id:?} occurs more than once"),
            "give each node or flow its own ID, or remove the repeated entry",
        );
    }
}

/// Which files the map's nodes claim, under the assignment rule the format
/// documents: a node claims the files its `paths` match, minus its own
/// `exclude` and every ancestor's. A reference that resolves only through an
/// excluded path is dangling, so this stays as strict as the codec's owner
/// lookup.
struct Claims<'a> {
    nodes: &'a [FloorplanNode],
    by_id: std::collections::HashMap<&'a str, &'a FloorplanNode>,
}

impl<'a> Claims<'a> {
    fn new(spec: &'a FloorplanSpec) -> Self {
        let mut by_id = std::collections::HashMap::new();
        for node in &spec.nodes {
            by_id.entry(node.id.as_str()).or_insert(node);
        }
        Self {
            nodes: &spec.nodes,
            by_id,
        }
    }

    fn any(&self, path: &str) -> bool {
        self.nodes.iter().any(|node| self.claims(node, path))
    }

    fn claims(&self, node: &FloorplanNode, path: &str) -> bool {
        let matched = node
            .paths
            .as_deref()
            .unwrap_or_default()
            .iter()
            .any(|glob| glob_matches(glob, path));
        if !matched {
            return false;
        }
        let mut current = Some(node);
        let mut seen = HashSet::new();
        while let Some(owner) = current {
            if owner
                .exclude
                .as_deref()
                .unwrap_or_default()
                .iter()
                .any(|glob| glob_matches(glob, path))
            {
                return false;
            }
            current = owner.parent.as_deref().and_then(|id| {
                if !seen.insert(id) {
                    return None;
                }
                self.by_id.get(id).copied()
            });
        }
        true
    }
}

/// A reference resolves as a node id, or as a file some node claims.
fn resolves(reference: &str, node_ids: &HashSet<String>, claims: &Claims) -> bool {
    node_ids.contains(reference) || claims.any(reference)
}

fn check_reference(
    ctx: &mut Context,
    rule: &str,
    reference: &str,
    path: &str,
    node_ids: &HashSet<String>,
    claims: &Claims,
    action: &str,
) {
    if !resolves(reference, node_ids, claims) {
        ctx.error(
            rule,
            path,
            format!("reference {reference:?} names no node and no file a node claims"),
            format!("point {action} at an existing node id, or add the file to the paths of the node that owns it"),
        );
    }
}

fn check_parents(ctx: &mut Context, spec: &FloorplanSpec, node_ids: &HashSet<String>) {
    let mut parent_of: Vec<Option<&str>> = Vec::with_capacity(spec.nodes.len());
    for (index, node) in spec.nodes.iter().enumerate() {
        let path = format!("/nodes/{index}/parent");
        match node.parent.as_deref() {
            None => parent_of.push(None),
            Some(parent) => {
                if parent == node.id {
                    ctx.error(
                        "parent-cycle",
                        &path,
                        format!("node {:?} is its own parent", node.id),
                        "nest the node under a different node or remove parent",
                    );
                    parent_of.push(None);
                } else if !node_ids.contains(parent) {
                    ctx.error(
                        "parent-reference",
                        &path,
                        format!("parent {parent:?} is not a node in this map"),
                        "name an existing node id, or add the parent node first",
                    );
                    parent_of.push(None);
                } else {
                    parent_of.push(Some(parent));
                }
            }
        }
    }
    let by_id: std::collections::HashMap<&str, usize> = spec
        .nodes
        .iter()
        .enumerate()
        .map(|(index, node)| (node.id.as_str(), index))
        .collect();
    for (index, _) in spec.nodes.iter().enumerate() {
        let mut seen = HashSet::new();
        seen.insert(spec.nodes[index].id.as_str());
        let mut current = parent_of[index];
        while let Some(parent) = current {
            if !seen.insert(parent) {
                ctx.error(
                    "parent-cycle",
                    &format!("/nodes/{index}/parent"),
                    format!(
                        "the parent chain of {:?} returns to itself",
                        spec.nodes[index].id
                    ),
                    "break the cycle by re-parenting one node in the chain",
                );
                break;
            }
            current = by_id.get(parent).and_then(|up| parent_of[*up]);
        }
    }
}

fn validate_spec(spec: &FloorplanSpec, ctx: &mut Context) {
    ctx.text(&spec.project.name, 1, None, "/project/name");
    if let Some(summary) = &spec.project.summary {
        ctx.text(summary, 0, None, "/project/summary");
    }
    if let Some(audience) = &spec.audience {
        ctx.enum_value(audience, AUDIENCES, "/audience");
    }

    let mut node_ids = HashSet::new();
    ctx.cardinality(spec.nodes.len(), 1, "/nodes");
    for (index, node) in spec.nodes.iter().enumerate() {
        let path = format!("/nodes/{index}");
        insert_floorplan_id(ctx, &mut node_ids, &node.id, &format!("{path}/id"));
        ctx.text(&node.label, 1, None, &format!("{path}/label"));
        ctx.enum_value(&node.kind, NODE_KINDS, &format!("{path}/kind"));
        if let Some(summary) = &node.summary {
            ctx.text(summary, 0, None, &format!("{path}/summary"));
        }
        if let Some(details) = &node.details {
            ctx.text(details, 0, None, &format!("{path}/details"));
        }
    }
    check_parents(ctx, spec, &node_ids);
    let claims = Claims::new(spec);

    for (index, edge) in spec.edges.as_deref().unwrap_or_default().iter().enumerate() {
        let path = format!("/edges/{index}");
        for (field, end) in [("from", &edge.from), ("to", &edge.to)] {
            check_reference(
                ctx,
                "edge-endpoint",
                end,
                &format!("{path}/{field}"),
                &node_ids,
                &claims,
                "this edge endpoint",
            );
        }
        if let Some(kind) = &edge.kind {
            ctx.enum_value(kind, EDGE_KINDS, &format!("{path}/kind"));
        }
        if let Some(label) = &edge.label {
            ctx.text(label, 0, None, &format!("{path}/label"));
        }
        if let Some(description) = &edge.description {
            ctx.text(description, 0, None, &format!("{path}/description"));
        }
    }

    for (index, annotation) in spec
        .annotations
        .as_deref()
        .unwrap_or_default()
        .iter()
        .enumerate()
    {
        let path = format!("/annotations/{index}");
        ctx.text(&annotation.path, 1, None, &format!("{path}/path"));
        if let Some(note) = &annotation.note {
            ctx.text(note, 0, None, &format!("{path}/note"));
        }
    }

    let mut flow_ids = HashSet::new();
    for (index, flow) in spec.flows.as_deref().unwrap_or_default().iter().enumerate() {
        let path = format!("/flows/{index}");
        insert_floorplan_id(ctx, &mut flow_ids, &flow.id, &format!("{path}/id"));
        ctx.text(&flow.title, 1, None, &format!("{path}/title"));
        if let Some(description) = &flow.description {
            ctx.text(description, 0, None, &format!("{path}/description"));
        }
        if flow.steps.len() < 2 {
            ctx.error(
                "flow-steps",
                &format!("{path}/steps"),
                format!(
                    "flow {:?} has {} step(s); a tour through the map needs at least two",
                    flow.id,
                    flow.steps.len()
                ),
                "add the steps the flow walks through, in order",
            );
        }
        for (step_index, step) in flow.steps.iter().enumerate() {
            check_reference(
                ctx,
                "flow-step-node",
                &step.node,
                &format!("{path}/steps/{step_index}/node"),
                &node_ids,
                &claims,
                "this flow step",
            );
            if let Some(note) = &step.note {
                ctx.text(note, 0, None, &format!("{path}/steps/{step_index}/note"));
            }
        }
    }

    for (index, stop) in spec.tour.as_deref().unwrap_or_default().iter().enumerate() {
        let path = format!("/tour/{index}");
        check_reference(
            ctx,
            "tour-stop",
            &stop.node,
            &format!("{path}/node"),
            &node_ids,
            &claims,
            "this tour stop",
        );
        if let Some(title) = &stop.title {
            ctx.text(title, 0, None, &format!("{path}/title"));
        }
        if let Some(note) = &stop.note {
            ctx.text(note, 0, None, &format!("{path}/note"));
        }
    }
}

fn check_object_fields(value: &Value, ctx: &mut Context, rules: &[(&str, &[&str])]) {
    for (field, allowed) in rules {
        if let Some(items) = value.get(*field).and_then(Value::as_array) {
            for (index, item) in items.iter().enumerate() {
                if item.is_object() {
                    ctx.fields(item, &format!("/{field}/{index}"), allowed);
                }
            }
        } else if let Some(item) = value.get(*field).filter(|item| item.is_object()) {
            ctx.fields(item, &format!("/{field}"), allowed);
        }
    }
}

/// Validate one `floorplan/architecture@1` document against the E5 T1 rules.
pub(crate) fn validate(value: Value) -> Vec<Diagnostic> {
    let mut ctx = Context::new("floorplan");
    if !value.is_object() {
        ctx.error(
            "shape",
            "/",
            "a floorplan document must be a JSON object",
            "start from a document with $schema, project and nodes",
        );
        return ctx.finish();
    }
    ctx.fields(&value, "", TOP_FIELDS);
    match value.get("$schema").and_then(Value::as_str) {
        Some(id) if id == FLOORPLAN_SCHEMA_ID => {}
        Some(id) => ctx.error(
            "schema",
            "/$schema",
            format!("the document declares schema {id:?}, not {FLOORPLAN_SCHEMA_ID:?}"),
            format!("set \"$schema\" to \"{FLOORPLAN_SCHEMA_ID}\" or validate it as its own type"),
        ),
        None => ctx.error(
            "schema",
            "/$schema",
            "the document does not declare its schema",
            format!("add \"$schema\": \"{FLOORPLAN_SCHEMA_ID}\""),
        ),
    }
    if let Some(project) = value.get("project").filter(|item| item.is_object()) {
        ctx.fields(project, "/project", PROJECT_FIELDS);
    }
    check_object_fields(
        &value,
        &mut ctx,
        &[
            ("nodes", NODE_FIELDS),
            ("edges", EDGE_FIELDS),
            ("annotations", ANNOTATION_FIELDS),
            ("flows", FLOW_FIELDS),
            ("tour", TOUR_STOP_FIELDS),
        ],
    );
    if let Some(flows) = value.get("flows").and_then(Value::as_array) {
        for (index, flow) in flows.iter().enumerate() {
            if let Some(steps) = flow.get("steps").and_then(Value::as_array) {
                for (step_index, step) in steps.iter().enumerate() {
                    if step.is_object() {
                        ctx.fields(
                            step,
                            &format!("/flows/{index}/steps/{step_index}"),
                            FLOW_STEP_FIELDS,
                        );
                    }
                }
            }
        }
    }
    let Some(spec) = common::decode::<FloorplanSpec>(&value, &mut ctx) else {
        return ctx.finish();
    };
    validate_spec(&spec, &mut ctx);
    ctx.finish()
}

#[cfg(feature = "typegen")]
pub fn declarations(cfg: &ts_rs::Config) -> Vec<String> {
    use ts_rs::TS;
    vec![
        FloorplanSpec::decl(cfg),
        FloorplanProject::decl(cfg),
        FloorplanNode::decl(cfg),
        FloorplanEdge::decl(cfg),
        FloorplanAnnotation::decl(cfg),
        FloorplanFlow::decl(cfg),
        FloorplanFlowStep::decl(cfg),
        FloorplanTourStop::decl(cfg),
    ]
}

#[cfg(test)]
mod tests {
    use super::{glob_matches, validate};
    use serde_json::{json, Value};

    /// Synthetic only: the application fixture is a published map whose source
    /// repository is private, so its provenance cannot be recorded here.
    fn nested_map() -> Value {
        json!({
            "$schema": "floorplan/architecture@1",
            "audience": "developers",
            "project": {
                "name": "Synthetic E5 map",
                "summary": "Two containers and one external service.",
                "entrypoints": ["app/src/main.ts"]
            },
            "include": ["app/**"],
            "ignore": ["app/vendor/**"],
            "nodes": [
                {
                    "id": "app",
                    "label": "Application",
                    "kind": "service",
                    "paths": ["app/**"]
                },
                {
                    "id": "app.ui",
                    "parent": "app",
                    "label": "Interface",
                    "kind": "ui",
                    "paths": ["app/src/{views,components}/**"]
                },
                {
                    "id": "app.api",
                    "parent": "app",
                    "label": "API",
                    "kind": "library",
                    "paths": ["app/src/api/**"],
                    "exclude": ["app/src/api/legacy/**"]
                },
                {
                    "id": "db",
                    "label": "Database",
                    "kind": "data",
                    "hosts": ["db.internal"]
                }
            ],
            "edges": [
                {"from": "app.ui", "to": "app.api", "kind": "import", "label": "calls"},
                {"from": "app.api", "to": "db", "kind": "data", "description": "queries"}
            ],
            "annotations": [
                {"path": "app/src/main.ts", "note": "entrypoint", "tags": ["boot"]}
            ],
            "flows": [
                {
                    "id": "request",
                    "title": "One request",
                    "steps": [
                        {"node": "app.ui", "note": "the reader acts"},
                        {"node": "app.api"},
                        {"node": "db"}
                    ]
                }
            ],
            "tour": [
                {"node": "app", "title": "Coordination", "note": "start here"}
            ]
        })
    }

    fn codes(diagnostics: &[crate::Diagnostic]) -> Vec<&str> {
        diagnostics.iter().map(|item| item.code.as_str()).collect()
    }

    #[test]
    fn accepts_a_nested_synthetic_map_with_every_documented_collection() {
        let diagnostics = validate(nested_map());
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
    }

    #[test]
    fn every_rejection_names_a_cause_and_a_next_step() {
        let mut spec = nested_map();
        spec["nodes"][1]["kind"] = json!("widget");
        spec["edges"][0]["to"] = json!("absent.node");
        spec["flows"][0]["steps"] = json!([{"node": "app.ui"}]);
        let diagnostics = validate(spec);
        assert!(!diagnostics.is_empty());
        let listed = codes(&diagnostics);
        assert!(listed.contains(&"floorplan/enum"), "{listed:?}");
        assert!(listed.contains(&"floorplan/edge-endpoint"), "{listed:?}");
        assert!(listed.contains(&"floorplan/flow-steps"), "{listed:?}");
        assert!(
            diagnostics
                .iter()
                .all(|item| !item.message.is_empty() && !item.fix.is_empty()),
            "a diagnostic has no cause or next step: {diagnostics:?}"
        );
    }

    #[test]
    fn rejects_a_document_that_declares_another_schema() {
        let mut spec = nested_map();
        spec["$schema"] = json!("floorplan/architecture@2");
        assert_eq!(codes(&validate(spec)), vec!["floorplan/schema"]);
    }

    #[test]
    fn rejects_unknown_fields_at_every_object_level() {
        let mut spec = nested_map();
        spec["layout"] = json!({"cols": 3});
        spec["nodes"][0]["icon"] = json!("cube");
        spec["edges"][0]["weight"] = json!(2);
        spec["flows"][0]["steps"][0]["highlight"] = json!(true);
        spec["tour"][0]["duration"] = json!(3);
        let diagnostics = validate(spec);
        let listed = codes(&diagnostics);
        assert_eq!(
            listed
                .iter()
                .filter(|code| **code == "floorplan/unknown-field")
                .count(),
            5,
            "{listed:?}"
        );
    }

    #[test]
    fn rejects_ids_outside_the_floorplan_character_set_and_duplicates() {
        let mut spec = nested_map();
        spec["nodes"][0]["id"] = json!("app team");
        spec["nodes"][3]["id"] = json!("app.ui");
        let diagnostics = validate(spec);
        let listed = codes(&diagnostics);
        assert!(listed.contains(&"floorplan/id"), "{listed:?}");
        assert!(listed.contains(&"floorplan/duplicate-id"), "{listed:?}");
    }

    #[test]
    fn rejects_a_parent_that_is_absent_or_part_of_a_cycle() {
        let mut spec = nested_map();
        spec["nodes"][1]["parent"] = json!("absent");
        let diagnostics = validate(spec);
        let listed = codes(&diagnostics);
        assert!(listed.contains(&"floorplan/parent-reference"), "{listed:?}");

        let mut cyclic = nested_map();
        cyclic["nodes"][0]["parent"] = json!("app.api");
        let diagnostics = validate(cyclic);
        let listed = codes(&diagnostics);
        assert!(listed.contains(&"floorplan/parent-cycle"), "{listed:?}");
    }

    #[test]
    fn an_endpoint_may_name_a_file_a_node_claims() {
        let mut spec = nested_map();
        spec["edges"][0]["from"] = json!("app/src/views/home.ts");
        assert!(validate(spec).is_empty(), "a claimed file did not resolve");

        let mut dangling = nested_map();
        dangling["edges"][0]["from"] = json!("scripts/seed.ts");
        assert_eq!(codes(&validate(dangling)), vec!["floorplan/edge-endpoint"]);

        // A node's `exclude` removes the file from its own claim, and a
        // descendant inherits it, so app.ui's `paths` no longer reach the file.
        let mut excluded = nested_map();
        excluded["nodes"][0]["exclude"] = json!(["app/src/views/**"]);
        excluded["edges"][1]["to"] = json!("app/src/views/home.ts");
        assert_eq!(codes(&validate(excluded)), vec!["floorplan/edge-endpoint"]);

        let mut stop = nested_map();
        stop["tour"][0]["node"] = json!("absent.node");
        assert_eq!(codes(&validate(stop)), vec!["floorplan/tour-stop"]);

        let mut step = nested_map();
        step["flows"][0]["steps"][1]["node"] = json!("absent.node");
        assert_eq!(codes(&validate(step)), vec!["floorplan/flow-step-node"]);
    }

    #[test]
    fn requires_a_project_name_and_an_audience_the_schema_documents() {
        let mut spec = nested_map();
        spec["project"]["name"] = json!("");
        spec["audience"] = json!("everybody");
        let diagnostics = validate(spec);
        let listed = codes(&diagnostics);
        assert!(listed.contains(&"floorplan/text"), "{listed:?}");
        assert!(listed.contains(&"floorplan/enum"), "{listed:?}");
    }

    #[test]
    fn matches_the_upstream_glob_subset() {
        let cases: &[(&str, &str, bool)] = &[
            ("app/**", "app/src/main.ts", true),
            ("app/**", "app", false),
            ("app/**/main.ts", "app/main.ts", true),
            ("app/**/main.ts", "app/src/a/main.ts", true),
            ("**/main.ts", "main.ts", true),
            ("**/main.ts", "app/src/main.ts", true),
            ("app/*.ts", "app/main.ts", true),
            ("app/*.ts", "app/src/main.ts", false),
            ("app/?.ts", "app/a.ts", true),
            ("app/?.ts", "app/ab.ts", false),
            (
                "app/src/{views,components}/**",
                "app/src/views/home.ts",
                true,
            ),
            (
                "app/src/{views,components}/**",
                "app/src/components/list/item.ts",
                true,
            ),
            (
                "app/src/{views,components}/**",
                "app/src/api/client.ts",
                false,
            ),
            ("app/src/{a*,b?}/**", "app/src/api/x.ts", true),
            ("app/[abc].ts", "app/a.ts", true),
            ("app/[abc].ts", "app/d.ts", false),
            ("app/[!abc].ts", "app/d.ts", true),
            ("app/[!abc].ts", "app/a.ts", false),
            // A whole bracketed segment is a literal folder name, not a class.
            ("app/[id]/**", "app/[id]/page.ts", true),
            ("app/[id]/**", "app/a/page.ts", false),
            ("app/src", "app/src", true),
            ("app/src", "app/src/main.ts", true),
            ("app/src", "app/src2/main.ts", false),
        ];
        for (pattern, path, expected) in cases {
            assert_eq!(
                glob_matches(pattern, path),
                *expected,
                "pattern {pattern:?} against {path:?}"
            );
        }
    }
}
