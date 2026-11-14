//! Independent E5 document validity for `floorplan/architecture@1`.
//!
//! The document is the upstream interchange JSON, validated as authored: no
//! layout, no renderer and no Floorplan code, which the spec allows as a
//! reference only. The rules are the floor the application already applies
//! (`src/lib/diagram/floorplan.ts` in maru), and no stricter: an optional field
//! may be omitted, an empty node list is a map with nothing on it yet, flow ids
//! are any non-empty string, a field the format does not define is preserved
//! rather than refused (the codec carries it verbatim as a fidelity note), a
//! present `null` is refused because the field was given rather than left out,
//! except in the four prose fields the codec never reads (`flow.description`,
//! `steps[].note`, `tour[].title`, `tour[].note`), and an empty reference is
//! refused before any glob is asked instead of resolving through a `*` claim.
//! Layout is E5 T2, the repository scanner T3 and the apply-gate switch T4.
//!
//! An edge endpoint, flow step or tour stop names a node id, or a file that some
//! node's `paths` claim, which is why the upstream glob subset is matched here.
//! A pattern is compiled to a small program and walked one character at a time,
//! so an alternation is never expanded and no split point is retried: neither a
//! `{a,b}` chain nor a `*`-heavy pattern can grow past the pattern and path
//! lengths. Braces are paired in one pass first, so a `{` that never closes, or
//! one nested past `MAX_BRACE_DEPTH`, is a literal brace and no suffix of the
//! pattern is read twice. It is written by hand because the crate carries no
//! regex dependency and the WASM build is measured per chunk.

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

/// Deepest nesting a map may declare. The layout walks one level per call, so
/// an acyclic chain past this would overflow the stack, and validation bounds
/// each ancestor walk by it so a long chain costs linear time, not quadratic.
/// Real maps nest a handful of levels.
pub(crate) const MAX_NESTING_DEPTH: usize = 64;

/// Most nodes one map may hold. AC6 sizes the format at 1,000 nodes; four times
/// that leaves room for a large monorepo map while keeping a hostile document
/// from making validation and layout allocate without bound.
pub const MAX_NODES: usize = 4_096;

/// Most edges one map may hold: two per node at the node cap, which is denser
/// than any published map, and each edge is one route request at layout.
pub const MAX_EDGES: usize = 8_192;

// The fields the format types when they are present. Each of them may also be
// left out, so the rule they need is that an explicit `null` is refused: serde
// reads it as the same absent value, while the codec's `value !== undefined`
// checks refuse it.
const SPEC_TYPED: &[&str] = &[
    "$schema",
    "edges",
    "annotations",
    "flows",
    "tour",
    "audience",
    "include",
    "ignore",
];
const PROJECT_TYPED: &[&str] = &["summary", "entrypoints"];
const NODE_TYPED: &[&str] = &[
    "parent", "summary", "details", "paths", "exclude", "packages", "hosts", "tags",
];
const EDGE_TYPED: &[&str] = &["kind", "label", "description"];
const ANNOTATION_TYPED: &[&str] = &["note", "tags"];

/// The prose the codec never reads: `flow.description`, `steps[].note`,
/// `tour[].title` and `tour[].note` are absent from its checks, so a value it
/// would accept cannot be refused here. The string is kept when the document
/// gives one and dropped otherwise, which leaves the model typed.
fn unchecked_prose<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Option::<Value>::deserialize(deserializer)?
        .and_then(|value| value.as_str().map(str::to_string)))
}

/// One `floorplan/architecture@1` document. Optional collections stay optional
/// so a map without edges, flows, annotations or a tour validates.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
pub struct FloorplanSpec {
    // The codec accepts a document without it and refuses only another value.
    #[serde(rename = "$schema", default)]
    #[cfg_attr(feature = "typegen", ts(rename = "$schema", optional = nullable))]
    pub schema: Option<String>,
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
    #[serde(default, deserialize_with = "unchecked_prose")]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub description: Option<String>,
    pub steps: Vec<FloorplanFlowStep>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
pub struct FloorplanFlowStep {
    pub node: String,
    #[serde(default, deserialize_with = "unchecked_prose")]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
pub struct FloorplanTourStop {
    pub node: String,
    #[serde(default, deserialize_with = "unchecked_prose")]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub title: Option<String>,
    #[serde(default, deserialize_with = "unchecked_prose")]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub note: Option<String>,
}

// ---------------------------------------------------------------------------
// The upstream glob subset
// ---------------------------------------------------------------------------

/// Whether a pattern carries glob syntax, which decides whether a value it
/// matches exactly also claims everything under it. A whole segment in brackets
/// (`[id]`, `[...slug]`, `[[...slug]]`) is a literal folder name here, as the
/// application's matcher treats it; any other `[` counts.
fn has_wildcard(pattern: &str) -> bool {
    pattern.split('/').any(|segment| {
        if segment.len() >= 2 && segment.starts_with('[') && segment.ends_with(']') {
            return false;
        }
        segment
            .chars()
            .any(|ch| matches!(ch, '*' | '?' | '{' | '['))
    })
}

/// One token of a compiled pattern. Alternation arms are indices into the
/// pattern's arm list, so `{a,b}` is matched through the program rather than by
/// expanding the cartesian product of its alternatives.
#[derive(Debug, Clone)]
enum Piece {
    /// A literal character, including `/`.
    Literal(char),
    /// `*`: any run inside one segment.
    Star,
    /// `**`: any run, across segments.
    Glob,
    /// `**/`: an optional run ending at a segment boundary.
    GlobSlash,
    /// `?`: exactly one character inside the segment.
    Any,
    /// `[abc]` or `[!abc]`: exactly one listed character.
    Class { negated: bool, body: Vec<char> },
    /// `{a,b}`: one of the arms.
    Alt(Vec<usize>),
    /// The `(?:/.*)?` that a wildcard-free pattern also claims.
    DirectoryTail,
}

/// A pattern parsed into arms: arm 0 is the pattern itself, the rest are
/// `{a,b}` alternatives.
struct Compiled {
    arms: Vec<Vec<Piece>>,
    /// A class the application's `RegExp` constructor refuses (a descending
    /// range such as `[z-a]`). There `floorplanGlobMatches` matches nothing, so
    /// the whole pattern matches nothing here too.
    invalid: bool,
}

/// How deep alternations may nest before a `{` is read literally. A map never
/// nests two, and the cap keeps a hostile pattern off the stack.
const MAX_BRACE_DEPTH: usize = 32;

/// For each position, the index of the first `]` at or after it. Built in one
/// backward pass, so finding a class closer is a lookup: an unmatched `[` run
/// would otherwise rescan the rest of the pattern once per `[`.
fn class_closers(chars: &[char]) -> Vec<Option<usize>> {
    let mut closers = vec![None; chars.len() + 1];
    for at in (0..chars.len()).rev() {
        closers[at] = if chars[at] == ']' {
            Some(at)
        } else {
            closers[at + 1]
        };
    }
    closers
}

/// The closer of a class opened at `open`: the first `]` from `open + 2`, as
/// `pattern.indexOf("]", i + 2)` finds it in the application.
fn class_close(closers: &[Option<usize>], open: usize) -> Option<usize> {
    closers.get(open + 2).copied().flatten()
}

/// Pair every `{` with its `}` in one pass, so the parser never has to search
/// for a closer and never re-reads a suffix. Character classes and literal
/// bracketed segments are skipped exactly as the parser reads them, which is
/// what keeps a `}` inside `[}]` from closing an alternation.
fn brace_pairs(chars: &[char], closers: &[Option<usize>]) -> Vec<Option<usize>> {
    let mut pairs = vec![None; chars.len()];
    let mut open = Vec::new();
    let mut at = 0usize;
    while at < chars.len() {
        let segment_start = at == 0 || chars[at - 1] == '/';
        if chars[at] == '[' {
            if segment_start {
                let end = chars[at..]
                    .iter()
                    .position(|item| *item == '/')
                    .unwrap_or(chars.len() - at);
                let segment = &chars[at..at + end];
                if segment.last() == Some(&']')
                    && !segment.iter().any(|item| matches!(item, '{' | '}' | ','))
                {
                    at += end;
                    continue;
                }
            }
            match class_close(closers, at) {
                Some(close) => at = close + 1,
                None => at += 1,
            }
            continue;
        }
        match chars[at] {
            '{' => open.push(at),
            '}' => {
                if let Some(start) = open.pop() {
                    pairs[start] = Some(at);
                }
            }
            _ => {}
        }
        at += 1;
    }
    pairs
}

impl Compiled {
    fn new(pattern: &str) -> Self {
        let chars: Vec<char> = pattern.chars().collect();
        let closers = class_closers(&chars);
        let pairs = brace_pairs(&chars, &closers);
        let tables = Tables {
            pairs: &pairs,
            closers: &closers,
        };
        let mut arms: Vec<Vec<Piece>> = vec![Vec::new()];
        let mut at = 0usize;
        let mut top = parse_sequence(&chars, &tables, &mut at, &mut arms, false, 0);
        if !has_wildcard(pattern) {
            top.push(Piece::DirectoryTail);
        }
        arms[0] = top;
        let invalid = arms.iter().flatten().any(
            |piece| matches!(piece, Piece::Class { body, .. } if class_has_descending_range(body)),
        );
        Self { arms, invalid }
    }
}

/// The one-pass lookups the parser reads instead of scanning the suffix.
struct Tables<'a> {
    pairs: &'a [Option<usize>],
    closers: &'a [Option<usize>],
}

/// Parse one piece sequence. Inside an alternation it stops at `,` or `}`.
fn parse_sequence(
    chars: &[char],
    tables: &Tables<'_>,
    at: &mut usize,
    arms: &mut Vec<Vec<Piece>>,
    in_brace: bool,
    depth: usize,
) -> Vec<Piece> {
    let mut pieces = Vec::new();
    while *at < chars.len() {
        let ch = chars[*at];
        if in_brace && matches!(ch, ',' | '}') {
            break;
        }
        let segment_start = *at == 0 || chars[*at - 1] == '/';
        // A whole segment in brackets is a literal folder name, so it is copied
        // character by character instead of becoming a class.
        if ch == '[' && segment_start {
            let rest = &chars[*at..];
            let end = rest
                .iter()
                .position(|item| *item == '/')
                .unwrap_or(rest.len());
            let segment = &rest[..end];
            if segment.last() == Some(&']')
                && !segment.iter().any(|item| matches!(item, '{' | '}' | ','))
            {
                pieces.extend(segment.iter().map(|item| Piece::Literal(*item)));
                *at += end;
                continue;
            }
        }
        match ch {
            '*' if chars.get(*at + 1) == Some(&'*') => {
                if chars.get(*at + 2) == Some(&'/') {
                    pieces.push(Piece::GlobSlash);
                    *at += 3;
                } else {
                    pieces.push(Piece::Glob);
                    *at += 2;
                }
            }
            '*' => {
                pieces.push(Piece::Star);
                *at += 1;
            }
            '?' => {
                pieces.push(Piece::Any);
                *at += 1;
            }
            '{' => {
                // The closer comes from the one-pass pairing, so a brace is
                // either an alternation or a literal and the suffix is never
                // read twice.
                match tables.pairs[*at] {
                    // Past the cap the whole span is copied literally, so an
                    // over-nested pattern reads as text without moving the rest
                    // of the parse.
                    Some(close) if depth >= MAX_BRACE_DEPTH => {
                        pieces.extend(chars[*at..=close].iter().map(|item| Piece::Literal(*item)));
                        *at = close + 1;
                    }
                    Some(close) => {
                        let arms_before = arms.len();
                        *at += 1;
                        // Every arm is parsed, including an empty last one after a
                        // trailing `,`: `{a,}` is `(?:a|)` in the application.
                        let mut branches = Vec::new();
                        loop {
                            branches.push(parse_sequence(chars, tables, at, arms, true, depth + 1));
                            if *at < close && chars.get(*at) == Some(&',') {
                                *at += 1;
                                continue;
                            }
                            break;
                        }
                        if chars.get(*at) == Some(&'}') {
                            *at += 1;
                            let ids = branches
                                .into_iter()
                                .map(|branch| {
                                    arms.push(branch);
                                    arms.len() - 1
                                })
                                .collect();
                            pieces.push(Piece::Alt(ids));
                        } else {
                            // Unreachable while the pairing and the parser read
                            // classes alike; kept as a literal instead of a
                            // retry so no path re-reads the pattern.
                            arms.truncate(arms_before);
                            pieces.push(Piece::Literal('{'));
                        }
                    }
                    // A `{` with no closer in the pattern is a literal brace,
                    // which is how the application reads one.
                    _ => {
                        pieces.push(Piece::Literal('{'));
                        *at += 1;
                    }
                }
            }
            '[' => {
                // A class runs to the next `]`; an unclosed `[` is literal.
                let close = class_close(tables.closers, *at);
                match close {
                    None => {
                        pieces.push(Piece::Literal('['));
                        *at += 1;
                    }
                    Some(close) => {
                        let mut body = chars[*at + 1..close].to_vec();
                        let negated = matches!(body.first(), Some('!') | Some('^'));
                        if negated {
                            body.remove(0);
                        }
                        pieces.push(Piece::Class { negated, body });
                        *at = close + 1;
                    }
                }
            }
            other => {
                pieces.push(Piece::Literal(other));
                *at += 1;
            }
        }
    }
    pieces
}

/// Whether a class body holds a range whose end precedes its start, which the
/// application's `RegExp` constructor refuses. The ranges are read exactly as
/// [`class_matches`] reads them.
fn class_has_descending_range(body: &[char]) -> bool {
    let mut at = 0;
    while at < body.len() {
        if at + 2 < body.len() && body[at + 1] == '-' {
            if body[at] > body[at + 2] {
                return true;
            }
            at += 3;
            continue;
        }
        at += 1;
    }
    false
}

/// Whether one character is listed by a class body: a range (`a-z`) or any
/// character taken literally, which is how the application's class reads it.
fn class_matches(body: &[char], ch: char) -> bool {
    let mut at = 0;
    while at < body.len() {
        let first = body[at];
        if at + 2 < body.len() && body[at + 1] == '-' {
            if first <= ch && ch <= body[at + 2] {
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

/// One instruction of a compiled pattern. Alternation and repetition become
/// splits and jumps, so a pattern is matched in one pass over the path instead
/// of by recursing over every split point.
#[derive(Debug, Clone, Copy)]
enum Inst {
    Literal(char),
    NotSlash,
    AnyChar,
    Class { negated: bool, body: usize },
    Split(usize, usize),
    Jump(usize),
    Match,
}

struct Program {
    insts: Vec<Inst>,
    bodies: Vec<Vec<char>>,
}

impl Program {
    fn compile(compiled: &Compiled) -> Self {
        let mut program = Self {
            insts: Vec::new(),
            bodies: Vec::new(),
        };
        // A pattern the application cannot compile matches nothing: a program
        // with no `Match` instruction never accepts.
        if compiled.invalid {
            return program;
        }
        emit_arm(&compiled.arms, 0, &mut program.insts, &mut program.bodies);
        program.insts.push(Inst::Match);
        program
    }
}

/// Emit `body*`: a split around one repeated instruction. `body` is `[^/]` for
/// `*` and any character for `**`.
fn emit_repeat(insts: &mut Vec<Inst>, body: Inst) {
    let split = insts.len();
    insts.push(Inst::Split(0, 0));
    let repeated = insts.len();
    insts.push(body);
    insts.push(Inst::Jump(split));
    let after = insts.len();
    insts[split] = Inst::Split(repeated, after);
}

fn emit_arm(arms: &[Vec<Piece>], arm: usize, insts: &mut Vec<Inst>, bodies: &mut Vec<Vec<char>>) {
    for piece in arms[arm].clone() {
        match piece {
            Piece::Literal(ch) => insts.push(Inst::Literal(ch)),
            Piece::Any => insts.push(Inst::NotSlash),
            Piece::Class { negated, body } => {
                bodies.push(body);
                insts.push(Inst::Class {
                    negated,
                    body: bodies.len() - 1,
                });
            }
            Piece::Star => emit_repeat(insts, Inst::NotSlash),
            Piece::Glob => emit_repeat(insts, Inst::AnyChar),
            // `(?:.*/)?`: skip, or consume a run that ends at a `/`.
            Piece::GlobSlash => {
                let split = insts.len();
                insts.push(Inst::Split(0, 0));
                let run = insts.len();
                insts.push(Inst::Split(0, 0));
                let more = insts.len();
                insts.push(Inst::AnyChar);
                insts.push(Inst::Jump(run));
                let slash = insts.len();
                insts.push(Inst::Literal('/'));
                let after = insts.len() + 1;
                insts.push(Inst::Jump(after));
                insts[split] = Inst::Split(after, run);
                insts[run] = Inst::Split(slash, more);
            }
            // `(?:/.*)?` for the directory a wildcard-free pattern names.
            Piece::DirectoryTail => {
                let split = insts.len();
                insts.push(Inst::Split(0, 0));
                let slash = insts.len();
                insts.push(Inst::Literal('/'));
                let run = insts.len();
                insts.push(Inst::Split(0, 0));
                let more = insts.len();
                insts.push(Inst::AnyChar);
                insts.push(Inst::Jump(run));
                let after = insts.len();
                insts[split] = Inst::Split(after, slash);
                insts[run] = Inst::Split(after, more);
            }
            Piece::Alt(ids) => {
                if ids.len() == 1 {
                    emit_arm(arms, ids[0], insts, bodies);
                    continue;
                }
                let mut jumps = Vec::new();
                for (position, id) in ids.iter().enumerate() {
                    if position + 1 == ids.len() {
                        emit_arm(arms, *id, insts, bodies);
                        continue;
                    }
                    let split = insts.len();
                    insts.push(Inst::Split(0, 0));
                    let branch = insts.len();
                    emit_arm(arms, *id, insts, bodies);
                    jumps.push(insts.len());
                    insts.push(Inst::Jump(0));
                    let next = insts.len();
                    insts[split] = Inst::Split(branch, next);
                }
                let after = insts.len();
                for jump in jumps {
                    insts[jump] = Inst::Jump(after);
                }
            }
        }
    }
}

impl Inst {
    fn consumes(self, ch: char, bodies: &[Vec<char>]) -> bool {
        match self {
            Inst::Literal(expected) => expected == ch,
            Inst::NotSlash => ch != '/',
            Inst::AnyChar => true,
            Inst::Class { negated, body } => class_matches(&bodies[body], ch) != negated,
            Inst::Split(..) | Inst::Jump(..) | Inst::Match => false,
        }
    }
}

/// Walk the program one character at a time, carrying the set of reachable
/// instructions. The state count is the program size, so a path costs one pass
/// of that many steps however many wildcards and alternatives the pattern holds.
fn program_matches(program: &Program, text: &[char]) -> bool {
    let count = program.insts.len();
    // An invalid pattern compiles to no instructions and matches nothing.
    if count == 0 {
        return false;
    }
    // Sparse state sets: each step touches only the live states, and the
    // generation stamp clears a set without walking every instruction, so a
    // long literal pattern costs one pass, not pattern length times path length.
    let mut seen = vec![0u32; count];
    let mut generation = 1u32;
    let mut active = Vec::new();
    close(program, &[0], &mut seen, generation, &mut active);
    for ch in text {
        let seeds: Vec<usize> = active
            .iter()
            .filter(|pc| program.insts[**pc].consumes(*ch, &program.bodies))
            .map(|pc| pc + 1)
            .collect();
        if seeds.is_empty() {
            return false;
        }
        generation += 1;
        close(program, &seeds, &mut seen, generation, &mut active);
    }
    active.contains(&(count - 1))
}

/// Collect every instruction reachable from `seeds` without consuming a
/// character into `active`, marking each with `generation` in `seen`.
fn close(
    program: &Program,
    seeds: &[usize],
    seen: &mut [u32],
    generation: u32,
    active: &mut Vec<usize>,
) {
    active.clear();
    let mut pending: Vec<usize> = seeds.to_vec();
    while let Some(pc) = pending.pop() {
        if seen[pc] == generation {
            continue;
        }
        seen[pc] = generation;
        active.push(pc);
        match program.insts[pc] {
            Inst::Split(left, right) => {
                pending.push(left);
                pending.push(right);
            }
            Inst::Jump(target) => pending.push(target),
            _ => {}
        }
    }
}

/// The upstream glob subset: `**` any depth (also inside a segment), `*` within
/// a segment, `?` one character, `{a,b}` alternation, a whole segment in
/// brackets literal and elsewhere `[abc]` / `[!abc]` a class. A pattern with no
/// wildcard also claims everything under that directory. The document path goes
/// through [`Claims`], which compiles each `paths` and `exclude` glob once.
#[cfg(test)]
pub(crate) fn glob_matches(pattern: &str, path: &str) -> bool {
    let compiled = Compiled::new(pattern);
    let program = Program::compile(&compiled);
    let text: Vec<char> = path.chars().collect();
    program_matches(&program, &text)
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
    // Each `paths` and `exclude` glob is compiled once, so a map with many
    // references does not recompile the same pattern for every one of them.
    // Compiling is one linear parse per pattern and matching one pass over it,
    // so building this costs the map's glob text even when no edge, flow or tour
    // ends up asking: a bounded parse, not a search.
    programs: std::collections::HashMap<&'a str, Program>,
}

impl<'a> Claims<'a> {
    fn new(spec: &'a FloorplanSpec) -> Self {
        let mut by_id = std::collections::HashMap::new();
        let mut programs = std::collections::HashMap::new();
        for node in &spec.nodes {
            by_id.entry(node.id.as_str()).or_insert(node);
            for glob in node
                .paths
                .as_deref()
                .unwrap_or_default()
                .iter()
                .chain(node.exclude.as_deref().unwrap_or_default())
            {
                programs
                    .entry(glob.as_str())
                    .or_insert_with(|| Program::compile(&Compiled::new(glob)));
            }
        }
        Self {
            nodes: &spec.nodes,
            by_id,
            programs,
        }
    }

    fn matches(&self, glob: &str, path: &str) -> bool {
        match self.programs.get(glob) {
            Some(program) => program_matches(program, &path.chars().collect::<Vec<_>>()),
            None => false,
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
            .any(|glob| self.matches(glob, path));
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
                .any(|glob| self.matches(glob, path))
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

/// Chars of `glob` before its first wildcard: the upstream tie-break between two
/// nodes that claim a file at the same depth.
///
/// Counted in UTF-16 code units, the way `literalPrefixLength` counts them in
/// `src/lib/diagram/floorplan.ts` (`search` and `length` on a JavaScript string):
/// a byte offset would let a non-ASCII prefix win a tie the canvas gives away, so
/// the same edge would attach to different nodes there and here.
#[cfg(feature = "geometry")]
fn literal_prefix_length(glob: &str) -> usize {
    let at = glob.find(['*', '?', '{']).unwrap_or(glob.len());
    glob[..at].encode_utf16().count()
}

/// Which node a reference is drawn on.
///
/// A reference is a node id first. Otherwise it is a file path, and the node that
/// owns it is the upstream assignment rule's: among the nodes whose `paths` claim
/// it and whose own or inherited `exclude` does not, the deepest wins and the
/// longer literal glob prefix breaks a tie, with document order keeping the
/// rest. The canvas draws the same edge onto the same node (`floorplanOwner` in
/// `src/lib/diagram/floorplan.ts`), so a map cannot be drawn on two nodes at
/// once.
#[cfg(feature = "geometry")]
pub(crate) struct Resolver<'a> {
    spec: &'a FloorplanSpec,
    claims: Claims<'a>,
}

#[cfg(feature = "geometry")]
impl<'a> Resolver<'a> {
    pub(crate) fn new(spec: &'a FloorplanSpec) -> Self {
        Self {
            spec,
            claims: Claims::new(spec),
        }
    }

    /// How many parents a node has above it; a top-level node is 0.
    fn depth(&self, node: &FloorplanNode) -> usize {
        let mut depth = 0;
        let mut seen = HashSet::new();
        let mut current = node.parent.as_deref();
        while let Some(id) = current {
            if !seen.insert(id) {
                break;
            }
            let Some(parent) = self.claims.by_id.get(id) else {
                break;
            };
            depth += 1;
            current = parent.parent.as_deref();
        }
        depth
    }

    fn owner(&self, path: &str) -> Option<&'a str> {
        let mut best: Option<(&'a str, usize, usize)> = None;
        for node in &self.spec.nodes {
            if node.paths.as_deref().unwrap_or_default().is_empty()
                || !self.claims.claims(node, path)
            {
                continue;
            }
            let prefix = node
                .paths
                .as_deref()
                .unwrap_or_default()
                .iter()
                .filter(|glob| self.claims.matches(glob, path))
                .map(|glob| literal_prefix_length(glob))
                .max()
                .unwrap_or(0);
            let depth = self.depth(node);
            let better = match best {
                None => true,
                Some((_, best_depth, best_prefix)) => {
                    depth > best_depth || (depth == best_depth && prefix > best_prefix)
                }
            };
            if better {
                best = Some((node.id.as_str(), depth, prefix));
            }
        }
        best.map(|(id, _, _)| id)
    }

    /// The node id this reference draws on, or `None` when it names no node and
    /// no file a node claims.
    pub(crate) fn resolve(&self, reference: &str) -> Option<&'a str> {
        match self.claims.by_id.get(reference) {
            Some(node) => Some(node.id.as_str()),
            None => self.owner(reference),
        }
    }
}

/// Whether a JSON value is a Floorplan interchange document rather than one of
/// the five `diagram_type` envelopes. The upstream `$schema` is optional (the
/// codec accepts a document without it), so the shape decides as well.
pub fn is_document(value: &Value) -> bool {
    if let Some(schema) = value.get("$schema").and_then(Value::as_str) {
        return schema == FLOORPLAN_SCHEMA_ID;
    }
    value.get("diagram_type").is_none()
        && value.get("project").is_some_and(Value::is_object)
        && value.get("nodes").is_some_and(Value::is_array)
}

/// The semantic projection the SVG writer paints a Floorplan map from: every
/// member's own kind, so its box and its legend swatch take the same token. The
/// family has no frame variants, activations, lifecycle overrides or route
/// labels, so those maps stay empty.
#[cfg(feature = "geometry")]
pub fn semantic_context(spec: &FloorplanSpec) -> crate::semantics::SemanticContext {
    use std::collections::BTreeMap;
    crate::semantics::SemanticContext {
        family: "floorplan".into(),
        schema_version: 1,
        nodes: spec
            .nodes
            .iter()
            .map(|node| {
                (
                    node.id.clone(),
                    crate::semantics::NodeSemantic {
                        kind: node.kind.clone(),
                        lane: None,
                    },
                )
            })
            .collect::<BTreeMap<_, _>>(),
        frame_variants: BTreeMap::new(),
        activations: BTreeMap::new(),
        lifecycle_variants: BTreeMap::new(),
        route_labels: BTreeMap::new(),
    }
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
    // An empty reference names nothing, and `*` claims the empty path, so it is
    // refused before the globs are asked; the codec refuses it the same way.
    if reference.is_empty() {
        ctx.error(
            "empty-reference",
            path,
            format!("{action} is empty, so it names no node and no file"),
            format!("name the node id or the file {action} points at, or remove the entry"),
        );
        return;
    }
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
    // Each walk stops once it has climbed MAX_NESTING_DEPTH ancestors, so the
    // check is O(nodes * cap). A chain that reaches the cap is refused once for
    // the document: that is past what the layout places, and a cycle longer
    // than the cap is caught by the same refusal.
    let mut too_deep = false;
    for (index, _) in spec.nodes.iter().enumerate() {
        let mut seen = HashSet::new();
        seen.insert(spec.nodes[index].id.as_str());
        let mut current = parent_of[index];
        let mut climbed = 0usize;
        while let Some(parent) = current {
            climbed += 1;
            if climbed > MAX_NESTING_DEPTH {
                if !too_deep {
                    too_deep = true;
                    ctx.error(
                        "nesting-depth",
                        &format!("/nodes/{index}/parent"),
                        format!(
                            "node {:?} nests at least {climbed} levels deep, past the {MAX_NESTING_DEPTH} levels a map may nest (a parent cycle longer than that reads the same)",
                            spec.nodes[index].id
                        ),
                        format!(
                            "flatten the deepest frames to {MAX_NESTING_DEPTH} levels or fewer, break any cycle in the chain, or split the map into several documents"
                        ),
                    );
                }
                break;
            }
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
    // The schema is optional; only a document that declares a different one is
    // refused, which is what the codec's `$schema !== undefined` check decides.
    if let Some(schema) = &spec.schema {
        if schema != FLOORPLAN_SCHEMA_ID {
            ctx.error(
                "schema",
                "/$schema",
                format!("the document declares schema {schema:?}, not {FLOORPLAN_SCHEMA_ID:?}"),
                format!(
                    "set \"$schema\" to \"{FLOORPLAN_SCHEMA_ID}\" or validate it as its own type"
                ),
            );
        }
    }
    ctx.text(&spec.project.name, 1, None, "/project/name");
    if let Some(summary) = &spec.project.summary {
        ctx.text(summary, 0, None, "/project/summary");
    }
    if let Some(audience) = &spec.audience {
        ctx.enum_value(audience, AUDIENCES, "/audience");
    }

    // An empty node list is a map with nothing on it yet, which the codec allows.
    let mut node_ids = HashSet::new();
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
        // Flow ids are any non-empty string ("request flow" is a flow), unlike
        // the node ids they are never referenced by.
        ctx.text(&flow.id, 1, None, &format!("{path}/id"));
        if !flow_ids.insert(flow.id.as_str()) {
            ctx.error(
                "duplicate-id",
                &format!("{path}/id"),
                format!("flow ID {:?} occurs more than once", flow.id),
                "give each flow its own ID, or remove the repeated entry",
            );
        }
        ctx.text(&flow.title, 1, None, &format!("{path}/title"));
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
    }
}

/// The items of an array field, or nothing when the field is absent or is not
/// an array (which serde reports as the wrong shape on its own).
fn items<'a>(value: &'a Value, field: &str) -> &'a [Value] {
    value
        .get(field)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
}

/// Refuse an explicit `null` in a field the format types when it is present.
/// Omitting the field and writing `null` read as the same value to serde, while
/// the codec refuses the second, so this keeps the two verdicts equal.
fn check_nulls(ctx: &mut Context, value: &Value, path: &str, fields: &[&str]) {
    let Some(object) = value.as_object() else {
        return;
    };
    for field in fields {
        if object.get(*field).is_some_and(Value::is_null) {
            ctx.error(
                "null-field",
                &format!("{path}/{field}"),
                format!("field {field:?} is null, which the format does not accept"),
                "remove the field, or give it its documented value",
            );
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
            "start from a document with a project and its nodes",
        );
        return ctx.finish();
    }
    // Counted before anything walks the items, so an oversized document is
    // refused at the cost of reading its length.
    let mut oversized = false;
    for (field, cap, noun) in [("nodes", MAX_NODES, "node"), ("edges", MAX_EDGES, "edge")] {
        let count = items(&value, field).len();
        if count > cap {
            oversized = true;
            ctx.error(
                &format!("{noun}-count"),
                &format!("/{field}"),
                format!("the map lists {count} {noun}s, past the {cap} one map may hold"),
                format!("split the map into several documents of at most {cap} {noun}s each"),
            );
        }
    }
    if oversized {
        return ctx.finish();
    }
    check_nulls(&mut ctx, &value, "", SPEC_TYPED);
    if let Some(project) = value.get("project") {
        check_nulls(&mut ctx, project, "/project", PROJECT_TYPED);
    }
    for (field, fields) in [
        ("nodes", NODE_TYPED),
        ("edges", EDGE_TYPED),
        ("annotations", ANNOTATION_TYPED),
    ] {
        for (index, item) in items(&value, field).iter().enumerate() {
            check_nulls(&mut ctx, item, &format!("/{field}/{index}"), fields);
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
    fn preserves_fields_the_format_does_not_define() {
        // The codec keeps an unknown field verbatim and reports it as a fidelity
        // note, so it is not a reason to refuse the document here either.
        let mut spec = nested_map();
        spec["custom"] = json!(true);
        spec["nodes"][0]["icon"] = json!("cube");
        spec["edges"][0]["weight"] = json!(2);
        spec["flows"][0]["steps"][0]["highlight"] = json!(true);
        spec["tour"][0]["duration"] = json!(3);
        assert!(validate(spec).is_empty());
    }

    #[test]
    fn accepts_an_absent_schema_and_an_empty_node_list() {
        let mut spec = nested_map();
        spec.as_object_mut().unwrap().remove("$schema");
        assert!(validate(spec).is_empty(), "an absent $schema is allowed");

        let mut empty = nested_map();
        empty["nodes"] = json!([]);
        empty["edges"] = json!([]);
        empty["flows"] = json!([]);
        empty["tour"] = json!([]);
        assert!(
            validate(empty).is_empty(),
            "a map with no nodes yet is allowed"
        );
    }

    #[test]
    fn accepts_a_flow_id_that_is_not_an_identifier() {
        // Only node ids carry the character rule; a flow is never referenced.
        let mut spec = nested_map();
        spec["flows"][0]["id"] = json!("request flow");
        assert!(validate(spec).is_empty());

        let mut repeated = nested_map();
        let flow = repeated["flows"][0].clone();
        repeated["flows"] = json!([flow.clone(), flow]);
        let diagnostics = validate(repeated);
        let listed = codes(&diagnostics);
        assert!(listed.contains(&"floorplan/duplicate-id"), "{listed:?}");
    }

    #[test]
    fn refuses_a_null_in_a_field_the_format_types() {
        // Each optional collection, one scalar, and one nested field: a present
        // `null` is a value the format does not accept, while an omitted field is
        // exactly the same document.
        let mut spec = nested_map();
        spec["edges"] = Value::Null;
        spec["annotations"] = Value::Null;
        spec["flows"] = Value::Null;
        spec["tour"] = Value::Null;
        spec["include"] = Value::Null;
        spec["nodes"][0]["parent"] = Value::Null;
        spec["nodes"][0]["summary"] = Value::Null;
        let diagnostics = validate(spec);
        let listed = codes(&diagnostics);
        assert_eq!(
            listed
                .iter()
                .filter(|code| **code == "floorplan/null-field")
                .count(),
            7,
            "{listed:?}"
        );

        // The four prose fields the codec never reads are not typed by it, so a
        // present `null` there is accepted rather than refused.
        let mut prose = nested_map();
        prose["flows"][0]["description"] = Value::Null;
        prose["flows"][0]["steps"][0]["note"] = Value::Null;
        prose["tour"][0]["title"] = Value::Null;
        prose["tour"][0]["note"] = Value::Null;
        assert!(validate(prose).is_empty(), "unchecked prose was refused");
    }

    #[test]
    fn accepts_prose_the_codec_does_not_read_in_any_shape() {
        // The codec checks neither the type nor the presence of these four
        // fields, so a number there is a document it accepts.
        let mut spec = nested_map();
        spec["flows"][0]["description"] = json!(7);
        spec["flows"][0]["steps"][1]["note"] = json!(["not", "prose"]);
        spec["tour"][0]["title"] = json!(false);
        spec["tour"][0]["note"] = json!({"nested": 1});
        let diagnostics = validate(spec);
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
    }

    #[test]
    fn refuses_an_empty_reference_even_when_a_glob_would_claim_it() {
        // `*` matches the empty path, so an empty reference would resolve as a
        // file a node claims unless emptiness is refused first; the codec refuses
        // it outright, in `isFloorplanRef` and in the edge endpoint check.
        let mut spec = nested_map();
        spec["nodes"][0]["paths"] = json!(["*"]);
        assert!(
            validate(spec.clone()).is_empty(),
            "the * claim alone is a valid map"
        );

        let mut endpoint = spec.clone();
        endpoint["edges"][0]["from"] = json!("");
        assert_eq!(
            codes(&validate(endpoint)),
            vec!["floorplan/empty-reference"]
        );

        let mut step = spec.clone();
        step["flows"][0]["steps"][1]["node"] = json!("");
        assert_eq!(codes(&validate(step)), vec!["floorplan/empty-reference"]);

        let mut stop = spec.clone();
        stop["tour"][0]["node"] = json!("");
        assert_eq!(codes(&validate(stop)), vec!["floorplan/empty-reference"]);
    }

    #[test]
    fn a_pathological_pattern_stays_within_its_budget() {
        // Neither an alternation chain, a `*`-heavy segment nor a brace that
        // never closes may cost more than one pass over the pattern and the path,
        // which is what a pattern inside the apply gate needs: expanding either
        // would be exponential.
        let braces = format!("{}/x", "{a,b}".repeat(30));
        let stars = format!("{}b", "a*".repeat(30));
        let path = "a".repeat(60);
        let unclosed = format!("{}x", "{".repeat(30));
        // An unmatched `[` run as long as the codec's size budget allows: each
        // `[` must find (or miss) its closer by lookup, not by a suffix scan.
        // This case is only a time budget. At 100k characters V8 refuses the
        // application's regex ("Regular expression too large") and matches
        // nothing, so parity is checked at 1,000, which TS verified matches.
        let brackets = "[".repeat(100_000);
        let started = std::time::Instant::now();
        assert!(!glob_matches(&brackets, "x"));
        let _ = glob_matches(&brackets, &brackets);
        let thousand = "[".repeat(1_000);
        assert!(glob_matches(&thousand, &thousand));
        assert!(!glob_matches(&braces, "a/a/a"));
        assert!(!glob_matches(&stars, &path));
        assert!(glob_matches(&stars, &format!("{path}b")));
        // An unclosed `{` is a literal brace, so the pattern reads as text.
        assert!(glob_matches(&unclosed, &unclosed));
        // An alternation nested one level is still an alternation.
        assert!(glob_matches("{a,{b,c}}.ts", "c.ts"));
        assert!(!glob_matches("{a,{b,c}}.ts", "d.ts"));
        assert!(
            started.elapsed() < std::time::Duration::from_secs(2),
            "the glob matcher took {:?} on a pathological pattern",
            started.elapsed()
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
            // The application's own table (src/lib/diagram/floorplan.test.ts).
            ("shop-api/app", "shop-api/app/routes/x.py", true),
            ("src/{a,b}.ts", "src/b.ts", true),
            ("src/*.ts", "src/x/y.ts", false),
            ("src/[ab].ts", "src/a.ts", true),
            ("src/[ab].ts", "src/c.ts", false),
            ("src/{?,bb}.ts", "src/z.ts", true),
            ("src/{?,bb}.ts", "src/bb.ts", true),
            ("src/{?,bb}.ts", "src/bbb.ts", false),
            ("app/orders/[id]/**", "app/orders/[id]/page.tsx", true),
            ("app/orders/[id]/**", "app/orders/7/page.tsx", false),
            ("app/[...slug]/page.tsx", "app/[...slug]/page.tsx", true),
            ("app/[[...slug]]/page.tsx", "app/[[...slug]]/page.tsx", true),
            ("src/{broken", "src/{broken", true),
            // `**` crosses directories wherever it stands, not only as a segment.
            ("app/**.ts", "app/main.ts", true),
            ("app/**.ts", "app/src/main.ts", true),
            ("a/**.ts/x", "a/b/c.ts/x", true),
            // A trailing `**` needs the segment boundary the pattern names.
            ("a/**", "a/", true),
            ("a/**", "a", false),
            // A class is a wildcard, so it claims no directory of its own.
            ("app/[abc].ts", "app/[abc].ts/x", false),
            // TS-verified (compileGlob run on these inputs): an empty arm is an
            // arm, first, last or in between.
            ("{a,}.ts", ".ts", true),
            ("{a,}.ts", "a.ts", true),
            ("{,a}.ts", ".ts", true),
            ("{,a}.ts", "a.ts", true),
            ("{a,,b}.ts", ".ts", true),
            // TS-verified: a descending range makes `new RegExp` throw, so the
            // whole pattern matches nothing; an ascending one is a range.
            ("src/[z-a0].ts", "src/0.ts", false),
            ("src/[z-a0].ts", "src/z.ts", false),
            ("src/[a-z0].ts", "src/0.ts", true),
        ];
        for (pattern, path, expected) in cases {
            assert_eq!(
                glob_matches(pattern, path),
                *expected,
                "pattern {pattern:?} against {path:?}"
            );
        }
    }

    fn chain_map(length: usize) -> Value {
        let nodes: Vec<Value> = (0..length)
            .map(|level| {
                let mut node =
                    json!({ "id": format!("n{level}"), "label": "L", "kind": "service" });
                if level > 0 {
                    node["parent"] = json!(format!("n{}", level - 1));
                }
                node
            })
            .collect();
        json!({ "project": { "name": "chain" }, "nodes": nodes })
    }

    #[test]
    fn a_chain_past_the_nesting_cap_is_refused_once_by_validation() {
        let cap = super::MAX_NESTING_DEPTH;
        // cap + 1 nodes nest exactly cap levels, which the layout still places.
        assert!(validate(chain_map(cap + 1)).is_empty());
        let diagnostics = validate(chain_map(cap + 2));
        assert_eq!(codes(&diagnostics), vec!["floorplan/nesting-depth"]);
        assert!(
            diagnostics[0].fix.contains(&cap.to_string()),
            "{}",
            diagnostics[0].fix
        );
    }

    #[test]
    fn a_short_cycle_is_still_named_a_cycle() {
        let mut cyclic = chain_map(3);
        cyclic["nodes"][0]["parent"] = json!("n2");
        let listed = validate(cyclic);
        let listed = codes(&listed);
        assert!(listed.contains(&"floorplan/parent-cycle"), "{listed:?}");
        assert!(!listed.contains(&"floorplan/nesting-depth"), "{listed:?}");
    }

    #[test]
    fn a_hundred_thousand_node_chain_validates_in_linear_time() {
        // Unbounded ancestor walks cost ~5e9 steps here; the capped walk costs
        // ~6.4e6. The bound is loose for slow CI, far below the quadratic cost.
        let mut spec = chain_map(100_000);
        // Count caps run first, so lift the chain under them by checking the
        // walk directly through validate_spec.
        let started = std::time::Instant::now();
        let parsed: super::FloorplanSpec = serde_json::from_value(spec.take()).unwrap();
        let mut ctx = crate::common::Context::new("floorplan");
        super::validate_spec(&parsed, &mut ctx);
        let diagnostics = ctx.finish();
        let elapsed = started.elapsed();
        assert_eq!(codes(&diagnostics), vec!["floorplan/nesting-depth"]);
        assert!(
            elapsed < std::time::Duration::from_secs(10),
            "took {elapsed:?}"
        );
    }

    #[test]
    fn a_hundred_thousand_node_document_is_refused_by_count_first() {
        let started = std::time::Instant::now();
        let diagnostics = validate(chain_map(100_000));
        assert_eq!(codes(&diagnostics), vec!["floorplan/node-count"]);
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }

    #[test]
    fn node_and_edge_counts_past_their_caps_are_refused() {
        let at_cap = chain_map(super::MAX_NODES);
        assert!(!codes(&validate(at_cap)).contains(&"floorplan/node-count"));
        let diagnostics = validate(chain_map(super::MAX_NODES + 1));
        assert_eq!(codes(&diagnostics), vec!["floorplan/node-count"]);
        assert!(diagnostics[0]
            .message
            .contains(&(super::MAX_NODES + 1).to_string()));
        assert!(diagnostics[0].fix.contains(&super::MAX_NODES.to_string()));

        let mut spec = nested_map();
        let edge = spec["edges"][0].clone();
        spec["edges"] = Value::Array(vec![edge; super::MAX_EDGES + 1]);
        let diagnostics = validate(spec);
        assert_eq!(codes(&diagnostics), vec!["floorplan/edge-count"]);
        assert!(diagnostics[0].fix.contains(&super::MAX_EDGES.to_string()));
    }
}
