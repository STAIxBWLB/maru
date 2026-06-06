// Lightweight, selective Rust port of kordoc ideas used by Anchor Studio.
//
// Source reference: https://github.com/chrisryugj/kordoc (MIT). This module
// intentionally keeps the scope small: format sniffing, safe HWPX ZIP/XML
// checks, Korean public-form label recognition, and conservative HWPX text
// replacement. It is not a general document converter.

use quick_xml::events::{BytesText, Event};
use quick_xml::{Reader, Writer};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs::File;
use std::io::{Cursor, Read, Seek, Write};
use std::path::{Component, Path};
use std::sync::OnceLock;
use zip::write::{SimpleFileOptions, ZipWriter};
use zip::ZipArchive;

const MAX_ZIP_ENTRIES: usize = 500;
const MAX_DECOMPRESSED_SIZE: u64 = 100 * 1024 * 1024;

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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KordocLiteCheck {
    pub name: String,
    pub status: String,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone)]
pub struct LiteField {
    pub key: String,
    pub label: String,
    pub required: bool,
    pub occurrences: u32,
    pub source: String,
    pub confidence: f32,
    pub matched_key: Option<String>,
}

#[derive(Debug, Clone)]
pub struct HwpxScanResult {
    pub fields: Vec<LiteField>,
    pub warnings: Vec<String>,
    pub validation_checks: Vec<KordocLiteCheck>,
}

#[derive(Debug, Clone)]
pub struct HwpxFillOutcome {
    pub filled_count: u32,
    pub unmatched_fields: Vec<String>,
    pub validation_checks: Vec<KordocLiteCheck>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HwpxPreview {
    pub html: String,
    pub sections: usize,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone)]
struct HwpxPackage {
    entries: BTreeMap<String, Vec<u8>>,
    section_names: Vec<String>,
}

#[derive(Debug, Clone)]
struct ParsedSection {
    events: Vec<Event<'static>>,
    text_nodes: Vec<TextNode>,
    cells: Vec<CellInfo>,
}

#[derive(Debug, Clone)]
struct TextNode {
    event_index: usize,
    text: String,
    in_cell: bool,
}

#[derive(Debug, Clone)]
struct CellInfo {
    row: usize,
    text_indices: Vec<usize>,
    insert_after_event: Option<usize>,
    text: String,
}

#[derive(Debug)]
struct CellBuilder {
    row: usize,
    text_indices: Vec<usize>,
    insert_after_event: Option<usize>,
    text: String,
}

pub fn detect_document_format_path(path: &Path) -> Result<DocumentFormat, String> {
    let bytes = std::fs::read(path).map_err(|err| format!("Cannot read file: {err}"))?;
    Ok(detect_document_format(&bytes))
}

pub fn detect_document_format(bytes: &[u8]) -> DocumentFormat {
    if bytes.len() < 4 {
        return DocumentFormat::Unknown;
    }
    if bytes.starts_with(b"HWP Document File V3.00") {
        return DocumentFormat::Hwp3;
    }
    if bytes.starts_with(b"%PDF") {
        return DocumentFormat::Pdf;
    }
    if is_hwpml(bytes) {
        return DocumentFormat::Hwpml;
    }
    if bytes.starts_with(&[0xd0, 0xcf, 0x11, 0xe0]) {
        return DocumentFormat::Hwp;
    }
    if bytes.starts_with(b"PK\x03\x04") {
        return detect_zip_format(bytes);
    }
    DocumentFormat::Unknown
}

pub fn extract_hwpx_text_html(path: &Path) -> Result<HwpxPreview, String> {
    let package = read_hwpx_package(path)?;
    let mut html = String::new();
    let mut warnings = Vec::new();
    let mut sections = 0usize;

    for section_name in &package.section_names {
        let Some(bytes) = package.entries.get(section_name) else {
            continue;
        };
        let xml = match String::from_utf8(bytes.clone()) {
            Ok(value) => value,
            Err(err) => {
                warnings.push(format!("Section {section_name} is not UTF-8: {err}"));
                continue;
            }
        };
        match section_xml_to_html(&strip_dtd(&xml)) {
            Ok(section_html) => {
                if !section_html.is_empty() {
                    if sections > 0 {
                        html.push_str("<hr class=\"hwpx-section-break\" />");
                    }
                    html.push_str(&section_html);
                    sections += 1;
                }
            }
            Err(err) => warnings.push(format!("Section {section_name} render failed: {err}")),
        }
    }

    if html.is_empty() {
        warnings.push("HWPX has no renderable text content".to_string());
    }

    Ok(HwpxPreview {
        html,
        sections,
        warnings,
    })
}

fn section_xml_to_html(xml: &str) -> Result<String, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);

    let mut out = String::new();
    let mut depth_t: u32 = 0;
    let mut in_para = false;
    let mut row_open = false;
    let mut cell_open = false;
    let mut para_has_text = false;

    loop {
        let event = reader
            .read_event()
            .map_err(|err| format!("XML parse failed: {err}"))?;
        match &event {
            Event::Eof => break,
            Event::Start(start) => match local_name(start.name().as_ref()).as_str() {
                "p" => {
                    if in_para {
                        if !para_has_text {
                            out.push_str("&nbsp;");
                        }
                        out.push_str("</p>");
                    }
                    out.push_str("<p>");
                    in_para = true;
                    para_has_text = false;
                }
                "tbl" => {
                    if in_para {
                        if !para_has_text {
                            out.push_str("&nbsp;");
                        }
                        out.push_str("</p>");
                        in_para = false;
                    }
                    out.push_str("<table>");
                }
                "tr" => {
                    out.push_str("<tr>");
                    row_open = true;
                }
                "tc" => {
                    out.push_str("<td>");
                    cell_open = true;
                }
                "t" => depth_t += 1,
                "linebreak" | "lineBreak" => {
                    if in_para || cell_open {
                        out.push_str("<br/>");
                    }
                }
                _ => {}
            },
            Event::Empty(start) => match local_name(start.name().as_ref()).as_str() {
                "linebreak" | "lineBreak" | "br" => {
                    if in_para || cell_open {
                        out.push_str("<br/>");
                    }
                }
                _ => {}
            },
            Event::End(end) => match local_name(end.name().as_ref()).as_str() {
                "p" => {
                    if in_para {
                        if !para_has_text {
                            out.push_str("&nbsp;");
                        }
                        out.push_str("</p>");
                        in_para = false;
                        para_has_text = false;
                    }
                }
                "tbl" => out.push_str("</table>"),
                "tr" => {
                    if row_open {
                        out.push_str("</tr>");
                        row_open = false;
                    }
                }
                "tc" => {
                    if cell_open {
                        out.push_str("</td>");
                        cell_open = false;
                    }
                }
                "t" => depth_t = depth_t.saturating_sub(1),
                _ => {}
            },
            Event::Text(text) if depth_t > 0 => {
                if let Ok(decoded) = text.xml_content() {
                    let escaped = html_escape_text(decoded.as_ref());
                    if !escaped.is_empty() {
                        out.push_str(&escaped);
                        para_has_text = true;
                    }
                }
            }
            Event::CData(cdata) if depth_t > 0 => {
                if let Ok(s) = cdata.decode() {
                    // CDATA content is taken literally — no entity decoding.
                    let escaped = html_escape_text(s.as_ref());
                    if !escaped.is_empty() {
                        out.push_str(&escaped);
                        para_has_text = true;
                    }
                }
            }
            Event::GeneralRef(reference) if depth_t > 0 => {
                let ch = resolve_general_ref(reference);
                if let Some(ch) = ch {
                    let mut tmp = String::new();
                    tmp.push(ch);
                    out.push_str(&html_escape_text(&tmp));
                    para_has_text = true;
                }
            }
            _ => {}
        }
    }

    if in_para {
        if !para_has_text {
            out.push_str("&nbsp;");
        }
        out.push_str("</p>");
    }
    Ok(out)
}

fn resolve_general_ref(reference: &quick_xml::events::BytesRef<'_>) -> Option<char> {
    if let Ok(Some(ch)) = reference.resolve_char_ref() {
        return Some(ch);
    }
    let name = reference.decode().ok()?;
    match name.as_ref() {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        _ => None,
    }
}

fn html_escape_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
    out
}

pub fn scan_hwpx_fields(path: &Path) -> Result<HwpxScanResult, String> {
    let package = read_hwpx_package(path)?;
    let mut fields = BTreeMap::<String, LiteField>::new();
    let mut warnings = Vec::new();

    for section_name in &package.section_names {
        let Some(bytes) = package.entries.get(section_name) else {
            continue;
        };
        let xml = String::from_utf8(bytes.clone())
            .map_err(|err| format!("HWPX section is not UTF-8: {section_name}: {err}"))?;
        let section = parse_section_xml(&strip_dtd(&xml))?;
        collect_fields_from_section(&section, &mut fields);
    }

    if fields.is_empty() {
        warnings.push("kordoc_lite found no placeholders or form labels".to_string());
    }

    Ok(HwpxScanResult {
        fields: fields.into_values().collect(),
        warnings,
        validation_checks: pass_hwpx_checks(&package),
    })
}

pub fn fill_hwpx_form_fields(
    input_path: &Path,
    output_path: &Path,
    values: &BTreeMap<String, String>,
) -> Result<HwpxFillOutcome, String> {
    let mut package = read_hwpx_package(input_path)?;
    let normalized_values = normalize_values(values);
    let mut matched = HashSet::<String>::new();
    let mut filled_count = 0u32;

    for section_name in package.section_names.clone() {
        let Some(bytes) = package.entries.get(&section_name).cloned() else {
            continue;
        };
        let xml = String::from_utf8(bytes)
            .map_err(|err| format!("HWPX section is not UTF-8: {section_name}: {err}"))?;
        let (rewritten, count) =
            rewrite_section_xml(&strip_dtd(&xml), &normalized_values, &mut matched)?;
        if count > 0 {
            package.entries.insert(section_name, rewritten.into_bytes());
            filled_count += count;
        }
    }

    write_hwpx_package(output_path, &package)?;
    let validation_checks = validate_hwpx_path(output_path);

    Ok(HwpxFillOutcome {
        filled_count,
        unmatched_fields: resolve_unmatched(&normalized_values, &matched, values),
        validation_checks,
        warnings: Vec::new(),
    })
}

pub fn validate_export_artifact(path: &Path, extension: &str) -> Vec<KordocLiteCheck> {
    match extension {
        "hwpx" => validate_hwpx_path(path),
        "docx" => vec![validate_zip_member(
            path,
            "word/document.xml",
            "docx-structure",
        )],
        "pdf" => vec![validate_pdf(path)],
        _ => vec![KordocLiteCheck::skipped(
            "format-structure",
            "no kordoc_lite check for this format",
        )],
    }
}

pub fn validate_hwpx_path(path: &Path) -> Vec<KordocLiteCheck> {
    match read_hwpx_package(path) {
        Ok(package) => pass_hwpx_checks(&package),
        Err(err) => vec![KordocLiteCheck::fail("hwpx-structure", err)],
    }
}

fn pass_hwpx_checks(package: &HwpxPackage) -> Vec<KordocLiteCheck> {
    vec![
        KordocLiteCheck::pass("zip-safety"),
        if package.section_names.is_empty() {
            KordocLiteCheck::fail("hwpx-sections", "HWPX section XML not found")
        } else {
            KordocLiteCheck::pass("hwpx-sections")
        },
    ]
}

fn validate_pdf(path: &Path) -> KordocLiteCheck {
    let Ok(bytes) = std::fs::read(path) else {
        return KordocLiteCheck::fail("pdf-structure", "cannot read PDF");
    };
    if !bytes.starts_with(b"%PDF") {
        return KordocLiteCheck::fail("pdf-structure", "missing %PDF header");
    }
    let tail_start = bytes.len().saturating_sub(2048);
    if !bytes[tail_start..]
        .windows(5)
        .any(|chunk| chunk == b"%%EOF")
    {
        return KordocLiteCheck::fail("pdf-structure", "missing %%EOF marker near file end");
    }
    KordocLiteCheck::pass("pdf-structure")
}

fn validate_zip_member(path: &Path, member: &str, check_name: &str) -> KordocLiteCheck {
    let Ok(file) = File::open(path) else {
        return KordocLiteCheck::fail(check_name, "cannot read ZIP file");
    };
    let Ok(mut archive) = ZipArchive::new(file) else {
        return KordocLiteCheck::fail(check_name, "invalid ZIP file");
    };
    let exists = archive.by_name(member).is_ok();
    match exists {
        true => KordocLiteCheck::pass(check_name),
        false => KordocLiteCheck::fail(check_name, format!("missing {member}")),
    }
}

fn detect_zip_format(bytes: &[u8]) -> DocumentFormat {
    let Ok(mut archive) = ZipArchive::new(Cursor::new(bytes)) else {
        return DocumentFormat::Unknown;
    };
    let mut names = BTreeSet::new();
    for i in 0..archive.len().min(MAX_ZIP_ENTRIES) {
        if let Ok(file) = archive.by_index(i) {
            names.insert(file.name().to_ascii_lowercase());
        }
    }
    if names.contains("xl/workbook.xml") {
        DocumentFormat::Xlsx
    } else if names.contains("word/document.xml") {
        DocumentFormat::Docx
    } else if names.contains("contents/content.hpf")
        || names.contains("mimetype")
        || names
            .iter()
            .any(|name| name.starts_with("contents/section"))
    {
        DocumentFormat::Hwpx
    } else {
        DocumentFormat::Unknown
    }
}

fn read_hwpx_package(path: &Path) -> Result<HwpxPackage, String> {
    let format = detect_document_format_path(path)?;
    if format != DocumentFormat::Hwpx {
        return Err(format!("expected HWPX, detected {format:?}"));
    }
    let file = File::open(path).map_err(|err| format!("Cannot open HWPX: {err}"))?;
    read_zip_package(file)
}

fn read_zip_package<R: Read + Seek>(reader: R) -> Result<HwpxPackage, String> {
    let mut archive = ZipArchive::new(reader).map_err(|err| format!("Invalid ZIP/HWPX: {err}"))?;
    if archive.len() > MAX_ZIP_ENTRIES {
        return Err("ZIP entry count exceeds safety limit".to_string());
    }

    let mut total_size = 0u64;
    let mut entries = BTreeMap::new();
    let mut section_names = Vec::new();

    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|err| format!("Cannot read ZIP entry: {err}"))?;
        let name = file.name().to_string();
        validate_zip_entry_name(&name)?;
        if file.is_dir() {
            continue;
        }
        total_size = total_size
            .checked_add(file.size())
            .ok_or_else(|| "ZIP size overflow".to_string())?;
        if total_size > MAX_DECOMPRESSED_SIZE {
            return Err("ZIP decompressed size exceeds safety limit".to_string());
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|err| format!("Cannot read ZIP entry {name}: {err}"))?;
        if is_section_name(&name) {
            section_names.push(name.clone());
        }
        entries.insert(name, bytes);
    }

    section_names.sort();
    if section_names.is_empty() {
        return Err("HWPX section XML not found".to_string());
    }

    Ok(HwpxPackage {
        entries,
        section_names,
    })
}

fn write_hwpx_package(path: &Path, package: &HwpxPackage) -> Result<(), String> {
    let file = File::create(path).map_err(|err| format!("Cannot write HWPX: {err}"))?;
    let mut writer = ZipWriter::new(file);
    let stored = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let deflated =
        SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    if let Some(bytes) = package.entries.get("mimetype") {
        writer
            .start_file("mimetype", stored)
            .map_err(|err| format!("Cannot start ZIP entry mimetype: {err}"))?;
        writer
            .write_all(bytes)
            .map_err(|err| format!("Cannot write ZIP entry mimetype: {err}"))?;
    }
    for (name, bytes) in &package.entries {
        if name == "mimetype" {
            continue;
        }
        writer
            .start_file(name, deflated)
            .map_err(|err| format!("Cannot start ZIP entry {name}: {err}"))?;
        writer
            .write_all(bytes)
            .map_err(|err| format!("Cannot write ZIP entry {name}: {err}"))?;
    }
    writer
        .finish()
        .map_err(|err| format!("Cannot finalize HWPX ZIP: {err}"))?;
    Ok(())
}

fn parse_section_xml(xml: &str) -> Result<ParsedSection, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);

    let mut events = Vec::new();
    let mut text_nodes = Vec::new();
    let mut cells = Vec::new();
    let mut current_cell: Option<CellBuilder> = None;
    let mut current_row = 0usize;
    let mut seen_row = false;

    loop {
        let event = reader
            .read_event()
            .map_err(|err| format!("XML parse failed: {err}"))?;
        match &event {
            Event::Eof => break,
            Event::Start(start) => {
                let local = local_name(start.name().as_ref());
                if local == "tr" {
                    if seen_row {
                        current_row += 1;
                    } else {
                        seen_row = true;
                    }
                } else if local == "tc" {
                    current_cell = Some(CellBuilder {
                        row: current_row,
                        text_indices: Vec::new(),
                        insert_after_event: None,
                        text: String::new(),
                    });
                } else if local == "t" {
                    if let Some(cell) = current_cell.as_mut() {
                        cell.insert_after_event.get_or_insert(events.len());
                    }
                }
            }
            Event::Text(text) => {
                let decoded = text
                    .xml_content()
                    .map_err(|err| format!("XML text decode failed: {err}"))?
                    .into_owned();
                let event_index = events.len();
                let text_index = text_nodes.len();
                if let Some(cell) = current_cell.as_mut() {
                    cell.text_indices.push(text_index);
                    cell.text.push_str(&decoded);
                }
                text_nodes.push(TextNode {
                    event_index,
                    text: decoded,
                    in_cell: current_cell.is_some(),
                });
            }
            Event::CData(cdata) => {
                let decoded = cdata
                    .decode()
                    .map_err(|err| format!("XML CDATA decode failed: {err}"))?
                    .into_owned();
                let event_index = events.len();
                let text_index = text_nodes.len();
                if let Some(cell) = current_cell.as_mut() {
                    cell.text_indices.push(text_index);
                    cell.text.push_str(&decoded);
                }
                text_nodes.push(TextNode {
                    event_index,
                    text: decoded,
                    in_cell: current_cell.is_some(),
                });
            }
            Event::End(end) if local_name(end.name().as_ref()) == "tc" => {
                if let Some(cell) = current_cell.take() {
                    cells.push(CellInfo {
                        row: cell.row,
                        text_indices: cell.text_indices,
                        insert_after_event: cell.insert_after_event,
                        text: cell.text,
                    });
                }
            }
            _ => {}
        }
        events.push(event.into_owned());
    }

    Ok(ParsedSection {
        events,
        text_nodes,
        cells,
    })
}

fn collect_fields_from_section(section: &ParsedSection, fields: &mut BTreeMap<String, LiteField>) {
    for node in &section.text_nodes {
        for captures in placeholder_re().captures_iter(&node.text) {
            let Some(raw) = captures.get(1).map(|value| value.as_str().trim()) else {
                continue;
            };
            if raw.is_empty() {
                continue;
            }
            merge_field(fields, raw, raw, "placeholder", 1.0, None);
        }
        if !node.in_cell {
            for captures in inline_label_re().captures_iter(&node.text) {
                if let Some(label) = captures.get(1).map(|value| value.as_str()) {
                    merge_field(fields, label, label, "inlineLabel", 0.64, None);
                }
            }
        }
    }

    for cell in &section.cells {
        if is_label_cell(&cell.text) {
            let label = trim_label(&cell.text);
            merge_field(fields, &label, &label, "formLabel", 0.72, None);
        }
    }
}

fn rewrite_section_xml(
    xml: &str,
    values: &BTreeMap<String, String>,
    matched: &mut HashSet<String>,
) -> Result<(String, u32), String> {
    let section = parse_section_xml(xml)?;
    let mut replacements = HashMap::<usize, String>::new();
    let mut insertions = HashMap::<usize, String>::new();
    let mut filled_count = 0u32;

    for node in &section.text_nodes {
        let (updated, count) = replace_placeholders(&node.text, values, matched);
        if count > 0 {
            replacements.insert(node.event_index, updated);
            filled_count += count;
        }
        if !node.in_cell {
            let (updated, count) = replace_inline_fields(&node.text, values, matched);
            if count > 0 {
                replacements.insert(node.event_index, updated);
                filled_count += count;
            }
        }
    }

    for cell in &section.cells {
        if let Some((updated, count)) = fill_in_cell_patterns(&cell.text, values, matched) {
            apply_cell_replacement(cell, updated, &section, &mut replacements, &mut insertions);
            filled_count += count;
        }
    }

    let mut rows: BTreeMap<usize, Vec<&CellInfo>> = BTreeMap::new();
    for cell in &section.cells {
        rows.entry(cell.row).or_default().push(cell);
    }
    for row in rows.values() {
        for pair in row.windows(2) {
            let label_cell = pair[0];
            let value_cell = pair[1];
            if !is_label_cell(&label_cell.text) || is_keyword_label(&value_cell.text) {
                continue;
            }
            let normalized = normalize_label(&label_cell.text);
            if let Some(key) = find_matching_key(&normalized, values) {
                let value = values.get(&key).cloned().unwrap_or_default();
                apply_cell_replacement(
                    value_cell,
                    value,
                    &section,
                    &mut replacements,
                    &mut insertions,
                );
                matched.insert(key);
                filled_count += 1;
            }
        }
    }

    let mut writer = Writer::new(Vec::new());
    for (index, event) in section.events.into_iter().enumerate() {
        if let Some(replacement) = replacements.get(&index) {
            writer
                .write_event(Event::Text(BytesText::new(replacement).into_owned()))
                .map_err(|err| format!("XML write failed: {err}"))?;
        } else {
            writer
                .write_event(event)
                .map_err(|err| format!("XML write failed: {err}"))?;
        }
        if let Some(insertion) = insertions.get(&index) {
            writer
                .write_event(Event::Text(BytesText::new(insertion).into_owned()))
                .map_err(|err| format!("XML write failed: {err}"))?;
        }
    }
    let bytes = writer.into_inner();
    let xml = String::from_utf8(bytes)
        .map_err(|err| format!("XML writer emitted invalid UTF-8: {err}"))?;
    Ok((xml, filled_count))
}

fn apply_cell_replacement(
    cell: &CellInfo,
    replacement: String,
    section: &ParsedSection,
    replacements: &mut HashMap<usize, String>,
    insertions: &mut HashMap<usize, String>,
) {
    if cell.text_indices.is_empty() {
        if let Some(event_index) = cell.insert_after_event {
            insertions.insert(event_index, replacement);
        }
        return;
    }
    for (offset, text_index) in cell.text_indices.iter().copied().enumerate() {
        let event_index = section.text_nodes[text_index].event_index;
        replacements.insert(
            event_index,
            if offset == 0 {
                replacement.clone()
            } else {
                String::new()
            },
        );
    }
}

fn replace_placeholders(
    text: &str,
    values: &BTreeMap<String, String>,
    matched: &mut HashSet<String>,
) -> (String, u32) {
    let mut count = 0u32;
    let updated = placeholder_re().replace_all(text, |captures: &regex::Captures<'_>| {
        let raw = captures
            .get(1)
            .map(|value| value.as_str())
            .unwrap_or("")
            .trim();
        let key = normalize_label(raw);
        if let Some(value) = values.get(&key) {
            matched.insert(key);
            count += 1;
            value.clone()
        } else {
            captures
                .get(0)
                .map(|value| value.as_str())
                .unwrap_or("")
                .to_string()
        }
    });
    (updated.into_owned(), count)
}

fn replace_inline_fields(
    text: &str,
    values: &BTreeMap<String, String>,
    matched: &mut HashSet<String>,
) -> (String, u32) {
    let mut count = 0u32;
    let updated = inline_label_re().replace_all(text, |captures: &regex::Captures<'_>| {
        let label = captures.get(1).map(|value| value.as_str()).unwrap_or("");
        let key = normalize_label(label);
        if let Some(value) = values.get(&key) {
            matched.insert(key);
            count += 1;
            format!("{label}: {value}")
        } else {
            captures
                .get(0)
                .map(|value| value.as_str())
                .unwrap_or("")
                .to_string()
        }
    });
    (updated.into_owned(), count)
}

fn fill_in_cell_patterns(
    text: &str,
    values: &BTreeMap<String, String>,
    matched: &mut HashSet<String>,
) -> Option<(String, u32)> {
    let mut count = 0u32;

    let updated = paren_blank_re().replace_all(text, |captures: &regex::Captures<'_>| {
        let prefix = captures.get(1).map(|value| value.as_str()).unwrap_or("");
        let suffix = captures.get(2).map(|value| value.as_str()).unwrap_or("");
        let label = normalize_label(&format!("{prefix}{suffix}"));
        let fallback = normalize_label(prefix);
        let key = values
            .contains_key(&label)
            .then_some(label)
            .or_else(|| values.contains_key(&fallback).then_some(fallback));
        if let Some(key) = key {
            let value = values.get(&key).cloned().unwrap_or_default();
            matched.insert(key);
            count += 1;
            format!("{prefix}({value}){suffix}")
        } else {
            captures
                .get(0)
                .map(|value| value.as_str())
                .unwrap_or("")
                .to_string()
        }
    });

    let updated = checkbox_re().replace_all(&updated, |captures: &regex::Captures<'_>| {
        let keyword = captures.get(1).map(|value| value.as_str()).unwrap_or("");
        let key = normalize_label(keyword);
        let Some(value) = values.get(&key) else {
            return captures
                .get(0)
                .map(|value| value.as_str())
                .unwrap_or("")
                .to_string();
        };
        if is_truthy_checkbox(value) {
            matched.insert(key);
            count += 1;
            format!("☑{keyword}")
        } else {
            captures
                .get(0)
                .map(|value| value.as_str())
                .unwrap_or("")
                .to_string()
        }
    });

    let updated = annotation_blank_re().replace_all(&updated, |captures: &regex::Captures<'_>| {
        let keyword = captures.get(1).map(|value| value.as_str()).unwrap_or("");
        let key = normalize_label(keyword);
        if let Some(value) = values.get(&key) {
            matched.insert(key);
            count += 1;
            format!("({keyword}: {value})")
        } else {
            captures
                .get(0)
                .map(|value| value.as_str())
                .unwrap_or("")
                .to_string()
        }
    });

    (count > 0).then(|| (updated.into_owned(), count))
}

fn merge_field(
    fields: &mut BTreeMap<String, LiteField>,
    key: &str,
    label: &str,
    source: &str,
    confidence: f32,
    matched_key: Option<String>,
) {
    let normalized = normalize_label(key);
    if normalized.is_empty() {
        return;
    }
    fields
        .entry(normalized.clone())
        .and_modify(|field| {
            field.occurrences += 1;
            if should_replace_field_metadata(field, source, confidence) {
                field.label = trim_label(label);
                field.source = source.to_string();
                field.confidence = confidence;
                field.matched_key = matched_key.clone();
            } else if field.matched_key.is_none() && matched_key.is_some() {
                field.matched_key = matched_key.clone();
            }
        })
        .or_insert_with(|| LiteField {
            key: normalized,
            label: trim_label(label),
            required: false,
            occurrences: 1,
            source: source.to_string(),
            confidence,
            matched_key,
        });
}

fn should_replace_field_metadata(field: &LiteField, source: &str, confidence: f32) -> bool {
    let existing_rank = field_source_rank(&field.source);
    let incoming_rank = field_source_rank(source);
    incoming_rank > existing_rank
        || (incoming_rank == existing_rank && confidence > field.confidence)
}

fn field_source_rank(source: &str) -> u8 {
    match source {
        "formLabel" => 3,
        "inlineLabel" => 2,
        "placeholder" => 1,
        "" => 0,
        _ => 2,
    }
}

fn normalize_values(values: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    values
        .iter()
        .map(|(key, value)| (normalize_label(key), value.clone()))
        .filter(|(key, _)| !key.is_empty())
        .collect()
}

fn resolve_unmatched(
    normalized_values: &BTreeMap<String, String>,
    matched: &HashSet<String>,
    original_values: &BTreeMap<String, String>,
) -> Vec<String> {
    normalized_values
        .keys()
        .filter(|key| !matched.contains(*key))
        .map(|key| {
            original_values
                .keys()
                .find(|original| normalize_label(original) == **key)
                .cloned()
                .unwrap_or_else(|| key.clone())
        })
        .collect()
}

fn find_matching_key(cell_label: &str, values: &BTreeMap<String, String>) -> Option<String> {
    if values.contains_key(cell_label) {
        return Some(cell_label.to_string());
    }
    let mut best_key = None;
    let mut best_len = 0usize;
    for key in values.keys() {
        if cell_label.starts_with(key) && key.chars().count() * 10 >= cell_label.chars().count() * 6
        {
            if key.len() > best_len {
                best_len = key.len();
                best_key = Some(key.clone());
            }
        } else if key.starts_with(cell_label)
            && cell_label.chars().count() * 10 >= key.chars().count() * 6
            && cell_label.len() > best_len
        {
            best_len = cell_label.len();
            best_key = Some(key.clone());
        }
    }
    best_key
}

fn is_hwpml(bytes: &[u8]) -> bool {
    let head_len = bytes.len().min(512);
    let head = String::from_utf8_lossy(&bytes[..head_len]);
    head.trim_start_matches('\u{feff}')
        .trim_start()
        .starts_with("<?xml")
        && head.contains("<HWPML")
}

fn is_section_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".xml") && lower.contains("section")
}

fn validate_zip_entry_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.starts_with('/') || name.contains('\\') {
        return Err(format!("unsafe ZIP entry path: {name}"));
    }
    if name.contains(':') || name.split('/').any(|part| part == "..") {
        return Err(format!("unsafe ZIP entry path: {name}"));
    }
    for component in Path::new(name).components() {
        if matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        ) {
            return Err(format!("unsafe ZIP entry path: {name}"));
        }
    }
    Ok(())
}

fn strip_dtd(xml: &str) -> String {
    dtd_re().replace_all(xml, "").into_owned()
}

fn local_name(name: &[u8]) -> String {
    std::str::from_utf8(name)
        .unwrap_or("")
        .rsplit(':')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn normalize_label(label: &str) -> String {
    label.trim().replace(
        [':', '：', ' ', '\t', '\n', '\r', '(', ')', '（', '）', '·'],
        "",
    )
}

fn trim_label(label: &str) -> String {
    label
        .trim()
        .trim_end_matches([':', '：', ' ', '\t', '\n', '\r'])
        .to_string()
}

fn is_label_cell(text: &str) -> bool {
    let trimmed = text
        .trim()
        .trim_end_matches(|ch: char| "¹²³⁴⁵⁶⁷⁸⁹⁰*※".contains(ch))
        .trim();
    if trimmed.is_empty() || trimmed.chars().count() > 30 {
        return false;
    }
    if LABEL_KEYWORDS
        .iter()
        .any(|keyword| trimmed.contains(keyword))
    {
        return true;
    }
    let compact_len = trimmed.chars().filter(|ch| !ch.is_whitespace()).count();
    let hangulish = trimmed
        .chars()
        .all(|ch| ch.is_whitespace() || "():：（）·".contains(ch) || ('가'..='힣').contains(&ch));
    if hangulish && (2..=8).contains(&compact_len) && !trimmed.chars().any(|ch| ch.is_ascii_digit())
    {
        return true;
    }
    label_colon_re().is_match(trimmed)
}

fn is_keyword_label(text: &str) -> bool {
    let trimmed = text
        .trim()
        .trim_end_matches(|ch: char| "¹²³⁴⁵⁶⁷⁸⁹⁰*※".contains(ch))
        .trim();
    if trimmed.is_empty() || trimmed.chars().count() > 15 {
        return false;
    }
    LABEL_KEYWORDS
        .iter()
        .any(|keyword| trimmed.contains(keyword))
}

fn is_truthy_checkbox(value: &str) -> bool {
    matches!(
        value.trim(),
        "" | "☑" | "✓" | "✔" | "v" | "V" | "true" | "1" | "yes" | "o" | "O"
    )
}

impl KordocLiteCheck {
    fn pass(name: &str) -> Self {
        Self {
            name: name.to_string(),
            status: "pass".to_string(),
            reason: None,
        }
    }

    fn fail(name: &str, reason: impl Into<String>) -> Self {
        Self {
            name: name.to_string(),
            status: "fail".to_string(),
            reason: Some(reason.into()),
        }
    }

    fn skipped(name: &str, reason: impl Into<String>) -> Self {
        Self {
            name: name.to_string(),
            status: "skipped".to_string(),
            reason: Some(reason.into()),
        }
    }
}

fn placeholder_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\{\{\s*([^{}]+?)\s*\}\}").expect("placeholder regex"))
}

fn inline_label_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"([가-힣A-Za-z]{2,10})\s*[:：]\s*([^\n,;]{0,100})").expect("inline label regex")
    })
}

fn label_colon_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[가-힣A-Za-z\s]+[:：]$").expect("label colon regex"))
}

fn dtd_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?is)<!DOCTYPE[^>]*(\[[\s\S]*?\])?\s*>").expect("DTD regex"))
}

fn paren_blank_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"([가-힣A-Za-z]+)\(\s{1,}\)([가-힣A-Za-z]*)").expect("paren blank regex")
    })
}

fn checkbox_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"□([가-힣A-Za-z]+)").expect("checkbox regex"))
}

fn annotation_blank_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\(([가-힣A-Za-z]+)[:：]\s{1,}\)").expect("annotation regex"))
}

const LABEL_KEYWORDS: &[&str] = &[
    "성명",
    "이름",
    "주소",
    "전화",
    "전화번호",
    "휴대폰",
    "핸드폰",
    "연락처",
    "생년월일",
    "주민등록번호",
    "소속",
    "직위",
    "직급",
    "부서",
    "이메일",
    "팩스",
    "학교",
    "학년",
    "반",
    "번호",
    "신청인",
    "대표자",
    "담당자",
    "작성자",
    "확인자",
    "승인자",
    "일시",
    "날짜",
    "기간",
    "장소",
    "목적",
    "사유",
    "비고",
    "금액",
    "수량",
    "단가",
    "합계",
    "계",
    "소계",
    "등록기준지",
    "본적",
    "위임인",
    "청구사유",
    "소명자료",
];

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;
    use zip::write::SimpleFileOptions;

    fn write_hwpx_fixture(path: &Path, section_xml: &str) {
        let file = File::create(path).unwrap();
        let mut zip = ZipWriter::new(file);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        zip.start_file("mimetype", options).unwrap();
        zip.write_all(b"application/hwp+zip").unwrap();
        zip.start_file("Contents/content.hpf", options).unwrap();
        zip.write_all(b"<package />").unwrap();
        zip.start_file("Contents/section0.xml", options).unwrap();
        zip.write_all(section_xml.as_bytes()).unwrap();
        zip.finish().unwrap();
    }

    #[test]
    fn detects_zip_subformats() {
        let tmp = TempDir::new().unwrap();
        let hwpx = tmp.path().join("sample.hwpx");
        write_hwpx_fixture(&hwpx, "<hp:sec><hp:p><hp:t>{{제목}}</hp:t></hp:p></hp:sec>");
        assert_eq!(
            detect_document_format_path(&hwpx).unwrap(),
            DocumentFormat::Hwpx
        );
    }

    #[test]
    fn scans_placeholders_and_form_labels() {
        let tmp = TempDir::new().unwrap();
        let hwpx = tmp.path().join("form.hwpx");
        write_hwpx_fixture(
            &hwpx,
            r#"<hp:sec><hp:p><hp:t>{{제목}}</hp:t></hp:p><hp:p><hp:t>{{성명}}</hp:t></hp:p><hp:tbl><hp:tr><hp:tc><hp:p><hp:t>성명</hp:t></hp:p></hp:tc><hp:tc><hp:p><hp:t></hp:t></hp:p></hp:tc></hp:tr></hp:tbl></hp:sec>"#,
        );

        let scan = scan_hwpx_fields(&hwpx).unwrap();
        let keys: BTreeSet<_> = scan.fields.iter().map(|field| field.key.as_str()).collect();
        assert!(keys.contains("제목"));
        assert!(keys.contains("성명"));
        let field = scan
            .fields
            .iter()
            .find(|field| field.key == "성명")
            .unwrap();
        assert_eq!(field.occurrences, 2);
        assert_eq!(field.source, "formLabel");
    }

    #[test]
    fn extracts_hwpx_text_html_with_paragraphs_and_tables() {
        let tmp = TempDir::new().unwrap();
        let hwpx = tmp.path().join("text.hwpx");
        write_hwpx_fixture(
            &hwpx,
            r#"<hp:sec><hp:p><hp:t>제목입니다</hp:t></hp:p><hp:p><hp:t>본문 라인 &amp; HTML 이스케이프 &lt;b&gt;</hp:t></hp:p><hp:tbl><hp:tr><hp:tc><hp:p><hp:t>이름</hp:t></hp:p></hp:tc><hp:tc><hp:p><hp:t>홍길동</hp:t></hp:p></hp:tc></hp:tr></hp:tbl></hp:sec>"#,
        );
        let preview = extract_hwpx_text_html(&hwpx).unwrap();
        assert_eq!(preview.sections, 1);
        assert!(
            preview.html.contains("<p>제목입니다</p>"),
            "{}",
            preview.html
        );
        assert!(
            preview.html.contains("&amp; HTML 이스케이프 &lt;b&gt;"),
            "{}",
            preview.html
        );
        assert!(preview.html.contains("<table>"), "{}", preview.html);
        assert!(preview.html.contains("<td>"), "{}", preview.html);
        assert!(preview.html.contains("홍길동"), "{}", preview.html);
    }

    #[test]
    fn extracts_hwpx_text_html_on_bundled_template() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("skills/skills/hwpx/templates/사업계획서_기본.hwpx");
        if !path.exists() {
            eprintln!("skip: bundled HWPX template missing at {}", path.display());
            return;
        }
        let preview = extract_hwpx_text_html(&path).unwrap();
        assert!(preview.sections >= 1, "expected at least one section");
        assert!(
            preview.html.contains("<p>") || preview.html.contains("<td>"),
            "expected paragraphs or table cells in output (got {} bytes)",
            preview.html.len()
        );
    }

    #[test]
    fn fills_placeholders_adjacent_cells_and_inline_labels() {
        let tmp = TempDir::new().unwrap();
        let input = tmp.path().join("form.hwpx");
        let output = tmp.path().join("out.hwpx");
        write_hwpx_fixture(
            &input,
            r#"<hp:sec><hp:p><hp:t>{{제목}}</hp:t></hp:p><hp:p><hp:t>담당자: </hp:t></hp:p><hp:tbl><hp:tr><hp:tc><hp:p><hp:t>성명</hp:t></hp:p></hp:tc><hp:tc><hp:p><hp:t></hp:t></hp:p></hp:tc></hp:tr></hp:tbl></hp:sec>"#,
        );
        let mut values = BTreeMap::new();
        values.insert("제목".to_string(), "사업계획".to_string());
        values.insert("성명".to_string(), "홍길동".to_string());
        values.insert("담당자".to_string(), "이영준".to_string());

        let result = fill_hwpx_form_fields(&input, &output, &values).unwrap();
        assert!(result.filled_count >= 3);
        let package = read_hwpx_package(&output).unwrap();
        let xml = String::from_utf8(package.entries["Contents/section0.xml"].clone()).unwrap();
        assert!(xml.contains("사업계획"));
        assert!(xml.contains("홍길동"));
        assert!(xml.contains("담당자: 이영준"));
        let file = File::open(&output).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mimetype = archive.by_index(0).unwrap();
        assert_eq!(mimetype.name(), "mimetype");
        assert_eq!(mimetype.compression(), zip::CompressionMethod::Stored);
    }

    #[test]
    fn detects_pdf_and_ole2_and_short_byte_formats() {
        assert_eq!(
            detect_document_format(b"%PDF-1.4\n%abc\n%%EOF"),
            DocumentFormat::Pdf
        );
        assert_eq!(
            detect_document_format(&[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
            DocumentFormat::Hwp
        );
        assert_eq!(detect_document_format(b""), DocumentFormat::Unknown);
        assert_eq!(detect_document_format(b"abc"), DocumentFormat::Unknown);
        assert_eq!(detect_document_format(b"random!!"), DocumentFormat::Unknown);
    }

    #[test]
    fn validate_pdf_requires_header_and_eof_marker() {
        let tmp = TempDir::new().unwrap();
        let good = tmp.path().join("good.pdf");
        std::fs::write(&good, b"%PDF-1.4\n%binary stuff\n%%EOF\n").unwrap();
        assert_eq!(validate_pdf(&good).status, "pass");

        let missing_header = tmp.path().join("noheader.pdf");
        std::fs::write(&missing_header, b"not a pdf\n%%EOF").unwrap();
        assert_eq!(validate_pdf(&missing_header).status, "fail");

        let missing_eof = tmp.path().join("noeof.pdf");
        std::fs::write(&missing_eof, b"%PDF-1.4\nbody without trailer").unwrap();
        assert_eq!(validate_pdf(&missing_eof).status, "fail");
    }

    #[test]
    fn validate_export_artifact_routes_by_extension() {
        let tmp = TempDir::new().unwrap();
        let hwpx = tmp.path().join("doc.hwpx");
        write_hwpx_fixture(&hwpx, "<hp:sec><hp:p><hp:t>x</hp:t></hp:p></hp:sec>");
        let checks = validate_export_artifact(&hwpx, "hwpx");
        assert!(checks.iter().any(|c| c.name == "zip-safety"));
        assert!(checks
            .iter()
            .any(|c| c.name == "hwpx-sections" && c.status == "pass"));

        let unknown = validate_export_artifact(&hwpx, "xyz");
        assert_eq!(unknown.len(), 1);
        assert_eq!(unknown[0].status, "skipped");
    }

    #[test]
    fn validate_hwpx_path_fails_for_corrupt_zip() {
        let tmp = TempDir::new().unwrap();
        let corrupt = tmp.path().join("bad.hwpx");
        std::fs::write(&corrupt, b"not a real hwpx").unwrap();
        let checks = validate_hwpx_path(&corrupt);
        assert!(checks.iter().any(|c| c.status == "fail"));
    }

    #[test]
    fn validate_zip_member_detects_missing_entry() {
        let tmp = TempDir::new().unwrap();
        let hwpx = tmp.path().join("doc.hwpx");
        write_hwpx_fixture(&hwpx, "<hp:sec><hp:p><hp:t>x</hp:t></hp:p></hp:sec>");
        let present = validate_zip_member(&hwpx, "mimetype", "mimetype-check");
        assert_eq!(present.status, "pass");
        let absent = validate_zip_member(&hwpx, "word/document.xml", "docx-check");
        assert_eq!(absent.status, "fail");
    }
}
