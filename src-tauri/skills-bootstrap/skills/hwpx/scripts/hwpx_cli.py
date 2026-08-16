#!/usr/bin/env python3
"""hwpx-toolkit CLI dispatcher.

Subcommands:
  read <file.hwpx> [--format md|text|json] [--section N] [--engine auto|hwp|lxml]
  summary <file.hwpx>
  to-md <file.hwpx> [-o out.md] [--media-dir figs] [--section N] [--engine auto|hwp|lxml]
        (-o 시 hwp-cli convert 위임 — 이미지를 <출력스템>.media/ 또는 --media-dir로 추출)
  unpack <file.hwpx> <out_dir> [-f]
  repack <dir> <out.hwpx>
  fill <template.hwpx> [--data json_file] [--kv key=value ...] [-o out.hwpx] [--stdin-json]
  slots <template.hwpx> [--format text|json]
  edit <in.hwpx> <out.hwpx> --replace OLD NEW [--limit N]
  add-rows <file> --count N [--table T] [--set-cell "T:row:col=val" ...] [-o out]
  add-col <file> [--table T] [--count N] [--set-cell "T:row:col=val" ...] [-o out]
        (전체 표 폭 유지하며 열 추가 — 기존 열 균등 축소, 병합 표는 거부)
  fill-table <file> --data tables.json [-o out]   (행 자동 증식 + 셀 채우기)
  create <out.hwpx> [--markdown md_file | --title T --body B | --json j_file] [--plain]
  styled -o <out.hwpx> [--preset gongmun|bogoseo|gian|report] [--reference form.hwpx]
         [--markdown md | --json j | --stdin-markdown | --stdin-json] [--header H] [--footer F] [--plain]
  beautify <in.hwpx> [-o out.hwpx] [--header-fill "#F2F2F2"] [--no-title-center]
  validate <file.hwpx>
  analyze <file.hwpx> [--section-file section0.xml] [--format text|json]
  guard --reference <ref.hwpx> --output <out.hwpx>
  edit-section <file.hwpx> --start N --end M [--ref-index R] [--lines f | --stdin] [-o out.hwpx]
  fill-form <form.hwpx> [--data json_file] [--kv label=value ...] [--stdin-json] [-o out.hwpx]
  to-pdf <file.hwpx> [-o out.pdf] [--engine auto|hwp|soffice]
  render-pdf <file.hwpx> [-o out.pdf]   (alias of `to-pdf --engine hwp`)
  to-html <file.hwpx> [-o out.html]
  write-java <out.hwpx> [--markdown md | --input txt]   (legacy alias → hwp-cli new)

Generation/conversion/render/validate delegate to the Rust hwp-cli (`hwp`);
slot/structure editing uses lxml. No bundled Java/JRE.

템플릿 없는 생성(create/styled/write-java)은 공문서 기본 스타일 후처리(style_pass —
표 칼럼 폭/헤더 음영/제목 가운데; 근거 references/style-patterns.md)를 자동 적용한다.
--plain 으로 생략, 기존 파일엔 beautify.

All commands: exit 0 success, 1 arg/IO error, 2 parse failure, 3 not found.
"""
from __future__ import annotations

import argparse
import functools
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

# 이 스킬이 전제하는 hwp-cli 최소 버전. 0.3.0 미만은 hwpx 쓰기에서 수식(<hp:equation>)을
# 경고 없이 통째로 버린다(GE-14). 편집·변환만 해도 유실되므로 경고 대상.
HWP_CLI_MIN = (0, 3, 0)
STYLED_PRESET_ALIASES = {
    "gongmun": "gian",
    "gian": "gian",
    "bogoseo": "report",
    "report": "report",
}


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


def _create_markdown_from_args(args) -> str:
    """create 인자(title/body/markdown/json)를 markdown으로 합성 (hwp new 위임용)."""
    parts: list[str] = []
    if args.title:
        parts.append(f"# {args.title}")
    if args.body:
        parts.extend(args.body.splitlines() or [args.body])
    if args.markdown:
        parts.append(Path(args.markdown).read_text(encoding="utf-8"))
    if args.json:
        payload = json.loads(Path(args.json).read_text(encoding="utf-8"))
        parts.extend(_json_payload_to_markdown(payload))
    parts = [p for p in parts if p is not None]
    return "\n\n".join(parts)


def _json_payload_to_markdown(payload) -> list[str]:
    """create/styled의 JSON 블록 스키마 → markdown 조각 리스트."""
    out: list[str] = []
    if isinstance(payload, dict):
        if payload.get("title"):
            out.append(f"# {payload['title']}")
        if payload.get("subtitle"):
            out.append(f"## {payload['subtitle']}")
        for para in payload.get("paragraphs", []):
            out.append(str(para))
        for block in payload.get("blocks", []):
            if isinstance(block, str):
                out.append(block)
                continue
            kind = block.get("kind", "para")
            text = str(block.get("text", ""))
            if kind == "title":
                out.append(f"# {text}")
            elif kind == "subtitle":
                out.append(f"## {text}")
            elif kind == "heading":
                level = max(1, min(6, int(block.get("level", 1))))
                out.append("#" * level + " " + text)
            elif kind == "separator":
                out.append("")
            else:
                out.append(text)
    elif isinstance(payload, list):
        out.extend(str(p) for p in payload)
    return out


# subcommand implementations

def _hwp_version(binary: str) -> tuple[int, int, int] | None:
    """`hwp --version`이 `hwp X.Y.Z`를 내면 버전 튜플, 아니면 None. 동명이인(구
    hwp-toolkit 래퍼처럼 `hwp`라는 이름을 공유하지만 hwp-cli가 아닌 것)을
    걸러내는 판별자를 겸한다."""
    try:
        proc = subprocess.run([binary, "--version"], capture_output=True, timeout=5)
    except OSError:
        return None
    m = re.match(r"hwp (\d+)\.(\d+)\.(\d+)", proc.stdout.decode("utf-8", "ignore").strip())
    return (int(m[1]), int(m[2]), int(m[3])) if m else None


@functools.lru_cache(maxsize=1)
def _find_hwp_cli() -> str | None:
    """hwp-cli(Rust) `hwp` 바이너리 탐색. `$HWP_CLI`가 지정되면 그것을 쓰고(명시적
    의도 우선), 없으면 알려진 설치 경로(PATH의 Homebrew 설치·`~/.cargo/bin`·
    워크스페이스 dev 릴리스 빌드) 중 **버전이 가장 높은 것**을 고른다.

    고정 순서가 아니라 버전 최대를 쓰는 이유: 세 곳에 동시에 설치되는 게 정상이라
    (brew 설치 + cargo install + dev 빌드) 고정 순서는 오래된 사본을 집어 신기능이
    조용히 안 보인다. 실제로 0.2.0이 hwpx 쓰기에서 수식을 통째로 버렸다.

    어느 경로로 잡혔든 HWP_CLI_MIN 미만이면 stderr에 경고한다(무경고 데이터 유실
    방지 — 명시 지정도 예외가 아니다)."""
    chosen: tuple[tuple[int, int, int], str] | None = None
    explicit = os.environ.get("HWP_CLI")
    if explicit and Path(explicit).is_file() and os.access(explicit, os.X_OK):
        v = _hwp_version(explicit)
        if v is None:  # 버전을 못 읽어도 명시 지정은 존중하되 검증은 못 한다
            return explicit
        chosen = (v, explicit)
    else:
        seen: set[str] = set()
        for c in (
            shutil.which("hwp"),
            str(Path.home() / ".cargo" / "bin" / "hwp"),
            str(Path.home() / "workspace/work/dev/hwp-cli/target/release/hwp"),
        ):
            if not c or not Path(c).is_file() or not os.access(c, os.X_OK):
                continue
            real = os.path.realpath(c)  # brew 심링크 등 같은 실체를 두 번 재지 않는다
            if real in seen:
                continue
            seen.add(real)
            v = _hwp_version(c)
            if v and (chosen is None or v > chosen[0]):
                chosen = (v, c)
    if chosen is None:
        return None
    if chosen[0] < HWP_CLI_MIN:
        print(
            f"[hwpx] 경고: hwp-cli {'.'.join(map(str, chosen[0]))} 사용 중 "
            f"({chosen[1]}). 이 스킬은 {'.'.join(map(str, HWP_CLI_MIN))} 이상을 "
            "전제하며, 구버전은 hwpx 쓰기에서 수식을 경고 없이 버린다. "
            "`brew upgrade hwp` 또는 `cargo install --path crates/hwp-cli --force`로 갱신할 것",
            file=sys.stderr,
        )
    return chosen[1]


@functools.lru_cache(maxsize=None)
def _supports_new_preset(binary: str) -> bool:
    """해당 hwp-cli가 `hwp new --preset`을 실제로 제공하는지 확인한다.

    버전 번호만으로 판단하지 않는다. 같은 개발 버전의 서로 다른 빌드가 PATH와
    워크스페이스에 함께 있을 수 있기 때문이다.
    """
    try:
        proc = subprocess.run(
            [binary, "new", "--help"],
            capture_output=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    help_text = (
        proc.stdout.decode("utf-8", "ignore")
        + "\n"
        + proc.stderr.decode("utf-8", "ignore")
    )
    return proc.returncode == 0 and "--preset" in help_text


@functools.lru_cache(maxsize=None)
def _supports_convert_format(binary: str, fmt: str) -> bool:
    """해당 hwp-cli의 `convert --to`가 이 포맷을 실제로 받는지 확인한다.

    `_supports_new_preset`과 같은 이유로 버전 번호가 아니라 능력을 직접 묻는다.

    help 안의 **모든** `possible values` 목록을 합쳐서 본다. `--to` 것만 집으려 들면
    앞서 나오는 `--lang`의 `[en, ko]`를 잡아 멀쩡한 바이너리를 막는다. 오탐(막지 않고
    통과)은 hwp-cli가 어차피 거부하므로 무해하지만, 미탐(동작하는 바이너리를 막음)은
    사용자를 막다른 길로 보낸다.
    """
    try:
        proc = subprocess.run([binary, "convert", "--help"], capture_output=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return False
    if proc.returncode != 0:
        return False
    help_text = proc.stdout.decode("utf-8", "ignore") + "\n" + proc.stderr.decode("utf-8", "ignore")
    lists = re.findall(r"possible values:\s*([^\]]+)\]", help_text)
    if not lists:  # 목록을 못 읽으면 막지 않는다 — 시도해 보고 hwp-cli가 판정하게 둔다
        return True
    return any(fmt in {t.strip() for t in group.split(",")} for group in lists)


@functools.lru_cache(maxsize=1)
def _find_hwp_cli_with_new_preset() -> str | None:
    """`new --preset`을 제공하는 hwp-cli 중 가장 높은 버전을 선택한다.

    `$HWP_CLI`가 명시되면 다른 설치본으로 우회하지 않는다. 자동 탐색일 때만
    preset 미지원 사본을 제외하고 PATH/cargo/dev 후보 중 가장 높은 버전을 쓴다.
    """
    explicit = os.environ.get("HWP_CLI")
    if explicit and Path(explicit).is_file() and os.access(explicit, os.X_OK):
        return explicit if _supports_new_preset(explicit) else None

    chosen: tuple[tuple[int, int, int], str] | None = None
    seen: set[str] = set()
    for candidate in (
        shutil.which("hwp"),
        str(Path.home() / ".cargo" / "bin" / "hwp"),
        str(Path.home() / "workspace/work/dev/hwp-cli/target/release/hwp"),
    ):
        if (
            not candidate
            or not Path(candidate).is_file()
            or not os.access(candidate, os.X_OK)
        ):
            continue
        real = os.path.realpath(candidate)
        if real in seen:
            continue
        seen.add(real)
        version = _hwp_version(candidate)
        if (
            version
            and _supports_new_preset(candidate)
            and (chosen is None or version > chosen[0])
        ):
            chosen = (version, candidate)
    return chosen[1] if chosen else None


def _hwp_cat(path: Path, fmt: str = "markdown") -> str:
    """hwp-cli `cat` 텍스트 추출 (stdout만, 경고는 stderr). fmt: plain|markdown|json|html."""
    tool = _find_hwp_cli()
    if not tool:
        raise FileNotFoundError("hwp-cli('hwp') 미발견")
    proc = subprocess.run(
        [tool, "cat", str(path), "--format", fmt], capture_output=True, timeout=120
    )
    if proc.returncode != 0:
        raise RuntimeError(f"hwp cat 실패: {proc.stderr.decode('utf-8', 'ignore').strip()}")
    return proc.stdout.decode("utf-8", "ignore")


def _hwpx_text_via_cli(path: Path, cli_fmt: str) -> str | None:
    """.hwpx 텍스트 추출을 hwp-cli `cat`으로 우선 시도. hwp-cli 미발견/실패 시
    None 을 돌려 호출부가 lxml 추출로 폴백하도록 함. cli_fmt: plain|markdown|json."""
    if not _find_hwp_cli():
        return None
    try:
        return _hwp_cat(path, cli_fmt)
    except Exception as e:  # noqa: BLE001 — 어떤 실패든 lxml 폴백
        print(f"[hwpx] hwp-cli cat 폴백 → lxml: {e}", file=sys.stderr)
        return None


def _hwp_cli_or_die(*, require_new_preset: bool = False) -> str:
    tool = _find_hwp_cli_with_new_preset() if require_new_preset else _find_hwp_cli()
    if not tool:
        if require_new_preset:
            explicit = os.environ.get("HWP_CLI")
            pinned = f" 지정된 HWP_CLI({explicit})가" if explicit else " 설치된 hwp-cli가"
            _die(
                1,
                f"{pinned} `hwp new --preset`을 지원하지 않음. "
                "hwp-cli v0.4.1 이상으로 `brew update && brew upgrade hwp`하거나 "
                "preset 지원 바이너리를 HWP_CLI로 지정할 것",
            )
        _die(1, "hwp-cli('hwp') 미발견 — `cargo install --path crates/hwp-cli` 또는 HWP_CLI 지정")
    return tool


def _hwp_env() -> dict:
    """hwp-cli 서브프로세스 환경 — PDF 폰트 임베드를 위해 HWP_FONT_DIR 보강."""
    env = dict(os.environ)
    if "HWP_FONT_DIR" not in env:
        for cand in (Path.home() / ".maru/env/fonts", Path.home() / "Library/Fonts"):
            if cand.is_dir():
                env["HWP_FONT_DIR"] = str(cand)
                break
    return env


def _run_hwp(
    argv: list, *, require_new_preset: bool = False
) -> subprocess.CompletedProcess:
    """확장된 hwp-cli에 위임 실행 (capture)."""
    tool = _hwp_cli_or_die(require_new_preset=require_new_preset)
    return subprocess.run([tool, *argv], capture_output=True, text=True, env=_hwp_env())


def _new_from_markdown(
    md_text: str,
    out: Path,
    preset: str | None = None,
    *,
    plain: bool = False,
    base_dir: Path | None = None,
) -> int:
    """markdown을 임시 파일로 써서 hwp-cli `new`에 위임 (문서 생성 통합 경로).

    생성 후 공문서 기본 스타일 후처리(style_pass — 표 칼럼 폭/헤더 음영/제목 가운데)를
    적용한다. `plain=True`면 후처리만 생략한다. preset이 지정되면 하위호환 별칭을
    hwp-cli의 canonical 이름으로 바꿔 `hwp new --preset`에 전달한다.

    `base_dir`: 상대경로 이미지(`![alt](img.png)`)의 해석 기준. hwp-cli `new`는 md 파일
    위치 기준으로 이미지를 찾으므로, 원본 md가 있으면 그 디렉터리에 임시 파일을 둬야
    상대 경로가 유지된다(미지정 시 시스템 임시 디렉터리 — 상대 이미지는 떨어진다).
    """
    import tempfile

    canonical_preset = STYLED_PRESET_ALIASES.get(preset) if preset else None
    if preset and canonical_preset is None:
        _die(1, f"알 수 없는 preset: {preset}")
    tf = tempfile.NamedTemporaryFile(
        "w",
        suffix=".md",
        delete=False,
        encoding="utf-8",
        dir=str(base_dir) if base_dir else None,
    )
    try:
        tf.write(md_text)
        tf.close()
        cmd = ["new", "--from", tf.name, "-o", str(out)]
        if canonical_preset:
            cmd.extend(["--preset", canonical_preset])
        proc = _run_hwp(cmd, require_new_preset=canonical_preset is not None)
    finally:
        os.unlink(tf.name)
    if proc.returncode != 0:
        _die(2, f"hwp new 실패: {proc.stderr.strip()}")
    if not plain:
        import style_pass

        stats = style_pass.apply_default_style(out)
        print(f"[hwpx] style-pass: {stats}", file=sys.stderr)
    return 0


def _tagged_lines_to_markdown(text: str) -> str:
    """레거시 write-java 태그 라인(H1:/P:)을 markdown으로 환원."""
    out: list[str] = []
    for line in text.splitlines():
        if len(line) > 2 and line[0] == "H" and line[1].isdigit() and line[2] == ":":
            out.append("#" * int(line[1]) + " " + line[3:])
        elif line.startswith("P:"):
            out.append(line[2:])
        else:
            out.append(line)
    return "\n\n".join(out)


def _delegate_hwp_read(path: Path, fmt: str) -> int:
    """Binary .hwp(v5 OLE2) is not parsed here — delegate read to hwp-cli (`hwp cat`)."""
    tool = _find_hwp_cli()
    if not tool:
        _die(
            1,
            ".hwp(바이너리)는 이 스킬이 직접 처리하지 않음. hwp-cli 미발견 — "
            "`cargo install --path crates/hwp-cli`로 설치하거나 HWP_CLI=<.../hwp> 지정",
        )
    cli_fmt = {"text": "plain", "md": "markdown", "json": "json"}.get(fmt, "markdown")
    try:
        proc = subprocess.run(
            [tool, "cat", str(path), "--format", cli_fmt],
            capture_output=True, text=True, timeout=120,
        )
    except (subprocess.TimeoutExpired, OSError) as e:
        _die(2, f"hwp-cli 위임 실패: {e}")
    if proc.returncode != 0:
        _die(2, f"hwp-cli cat 실패: {(proc.stderr or proc.stdout).strip()}")
    sys.stdout.write(proc.stdout)
    print(f"[hwpx] .hwp → hwp-cli 위임 ({tool})", file=sys.stderr)
    return 0


def cmd_read(args) -> int:
    path = _ensure_file(args.file)
    if path.suffix.lower() == ".hwp":
        return _delegate_hwp_read(path, args.format)
    engine = getattr(args, "engine", "auto")
    # .hwpx text/markdown: hwp-cli `cat` 우선 (섹션 선택 없을 때), 실패 시 lxml 폴백
    if args.format in ("text", "md") and args.section is None and engine != "lxml":
        cli_fmt = "plain" if args.format == "text" else "markdown"
        text = _hwpx_text_via_cli(path, cli_fmt)
        if text is not None:
            sys.stdout.write(text)
            return 0
        if engine == "hwp":
            _die(1, "hwp-cli('hwp') 미발견/실패 — cargo install --path crates/hwp-cli 또는 HWP_CLI 지정")
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
    engine = getattr(args, "engine", "auto")
    # 파일 출력은 hwp-cli `convert` 우선 — 이미지를 사이드카 디렉터리(기본 <스템>.media,
    # --media-dir로 지정)에 추출하고 목록·각주·수식·병합셀까지 보존한다.
    # stdout 출력은 이미지 추출이 없는 `cat` 경로 유지(hwp-cli 의미와 동일).
    if args.output and args.section is None and engine != "lxml" and _find_hwp_cli():
        out = Path(args.output)
        cmd = ["convert", str(path), "--to", "md", "-o", str(out)]
        if args.media_dir:
            cmd += ["--media-dir", args.media_dir]
        proc = _run_hwp(cmd)
        if proc.returncode == 0:
            media = args.media_dir or f"{out.stem}.media"
            print(f"[hwpx] convert(→md) -> {out} (이미지: {media}/)", file=sys.stderr)
            return 0
        print(f"[hwpx] hwp convert 폴백 → cat: {proc.stderr.strip()}", file=sys.stderr)
    md = None
    # hwp-cli `cat` markdown 우선 (섹션 선택 없을 때), 실패 시 lxml 폴백
    if args.section is None and engine != "lxml":
        md = _hwpx_text_via_cli(path, "markdown")
        if md is None and engine == "hwp":
            _die(1, "hwp-cli('hwp') 미발견/실패 — cargo install --path crates/hwp-cli 또는 HWP_CLI 지정")
    if md is None:
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

    out = Path(args.output or _derive_output(args.template, suffix="-filled.hwpx"))
    # hwp-cli 충실도 보존 fill (미리보기·compat·스타일 보존). --set name=value 로 전달.
    sets: list = []
    for key, value in data.items():
        sets += ["--set", f"{key}={value}"]
    proc = _run_hwp(["fill", str(src), "-o", str(out), *sets, "--json"])
    if proc.returncode != 0:
        _die(2, f"fill 실패: {proc.stderr.strip()}")
    summary = json.loads(proc.stdout)
    counts = summary.get("counts", {})
    total = summary.get("replaced", 0)
    unfilled = [a for a, n in counts.items() if n == 0]
    if unfilled:
        print(f"[hwpx] ⚠️  미치환 maru {len(unfilled)}건: {', '.join(unfilled)}", file=sys.stderr)
    print(f"[hwpx] {total}건 치환 -> {out}", file=sys.stderr)
    return 0


def cmd_slots(args) -> int:
    input_path = _ensure_file(args.template)
    if input_path.suffix.lower() != ".hwpx":
        _die(1, f"slots는 .hwpx 파일만 지원: {input_path}")

    proc = _run_hwp(["slots", str(input_path), "--json"])
    if proc.returncode != 0:
        _die(2, f"슬롯 스캔 실패: {proc.stderr.strip()}")
    placeholders = json.loads(proc.stdout).get("placeholders", [])
    fields = [
        {
            "key": p["name"],
            "label": p["name"],
            "required": True,
            "occurrences": p["occurrences"],
        }
        for p in placeholders
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


def cmd_add_rows(args) -> int:
    """표 행 추가 (양식 변형) → hwp edit --add-row 위임. .hwp/.hwpx 모두.

    표의 마지막 행을 복제해 빈 행 N개를 추가하고, --set-cell 로 새 행을 채울 수 있다
    (새 행 인덱스는 기존 행 수부터). --template-row 는 hwp-cli 모델(항상 마지막 행 복제)
    에서 미지원이라 무시한다.
    """
    src = _ensure_file(args.in_file)
    out = Path(args.output or _derive_output(args.in_file, suffix=f"-grown{Path(args.in_file).suffix}"))
    # hwp edit --add-row 는 표 인덱스 1개당 1행(마지막 행 복제) → count 만큼 반복한다.
    cmd = ["edit", str(src), "-o", str(out)]
    for _ in range(args.count):
        cmd += ["--add-row", str(args.table)]
    proc = _run_hwp(cmd)
    if proc.returncode != 0:
        _die(2, f"add-rows 실패: {proc.stderr.strip()}")
    # --set-cell 은 edit 안에서 --add-row 보다 먼저 적용돼(새 행이 아직 없음) 같은 호출로는
    # 새 행을 못 채운다 → 행 추가 후 2차 패스로 채운다(edit 는 전체 IR 왕복이라 제자리 안전).
    if args.set_cell:
        cmd2 = ["edit", str(out), "-o", str(out)]
        for sc in args.set_cell:
            cmd2 += ["--set-cell", sc]
        proc2 = _run_hwp(cmd2)
        if proc2.returncode != 0:
            _die(2, f"add-rows 셀 채우기 실패: {proc2.stderr.strip()}")
    print(f"[hwpx] 표{args.table}에 {args.count}행 추가 -> {out}", file=sys.stderr)
    return 0


def cmd_add_col(args) -> int:
    """표 열 추가 (전체 폭 유지) → hwp edit --add-col 위임. .hwp/.hwpx 모두.

    새 열은 균등 몫(행총폭/(열수+1))을 갖고 기존 열은 비율로 축소된다(행별 정수 잔차는
    마지막 기존 셀에 가산해 총폭 정확 보존). v0.2.0부터 열 추가는 병합 셀 표도 지원한다
    (피병합 셀 생략·병합 cellSz 규칙 — 정품 실측). 새 열 인덱스는 기존 열 수이고, --set-cell 로
    새 셀을 채울 수 있다(add-rows와 같은 2차 패스). 위치 삽입·열 삭제·셀 병합/분할은
    hwp edit --add-col "표:위치"/--delete-col/--merge-cells/--split-cell 직접 호출(SKILL.md §4).
    """
    src = _ensure_file(args.in_file)
    out = Path(args.output or _derive_output(args.in_file, suffix=f"-wide{Path(args.in_file).suffix}"))
    cmd = ["edit", str(src), "-o", str(out)]
    for _ in range(args.count):
        cmd += ["--add-col", str(args.table)]
    proc = _run_hwp(cmd)
    if proc.returncode != 0:
        _die(2, f"add-col 실패: {proc.stderr.strip()}")
    # --set-cell 은 edit 안에서 --add-col 보다 먼저 적용돼(새 열이 아직 없음) 같은 호출로는
    # 새 셀을 못 채운다 → 열 추가 후 2차 패스로 채운다.
    if args.set_cell:
        cmd2 = ["edit", str(out), "-o", str(out)]
        for sc in args.set_cell:
            cmd2 += ["--set-cell", sc]
        proc2 = _run_hwp(cmd2)
        if proc2.returncode != 0:
            _die(2, f"add-col 셀 채우기 실패: {proc2.stderr.strip()}")
    print(f"[hwpx] 표{args.table}에 {args.count}열 추가(전체 폭 유지) -> {out}", file=sys.stderr)
    return 0


def cmd_fill_table(args) -> int:
    """데이터 구동 표 채우기 (행 자동 증식) → hwp fill --data 위임.

    --data JSON 의 `tables` 지시대로 표를 데이터 수만큼 늘리고 셀을 채운다(선택적
    `fields` 로 {{키}} 치환). 자리표시자 전용 치환은 기존 `fill` 을 쓴다.
    """
    src = _ensure_file(args.in_file)
    out = Path(args.output or _derive_output(args.in_file, suffix=f"-filled{Path(args.in_file).suffix}"))
    proc = _run_hwp(["fill", str(src), "-o", str(out), "--data", str(_ensure_file(args.data)), "--json"])
    if proc.returncode != 0:
        _die(2, f"fill-table 실패: {proc.stderr.strip()}")
    try:
        summary = json.loads(proc.stdout)
        print(
            f"[hwpx] 표 채움 {summary.get('filled', 0)}건 (+{summary.get('rows_added', 0)}행) -> {out}",
            file=sys.stderr,
        )
    except Exception:
        print(f"[hwpx] 표 채움 -> {out}", file=sys.stderr)
    return 0


def cmd_create(args) -> int:
    out = Path(args.out_file)
    base = Path(args.markdown).parent if args.markdown else None
    rc = _new_from_markdown(
        _create_markdown_from_args(args), out, plain=args.plain, base_dir=base
    )
    if rc == 0:
        print(f"[hwpx] created -> {out}", file=sys.stderr)
    return rc


def cmd_write_java(args) -> int:
    """레거시 호환 별칭 — markdown/텍스트 → HWPX (이제 hwp-cli new 위임, Java 미사용)."""
    out = Path(args.out_file)
    if args.markdown:
        md = Path(args.markdown).read_text(encoding="utf-8")
    elif args.input:
        md = "\n\n".join(Path(args.input).read_text(encoding="utf-8").splitlines())
    else:
        md = _tagged_lines_to_markdown(sys.stdin.read())
    base = Path(args.markdown).parent if args.markdown else None
    rc = _new_from_markdown(md, out, plain=args.plain, base_dir=base)
    if rc == 0:
        print(f"[hwpx] created -> {out} (engine=hwp-cli)", file=sys.stderr)
    return rc


def cmd_styled(args) -> int:
    """비참조 생성은 hwp-cli `new` + 공문서 스타일 후처리(--plain 시 생략);
    --reference(슬롯 채우기)는 lxml 코어 유지. --preset은 비참조 생성에만 적용."""
    if not args.reference and (args.markdown or args.stdin_markdown):
        md_text = (
            Path(args.markdown).read_text(encoding="utf-8")
            if args.markdown
            else sys.stdin.read()
        )
        out = Path(args.output)  # styled는 -o 필수
        base = Path(args.markdown).parent if args.markdown else None
        rc = _new_from_markdown(
            md_text, out, args.preset, plain=args.plain, base_dir=base
        )
        if rc == 0:
            print(f"[hwpx] styled(hwp-cli) -> {out}", file=sys.stderr)
        return rc
    return _styled_legacy(args)


def _styled_legacy(args) -> int:
    """참조 템플릿 슬롯 채우기(lxml) + 비참조 JSON 생성(hwp-cli new). Java 미사용."""
    if args.reference:
        import styled as styled_mod

        if args.markdown:
            blocks = styled_mod.markdown_to_blocks(Path(args.markdown).read_text(encoding="utf-8"))
        elif args.json:
            blocks = _blocks_from_json(
                json.loads(Path(args.json).read_text(encoding="utf-8")), styled_mod
            )
        elif args.stdin_markdown:
            blocks = styled_mod.markdown_to_blocks(sys.stdin.read())
        elif args.stdin_json:
            blocks = _blocks_from_json(json.load(sys.stdin), styled_mod)
        else:
            _die(1, "소스 없음: --markdown / --json / --stdin-markdown / --stdin-json 중 하나 필요")
        try:
            out = styled_mod.follow_template(
                blocks,
                reference=args.reference,
                output=args.output,
                header=args.header,
                footer=args.footer,
            )
        except Exception as e:
            _die(2, f"styled --reference 실패: {type(e).__name__}: {e}")
        print(f"[hwpx] styled(reference, lxml) -> {out}", file=sys.stderr)
        return 0

    # 비참조 JSON/stdin-json → hwp-cli new 위임
    if args.json:
        payload = json.loads(Path(args.json).read_text(encoding="utf-8"))
    elif args.stdin_json:
        payload = json.load(sys.stdin)
    else:
        _die(1, "소스 없음: --markdown / --json / --stdin-markdown / --stdin-json 중 하나 필요")
    md = "\n\n".join(_json_payload_to_markdown(payload))
    _new_from_markdown(
        md,
        Path(args.output),
        args.preset,
        plain=getattr(args, "plain", False),
    )
    print(f"[hwpx] styled(hwp-cli) -> {args.output}", file=sys.stderr)
    return 0


def cmd_beautify(args) -> int:
    """기존 HWPX에 공문서 기본 스타일 패스 적용 (표 폭/헤더 음영/제목 가운데).

    가드(균등 폭 아닌 표·borderFill 혼합 표 스킵) 덕에 임의 파일에 안전·멱등 —
    이미 스타일된 표는 건드리지 않는다.
    """
    import style_pass

    src = _ensure_file(args.in_file)
    out = Path(args.output or _derive_output(args.in_file, suffix="-styled.hwpx"))
    stats = style_pass.apply_default_style(
        src, out, header_fill=args.header_fill, title_center=not args.no_title_center
    )
    print(f"[hwpx] beautify: {stats} -> {out}", file=sys.stderr)
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
    # hwp-cli 네이티브 검증 우선 (mimetype/필수 엔트리/XML 파싱); 미발견 시 lxml 폴백.
    if _find_hwp_cli():
        proc = _run_hwp(["validate", str(path)])
        if proc.stdout:
            sys.stdout.write(proc.stdout)
        if proc.stderr:
            sys.stderr.write(proc.stderr)
        return proc.returncode
    return _validate_lxml(path)


def _validate_lxml(path: Path) -> int:
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


def _to_pdf_soffice(args, out: Path) -> int:
    """LibreOffice(soffice) 경유 벡터·텍스트선택 PDF (HWPX 읽기에 H2Orestart 확장 필요)."""
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice:
        _die(
            1,
            "LibreOffice(soffice) 미설치 — 벡터 PDF 불가. "
            "기본 엔진(hwp-cli)으로 변환하려면 `--engine hwp`(또는 auto), "
            "벡터·텍스트선택 PDF가 필요하면 `brew install --cask libreoffice`(+H2Orestart)",
        )
    out_dir = out.parent.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    try:
        subprocess.run(
            [soffice, "--headless", "--convert-to", "pdf", "--outdir", str(out_dir), str(args.file)],
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
    print(f"[hwpx] to-pdf(soffice, 벡터) -> {out}", file=sys.stderr)
    return 0


def cmd_to_pdf(args) -> int:
    """HWP/HWPX → PDF. 기본 엔진은 hwp-cli 네이티브(텍스트 선택가능);
    `--engine soffice`로 LibreOffice 벡터 PDF."""
    src = _ensure_file(args.file)
    out = Path(args.output) if args.output else src.with_suffix(".pdf")
    engine = getattr(args, "engine", "auto")

    if engine == "soffice":
        return _to_pdf_soffice(args, out)

    if _find_hwp_cli():
        proc = _run_hwp(["convert", str(src), "--to", "pdf", "-o", str(out)])
        if proc.returncode == 0:
            print(f"[hwpx] to-pdf(hwp-cli, 선택가능) -> {out}", file=sys.stderr)
            return 0
        if engine == "hwp":
            _die(2, f"hwp-cli PDF 변환 실패: {proc.stderr.strip()}")
        print(f"[hwpx] hwp-cli 실패 → soffice 폴백: {proc.stderr.strip()}", file=sys.stderr)
    elif engine == "hwp":
        _die(1, "hwp-cli('hwp') 미발견 — `cargo install --path crates/hwp-cli` 또는 HWP_CLI 지정")

    # soffice 폴백 (벡터)
    return _to_pdf_soffice(args, out)


def cmd_render_pdf(args) -> int:
    """`to-pdf --engine hwp` 별칭 — hwp-cli 네이티브 텍스트 선택가능 PDF (.hwp/.hwpx)."""
    args.engine = "hwp"
    return cmd_to_pdf(args)


def cmd_to_html(args) -> int:
    """HWP/HWPX → HTML via hwp-cli 네이티브 (`hwp cat --format html`)."""
    src = _ensure_file(args.file)
    out = Path(args.output) if args.output else src.with_suffix(".html")
    proc = _run_hwp(["cat", str(src), "--format", "html"])
    if proc.returncode != 0:
        _die(2, f"to-html 실패: {proc.stderr.strip()}")
    out.write_text(proc.stdout, encoding="utf-8")
    print(f"[hwpx] to-html -> {out}", file=sys.stderr)
    return 0


# hwp-cli 조회·렌더·변환 passthrough (순수 위임 — 폴백·재구현 없음)

def cmd_info(args) -> int:
    """파일 정보(포맷/버전/속성/스트림) — hwp-cli `info` 위임.

    구조 요약(sections/paragraphs/styles)은 lxml 기반 `summary`를 쓴다 — 별개 관점.
    """
    path = _ensure_file(args.file)
    proc = _run_hwp(["info", str(path), *(["--json"] if args.json else [])])
    if proc.returncode != 0:
        _die(2, f"hwp info 실패: {proc.stderr.strip()}")
    sys.stdout.write(proc.stdout)
    return 0


def cmd_fields(args) -> int:
    """누름틀(필드) 목록 — hwp-cli `fields` 위임 (이름·종류·값). 빈 목록 정상."""
    path = _ensure_file(args.file)
    proc = _run_hwp(["fields", str(path), *(["--json"] if args.json else [])])
    if proc.returncode != 0:
        _die(2, f"hwp fields 실패: {proc.stderr.strip()}")
    sys.stdout.write(proc.stdout)
    return 0


def cmd_bookmarks(args) -> int:
    """책갈피 목록 — hwp-cli `bookmarks` 위임. 빈 목록 정상."""
    path = _ensure_file(args.file)
    proc = _run_hwp(["bookmarks", str(path), *(["--json"] if args.json else [])])
    if proc.returncode != 0:
        _die(2, f"hwp bookmarks 실패: {proc.stderr.strip()}")
    sys.stdout.write(proc.stdout)
    return 0


def cmd_render(args) -> int:
    """페이지 이미지 렌더(png/svg) — hwp-cli `render` 위임. PDF는 render-pdf/to-pdf."""
    src = _ensure_file(args.file)
    out = Path(args.output) if args.output else src.with_suffix(f".{args.format or 'png'}")
    cmd = ["render", str(src), "-o", str(out), "--pages", args.pages, "--dpi", str(args.dpi)]
    if args.format:
        cmd += ["--format", args.format]
    proc = _run_hwp(cmd)
    if proc.returncode != 0:
        _die(2, f"hwp render 실패: {proc.stderr.strip()}")
    print(f"[hwpx] render({args.pages}@{args.dpi}dpi) -> {out}", file=sys.stderr)
    return 0


def cmd_convert(args) -> int:
    """범용 포맷 변환 — hwp-cli `convert` 위임 (hwpx/md/json/odt/docx 등).

    PDF는 `to-pdf`(soffice 폴백 포함), markdown-HTML은 `to-html`이 더 편리하다.
    docx는 출력 전용(hwp-cli v0.7.0+) — .docx를 입력으로 넣을 수는 없다.
    """
    src = _ensure_file(args.file)
    # 구버전 바이너리에서 `--to docx`는 clap이 알 수 없는 값으로 거부하며, 그 메시지만
    # 봐서는 업그레이드가 필요하다는 걸 알기 어렵다. 능력을 먼저 물어 안내한다.
    tool = _hwp_cli_or_die()
    if not _supports_convert_format(tool, args.to):
        _die(
            1,
            f"{tool} 의 convert가 `--to {args.to}`를 지원하지 않음"
            + (" (docx 출력은 hwp-cli v0.7.0 이상)" if args.to == "docx" else "")
            + ". `brew update && brew upgrade hwp` 또는 HWP_CLI로 신버전 지정할 것",
        )
    out = Path(args.output) if args.output else src.with_suffix(f".{args.to}")
    cmd = ["convert", str(src), "--to", args.to, "-o", str(out)]
    if getattr(args, "media_dir", None):
        cmd += ["--media-dir", args.media_dir]
    if args.strict:
        cmd.append("--strict")
    proc = _run_hwp(cmd)
    if proc.returncode != 0:
        _die(2, f"hwp convert 실패: {proc.stderr.strip()}")
    print(f"[hwpx] convert(→{args.to}) -> {out}", file=sys.stderr)
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

    s = sub.add_parser("read", help="HWPX -> text/markdown/json (.hwpx text/md는 hwp-cli 우선)")
    s.add_argument("file")
    s.add_argument("--format", choices=["md", "text", "json"], default="md")
    s.add_argument("--section", type=int, default=None)
    s.add_argument("--engine", choices=["auto", "hwp", "lxml"], default="auto",
                   help="auto(기본): text/md는 hwp-cli cat 우선·lxml 폴백 / hwp: hwp-cli 강제 / "
                        "lxml: 순수 파이썬 (json·section 지정 시 항상 lxml)")
    s.set_defaults(func=cmd_read)

    s = sub.add_parser("summary", help="문서 메타 요약")
    s.add_argument("file")
    s.set_defaults(func=cmd_summary)

    s = sub.add_parser("to-md", help="HWPX -> markdown (hwp-cli 우선; -o 시 이미지 추출)")
    s.add_argument("file")
    s.add_argument("-o", "--output")
    s.add_argument("--media-dir", dest="media_dir", default=None,
                   help="(-o 필요) 이미지 추출 디렉터리 — 기본 <출력스템>.media, 상대경로는 출력 파일 기준")
    s.add_argument("--section", type=int, default=None)
    s.add_argument("--engine", choices=["auto", "hwp", "lxml"], default="auto",
                   help="auto(기본): hwp-cli cat 우선·lxml 폴백 / hwp: 강제 / lxml: 순수 파이썬 (section 지정 시 lxml)")
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

    s = sub.add_parser("add-rows", help="표 행 추가 (양식 변형, 마지막 행 복제) + 선택 채움")
    s.add_argument("in_file")
    s.add_argument("--table", type=int, default=0, help="표 인덱스(0-기반, 기본 0)")
    s.add_argument("--count", type=int, required=True, help="추가할 행 수")
    s.add_argument("--template-row", type=int, default=None, help="복제 원본 행(0-기반, 기본 마지막 병합 없는 행)")
    s.add_argument("--set-cell", action="append", help='새 행 채우기 "표:행:열=값" (반복 가능)')
    s.add_argument("-o", "--output")
    s.set_defaults(func=cmd_add_rows)

    s = sub.add_parser("add-col", help="표 열 추가 (전체 폭 유지, 기존 열 균등 축소) + 선택 채움")
    s.add_argument("in_file")
    s.add_argument("--table", type=int, default=0, help="표 인덱스(0-기반, 기본 0)")
    s.add_argument("--count", type=int, default=1, help="추가할 열 수 (기본 1)")
    s.add_argument("--set-cell", action="append", help='새 열 채우기 "표:행:열=값" (반복 가능)')
    s.add_argument("-o", "--output")
    s.set_defaults(func=cmd_add_col)

    s = sub.add_parser("fill-table", help="데이터 구동 표 채우기 (행 자동 증식) — --data tables 지시")
    s.add_argument("in_file")
    s.add_argument("--data", required=True, help='JSON 파일 ({"tables":[{"table":0,"start_row":1,"rows":[[..]]}]})')
    s.add_argument("-o", "--output")
    s.set_defaults(func=cmd_fill_table)

    s = sub.add_parser("create", help="신규 HWPX 생성 (markdown/JSON/inline)")
    s.add_argument("out_file")
    s.add_argument("--markdown", help="markdown 파일")
    s.add_argument("--title")
    s.add_argument("--body")
    s.add_argument("--json", help="JSON 파일 (title + paragraphs[] or blocks[])")
    s.add_argument("--plain", action="store_true", help="스타일 후처리(표/제목) 생략")
    s.set_defaults(func=cmd_create)

    s = sub.add_parser("styled", help="HWPX 생성 (공문서 스타일 후처리 / --reference 슬롯 채우기)")
    s.add_argument("-o", "--output", required=True, help="출력 파일 경로")
    s.add_argument(
        "--preset",
        choices=list(STYLED_PRESET_ALIASES),
        default="gongmun",
        help="문서 프리셋: gongmun|gian=기안문, bogoseo|report=보고서",
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
    s.add_argument("--plain", action="store_true", help="스타일 후처리(표/제목) 생략")
    s.set_defaults(func=cmd_styled)

    s = sub.add_parser(
        "beautify", help="기존 HWPX에 공문서 스타일 패스 (표 폭/헤더 음영/제목 가운데)"
    )
    s.add_argument("in_file")
    s.add_argument("-o", "--output", help="출력 (기본: <in>-styled.hwpx)")
    s.add_argument("--header-fill", default="#F2F2F2", help="헤더행 음영색 (기본 #F2F2F2)")
    s.add_argument("--no-title-center", action="store_true", help="제목 가운데/15pt 생략")
    s.set_defaults(func=cmd_beautify)

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

    s = sub.add_parser("to-pdf", help="PDF (기본 hwp-cli 네이티브 텍스트 선택가능, --engine soffice 벡터)")
    s.add_argument("file")
    s.add_argument("-o", "--output")
    s.add_argument("--engine", choices=["auto", "hwp", "soffice"], default="auto",
                   help="auto(기본): hwp-cli 우선·soffice 폴백 / hwp: hwp-cli 강제(텍스트 선택가능) / "
                        "soffice: LibreOffice 강제(벡터)")
    s.set_defaults(func=cmd_to_pdf)

    s = sub.add_parser("render-pdf", help="`to-pdf --engine hwp` 별칭 (hwp-cli 네이티브 PDF, .hwp/.hwpx)")
    s.add_argument("file")
    s.add_argument("-o", "--output")
    s.set_defaults(func=cmd_render_pdf)

    s = sub.add_parser("to-html", help="HWP/HWPX → HTML (hwp-cli 네이티브 cat --format html)")
    s.add_argument("file")
    s.add_argument("-o", "--output")
    s.set_defaults(func=cmd_to_html)

    s = sub.add_parser("info", help="파일 정보 (포맷/버전/스트림) — hwp-cli info")
    s.add_argument("file")
    s.add_argument("--json", action="store_true", help="JSON 출력")
    s.set_defaults(func=cmd_info)

    s = sub.add_parser("fields", help="누름틀(필드) 목록 (이름·종류·값) — hwp-cli fields")
    s.add_argument("file")
    s.add_argument("--json", action="store_true", help="JSON 출력")
    s.set_defaults(func=cmd_fields)

    s = sub.add_parser("bookmarks", help="책갈피 목록 — hwp-cli bookmarks")
    s.add_argument("file")
    s.add_argument("--json", action="store_true", help="JSON 출력")
    s.set_defaults(func=cmd_bookmarks)

    s = sub.add_parser("render", help="페이지 이미지 렌더 (png/svg) — hwp-cli render. PDF는 render-pdf")
    s.add_argument("file")
    s.add_argument("-o", "--output", help="출력 (생략 시 <in>.png)")
    s.add_argument("--pages", default="all", help='페이지 범위 "1"|"1-3"|"all" (기본 all)')
    s.add_argument("--dpi", type=int, default=96, help="해상도 DPI (기본 96)")
    s.add_argument("--format", choices=["png", "svg"], default=None,
                   help="출력 포맷 (생략 시 확장자 추론, 기본 png)")
    s.set_defaults(func=cmd_render)

    s = sub.add_parser("convert", help="범용 변환 (hwpx/md/json/odt 등) — hwp-cli convert. pdf→to-pdf, html→to-html 권장")
    s.add_argument("file")
    s.add_argument("--to", required=True,
                   choices=["hwp", "hwpx", "md", "json", "html", "odt", "pdf", "txt", "csv", "docx"],
                   help="출력 포맷 (docx는 출력 전용 — 읽기는 불가)")
    s.add_argument("-o", "--output", help="출력 (생략 시 <in>.<to>)")
    s.add_argument("--media-dir", dest="media_dir", default=None,
                   help="(md) 이미지 추출 디렉터리 — 기본 <출력스템>.media, 상대경로는 출력 파일 기준")
    s.add_argument("--strict", action="store_true", help="보존 불가(opaque) 데이터 발견 시 실패")
    s.set_defaults(func=cmd_convert)

    s = sub.add_parser("write-java", help="markdown/텍스트 → HWPX (hwp-cli new 위임, 레거시 별칭)")
    s.add_argument("out_file")
    src = s.add_mutually_exclusive_group()
    src.add_argument("--markdown", help="markdown 파일")
    src.add_argument("--input", help="평문 텍스트 파일 (줄당 한 문단)")
    s.add_argument("--plain", action="store_true", help="스타일 후처리(표/제목) 생략")
    s.set_defaults(func=cmd_write_java)

    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    return args.func(args) or 0


if __name__ == "__main__":
    sys.exit(main())
