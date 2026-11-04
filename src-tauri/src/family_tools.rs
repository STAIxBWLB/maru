//! Read-only family inventory. Installation and updates remain dotfiles-owned.
use crate::{
    command_output::run_command_with_timeout, site_launcher, skill_host::fs as host_fs,
    tool_manifest,
};
use serde::Serialize;
use std::{
    io::Read,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

const TOOLS: [(&str, &str); 4] = [
    ("ahub", "@staix/agent-hub"),
    ("amem", "@staix/agent-mem"),
    ("vmem", "@staix/vault-mem"),
    ("acon", "@staix/agent-console"),
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FamilyToolStatus {
    id: &'static str,
    package: &'static str,
    installed_version: Option<String>,
    available_version: Option<String>,
    state: &'static str,
    ownership: &'static str,
    commands: Vec<String>,
    can_launch: bool,
    previous_version: Option<String>,
    detail: Vec<String>,
}

fn latest(bytes: &[u8], package: &str) -> Result<String, String> {
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| {
        "invalid registry metadata; retry Refresh or inspect npm registry availability"
    })?;
    if value["name"].as_str() != Some(package) {
        return Err(
            "registry package identity mismatch; retry Refresh and inspect the npm registry".into(),
        );
    }
    let version = value["version"]
        .as_str()
        .filter(|v| tool_manifest::parse_stable(v).is_some())
        .ok_or("registry has no stable version; retry Refresh or inspect the package release")?;
    Ok(version.to_string())
}

fn classify(installed: Option<&str>, available: Option<&str>, broken: bool) -> &'static str {
    if broken {
        return "unavailable";
    }
    match (installed, available) {
        (None, _) => "absent",
        (Some(a), Some(b)) if tool_manifest::parse_stable(a) < tool_manifest::parse_stable(b) => {
            "stale"
        }
        (Some(_), Some(_)) => "installed",
        (Some(_), None) => "installed",
    }
}

fn inspect(
    home: &Path,
    id: &'static str,
    package: &'static str,
    available: Result<String, String>,
) -> FamilyToolStatus {
    inspect_for_platform(home, id, package, available, cfg!(windows))
}

fn inspect_for_platform(
    home: &Path,
    id: &'static str,
    package: &'static str,
    available: Result<String, String>,
    windows: bool,
) -> FamilyToolStatus {
    let mut detail = Vec::new();
    let available_version = available
        .map_err(|error| detail.push(format!("Latest version unknown: {error}")))
        .ok();
    let alias = active_program(home, id, windows);
    let mut result = FamilyToolStatus {
        id,
        package,
        installed_version: None,
        available_version,
        state: "absent",
        ownership: if id == "ahub" {
            "ahub-upgrade"
        } else {
            "dot-family"
        },
        commands: Vec::new(),
        can_launch: false,
        previous_version: None,
        detail,
    };
    let Some(alias) = alias else {
        return result;
    };
    let trusted = match site_launcher::resolve_tool_at_for_platform(
        home, id, package, &alias, windows,
    ) {
        Ok(trusted) => trusted,
        Err(error) => {
            result.ownership = installed_owner(home, id, &alias, windows);
            result.state = "unavailable";
            result.detail.push(format!("{}: {error}; use this tool's owning installer; Maru will not execute or overwrite it", alias.display()));
            return result;
        }
    };
    result.ownership = trusted.ownership;
    result.installed_version = Some(trusted.version.clone());
    let shadow = home.join(".bun/bin").join(if windows {
        format!("{id}.exe")
    } else {
        id.to_string()
    });
    if shadow
        .canonicalize()
        .ok()
        .is_some_and(|path| path != trusted.program)
    {
        result.detail.push(format!("Shadowed duplicate install at {}; active tool is {}. Use the owning installer to reconcile PATH; no copy was changed.", shadow.display(), alias.display()));
    }
    if result.ownership == "dot-family" {
        let root = home.join(".local/share/dotfiles/tools").join(id);
        result.previous_version = root
            .join("previous")
            .canonicalize()
            .ok()
            .filter(|previous| root.canonicalize().ok().as_deref() == previous.parent())
            .and_then(|previous| {
                previous
                    .file_name()
                    .and_then(|name| name.to_str())
                    .filter(|version| tool_manifest::parse_stable(version).is_some())
                    .map(str::to_string)
            });
    }
    let installed = (|| -> Result<(), String> {
        // These two tools publish a read-only manifest; ahub/acon currently do not.
        if matches!(id, "amem" | "vmem") {
            let mut command = Command::new(trusted.bun);
            command
                .arg(trusted.entry)
                .args(["manifest", "--json"])
                .current_dir(trusted.home)
                .env("PATH", crate::cli_path::augmented_path());
            let output = run_command_with_timeout(&mut command, Duration::from_secs(3), |_, _| false).map_err(|_| format!("{id} manifest failed or timed out; repair the installed tool and retry Refresh"))?;
            if !output.status.success() || output.stdout_truncated {
                return Err(format!("{id} manifest failed or exceeded 64 KiB; inspect `{id} manifest --json` then retry Refresh"));
            }
            let manifest: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|_| format!("{id} returned invalid manifest JSON; inspect `{id} manifest --json` and repair the installed tool"))?;
            if manifest["name"].as_str() != Some(package)
                || manifest["version"].as_str() != result.installed_version.as_deref()
            {
                return Err(format!("{id} manifest identity/version disagrees with the package; repair its installation before using it"));
            }
            result.commands = published_commands(&manifest);
        }
        result.can_launch = id == "acon";
        Ok(())
    })();
    let broken = if let Err(error) = installed {
        result.detail.push(format!("{id}: {error}"));
        true
    } else {
        false
    };
    result.state = classify(
        result.installed_version.as_deref(),
        result.available_version.as_deref(),
        broken,
    );
    result
}

fn installed_owner(home: &Path, id: &str, alias: &Path, windows: bool) -> &'static str {
    let target = alias
        .canonicalize()
        .ok()
        .or_else(|| {
            std::fs::read_link(alias).ok().map(|target| {
                if target.is_absolute() {
                    target
                } else {
                    alias.parent().unwrap_or(home).join(target)
                }
            })
        })
        .unwrap_or_else(|| alias.to_path_buf());
    let target = crate::vault::lexical_normalize(&target);
    let contains = |root: &Path| {
        target.starts_with(root)
            || root
                .canonicalize()
                .ok()
                .is_some_and(|root| target.starts_with(root))
    };
    let mut homes = vec![home.to_path_buf()];
    if let Ok(canonical) = home.canonicalize() {
        homes.push(canonical);
    }
    for home in homes {
        if contains(&home.join(".local/share/dotfiles/tools").join(id)) {
            return "dot-family";
        }
        if id == "ahub" && contains(&home.join(".agenthub/releases")) {
            return "ahub-upgrade";
        }
        if contains(&home.join(".bun/install/global/node_modules"))
            || site_launcher::is_bun_shim(&home, id, &target, windows)
        {
            return if id == "ahub" {
                "ahub-upgrade"
            } else {
                "bun-global"
            };
        }
    }
    "external"
}

fn published_commands(manifest: &serde_json::Value) -> Vec<String> {
    manifest["commands"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|value| value.as_str())
                .filter(|command| {
                    !command.is_empty()
                        && command.len() <= 80
                        && command.split(' ').all(|word| {
                            !word.is_empty()
                                && word
                                    .bytes()
                                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                        })
                })
                .take(128)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn active_program(home: &Path, id: &str, windows: bool) -> Option<PathBuf> {
    if id == "acon" {
        return site_launcher::active_program(home, id, windows);
    }
    // Native/test HOME isolation must never resolve a personal tool.
    #[cfg(not(any(test, feature = "native-e2e")))]
    if let Some(program) = crate::cli_path::resolve_program(id) {
        return Some(program);
    }
    [
        home.join(".local/bin").join(id),
        home.join(".bun/bin").join(if windows {
            format!("{id}.exe")
        } else {
            id.to_string()
        }),
    ]
    .into_iter()
    .find(|path| std::fs::symlink_metadata(path).is_ok())
}

fn inventory_home_error(error: impl std::fmt::Display) -> String {
    format!("family_tools_home_unavailable: cannot resolve the inventory home: {error}; set HOME to an existing absolute home directory, then retry Refresh")
}

pub fn family_tools_status() -> Result<Vec<FamilyToolStatus>, String> {
    let home = host_fs::install_root_base().map_err(inventory_home_error)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(3))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| {
            format!(
                "family_registry_client_failed: {error}; retry Refresh or use the tool's installer"
            )
        })?;
    Ok(TOOLS.into_iter().map(|(id, package)| {
        let available = (|| -> Result<String, String> {
            let response = client.get(format!("https://registry.npmjs.org/{package}/latest")).send().and_then(|response| response.error_for_status()).map_err(|_| format!("{package}: registry unavailable; retry Refresh or inspect your connection"))?;
            let mut bytes = Vec::new();
            response.take(65537).read_to_end(&mut bytes).map_err(|_| format!("{package}: cannot read registry metadata; retry Refresh"))?;
            if bytes.len() > 65536 { return Err(format!("{package}: registry metadata exceeds 64 KiB; inspect the package release and retry")); }
            latest(&bytes, package)
        })();
        inspect(&home, id, package, available)
    }).collect())
}

pub mod ipc {
    #[tauri::command]
    pub async fn family_tools_status() -> Result<Vec<super::FamilyToolStatus>, String> {
        tauri::async_runtime::spawn_blocking(|| {
            #[cfg(test)]
            crate::atomic_file::PathTransactionLease::test_stage(
                &[crate::test_support::absolute_hook_path(
                    std::path::Path::new("/family_tools/status"),
                )],
                "worker:family_tools_status",
            );
            super::family_tools_status()
        })
        .await
        .map_err(|error| format!("family_tools_status_task_failed: {error}; retry Refresh"))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inventory_home_error_explains_how_to_recover() {
        let error = inventory_home_error("Home root must be absolute");
        assert!(error.contains("family_tools_home_unavailable"));
        assert!(error.contains("set HOME to an existing absolute home directory"));
        assert!(error.contains("retry Refresh"));
    }

    #[test]
    fn family_registry_windows_bun_shim_is_installed_without_shadow_false_positive() {
        let home = site_launcher::windows_shim_fixture();
        let root = home.path().canonicalize().unwrap();
        let before = std::fs::read(root.join(".bun/bin/acon.exe")).unwrap();
        let status = inspect_for_platform(
            &root,
            "acon",
            "@staix/agent-console",
            Ok("1.0.1".into()),
            true,
        );
        assert_eq!(status.ownership, "bun-global");
        assert_eq!(status.installed_version.as_deref(), Some("1.0.0"));
        assert_eq!(status.state, "stale");
        assert!(status.can_launch);
        assert!(
            !status
                .detail
                .iter()
                .any(|detail| detail.contains("Shadowed duplicate")),
            "{:?}",
            status.detail
        );
        assert_eq!(
            std::fs::read(root.join(".bun/bin/acon.exe")).unwrap(),
            before
        );
    }

    #[test]
    fn family_registry_manifest_commands_keep_bounded_single_space_words() {
        let manifest = serde_json::json!({"commands": [
            "spec get", "graph build", "log tail", "one-word", "A1 word-2",
            "", " leading", "trailing ", "two  spaces", "tab\tword", "line\nword", "spec; get", "$(cmd)", "명령 보기", 7, null
        ]});
        assert_eq!(
            published_commands(&manifest),
            [
                "spec get",
                "graph build",
                "log tail",
                "one-word",
                "A1 word-2"
            ]
        );
        assert_eq!(
            published_commands(&serde_json::json!({"commands":["a".repeat(80), "b".repeat(81)]})),
            ["a".repeat(80)]
        );
        let commands: Vec<String> = (0..140).map(|n| format!("command-{n}")).collect();
        let bounded = published_commands(&serde_json::json!({"commands": commands}));
        assert_eq!(bounded.len(), 128);
        assert_eq!(bounded.last().unwrap(), "command-127");
    }

    #[test]
    #[cfg(unix)]
    fn family_registry_dangling_managed_aliases_keep_owner_and_never_execute() {
        for (id, package, dir, target, expected) in [
            (
                "acon",
                "@staix/agent-console",
                ".local/bin",
                "../share/dotfiles/tools/acon/current/bin/acon",
                "dot-family",
            ),
            (
                "vmem",
                "@staix/vault-mem",
                ".bun/bin",
                "../install/global/node_modules/@staix/vault-mem/bin/vmem.js",
                "bun-global",
            ),
            (
                "ahub",
                "@staix/agent-hub",
                ".bun/bin",
                "../../.agenthub/releases/release-0.30.0/src/cli/main.js",
                "ahub-upgrade",
            ),
            (
                "amem",
                "@staix/agent-mem",
                ".local/bin",
                "../share/dotfiles/tools/amem/../../../../../outside/amem",
                "external",
            ),
        ] {
            let home = tempfile::tempdir().unwrap();
            let root = home.path().canonicalize().unwrap();
            let alias = root.join(dir).join(id);
            std::fs::create_dir_all(alias.parent().unwrap()).unwrap();
            std::os::unix::fs::symlink(target, &alias).unwrap();
            let status = inspect(&root, id, package, Ok("1.0.1".into()));
            assert_eq!(status.ownership, expected, "{id}: {:?}", status.detail);
            assert_eq!(status.state, "unavailable");
            assert!(status.installed_version.is_none());
            assert!(status.commands.is_empty());
            assert!(!status.can_launch);
            assert_eq!(std::fs::read_link(&alias).unwrap(), PathBuf::from(target));
            assert!(
                !alias.exists(),
                "inventory must not repair the dangling alias"
            );
        }
    }

    #[test]
    #[cfg(unix)]
    fn family_registry_dangling_alias_under_canonical_install_root_keeps_owner() {
        let home = tempfile::tempdir().unwrap();
        let external_storage = tempfile::tempdir().unwrap();
        let root = home.path().canonicalize().unwrap();
        let storage = external_storage.path().canonicalize().unwrap();
        let managed = root.join(".local/share/dotfiles/tools/amem");
        std::fs::create_dir_all(managed.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&storage, &managed).unwrap();
        let alias = root.join(".local/bin/amem");
        std::fs::create_dir_all(alias.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(storage.join("current/bin/amem"), &alias).unwrap();
        let status = inspect(&root, "amem", "@staix/agent-mem", Ok("1.0.1".into()));
        assert_eq!(status.ownership, "dot-family");
        assert_eq!(status.state, "unavailable");
        assert!(!status.can_launch && status.commands.is_empty());
        assert!(!alias.exists());
    }

    #[test]
    fn family_registry_worker_yields_and_maps_join_failure() {
        crate::atomic_file::phase08_06::boundary(
            crate::test_support::absolute_hook_path(Path::new("/family_tools/status")),
            "family_tools_status",
            ipc::family_tools_status(),
        );
    }

    #[test]
    #[cfg(unix)]
    fn family_registry_rejects_foreign_bin_without_running_or_mutating_it() {
        let home = tempfile::tempdir().unwrap();
        let bin = home.path().join(".bun/bin");
        let package = home
            .path()
            .join(".bun/install/global/node_modules/@staix/agent-mem");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(package.join("bin")).unwrap();
        let metadata =
            br#"{"name":"@staix/agent-mem","version":"1.0.0","bin":{"amem":"bin/amem.js"}}"#;
        std::fs::write(package.join("package.json"), metadata).unwrap();
        std::fs::write(
            package.join("bin/amem.js"),
            "throw new Error('never execute')",
        )
        .unwrap();
        std::os::unix::fs::symlink("/bin/sh", bin.join("amem")).unwrap();
        let status = inspect(home.path(), "amem", "@staix/agent-mem", Ok("1.0.1".into()));
        assert_eq!(status.state, "unavailable");
        assert!(!status.can_launch && status.commands.is_empty());
        assert_eq!(
            std::fs::read(package.join("package.json")).unwrap(),
            metadata
        );
        assert!(status.detail.iter().any(|d| d.contains("does not match")));
    }

    #[test]
    #[cfg(unix)]
    fn family_registry_uses_dot_current_over_shadowed_bun_and_keeps_offline_install() {
        let home = tempfile::tempdir().unwrap();
        let bin = home.path().join(".bun/bin");
        std::fs::create_dir_all(&bin).unwrap();
        crate::test_support::write_executable_fixture(
            &bin.join("bun"),
            "#!/bin/sh\nexit 99\n",
            0o755,
        )
        .unwrap();
        let global = home
            .path()
            .join(".bun/install/global/node_modules/@staix/agent-console");
        let root = home.path().join(".local/share/dotfiles/tools/acon");
        let current = root.join("0.1.1");
        let dot = current.join("lib/node_modules/@staix/agent-console");
        for (package, version) in [(&global, "0.1.0"), (&dot, "0.1.1")] {
            std::fs::create_dir_all(package.join("bin")).unwrap();
            std::fs::write(package.join("package.json"), serde_json::json!({"name":"@staix/agent-console","version":version,"bin":{"acon":"bin/acon.js"}}).to_string()).unwrap();
            std::fs::write(
                package.join("bin/acon.js"),
                "throw new Error('status must not launch')",
            )
            .unwrap();
        }
        std::os::unix::fs::symlink(global.join("bin/acon.js"), bin.join("acon")).unwrap();
        std::fs::create_dir_all(current.join("bin")).unwrap();
        std::os::unix::fs::symlink(dot.join("bin/acon.js"), current.join("bin/acon")).unwrap();
        std::os::unix::fs::symlink("0.1.1", root.join("current")).unwrap();
        std::fs::create_dir_all(root.join("0.1.0")).unwrap();
        std::os::unix::fs::symlink("0.1.0", root.join("previous")).unwrap();
        std::fs::create_dir_all(home.path().join(".local/bin")).unwrap();
        std::os::unix::fs::symlink(
            root.join("current/bin/acon"),
            home.path().join(".local/bin/acon"),
        )
        .unwrap();
        let status = inspect(
            home.path(),
            "acon",
            "@staix/agent-console",
            Err("registry offline; retry Refresh".into()),
        );
        assert_eq!(status.installed_version.as_deref(), Some("0.1.1"));
        assert_eq!(status.previous_version.as_deref(), Some("0.1.0"));
        assert_eq!(status.ownership, "dot-family");
        assert_eq!(status.state, "installed");
        assert!(status.can_launch);
        assert!(status
            .detail
            .iter()
            .any(|detail| detail.contains("Shadowed duplicate")));
        let trusted =
            site_launcher::resolve_tool(home.path(), "acon", "@staix/agent-console").unwrap();
        assert_eq!(
            trusted.entry,
            dot.join("bin/acon.js").canonicalize().unwrap()
        );
    }

    #[test]
    #[cfg(unix)]
    fn family_registry_recognizes_ahub_upgrade_release_identity_without_executing_it() {
        let home = tempfile::tempdir().unwrap();
        let bin = home.path().join(".bun/bin");
        let package = home.path().join(".agenthub/releases/release-0.30.0");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(package.join("src/cli")).unwrap();
        crate::test_support::write_executable_fixture(
            &bin.join("bun"),
            "#!/bin/sh\nexit 99\n",
            0o755,
        )
        .unwrap();
        std::fs::write(
            package.join("package.json"),
            br#"{"name":"@staix/agent-hub","version":"0.30.0","bin":{"ahub":"src/cli/main.js"}}"#,
        )
        .unwrap();
        std::fs::write(
            package.join("src/cli/main.js"),
            "throw new Error('never execute')",
        )
        .unwrap();
        std::os::unix::fs::symlink(package.join("src/cli/main.js"), bin.join("ahub")).unwrap();
        let status = inspect(home.path(), "ahub", "@staix/agent-hub", Ok("0.30.1".into()));
        assert_eq!(status.ownership, "ahub-upgrade");
        assert_eq!(status.installed_version.as_deref(), Some("0.30.0"));
        assert_eq!(status.state, "stale");
        assert!(!status.can_launch);
    }

    #[test]
    fn family_registry_distinguishes_absent_stale_and_unavailable() {
        assert_eq!(classify(None, Some("1.0.0"), false), "absent");
        assert_eq!(classify(Some("1.0.0"), Some("1.0.1"), false), "stale");
        assert_eq!(classify(Some("1.0.1"), Some("1.0.1"), false), "installed");
        assert_eq!(classify(Some("1.0.1"), None, false), "installed");
        assert_eq!(classify(None, Some("1.0.0"), true), "unavailable");
        assert!(latest(br#"{"name":"wrong","version":"1.0.0"}"#, TOOLS[0].1).is_err());
        assert!(latest(
            br#"{"name":"@staix/agent-hub","version":"1.0.0;touch x"}"#,
            TOOLS[0].1
        )
        .is_err());
    }
}
