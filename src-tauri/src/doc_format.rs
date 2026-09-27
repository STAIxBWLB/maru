//! Bounded document format sniffing: a fixed header read plus, for ZIP
//! containers, at most `FORMAT_ZIP_ENTRY_LIMIT` entry names. Classification
//! only; structural truth comes from `artifact_checks`.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read;
use std::path::Path;
use zip::ZipArchive;

const FORMAT_HEADER_BYTES: u64 = 8 * 1024;
const FORMAT_ZIP_ENTRY_LIMIT: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DocumentFormat {
    Hwpx,
    Docx,
    Xlsx,
    Pdf,
    Hwp,
    Hwp3,
    Hwpml,
    Unknown,
}

pub fn detect_document_format(path: &Path) -> Result<DocumentFormat, String> {
    let mut file = fs::File::open(path).map_err(|err| format!("Cannot open target: {err}"))?;
    let mut header = Vec::with_capacity(FORMAT_HEADER_BYTES as usize);
    file.by_ref()
        .take(FORMAT_HEADER_BYTES)
        .read_to_end(&mut header)
        .map_err(|err| format!("Cannot read target header: {err}"))?;

    if header.starts_with(b"HWP Document File V3.00") {
        return Ok(DocumentFormat::Hwp3);
    }
    if header.starts_with(b"%PDF") {
        return Ok(DocumentFormat::Pdf);
    }
    if header.starts_with(&[0xd0, 0xcf, 0x11, 0xe0]) {
        return Ok(DocumentFormat::Hwp);
    }
    if is_hwpml_header(&header) {
        return Ok(DocumentFormat::Hwpml);
    }
    if is_zip_header(&header) {
        return Ok(detect_zip_format(path));
    }
    Ok(DocumentFormat::Unknown)
}

fn is_zip_header(bytes: &[u8]) -> bool {
    bytes.starts_with(b"PK\x03\x04")
        || bytes.starts_with(b"PK\x05\x06")
        || bytes.starts_with(b"PK\x07\x08")
}

fn is_hwpml_header(bytes: &[u8]) -> bool {
    let head_len = bytes.len().min(512);
    let head = String::from_utf8_lossy(&bytes[..head_len]);
    head.trim_start_matches('\u{feff}')
        .trim_start()
        .starts_with("<?xml")
        && head.contains("<HWPML")
}

fn detect_zip_format(path: &Path) -> DocumentFormat {
    let Ok(file) = fs::File::open(path) else {
        return DocumentFormat::Unknown;
    };
    let Ok(mut archive) = ZipArchive::new(file) else {
        return DocumentFormat::Unknown;
    };
    let mut has_xlsx = false;
    let mut has_docx = false;
    let mut has_hwpx = false;
    for index in 0..archive.len().min(FORMAT_ZIP_ENTRY_LIMIT) {
        let Ok(file) = archive.by_index(index) else {
            continue;
        };
        let name = file.name().to_ascii_lowercase();
        match name.as_str() {
            "xl/workbook.xml" => has_xlsx = true,
            "word/document.xml" => has_docx = true,
            "contents/content.hpf" | "mimetype" => has_hwpx = true,
            _ if name.starts_with("contents/section") => has_hwpx = true,
            _ => {}
        }
    }
    if has_xlsx {
        DocumentFormat::Xlsx
    } else if has_docx {
        DocumentFormat::Docx
    } else if has_hwpx {
        DocumentFormat::Hwpx
    } else {
        DocumentFormat::Unknown
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let mut zip = zip::ZipWriter::new(fs::File::create(path).unwrap());
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for (name, bytes) in entries {
            zip.start_file(*name, options).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
    }

    fn detect_bytes(bytes: &[u8]) -> DocumentFormat {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        fs::write(tmp.path(), bytes).unwrap();
        detect_document_format(tmp.path()).unwrap()
    }

    #[test]
    fn detects_zip_subformats_within_the_entry_limit() {
        let tmp = tempfile::tempdir().unwrap();
        let cases: [(&str, &[(&str, &[u8])], DocumentFormat); 4] = [
            (
                "a.hwpx",
                &[
                    ("mimetype", b"application/hwp+zip"),
                    ("Contents/section0.xml", b"<hs:sec/>"),
                ],
                DocumentFormat::Hwpx,
            ),
            (
                "a.docx",
                &[("word/document.xml", b"<w:document/>")],
                DocumentFormat::Docx,
            ),
            (
                "a.xlsx",
                &[("xl/workbook.xml", b"<workbook/>")],
                DocumentFormat::Xlsx,
            ),
            ("a.zip", &[("readme.txt", b"x")], DocumentFormat::Unknown),
        ];
        for (name, entries, expected) in cases {
            let path = tmp.path().join(name);
            write_zip(&path, entries);
            assert_eq!(detect_document_format(&path).unwrap(), expected, "{name}");
        }

        // A marker entry past the entry limit is never read.
        let names = (0..FORMAT_ZIP_ENTRY_LIMIT)
            .map(|index| format!("filler/{index}.txt"))
            .collect::<Vec<_>>();
        let mut entries = names
            .iter()
            .map(|name| (name.as_str(), b"x".as_slice()))
            .collect::<Vec<_>>();
        entries.push(("word/document.xml", b"<w:document/>"));
        let late = tmp.path().join("late.docx");
        write_zip(&late, &entries);
        assert_eq!(
            detect_document_format(&late).unwrap(),
            DocumentFormat::Unknown
        );
    }

    #[test]
    fn detects_pdf_ole2_hwp3_hwpml_and_short_input() {
        assert_eq!(detect_bytes(b"%PDF-1.4\n%abc\n%%EOF"), DocumentFormat::Pdf);
        assert_eq!(
            detect_bytes(&[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
            DocumentFormat::Hwp
        );
        assert_eq!(
            detect_bytes(b"HWP Document File V3.00 \x1a\x01\x02"),
            DocumentFormat::Hwp3
        );
        assert_eq!(
            detect_bytes("\u{feff}<?xml version=\"1.0\"?><HWPML Version=\"2.8\">".as_bytes()),
            DocumentFormat::Hwpml
        );
        assert_eq!(detect_bytes(b""), DocumentFormat::Unknown);
        assert_eq!(detect_bytes(b"abc"), DocumentFormat::Unknown);
        assert_eq!(detect_bytes(b"PK\x03\x04"), DocumentFormat::Unknown);
        assert_eq!(detect_bytes(b"random!!"), DocumentFormat::Unknown);
    }
}
