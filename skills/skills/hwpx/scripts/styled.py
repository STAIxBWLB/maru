"""Styled HWPX reference-template filler.

`--reference` HWPX 슬롯 채우기(raw ZIP/XML, lxml 엔진)만 담당한다. binary HWP의
임시 변환과 프리셋 생성은 hwpx_cli.cmd_styled가 hwp-cli에 위임한다.
"""
from __future__ import annotations

import os
import re
import stat
import sys
import tempfile
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable

from lxml import etree
import hwpx_xml as hx


XML_SUFFIXES = (".xml", ".hpf")
COMMON_BODY_KEYS = ("본문", "내용", "BODY", "CONTENT", "body", "content")
COMMON_TITLE_KEYS = ("제목", "문서제목", "TITLE", "DOCUMENT_TITLE", "title")

# Package limits mirror `hwpx::PackageLimits::default()` exactly.
MAX_ZIP_ENTRIES = hx.PACKAGE_LIMITS.max_entries
MAX_MIMETYPE_BYTES = 256
MAX_ZIP_ENTRY_BYTES = hx.PACKAGE_LIMITS.max_entry_uncompressed_bytes
MAX_ZIP_TOTAL_BYTES = hx.PACKAGE_LIMITS.max_total_uncompressed_bytes
MAX_COMPRESSION_RATIO = hx.PACKAGE_LIMITS.max_compression_ratio
MAX_XML_ENTRY_BYTES = hx.PACKAGE_LIMITS.max_xml_uncompressed_bytes
MAX_XML_TOTAL_BYTES = hx.PACKAGE_LIMITS.max_total_uncompressed_bytes
MAX_ENTRY_NAME_BYTES = hx.PACKAGE_LIMITS.max_entry_name_bytes
MAX_TOTAL_NAME_BYTES = hx.PACKAGE_LIMITS.max_total_name_bytes


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
    `hwpx fill`. Returns the total number of replacements; callers must abort
    without publishing the output when it is zero.
    """
    import hwpx_xml as hx

    anchored = {"{{" + key + "}}": value for key, value in replacements.items()}
    counts = hx.edit_text(template, output, anchored)
    return sum(counts.values())


def validate_hwpx_package(path: str | Path) -> None:
    """Raise ValueError unless `path` is a bounded, structurally readable HWPX."""
    source = Path(path)
    errors: list[str] = []
    limits = hx.PackageLimits(
        max_entries=MAX_ZIP_ENTRIES,
        reject_duplicate_names=True,
        max_entry_uncompressed_bytes=MAX_ZIP_ENTRY_BYTES,
        max_total_uncompressed_bytes=MAX_ZIP_TOTAL_BYTES,
        max_xml_uncompressed_bytes=MAX_XML_ENTRY_BYTES,
        max_compression_ratio=MAX_COMPRESSION_RATIO,
        max_entry_name_bytes=MAX_ENTRY_NAME_BYTES,
        max_total_name_bytes=MAX_TOTAL_NAME_BYTES,
    )
    try:
        with hx.open_bounded_zip(source, limits) as zf:
            infos = zf.infolist()
            names = [info.filename for info in infos]
            if not names or names[0] != "mimetype":
                errors.append("mimetype이 첫 엔트리가 아님")

            try:
                info = zf.getinfo("mimetype")
                if info.compress_type != zipfile.ZIP_STORED:
                    errors.append("mimetype이 STORED 방식이 아님")
                if info.file_size > MAX_MIMETYPE_BYTES:
                    errors.append(
                        "mimetype 크기 제한 초과: "
                        f"{info.file_size} > {MAX_MIMETYPE_BYTES} bytes"
                    )
                    value = ""
                else:
                    raw_mimetype = hx.read_bounded_entry(
                        zf,
                        info,
                        limit=MAX_MIMETYPE_BYTES,
                        limits=limits,
                    )
                    if len(raw_mimetype) > MAX_MIMETYPE_BYTES:
                        errors.append(
                            "mimetype 실제 크기 제한 초과: "
                            f"> {MAX_MIMETYPE_BYTES} bytes"
                        )
                        value = ""
                    else:
                        value = raw_mimetype.decode(
                            "ascii", errors="replace"
                        ).strip()
                if value != "application/hwp+zip":
                    errors.append(f"mimetype 값이 application/hwp+zip이 아님: {value!r}")
            except KeyError:
                errors.append("mimetype 파일이 없음")

            for required in (
                "version.xml",
                "Contents/header.xml",
                "META-INF/container.xml",
            ):
                if required not in names:
                    errors.append(f"필수 엔트리가 없음: {required}")
            if not any(
                name.lower().startswith("contents/section")
                and name.lower().endswith(".xml")
                for name in names
            ):
                errors.append("본문 섹션(Contents/section*.xml)이 없음")

            xml_total = 0
            for info in infos:
                name = info.filename
                if not name.lower().endswith(XML_SUFFIXES):
                    try:
                        hx.verify_bounded_entry(zf, info, limits=limits)
                    except (OSError, RuntimeError, zipfile.BadZipFile, ValueError) as exc:
                        errors.append(f"ZIP 엔트리 읽기 실패 {name}: {exc}")
                    continue
                if info.file_size > MAX_XML_ENTRY_BYTES:
                    errors.append(
                        f"XML 엔트리 크기 제한 초과 {name}: "
                        f"{info.file_size} > {MAX_XML_ENTRY_BYTES} bytes"
                    )
                    continue
                xml_total += info.file_size
                if xml_total > MAX_XML_TOTAL_BYTES:
                    errors.append(
                        "XML 전체 크기 제한 초과: "
                        f"{xml_total} > {MAX_XML_TOTAL_BYTES} bytes"
                    )
                    break
                try:
                    data = hx.read_bounded_entry(
                        zf,
                        info,
                        limit=MAX_XML_ENTRY_BYTES,
                        limits=limits,
                    )
                    if len(data) > MAX_XML_ENTRY_BYTES:
                        errors.append(
                            f"XML 실제 크기 제한 초과 {name}: "
                            f"> {MAX_XML_ENTRY_BYTES} bytes"
                        )
                        continue
                    etree.fromstring(
                        data,
                        parser=etree.XMLParser(
                            resolve_entities=False,
                            no_network=True,
                            huge_tree=False,
                        ),
                    )
                except (OSError, RuntimeError, zipfile.BadZipFile) as exc:
                    errors.append(f"ZIP 엔트리 읽기 실패 {name}: {exc}")
                except etree.XMLSyntaxError as exc:
                    errors.append(f"XML 파싱 실패 {name}: {exc}")
    except (OSError, zipfile.BadZipFile, ValueError) as exc:
        errors.append(f"HWPX ZIP을 읽을 수 없음: {exc}")

    if errors:
        raise ValueError("; ".join(errors))


def _fsync_file(path: Path) -> None:
    with path.open("rb") as stream:
        os.fsync(stream.fileno())


def _fsync_parent(path: Path) -> None:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    fd = os.open(path.parent, flags)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


@dataclass(frozen=True)
class DestinationSnapshot:
    exists: bool
    st_dev: int | None = None
    st_ino: int | None = None
    st_nlink: int | None = None
    mode: int | None = None
    size: int | None = None
    mtime_ns: int | None = None
    ctime_ns: int | None = None


def snapshot_destination(
    output: str | Path,
    *,
    source: str | Path | None = None,
) -> DestinationSnapshot:
    """Validate and snapshot the destination identity before staging starts."""
    destination = Path(output)
    reference = Path(source) if source is not None else None
    if destination.suffix.lower() != ".hwpx":
        if (
            reference is not None
            and reference.suffix.lower() == ".hwp"
            and destination.suffix.lower() == ".hwp"
        ):
            raise ValueError(
                "binary .hwp 참조 파일을 출력 별칭으로 사용할 수 없음. "
                "styled --reference 출력 형식은 HWPX여야 함"
            )
        raise ValueError(
            "styled 출력 형식은 .hwpx여야 함: "
            f"{destination.name}"
        )
    try:
        status = destination.lstat()
    except FileNotFoundError:
        status = None
    if status is not None and stat.S_ISLNK(status.st_mode):
        raise ValueError(f"styled 출력 경로가 심볼릭 링크임: {destination}")
    if (
        reference is not None
        and reference.resolve() == destination.resolve(strict=False)
    ):
        raise ValueError(
            f"참조 파일과 출력이 같은 경로 별칭을 가리킴: {destination}"
        )
    if status is None:
        return DestinationSnapshot(exists=False)
    if not stat.S_ISREG(status.st_mode):
        raise ValueError(f"styled 출력 경로가 일반 파일이 아님: {destination}")
    if reference is not None and reference.is_file() and os.path.samefile(
        reference, destination
    ):
        if reference.suffix.lower() == ".hwp":
            raise ValueError(
                "binary .hwp 참조 파일과 styled 출력이 같은 파일을 가리킴. "
                "별도의 .hwpx 출력 경로가 필요함"
            )
        raise ValueError(f"참조 파일과 styled 출력이 같은 파일을 가리킴: {destination}")
    if status.st_nlink > 1:
        raise ValueError(
            f"styled 출력 경로의 하드링크 수가 1보다 큼 "
            f"(st_nlink={status.st_nlink}): {destination}"
        )
    return DestinationSnapshot(
        exists=True,
        st_dev=status.st_dev,
        st_ino=status.st_ino,
        st_nlink=status.st_nlink,
        mode=stat.S_IMODE(status.st_mode),
        size=status.st_size,
        mtime_ns=status.st_mtime_ns,
        ctime_ns=status.st_ctime_ns,
    )


def _recheck_destination(
    destination: Path,
    expected: DestinationSnapshot,
) -> None:
    """Reject any destination creation, replacement, link, or mode race."""
    try:
        status = destination.lstat()
    except FileNotFoundError:
        current = DestinationSnapshot(exists=False)
    else:
        if stat.S_ISLNK(status.st_mode):
            raise RuntimeError(
                f"styled 출력 경로가 게시 직전에 심볼릭 링크로 변경됨: {destination}"
            )
        if not stat.S_ISREG(status.st_mode):
            raise RuntimeError(
                f"styled 출력 경로가 게시 직전에 일반 파일이 아니게 됨: {destination}"
            )
        if status.st_nlink > 1:
            raise RuntimeError(
                f"styled 출력 경로의 하드링크 수가 게시 직전에 변경됨 "
                f"(st_nlink={status.st_nlink}): {destination}"
            )
        current = DestinationSnapshot(
            exists=True,
            st_dev=status.st_dev,
            st_ino=status.st_ino,
            st_nlink=status.st_nlink,
            mode=stat.S_IMODE(status.st_mode),
            size=status.st_size,
            mtime_ns=status.st_mtime_ns,
            ctime_ns=status.st_ctime_ns,
        )
    if current != expected:
        raise RuntimeError(
            f"styled 출력 경로가 생성 시작 후 변경됨: {destination}"
        )


def publish_staged_file(
    staged: Path,
    destination: Path,
    *,
    destination_snapshot: DestinationSnapshot,
) -> None:
    """Crash-durable best effort publication with truthful post-publish errors."""
    if destination_snapshot.mode is not None:
        staged.chmod(destination_snapshot.mode)
    _fsync_file(staged)
    _recheck_destination(destination, destination_snapshot)
    os.replace(staged, destination)
    try:
        _fsync_parent(destination)
    except OSError as exc:
        # The name is already published and cannot be rolled back safely here.
        print(
            f"[hwpx] 경고: 출력은 게시되었지만 부모 디렉터리 fsync 실패 "
            f"({destination.parent}): {exc}",
            file=sys.stderr,
        )


def follow_template(
    blocks: Iterable[Block],
    reference: str | Path,
    output: str | Path,
    header: str | None = None,
    footer: str | None = None,
    *,
    native_validate: Callable[[Path], object],
    destination_snapshot: DestinationSnapshot | None = None,
) -> Path:
    if header is not None or footer is not None:
        raise ValueError(
            "styled --header/--footer는 실제 HWPX 머리말/꼬리말 저작 전까지 지원하지 않음. "
            "본문 삽입 fallback을 사용하지 않음"
        )

    source = Path(reference)
    if not source.is_file():
        raise FileNotFoundError(source)
    out = Path(output)
    if destination_snapshot is None:
        destination_snapshot = snapshot_destination(out, source=source)
    validate_hwpx_package(source)

    block_list = list(blocks)
    body = _block_text(block_list)
    title_text = _block_title(block_list)

    replacements: dict[str, str] = {}
    for key in COMMON_BODY_KEYS:
        replacements[key] = body
    for key in COMMON_TITLE_KEYS:
        replacements[key] = title_text

    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix=f".{out.name}.staging-",
        dir=out.parent,
    ) as temp_dir:
        staging_dir = Path(temp_dir)
        staging_dir.chmod(0o700)
        temp = staging_dir / "output.hwpx"
        hits = _rewrite_template_slots(source, temp, replacements)
        if hits == 0:
            raise RuntimeError(
                f"참조 템플릿에서 일치하는 슬롯이 없음: {source} "
                "(본문/제목 슬롯 {{본문}}/{{제목}} 등이 있는지 확인)"
            )
        validate_hwpx_package(temp)
        native_validate(temp)
        publish_staged_file(
            temp,
            out,
            destination_snapshot=destination_snapshot,
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
