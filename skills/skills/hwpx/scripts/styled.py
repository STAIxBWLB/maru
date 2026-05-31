"""Styled HWPX document builder.

This module intentionally uses only repo-local code:
  - bundled Java writer for fresh HWPX generation
  - raw ZIP/XML slot replacement for reference templates

The public CLI keeps the old `styled` shape, but no commercial-use-restricted
Python HWPX package is imported at runtime.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

from write_java import write_java


XML_SUFFIXES = (".xml", ".hpf")
COMMON_BODY_KEYS = ("본문", "내용", "BODY", "CONTENT", "body", "content")
COMMON_TITLE_KEYS = ("제목", "문서제목", "TITLE", "DOCUMENT_TITLE", "title")


@dataclass
class Block:
    kind: str  # title | subtitle | heading | para | separator
    text: str = ""
    level: int = 0
    align: str = "LEFT"
    items: list = field(default_factory=list)


def title(text: str) -> Block:
    return Block("title", text=text, align="CENTER")


def subtitle(text: str) -> Block:
    return Block("subtitle", text=text, align="CENTER")


def heading(text: str, level: int = 1) -> Block:
    return Block("heading", text=text, level=level)


def para(text: str, align: str = "LEFT") -> Block:
    return Block("para", text=text, align=align)


def separator() -> Block:
    return Block("separator")


def _block_lines(blocks: Iterable[Block], *, header: str | None = None, footer: str | None = None) -> list[str]:
    lines: list[str] = []
    if header:
        lines.append(f"P:{header}")
        lines.append("P:")
    for block in blocks:
        if block.kind == "title":
            lines.append(f"H1:{block.text}")
        elif block.kind == "subtitle":
            lines.append(f"H2:{block.text}")
        elif block.kind == "heading":
            level = max(1, min(6, int(block.level or 1)))
            lines.append(f"H{level}:{block.text}")
        elif block.kind == "separator":
            lines.append("P:")
        else:
            text = block.text or ""
            split = text.splitlines() or [""]
            lines.extend(f"P:{line}" if line else "P:" for line in split)
    if footer and footer.lower() != "none":
        lines.append("P:")
        lines.append(f"P:{footer}")
    return lines or ["P:"]


def _block_title(blocks: list[Block]) -> str:
    for block in blocks:
        if block.kind in {"title", "subtitle", "heading"} and block.text.strip():
            return block.text.strip()
    for block in blocks:
        if block.text.strip():
            return block.text.strip().splitlines()[0]
    return ""


def _block_text(blocks: list[Block]) -> str:
    lines: list[str] = []
    for block in blocks:
        if block.kind == "separator":
            lines.append("")
        elif block.text:
            lines.extend(block.text.splitlines() or [block.text])
    return "\n".join(lines).strip()


def _rewrite_template_slots(template: Path, output: Path, replacements: dict[str, str]) -> int:
    """Run-aware {{slot}} substitution via the shared lxml engine.

    Delegates to hwpx_xml.edit_text so an anchor split across multiple runs still
    matches and stale linesegarray caches are cleaned — identical robustness to
    `hwpx fill`. Returns the total number of replacements (0 → the caller falls
    back to fresh generation).
    """
    import hwpx_xml as hx

    anchored = {"{{" + key + "}}": value for key, value in replacements.items()}
    counts = hx.edit_text(template, output, anchored)
    return sum(counts.values())


def from_preset(
    blocks: Iterable[Block],
    preset_name: str = "gongmun",
    output: str | Path = "out.hwpx",
    header: str | None = None,
    footer: str | None = "- # / ## -",
) -> Path:
    if preset_name not in {"gongmun", "bogoseo"}:
        raise ValueError("unknown preset: " + preset_name)
    out = Path(output)
    write_java(out, _block_lines(list(blocks), header=header, footer=footer))
    return out


def follow_template(
    blocks: Iterable[Block],
    reference: str | Path,
    output: str | Path,
    header: str | None = None,
    footer: str | None = None,
) -> Path:
    source = Path(reference)
    if not source.is_file():
        raise FileNotFoundError(source)

    block_list = list(blocks)
    body = _block_text(block_list)
    title_text = _block_title(block_list)
    body_with_extras = body
    if header:
        body_with_extras = f"{header}\n\n{body_with_extras}".strip()
    if footer and footer.lower() != "none":
        body_with_extras = f"{body_with_extras}\n\n{footer}".strip()

    replacements: dict[str, str] = {}
    for key in COMMON_BODY_KEYS:
        replacements[key] = body_with_extras
    for key in COMMON_TITLE_KEYS:
        replacements[key] = title_text

    out = Path(output)
    hits = _rewrite_template_slots(source, out, replacements)
    if hits == 0:
        write_java(out, _block_lines(block_list, header=header, footer=footer))
    return out


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
