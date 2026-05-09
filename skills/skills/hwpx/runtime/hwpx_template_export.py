#!/usr/bin/env python3
from __future__ import annotations

import argparse
import copy
import json
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path
from typing import Any


BLOCK_TAGS = {
    "article",
    "aside",
    "blockquote",
    "div",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "li",
    "p",
    "section",
}

CONTAINER_TAGS = {"body", "html", "main", "section", "article", "div", "ul", "ol"}
TABLE_CELL_TAGS = {"td", "th"}
VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}
HP_NS = "http://www.hancom.co.kr/hwpml/2011/paragraph"
HP = f"{{{HP_NS}}}"

FIELD_ALIASES: dict[str, list[str]] = {
    "title": ["TITLE", "DOCUMENT_TITLE", "문서제목", "제목", "보고서제목", "공문제목", "안내문제목"],
    "body": ["BODY", "CONTENT", "본문", "내용", "문서내용"],
    "today": ["TODAY", "작성일", "작성일자", "오늘"],
    "report_date": ["REPORT_DATE", "DATE", "보고일자", "제안일", "회의일시", "일시"],
    "department": ["DEPARTMENT", "보고부서", "부서", "제안부서"],
    "author": ["AUTHOR", "WRITER", "보고자", "작성자", "제안자", "기록"],
    "approval": ["APPROVAL", "결재라인", "결재"],
    "recipient": ["RECIPIENT", "수신", "수신처"],
    "reference": ["REFERENCE", "참조", "참조처"],
    "location": ["LOCATION", "장소", "회의장소"],
    "meeting_name": ["MEETING_NAME", "회의명"],
}

LABEL_TO_FIELD = {
    "보고일자": "report_date",
    "제안일": "report_date",
    "일시": "report_date",
    "일자": "report_date",
    "보고부서": "department",
    "제안부서": "department",
    "부서": "department",
    "보고자": "author",
    "작성자": "author",
    "제안자": "author",
    "기록": "author",
    "결재라인": "approval",
    "결재": "approval",
    "수신": "recipient",
    "수신처": "recipient",
    "참조": "reference",
    "참조처": "reference",
    "장소": "location",
    "회의장소": "location",
    "회의명": "meeting_name",
    "제목": "title",
}


@dataclass
class Node:
    tag: str
    attrs: dict[str, str] = field(default_factory=dict)
    children: list["Node"] = field(default_factory=list)
    data: str = ""


@dataclass
class HtmlCell:
    text: str
    header: bool = False
    colspan: int = 1
    rowspan: int = 1


@dataclass
class HtmlTable:
    rows: list[list[HtmlCell]]


@dataclass
class HtmlLayoutCell:
    row_index: int
    col_index: int
    cell: HtmlCell


@dataclass
class HtmlBlock:
    kind: str
    text: str = ""
    table: HtmlTable | None = None
    level: int = 0


class TinyHtmlParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = Node("root")
        self.stack = [self.root]

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        node = Node(tag, {name.lower(): value or "" for name, value in attrs})
        self.stack[-1].children.append(node)
        if tag not in VOID_TAGS:
            self.stack.append(node)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if tag.lower() not in VOID_TAGS and len(self.stack) > 1:
            self.stack.pop()

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                break

    def handle_data(self, data: str) -> None:
        if data:
            self.stack[-1].children.append(Node("#text", data=data))


def clean_text(value: str) -> str:
    value = value.replace("\xa0", " ")
    value = re.sub(r"[ \t\r\f\v]+", " ", value)
    value = re.sub(r" *\n *", "\n", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value.strip()


def normalize_label(value: str) -> str:
    value = clean_text(value)
    value = re.sub(r"^[\[(（(【]?\s*", "", value)
    value = re.sub(r"\s*[\])）)】]?$", "", value)
    value = re.sub(r"[:：]+$", "", value)
    value = re.sub(r"\s+", "", value)
    return value.casefold()


def slug_key(value: str) -> str:
    value = re.sub(r"^\s*\d+\s*[.)．、-]?\s*", "", clean_text(value))
    value = re.sub(r"[/|·ㆍ]+", " ", value)
    value = re.sub(r"[^\w가-힣]+", "_", value, flags=re.UNICODE)
    return value.strip("_").casefold()


def parse_int(value: str | None, default: int = 1) -> int:
    try:
        return max(default, int(str(value or "").strip()))
    except ValueError:
        return default


def node_text(node: Node) -> str:
    if node.tag == "#text":
        return node.data
    if node.tag == "br":
        return "\n"
    if node.tag in {"script", "style", "head", "meta", "title", "link"}:
        return ""
    parts = [node_text(child) for child in node.children]
    text = "".join(parts)
    if node.tag in {"p", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr"}:
        text += "\n"
    return text


def descendants(node: Node, tag: str) -> list[Node]:
    found: list[Node] = []
    for child in node.children:
        if child.tag == tag:
            found.append(child)
        found.extend(descendants(child, tag))
    return found


def first_descendant(node: Node, tag: str) -> Node | None:
    if node.tag == tag:
        return node
    for child in node.children:
        found = first_descendant(child, tag)
        if found is not None:
            return found
    return None


def direct_children(node: Node, tags: set[str]) -> list[Node]:
    return [child for child in node.children if child.tag in tags]


def parse_table(node: Node) -> HtmlTable:
    rows: list[list[HtmlCell]] = []
    for tr in direct_table_rows(node):
        row: list[HtmlCell] = []
        for cell in direct_children(tr, TABLE_CELL_TAGS):
            row.append(
                HtmlCell(
                    text=clean_text(node_text(cell)),
                    header=cell.tag == "th",
                    colspan=parse_int(cell.attrs.get("colspan"), 1),
                    rowspan=parse_int(cell.attrs.get("rowspan"), 1),
                )
            )
        if row:
            rows.append(row)
    return HtmlTable(rows=rows)


def direct_table_rows(table_node: Node) -> list[Node]:
    rows: list[Node] = []

    def collect(node: Node) -> None:
        for child in node.children:
            if child.tag == "tr":
                rows.append(child)
            elif child.tag in {"thead", "tbody", "tfoot"}:
                collect(child)

    collect(table_node)
    return rows


def parse_html(html: str) -> list[HtmlBlock]:
    parser = TinyHtmlParser()
    parser.feed(html or "")
    parser.close()

    body = first_descendant(parser.root, "body") or parser.root
    blocks: list[HtmlBlock] = []

    def walk(node: Node) -> None:
        if node.tag in {"script", "style", "head", "meta", "title", "link"}:
            return
        if node.tag == "table":
            table = parse_table(node)
            if table.rows:
                blocks.append(HtmlBlock(kind="table", table=table))
            return
        if node.tag in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            text = clean_text(node_text(node))
            if text:
                blocks.append(HtmlBlock(kind="heading", text=text, level=int(node.tag[1])))
            return
        if node.tag in {"p", "li", "blockquote"}:
            text = clean_text(node_text(node))
            if text:
                blocks.append(HtmlBlock(kind="text", text=text))
            return
        if node.tag in CONTAINER_TAGS or node.tag == "root":
            for child in node.children:
                walk(child)
            return
        text = clean_text(node_text(node))
        if text and node.tag in BLOCK_TAGS:
            blocks.append(HtmlBlock(kind="text", text=text))

    walk(body)
    return blocks


def table_plain_text(table: HtmlTable) -> str:
    return "\n".join("\t".join(cell.text for cell in row) for row in table.rows)


def extract_key_values(blocks: list[HtmlBlock]) -> dict[str, str]:
    values: dict[str, str] = {}

    def add(label: str, value: str) -> None:
        key = normalize_label(label)
        value = clean_text(value)
        if key and value and key not in values:
            values[key] = value

    for block in blocks:
        if block.table is None:
            for match in re.finditer(r"([^:\n：]{1,20})[:：]\s*([^\n]+)", block.text):
                add(match.group(1), match.group(2))
            continue

        for row in block.table.rows:
            cells = [cell.text for cell in row]
            if len(cells) < 2:
                continue
            for index, label in enumerate(cells[:-1]):
                label_key = normalize_label(label)
                if not label_key:
                    continue
                if label_key in {normalize_label(k) for k in LABEL_TO_FIELD} or len(label_key) <= 12:
                    add(label, cells[index + 1])

    return values


def extract_sections(blocks: list[HtmlBlock]) -> list[dict[str, str]]:
    sections: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for block in blocks:
        if block.kind == "heading" and block.level >= 2:
            if current is not None:
                sections.append({"title": current["title"], "body": clean_text("\n".join(current["body"]))})
            current = {"title": block.text, "body": []}
            continue
        if current is None:
            continue
        if block.kind == "text":
            current["body"].append(block.text)
        elif block.kind == "table" and block.table is not None:
            current["body"].append(table_plain_text(block.table))
    if current is not None:
        sections.append({"title": current["title"], "body": clean_text("\n".join(current["body"]))})
    return sections


def extract_fields(blocks: list[HtmlBlock], template_id: str) -> tuple[dict[str, str], list[HtmlTable]]:
    tables = [block.table for block in blocks if block.table is not None]
    text_blocks = [block.text for block in blocks if block.text]
    headings = [block for block in blocks if block.kind == "heading"]
    first_h1 = next((block.text for block in headings if block.level == 1 and block.text), "")
    title = first_h1 or (text_blocks[0] if text_blocks else "")
    key_values = extract_key_values(blocks)
    sections = extract_sections(blocks)

    fields: dict[str, str] = {
        "template_id": template_id,
        "title": title,
        "body": clean_text("\n".join(text_blocks)),
        "today": datetime.now().strftime("%Y-%m-%d"),
    }

    for label, value in key_values.items():
        field = LABEL_TO_FIELD.get(label)
        if field is None:
            for source_label, source_field in LABEL_TO_FIELD.items():
                if normalize_label(source_label) == label:
                    field = source_field
                    break
        if field:
            fields.setdefault(field, value)
        fields[label] = value

    for index, section in enumerate(sections, start=1):
        title_value = section["title"]
        body_value = section["body"]
        fields[f"section_{index}_title"] = title_value
        fields[f"section_{index}_body"] = body_value
        section_slug = slug_key(title_value)
        if section_slug:
            fields.setdefault(section_slug, body_value)
            for token in re.split(r"[_\s]+", section_slug):
                if token:
                    fields.setdefault(token, body_value)

    for key, aliases in FIELD_ALIASES.items():
        if key in fields:
            for alias in aliases:
                fields.setdefault(alias, fields[key])
                fields.setdefault(alias.casefold(), fields[key])

    return fields, [table for table in tables if table is not None]


def build_replacements(fields: dict[str, str]) -> dict[str, str]:
    replacements: dict[str, str] = {}
    for raw_key, value in fields.items():
        if value is None:
            continue
        key = str(raw_key).strip()
        if not key:
            continue
        names = {key, key.upper(), key.casefold()}
        if key in FIELD_ALIASES:
            names.update(FIELD_ALIASES[key])
        for name in names:
            replacements[f"{{{{{name}}}}}"] = str(value)
            replacements[f"${{{name}}}"] = str(value)
            replacements[f"<<{name}>>"] = str(value)
            replacements[f"[{name}]"] = str(value)
    return replacements


def replace_text_elements(doc: Any, replacements: dict[str, str]) -> int:
    touched = 0
    parts = []
    parts.extend(getattr(doc, "sections", []) or [])
    parts.extend(getattr(doc, "headers", []) or [])
    parts.extend(getattr(doc, "master_pages", []) or [])
    parts.extend(getattr(doc, "histories", []) or [])
    version = getattr(doc, "version", None)
    if version is not None:
        parts.append(version)

    for part in parts:
        element = getattr(part, "element", None)
        if element is None:
            continue
        part_changed = False
        for node in element.iter():
            if not str(node.tag).endswith("}t") or not node.text:
                continue
            next_text = node.text
            for token, value in replacements.items():
                if token in next_text:
                    next_text = next_text.replace(token, value)
            if next_text != node.text:
                node.text = next_text
                touched += 1
                part_changed = True
        if part_changed and hasattr(part, "mark_dirty"):
            part.mark_dirty()
    return touched


def mutate_text_elements(doc: Any, mutator: Any) -> int:
    touched = 0
    parts = []
    parts.extend(getattr(doc, "sections", []) or [])
    parts.extend(getattr(doc, "headers", []) or [])
    parts.extend(getattr(doc, "master_pages", []) or [])
    parts.extend(getattr(doc, "histories", []) or [])
    version = getattr(doc, "version", None)
    if version is not None:
        parts.append(version)

    for part in parts:
        element = getattr(part, "element", None)
        if element is None:
            continue
        part_changed = False
        for node in element.iter():
            if not str(node.tag).endswith("}t") or node.text is None:
                continue
            next_text = mutator(node.text)
            if next_text != node.text:
                node.text = next_text
                touched += 1
                part_changed = True
        if part_changed and hasattr(part, "mark_dirty"):
            part.mark_dirty()
    return touched


def clear_unresolved_placeholders(doc: Any) -> int:
    pattern = re.compile(r"(\{\{[^{}]{1,100}\}\}|\$\{[^{}]{1,100}\}|<<[^<>]{1,100}>>)")
    return mutate_text_elements(doc, lambda text: clean_text(pattern.sub("", text)))


def fill_labeled_cells(doc: Any, fields: dict[str, str]) -> dict[str, Any]:
    mappings: dict[str, str] = {}
    for source_label, field_name in LABEL_TO_FIELD.items():
        value = fields.get(field_name) or fields.get(normalize_label(source_label))
        if not value:
            continue
        try:
            matches = doc.find_cell_by_label(source_label, "right")
        except Exception:
            matches = {"count": 0}
        if int(matches.get("count", 0)) == 1:
            mappings[f"{source_label} > right"] = value
    if not mappings:
        return {"applied_count": 0, "failed_count": 0, "applied": [], "failed": []}
    try:
        return doc.fill_by_path(mappings)
    except Exception as exc:  # noqa: BLE001
        return {"applied_count": 0, "failed_count": len(mappings), "applied": [], "failed": [{"path": "*", "reason": str(exc)}]}


def collect_hwpx_tables(doc: Any) -> list[Any]:
    try:
        from hwpx.tools.table_navigation import _collect_document_tables

        return [item.table for item in _collect_document_tables(doc)]
    except Exception:
        return []


def expanded_row_text(row: list[HtmlCell], target_cols: int | None = None) -> list[str]:
    values: list[str] = []
    for cell in row:
        values.append(cell.text)
        for _ in range(max(0, cell.colspan - 1)):
            values.append("")
    if target_cols is not None:
        values = values[:target_cols]
        while len(values) < target_cols:
            values.append("")
    return values


def html_table_dimensions(table: HtmlTable) -> tuple[int, int]:
    return (len(table.rows), table_layout(table)[1])


def table_layout(table: HtmlTable) -> tuple[list[list[HtmlLayoutCell]], int]:
    rows: list[list[HtmlLayoutCell]] = []
    active: list[int] = []
    col_count = 0

    for row_index, source_row in enumerate(table.rows):
        next_active = [max(0, value - 1) for value in active]
        layout_row: list[HtmlLayoutCell] = []
        col_index = 0

        for cell in source_row:
            while col_index < len(active) and active[col_index] > 0:
                col_index += 1
            colspan = max(1, cell.colspan)
            rowspan = max(1, cell.rowspan)
            layout_row.append(HtmlLayoutCell(row_index=row_index, col_index=col_index, cell=cell))
            for offset in range(colspan):
                target_index = col_index + offset
                while len(next_active) <= target_index:
                    next_active.append(0)
                next_active[target_index] = max(next_active[target_index], rowspan - 1)
            col_index += colspan

        col_count = max(col_count, col_index, active_width(active), active_width(next_active))
        rows.append(layout_row)
        active = next_active

    return rows, max(1, col_count)


def active_width(active: list[int]) -> int:
    for index in range(len(active) - 1, -1, -1):
        if active[index] > 0:
            return index + 1
    return 0


def logical_row_text(table: HtmlTable, row_index: int, target_cols: int | None = None) -> list[str]:
    layout_rows, col_count = table_layout(table)
    cols = target_cols or col_count
    values = [""] * cols
    if row_index >= len(layout_rows):
        return values
    for layout_cell in layout_rows[row_index]:
        if layout_cell.col_index < cols:
            values[layout_cell.col_index] = layout_cell.cell.text
    return values


def normalized_row(values: list[str]) -> list[str]:
    return [normalize_label(value) for value in values if normalize_label(value)]


def table_header_score(template_values: list[str], source_values: list[str]) -> int:
    template_norm = set(normalized_row(template_values))
    source_norm = set(normalized_row(source_values))
    if not template_norm or not source_norm:
        return 0
    return len(template_norm & source_norm)


def ensure_table_rows(table: Any, target_rows: int) -> None:
    row_elements = table.element.findall(f"{HP}tr")
    if not row_elements:
        return
    changed = False
    while len(row_elements) < target_rows:
        new_index = len(row_elements)
        new_row = copy.deepcopy(row_elements[-1])
        for cell_index, tc in enumerate(new_row.findall(f"{HP}tc")):
            addr = tc.find(f"{HP}cellAddr")
            if addr is not None:
                addr.set("rowAddr", str(new_index))
                addr.set("colAddr", str(cell_index))
            for text_node in tc.findall(f".//{HP}t"):
                text_node.text = ""
        table.element.append(new_row)
        row_elements.append(new_row)
        changed = True

    if changed:
        table.element.set("rowCnt", str(max(table.row_count, target_rows)))
        size = table.element.find(f"{HP}sz")
        if size is not None:
            try:
                current_height = int(size.get("height", "0"))
                first_cell = table.cell(0, 0)
                row_height = max(1, first_cell.height)
                size.set("height", str(max(current_height, target_rows * row_height)))
            except Exception:
                pass
        table.mark_dirty()


def copy_matching_tables(doc: Any, html_tables: list[HtmlTable]) -> int:
    target_tables = collect_hwpx_tables(doc)
    used_targets: set[int] = set()
    copied = 0

    for source_table in html_tables:
        source_rows, source_cols = html_table_dimensions(source_table)
        if source_rows == 0 or source_cols == 0:
            continue
        source_header = logical_row_text(source_table, 0, source_cols)

        best_index = -1
        best_score = 0
        for index, target_table in enumerate(target_tables):
            if index in used_targets or target_table.column_count != source_cols:
                continue
            try:
                target_header = [target_table.cell(0, col).text for col in range(target_table.column_count)]
            except Exception:
                continue
            score = table_header_score(target_header, source_header)
            has_placeholders = any("{{" in value and "}}" in value for value in target_header)
            if score > best_score or (score == 0 and has_placeholders and best_index < 0):
                best_index = index
                best_score = score if score > 0 else 1

        if best_index < 0 or best_score <= 0:
            continue

        target_table = target_tables[best_index]
        used_targets.add(best_index)
        ensure_table_rows(target_table, source_rows)
        source_layout, _source_col_count = table_layout(source_table)
        for row_index, source_row in enumerate(source_layout[:target_table.row_count]):
            for layout_cell in source_row:
                col_index = layout_cell.col_index
                if col_index >= target_table.column_count:
                    continue
                try:
                    target_table.set_cell_text(row_index, col_index, layout_cell.cell.text, logical=True)
                except Exception:
                    continue
        copied += 1

    return copied


def append_body_if_needed(
    doc: Any,
    fields: dict[str, str],
    replacements_touched: int,
    fill_result: dict[str, Any],
    copied_tables: int,
) -> int:
    body = clean_text(fields.get("body", ""))
    if not body:
        return 0
    if replacements_touched > 0 or int(fill_result.get("applied_count", 0)) > 0 or copied_tables > 0:
        return 0
    doc.add_paragraph("")
    doc.add_paragraph(body)
    return 1


def export_hwpx(input_html: Path, output: Path, template_path: Path, template_id: str) -> dict[str, Any]:
    from hwpx import HwpxDocument

    if not template_path.exists():
        raise FileNotFoundError(f"template not found: {template_path}")

    blocks = parse_html(input_html.read_text(encoding="utf-8"))
    fields, tables = extract_fields(blocks, template_id)
    replacements = build_replacements(fields)

    doc = HwpxDocument.open(template_path)
    replaced = replace_text_elements(doc, replacements)
    fill_result = fill_labeled_cells(doc, fields)
    copied_tables = copy_matching_tables(doc, tables)
    cleared = clear_unresolved_placeholders(doc)
    appended = append_body_if_needed(doc, fields, replaced, fill_result, copied_tables)

    output.parent.mkdir(parents=True, exist_ok=True)
    doc.save_to_path(output)

    return {
        "success": True,
        "engine": "python-hwpx-template",
        "templatePath": str(template_path),
        "replacedTextNodes": replaced,
        "filledCells": int(fill_result.get("applied_count", 0)),
        "failedCellFills": int(fill_result.get("failed_count", 0)),
        "copiedTables": copied_tables,
        "clearedPlaceholders": cleared,
        "appendedBody": appended,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Fill an HWPX template from exported HTML.")
    parser.add_argument("--input-html", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--template-path", required=True)
    parser.add_argument("--template-id", default="report")
    args = parser.parse_args()

    try:
        result = export_hwpx(
            input_html=Path(args.input_html),
            output=Path(args.output),
            template_path=Path(args.template_path),
            template_id=args.template_id,
        )
    except Exception as exc:  # noqa: BLE001
        result = {
            "success": False,
            "engine": "python-hwpx-template",
            "error": str(exc),
            "errorType": type(exc).__name__,
        }

    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("success") else 1


if __name__ == "__main__":
    raise SystemExit(main())
