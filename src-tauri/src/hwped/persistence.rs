//! Workspace-owned HWPX persistence. Binary bytes never enter frontmatter APIs.
use super::*;
use crate::atomic_file::{write_atomic_checked, PathTransactionParent, PathTransactionRequest};
use crate::ipc_error::{IpcError, DOCUMENT_CONFLICT};
use crate::vault::resolve_inside_vault;
use crate::vault_list::{assert_document_owner, assert_maru_can_write, WorkspaceWriteAction};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};

const MAX_BYTES: usize = 33_554_432;
const MAX_BASE64: usize = 44_739_244;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HwpedSaveResponse {
    pub revision: String,
    pub size_bytes: u64,
    pub snapshot_path: String,
}

fn failure(cause: impl std::fmt::Display) -> String {
    format!("HWPX save refused: {cause}; keep your edits, check the workspace and HWP engine, then retry saving.")
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn conflict() -> IpcError {
    IpcError {
        code: DOCUMENT_CONFLICT.to_string(),
        message: "The file changed on disk or disappeared. Keep editing, or reload the disk version and discard these edits.".to_string(),
    }
}

fn decode_candidate(data: &str) -> Result<Vec<u8>, String> {
    if data.is_empty() || data.len() > MAX_BASE64 || !data.is_ascii() {
        return Err(failure(
            "candidate base64 is empty, non-ASCII or exceeds 32 MiB decoded",
        ));
    }
    let bytes = BASE64
        .decode(data)
        .map_err(|_| failure("candidate base64 is malformed"))?;
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err(failure("candidate bytes are empty or exceed 32 MiB"));
    }
    Ok(bytes)
}

/// A metadata check alone cannot bound a file that grows while it is read.
fn bounded_source(path: &Path) -> Result<Vec<u8>, IpcError> {
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => (),
        Ok(_) => return Err(failure("the selected source is not a regular file").into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Err(conflict()),
        Err(_) => return Err(failure("cannot inspect the source file").into()),
    }
    let file = fs::File::open(path).map_err(|err| {
        if err.kind() == std::io::ErrorKind::NotFound {
            conflict()
        } else {
            failure("cannot read the current source file").into()
        }
    })?;
    if !file
        .metadata()
        .map_err(|_| failure("cannot inspect the source file"))?
        .is_file()
    {
        return Err(failure("the selected source is not a regular file").into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| failure("source read failed"))?;
    if bytes.len() > MAX_BYTES {
        return Err(failure("source bytes exceed 32 MiB").into());
    }
    Ok(bytes)
}

fn target(root: &str, document_path: &str) -> Result<(PathBuf, PathBuf, String), String> {
    let vault = resolve_inside_vault(root, ".").map_err(failure)?;
    let path = resolve_inside_vault(root, document_path).map_err(failure)?;
    if path
        .extension()
        .and_then(|s| s.to_str())
        .is_none_or(|s| !s.eq_ignore_ascii_case("hwpx"))
    {
        return Err(failure("only an existing .hwpx can be saved"));
    }
    let relative = path
        .strip_prefix(&vault)
        .map_err(|_| failure("source escapes the workspace"))?
        .to_string_lossy()
        .replace('\\', "/");
    authorize(root, &path)?;
    Ok((vault, path, relative))
}

fn authorize(root: &str, path: &Path) -> Result<(), String> {
    assert_document_owner(root, path).map_err(failure)?;
    assert_maru_can_write(root, WorkspaceWriteAction::Modify).map_err(failure)
}

/// The existing envelope parser reads only this immutable private copy. Neither
/// the engine nor the revision calculation opens the mutable workspace source.
pub(super) fn capture_now(
    document: HwpedDocumentRef,
    root: Option<String>,
) -> Result<Value, String> {
    let root = root
        .filter(|root| !root.trim().is_empty())
        .ok_or_else(|| failure("source capture requires workspaceRoot"))?;
    let selected = document
        .path
        .ok_or_else(|| failure("source capture requires the selected workspace path"))?;
    let (vault, path, _) = target(&root, &selected)?;
    let lease = PathTransactionRequest::new([path.clone()])?
        .with_workspace_registry()?
        .require_parent(&vault)?
        .acquire()?;
    lease.ensure_workspace_registry()?;
    authorize(&root, &path)?;
    let bytes = bounded_source(&path).map_err(|error| error.to_string())?;
    if bytes.is_empty() {
        return Err(failure("the captured source is empty"));
    }
    let revision = digest(&bytes);
    let tmp = tempfile::tempdir().map_err(|_| failure("cannot create private capture staging"))?;
    let staged = tmp.path().join("source.hwpx");
    fs::write(&staged, &bytes).map_err(|_| failure("cannot stage the captured source"))?;
    #[cfg(test)]
    PathTransactionLease::test_stage(&[vault], "hwped:capture-staged");
    let mut envelope = read_now(
        HwpedDocumentRef {
            name: "source.hwpx".to_string(),
            path: Some(staged.to_string_lossy().into_owned()),
            data_base64: None,
        },
        None,
    )
    .map_err(|_| failure("the engine could not read the captured HWPX"))?;
    if !is_read_envelope(&envelope) {
        return Err(failure(
            "the engine returned a malformed captured read envelope",
        ));
    }
    let object = envelope
        .as_object_mut()
        .ok_or_else(|| failure("the engine returned a malformed read envelope"))?;
    object.insert(
        "source".to_string(),
        serde_json::json!({"dataBase64": BASE64.encode(&bytes), "revision": revision}),
    );
    Ok(envelope)
}

fn validate_candidate(bin: &Path, version: &str, staged: &Path) -> Result<(), String> {
    let run = run_hwp(
        bin,
        &[
            OsString::from("validate"),
            staged.as_os_str().to_owned(),
            OsString::from("--json"),
        ],
    )
    .map_err(|_| failure("engine validation failed or timed out"))?;
    let report: crate::hwp_cli_template::ValidateReport = serde_json::from_slice(&run.stdout)
        .map_err(|_| failure("the engine returned a malformed validation report"))?;
    if run.code != 0 || !report.valid || report.format != "hwpx" || !report.errors.is_empty() {
        return Err(failure("the candidate is not a valid HWPX document"));
    }
    let envelope = read_staged(bin, version, staged)
        .map_err(|_| failure("the engine could not re-read the validated candidate"))?;
    if !is_read_envelope(&envelope) {
        return Err(failure(
            "the engine returned a malformed candidate read envelope",
        ));
    }
    Ok(())
}

fn is_read_envelope(envelope: &Value) -> bool {
    envelope.get("markdown").is_some_and(Value::is_string)
        && envelope.get("segments").is_some_and(Value::is_array)
}

fn check_revision(path: &Path, expected: &str) -> Result<Vec<u8>, IpcError> {
    if !path.is_file() {
        return Err(conflict());
    }
    let bytes = bounded_source(path)?;
    if digest(&bytes) != expected {
        return Err(conflict());
    }
    Ok(bytes)
}

pub(super) fn save_now(
    root: String,
    selected: String,
    data: String,
    expected: String,
) -> Result<HwpedSaveResponse, IpcError> {
    save_with_engine(root, selected, data, expected, hwp_bin)
}

fn save_with_engine(
    root: String,
    selected: String,
    data: String,
    expected: String,
    engine: impl FnOnce() -> Result<PathBuf, String>,
) -> Result<HwpedSaveResponse, IpcError> {
    if expected.len() != 64
        || !expected
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err(
            failure("expectedRevision must be the lowercase SHA-256 of the opened bytes").into(),
        );
    }
    let candidate = decode_candidate(&data)?;
    let revision = digest(&candidate);
    let (vault, path, relative) = target(&root, &selected)?;
    let versions = vault.join(".maru/versions");
    let lease = PathTransactionRequest::new([path.clone(), versions.clone()])?
        .with_workspace_registry()?
        .require_parent(&vault)?
        .acquire()
        .map_err(|error| match check_revision(&path, &expected) {
            Err(conflict) if conflict.code == DOCUMENT_CONFLICT => conflict,
            _ => error.into(),
        })?;
    lease.ensure_workspace_registry()?;
    lease.ensure_covered([path.clone(), versions.clone()])?;
    authorize(&root, &path)?;
    crate::vault_guard::validate_managed_write(&root, &relative, "").map_err(failure)?;
    stage(&vault, "source-read")?;
    let original = check_revision(&path, &expected)?;
    // Resolve only for replacement semantics, never for lexical authorization.
    // Replacing the physical target keeps a deliberate workspace symlink intact.
    let physical = path.canonicalize().map_err(|_| conflict())?;
    let tmp =
        tempfile::tempdir().map_err(|_| failure("cannot create private candidate staging"))?;
    stage(&vault, "candidate-stage")?;
    let staged = tmp.path().join("candidate.hwpx");
    fs::write(&staged, &candidate).map_err(|_| failure("cannot stage candidate bytes"))?;
    let bin = engine().map_err(failure)?;
    let version = ensure_version(&bin).map_err(failure)?;
    validate_candidate(&bin, &version, &staged)?;
    if digest(
        &bounded_source(&staged)
            .map_err(|_| failure("candidate staging changed during engine validation"))?,
    ) != revision
    {
        return Err(failure("the engine changed candidate bytes during validation").into());
    }
    stage(&vault, "validated")?;
    // Refuse changes during engine work before producing any recovery snapshot.
    check_revision(&path, &expected)?;
    lease.before_effect()?;
    authorize(&root, &path)?;
    stage(&vault, "snapshot-directory")?;
    fs::create_dir_all(&versions)
        .map_err(|_| failure("cannot create the recovery snapshot directory"))?;
    let snapshot_parent = PathTransactionParent::capture(&versions)?;
    let snapshot = versions.join(format!(
        "{}-{}.hwpx",
        chrono::Utc::now().format("%Y%m%dT%H%M%S%.9fZ"),
        uuid::Uuid::new_v4()
    ));
    lease.ensure_covered([snapshot.clone()])?;
    stage(&vault, "snapshot-create")?;
    let mut snapshot_temp = tempfile::Builder::new()
        .prefix(".hwpx-snapshot-")
        .tempfile_in(&versions)
        .map_err(|_| failure("cannot create the private recovery snapshot"))?;
    // NamedTempFile starts private (0600 on Unix). No binary transformation.
    stage(&vault, "snapshot-write")?;
    snapshot_temp
        .write_all(&original)
        .map_err(|_| failure("cannot write the recovery snapshot"))?;
    stage(&vault, "snapshot-sync")?;
    snapshot_temp
        .as_file()
        .sync_all()
        .map_err(|_| failure("cannot sync the recovery snapshot"))?;
    stage(&vault, "snapshot-publish")?;
    snapshot_parent.revalidate()?;
    snapshot_temp
        .persist_noclobber(&snapshot)
        .map_err(|_| failure("cannot publish the recovery snapshot"))?;
    stage(&vault, "snapshot-complete")?;
    // All fallible return metadata is prepared before commit.
    let snapshot_path = snapshot
        .strip_prefix(&vault)
        .map_err(|_| failure("snapshot path is outside workspace"))?
        .to_string_lossy()
        .replace('\\', "/");
    stage(&vault, "replacement-stage")?;
    write_atomic_checked(&physical, &candidate, 0o600, || {
        stage(&vault, "before-replace")?;
        // Missing selected aliases are document conflicts, even when their
        // removal also changes the physical admission key.
        check_revision(&path, &expected)?;
        lease.revalidate_paths()?;
        snapshot_parent.revalidate()?;
        let recovery = bounded_source(&snapshot).map_err(|_| {
            failure("the recovery snapshot changed or disappeared before replacement")
        })?;
        if digest(&recovery) != expected {
            return Err(failure("the recovery snapshot changed before replacement").into());
        }
        lease.before_effect()?;
        authorize(&root, &path)?;
        check_revision(&path, &expected)?;
        Ok::<(), IpcError>(())
    })
    .map_err(|error: IpcError| {
        if error.code == DOCUMENT_CONFLICT {
            error
        } else {
            failure(error.message).into()
        }
    })?;
    Ok(HwpedSaveResponse {
        revision,
        size_bytes: candidate.len() as u64,
        snapshot_path,
    })
}

fn stage(root: &Path, label: &str) -> Result<(), String> {
    #[cfg(test)]
    {
        PathTransactionLease::test_stage(&[root.to_path_buf()], &format!("hwped:{label}"));
        if TEST_FAILURES
            .lock()
            .unwrap()
            .iter()
            .any(|(key, value)| key == root && value == label)
        {
            return Err(failure(format!("injected {label} failure")));
        }
    }
    let _ = (root, label);
    Ok(())
}

#[cfg(test)]
static TEST_FAILURES: Mutex<Vec<(PathBuf, String)>> = Mutex::new(Vec::new());

#[cfg(test)]
pub(super) mod tests;
