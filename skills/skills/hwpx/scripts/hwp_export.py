#!/usr/bin/env python3
"""hwp_export.py — HWP/HWPX → PDF / HTML via hwp-cli.

These are the migration shims for the two output formats hwp-cli (Rust) does not
emit directly:

* PDF  — layout-accurate. hwp-cli renders each page to PNG (pixel-faithful to the
         Hancom layout); img2pdf packs the PNGs losslessly into one PDF. Best for
         Korean official documents. Output is image-based (not text-selectable);
         for selectable text use `to-html` or `hwp cat --format markdown`.
* HTML — markdown-level fidelity. `hwp cat --format markdown` → Python-Markdown
         (tables) → standalone HTML with embedded CJK font CSS.

Both work on `.hwp` and `.hwpx` (format auto-detected by hwp-cli).

PDF rendering needs CJK fonts (함초롬/HCR + a fallback). The font dir is resolved
from $HWP_FONT_DIR, else ~/.anchor/env/fonts, else ~/Library/Fonts.
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


# --- hwp-cli discovery (kept in sync with hwpx_cli.py / extract_all.py) ----------

def _is_hwp_cli(binary: str) -> bool:
    """True if `binary` is hwp-cli (has a `cat` subcommand) — excludes the legacy
    hwp-toolkit wrapper, which shares the name `hwp`."""
    try:
        proc = subprocess.run([binary, "cat", "--help"], capture_output=True, timeout=5)
        return proc.returncode == 0
    except OSError:
        return False


def find_hwp_cli() -> str | None:
    """Locate the hwp-cli `hwp` binary. Order: $HWP_CLI, ~/.cargo/bin/hwp, the
    workspace dev release build, then a validated `hwp` on PATH."""
    explicit = [
        os.environ.get("HWP_CLI"),
        str(Path.home() / ".cargo" / "bin" / "hwp"),
        str(Path.home() / "workspace/work/dev/hwp-cli/target/release/hwp"),
    ]
    for c in explicit:
        if c and Path(c).is_file() and os.access(c, os.X_OK):
            return c
    path_hwp = shutil.which("hwp")
    if path_hwp and _is_hwp_cli(path_hwp):
        return path_hwp
    return None


def _font_dir() -> str | None:
    for c in (
        os.environ.get("HWP_FONT_DIR"),
        str(Path.home() / ".anchor" / "env" / "fonts"),
        str(Path.home() / "Library" / "Fonts"),
    ):
        if c and Path(c).is_dir():
            return c
    return None


def _require_cli() -> str:
    binary = find_hwp_cli()
    if not binary:
        raise FileNotFoundError(
            "hwp-cli('hwp') not found — `cargo install --path crates/hwp-cli` 또는 HWP_CLI=<.../hwp> 지정"
        )
    return binary


def cat(src: Path, fmt: str = "markdown") -> str:
    """`hwp cat` 텍스트 추출 (stdout만, 경고는 stderr)."""
    binary = _require_cli()
    proc = subprocess.run(
        [binary, "cat", str(src), "--format", fmt], capture_output=True, timeout=120
    )
    if proc.returncode != 0:
        raise RuntimeError(f"hwp cat 실패: {proc.stderr.decode('utf-8', 'ignore').strip()}")
    return proc.stdout.decode("utf-8", "ignore")


# --- PDF -------------------------------------------------------------------------

def _page_key(p: Path) -> int:
    m = re.search(r"-(\d+)$", p.stem)
    return int(m.group(1)) if m else 0


def render_to_pdf(src: Path, out_pdf: Path, dpi: int = 150) -> Path:
    """Render every page to PNG via hwp-cli, then pack into a single PDF (img2pdf)."""
    import img2pdf

    binary = _require_cli()
    fonts = _font_dir()
    with tempfile.TemporaryDirectory() as td:
        stem = Path(td) / "page.png"
        cmd = [
            binary, "render", str(src), "-o", str(stem),
            "--pages", "all", "--dpi", str(dpi), "--format", "png",
        ]
        if fonts:
            cmd += ["--font-dir", fonts]
        proc = subprocess.run(cmd, capture_output=True, timeout=600)
        if proc.returncode != 0:
            raise RuntimeError(f"hwp render 실패: {proc.stderr.decode('utf-8', 'ignore').strip()}")
        pngs = sorted(Path(td).glob("page*.png"), key=_page_key)
        if not pngs:
            raise RuntimeError("렌더 결과 PNG가 없음 (빈 문서이거나 폰트 미해결)")
        out_pdf.parent.mkdir(parents=True, exist_ok=True)
        with open(out_pdf, "wb") as f:
            f.write(img2pdf.convert([str(p) for p in pngs]))
    return out_pdf


# --- HTML ------------------------------------------------------------------------

_HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8">
<title>{title}</title>
<style>
body {{ font-family: "함초롬바탕","HCR Batang","Noto Serif CJK KR",serif;
  max-width: 50rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.7; }}
table {{ border-collapse: collapse; width: 100%; margin: 1rem 0; }}
th, td {{ border: 1px solid #999; padding: 0.35rem 0.6rem; }}
th {{ background: #f2f2f2; }}
h1,h2,h3 {{ font-family: "함초롬돋움","HCR Dotum","Noto Sans CJK KR",sans-serif; }}
</style></head>
<body>
{body}
</body></html>
"""


def to_html(src: Path, out_html: Path | None = None, standalone: bool = True) -> str:
    """HWP/HWPX → HTML (markdown-level)."""
    import markdown as _md

    body = _md.markdown(
        cat(src, "markdown"),
        extensions=["tables", "fenced_code", "sane_lists"],
    )
    html = _HTML_TEMPLATE.format(title=src.stem, body=body) if standalone else body
    if out_html is not None:
        out_html.parent.mkdir(parents=True, exist_ok=True)
        out_html.write_text(html, encoding="utf-8")
    return html


# --- standalone CLI --------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="hwp_export", description="HWP/HWPX → PDF/HTML (hwp-cli shim)")
    ap.add_argument("src")
    ap.add_argument("--to", choices=["pdf", "html"], required=True)
    ap.add_argument("-o", "--output")
    ap.add_argument("--dpi", type=int, default=150, help="PDF 렌더 해상도 (기본 150)")
    args = ap.parse_args(argv)

    src = Path(args.src)
    if not src.is_file():
        print(f"파일 없음: {src}", file=sys.stderr)
        return 1
    out = Path(args.output) if args.output else src.with_suffix("." + args.to)
    try:
        if args.to == "pdf":
            render_to_pdf(src, out, dpi=args.dpi)
        else:
            to_html(src, out)
    except Exception as e:  # noqa: BLE001 — surface a clean message to the user
        print(f"변환 실패: {e}", file=sys.stderr)
        return 2
    print(f"생성: {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
