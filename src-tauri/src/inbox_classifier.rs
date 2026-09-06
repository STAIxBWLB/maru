// Phase 2 step 4.5: classifier on top of the Claude CLI bridge. Two pure
// Rust pieces — `build_inbox_classification_prompt` and
// `parse_inbox_classification` — wrapped as Tauri commands so the
// frontend can:
//
//   1. call `build_inbox_classification_prompt(item)` → prompt string
//   2. call `start_claude_cli_invocation(prompt)` (existing CLI bridge)
//   3. accumulate `ai://output` lines for that invocation
//   4. on `ai://done`, call `parse_inbox_classification(raw)` → Classification
//
// Keeping this split as two pure functions lets us unit-test the prompt
// shape and the parser independently of any subprocess. The Tauri
// roundtrip stays in the frontend, where it joins the existing AI
// invocation event stream.

use crate::inbox::InboxDropItem;
use serde::{Deserialize, Serialize};

/// Categories maru's inbox classifier emits. Frontend uses this to
/// drive folder routing + colour chips. Closed enum — anything Claude
/// returns outside this set is normalised to `noise`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Category {
    Task,
    Reference,
    Meeting,
    Admin,
    Noise,
}

impl Category {
    fn from_str_lossy(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "task" => Category::Task,
            "reference" => Category::Reference,
            "meeting" => Category::Meeting,
            "admin" => Category::Admin,
            _ => Category::Noise,
        }
    }

    fn as_str(&self) -> &'static str {
        match self {
            Category::Task => "task",
            Category::Reference => "reference",
            Category::Meeting => "meeting",
            Category::Admin => "admin",
            Category::Noise => "noise",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Classification {
    /// One of: task | reference | meeting | admin | noise.
    pub category: String,
    /// One short Korean sentence describing the item.
    pub summary: String,
    /// Vault-relative folder maru should propose. `None` for "ask user".
    pub suggested_folder: Option<String>,
    /// Best-effort due date / event date in RFC3339, or `None`.
    pub extracted_date: Option<String>,
}

/// Build the prompt maru sends to Claude for a single inbox file. The
/// instructions are deliberately strict: single-line JSON, no markdown
/// fences, closed category set. Robust parsing on the other side picks
/// up the slack when Claude wraps the JSON in fences anyway.
pub fn build_inbox_classification_prompt(item: InboxDropItem) -> String {
    let received_at = item.received_at.as_deref().unwrap_or("unknown");
    format!(
        "You are maru's inbox classifier. Classify the file below and return \
ONLY a single-line JSON object — no prose, no markdown fences.\n\n\
File: {rel_path}\nSource: {source}\nSize: {size} bytes\nFilename: {title}\nReceivedAt: {received}\n\n\
Return JSON with these keys:\n\
- \"category\": one of \"task\", \"reference\", \"meeting\", \"admin\", \"noise\".\n\
- \"summary\": one Korean sentence, max 80 chars.\n\
- \"suggestedFolder\": vault-relative folder path or null.\n\
- \"extractedDate\": RFC3339 timestamp or null.\n\n\
Decide based on filename + source. Do not invent fields.\n",
        rel_path = item.rel_path,
        source = item.source,
        size = item.size_bytes,
        title = item.title,
        received = received_at,
    )
}

/// Parse Claude's classification reply. Tolerates:
/// - leading/trailing whitespace
/// - ```json … ``` or ``` … ``` fences
/// - extra prose before the first `{` / after the last `}`
///
/// Unknown categories collapse to `noise`. Empty / non-string fields
/// surface as the typed `Option::None`.
pub fn parse_inbox_classification(raw: String) -> Result<Classification, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Classifier returned no output.".to_string());
    }
    let json_slice = extract_json_object(trimmed)
        .ok_or_else(|| "No JSON object found in classifier output.".to_string())?;

    let parsed: serde_json::Value = serde_json::from_str(json_slice)
        .map_err(|err| format!("Classifier JSON malformed: {err}"))?;

    let category_raw = parsed
        .get("category")
        .and_then(|v| v.as_str())
        .unwrap_or("noise");
    let summary = parsed
        .get("summary")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "분류기가 요약을 비웠습니다.".to_string());
    let suggested_folder = parsed
        .get("suggestedFolder")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let extracted_date = parsed
        .get("extractedDate")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    Ok(Classification {
        category: Category::from_str_lossy(category_raw).as_str().to_string(),
        summary,
        suggested_folder,
        extracted_date,
    })
}

fn extract_json_object(s: &str) -> Option<&str> {
    let start = s.find('{')?;
    let end = s.rfind('}')?;
    if end <= start {
        return None;
    }
    Some(&s[start..=end])
}

/// IPC owns classifier inputs and runs the synchronous helpers on a dedicated
/// blocking worker. The synchronous functions above remain available to Rust
/// callers and tests, while the wire command names stay unchanged through the
/// nested module registration in `lib.rs`.
pub mod ipc {
    use super::*;

    #[tauri::command]
    pub async fn build_inbox_classification_prompt(item: InboxDropItem) -> Result<String, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            super::phase08_10_hooks::stage("build_inbox_classification_prompt");
            super::build_inbox_classification_prompt(item)
        })
        .await
        .map_err(|error| format!("build_inbox_classification_prompt_task_failed: {error}"))
    }

    #[tauri::command]
    pub async fn parse_inbox_classification(raw: String) -> Result<Classification, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            super::phase08_10_hooks::stage("parse_inbox_classification");
            super::parse_inbox_classification(raw)
        })
        .await
        .map_err(|error| format!("parse_inbox_classification_task_failed: {error}"))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(title: &str, source: &str) -> InboxDropItem {
        InboxDropItem {
            id: format!("inbox/downloads/{source}/{title}"),
            path: format!("/v/inbox/downloads/{source}/{title}"),
            rel_path: format!("inbox/downloads/{source}/{title}"),
            title: title.to_string(),
            source: source.to_string(),
            size_bytes: 1024,
            received_at: Some("2026-04-28T09:00:00+09:00".to_string()),
        }
    }

    #[test]
    fn prompt_contains_filename_and_source_and_strict_json_instruction() {
        let prompt = build_inbox_classification_prompt(item("rise-budget.pdf", "gmail"));
        assert!(prompt.contains("rise-budget.pdf"));
        assert!(prompt.contains("Source: gmail"));
        assert!(prompt.contains("ONLY a single-line JSON"));
        assert!(prompt.contains("\"category\""));
        assert!(prompt.contains("\"suggestedFolder\""));
        assert!(prompt.contains("\"extractedDate\""));
    }

    #[test]
    fn parses_clean_single_line_json() {
        let raw = r#"{"category":"task","summary":"예산 검토 회신 필요","suggestedFolder":"projects/rise","extractedDate":null}"#;
        let result = parse_inbox_classification(raw.to_string()).unwrap();
        assert_eq!(result.category, "task");
        assert_eq!(result.summary, "예산 검토 회신 필요");
        assert_eq!(result.suggested_folder.as_deref(), Some("projects/rise"));
        assert_eq!(result.extracted_date, None);
    }

    #[test]
    fn parses_through_markdown_fences() {
        let raw = "```json\n{\"category\":\"meeting\",\"summary\":\"주간회의 의제\",\"suggestedFolder\":\"meetings/2026/2026-04\",\"extractedDate\":\"2026-04-30T10:00:00+09:00\"}\n```";
        let result = parse_inbox_classification(raw.to_string()).unwrap();
        assert_eq!(result.category, "meeting");
        assert_eq!(
            result.suggested_folder.as_deref(),
            Some("meetings/2026/2026-04"),
        );
        assert_eq!(
            result.extracted_date.as_deref(),
            Some("2026-04-30T10:00:00+09:00"),
        );
    }

    #[test]
    fn parses_with_leading_prose() {
        let raw = "Here is my classification:\n{\"category\":\"reference\",\"summary\":\"용어집 첨부\",\"suggestedFolder\":\"references\",\"extractedDate\":null}\nLet me know if you need more.";
        let result = parse_inbox_classification(raw.to_string()).unwrap();
        assert_eq!(result.category, "reference");
        assert_eq!(result.suggested_folder.as_deref(), Some("references"));
    }

    #[test]
    fn unknown_category_collapses_to_noise() {
        let raw =
            r#"{"category":"spam","summary":"광고","suggestedFolder":null,"extractedDate":null}"#;
        let result = parse_inbox_classification(raw.to_string()).unwrap();
        assert_eq!(result.category, "noise");
    }

    #[test]
    fn empty_summary_is_replaced_with_default() {
        let raw =
            r#"{"category":"admin","summary":"","suggestedFolder":null,"extractedDate":null}"#;
        let result = parse_inbox_classification(raw.to_string()).unwrap();
        assert_eq!(result.category, "admin");
        assert!(!result.summary.is_empty());
    }

    #[test]
    fn missing_summary_field_falls_back() {
        let raw = r#"{"category":"task"}"#;
        let result = parse_inbox_classification(raw.to_string()).unwrap();
        assert_eq!(result.category, "task");
        assert!(!result.summary.is_empty());
        assert_eq!(result.suggested_folder, None);
        assert_eq!(result.extracted_date, None);
    }

    #[test]
    fn empty_input_errors() {
        assert!(parse_inbox_classification(String::new()).is_err());
        assert!(parse_inbox_classification("   ".to_string()).is_err());
    }

    #[test]
    fn malformed_json_errors() {
        assert!(parse_inbox_classification("{ not json }".to_string()).is_err());
    }

    #[test]
    fn no_braces_errors() {
        assert!(parse_inbox_classification("Sorry, I cannot classify.".to_string()).is_err());
    }

    #[test]
    fn whitespace_only_folder_is_dropped() {
        let raw =
            r#"{"category":"reference","summary":"x","suggestedFolder":"   ","extractedDate":""}"#;
        let result = parse_inbox_classification(raw.to_string()).unwrap();
        assert_eq!(result.suggested_folder, None);
        assert_eq!(result.extracted_date, None);
    }
}

#[cfg(test)]
mod phase08_10_hooks {
    use std::sync::{Arc, Mutex, OnceLock};

    type Callback = Arc<dyn Fn() + Send + Sync>;

    static STAGES: OnceLock<Mutex<Vec<(u64, String, Callback)>>> = OnceLock::new();
    static TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

    fn stages() -> &'static Mutex<Vec<(u64, String, Callback)>> {
        STAGES.get_or_init(|| Mutex::new(Vec::new()))
    }

    pub(crate) fn lock() -> std::sync::MutexGuard<'static, ()> {
        TEST_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap()
    }

    pub(crate) struct StageHook(u64);

    impl StageHook {
        pub(crate) fn new(command: &str, callback: impl Fn() + Send + Sync + 'static) -> Self {
            let id = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            stages()
                .lock()
                .unwrap()
                .push((id, command.to_string(), Arc::new(callback)));
            Self(id)
        }
    }

    impl Drop for StageHook {
        fn drop(&mut self) {
            stages().lock().unwrap().retain(|(id, _, _)| *id != self.0);
        }
    }

    pub(crate) fn stage(command: &str) {
        let callbacks: Vec<_> = stages()
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, registered, _)| registered == command)
            .map(|(_, _, callback)| callback.clone())
            .collect();
        for callback in callbacks {
            callback();
        }
    }
}

#[cfg(test)]
mod phase08_10 {
    use super::*;
    use std::sync::{mpsc, Mutex};
    use std::thread;
    use std::time::Duration;

    fn fixture_item() -> InboxDropItem {
        InboxDropItem {
            id: "inbox/downloads/fixture/budget.pdf".to_string(),
            path: "/tmp/maru-phase08-10/inbox/downloads/fixture/budget.pdf".to_string(),
            rel_path: "inbox/downloads/fixture/budget.pdf".to_string(),
            title: "budget.pdf".to_string(),
            source: "fixture".to_string(),
            size_bytes: 2_048,
            received_at: Some("2026-09-05T10:00:00+09:00".to_string()),
        }
    }

    fn run<F>(future: F) -> F::Output
    where
        F: std::future::Future + Send + 'static,
        F::Output: Send + 'static,
    {
        let (tx, rx) = mpsc::channel();
        tauri::async_runtime::spawn(async move {
            let _ = tx.send(future.await);
        });
        rx.recv_timeout(Duration::from_secs(10))
            .expect("classifier fixture runtime completion")
    }

    #[test]
    fn phase08_10_actual_wrappers_return_nonempty_fixture_payloads() {
        let _test_guard = phase08_10_hooks::lock();
        let prompt = run(ipc::build_inbox_classification_prompt(fixture_item())).unwrap();
        assert!(!prompt.is_empty());
        assert!(prompt.contains("budget.pdf"));

        let parsed = run(ipc::parse_inbox_classification(
            r#"{"category":"task","summary":"예산 검토 회신 필요","suggestedFolder":"projects/rise","extractedDate":null}"#.to_string(),
        ))
        .unwrap();
        assert_eq!(parsed.category, "task");
        assert!(!parsed.summary.is_empty());
    }

    #[test]
    fn phase08_10_parse_wrapper_preserves_domain_rejection() {
        let _test_guard = phase08_10_hooks::lock();
        let error = run(ipc::parse_inbox_classification("not json".to_string())).unwrap_err();
        assert_eq!(error, "No JSON object found in classifier output.");
    }

    #[test]
    fn phase08_10_build_wrapper_yields_on_same_polling_task() {
        let _test_guard = phase08_10_hooks::lock();
        let (entered_tx, mut entered_rx) = tauri::async_runtime::channel(1);
        let (release_tx, release_rx) = mpsc::channel();
        let release_rx = Mutex::new(release_rx);
        let _hook =
            phase08_10_hooks::StageHook::new("build_inbox_classification_prompt", move || {
                entered_tx.blocking_send(thread::current().id()).unwrap();
                release_rx
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(5))
                    .expect("release build classifier worker");
            });
        run(async move {
            let caller = thread::current().id();
            let mut future = Box::pin(ipc::build_inbox_classification_prompt(fixture_item()));
            assert!(std::future::poll_fn(|cx| {
                std::task::Poll::Ready(std::future::Future::poll(future.as_mut(), cx))
            })
            .await
            .is_pending());
            let worker = entered_rx.recv().await.expect("build worker entered");
            let mut yielded = false;
            std::future::poll_fn(|cx| {
                if yielded {
                    std::task::Poll::Ready(())
                } else {
                    yielded = true;
                    cx.waker().wake_by_ref();
                    std::task::Poll::Pending
                }
            })
            .await;
            assert_ne!(caller, worker);
            release_tx.send(()).unwrap();
            assert!(!future.await.unwrap().is_empty());
        });
    }

    #[test]
    fn phase08_10_parse_wrapper_yields_on_same_polling_task() {
        let _test_guard = phase08_10_hooks::lock();
        let (entered_tx, mut entered_rx) = tauri::async_runtime::channel(1);
        let (release_tx, release_rx) = mpsc::channel();
        let release_rx = Mutex::new(release_rx);
        let _hook = phase08_10_hooks::StageHook::new("parse_inbox_classification", move || {
            entered_tx.blocking_send(thread::current().id()).unwrap();
            release_rx
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(5))
                .expect("release parse classifier worker");
        });
        run(async move {
            let caller = thread::current().id();
            let raw = r#"{"category":"reference","summary":"fixture"}"#.to_string();
            let mut future = Box::pin(ipc::parse_inbox_classification(raw));
            assert!(std::future::poll_fn(|cx| {
                std::task::Poll::Ready(std::future::Future::poll(future.as_mut(), cx))
            })
            .await
            .is_pending());
            let worker = entered_rx.recv().await.expect("parse worker entered");
            let mut yielded = false;
            std::future::poll_fn(|cx| {
                if yielded {
                    std::task::Poll::Ready(())
                } else {
                    yielded = true;
                    cx.waker().wake_by_ref();
                    std::task::Poll::Pending
                }
            })
            .await;
            assert_ne!(caller, worker);
            release_tx.send(()).unwrap();
            assert_eq!(future.await.unwrap().category, "reference");
        });
    }

    #[test]
    fn phase08_10_each_wrapper_adds_context_to_join_failure() {
        let _test_guard = phase08_10_hooks::lock();
        let build_hook =
            phase08_10_hooks::StageHook::new("build_inbox_classification_prompt", || {
                panic!("phase08_10 build worker fixture failure")
            });
        let build_error = run(ipc::build_inbox_classification_prompt(fixture_item())).unwrap_err();
        assert!(build_error.starts_with("build_inbox_classification_prompt_task_failed:"));
        drop(build_hook);

        let parse_hook = phase08_10_hooks::StageHook::new("parse_inbox_classification", || {
            panic!("phase08_10 parse worker fixture failure")
        });
        let parse_error = run(ipc::parse_inbox_classification("{}".to_string())).unwrap_err();
        assert!(parse_error.starts_with("parse_inbox_classification_task_failed:"));
        drop(parse_hook);
    }

    #[test]
    fn phase08_10_synchronous_helpers_remain_available_to_rust_callers() {
        let prompt = build_inbox_classification_prompt(fixture_item());
        assert!(prompt.contains("Source: fixture"));
        assert_eq!(
            parse_inbox_classification(r#"{"category":"admin","summary":"x"}"#.to_string())
                .unwrap()
                .category,
            "admin"
        );
    }
}
