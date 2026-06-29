#!/usr/bin/env python3
"""hwpx_xml.py — lxml-based HWPX editing engine (dependency-light core).

Replaces the fragile "decode XML → str.replace → re-encode" approach with
structure-aware tree editing. This is the single source of truth for in-place
HWPX edits; CLI subcommands (fill/edit/edit-section/fill-form) call into it.

Core guarantees (the hard-won HWPX rules):
  * run-spanning {{anchor}} replacement — joins <hp:t> across runs so an anchor
    split into multiple runs by Hancom Office still matches.
  * mandatory <hp:linesegarray> deletion after any text edit — that element is a
    stale line-layout cache; leaving it makes glyphs overlap. Hancom recomputes
    it on open.
  * sec direct-child index mapping — body paragraphs are direct children of a
    single shared <hs:sec>; callers map by index, never by text search.
  * deepcopy reference-paragraph cloning — preserves run/charPr/paraPr structure.
  * mimetype-first STORED repackaging — HWPX/EPUB zip rule.

Only dependency is lxml (already in the Anchor env). No python-hwpx.
"""
from __future__ import annotations

import copy
import re
import zipfile
from io import BytesIO
from pathlib import Path

from lxml import etree

HP_NS = "http://www.hancom.co.kr/hwpml/2011/paragraph"
HS_NS = "http://www.hancom.co.kr/hwpml/2011/section"
HH_NS = "http://www.hancom.co.kr/hwpml/2011/head"
HP = f"{{{HP_NS}}}"
HS = f"{{{HS_NS}}}"
NS = {"hp": HP_NS, "hs": HS_NS, "hh": HH_NS}

_SECTION_RE = re.compile(r"contents/section(\d+)\.xml$", re.IGNORECASE)
XML_SUFFIXES = (".xml", ".hpf")
SLOT_RE = re.compile(r"\{\{\s*([^{}\r\n]+?)\s*\}\}")


# ── low-level helpers ────────────────────────────────────────────────────────

def localname(el: etree._Element) -> str:
    tag = el.tag
    if not isinstance(tag, str):  # comment / PI / entity nodes have non-str tags
        return ""
    return etree.QName(el).localname


def parse_xml(data: bytes) -> etree._ElementTree:
    return etree.parse(BytesIO(data))


def serialize(tree: etree._ElementTree) -> bytes:
    """Serialize preserving the original XML declaration/encoding/standalone."""
    info = tree.docinfo
    return etree.tostring(
        tree,
        xml_declaration=True,
        encoding=info.encoding or "UTF-8",
        standalone=info.standalone,
    )


def find_sec(root: etree._Element) -> etree._Element:
    """Return the <hs:sec> element, or the root itself when absent."""
    for el in root.iter():
        if localname(el) == "sec":
            return el
    return root


def body_paragraphs(parent: etree._Element) -> list[etree._Element]:
    """Direct-child <hp:p> of `parent`, in document order (index-stable)."""
    return [c for c in parent if localname(c) == "p"]


def all_paragraphs(root: etree._Element) -> list[etree._Element]:
    """Every <hp:p> at any depth (incl. table cells / subList)."""
    return list(root.iter(f"{HP}p"))


def document_xml_entry_names(src: Path) -> list[str]:
    """XML/HPF entries that can be parsed and inspected structurally."""
    with zipfile.ZipFile(src) as zin:
        return [n for n in zin.namelist() if n.lower().endswith(XML_SUFFIXES)]


def t_nodes(p: etree._Element) -> list[etree._Element]:
    """All <hp:t> text nodes within a paragraph, in order."""
    return [el for el in p.iter() if localname(el) == "t"]


def paragraph_text(p: etree._Element) -> str:
    parts: list[str] = []
    for el in p.iter():
        ln = localname(el)
        if ln == "t" and el.text:
            parts.append(el.text)
        elif ln in ("lineBreak", "br"):
            parts.append("\n")
        elif ln == "tab":
            parts.append("\t")
    return "".join(parts)


def remove_linesegarray(p: etree._Element) -> int:
    """Delete every <hp:linesegarray> in/under a paragraph (stale line cache).

    MUST be called after editing a paragraph's text. Returns removed count.
    """
    targets = [el for el in p.iter() if localname(el) == "linesegarray"]
    removed = 0
    for el in targets:
        parent = el.getparent()
        if parent is not None:
            parent.remove(el)
            removed += 1
    return removed


# ── run-aware text replacement ───────────────────────────────────────────────

def replace_in_paragraph(p: etree._Element, old: str, new: str,
                         *, limit: int | None = None) -> int:
    """Replace `old`→`new` across the paragraph's <hp:t> nodes, even when `old`
    spans multiple runs. Text outside the matched span keeps its run/formatting;
    the replacement inherits the style of the run owning the anchor's start.

    Deletes the paragraph's linesegarray on any change. Returns # replaced.
    """
    if not old:
        return 0
    nodes = t_nodes(p)
    if not nodes:
        return 0
    texts = [(n.text or "") for n in nodes]
    full = "".join(texts)
    if old not in full:
        return 0

    # Collect non-overlapping match spans (left→right) on the original text.
    spans: list[tuple[int, int]] = []
    start = 0
    while True:
        i = full.find(old, start)
        if i < 0:
            break
        spans.append((i, i + len(old)))
        start = i + len(old)
        if limit is not None and len(spans) >= limit:
            break
    if not spans:
        return 0

    span_starts = {a for a, _ in spans}

    def _in_span(g: int) -> bool:
        for a, b in spans:
            if a <= g < b:
                return True
        return False

    pos = 0
    for node, txt in zip(nodes, texts):
        out: list[str] = []
        for i, ch in enumerate(txt):
            g = pos + i
            if g in span_starts:
                out.append(new)
            if not _in_span(g):
                out.append(ch)
        node.text = "".join(out)
        pos += len(txt)

    remove_linesegarray(p)
    return len(spans)


def edit_text(src: Path, dst: Path, replacements: dict[str, str],
              *, limit: int | None = None) -> dict[str, int]:
    """Apply {anchor: value} replacements across all section/header XML entries
    using run-aware, linesegarray-safe tree editing. Repackages mimetype-first.

    Returns per-anchor replacement counts.
    """
    counts = {k: 0 for k in replacements}
    remaining = limit
    overrides: dict[str, bytes] = {}

    xml_names = document_xml_entry_names(src)
    with zipfile.ZipFile(src) as zin:
        data_map = {n: zin.read(n) for n in xml_names}

    for name, data in data_map.items():
        tree = parse_xml(data)
        root = tree.getroot()
        changed = False
        for p in all_paragraphs(root):
            for old, new in replacements.items():
                if remaining == 0:
                    break
                n = replace_in_paragraph(p, old, new, limit=remaining)
                if n:
                    counts[old] += n
                    changed = True
                    if remaining is not None:
                        remaining -= n
        if changed:
            overrides[name] = serialize(tree)

    rewrite_entries(src, dst, overrides)
    return counts


def scan_slots(src: Path) -> dict[str, int]:
    """Return {{field}} counts from the same paragraph text surface edit_text uses.

    This is run-aware because paragraph_text joins <hp:t> nodes before applying
    the slot regex; it intentionally ignores raw XML text outside paragraphs.
    """
    counts: dict[str, int] = {}
    xml_names = document_xml_entry_names(src)
    with zipfile.ZipFile(src) as zin:
        data_map = {n: zin.read(n) for n in xml_names}
    for data in data_map.values():
        tree = parse_xml(data)
        for p in all_paragraphs(tree.getroot()):
            for match in SLOT_RE.finditer(paragraph_text(p)):
                key = match.group(1).strip()
                if key:
                    counts[key] = counts.get(key, 0) + 1
    return counts


# ── section-body editing (deepcopy + reverse-order) ──────────────────────────

def clone_para(ref_p: etree._Element, run_texts: list[str]) -> etree._Element:
    """Deepcopy `ref_p`, set each run's <hp:t> text from `run_texts`, drop extra
    runs, and delete the clone's linesegarray. Preserves charPr/paraPr refs.
    """
    new_p = copy.deepcopy(ref_p)
    remove_linesegarray(new_p)
    runs = [c for c in new_p if localname(c) == "run"]
    for i, txt in enumerate(run_texts):
        if i < len(runs):
            wrote = False
            for el in runs[i].iter():
                if localname(el) == "t":
                    el.text = txt if not wrote else ""
                    wrote = True
            if not wrote:  # run had no <hp:t> (e.g. empty cell run) — create one
                etree.SubElement(runs[i], f"{HP}t").text = txt
    for r in runs[len(run_texts):]:
        new_p.remove(r)
    return new_p


def replace_section_body(sec: etree._Element, start_idx: int, end_idx: int,
                         clones: list[etree._Element]) -> None:
    """Replace sec's direct children [start_idx:end_idx) with `clones`.

    Call in REVERSE order (last section block first) across a document so that
    insert/delete in one block does not shift the indices of earlier blocks.
    """
    children = list(sec)
    for child in children[start_idx:end_idx]:
        sec.remove(child)
    insert_at = start_idx
    for clone in clones:
        sec.insert(insert_at, clone)
        insert_at += 1


# ── zip (de)packaging ────────────────────────────────────────────────────────

def rewrite_entries(src: Path, dst: Path, overrides: dict[str, bytes]) -> None:
    """Copy `src` HWPX → `dst`, replacing named entries with `overrides` bytes.
    mimetype is written first and STORED; everything else DEFLATED.
    """
    with zipfile.ZipFile(src, "r") as zin:
        entries = [
            (info, overrides.get(info.filename, zin.read(info.filename)))
            for info in zin.infolist()
        ]
    dst.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(dst, "w") as zout:
        mt = next((e for e in entries if e[0].filename == "mimetype"), None)
        if mt is not None:
            zi = zipfile.ZipInfo("mimetype")
            zi.compress_type = zipfile.ZIP_STORED
            zout.writestr(zi, mt[1])
        for info, data in entries:
            if info.filename == "mimetype":
                continue
            ni = zipfile.ZipInfo(info.filename, date_time=info.date_time)
            ni.compress_type = zipfile.ZIP_DEFLATED
            ni.external_attr = info.external_attr
            zout.writestr(ni, data)


def pack_dir(src_dir: Path, dst: Path) -> None:
    """Pack an unpacked HWPX directory → .hwpx (mimetype first STORED)."""
    mimetype = src_dir / "mimetype"
    if not mimetype.is_file():
        raise FileNotFoundError(f"mimetype 없음: {mimetype} (HWPX unpack 결과 아님)")
    dst.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(dst, "w") as zf:
        zi = zipfile.ZipInfo("mimetype")
        zi.compress_type = zipfile.ZIP_STORED
        zf.writestr(zi, mimetype.read_bytes())
        for path in sorted(src_dir.rglob("*")):
            if path.is_dir() or path == mimetype:
                continue
            zf.write(path, str(path.relative_to(src_dir)),
                     compress_type=zipfile.ZIP_DEFLATED)


def section_entry_names(src: Path) -> list[str]:
    """Sorted Contents/sectionN.xml entry names in a HWPX."""
    with zipfile.ZipFile(src) as zin:
        names = [n for n in zin.namelist() if _SECTION_RE.search(n)]
    return sorted(names, key=lambda n: int(_SECTION_RE.search(n).group(1)))


def apply_heading_styles(hwpx_path: Path, levels: list[str]) -> int:
    """Give heading paragraphs visual hierarchy by re-pointing their runs to the
    larger EXISTING header charPr (H1=largest, H2/H3=next). Uses only charPr that
    are already defined in header.xml, so there is zero OWPML-schema / Hancom
    compatibility risk (no new charPr inserted, no bold/centre surgery).

    `levels` is aligned to the document's content paragraphs in order; each is
    "H1".."H6" or "P". 'P'/None paragraphs keep their default charPr. Edits
    section0.xml in place.
    Returns the number of paragraphs restyled.
    """
    sec_names = section_entry_names(hwpx_path)
    if not sec_names:
        return 0
    sec_name = sec_names[0]
    with zipfile.ZipFile(hwpx_path) as z:
        if "Contents/header.xml" not in z.namelist():
            return 0
        header = parse_xml(z.read("Contents/header.xml")).getroot()
        sec_tree = parse_xml(z.read(sec_name))

    charprs = [
        (int(e.get("id")), int(e.get("height") or 0))
        for e in header.iter()
        if localname(e) == "charPr" and (e.get("id") or "").isdigit()
    ]
    ranked = [cid for cid, _ in sorted(charprs, key=lambda x: (-x[1], x[0])) if cid != 0]
    if not ranked:
        return 0
    h_char = {
        "H1": str(ranked[0]),
        "H2": str(ranked[min(1, len(ranked) - 1)]),
        "H3": str(ranked[min(2, len(ranked) - 1)]),
    }
    for n in range(4, 7):
        h_char[f"H{n}"] = h_char["H3"]

    sec = find_sec(sec_tree.getroot())
    content = [
        p for p in body_paragraphs(sec)
        if not any(localname(e) == "secPr" for e in p.iter())
    ]
    restyled = 0
    for p, lvl in zip(content, levels):
        cid = h_char.get(lvl)
        if not cid:
            continue
        runs = [c for c in p if localname(c) == "run"]
        if not runs:
            continue
        for run in runs:
            run.set("charPrIDRef", cid)
        restyled += 1
    if restyled:
        rewrite_entries(hwpx_path, hwpx_path, {sec_name: serialize(sec_tree)})
    return restyled


# ── label-value form filling (table strategies) ─────────────────────────────

def _norm_label(s: str) -> str:
    return s.strip().rstrip(":：").strip()


def cell_text(tc: etree._Element) -> str:
    """Concatenated visible text of a table cell (<hp:tc>), incl. subList."""
    parts: list[str] = []
    for el in tc.iter():
        ln = localname(el)
        if ln == "t" and el.text:
            parts.append(el.text)
        elif ln == "tab":
            parts.append("\t")
        elif ln in ("lineBreak", "br"):
            parts.append("\n")
    return "".join(parts)


def set_cell_text(tc: etree._Element, value: str) -> bool:
    """Set a cell's value into its first paragraph's first <hp:t> (preserving
    that run's charPr), blank the remaining <hp:t> in the cell, drop linesegarray.
    Creates a <hp:t> in the first run if the cell paragraph has none (empty cell).
    Returns True if the value was written.
    """
    paras = [e for e in tc.iter() if localname(e) == "p"]
    if not paras:
        return False
    first_p = paras[0]
    t_elems = [e for e in first_p.iter() if localname(e) == "t"]
    done = False
    if t_elems:
        t_elems[0].text = value
        for t in t_elems[1:]:
            t.text = ""
        done = True
    else:
        runs = [c for c in first_p if localname(c) == "run"]
        if runs:
            t = etree.SubElement(runs[0], f"{HP}t")
            t.text = value
            done = True
    for p in paras[1:]:
        for t in [e for e in p.iter() if localname(e) == "t"]:
            t.text = ""
        remove_linesegarray(p)
    remove_linesegarray(first_p)
    return done


def fill_form(src: Path, dst: Path, values: dict[str, str]) -> tuple[list[tuple[str, str]], list[str]]:
    """Fill a form by matching labels to table cells (style preserved).

    Strategies (kordoc-derived):
      1. adjacent label|value cells — cell whose text == a provided label →
         write value into the next cell in the row.
      2. header + data rows — first row all labels → fill each data row by column.

    Label match: whitespace-trimmed, trailing colon stripped, exact (each label
    filled once). Returns (filled[(label,value)], unmatched_labels).
    """
    norm_values = {_norm_label(k): v for k, v in values.items()}
    filled: list[tuple[str, str]] = []
    matched: set[str] = set()
    overrides: dict[str, bytes] = {}

    with zipfile.ZipFile(src) as zin:
        xml_names = [
            n for n in zin.namelist()
            if n.lower().endswith(".xml") and "section" in n.lower()
        ]
        data_map = {n: zin.read(n) for n in xml_names}

    for name, data in data_map.items():
        tree = parse_xml(data)
        root = tree.getroot()
        changed = False
        for tbl in [e for e in root.iter() if localname(e) == "tbl"]:
            rows = [c for c in tbl if localname(c) == "tr"]

            # Strategy 1: adjacent label | value
            for tr in rows:
                cells = [c for c in tr if localname(c) == "tc"]
                for i in range(len(cells) - 1):
                    label = _norm_label(cell_text(cells[i]))
                    if not label or label not in norm_values or label in matched:
                        continue
                    # don't clobber a cell that is itself a known label
                    if _norm_label(cell_text(cells[i + 1])) in norm_values:
                        continue
                    if set_cell_text(cells[i + 1], norm_values[label]):
                        matched.add(label)
                        filled.append((label, norm_values[label]))
                        changed = True

            # Strategy 2: header + data rows
            if len(rows) >= 2:
                header_cells = [c for c in rows[0] if localname(c) == "tc"]
                labels = [_norm_label(cell_text(c)) for c in header_cells]
                if labels and all(labels):
                    for tr in rows[1:]:
                        data_cells = [c for c in tr if localname(c) == "tc"]
                        for ci in range(min(len(header_cells), len(data_cells))):
                            lab = labels[ci]
                            if lab in norm_values and lab not in matched:
                                if set_cell_text(data_cells[ci], norm_values[lab]):
                                    matched.add(lab)
                                    filled.append((lab, norm_values[lab]))
                                    changed = True
        if changed:
            overrides[name] = serialize(tree)

    rewrite_entries(src, dst, overrides)
    unmatched = [k for k in norm_values if k not in matched]
    return filled, unmatched
