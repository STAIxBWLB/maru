//! Structure checks for exported and evidence artifacts. HWPX goes through
//! the released `hwp` (`hwp validate --json`, `hwp info --json`); DOCX and
//! PDF are checked locally. The check names reach persisted JSON (Studio
//! state, evidence candidates, export validation reports), so they are stable.

use crate::hwp_cli_template;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use zip::ZipArchive;

const HWPX_MIMETYPE: &str = "application/hwp+zip";
const PDF_TAIL_BYTES: u64 = 2048;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactCheck {
    pub name: String,
    pub status: String,
    #[serde(default)]
    pub reason: Option<String>,
}

impl ArtifactCheck {
    pub(crate) fn pass(name: &str) -> Self {
        Self::with(name, "pass", None)
    }

    fn fail(name: &str, reason: impl Into<String>) -> Self {
        Self::with(name, "fail", Some(reason.into()))
    }

    fn with(name: &str, status: &str, reason: Option<String>) -> Self {
        Self {
            name: name.to_string(),
            status: status.to_string(),
            reason,
        }
    }
}

pub fn validate_export_artifact(path: &Path, extension: &str) -> Vec<ArtifactCheck> {
    validate_artifact(path, extension).0
}

/// The checks, and whether they are settled. A result is unsettled when
/// `hwp` was unavailable or a call to it failed (spawn, timeout, an
/// unreadable report); a caller that caches checks must not keep it.
pub(crate) fn validate_artifact(path: &Path, extension: &str) -> (Vec<ArtifactCheck>, bool) {
    match extension {
        "hwpx" => hwpx_checks(hwp_cli_template::hwp_bin().as_deref(), path),
        "docx" => (
            vec![zip_member_check(
                path,
                "word/document.xml",
                "docx-structure",
            )],
            true,
        ),
        "pdf" => (vec![pdf_check(path)], true),
        _ => (
            vec![ArtifactCheck::with(
                "format-structure",
                "skipped",
                Some("no structure check for this format".to_string()),
            )],
            true,
        ),
    }
}

/// HWPX through `hwp`: `valid` on an HWPX package gives `zip-safety` (hwp
/// enforces its package limits before parsing) and `hwpx-sections` from
/// `hwp info`; `valid: false`, or another format (an HWP5 file named .hwpx),
/// gives `hwpx-structure` with the reason. Without a released `hwp`,
/// `hwpx-structure` is the reduced offline check, never skipped. The bool is
/// whether the result is settled (see [`validate_artifact`]).
pub(crate) fn hwpx_checks(hwp: Result<&Path, &String>, path: &Path) -> (Vec<ArtifactCheck>, bool) {
    let bin = match hwp {
        Ok(bin) => bin,
        Err(why) => return (vec![reduced_hwpx_check(path, why)], false),
    };
    let report = match hwp_cli_template::validate_report(bin, path) {
        Ok(report) => report,
        Err(err) => return (vec![ArtifactCheck::fail("hwpx-structure", err)], false),
    };
    if !report.valid {
        let reason = report
            .errors
            .into_iter()
            .next()
            .unwrap_or_else(|| "hwp validate reported an invalid package".to_string());
        return (vec![ArtifactCheck::fail("hwpx-structure", reason)], true);
    }
    if report.format != "hwpx" {
        let reason = format!("hwp validate read the file as {}, not HWPX", report.format);
        return (vec![ArtifactCheck::fail("hwpx-structure", reason)], true);
    }
    let (sections, settled) = match hwp_cli_template::info_sections(bin, path) {
        Ok(sections) if sections >= 1 => (ArtifactCheck::pass("hwpx-sections"), true),
        Ok(_) => (
            ArtifactCheck::fail("hwpx-sections", "HWPX section XML not found"),
            true,
        ),
        Err(err) => (ArtifactCheck::fail("hwpx-sections", err), false),
    };
    (vec![ArtifactCheck::pass("zip-safety"), sections], settled)
}

/// Offline `hwpx-structure` when `hwp` is unavailable: the file opens as a
/// ZIP, its `mimetype` entry is `application/hwp+zip`, and at least one
/// `Contents/section*.xml` entry exists.
fn reduced_hwpx_check(path: &Path, why: &str) -> ArtifactCheck {
    let context = format!("reduced offline check (hwp unavailable: {why})");
    match reduced_hwpx_failure(path) {
        None => ArtifactCheck::with("hwpx-structure", "pass", Some(context)),
        Some(detail) => ArtifactCheck::fail("hwpx-structure", format!("{context}: {detail}")),
    }
}

fn reduced_hwpx_failure(path: &Path) -> Option<String> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(err) => return Some(format!("cannot read HWPX: {err}")),
    };
    let mut archive = match ZipArchive::new(file) {
        Ok(archive) => archive,
        Err(err) => return Some(format!("not a ZIP package: {err}")),
    };
    let mut mimetype = String::new();
    let mimetype_read = archive.by_name("mimetype").map(|entry| {
        entry
            .take(HWPX_MIMETYPE.len() as u64 + 1)
            .read_to_string(&mut mimetype)
    });
    if !matches!(mimetype_read, Ok(Ok(_))) {
        return Some("missing mimetype entry".to_string());
    }
    if mimetype != HWPX_MIMETYPE {
        return Some(format!("mimetype is not {HWPX_MIMETYPE}"));
    }
    let has_section = archive
        .file_names()
        .any(|name| name.starts_with("Contents/section") && name.ends_with(".xml"));
    (!has_section).then(|| "no Contents/section*.xml entry".to_string())
}

fn pdf_check(path: &Path) -> ArtifactCheck {
    let Ok(mut file) = File::open(path) else {
        return ArtifactCheck::fail("pdf-structure", "cannot read PDF");
    };
    let mut header = [0u8; 4];
    if file.read_exact(&mut header).is_err() || &header != b"%PDF" {
        return ArtifactCheck::fail("pdf-structure", "missing %PDF header");
    }
    let mut tail = Vec::new();
    let tail_read = file
        .seek(SeekFrom::End(0))
        .and_then(|len| file.seek(SeekFrom::Start(len.saturating_sub(PDF_TAIL_BYTES))))
        .and_then(|_| file.read_to_end(&mut tail));
    if tail_read.is_err() || !tail.windows(5).any(|chunk| chunk == b"%%EOF") {
        return ArtifactCheck::fail("pdf-structure", "missing %%EOF marker near file end");
    }
    ArtifactCheck::pass("pdf-structure")
}

fn zip_member_check(path: &Path, member: &str, check_name: &str) -> ArtifactCheck {
    let Ok(file) = File::open(path) else {
        return ArtifactCheck::fail(check_name, "cannot read ZIP file");
    };
    let Ok(mut archive) = ZipArchive::new(file) else {
        return ArtifactCheck::fail(check_name, "invalid ZIP file");
    };
    if archive.by_name(member).is_ok() {
        ArtifactCheck::pass(check_name)
    } else {
        ArtifactCheck::fail(check_name, format!("missing {member}"))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;

    pub(crate) fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let mut zip = zip::ZipWriter::new(File::create(path).unwrap());
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for (name, bytes) in entries {
            zip.start_file(*name, options).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
    }

    /// Stub released hwp: `validate` prints `validate_json` and exits with
    /// `validate_exit` (hwp exits 1 on an invalid package); `info` reports
    /// `sections`; `slots` prints the sibling `hwp.slots` file when present.
    #[cfg(unix)]
    pub(crate) fn stub_hwp(
        dir: &Path,
        validate_json: &str,
        validate_exit: i32,
        sections: u32,
    ) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let binary = dir.join("hwp");
        let script = format!(
            r#"#!/bin/sh
case "$1" in
  --version) echo "hwp 1.3.0" ;;
  validate) printf '%s\n' '{validate_json}'; exit {validate_exit} ;;
  info) printf '%s\n' '{{"format":"hwpx","sections":{sections}}}' ;;
  slots) cat "$0.slots" || exit 2 ;;
  *) exit 2 ;;
esac
"#
        );
        std::fs::write(&binary, script).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        binary
    }

    fn statuses(checks: &[ArtifactCheck]) -> Vec<(String, String)> {
        checks
            .iter()
            .map(|check| (check.name.clone(), check.status.clone()))
            .collect()
    }

    #[test]
    fn pdf_requires_header_and_eof_marker() {
        let tmp = tempfile::tempdir().unwrap();
        let good = tmp.path().join("good.pdf");
        std::fs::write(&good, b"%PDF-1.4\n%binary stuff\n%%EOF\n").unwrap();
        assert_eq!(pdf_check(&good).status, "pass");

        let long = tmp.path().join("long.pdf");
        let mut bytes = b"%PDF-1.7\n".to_vec();
        bytes.extend(vec![b'x'; 10_000]);
        bytes.extend(b"\n%%EOF\n");
        std::fs::write(&long, bytes).unwrap();
        assert_eq!(pdf_check(&long).status, "pass");

        let missing_header = tmp.path().join("noheader.pdf");
        std::fs::write(&missing_header, b"not a pdf\n%%EOF").unwrap();
        assert_eq!(
            pdf_check(&missing_header).reason.as_deref(),
            Some("missing %PDF header")
        );

        let missing_eof = tmp.path().join("noeof.pdf");
        std::fs::write(&missing_eof, b"%PDF-1.4\nbody without trailer").unwrap();
        assert_eq!(
            pdf_check(&missing_eof).reason.as_deref(),
            Some("missing %%EOF marker near file end")
        );
    }

    #[test]
    fn docx_structure_requires_the_word_document_member() {
        let tmp = tempfile::tempdir().unwrap();
        let docx = tmp.path().join("doc.docx");
        write_zip(&docx, &[("word/document.xml", b"<w:document/>")]);
        assert_eq!(
            statuses(&validate_export_artifact(&docx, "docx")),
            [("docx-structure".to_string(), "pass".to_string())]
        );
        let not_docx = tmp.path().join("other.docx");
        write_zip(&not_docx, &[("mimetype", b"application/hwp+zip")]);
        let check = zip_member_check(&not_docx, "word/document.xml", "docx-structure");
        assert_eq!(check.status, "fail");
        assert_eq!(check.reason.as_deref(), Some("missing word/document.xml"));
    }

    const VALID_HWPX: &str = r#"{"valid":true,"format":"hwpx","errors":[]}"#;

    #[cfg(unix)]
    #[test]
    fn router_sends_hwpx_to_hwp_and_skips_unknown_formats() {
        let tmp = tempfile::tempdir().unwrap();
        let hwpx = tmp.path().join("doc.hwpx");
        std::fs::write(&hwpx, b"stub reads nothing").unwrap();
        let valid = stub_hwp(tmp.path(), VALID_HWPX, 0, 1);
        let (checks, settled) = hwpx_checks(Ok(&valid), &hwpx);
        assert_eq!(
            statuses(&checks),
            [
                ("zip-safety".to_string(), "pass".to_string()),
                ("hwpx-sections".to_string(), "pass".to_string())
            ]
        );
        assert!(settled);
        let no_sections = stub_hwp(tmp.path(), VALID_HWPX, 0, 0);
        let (checks, settled) = hwpx_checks(Ok(&no_sections), &hwpx);
        assert_eq!(
            statuses(&checks)[1],
            ("hwpx-sections".to_string(), "fail".to_string())
        );
        assert!(settled);

        let unknown = validate_export_artifact(&hwpx, "xyz");
        assert_eq!(
            statuses(&unknown),
            [("format-structure".to_string(), "skipped".to_string())]
        );
        assert_eq!(
            unknown[0].reason.as_deref(),
            Some("no structure check for this format")
        );
    }

    #[cfg(unix)]
    #[test]
    fn invalid_hwp_report_on_exit_1_fails_hwpx_structure() {
        let tmp = tempfile::tempdir().unwrap();
        let hwpx = tmp.path().join("bad.hwpx");
        std::fs::write(&hwpx, b"not a real hwpx").unwrap();
        let invalid = stub_hwp(
            tmp.path(),
            r#"{"errors":["포맷 감지 실패: 시그니처 불일치","second"],"format":"unknown","valid":false,"warnings":[]}"#,
            1,
            0,
        );
        let (checks, settled) = hwpx_checks(Ok(&invalid), &hwpx);
        assert_eq!(
            statuses(&checks),
            [("hwpx-structure".to_string(), "fail".to_string())]
        );
        assert_eq!(
            checks[0].reason.as_deref(),
            Some("포맷 감지 실패: 시그니처 불일치")
        );
        assert!(settled, "an invalid-package verdict is hwp's answer");

        // An unreadable report is not a verdict.
        let garbage = stub_hwp(tmp.path(), "not json", 1, 0);
        let (checks, settled) = hwpx_checks(Ok(&garbage), &hwpx);
        assert_eq!(checks[0].status, "fail");
        assert!(checks[0]
            .reason
            .as_deref()
            .unwrap()
            .starts_with("hwp_validate_invalid_json"));
        assert!(!settled);
    }

    /// hwp validates an HWP5 (CFB) file as valid too, so a `.hwpx` that is
    /// really HWP5 must not pass as an HWPX package.
    #[cfg(unix)]
    #[test]
    fn hwp5_file_named_hwpx_fails_hwpx_structure() {
        let tmp = tempfile::tempdir().unwrap();
        let hwpx = tmp.path().join("really-hwp5.hwpx");
        std::fs::write(&hwpx, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).unwrap();
        let hwp5 = stub_hwp(
            tmp.path(),
            r#"{"errors":[],"format":"hwp5","valid":true,"warnings":[]}"#,
            0,
            1,
        );
        let (checks, settled) = hwpx_checks(Ok(&hwp5), &hwpx);
        assert_eq!(
            statuses(&checks),
            [("hwpx-structure".to_string(), "fail".to_string())]
        );
        assert_eq!(
            checks[0].reason.as_deref(),
            Some("hwp validate read the file as hwp5, not HWPX")
        );
        assert!(settled);
    }

    #[test]
    fn reduced_offline_check_is_never_settled() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("ok.hwpx");
        write_zip(
            &path,
            &[
                ("mimetype", b"application/hwp+zip"),
                ("Contents/section0.xml", b"<hs:sec/>"),
            ],
        );
        let why = "hwp_version: hwp 1.2.0 is too old; Maru requires >= 1.3.0".to_string();
        let (checks, settled) = hwpx_checks(Err(&why), &path);
        assert_eq!(checks[0].status, "pass");
        assert!(!settled, "hwp may be installed or upgraded later");
    }
    #[test]
    fn reduced_offline_check_passes_a_package_and_fails_each_defect() {
        let tmp = tempfile::tempdir().unwrap();
        let why = "cli_missing: released hwp >= 1.3.0 binary not found".to_string();
        let check = |name: &str, entries: Option<&[(&str, &[u8])]>| {
            let path = tmp.path().join(name);
            match entries {
                Some(entries) => write_zip(&path, entries),
                None => std::fs::write(&path, b"not a zip").unwrap(),
            }
            let (checks, _) = hwpx_checks(Err(&why), &path);
            assert_eq!(checks.len(), 1, "{name}");
            assert_eq!(checks[0].name, "hwpx-structure", "{name}");
            let reason = checks[0].reason.clone().unwrap();
            assert!(
                reason.starts_with("reduced offline check (hwp unavailable: cli_missing:"),
                "{reason}"
            );
            (checks[0].status.clone(), reason)
        };

        let (status, _) = check(
            "ok.hwpx",
            Some(&[
                ("mimetype", b"application/hwp+zip"),
                ("Contents/section0.xml", b"<hs:sec/>"),
            ]),
        );
        assert_eq!(status, "pass");

        let (status, reason) = check("not-zip.hwpx", None);
        assert_eq!(status, "fail");
        assert!(reason.contains("not a ZIP package"), "{reason}");

        let (status, reason) = check(
            "no-mimetype.hwpx",
            Some(&[("Contents/section0.xml", b"<hs:sec/>")]),
        );
        assert_eq!(status, "fail");
        assert!(reason.ends_with("missing mimetype entry"), "{reason}");

        let (status, reason) = check(
            "wrong-mimetype.hwpx",
            Some(&[
                ("mimetype", b"application/zip"),
                ("Contents/section0.xml", b"<hs:sec/>"),
            ]),
        );
        assert_eq!(status, "fail");
        assert!(
            reason.ends_with("mimetype is not application/hwp+zip"),
            "{reason}"
        );

        let (status, reason) = check(
            "no-section.hwpx",
            Some(&[
                ("mimetype", b"application/hwp+zip"),
                ("Contents/header.xml", b"<hh:head/>"),
            ]),
        );
        assert_eq!(status, "fail");
        assert!(
            reason.ends_with("no Contents/section*.xml entry"),
            "{reason}"
        );
    }
}
