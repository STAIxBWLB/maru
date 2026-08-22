// In-app browser pane: one native child webview per tab ("sites-embed-<id>")
// embedded inside the "main" window. Each embed loads arbitrary external
// http(s) sites and is intentionally NOT listed in any capability, so
// remote content gets zero IPC surface. Control flows in through these
// commands (invoked from the main webview); feedback flows back out via
// app events emitted to the main webview only, tagged with the tab id.
//
// Only the active tab is shown; the rest stay hidden so each keeps its own
// page state (scroll position, forms, SPA state).
//
// Requires the tauri "unstable" cargo feature (Window::add_child,
// Manager::get_window / get_webview are gated behind it in tauri 2.10).
//
// Bounds are logical pixels relative to the window's client area. With
// `titleBarStyle: Overlay` the main webview fills the window from (0,0),
// so the frontend can pass `getBoundingClientRect()` numbers directly.
// The child webview does NOT track window resizes — the frontend owns a
// ResizeObserver and re-syncs through `site_view_set_bounds`.

use crate::win_process::NoWindow;
use serde::Serialize;
use std::collections::VecDeque;
use std::process::Command;
use std::sync::Mutex;
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Position, Rect, Size, Url, Webview,
    WebviewUrl,
};

pub const SITES_EMBED_PREFIX: &str = "sites-embed-";
const MAIN_WINDOW_LABEL: &str = "main";
/// Each tab is a real native webview, so the count is capped.
const MAX_TABS: usize = 12;

// Keep in sync with src/lib/siteView.ts (naming follows catalog://refresh).
const EVENT_NAVIGATED: &str = "sites://navigated";
const EVENT_LOAD: &str = "sites://page-load";
const EVENT_TITLE: &str = "sites://title-changed";
#[cfg(target_os = "macos")]
const EVENT_OPEN_REQUESTED: &str = "sites://open-requested";
#[cfg(any(target_os = "macos", test))]
const MAX_OPENED_URLS: usize = 64;

#[derive(Default)]
pub struct SiteOpenedUrlState {
    queue: Mutex<VecDeque<String>>,
}

impl SiteOpenedUrlState {
    #[cfg(any(target_os = "macos", test))]
    fn enqueue(&self, urls: Vec<Url>) -> Vec<String> {
        let accepted = filter_opened_urls(urls);
        if accepted.is_empty() {
            return accepted;
        }
        let mut queue = self
            .queue
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for url in &accepted {
            if queue.len() == MAX_OPENED_URLS {
                queue.pop_front();
            }
            queue.push_back(url.clone());
        }
        accepted
    }

    fn take(&self) -> Vec<String> {
        self.queue
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .drain(..)
            .collect()
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NavigatedPayload {
    tab_id: String,
    url: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadPayload {
    tab_id: String,
    url: String,
    /// "started" | "finished"
    state: &'static str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TitlePayload {
    tab_id: String,
    title: String,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn parse_http_url(input: &str) -> Result<Url, String> {
    let url: Url = input
        .trim()
        .parse()
        .map_err(|err| format!("Invalid URL {input:?}: {err}"))?;
    match url.scheme() {
        "http" | "https" => Ok(url),
        other => Err(format!(
            "Unsupported URL scheme {other:?} (http/https only)"
        )),
    }
}

#[cfg(any(target_os = "macos", test))]
fn filter_opened_urls(urls: Vec<Url>) -> Vec<String> {
    urls.into_iter()
        .filter(|url| matches!(url.scheme(), "http" | "https"))
        .map(|url| url.to_string())
        .collect()
}

#[cfg(target_os = "macos")]
pub fn queue_opened_urls(app: &AppHandle, urls: Vec<Url>) {
    let accepted = app.state::<SiteOpenedUrlState>().enqueue(urls);
    if !accepted.is_empty() {
        emit_to_main(app, EVENT_OPEN_REQUESTED, accepted);
    }
}

fn embed_rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
    Rect {
        position: Position::Logical(LogicalPosition::new(x, y)),
        size: Size::Logical(LogicalSize::new(width.max(1.0), height.max(1.0))),
    }
}

/// Tab ids become webview labels, so they are restricted to a safe alphabet
/// rather than trusted from the frontend.
fn embed_label(tab_id: &str) -> Result<String, String> {
    let trimmed = tab_id.trim();
    if trimmed.is_empty() || trimmed.len() > 64 {
        return Err("Invalid browser tab id".to_string());
    }
    if !trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err("Invalid browser tab id".to_string());
    }
    Ok(format!("{SITES_EMBED_PREFIX}{trimmed}"))
}

fn get_embed(app: &AppHandle, tab_id: &str) -> Result<Webview, String> {
    let label = embed_label(tab_id)?;
    app.get_webview(&label)
        .ok_or_else(|| format!("Browser tab {tab_id} is not open"))
}

fn embed_labels(app: &AppHandle) -> Vec<String> {
    app.webviews()
        .into_keys()
        .filter(|label| label.starts_with(SITES_EMBED_PREFIX))
        .collect()
}

fn emit_to_main<S: Serialize + Clone>(app: &AppHandle, event: &str, payload: S) {
    // Best-effort: an event the frontend missed is not an error.
    let _ = app.emit_to(MAIN_WINDOW_LABEL, event, payload);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
//
// All commands are async so they run on the tokio pool: `add_child`
// internally posts to the main thread and blocks on the result, which
// would deadlock if the command itself ran on the main thread.

#[tauri::command]
pub async fn site_view_open(
    app: AppHandle,
    tab_id: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let target = parse_http_url(&url)?;
    let label = embed_label(&tab_id)?;

    // Serialize concurrent opens so two racing calls never both reach
    // add_child for the same label.
    static OPEN_LOCK: Mutex<()> = Mutex::new(());
    let _guard = OPEN_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    if let Some(existing) = app.get_webview(&label) {
        existing
            .set_bounds(embed_rect(x, y, width, height))
            .map_err(|err| format!("Cannot set browser tab bounds: {err}"))?;
        existing
            .navigate(target)
            .map_err(|err| format!("Cannot navigate browser tab: {err}"))?;
        existing
            .show()
            .map_err(|err| format!("Cannot show browser tab: {err}"))?;
        return Ok(());
    }

    if embed_labels(&app).len() >= MAX_TABS {
        return Err(format!("Too many browser tabs open (max {MAX_TABS})"));
    }

    let window = app
        .get_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "main window not found".to_string())?;

    let app_nav = app.clone();
    let app_load = app.clone();
    let app_title = app.clone();
    let app_popup = app.clone();
    let nav_tab = tab_id.clone();
    let load_tab = tab_id.clone();
    let title_tab = tab_id.clone();
    let popup_label = label.clone();

    let builder = WebviewBuilder::new(&label, WebviewUrl::External(target))
        // Do not steal keyboard focus from the main UI on open.
        .focused(false)
        .on_navigation(move |url| {
            let allowed = matches!(url.scheme(), "http" | "https") || url.as_str() == "about:blank";
            if allowed {
                emit_to_main(
                    &app_nav,
                    EVENT_NAVIGATED,
                    NavigatedPayload {
                        tab_id: nav_tab.clone(),
                        url: url.to_string(),
                    },
                );
            }
            allowed
        })
        .on_page_load(move |_webview, payload| {
            let state = match payload.event() {
                PageLoadEvent::Started => "started",
                PageLoadEvent::Finished => "finished",
            };
            emit_to_main(
                &app_load,
                EVENT_LOAD,
                LoadPayload {
                    tab_id: load_tab.clone(),
                    url: payload.url().to_string(),
                    state,
                },
            );
        })
        .on_document_title_changed(move |_webview, title| {
            emit_to_main(
                &app_title,
                EVENT_TITLE,
                TitlePayload {
                    tab_id: title_tab.clone(),
                    title,
                },
            );
        })
        .on_new_window(move |url, _features| {
            // Keep target=_blank / window.open inside this tab: deny the
            // popup, then steer the embed itself to the URL. Navigation is
            // deferred off the callback to avoid re-entrancy in the
            // platform webview delegate.
            if matches!(url.scheme(), "http" | "https") {
                let app = app_popup.clone();
                let label = popup_label.clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(embed) = app.get_webview(&label) {
                        let _ = embed.navigate(url);
                    }
                });
            }
            NewWindowResponse::Deny
        });

    window
        .add_child(
            builder,
            Position::Logical(LogicalPosition::new(x, y)),
            Size::Logical(LogicalSize::new(width.max(1.0), height.max(1.0))),
        )
        .map_err(|err| format!("Cannot create browser tab webview: {err}"))?;
    Ok(())
}

#[tauri::command]
pub async fn site_view_navigate(app: AppHandle, tab_id: String, url: String) -> Result<(), String> {
    let target = parse_http_url(&url)?;
    get_embed(&app, &tab_id)?
        .navigate(target)
        .map_err(|err| format!("Cannot navigate browser tab: {err}"))
}

#[tauri::command]
pub async fn site_view_set_bounds(
    app: AppHandle,
    tab_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    get_embed(&app, &tab_id)?
        .set_bounds(embed_rect(x, y, width, height))
        .map_err(|err| format!("Cannot set browser tab bounds: {err}"))
}

/// Show one tab and hide every other embed, so switching tabs never leaves
/// two webviews stacked on the same bounds.
#[tauri::command]
pub async fn site_view_show(app: AppHandle, tab_id: String) -> Result<(), String> {
    let label = embed_label(&tab_id)?;
    for other in embed_labels(&app) {
        if other == label {
            continue;
        }
        if let Some(webview) = app.get_webview(&other) {
            let _ = webview.hide();
        }
    }
    get_embed(&app, &tab_id)?
        .show()
        .map_err(|err| format!("Cannot show browser tab: {err}"))
}

/// Hide every embed. Used when the browser surface itself goes away.
#[tauri::command]
pub async fn site_view_hide(app: AppHandle) -> Result<(), String> {
    for label in embed_labels(&app) {
        if let Some(webview) = app.get_webview(&label) {
            let _ = webview.hide();
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn site_view_close(app: AppHandle, tab_id: String) -> Result<(), String> {
    // Idempotent: closing an absent tab is a no-op. A leaked child webview
    // would float over the UI forever, so failures are surfaced.
    let label = embed_label(&tab_id)?;
    match app.get_webview(&label) {
        Some(webview) => webview
            .close()
            .map_err(|err| format!("Cannot close browser tab: {err}")),
        None => Ok(()),
    }
}

#[tauri::command]
pub async fn site_view_close_all(app: AppHandle) -> Result<(), String> {
    for label in embed_labels(&app) {
        if let Some(webview) = app.get_webview(&label) {
            let _ = webview.close();
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn site_view_reload(app: AppHandle, tab_id: String) -> Result<(), String> {
    get_embed(&app, &tab_id)?
        .reload()
        .map_err(|err| format!("Cannot reload browser tab: {err}"))
}

#[tauri::command]
pub async fn site_view_back(app: AppHandle, tab_id: String) -> Result<(), String> {
    // Webview<R> exposes no native history API; history.back() in the
    // page context is the supported equivalent.
    get_embed(&app, &tab_id)?
        .eval("history.back()")
        .map_err(|err| format!("Cannot go back: {err}"))
}

#[tauri::command]
pub async fn site_view_forward(app: AppHandle, tab_id: String) -> Result<(), String> {
    get_embed(&app, &tab_id)?
        .eval("history.forward()")
        .map_err(|err| format!("Cannot go forward: {err}"))
}

#[tauri::command]
pub async fn site_view_open_external(url: String) -> Result<(), String> {
    // Validate before shelling out: http/https only, so this can never be
    // abused to `open` a local path or custom scheme.
    let target = parse_http_url(&url)?;
    open_in_system_browser(target.as_str())
}

/// Open the URL specifically in Safari. This avoids recursively reopening
/// Maru when its provisioned passkey build is registered for HTTP/HTTPS.
#[tauri::command]
pub async fn site_view_open_safari(url: String) -> Result<(), String> {
    let target = parse_http_url(&url)?;
    #[cfg(target_os = "macos")]
    {
        safari_command(target.as_str())
            .no_window()
            .spawn()
            .map_err(|err| format!("Cannot open Safari: {err}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        open_in_system_browser(target.as_str())
    }
}

#[tauri::command]
pub fn site_view_take_opened_urls(state: tauri::State<'_, SiteOpenedUrlState>) -> Vec<String> {
    state.take()
}

#[cfg(target_os = "macos")]
fn safari_command(url: &str) -> Command {
    let mut command = Command::new("/usr/bin/open");
    command.arg("-b").arg("com.apple.Safari").arg(url);
    command
}

fn open_in_system_browser(url: &str) -> Result<(), String> {
    let mut command = if cfg!(target_os = "macos") {
        let mut c = Command::new("open");
        c.arg(url);
        c
    } else if cfg!(target_os = "windows") {
        // `cmd /C start` mangles URLs containing `&`; rundll32 does not.
        let mut c = Command::new("rundll32");
        c.arg("url.dll,FileProtocolHandler").arg(url);
        c
    } else {
        let mut c = Command::new("xdg-open");
        c.arg(url);
        c
    };
    command
        .no_window()
        .spawn()
        .map_err(|err| format!("Cannot open system browser: {err}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(value: &str) -> Url {
        value.parse().expect("test URL")
    }

    #[test]
    fn opened_url_filter_accepts_only_http_and_https() {
        assert_eq!(
            filter_opened_urls(vec![
                url("https://example.com/a"),
                url("file:///tmp/private"),
                url("http://localhost:3000/path?q=1"),
                url("maru://sites/open"),
            ]),
            vec![
                "https://example.com/a".to_string(),
                "http://localhost:3000/path?q=1".to_string(),
            ]
        );
    }

    #[test]
    fn opened_url_queue_is_memory_only_bounded_and_drained() {
        let state = SiteOpenedUrlState::default();
        let urls = (0..=MAX_OPENED_URLS)
            .map(|index| url(&format!("https://example.com/{index}")))
            .collect();
        state.enqueue(urls);

        let drained = state.take();
        assert_eq!(drained.len(), MAX_OPENED_URLS);
        assert_eq!(
            drained.first().map(String::as_str),
            Some("https://example.com/1")
        );
        assert_eq!(
            drained.last().map(String::as_str),
            Some("https://example.com/64")
        );
        assert!(state.take().is_empty());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn safari_fallback_bypasses_the_default_http_handler() {
        let command = safari_command("https://example.com/passkey");
        assert_eq!(command.get_program(), "/usr/bin/open");
        assert_eq!(
            command
                .get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
            vec!["-b", "com.apple.Safari", "https://example.com/passkey"]
        );
    }
}
