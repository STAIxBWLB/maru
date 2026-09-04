#!/usr/bin/env python3
"""hwpx_xml.py — lxml-based HWPX editing engine (dependency-light core).

Replaces the fragile "decode XML → str.replace → re-encode" approach with
structure-aware tree editing. This is the single source of truth for in-place
HWPX edits; CLI subcommands (fill/edit/edit-section/fill-form) call into it.

Core guarantees (the hard-won HWPX rules):
  * run-spanning {{anchor}} replacement — joins <hp:t> across runs so an anchor
    split into multiple runs by Hancom Office still matches.
  * mandatory <hp:linesegarray> deletion after any text edit — that element is a
    stale line-layout cache; leaving it makes glyphs overlap. Hancom recomputes
    it on open.
  * sec direct-child index mapping — body paragraphs are direct children of a
    single shared <hs:sec>; callers map by index, never by text search.
  * deepcopy reference-paragraph cloning — preserves run/charPr/paraPr structure.
  * mimetype-first STORED repackaging — HWPX/EPUB zip rule.

Only dependency is lxml (already in the Maru env). No python-hwpx.
"""
from __future__ import annotations

import copy
import contextlib
import os
import re
import stat
import struct
import tempfile
import zipfile
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path, PurePosixPath
from typing import BinaryIO, Iterator

from lxml import etree

HP_NS = "http://www.hancom.co.kr/hwpml/2011/paragraph"
HS_NS = "http://www.hancom.co.kr/hwpml/2011/section"
HH_NS = "http://www.hancom.co.kr/hwpml/2011/head"
HP = f"{{{HP_NS}}}"
HS = f"{{{HS_NS}}}"
NS = {"hp": HP_NS, "hs": HS_NS, "hh": HH_NS}

_SECTION_RE = re.compile(r"contents/section(\d+)\.xml$", re.IGNORECASE)
XML_SUFFIXES = (".xml", ".hpf")
SLOT_RE = re.compile(r"\{\{\s*([^{}\r\n]+?)\s*\}\}")

# Keep this profile byte-for-byte aligned with the public Rust
# `hwpx::PackageLimits::default()` contract. The raw central-directory scan runs
# before `zipfile.ZipFile` gets a chance to allocate decoded names or ZipInfo
# objects.
PACKAGE_LIMITS_PROFILE = "hwp-cli-native-v1"


@dataclass(frozen=True)
class PackageLimits:
    max_entries: int = 4_096
    reject_duplicate_names: bool = True
    max_entry_uncompressed_bytes: int = 512 * 1024 * 1024
    max_total_uncompressed_bytes: int = 2 * 1024 * 1024 * 1024
    max_xml_uncompressed_bytes: int = 64 * 1024 * 1024
    max_compression_ratio: int = 1_000
    max_entry_name_bytes: int = 64 * 1024
    max_total_name_bytes: int = 16 * 1024 * 1024


PACKAGE_LIMITS = PackageLimits()
MAX_STREAM_ENTRY_BYTES = PACKAGE_LIMITS.max_entry_uncompressed_bytes
MAX_STREAM_TOTAL_BYTES = PACKAGE_LIMITS.max_total_uncompressed_bytes
MAX_TRANSFORMED_XML_BYTES = PACKAGE_LIMITS.max_xml_uncompressed_bytes
MAX_COMPRESSION_RATIO = PACKAGE_LIMITS.max_compression_ratio
MAX_STREAM_ENTRIES = PACKAGE_LIMITS.max_entries
COPY_CHUNK_BYTES = 1024 * 1024


# ── bounded ZIP package abstraction ─────────────────────────────────────────

def _read_exact_at(stream: BinaryIO, offset: int, size: int) -> bytes:
    stream.seek(offset)
    data = stream.read(size)
    if len(data) != size:
        raise zipfile.BadZipFile("truncated ZIP central directory")
    return data


def _zip64_sizes(
    extra: bytes,
    *,
    need_size: bool,
    need_compressed: bool,
) -> tuple[int | None, int | None]:
    offset = 0
    while offset + 4 <= len(extra):
        tag, length = struct.unpack_from("<HH", extra, offset)
        offset += 4
        end = offset + length
        if end > len(extra):
            raise zipfile.BadZipFile("truncated ZIP64 extra field")
        if tag == 0x0001:
            cursor = offset
            size = None
            compressed = None
            if need_size:
                if cursor + 8 > end:
                    raise zipfile.BadZipFile("ZIP64 uncompressed size is missing")
                size = struct.unpack_from("<Q", extra, cursor)[0]
                cursor += 8
            if need_compressed:
                if cursor + 8 > end:
                    raise zipfile.BadZipFile("ZIP64 compressed size is missing")
                compressed = struct.unpack_from("<Q", extra, cursor)[0]
            return size, compressed
        offset = end
    return None, None


def _is_xml_name(name: str) -> bool:
    return name.lower().endswith(XML_SUFFIXES)


def _validate_entry_name(name: bytes | str) -> str:
    """Apply the exact `hwpx::package::validate_entry_name` path contract."""
    if isinstance(name, bytes):
        try:
            decoded = name.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ValueError("ZIP 엔트리 이름이 유효한 UTF-8이 아님") from exc
    else:
        decoded = name
        try:
            decoded.encode("utf-8")
        except UnicodeEncodeError as exc:
            raise ValueError("ZIP 엔트리 이름이 유효한 UTF-8이 아님") from exc
    if not decoded:
        raise ValueError("빈 ZIP 엔트리 이름을 허용하지 않음")
    if "\0" in decoded:
        raise ValueError(f"NUL을 포함한 ZIP 엔트리 이름을 허용하지 않음: {decoded!r}")
    if decoded.startswith(("/", "\\")) or "\\" in decoded:
        raise ValueError(
            f"절대 경로 또는 역슬래시 ZIP 엔트리 이름을 허용하지 않음: {decoded!r}"
        )

    path = decoded[:-1] if decoded.endswith("/") else decoded
    if not path:
        raise ValueError(f"루트 ZIP 디렉터리 엔트리를 허용하지 않음: {decoded!r}")
    components = path.split("/")
    first = components[0].encode("utf-8")
    if (
        len(first) >= 2
        and first[0:1].isalpha()
        and first[1:2] == b":"
        and first[0] < 128
    ):
        raise ValueError(f"드라이브 절대경로 ZIP 엔트리를 허용하지 않음: {decoded!r}")
    if any(component in {"", ".", ".."} for component in components):
        raise ValueError(
            f"빈/현재/상위 경로 컴포넌트를 허용하지 않음: {decoded!r}"
        )
    return decoded


def _check_declared_entry(
    name: str,
    size: int,
    compressed_size: int,
    limits: PackageLimits,
) -> None:
    if size > limits.max_entry_uncompressed_bytes:
        raise ValueError(
            f"ZIP 엔트리 크기 제한 초과 {name}: "
            f"{size} > {limits.max_entry_uncompressed_bytes} bytes"
        )
    if compressed_size > limits.max_entry_uncompressed_bytes:
        raise ValueError(
            f"ZIP 압축 데이터 크기 제한 초과 {name}: "
            f"{compressed_size} > {limits.max_entry_uncompressed_bytes} bytes"
        )
    if _is_xml_name(name) and size > limits.max_xml_uncompressed_bytes:
        raise ValueError(
            f"XML 엔트리 크기 제한 초과 {name}: "
            f"{size} > {limits.max_xml_uncompressed_bytes} bytes"
        )
    if size and compressed_size == 0:
        raise ValueError(
            f"ZIP 압축 크기가 0인 비어 있지 않은 엔트리: {name} ({size} bytes)"
        )
    if (
        compressed_size
        and size > compressed_size * limits.max_compression_ratio
    ):
        raise ValueError(
            f"ZIP 압축률 제한 초과 {name}: "
            f"{size}/{compressed_size} > {limits.max_compression_ratio}:1"
        )


def preflight_zip(
    path: str | Path,
    limits: PackageLimits = PACKAGE_LIMITS,
) -> None:
    """Inspect raw EOCD/central-directory bytes before ZipFile allocation."""
    source = Path(path)
    with source.open("rb") as stream:
        stream.seek(0, os.SEEK_END)
        file_size = stream.tell()
        tail_size = min(file_size, 22 + 0xFFFF)
        tail = _read_exact_at(stream, file_size - tail_size, tail_size)
        eocd_offset = None
        for offset in range(max(0, len(tail) - 22), -1, -1):
            if tail[offset : offset + 4] != b"PK\x05\x06":
                continue
            comment_len = struct.unpack_from("<H", tail, offset + 20)[0]
            if offset + 22 + comment_len == len(tail):
                eocd_offset = offset
                break
        if eocd_offset is None:
            raise zipfile.BadZipFile("ZIP EOCD record not found")

        eocd_position = file_size - tail_size + eocd_offset
        eocd = tail[eocd_offset : eocd_offset + 22]
        disk_no, central_disk = struct.unpack_from("<HH", eocd, 4)
        disk_entries, total_entries = struct.unpack_from("<HH", eocd, 8)
        central_size, central_offset = struct.unpack_from("<II", eocd, 12)
        if disk_no != 0 or central_disk != 0 or disk_entries != total_entries:
            raise zipfile.BadZipFile("multi-disk ZIP archives are not supported")
        central_end = eocd_position

        if (
            total_entries == 0xFFFF
            or central_size == 0xFFFFFFFF
            or central_offset == 0xFFFFFFFF
        ):
            locator_position = eocd_position - 20
            if locator_position < 0:
                raise zipfile.BadZipFile("ZIP64 locator is missing")
            locator = _read_exact_at(stream, locator_position, 20)
            if locator[:4] != b"PK\x06\x07":
                raise zipfile.BadZipFile("ZIP64 locator is invalid")
            zip64_position = struct.unpack_from("<Q", locator, 8)[0]
            zip64 = _read_exact_at(stream, zip64_position, 56)
            if zip64[:4] != b"PK\x06\x06":
                raise zipfile.BadZipFile("ZIP64 EOCD record is invalid")
            disk_no = struct.unpack_from("<I", zip64, 16)[0]
            central_disk = struct.unpack_from("<I", zip64, 20)[0]
            disk_entries = struct.unpack_from("<Q", zip64, 24)[0]
            total_entries = struct.unpack_from("<Q", zip64, 32)[0]
            central_size = struct.unpack_from("<Q", zip64, 40)[0]
            central_offset = struct.unpack_from("<Q", zip64, 48)[0]
            if disk_no != 0 or central_disk != 0 or disk_entries != total_entries:
                raise zipfile.BadZipFile("multi-disk ZIP64 archives are not supported")
            central_end = zip64_position

        if total_entries > limits.max_entries:
            raise ValueError(
                f"ZIP 엔트리 수 제한 초과: "
                f"{total_entries} > {limits.max_entries}"
            )
        if central_size > file_size or central_end < central_size:
            raise zipfile.BadZipFile("ZIP central-directory size is invalid")

        central_start = central_offset
        if (
            central_start + 4 > file_size
            or _read_exact_at(stream, central_start, 4) != b"PK\x01\x02"
        ):
            # ZIPs with a prepended self-extracting stub use archive-relative
            # offsets. Recover from the already-bounded central-directory end.
            central_start = central_end - central_size
        cursor = central_start
        names: set[bytes] = set()
        total_name_bytes = 0
        total_size = 0
        total_compressed = 0

        for _ in range(total_entries):
            if cursor + 46 > central_end:
                raise zipfile.BadZipFile("truncated ZIP central directory")
            fixed = _read_exact_at(stream, cursor, 46)
            if fixed[:4] != b"PK\x01\x02":
                raise zipfile.BadZipFile("invalid ZIP central-directory entry")
            compressed_size = struct.unpack_from("<I", fixed, 20)[0]
            size = struct.unpack_from("<I", fixed, 24)[0]
            name_len, extra_len, comment_len = struct.unpack_from("<HHH", fixed, 28)
            if name_len > limits.max_entry_name_bytes:
                raise ValueError(
                    f"ZIP 엔트리 이름 크기 제한 초과: "
                    f"{name_len} > {limits.max_entry_name_bytes} bytes"
                )
            total_name_bytes += name_len
            if total_name_bytes > limits.max_total_name_bytes:
                raise ValueError(
                    "ZIP 엔트리 이름 전체 크기 제한 초과: "
                    f"{total_name_bytes} > {limits.max_total_name_bytes} bytes"
                )
            entry_end = cursor + 46 + name_len + extra_len + comment_len
            if entry_end > central_end:
                raise zipfile.BadZipFile("truncated ZIP central-directory entry")
            name = _read_exact_at(stream, cursor + 46, name_len)
            display_name = _validate_entry_name(name)
            if limits.reject_duplicate_names and name in names:
                raise ValueError(f"중복 ZIP 엔트리: {display_name}")
            names.add(name)
            extra = _read_exact_at(stream, cursor + 46 + name_len, extra_len)
            if size == 0xFFFFFFFF or compressed_size == 0xFFFFFFFF:
                zip64_size, zip64_compressed = _zip64_sizes(
                    extra,
                    need_size=size == 0xFFFFFFFF,
                    need_compressed=compressed_size == 0xFFFFFFFF,
                )
                if size == 0xFFFFFFFF:
                    if zip64_size is None:
                        raise zipfile.BadZipFile("ZIP64 entry size is missing")
                    size = zip64_size
                if compressed_size == 0xFFFFFFFF:
                    if zip64_compressed is None:
                        raise zipfile.BadZipFile(
                            "ZIP64 entry compressed size is missing"
                        )
                    compressed_size = zip64_compressed
            _check_declared_entry(display_name, size, compressed_size, limits)
            total_size += size
            total_compressed += compressed_size
            if total_size > limits.max_total_uncompressed_bytes:
                raise ValueError(
                    f"ZIP 전체 크기 제한 초과: "
                    f"{total_size} > {limits.max_total_uncompressed_bytes} bytes"
                )
            if total_compressed > limits.max_total_uncompressed_bytes:
                raise ValueError(
                    f"ZIP 압축 데이터 전체 크기 제한 초과: "
                    f"{total_compressed} > {limits.max_total_uncompressed_bytes} bytes"
                )
            cursor = entry_end

        if cursor != central_end:
            raise zipfile.BadZipFile(
                "ZIP central directory does not match its declared size"
            )


def _check_zip_metadata(
    infos: list[zipfile.ZipInfo],
    limits: PackageLimits = PACKAGE_LIMITS,
) -> None:
    if len(infos) > limits.max_entries:
        raise ValueError(
            f"ZIP 엔트리 수 제한 초과: {len(infos)} > {limits.max_entries}"
        )
    names: set[str] = set()
    total_size = 0
    total_compressed = 0
    total_name_bytes = 0
    for info in infos:
        _validate_entry_name(info.filename)
        encoded_name = info.filename.encode("utf-8", "surrogatepass")
        if len(encoded_name) > limits.max_entry_name_bytes:
            raise ValueError(
                f"ZIP 엔트리 이름 크기 제한 초과 {info.filename}: "
                f"{len(encoded_name)} > {limits.max_entry_name_bytes} bytes"
            )
        total_name_bytes += len(encoded_name)
        if total_name_bytes > limits.max_total_name_bytes:
            raise ValueError(
                "ZIP 엔트리 이름 전체 크기 제한 초과: "
                f"{total_name_bytes} > {limits.max_total_name_bytes} bytes"
            )
        if limits.reject_duplicate_names and info.filename in names:
            raise ValueError(f"중복 ZIP 엔트리: {info.filename}")
        names.add(info.filename)
        _check_declared_entry(
            info.filename,
            info.file_size,
            info.compress_size,
            limits,
        )
        total_size += info.file_size
        total_compressed += info.compress_size
        if total_size > limits.max_total_uncompressed_bytes:
            raise ValueError(
                f"ZIP 전체 크기 제한 초과: "
                f"{total_size} > {limits.max_total_uncompressed_bytes} bytes"
            )
        if total_compressed > limits.max_total_uncompressed_bytes:
            raise ValueError(
                f"ZIP 압축 데이터 전체 크기 제한 초과: "
                f"{total_compressed} > {limits.max_total_uncompressed_bytes} bytes"
            )


@contextlib.contextmanager
def open_bounded_zip(
    path: str | Path,
    limits: PackageLimits = PACKAGE_LIMITS,
) -> Iterator[zipfile.ZipFile]:
    """Open a read-only ZIP only after raw and decoded metadata preflight."""
    source = Path(path)
    preflight_zip(source, limits)
    archive = zipfile.ZipFile(source, "r")
    try:
        _check_zip_metadata(archive.infolist(), limits)
        yield archive
    finally:
        archive.close()


def read_bounded_entry(
    archive: zipfile.ZipFile,
    entry: str | zipfile.ZipInfo,
    *,
    limit: int | None = None,
    limits: PackageLimits = PACKAGE_LIMITS,
) -> bytes:
    info = archive.getinfo(entry) if isinstance(entry, str) else entry
    effective_limit = limits.max_entry_uncompressed_bytes
    if _is_xml_name(info.filename):
        effective_limit = min(
            effective_limit,
            limits.max_xml_uncompressed_bytes,
        )
    if limit is not None:
        effective_limit = min(effective_limit, limit)
    if info.file_size > effective_limit:
        kind = "XML 엔트리" if _is_xml_name(info.filename) else "ZIP 엔트리"
        raise ValueError(
            f"{kind} 크기 제한 초과 {info.filename}: "
            f"{info.file_size} > {effective_limit} bytes"
        )
    chunks: list[bytes] = []
    actual = 0
    with archive.open(info, "r") as stream:
        while True:
            chunk = stream.read(min(COPY_CHUNK_BYTES, effective_limit - actual + 1))
            if not chunk:
                break
            actual += len(chunk)
            if actual > effective_limit:
                raise ValueError(
                    f"ZIP 실제 크기 제한 초과 {info.filename}: "
                    f"> {effective_limit} bytes"
                )
            chunks.append(chunk)
    if actual != info.file_size:
        raise ValueError(
            f"ZIP 선언/실제 크기 불일치 {info.filename}: "
            f"{info.file_size} != {actual} bytes"
        )
    return b"".join(chunks)


def verify_bounded_entry(
    archive: zipfile.ZipFile,
    entry: str | zipfile.ZipInfo,
    *,
    limits: PackageLimits = PACKAGE_LIMITS,
) -> int:
    """Stream an entry through ZipFile's CRC check without materializing it."""
    info = archive.getinfo(entry) if isinstance(entry, str) else entry
    effective_limit = limits.max_entry_uncompressed_bytes
    if _is_xml_name(info.filename):
        effective_limit = min(
            effective_limit,
            limits.max_xml_uncompressed_bytes,
        )
    actual = 0
    with archive.open(info, "r") as stream:
        while True:
            chunk = stream.read(min(COPY_CHUNK_BYTES, effective_limit - actual + 1))
            if not chunk:
                break
            actual += len(chunk)
            if actual > effective_limit:
                raise ValueError(
                    f"ZIP 실제 크기 제한 초과 {info.filename}: "
                    f"> {effective_limit} bytes"
                )
    if actual != info.file_size:
        raise ValueError(
            f"ZIP 선언/실제 크기 불일치 {info.filename}: "
            f"{info.file_size} != {actual} bytes"
        )
    return actual


def _safe_extract_target(root: Path, info: zipfile.ZipInfo) -> Path:
    name = info.filename
    if not name or "\\" in name or "\0" in name:
        raise ValueError(f"안전하지 않은 ZIP 엔트리 경로: {name!r}")
    pure = PurePosixPath(name)
    if pure.is_absolute() or any(part in {"", ".", ".."} for part in pure.parts):
        raise ValueError(f"ZIP 엔트리 경로 이탈 감지: {name}")
    unix_mode = (info.external_attr >> 16) & 0xFFFF
    if unix_mode and stat.S_ISLNK(unix_mode):
        raise ValueError(f"ZIP 심볼릭 링크 엔트리를 추출할 수 없음: {name}")
    target = root.joinpath(*pure.parts)
    resolved_root = root.resolve()
    resolved_target = target.resolve(strict=False)
    if resolved_target != resolved_root and resolved_root not in resolved_target.parents:
        raise ValueError(f"ZIP 엔트리 경로 이탈 감지: {name}")
    return target


def extract_bounded_zip(
    path: str | Path,
    destination: str | Path,
    limits: PackageLimits = PACKAGE_LIMITS,
) -> None:
    """Extract with path containment and actual aggregate byte accounting."""
    root = Path(destination)
    root.mkdir(parents=True, exist_ok=True)
    actual_total = 0
    with open_bounded_zip(path, limits) as archive:
        for info in archive.infolist():
            target = _safe_extract_target(root, info)
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.is_symlink():
                raise ValueError(f"기존 심볼릭 링크 경로에 추출할 수 없음: {target}")
            entry_limit = limits.max_entry_uncompressed_bytes
            if _is_xml_name(info.filename):
                entry_limit = min(entry_limit, limits.max_xml_uncompressed_bytes)
            written = 0
            with archive.open(info, "r") as source, target.open("wb") as output:
                while True:
                    chunk = source.read(
                        min(COPY_CHUNK_BYTES, entry_limit - written + 1)
                    )
                    if not chunk:
                        break
                    written += len(chunk)
                    actual_total += len(chunk)
                    if written > entry_limit:
                        raise ValueError(
                            f"ZIP 실제 크기 제한 초과 {info.filename}: "
                            f"> {entry_limit} bytes"
                        )
                    if actual_total > limits.max_total_uncompressed_bytes:
                        raise ValueError(
                            "ZIP 실제 전체 크기 제한 초과: "
                            f"{actual_total} > "
                            f"{limits.max_total_uncompressed_bytes} bytes"
                        )
                    output.write(chunk)
            if written != info.file_size:
                raise ValueError(
                    f"ZIP 선언/실제 크기 불일치 {info.filename}: "
                    f"{info.file_size} != {written} bytes"
                )


# ── low-level helpers ────────────────────────────────────────────────────────

def localname(el: etree._Element) -> str:
    tag = el.tag
    if not isinstance(tag, str):  # comment / PI / entity nodes have non-str tags
        return ""
    return etree.QName(el).localname


def parse_xml(data: bytes) -> etree._ElementTree:
    return etree.parse(BytesIO(data))


def serialize(tree: etree._ElementTree) -> bytes:
    """Serialize preserving the original XML declaration/encoding/standalone."""
    info = tree.docinfo
    return etree.tostring(
        tree,
        xml_declaration=True,
        encoding=info.encoding or "UTF-8",
        standalone=info.standalone,
    )


def find_sec(root: etree._Element) -> etree._Element:
    """Return the <hs:sec> element, or the root itself when absent."""
    for el in root.iter():
        if localname(el) == "sec":
            return el
    return root


def body_paragraphs(parent: etree._Element) -> list[etree._Element]:
    """Direct-child <hp:p> of `parent`, in document order (index-stable)."""
    return [c for c in parent if localname(c) == "p"]


def all_paragraphs(root: etree._Element) -> list[etree._Element]:
    """Every <hp:p> at any depth (incl. table cells / subList)."""
    return list(root.iter(f"{HP}p"))


def document_xml_entry_names(src: Path) -> list[str]:
    """XML/HPF entries that can be parsed and inspected structurally."""
    with open_bounded_zip(src) as zin:
        return [n for n in zin.namelist() if n.lower().endswith(XML_SUFFIXES)]


def _read_bounded_entry(
    archive: zipfile.ZipFile,
    info: zipfile.ZipInfo,
    *,
    limit: int,
) -> bytes:
    return read_bounded_entry(archive, info, limit=limit)


def t_nodes(p: etree._Element) -> list[etree._Element]:
    """All <hp:t> text nodes within a paragraph, in order."""
    return [el for el in p.iter() if localname(el) == "t"]


def paragraph_text(p: etree._Element) -> str:
    parts: list[str] = []
    for el in p.iter():
        ln = localname(el)
        if ln == "t" and el.text:
            parts.append(el.text)
        elif ln in ("lineBreak", "br"):
            parts.append("\n")
        elif ln == "tab":
            parts.append("\t")
    return "".join(parts)


def remove_linesegarray(p: etree._Element) -> int:
    """Delete every <hp:linesegarray> in/under a paragraph (stale line cache).

    MUST be called after editing a paragraph's text. Returns removed count.
    """
    targets = [el for el in p.iter() if localname(el) == "linesegarray"]
    removed = 0
    for el in targets:
        parent = el.getparent()
        if parent is not None:
            parent.remove(el)
            removed += 1
    return removed


# ── run-aware text replacement ───────────────────────────────────────────────

def replace_in_paragraph(p: etree._Element, old: str, new: str,
                         *, limit: int | None = None) -> int:
    """Replace `old`→`new` across the paragraph's <hp:t> nodes, even when `old`
    spans multiple runs. Text outside the matched span keeps its run/formatting;
    the replacement inherits the style of the run owning the maru's start.

    Deletes the paragraph's linesegarray on any change. Returns # replaced.
    """
    if not old:
        return 0
    nodes = t_nodes(p)
    if not nodes:
        return 0
    texts = [(n.text or "") for n in nodes]
    full = "".join(texts)
    if old not in full:
        return 0

    # Collect non-overlapping match spans (left→right) on the original text.
    spans: list[tuple[int, int]] = []
    start = 0
    while True:
        i = full.find(old, start)
        if i < 0:
            break
        spans.append((i, i + len(old)))
        start = i + len(old)
        if limit is not None and len(spans) >= limit:
            break
    if not spans:
        return 0

    span_starts = {a for a, _ in spans}

    def _in_span(g: int) -> bool:
        for a, b in spans:
            if a <= g < b:
                return True
        return False

    pos = 0
    for node, txt in zip(nodes, texts):
        out: list[str] = []
        for i, ch in enumerate(txt):
            g = pos + i
            if g in span_starts:
                out.append(new)
            if not _in_span(g):
                out.append(ch)
        node.text = "".join(out)
        pos += len(txt)

    remove_linesegarray(p)
    return len(spans)


def edit_text(src: Path, dst: Path, replacements: dict[str, str],
              *, limit: int | None = None) -> dict[str, int]:
    """Apply {maru: value} replacements across all section/header XML entries
    using run-aware, linesegarray-safe tree editing. Repackages mimetype-first.

    Returns per-maru replacement counts.
    """
    counts = {k: 0 for k in replacements}
    remaining = limit
    overrides: dict[str, bytes] = {}

    with open_bounded_zip(src) as zin:
        infos = zin.infolist()
        _check_stream_metadata(infos)
        for info in infos:
            name = info.filename
            if not name.lower().endswith(XML_SUFFIXES):
                continue
            data = _read_bounded_entry(
                zin,
                info,
                limit=MAX_TRANSFORMED_XML_BYTES,
            )
            tree = parse_xml(data)
            root = tree.getroot()
            changed = False
            for p in all_paragraphs(root):
                for old, new in replacements.items():
                    if remaining == 0:
                        break
                    n = replace_in_paragraph(p, old, new, limit=remaining)
                    if n:
                        counts[old] += n
                        changed = True
                        if remaining is not None:
                            remaining -= n
            if changed:
                overrides[name] = serialize(tree)

    rewrite_entries(src, dst, overrides)
    return counts


def scan_slots(src: Path) -> dict[str, int]:
    """Return {{field}} counts from the same paragraph text surface edit_text uses.

    This is run-aware because paragraph_text joins <hp:t> nodes before applying
    the slot regex; it intentionally ignores raw XML text outside paragraphs.
    """
    counts: dict[str, int] = {}
    with open_bounded_zip(src) as zin:
        infos = zin.infolist()
        _check_stream_metadata(infos)
        for info in infos:
            if not info.filename.lower().endswith(XML_SUFFIXES):
                continue
            data = _read_bounded_entry(
                zin,
                info,
                limit=MAX_TRANSFORMED_XML_BYTES,
            )
            tree = parse_xml(data)
            for p in all_paragraphs(tree.getroot()):
                for match in SLOT_RE.finditer(paragraph_text(p)):
                    key = match.group(1).strip()
                    if key:
                        counts[key] = counts.get(key, 0) + 1
    return counts


# ── section-body editing (deepcopy + reverse-order) ──────────────────────────

def clone_para(ref_p: etree._Element, run_texts: list[str]) -> etree._Element:
    """Deepcopy `ref_p`, set each run's <hp:t> text from `run_texts`, drop extra
    runs, and delete the clone's linesegarray. Preserves charPr/paraPr refs.
    """
    new_p = copy.deepcopy(ref_p)
    remove_linesegarray(new_p)
    runs = [c for c in new_p if localname(c) == "run"]
    for i, txt in enumerate(run_texts):
        if i < len(runs):
            wrote = False
            for el in runs[i].iter():
                if localname(el) == "t":
                    el.text = txt if not wrote else ""
                    wrote = True
            if not wrote:  # run had no <hp:t> (e.g. empty cell run) — create one
                etree.SubElement(runs[i], f"{HP}t").text = txt
    for r in runs[len(run_texts):]:
        new_p.remove(r)
    return new_p


def replace_section_body(sec: etree._Element, start_idx: int, end_idx: int,
                         clones: list[etree._Element]) -> None:
    """Replace sec's direct children [start_idx:end_idx) with `clones`.

    Call in REVERSE order (last section block first) across a document so that
    insert/delete in one block does not shift the indices of earlier blocks.
    """
    children = list(sec)
    for child in children[start_idx:end_idx]:
        sec.remove(child)
    insert_at = start_idx
    for clone in clones:
        sec.insert(insert_at, clone)
        insert_at += 1


# ── zip (de)packaging ────────────────────────────────────────────────────────

def _copy_info(info: zipfile.ZipInfo, *, stored: bool = False) -> zipfile.ZipInfo:
    """Clone portable metadata without reusing reader-only offsets."""
    cloned = zipfile.ZipInfo(info.filename, date_time=info.date_time)
    cloned.compress_type = zipfile.ZIP_STORED if stored else zipfile.ZIP_DEFLATED
    cloned.comment = info.comment
    cloned.extra = info.extra
    cloned.internal_attr = info.internal_attr
    cloned.external_attr = info.external_attr
    cloned.create_system = info.create_system
    return cloned


def _check_stream_metadata(infos: list[zipfile.ZipInfo]) -> None:
    _check_zip_metadata(infos)


def _stream_entry(
    zin: zipfile.ZipFile,
    zout: zipfile.ZipFile,
    info: zipfile.ZipInfo,
    *,
    stored: bool = False,
) -> int:
    """Stream one entry with an actual-byte guard; never materialize its payload."""
    copied = 0
    entry_limit = PACKAGE_LIMITS.max_entry_uncompressed_bytes
    if _is_xml_name(info.filename):
        entry_limit = min(
            entry_limit,
            PACKAGE_LIMITS.max_xml_uncompressed_bytes,
        )
    with zin.open(info, "r") as source, zout.open(
        _copy_info(info, stored=stored), "w", force_zip64=True
    ) as target:
        while True:
            chunk = source.read(
                min(COPY_CHUNK_BYTES, entry_limit - copied + 1)
            )
            if not chunk:
                break
            copied += len(chunk)
            if copied > entry_limit:
                raise ValueError(
                    f"ZIP 실제 크기 제한 초과 {info.filename}: "
                    f"> {entry_limit} bytes"
                )
            target.write(chunk)
    if copied != info.file_size:
        raise ValueError(
            f"ZIP 선언/실제 크기 불일치 {info.filename}: "
            f"{info.file_size} != {copied} bytes"
        )
    return copied


def _write_rewritten_zip(
    src: Path,
    dst: Path,
    overrides: dict[str, bytes],
) -> None:
    with open_bounded_zip(src) as zin:
        infos = zin.infolist()
        _check_stream_metadata(infos)
        names = {info.filename for info in infos}
        unknown = sorted(set(overrides) - names)
        if unknown:
            raise ValueError(
                f"원본에 없는 ZIP 엔트리를 override함: {', '.join(unknown[:8])}"
            )
        for name, data in overrides.items():
            if len(data) > MAX_STREAM_ENTRY_BYTES:
                raise ValueError(
                    f"변환 엔트리 크기 제한 초과 {name}: "
                    f"{len(data)} > {MAX_STREAM_ENTRY_BYTES} bytes"
                )
            if name.lower().endswith(XML_SUFFIXES) and len(data) > MAX_TRANSFORMED_XML_BYTES:
                raise ValueError(
                    f"변환 XML 크기 제한 초과 {name}: "
                    f"{len(data)} > {MAX_TRANSFORMED_XML_BYTES} bytes"
                )
        projected_total = sum(
            len(overrides[info.filename])
            if info.filename in overrides
            else info.file_size
            for info in infos
        )
        if projected_total > MAX_STREAM_TOTAL_BYTES:
            raise ValueError(
                "변환 ZIP 전체 크기 제한 초과: "
                f"{projected_total} > {MAX_STREAM_TOTAL_BYTES} bytes"
            )

        with zipfile.ZipFile(dst, "w") as zout:
            ordered = sorted(infos, key=lambda info: info.filename != "mimetype")
            actual_total = 0
            for info in ordered:
                override = overrides.get(info.filename)
                if override is not None:
                    actual_total += len(override)
                    if actual_total > MAX_STREAM_TOTAL_BYTES:
                        raise ValueError(
                            "ZIP 실제 전체 크기 제한 초과: "
                            f"{actual_total} > {MAX_STREAM_TOTAL_BYTES} bytes"
                        )
                    zout.writestr(
                        _copy_info(info, stored=info.filename == "mimetype"),
                        override,
                    )
                    continue
                copied = _stream_entry(
                    zin,
                    zout,
                    info,
                    stored=info.filename == "mimetype",
                )
                actual_total += copied
                if actual_total > MAX_STREAM_TOTAL_BYTES:
                    raise ValueError(
                        "ZIP 실제 전체 크기 제한 초과: "
                        f"{actual_total} > {MAX_STREAM_TOTAL_BYTES} bytes"
                    )


def rewrite_entries(src: Path, dst: Path, overrides: dict[str, bytes]) -> None:
    """Stream `src` HWPX → `dst`, materializing only bounded override XML.

    `mimetype` is always first and STORED. Every call writes to a private
    sibling workspace, validates the complete package, fsyncs it, rechecks the
    destination identity, and publishes with one `os.replace`.
    """
    import styled as styled_mod

    src = Path(src)
    dst = Path(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    destination = styled_mod.snapshot_destination(dst)
    with tempfile.TemporaryDirectory(
        prefix=f".{dst.name}.rewrite-",
        dir=dst.parent,
    ) as workspace_name:
        workspace = Path(workspace_name)
        workspace.chmod(0o700)
        staged = workspace / dst.name
        _write_rewritten_zip(src, staged, overrides)
        styled_mod.validate_hwpx_package(staged)
        styled_mod.publish_staged_file(
            staged,
            dst,
            destination_snapshot=destination,
        )


def pack_dir(src_dir: Path, dst: Path) -> None:
    """Pack an unpacked HWPX directory → .hwpx (mimetype first STORED)."""
    src_dir = Path(src_dir)
    dst = Path(dst)
    mimetype = src_dir / "mimetype"
    if not mimetype.is_file():
        raise FileNotFoundError(f"mimetype 없음: {mimetype} (HWPX unpack 결과 아님)")
    if mimetype.is_symlink():
        raise ValueError(f"mimetype 심볼릭 링크를 패키징할 수 없음: {mimetype}")
    mime_bytes = mimetype.read_bytes()
    if mime_bytes != b"application/hwp+zip":
        raise ValueError(f"mimetype 값이 올바르지 않음: {mime_bytes!r}")
    source_root = src_dir.resolve()
    output_resolved = dst.resolve(strict=False)
    if output_resolved == source_root or source_root in output_resolved.parents:
        raise ValueError(f"repack 출력은 입력 디렉터리 밖이어야 함: {dst}")

    paths: list[tuple[Path, str, int]] = [(mimetype, "mimetype", len(mime_bytes))]
    total_size = len(mime_bytes)
    total_name_bytes = len(b"mimetype")
    for path in sorted(src_dir.rglob("*")):
        if path == mimetype or path.is_dir():
            continue
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"일반 파일이 아닌 repack 입력: {path}")
        resolved = path.resolve()
        if source_root not in resolved.parents:
            raise ValueError(f"repack 입력 경로 이탈 감지: {path}")
        arcname = path.relative_to(src_dir).as_posix()
        _validate_entry_name(arcname)
        name_size = len(arcname.encode("utf-8"))
        if name_size > PACKAGE_LIMITS.max_entry_name_bytes:
            raise ValueError(
                f"ZIP 엔트리 이름 크기 제한 초과 {arcname}: "
                f"{name_size} > {PACKAGE_LIMITS.max_entry_name_bytes} bytes"
            )
        total_name_bytes += name_size
        if total_name_bytes > PACKAGE_LIMITS.max_total_name_bytes:
            raise ValueError(
                "ZIP 엔트리 이름 전체 크기 제한 초과: "
                f"{total_name_bytes} > {PACKAGE_LIMITS.max_total_name_bytes} bytes"
            )
        size = path.stat().st_size
        _check_declared_entry(arcname, size, size, PACKAGE_LIMITS)
        total_size += size
        if total_size > PACKAGE_LIMITS.max_total_uncompressed_bytes:
            raise ValueError(
                f"ZIP 전체 크기 제한 초과: "
                f"{total_size} > "
                f"{PACKAGE_LIMITS.max_total_uncompressed_bytes} bytes"
            )
        paths.append((path, arcname, size))
        if len(paths) > PACKAGE_LIMITS.max_entries:
            raise ValueError(
                f"ZIP 엔트리 수 제한 초과: "
                f"{len(paths)} > {PACKAGE_LIMITS.max_entries}"
            )

    dst.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(
        prefix=f".{dst.name}.repack-",
        suffix=".hwpx",
        dir=dst.parent,
    )
    os.close(fd)
    temp = Path(temp_name)
    try:
        with zipfile.ZipFile(temp, "w") as zf:
            zi = zipfile.ZipInfo("mimetype")
            zi.compress_type = zipfile.ZIP_STORED
            zf.writestr(zi, mime_bytes)
            for path, arcname, _size in paths[1:]:
                zf.write(
                    path,
                    arcname,
                    compress_type=zipfile.ZIP_DEFLATED,
                )
        preflight_zip(temp)
        os.replace(temp, dst)
    finally:
        with contextlib.suppress(FileNotFoundError):
            temp.unlink()


def section_entry_names(src: Path) -> list[str]:
    """Sorted Contents/sectionN.xml entry names in a HWPX."""
    with open_bounded_zip(src) as zin:
        names = [n for n in zin.namelist() if _SECTION_RE.search(n)]
    return sorted(names, key=lambda n: int(_SECTION_RE.search(n).group(1)))


def apply_heading_styles(hwpx_path: Path, levels: list[str]) -> int:
    """Give heading paragraphs visual hierarchy by re-pointing their runs to the
    larger EXISTING header charPr (H1=largest, H2/H3=next). Uses only charPr that
    are already defined in header.xml, so there is zero OWPML-schema / Hancom
    compatibility risk (no new charPr inserted, no bold/centre surgery).

    `levels` is aligned to the document's content paragraphs in order; each is
    "H1".."H6" or "P". 'P'/None paragraphs keep their default charPr. Edits
    section0.xml in place.
    Returns the number of paragraphs restyled.
    """
    sec_names = section_entry_names(hwpx_path)
    if not sec_names:
        return 0
    sec_name = sec_names[0]
    with open_bounded_zip(hwpx_path) as z:
        if "Contents/header.xml" not in z.namelist():
            return 0
        header = parse_xml(read_bounded_entry(z, "Contents/header.xml")).getroot()
        sec_tree = parse_xml(read_bounded_entry(z, sec_name))

    charprs = [
        (int(e.get("id")), int(e.get("height") or 0))
        for e in header.iter()
        if localname(e) == "charPr" and (e.get("id") or "").isdigit()
    ]
    ranked = [cid for cid, _ in sorted(charprs, key=lambda x: (-x[1], x[0])) if cid != 0]
    if not ranked:
        return 0
    h_char = {
        "H1": str(ranked[0]),
        "H2": str(ranked[min(1, len(ranked) - 1)]),
        "H3": str(ranked[min(2, len(ranked) - 1)]),
    }
    for n in range(4, 7):
        h_char[f"H{n}"] = h_char["H3"]

    sec = find_sec(sec_tree.getroot())
    content = [
        p for p in body_paragraphs(sec)
        if not any(localname(e) == "secPr" for e in p.iter())
    ]
    restyled = 0
    for p, lvl in zip(content, levels):
        cid = h_char.get(lvl)
        if not cid:
            continue
        runs = [c for c in p if localname(c) == "run"]
        if not runs:
            continue
        for run in runs:
            run.set("charPrIDRef", cid)
        restyled += 1
    if restyled:
        rewrite_entries(hwpx_path, hwpx_path, {sec_name: serialize(sec_tree)})
    return restyled


# ── label-value form filling (table strategies) ─────────────────────────────

def _norm_label(s: str) -> str:
    return s.strip().rstrip(":：").strip()


def cell_text(tc: etree._Element) -> str:
    """Concatenated visible text of a table cell (<hp:tc>), incl. subList."""
    parts: list[str] = []
    for el in tc.iter():
        ln = localname(el)
        if ln == "t" and el.text:
            parts.append(el.text)
        elif ln == "tab":
            parts.append("\t")
        elif ln in ("lineBreak", "br"):
            parts.append("\n")
    return "".join(parts)


def set_cell_text(tc: etree._Element, value: str) -> bool:
    """Set a cell's value into its first paragraph's first <hp:t> (preserving
    that run's charPr), blank the remaining <hp:t> in the cell, drop linesegarray.
    Creates a <hp:t> in the first run if the cell paragraph has none (empty cell).
    Returns True if the value was written.
    """
    paras = [e for e in tc.iter() if localname(e) == "p"]
    if not paras:
        return False
    first_p = paras[0]
    t_elems = [e for e in first_p.iter() if localname(e) == "t"]
    done = False
    if t_elems:
        t_elems[0].text = value
        for t in t_elems[1:]:
            t.text = ""
        done = True
    else:
        runs = [c for c in first_p if localname(c) == "run"]
        if runs:
            t = etree.SubElement(runs[0], f"{HP}t")
            t.text = value
            done = True
    for p in paras[1:]:
        for t in [e for e in p.iter() if localname(e) == "t"]:
            t.text = ""
        remove_linesegarray(p)
    remove_linesegarray(first_p)
    return done


def fill_form(src: Path, dst: Path, values: dict[str, str]) -> tuple[list[tuple[str, str]], list[str]]:
    """Fill a form by matching labels to table cells (style preserved).

    Strategies (kordoc-derived):
      1. adjacent label|value cells — cell whose text == a provided label →
         write value into the next cell in the row.
      2. header + data rows — first row all labels → fill each data row by column.

    Label match: whitespace-trimmed, trailing colon stripped, exact (each label
    filled once). Returns (filled[(label,value)], unmatched_labels).
    """
    norm_values = {_norm_label(k): v for k, v in values.items()}
    filled: list[tuple[str, str]] = []
    matched: set[str] = set()
    overrides: dict[str, bytes] = {}

    with open_bounded_zip(src) as zin:
        infos = zin.infolist()
        _check_stream_metadata(infos)
        for info in infos:
            name = info.filename
            if not (
                name.lower().endswith(".xml")
                and "section" in name.lower()
            ):
                continue
            data = _read_bounded_entry(
                zin,
                info,
                limit=MAX_TRANSFORMED_XML_BYTES,
            )
            tree = parse_xml(data)
            root = tree.getroot()
            changed = False
            for tbl in [e for e in root.iter() if localname(e) == "tbl"]:
                rows = [c for c in tbl if localname(c) == "tr"]

                # Strategy 1: adjacent label | value
                for tr in rows:
                    cells = [c for c in tr if localname(c) == "tc"]
                    for i in range(len(cells) - 1):
                        label = _norm_label(cell_text(cells[i]))
                        if not label or label not in norm_values or label in matched:
                            continue
                        # don't clobber a cell that is itself a known label
                        if _norm_label(cell_text(cells[i + 1])) in norm_values:
                            continue
                        if set_cell_text(cells[i + 1], norm_values[label]):
                            matched.add(label)
                            filled.append((label, norm_values[label]))
                            changed = True

                # Strategy 2: header + data rows
                if len(rows) >= 2:
                    header_cells = [c for c in rows[0] if localname(c) == "tc"]
                    labels = [_norm_label(cell_text(c)) for c in header_cells]
                    if labels and all(labels):
                        for tr in rows[1:]:
                            data_cells = [c for c in tr if localname(c) == "tc"]
                            for ci in range(min(len(header_cells), len(data_cells))):
                                lab = labels[ci]
                                if lab in norm_values and lab not in matched:
                                    if set_cell_text(data_cells[ci], norm_values[lab]):
                                        matched.add(lab)
                                        filled.append((lab, norm_values[lab]))
                                        changed = True
            if changed:
                overrides[name] = serialize(tree)

    rewrite_entries(src, dst, overrides)
    unmatched = [k for k in norm_values if k not in matched]
    return filled, unmatched
