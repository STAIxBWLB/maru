#!/usr/bin/env python3
"""Markdown -> PDF via HTML print (Chrome headless).

Outgoing-PDF path for share-outbox: renders Markdown to HTML with a print
stylesheet, then prints it with Chrome headless. Browser print paginates
tables row-by-row with repeating header rows, unlike the hwp-cli PDF
renderer, which silently drops every table row after a page boundary.

Runs on the bundled env's markdown-it-py (no python-markdown dependency).
Supported syntax: CommonMark + tables + strikethrough. Footnotes and task
lists are NOT rendered (plugins not bundled) and pass through as raw text.
A leading YAML frontmatter block is stripped before rendering so internal
metadata never reaches an outgoing document.

Usage:
  md_to_pdf_chrome.py <src.md> -o <out.pdf> [--title T] [--chrome BIN]
                      [--keep-html]
"""
from __future__ import annotations

import argparse
import html
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from markdown_it import MarkdownIt

CHROME_TIMEOUT_S = 120

# Print CSS baseline. Load-bearing rules: thead repeats on every page,
# tr never splits across pages, keep-all keeps Korean words unbroken.
CSS = """
@page { size: A4; margin: 18mm 15mm 16mm 15mm; }
* { box-sizing: border-box; }
body { font-family: "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR",
       "Noto Sans CJK KR", sans-serif;
       font-size: 9.5pt; line-height: 1.5; color: #111; margin: 0;
       word-break: keep-all; }
h1 { font-size: 17pt; text-align: center; margin: 0 0 14pt; }
h2 { font-size: 12.5pt; margin: 16pt 0 6pt; border-left: 4px solid #1a4f8b;
     padding-left: 7px; page-break-after: avoid; }
h3 { font-size: 10.5pt; margin: 10pt 0 4pt; page-break-after: avoid; }
p, li { margin: 3pt 0; }
ul, ol { padding-left: 16pt; margin: 4pt 0; }
table { width: 100%; border-collapse: collapse; margin: 6pt 0 10pt;
        font-size: 8.6pt; }
thead { display: table-header-group; }
tr { page-break-inside: avoid; }
th { background: #eef2f7; border: 0.6pt solid #555; padding: 3.5pt 4pt;
     text-align: center; font-weight: 700; }
td { border: 0.6pt solid #777; padding: 3.5pt 4pt; vertical-align: middle; }
td:first-child { white-space: nowrap; font-weight: 600; text-align: center; }
blockquote { margin: 4pt 0; padding: 2pt 8px; border-left: 3px solid #999;
             color: #333; }
code { font-family: Menlo, Consolas, monospace; font-size: 0.95em; }
"""

CHROME_CANDIDATES = (
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "google-chrome",
    "chromium",
    "chromium-browser",
)


def resolve_binary(cand: str) -> str | None:
    if os.path.sep in cand:
        return cand if os.path.isfile(cand) and os.access(cand, os.X_OK) else None
    return shutil.which(cand)


def find_chrome(explicit: str | None) -> str | None:
    """Resolve the browser binary. An explicit --chrome that does not resolve
    is an error (no silent fallback to a different browser)."""
    if explicit:
        return resolve_binary(explicit)
    for cand in filter(None, (os.environ.get("CHROME_BIN"), *CHROME_CANDIDATES)):
        found = resolve_binary(cand)
        if found:
            return found
    return None


def strip_frontmatter(text: str) -> str:
    """Drop a leading YAML frontmatter block (internal metadata)."""
    return re.sub(r"\A---\n.*?\n---\n", "", text, count=1, flags=re.S)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("source", type=Path, help="markdown source file")
    ap.add_argument("-o", "--output", type=Path, required=True, help="PDF output path")
    ap.add_argument("--title", help="HTML <title> (default: first H1 or file stem)")
    ap.add_argument("--chrome", help="Chrome/Chromium binary (default: auto-detect)")
    ap.add_argument("--keep-html", action="store_true", help="keep the intermediate HTML")
    args = ap.parse_args()

    if not args.source.is_file():
        print(f"error: source not found: {args.source}", file=sys.stderr)
        return 2

    chrome = find_chrome(args.chrome)
    if not chrome:
        if args.chrome:
            print(f"error: --chrome not executable: {args.chrome}", file=sys.stderr)
        else:
            print(
                "error: Chrome/Chromium not found. Pass --chrome or set CHROME_BIN.\n"
                "fallback: convert to docx/hwpx first and print with LibreOffice "
                "(see references/pdf-print-path.md)",
                file=sys.stderr,
            )
        return 2

    md_text = strip_frontmatter(args.source.read_text(encoding="utf-8-sig"))
    title = args.title
    if not title:
        m = re.search(r"^#\s+(.+)$", md_text, flags=re.M)
        title = m.group(1).strip() if m else args.source.stem

    body = MarkdownIt("commonmark").enable(["table", "strikethrough"]).render(md_text)
    doc = (
        f'<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">'
        f"<title>{html.escape(title)}</title><style>{CSS}</style></head>"
        f"<body>{body}</body></html>"
    )
    fd, tmp_name = tempfile.mkstemp(suffix=".html", prefix="md2pdf-")
    html_path = Path(tmp_name)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(doc)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        chrome,
        "--headless",
        "--disable-gpu",
        "--no-pdf-header-footer",
        f"--print-to-pdf={args.output}",
        html_path.resolve().as_uri(),
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=CHROME_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        print(f"error: Chrome timed out after {CHROME_TIMEOUT_S}s (HTML kept: {html_path})",
              file=sys.stderr)
        return 1
    if proc.returncode != 0 or not args.output.exists():
        # keep the HTML for debugging on failure
        print(proc.stderr.strip() or f"error: Chrome print failed (HTML kept: {html_path})",
              file=sys.stderr)
        return proc.returncode or 1
    if args.keep_html:
        print(f"html: {html_path}", file=sys.stderr)
    else:
        html_path.unlink(missing_ok=True)
    print(args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
