//! Central routing policy for application commands.

use tauri::{ipc::Invoke, Runtime};

const APP_COMMAND_REFUSAL: &str =
    "app_command_unavailable: this webview cannot dispatch app commands";

/// Only the two first-party webviews created by the app may dispatch its
/// commands. Plugin commands retain Tauri's separate capability checks.
pub(crate) fn restrict_app_commands<R: Runtime>(
    handler: impl Fn(Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        if !matches!(
            invoke.message.webview_ref().label(),
            "main" | "skill-editor"
        ) {
            invoke.resolver.reject(APP_COMMAND_REFUSAL);
            return true;
        }
        handler(invoke)
    }
}
