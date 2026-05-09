"""Styled HWPX document builder.

Produces polished Korean-official-document HWPX files:
  - A4 margins per 공문서 규정 (top 30 / bottom 15 / left 20 / right 15 mm)
  - Line spacing 160%
  - Preset styles: 'gongmun' (맑은 고딕 11.5pt) | 'bogoseo' (함초롬바탕 15pt)
  - Header / footer with page numbers

Two modes:
  1. from_preset(blocks, preset_name=...) — fresh doc, preset styles
  2. follow_template(blocks, reference=...) — keep reference's styles, replace body

Implementation notes (python-hwpx v2.5 quirks):
  - charPr registration uses doc.oxml.headers[0].ensure_char_property(modifier=...)
    with an lxml-based modifier (stdlib ET.SubElement fails on lxml elements).
  - paraPr registration is manual lxml edits on hdr.element + mark_dirty().
  - set_header_text / set_footer_text are broken in v2.5 → we inject <hp:header>
    and <hp:footer> directly into section's <hp:secPr>.
  - The blank document's <hp:secPr> (page size/margins) is embedded in the first
    paragraph's first run. We preserve it by moving it into the new first
    paragraph before removing the original blank one.
"""
from __future__ import annotations

import logging
import re
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

logging.getLogger("hwpx").setLevel(logging.ERROR)

from lxml import etree  # noqa: E402

from hwpx import HwpxDocument  # noqa: E402

# ─── Namespaces ──────────────────────────────────────────────────────────

NS = {
    "hp": "http://www.hancom.co.kr/hwpml/2011/paragraph",
    "hh": "http://www.hancom.co.kr/hwpml/2011/head",
    "hs": "http://www.hancom.co.kr/hwpml/2011/section",
    "hc": "http://www.hancom.co.kr/hwpml/2011/core",
}
HP = "{%s}" % NS["hp"]
HH = "{%s}" % NS["hh"]


def mm(value: float) -> int:
    """mm → HWPUNIT."""
    return int(round(value * 283.464566929))


def pt_to_hu(pt: float) -> int:
    """pt → charPr height (1/100 pt)."""
    return int(round(pt * 100))


# ─── Content model ───────────────────────────────────────────────────────

@dataclass
class Block:
    kind: str  # title | subtitle | heading | para | separator
    text: str = ""
    level: int = 0
    align: str = "LEFT"
    items: list = field(default_factory=list)


def title(text: str) -> Block: return Block("title", text=text, align="CENTER")
def subtitle(text: str) -> Block: return Block("subtitle", text=text, align="CENTER")
def heading(text: str, level: int = 1) -> Block: return Block("heading", text=text, level=level)
def para(text: str, align: str = "LEFT") -> Block: return Block("para", text=text, align=align)
def separator() -> Block: return Block("separator")


# ─── Style presets ───────────────────────────────────────────────────────

@dataclass
class Preset:
    name: str
    hangul_font: str
    latin_font: str
    body_pt: float
    title_pt: float
    subtitle_pt: float
    heading_pts: tuple
    line_spacing_pct: int = 160
    margins_mm: tuple = (30, 15, 20, 15)  # top / bottom / left / right
    header_mm: float = 15.0
    footer_mm: float = 15.0


PRESETS: dict[str, Preset] = {
    # Note: python-hwpx v2.5 strips font additions from header.xml on save
    # (keeps only the two built-in fonts per language). We therefore map
    # to font IDs 0 (함초롬돋움, sans-style) and 1 (함초롬바탕, myungjo-style).
    # A post-save patch (_post_save_register_fonts) then rewrites the zip to
    # substitute the actual font face name. Users can change fonts in
    # Hancom Office via 서식 → 글자 모양 if their institution requires a
    # different typeface.
    "gongmun": Preset(
        # 공문·기안문 현행 표준: 맑은 고딕 계열 (맑은고딕 → 함초롬돋움 자리 id=0)
        name="gongmun",
        hangul_font="맑은 고딕", latin_font="Malgun Gothic",
        body_pt=11.5, title_pt=16.0, subtitle_pt=13.0,
        heading_pts=(13.0, 12.0, 11.5),
    ),
    "bogoseo": Preset(
        # 보고서/사업계획서: 함초롬바탕 (id=1)
        name="bogoseo",
        hangul_font="함초롬바탕", latin_font="Times New Roman",
        body_pt=15.0, title_pt=22.0, subtitle_pt=18.0,
        heading_pts=(17.0, 16.0, 15.0),
    ),
}

# Mapping from preset name → default font ID slot in the library's blank doc
# gongmun wants a gothic-like face (slot 0 = 함초롬돋움)
# bogoseo wants a myungjo-like face (slot 1 = 함초롬바탕)
_PRESET_TO_SLOT = {"gongmun": 0, "bogoseo": 1}


# ─── Helpers ─────────────────────────────────────────────────────────────

def _obj_id() -> str:
    return str(uuid.uuid4().int % 10_000_000_000).zfill(10)


def _find_by_localname(root: etree._Element, localname: str) -> etree._Element | None:
    for el in root.iter():
        if etree.QName(el.tag).localname == localname:
            return el
    return None


# ─── Style registration (via library's ensure_* API) ─────────────────────

class _StyleRegistrar:
    """Batch style additions to header.xml using the library's oxml API."""

    def __init__(self, doc: HwpxDocument):
        self.doc = doc
        self.header = doc.oxml.headers[0]

    def register_font(self, face: str, lang: str = "HANGUL") -> int:
        """Return existing font id matching `face`, else return 0 as fallback.

        NOTE: Adding new fonts via the oxml model does not persist in v2.5
        (the library re-serializes fonts from its own internal table). Callers
        should rely on `_post_save_rewrite_fonts()` to substitute face names
        after the library saves.
        """
        root = self.header.element
        for group in root.iter(HH + "fontFaces"):
            if group.get("lang") == lang:
                fonts = group.findall(HH + "font")
                for i, f in enumerate(fonts):
                    if f.get("face") == face:
                        return i
                return 0
        return 0

    def register_char_pr(self, pt: float, *, bold: bool = False,
                         hangul_font_id: int = 1, latin_font_id: int = 1,
                         color: str = "#000000") -> int:
        """Register a new charPr via ensure_char_property (persists on save)."""
        height = pt_to_hu(pt)

        def modifier(el: etree._Element) -> None:
            el.set("height", str(height))
            el.set("textColor", color)
            fr = el.find(HH + "fontRef")
            if fr is not None:
                fr.set("hangul", str(hangul_font_id))
                fr.set("latin", str(latin_font_id))
                fr.set("hanja", str(hangul_font_id))
                fr.set("other", str(hangul_font_id))
            for b in el.findall(HH + "bold"):
                el.remove(b)
            if bold:
                etree.SubElement(el, HH + "bold")

        def predicate(el: etree._Element) -> bool:
            # Reuse if identical
            if el.get("height") != str(height):
                return False
            if el.get("textColor") != color:
                return False
            has_bold = el.find(HH + "bold") is not None
            if has_bold != bold:
                return False
            fr = el.find(HH + "fontRef")
            if fr is None or fr.get("hangul") != str(hangul_font_id):
                return False
            return True

        new = self.header.ensure_char_property(
            base_char_pr_id=0, predicate=predicate, modifier=modifier
        )
        return int(new.get("id"))

    def register_para_pr(self, align: str = "LEFT",
                         line_spacing_pct: int = 160) -> int:
        """Clone paraPr id=0, set alignment + line spacing, append to paraProperties."""
        root = self.header.element
        container = _find_by_localname(root, "paraProperties")
        if container is None:
            return 0
        existing = container.findall(HH + "paraPr")

        # Try to find a matching one first
        for el in existing:
            align_el = el.find(HH + "align")
            ls_el = el.find(HH + "lineSpacing")
            if (align_el is not None and align_el.get("horizontal") == align
                    and ls_el is not None
                    and ls_el.get("value") == str(line_spacing_pct)
                    and ls_el.get("type") == "PERCENT"):
                return int(el.get("id"))

        # Clone first paraPr (deep copy), adjust
        from copy import deepcopy
        template = existing[0]
        new = deepcopy(template)
        new_id = str(len(existing))
        new.set("id", new_id)
        a = new.find(HH + "align")
        if a is not None:
            a.set("horizontal", align)
        ls = new.find(HH + "lineSpacing")
        if ls is not None:
            ls.set("type", "PERCENT")
            ls.set("value", str(line_spacing_pct))
            ls.set("unit", "HWPUNIT")
        container.append(new)
        container.set("itemCnt", str(len(existing) + 1))
        self.header.mark_dirty()
        return int(new_id)


# ─── Body replacement preserving secPr ──────────────────────────────────

def _replace_body_keeping_secpr(doc: HwpxDocument, section, blocks: list[Block], *,
                                para_ids: dict[str, int],
                                char_ids: dict[str, int]) -> None:
    """Replace section body while preserving the <hp:secPr> embedded in the
    first original paragraph's first run (HWPX convention)."""
    original = list(section.paragraphs)

    # Extract secPr from first original paragraph's first run (if present)
    secPr_el = None
    if original:
        first = original[0].element
        first_run = first.find(HP + "run")
        if first_run is not None:
            secPr_el = first_run.find(HP + "secPr")
            if secPr_el is not None:
                first_run.remove(secPr_el)

    # Append all new blocks
    added = []
    for block in blocks:
        if block.kind == "separator" or (block.kind == "para" and not block.text.strip()):
            p = doc.add_paragraph("", section=section,
                                  para_pr_id_ref=para_ids["LEFT"],
                                  char_pr_id_ref=char_ids["body"],
                                  style_id_ref=0)
        elif block.kind == "title":
            p = doc.add_paragraph(block.text, section=section,
                                  para_pr_id_ref=para_ids["CENTER"],
                                  char_pr_id_ref=char_ids["title"],
                                  style_id_ref=0)
        elif block.kind == "subtitle":
            p = doc.add_paragraph(block.text, section=section,
                                  para_pr_id_ref=para_ids["CENTER"],
                                  char_pr_id_ref=char_ids["subtitle"],
                                  style_id_ref=0)
        elif block.kind == "heading":
            key = {1: "h1", 2: "h2", 3: "h3"}.get(block.level, "h3")
            p = doc.add_paragraph(block.text, section=section,
                                  para_pr_id_ref=para_ids["LEFT"],
                                  char_pr_id_ref=char_ids[key],
                                  style_id_ref=0)
        else:  # para
            align = block.align if block.align in para_ids else "LEFT"
            p = doc.add_paragraph(block.text, section=section,
                                  para_pr_id_ref=para_ids[align],
                                  char_pr_id_ref=char_ids["body"],
                                  style_id_ref=0)
        added.append(p)

    # Inject secPr into the new first paragraph's first run
    if added and secPr_el is not None:
        new_first_run = added[0].element.find(HP + "run")
        if new_first_run is not None:
            new_first_run.insert(0, secPr_el)

    # Remove originals
    for p in original:
        try:
            doc.remove_paragraph(p)
        except ValueError:
            pass  # last-paragraph guard, shouldn't trigger


# ─── Header / footer injection ──────────────────────────────────────────

def _inject_header_or_footer(section, kind: str, text: str,
                             paraPrIDRef: int, charPrIDRef: int) -> None:
    """Inject <hp:header> / <hp:footer> into the section's <hp:secPr>.

    The secPr lives inside the first paragraph's first run. Find it via lookup.
    """
    assert kind in ("header", "footer")

    # Find secPr inside section
    secPr = None
    for para in section.paragraphs:
        first_run = para.element.find(HP + "run")
        if first_run is None:
            continue
        secPr = first_run.find(HP + "secPr")
        if secPr is not None:
            break
    if secPr is None:
        return  # no secPr to attach header/footer to

    # Remove existing
    for existing in secPr.findall(HP + kind):
        secPr.remove(existing)

    element = etree.SubElement(secPr, HP + kind, attrib={
        "id": _obj_id(),
        "applyPageType": "BOTH",
    })
    subList = etree.SubElement(element, HP + "subList", attrib={
        "id": "",
        "textDirection": "HORIZONTAL",
        "lineWrap": "BREAK",
        "vertAlign": "TOP",
        "linkListIDRef": "0",
        "linkListNextIDRef": "0",
        "textWidth": "0",
        "textHeight": "0",
        "hasTextRef": "0",
        "hasNumRef": "0",
    })
    p = etree.SubElement(subList, HP + "p", attrib={
        "id": _obj_id(),
        "paraPrIDRef": str(paraPrIDRef),
        "styleIDRef": "0",
        "pageBreak": "0",
        "columnBreak": "0",
        "merged": "0",
    })
    run = etree.SubElement(p, HP + "run", attrib={"charPrIDRef": str(charPrIDRef)})

    # Text rendering: `#` / `##` are placeholders. Hancom users can convert
    # to dynamic page fields via UI. LibreOffice H2Orestart renders literal.
    parts = re.split(r"(##|#)", text) if text else [""]
    for segment in parts:
        if segment:
            t = etree.SubElement(run, HP + "t")
            t.text = segment
    if not parts:  # empty text edge case
        etree.SubElement(run, HP + "t").text = ""

    section.mark_dirty()


# ─── Public entry points ────────────────────────────────────────────────

def from_preset(
    blocks: Iterable[Block],
    preset_name: str = "gongmun",
    output: str | Path = "out.hwpx",
    header: str | None = None,
    footer: str | None = "- # / ## -",
) -> Path:
    preset = PRESETS.get(preset_name)
    if preset is None:
        raise ValueError(f"unknown preset: {preset_name} (options: {list(PRESETS)})")

    doc = HwpxDocument.new()
    sec = list(doc.sections)[0]

    # Page setup
    top, bot, left, right = preset.margins_mm
    sec.properties.set_page_margins(
        top=mm(top), bottom=mm(bot), left=mm(left), right=mm(right),
        header=mm(preset.header_mm), footer=mm(preset.footer_mm), gutter=0,
    )

    # Style registration
    reg = _StyleRegistrar(doc)
    # Map preset to existing font slot (see PRESETS docstring)
    hangul_id = _PRESET_TO_SLOT.get(preset.name, 0)
    latin_id = _PRESET_TO_SLOT.get(preset.name, 0)

    char_ids = {
        "body": reg.register_char_pr(preset.body_pt, bold=False,
                                     hangul_font_id=hangul_id, latin_font_id=latin_id),
        "title": reg.register_char_pr(preset.title_pt, bold=True,
                                      hangul_font_id=hangul_id, latin_font_id=latin_id),
        "subtitle": reg.register_char_pr(preset.subtitle_pt, bold=True,
                                         hangul_font_id=hangul_id, latin_font_id=latin_id),
        "h1": reg.register_char_pr(preset.heading_pts[0], bold=True,
                                   hangul_font_id=hangul_id, latin_font_id=latin_id),
        "h2": reg.register_char_pr(preset.heading_pts[1], bold=True,
                                   hangul_font_id=hangul_id, latin_font_id=latin_id),
        "h3": reg.register_char_pr(preset.heading_pts[2], bold=False,
                                   hangul_font_id=hangul_id, latin_font_id=latin_id),
        "small": reg.register_char_pr(preset.body_pt * 0.85, bold=False,
                                      hangul_font_id=hangul_id, latin_font_id=latin_id),
    }
    para_ids = {
        "LEFT": reg.register_para_pr("LEFT", preset.line_spacing_pct),
        "CENTER": reg.register_para_pr("CENTER", preset.line_spacing_pct),
        "RIGHT": reg.register_para_pr("RIGHT", preset.line_spacing_pct),
        "JUSTIFY": reg.register_para_pr("JUSTIFY", preset.line_spacing_pct),
    }
    para_tight_center = reg.register_para_pr("CENTER", 100)

    # Body
    _replace_body_keeping_secpr(doc, sec, list(blocks),
                                para_ids=para_ids, char_ids=char_ids)

    # Header / footer (must come after body replacement — they attach to secPr
    # which is now inside the new first paragraph)
    if header:
        _inject_header_or_footer(sec, "header", header,
                                 paraPrIDRef=para_tight_center,
                                 charPrIDRef=char_ids["small"])
    if footer:
        _inject_header_or_footer(sec, "footer", footer,
                                 paraPrIDRef=para_tight_center,
                                 charPrIDRef=char_ids["small"])

    output = Path(output)
    doc.save_to_path(output)
    _post_save_rewrite_fonts(output, preset)
    return output


def follow_template(
    blocks: Iterable[Block],
    reference: str | Path,
    output: str | Path,
    header: str | None = None,
    footer: str | None = None,
) -> Path:
    doc = HwpxDocument.open(str(reference))
    sec = list(doc.sections)[0]

    # Minimal paraPr for alignment; reuse default charPr (id=0)
    reg = _StyleRegistrar(doc)
    para_ids = {
        "LEFT": 0,
        "CENTER": reg.register_para_pr("CENTER", 160),
        "RIGHT": reg.register_para_pr("RIGHT", 160),
        "JUSTIFY": 0,
    }
    para_tight_center = reg.register_para_pr("CENTER", 100)
    char_ids = {k: 0 for k in ["body", "title", "subtitle", "h1", "h2", "h3", "small"]}

    _replace_body_keeping_secpr(doc, sec, list(blocks),
                                para_ids=para_ids, char_ids=char_ids)

    if header:
        _inject_header_or_footer(sec, "header", header,
                                 paraPrIDRef=para_tight_center, charPrIDRef=0)
    if footer:
        _inject_header_or_footer(sec, "footer", footer,
                                 paraPrIDRef=para_tight_center, charPrIDRef=0)

    output = Path(output)
    doc.save_to_path(output)
    # For follow_template we don't force a preset font — we leave the reference
    # file's fonts intact. Callers who want to override can re-run from_preset.
    return output


# ─── Post-save font rewrite ──────────────────────────────────────────────

def _post_save_rewrite_fonts(path: Path, preset: Preset) -> None:
    """Rewrite the saved HWPX's header.xml to substitute font face names.

    python-hwpx v2.5 keeps only the library's built-in fonts on save. We
    re-open the zip, modify header.xml's `<hh:font face="...">` entries to
    use the preset's fonts, and rewrite. Mimetype-first STORED is preserved.
    """
    import zipfile
    import shutil
    import tempfile

    with tempfile.TemporaryDirectory() as td:
        work = Path(td) / "unpacked"
        work.mkdir()
        with zipfile.ZipFile(path) as zf:
            zf.extractall(work)

        header_file = work / "Contents" / "header.xml"
        if not header_file.is_file():
            return
        tree = etree.parse(str(header_file))
        root = tree.getroot()

        slot = _PRESET_TO_SLOT.get(preset.name, 0)
        # Library lowercases tag names on serialize (`fontface`, `fontfaces`).
        # Walk and match by localname, case-insensitive.
        for el in list(root.iter()):
            localname = etree.QName(el.tag).localname
            if localname.lower() != "fontface":
                continue
            lang = el.get("lang")
            target = preset.hangul_font if lang == "HANGUL" else preset.latin_font
            if not target:
                continue
            for font in el:
                if etree.QName(font.tag).localname.lower() != "font":
                    continue
                if font.get("id") == str(slot):
                    font.set("face", target)

        tree.write(
            str(header_file),
            encoding="utf-8",
            xml_declaration=True,
            standalone=True,
        )

        # Repack: mimetype first, STORED; rest DEFLATED
        tmp_out = path.with_suffix(".hwpx.tmp")
        with zipfile.ZipFile(tmp_out, "w") as zf:
            info = zipfile.ZipInfo("mimetype")
            info.compress_type = zipfile.ZIP_STORED
            zf.writestr(info, (work / "mimetype").read_bytes())
            for p in sorted(work.rglob("*")):
                if p.is_dir() or p.name == "mimetype":
                    continue
                arcname = str(p.relative_to(work))
                zf.write(p, arcname, compress_type=zipfile.ZIP_DEFLATED)
        shutil.move(tmp_out, path)


# ─── Simple markdown parser ─────────────────────────────────────────────

_MD_HEAD = re.compile(r"^(#{1,3})\s+(.*)")


def markdown_to_blocks(md: str) -> list[Block]:
    """# Title | ## H1 | ### H2 | --- sep | blank line sep | else: para."""
    blocks: list[Block] = []
    for line in md.splitlines():
        stripped = line.rstrip()
        if not stripped or stripped == "---":
            blocks.append(separator())
            continue
        m = _MD_HEAD.match(stripped)
        if m:
            hashes, text = m.groups()
            level = len(hashes)
            blocks.append(title(text) if level == 1 else heading(text, level=level - 1))
            continue
        blocks.append(para(line))
    return blocks
