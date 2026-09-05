use crate::vault::resolve_inside_vault;
use crate::win_process::NoWindow;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, PartialEq, Eq)]
struct RevealCommand {
    program: String,
    args: Vec<String>,
}

pub fn reveal_in_file_manager(vault_path: String, target_path: String) -> Result<(), String> {
    let target = resolve_file_manager_target(&vault_path, &target_path)?;
    let command = build_reveal_command(&target)?;
    launch_file_manager(command, "reveal")
}

pub fn open_in_file_manager(vault_path: String, target_path: String) -> Result<(), String> {
    let target = resolve_file_manager_target(&vault_path, &target_path)?;
    let command = build_open_command(&target)?;
    launch_file_manager(command, "open")
}

fn launch_file_manager(command: RevealCommand, action: &str) -> Result<(), String> {
    #[cfg(test)]
    if let Some(fixture) = phase08_07::capture() {
        // Only tests can replace the native launcher. Exercise a real process
        // using this test executable, never the user's installed file manager.
        fixture.commands.lock().unwrap().push(command);
        let mut child = Command::new(&fixture.program)
            .args([
                "--exact",
                "file_manager::tests::phase08_07_native_fixture_child",
            ])
            .env("MARU_PHASE08_07_FILE_MANAGER_MARKER", &fixture.marker)
            .no_window()
            .spawn()
            .map_err(|err| format!("Cannot {action} target: {err}"))?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                result => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "Cannot {action} target: fixture did not exit: {result:?}"
                    ));
                }
            }
        };
        return if status.success() {
            Ok(())
        } else {
            Err(format!("Cannot {action} target: fixture failed"))
        };
    }
    Command::new(&command.program)
        .args(&command.args)
        .no_window()
        .spawn()
        .map_err(|err| format!("Cannot {action} target: {err}"))?;
    Ok(())
}

pub mod ipc {
    #[tauri::command]
    pub async fn reveal_in_file_manager(
        vault_path: String,
        target_path: String,
    ) -> Result<(), String> {
        #[cfg(test)]
        let fixture = super::phase08_07::capture();
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            let _fixture = super::phase08_07::enter(fixture);
            #[cfg(test)]
            crate::atomic_file::PathTransactionLease::test_stage(
                &[std::path::PathBuf::from(&vault_path)],
                "worker:reveal_in_file_manager",
            );
            super::reveal_in_file_manager(vault_path, target_path)
        })
        .await
        .map_err(|err| format!("reveal_in_file_manager_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn open_in_file_manager(
        vault_path: String,
        target_path: String,
    ) -> Result<(), String> {
        #[cfg(test)]
        let fixture = super::phase08_07::capture();
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            let _fixture = super::phase08_07::enter(fixture);
            #[cfg(test)]
            crate::atomic_file::PathTransactionLease::test_stage(
                &[std::path::PathBuf::from(&vault_path)],
                "worker:open_in_file_manager",
            );
            super::open_in_file_manager(vault_path, target_path)
        })
        .await
        .map_err(|err| format!("open_in_file_manager_task_failed: {err}"))?
    }
}

#[cfg(test)]
mod phase08_07 {
    use super::RevealCommand;
    use std::{
        cell::RefCell,
        path::PathBuf,
        sync::{Arc, Mutex},
    };
    pub(super) struct Fixture {
        pub(super) program: PathBuf,
        pub(super) marker: PathBuf,
        pub(super) commands: Mutex<Vec<RevealCommand>>,
    }
    thread_local! {
        static FIXTURE: RefCell<Option<Arc<Fixture>>> = const { RefCell::new(None) };
    }
    pub(super) fn capture() -> Option<Arc<Fixture>> {
        FIXTURE.with(|slot| slot.borrow().clone())
    }
    pub(super) struct Guard(Option<Arc<Fixture>>);
    pub(super) fn enter(fixture: Option<Arc<Fixture>>) -> Guard {
        Guard(FIXTURE.with(|slot| slot.replace(fixture)))
    }
    impl Drop for Guard {
        fn drop(&mut self) {
            FIXTURE.with(|slot| slot.replace(self.0.take()));
        }
    }
}

fn resolve_file_manager_target(vault_path: &str, target_path: &str) -> Result<PathBuf, String> {
    let expanded = expand_user_path(target_path);
    let expanded_target = expanded
        .to_str()
        .ok_or_else(|| "File manager target path is not valid UTF-8".to_string())?;
    let target = resolve_inside_vault(vault_path, expanded_target)?;
    if !target.exists() {
        return Err(format!(
            "File manager target does not exist: {}",
            target.display()
        ));
    }
    Ok(target)
}

fn expand_user_path(input: &str) -> PathBuf {
    if let Some(rest) = input.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    if input == "~" {
        if let Some(home) = dirs::home_dir() {
            return home;
        }
    }
    PathBuf::from(input)
}

fn build_reveal_command(target: &Path) -> Result<RevealCommand, String> {
    let target = target
        .to_str()
        .ok_or_else(|| "Reveal target path is not valid UTF-8".to_string())?
        .to_string();
    #[cfg(target_os = "macos")]
    {
        Ok(RevealCommand {
            program: "open".to_string(),
            args: vec!["-R".to_string(), target],
        })
    }
    #[cfg(target_os = "windows")]
    {
        Ok(RevealCommand {
            program: "explorer".to_string(),
            args: vec![format!("/select,{target}")],
        })
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let path = Path::new(&target);
        let open_target = if path.is_file() {
            path.parent().unwrap_or(path)
        } else {
            path
        };
        Ok(RevealCommand {
            program: "xdg-open".to_string(),
            args: vec![open_target.to_string_lossy().to_string()],
        })
    }
}

fn build_open_command(target: &Path) -> Result<RevealCommand, String> {
    let target = target
        .to_str()
        .ok_or_else(|| "Open target path is not valid UTF-8".to_string())?
        .to_string();
    #[cfg(target_os = "macos")]
    {
        Ok(RevealCommand {
            program: "open".to_string(),
            args: vec![target],
        })
    }
    #[cfg(target_os = "windows")]
    {
        Ok(RevealCommand {
            program: "explorer".to_string(),
            args: vec![target],
        })
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Ok(RevealCommand {
            program: "xdg-open".to_string(),
            args: vec![target],
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn phase08_07_native_fixture_child() {
        if let Some(marker) = std::env::var_os("MARU_PHASE08_07_FILE_MANAGER_MARKER") {
            std::fs::write(marker, "native fixture ran").unwrap();
        }
    }

    #[test]
    fn reveal_target_must_stay_inside_vault() {
        let tmp = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let outside_file = outside.path().join("outside.md");
        fs::write(&outside_file, "x").unwrap();

        let err = resolve_file_manager_target(
            tmp.path().to_str().unwrap(),
            outside_file.to_str().unwrap(),
        )
        .unwrap_err();
        assert!(err.contains("escapes"));
    }

    #[test]
    fn reveal_target_must_exist() {
        let tmp = TempDir::new().unwrap();
        let err =
            resolve_file_manager_target(tmp.path().to_str().unwrap(), "missing.md").unwrap_err();
        assert!(err.contains("does not exist"));
    }

    #[test]
    fn file_manager_target_expands_tilde_inside_vault() {
        let home = dirs::home_dir().expect("home directory should be available for tilde tests");
        let tmp = tempfile::Builder::new()
            .prefix("maru-file-manager-")
            .tempdir_in(&home)
            .unwrap();
        let target = tmp.path().join("inbox");
        fs::create_dir(&target).unwrap();
        let rel_to_home = target.strip_prefix(&home).unwrap();
        let target_path = format!("~/{}", rel_to_home.to_string_lossy());

        let resolved =
            resolve_file_manager_target(tmp.path().to_str().unwrap(), &target_path).unwrap();

        assert_eq!(resolved, target);
    }

    #[test]
    fn file_manager_target_rejects_tilde_outside_vault() {
        let tmp = TempDir::new().unwrap();

        let err = resolve_file_manager_target(tmp.path().to_str().unwrap(), "~").unwrap_err();

        assert!(err.contains("escapes"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_reveal_command_uses_open_r() {
        let tmp = TempDir::new().unwrap();
        let target = tmp.path().join("note.md");
        fs::write(&target, "x").unwrap();
        let command = build_reveal_command(&target).unwrap();
        assert_eq!(command.program, "open");
        assert_eq!(command.args, vec!["-R", target.to_str().unwrap()]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_open_command_uses_open() {
        let tmp = TempDir::new().unwrap();
        let command = build_open_command(tmp.path()).unwrap();
        assert_eq!(command.program, "open");
        assert_eq!(command.args, vec![tmp.path().to_str().unwrap()]);
    }
}

#[cfg(test)]
mod phase08_07_tests {
    use super::*;
    use crate::atomic_file::phase08_06::{boundary, run};
    use std::{
        future::Future,
        sync::{Arc, Mutex},
    };

    async fn with_fixture<F: Future>(fixture: Arc<phase08_07::Fixture>, future: F) -> F::Output {
        let mut future = Box::pin(future);
        std::future::poll_fn(move |cx| {
            // Scope the caller fixture to each poll; worker captures owned Arc.
            let _fixture = phase08_07::enter(Some(fixture.clone()));
            future.as_mut().poll(cx)
        })
        .await
    }

    #[test]
    fn phase08_07_file_manager_actual_wrappers_launch_native_fixture_and_preserve_argv() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("a note.md");
        std::fs::write(&target, "nonempty document bytes").unwrap();
        let root = temp.path().to_string_lossy().into_owned();
        let target_text = target.to_string_lossy().into_owned();
        let fixture = Arc::new(phase08_07::Fixture {
            program: std::env::current_exe().unwrap(),
            marker: temp.path().join("native-child.txt"),
            commands: Mutex::new(Vec::new()),
        });
        let validated_target = resolve_file_manager_target(&root, &target_text).unwrap();
        let expected = vec![
            build_reveal_command(&validated_target).unwrap(),
            build_open_command(&validated_target).unwrap(),
        ];
        let worker_fixture = fixture.clone();
        run(async move {
            with_fixture(
                worker_fixture.clone(),
                ipc::reveal_in_file_manager(root.clone(), target_text.clone()),
            )
            .await
            .unwrap();
            assert_eq!(
                std::fs::read(&worker_fixture.marker).unwrap(),
                b"native fixture ran"
            );
            std::fs::remove_file(&worker_fixture.marker).unwrap();
            with_fixture(
                worker_fixture.clone(),
                ipc::open_in_file_manager(root, target_text),
            )
            .await
            .unwrap();
            assert_eq!(
                std::fs::read(&worker_fixture.marker).unwrap(),
                b"native fixture ran"
            );
        });
        assert_eq!(*fixture.commands.lock().unwrap(), expected);
        assert_eq!(std::fs::read(target).unwrap(), b"nonempty document bytes");
    }

    #[test]
    fn phase08_07_file_manager_actual_wrappers_preserve_denied_missing_and_spawn_errors() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let target = temp.path().join("note.md");
        std::fs::write(&target, "nonempty bytes").unwrap();
        let root = temp.path().to_string_lossy().into_owned();
        let outside_file = outside.path().join("outside.md");
        std::fs::write(&outside_file, "outside bytes").unwrap();
        let denied = outside_file.to_string_lossy().into_owned();
        let expected_denied = reveal_in_file_manager(root.clone(), denied.clone()).unwrap_err();
        let expected_missing = open_in_file_manager(root.clone(), "missing.md".into()).unwrap_err();
        assert!(expected_denied.contains("escapes"));
        assert!(expected_missing.contains("does not exist"));
        let fixture = Arc::new(phase08_07::Fixture {
            program: temp.path().join("absent-native-program"),
            marker: temp.path().join("unused-marker"),
            commands: Mutex::new(Vec::new()),
        });
        run(async move {
            assert_eq!(
                ipc::reveal_in_file_manager(root.clone(), denied.clone())
                    .await
                    .unwrap_err(),
                expected_denied
            );
            assert_eq!(
                ipc::open_in_file_manager(root.clone(), denied)
                    .await
                    .unwrap_err(),
                expected_denied
            );
            assert_eq!(
                ipc::reveal_in_file_manager(root.clone(), "missing.md".into())
                    .await
                    .unwrap_err(),
                expected_missing
            );
            assert_eq!(
                ipc::open_in_file_manager(root.clone(), "missing.md".into())
                    .await
                    .unwrap_err(),
                expected_missing
            );
            let target = target.to_string_lossy().into_owned();
            let expected_reveal = {
                let _guard = phase08_07::enter(Some(fixture.clone()));
                reveal_in_file_manager(root.clone(), target.clone()).unwrap_err()
            };
            let expected_open = {
                let _guard = phase08_07::enter(Some(fixture.clone()));
                open_in_file_manager(root.clone(), target.clone()).unwrap_err()
            };
            assert!(expected_reveal.starts_with("Cannot reveal target:"));
            assert!(expected_open.starts_with("Cannot open target:"));
            assert_eq!(
                with_fixture(
                    fixture.clone(),
                    ipc::reveal_in_file_manager(root.clone(), target.clone())
                )
                .await
                .unwrap_err(),
                expected_reveal
            );
            assert_eq!(
                with_fixture(fixture, ipc::open_in_file_manager(root, target))
                    .await
                    .unwrap_err(),
                expected_open
            );
        });
    }

    #[test]
    fn phase08_07_file_manager_actual_wrappers_yield_on_same_polling_task() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("note.md"), "fixture bytes").unwrap();
        let root = temp.path().to_string_lossy().into_owned();
        boundary(
            temp.path().to_path_buf(),
            "reveal_in_file_manager",
            ipc::reveal_in_file_manager(root.clone(), "note.md".into()),
        );
        boundary(
            temp.path().to_path_buf(),
            "open_in_file_manager",
            ipc::open_in_file_manager(root, "note.md".into()),
        );
    }
}
