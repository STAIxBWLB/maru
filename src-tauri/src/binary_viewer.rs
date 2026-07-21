use crate::kordoc_lite::{extract_hwpx_text_html, DocumentFormat, HwpxPreview};
use crate::vault::resolve_inside_vault;
use crate::win_process::NoWindow;
use encoding_rs::EUC_KR;
use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::fs;
use std::io::Read;
use std::path::Path;
use std::process::Command;
use tauri::Manager;
use zip::ZipArchive;

const DEFAULT_TEXT_LIMIT_BYTES: u64 = 2 * 1024 * 1024; // 2 MiB
const ARCHIVE_ENTRY_LIMIT: usize = 5000;
const FORMAT_HEADER_BYTES: u64 = 8 * 1024;
const FORMAT_ZIP_ENTRY_LIMIT: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ViewerCategory {
    Image,
    Svg,
    Pdf,
    Docx,
    Xlsx,
    Hwpx,
    Audio,
    Video,
    Text,
    Archive,
    Unsupported,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewerClassification {
    pub category: ViewerCategory,
    pub mime: Option<String>,
    pub extension: Option<String>,
    pub size_bytes: u64,
    pub detected_format: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextPreview {
    pub content: String,
    pub truncated: bool,
    pub encoding: String,
    pub byte_count: u64,
    pub shown_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    pub name: String,
    pub size: u64,
    pub compressed_size: u64,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivePreview {
    pub entries: Vec<ArchiveEntry>,
    pub total_entries: usize,
    pub truncated: bool,
}

#[tauri::command]
pub fn binary_viewer_classify(
    vault_path: String,
    target_path: String,
) -> Result<ViewerClassification, String> {
    let target = resolve_inside_vault(&vault_path, &target_path)?;
    require_existing_file(&target)?;
    let metadata = fs::metadata(&target).map_err(|err| format!("Cannot stat target: {err}"))?;
    let extension = target
        .extension()
        .and_then(OsStr::to_str)
        .map(str::to_ascii_lowercase);
    let mime = mime_guess::from_path(&target)
        .first()
        .map(|m| m.essence_str().to_string());
    let detected_format = match detect_document_format_bounded(&target) {
        Ok(format) => format_label(format).to_string(),
        Err(_) => "unknown".to_string(),
    };
    let category = classify(extension.as_deref(), &detected_format);
    Ok(ViewerClassification {
        category,
        mime,
        extension,
        size_bytes: metadata.len(),
        detected_format,
    })
}

#[tauri::command]
pub fn binary_viewer_prepare_asset(
    app: tauri::AppHandle,
    vault_path: String,
    target_path: String,
) -> Result<String, String> {
    let target = resolve_inside_vault(&vault_path, &target_path)?;
    require_existing_file(&target)?;
    app.asset_protocol_scope()
        .allow_file(&target)
        .map_err(|err| format!("Cannot allow viewer asset: {err}"))?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
pub fn binary_viewer_read_text(
    vault_path: String,
    target_path: String,
    max_bytes: Option<u64>,
) -> Result<TextPreview, String> {
    let target = resolve_inside_vault(&vault_path, &target_path)?;
    require_existing_file(&target)?;
    let limit = max_bytes.unwrap_or(DEFAULT_TEXT_LIMIT_BYTES);
    let metadata = fs::metadata(&target).map_err(|err| format!("Cannot stat target: {err}"))?;
    let total_bytes = metadata.len();
    let truncated = total_bytes > limit;
    let read_limit = if truncated { limit } else { total_bytes };
    let mut file = fs::File::open(&target).map_err(|err| format!("Cannot open target: {err}"))?;
    let mut buf = Vec::with_capacity(read_limit as usize);
    file.by_ref()
        .take(read_limit)
        .read_to_end(&mut buf)
        .map_err(|err| format!("Cannot read target: {err}"))?;
    let (content, encoding) = decode_text(&buf);
    Ok(TextPreview {
        content,
        truncated,
        encoding,
        byte_count: total_bytes,
        shown_bytes: read_limit,
    })
}

#[tauri::command]
pub fn binary_viewer_read_archive(
    vault_path: String,
    target_path: String,
) -> Result<ArchivePreview, String> {
    let target = resolve_inside_vault(&vault_path, &target_path)?;
    require_existing_file(&target)?;
    let file = fs::File::open(&target).map_err(|err| format!("Cannot open target: {err}"))?;
    let mut archive = ZipArchive::new(file).map_err(|err| format!("Invalid ZIP file: {err}"))?;
    let total_entries = archive.len();
    let count = total_entries.min(ARCHIVE_ENTRY_LIMIT);
    let mut entries = Vec::with_capacity(count);
    for index in 0..count {
        let entry = archive
            .by_index(index)
            .map_err(|err| format!("Cannot read ZIP entry {index}: {err}"))?;
        entries.push(ArchiveEntry {
            name: entry.name().to_string(),
            size: entry.size(),
            compressed_size: entry.compressed_size(),
            is_dir: entry.is_dir(),
        });
    }
    Ok(ArchivePreview {
        entries,
        total_entries,
        truncated: total_entries > count,
    })
}

#[tauri::command]
pub fn binary_viewer_extract_hwpx(
    vault_path: String,
    target_path: String,
) -> Result<HwpxPreview, String> {
    let target = resolve_inside_vault(&vault_path, &target_path)?;
    require_existing_file(&target)?;
    extract_hwpx_text_html(&target)
}

#[tauri::command]
pub fn binary_viewer_open_external(vault_path: String, target_path: String) -> Result<(), String> {
    let target = resolve_inside_vault(&vault_path, &target_path)?;
    require_existing_file(&target)?;
    let target_str = target
        .to_str()
        .ok_or_else(|| "Path is not valid UTF-8".to_string())?
        .to_string();
    spawn_external(&target_str)
}

#[tauri::command]
pub fn binary_viewer_preview_external(
    vault_path: String,
    target_path: String,
) -> Result<(), String> {
    let target = resolve_inside_vault(&vault_path, &target_path)?;
    require_existing_file(&target)?;
    let target_str = target
        .to_str()
        .ok_or_else(|| "Path is not valid UTF-8".to_string())?
        .to_string();
    spawn_preview(&target_str)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DesktopPlatform {
    Macos,
    Windows,
    Unix,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CommandSpec {
    program: String,
    args: Vec<String>,
}

fn current_desktop_platform() -> DesktopPlatform {
    if cfg!(target_os = "macos") {
        DesktopPlatform::Macos
    } else if cfg!(target_os = "windows") {
        DesktopPlatform::Windows
    } else {
        DesktopPlatform::Unix
    }
}

fn external_command_spec_for(platform: DesktopPlatform, target: &str) -> CommandSpec {
    match platform {
        DesktopPlatform::Macos => CommandSpec {
            program: "open".to_string(),
            args: vec![target.to_string()],
        },
        DesktopPlatform::Windows => CommandSpec {
            program: "cmd".to_string(),
            args: vec![
                "/C".to_string(),
                "start".to_string(),
                "".to_string(),
                target.to_string(),
            ],
        },
        DesktopPlatform::Unix => CommandSpec {
            program: "xdg-open".to_string(),
            args: vec![target.to_string()],
        },
    }
}

fn preview_command_spec_for(platform: DesktopPlatform, target: &str) -> CommandSpec {
    match platform {
        DesktopPlatform::Macos => CommandSpec {
            program: "qlmanage".to_string(),
            args: vec!["-p".to_string(), target.to_string()],
        },
        DesktopPlatform::Windows | DesktopPlatform::Unix => {
            external_command_spec_for(platform, target)
        }
    }
}

fn spawn_command(spec: CommandSpec, label: &str) -> Result<(), String> {
    Command::new(&spec.program)
        .args(spec.args)
        .no_window()
        .spawn()
        .map_err(|err| format!("{label}: {err}"))?;
    Ok(())
}

fn spawn_external(target: &str) -> Result<(), String> {
    spawn_command(
        external_command_spec_for(current_desktop_platform(), target),
        "Cannot open externally",
    )
}

fn spawn_preview(target: &str) -> Result<(), String> {
    spawn_command(
        preview_command_spec_for(current_desktop_platform(), target),
        "Cannot open system preview",
    )
}

pub(crate) fn require_existing_file(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("Target does not exist: {}", path.display()));
    }
    if !path.is_file() {
        return Err(format!("Target is not a regular file: {}", path.display()));
    }
    Ok(())
}

fn detect_document_format_bounded(path: &Path) -> Result<DocumentFormat, String> {
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
    if header.len() >= 4 && header.starts_with(&[0xd0, 0xcf, 0x11, 0xe0]) {
        return Ok(DocumentFormat::Hwp);
    }
    if is_hwpml_header(&header) {
        return Ok(DocumentFormat::Hwpml);
    }
    if is_zip_header(&header) {
        return Ok(detect_zip_format_path(path));
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

fn detect_zip_format_path(path: &Path) -> DocumentFormat {
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

fn classify(ext: Option<&str>, detected_format: &str) -> ViewerCategory {
    match ext {
        Some(
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "ico" | "tiff" | "tif" | "heic"
            | "heif" | "avif",
        ) => ViewerCategory::Image,
        Some("svg") => ViewerCategory::Svg,
        Some("pdf") => ViewerCategory::Pdf,
        Some("docx") => ViewerCategory::Docx,
        Some("xlsx" | "xls" | "xlsm") => ViewerCategory::Xlsx,
        Some("hwpx") => ViewerCategory::Hwpx,
        Some("mp3" | "wav" | "ogg" | "oga" | "flac" | "m4a" | "aac" | "opus") => {
            ViewerCategory::Audio
        }
        Some("mp4" | "mov" | "mkv" | "avi" | "webm" | "m4v") => ViewerCategory::Video,
        Some(
            "txt" | "log" | "srt" | "csv" | "tsv" | "json" | "xml" | "yaml" | "yml" | "toml"
            | "ini" | "conf" | "cfg" | "env" | "html" | "htm" | "css" | "scss" | "sass" | "less"
            | "js" | "mjs" | "cjs" | "ts" | "tsx" | "jsx" | "py" | "rs" | "go" | "java" | "kt"
            | "swift" | "c" | "cc" | "cpp" | "h" | "hpp" | "sql" | "sh" | "bash" | "zsh" | "fish"
            | "rb" | "php" | "lua" | "vim" | "dockerfile" | "gradle" | "properties",
        ) => ViewerCategory::Text,
        Some("zip" | "jar" | "war" | "apk" | "epub" | "ipa") => ViewerCategory::Archive,
        _ => match detected_format {
            "pdf" => ViewerCategory::Pdf,
            "docx" => ViewerCategory::Docx,
            "xlsx" => ViewerCategory::Xlsx,
            "hwpx" => ViewerCategory::Hwpx,
            _ => ViewerCategory::Unsupported,
        },
    }
}

fn format_label(format: DocumentFormat) -> &'static str {
    match format {
        DocumentFormat::Hwpx => "hwpx",
        DocumentFormat::Docx => "docx",
        DocumentFormat::Xlsx => "xlsx",
        DocumentFormat::Pdf => "pdf",
        DocumentFormat::Hwp => "hwp",
        DocumentFormat::Hwp3 => "hwp3",
        DocumentFormat::Hwpml => "hwpml",
        DocumentFormat::Unknown => "unknown",
    }
}

fn decode_text(bytes: &[u8]) -> (String, String) {
    if let Ok(s) = std::str::from_utf8(bytes) {
        return (s.to_string(), "utf-8".to_string());
    }
    if let Err(err) = std::str::from_utf8(bytes) {
        if err.error_len().is_none() && err.valid_up_to() > 0 {
            let valid = &bytes[..err.valid_up_to()];
            if let Ok(s) = std::str::from_utf8(valid) {
                return (s.to_string(), "utf-8".to_string());
            }
        }
    }
    let (decoded, _used, had_errors) = EUC_KR.decode(bytes);
    if !had_errors {
        return (decoded.into_owned(), "euc-kr".to_string());
    }
    (
        String::from_utf8_lossy(bytes).into_owned(),
        "utf-8-lossy".to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn classify_dispatches_on_extension() {
        let cases = [
            ("foo.png", ViewerCategory::Image),
            ("foo.SVG", ViewerCategory::Svg),
            ("foo.pdf", ViewerCategory::Pdf),
            ("foo.docx", ViewerCategory::Docx),
            ("foo.xlsx", ViewerCategory::Xlsx),
            ("foo.hwpx", ViewerCategory::Hwpx),
            ("foo.mp4", ViewerCategory::Video),
            ("foo.mp3", ViewerCategory::Audio),
            ("foo.txt", ViewerCategory::Text),
            ("foo.zip", ViewerCategory::Archive),
            ("foo.unknown", ViewerCategory::Unsupported),
        ];
        for (name, expected) in cases {
            let ext = Path::new(name)
                .extension()
                .and_then(OsStr::to_str)
                .map(str::to_ascii_lowercase);
            let cat = classify(ext.as_deref(), "unknown");
            assert_eq!(cat, expected, "category for {name}");
        }
    }

    #[test]
    fn classify_falls_back_to_detected_format() {
        assert_eq!(classify(None, "pdf"), ViewerCategory::Pdf);
        assert_eq!(classify(Some("bin"), "hwpx"), ViewerCategory::Hwpx);
        assert_eq!(
            classify(Some("bin"), "unknown"),
            ViewerCategory::Unsupported
        );
    }

    #[test]
    fn decode_text_prefers_utf8() {
        let (content, encoding) = decode_text("hello 한글".as_bytes());
        assert_eq!(content, "hello 한글");
        assert_eq!(encoding, "utf-8");
    }

    #[test]
    fn decode_text_falls_back_to_euc_kr() {
        // "한글" in EUC-KR (CP949): 0xC7 0xD1 0xB1 0xDB
        let bytes = vec![0xC7, 0xD1, 0xB1, 0xDB];
        let (content, encoding) = decode_text(&bytes);
        assert_eq!(content, "한글");
        assert_eq!(encoding, "euc-kr");
    }

    #[test]
    fn read_text_truncates_large_files() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("big.txt");
        fs::write(&path, "a".repeat(1000)).unwrap();
        let preview = binary_viewer_read_text(
            tmp.path().to_str().unwrap().to_string(),
            path.to_str().unwrap().to_string(),
            Some(100),
        )
        .unwrap();
        assert!(preview.truncated);
        assert_eq!(preview.content.len(), 100);
        assert_eq!(preview.byte_count, 1000);
        assert_eq!(preview.shown_bytes, 100);
    }

    #[test]
    fn read_text_trims_incomplete_utf8_suffix() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("truncated.txt");
        fs::write(&path, "a한".as_bytes()).unwrap();
        let preview = binary_viewer_read_text(
            tmp.path().to_str().unwrap().to_string(),
            path.to_str().unwrap().to_string(),
            Some(2),
        )
        .unwrap();
        assert!(preview.truncated);
        assert_eq!(preview.content, "a");
        assert_eq!(preview.encoding, "utf-8");
        assert_eq!(preview.shown_bytes, 2);
    }

    #[test]
    fn read_text_handles_cp949_file() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("ko.txt");
        let cp949_bytes = vec![0xC7, 0xD1, 0xB1, 0xDB];
        fs::write(&path, &cp949_bytes).unwrap();
        let preview = binary_viewer_read_text(
            tmp.path().to_str().unwrap().to_string(),
            path.to_str().unwrap().to_string(),
            None,
        )
        .unwrap();
        assert_eq!(preview.encoding, "euc-kr");
        assert_eq!(preview.content, "한글");
    }

    #[test]
    fn classify_rejects_outside_vault() {
        let tmp = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let outside_file = outside.path().join("x.png");
        fs::write(&outside_file, b"\x89PNG\r\n").unwrap();
        let err = binary_viewer_classify(
            tmp.path().to_str().unwrap().to_string(),
            outside_file.to_str().unwrap().to_string(),
        )
        .unwrap_err();
        assert!(
            err.contains("escapes") || err.contains("outside") || err.contains("does not"),
            "unexpected err: {err}"
        );
    }

    #[test]
    fn preview_command_uses_quicklook_on_macos() {
        let spec = preview_command_spec_for(DesktopPlatform::Macos, "/tmp/file.pdf");
        assert_eq!(spec.program, "qlmanage");
        assert_eq!(spec.args, vec!["-p", "/tmp/file.pdf"]);
    }

    #[test]
    fn preview_command_falls_back_to_external_open_elsewhere() {
        let windows = preview_command_spec_for(DesktopPlatform::Windows, "C:\\tmp\\file.docx");
        assert_eq!(windows.program, "cmd");
        assert_eq!(windows.args, vec!["/C", "start", "", "C:\\tmp\\file.docx"]);

        let unix = preview_command_spec_for(DesktopPlatform::Unix, "/tmp/file.xlsx");
        assert_eq!(unix.program, "xdg-open");
        assert_eq!(unix.args, vec!["/tmp/file.xlsx"]);
    }

    #[test]
    fn preview_rejects_outside_vault() {
        let tmp = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let outside_file = outside.path().join("x.pdf");
        fs::write(&outside_file, b"%PDF-1.4\n%%EOF").unwrap();
        let err = binary_viewer_preview_external(
            tmp.path().to_str().unwrap().to_string(),
            outside_file.to_str().unwrap().to_string(),
        )
        .unwrap_err();
        assert!(
            err.contains("escapes") || err.contains("outside") || err.contains("does not"),
            "unexpected err: {err}"
        );
    }

    #[test]
    fn classify_reports_metadata() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("note.txt");
        fs::write(&path, b"hello").unwrap();
        let report = binary_viewer_classify(
            tmp.path().to_str().unwrap().to_string(),
            path.to_str().unwrap().to_string(),
        )
        .unwrap();
        assert_eq!(report.category, ViewerCategory::Text);
        assert_eq!(report.extension.as_deref(), Some("txt"));
        assert_eq!(report.size_bytes, 5);
    }

    fn write_zip_fixture(path: &Path, entries: &[(&str, &[u8])]) {
        let file = fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for (name, bytes) in entries {
            zip.start_file(name, options).unwrap();
            std::io::Write::write_all(&mut zip, bytes).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn classify_uses_magic_detection_for_renamed_documents() {
        let tmp = TempDir::new().unwrap();
        let pdf = tmp.path().join("pdf-renamed.bin");
        fs::write(&pdf, b"%PDF-1.4\n%%EOF").unwrap();
        let docx = tmp.path().join("docx-renamed.bin");
        write_zip_fixture(&docx, &[("word/document.xml", b"<w:document />")]);
        let xlsx = tmp.path().join("xlsx-renamed.bin");
        write_zip_fixture(&xlsx, &[("xl/workbook.xml", b"<workbook />")]);
        let hwpx = tmp.path().join("hwpx-renamed.bin");
        write_zip_fixture(
            &hwpx,
            &[
                ("mimetype", b"application/hwp+zip"),
                ("Contents/content.hpf", b"<package />"),
            ],
        );

        let cases = [
            (pdf, ViewerCategory::Pdf, "pdf"),
            (docx, ViewerCategory::Docx, "docx"),
            (xlsx, ViewerCategory::Xlsx, "xlsx"),
            (hwpx, ViewerCategory::Hwpx, "hwpx"),
        ];
        for (path, category, detected_format) in cases {
            let report = binary_viewer_classify(
                tmp.path().to_str().unwrap().to_string(),
                path.to_str().unwrap().to_string(),
            )
            .unwrap();
            assert_eq!(report.category, category);
            assert_eq!(report.extension.as_deref(), Some("bin"));
            assert_eq!(report.detected_format, detected_format);
        }
    }

    #[test]
    fn read_archive_reports_total_and_truncation() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("archive.zip");
        write_zip_fixture(&path, &[("a.txt", b"a"), ("b.txt", b"b")]);
        let preview = binary_viewer_read_archive(
            tmp.path().to_str().unwrap().to_string(),
            path.to_str().unwrap().to_string(),
        )
        .unwrap();
        assert_eq!(preview.total_entries, 2);
        assert_eq!(preview.entries.len(), 2);
        assert!(!preview.truncated);
    }
}
