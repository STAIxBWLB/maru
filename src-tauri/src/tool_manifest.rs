//! What the installed amem and vmem publish about themselves: their version and
//! their MCP tool names. Read from `<tool> manifest --json` (vault-mem#83,
//! agent-mem#199), with `<tool> --version` as the fallback for releases that
//! predate it. A missing tool or manifest is never an error, only an empty answer.

use std::process::Command;
use std::time::Duration;

use serde::Deserialize;

use crate::command_output::run_command_with_timeout;

const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

pub type Semver = (u64, u64, u64);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestTool {
    pub name: String,
    /// The manifest's own claim that the tool changes nothing. A plain string
    /// entry makes no such claim.
    pub read_only: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ToolManifest {
    pub version: Option<Semver>,
    /// Empty when the tool has no manifest command.
    pub tools: Vec<ManifestTool>,
}

/// npm package each known tool must name in its manifest.
fn package_for(tool: &str) -> Option<&'static str> {
    match tool {
        "amem" => Some("@staix/agent-mem"),
        "vmem" => Some("@staix/vault-mem"),
        _ => None,
    }
}

/// Probe the installed `tool` (amem or vmem). Unknown tools read as absent.
pub fn read(tool: &str) -> ToolManifest {
    let Some(package) = package_for(tool) else {
        return ToolManifest::default();
    };
    let Some(program) = crate::cli_path::resolve_program(tool) else {
        return ToolManifest::default();
    };
    let run = |args: &[&str]| -> Option<Vec<u8>> {
        let mut command = Command::new(&program);
        // An `env bun` or `env node` shebang needs the interpreter on the child's PATH too.
        command
            .args(args)
            .env("PATH", crate::cli_path::augmented_path());
        let output = run_command_with_timeout(&mut command, PROBE_TIMEOUT, |_, _| false).ok()?;
        output.status.success().then_some(output.stdout)
    };
    if let Some(manifest) =
        run(&["manifest", "--json"]).and_then(|out| parse_manifest(&out, package))
    {
        return manifest;
    }
    ToolManifest {
        version: run(&["--version"]).and_then(|out| parse_version_output(&out)),
        tools: Vec::new(),
    }
}

/// `{name?, version, mcp: {tools: [string | {name, readOnly?}]}}`; unknown keys
/// are ignored. A manifest naming another package, or without a stable X.Y.Z
/// version, is not this tool's and is ignored.
fn parse_manifest(stdout: &[u8], package: &str) -> Option<ToolManifest> {
    #[derive(Deserialize)]
    struct Raw {
        #[serde(default)]
        name: Option<String>,
        version: String,
        #[serde(default)]
        mcp: Option<RawMcp>,
    }
    #[derive(Deserialize)]
    struct RawMcp {
        #[serde(default)]
        tools: Vec<serde_json::Value>,
    }
    let raw: Raw = serde_json::from_slice(stdout).ok()?;
    if raw.name.as_deref().is_some_and(|name| name != package) {
        return None;
    }
    let version = parse_stable(&raw.version)?;
    let tools = raw
        .mcp
        .map(|mcp| mcp.tools)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| match item {
            serde_json::Value::String(name) => Some(ManifestTool {
                name,
                read_only: false,
            }),
            serde_json::Value::Object(map) => Some(ManifestTool {
                name: map.get("name")?.as_str()?.to_string(),
                read_only: map.get("readOnly") == Some(&serde_json::Value::Bool(true)),
            }),
            _ => None,
        })
        .filter(|tool| !tool.name.is_empty())
        .collect();
    Some(ToolManifest {
        version: Some(version),
        tools,
    })
}

/// `vmem --version` prints `0.2.4`; `amem --version` prints `amem 0.17.0`.
fn parse_version_output(stdout: &[u8]) -> Option<Semver> {
    String::from_utf8_lossy(stdout)
        .split_whitespace()
        .find_map(|token| parse_stable(token.strip_prefix('v').unwrap_or(token)))
}

/// Exactly `X.Y.Z`: a pre-release or build suffix is not a stable version.
pub fn parse_stable(value: &str) -> Option<Semver> {
    let mut parts = value.split('.');
    let mut next = || -> Option<u64> {
        let part = parts.next()?;
        if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        part.parse().ok()
    };
    let version = (next()?, next()?, next()?);
    parts.next().is_none().then_some(version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_tools_take_strings_and_objects_and_readonly_only_when_true() {
        let out = br#"{"name":"@staix/vault-mem","version":"0.2.5","configVersion":1,
            "mcp":{"server":"vmem","tools":["vmem_read",{"name":"vmem_stats","readOnly":true},
            {"name":"vmem_x","readOnly":"yes"},{"readOnly":true},7]},"commands":["manifest"]}"#;
        let manifest = parse_manifest(out, "@staix/vault-mem").unwrap();
        assert_eq!(manifest.version, Some((0, 2, 5)));
        assert_eq!(
            manifest.tools,
            vec![
                ManifestTool {
                    name: "vmem_read".into(),
                    read_only: false
                },
                ManifestTool {
                    name: "vmem_stats".into(),
                    read_only: true
                },
                ManifestTool {
                    name: "vmem_x".into(),
                    read_only: false
                },
            ]
        );
    }

    #[test]
    fn manifest_of_another_package_or_unstable_version_is_ignored() {
        assert!(
            parse_manifest(br#"{"name":"other","version":"0.2.5"}"#, "@staix/vault-mem").is_none()
        );
        assert!(parse_manifest(br#"{"version":"0.2.5-beta"}"#, "@staix/vault-mem").is_none());
        assert!(parse_manifest(b"vmem: unknown command: manifest", "@staix/vault-mem").is_none());
        let unnamed = parse_manifest(br#"{"version":"0.2.5"}"#, "@staix/vault-mem").unwrap();
        assert_eq!(unnamed.version, Some((0, 2, 5)));
        assert!(unnamed.tools.is_empty());
    }

    #[test]
    fn version_output_reads_bare_and_prefixed_forms() {
        assert_eq!(parse_version_output(b"0.2.4\n"), Some((0, 2, 4)));
        assert_eq!(parse_version_output(b"amem 0.17.0\n"), Some((0, 17, 0)));
        assert_eq!(parse_version_output(b"v1.2.3"), Some((1, 2, 3)));
        assert_eq!(parse_version_output(b"0.2.4-rc.1"), None);
        assert_eq!(parse_version_output(b""), None);
    }

    #[test]
    fn unknown_tools_are_never_probed() {
        assert_eq!(read("sh"), ToolManifest::default());
    }
}
