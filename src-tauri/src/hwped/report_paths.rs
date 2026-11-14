//! Absolute-path redaction for edit reports that leave the host (maru#620), a
//! port of hwp-editor's `withoutPaths` (packages/core/src/insertion-refusals.ts
//! at ce9d7e9). The same passes run in the same order:
//!
//! 1. the stage dir becomes `<work dir>`;
//! 2. a quoted path is redacted through its closing quote;
//! 3. on a line that opens with one of the engine's file heads
//!    (`FILE_LINE_HEAD`, where the engine prints `{path}: {error}`), the first
//!    path is redacted up to the next `: `;
//! 4. a path that reaches a known file extension, through its file name;
//! 5. any other path through its first space or delimiter, then any following
//!    space-separated words that still hold a separator.
//!
//! A replacement fires only where a path can start, so Korean prose with its
//! own slashes survives. `matches_upstream_without_paths` holds this port to
//! input/output pairs recorded by running the upstream function.

/// The engine's fixed IO heads (upstream `FILE_LINE_HEAD`, anchored at the
/// start of the text).
const FILE_LINE_HEADS: &[&str] = &[
    "입출력 오류: ",
    "HWPX 파일이 아닙니다 (",
    "XML 파싱 오류 (",
    "HWP 5.0 파일이 아닙니다 (",
    "압축 해제 실패 (",
    "레코드 구조가 손상되었습니다: ",
    "엔트리가 없습니다: ",
    "HWPX 패키지 무결성 오류: ",
    "FileHeader 시그니처가 올바르지 않습니다",
    "FileHeader 크기가 올바르지 않습니다 (",
    "스트림이 없습니다: ",
    "이미지 읽기 실패 ",
    "편집 연산 입력을 읽을 수 없습니다: ",
    "staged_native_readback 실패: ",
    "검증 재읽기 실패: ",
    "JSON IR 파싱 실패 (",
];

/// Extensions a path with spaces runs to (upstream `PATH_END`).
const EXTENSIONS: &[&str] = &[
    "hwpx", "hwp", "json", "png", "jpg", "jpeg", "gif", "bmp", "svg", "pdf", "md", "txt", "xml",
    "hwpt",
];

const PATH: &str = "<path>";

fn is_hangul(ch: char) -> bool {
    matches!(ch,
        '\u{1100}'..='\u{11FF}' | '\u{2E80}'..='\u{2EFF}' | '\u{3005}' | '\u{3021}'..='\u{3029}'
        | '\u{302E}' | '\u{302F}' | '\u{3131}'..='\u{318E}' | '\u{3200}'..='\u{321E}'
        | '\u{3260}'..='\u{327E}' | '\u{A960}'..='\u{A97C}' | '\u{AC00}'..='\u{D7A3}'
        | '\u{D7B0}'..='\u{D7C6}' | '\u{D7CB}'..='\u{D7FB}' | '\u{FFA0}'..='\u{FFBE}'
        | '\u{FFC2}'..='\u{FFC7}' | '\u{FFCA}'..='\u{FFCF}' | '\u{FFD2}'..='\u{FFD7}'
        | '\u{FFDA}'..='\u{FFDC}')
}

/// JS `\s` on the characters a report can carry.
fn is_space(ch: char) -> bool {
    ch.is_whitespace() || ch == '\u{FEFF}'
}

/// Length of a known extension (`.ext` plus a word boundary) at `at`.
fn extension_at(chars: &[char], at: usize) -> Option<usize> {
    if chars.get(at) != Some(&'.') {
        return None;
    }
    EXTENSIONS.iter().find_map(|ext| {
        let ext: Vec<char> = ext.chars().collect();
        let end = at + 1 + ext.len();
        let matches = chars.len() >= end
            && chars[at + 1..end]
                .iter()
                .zip(&ext)
                .all(|(a, b)| a.eq_ignore_ascii_case(b));
        // `\b`: the next char is not a word char (ASCII semantics in JS `\b`).
        let boundary = chars
            .get(end)
            .is_none_or(|ch| !(ch.is_ascii_alphanumeric() || *ch == '_'));
        (matches && boundary).then_some(1 + ext.len())
    })
}

/// Length of an absolute-path root at `at` (upstream `PATH_ROOT`), if any.
fn root_at(chars: &[char], at: usize) -> Option<usize> {
    let rest = &chars[at..];
    let starts = |prefix: &str| {
        let prefix: Vec<char> = prefix.chars().collect();
        rest.len() >= prefix.len() && rest[..prefix.len()] == prefix[..]
    };
    // file:\/\/\/?
    if starts("file://") {
        return Some(if rest.get(7) == Some(&'/') { 8 } else { 7 });
    }
    // (?<![A-Za-z]:)\/\/(?=[^\s/]+\/)
    if starts("//") {
        let after_drive = at >= 2 && chars[at - 1] == ':' && chars[at - 2].is_ascii_alphabetic();
        if !after_drive && followed_by_segment(rest, 2, |ch| ch != '/', '/') {
            return Some(2);
        }
    }
    // \\\\(?=[^\s\\]+\\)
    if starts("\\\\") && followed_by_segment(rest, 2, |ch| ch != '\\', '\\') {
        return Some(2);
    }
    // [A-Za-z]:[\\/]
    if rest.len() >= 3
        && rest[0].is_ascii_alphabetic()
        && rest[1] == ':'
        && matches!(rest[2], '\\' | '/')
    {
        return Some(3);
    }
    // \/(?=[^\s/"'\p{Hangul}]+\/) | \/(?=[^\s/"'\p{Hangul}]+PATH_END)
    if rest.first() == Some(&'/') {
        let segment_char =
            |ch: char| !is_space(ch) && !matches!(ch, '/' | '"' | '\'') && !is_hangul(ch);
        let mut end = 1;
        while end < rest.len() && segment_char(rest[end]) {
            end += 1;
        }
        if end > 1 {
            if rest.get(end) == Some(&'/') {
                return Some(1);
            }
            // Backtracking `+` then PATH_END: an extension ending inside or at
            // the end of the segment run.
            for split in (2..=end).rev() {
                if extension_at(rest, split).is_some() {
                    return Some(1);
                }
            }
        }
    }
    None
}

/// `(?=[^\s<sep>]+<sep>)` starting at `from`.
fn followed_by_segment(
    rest: &[char],
    from: usize,
    allowed: impl Fn(char) -> bool,
    separator: char,
) -> bool {
    let mut at = from;
    while at < rest.len() && !is_space(rest[at]) && allowed(rest[at]) {
        at += 1;
    }
    at > from && rest.get(at) == Some(&separator)
}

/// `(^|[\s(\[{:])` before `at`.
fn opens(chars: &[char], at: usize) -> bool {
    at == 0 || {
        let previous = chars[at - 1];
        is_space(previous) || matches!(previous, '(' | '[' | '{' | ':')
    }
}

/// Pass 2: `(["'])PATH_ROOT[^"'\n]*\1` becomes `$1<path>$1`.
fn quoted_pass(chars: &[char]) -> Vec<char> {
    let mut out = Vec::with_capacity(chars.len());
    let mut at = 0;
    while at < chars.len() {
        let quote = chars[at];
        if matches!(quote, '"' | '\'') && root_at(chars, at + 1).is_some() {
            let mut end = at + 1;
            while end < chars.len() && !matches!(chars[end], '"' | '\'' | '\n') {
                end += 1;
            }
            if chars.get(end) == Some(&quote) {
                out.push(quote);
                out.extend(PATH.chars());
                out.push(quote);
                at = end + 1;
                continue;
            }
        }
        out.push(chars[at]);
        at += 1;
    }
    out
}

/// Pass 3: on a file-head line, `(^|[\s(\[{:])PATH_ROOT[^\n"']*?(?=: )`, once.
fn file_head_pass(chars: &[char]) -> Vec<char> {
    let text: String = chars.iter().collect();
    if !FILE_LINE_HEADS.iter().any(|head| text.starts_with(head)) {
        return chars.to_vec();
    }
    for at in 0..chars.len() {
        if !opens(chars, at) {
            continue;
        }
        let Some(root) = root_at(chars, at) else {
            continue;
        };
        // Lazy `[^\n"']*?` then `(?=: )`.
        let mut end = at + root;
        loop {
            if chars.get(end) == Some(&':') && chars.get(end + 1) == Some(&' ') {
                let mut out = chars[..at].to_vec();
                out.extend(PATH.chars());
                out.extend_from_slice(&chars[end..]);
                return out;
            }
            match chars.get(end) {
                Some(ch) if !matches!(ch, '\n' | '"' | '\'') => end += 1,
                _ => break,
            }
        }
    }
    chars.to_vec()
}

/// Pass 4: `(^|[\s(\[{:])PATH_ROOT[^\n"']*?PATH_END`, global.
fn extension_pass(chars: &[char]) -> Vec<char> {
    let mut out = Vec::with_capacity(chars.len());
    let mut at = 0;
    while at < chars.len() {
        if opens(chars, at) {
            if let Some(root) = root_at(chars, at) {
                let mut end = at + root;
                let mut matched = None;
                loop {
                    if let Some(len) = extension_at(chars, end) {
                        matched = Some(end + len);
                        break;
                    }
                    match chars.get(end) {
                        Some(ch) if !matches!(ch, '\n' | '"' | '\'') => end += 1,
                        _ => break,
                    }
                }
                if let Some(end) = matched {
                    out.extend(PATH.chars());
                    at = end;
                    continue;
                }
            }
        }
        out.push(chars[at]);
        at += 1;
    }
    out
}

/// Pass 5: `(^|[\s(\[{:])PATH_ROOT(?:[^\s"')\]}:]|:(?!\s|$))*`, global.
fn delimiter_pass(chars: &[char]) -> Vec<char> {
    let mut out = Vec::with_capacity(chars.len());
    let mut at = 0;
    while at < chars.len() {
        if opens(chars, at) {
            if let Some(root) = root_at(chars, at) {
                let mut end = at + root;
                while let Some(&ch) = chars.get(end) {
                    let plain = !is_space(ch) && !matches!(ch, '"' | '\'' | ')' | ']' | '}' | ':');
                    let colon =
                        ch == ':' && chars.get(end + 1).is_some_and(|next| !is_space(*next));
                    if plain || colon {
                        end += 1;
                    } else {
                        break;
                    }
                }
                out.extend(PATH.chars());
                at = end;
                continue;
            }
        }
        out.push(chars[at]);
        at += 1;
    }
    out
}

/// Pass 6: `<path>(?: [^\s"'/\\\p{Hangul}]+[/\\](?:[^\s"'\p{Hangul}:]|:(?!\s|$))*)+`
/// collapses into `<path>`.
fn tail_pass(chars: &[char]) -> Vec<char> {
    let marker: Vec<char> = PATH.chars().collect();
    let mut out = Vec::with_capacity(chars.len());
    let mut at = 0;
    while at < chars.len() {
        if chars[at..].starts_with(&marker) {
            out.extend_from_slice(&marker);
            at += marker.len();
            // One or more ` word/tail` groups.
            loop {
                if chars.get(at) != Some(&' ') {
                    break;
                }
                let head_char = |ch: char| {
                    !is_space(ch) && !matches!(ch, '"' | '\'' | '/' | '\\') && !is_hangul(ch)
                };
                let mut head_end = at + 1;
                while head_end < chars.len() && head_char(chars[head_end]) {
                    head_end += 1;
                }
                if head_end == at + 1 || !matches!(chars.get(head_end), Some('/' | '\\')) {
                    break;
                }
                let mut end = head_end + 1;
                while let Some(&ch) = chars.get(end) {
                    let plain = !is_space(ch) && !matches!(ch, '"' | '\'' | ':') && !is_hangul(ch);
                    let colon =
                        ch == ':' && chars.get(end + 1).is_some_and(|next| !is_space(*next));
                    if plain || colon {
                        end += 1;
                    } else {
                        break;
                    }
                }
                at = end;
            }
            continue;
        }
        out.push(chars[at]);
        at += 1;
    }
    out
}

/// `text` with the stage dir and every absolute path removed, as upstream
/// `withoutPaths(text, workDir)` returns it.
pub(crate) fn without_paths(text: &str, work_dir: &str) -> String {
    let text = if work_dir.is_empty() {
        text.to_string()
    } else {
        text.replace(work_dir, "<work dir>")
    };
    let chars: Vec<char> = text.chars().collect();
    let chars = quoted_pass(&chars);
    let chars = file_head_pass(&chars);
    let chars = extension_pass(&chars);
    let chars = delimiter_pass(&chars);
    tail_pass(&chars).into_iter().collect()
}

// ---------------------------------------------------------------------------
// Schema-shaped sanitizing (upstream `parseEditReport` + `sanitizeEditReport`)
// ---------------------------------------------------------------------------

use serde_json::{Map, Value};

fn text(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_string)
}

fn nonempty(value: Option<&Value>) -> Option<String> {
    text(value).filter(|text| !text.trim().is_empty())
}

/// A non-negative safe integer (JS `Number.isSafeInteger(n) && n >= 0`).
fn count(value: Option<&Value>) -> Option<Value> {
    let number = value?.as_u64()?;
    (number < (1u64 << 53)).then(|| Value::from(number))
}

fn millimetres(value: Option<&Value>) -> Option<Value> {
    let number = value?.as_f64()?;
    (number.is_finite() && number >= 0.0)
        .then(|| value.cloned())
        .flatten()
}

fn is_segment_id(id: &str) -> bool {
    let Some((hash, chain)) = id.split_once('.') else {
        return false;
    };
    let indices: Vec<&str> = chain.split('.').collect();
    hash.len() == 16
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        && (1..=33).contains(&indices.len())
        && indices
            .iter()
            .all(|index| !index.is_empty() && index.bytes().all(|byte| byte.is_ascii_digit()))
}

fn segment(value: Option<&Value>) -> Option<Value> {
    match value? {
        Value::Null => Some(Value::Null),
        Value::String(id) if is_segment_id(id) => Some(Value::String(id.clone())),
        _ => None,
    }
}

/// Issue values: messages are diagnostics (redacted); `code`, the structured
/// `path` segments and widths are kept exact.
fn issue_values(values: &Map<String, Value>, work_dir: &str) -> Option<Value> {
    let issues = values.get("issues")?.as_array()?;
    if issues.is_empty() {
        return None;
    }
    let mut kept = Vec::with_capacity(issues.len());
    for issue in issues {
        let issue = issue.as_object()?;
        let path = issue
            .get("path")?
            .as_array()?
            .iter()
            .map(|part| match part {
                Value::String(_) => Some(part.clone()),
                other => count(Some(other)),
            })
            .collect::<Option<Vec<_>>>()?;
        let mut entry = Map::new();
        entry.insert("code".into(), Value::String(nonempty(issue.get("code"))?));
        entry.insert("path".into(), Value::Array(path));
        entry.insert(
            "message".into(),
            Value::String(without_paths(&text(issue.get("message"))?, work_dir)),
        );
        if let Some(width) = issue.get("measured_width_mm") {
            entry.insert("measured_width_mm".into(), millimetres(Some(width))?);
        }
        kept.push(Value::Object(entry));
    }
    let mut out = Map::new();
    out.insert("issues".into(), Value::Array(kept));
    out.insert(
        "container_width_mm".into(),
        millimetres(values.get("container_width_mm"))?,
    );
    Some(Value::Object(out))
}

/// A refusal reduced to the edit-report-v1 1.1 shape for its code, with its
/// diagnostics redacted. Typed anchors, styles and issue paths stay exact.
/// `None` for an unknown code or a value the schema does not allow.
fn refusal(raw: &Value, work_dir: &str) -> Option<Value> {
    let raw = raw.as_object()?;
    let code = raw.get("code")?.as_str()?;
    let values = raw.get("values")?.as_object()?;
    let message = without_paths(&text(raw.get("message"))?, work_dir);
    let mut kept = Map::new();
    match code {
        "range_tag_shift"
        | "section_owner_insert"
        | "section_owner_move"
        | "unapplied_requests"
        | "no_applicable_edits"
        | "unclassified" => {}
        "keep_together_unsupported" => {
            let requested = values
                .get("requested")?
                .as_array()?
                .iter()
                .map(|item| nonempty(Some(item)).map(Value::String))
                .collect::<Option<Vec<_>>>()?;
            if requested.is_empty() {
                return None;
            }
            kept.insert("op_index".into(), count(values.get("op_index"))?);
            kept.insert("requested".into(), Value::Array(requested));
        }
        "add_table.anchor_not_found" => {
            kept.insert("anchor".into(), Value::String(text(values.get("anchor"))?));
        }
        "insert_blocks.unknown_style" => {
            let missing = values.get("missing_style")?.as_str()?;
            if !matches!(missing, "create" | "refuse") {
                return None;
            }
            kept.insert(
                "style".into(),
                Value::String(nonempty(values.get("style"))?),
            );
            kept.insert("missing_style".into(), Value::String(missing.to_string()));
        }
        "insert_blocks.style_not_paragraph"
        | "insert_blocks.duplicate_style"
        | "insert_blocks.style_cycle" => {
            kept.insert(
                "style".into(),
                Value::String(nonempty(values.get("style"))?),
            );
        }
        "insert_blocks.style_id_overflow" => {
            kept.insert(
                "style".into(),
                Value::String(nonempty(values.get("style"))?),
            );
            kept.insert("style_id".into(), count(values.get("style_id"))?);
            kept.insert("max_style_id".into(), count(values.get("max_style_id"))?);
        }
        "insert_blocks.invalid_definition" => {
            if values.contains_key("issues") {
                kept = issue_values(values, work_dir)?.as_object()?.clone();
            } else {
                kept.insert(
                    "style".into(),
                    Value::String(nonempty(values.get("style"))?),
                );
                kept.insert(
                    "detail".into(),
                    Value::String(without_paths(&text(values.get("detail"))?, work_dir)),
                );
            }
        }
        "layout_overflow" | "insert_blocks.invalid_spec" => {
            kept = issue_values(values, work_dir)?.as_object()?.clone();
        }
        "preservation_loss" => {
            const RESOURCES: &[&str] = &[
                "container_stream",
                "container_storage",
                "package_entry",
                "control",
                "binary_asset",
                "relationship",
                "metadata",
            ];
            let events = values
                .get("events")?
                .as_array()?
                .iter()
                .map(|event| {
                    let event = event.as_object()?;
                    let resource = event.get("resource")?.as_str()?;
                    let disposition = event.get("disposition")?.as_str()?;
                    if !RESOURCES.contains(&resource)
                        || !matches!(
                            disposition,
                            "removed" | "changed_non_target" | "unrepresentable"
                        )
                    {
                        return None;
                    }
                    let total = count(event.get("count"))?;
                    if total.as_u64() == Some(0) {
                        return None;
                    }
                    let mut entry = Map::new();
                    entry.insert("code".into(), Value::String(nonempty(event.get("code"))?));
                    entry.insert("resource".into(), Value::String(resource.to_string()));
                    entry.insert("disposition".into(), Value::String(disposition.to_string()));
                    entry.insert("count".into(), total);
                    Some(Value::Object(entry))
                })
                .collect::<Option<Vec<_>>>()?;
            if events.is_empty() {
                return None;
            }
            kept.insert("events".into(), Value::Array(events));
        }
        _ => return None,
    }
    let mut out = Map::new();
    out.insert("code".into(), Value::String(code.to_string()));
    out.insert("values".into(), Value::Object(kept));
    out.insert("message".into(), Value::String(message));
    Some(Value::Object(out))
}

fn outcome(raw: &Value, work_dir: &str) -> Option<Value> {
    let raw = raw.as_object()?;
    let status = raw.get("status")?.as_str()?;
    if !matches!(status, "applied" | "failed") {
        return None;
    }
    let changed = raw
        .get("changed")?
        .as_array()?
        .iter()
        .map(|pair| {
            let pair = pair.as_object()?;
            let mut entry = Map::new();
            entry.insert("before".into(), segment(pair.get("before"))?);
            entry.insert("after".into(), segment(pair.get("after"))?);
            Some(Value::Object(entry))
        })
        .collect::<Option<Vec<_>>>()?;
    let reason = match raw.get("reason")? {
        Value::Null => Value::Null,
        Value::String(reason) => Value::String(without_paths(reason, work_dir)),
        _ => return None,
    };
    let mut out = Map::new();
    out.insert("index".into(), count(raw.get("index"))?);
    out.insert("op".into(), Value::String(text(raw.get("op"))?));
    out.insert("status".into(), Value::String(status.to_string()));
    out.insert("pieces_touched".into(), count(raw.get("pieces_touched"))?);
    out.insert("changed".into(), Value::Array(changed));
    if let Some(total) = raw.get("changed_total") {
        out.insert("changed_total".into(), count(Some(total))?);
    }
    if let Some(missing) = raw.get("missing_style") {
        let missing = missing.as_str()?;
        if !matches!(missing, "create" | "refuse") {
            return None;
        }
        out.insert("missing_style".into(), Value::String(missing.to_string()));
    }
    out.insert("reason".into(), reason);
    if let Some(raw_refusal) = raw.get("refusal") {
        out.insert("refusal".into(), refusal(raw_refusal, work_dir)?);
    }
    Some(Value::Object(out))
}

/// The report reduced to the edit-report-v1 shape, as upstream
/// `sanitizeEditReport(parseEditReport(raw), name, workDir)` returns it:
/// unknown fields are dropped, `output` becomes `name`, and only diagnostics
/// (op `reason`, refusal `message`, `values.detail`, issue `message`) are
/// redacted. `None` when the report is not edit-report-v1, as upstream's parser
/// would refuse it; the caller then keeps the legacy string.
pub(crate) fn sanitize_report(raw: &Value, name: &str, work_dir: &str) -> Option<Value> {
    let raw = raw.as_object()?;
    if raw.get("contract")?.as_str()? != "hwp-edit-report-v1" {
        return None;
    }
    let schema = raw.get("schema_version")?.as_str()?;
    let minor = schema.strip_prefix("1.")?;
    if minor.is_empty() || !minor.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let dry_run = raw.get("dry_run")?.as_bool()?;
    text(raw.get("output"))?;
    let ops = raw
        .get("ops")?
        .as_array()?
        .iter()
        .map(|op| outcome(op, work_dir))
        .collect::<Option<Vec<_>>>()?;
    let mut out = Map::new();
    out.insert("schema_version".into(), Value::String(schema.to_string()));
    out.insert(
        "contract".into(),
        Value::String("hwp-edit-report-v1".into()),
    );
    out.insert("output".into(), Value::String(name.to_string()));
    out.insert("dry_run".into(), Value::Bool(dry_run));
    out.insert("ops".into(), Value::Array(ops));
    out.insert("applied_count".into(), count(raw.get("applied_count"))?);
    out.insert("failed_count".into(), count(raw.get("failed_count"))?);
    if let Some(raw_refusal) = raw.get("refusal") {
        out.insert("refusal".into(), refusal(raw_refusal, work_dir)?);
    }
    Some(Value::Object(out))
}

#[cfg(test)]
#[path = "report_paths_tests.rs"]
mod tests;
