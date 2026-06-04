use crate::vault::resolve_inside_vault;
use crate::win_process::NoWindow;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, PartialEq, Eq)]
struct RevealCommand {
    program: String,
    args: Vec<String>,
}

#[tauri::command]
pub fn reveal_in_file_manager(vault_path: String, target_path: String) -> Result<(), String> {
    let target = resolve_file_manager_target(&vault_path, &target_path)?;
    let command = build_reveal_command(&target)?;
    Command::new(&command.program)
        .args(&command.args)
        .no_window()
        .spawn()
        .map_err(|err| format!("Cannot reveal target: {err}"))?;
    Ok(())
}

#[tauri::command]
pub fn open_in_file_manager(vault_path: String, target_path: String) -> Result<(), String> {
    let target = resolve_file_manager_target(&vault_path, &target_path)?;
    let command = build_open_command(&target)?;
    Command::new(&command.program)
        .args(&command.args)
        .no_window()
        .spawn()
        .map_err(|err| format!("Cannot open target: {err}"))?;
    Ok(())
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
            .prefix("anchor-file-manager-")
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
