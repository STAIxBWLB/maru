//! Central routing policy for application commands.

use tauri::{ipc::Invoke, Manager, Runtime, Url, Webview};

const APP_COMMAND_REFUSAL: &str =
    "app_command_unavailable: this webview cannot dispatch app commands; use the Maru main window or skill editor";

/// Match origins explicitly: custom `tauri` URLs have opaque URL origins.
/// The configured HTTP(S) development origin is admitted only in debug builds.
pub(crate) fn is_app_origin(url: &Url, dev_url: Option<&Url>, debug: bool) -> bool {
    if url.port().is_none()
        && matches!(
            (url.scheme(), url.host_str()),
            ("tauri", Some("localhost")) | ("http", Some("tauri.localhost"))
        )
    {
        return true;
    }
    debug
        && matches!(url.scheme(), "http" | "https")
        && dev_url.is_some_and(|dev| {
            matches!(dev.scheme(), "http" | "https") && url.origin() == dev.origin()
        })
}

pub(crate) fn is_app_url(url: &Url, dev_url: Option<&Url>, debug: bool) -> bool {
    url.username().is_empty() && url.password().is_none() && is_app_origin(url, dev_url, debug)
}

pub(crate) fn is_first_party_webview<R: Runtime>(webview: &Webview<R>) -> bool {
    matches!(webview.label(), "main" | "skill-editor")
        && webview.url().is_ok_and(|url| {
            is_app_url(
                &url,
                webview.app_handle().config().build.dev_url.as_ref(),
                cfg!(debug_assertions),
            )
        })
}

/// Application dispatch requires both a first-party label and its current
/// native URL. Public Invoke does not expose the requesting subframe URL;
/// caller-supplied headers are intentionally not used as authentication.
pub(crate) fn restrict_app_commands<R: Runtime>(
    handler: impl Fn(Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        let allowed = is_first_party_webview(invoke.message.webview_ref());
        if !allowed {
            invoke.resolver.reject(APP_COMMAND_REFUSAL);
            return true;
        }
        handler(invoke)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_origins_and_configured_debug_origin_are_explicit() {
        let dev = Url::parse("http://127.0.0.1:5307/").unwrap();
        for text in [
            "tauri://localhost/index.html?window=skill-editor",
            "http://tauri.localhost/index.html",
            "http://tauri.localhost:80/",
        ] {
            let url = Url::parse(text).unwrap();
            assert!(is_app_url(&url, Some(&dev), false), "{text}");
            assert!(is_app_url(&url, None, true), "{text}");
        }
        let url = Url::parse("http://127.0.0.1:5307/editor?window=skill-editor").unwrap();
        assert!(is_app_url(&url, Some(&dev), true));
        assert!(!is_app_url(&url, Some(&dev), false));
        assert!(!is_app_url(&url, None, true));
        for text in [
            "https://example.invalid/",
            "http://127.0.0.1:5308/",
            "http://localhost:5307/",
            "https://127.0.0.1:5307/",
            "tauri://other/",
            "asset://localhost/",
            "https://tauri.localhost/",
            "http://tauri.localhost:8000/",
            "tauri://localhost:1234/",
            "http://user@tauri.localhost/",
            "http://user:password@127.0.0.1:5307/",
            "about:blank",
        ] {
            assert!(
                !is_app_url(&Url::parse(text).unwrap(), Some(&dev), true),
                "{text}"
            );
        }
    }
}
