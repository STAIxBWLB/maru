//! Absolute-path redaction for edit reports that leave the host (maru#620),
//! following hwp-editor's `withoutPaths` (packages/core/src/insertion-refusals.ts
//! at b96b2e5): the stage dir becomes `<work dir>`, then every absolute path,
//! POSIX or Windows, becomes `<path>`. A path may hold spaces, so a quoted path
//! runs to its closing quote, and an unquoted one runs to a known file
//! extension on the same line (spaces and Hangul included, as in
//! `/Users/홍 길동/x.png`), else to the next delimiter plus any following words
//! that still hold a separator. Such a tail word holding Hangul ends the path,
//! so Korean prose after a path stays.

/// Extensions a path is allowed to run to across spaces (upstream `PATH_END`).
const EXTENSIONS: &[&str] = &[
    "hwpx", "hwp", "json", "png", "jpg", "jpeg", "gif", "bmp", "svg", "pdf", "md", "txt", "xml",
    "hwpt",
];

fn is_hangul(ch: char) -> bool {
    matches!(ch, '\u{1100}'..='\u{11FF}' | '\u{3130}'..='\u{318F}' | '\u{AC00}'..='\u{D7AF}')
}

/// A character that may precede a path (upstream `(^|[\s(\[{:])`).
fn opens_path(previous: Option<char>) -> bool {
    match previous {
        None => true,
        Some(ch) => ch.is_whitespace() || matches!(ch, '(' | '[' | '{' | ':' | '"' | '\''),
    }
}

/// The length in chars of the absolute-path root at `chars[at..]`, if any
/// (upstream `PATH_ROOT`): `file://`, a UNC `\\host\` or `//host/`, a drive
/// `C:\` or `C:/`, or a POSIX `/` that starts a multi-segment path or names a
/// file with a known extension.
fn root_len(chars: &[char], at: usize) -> Option<usize> {
    let rest = &chars[at..];
    let starts = |prefix: &str| {
        let prefix: Vec<char> = prefix.chars().collect();
        rest.len() >= prefix.len() && rest[..prefix.len()] == prefix[..]
    };
    if starts("file:///") {
        return Some(8);
    }
    if starts("file://") {
        return Some(7);
    }
    if rest.len() >= 3
        && rest[0].is_ascii_alphabetic()
        && rest[1] == ':'
        && matches!(rest[2], '\\' | '/')
    {
        return Some(3);
    }
    if starts("\\\\") && segment_then(rest, 2, '\\') {
        return Some(2);
    }
    if starts("//") && segment_then(rest, 2, '/') {
        return Some(2);
    }
    if rest.first() == Some(&'/') {
        let segment: String = rest[1..]
            .iter()
            .take_while(|ch| !ch.is_whitespace() && !matches!(ch, '/' | '"' | '\''))
            .collect();
        if segment.is_empty() || segment.chars().any(is_hangul) {
            return None;
        }
        let after = 1 + segment.chars().count();
        if rest.get(after) == Some(&'/') || ends_with_extension(&segment) {
            return Some(1);
        }
    }
    None
}

/// A non-empty segment of non-space, non-separator chars followed by `separator`.
fn segment_then(rest: &[char], from: usize, separator: char) -> bool {
    let mut at = from;
    while at < rest.len() && !rest[at].is_whitespace() && rest[at] != separator {
        at += 1;
    }
    at > from && rest.get(at) == Some(&separator)
}

fn ends_with_extension(text: &str) -> bool {
    text.rsplit_once('.').is_some_and(|(stem, ext)| {
        !stem.is_empty()
            && EXTENSIONS
                .iter()
                .any(|known| ext.eq_ignore_ascii_case(known))
    })
}

/// The end (exclusive) of the path starting at `start` in `chars`.
fn path_end(chars: &[char], start: usize, quote: Option<char>) -> usize {
    if let Some(quote) = quote {
        // A quoted path runs through its closing quote (or the line's end).
        return chars[start..]
            .iter()
            .position(|ch| *ch == quote || *ch == '\n')
            .map_or(chars.len(), |offset| start + offset);
    }
    // Run to a known extension across spaces, if one comes before the line ends
    // and no quote intervenes.
    let line_end = chars[start..]
        .iter()
        .position(|ch| matches!(ch, '\n' | '"' | '\''))
        .map_or(chars.len(), |offset| start + offset);
    let mut best = None;
    let mut at = start;
    while at < line_end {
        if chars[at] == '.' {
            let word: String = chars[at + 1..line_end]
                .iter()
                .take_while(|ch| ch.is_ascii_alphanumeric())
                .collect();
            let boundary = chars
                .get(at + 1 + word.chars().count())
                .is_none_or(|ch| !ch.is_alphanumeric());
            if !word.is_empty()
                && boundary
                && EXTENSIONS
                    .iter()
                    .any(|known| word.eq_ignore_ascii_case(known))
            {
                best = Some(at + 1 + word.chars().count());
                break;
            }
        }
        at += 1;
    }
    if let Some(end) = best {
        return end;
    }
    // Otherwise: to the next delimiter, then any following space-separated
    // words that still hold a separator (`b/c/data`, `Files\Maru`).
    let mut end = start;
    while end < line_end
        && !chars[end].is_whitespace()
        && !matches!(chars[end], ')' | ']' | '}')
        && !(chars[end] == ':' && chars.get(end + 1).is_none_or(|next| next.is_whitespace()))
    {
        end += 1;
    }
    loop {
        if chars.get(end) != Some(&' ') {
            break;
        }
        let word_start = end + 1;
        let mut word_end = word_start;
        while word_end < line_end && !chars[word_end].is_whitespace() {
            word_end += 1;
        }
        let word = &chars[word_start..word_end];
        let has_separator = word.iter().any(|ch| matches!(ch, '/' | '\\'));
        let starts_with_separator = word.first().is_some_and(|ch| matches!(ch, '/' | '\\'));
        if word.is_empty()
            || !has_separator
            || starts_with_separator
            || word.iter().any(|ch| is_hangul(*ch))
        {
            break;
        }
        end = word_end;
    }
    end
}

/// `text` with the stage dir and every absolute path removed.
pub(crate) fn without_paths(text: &str, work_dir: &str) -> String {
    let text = if work_dir.is_empty() {
        text.to_string()
    } else {
        text.replace(work_dir, "<work dir>")
    };
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    while at < chars.len() {
        let previous = at.checked_sub(1).map(|index| chars[index]);
        if opens_path(previous) {
            if let Some(_len) = root_len(&chars, at) {
                let quote = previous.filter(|ch| matches!(ch, '"' | '\''));
                let end = path_end(&chars, at, quote).max(at + 1);
                out.push_str("<path>");
                at = end;
                continue;
            }
        }
        out.push(chars[at]);
        at += 1;
    }
    out
}

/// Object keys whose string values are user-valued identifiers, kept exact:
/// an anchor or style the user typed, and an issue's structured path.
const IDENTIFIER_KEYS: &[&str] = &["anchor", "style", "path"];

/// Redact every diagnostic string in `value`, recursively, keeping the strings
/// under identifier keys exact.
pub(crate) fn redact_value(value: &mut serde_json::Value, work_dir: &str) {
    match value {
        serde_json::Value::String(text) => *text = without_paths(text, work_dir),
        serde_json::Value::Array(items) => {
            for item in items {
                redact_value(item, work_dir);
            }
        }
        serde_json::Value::Object(map) => {
            for (key, item) in map.iter_mut() {
                if IDENTIFIER_KEYS.contains(&key.as_str()) {
                    continue;
                }
                redact_value(item, work_dir);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn posix_windows_unc_and_file_paths_are_redacted() {
        let cases = [
            (
                "cannot read /Users/yj/workspace/image.png now",
                "cannot read <path> now",
            ),
            ("cannot read /Users/홍 길동/x.png", "cannot read <path>"),
            (
                r"C:\Program Files (x86)\Maru\a.hwpx failed",
                "<path> failed",
            ),
            (r"open C:\Users\me\doc.hwp", "open <path>"),
            ("at C:/Users/me/doc.hwp", "at <path>"),
            (r"share \\server\share\a.txt gone", "share <path> gone"),
            ("url file:///tmp/x/a.json bad", "url <path> bad"),
            (
                "quoted \"/var/folders/a b/c.hwpx\" end",
                "quoted \"<path>\" end",
            ),
            ("list: /tmp/x/y, then", "list: <path> then"),
            ("dir /a/b c/d/e more", "dir <path> more"),
        ];
        for (input, expected) in cases {
            assert_eq!(without_paths(input, ""), expected, "{input}");
        }
    }

    #[test]
    fn prose_slashes_and_hangul_are_not_paths() {
        for text in [
            "적용되지 않은 편집 요청이 있습니다",
            "and/or either",
            "ratio 1/2",
            "/ alone",
            "a / b",
            "/한글/경로 처럼 보이는 글",
            "--replace \"absent string\"=>\"y\"",
        ] {
            assert_eq!(without_paths(text, ""), text, "{text}");
        }
    }

    #[test]
    fn the_work_dir_is_named_before_generic_redaction() {
        assert_eq!(
            without_paths("read /tmp/.stage/in.hwpx", "/tmp/.stage"),
            "read <work dir>/in.hwpx"
        );
    }

    #[test]
    fn nested_values_are_redacted_and_identifiers_kept() {
        let mut value = serde_json::json!({
            "message": "cannot read /Users/me/a.png",
            "values": {
                "anchor": "/Users/me/literal anchor",
                "style": r"C:\style-name",
                "issues": [{"path": ["/Users/x"], "message": r"bad D:\data\x.json"}],
                "unknown": {"deep": ["see /home/u/notes.txt"]}
            }
        });
        redact_value(&mut value, "");
        assert_eq!(value["message"], "cannot read <path>");
        assert_eq!(value["values"]["anchor"], "/Users/me/literal anchor");
        assert_eq!(value["values"]["style"], r"C:\style-name");
        assert_eq!(value["values"]["issues"][0]["path"][0], "/Users/x");
        assert_eq!(value["values"]["issues"][0]["message"], "bad <path>");
        assert_eq!(value["values"]["unknown"]["deep"][0], "see <path>");
    }
    /// Input/output pairs produced by hwp-editor's own `withoutPaths` at
    /// b96b2e5 (recorded by running it on these inputs), so this port is held
    /// to upstream behaviour rather than to a description of it.
    #[test]
    fn matches_upstream_without_paths() {
        let cases: &[(&str, &str)] = &[
            (
                "cannot read /Users/yj/workspace/image.png now",
                "cannot read <path> now",
            ),
            ("cannot read /Users/홍 길동/x.png", "cannot read <path>"),
            (
                "C:\\Program Files (x86)\\Maru\\a.hwpx failed",
                "<path> failed",
            ),
            ("open C:\\Users\\me\\doc.hwp", "open <path>"),
            ("at C:/Users/me/doc.hwp", "at <path>"),
            ("share \\\\server\\share\\a.txt gone", "share <path> gone"),
            ("url file:///tmp/x/a.json bad", "url <path> bad"),
            (
                "quoted \"/var/folders/a b/c.hwpx\" end",
                "quoted \"<path>\" end",
            ),
            ("list: /tmp/x/y, then", "list: <path> then"),
            ("dir /a/b c/d/e more", "dir <path> more"),
            (
                "적용되지 않은 편집 요청이 있습니다",
                "적용되지 않은 편집 요청이 있습니다",
            ),
            ("and/or either", "and/or either"),
            ("ratio 1/2", "ratio 1/2"),
            ("/ alone", "/ alone"),
            ("a / b", "a / b"),
            ("/한글/경로 처럼 보이는 글", "/한글/경로 처럼 보이는 글"),
            (
                "--replace \"absent string\"=>\"y\"",
                "--replace \"absent string\"=>\"y\"",
            ),
            (
                "anchor missing; input was /var/folders/zz/doc.hwpx",
                "anchor missing; input was <path>",
            ),
            (
                "cannot read C:\\Users\\someone\\Pictures\\a.png",
                "cannot read <path>",
            ),
            ("see /home/someone/notes.txt", "see <path>"),
            ("\\\\server\\share\\x.json", "<path>"),
            ("bad D:\\data\\x.json", "bad <path>"),
            (
                "출력 검증 실패 (대상: /tmp/a/out.hwp)",
                "출력 검증 실패 (대상: <path>)",
            ),
        ];
        for (input, expected) in cases {
            assert_eq!(&without_paths(input, ""), expected, "{input}");
        }
    }
}
