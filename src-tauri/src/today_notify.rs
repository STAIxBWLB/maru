// Maru Today — native new-day notification.
//
// Title/body come from the frontend so i18n stays in TypeScript. When OS
// permission is denied (or unavailable), the command returns
// `{ sent: false, permission: "denied" }` and the frontend falls back to
// its in-app banner. Limitations: no click-to-focus wiring — the plugin's
// click listener is JS-side (`registerListener`), so the frontend owns
// focus handling; native notifications do not steal focus by default.

use crate::vault::normalize_existing_dir;
use serde::Serialize;
use tauri_plugin_notification::{NotificationExt, PermissionState};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TodayNotifyOutcome {
    pub sent: bool,
    pub permission: String,
}

fn permission_label(state: PermissionState) -> &'static str {
    match state {
        PermissionState::Granted => "granted",
        PermissionState::Denied => "denied",
        PermissionState::Prompt | PermissionState::PromptWithRationale => "prompt",
    }
}

#[tauri::command]
pub fn today_notify_new_day(
    app: tauri::AppHandle,
    work_path: String,
    logical_day: String,
    title: Option<String>,
    body: Option<String>,
) -> Result<TodayNotifyOutcome, String> {
    let _work = normalize_existing_dir(&work_path)?;
    let notification = app.notification();
    let mut state = notification
        .permission_state()
        .map_err(|err| format!("today_notify_permission_failed: {err}"))?;
    if matches!(
        state,
        PermissionState::Prompt | PermissionState::PromptWithRationale
    ) {
        state = notification
            .request_permission()
            .map_err(|err| format!("today_notify_permission_failed: {err}"))?;
    }
    if state != PermissionState::Granted {
        return Ok(TodayNotifyOutcome {
            sent: false,
            permission: permission_label(state).to_string(),
        });
    }
    notification
        .builder()
        .title(
            title
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "New day".to_string()),
        )
        .body(
            body.filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| format!("A new day ({logical_day}) has started.")),
        )
        .show()
        .map_err(|err| format!("today_notify_failed: {err}"))?;
    Ok(TodayNotifyOutcome {
        sent: true,
        permission: "granted".to_string(),
    })
}
