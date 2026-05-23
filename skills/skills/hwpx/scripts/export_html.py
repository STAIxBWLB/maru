"""hwpx export-html - cascade fallback HTML -> HWPX exporter.

Direct port of tidy's `document:export-hwp` IPC handler
(<workspace-root>/dev/tidy/app/electron/ipc-handlers.js:2756–2807).

Stages (each tried in order; first success returns):
  1. bundled Java writer - flat HTML -> text-block -> HwpxWriter
  2. pypandoc-hwpx CLI / module (if installed)

Stage 1 in this MVP is a simple flattener (block tags → H1:/H2:/P: lines).
The richer table/style preservation logic (htmlToHwpxBlocks +
rewriteHwpxWithBlocks, ~1500 LOC of JS in tidy) is intentionally NOT ported in
this pass.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from html.parser import HTMLParser
from pathlib import Path

from runtime_paths import VENV_PY, assert_jre
from write_java import write_java


# ─── Stage 1: HTML -> flat text blocks ───────────────────────────────────

_HEADING_TAGS = {"h1": 1, "h2": 2, "h3": 3, "h4": 4, "h5": 5, "h6": 6}
_BLOCK_TAGS = {"p", "li", "blockquote", "div", "section", "article"}
_SKIP_TAGS = {"script", "style", "head", "meta", "link", "title"}


class _Flattener(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.lines: list[str] = []
        self._buf: list[str] = []
        self._tag_stack: list[str] = []
        self._skip_depth = 0

    def _flush(self, prefix: str = "P:") -> None:
        text = re.sub(r"\s+", " ", "".join(self._buf)).strip()
        self._buf.clear()
        if text:
            self.lines.append(f"{prefix}{text}")

    def handle_starttag(self, tag: str, attrs) -> None:
        tag = tag.lower()
        if tag in _SKIP_TAGS:
            self._skip_depth += 1
            return
        self._tag_stack.append(tag)
        if tag == "br":
            self._flush()
        elif tag in _HEADING_TAGS or tag in _BLOCK_TAGS:
            self._flush()

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in _SKIP_TAGS:
            self._skip_depth = max(0, self._skip_depth - 1)
            return
        if tag in _HEADING_TAGS:
            self._flush(f"H{_HEADING_TAGS[tag]}:")
        elif tag in _BLOCK_TAGS:
            self._flush()
        if self._tag_stack and self._tag_stack[-1] == tag:
            self._tag_stack.pop()

    def handle_data(self, data: str) -> None:
        if self._skip_depth:
            return
        self._buf.append(data)

    def close(self) -> None:  # type: ignore[override]
        super().close()
        self._flush()


def html_to_lines(html: str) -> list[str]:
    p = _Flattener()
    p.feed(html)
    p.close()
    return p.lines or ["P:"]


# ─── Cascade ─────────────────────────────────────────────────────────────

def _try_bundled(html: str, out: Path) -> tuple[bool, str]:
    try:
        assert_jre()
        write_java(out, html_to_lines(html))
        return True, ""
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"


def _try_pypandoc(html_path: Path, out: Path) -> tuple[bool, str]:
    cli = shutil.which("pypandoc-hwpx")
    if cli:
        proc = subprocess.run([cli, str(html_path), "-o", str(out)], capture_output=True)
        if proc.returncode == 0 and out.exists() and out.stat().st_size > 0:
            return True, ""
    if VENV_PY.exists():
        proc = subprocess.run(
            [str(VENV_PY), "-m", "pypandoc_hwpx.cli", str(html_path), "-o", str(out)],
            capture_output=True,
        )
        if proc.returncode == 0 and out.exists() and out.stat().st_size > 0:
            return True, ""
    return False, "pypandoc-hwpx not available"


def export_html(html_path: Path, out: Path, template_id: str = "report") -> dict:
    html = html_path.read_text(encoding="utf-8")
    out.parent.mkdir(parents=True, exist_ok=True)

    ok, err1 = _try_bundled(html, out)
    if ok:
        return {"engine": "bundled-hwpx-java", "output": str(out)}

    ok, err2 = _try_pypandoc(html_path, out)
    if ok:
        return {
            "engine": "pypandoc-hwpx",
            "output": str(out),
            "bundled_error": err1,
        }

    raise RuntimeError(
        "all engines failed:\n"
        f"  bundled-java : {err1}\n"
        f"  pypandoc    : {err2}"
    )


def cli_export_html(args: argparse.Namespace) -> int:
    html_path = Path(args.input)
    out = Path(args.output)
    if not html_path.exists():
        print(f"[hwpx] HTML 파일 없음: {html_path}", file=sys.stderr)
        return 1
    try:
        result = export_html(html_path, out, args.template_id)
    except RuntimeError as e:
        print(f"[hwpx] export-html 실패:\n{e}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def add_subparser(sub) -> None:
    s = sub.add_parser(
        "export-html",
        help="HTML -> HWPX (bundled Java -> pypandoc cascade)",
    )
    s.add_argument("input", help="입력 .html 파일")
    s.add_argument("output", help="출력 .hwpx 파일")
    s.add_argument(
        "--template-id",
        default="report",
        choices=("report", "gongmun", "minutes", "proposal", "notice"),
        help="호환 옵션. 현재 bundled Java/pypandoc 경로에서는 사용하지 않음",
    )
    s.set_defaults(func=cli_export_html)
