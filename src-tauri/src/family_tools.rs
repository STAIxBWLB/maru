//! Read-only family inventory. Installation and updates remain dotfiles-owned.
use crate::{
    command_output::run_command_with_timeout, site_launcher, skill_host::fs as host_fs,
    tool_manifest,
};
use serde::Serialize;
use std::{io::Read, path::Path, process::Command, time::Duration};

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
        (Some(_), None) => "unavailable",
    }
}

fn inspect(
    home: &Path,
    id: &'static str,
    package: &'static str,
    available: Result<String, String>,
) -> FamilyToolStatus {
    let mut detail = Vec::new();
    let available_version = available.map_err(|error| detail.push(error)).ok();
    let alias = home.join(".bun/bin").join(if cfg!(windows) {
        format!("{id}.exe")
    } else {
        id.to_string()
    });
    let alias_metadata = std::fs::symlink_metadata(&alias);
    let exists = alias_metadata.is_ok();
    let inspection_error = alias_metadata
        .err()
        .filter(|error| error.kind() != std::io::ErrorKind::NotFound);
    let external = !exists && crate::cli_path::resolve_program(id).is_some();
    let mut result = FamilyToolStatus {
        id,
        package,
        installed_version: None,
        available_version,
        state: "absent",
        ownership: if external { "external" } else { "bun-global" },
        commands: Vec::new(),
        can_launch: false,
        detail,
    };
    if let Some(error) = inspection_error {
        result.state = "unavailable";
        result.detail.push(format!(
            "Cannot inspect {}: {error}; fix access permissions and retry Refresh",
            alias.display()
        ));
        return result;
    }
    if external {
        result.state = "unavailable";
        result.detail.push(format!("{id} is resolved outside the supported Bun global install; use its owning installer to inspect/update it. Maru does not execute or overwrite it."));
        return result;
    }
    if !exists {
        if std::fs::symlink_metadata(home.join(".bun/install/global/node_modules").join(package))
            .is_ok()
        {
            result.state = "unavailable";
            result.detail.push(format!("{package} exists but {} is missing; repair it with the owning installer then retry Refresh", alias.display()));
        }
        return result;
    }
    let installed = (|| -> Result<(), String> {
        let trusted = site_launcher::resolve_tool(home, id, package)?;
        let metadata: serde_json::Value = serde_json::from_slice(&site_launcher::read_small(&home.join(".bun/install/global/node_modules").join(package).join("package.json"))?).map_err(|error| format!("{id}: invalid installed metadata: {error}; repair the package with its owning installer"))?;
        result.installed_version = metadata["version"]
            .as_str()
            .filter(|v| tool_manifest::parse_stable(v).is_some())
            .map(str::to_string);
        if result.installed_version.is_none() {
            return Err(format!("{id}: installed package has no stable version; repair its package metadata using the owning installer"));
        }
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
            result.commands = manifest["commands"]
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|v| v.as_str())
                        .filter(|s| {
                            s.len() <= 80
                                && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                        })
                        .take(128)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
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

pub fn family_tools_status() -> Result<Vec<FamilyToolStatus>, String> {
    let home = host_fs::install_root_base()?;
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
    fn family_registry_distinguishes_absent_stale_and_unavailable() {
        assert_eq!(classify(None, Some("1.0.0"), false), "absent");
        assert_eq!(classify(Some("1.0.0"), Some("1.0.1"), false), "stale");
        assert_eq!(classify(Some("1.0.1"), Some("1.0.1"), false), "installed");
        assert_eq!(classify(Some("1.0.1"), None, false), "unavailable");
        assert_eq!(classify(None, Some("1.0.0"), true), "unavailable");
        assert!(latest(br#"{"name":"wrong","version":"1.0.0"}"#, TOOLS[0].1).is_err());
        assert!(latest(
            br#"{"name":"@staix/agent-hub","version":"1.0.0;touch x"}"#,
            TOOLS[0].1
        )
        .is_err());
    }
}
