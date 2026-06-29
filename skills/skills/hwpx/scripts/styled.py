"""Styled HWPX reference-template filler.

`--reference` 슬롯 채우기(raw ZIP/XML, lxml 엔진)만 담당한다. 프리셋 생성은
hwp-cli `new --preset`로 위임됐고(hwpx_cli.cmd_styled), 번들 Java writer는 제거됨.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable


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
        raise RuntimeError(
            f"참조 템플릿에서 일치하는 슬롯이 없음: {source} "
            "(본문/제목 슬롯 {{본문}}/{{제목}} 등이 단일 런으로 있는지 확인)"
        )
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
