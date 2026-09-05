// Global site registry (~/.maru/sites.json) + work-sites directory scanner.
//
// Registry envelope (same convention as skills.json):
//   { "version": 1, "sites": [ ...entries owned by the frontend... ] }
//
// `read_sites` is ensure-on-read: a missing or empty file is seeded with the
// default envelope. Paths resolve through skill_host::fs::maru_home which
// honors the MARU_TEST_HOME override under cfg(test), and all logic lives
// in `_internal` functions taking explicit paths so tests never touch the
// real ~/.maru.
//
// The scanner walks the immediate children of a directory (typically
// ~/workspace/work/sites) and proposes SiteCandidate records. It is
// best-effort per child directory: a malformed project never fails the
// scan, it just yields a sparser candidate.

use crate::atomic_file::{with_path_transactions, PathTransactionRequest};
use crate::skill_host::fs as host_fs;
use regex::Regex;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const SITES_SCHEMA_VERSION: u32 = 1;

/// Cap for reading text probe files (configs, READMEs). Anything larger is
/// truncated — all real probe targets are a few KiB.
const TEXT_CAP: usize = 256 * 1024;

// ---------------------------------------------------------------------------
// Registry: ~/.maru/sites.json
// ---------------------------------------------------------------------------

fn sites_json_path() -> Result<PathBuf, String> {
    Ok(host_fs::maru_home()?.join("sites.json"))
}

fn default_sites_value() -> JsonValue {
    json!({ "version": SITES_SCHEMA_VERSION, "sites": [] })
}

/// Atomic (tmp + rename) pretty write with the trailing newline the envelope
/// files in this app carry.
fn write_sites_file(path: &Path, value: &JsonValue) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Cannot create {}: {err}", parent.display()))?;
    }
    let mut data = serde_json::to_string_pretty(value)
        .map_err(|err| format!("Cannot serialize sites.json: {err}"))?;
    data.push('\n');
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, data).map_err(|err| format!("Cannot write {}: {err}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|err| format!("Cannot replace {}: {err}", path.display()))
}

fn read_sites_internal(path: &Path) -> Result<JsonValue, String> {
    if !path.exists() {
        let value = default_sites_value();
        write_sites_file(path, &value)?;
        return Ok(value);
    }
    let buf =
        fs::read_to_string(path).map_err(|err| format!("Cannot read {}: {err}", path.display()))?;
    if buf.trim().is_empty() {
        let value = default_sites_value();
        write_sites_file(path, &value)?;
        return Ok(value);
    }
    let value: JsonValue = serde_json::from_str(&buf)
        .map_err(|err| format!("Cannot parse {}: {err}", path.display()))?;
    if !value.is_object() {
        return Err(format!(
            "{}: expected an object envelope {{ version, sites }}",
            path.display()
        ));
    }
    Ok(value)
}

fn save_sites_internal(path: &Path, mut value: JsonValue) -> Result<(), String> {
    let obj = value
        .as_object_mut()
        .ok_or_else(|| "sites.json payload must be a JSON object".to_string())?;
    match obj.get("sites") {
        Some(JsonValue::Array(_)) => {}
        _ => return Err("sites.json payload must contain a \"sites\" array".to_string()),
    }
    obj.entry("version")
        .or_insert_with(|| json!(SITES_SCHEMA_VERSION));
    write_sites_file(path, &value)
}

pub fn read_sites() -> Result<JsonValue, String> {
    let path = sites_json_path()?;
    with_path_transactions(sites_registry_admission()?, |lease| {
        lease.before_effect()?;
        read_sites_internal(&path)
    })
}

pub fn save_sites(value: JsonValue) -> Result<(), String> {
    let path = sites_json_path()?;
    with_path_transactions(sites_registry_admission()?, |lease| {
        lease.before_effect()?;
        save_sites_internal(&path, value)
    })
}

fn sites_registry_admission() -> Result<PathTransactionRequest, String> {
    PathTransactionRequest::new(vec![sites_json_path()?])
}

/// Owned IPC boundaries; the synchronous entry points remain available to
/// Rust callers.
pub mod ipc {
    use super::*;

    #[cfg(test)]
    use crate::atomic_file::PathTransactionLease;

    #[tauri::command]
    pub async fn read_sites() -> Result<JsonValue, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            if let Ok(key) = super::sites_json_path() {
                PathTransactionLease::test_stage(&[key], "worker:read_sites");
            }
            super::read_sites()
        })
        .await
        .map_err(|err| format!("read_sites_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn save_sites(value: JsonValue) -> Result<(), String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            if let Ok(key) = super::sites_json_path() {
                PathTransactionLease::test_stage(&[key], "worker:save_sites");
            }
            super::save_sites(value)
        })
        .await
        .map_err(|err| format!("save_sites_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn scan_work_sites(dir: String) -> Result<Vec<SiteCandidate>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            {
                let key = host_fs::expand_tilde(&dir);
                PathTransactionLease::test_stage(&[key], "worker:scan_work_sites");
            }
            super::scan_work_sites(dir)
        })
        .await
        .map_err(|err| format!("scan_work_sites_task_failed: {err}"))?
    }
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteCandidate {
    pub dir_name: String,
    pub label: String,
    pub local_path: String,
    pub url: Option<String>,
    pub dev_url: Option<String>,
    /// Which probe produced `url`:
    /// "astroConfig" | "cname" | "packageHomepage" | "readme" | "none"
    pub source: String,
}

/// Project roots probed inside each candidate dir, in priority order.
const PROBE_ROOTS: &[&str] = &[".", "astro", "site"];
/// CNAME locations probed inside each existing probe root.
const CNAME_RELATIVE: &[&str] = &["CNAME", "public/CNAME", "docs/CNAME"];
const ASTRO_CONFIG_NAMES: &[&str] = &["astro.config.mjs", "astro.config.js", "astro.config.ts"];
/// package.json names that describe the probe root, not the site.
const GENERIC_PACKAGE_NAMES: &[&str] = &["astro", "site"];
/// Domains never accepted from README lines (badges, framework links).
const URL_DOMAIN_DENYLIST: &[&str] = &["shields.io", "astro.build"];

fn astro_site_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    // matches:  site: 'https://halla.ai',  |  site: "https://x"  |  site: `https://x`
    // \b instead of a line maru so one-line configs
    // (`export default { site: '...' }`) match too.
    RE.get_or_init(|| Regex::new(r#"\bsite\s*:\s*["'`](https?://[^"'`\s]+)["'`]"#).unwrap())
}

fn readme_keyword_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    // English keywords word-bounded so e.g. "delivery" never matches.
    RE.get_or_init(|| Regex::new(r"(?i)\b(live|production|homepage)\b|운영|배포").unwrap())
}

fn url_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    // Stops at whitespace, quotes, backticks, markdown/link delimiters.
    RE.get_or_init(|| Regex::new(r#"https?://[^\s<>"'`)\]]+"#).unwrap())
}

fn port_flag_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    // --port 8080 | --port=8080 | -p 8080
    RE.get_or_init(|| Regex::new(r"(?:--port|-p)[ =]+(\d{2,5})").unwrap())
}

pub fn scan_work_sites(dir: String) -> Result<Vec<SiteCandidate>, String> {
    let root = host_fs::expand_tilde(&dir);
    if !root.is_dir() {
        return Err(format!("Not a directory: {}", root.display()));
    }
    let entries =
        fs::read_dir(&root).map_err(|err| format!("Cannot read {}: {err}", root.display()))?;
    let mut dirs: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        // is_dir() follows symlinks; broken symlinks and files fall out here.
        .filter(|path| path.is_dir())
        .collect();
    dirs.sort();
    Ok(dirs.iter().filter_map(|dir| scan_site_dir(dir)).collect())
}

/// Best-effort probe of a single candidate directory. Returns None only for
/// dirs that cannot be candidates at all (hidden, non-UTF8 name).
fn scan_site_dir(dir: &Path) -> Option<SiteCandidate> {
    let dir_name = dir.file_name()?.to_str()?.to_string();
    if dir_name.starts_with('.') {
        return None;
    }

    let roots: Vec<PathBuf> = PROBE_ROOTS
        .iter()
        .map(|root| {
            if *root == "." {
                dir.to_path_buf()
            } else {
                dir.join(root)
            }
        })
        .filter(|path| path.is_dir())
        .collect();

    // Primary package.json = first probe root that has one.
    let package_value: Option<JsonValue> = roots
        .iter()
        .map(|root| root.join("package.json"))
        .find(|path| path.is_file())
        .and_then(|path| read_text_capped(&path, TEXT_CAP))
        .and_then(|text| serde_json::from_str(&text).ok());

    let (url, source) = discover_url(dir, &roots, package_value.as_ref());
    let dev_url = package_value.as_ref().and_then(dev_url_from_package);
    let label = discover_label(&dir_name, dir, package_value.as_ref());

    Some(SiteCandidate {
        dir_name,
        label,
        local_path: dir.to_string_lossy().to_string(),
        url,
        dev_url,
        source,
    })
}

/// URL source priority: astro config `site:` > CNAME > package.json
/// "homepage" > README live/운영/배포/homepage/production line.
fn discover_url(
    dir: &Path,
    roots: &[PathBuf],
    package: Option<&JsonValue>,
) -> (Option<String>, String) {
    for root in roots {
        for name in ASTRO_CONFIG_NAMES {
            if let Some(text) = read_text_capped(&root.join(name), TEXT_CAP) {
                if let Some(cap) = astro_site_re().captures(&text) {
                    return (
                        Some(cap[1].trim_end_matches('/').to_string()),
                        "astroConfig".to_string(),
                    );
                }
            }
        }
    }
    for root in roots {
        for rel in CNAME_RELATIVE {
            if let Some(url) = cname_url(&root.join(rel)) {
                return (Some(url), "cname".to_string());
            }
        }
    }
    if let Some(homepage) = package
        .and_then(|p| p.get("homepage"))
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|s| s.starts_with("http://") || s.starts_with("https://"))
    {
        return (
            Some(homepage.trim_end_matches('/').to_string()),
            "packageHomepage".to_string(),
        );
    }
    if let Some(url) = readme_url(&dir.join("README.md")) {
        return (Some(url), "readme".to_string());
    }
    (None, "none".to_string())
}

fn cname_url(path: &Path) -> Option<String> {
    let text = read_text_capped(path, 4096)?;
    let domain = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('#'))?;
    if domain.contains(' ') || domain.contains("://") || !domain.contains('.') {
        return None;
    }
    Some(format!("https://{domain}"))
}

fn readme_url(path: &Path) -> Option<String> {
    let text = read_text_capped(path, TEXT_CAP)?;
    for line in text.lines() {
        if !readme_keyword_re().is_match(line) {
            continue;
        }
        for found in url_re().find_iter(line) {
            let url = found
                .as_str()
                .trim_end_matches(['.', ',', ';', ':', '*', '`']);
            if URL_DOMAIN_DENYLIST.iter().any(|deny| url.contains(deny)) {
                continue;
            }
            return Some(url.to_string());
        }
    }
    None
}

fn dev_url_from_package(package: &JsonValue) -> Option<String> {
    let dev = package.get("scripts")?.get("dev")?.as_str()?;
    if let Some(cap) = port_flag_re().captures(dev) {
        return Some(format!("http://localhost:{}", &cap[1]));
    }
    let port = if dev.contains("astro") {
        4321
    } else if dev.contains("next") {
        3000
    } else if dev.contains("vite") {
        5173
    } else {
        return None;
    };
    Some(format!("http://localhost:{port}"))
}

/// Label priority: package.json name (skipping generic probe-root names like
/// "astro"/"site") > first README H1 > directory name.
fn discover_label(dir_name: &str, dir: &Path, package: Option<&JsonValue>) -> String {
    if let Some(name) = package
        .and_then(|p| p.get("name"))
        .and_then(JsonValue::as_str)
        .map(str::trim)
    {
        if !name.is_empty() && !GENERIC_PACKAGE_NAMES.contains(&name) {
            return name.to_string();
        }
    }
    if let Some(h1) = readme_h1(&dir.join("README.md")) {
        return h1;
    }
    dir_name.to_string()
}

fn readme_h1(path: &Path) -> Option<String> {
    let text = read_text_capped(path, TEXT_CAP)?;
    for line in text.lines().take(20) {
        if let Some(rest) = line.strip_prefix("# ") {
            let title = rest.trim();
            if !title.is_empty() {
                return Some(title.to_string());
            }
        }
    }
    None
}

/// Lossy, size-capped text read. None on any IO error (missing file, broken
/// symlink, permission) — probes are best-effort.
fn read_text_capped(path: &Path, cap: usize) -> Option<String> {
    let data = fs::read(path).ok()?;
    let slice = if data.len() > cap {
        &data[..cap]
    } else {
        &data[..]
    };
    Some(String::from_utf8_lossy(slice).into_owned())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    fn candidate_for<'a>(out: &'a [SiteCandidate], dir: &str) -> &'a SiteCandidate {
        out.iter()
            .find(|c| c.dir_name == dir)
            .unwrap_or_else(|| panic!("no candidate for {dir}"))
    }

    // -- registry ----------------------------------------------------------

    #[test]
    fn read_sites_seeds_envelope_when_missing() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join(".maru/sites.json");
        let value = read_sites_internal(&path).unwrap();
        assert_eq!(value, json!({ "version": 1, "sites": [] }));
        let on_disk = fs::read_to_string(&path).unwrap();
        assert!(on_disk.ends_with('\n'), "envelope files end with newline");
    }

    #[test]
    fn read_sites_reseeds_empty_file() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("sites.json");
        write(&path, "  \n");
        assert_eq!(
            read_sites_internal(&path).unwrap(),
            json!({ "version": 1, "sites": [] })
        );
    }

    #[test]
    fn sites_round_trip_preserves_payload() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("sites.json");
        let payload = json!({
            "version": 1,
            "sites": [ { "label": "Halla AI", "url": "https://halla.ai" } ]
        });
        save_sites_internal(&path, payload.clone()).unwrap();
        assert_eq!(read_sites_internal(&path).unwrap(), payload);
    }

    #[test]
    fn save_sites_injects_version_and_rejects_malformed() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("sites.json");
        save_sites_internal(&path, json!({ "sites": [] })).unwrap();
        assert_eq!(
            read_sites_internal(&path).unwrap()["version"],
            json!(SITES_SCHEMA_VERSION)
        );
        assert!(save_sites_internal(&path, json!([1, 2])).is_err());
        assert!(save_sites_internal(&path, json!({ "version": 1 })).is_err());
        assert!(save_sites_internal(&path, json!({ "sites": "nope" })).is_err());
    }

    #[test]
    fn read_sites_rejects_non_object_envelope() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("sites.json");
        write(&path, "[1, 2, 3]\n");
        assert!(read_sites_internal(&path).is_err());
    }

    // -- scanner: URL source priority ---------------------------------------

    #[test]
    fn scanner_prefers_astro_config_over_everything() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("alpha");
        write(
            &dir.join("astro.config.mjs"),
            "export default { site: 'https://alpha.example/', };\n",
        );
        write(&dir.join("public/CNAME"), "cname.example\n");
        write(
            &dir.join("package.json"),
            r#"{ "name": "alpha", "homepage": "https://homepage.example", "scripts": { "dev": "astro dev" } }"#,
        );
        write(
            &dir.join("README.md"),
            "# Alpha\n\nLive: https://readme.example\n",
        );
        let out = scan_work_sites(tmp.path().to_string_lossy().to_string()).unwrap();
        let c = candidate_for(&out, "alpha");
        assert_eq!(c.url.as_deref(), Some("https://alpha.example"));
        assert_eq!(c.source, "astroConfig");
        assert_eq!(c.dev_url.as_deref(), Some("http://localhost:4321"));
        assert_eq!(c.label, "alpha");
    }

    #[test]
    fn scanner_falls_back_to_cname() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("bravo");
        write(&dir.join("docs/CNAME"), "courses.jeju.ai\n");
        write(&dir.join("package.json"), r#"{ "name": "bravo" }"#);
        let out = scan_work_sites(tmp.path().to_string_lossy().to_string()).unwrap();
        let c = candidate_for(&out, "bravo");
        assert_eq!(c.url.as_deref(), Some("https://courses.jeju.ai"));
        assert_eq!(c.source, "cname");
    }

    #[test]
    fn scanner_falls_back_to_package_homepage() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("charlie");
        write(
            &dir.join("package.json"),
            r#"{ "name": "charlie", "homepage": "https://charlie.example/", "scripts": { "dev": "next dev" } }"#,
        );
        write(
            &dir.join("README.md"),
            "# Charlie\n\nLive: https://readme.example\n",
        );
        let out = scan_work_sites(tmp.path().to_string_lossy().to_string()).unwrap();
        let c = candidate_for(&out, "charlie");
        assert_eq!(c.url.as_deref(), Some("https://charlie.example"));
        assert_eq!(c.source, "packageHomepage");
        assert_eq!(c.dev_url.as_deref(), Some("http://localhost:3000"));
    }

    #[test]
    fn scanner_falls_back_to_readme_url() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("delta");
        // Real-world shapes: Korean keyword + backtick-wrapped URL.
        write(
            &dir.join("README.md"),
            "# Delta\n\n운영 URL: `https://kbs-jeju-election.vercel.app`\n",
        );
        let out = scan_work_sites(tmp.path().to_string_lossy().to_string()).unwrap();
        let c = candidate_for(&out, "delta");
        assert_eq!(
            c.url.as_deref(),
            Some("https://kbs-jeju-election.vercel.app")
        );
        assert_eq!(c.source, "readme");
        assert_eq!(c.label, "Delta", "label falls back to README H1");
    }

    #[test]
    fn scanner_readme_skips_badge_urls_and_markdown_link_parens() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("echo");
        write(
            &dir.join("README.md"),
            "# Echo\n\n[![Website](https://img.shields.io/badge/website-live-brightgreen)](https://echo.example)\n**Live site:** [echo](https://echo.example/path)\n",
        );
        let out = scan_work_sites(tmp.path().to_string_lossy().to_string()).unwrap();
        let c = candidate_for(&out, "echo");
        assert_eq!(c.url.as_deref(), Some("https://echo.example"));
        assert_eq!(c.source, "readme");
    }

    // -- scanner: nested probe roots -----------------------------------------

    #[test]
    fn scanner_probes_nested_astro_root_and_skips_generic_package_name() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("foxtrot");
        // Mirrors halla-ai/staixbwlb: astro/ holds the project, package name
        // is the useless "astro", top-level README has the H1.
        write(
            &dir.join("astro/astro.config.mjs"),
            "export default { site: 'https://foxtrot.example' }\n",
        );
        write(
            &dir.join("astro/package.json"),
            r#"{ "name": "astro", "scripts": { "dev": "astro dev" } }"#,
        );
        write(&dir.join("site/legacy.html"), "<html></html>");
        write(&dir.join("README.md"), "# STAI × BWLB\n");
        let out = scan_work_sites(tmp.path().to_string_lossy().to_string()).unwrap();
        let c = candidate_for(&out, "foxtrot");
        assert_eq!(c.url.as_deref(), Some("https://foxtrot.example"));
        assert_eq!(c.source, "astroConfig");
        assert_eq!(c.dev_url.as_deref(), Some("http://localhost:4321"));
        assert_eq!(c.label, "STAI × BWLB");
    }

    // -- scanner: tolerance ---------------------------------------------------

    #[test]
    fn scanner_tolerates_garbage_and_returns_null_url_candidates() {
        let tmp = TempDir::new().unwrap();
        // Empty dir.
        fs::create_dir_all(tmp.path().join("empty")).unwrap();
        // Dir with invalid package.json.
        write(&tmp.path().join("broken/package.json"), "{ not json");
        // Hidden dir must be skipped.
        fs::create_dir_all(tmp.path().join(".git")).unwrap();
        // Loose file at top level must be ignored.
        write(&tmp.path().join("stray.txt"), "hi");
        // Broken symlink inside a dir must not abort the dir's probe.
        #[cfg(unix)]
        {
            fs::create_dir_all(tmp.path().join("symlinked")).unwrap();
            std::os::unix::fs::symlink(
                tmp.path().join("does-not-exist"),
                tmp.path().join("symlinked/.env.local"),
            )
            .unwrap();
        }
        // One good dir to prove the scan still produces useful output.
        write(&tmp.path().join("good/CNAME"), "good.example\n");

        let out = scan_work_sites(tmp.path().to_string_lossy().to_string()).unwrap();

        let empty = candidate_for(&out, "empty");
        assert_eq!(empty.url, None);
        assert_eq!(empty.source, "none");
        assert_eq!(empty.label, "empty");

        let broken = candidate_for(&out, "broken");
        assert_eq!(broken.url, None);
        assert_eq!(broken.dev_url, None);

        assert!(out.iter().all(|c| c.dir_name != ".git"));
        assert_eq!(
            candidate_for(&out, "good").url.as_deref(),
            Some("https://good.example")
        );
    }

    #[test]
    fn scan_rejects_missing_directory() {
        assert!(scan_work_sites("/definitely/not/a/real/dir-xyz".to_string()).is_err());
    }

    // -- scanner: dev url ------------------------------------------------------

    #[test]
    fn dev_url_detection_per_framework_and_explicit_port() {
        let next = json!({ "scripts": { "dev": "next dev" } });
        let vite = json!({ "scripts": { "dev": "vite --host" } });
        let astro = json!({ "scripts": { "dev": "astro dev" } });
        let explicit = json!({ "scripts": { "dev": "astro dev --port 8080" } });
        let unknown = json!({ "scripts": { "dev": "make serve" } });
        let none = json!({ "name": "x" });
        assert_eq!(
            dev_url_from_package(&next).as_deref(),
            Some("http://localhost:3000")
        );
        assert_eq!(
            dev_url_from_package(&vite).as_deref(),
            Some("http://localhost:5173")
        );
        assert_eq!(
            dev_url_from_package(&astro).as_deref(),
            Some("http://localhost:4321")
        );
        assert_eq!(
            dev_url_from_package(&explicit).as_deref(),
            Some("http://localhost:8080")
        );
        assert_eq!(dev_url_from_package(&unknown), None);
        assert_eq!(dev_url_from_package(&none), None);
    }

    mod phase08_23 {
        use super::*;
        use crate::atomic_file::phase08_06::{boundary, run, Held, Home};
        use std::sync::mpsc;
        use std::time::Duration;

        fn start<F>(future: F) -> mpsc::Receiver<F::Output>
        where
            F: std::future::Future + Send + 'static,
            F::Output: Send + 'static,
        {
            let (tx, rx) = mpsc::channel();
            tauri::async_runtime::spawn(async move {
                let _ = tx.send(future.await);
            });
            rx
        }

        fn done<T>(rx: mpsc::Receiver<T>) -> T {
            rx.recv_timeout(Duration::from_secs(10))
                .expect("fixture completion")
        }

        fn payload(label: &str) -> JsonValue {
            json!({
                "version": 1,
                "sites": [ { "label": label, "url": "https://example.com" } ]
            })
        }

        #[test]
        fn phase08_23_sites_wrappers_yield_same_poll_and_map_join_failure() {
            let home = Home::new();
            let registry = sites_json_path().unwrap();
            boundary(registry.clone(), "read_sites", ipc::read_sites());
            boundary(registry, "save_sites", ipc::save_sites(payload("boundary")));
            let scan_dir = home.root.path().join("scan-root");
            fs::create_dir_all(&scan_dir).unwrap();
            boundary(
                scan_dir.clone(),
                "scan_work_sites",
                ipc::scan_work_sites(scan_dir.to_string_lossy().to_string()),
            );
        }

        #[test]
        fn phase08_23_sites_real_fixture_results_and_rejections() {
            let _home = Home::new();
            let seeded = run(ipc::read_sites()).unwrap();
            assert_eq!(seeded, json!({ "version": 1, "sites": [] }));
            let registry = sites_json_path().unwrap();
            assert!(registry.exists());

            run(ipc::save_sites(payload("Fixture"))).unwrap();
            let reloaded = run(ipc::read_sites()).unwrap();
            assert_eq!(reloaded, payload("Fixture"));

            let err = run(ipc::save_sites(json!({ "sites": "nope" }))).unwrap_err();
            assert!(err.contains("\"sites\" array"));

            let scan_root = tempfile::tempdir().unwrap();
            write(&scan_root.path().join("alpha/CNAME"), "alpha.example\n");
            let scanned = run(ipc::scan_work_sites(
                scan_root.path().to_string_lossy().to_string(),
            ))
            .unwrap();
            let alpha = candidate_for(&scanned, "alpha");
            assert_eq!(alpha.url.as_deref(), Some("https://alpha.example"));

            let err = run(ipc::scan_work_sites(
                "/definitely/not/a/real/dir-xyz".to_string(),
            ))
            .unwrap_err();
            assert!(err.contains("Not a directory"));
        }

        #[test]
        fn phase08_23_sites_serializes_registry_both_orders() {
            for read_first in [false, true] {
                let home = Home::new();
                let registry = sites_json_path().unwrap();
                let admitted = Held::new(registry.clone(), "admitted");
                if read_first {
                    let first = start(ipc::read_sites());
                    admitted.wait();
                    let waiting = Held::new(registry.clone(), "before-admission");
                    let second = start(ipc::save_sites(payload("Writer")));
                    waiting.wait();
                    waiting.release();
                    assert!(
                        second.recv_timeout(Duration::from_millis(30)).is_err(),
                        "sites writer must wait while the seeding reader holds admission"
                    );
                    admitted.release();
                    done(first).unwrap();
                    done(second).unwrap();
                } else {
                    let first = start(ipc::save_sites(payload("Writer")));
                    admitted.wait();
                    let waiting = Held::new(registry.clone(), "before-admission");
                    let second = start(ipc::read_sites());
                    waiting.wait();
                    waiting.release();
                    assert!(
                        second.recv_timeout(Duration::from_millis(30)).is_err(),
                        "seeding reader must wait while the sites writer holds admission"
                    );
                    admitted.release();
                    done(first).unwrap();
                    done(second).unwrap();
                }
                let final_value = read_sites_internal(&registry).unwrap();
                assert_eq!(
                    final_value,
                    payload("Writer"),
                    "serialized writer payload must survive the reader in either order"
                );
            }
        }

        #[test]
        fn phase08_23_sites_error_releases_admission_and_retry_recovers() {
            let _home = Home::new();
            let registry = sites_json_path().unwrap();
            let err = run(ipc::save_sites(json!({ "version": 1 }))).unwrap_err();
            assert!(err.contains("\"sites\" array"));
            assert!(
                !registry.exists(),
                "rejected save must not create the registry file"
            );
            run(ipc::save_sites(payload("Recovered"))).unwrap();
            assert_eq!(
                read_sites_internal(&registry).unwrap(),
                payload("Recovered")
            );
        }
    }
}
