// OTA skills-bundle plumbing: durable state, signed-metadata discovery,
// download + verification, zip staging, and the swap transaction journal.
//
// This module owns no registry knowledge; the Tauri commands, migration, and
// swap orchestration live in `store.rs` (they need the registry lock and the
// embedded BUILTIN_DIR). Everything here is deliberately testable without a
// network: discovery/download take URLs, verification takes bytes.
//
// Layout under ~/.maru/skills/:
//   bundle-state.json        active/previous bundle refs (atomic writes)
//   bundle-txn.json          swap journal, present only mid-transaction
//   _bundles/<bundle-id>/    verified pristine baselines (dirty/discard source)
//   _builtin/                active materialization (user-editable)
//   _cache/staging/          zip extraction target before the swap
//   _cache/backup-*/         previous _builtin during a swap

use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use crate::skill_host::fs as host_fs;

pub const BUNDLE_STATE_FILE: &str = "bundle-state.json";
pub const TXN_JOURNAL_FILE: &str = "bundle-txn.json";
pub const BUNDLES_DIR_NAME: &str = "_bundles";
pub const BOOTSTRAP_SOURCE: &str = "bootstrap";
pub const REMOTE_SOURCE: &str = "remote";

const METADATA_CAP_BYTES: u64 = 8 * 1024 * 1024;
const ARCHIVE_CAP_BYTES: u64 = 256 * 1024 * 1024;
const UNCOMPRESSED_CAP_BYTES: u64 = 512 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 20_000;
const HTTP_JSON_TIMEOUT_SECS: u64 = 10;
const HTTP_ARCHIVE_TIMEOUT_SECS: u64 = 120;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// A bundle the app has applied (or could apply): identity + provenance.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillBundleRef {
    pub bundle_id: String,
    pub revision: u64,
    pub display_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    /// "bootstrap" (embedded snapshot) or "remote" (skills-channel download).
    pub source: String,
    pub env_hash: String,
    pub applied_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BundleState {
    pub schema: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active: Option<SkillBundleRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous: Option<SkillBundleRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BundleArchiveInfo {
    pub name: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BundleFileEntry {
    pub path: String,
    pub sha256: String,
    #[serde(default = "default_file_mode")]
    pub mode: String,
}

fn default_file_mode() -> String {
    "644".to_string()
}

/// Signed metadata published next to each bundle archive.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleMetadata {
    pub schema: u32,
    pub revision: u64,
    pub display_version: String,
    #[serde(default)]
    pub commit: Option<String>,
    #[serde(default)]
    pub published_at: Option<String>,
    pub min_app_version: String,
    pub env_hash: String,
    pub archive: BundleArchiveInfo,
    pub files: Vec<BundleFileEntry>,
}

/// A discovered remote bundle: verified metadata plus where to fetch the zip.
#[derive(Debug, Clone)]
pub struct RemoteBundle {
    pub metadata: BundleMetadata,
    pub archive_url: String,
    pub archive_sig_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapJournal {
    pub schema: u32,
    pub new_bundle_id: String,
    pub backup_dir: String,
    pub started_at: String,
}

// ---------------------------------------------------------------------------
// Paths and durable state
// ---------------------------------------------------------------------------

pub fn state_path() -> Result<PathBuf, String> {
    Ok(host_fs::skills_root()?.join(BUNDLE_STATE_FILE))
}

pub fn journal_path() -> Result<PathBuf, String> {
    Ok(host_fs::skills_root()?.join(TXN_JOURNAL_FILE))
}

pub fn bundles_dir() -> Result<PathBuf, String> {
    Ok(host_fs::skills_root()?.join(BUNDLES_DIR_NAME))
}

pub fn bundle_pristine_dir(bundle_id: &str) -> Result<PathBuf, String> {
    Ok(bundles_dir()?.join(bundle_id))
}

pub fn staging_root() -> Result<PathBuf, String> {
    Ok(host_fs::skills_root()?.join("_cache").join("staging"))
}

pub fn read_state() -> Result<Option<BundleState>, String> {
    let path = state_path()?;
    if !path.is_file() {
        return Ok(None);
    }
    let content = fs::read_to_string(&path)
        .map_err(|err| format!("Cannot read {}: {err}", host_fs::display_path(&path)))?;
    let state: BundleState = serde_json::from_str(&content)
        .map_err(|err| format!("Cannot parse {}: {err}", host_fs::display_path(&path)))?;
    Ok(Some(state))
}

pub fn write_state(state: &BundleState) -> Result<(), String> {
    host_fs::write_json_pretty(&state_path()?, state)
}

pub fn read_journal() -> Result<Option<SwapJournal>, String> {
    let path = journal_path()?;
    if !path.is_file() {
        return Ok(None);
    }
    let content = fs::read_to_string(&path)
        .map_err(|err| format!("Cannot read {}: {err}", host_fs::display_path(&path)))?;
    let journal: SwapJournal = serde_json::from_str(&content)
        .map_err(|err| format!("Cannot parse {}: {err}", host_fs::display_path(&path)))?;
    Ok(Some(journal))
}

pub fn write_journal(journal: &SwapJournal) -> Result<(), String> {
    host_fs::write_json_pretty(&journal_path()?, journal)
}

pub fn clear_journal() -> Result<(), String> {
    let path = journal_path()?;
    if path.is_file() {
        fs::remove_file(&path)
            .map_err(|err| format!("Cannot remove {}: {err}", host_fs::display_path(&path)))?;
    }
    Ok(())
}

/// Roll an interrupted swap back (or forward) to a consistent state. Called
/// before any bundle operation and from the builtin-source bootstrap path.
pub fn recover_interrupted_swap(builtin_root: &Path) -> Result<(), String> {
    let Some(journal) = read_journal()? else {
        return Ok(());
    };
    let state = read_state()?.unwrap_or_default();
    let swap_completed = state
        .active
        .as_ref()
        .map(|active| active.bundle_id == journal.new_bundle_id)
        .unwrap_or(false);
    let backup = PathBuf::from(&journal.backup_dir);
    if swap_completed {
        // Crash after the state write: the new bundle is fully applied; the
        // leftover backup just needs sweeping.
        if backup.exists() {
            fs::remove_dir_all(&backup).map_err(|err| {
                format!("Cannot remove {}: {err}", host_fs::display_path(&backup))
            })?;
        }
    } else {
        // Crash mid-copy: drop the partial _builtin and restore the backup.
        if backup.is_dir() {
            if builtin_root.exists() {
                fs::remove_dir_all(builtin_root).map_err(|err| {
                    format!(
                        "Cannot remove partial {}: {err}",
                        host_fs::display_path(builtin_root)
                    )
                })?;
            }
            fs::rename(&backup, builtin_root).map_err(|err| {
                format!(
                    "Cannot restore {} from {}: {err}",
                    host_fs::display_path(builtin_root),
                    host_fs::display_path(&backup)
                )
            })?;
        }
    }
    clear_journal()
}

// ---------------------------------------------------------------------------
// Version comparison
// ---------------------------------------------------------------------------

pub fn parse_semver(value: &str) -> Option<(u64, u64, u64)> {
    let mut parts = value.trim().splitn(3, '.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    Some((major, minor, patch))
}

/// True when this app build satisfies the bundle's minimum app version.
pub fn app_version_satisfies(min_app_version: &str) -> bool {
    let app = parse_semver(env!("CARGO_PKG_VERSION"));
    let min = parse_semver(min_app_version);
    match (app, min) {
        (Some(app), Some(min)) => app >= min,
        // Unparseable constraint: refuse rather than guess.
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// Signature verification (Tauri updater minisign key)
// ---------------------------------------------------------------------------

fn updater_pubkey_b64() -> Result<String, String> {
    #[cfg(debug_assertions)]
    if let Ok(key) = std::env::var("MARU_SKILLS_PUBKEY") {
        if !key.trim().is_empty() {
            return Ok(key.trim().to_string());
        }
    }
    let conf: serde_json::Value = serde_json::from_str(include_str!("../../tauri.conf.json"))
        .map_err(|err| format!("Cannot parse embedded tauri.conf.json: {err}"))?;
    conf.pointer("/plugins/updater/pubkey")
        .and_then(serde_json::Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| "updater_pubkey_missing".to_string())
}

/// Verify `data` against a Tauri-style signature: the `.sig` asset content is
/// base64 of a minisign signature file, checked with the app updater pubkey
/// (itself base64 of a minisign public key file).
pub fn verify_signature(data: &[u8], sig_asset_content: &str) -> Result<(), String> {
    let pubkey_text = base64::engine::general_purpose::STANDARD
        .decode(updater_pubkey_b64()?.trim())
        .map_err(|err| format!("signature_pubkey_decode_failed: {err}"))
        .and_then(|bytes| {
            String::from_utf8(bytes).map_err(|err| format!("signature_pubkey_utf8: {err}"))
        })?;
    let public_key = PublicKey::decode(&pubkey_text)
        .map_err(|err| format!("signature_pubkey_invalid: {err}"))?;
    let sig_text = base64::engine::general_purpose::STANDARD
        .decode(sig_asset_content.trim())
        .map_err(|err| format!("signature_decode_failed: {err}"))
        .and_then(|bytes| {
            String::from_utf8(bytes).map_err(|err| format!("signature_utf8: {err}"))
        })?;
    let signature =
        Signature::decode(&sig_text).map_err(|err| format!("signature_invalid: {err}"))?;
    public_key
        .verify(data, &signature, true)
        .map_err(|err| format!("signature_mismatch: {err}"))
}

// ---------------------------------------------------------------------------
// Remote discovery + download
// ---------------------------------------------------------------------------

fn http_client(timeout_secs: u64) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent(format!("maru/{}", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .build()
        .map_err(|err| format!("http_client_failed: {err}"))
}

fn http_get_capped(url: &str, cap: u64, timeout_secs: u64) -> Result<Vec<u8>, String> {
    let response = http_client(timeout_secs)?
        .get(url)
        .send()
        .map_err(|err| format!("network_error: {err}"))?;
    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err("not_found".to_string());
    }
    if !status.is_success() {
        return Err(format!("http_status_{}", status.as_u16()));
    }
    if let Some(length) = response.content_length() {
        if length > cap {
            return Err(format!("response_too_large: {length} > {cap}"));
        }
    }
    let mut body = Vec::new();
    let mut reader = response.take(cap + 1);
    reader
        .read_to_end(&mut body)
        .map_err(|err| format!("network_read_error: {err}"))?;
    if body.len() as u64 > cap {
        return Err(format!("response_too_large: > {cap}"));
    }
    Ok(body)
}

fn asset_revision(name: &str) -> Option<u64> {
    let rest = name.strip_prefix("maru-skills-r")?;
    let (revision, tail) = rest.split_once('-')?;
    if !tail.ends_with(".json") {
        return None;
    }
    let sha = tail.trim_end_matches(".json");
    if sha.is_empty() || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    revision.parse().ok()
}

/// Locate the newest published bundle. Returns Ok(None) when the channel or
/// its assets do not exist yet. Metadata signature is verified before parse.
pub fn discover_remote_bundle(repo_slug: &str, channel_tag: &str) -> Result<Option<RemoteBundle>, String> {
    if let Ok(url) = std::env::var("MARU_SKILLS_MANIFEST_URL") {
        if !url.trim().is_empty() {
            return discover_from_metadata_url(url.trim());
        }
    }
    let api_url = format!("https://api.github.com/repos/{repo_slug}/releases/tags/{channel_tag}");
    let body = match http_get_capped(&api_url, METADATA_CAP_BYTES, HTTP_JSON_TIMEOUT_SECS) {
        Ok(body) => body,
        Err(err) if err == "not_found" => return Ok(None),
        Err(err) => return Err(err),
    };
    let release: serde_json::Value =
        serde_json::from_slice(&body).map_err(|err| format!("channel_response_invalid: {err}"))?;
    let assets = release
        .get("assets")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut urls: BTreeMap<String, String> = BTreeMap::new();
    for asset in &assets {
        let (Some(name), Some(url)) = (
            asset.get("name").and_then(serde_json::Value::as_str),
            asset
                .get("browser_download_url")
                .and_then(serde_json::Value::as_str),
        ) else {
            continue;
        };
        urls.insert(name.to_string(), url.to_string());
    }
    let Some(metadata_name) = urls
        .keys()
        .filter(|name| asset_revision(name).is_some())
        .max_by_key(|name| asset_revision(name).unwrap_or(0))
        .cloned()
    else {
        return Ok(None);
    };
    let metadata_url = urls
        .get(&metadata_name)
        .cloned()
        .ok_or_else(|| "channel_asset_missing".to_string())?;
    let remote = fetch_verified_metadata(&metadata_url)?;
    let archive_name = remote.metadata.archive.name.clone();
    let archive_url = urls
        .get(&archive_name)
        .cloned()
        .ok_or_else(|| format!("channel_archive_missing: {archive_name}"))?;
    let archive_sig_url = urls
        .get(&format!("{archive_name}.sig"))
        .cloned()
        .ok_or_else(|| format!("channel_archive_sig_missing: {archive_name}.sig"))?;
    Ok(Some(RemoteBundle {
        metadata: remote.metadata,
        archive_url,
        archive_sig_url,
    }))
}

/// QA path: MARU_SKILLS_MANIFEST_URL points directly at a metadata JSON; the
/// archive and signatures are fetched as siblings. Signatures stay enforced.
fn discover_from_metadata_url(metadata_url: &str) -> Result<Option<RemoteBundle>, String> {
    let remote = match fetch_verified_metadata(metadata_url) {
        Ok(remote) => remote,
        Err(err) if err == "not_found" => return Ok(None),
        Err(err) => return Err(err),
    };
    let base = metadata_url
        .rsplit_once('/')
        .map(|(base, _)| base)
        .ok_or_else(|| "manifest_url_invalid".to_string())?;
    let archive_name = &remote.metadata.archive.name;
    Ok(Some(RemoteBundle {
        archive_url: format!("{base}/{archive_name}"),
        archive_sig_url: format!("{base}/{archive_name}.sig"),
        metadata: remote.metadata,
    }))
}

struct VerifiedMetadata {
    metadata: BundleMetadata,
}

fn fetch_verified_metadata(metadata_url: &str) -> Result<VerifiedMetadata, String> {
    let body = http_get_capped(metadata_url, METADATA_CAP_BYTES, HTTP_JSON_TIMEOUT_SECS)?;
    let sig = http_get_capped(
        &format!("{metadata_url}.sig"),
        METADATA_CAP_BYTES,
        HTTP_JSON_TIMEOUT_SECS,
    )
    .map_err(|err| format!("metadata_signature_unavailable: {err}"))?;
    let sig_text =
        String::from_utf8(sig).map_err(|err| format!("metadata_signature_utf8: {err}"))?;
    verify_signature(&body, &sig_text).map_err(|err| format!("metadata_{err}"))?;
    let metadata: BundleMetadata =
        serde_json::from_slice(&body).map_err(|err| format!("metadata_invalid: {err}"))?;
    if metadata.schema != 1 {
        return Err(format!("metadata_schema_unsupported: {}", metadata.schema));
    }
    validate_metadata_paths(&metadata)?;
    Ok(VerifiedMetadata { metadata })
}

fn validate_metadata_paths(metadata: &BundleMetadata) -> Result<(), String> {
    if metadata.files.is_empty() {
        return Err("metadata_files_empty".to_string());
    }
    if metadata.files.len() > MAX_ARCHIVE_ENTRIES {
        return Err(format!("metadata_files_excessive: {}", metadata.files.len()));
    }
    if metadata.archive.size > ARCHIVE_CAP_BYTES {
        return Err(format!("metadata_archive_too_large: {}", metadata.archive.size));
    }
    let mut seen = std::collections::BTreeSet::new();
    for file in &metadata.files {
        validate_bundle_rel_path(&file.path)?;
        if !seen.insert(file.path.as_str()) {
            return Err(format!("metadata_duplicate_path: {}", file.path));
        }
        if !matches!(file.mode.as_str(), "644" | "755") {
            return Err(format!("metadata_mode_invalid: {} {}", file.path, file.mode));
        }
    }
    Ok(())
}

fn validate_bundle_rel_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.len() > 4096 {
        return Err(format!("bundle_path_invalid: {path}"));
    }
    if path.starts_with('/') || path.contains('\\') || path.contains('\0') {
        return Err(format!("bundle_path_invalid: {path}"));
    }
    for segment in path.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err(format!("bundle_path_invalid: {path}"));
        }
    }
    Ok(())
}

/// Download the archive, verify its signature + digest + size, and return the
/// bytes. Nothing on disk is touched.
pub fn download_verified_archive(remote: &RemoteBundle) -> Result<Vec<u8>, String> {
    let bytes = http_get_capped(&remote.archive_url, ARCHIVE_CAP_BYTES, HTTP_ARCHIVE_TIMEOUT_SECS)?;
    if bytes.len() as u64 != remote.metadata.archive.size {
        return Err(format!(
            "archive_size_mismatch: {} != {}",
            bytes.len(),
            remote.metadata.archive.size
        ));
    }
    let digest = sha256_hex(&bytes);
    if digest != remote.metadata.archive.sha256 {
        return Err("archive_sha256_mismatch".to_string());
    }
    let sig = http_get_capped(
        &remote.archive_sig_url,
        METADATA_CAP_BYTES,
        HTTP_JSON_TIMEOUT_SECS,
    )
    .map_err(|err| format!("archive_signature_unavailable: {err}"))?;
    let sig_text =
        String::from_utf8(sig).map_err(|err| format!("archive_signature_utf8: {err}"))?;
    verify_signature(&bytes, &sig_text).map_err(|err| format!("archive_{err}"))?;
    Ok(bytes)
}

// ---------------------------------------------------------------------------
// Zip validation + staging
// ---------------------------------------------------------------------------

/// Validate the archive against its signed metadata and extract it into
/// `staging`. Every entry must be listed (path + sha256), symlinks and
/// traversal names are rejected, and decompression is budget-capped. The
/// staging directory is created fresh; on error it is removed.
pub fn extract_bundle_to_staging(
    zip_bytes: &[u8],
    metadata: &BundleMetadata,
    staging: &Path,
) -> Result<(), String> {
    if staging.exists() {
        fs::remove_dir_all(staging)
            .map_err(|err| format!("Cannot clear {}: {err}", host_fs::display_path(staging)))?;
    }
    host_fs::ensure_dir(staging)?;
    extract_bundle_inner(zip_bytes, metadata, staging).inspect_err(|_| {
        let _ = fs::remove_dir_all(staging);
    })
}

fn extract_bundle_inner(
    zip_bytes: &[u8],
    metadata: &BundleMetadata,
    staging: &Path,
) -> Result<(), String> {
    let expected: BTreeMap<&str, &BundleFileEntry> = metadata
        .files
        .iter()
        .map(|file| (file.path.as_str(), file))
        .collect();
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(zip_bytes))
        .map_err(|err| format!("archive_unreadable: {err}"))?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err(format!("archive_entries_excessive: {}", archive.len()));
    }
    let mut budget = UNCOMPRESSED_CAP_BYTES;
    let mut seen = std::collections::BTreeSet::new();
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|err| format!("archive_entry_unreadable: {err}"))?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().to_string();
        validate_bundle_rel_path(&name)?;
        if entry.enclosed_name().is_none() {
            return Err(format!("archive_entry_escapes: {name}"));
        }
        if let Some(mode) = entry.unix_mode() {
            if mode & 0o170000 == 0o120000 {
                return Err(format!("archive_symlink_rejected: {name}"));
            }
        }
        let listed = expected
            .get(name.as_str())
            .ok_or_else(|| format!("archive_unlisted_file: {name}"))?;
        if !seen.insert(name.clone()) {
            return Err(format!("archive_duplicate_entry: {name}"));
        }
        let mut contents = Vec::new();
        let mut limited = (&mut entry).take(budget + 1);
        limited
            .read_to_end(&mut contents)
            .map_err(|err| format!("archive_entry_read_failed: {name}: {err}"))?;
        if contents.len() as u64 > budget {
            return Err("archive_decompression_budget_exceeded".to_string());
        }
        budget -= contents.len() as u64;
        if sha256_hex(&contents) != listed.sha256 {
            return Err(format!("archive_file_sha256_mismatch: {name}"));
        }
        let target = staging.join(Path::new(&name));
        if let Some(parent) = target.parent() {
            host_fs::ensure_dir(parent)?;
        }
        fs::write(&target, &contents)
            .map_err(|err| format!("Cannot write {}: {err}", host_fs::display_path(&target)))?;
        set_bundle_file_mode(&target, &listed.mode)?;
    }
    if seen.len() != expected.len() {
        let missing: Vec<&str> = expected
            .keys()
            .filter(|path| !seen.contains(**path))
            .take(5)
            .copied()
            .collect();
        return Err(format!("archive_files_missing: {}", missing.join(", ")));
    }
    Ok(())
}

fn set_bundle_file_mode(path: &Path, mode: &str) -> Result<(), String> {
    #[cfg(unix)]
    {
        let bits = if mode == "755" { 0o755 } else { 0o644 };
        fs::set_permissions(path, fs::Permissions::from_mode(bits)).map_err(|err| {
            format!(
                "Cannot set permissions for {}: {err}",
                host_fs::display_path(path)
            )
        })?;
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Digest over (rel path, content sha) pairs: sorted `rel\0sha\0`, matching
/// scripts/skills-bundle.mjs. Paths must be '/'-normalized bundle-relative.
pub fn hash_from_file_hashes(mut pairs: Vec<(String, String)>) -> String {
    pairs.sort_by(|a, b| a.0.cmp(&b.0));
    let mut hasher = Sha256::new();
    for (rel, sha) in pairs {
        hasher.update(rel.as_bytes());
        hasher.update(b"\0");
        hasher.update(sha.as_bytes());
        hasher.update(b"\0");
    }
    format!("{:x}", hasher.finalize())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn build_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut cursor = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut cursor);
            for (name, data) in entries {
                writer
                    .start_file(*name, zip::write::SimpleFileOptions::default())
                    .unwrap();
                writer.write_all(data).unwrap();
            }
            writer.finish().unwrap();
        }
        cursor.into_inner()
    }

    fn metadata_for(files: &[(&str, &[u8])]) -> BundleMetadata {
        BundleMetadata {
            schema: 1,
            revision: 2,
            display_version: "r2".to_string(),
            commit: None,
            published_at: None,
            min_app_version: "0.0.1".to_string(),
            env_hash: String::new(),
            archive: BundleArchiveInfo {
                name: "maru-skills-r2-abc1234.zip".to_string(),
                sha256: String::new(),
                size: 0,
            },
            files: files
                .iter()
                .map(|(path, data)| BundleFileEntry {
                    path: (*path).to_string(),
                    sha256: sha256_hex(data),
                    mode: if data.starts_with(b"#!") {
                        "755".to_string()
                    } else {
                        "644".to_string()
                    },
                })
                .collect(),
        }
    }

    #[test]
    fn extract_stages_valid_bundle_with_modes() {
        let files: Vec<(&str, &[u8])> = vec![
            ("manifest.json", b"{}".as_slice()),
            ("skills/x/SKILL.md", b"---\nname: x\n---\n".as_slice()),
            ("envs/default/setup.sh", b"#!/bin/bash\n".as_slice()),
        ];
        let zip_bytes = build_zip(&files);
        let metadata = metadata_for(&files);
        let staging = tempfile::TempDir::new().unwrap();
        let target = staging.path().join("out");
        extract_bundle_to_staging(&zip_bytes, &metadata, &target).unwrap();
        assert_eq!(fs::read(target.join("manifest.json")).unwrap(), b"{}");
        assert!(target.join("skills/x/SKILL.md").is_file());
        #[cfg(unix)]
        {
            let mode = fs::metadata(target.join("envs/default/setup.sh"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o755);
        }
    }

    #[test]
    fn extract_rejects_traversal_unlisted_and_sha_mismatch() {
        let staging = tempfile::TempDir::new().unwrap();

        // Path traversal entry: rejected before any write.
        let evil: Vec<(&str, &[u8])> = vec![("../evil.txt", b"boom".as_slice())];
        let zip_bytes = build_zip(&evil);
        let metadata = metadata_for(&[("ok.txt", b"boom".as_slice())]);
        let target = staging.path().join("a");
        let err = extract_bundle_to_staging(&zip_bytes, &metadata, &target).unwrap_err();
        assert!(err.contains("bundle_path_invalid"), "{err}");
        assert!(!target.exists());

        // Unlisted file: zip has a file metadata does not know about.
        let files: Vec<(&str, &[u8])> = vec![
            ("ok.txt", b"ok".as_slice()),
            ("sneaky.txt", b"nope".as_slice()),
        ];
        let zip_bytes = build_zip(&files);
        let metadata = metadata_for(&[("ok.txt", b"ok".as_slice())]);
        let target = staging.path().join("b");
        let err = extract_bundle_to_staging(&zip_bytes, &metadata, &target).unwrap_err();
        assert!(err.contains("archive_unlisted_file"), "{err}");
        assert!(!target.exists());

        // Content drift: sha mismatch against the signed metadata.
        let files: Vec<(&str, &[u8])> = vec![("ok.txt", b"tampered".as_slice())];
        let zip_bytes = build_zip(&files);
        let metadata = metadata_for(&[("ok.txt", b"original".as_slice())]);
        let target = staging.path().join("c");
        let err = extract_bundle_to_staging(&zip_bytes, &metadata, &target).unwrap_err();
        assert!(err.contains("archive_file_sha256_mismatch"), "{err}");
        assert!(!target.exists());

        // Missing file: metadata expects more than the archive delivers.
        let files: Vec<(&str, &[u8])> = vec![("ok.txt", b"ok".as_slice())];
        let zip_bytes = build_zip(&files);
        let metadata = metadata_for(&[
            ("ok.txt", b"ok".as_slice()),
            ("gone.txt", b"gone".as_slice()),
        ]);
        let target = staging.path().join("d");
        let err = extract_bundle_to_staging(&zip_bytes, &metadata, &target).unwrap_err();
        assert!(err.contains("archive_files_missing"), "{err}");
        assert!(!target.exists());
    }

    #[test]
    fn extract_rejects_symlink_entries() {
        let mut cursor = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut cursor);
            writer
                .add_symlink(
                    "skills/x/link",
                    "/etc/passwd",
                    zip::write::SimpleFileOptions::default(),
                )
                .unwrap();
            writer.finish().unwrap();
        }
        let zip_bytes = cursor.into_inner();
        let metadata = metadata_for(&[("skills/x/link", b"whatever".as_slice())]);
        let staging = tempfile::TempDir::new().unwrap();
        let target = staging.path().join("out");
        let err = extract_bundle_to_staging(&zip_bytes, &metadata, &target).unwrap_err();
        assert!(err.contains("archive_symlink_rejected"), "{err}");
        assert!(!target.exists());
    }

    #[test]
    fn journal_recovery_restores_backup_for_incomplete_swap() {
        let _home = crate::skill_host::fs::test_home_for_bundle_tests();
        let skills_root = host_fs::skills_root().unwrap();
        let builtin = skills_root.join("_builtin");
        let backup = skills_root.join("_cache").join("backup-test");
        fs::create_dir_all(&backup).unwrap();
        fs::write(backup.join("marker.txt"), b"old").unwrap();
        fs::create_dir_all(&builtin).unwrap();
        fs::write(builtin.join("partial.txt"), b"new-partial").unwrap();
        // State still points at the OLD bundle: the swap never completed.
        write_state(&BundleState {
            schema: 1,
            active: Some(SkillBundleRef {
                bundle_id: "old".to_string(),
                revision: 1,
                display_version: "r1".to_string(),
                commit: None,
                source: REMOTE_SOURCE.to_string(),
                env_hash: String::new(),
                applied_at: "t".to_string(),
            }),
            previous: None,
        })
        .unwrap();
        write_journal(&SwapJournal {
            schema: 1,
            new_bundle_id: "new".to_string(),
            backup_dir: host_fs::display_path(&backup),
            started_at: "t".to_string(),
        })
        .unwrap();

        recover_interrupted_swap(&builtin).unwrap();

        assert!(builtin.join("marker.txt").is_file(), "backup restored");
        assert!(!builtin.join("partial.txt").exists(), "partial dropped");
        assert!(!backup.exists());
        assert!(read_journal().unwrap().is_none());
    }

    #[test]
    fn journal_recovery_sweeps_backup_for_completed_swap() {
        let _home = crate::skill_host::fs::test_home_for_bundle_tests();
        let skills_root = host_fs::skills_root().unwrap();
        let builtin = skills_root.join("_builtin");
        let backup = skills_root.join("_cache").join("backup-test");
        fs::create_dir_all(&backup).unwrap();
        fs::create_dir_all(&builtin).unwrap();
        fs::write(builtin.join("current.txt"), b"new").unwrap();
        // State already records the NEW bundle: only cleanup remained.
        write_state(&BundleState {
            schema: 1,
            active: Some(SkillBundleRef {
                bundle_id: "new".to_string(),
                revision: 2,
                display_version: "r2".to_string(),
                commit: None,
                source: REMOTE_SOURCE.to_string(),
                env_hash: String::new(),
                applied_at: "t".to_string(),
            }),
            previous: None,
        })
        .unwrap();
        write_journal(&SwapJournal {
            schema: 1,
            new_bundle_id: "new".to_string(),
            backup_dir: host_fs::display_path(&backup),
            started_at: "t".to_string(),
        })
        .unwrap();

        recover_interrupted_swap(&builtin).unwrap();

        assert!(builtin.join("current.txt").is_file(), "builtin untouched");
        assert!(!backup.exists(), "backup swept");
        assert!(read_journal().unwrap().is_none());
    }

    #[test]
    fn parse_semver_and_compare() {
        assert_eq!(parse_semver("0.4.6"), Some((0, 4, 6)));
        assert_eq!(parse_semver("10.0.1"), Some((10, 0, 1)));
        assert_eq!(parse_semver("junk"), None);
        assert_eq!(parse_semver("1.2"), None);
        assert!((0, 4, 6) > (0, 4, 5));
        assert!((0, 10, 0) > (0, 4, 6));
    }

    #[test]
    fn app_version_gate_refuses_unparseable() {
        assert!(!app_version_satisfies("not-a-version"));
        assert!(app_version_satisfies("0.0.1"));
        assert!(!app_version_satisfies("999.0.0"));
    }

    #[test]
    fn asset_revision_parses_channel_names() {
        assert_eq!(asset_revision("maru-skills-r42-abc1234.json"), Some(42));
        assert_eq!(asset_revision("maru-skills-r42-abc1234.zip"), None);
        assert_eq!(asset_revision("maru-skills-r42-XYZ.json"), None);
        assert_eq!(asset_revision("other.json"), None);
        assert_eq!(
            asset_revision("maru-skills-r170000000-9e9b165.json"),
            Some(170000000)
        );
    }

    #[test]
    fn bundle_rel_path_validation() {
        assert!(validate_bundle_rel_path("skills/gaejosik/SKILL.md").is_ok());
        assert!(validate_bundle_rel_path("manifest.json").is_ok());
        assert!(validate_bundle_rel_path("../evil").is_err());
        assert!(validate_bundle_rel_path("skills/../../evil").is_err());
        assert!(validate_bundle_rel_path("/abs/path").is_err());
        assert!(validate_bundle_rel_path("a\\b").is_err());
        assert!(validate_bundle_rel_path("").is_err());
        assert!(validate_bundle_rel_path("a//b").is_err());
    }

    #[test]
    fn hash_from_file_hashes_is_order_independent() {
        let a = hash_from_file_hashes(vec![
            ("envs/a".to_string(), "1111".to_string()),
            ("envs/b".to_string(), "2222".to_string()),
        ]);
        let b = hash_from_file_hashes(vec![
            ("envs/b".to_string(), "2222".to_string()),
            ("envs/a".to_string(), "1111".to_string()),
        ]);
        assert_eq!(a, b);
        assert_ne!(a, hash_from_file_hashes(Vec::new()));
    }

    #[test]
    fn bundle_state_roundtrip() {
        let state = BundleState {
            schema: 1,
            active: Some(SkillBundleRef {
                bundle_id: "r42-abc1234".to_string(),
                revision: 42,
                display_version: "r42".to_string(),
                commit: Some("abc1234".to_string()),
                source: REMOTE_SOURCE.to_string(),
                env_hash: "deadbeef".to_string(),
                applied_at: "2026-07-13T00:00:00Z".to_string(),
            }),
            previous: None,
        };
        let json = serde_json::to_string(&state).unwrap();
        assert!(json.contains("\"bundleId\":\"r42-abc1234\""));
        let back: BundleState = serde_json::from_str(&json).unwrap();
        assert_eq!(back.active, state.active);
    }

    #[test]
    fn metadata_validation_rejects_bad_entries() {
        let mut metadata = BundleMetadata {
            schema: 1,
            revision: 1,
            display_version: "r1".to_string(),
            commit: None,
            published_at: None,
            min_app_version: "0.4.6".to_string(),
            env_hash: String::new(),
            archive: BundleArchiveInfo {
                name: "maru-skills-r1-abc1234.zip".to_string(),
                sha256: "00".to_string(),
                size: 10,
            },
            files: vec![BundleFileEntry {
                path: "skills/x/SKILL.md".to_string(),
                sha256: "00".to_string(),
                mode: "644".to_string(),
            }],
        };
        assert!(validate_metadata_paths(&metadata).is_ok());
        metadata.files.push(BundleFileEntry {
            path: "skills/x/SKILL.md".to_string(),
            sha256: "00".to_string(),
            mode: "644".to_string(),
        });
        assert!(validate_metadata_paths(&metadata)
            .unwrap_err()
            .contains("duplicate"));
        metadata.files[1].path = "../evil".to_string();
        assert!(validate_metadata_paths(&metadata)
            .unwrap_err()
            .contains("bundle_path_invalid"));
        metadata.files[1].path = "ok/file".to_string();
        metadata.files[1].mode = "777".to_string();
        assert!(validate_metadata_paths(&metadata)
            .unwrap_err()
            .contains("mode_invalid"));
    }
}
