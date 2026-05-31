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
import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

from lxml import etree


HP_NS = "http://www.hancom.co.kr/hwpml/2011/paragraph"
HP = f"{{{HP_NS}}}"
XML_SUFFIXES = (".xml", ".hpf")
IMAGE_SUFFIXES = (".bmp", ".gif", ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".wmf", ".emf")


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


def _derive_output(input_path: str, suffix: str) -> str:
    p = Path(input_path)
    return str(p.with_name(p.stem + suffix))


def _resolve_section_entry(requested: str | None, section_names: list[str]) -> str | None:
    """Resolve either a full zip entry or a basename such as section0.xml."""
    if not section_names:
        return None
    if not requested:
        return section_names[0]
    if requested in section_names:
        return requested
    req_name = Path(requested).name.lower()
    for name in section_names:
        if Path(name).name.lower() == req_name:
            return name
    return None


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

def _find_hwp_toolkit() -> str | None:
    """Locate the hwp-toolkit CLI for legacy .hwp delegation. Order: $HWP_TOOLKIT,
    workspace dev path, then `hwp` on PATH."""
    candidates = [
        os.environ.get("HWP_TOOLKIT"),
        str(Path.home() / "workspace" / "work" / "dev" / "hwp-toolkit" / "hwp"),
        shutil.which("hwp"),
    ]
    for c in candidates:
        if c and Path(c).is_file():
            return c
    return None


def _delegate_hwp_read(path: Path, fmt: str) -> int:
    """Binary .hwp(v5 OLE2) is not parsed here — delegate read to hwp-toolkit."""
    tool = _find_hwp_toolkit()
    if not tool:
        _die(
            1,
            ".hwp(바이너리)는 이 스킬이 직접 처리하지 않음. hwp-toolkit 미발견 — "
            "Hancom에서 .hwpx로 저장하거나 HWP_TOOLKIT=<.../hwp> 지정",
        )
    toolkit_fmt = {"text": "txt", "md": "md", "json": "json"}.get(fmt, "md")
    try:
        proc = subprocess.run(
            [tool, "read", str(path), "--format", toolkit_fmt],
            capture_output=True, text=True, timeout=120,
        )
    except (subprocess.TimeoutExpired, OSError) as e:
        _die(2, f"hwp-toolkit 위임 실패: {e}")
    if proc.returncode != 0:
        _die(2, f"hwp-toolkit read 실패: {(proc.stderr or proc.stdout).strip()}")
    sys.stdout.write(proc.stdout)
    print(f"[hwpx] .hwp → hwp-toolkit 위임 ({tool})", file=sys.stderr)
    return 0


def cmd_read(args) -> int:
    path = _ensure_file(args.file)
    if path.suffix.lower() == ".hwp":
        return _delegate_hwp_read(path, args.format)
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
    import hwpx_xml as hx

    src = _ensure_file(args.template)
    data = _load_kv_data(args)
    if not data:
        _die(1, "치환 데이터 없음 (--data / --kv / --stdin-json)")

    replacements = {"{{" + str(key) + "}}": str(value) for key, value in data.items()}
    out = Path(args.output or _derive_output(args.template, suffix="-filled.hwpx"))
    counts = hx.edit_text(src, out, replacements)
    total = sum(counts.values())
    for anchor, n in counts.items():
        print(f"[hwpx] {anchor} -> {n}건", file=sys.stderr)
    unfilled = [a for a, n in counts.items() if n == 0]
    if unfilled:
        print(f"[hwpx] ⚠️  미치환 anchor {len(unfilled)}건: {', '.join(unfilled)}", file=sys.stderr)
    print(f"[hwpx] {total}건 치환 -> {out}", file=sys.stderr)
    return 0


def cmd_slots(args) -> int:
    import hwpx_xml as hx

    input_path = _ensure_file(args.template)
    if input_path.suffix.lower() != ".hwpx":
        _die(1, f"slots는 .hwpx 파일만 지원: {input_path}")

    try:
        counts = hx.scan_slots(input_path)
    except (zipfile.BadZipFile, etree.XMLSyntaxError) as e:
        _die(2, f"HWPX 슬롯 스캔 실패: {e}")

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
    import hwpx_xml as hx

    src = _ensure_file(args.in_file)
    counts = hx.edit_text(
        src,
        Path(args.out_file),
        {args.replace[0]: args.replace[1]},
        limit=args.limit,
    )
    total = sum(counts.values())
    print(f"[hwpx] {total}건 치환 -> {args.out_file}", file=sys.stderr)
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


def cmd_analyze(args) -> int:
    """편집 청사진 출력: sec 직계자식 인덱스 맵 + 스타일 ID 인벤토리 + 표 shape.

    edit-section 의 start/end 인덱스와 사용할 paraPr/charPr ID를 여기서 확인한다.
    (텍스트가 아닌 인덱스로 섹션 경계를 잡는다 — new_hwpx_master 2단계.)
    """
    import hwpx_xml as hx

    path = _ensure_file(args.file)
    sec_names = hx.section_entry_names(path)
    if not sec_names:
        _die(2, "section XML 없음")
    target = _resolve_section_entry(args.section_file, sec_names)
    if target is None:
        _die(2, f"section XML 없음: {args.section_file}")
    with zipfile.ZipFile(path) as zf:
        names = zf.namelist()
        data = zf.read(target)
        header = zf.read("Contents/header.xml") if "Contents/header.xml" in names else None

    root = hx.parse_xml(data).getroot()
    sec = hx.find_sec(root)
    children = list(sec)

    blueprint: dict = {"file": str(path), "section": target, "sec_children": []}
    for i, child in enumerate(children):
        local = hx.localname(child)
        entry: dict = {"index": i, "kind": local}
        if local == "p":
            entry["text"] = hx.paragraph_text(child)[:80]
            entry["paraPrIDRef"] = child.get("paraPrIDRef")
            entry["styleIDRef"] = child.get("styleIDRef")
            tbls = [e for e in child.iter() if hx.localname(e) == "tbl"]
            if tbls:
                entry["table"] = {"rowCnt": tbls[0].get("rowCnt"), "colCnt": tbls[0].get("colCnt")}
        blueprint["sec_children"].append(entry)

    if header is not None:
        h = hx.parse_xml(header).getroot()
        inv: dict[str, list] = {"charPr": [], "paraPr": [], "borderFill": []}
        for el in h.iter():
            ln = hx.localname(el)
            if ln in inv and el.get("id") is not None:
                inv[ln].append(el.get("id"))
        blueprint["style_ids"] = inv

    if args.format == "json":
        json.dump(blueprint, sys.stdout, ensure_ascii=False, indent=2)
        print()
    else:
        print(f"# {path} — {target}")
        print(f"sec 직계 자식: {len(children)}개")
        for e in blueprint["sec_children"]:
            if e["kind"] == "p":
                tbl = f" [table {e['table']['rowCnt']}x{e['table']['colCnt']}]" if e.get("table") else ""
                preview = (e.get("text") or "").replace("\n", " ")
                print(f"  [{e['index']:>3}] p  paraPr={e.get('paraPrIDRef')} style={e.get('styleIDRef')}{tbl}  {preview}")
            else:
                print(f"  [{e['index']:>3}] {e['kind']}")
        if "style_ids" in blueprint:
            s = blueprint["style_ids"]
            print(f"\nstyle IDs: charPr={s['charPr']}  paraPr={s['paraPr']}  borderFill={s['borderFill']}")
    return 0


def cmd_guard(args) -> int:
    """레퍼런스 대비 페이지 드리프트 게이트 (validate와 별개, 레이아웃 보존 검증)."""
    import page_guard as pg

    ref = _ensure_file(args.reference)
    out = _ensure_file(args.output)
    ref_m = pg.collect_metrics(ref)
    out_m = pg.collect_metrics(out)
    errors = pg.compare_metrics(
        ref_m, out_m,
        max_text_delta_ratio=args.max_text_delta_ratio,
        max_paragraph_delta_ratio=args.max_paragraph_delta_ratio,
    )
    if errors:
        print(f"[hwpx] guard FAIL: 레이아웃 드리프트 위험 ({len(errors)}건)", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        sys.exit(1)
    print(f"[hwpx] guard PASS: {out} (레퍼런스 대비 구조/길이 편차 허용 내)", file=sys.stderr)
    return 0


def cmd_edit_section(args) -> int:
    """sec 직계자식 [start:end) 본문 단락을 새 내용으로 교체 (서식 보존).

    ref-index 단락을 deepcopy 템플릿으로 삼아 한 줄당 한 단락 생성 → 인덱스
    범위를 통째 치환. 인덱스는 `analyze`로 확인한다. linesegarray 자동 정리.
    """
    import hwpx_xml as hx

    path = _ensure_file(args.file)
    secs = hx.section_entry_names(path)
    target = _resolve_section_entry(args.section_file, secs)
    with zipfile.ZipFile(path) as zf:
        names = zf.namelist()
        if target is None or target not in names:
            _die(2, f"section XML 없음: {args.section_file or '<default>'}")
        data = zf.read(target)

    tree = hx.parse_xml(data)
    sec = hx.find_sec(tree.getroot())
    children = list(sec)
    start, end = args.start, args.end
    if not (0 <= start < end <= len(children)):
        _die(1, f"인덱스 범위 오류: start={start} end={end} (sec children={len(children)})")

    ref_idx = args.ref_index if args.ref_index is not None else start
    if not (0 <= ref_idx < len(children)) or hx.localname(children[ref_idx]) != "p":
        _die(1, f"ref-index {ref_idx} 가 <hp:p> 아님")
    if any(hx.localname(el) == "secPr" for el in children[ref_idx].iter()):
        _die(1, f"ref-index {ref_idx} 는 section 속성(secPr)을 포함해 복제 불가")
    if any(
        hx.localname(el) == "secPr"
        for child in children[start:end]
        for el in child.iter()
    ):
        _die(1, f"교체 범위 [{start}:{end}) 에 section 속성(secPr) 문단 포함")
    ref = children[ref_idx]

    if args.lines:
        lines = Path(args.lines).read_text(encoding="utf-8").splitlines()
    elif args.stdin:
        lines = sys.stdin.read().splitlines()
    else:
        _die(1, "내용 없음: --lines <file> 또는 --stdin")

    clones = [hx.clone_para(ref, [line]) for line in lines]
    hx.replace_section_body(sec, start, end, clones)
    out = Path(args.output or _derive_output(str(path), suffix="-edited.hwpx"))
    hx.rewrite_entries(path, out, {target: hx.serialize(tree)})
    print(
        f"[hwpx] edit-section [{start}:{end}) → {len(clones)}단락 "
        f"({ref_idx}번 스타일 복제) → {out}",
        file=sys.stderr,
    )
    return 0


def cmd_fill_form(args) -> int:
    """라벨-값 표 양식 채우기 — 표의 `라벨 | 값` 셀 / 헤더+데이터행 매칭 (서식 보존)."""
    import hwpx_xml as hx

    src = _ensure_file(args.form)
    data = _load_kv_data(args)
    if not data:
        _die(1, "값 없음 (--data / --kv / --stdin-json) — 라벨=값 형식")
    out = Path(args.output or _derive_output(args.form, suffix="-filled.hwpx"))
    filled, unmatched = hx.fill_form(src, out, {str(k): str(v) for k, v in data.items()})
    for label, val in filled:
        print(f"[hwpx] {label} → {val}", file=sys.stderr)
    if unmatched:
        print(f"[hwpx] ⚠️  미매칭 라벨 {len(unmatched)}건: {', '.join(unmatched)}", file=sys.stderr)
    print(f"[hwpx] fill-form {len(filled)}건 채움 → {out}", file=sys.stderr)
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

    s = sub.add_parser("analyze", help="편집 청사진 (sec 인덱스 맵 + 스타일 ID)")
    s.add_argument("file")
    s.add_argument("--section-file", help="대상 section XML 엔트리 (기본: section0.xml)")
    s.add_argument("--format", choices=["text", "json"], default="text")
    s.set_defaults(func=cmd_analyze)

    s = sub.add_parser("guard", help="레퍼런스 대비 페이지 드리프트 게이트")
    s.add_argument("--reference", "-r", required=True, help="기준 HWPX")
    s.add_argument("--output", "-o", required=True, help="결과 HWPX")
    s.add_argument("--max-text-delta-ratio", type=float, default=0.15)
    s.add_argument("--max-paragraph-delta-ratio", type=float, default=0.25)
    s.set_defaults(func=cmd_guard)

    s = sub.add_parser("edit-section", help="sec 본문 단락 범위 교체 (서식 보존, 인덱스 기반)")
    s.add_argument("file")
    s.add_argument("--start", type=int, required=True, help="교체 시작 sec 자식 인덱스")
    s.add_argument("--end", type=int, required=True, help="교체 끝 인덱스 (exclusive)")
    s.add_argument("--ref-index", type=int, default=None, help="스타일 복제용 참조 단락 인덱스 (기본: start)")
    s.add_argument("--lines", help="줄당 한 단락이 될 텍스트 파일")
    s.add_argument("--stdin", action="store_true", help="stdin에서 줄 입력")
    s.add_argument("--section-file", help="대상 section XML (기본: section0.xml)")
    s.add_argument("-o", "--output")
    s.set_defaults(func=cmd_edit_section)

    s = sub.add_parser("fill-form", help="라벨-값 표 양식 채우기 (서식 보존)")
    s.add_argument("form")
    s.add_argument("--data", help="JSON 파일 (라벨:값)")
    s.add_argument("--kv", action="append", help="라벨=값 (반복 가능)")
    s.add_argument("--stdin-json", action="store_true")
    s.add_argument("-o", "--output")
    s.set_defaults(func=cmd_fill_form)

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
