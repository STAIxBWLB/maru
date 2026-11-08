//! Shared document contracts and independently implemented scalar rules.
use crate::Diagnostic;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};

pub type Point = [f64; 2];
pub const COMPONENT_TYPES: &[&str] = &[
    "frontend",
    "backend",
    "database",
    "cloud",
    "security",
    "messagebus",
    "external",
];
pub const VARIANTS: &[&str] = &["default", "emphasis", "security", "dashed"];
pub const SIDES: &[&str] = &["left", "right", "top", "bottom"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "typegen", ts(rename = "ArchitectureMeta"))]
pub struct Meta {
    pub title: String,
    pub output: String,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub locale: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub translations: Option<BTreeMap<String, String>>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub subtitle: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub animation: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub visual_preset: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub quality_profile: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub engineering_profile: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub column_fit: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub repository: Option<Repository>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub views: Option<Vec<GuidedView>>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub legend: Option<Legend>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    #[serde(rename = "viewBox")]
    pub view_box: Option<Point>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[serde(deny_unknown_fields)]
pub struct Repository {
    pub url: String,
    pub revision: String,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub provider: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub link_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[serde(deny_unknown_fields)]
pub struct GuidedView {
    pub id: String,
    pub label: String,
    pub focus: Vec<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[serde(deny_unknown_fields)]
pub struct Legend {
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub mode: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub entries: Option<BTreeMap<String, LegendEntry>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[serde(deny_unknown_fields)]
pub struct LegendEntry {
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub label: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub visible: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[serde(deny_unknown_fields)]
pub struct Card {
    pub dot: String,
    pub title: String,
    pub items: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
pub struct Decoration {
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub sublabel: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub tag: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub icon: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub brand: Option<Brand>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub sources: Option<Vec<SourceReference>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[serde(deny_unknown_fields)]
pub struct PinnedBrand {
    pub url: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[serde(deny_unknown_fields)]
pub struct SourceReference {
    pub path: String,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub line: Option<f64>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub end_line: Option<f64>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
pub enum Brand {
    Name(String),
    Pinned(PinnedBrand),
}

pub(crate) struct Context {
    pub kind: &'static str,
    diagnostics: Vec<Diagnostic>,
}
impl Context {
    pub fn new(kind: &'static str) -> Self {
        Self {
            kind,
            diagnostics: Vec::new(),
        }
    }
    pub fn error(
        &mut self,
        rule: &str,
        path: &str,
        message: impl Into<String>,
        fix: impl Into<String>,
    ) {
        let (code, identifier) = crate::rules::qualified(self.kind, rule);
        self.diagnostics.push(Diagnostic {
            code,
            path: if path.is_empty() {
                "/".into()
            } else {
                path.into()
            },
            rule: identifier,
            message: message.into(),
            fix: fix.into(),
        });
    }
    pub fn finish(self) -> Vec<Diagnostic> {
        self.diagnostics
    }
    pub fn fields(&mut self, value: &Value, path: &str, allowed: &[&str]) {
        if let Some(object) = value.as_object() {
            for key in object.keys() {
                if !allowed.contains(&key.as_str()) {
                    self.error(
                        "unknown-field",
                        &pointer(path, key),
                        format!("field {key:?} is not supported at {path}"),
                        "remove the unsupported field or use the matching diagram type",
                    );
                }
            }
        } else {
            self.error(
                "shape",
                path,
                "an object is required",
                "replace this value with the documented object fields",
            );
        }
    }
    pub fn insert_id(&mut self, ids: &mut HashSet<String>, id: &str, path: &str) {
        self.id(id, path);
        if !ids.insert(id.into()) {
            self.error(
                "duplicate-id",
                path,
                format!("ID {id:?} occurs more than once"),
                "give each entry in this collection a unique ID",
            );
        }
    }
    pub fn id(&mut self, id: &str, path: &str) {
        if !valid_id(id) {
            self.error(
                "id",
                path,
                format!("ID {id:?} is not an ASCII identifier"),
                "start the ID with a letter and use only letters, digits, underscores or hyphens",
            );
        }
    }
    pub fn reference(&mut self, id: &str, ids: &HashSet<String>, path: &str, rule: &str) {
        self.id(id, path);
        if !ids.contains(id) {
            self.error(
                rule,
                path,
                format!("reference {id:?} does not identify an existing entry"),
                "choose an existing ID or add the referenced entry",
            );
        }
    }
    pub fn text(&mut self, value: &str, min: usize, max: Option<usize>, path: &str) {
        let count = value.chars().count();
        if count < min || max.is_some_and(|limit| count > limit) {
            self.error(
                "text",
                path,
                format!("text length {count} is outside the supported bounds"),
                format!(
                    "use at least {min} characters{}",
                    max.map(|m| format!(" and at most {m}")).unwrap_or_default()
                ),
            );
        }
    }
    pub fn range(&mut self, value: f64, min: Option<f64>, max: Option<f64>, path: &str) {
        if !value.is_finite() || min.is_some_and(|n| value < n) || max.is_some_and(|n| value > n) {
            self.error(
                "range",
                path,
                format!("number {value} is outside the supported bounds"),
                match (min, max) {
                    (Some(lo), Some(hi)) => format!("use a finite value between {lo} and {hi}"),
                    (Some(lo), None) => format!("use a finite value at least {lo}"),
                    (None, Some(hi)) => format!("use a finite value at most {hi}"),
                    (None, None) => "use a finite numeric value".into(),
                },
            );
        }
    }
    pub fn enum_value(&mut self, value: &str, values: &[&str], path: &str) {
        if !values.contains(&value) {
            self.error(
                "enum",
                path,
                format!("value {value:?} is not supported"),
                format!("choose one of {}", values.join(", ")),
            );
        }
    }
    pub fn integer(&mut self, value: f64, min: Option<f64>, max: Option<f64>, path: &str) {
        if value.fract() != 0.0 {
            self.error(
                "integer",
                path,
                "an integer is required",
                "use a whole number at this field",
            );
        }
        self.range(value, min, max, path);
    }
    pub fn cardinality(&mut self, len: usize, min: usize, path: &str) {
        if len < min {
            self.error(
                "cardinality",
                path,
                format!("collection has {len} entries but needs at least {min}"),
                format!("add entries until this collection has at least {min}"),
            );
        }
    }
}
pub(crate) fn pointer(parent: &str, key: &str) -> String {
    format!("{}/{}", parent, key.replace('~', "~0").replace('/', "~1"))
}
pub(crate) fn valid_id(value: &str) -> bool {
    let mut chars = value.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
}
pub(crate) fn decode<T: DeserializeOwned>(value: &Value, ctx: &mut Context) -> Option<T> {
    decode_at(value, "", ctx)
}
fn decode_at<T: DeserializeOwned>(value: &Value, prefix: &str, ctx: &mut Context) -> Option<T> {
    let mut normalized = value.clone();
    normalize_integrals(&mut normalized);
    match serde_path_to_error::deserialize(normalized) {
        Ok(result) => Some(result),
        Err(error) => {
            let mut path = prefix.to_string();
            for part in error.path().iter() {
                match part {
                    serde_path_to_error::Segment::Seq { index } => {
                        path = pointer(&path, &index.to_string())
                    }
                    serde_path_to_error::Segment::Map { key } => path = pointer(&path, key),
                    serde_path_to_error::Segment::Enum { variant } => {
                        path = pointer(&path, variant)
                    }
                    _ => {}
                }
            }
            ctx.error(
                "shape",
                &path,
                format!("document field has the wrong shape: {}", error.inner()),
                "supply the required fields with the documented JSON types",
            );
            None
        }
    }
}
// JSON Schema treats 1.0 as an integer; serde's integer visitor does not.
// Normalize only integral floating-point lexemes, preserving integer numbers.
fn normalize_integrals(value: &mut Value) {
    match value {
        Value::Number(n) if n.is_f64() => {
            if let Some(x) = n.as_f64() {
                if x.fract() == 0.0 && x >= 0.0 && x < u64::MAX as f64 {
                    *value = Value::from(x as u64);
                } else if x.fract() == 0.0 && x >= i64::MIN as f64 && x < 0.0 {
                    *value = Value::from(x as i64);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(normalize_integrals),
        Value::Object(items) => items.values_mut().for_each(normalize_integrals),
        _ => {}
    }
}
fn nulls(value: &Value, path: &str, ctx: &mut Context) {
    match value {
        Value::Null => ctx.error(
            "shape",
            path,
            "null is not a valid document field value",
            "omit the optional field or supply its documented non-null value",
        ),
        Value::Array(items) => {
            for (i, item) in items.iter().enumerate() {
                nulls(item, &pointer(path, &i.to_string()), ctx)
            }
        }
        Value::Object(items) => {
            for (key, item) in items {
                nulls(item, &pointer(path, key), ctx)
            }
        }
        _ => {}
    }
}
fn portable_output(path: &str) -> bool {
    !path.is_empty()
        && path
            .rsplit('/')
            .next()
            .and_then(|name| name.rsplit_once('.'))
            .is_some_and(|(stem, ext)| !stem.is_empty() && ext.eq_ignore_ascii_case("html"))
        && !path
            .chars()
            .any(|c| c.is_control() || "\\<>:\"|?*".contains(c))
        && path.split('/').all(|part| {
            if part.is_empty()
                || part == "."
                || part == ".."
                || part.ends_with(['.', ' '])
                || part.len() > 255
                || part.encode_utf16().count() > 255
            {
                return false;
            }
            let stem = part.split('.').next().unwrap_or("").to_uppercase();
            let device = matches!(
                stem.as_str(),
                "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
            ) || ["COM", "LPT"].iter().any(|p| {
                stem.strip_prefix(p).is_some_and(|n| {
                    matches!(
                        n,
                        "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                    )
                })
            });
            let alias = part.split('.').any(|segment| {
                segment.rsplit_once('~').is_some_and(|(_, tail)| {
                    !tail.is_empty()
                        && !tail.starts_with('0')
                        && tail.bytes().all(|b| b.is_ascii_digit())
                })
            });
            !device && !alias
        })
}
pub(crate) fn base(
    value: &Value,
    kind: &'static str,
    top_fields: &[&str],
    meta_extras: &[&str],
    min_viewbox: (f64, f64),
) -> Context {
    let mut ctx = Context::new(kind);
    ctx.fields(value, "", top_fields);
    nulls(value, "", &mut ctx);
    let versions: &[f64] = if matches!(kind, "workflow" | "lifecycle") {
        &[1.0, 2.0]
    } else {
        &[1.0]
    };
    if !value
        .get("schema_version")
        .and_then(Value::as_f64)
        .is_some_and(|n| versions.contains(&n))
    {
        let supported = if versions.len() == 2 { "1 or 2" } else { "1" };
        ctx.error(
            "schema-version",
            "/schema_version",
            "this document schema version is not supported",
            format!("use schema_version {supported} for {kind} or migrate the document first"),
        );
    }
    if value.get("diagram_type").and_then(Value::as_str) != Some(kind) {
        ctx.error(
            "diagram-type",
            "/diagram_type",
            "the diagram type does not match this validator",
            "select the validator matching diagram_type",
        );
    }
    let raw = &value["meta"];
    let mut allowed = vec![
        "title",
        "output",
        "locale",
        "translations",
        "subtitle",
        "animation",
        "visual_preset",
        "quality_profile",
        "repository",
        "views",
        "legend",
        "viewBox",
    ];
    allowed.extend_from_slice(meta_extras);
    ctx.fields(raw, "/meta", &allowed);
    if let Some(meta) = decode_at::<Meta>(raw, "/meta", &mut ctx) {
        validate_meta(&meta, raw, min_viewbox, &mut ctx);
    }
    if let Some(cards) = value.get("cards") {
        if let Some(cards) = decode_at::<Vec<Card>>(cards, "/cards", &mut ctx) {
            for (i, card) in cards.iter().enumerate() {
                let p = format!("/cards/{i}");
                ctx.fields(&value["cards"][i], &p, &["dot", "title", "items"]);
                ctx.enum_value(
                    &card.dot,
                    &[
                        "cyan", "emerald", "violet", "amber", "rose", "orange", "slate",
                    ],
                    &format!("{p}/dot"),
                );
                ctx.text(&card.title, 1, None, &format!("{p}/title"));
            }
        }
    }
    ctx
}
fn validate_meta(meta: &Meta, raw: &Value, min_viewbox: (f64, f64), ctx: &mut Context) {
    ctx.text(&meta.title, 1, None, "/meta/title");
    if !portable_output(&meta.output) {
        ctx.error("output-path","/meta/output","output is not a portable relative HTML path","use an HTML filename with safe relative path segments, no traversal, device names or trailing dots/spaces");
    }
    if let Some(locale) = &meta.locale {
        let parts: Vec<_> = locale.split('-').collect();
        if locale.len() > 35
            || !(2..=3).contains(&parts[0].len())
            || !parts[0].bytes().all(|b| b.is_ascii_lowercase())
            || parts.iter().skip(1).any(|p| {
                !(2..=8).contains(&p.len()) || !p.bytes().all(|b| b.is_ascii_alphanumeric())
            })
        {
            ctx.error(
                "locale",
                "/meta/locale",
                "locale is not a supported language tag",
                "use a two/three-letter lowercase language plus optional 2-8 character subtags",
            );
        }
    }
    for (value, options, path) in [
        (&meta.animation, &["trace", "none"][..], "animation"),
        (
            &meta.visual_preset,
            &["classic", "signal-flow", "blueprint", "editorial"][..],
            "visual_preset",
        ),
        (
            &meta.quality_profile,
            &["standard", "showcase"][..],
            "quality_profile",
        ),
        (
            &meta.engineering_profile,
            &["deployment-ownership"][..],
            "engineering_profile",
        ),
        (&meta.column_fit, &["fixed", "spread"][..], "column_fit"),
    ] {
        if let Some(v) = value {
            ctx.enum_value(v, options, &format!("/meta/{path}"));
        }
    }
    if let Some(point) = meta.view_box {
        ctx.range(point[0], Some(min_viewbox.0), None, "/meta/viewBox/0");
        ctx.range(point[1], Some(min_viewbox.1), None, "/meta/viewBox/1");
    }
    if let Some(map) = &meta.translations {
        for (key, value) in map {
            let p = pointer("/meta/translations", key);
            if !key.split('.').all(|s| {
                s.as_bytes().first().is_some_and(|b| b.is_ascii_lowercase())
                    && s.bytes().all(|b| b.is_ascii_alphanumeric())
            }) || value.is_empty()
                || value.chars().count() > 400
                || map.len() > 600
            {
                ctx.error("translations",&p,"translation key/value or collection size is invalid","use dotted lower-leading alphanumeric keys, nonempty values up to 400 characters and at most 600 entries");
            }
        }
    }
    if let Some(repo) = &meta.repository {
        ctx.fields(
            &raw["repository"],
            "/meta/repository",
            &["url", "revision", "provider", "link_mode"],
        );
        ctx.text(&repo.url, 1, None, "/meta/repository/url");
        if repo.revision.len() != 40 || !repo.revision.bytes().all(|b| b.is_ascii_hexdigit()) {
            ctx.error(
                "repository",
                "/meta/repository/revision",
                "repository revision is not a full commit hash",
                "pin a full 40-character hexadecimal commit hash",
            );
        }
        if let Some(v) = &repo.provider {
            ctx.enum_value(v, &["github", "gitee"], "/meta/repository/provider");
        }
        if let Some(v) = &repo.link_mode {
            ctx.enum_value(v, &["web", "local-only"], "/meta/repository/link_mode");
        }
    }
    if let Some(views) = &meta.views {
        if views.len() > 5 {
            ctx.error(
                "views",
                "/meta/views",
                "more than five guided views are present",
                "keep at most five guided views",
            );
        }
        for (i, view) in views.iter().enumerate() {
            let p = format!("/meta/views/{i}");
            ctx.fields(&raw["views"][i], &p, &["id", "label", "focus", "note"]);
            ctx.id(&view.id, &format!("{p}/id"));
            ctx.text(&view.label, 1, Some(48), &format!("{p}/label"));
            ctx.cardinality(view.focus.len(), 1, &format!("{p}/focus"));
            for (j, id) in view.focus.iter().enumerate() {
                ctx.id(id, &format!("{p}/focus/{j}"));
            }
            if let Some(note) = &view.note {
                ctx.text(note, 0, Some(140), &format!("{p}/note"));
            }
        }
    }
    if let Some(legend) = &meta.legend {
        ctx.fields(&raw["legend"], "/meta/legend", &["mode", "entries"]);
        if let Some(mode) = &legend.mode {
            ctx.enum_value(mode, &["auto", "all", "hidden"], "/meta/legend/mode");
        }
        if let Some(entries) = &legend.entries {
            let keys = match ctx.kind {
                "sequence" => vec!["default", "emphasis", "security", "dashed", "return"],
                "dataflow" => vec!["default", "emphasis", "security", "dashed", "database"],
                "lifecycle" => vec![
                    "start", "active", "waiting", "decision", "success", "failure", "neutral",
                    "external",
                ],
                _ => COMPONENT_TYPES.to_vec(),
            };
            for (key, entry) in entries {
                let p = pointer("/meta/legend/entries", key);
                ctx.enum_value(key, &keys, &p);
                ctx.fields(&raw["legend"]["entries"][key], &p, &["label", "visible"]);
                if entry.label.is_none() && entry.visible.is_none() {
                    ctx.error(
                        "legend",
                        &p,
                        "legend entry has no label or visibility setting",
                        "set label or visible, or remove this entry",
                    );
                }
                if let Some(label) = &entry.label {
                    ctx.text(label, 1, Some(80), &format!("{p}/label"));
                }
            }
        }
    }
}
// Guided views use schema identifiers. Missing focus targets are tolerated by
// the pinned viewer, so E1 checks syntax, not an invented existence constraint.
pub(crate) fn validate_meta_refs(meta: &Meta, _ids: &HashSet<String>, ctx: &mut Context) {
    if let Some(views) = &meta.views {
        for (i, view) in views.iter().enumerate() {
            for (j, id) in view.focus.iter().enumerate() {
                ctx.id(id, &format!("/meta/views/{i}/focus/{j}"));
            }
        }
    }
}
pub(crate) fn validate_decoration(item: &Decoration, path: &str, ctx: &mut Context) {
    if let Some(icon) = &item.icon {
        ctx.enum_value(
            icon,
            &[
                "calendar",
                "clock",
                "person",
                "briefcase",
                "flag",
                "moon",
                "frontend",
                "backend",
                "database",
                "cloud",
                "security",
                "messagebus",
                "external",
                "start",
                "active",
                "waiting",
                "success",
                "failure",
                "neutral",
                "none",
            ],
            &format!("{path}/icon"),
        );
    }
    if let Some(brand) = &item.brand {
        match brand {
            Brand::Name(name) => {
                let len = name.chars().count();
                if len == 0
                    || len > 2048
                    || !((len <= 80 && !name.contains(['\r', '\n']))
                        || name.starts_with("http://")
                        || name.starts_with("https://"))
                {
                    ctx.error("brand",&format!("{path}/brand"),"brand is not a short name or HTTP(S) URL","use a one-line brand name up to 80 characters or an HTTP(S) URL up to 2048 characters");
                }
            }
            Brand::Pinned(pin) => {
                if !(8..=2048).contains(&pin.url.chars().count())
                    || !(pin.url.starts_with("http://") || pin.url.starts_with("https://"))
                    || pin.sha256.len() != 64
                    || !pin
                        .sha256
                        .bytes()
                        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                {
                    ctx.error(
                        "brand",
                        &format!("{path}/brand"),
                        "pinned brand URL/hash is invalid",
                        "provide an HTTP(S) URL and a lowercase 64-character SHA-256 hash",
                    );
                }
            }
        }
    }
    if let Some(sources) = &item.sources {
        if !(1..=3).contains(&sources.len()) {
            ctx.error(
                "sources",
                &format!("{path}/sources"),
                "source references must have one to three entries",
                "keep one to three source references or omit the field",
            );
        }
        for (i, source) in sources.iter().enumerate() {
            let p = format!("{path}/sources/{i}");
            ctx.text(&source.path, 1, Some(240), &format!("{p}/path"));
            if let Some(n) = source.line {
                ctx.integer(n, Some(1.0), None, &format!("{p}/line"));
            }
            if let Some(n) = source.end_line {
                ctx.integer(n, Some(1.0), None, &format!("{p}/end_line"));
            }
            if let Some(label) = &source.label {
                ctx.text(label, 1, Some(48), &format!("{p}/label"));
            }
        }
    }
}
#[cfg(feature = "typegen")]
pub fn declarations(cfg: &ts_rs::Config) -> Vec<String> {
    use ts_rs::TS;
    vec![
        Meta::decl(cfg),
        Repository::decl(cfg),
        GuidedView::decl(cfg),
        Legend::decl(cfg),
        LegendEntry::decl(cfg),
        Card::decl(cfg),
        Decoration::decl(cfg),
        Brand::decl(cfg),
        PinnedBrand::decl(cfg),
        SourceReference::decl(cfg),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn portable_outputs_keep_schema_segment_rules() {
        assert!(!portable_output(&format!("{}.html", "가".repeat(90))));
        for value in ["map.html", "nested/map.HTML", "한글.html"] {
            assert!(portable_output(value), "{value}");
        }
        for value in [
            ".html",
            "../map.html",
            "con.html",
            "foo.b~1.html",
            "tail./map.html",
            "map.txt",
        ] {
            assert!(!portable_output(value), "{value}");
        }
    }
    #[test]
    fn float_integer_lexemes_are_decoded_without_an_extra_integer_limit() {
        let value: Value = serde_json::from_str("1.0").unwrap();
        let mut ctx = Context::new("architecture");
        let n: Option<u32> = decode(&value, &mut ctx);
        assert_eq!(n, Some(1));
        assert!(ctx.finish().is_empty());
    }
}
