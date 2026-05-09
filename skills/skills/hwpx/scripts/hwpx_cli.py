#!/usr/bin/env python3
"""hwpx-toolkit CLI dispatcher.

Subcommands:
  read <file.hwpx> [--format md|text|json] [--section N]
  summary <file.hwpx>
  to-md <file.hwpx> [-o out.md]
  unpack <file.hwpx> <out_dir>
  repack <dir> <out.hwpx>
  fill <template.hwpx> [--data json_file] [--kv key=value ...] [-o out.hwpx] [--stdin-json]
  edit <in.hwpx> <out.hwpx> --replace OLD NEW [--limit N]
  create <out.hwpx> [--markdown md_file | --title T --body B | --json j_file]
  validate <file.hwpx>
  to-pdf <file.hwpx> [-o out.pdf]

All commands: exit 0 success, 1 arg/IO error, 2 parse failure, 3 not found.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

# python-hwpx emits WARNING logs for common manifest fallbacks on valid files.
# Silence by default; override with HWPX_VERBOSE=1 when debugging.
if not os.environ.get("HWPX_VERBOSE"):
    logging.getLogger("hwpx").setLevel(logging.ERROR)


# ─── helpers ─────────────────────────────────────────────────────────────

def _die(code: int, msg: str) -> None:
    print(f"[hwpx] {msg}", file=sys.stderr)
    sys.exit(code)


def _open_doc(path: str):
    try:
        from hwpx import HwpxDocument
    except ImportError as e:  # pragma: no cover
        _die(1, f"python-hwpx 미설치: {e}")
    try:
        return HwpxDocument.open(path)
    except FileNotFoundError:
        _die(1, f"파일 없음: {path}")
    except (zipfile.BadZipFile, KeyError) as e:
        _die(2, f"HWPX 파싱 실패 ({type(e).__name__}): {path}")


def _load_kv_data(args) -> dict:
    data: dict = {}
    if getattr(args, "stdin_json", False):
        try:
            data.update(json.load(sys.stdin))
        except json.JSONDecodeError as e:
            _die(1, f"stdin JSON 파싱 실패: {e}")
    if getattr(args, "data", None):
        try:
            data.update(json.loads(Path(args.data).read_text(encoding="utf-8")))
        except (FileNotFoundError, json.JSONDecodeError) as e:
            _die(1, f"--data 파일 오류: {e}")
    for kv in getattr(args, "kv", None) or []:
        if "=" not in kv:
            _die(1, f"--kv 형식 오류 (key=value 필요): {kv}")
        k, v = kv.split("=", 1)
        data[k.strip()] = v
    return data


# ─── subcommand implementations ──────────────────────────────────────────

def cmd_read(args) -> int:
    doc = _open_doc(args.file)
    fmt = args.format
    if fmt == "text":
        sys.stdout.write(doc.export_text())
    elif fmt == "md":
        sys.stdout.write(doc.export_markdown())
    elif fmt == "json":
        from hwpx.tools.text_extractor import TextExtractor

        extractor = TextExtractor(doc)
        out = {
            "sections": [
                {
                    "index": idx,
                    "paragraphs": [
                        {
                            "text": extractor.paragraph_text(p.element),
                            "style_id_ref": p.style_id_ref,
                            "para_pr_id_ref": p.para_pr_id_ref,
                        }
                        for p in sec.paragraphs
                    ],
                }
                for idx, sec in enumerate(doc.sections)
            ],
            "images": [
                {"path": getattr(img, "path", None), "bin_item": getattr(img, "bin_item_id_ref", None)}
                for img in doc.list_images()
            ],
        }
        json.dump(out, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
    return 0


def cmd_summary(args) -> int:
    doc = _open_doc(args.file)
    sections = list(doc.sections)
    paragraphs = list(doc.paragraphs)
    images = list(doc.list_images())
    v_attr = dict(doc.version.element.attrib)
    version_str = ".".join(
        v_attr.get(k, "?") for k in ("major", "minor", "micro", "buildNumber")
    )
    print(f"file      : {args.file}")
    print(f"version   : HCFVersion {version_str} ({v_attr.get('application', '?')})")
    print(f"sections  : {len(sections)}")
    print(f"paragraphs: {len(paragraphs)}")
    print(f"images    : {len(images)}")
    print(f"headers   : {len(list(doc.headers))}")
    print(f"styles    : {len(list(doc.styles))}")
    if paragraphs:
        first_non_empty = next(
            (p.text for p in paragraphs if (p.text or "").strip()), ""
        )
        preview = (first_non_empty or "")[:80].replace("\n", " ")
        print(f"preview   : {preview}")
    return 0


def cmd_to_md(args) -> int:
    doc = _open_doc(args.file)
    md = doc.export_markdown()
    if args.output:
        Path(args.output).write_text(md, encoding="utf-8")
        print(f"[hwpx] wrote {len(md)} chars → {args.output}", file=sys.stderr)
    else:
        sys.stdout.write(md)
    return 0


def cmd_unpack(args) -> int:
    src = Path(args.file)
    dst = Path(args.out_dir)
    if not src.is_file():
        _die(1, f"파일 없음: {src}")
    if dst.exists() and any(dst.iterdir()) and not args.force:
        _die(1, f"대상 디렉토리 비어있지 않음 (--force로 덮어쓰기): {dst}")
    dst.mkdir(parents=True, exist_ok=True)
    try:
        with zipfile.ZipFile(src) as zf:
            zf.extractall(dst)
    except zipfile.BadZipFile as e:
        _die(2, f"HWPX(zip) 파싱 실패: {e}")
    print(f"[hwpx] unpacked → {dst}", file=sys.stderr)
    return 0


def cmd_repack(args) -> int:
    src = Path(args.in_dir)
    dst = Path(args.out_file)
    mimetype_path = src / "mimetype"
    if not mimetype_path.is_file():
        _die(1, f"mimetype 없음: {mimetype_path} (HWPX unpack 결과 아님)")

    # HWPX/EPUB convention: mimetype FIRST, STORED (uncompressed), no extra field.
    with zipfile.ZipFile(dst, "w") as zf:
        info = zipfile.ZipInfo("mimetype")
        info.compress_type = zipfile.ZIP_STORED
        zf.writestr(info, mimetype_path.read_bytes())
        for path in sorted(src.rglob("*")):
            if path.is_dir() or path == mimetype_path:
                continue
            arcname = str(path.relative_to(src))
            zf.write(path, arcname, compress_type=zipfile.ZIP_DEFLATED)
    print(f"[hwpx] repacked → {dst}", file=sys.stderr)
    return 0


def cmd_fill(args) -> int:
    doc = _open_doc(args.template)
    data = _load_kv_data(args)
    if not data:
        _die(1, "치환 데이터 없음 (--data / --kv / --stdin-json)")

    total = 0
    for key, value in data.items():
        anchor = "{{" + str(key) + "}}"
        n = doc.replace_text_in_runs(anchor, str(value))
        print(f"[hwpx] {anchor} → {n}건", file=sys.stderr)
        total += n

    out = args.output or _derive_output(args.template, suffix="-filled.hwpx")
    doc.save_to_path(out)
    print(f"[hwpx] {total}건 치환 → {out}", file=sys.stderr)
    return 0


def cmd_edit(args) -> int:
    doc = _open_doc(args.in_file)
    n = doc.replace_text_in_runs(args.replace[0], args.replace[1], limit=args.limit)
    doc.save_to_path(args.out_file)
    print(f"[hwpx] {n}건 치환 → {args.out_file}", file=sys.stderr)
    return 0


def cmd_create(args) -> int:
    from hwpx import HwpxDocument

    doc = HwpxDocument.new()
    if args.title:
        doc.add_paragraph(args.title)
    if args.body:
        for line in args.body.split("\n"):
            doc.add_paragraph(line)
    if args.markdown:
        md_text = Path(args.markdown).read_text(encoding="utf-8")
        for line in md_text.split("\n"):
            # minimal MVP: one paragraph per non-empty line, strip '#' headings
            stripped = line.lstrip("#").strip()
            if stripped:
                doc.add_paragraph(stripped)
    if args.json:
        payload = json.loads(Path(args.json).read_text(encoding="utf-8"))
        if isinstance(payload, dict):
            if payload.get("title"):
                doc.add_paragraph(str(payload["title"]))
            for para in payload.get("paragraphs", []):
                doc.add_paragraph(str(para))
        elif isinstance(payload, list):
            for para in payload:
                doc.add_paragraph(str(para))
    doc.save_to_path(args.out_file)
    print(f"[hwpx] created → {args.out_file}", file=sys.stderr)
    return 0


def cmd_styled(args) -> int:
    """Generate a polished styled HWPX from markdown/JSON."""
    import styled as styled_mod  # local import to keep CLI boot fast

    # Source: markdown file, JSON file, or stdin
    if args.markdown:
        md_text = Path(args.markdown).read_text(encoding="utf-8")
        blocks = styled_mod.markdown_to_blocks(md_text)
    elif args.json:
        payload = json.loads(Path(args.json).read_text(encoding="utf-8"))
        blocks = _blocks_from_json(payload, styled_mod)
    elif args.stdin_markdown:
        blocks = styled_mod.markdown_to_blocks(sys.stdin.read())
    elif args.stdin_json:
        payload = json.load(sys.stdin)
        blocks = _blocks_from_json(payload, styled_mod)
    else:
        _die(1, "소스 없음 — --markdown / --json / --stdin-markdown / --stdin-json 중 하나 필요")

    if args.reference:
        out = styled_mod.follow_template(
            blocks, reference=args.reference, output=args.output,
            header=args.header, footer=args.footer,
        )
    else:
        out = styled_mod.from_preset(
            blocks, preset_name=args.preset, output=args.output,
            header=args.header,
            footer=args.footer if args.footer is not None else "- # / ## -",
        )
    print(f"[hwpx] styled → {out}", file=sys.stderr)
    return 0


def _blocks_from_json(payload: dict | list, styled_mod) -> list:
    """JSON schema: {title, subtitle, blocks:[{kind,text,level?,align?}]} or flat list."""
    out: list = []
    if isinstance(payload, dict):
        if payload.get("title"):
            out.append(styled_mod.title(payload["title"]))
        if payload.get("subtitle"):
            out.append(styled_mod.subtitle(payload["subtitle"]))
        if payload.get("title") or payload.get("subtitle"):
            out.append(styled_mod.separator())
        items = payload.get("blocks", [])
    else:
        items = payload
    for item in items:
        if isinstance(item, str):
            out.append(styled_mod.para(item))
            continue
        kind = item.get("kind", "para")
        factory = {
            "title": styled_mod.title,
            "subtitle": styled_mod.subtitle,
            "separator": lambda *_a, **_k: styled_mod.separator(),
        }.get(kind)
        if factory:
            out.append(factory(item.get("text", "")) if kind != "separator" else factory())
        elif kind == "heading":
            out.append(styled_mod.heading(item["text"], level=item.get("level", 1)))
        else:  # para (default)
            out.append(styled_mod.para(item.get("text", ""), align=item.get("align", "LEFT")))
    return out


def cmd_validate(args) -> int:
    # Structural checks that matter in the wild:
    #   1. mimetype is FIRST entry, STORED, content == application/hwp+zip
    #   2. Contents/content.hpf, Contents/header.xml, Contents/section0.xml exist
    #   3. Every XML file parses
    from lxml import etree

    path = Path(args.file)
    if not path.is_file():
        _die(1, f"파일 없음: {path}")

    errors = []
    try:
        with zipfile.ZipFile(path) as zf:
            names = zf.namelist()
            if not names or names[0] != "mimetype":
                errors.append(f"mimetype이 첫 엔트리 아님 (실제: {names[0] if names else '<empty>'})")
            info = zf.getinfo("mimetype")
            if info.compress_type != zipfile.ZIP_STORED:
                errors.append(f"mimetype이 STORED 아님 (compress_type={info.compress_type})")
            mimetype = zf.read("mimetype").decode("ascii", errors="replace").strip()
            if mimetype != "application/hwp+zip":
                errors.append(f"mimetype 값 부정확: '{mimetype}' (기대: 'application/hwp+zip')")

            required = ["Contents/content.hpf", "Contents/header.xml", "Contents/section0.xml"]
            for req in required:
                if req not in names:
                    errors.append(f"필수 파일 누락: {req}")

            for name in names:
                if not name.endswith(".xml") and not name.endswith(".hpf"):
                    continue
                try:
                    etree.fromstring(zf.read(name))
                except etree.XMLSyntaxError as e:
                    errors.append(f"XML 파싱 실패 {name}: {e}")
    except zipfile.BadZipFile as e:
        _die(2, f"zip 파싱 실패: {e}")

    if errors:
        print(f"[hwpx] validate FAIL ({len(errors)}건)", file=sys.stderr)
        for err in errors:
            print(f"  - {err}", file=sys.stderr)
        sys.exit(2)
    print(f"[hwpx] validate OK: {path}", file=sys.stderr)
    return 0


def cmd_to_pdf(args) -> int:
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice:
        _die(1, "LibreOffice(soffice) 필요 — brew install --cask libreoffice")

    out = Path(args.output) if args.output else Path(args.file).with_suffix(".pdf")
    out_dir = out.parent.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    # H2Orestart extension required for HWPX read support.
    # Inform-only; user installs the extension once via LibreOffice GUI.
    try:
        subprocess.run(
            [soffice, "--headless", "--convert-to", "pdf", "--outdir", str(out_dir), args.file],
            check=True,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except subprocess.CalledProcessError as e:
        _die(2, f"soffice 변환 실패: {e.stderr or e.stdout}")
    except subprocess.TimeoutExpired:
        _die(2, "soffice 변환 타임아웃 (120s)")

    # soffice writes <stem>.pdf in out_dir; rename if requested name differs.
    produced = out_dir / (Path(args.file).stem + ".pdf")
    if produced.resolve() != out.resolve():
        produced.rename(out)
    print(f"[hwpx] pdf → {out}", file=sys.stderr)
    return 0


def _derive_output(input_path: str, suffix: str) -> str:
    p = Path(input_path)
    return str(p.with_name(p.stem + suffix))


# ─── argparse wiring ─────────────────────────────────────────────────────

def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="hwpx", description="HWPX 공문서/결재문서 authoring toolkit")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("read", help="HWPX → text/markdown/json")
    s.add_argument("file")
    s.add_argument("--format", choices=["md", "text", "json"], default="md")
    s.set_defaults(func=cmd_read)

    s = sub.add_parser("summary", help="문서 메타 요약")
    s.add_argument("file")
    s.set_defaults(func=cmd_summary)

    s = sub.add_parser("to-md", help="HWPX → markdown")
    s.add_argument("file")
    s.add_argument("-o", "--output")
    s.set_defaults(func=cmd_to_md)

    s = sub.add_parser("unpack", help="HWPX zip → 디렉토리")
    s.add_argument("file")
    s.add_argument("out_dir")
    s.add_argument("-f", "--force", action="store_true")
    s.set_defaults(func=cmd_unpack)

    s = sub.add_parser("repack", help="디렉토리 → HWPX (mimetype-first STORED)")
    s.add_argument("in_dir")
    s.add_argument("out_file")
    s.set_defaults(func=cmd_repack)

    s = sub.add_parser("fill", help="{{anchor}} 치환 (템플릿 채우기)")
    s.add_argument("template")
    s.add_argument("--data", help="JSON 파일 경로")
    s.add_argument("--kv", action="append", help="key=value (반복 가능)")
    s.add_argument("--stdin-json", action="store_true", help="stdin에서 JSON 입력")
    s.add_argument("-o", "--output")
    s.set_defaults(func=cmd_fill)

    s = sub.add_parser("edit", help="find/replace 편집")
    s.add_argument("in_file")
    s.add_argument("out_file")
    s.add_argument("--replace", nargs=2, metavar=("OLD", "NEW"), required=True)
    s.add_argument("--limit", type=int, default=None)
    s.set_defaults(func=cmd_edit)

    s = sub.add_parser("create", help="신규 HWPX 생성 (MVP: markdown/JSON/inline)")
    s.add_argument("out_file")
    s.add_argument("--markdown", help="markdown 파일 (MVP: 한 줄 = 한 단락)")
    s.add_argument("--title")
    s.add_argument("--body")
    s.add_argument("--json", help="JSON 파일 (title + paragraphs[])")
    s.set_defaults(func=cmd_create)

    s = sub.add_parser("styled", help="보기 좋은 HWPX 생성 (여백·폰트·헤더/푸터·페이지번호 포함)")
    s.add_argument("-o", "--output", required=True, help="출력 파일 경로")
    s.add_argument("--preset", choices=list(["gongmun", "bogoseo"]), default="gongmun",
                   help="스타일 프리셋: gongmun(맑은 고딕 11.5pt) | bogoseo(함초롬바탕 15pt)")
    s.add_argument("--reference", help="양식 파일 (있으면 그 양식의 스타일을 따름)")
    s.add_argument("--markdown", help="markdown 파일")
    s.add_argument("--json", dest="json", help="JSON 파일 (title/subtitle/blocks)")
    s.add_argument("--stdin-markdown", action="store_true")
    s.add_argument("--stdin-json", action="store_true")
    s.add_argument("--header", help="머리글 텍스트")
    s.add_argument("--footer", default=None,
                   help="바닥글 템플릿 (# = 현재 쪽, ## = 전체 쪽). 기본 '- # / ## -'. 'none'으로 비활성화")
    s.set_defaults(func=cmd_styled)

    s = sub.add_parser("validate", help="mimetype/manifest/XML 검증")
    s.add_argument("file")
    s.set_defaults(func=cmd_validate)

    s = sub.add_parser("to-pdf", help="LibreOffice(+H2Orestart) 경유 PDF")
    s.add_argument("file")
    s.add_argument("-o", "--output")
    s.set_defaults(func=cmd_to_pdf)

    # bundled-JRE writer commands (ported from tidy)
    import write_java as _wj
    import export_html as _eh
    _wj.add_subparser(sub)
    _eh.add_subparser(sub)

    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    return args.func(args) or 0


if __name__ == "__main__":
    sys.exit(main())
