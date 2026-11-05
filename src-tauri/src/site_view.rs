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
use std::collections::{HashMap, VecDeque};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Position, Rect, Size, Url, Webview,
    WebviewUrl,
};

pub const SITES_EMBED_PREFIX: &str = "sites-embed-";
const MAIN_WINDOW_LABEL: &str = "main";
/// Each tab is a real native webview, so the count is capped.
const MAX_TABS: usize = 12;
const SITE_NAVIGATION_BLOCKED: &str = "site_navigation_blocked: Sites cannot navigate to Tauri-local origins; use an ordinary HTTP(S) URL or a different local port";

// Keep in sync with src/lib/siteView.ts (naming follows catalog://refresh).
const EVENT_NAVIGATED: &str = "sites://navigated";
const EVENT_LOAD: &str = "sites://page-load";
const EVENT_TITLE: &str = "sites://title-changed";
#[cfg(target_os = "macos")]
const EVENT_OPEN_REQUESTED: &str = "sites://open-requested";
#[cfg(any(target_os = "macos", test))]
const MAX_OPENED_URLS: usize = 64;

#[derive(Default, Clone)]
pub struct SiteOpenedUrlState {
    queue: Arc<Mutex<VecDeque<String>>>,
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

fn is_tauri_localhost_subdomain(host: &str) -> bool {
    host.trim_end_matches('.')
        .to_ascii_lowercase()
        .ends_with(".localhost")
}

fn site_navigation_allowed(url: &Url, dev_url: Option<&Url>, debug: bool) -> bool {
    if url.as_str() == "about:blank" {
        return true;
    }
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_some_and(is_tauri_localhost_subdomain)
    {
        return false;
    }
    !crate::ipc_policy::is_app_origin(url, dev_url, debug)
}

fn site_popup_navigation_allowed(url: &Url, dev_url: Option<&Url>, debug: bool) -> bool {
    matches!(url.scheme(), "http" | "https") && site_navigation_allowed(url, dev_url, debug)
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

fn get_embed<R: tauri::Runtime>(app: &AppHandle<R>, tab_id: &str) -> Result<Webview<R>, String> {
    let label = embed_label(tab_id)?;
    app.get_webview(&label)
        .ok_or_else(|| format!("Browser tab {tab_id} is not open"))
}

fn embed_labels<R: tauri::Runtime>(app: &AppHandle<R>) -> Vec<String> {
    app.webviews()
        .into_keys()
        .filter(|label| label.starts_with(SITES_EMBED_PREFIX))
        .collect()
}

fn emit_to_main<R: tauri::Runtime, S: Serialize + Clone>(
    app: &AppHandle<R>,
    event: &str,
    payload: S,
) {
    // Best-effort: an event the frontend missed is not an error.
    let _ = app.emit_to(MAIN_WINDOW_LABEL, event, payload);
}

type PendingOpens = HashMap<String, Arc<AtomicBool>>;
fn pending_opens() -> Arc<tauri::async_runtime::Mutex<PendingOpens>> {
    static STATE: OnceLock<Arc<tauri::async_runtime::Mutex<PendingOpens>>> = OnceLock::new();
    STATE
        .get_or_init(|| Arc::new(tauri::async_runtime::Mutex::new(HashMap::new())))
        .clone()
}

// Memory-only async bookkeeping, never filesystem/process work before the
// owned worker. Tokio's mutex yields instead of blocking the shared runtime.
async fn begin_site_open(tab_id: &str) -> Result<(String, Arc<AtomicBool>), String> {
    let label = embed_label(tab_id)?;
    let cancelled = Arc::new(AtomicBool::new(false));
    let mut pending = pending_opens().lock_owned().await;
    if pending.len() >= MAX_TABS && !pending.contains_key(&label) {
        return Err(
            "site_open_busy: too many sites are starting; wait or close a pending tab and retry"
                .into(),
        );
    }
    if let Some(previous) = pending.insert(label.clone(), cancelled.clone()) {
        previous.store(true, Ordering::Release);
    }
    Ok((label, cancelled))
}

async fn finish_site_open(label: &str, cancelled: &Arc<AtomicBool>) {
    let mut pending = pending_opens().lock_owned().await;
    if pending
        .get(label)
        .is_some_and(|current| Arc::ptr_eq(current, cancelled))
    {
        pending.remove(label);
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
//
// The per-tab lifecycle commands below (`site_view_navigate` through
// `site_view_forward`) are async so they run on the tokio pool: each webview
// call internally posts to the main thread and blocks on the result, which
// would deadlock if the command itself ran on the main thread. They keep
// their registrations because they are pure platform dispatch with no
// blocking substep of their own.
//
// `site_view_open`, the external-browser launches and the opened-URL drain
// run their lock waits and process spawns in owned blocking workers via
// `ipc` below; `add_child` and the webview methods post to the main thread
// internally, so calling them from a blocking worker is safe.

#[allow(clippy::too_many_arguments)]
pub fn site_view_open<R: tauri::Runtime>(
    app: AppHandle<R>,
    tab_id: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    launch: Option<String>,
    cancelled: Arc<AtomicBool>,
) -> Result<String, String> {
    let fallback = parse_http_url(&url)?;
    let dev_url = app.config().build.dev_url.clone();
    let debug = cfg!(debug_assertions);
    if !site_navigation_allowed(&fallback, dev_url.as_ref(), debug) {
        return Err(SITE_NAVIGATION_BLOCKED.into());
    }
    let label = embed_label(&tab_id)?;
    let window = app.get_window(MAIN_WINDOW_LABEL).ok_or_else(|| {
        "site_launch_window_missing: main window is unavailable; reopen Sites and retry".to_string()
    })?;
    let console = launch
        .as_deref()
        .map(|launch| crate::site_launcher::launch_site(launch, &cancelled))
        .transpose()?;
    let target = console
        .as_ref()
        .map(|console| console.url.clone())
        .unwrap_or(fallback);
    if !site_navigation_allowed(&target, dev_url.as_ref(), debug) {
        return Err(SITE_NAVIGATION_BLOCKED.into());
    }
    let resolved_url = target.to_string();

    // Waiting happens only on an owned blocking worker. Startup above does
    // not hold this lock; close/new-open can cancel it immediately. Native
    // navigation is serialized with close, preventing stale tab-id reuse.
    let state = pending_opens();
    let _state = state.blocking_lock();
    if cancelled.load(Ordering::Acquire) {
        return Err(
            "site_open_cancelled: this tab was closed or superseded; open the site again if needed"
                .into(),
        );
    }
    if let Some(existing) = app.get_webview(&label) {
        existing
            .set_bounds(embed_rect(x, y, width, height))
            .map_err(|err| format!("Cannot set browser tab bounds: {err}"))?;
        existing
            .navigate(target)
            .map_err(|err| format!("Cannot navigate browser tab: {err}"))?;
        existing.hide().map_err(|err| {
            format!("Cannot hide browser tab until its current UI is ready: {err}; close the tab and reopen the site")
        })?;
        if let Some(console) = console {
            console.keep_alive()?;
        }
        return Ok(resolved_url);
    }

    if embed_labels(&app).len() >= MAX_TABS {
        return Err(format!("Too many browser tabs open (max {MAX_TABS})"));
    }

    let app_nav = app.clone();
    let app_load = app.clone();
    let app_title = app.clone();
    let app_popup = app.clone();
    let navigation_dev_url = dev_url.clone();
    let popup_dev_url = dev_url;
    let nav_tab = tab_id.clone();
    let load_tab = tab_id.clone();
    let title_tab = tab_id.clone();
    let popup_label = label.clone();

    let builder = WebviewBuilder::new(&label, WebviewUrl::External(target))
        // Do not steal keyboard focus from the main UI on open.
        .focused(false)
        .on_navigation(move |url| {
            let allowed = site_navigation_allowed(url, navigation_dev_url.as_ref(), debug);
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
            if site_popup_navigation_allowed(&url, popup_dev_url.as_ref(), debug) {
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

    #[cfg(all(feature = "native-e2e", target_os = "macos"))]
    let builder = {
        let id = app.config().app.windows.iter().find(|window| window.label == MAIN_WINDOW_LABEL).and_then(|window| window.data_store_identifier)
            .ok_or("site_fixture_profile_missing: restart the native fixture with isolated config before opening a site")?;
        builder.data_store_identifier(id)
    };

    let embed = window
        .add_child(
            builder,
            Position::Logical(LogicalPosition::new(x, y)),
            Size::Logical(LogicalSize::new(width.max(1.0), height.max(1.0))),
        )
        .map_err(|err| format!("Cannot create browser tab webview: {err}"))?;
    if let Err(error) = embed.hide() {
        let cleanup = embed.close().err();
        return Err(format!("Cannot hide newly opened site view: {error}; close cleanup: {cleanup:?}; close the tab and retry opening the site"));
    }
    if let Some(console) = console {
        console.keep_alive()?;
    }
    Ok(resolved_url)
}

#[tauri::command]
pub async fn site_view_navigate<R: tauri::Runtime>(
    app: AppHandle<R>,
    tab_id: String,
    url: String,
) -> Result<(), String> {
    let target = parse_http_url(&url)?;
    let dev_url = app.config().build.dev_url.clone();
    if !site_navigation_allowed(&target, dev_url.as_ref(), cfg!(debug_assertions)) {
        return Err(SITE_NAVIGATION_BLOCKED.into());
    }
    get_embed(&app, &tab_id)?
        .navigate(target)
        .map_err(|err| format!("Cannot navigate browser tab: {err}"))
}

#[tauri::command]
pub async fn site_view_set_bounds<R: tauri::Runtime>(
    app: AppHandle<R>,
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
pub async fn site_view_show<R: tauri::Runtime>(
    app: AppHandle<R>,
    tab_id: String,
) -> Result<(), String> {
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
pub async fn site_view_hide<R: tauri::Runtime>(app: AppHandle<R>) -> Result<(), String> {
    for label in embed_labels(&app) {
        if let Some(webview) = app.get_webview(&label) {
            let _ = webview.hide();
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn site_view_close<R: tauri::Runtime>(
    app: AppHandle<R>,
    tab_id: String,
) -> Result<(), String> {
    // Idempotent: closing an absent tab is a no-op. A leaked child webview
    // would float over the UI forever, so failures are surfaced.
    let label = embed_label(&tab_id)?;
    let mut pending = pending_opens().lock_owned().await;
    if let Some(cancel) = pending.remove(&label) {
        cancel.store(true, Ordering::Release);
    }
    match app.get_webview(&label) {
        Some(webview) => webview
            .close()
            .map_err(|err| format!("Cannot close browser tab: {err}")),
        None => Ok(()),
    }
}

#[tauri::command]
pub async fn site_view_close_all<R: tauri::Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let mut pending = pending_opens().lock_owned().await;
    for cancel in pending.values() {
        cancel.store(true, Ordering::Release);
    }
    pending.clear();
    for label in embed_labels(&app) {
        if let Some(webview) = app.get_webview(&label) {
            let _ = webview.close();
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn site_view_reload<R: tauri::Runtime>(
    app: AppHandle<R>,
    tab_id: String,
) -> Result<(), String> {
    get_embed(&app, &tab_id)?
        .reload()
        .map_err(|err| format!("Cannot reload browser tab: {err}"))
}

#[tauri::command]
pub async fn site_view_back<R: tauri::Runtime>(
    app: AppHandle<R>,
    tab_id: String,
) -> Result<(), String> {
    // Webview<R> exposes no native history API; history.back() in the
    // page context is the supported equivalent.
    get_embed(&app, &tab_id)?
        .eval("history.back()")
        .map_err(|err| format!("Cannot go back: {err}"))
}

#[tauri::command]
pub async fn site_view_forward<R: tauri::Runtime>(
    app: AppHandle<R>,
    tab_id: String,
) -> Result<(), String> {
    get_embed(&app, &tab_id)?
        .eval("history.forward()")
        .map_err(|err| format!("Cannot go forward: {err}"))
}

pub fn site_view_open_external(url: String) -> Result<(), String> {
    // Validate before shelling out: http/https only, so this can never be
    // abused to `open` a local path or custom scheme.
    let target = parse_http_url(&url)?;
    open_in_system_browser(target.as_str())
}

/// Open the URL specifically in Safari. This avoids recursively reopening
/// Maru when its provisioned passkey build is registered for HTTP/HTTPS.
pub fn site_view_open_safari(url: String) -> Result<(), String> {
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

pub fn site_view_take_opened_urls(state: &SiteOpenedUrlState) -> Vec<String> {
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

/// Main-webview guard: a remote http(s) navigation, including a link in a
/// sandboxed viewer or preview, never replaces app content and opens in the
/// system browser. Sites embeds are separate webviews and keep their own
/// handlers.
///
/// Platform behavior differs: WKWebView reports subframe and new-window
/// navigations here; WebView2 reports only main-frame navigations. This guard
/// does not establish which frame requested a navigation.
pub(crate) fn external_link_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("maru-external-links")
        .on_navigation(|webview, url| {
            if !should_open_external_navigation(webview.label(), url) {
                return true;
            }
            let admitted = LAST_EXTERNAL_OPEN
                .lock()
                .map(|mut last| admit_external_open(&mut last, Instant::now()))
                .unwrap_or(false);
            if admitted {
                let target = url.to_string();
                // Leave the platform navigation delegate before spawning `open`.
                std::thread::spawn(move || {
                    if let Err(err) = open_in_system_browser(&target) {
                        eprintln!("[site-view] {err}");
                    }
                });
            }
            false
        })
        .build()
}

// ponytail: one global slot, so a script looping on navigations inside a
// viewer opens at most one browser tab per interval; per-frame limits need a
// frame identity the navigation callback does not carry.
static LAST_EXTERNAL_OPEN: Mutex<Option<Instant>> = Mutex::new(None);
const EXTERNAL_OPEN_INTERVAL: Duration = Duration::from_secs(1);

fn admit_external_open(last: &mut Option<Instant>, now: Instant) -> bool {
    if last.is_some_and(|at| now.duration_since(at) < EXTERNAL_OPEN_INTERVAL) {
        return false;
    }
    *last = Some(now);
    true
}

fn is_remote_http(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && !url.host_str().is_some_and(|host| {
            host == "localhost" || host == "127.0.0.1" || host.ends_with(".localhost")
        })
}

fn should_open_external_navigation(webview_label: &str, url: &Url) -> bool {
    webview_label == MAIN_WINDOW_LABEL && is_remote_http(url)
}

#[cfg(test)]
fn worker_hook_key(command: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(format!("/maru/phase08_24/site_view/{command}"))
}

/// Owned IPC boundaries for the commands that wait on locks or spawn
/// processes; the synchronous functions remain the Rust/CLI API. The
/// per-tab async UI dispatch commands above keep their registrations.
pub mod ipc {
    use super::*;

    #[tauri::command]
    #[allow(clippy::too_many_arguments)]
    pub async fn site_view_open<R: tauri::Runtime>(
        app: AppHandle<R>,
        tab_id: String,
        url: String,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        launch: Option<String>,
    ) -> Result<String, String> {
        let (label, cancelled) = begin_site_open(&tab_id).await?;
        let operation = cancelled.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            crate::atomic_file::PathTransactionLease::test_stage(
                &[super::worker_hook_key("site_view_open")],
                "worker:site_view_open",
            );
            super::site_view_open(app, tab_id, url, x, y, width, height, launch, operation)
        })
        .await
        .map_err(|err| format!("site_view_open_task_failed: {err}; retry opening the site"))
        .and_then(|result| result);
        finish_site_open(&label, &cancelled).await;
        result
    }

    #[tauri::command]
    pub async fn site_view_open_external(url: String) -> Result<(), String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            crate::atomic_file::PathTransactionLease::test_stage(
                &[super::worker_hook_key("site_view_open_external")],
                "worker:site_view_open_external",
            );
            super::site_view_open_external(url)
        })
        .await
        .map_err(|err| format!("site_view_open_external_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn site_view_open_safari(url: String) -> Result<(), String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            crate::atomic_file::PathTransactionLease::test_stage(
                &[super::worker_hook_key("site_view_open_safari")],
                "worker:site_view_open_safari",
            );
            super::site_view_open_safari(url)
        })
        .await
        .map_err(|err| format!("site_view_open_safari_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn site_view_take_opened_urls(
        state: tauri::State<'_, SiteOpenedUrlState>,
    ) -> Result<Vec<String>, String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<Vec<String>, String> {
            #[cfg(test)]
            crate::atomic_file::PathTransactionLease::test_stage(
                &[super::worker_hook_key("site_view_take_opened_urls")],
                "worker:site_view_take_opened_urls",
            );
            Ok(super::site_view_take_opened_urls(&state))
        })
        .await
        .map_err(|err| format!("site_view_take_opened_urls_task_failed: {err}"))?
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn cancelled_open_identity_cannot_remove_or_publish_a_newer_tab_request() {
        let _guard = phase08_24::serialized();
        tauri::async_runtime::block_on(async {
            let (label, first) = super::begin_site_open("cancel-test").await.unwrap();
            let (_, second) = super::begin_site_open("cancel-test").await.unwrap();
            assert!(first.load(std::sync::atomic::Ordering::Acquire));
            assert!(!second.load(std::sync::atomic::Ordering::Acquire));
            super::finish_site_open(&label, &first).await;
            let app = tauri::test::mock_app();
            super::site_view_close(app.handle().clone(), "cancel-test".into())
                .await
                .unwrap();
            assert!(second.load(std::sync::atomic::Ordering::Acquire));
            assert!(!super::pending_opens()
                .lock_owned()
                .await
                .contains_key(&label));
        });
    }

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
    fn sites_navigation_blocks_tauri_localhost_hosts_for_initial_and_redirect_urls() {
        for value in [
            "http://tauri.localhost/",
            "https://auth.localhost/",
            "http://nested.auth.localhost./",
            "https://auth.localhost.:8443/",
        ] {
            assert!(
                !site_navigation_allowed(&url(value), None, false),
                "reserved Tauri-local host should be blocked: {value}"
            );
        }
        assert!(!site_navigation_allowed(
            &url("tauri://localhost/index.html"),
            None,
            false
        ));
    }

    #[test]
    fn site_view_open_rejects_reserved_initial_target_before_window_lookup() {
        let app = tauri::test::mock_app();
        let error = site_view_open(
            app.handle().clone(),
            "reserved-initial".into(),
            "https://auth.localhost/".into(),
            0.0,
            0.0,
            1.0,
            1.0,
            None,
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap_err();

        assert!(error.contains("site_navigation_blocked"), "{error}");
        assert!(!error.contains("site_launch_window_missing"), "{error}");
        assert!(app.get_webview("sites-embed-reserved-initial").is_none());
    }

    #[test]
    fn site_view_navigate_rejects_reserved_target_before_missing_embed_lookup() {
        let app = tauri::test::mock_app();
        let error = tauri::async_runtime::block_on(site_view_navigate(
            app.handle().clone(),
            "missing-embed".into(),
            "http://auth.localhost/".into(),
        ))
        .unwrap_err();

        assert!(error.contains("site_navigation_blocked"), "{error}");
        assert!(
            !error.contains("Browser tab missing-embed is not open"),
            "{error}"
        );
    }

    #[test]
    fn sites_navigation_preserves_ordinary_localhost_and_loopback_origins() {
        let dev_url = url("http://localhost:5307/");
        for value in [
            "http://localhost:3000/",
            "http://127.0.0.1:5307/",
            "http://[::1]:5307/",
        ] {
            assert!(
                site_navigation_allowed(&url(value), Some(&dev_url), true),
                "ordinary local origin should remain available: {value}"
            );
        }
        assert!(!site_navigation_allowed(
            &url("http://localhost:5307/another-path"),
            Some(&dev_url),
            true
        ));
        assert!(!site_navigation_allowed(
            &url("http://user:password@localhost:5307/another-path"),
            Some(&dev_url),
            true
        ));
        assert!(site_navigation_allowed(
            &url("http://localhost:5307/"),
            Some(&dev_url),
            false
        ));
        assert!(site_navigation_allowed(&url("about:blank"), None, true));
    }

    #[test]
    fn popup_navigation_remains_http_and_https_only() {
        assert!(!site_popup_navigation_allowed(
            &url("about:blank"),
            None,
            true
        ));
        assert!(site_popup_navigation_allowed(
            &url("http://localhost:3000/"),
            None,
            true
        ));
        assert!(!site_popup_navigation_allowed(
            &url("https://auth.localhost/"),
            None,
            true
        ));
    }

    #[test]
    fn external_link_guard_passes_app_asset_and_dev_origins() {
        for local in [
            "tauri://localhost/index.html",
            "asset://localhost/%2Fwork%2Fdocs%2Fa-rendered.html",
            "http://asset.localhost/work/docs/a-rendered.html",
            "http://tauri.localhost/",
            "http://127.0.0.1:5307/",
            "http://localhost:5307/",
            "about:blank",
            "blob:tauri://localhost/1",
        ] {
            assert!(!is_remote_http(&url(local)), "{local}");
        }
        for remote in ["https://github.com/entelecheia/maru", "http://example.com/"] {
            assert!(is_remote_http(&url(remote)), "{remote}");
        }
    }

    #[test]
    fn relay_remote_origin_uses_the_same_external_navigation_route_as_other_remotes() {
        let relay = url("http://relay-mac.local:8787/?theme=dark");
        let ordinary_remote = url("https://example.com/");
        assert!(should_open_external_navigation(MAIN_WINDOW_LABEL, &relay));
        assert_eq!(
            should_open_external_navigation(MAIN_WINDOW_LABEL, &relay),
            should_open_external_navigation(MAIN_WINDOW_LABEL, &ordinary_remote)
        );
        assert!(!should_open_external_navigation(
            MAIN_WINDOW_LABEL,
            &url("http://localhost:3000/")
        ));
        assert!(!should_open_external_navigation(
            "sites-embed-relay",
            &relay
        ));
    }

    #[test]
    fn external_link_guard_opens_at_most_once_per_interval() {
        let start = Instant::now();
        let mut last = None;
        assert!(admit_external_open(&mut last, start));
        assert!(!admit_external_open(
            &mut last,
            start + Duration::from_millis(300)
        ));
        assert!(admit_external_open(
            &mut last,
            start + EXTERNAL_OPEN_INTERVAL
        ));
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

    mod phase08_24 {
        use super::*;
        use crate::atomic_file::phase08_06::{boundary, run};
        use std::sync::{Mutex, MutexGuard};

        // Synthetic worker-hook keys are module-global; serialize these tests
        // so a stage hook registered by one test cannot intercept a parallel
        // test's worker for the same command stage.
        static TEST_LOCK: Mutex<()> = Mutex::new(());
        pub(super) fn serialized() -> MutexGuard<'static, ()> {
            TEST_LOCK
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
        }

        fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
            let app = tauri::test::mock_app();
            app.manage(SiteOpenedUrlState::default());
            app
        }

        #[test]
        fn phase08_24_site_view_workers_yield_same_poll_and_map_join_failure() {
            let _guard = serialized();
            let app = mock_app();
            let open_app = app.handle().clone();
            boundary(
                worker_hook_key("site_view_open"),
                "site_view_open",
                async move {
                    ipc::site_view_open(
                        open_app,
                        "docs".into(),
                        "https://example.com".into(),
                        0.0,
                        0.0,
                        100.0,
                        100.0,
                        None,
                    )
                    .await
                },
            );
            boundary(
                worker_hook_key("site_view_open_external"),
                "site_view_open_external",
                ipc::site_view_open_external("https://example.com".into()),
            );
            boundary(
                worker_hook_key("site_view_open_safari"),
                "site_view_open_safari",
                ipc::site_view_open_safari("https://example.com".into()),
            );
            let take_app = app.handle().clone();
            boundary(
                worker_hook_key("site_view_take_opened_urls"),
                "site_view_take_opened_urls",
                async move { ipc::site_view_take_opened_urls(take_app.state()).await },
            );
        }

        #[test]
        fn phase08_24_site_view_owned_results_and_rejections() {
            let _guard = serialized();
            let app = mock_app();
            let app = app.handle().clone();
            run(async move {
                let error = ipc::site_view_open(
                    app.clone(),
                    "docs".into(),
                    "ftp://example.com".into(),
                    0.0,
                    0.0,
                    100.0,
                    100.0,
                    None,
                )
                .await
                .unwrap_err();
                assert!(
                    error.contains("Unsupported URL scheme"),
                    "unexpected error: {error}"
                );

                let error = ipc::site_view_open(
                    app.clone(),
                    "bad id!".into(),
                    "https://example.com".into(),
                    0.0,
                    0.0,
                    100.0,
                    100.0,
                    None,
                )
                .await
                .unwrap_err();
                assert_eq!(error, "Invalid browser tab id");

                let error = ipc::site_view_open(
                    app.clone(),
                    "docs".into(),
                    "https://example.com".into(),
                    0.0,
                    0.0,
                    100.0,
                    100.0,
                    None,
                )
                .await
                .unwrap_err();
                assert!(error.contains("site_launch_window_missing"), "{error}");

                let error = ipc::site_view_open_external("file:///etc/passwd".into())
                    .await
                    .unwrap_err();
                assert!(
                    error.contains("Unsupported URL scheme"),
                    "unexpected error: {error}"
                );

                let error = ipc::site_view_open_safari("maru://x".into())
                    .await
                    .unwrap_err();
                assert!(
                    error.contains("Unsupported URL scheme"),
                    "unexpected error: {error}"
                );

                let queued = app.state::<SiteOpenedUrlState>();
                let accepted = queued.enqueue(vec![
                    url("https://example.com/a"),
                    url("file:///tmp/private"),
                ]);
                assert_eq!(accepted, vec!["https://example.com/a".to_string()]);
                let drained = ipc::site_view_take_opened_urls(app.state()).await.unwrap();
                assert_eq!(drained, vec!["https://example.com/a".to_string()]);
                assert!(ipc::site_view_take_opened_urls(app.state())
                    .await
                    .unwrap()
                    .is_empty());
            });
        }

        #[test]
        fn phase08_24_site_view_ui_rows_dispatch_with_typed_rejections() {
            let _guard = serialized();
            let app = mock_app();
            let app = app.handle().clone();
            run(async move {
                let not_open = |error: &str| {
                    assert!(error.contains("is not open"), "unexpected error: {error}");
                };
                not_open(
                    &site_view_navigate(app.clone(), "docs".into(), "https://example.com".into())
                        .await
                        .unwrap_err(),
                );
                not_open(
                    &site_view_set_bounds(app.clone(), "docs".into(), 0.0, 0.0, 1.0, 1.0)
                        .await
                        .unwrap_err(),
                );
                not_open(
                    &site_view_show(app.clone(), "docs".into())
                        .await
                        .unwrap_err(),
                );
                not_open(
                    &site_view_reload(app.clone(), "docs".into())
                        .await
                        .unwrap_err(),
                );
                not_open(
                    &site_view_back(app.clone(), "docs".into())
                        .await
                        .unwrap_err(),
                );
                not_open(
                    &site_view_forward(app.clone(), "docs".into())
                        .await
                        .unwrap_err(),
                );
                site_view_hide(app.clone()).await.unwrap();
                site_view_close_all(app.clone()).await.unwrap();
                site_view_close(app, "docs".into()).await.unwrap();
            });
        }
    }
}
