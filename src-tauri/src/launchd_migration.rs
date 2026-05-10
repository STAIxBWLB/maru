use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

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
    let launch_agents = dirs::home_dir()
        .ok_or_else(|| "Cannot resolve home directory".to_string())?
        .join("Library")
        .join("LaunchAgents");
    Ok(detect_legacy_telegram_launchd_in(
        &launch_agents,
        &loaded_launchd_labels(),
    ))
}

#[tauri::command]
pub fn unload_legacy_telegram_launchd(plist_path: String) -> Result<LegacyLaunchdService, String> {
    let path = PathBuf::from(plist_path.trim());
    if !is_legacy_telegram_monitor_plist(&path) {
        return Err("not_legacy_telegram_monitor_plist".to_string());
    }
    let label = label_from_plist(&path).unwrap_or_else(|| {
        path.file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("telegram-monitor")
            .to_string()
    });
    let _ = Command::new("launchctl").arg("unload").arg(&path).output();
    fs::remove_file(&path)
        .map_err(|err| format!("Cannot remove {}: {err}", path.to_string_lossy()))?;
    Ok(LegacyLaunchdService {
        label,
        plist_path: path.to_string_lossy().to_string(),
        loaded: false,
    })
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
}
