use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::win_process::NoWindow;

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyLaunchdService {
    pub label: String,
    pub plist_path: String,
    pub loaded: bool,
}

#[tauri::command]
pub fn detect_legacy_telegram_launchd() -> Result<Vec<LegacyLaunchdService>, String> {
    let launch_agents = launch_agents_dir()?;
    Ok(detect_legacy_telegram_launchd_in(
        &launch_agents,
        &loaded_launchd_labels(),
    ))
}

#[tauri::command]
pub fn unload_legacy_telegram_launchd(plist_path: String) -> Result<LegacyLaunchdService, String> {
    let launch_agents = launch_agents_dir()?;
    unload_legacy_telegram_launchd_in(&plist_path, &launch_agents, unload_launchctl)
}

fn unload_legacy_telegram_launchd_in<F>(
    plist_path: &str,
    launch_agents: &Path,
    unload: F,
) -> Result<LegacyLaunchdService, String>
where
    F: Fn(&Path) -> Result<(), String>,
{
    let path = PathBuf::from(plist_path.trim());
    let canonical_launch_agents = fs::canonicalize(launch_agents).map_err(|err| {
        format!(
            "launch_agents_missing: {}: {err}",
            launch_agents.to_string_lossy()
        )
    })?;
    let canonical_path = fs::canonicalize(&path)
        .map_err(|err| format!("plist_missing: {}: {err}", path.to_string_lossy()))?;
    if canonical_path.parent() != Some(canonical_launch_agents.as_path()) {
        return Err("plist_outside_launch_agents".to_string());
    }
    if !is_legacy_telegram_monitor_plist(&canonical_path) {
        return Err("not_legacy_telegram_monitor_plist".to_string());
    }
    let label = label_from_plist(&canonical_path).unwrap_or_else(|| {
        canonical_path
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("telegram-monitor")
            .to_string()
    });
    unload(&canonical_path)?;
    fs::remove_file(&canonical_path)
        .map_err(|err| format!("Cannot remove {}: {err}", canonical_path.to_string_lossy()))?;
    Ok(LegacyLaunchdService {
        label,
        plist_path: canonical_path.to_string_lossy().to_string(),
        loaded: false,
    })
}

fn launch_agents_dir() -> Result<PathBuf, String> {
    Ok(dirs::home_dir()
        .ok_or_else(|| "Cannot resolve home directory".to_string())?
        .join("Library")
        .join("LaunchAgents"))
}

fn unload_launchctl(path: &Path) -> Result<(), String> {
    let output = Command::new("launchctl")
        .arg("unload")
        .arg(path)
        .no_window()
        .output()
        .map_err(|err| format!("launchctl_spawn_failed: {err}"))?;
    if output.status.success() {
        return Ok(());
    }
    let detail = [output.stderr.as_slice(), output.stdout.as_slice()]
        .into_iter()
        .map(|bytes| String::from_utf8_lossy(bytes).trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    Err(format!("launchctl_unload_failed: {detail}"))
}

fn detect_legacy_telegram_launchd_in(
    launch_agents: &Path,
    loaded_labels: &[String],
) -> Vec<LegacyLaunchdService> {
    let Ok(entries) = fs::read_dir(launch_agents) else {
        return Vec::new();
    };
    let mut services = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| is_legacy_telegram_monitor_plist(path))
        .map(|path| {
            let label = label_from_plist(&path).unwrap_or_else(|| {
                path.file_stem()
                    .and_then(|name| name.to_str())
                    .unwrap_or("telegram-monitor")
                    .to_string()
            });
            LegacyLaunchdService {
                loaded: loaded_labels.iter().any(|loaded| loaded == &label),
                label,
                plist_path: path.to_string_lossy().to_string(),
            }
        })
        .collect::<Vec<_>>();
    services.sort_by(|a, b| a.label.cmp(&b.label));
    services
}

fn loaded_launchd_labels() -> Vec<String> {
    Command::new("launchctl")
        .arg("list")
        .no_window()
        .output()
        .ok()
        .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
        .unwrap_or_default()
        .lines()
        .filter_map(|line| line.split_whitespace().last())
        .map(ToString::to_string)
        .collect()
}

fn is_legacy_telegram_monitor_plist(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    if !name.ends_with(".plist") {
        return false;
    }
    let lower_name = name.to_lowercase();
    if !lower_name.contains("telegram") {
        return false;
    }
    let content = fs::read_to_string(path).unwrap_or_default().to_lowercase();
    let haystack = format!("{lower_name}\n{content}");
    if haystack.contains("application.ru.keepcoder.telegram") {
        return false;
    }
    haystack.contains("telegram-monitor")
        || haystack.contains("telegram_monitor")
        || haystack.contains("io-telegram")
        || (haystack.contains("telethon") && haystack.contains("monitor"))
}

fn label_from_plist(path: &Path) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    let label_key = content.find("<key>Label</key>")?;
    let rest = &content[label_key..];
    let open = rest.find("<string>")? + "<string>".len();
    let close = rest[open..].find("</string>")?;
    let label = rest[open..open + close].trim();
    (!label.is_empty()).then(|| label.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_monitor_plist_but_ignores_telegram_app_label() {
        let dir = tempfile::tempdir().unwrap();
        let monitor = dir.path().join("com.anchor.telegram-monitor.plist");
        fs::write(
            &monitor,
            r#"<plist><dict><key>Label</key><string>com.anchor.telegram-monitor</string><key>ProgramArguments</key><array><string>telegram_monitor.py</string></array></dict></plist>"#,
        )
        .unwrap();
        let app = dir
            .path()
            .join("application.ru.keepcoder.Telegram.123.plist");
        fs::write(
            &app,
            r#"<plist><dict><key>Label</key><string>application.ru.keepcoder.Telegram.123</string></dict></plist>"#,
        )
        .unwrap();
        let found = detect_legacy_telegram_launchd_in(
            dir.path(),
            &["com.anchor.telegram-monitor".to_string()],
        );
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].label, "com.anchor.telegram-monitor");
        assert!(found[0].loaded);
    }

    #[test]
    fn unload_rejects_matching_plist_outside_launch_agents() {
        let dir = tempfile::tempdir().unwrap();
        let launch_agents = dir.path().join("LaunchAgents");
        fs::create_dir_all(&launch_agents).unwrap();
        let outside = dir.path().join("com.anchor.telegram-monitor.plist");
        write_monitor_plist(&outside);

        let err =
            unload_legacy_telegram_launchd_in(&outside.to_string_lossy(), &launch_agents, |_| {
                panic!("launchctl should not run for paths outside LaunchAgents");
            })
            .unwrap_err();

        assert_eq!(err, "plist_outside_launch_agents");
        assert!(outside.exists());
    }

    #[test]
    fn unload_keeps_plist_when_launchctl_fails() {
        let dir = tempfile::tempdir().unwrap();
        let launch_agents = dir.path().join("LaunchAgents");
        fs::create_dir_all(&launch_agents).unwrap();
        let monitor = launch_agents.join("com.anchor.telegram-monitor.plist");
        write_monitor_plist(&monitor);

        let err =
            unload_legacy_telegram_launchd_in(&monitor.to_string_lossy(), &launch_agents, |_| {
                Err("launchctl_unload_failed: test".to_string())
            })
            .unwrap_err();

        assert_eq!(err, "launchctl_unload_failed: test");
        assert!(monitor.exists());
    }

    #[test]
    fn unload_removes_launch_agents_monitor_after_success() {
        let dir = tempfile::tempdir().unwrap();
        let launch_agents = dir.path().join("LaunchAgents");
        fs::create_dir_all(&launch_agents).unwrap();
        let monitor = launch_agents.join("com.anchor.telegram-monitor.plist");
        write_monitor_plist(&monitor);

        let outcome =
            unload_legacy_telegram_launchd_in(&monitor.to_string_lossy(), &launch_agents, |_| {
                Ok(())
            })
            .unwrap();

        assert_eq!(outcome.label, "com.anchor.telegram-monitor");
        assert!(!monitor.exists());
    }

    fn write_monitor_plist(path: &Path) {
        fs::write(
            path,
            r#"<plist><dict><key>Label</key><string>com.anchor.telegram-monitor</string><key>ProgramArguments</key><array><string>telegram_monitor.py</string></array></dict></plist>"#,
        )
        .unwrap();
    }
}
