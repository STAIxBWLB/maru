//! Host port of hwp-editor's form wire parsers (`packages/core/src/forms.ts`,
//! hwp-editor 7c430d2): `parseFormDiscovery`, `parseFormBindingPlan`,
//! `validateFormValues`, `parseFormReceipt` and `parseFormPreview`.
//!
//! The host refuses what the client and the HTTP adapter refuse and returns what
//! they return: only known fields, in upstream order, with the same bounds. The
//! preview's `native_warnings` are always emptied, because native diagnostics
//! may contain local paths (maru#626 T126-R2). Each refusal names the JSON path
//! upstream names, so `forms/parity_tests.rs` can compare the two directly
//! against outputs recorded from the upstream functions.
//!
//! serde_json rejects lone surrogates while parsing, so every `&str` here is
//! valid Unicode and a scalar count is `chars().count()`.

use serde_json::{Map, Value};
use std::collections::BTreeSet;

/// Upstream's `TypeError("Invalid form data at <path>")`, by path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct FormDataError(pub String);

impl std::fmt::Display for FormDataError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "Invalid form data at {}", self.0)
    }
}

type Parsed<T> = Result<T, FormDataError>;

const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
const NO_MAX: usize = usize::MAX;

fn fail<T>(path: impl Into<String>) -> Parsed<T> {
    Err(FormDataError(path.into()))
}

fn obj<'a>(
    value: &'a Value,
    path: &str,
    allowed: &[&str],
    required: &[&str],
) -> Parsed<&'a Map<String, Value>> {
    let Some(object) = value.as_object() else {
        return fail(path);
    };
    if object.keys().any(|key| !allowed.contains(&key.as_str()))
        || required.iter().any(|key| !object.contains_key(*key))
    {
        return fail(path);
    }
    Ok(object)
}

/// A field `obj` already proved present, or JSON `undefined` for an optional
/// one, which only `copies`, `repeats` and `constraints` may be.
fn field<'a>(object: &'a Map<String, Value>, key: &str) -> &'a Value {
    static UNDEFINED: Value = Value::Null;
    object.get(key).unwrap_or(&UNDEFINED)
}

fn str_<'a>(value: &'a Value, path: &str, min: usize, max: usize) -> Parsed<&'a str> {
    let Some(text) = value.as_str() else {
        return fail(path);
    };
    let length = text.chars().count();
    if length < min || length > max {
        return fail(path);
    }
    Ok(text)
}

fn int(value: &Value, path: &str, min: u64, max: u64) -> Parsed<u64> {
    // `Number.isInteger` accepts 2.0 and -0, so a float with no fraction counts.
    let number = match value {
        Value::Number(number) => match (number.as_u64(), number.as_i64(), number.as_f64()) {
            (Some(unsigned), _, _) => Some(unsigned),
            (None, Some(_), _) => None,
            (None, None, Some(float)) if float.is_finite() && float.fract() == 0.0 => {
                if float == 0.0 {
                    Some(0)
                } else if float > 0.0 && float <= MAX_SAFE_INTEGER as f64 {
                    Some(float as u64)
                } else {
                    None
                }
            }
            _ => None,
        },
        _ => None,
    };
    match number {
        Some(number) if number >= min && number <= max.min(MAX_SAFE_INTEGER) => Ok(number),
        _ => fail(path),
    }
}

fn bool_(value: &Value, path: &str) -> Parsed<bool> {
    value.as_bool().map_or_else(|| fail(path), Ok)
}

fn arr<'a>(value: &'a Value, path: &str, max: usize) -> Parsed<&'a [Value]> {
    match value.as_array() {
        Some(items) if items.len() <= max => Ok(items),
        _ => fail(path),
    }
}

fn is_lower_hex(text: &str, length: usize) -> bool {
    text.len() == length
        && text
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn hash(value: &Value, path: &str) -> Parsed<String> {
    let text = str_(value, path, 64, 64)?;
    if !is_lower_hex(text, 64) {
        return fail(path);
    }
    Ok(text.to_string())
}

fn is_occurrence(text: &str) -> bool {
    text.strip_prefix("occ-")
        .is_some_and(|rest| is_lower_hex(rest, 64))
}

fn key(value: &Value, path: &str) -> Parsed<String> {
    str_(value, path, 1, 128).map(str::to_string)
}

fn identifier(value: &Value, path: &str) -> Parsed<String> {
    str_(value, path, 1, 1024).map(str::to_string)
}

fn version(object: &Map<String, Value>) -> Parsed<()> {
    // `o.version !== 1`: 1.0 is the same number in JSON.
    if object.get("version").and_then(Value::as_f64) == Some(1.0) {
        Ok(())
    } else {
        fail("version")
    }
}

fn indices(value: &Value, path: &str) -> Parsed<Value> {
    let items = arr(value, path, 32)?;
    let mut out = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        out.push(Value::from(int(
            item,
            &format!("{path}[{index}]"),
            0,
            MAX_SAFE_INTEGER,
        )?));
    }
    Ok(Value::Array(out))
}

fn nullable(value: &Value, parse: impl FnOnce(&Value) -> Parsed<Value>) -> Parsed<Value> {
    if value.is_null() {
        Ok(Value::Null)
    } else {
        parse(value)
    }
}

fn nullable_str(value: &Value, path: &str, min: usize) -> Parsed<Value> {
    nullable(value, |value| {
        str_(value, path, min, NO_MAX).map(Value::from)
    })
}

fn nullable_int(value: &Value, path: &str, max: u64) -> Parsed<Value> {
    nullable(value, |value| int(value, path, 0, max).map(Value::from))
}

fn unique<T: Ord>(items: impl IntoIterator<Item = T>, path: &str) -> Parsed<()> {
    let mut seen = BTreeSet::new();
    for item in items {
        if !seen.insert(item) {
            return fail(path);
        }
    }
    Ok(())
}

/// `/[\u0000-\u0008\u000b-\u001f]/`: tab and line feed are allowed.
fn has_control(text: &str) -> bool {
    text.chars()
        .any(|ch| matches!(ch, '\u{0}'..='\u{8}' | '\u{b}'..='\u{1f}'))
}

/// Build an object in the given order; `preserve_order` keeps it on the wire.
fn object(entries: Vec<(&str, Value)>) -> Value {
    Value::Object(
        entries
            .into_iter()
            .map(|(key, value)| (key.to_string(), value))
            .collect(),
    )
}

const OCCURRENCE_FIELDS: &[&str] = &[
    "id",
    "kind",
    "label",
    "paragraph_id",
    "section",
    "indices",
    "model_route",
    "table_id",
    "table_index",
    "row",
    "col",
    "start",
    "end",
    "old_text",
    "prior_sha256",
    "bindable",
    "cause",
    "next_step",
    "label_occurrences",
    "label_ambiguous",
];
const KINDS: &[&str] = &["cell_text", "placeholder", "inline_value", "native_field"];
const CAUSES: &[&str] = &[
    "caption_target",
    "raw_preserved_target",
    "rich_target",
    "native_field",
];

pub(super) fn parse_discovery(raw: &Value) -> Parsed<Value> {
    let fields = [
        "version",
        "source_sha256",
        "structural_sha256",
        "occurrences",
    ];
    let o = obj(raw, "discovery", &fields, &fields)?;
    version(o)?;
    let mut occurrences = Vec::new();
    let mut ids = Vec::new();
    for (i, v) in arr(field(o, "occurrences"), "occurrences", 20000)?
        .iter()
        .enumerate()
    {
        let p = format!("occurrences[{i}]");
        let q = obj(v, &p, OCCURRENCE_FIELDS, OCCURRENCE_FIELDS)?;
        let at = |name: &str| format!("{p}.{name}");
        let id = str_(field(q, "id"), &at("id"), 68, 68)?;
        if !is_occurrence(id) {
            return fail(at("id"));
        }
        let kind = str_(field(q, "kind"), &at("kind"), 0, NO_MAX)?;
        if !KINDS.contains(&kind) {
            return fail(at("kind"));
        }
        let bindable = bool_(field(q, "bindable"), &at("bindable"))?;
        let cause = nullable(field(q, "cause"), |value| {
            let text = str_(value, &at("cause"), 0, NO_MAX)?;
            if !CAUSES.contains(&text) {
                return fail(at("cause"));
            }
            Ok(Value::from(text))
        })?;
        let next_step = nullable_str(field(q, "next_step"), &at("next_step"), 1)?;
        // A bindable target carries neither a cause nor a next step; an
        // unbindable one carries both.
        let refused = if bindable {
            !cause.is_null() || !next_step.is_null()
        } else {
            cause.is_null() || next_step.is_null()
        };
        if refused {
            return fail(p);
        }
        if kind == "native_field" && (bindable || next_step.as_str() != Some("hwp fields")) {
            return fail(p);
        }
        let start = int(field(q, "start"), &at("start"), 0, MAX_SAFE_INTEGER)?;
        let end = int(field(q, "end"), &at("end"), 0, MAX_SAFE_INTEGER)?;
        if start > end {
            return fail(p);
        }
        let label = str_(field(q, "label"), &at("label"), 0, NO_MAX)?;
        let label_occurrences = int(
            field(q, "label_occurrences"),
            &at("label_occurrences"),
            0,
            20000,
        )?;
        let label_ambiguous = bool_(field(q, "label_ambiguous"), &at("label_ambiguous"))?;
        if (label.is_empty() && (label_occurrences != 0 || label_ambiguous))
            || label_ambiguous != (label_occurrences > 1)
        {
            return fail(p);
        }
        let paragraph_id = nullable_str(field(q, "paragraph_id"), &at("paragraph_id"), 1)?;
        let section = int(field(q, "section"), &at("section"), 0, MAX_SAFE_INTEGER)?;
        let indices = indices(field(q, "indices"), &at("indices"))?;
        let model_route = str_(field(q, "model_route"), &at("model_route"), 1, NO_MAX)?;
        let table_id = nullable_str(field(q, "table_id"), &at("table_id"), 1)?;
        let table_index = nullable_int(
            field(q, "table_index"),
            &at("table_index"),
            MAX_SAFE_INTEGER,
        )?;
        let row = nullable_int(field(q, "row"), &at("row"), 65535)?;
        let col = nullable_int(field(q, "col"), &at("col"), 65535)?;
        let old_text = str_(field(q, "old_text"), &at("old_text"), 0, NO_MAX)?;
        let prior = hash(field(q, "prior_sha256"), &at("prior_sha256"))?;
        ids.push(id.to_string());
        occurrences.push(object(vec![
            ("id", Value::from(id)),
            ("kind", Value::from(kind)),
            ("label", Value::from(label)),
            ("paragraph_id", paragraph_id),
            ("section", Value::from(section)),
            ("indices", indices),
            ("model_route", Value::from(model_route)),
            ("table_id", table_id),
            ("table_index", table_index),
            ("row", row),
            ("col", col),
            ("start", Value::from(start)),
            ("end", Value::from(end)),
            ("old_text", Value::from(old_text)),
            ("prior_sha256", Value::from(prior)),
            ("bindable", Value::from(bindable)),
            ("cause", cause),
            ("next_step", next_step),
            ("label_occurrences", Value::from(label_occurrences)),
            ("label_ambiguous", Value::from(label_ambiguous)),
        ]));
    }
    unique(ids, "occurrences.id")?;
    Ok(object(vec![
        ("version", Value::from(1)),
        (
            "source_sha256",
            Value::from(hash(field(o, "source_sha256"), "source_sha256")?),
        ),
        (
            "structural_sha256",
            Value::from(hash(field(o, "structural_sha256"), "structural_sha256")?),
        ),
        ("occurrences", Value::Array(occurrences)),
    ]))
}

pub(super) fn parse_plan(raw: &Value) -> Parsed<Value> {
    let o = obj(
        raw,
        "plan",
        &[
            "version",
            "source_sha256",
            "structural_sha256",
            "bindings",
            "repeats",
            "constraints",
        ],
        &["version", "source_sha256", "structural_sha256", "bindings"],
    )?;
    version(o)?;
    let mut bindings = Vec::new();
    let mut keys = Vec::new();
    let mut owners = Vec::new();
    for (i, v) in arr(field(o, "bindings"), "bindings", 256)?
        .iter()
        .enumerate()
    {
        let p = format!("bindings[{i}]");
        let b = obj(v, &p, &["key", "targets"], &["key", "targets"])?;
        let k = key(field(b, "key"), &format!("{p}.key"))?;
        let mut targets = Vec::new();
        for (j, t) in arr(field(b, "targets"), &format!("{p}.targets"), 256)?
            .iter()
            .enumerate()
        {
            let z = format!("{p}.targets[{j}]");
            let q = obj(
                t,
                &z,
                &["occurrence_id", "copies", "max_chars", "allow_reflow"],
                &["occurrence_id", "max_chars", "allow_reflow"],
            )?;
            let explicit = q.contains_key("copies");
            let copies = if explicit {
                let mut copies = Vec::new();
                for (h, n) in arr(field(q, "copies"), &format!("{z}.copies"), 16)?
                    .iter()
                    .enumerate()
                {
                    copies.push(int(n, &format!("{z}.copies[{h}]"), 0, 15)?);
                }
                copies
            } else {
                vec![0]
            };
            if copies.is_empty() {
                return fail(z);
            }
            unique(copies.iter().copied(), &format!("{z}.copies"))?;
            let occurrence = identifier(field(q, "occurrence_id"), &format!("{z}.occurrence_id"))?;
            let max_chars = int(field(q, "max_chars"), &format!("{z}.max_chars"), 1, 20000)?;
            let allow_reflow = bool_(field(q, "allow_reflow"), &format!("{z}.allow_reflow"))?;
            owners.extend(copies.iter().map(|copy| (occurrence.clone(), *copy)));
            let mut entries = vec![("occurrence_id", Value::from(occurrence))];
            if explicit {
                entries.push(("copies", Value::from(copies)));
            }
            entries.push(("max_chars", Value::from(max_chars)));
            entries.push(("allow_reflow", Value::from(allow_reflow)));
            targets.push(object(entries));
        }
        if targets.is_empty() {
            return fail(format!("{p}.targets"));
        }
        keys.push(k.clone());
        bindings.push(object(vec![
            ("key", Value::from(k)),
            ("targets", Value::Array(targets)),
        ]));
    }
    unique(keys.iter(), "bindings.key")?;
    unique(owners, "bindings.targets")?;
    let repeats = match o.get("repeats") {
        None => None,
        Some(value) => {
            let mut repeats = Vec::new();
            for (i, v) in arr(value, "repeats", 16)?.iter().enumerate() {
                let p = format!("repeats[{i}]");
                let fields = ["table_id", "after_paragraph_id", "copies", "profile_ids"];
                let r = obj(v, &p, &fields, &fields)?;
                let copies = int(field(r, "copies"), &format!("{p}.copies"), 1, 16)?;
                let mut profiles = Vec::new();
                for (j, x) in arr(field(r, "profile_ids"), &format!("{p}.profile_ids"), 16)?
                    .iter()
                    .enumerate()
                {
                    profiles.push(key(x, &format!("{p}.profile_ids[{j}]"))?);
                }
                if profiles.len() as u64 != copies {
                    return fail(format!("{p}.profile_ids"));
                }
                unique(profiles.iter(), &format!("{p}.profile_ids"))?;
                let table_id = identifier(field(r, "table_id"), &format!("{p}.table_id"))?;
                let after = identifier(
                    field(r, "after_paragraph_id"),
                    &format!("{p}.after_paragraph_id"),
                )?;
                repeats.push(object(vec![
                    ("table_id", Value::from(table_id)),
                    ("after_paragraph_id", Value::from(after)),
                    ("copies", Value::from(copies)),
                    ("profile_ids", Value::from(profiles)),
                ]));
            }
            Some(Value::Array(repeats))
        }
    };
    let constraints = match o.get("constraints") {
        None => None,
        Some(value) => {
            let mut constraints = Vec::new();
            for (i, v) in arr(value, "constraints", 128)?.iter().enumerate() {
                let p = format!("constraints[{i}]");
                let kind = v
                    .as_object()
                    .and_then(|object| object.get("kind"))
                    .and_then(Value::as_str);
                constraints.push(match kind {
                    Some("equal") => {
                        let q = obj(
                            v,
                            &p,
                            &["kind", "left", "right"],
                            &["kind", "left", "right"],
                        )?;
                        let left = key(field(q, "left"), &format!("{p}.left"))?;
                        let right = key(field(q, "right"), &format!("{p}.right"))?;
                        object(vec![
                            ("kind", Value::from("equal")),
                            ("left", Value::from(left)),
                            ("right", Value::from(right)),
                        ])
                    }
                    Some("sum") => {
                        let q = obj(
                            v,
                            &p,
                            &["kind", "keys", "total"],
                            &["kind", "keys", "total"],
                        )?;
                        let mut ks = Vec::new();
                        for (j, x) in arr(field(q, "keys"), &format!("{p}.keys"), 256)?
                            .iter()
                            .enumerate()
                        {
                            ks.push(key(x, &format!("{p}.keys[{j}]"))?);
                        }
                        if ks.is_empty() {
                            return fail(format!("{p}.keys"));
                        }
                        let total = key(field(q, "total"), &format!("{p}.total"))?;
                        object(vec![
                            ("kind", Value::from("sum")),
                            ("keys", Value::from(ks)),
                            ("total", Value::from(total)),
                        ])
                    }
                    _ => return fail(p),
                });
            }
            Some(Value::Array(constraints))
        }
    };
    let mut entries = vec![
        ("version", Value::from(1)),
        (
            "source_sha256",
            Value::from(hash(field(o, "source_sha256"), "source_sha256")?),
        ),
        (
            "structural_sha256",
            Value::from(hash(field(o, "structural_sha256"), "structural_sha256")?),
        ),
        ("bindings", Value::Array(bindings)),
    ];
    if let Some(repeats) = repeats {
        entries.push(("repeats", repeats));
    }
    if let Some(constraints) = constraints {
        entries.push(("constraints", constraints));
    }
    Ok(object(entries))
}

/// `BigInt` of a plain or comma-grouped decimal, refused past `i64::MAX`.
fn number(values: &Map<String, Value>, key: &str) -> Parsed<u128> {
    let Some(text) = values.get(key).and_then(Value::as_str) else {
        return fail("values.numeric");
    };
    let plain = !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit());
    let grouped = {
        let mut groups = text.split(',');
        let head = groups.next().unwrap_or_default();
        let rest: Vec<&str> = groups.collect();
        !rest.is_empty()
            && (1..=3).contains(&head.len())
            && head.bytes().all(|byte| byte.is_ascii_digit())
            && rest
                .iter()
                .all(|group| group.len() == 3 && group.bytes().all(|byte| byte.is_ascii_digit()))
    };
    if !plain && !grouped {
        return fail("values.numeric");
    }
    let mut total: u128 = 0;
    for byte in text.bytes().filter(u8::is_ascii_digit) {
        total = match total
            .checked_mul(10)
            .and_then(|n| n.checked_add(u128::from(byte - b'0')))
        {
            Some(total) => total,
            None => return fail("values.numeric"),
        };
    }
    if total > i64::MAX as u128 {
        return fail("values.numeric");
    }
    Ok(total)
}

/// `validateFormValues` against a plan `parse_plan` returned.
pub(super) fn validate_values(plan: &Value, raw: &Value) -> Parsed<Map<String, Value>> {
    let Some(o) = raw.as_object() else {
        return fail("values");
    };
    let bindings = plan["bindings"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    let expected: BTreeSet<&str> = bindings.iter().filter_map(|b| b["key"].as_str()).collect();
    if o.len() != expected.len() || o.keys().any(|key| !expected.contains(key.as_str())) {
        return fail("values");
    }
    let mut values = Map::new();
    for (i, (k, v)) in o.iter().enumerate() {
        let path = format!("values[{i}]");
        let text = str_(v, &path, 0, 20000)?;
        if has_control(text) {
            return fail(path);
        }
        values.insert(k.clone(), Value::from(text));
        let chars = text.chars().count() as u64;
        for binding in bindings
            .iter()
            .filter(|b| b["key"].as_str() == Some(k.as_str()))
        {
            for target in binding["targets"].as_array().into_iter().flatten() {
                if chars > target["max_chars"].as_u64().unwrap_or(0) {
                    return fail(path);
                }
            }
        }
    }
    let max = i64::MAX as u128;
    for (i, c) in plan["constraints"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        let at = format!("constraints[{i}]");
        let names: Vec<&str> = if c["kind"] == "equal" {
            vec![
                c["left"].as_str().unwrap_or_default(),
                c["right"].as_str().unwrap_or_default(),
            ]
        } else {
            c["keys"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .chain(c["total"].as_str())
                .collect()
        };
        if names.iter().any(|name| !expected.contains(name)) {
            return fail(at);
        }
        if c["kind"] == "equal" {
            if number(&values, names[0])? != number(&values, names[1])? {
                return fail(at);
            }
        } else {
            let (total, keys) = names.split_last().expect("a sum names its total");
            let mut sum: u128 = 0;
            for name in keys {
                sum += number(&values, name)?;
                if sum > max {
                    return fail(at);
                }
            }
            if sum != number(&values, total)? {
                return fail(at);
            }
        }
    }
    Ok(values)
}

pub(super) fn parse_receipt(raw: &Value) -> Parsed<Value> {
    let fields = [
        "version",
        "source_sha256",
        "plan_sha256",
        "values_sha256",
        "output_sha256",
        "published",
        "occurrence_ids",
        "targets",
        "cloned_profiles",
        "semantic_budget",
        "render_font_native",
        "native_warning_count",
    ];
    let o = obj(raw, "receipt", &fields, &fields)?;
    version(o)?;
    let mut ids = Vec::new();
    for (i, x) in arr(field(o, "occurrence_ids"), "occurrence_ids", 20000)?
        .iter()
        .enumerate()
    {
        let path = format!("occurrence_ids[{i}]");
        let text = str_(x, &path, 0, NO_MAX)?;
        if !is_occurrence(text) {
            return fail(path);
        }
        ids.push(Value::from(text));
    }
    let source = hash(field(o, "source_sha256"), "source_sha256")?;
    let plan = hash(field(o, "plan_sha256"), "plan_sha256")?;
    let values = hash(field(o, "values_sha256"), "values_sha256")?;
    let output = hash(field(o, "output_sha256"), "output_sha256")?;
    let published = bool_(field(o, "published"), "published")?;
    let targets = int(field(o, "targets"), "targets", 0, MAX_SAFE_INTEGER)?;
    let cloned = int(
        field(o, "cloned_profiles"),
        "cloned_profiles",
        0,
        MAX_SAFE_INTEGER,
    )?;
    if field(o, "semantic_budget") != "selected_text_and_declared_clones_only" {
        return fail("semantic_budget");
    }
    if field(o, "render_font_native") != "unverified" {
        return fail("render_font_native");
    }
    let warnings = int(
        field(o, "native_warning_count"),
        "native_warning_count",
        0,
        MAX_SAFE_INTEGER,
    )?;
    Ok(object(vec![
        ("version", Value::from(1)),
        ("source_sha256", Value::from(source)),
        ("plan_sha256", Value::from(plan)),
        ("values_sha256", Value::from(values)),
        ("output_sha256", Value::from(output)),
        ("published", Value::from(published)),
        ("occurrence_ids", Value::Array(ids)),
        ("targets", Value::from(targets)),
        ("cloned_profiles", Value::from(cloned)),
        (
            "semantic_budget",
            Value::from("selected_text_and_declared_clones_only"),
        ),
        ("render_font_native", Value::from("unverified")),
        ("native_warning_count", Value::from(warnings)),
    ]))
}

pub(super) fn parse_preview(raw: &Value) -> Parsed<Value> {
    let fields = [
        "version",
        "source_sha256",
        "plan_sha256",
        "values_sha256",
        "copies",
        "changes",
        "native_warnings",
    ];
    let o = obj(raw, "preview", &fields, &fields)?;
    version(o)?;
    let mut copies = Vec::new();
    for (i, v) in arr(field(o, "copies"), "copies", 256)?.iter().enumerate() {
        let p = format!("copies[{i}]");
        let names = [
            "source_table_id",
            "copy",
            "profile_id",
            "table_id",
            "section",
            "indices",
        ];
        let q = obj(v, &p, &names, &names)?;
        let at = |name: &str| format!("{p}.{name}");
        copies.push(object(vec![
            (
                "source_table_id",
                Value::from(str_(
                    field(q, "source_table_id"),
                    &at("source_table_id"),
                    0,
                    NO_MAX,
                )?),
            ),
            (
                "copy",
                Value::from(int(field(q, "copy"), &at("copy"), 0, 15)?),
            ),
            (
                "profile_id",
                Value::from(str_(field(q, "profile_id"), &at("profile_id"), 0, NO_MAX)?),
            ),
            (
                "table_id",
                Value::from(str_(field(q, "table_id"), &at("table_id"), 0, NO_MAX)?),
            ),
            (
                "section",
                Value::from(int(
                    field(q, "section"),
                    &at("section"),
                    0,
                    MAX_SAFE_INTEGER,
                )?),
            ),
            ("indices", indices(field(q, "indices"), &at("indices"))?),
        ]));
    }
    let mut changes = Vec::new();
    for (i, v) in arr(field(o, "changes"), "changes", 20000)?
        .iter()
        .enumerate()
    {
        let p = format!("changes[{i}]");
        let names = [
            "occurrence_id",
            "copy",
            "profile_id",
            "paragraph_id",
            "section",
            "indices",
            "row",
            "col",
            "start",
            "end",
            "old_text",
            "new_text",
            "max_chars",
            "allow_reflow",
        ];
        let q = obj(v, &p, &names, &names)?;
        let at = |name: &str| format!("{p}.{name}");
        let id = str_(field(q, "occurrence_id"), &at("occurrence_id"), 0, NO_MAX)?;
        if !is_occurrence(id) {
            return fail(at("occurrence_id"));
        }
        let old_text = str_(field(q, "old_text"), &at("old_text"), 0, NO_MAX)?;
        let new_text = str_(field(q, "new_text"), &at("new_text"), 0, 20000)?;
        if has_control(new_text) {
            return fail(at("new_text"));
        }
        let length = new_text.chars().count() as u64;
        let max_chars = int(field(q, "max_chars"), &at("max_chars"), 1, 20000)?;
        if length > max_chars {
            return fail(at("new_text"));
        }
        let start = int(field(q, "start"), &at("start"), 0, MAX_SAFE_INTEGER)?;
        let end = int(field(q, "end"), &at("end"), 0, MAX_SAFE_INTEGER)?;
        if start > end {
            return fail(p);
        }
        changes.push(object(vec![
            ("occurrence_id", Value::from(id)),
            (
                "copy",
                Value::from(int(field(q, "copy"), &at("copy"), 0, 15)?),
            ),
            (
                "profile_id",
                nullable_str(field(q, "profile_id"), &at("profile_id"), 0)?,
            ),
            (
                "paragraph_id",
                Value::from(str_(
                    field(q, "paragraph_id"),
                    &at("paragraph_id"),
                    0,
                    NO_MAX,
                )?),
            ),
            (
                "section",
                Value::from(int(
                    field(q, "section"),
                    &at("section"),
                    0,
                    MAX_SAFE_INTEGER,
                )?),
            ),
            ("indices", indices(field(q, "indices"), &at("indices"))?),
            (
                "row",
                nullable_int(field(q, "row"), &at("row"), MAX_SAFE_INTEGER)?,
            ),
            (
                "col",
                nullable_int(field(q, "col"), &at("col"), MAX_SAFE_INTEGER)?,
            ),
            ("start", Value::from(start)),
            ("end", Value::from(end)),
            ("old_text", Value::from(old_text)),
            ("new_text", Value::from(new_text)),
            ("max_chars", Value::from(max_chars)),
            (
                "allow_reflow",
                Value::from(bool_(field(q, "allow_reflow"), &at("allow_reflow"))?),
            ),
        ]));
    }
    // Warning strings are checked, then dropped: native diagnostics may
    // contain local paths.
    for warning in arr(field(o, "native_warnings"), "native_warnings", NO_MAX)? {
        str_(warning, "native_warnings[]", 0, NO_MAX)?;
    }
    Ok(object(vec![
        ("version", Value::from(1)),
        (
            "source_sha256",
            Value::from(hash(field(o, "source_sha256"), "source_sha256")?),
        ),
        (
            "plan_sha256",
            Value::from(hash(field(o, "plan_sha256"), "plan_sha256")?),
        ),
        (
            "values_sha256",
            Value::from(hash(field(o, "values_sha256"), "values_sha256")?),
        ),
        ("copies", Value::Array(copies)),
        ("changes", Value::Array(changes)),
        ("native_warnings", Value::Array(Vec::new())),
    ]))
}

#[cfg(test)]
#[path = "parity_tests.rs"]
mod parity_tests;
