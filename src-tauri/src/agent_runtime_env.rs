use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::process::Command;

const SCRATCHPAD_ENV: &str = "MARU_SCRATCHPAD";
const TEMP_ENV: &str = "MARU_TEMP";
const CLAUDE_TMP_ENV: &str = "CLAUDE_CODE_TMPDIR";

fn canonicalize_or_self(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

/// Locate the private work root that owns an agent run.
///
/// A run may start in a nested project or a registered public workspace.
/// Registry ownership wins over nearby config files so a public workspace can
/// never redirect Scratchpad writes to itself. Standalone unregistered folders
/// still use the nearest workspace.config.yaml.
fn runtime_work_root(path: &Path) -> Result<PathBuf, String> {
    let candidate = canonicalize_or_self(path);
    let registry = crate::vault_list::list_workspace_roots().ok();
    runtime_work_root_with_registry(&candidate, registry.as_ref())
}

fn runtime_work_root_with_registry(
    candidate: &Path,
    registry: Option<&crate::vault_list::WorkspaceRegistry>,
) -> Result<PathBuf, String> {
    if let Some(registry) = registry {
        let owner = registry
            .workspaces
            .iter()
            .filter(|workspace| {
                candidate.starts_with(canonicalize_or_self(Path::new(&workspace.path)))
            })
            .max_by_key(|workspace| Path::new(&workspace.path).components().count());
        if owner.is_some() {
            let private = registry.active_by_visibility.private.as_deref().ok_or_else(|| {
                "agent_runtime_primary_private_missing: registered workspace runs require an active private workspace"
                    .to_string()
            })?;
            return Ok(canonicalize_or_self(Path::new(private)));
        }
    }
    Ok(candidate
        .ancestors()
        .find(|ancestor| ancestor.join("workspace.config.yaml").is_file())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| candidate.to_path_buf()))
}

pub(crate) fn reserved_runtime_env(work_path: &Path) -> Result<BTreeMap<String, String>, String> {
    let work_root = runtime_work_root(work_path)?;
    let scratchpad = crate::scratchpad::resolve_scratchpad_root(&work_root)?;
    let temp = crate::scratchpad::resolve_scratchpad_temp_root(&work_root)?;
    let mut env = BTreeMap::new();
    env.insert(
        SCRATCHPAD_ENV.to_string(),
        scratchpad.to_string_lossy().into_owned(),
    );
    env.insert(TEMP_ENV.to_string(), temp.to_string_lossy().into_owned());
    env.insert(
        CLAUDE_TMP_ENV.to_string(),
        temp.join("runtime")
            .join("claude")
            .to_string_lossy()
            .into_owned(),
    );
    Ok(env)
}

pub(crate) fn reserve_btree_env(
    env: &mut BTreeMap<String, String>,
    work_path: &Path,
) -> Result<(), String> {
    env.extend(reserved_runtime_env(work_path)?);
    Ok(())
}

pub(crate) fn reserve_hash_env(
    env: &mut HashMap<String, String>,
    work_path: &Path,
) -> Result<(), String> {
    env.extend(reserved_runtime_env(work_path)?);
    Ok(())
}

pub(crate) fn apply_to_command(cmd: &mut Command, work_path: &Path) -> Result<(), String> {
    cmd.envs(reserved_runtime_env(work_path)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn registry_entry(
        label: &str,
        path: &Path,
        visibility: &str,
    ) -> crate::vault_list::WorkspaceRootEntry {
        crate::vault_list::WorkspaceRootEntry {
            label: label.to_string(),
            path: path.to_string_lossy().to_string(),
            visibility: visibility.to_string(),
            provider: "local".to_string(),
            provider_id: None,
            external_writer: None,
            write_policy: "direct".to_string(),
            permission_summary: None,
        }
    }

    fn configured_work() -> tempfile::TempDir {
        let work = tempfile::tempdir().unwrap();
        let scratchpad = work.path().join("scratchpad");
        fs::write(
            work.path().join("workspace.config.yaml"),
            format!(
                "version: 1\npaths:\n  primary: {}\n  scratchpad: {}\nscratchpad:\n  temp_subdir: temp\n",
                work.path().display(),
                scratchpad.display()
            ),
        )
        .unwrap();
        work
    }

    #[test]
    fn nested_runs_use_the_configured_work_scratchpad() {
        let work = configured_work();
        let expected_scratchpad = crate::scratchpad::resolve_scratchpad_root(work.path()).unwrap();
        let nested = work.path().join("dev").join("project");
        fs::create_dir_all(&nested).unwrap();

        let env = reserved_runtime_env(&nested).unwrap();

        assert_eq!(
            env.get(SCRATCHPAD_ENV).map(String::as_str),
            Some(expected_scratchpad.to_string_lossy().as_ref())
        );
        assert_eq!(
            env.get(TEMP_ENV).map(String::as_str),
            Some(expected_scratchpad.join("temp").to_string_lossy().as_ref())
        );
    }

    #[test]
    fn reserved_values_replace_caller_values() {
        let work = configured_work();
        let expected_scratchpad = crate::scratchpad::resolve_scratchpad_root(work.path()).unwrap();
        let mut env = HashMap::from([
            (SCRATCHPAD_ENV.to_string(), "/tmp/override".to_string()),
            (TEMP_ENV.to_string(), "/tmp/override/temp".to_string()),
            (
                CLAUDE_TMP_ENV.to_string(),
                "/tmp/override/claude".to_string(),
            ),
        ]);

        reserve_hash_env(&mut env, work.path()).unwrap();

        assert_eq!(
            env.get(SCRATCHPAD_ENV),
            Some(&expected_scratchpad.to_string_lossy().into_owned())
        );
        assert_eq!(
            env.get(CLAUDE_TMP_ENV),
            Some(
                &expected_scratchpad
                    .join("temp/runtime/claude")
                    .to_string_lossy()
                    .into_owned()
            )
        );
    }

    #[test]
    fn registered_public_root_with_own_config_maps_to_primary_private() {
        let temp = tempfile::tempdir().unwrap();
        let private = temp.path().join("private");
        let public = temp.path().join("public");
        let nested_public = public.join("project");
        fs::create_dir_all(&private).unwrap();
        fs::create_dir_all(&nested_public).unwrap();
        fs::write(private.join("workspace.config.yaml"), "version: 1\n").unwrap();
        fs::write(public.join("workspace.config.yaml"), "version: 1\n").unwrap();
        let registry = crate::vault_list::WorkspaceRegistry {
            workspaces: vec![
                registry_entry("private", &private, "private"),
                registry_entry("public", &public, "public"),
            ],
            active_by_visibility: crate::vault_list::ActiveByVisibility {
                private: Some(private.to_string_lossy().to_string()),
                public: Some(public.to_string_lossy().to_string()),
            },
            hidden_defaults: Vec::new(),
        };

        let resolved =
            runtime_work_root_with_registry(&canonicalize_or_self(&nested_public), Some(&registry))
                .unwrap();

        assert_eq!(resolved, canonicalize_or_self(&private));
    }

    #[test]
    fn registered_secondary_private_maps_to_active_primary_private() {
        let temp = tempfile::tempdir().unwrap();
        let primary = temp.path().join("primary");
        let secondary = temp.path().join("secondary");
        let nested_secondary = secondary.join("project");
        fs::create_dir_all(&primary).unwrap();
        fs::create_dir_all(&nested_secondary).unwrap();
        fs::write(secondary.join("workspace.config.yaml"), "version: 1\n").unwrap();
        let registry = crate::vault_list::WorkspaceRegistry {
            workspaces: vec![
                registry_entry("primary", &primary, "private"),
                registry_entry("secondary", &secondary, "private"),
            ],
            active_by_visibility: crate::vault_list::ActiveByVisibility {
                private: Some(primary.to_string_lossy().to_string()),
                public: None,
            },
            hidden_defaults: Vec::new(),
        };

        let resolved = runtime_work_root_with_registry(
            &canonicalize_or_self(&nested_secondary),
            Some(&registry),
        )
        .unwrap();

        assert_eq!(resolved, canonicalize_or_self(&primary));
    }

    #[test]
    fn registered_public_without_active_private_is_an_error() {
        let temp = tempfile::tempdir().unwrap();
        let public = temp.path().join("public");
        fs::create_dir_all(&public).unwrap();
        fs::write(public.join("workspace.config.yaml"), "version: 1\n").unwrap();
        let registry = crate::vault_list::WorkspaceRegistry {
            workspaces: vec![registry_entry("public", &public, "public")],
            active_by_visibility: crate::vault_list::ActiveByVisibility {
                private: None,
                public: Some(public.to_string_lossy().to_string()),
            },
            hidden_defaults: Vec::new(),
        };

        let error =
            runtime_work_root_with_registry(&canonicalize_or_self(&public), Some(&registry))
                .unwrap_err();

        assert!(error.contains("agent_runtime_primary_private_missing"));
    }
}
