//! `without_paths` against hwp-editor's own `withoutPaths`: every expected
//! value below was recorded by running the upstream function (hwp-editor
//! ce9d7e9, packages/core/src/insertion-refusals.ts) on the same input and work
//! dir. Regenerate by running upstream again, never by hand.

use super::*;

/// (input, work dir, upstream output).
const UPSTREAM: &[(&str, &str, &str)] = &[
    ("cannot read /Users/홍 길동/x.png", "", "cannot read <path>"),
    (
        "C:\\Program Files (x86)\\Maru\\a.hwpx failed",
        "",
        "<path> failed",
    ),
    ("open C:\\Users\\me\\doc.hwp", "", "open <path>"),
    ("at C:/Users/me/doc.hwp", "", "at <path>"),
    (
        "share \\\\server\\share\\a.txt gone",
        "",
        "share <path> gone",
    ),
    ("url file:///tmp/x/a.json bad", "", "url <path> bad"),
    (
        "quoted \"/var/folders/a b/c.hwpx\" end",
        "",
        "quoted \"<path>\" end",
    ),
    ("list: /tmp/x/y, then", "", "list: <path> then"),
    ("dir /a/b c/d/e more", "", "dir <path> more"),
    (
        "적용되지 않은 편집 요청이 있습니다",
        "",
        "적용되지 않은 편집 요청이 있습니다",
    ),
    ("and/or either", "", "and/or either"),
    ("ratio 1/2", "", "ratio 1/2"),
    ("/ alone", "", "/ alone"),
    ("a / b", "", "a / b"),
    ("/한글/경로 처럼 보이는 글", "", "/한글/경로 처럼 보이는 글"),
    (
        "--replace \"absent string\"=>\"y\"",
        "",
        "--replace \"absent string\"=>\"y\"",
    ),
    (
        "anchor missing; input was /var/folders/zz/doc.hwpx",
        "",
        "anchor missing; input was <path>",
    ),
    (
        "cannot read C:\\Users\\someone\\Pictures\\a.png",
        "",
        "cannot read <path>",
    ),
    ("see /home/someone/notes.txt", "", "see <path>"),
    ("\\\\server\\share\\x.json", "", "<path>"),
    ("bad D:\\data\\x.json", "", "bad <path>"),
    (
        "출력 검증 실패 (대상: /tmp/a/out.hwp)",
        "",
        "출력 검증 실패 (대상: <path>)",
    ),
    (
        "입출력 오류: /Users/홍 길동/private.bin: permission denied",
        "",
        "입출력 오류: <path>: permission denied",
    ),
    ("입출력 오류: /Users/a b/c: x", "", "입출력 오류: <path>: x"),
    (
        "이미지 읽기 실패 /Users/홍 길동/pic.bin: 없음",
        "",
        "이미지 읽기 실패 <path>: 없음",
    ),
    (
        "편집 연산 입력을 읽을 수 없습니다: C:\\Program Files\\x\\ops: bad",
        "",
        "편집 연산 입력을 읽을 수 없습니다: <path>: bad",
    ),
    (
        "not a head /Users/홍 길동/private.bin: permission denied",
        "",
        "not a head <path> 길동/private.bin: permission denied",
    ),
    ("예산 /항목/세부", "", "예산 /항목/세부"),
    ("제목 / 부제", "", "제목 / 부제"),
    ("/in.hwpx failed", "", "<path> failed"),
    ("new /Users/a b c/d data", "", "new <path> b c/d data"),
    ("path 'C:\\a b\\c' ok", "", "path '<path>' ok"),
    ("mixed \"/x/y' z\"", "", "mixed \"/x/y' z\""),
    ("(/tmp/a/b) and [/tmp/c/d]", "", "(<path>) and [<path>]"),
    ("file://host/share/x.json", "", "<path>"),
    ("//host/share/x y", "", "<path> y"),
    ("C://host/x", "", "<path>"),
    ("x:/tmp/a/b", "", "<path>"),
    ("/tmp/a/b:c:d e", "", "<path> e"),
    ("/tmp/a/b: e", "", "<path>: e"),
    ("/tmp/a/b:", "", "<path>:"),
    (
        "work /stage/dir/in.hwpx",
        "/stage/dir",
        "work <work dir>/in.hwpx",
    ),
    ("<path> b/c/data 한글/x", "", "<path> 한글/x"),
    ("/a/b  c/d", "", "<path>  c/d"),
    ("/Users/x\ny/z", "", "<path>\ny/z"),
    // Han code points are not Script=Hangul, so a space-separated tail holding
    // them is a path tail upstream redacts (T124-R3.1).
    (
        "cannot read /Users/A 佐々木/private.bin",
        "",
        "cannot read <path>",
    ),
    (
        "/々/private.bin: permission denied",
        "",
        "<path>: permission denied",
    ),
    // A 2,812-input differential sweep against upstream `withoutPaths` at
    // hwp-editor ce9d7e9 diverged on these 87 inputs before the fix: JS `\s`
    // is not Rust's White_Space (U+0085 is one here, not there), and PATH_END
    // is case-sensitive. One representative per cause and direction; the
    // expected values are upstream's output, not retyped.
    (
        "cannot read /Users/A\u{85}B\u{85}C/private.bin",
        "",
        "cannot read <path>",
    ),
    (
        "입출력 오류: \u{85}/tmp/x.hwp\u{85}: bad",
        "",
        "입출력 오류: \u{85}/tmp/x.hwp\u{85}: bad",
    ),
    ("cannot read C:\\a\u{85}b", "", "cannot read <path>"),
    (
        "cannot read //host/share/a\u{85}b",
        "",
        "cannot read <path>",
    ),
    (
        "cannot read C:\\A B\u{85}NOTES.TXT",
        "",
        "cannot read <path> B\u{85}NOTES.TXT",
    ),
    ("cannot read /Users/A b/notes.TXT", "", "cannot read <path>"),
    (
        "cannot read C:/A B\u{feff}NOTES.TXT",
        "",
        "cannot read <path> B\u{feff}NOTES.TXT",
    ),
    (
        "cannot read C:\\A B\u{180e}NOTES.TXT",
        "",
        "cannot read <path> B\u{180e}NOTES.TXT",
    ),
    (
        "cannot read C:\\A B\u{200b}NOTES.TXT",
        "",
        "cannot read <path> B\u{200b}NOTES.TXT",
    ),
    (
        "cannot read C:\\A B\u{3000}NOTES.TXT",
        "",
        "cannot read <path> B\u{3000}NOTES.TXT",
    ),
    (
        "cannot read C:\\A B\u{2028}NOTES.TXT",
        "",
        "cannot read <path> B\u{2028}NOTES.TXT",
    ),
    (
        "cannot read C:\\A B\u{a0}NOTES.TXT",
        "",
        "cannot read <path> B\u{a0}NOTES.TXT",
    ),
];

#[test]
fn matches_upstream_without_paths() {
    for (input, work_dir, expected) in UPSTREAM {
        assert_eq!(&without_paths(input, work_dir), expected, "input {input:?}");
    }
}

#[test]
fn a_file_head_line_redacts_the_whole_path_up_to_its_colon() {
    // The reviewer's case: a username with a space and Hangul.
    assert_eq!(
        without_paths(
            "입출력 오류: /Users/홍 길동/private.bin: permission denied",
            ""
        ),
        "입출력 오류: <path>: permission denied"
    );
}

#[test]
fn count_mirrors_number_is_safe_integer() {
    use serde_json::json;
    // An integral float is a safe integer upstream (`0.0`, `2.0`), so the
    // report it appears in must not drop to the legacy string (T124-R3.2).
    assert_eq!(count(Some(&json!(0.0))), Some(json!(0)));
    assert_eq!(count(Some(&json!(2.0))), Some(json!(2)));
    assert_eq!(count(Some(&json!(3))), Some(json!(3)));
    assert_eq!(count(Some(&json!(-1.0))), None);
    assert_eq!(count(Some(&json!(-3))), None);
    assert_eq!(count(Some(&json!(1.5))), None);
    assert_eq!(count(Some(&json!(9_007_199_254_740_992.0))), None);
    assert_eq!(count(Some(&json!(9_007_199_254_740_992u64))), None);
    assert_eq!(count(Some(&json!("2"))), None);
    assert_eq!(count(None), None);
}

#[test]
fn an_integral_float_count_keeps_the_report_structured() {
    let report = serde_json::json!({
        "schema_version": "1.1",
        "contract": "hwp-edit-report-v1",
        "output": "/Users/someone/out.hwpx",
        "dry_run": false,
        "ops": [{
            "index": 0.0, "op": "replace_text", "status": "applied",
            "pieces_touched": 2.0, "changed": [], "reason": null
        }],
        "applied_count": 1.0,
        "failed_count": 0.0
    });
    let out = sanitize_report(&report, "out.hwpx", "").expect("a safe integer stays a report");
    assert_eq!(out["applied_count"], serde_json::json!(1));
    assert_eq!(out["failed_count"], serde_json::json!(0));
    assert_eq!(out["ops"][0]["index"], serde_json::json!(0));
    assert_eq!(out["ops"][0]["pieces_touched"], serde_json::json!(2));
}

#[test]
fn a_js_whitespace_only_style_name_is_empty() {
    use serde_json::json;
    // JS `trim` removes the `\s` set, which holds U+FEFF; Rust's `trim` keeps it,
    // so a U+FEFF-only style name passed here and is empty upstream (T124-R4.3).
    for blank in ["\u{feff}", "\u{3000}", "\u{a0}", " \t\n"] {
        assert_eq!(nonempty(Some(&json!(blank))), None, "{blank:?}");
    }
    // U+0085 is not `\s`, so it is not blank.
    assert_eq!(nonempty(Some(&json!("\u{85}"))), Some("\u{85}".to_string()));
    assert_eq!(nonempty(Some(&json!("한글"))), Some("한글".to_string()));
}
