"""hwpx write-java — call bundled Java + hwpxlib HwpxWriter to produce HWPX.

The Java writer reads UTF-8 lines from stdin where each line is one paragraph,
optionally prefixed with a tag:
  H1:대제목
  H2:중제목
  P:본문 단락
  P:                       (빈 줄)

Markdown input mode (`--markdown FILE`):
  '#'  → H1:
  '##' → H2:
  '###'→ H3:
  other non-empty lines → P:
  blank lines → P: (empty paragraph)
"""
from __future__ import annotations

import argparse
import io
import re
import subprocess
import sys
import zipfile
from pathlib import Path

from runtime_paths import JAVA_BIN, WRITER_CLASS, WRITER_SOURCE, assert_jre, classpath


def _normalize_mimetype(path: Path) -> None:
    """Rewrite the .hwpx zip so 'mimetype' is the first entry and STORED.

    hwpxlib's HWPXWriter emits mimetype as DEFLATE, which Hancom Office accepts
    but the OWPML/EPUB-style convention (and our own `validate`) requires STORED
    + first entry. This mirrors what the existing `repack` command guarantees.
    """
    with zipfile.ZipFile(path, "r") as zin:
        names = zin.namelist()
        contents = {n: zin.read(n) for n in names}

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zout:
        if "mimetype" in contents:
            info = zipfile.ZipInfo("mimetype")
            info.compress_type = zipfile.ZIP_STORED
            zout.writestr(info, contents.pop("mimetype"))
        for name in names:
            if name == "mimetype":
                continue
            info = zipfile.ZipInfo(name)
            info.compress_type = zipfile.ZIP_DEFLATED
            zout.writestr(info, contents[name])
    path.write_bytes(buf.getvalue())


def md_to_lines(md: str) -> list[str]:
    out: list[str] = []
    for raw in md.splitlines():
        line = raw.rstrip()
        if not line.strip():
            out.append("P:")
            continue
        m = re.match(r"^(#{1,6})\s+(.*)$", line)
        if m:
            level = len(m.group(1))
            out.append(f"H{level}:{m.group(2).strip()}")
        else:
            out.append(f"P:{line.lstrip()}")
    return out


def text_to_lines(txt: str) -> list[str]:
    """Treat each line as a P: paragraph, preserving blanks."""
    return [f"P:{line.rstrip()}" if line.strip() else "P:" for line in txt.splitlines()]


def write_java(output: Path, lines: list[str], timeout: float = 30.0) -> None:
    assert_jre()
    output.parent.mkdir(parents=True, exist_ok=True)
    payload = ("\n".join(lines) + "\n").encode("utf-8") if lines else b"P:\n"
    main = "HwpxWriter" if WRITER_CLASS.exists() else str(WRITER_SOURCE)
    proc = subprocess.run(
        [str(JAVA_BIN), "-cp", classpath(), main, str(output)],
        input=payload,
        capture_output=True,
        timeout=timeout,
    )
    if proc.returncode != 0:
        stderr = proc.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"HwpxWriter failed (exit {proc.returncode}): {stderr}")
    _normalize_mimetype(output)


def cli_write_java(args: argparse.Namespace) -> int:
    output = Path(args.output)
    if args.markdown:
        lines = md_to_lines(Path(args.markdown).read_text(encoding="utf-8"))
    elif args.input:
        lines = text_to_lines(Path(args.input).read_text(encoding="utf-8"))
    else:
        # stdin: caller already provides H1:/P: lines (or blank → P:)
        raw = sys.stdin.read()
        lines = [ln.rstrip("\r\n") for ln in raw.splitlines()] or ["P:"]
    try:
        write_java(output, lines)
    except RuntimeError as e:
        print(f"[hwpx] write-java 실패: {e}", file=sys.stderr)
        return 1
    print(f"HWPX saved: {output} ({len(lines)} paragraphs, engine=bundled-hwpx-java)")
    return 0


def add_subparser(sub) -> None:
    s = sub.add_parser(
        "write-java",
        help="번들 Java + hwpxlib로 HWPX 생성 (저수준)",
    )
    s.add_argument("output", help="output .hwpx path")
    src = s.add_mutually_exclusive_group()
    src.add_argument("--markdown", help="markdown 파일 → H1/H2/H3/P 변환 후 전달")
    src.add_argument("--input", help="텍스트 파일 → 한 줄 = 한 P: 단락")
    s.set_defaults(func=cli_write_java)
