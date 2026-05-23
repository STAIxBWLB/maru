#!/usr/bin/env python3
"""hwpx-toolkit CLI dispatcher.

Subcommands:
  read <file.hwpx> [--format md|text|json] [--section N]
  summary <file.hwpx>
  to-md <file.hwpx> [-o out.md]
  unpack <file.hwpx> <out_dir>
  repack <dir> <out.hwpx>
  fill <template.hwpx> [--data json_file] [--kv key=value ...] [-o out.hwpx] [--stdin-json]
  slots <template.hwpx> [--format text|json]
  edit <in.hwpx> <out.hwpx> --replace OLD NEW [--limit N]
  create <out.hwpx> [--markdown md_file | --title T --body B | --json j_file]
  validate <file.hwpx>
  to-pdf <file.hwpx> [-o out.pdf]

All commands: exit 0 success, 1 arg/IO error, 2 parse failure, 3 not found.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import zipfile
from dataclasses import dataclass
from pathlib import Path

from lxml import etree


HP_NS = "http://www.hancom.co.kr/hwpml/2011/paragraph"
HP = f"{{{HP_NS}}}"
XML_SUFFIXES = (".xml", ".hpf")
IMAGE_SUFFIXES = (".bmp", ".gif", ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".wmf", ".emf")


@dataclass
class ReplaceResult:
    output: Path
    counts: dict[str, int]

    @property
    def total(self) -> int:
        return sum(self.counts.values())


# helpers

def _die(code: int, msg: str) -> None:
    print(f"[hwpx] {msg}", file=sys.stderr)
    sys.exit(code)


def _ensure_file(path: str | Path) -> Path:
    p = Path(path)
    if not p.is_file():
        _die(1, f"파일 없음: {p}")
    return p


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


def _localname(element: etree._Element) -> str:
    return etree.QName(element).localname


def _section_sort_key(name: str) -> tuple[int, str]:
    m = re.search(r"section(\d+)\.xml$", name, re.IGNORECASE)
    return (int(m.group(1)) if m else 999_999, name)


def _section_names(names: list[str]) -> list[str]:
    sections = [
        name
        for name in names
        if name.lower().startswith("contents/section") and name.lower().endswith(".xml")
    ]
    return sorted(sections, key=_section_sort_key)


def _paragraph_text(paragraph: etree._Element) -> str:
    parts: list[str] = []
    for element in paragraph.iter():
        local = _localname(element)
        if local == "t" and element.text:
            parts.append(element.text)
        elif local in {"lineBreak", "br"}:
            parts.append("\n")
        elif local == "tab":
            parts.append("\t")
    return "".join(parts)


def _parse_section(name: str, data: bytes) -> dict:
    try:
        root = etree.fromstring(data)
    except etree.XMLSyntaxError as e:
        _die(2, f"XML 파싱 실패 {name}: {e}")

    paragraphs = []
    for idx, para in enumerate(root.iter(f"{HP}p")):
        paragraphs.append(
            {
                "index": idx,
                "text": _paragraph_text(para),
                "style_id_ref": para.get("styleIDRef"),
                "para_pr_id_ref": para.get("paraPrIDRef"),
            }
        )
    return {"path": name, "paragraphs": paragraphs}


def _extract_structure(path: Path) -> dict:
    try:
        with zipfile.ZipFile(path) as zf:
            names = zf.namelist()
            sections = [
                {"index": idx, **_parse_section(name, zf.read(name))}
                for idx, name in enumerate(_section_names(names))
            ]
            images = [
                {"path": name}
                for name in names
                if name.lower().endswith(IMAGE_SUFFIXES)
                and (name.lower().startswith("bindata/") or "/bindata/" in name.lower())
            ]
            header_counts = _header_counts(zf) if "Contents/header.xml" in names else {}
            version = _version_info(zf) if "version.xml" in names else {}
    except zipfile.BadZipFile as e:
        _die(2, f"HWPX(zip) 파싱 실패: {e}")

    return {
        "file": str(path),
        "sections": sections,
        "images": images,
        "header": header_counts,
        "version": version,
    }


def _header_counts(zf: zipfile.ZipFile) -> dict:
    try:
        root = etree.fromstring(zf.read("Contents/header.xml"))
    except etree.XMLSyntaxError:
        return {}
    counts: dict[str, int] = {"styles": 0, "char_properties": 0, "para_properties": 0}
    for element in root.iter():
        local = _localname(element).lower()
        if local == "style":
            counts["styles"] += 1
        elif local == "charpr":
            counts["char_properties"] += 1
        elif local == "parapr":
            counts["para_properties"] += 1
    return counts


def _version_info(zf: zipfile.ZipFile) -> dict:
    try:
        root = etree.fromstring(zf.read("version.xml"))
    except etree.XMLSyntaxError:
        return {}
    return {k: v for k, v in root.attrib.items()}


def _selected_sections(structure: dict, section: int | None) -> list[dict]:
    sections = structure["sections"]
    if section is None:
        return sections
    if section < 0 or section >= len(sections):
        _die(3, f"섹션 없음: {section} (총 {len(sections)}개)")
    return [sections[section]]


def _text_from_structure(structure: dict, section: int | None = None) -> str:
    lines: list[str] = []
    for sec in _selected_sections(structure, section):
        for para in sec["paragraphs"]:
            lines.append(para["text"])
    return "\n".join(lines).rstrip() + ("\n" if lines else "")


def _markdown_from_structure(structure: dict, section: int | None = None) -> str:
    return _text_from_structure(structure, section)


def _xml_entry(name: str) -> bool:
    return name.lower().endswith(XML_SUFFIXES)


def _copy_info(src: zipfile.ZipInfo, *, compress_type: int | None = None) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(src.filename, date_time=src.date_time)
    info.compress_type = src.compress_type if compress_type is None else compress_type
    info.comment = src.comment
    info.extra = src.extra
    info.external_attr = src.external_attr
    info.internal_attr = src.internal_attr
    return info


def _rewrite_hwpx_text(
    src: Path,
    dst: Path,
    replacements: dict[str, str],
    *,
    limit: int | None = None,
) -> ReplaceResult:
    if not replacements:
        _die(1, "치환 데이터 없음")

    counts = {key: 0 for key in replacements}
    remaining = limit
    try:
        with zipfile.ZipFile(src, "r") as zin:
            entries: list[tuple[zipfile.ZipInfo, bytes]] = []
            for info in zin.infolist():
                data = zin.read(info.filename)
                if _xml_entry(info.filename):
                    text = data.decode("utf-8", errors="strict")
                    for old, new in replacements.items():
                        if remaining == 0:
                            break
                        if not old:
                            continue
                        available = text.count(old)
                        if available == 0:
                            continue
                        if remaining is None:
                            used = available
                            text = text.replace(old, new)
                        else:
                            used = min(available, remaining)
                            text = text.replace(old, new, used)
                            remaining -= used
                        counts[old] += used
                    data = text.encode("utf-8")
                entries.append((info, data))
    except UnicodeDecodeError as e:
        _die(2, f"XML UTF-8 디코딩 실패: {e}")
    except zipfile.BadZipFile as e:
        _die(2, f"HWPX(zip) 파싱 실패: {e}")

    dst.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(dst, "w") as zout:
        mimetype_entry = next((item for item in entries if item[0].filename == "mimetype"), None)
        if mimetype_entry is not None:
            _, data = mimetype_entry
            info = zipfile.ZipInfo("mimetype")
            info.compress_type = zipfile.ZIP_STORED
            zout.writestr(info, data)
        for src_info, data in entries:
            if src_info.filename == "mimetype":
                continue
            zout.writestr(_copy_info(src_info), data)

    return ReplaceResult(output=dst, counts=counts)


def _derive_output(input_path: str, suffix: str) -> str:
    p = Path(input_path)
    return str(p.with_name(p.stem + suffix))


def _create_lines_from_args(args) -> list[str]:
    import write_java as write_java_mod

    lines: list[str] = []
    if args.title:
        lines.append(f"H1:{args.title}")
    if args.body:
        lines.extend(write_java_mod.text_to_lines(args.body))
    if args.markdown:
        lines.extend(write_java_mod.md_to_lines(Path(args.markdown).read_text(encoding="utf-8")))
    if args.json:
        payload = json.loads(Path(args.json).read_text(encoding="utf-8"))
        if isinstance(payload, dict):
            if payload.get("title"):
                lines.append(f"H1:{payload['title']}")
            if payload.get("subtitle"):
                lines.append(f"H2:{payload['subtitle']}")
            for para in payload.get("paragraphs", []):
                lines.extend(write_java_mod.text_to_lines(str(para)))
            for block in payload.get("blocks", []):
                if isinstance(block, str):
                    lines.extend(write_java_mod.text_to_lines(block))
                    continue
                kind = block.get("kind", "para")
                text = str(block.get("text", ""))
                if kind == "title":
                    lines.append(f"H1:{text}")
                elif kind == "heading":
                    level = max(1, min(6, int(block.get("level", 1))))
                    lines.append(f"H{level}:{text}")
                elif kind == "separator":
                    lines.append("P:")
                else:
                    lines.extend(write_java_mod.text_to_lines(text))
        elif isinstance(payload, list):
            for para in payload:
                lines.extend(write_java_mod.text_to_lines(str(para)))
    return lines or ["P:"]


# subcommand implementations

def cmd_read(args) -> int:
    path = _ensure_file(args.file)
    structure = _extract_structure(path)
    if args.format == "text":
        sys.stdout.write(_text_from_structure(structure, args.section))
    elif args.format == "md":
        sys.stdout.write(_markdown_from_structure(structure, args.section))
    elif args.format == "json":
        payload = dict(structure)
        if args.section is not None:
            payload["sections"] = _selected_sections(structure, args.section)
        json.dump(payload, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
    return 0


def cmd_summary(args) -> int:
    path = _ensure_file(args.file)
    structure = _extract_structure(path)
    paragraphs = [p for sec in structure["sections"] for p in sec["paragraphs"]]
    first_non_empty = next((p["text"] for p in paragraphs if p["text"].strip()), "")
    preview = first_non_empty[:80].replace("\n", " ")
    version = structure.get("version", {})
    header = structure.get("header", {})

    print(f"file      : {path}")
    print(f"version   : {version or '-'}")
    print(f"sections  : {len(structure['sections'])}")
    print(f"paragraphs: {len(paragraphs)}")
    print(f"images    : {len(structure['images'])}")
    print(f"styles    : {header.get('styles', 0)}")
    if preview:
        print(f"preview   : {preview}")
    return 0


def cmd_to_md(args) -> int:
    path = _ensure_file(args.file)
    md = _markdown_from_structure(_extract_structure(path), args.section)
    if args.output:
        Path(args.output).write_text(md, encoding="utf-8")
        print(f"[hwpx] wrote {len(md)} chars -> {args.output}", file=sys.stderr)
    else:
        sys.stdout.write(md)
    return 0


def cmd_unpack(args) -> int:
    src = _ensure_file(args.file)
    dst = Path(args.out_dir)
    if dst.exists() and any(dst.iterdir()) and not args.force:
        _die(1, f"대상 디렉토리 비어있지 않음 (--force로 덮어쓰기): {dst}")
    dst.mkdir(parents=True, exist_ok=True)
    try:
        with zipfile.ZipFile(src) as zf:
            zf.extractall(dst)
    except zipfile.BadZipFile as e:
        _die(2, f"HWPX(zip) 파싱 실패: {e}")
    print(f"[hwpx] unpacked -> {dst}", file=sys.stderr)
    return 0


def cmd_repack(args) -> int:
    src = Path(args.in_dir)
    dst = Path(args.out_file)
    mimetype_path = src / "mimetype"
    if not mimetype_path.is_file():
        _die(1, f"mimetype 없음: {mimetype_path} (HWPX unpack 결과 아님)")

    with zipfile.ZipFile(dst, "w") as zf:
        info = zipfile.ZipInfo("mimetype")
        info.compress_type = zipfile.ZIP_STORED
        zf.writestr(info, mimetype_path.read_bytes())
        for path in sorted(src.rglob("*")):
            if path.is_dir() or path == mimetype_path:
                continue
            arcname = str(path.relative_to(src))
            zf.write(path, arcname, compress_type=zipfile.ZIP_DEFLATED)
    print(f"[hwpx] repacked -> {dst}", file=sys.stderr)
    return 0


def cmd_fill(args) -> int:
    src = _ensure_file(args.template)
    data = _load_kv_data(args)
    if not data:
        _die(1, "치환 데이터 없음 (--data / --kv / --stdin-json)")

    replacements = {"{{" + str(key) + "}}": str(value) for key, value in data.items()}
    out = Path(args.output or _derive_output(args.template, suffix="-filled.hwpx"))
    result = _rewrite_hwpx_text(src, out, replacements)
    for old, n in result.counts.items():
        print(f"[hwpx] {old} -> {n}건", file=sys.stderr)
    print(f"[hwpx] {result.total}건 치환 -> {result.output}", file=sys.stderr)
    return 0


def cmd_slots(args) -> int:
    input_path = _ensure_file(args.template)
    if input_path.suffix.lower() != ".hwpx":
        _die(1, f"slots는 .hwpx 파일만 지원: {input_path}")

    pattern = re.compile(r"\{\{\s*([^{}\r\n]+?)\s*\}\}")
    counts: dict[str, int] = {}
    try:
        with zipfile.ZipFile(input_path, "r") as zf:
            for info in zf.infolist():
                if not _xml_entry(info.filename):
                    continue
                text = zf.read(info).decode("utf-8", errors="ignore")
                for match in pattern.finditer(text):
                    key = match.group(1).strip()
                    if key:
                        counts[key] = counts.get(key, 0) + 1
    except zipfile.BadZipFile as e:
        _die(2, f"HWPX(zip) 파싱 실패: {e}")

    fields = [
        {
            "key": key,
            "label": key,
            "required": True,
            "occurrences": occurrences,
        }
        for key, occurrences in counts.items()
    ]
    payload = {"template": str(input_path), "fields": fields}

    if args.format == "json":
        json.dump(payload, sys.stdout, ensure_ascii=False, indent=2)
        print()
    else:
        if not fields:
            print("No {{field}} slots found.")
        for field in fields:
            print(f"{field['key']}\t{field['occurrences']}")
    return 0


def cmd_edit(args) -> int:
    src = _ensure_file(args.in_file)
    result = _rewrite_hwpx_text(
        src,
        Path(args.out_file),
        {args.replace[0]: args.replace[1]},
        limit=args.limit,
    )
    print(f"[hwpx] {result.total}건 치환 -> {args.out_file}", file=sys.stderr)
    return 0


def cmd_create(args) -> int:
    import write_java as write_java_mod

    out = Path(args.out_file)
    try:
        write_java_mod.write_java(out, _create_lines_from_args(args))
    except RuntimeError as e:
        _die(2, f"create 실패: {e}")
    print(f"[hwpx] created -> {out}", file=sys.stderr)
    return 0


def cmd_styled(args) -> int:
    """Generate a styled HWPX from markdown/JSON."""
    import styled as styled_mod

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
        _die(1, "소스 없음: --markdown / --json / --stdin-markdown / --stdin-json 중 하나 필요")

    try:
        if args.reference:
            out = styled_mod.follow_template(
                blocks,
                reference=args.reference,
                output=args.output,
                header=args.header,
                footer=args.footer,
            )
        else:
            out = styled_mod.from_preset(
                blocks,
                preset_name=args.preset,
                output=args.output,
                header=args.header,
                footer=args.footer if args.footer is not None else "- # / ## -",
            )
    except Exception as e:
        _die(2, f"styled 실패: {type(e).__name__}: {e}")
    print(f"[hwpx] styled -> {out}", file=sys.stderr)
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
        else:
            out.append(styled_mod.para(item.get("text", ""), align=item.get("align", "LEFT")))
    return out


def cmd_validate(args) -> int:
    path = Path(args.file)
    if not path.is_file():
        _die(1, f"파일 없음: {path}")

    errors = []
    try:
        with zipfile.ZipFile(path) as zf:
            names = zf.namelist()
            if not names or names[0] != "mimetype":
                errors.append(f"mimetype이 첫 엔트리 아님 (실제: {names[0] if names else '<empty>'})")
            try:
                info = zf.getinfo("mimetype")
                if info.compress_type != zipfile.ZIP_STORED:
                    errors.append(f"mimetype이 STORED 아님 (compress_type={info.compress_type})")
                mimetype = zf.read("mimetype").decode("ascii", errors="replace").strip()
                if mimetype != "application/hwp+zip":
                    errors.append(f"mimetype 값 부정확: '{mimetype}' (기대: 'application/hwp+zip')")
            except KeyError:
                errors.append("mimetype 파일 누락")

            required = ["Contents/content.hpf", "Contents/header.xml", "Contents/section0.xml"]
            for req in required:
                if req not in names:
                    errors.append(f"필수 파일 누락: {req}")

            for name in names:
                if not _xml_entry(name):
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
        _die(1, "LibreOffice(soffice) 필요: brew install --cask libreoffice")

    out = Path(args.output) if args.output else Path(args.file).with_suffix(".pdf")
    out_dir = out.parent.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

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

    produced = out_dir / (Path(args.file).stem + ".pdf")
    if produced.resolve() != out.resolve():
        produced.rename(out)
    print(f"[hwpx] pdf -> {out}", file=sys.stderr)
    return 0


# argparse wiring

def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="hwpx", description="HWPX 공문서/결재문서 authoring toolkit")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("read", help="HWPX -> text/markdown/json")
    s.add_argument("file")
    s.add_argument("--format", choices=["md", "text", "json"], default="md")
    s.add_argument("--section", type=int, default=None)
    s.set_defaults(func=cmd_read)

    s = sub.add_parser("summary", help="문서 메타 요약")
    s.add_argument("file")
    s.set_defaults(func=cmd_summary)

    s = sub.add_parser("to-md", help="HWPX -> markdown")
    s.add_argument("file")
    s.add_argument("-o", "--output")
    s.add_argument("--section", type=int, default=None)
    s.set_defaults(func=cmd_to_md)

    s = sub.add_parser("unpack", help="HWPX zip -> 디렉토리")
    s.add_argument("file")
    s.add_argument("out_dir")
    s.add_argument("-f", "--force", action="store_true")
    s.set_defaults(func=cmd_unpack)

    s = sub.add_parser("repack", help="디렉토리 -> HWPX (mimetype-first STORED)")
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

    s = sub.add_parser("slots", help="{{field}} 슬롯 목록 추출")
    s.add_argument("template")
    s.add_argument("--format", choices=["text", "json"], default="text")
    s.set_defaults(func=cmd_slots)

    s = sub.add_parser("edit", help="find/replace 편집")
    s.add_argument("in_file")
    s.add_argument("out_file")
    s.add_argument("--replace", nargs=2, metavar=("OLD", "NEW"), required=True)
    s.add_argument("--limit", type=int, default=None)
    s.set_defaults(func=cmd_edit)

    s = sub.add_parser("create", help="신규 HWPX 생성 (markdown/JSON/inline)")
    s.add_argument("out_file")
    s.add_argument("--markdown", help="markdown 파일")
    s.add_argument("--title")
    s.add_argument("--body")
    s.add_argument("--json", help="JSON 파일 (title + paragraphs[] or blocks[])")
    s.set_defaults(func=cmd_create)

    s = sub.add_parser("styled", help="HWPX 생성 (bundled Java writer 기반)")
    s.add_argument("-o", "--output", required=True, help="출력 파일 경로")
    s.add_argument(
        "--preset",
        choices=list(["gongmun", "bogoseo"]),
        default="gongmun",
        help="스타일 프리셋: gongmun | bogoseo",
    )
    s.add_argument("--reference", help="양식 파일 (slot이 있으면 raw ZIP/XML 치환)")
    s.add_argument("--markdown", help="markdown 파일")
    s.add_argument("--json", dest="json", help="JSON 파일 (title/subtitle/blocks)")
    s.add_argument("--stdin-markdown", action="store_true")
    s.add_argument("--stdin-json", action="store_true")
    s.add_argument("--header", help="머리글 텍스트")
    s.add_argument(
        "--footer",
        default=None,
        help="바닥글 템플릿 (# = 현재 쪽, ## = 전체 쪽). 기본 '- # / ## -'. 'none' 또는 빈 값으로 비활성화",
    )
    s.set_defaults(func=cmd_styled)

    s = sub.add_parser("validate", help="mimetype/manifest/XML 검증")
    s.add_argument("file")
    s.set_defaults(func=cmd_validate)

    s = sub.add_parser("to-pdf", help="LibreOffice(+H2Orestart) 경유 PDF")
    s.add_argument("file")
    s.add_argument("-o", "--output")
    s.set_defaults(func=cmd_to_pdf)

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
