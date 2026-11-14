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
