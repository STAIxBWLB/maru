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

pub fn today_notify_new_day<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
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

/// Owned IPC boundary; the synchronous function remains the Rust/CLI API and
/// the workspace check plus the native notification dispatch run on a finite
/// blocking worker, never on the main or shared async runtime thread.
pub mod ipc {
    use super::*;

    #[tauri::command]
    pub async fn today_notify_new_day<R: tauri::Runtime>(
        app: tauri::AppHandle<R>,
        work_path: String,
        logical_day: String,
        title: Option<String>,
        body: Option<String>,
    ) -> Result<TodayNotifyOutcome, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            crate::atomic_file::PathTransactionLease::test_stage(
                &[std::path::PathBuf::from(&work_path)],
                "worker:today_notify_new_day",
            );
            super::today_notify_new_day(app, work_path, logical_day, title, body)
        })
        .await
        .map_err(|err| format!("today_notify_new_day_task_failed: {err}"))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::atomic_file::phase08_06::{boundary, run};

    fn notify_app() -> tauri::App<tauri::test::MockRuntime> {
        tauri::test::mock_builder()
            .plugin(tauri_plugin_notification::init())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("build mock app with the notification plugin")
    }

    #[test]
    fn phase08_24_today_notify_wrappers_yield_same_poll_and_map_join_failure() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().to_string_lossy().to_string();
        let app = notify_app();
        boundary(
            tmp.path().to_path_buf(),
            "today_notify_new_day",
            ipc::today_notify_new_day(app.handle().clone(), work, "2026-09-06".into(), None, None),
        );
    }

    #[test]
    fn phase08_24_today_notify_real_fixture_results_and_rejections() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().to_string_lossy().to_string();
        let app = notify_app();
        let app = app.handle().clone();
        run(async move {
            let outcome =
                ipc::today_notify_new_day(app.clone(), work, "2026-09-06".into(), None, None)
                    .await
                    .unwrap();
            assert_eq!(
                outcome,
                TodayNotifyOutcome {
                    sent: true,
                    permission: "granted".to_string(),
                }
            );

            let error = ipc::today_notify_new_day(
                app,
                "/definitely/not/a/real/work-dir-xyz".into(),
                "2026-09-06".into(),
                None,
                None,
            )
            .await
            .unwrap_err();
            assert!(
                error.contains("Cannot open workspace directory"),
                "unexpected error: {error}"
            );
        });
    }
}
