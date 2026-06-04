use crate::vault::resolve_inside_vault;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, PartialEq, Eq)]
struct RevealCommand {
    program: String,
    args: Vec<String>,
}

#[tauri::command]
pub fn reveal_in_file_manager(vault_path: String, target_path: String) -> Result<(), String> {
    let target = resolve_reveal_target(&vault_path, &target_path)?;
    let command = build_reveal_command(&target)?;
    Command::new(&command.program)
        .args(&command.args)
        .spawn()
        .map_err(|err| format!("Cannot reveal target: {err}"))?;
    Ok(())
}

#[tauri::command]
pub fn open_in_file_manager(vault_path: String, target_path: String) -> Result<(), String> {
    let target = resolve_reveal_target(&vault_path, &target_path)?;
    let command = build_open_command(&target)?;
    Command::new(&command.program)
        .args(&command.args)
        .spawn()
        .map_err(|err| format!("Cannot open target: {err}"))?;
    Ok(())
}

fn resolve_reveal_target(vault_path: &str, target_path: &str) -> Result<PathBuf, String> {
    let target = resolve_inside_vault(vault_path, target_path)?;
    if !target.exists() {
        return Err(format!(
            "Reveal target does not exist: {}",
            target.display()
        ));
    }
    Ok(target)
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

        let err =
            resolve_reveal_target(tmp.path().to_str().unwrap(), outside_file.to_str().unwrap())
                .unwrap_err();
        assert!(err.contains("escapes"));
    }

    #[test]
    fn reveal_target_must_exist() {
        let tmp = TempDir::new().unwrap();
        let err = resolve_reveal_target(tmp.path().to_str().unwrap(), "missing.md").unwrap_err();
        assert!(err.contains("does not exist"));
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
