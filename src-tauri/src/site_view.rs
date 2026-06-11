// In-app browser pane: a single native child webview ("sites-embed")
// embedded inside the "main" window. The embed loads arbitrary external
// http(s) sites and is intentionally NOT listed in any capability, so
// remote content gets zero IPC surface. Control flows in through these
// commands (invoked from the main webview); feedback flows back out via
// app events emitted to the main webview only.
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
use std::process::Command;
use std::sync::Mutex;
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Position, Rect, Size, Url, Webview,
    WebviewUrl,
};

pub const SITES_EMBED_LABEL: &str = "sites-embed";
const MAIN_WINDOW_LABEL: &str = "main";

// Keep in sync with src/lib/siteView.ts (naming follows catalog://refresh).
const EVENT_NAVIGATED: &str = "sites://navigated";
const EVENT_LOAD: &str = "sites://page-load";
const EVENT_TITLE: &str = "sites://title-changed";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NavigatedPayload {
    url: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadPayload {
    url: String,
    /// "started" | "finished"
    state: &'static str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TitlePayload {
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

fn embed_rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
    Rect {
        position: Position::Logical(LogicalPosition::new(x, y)),
        size: Size::Logical(LogicalSize::new(width.max(1.0), height.max(1.0))),
    }
}

fn get_embed(app: &AppHandle) -> Result<Webview, String> {
    app.get_webview(SITES_EMBED_LABEL)
        .ok_or_else(|| "sites-embed webview is not open".to_string())
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
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let target = parse_http_url(&url)?;

    // Serialize concurrent opens so two racing calls never both reach
    // add_child for the same label.
    static OPEN_LOCK: Mutex<()> = Mutex::new(());
    let _guard = OPEN_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    if let Some(existing) = app.get_webview(SITES_EMBED_LABEL) {
        existing
            .set_bounds(embed_rect(x, y, width, height))
            .map_err(|err| format!("Cannot set sites-embed bounds: {err}"))?;
        existing
            .navigate(target)
            .map_err(|err| format!("Cannot navigate sites-embed: {err}"))?;
        existing
            .show()
            .map_err(|err| format!("Cannot show sites-embed: {err}"))?;
        return Ok(());
    }

    let window = app
        .get_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "main window not found".to_string())?;

    let app_nav = app.clone();
    let app_load = app.clone();
    let app_title = app.clone();
    let app_popup = app.clone();

    let builder = WebviewBuilder::new(SITES_EMBED_LABEL, WebviewUrl::External(target))
        // Do not steal keyboard focus from the main UI on open.
        .focused(false)
        .on_navigation(move |url| {
            let allowed =
                matches!(url.scheme(), "http" | "https") || url.as_str() == "about:blank";
            if allowed {
                emit_to_main(
                    &app_nav,
                    EVENT_NAVIGATED,
                    NavigatedPayload {
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
                    url: payload.url().to_string(),
                    state,
                },
            );
        })
        .on_document_title_changed(move |_webview, title| {
            emit_to_main(&app_title, EVENT_TITLE, TitlePayload { title });
        })
        .on_new_window(move |url, _features| {
            // Keep target=_blank / window.open inside the pane: deny the
            // popup, then steer the embed itself to the URL. Navigation is
            // deferred off the callback to avoid re-entrancy in the
            // platform webview delegate.
            if matches!(url.scheme(), "http" | "https") {
                let app = app_popup.clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(embed) = app.get_webview(SITES_EMBED_LABEL) {
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
        .map_err(|err| format!("Cannot create sites-embed webview: {err}"))?;
    Ok(())
}

#[tauri::command]
pub async fn site_view_navigate(app: AppHandle, url: String) -> Result<(), String> {
    let target = parse_http_url(&url)?;
    get_embed(&app)?
        .navigate(target)
        .map_err(|err| format!("Cannot navigate sites-embed: {err}"))
}

#[tauri::command]
pub async fn site_view_set_bounds(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    get_embed(&app)?
        .set_bounds(embed_rect(x, y, width, height))
        .map_err(|err| format!("Cannot set sites-embed bounds: {err}"))
}

#[tauri::command]
pub async fn site_view_show(app: AppHandle) -> Result<(), String> {
    get_embed(&app)?
        .show()
        .map_err(|err| format!("Cannot show sites-embed: {err}"))
}

#[tauri::command]
pub async fn site_view_hide(app: AppHandle) -> Result<(), String> {
    get_embed(&app)?
        .hide()
        .map_err(|err| format!("Cannot hide sites-embed: {err}"))
}

#[tauri::command]
pub async fn site_view_close(app: AppHandle) -> Result<(), String> {
    // Idempotent: closing an absent embed is a no-op.
    match app.get_webview(SITES_EMBED_LABEL) {
        Some(webview) => webview
            .close()
            .map_err(|err| format!("Cannot close sites-embed: {err}")),
        None => Ok(()),
    }
}

#[tauri::command]
pub async fn site_view_reload(app: AppHandle) -> Result<(), String> {
    get_embed(&app)?
        .reload()
        .map_err(|err| format!("Cannot reload sites-embed: {err}"))
}

#[tauri::command]
pub async fn site_view_back(app: AppHandle) -> Result<(), String> {
    // Webview<R> exposes no native history API; history.back() in the
    // page context is the supported equivalent.
    get_embed(&app)?
        .eval("history.back()")
        .map_err(|err| format!("Cannot go back: {err}"))
}

#[tauri::command]
pub async fn site_view_forward(app: AppHandle) -> Result<(), String> {
    get_embed(&app)?
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
