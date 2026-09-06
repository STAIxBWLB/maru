use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::atomic_file::{with_path_transactions, PathTransactionLease, PathTransactionRequest};
use crate::win_process::NoWindow;

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyLaunchdService {
    pub label: String,
    pub plist_path: String,
    pub loaded: bool,
}

pub fn detect_legacy_telegram_launchd() -> Result<Vec<LegacyLaunchdService>, String> {
    let launch_agents = launch_agents_dir()?;
    Ok(detect_legacy_telegram_launchd_in(
        &launch_agents,
        &loaded_launchd_labels(),
    ))
}

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
    // Capture the original root and target before waiting. The request includes
    // lexical paths and their physical aliases, and pins existing parents.
    let canonical_launch_agents = fs::canonicalize(launch_agents)
        .map_err(|err| format!("launch_agents_missing: {}: {err}", launch_agents.display()))?;
    let canonical_path = fs::canonicalize(&path)
        .map_err(|err| format!("plist_missing: {}: {err}", path.display()))?;
    let path = if path.is_absolute() {
        crate::paths::lexical_normalize(&path)
    } else {
        crate::paths::lexical_normalize(
            &std::env::current_dir()
                .map_err(|err| err.to_string())?
                .join(path),
        )
    };
    let request = PathTransactionRequest::new([
        path.clone(),
        launch_agents.to_path_buf(),
        canonical_path.clone(),
        canonical_launch_agents,
    ])?
    .require_parent(launch_agents)?;
    with_path_transactions(request, |lease| {
        unload_legacy_telegram_launchd_in_transaction(
            &path,
            launch_agents,
            &canonical_path,
            unload,
            lease,
        )
    })
}

fn unload_legacy_telegram_launchd_in_transaction<F>(
    path: &Path,
    launch_agents: &Path,
    selected: &Path,
    unload: F,
    lease: &PathTransactionLease,
) -> Result<LegacyLaunchdService, String>
where
    F: Fn(&Path) -> Result<(), String>,
{
    lease.ensure_covered([
        path.to_path_buf(),
        launch_agents.to_path_buf(),
        selected.to_path_buf(),
    ])?;
    let canonical_launch_agents = fs::canonicalize(launch_agents)
        .map_err(|err| format!("launch_agents_missing: {}: {err}", launch_agents.display()))?;
    let canonical_path = fs::canonicalize(path)
        .map_err(|err| format!("plist_missing: {}: {err}", path.display()))?;
    if canonical_path.parent() != Some(canonical_launch_agents.as_path()) {
        return Err("plist_outside_launch_agents".to_string());
    }
    if canonical_path != selected {
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
    lease.before_effect()?;
    // Admission lives through child completion and final removal, including
    // errors/unwind. No separate domain lock or parent creation is necessary.
    unload(&canonical_path)?;
    fs::remove_file(&canonical_path)
        .map_err(|err| format!("Cannot remove {}: {err}", canonical_path.display()))?;
    Ok(LegacyLaunchdService {
        label,
        plist_path: canonical_path.to_string_lossy().to_string(),
        loaded: false,
    })
}

fn launch_agents_dir() -> Result<PathBuf, String> {
    Ok(crate::skill_host::fs::install_root_base()?
        .join("Library")
        .join("LaunchAgents"))
}

// Test/native fixture binaries must be explicit harmless existing executables:
// a fixture HOME alone never makes launchctl's global service labels safe.
fn launchctl_program() -> Result<PathBuf, String> {
    #[cfg(test)]
    {
        let program = if TEST_LAUNCHCTL_FAIL.load(std::sync::atomic::Ordering::SeqCst) {
            PathBuf::from("/usr/bin/false")
        } else {
            PathBuf::from("/usr/bin/true")
        };
        if !crate::cli_path::is_executable(&program) {
            return Err("launchctl_spawn_failed: harmless fixture executable missing".into());
        }
        Ok(program)
    }
    #[cfg(all(not(test), feature = "native-e2e"))]
    if std::env::var_os(crate::paths::NATIVE_E2E_HOME_VAR).is_some() {
        let program = std::env::var_os("MARU_NATIVE_E2E_LAUNCHCTL").map(PathBuf::from);
        if program.as_deref() != Some(Path::new("/usr/bin/true"))
            || !crate::cli_path::is_executable(Path::new("/usr/bin/true"))
        {
            return Err("launchctl_spawn_failed: native fixture requires /usr/bin/true".into());
        }
        return Ok(program.unwrap());
    }
    #[cfg(not(test))]
    Ok(PathBuf::from("launchctl"))
}

#[cfg(test)]
static TEST_LAUNCHCTL_FAIL: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

fn unload_launchctl(path: &Path) -> Result<(), String> {
    let output = Command::new(launchctl_program()?)
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
    let Ok(program) = launchctl_program() else {
        return Vec::new();
    };
    Command::new(program)
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

pub mod ipc {
    use super::*;

    #[tauri::command]
    pub async fn detect_legacy_telegram_launchd() -> Result<Vec<LegacyLaunchdService>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[launch_agents_dir()?],
                "worker:detect_legacy_telegram_launchd",
            );
            super::detect_legacy_telegram_launchd()
        })
        .await
        .map_err(|err| format!("detect_legacy_telegram_launchd_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn unload_legacy_telegram_launchd(
        plist_path: String,
    ) -> Result<LegacyLaunchdService, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&plist_path)],
                "worker:unload_legacy_telegram_launchd",
            );
            super::unload_legacy_telegram_launchd(plist_path)
        })
        .await
        .map_err(|err| format!("unload_legacy_telegram_launchd_task_failed: {err}"))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_monitor_plist_but_ignores_telegram_app_label() {
        let dir = tempfile::tempdir().unwrap();
        let monitor = dir.path().join("com.maru.telegram-monitor.plist");
        fs::write(
            &monitor,
            r#"<plist><dict><key>Label</key><string>com.maru.telegram-monitor</string><key>ProgramArguments</key><array><string>telegram_monitor.py</string></array></dict></plist>"#,
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
            &["com.maru.telegram-monitor".to_string()],
        );
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].label, "com.maru.telegram-monitor");
        assert!(found[0].loaded);
    }

    #[test]
    fn unload_rejects_matching_plist_outside_launch_agents() {
        let dir = tempfile::tempdir().unwrap();
        let launch_agents = dir.path().join("LaunchAgents");
        fs::create_dir_all(&launch_agents).unwrap();
        let outside = dir.path().join("com.maru.telegram-monitor.plist");
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
        let monitor = launch_agents.join("com.maru.telegram-monitor.plist");
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
        let monitor = launch_agents.join("com.maru.telegram-monitor.plist");
        write_monitor_plist(&monitor);

        let outcome =
            unload_legacy_telegram_launchd_in(&monitor.to_string_lossy(), &launch_agents, |_| {
                Ok(())
            })
            .unwrap();

        assert_eq!(outcome.label, "com.maru.telegram-monitor");
        assert!(!monitor.exists());
    }

    fn write_monitor_plist(path: &Path) {
        fs::write(
            path,
            r#"<plist><dict><key>Label</key><string>com.maru.telegram-monitor</string><key>ProgramArguments</key><array><string>telegram_monitor.py</string></array></dict></plist>"#,
        )
        .unwrap();
    }
}

#[cfg(all(test, unix))]
mod phase08_15 {
    use super::*;
    use crate::atomic_file::phase08_06::{boundary, run, Held, Home};
    use crate::atomic_file::PathTransactionTestHook;
    use crate::scratchpad::phase08_08::{registry, PrimaryWorkspaceAccessFixture};
    use std::sync::{mpsc, Arc};
    use std::thread;
    use std::time::Duration;

    fn fixture(home: &Home) -> PathBuf {
        let root = home.root.path().join("Library/LaunchAgents");
        fs::create_dir_all(&root).unwrap();
        let plist = root.join("com.maru.telegram-monitor.plist");
        fs::write(&plist, "<plist><key>Label</key><string>com.maru.telegram-monitor</string><string>telegram_monitor.py</string></plist>").unwrap();
        assert_eq!(launchctl_program().unwrap(), Path::new("/usr/bin/true"));
        assert!(crate::cli_path::is_executable(Path::new("/usr/bin/true")));
        plist
    }

    #[test]
    fn phase08_15_launchd_real_wrappers_and_legacy_errors() {
        let home = Home::new();
        let plist = fixture(&home);
        let found = run(ipc::detect_legacy_telegram_launchd()).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].label, "com.maru.telegram-monitor");
        let outside = home.root.path().join("outside-telegram-monitor.plist");
        fs::copy(&plist, &outside).unwrap();
        assert_eq!(
            run(ipc::unload_legacy_telegram_launchd(
                outside.to_string_lossy().into_owned()
            ))
            .unwrap_err(),
            "plist_outside_launch_agents"
        );
        let result = run(ipc::unload_legacy_telegram_launchd(
            plist.to_string_lossy().into_owned(),
        ))
        .unwrap();
        assert_eq!(result.label, found[0].label);
        assert!(!result.loaded);
        assert!(!plist.exists());
        assert!(run(ipc::unload_legacy_telegram_launchd(
            plist.to_string_lossy().into_owned()
        ))
        .unwrap_err()
        .starts_with("plist_missing:"));
    }

    #[test]
    fn phase08_15_launchd_both_workers_yield_and_join_errors() {
        let home = Home::new();
        let plist = fixture(&home);
        boundary(
            plist.parent().unwrap().into(),
            "detect_legacy_telegram_launchd",
            ipc::detect_legacy_telegram_launchd(),
        );
        boundary(
            plist.clone(),
            "unload_legacy_telegram_launchd",
            ipc::unload_legacy_telegram_launchd(plist.to_string_lossy().into_owned()),
        );
        assert!(plist.exists());
    }

    #[test]
    fn phase08_15_launchd_same_target_and_launch_failure_release() {
        let home = Home::new();
        let plist = fixture(&home);
        struct Reset;
        impl Drop for Reset {
            fn drop(&mut self) {
                TEST_LAUNCHCTL_FAIL.store(false, std::sync::atomic::Ordering::SeqCst);
            }
        }
        let reset = Reset;
        TEST_LAUNCHCTL_FAIL.store(true, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(launchctl_program().unwrap(), Path::new("/usr/bin/false"));
        let failed = run(ipc::unload_legacy_telegram_launchd(
            plist.to_string_lossy().into_owned(),
        ));
        assert!(failed.unwrap_err().starts_with("launchctl_unload_failed:"));
        assert!(plist.exists());
        drop(reset);
        let held = Held::new(plist.clone(), "pre-effect");
        let first_path = plist.to_string_lossy().into_owned();
        let first = thread::spawn(move || run(ipc::unload_legacy_telegram_launchd(first_path)));
        held.wait();
        let waiting = Held::new(plist.clone(), "before-admission");
        let second_path = plist.to_string_lossy().into_owned();
        let (tx, rx) = mpsc::channel();
        let second = thread::spawn(move || {
            tx.send(run(ipc::unload_legacy_telegram_launchd(second_path)))
                .unwrap();
        });
        waiting.wait();
        waiting.release();
        assert!(rx.recv_timeout(Duration::from_millis(40)).is_err());
        held.release();
        assert!(first.join().unwrap().is_ok());
        assert!(rx.recv_timeout(Duration::from_secs(5)).unwrap().is_err());
        second.join().unwrap();
        assert!(!plist.exists());
    }

    #[test]
    fn phase08_15_launchd_files_parent_race_both_orders_and_aliases() {
        let home = Home::new();
        registry(home.root.path(), "direct");
        let _access = PrimaryWorkspaceAccessFixture::new(home.root.path().into());
        for files_first in [false, true] {
            for alias in [false, true] {
                let plist = fixture(&home);
                let agents = plist.parent().unwrap().to_path_buf();
                let alias_root = home.root.path().join("agents-alias");
                std::os::unix::fs::symlink(&agents, &alias_root).unwrap();
                let selected = if alias {
                    alias_root.join(plist.file_name().unwrap())
                } else {
                    plist.clone()
                };
                let held = Held::new(
                    if files_first {
                        agents.clone()
                    } else {
                        selected.clone()
                    },
                    "admitted",
                );
                let (writer_tx, writer_rx) = mpsc::channel();
                let writer_path = selected.to_string_lossy().into_owned();
                let writer = move || {
                    writer_tx
                        .send(run(ipc::unload_legacy_telegram_launchd(writer_path)))
                        .unwrap();
                };
                let (files_tx, files_rx) = mpsc::channel();
                let root = home.root.path().to_string_lossy().into_owned();
                let files = move || {
                    files_tx
                        .send(run(crate::workspace_files::ipc::rename_workspace_entry(
                            root,
                            "Library/LaunchAgents".into(),
                            "moved".into(),
                        )))
                        .unwrap();
                };
                let (first, second) = if files_first {
                    let first = thread::spawn(files);
                    held.wait();
                    let waiting = Held::new(selected, "before-admission");
                    let second = thread::spawn(writer);
                    waiting.wait();
                    waiting.release();
                    assert!(writer_rx.recv_timeout(Duration::from_millis(40)).is_err());
                    held.release();
                    (first, second)
                } else {
                    let first = thread::spawn(writer);
                    held.wait();
                    let waiting = Held::new(agents.clone(), "before-admission");
                    let second = thread::spawn(files);
                    waiting.wait();
                    waiting.release();
                    assert!(files_rx.recv_timeout(Duration::from_millis(40)).is_err());
                    held.release();
                    (first, second)
                };
                first.join().unwrap();
                second.join().unwrap();
                assert!(files_rx
                    .recv_timeout(Duration::from_secs(5))
                    .unwrap()
                    .is_ok());
                assert_eq!(
                    writer_rx
                        .recv_timeout(Duration::from_secs(5))
                        .unwrap()
                        .is_ok(),
                    !files_first
                );
                assert!(!agents.exists());
                assert_eq!(
                    home.root
                        .path()
                        .join("Library/moved")
                        .join(plist.file_name().unwrap())
                        .exists(),
                    files_first
                );
                fs::remove_file(alias_root).unwrap();
                fs::remove_dir_all(home.root.path().join("Library/moved")).unwrap();
            }
        }
    }

    #[test]
    fn phase08_15_launchd_document_contention_both_orders_and_aliases() {
        let home = Home::new();
        registry(home.root.path(), "direct");
        let _access = PrimaryWorkspaceAccessFixture::new(home.root.path().into());
        for document_first in [false, true] {
            for alias in [false, true] {
                let plist = fixture(&home);
                let note = plist.parent().unwrap().join("note.md");
                fs::write(&note, "# Before\n").unwrap();
                let alias_root = home.root.path().join("agents-alias");
                std::os::unix::fs::symlink(plist.parent().unwrap(), &alias_root).unwrap();
                let selected = if alias {
                    alias_root.join(plist.file_name().unwrap())
                } else {
                    plist.clone()
                };
                let held = Held::new(
                    if document_first {
                        note.clone()
                    } else {
                        selected.clone()
                    },
                    "admitted",
                );
                let (writer_tx, writer_rx) = mpsc::channel();
                let writer_path = selected.to_string_lossy().into_owned();
                let writer = move || {
                    writer_tx
                        .send(run(ipc::unload_legacy_telegram_launchd(writer_path)))
                        .unwrap();
                };
                let (document_tx, document_rx) = mpsc::channel();
                let root = home.root.path().to_string_lossy().into_owned();
                let document = move || {
                    document_tx
                        .send(run(crate::document::ipc::save_document(
                            root,
                            "Library/LaunchAgents/note.md".into(),
                            "# After\n".into(),
                            None,
                        )))
                        .unwrap();
                };
                let (first, second) = if document_first {
                    let first = thread::spawn(document);
                    held.wait();
                    let waiting = Held::new(selected, "before-admission");
                    let second = thread::spawn(writer);
                    waiting.wait();
                    waiting.release();
                    assert!(writer_rx.recv_timeout(Duration::from_millis(40)).is_err());
                    held.release();
                    (first, second)
                } else {
                    let first = thread::spawn(writer);
                    held.wait();
                    let waiting = Held::new(note.clone(), "before-admission");
                    let second = thread::spawn(document);
                    waiting.wait();
                    waiting.release();
                    assert!(document_rx.recv_timeout(Duration::from_millis(40)).is_err());
                    held.release();
                    (first, second)
                };
                first.join().unwrap();
                second.join().unwrap();
                assert!(document_rx
                    .recv_timeout(Duration::from_secs(5))
                    .unwrap()
                    .is_ok());
                assert!(writer_rx
                    .recv_timeout(Duration::from_secs(5))
                    .unwrap()
                    .is_ok());
                assert_eq!(fs::read_to_string(note).unwrap(), "# After\n");
                fs::remove_file(alias_root).unwrap();
            }
        }
    }

    #[test]
    fn phase08_15_launchd_unwind_and_replaced_parent_release() {
        let home = Home::new();
        let plist = fixture(&home);
        let hook = PathTransactionTestHook::new(plist.clone(), "pre-effect", || {
            panic!("fixture admitted unwind")
        });
        let err = run(ipc::unload_legacy_telegram_launchd(
            plist.to_string_lossy().into_owned(),
        ))
        .unwrap_err();
        assert!(err.starts_with("unload_legacy_telegram_launchd_task_failed:"));
        drop(hook);
        assert!(plist.exists());
        let agents = plist.parent().unwrap().to_path_buf();
        let moved = home.root.path().join("old-agents");
        let replacement = agents.clone();
        let moved_for_hook = moved.clone();
        let once = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let hook = PathTransactionTestHook::new(plist.clone(), "before-admission", move || {
            if !once.swap(true, std::sync::atomic::Ordering::SeqCst) {
                fs::rename(&replacement, &moved_for_hook).unwrap();
                fs::create_dir(&replacement).unwrap();
            }
        });
        assert!(run(ipc::unload_legacy_telegram_launchd(
            plist.to_string_lossy().into_owned()
        ))
        .is_err());
        drop(hook);
        assert!(!plist.exists());
        assert!(moved.join(plist.file_name().unwrap()).exists());
        fs::remove_dir(&agents).unwrap();
        fs::rename(&moved, &agents).unwrap();
        assert!(run(ipc::unload_legacy_telegram_launchd(
            plist.to_string_lossy().into_owned()
        ))
        .is_ok());
    }
}
