"""Strict consumer for the frozen hwp structured corpus v1 report tree."""
from __future__ import annotations

import hashlib
import json
import os
import re
import stat
from pathlib import Path

import certification_contract as certification


MANIFEST_SCHEMA_SHA256 = "b8057de94b15deebceb58f014071d57d96fd9bb61603d9cbc2fd94a4398b3b3a"
RUN_SCHEMA_SHA256 = "416466f0c197ec31c64ed76035d3a7b34dbb694c08c459605c9eccfface22706"
ARTIFACTS_SCHEMA_SHA256 = "3f9effe9df788304ae39bd3f1f460a40bf4b979016d5bc4c5599db386d577c23"
FROZEN_MANIFEST_SHA256 = "03ef22e59a45a03d49de5e611f95edebb268a76665feaa63e8fc5d2e92f30dc5"
FROZEN_POLICY_SHA256 = "2da9ef212ac3c5e10c85229d62e307e0c29a8e06a848e47feb039db1fd09fdb8"
# Certification hashes its validated canonical policy, not the source JSON bytes.
CERTIFICATION_POLICY_SHA256 = "27512c68673a72e8c29f574557a632bf8d05a0800da71146bc0f5fb885a70bd1"
FONT_SHA256 = "194018e6b2b293a7964f037b25c0249ce1418bc9ab3c971060a03aa57861e252"
FONT_SOURCE_REVISION = "2796410152d4f9524b68ed46e69c1b60f8e0f7c3"
FONT_SOURCE_URL_SHA256 = "405bba3514cd264bc1775582cf90b100445e9ae5154b8b365b0a0faa80b1d631"

MAX_MANIFEST_BYTES = 1024 * 1024
MAX_REPORT_BYTES = 1024 * 1024
MAX_TREE_FILES = 256
MAX_TREE_DIRECTORIES = 128
MAX_TREE_DEPTH = 8
MAX_PATH_BYTES = 512
MAX_FILE_BYTES = 128 * 1024 * 1024
MAX_TREE_BYTES = 512 * 1024 * 1024
MAX_SEMANTIC_NODES = 100_000
MAX_SEMANTIC_BYTES = 64 * 1024 * 1024

CASES = (
    ("official-letter", "korean-official-letter"),
    ("approval-memo", "approval-draft-memo"),
    ("report", "report"),
    ("business-plan", "business-plan"),
    ("meeting-minutes", "meeting-minutes"),
    ("academic-education", "academic-education"),
    ("print-form", "print-form"),
)
FORMATS = ("hwpx", "hwp")
ALLOWED_ARTIFACT_PATHS = {"summary.json"}
for _case_id, _category in CASES:
    for _format in FORMATS:
        for _run in ("run-a", "run-b"):
            ALLOWED_ARTIFACT_PATHS.add(
                f"documents/{_case_id}/{_run}.{_format}"
            )
            for _suffix in (
                "manifest.json",
                "pages/page-000001.png",
                "report.json",
            ):
                ALLOWED_ARTIFACT_PATHS.add(
                    f"certification/{_case_id}/{_format}/{_run}/{_suffix}"
                )
CASE_REASONS = frozenset({"format_failed", "cross_format_semantic_mismatch"})
FORMAT_REASONS = frozenset(
    {
        "workspace_failed",
        "input_snapshot_failed",
        "generation_failed",
        "output_read_failed",
        "two_run_byte_mismatch",
        "package_validation_failed",
        "semantic_assertion_failed",
        "certification_failed",
        "certification_assertion_failed",
        "certification_execution_failed",
        "two_run_render_mismatch",
    }
)
LIMITS = {
    "max_manifest_bytes": MAX_MANIFEST_BYTES,
    "max_report_bytes": MAX_REPORT_BYTES,
    "max_cases": 32,
    "max_tree_files": MAX_TREE_FILES,
    "max_tree_directories": MAX_TREE_DIRECTORIES,
    "max_tree_depth": MAX_TREE_DEPTH,
    "max_artifact_path_bytes": MAX_PATH_BYTES,
    "max_artifact_file_bytes": MAX_FILE_BYTES,
    "max_tree_bytes": MAX_TREE_BYTES,
    "max_semantic_nodes": MAX_SEMANTIC_NODES,
    "max_semantic_bytes": MAX_SEMANTIC_BYTES,
}
LIMITATIONS = (
    "no_hancom_parity_claim",
    "no_independent_office_oracle",
    "single_page_fixture_profile",
    "no_advanced_drawing_or_chart_coverage",
    "no_comments_revisions_or_security_controls",
    "no_unparsed_target_specific_control_payloads_in_semantic_digest",
    "no_line_layout_cache_or_opaque_record_bytes_in_semantic_digest",
    "no_advanced_shape_geometry_or_style_in_semantic_digest",
    "no_hwp5_ambiguous_strike_or_underline_shape_in_semantic_digest",
    "category_labels_do_not_imply_complete_feature_coverage",
)
CLAIMS = {
    "coverage_scope": "bounded_representative_structured_smoke",
    "semantic_digest_profile": "hwp-corpus-common-semantic-v1",
    "byte_determinism_scope": "same_process_same_platform_two_run",
    "render_hash_scope": "recorded_for_platform_profile_not_cross_platform_equivalence",
    "oracle_scope": "native_only_oracle_disabled",
    "manual_checks": False,
    "limitations": list(LIMITATIONS),
}

SHA256 = re.compile(r"^[0-9a-f]{64}$")
ARTIFACT_PATH = re.compile(
    r"^(?:certification|documents)/[a-z0-9][a-z0-9/-]*\.(?:json|png|hwp|hwpx)$"
    r"|^summary\.json$"
)
WINDOWS_RESERVED = re.compile(r"^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)", re.I)


class ContractError(ValueError):
    """The corpus report tree does not satisfy the frozen contract."""


def _fail() -> None:
    raise ContractError("structured corpus contract rejected")


def _exact_dict(value, keys) -> dict:
    if not isinstance(value, dict) or set(value) != set(keys):
        _fail()
    return value


def _integer(value, minimum=0, maximum=None) -> int:
    if type(value) is not int or value < minimum or (
        maximum is not None and value > maximum
    ):
        _fail()
    return value


def _sha(value) -> str:
    if not isinstance(value, str) or SHA256.fullmatch(value) is None:
        _fail()
    return value


def _bounded_ascii(value, maximum=32) -> str:
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= maximum
        or not value.isascii()
        or any(ord(character) < 32 or ord(character) == 127 for character in value)
    ):
        _fail()
    return value


def _no_duplicate_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            _fail()
        result[key] = value
    return result


def _reject_constant(_value):
    _fail()


def _is_reparse(metadata) -> bool:
    attribute = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return bool(getattr(metadata, "st_file_attributes", 0) & attribute)


def _regular_stat(path: Path, maximum=MAX_FILE_BYTES):
    try:
        metadata = path.lstat()
    except OSError:
        _fail()
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_nlink != 1
        or _is_reparse(metadata)
        or metadata.st_size > maximum
    ):
        _fail()
    return metadata


def _hash_file(path: Path, maximum=MAX_FILE_BYTES) -> tuple[int, str]:
    metadata = _regular_stat(path, maximum)
    digest = hashlib.sha256()
    total = 0
    try:
        with path.open("rb") as stream:
            opened = os.fstat(stream.fileno())
            if (
                opened.st_dev != metadata.st_dev
                or opened.st_ino != metadata.st_ino
                or opened.st_size != metadata.st_size
                or opened.st_nlink != 1
            ):
                _fail()
            while chunk := stream.read(64 * 1024):
                total += len(chunk)
                if total > maximum:
                    _fail()
                digest.update(chunk)
            after = os.fstat(stream.fileno())
    except OSError:
        _fail()
    if (
        total != metadata.st_size
        or after.st_dev != metadata.st_dev
        or after.st_ino != metadata.st_ino
        or after.st_size != metadata.st_size
        or after.st_nlink != 1
    ):
        _fail()
    return total, digest.hexdigest()


def _read_json(path: Path, maximum=MAX_REPORT_BYTES) -> tuple[dict, bytes]:
    metadata = _regular_stat(path, maximum)
    try:
        with path.open("rb") as stream:
            opened = os.fstat(stream.fileno())
            if (
                opened.st_dev != metadata.st_dev
                or opened.st_ino != metadata.st_ino
                or opened.st_size != metadata.st_size
                or opened.st_nlink != 1
            ):
                _fail()
            data = stream.read(maximum + 1)
            after = os.fstat(stream.fileno())
    except OSError:
        _fail()
    if (
        len(data) != metadata.st_size
        or len(data) > maximum
        or after.st_dev != metadata.st_dev
        or after.st_ino != metadata.st_ino
        or after.st_size != metadata.st_size
        or after.st_nlink != 1
    ):
        _fail()
    try:
        value = json.loads(
            data.decode("utf-8", "strict"),
            object_pairs_hook=_no_duplicate_object,
            parse_constant=_reject_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError):
        _fail()
    if not isinstance(value, dict):
        _fail()
    return value, data


def _portable_path(relative: str) -> None:
    if (
        not isinstance(relative, str)
        or not relative
        or len(relative.encode("utf-8")) > MAX_PATH_BYTES
        or not relative.isascii()
        or "\\" in relative
        or ":" in relative
        or any(ord(character) < 32 or ord(character) == 127 for character in relative)
    ):
        _fail()
    parts = relative.split("/")
    if any(
        not part
        or part in (".", "..")
        or part.endswith((".", " "))
        or WINDOWS_RESERVED.match(part)
        for part in parts
    ):
        _fail()


def _walk_tree(root: Path) -> tuple[dict[str, Path], set[str]]:
    try:
        root_metadata = root.lstat()
    except OSError:
        _fail()
    if (
        not stat.S_ISDIR(root_metadata.st_mode)
        or stat.S_ISLNK(root_metadata.st_mode)
        or _is_reparse(root_metadata)
        or (os.name != "nt" and root_metadata.st_mode & 0o077 != 0)
    ):
        _fail()
    files: dict[str, Path] = {}
    directories: set[str] = set()
    stack = [(root, "", 0)]
    total = 0
    while stack:
        directory, prefix, depth = stack.pop()
        if depth > MAX_TREE_DEPTH:
            _fail()
        try:
            entries = list(os.scandir(directory))
        except OSError:
            _fail()
        for entry in entries:
            relative = f"{prefix}/{entry.name}" if prefix else entry.name
            _portable_path(relative)
            try:
                metadata = entry.stat(follow_symlinks=False)
            except OSError:
                _fail()
            if stat.S_ISLNK(metadata.st_mode) or _is_reparse(metadata):
                _fail()
            path = Path(entry.path)
            if stat.S_ISDIR(metadata.st_mode):
                directories.add(relative)
                if len(directories) > MAX_TREE_DIRECTORIES:
                    _fail()
                stack.append((path, relative, depth + 1))
            elif stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1:
                if relative in files or metadata.st_size > MAX_FILE_BYTES:
                    _fail()
                files[relative] = path
                total += metadata.st_size
                if len(files) > MAX_TREE_FILES or total > MAX_TREE_BYTES:
                    _fail()
            else:
                _fail()
    return files, directories


def _reason_list(value, allowed, maximum) -> list[str]:
    if (
        not isinstance(value, list)
        or len(value) > maximum
        or any(not isinstance(item, str) or item not in allowed for item in value)
    ):
        _fail()
    return value


def _validate_detection(value) -> None:
    value = _exact_dict(value, ("result", "count", "complete"))
    if (
        value["result"] != "not_detected"
        or _integer(value["count"], 0, 0) != 0
        or value["complete"] is not True
    ):
        _fail()


def _validate_semantic(value) -> None:
    value = _exact_dict(
        value,
        (
            "plain_text_sha256",
            "structural_semantic_sha256",
            "text_chars",
            "sections",
            "paragraphs",
            "tables",
            "required_text_count",
        ),
    )
    _sha(value["plain_text_sha256"])
    _sha(value["structural_semantic_sha256"])
    _integer(value["text_chars"], 80, 2_000_000)
    _integer(value["sections"], 1, 64)
    _integer(value["paragraphs"], 5, 1_000_000)
    _integer(value["tables"], 1, 100_000)
    _integer(value["required_text_count"], 3, 64)


def _certification_projection(report: dict) -> dict:
    render = report["render"]
    return {
        "overall": report["overall"],
        "total_pages": render["total_pages"],
        "selected_pages": render["selected_pages"],
        "render_issue_count": render["issue_count"],
        "render_issue_sha256": render["issue_sha256"],
        "fonts": [
            {
                "font_file_sha256": font["font_file_sha256"],
                "outcome": font["outcome"],
            }
            for font in render["fonts"]
        ],
        "pages": [
            {
                "page": page["page"],
                "png_sha256": page["png_sha256"],
                "visual_blank": page["visual_blank"],
                "outside_page_bounds": {
                    key: page["outside_page_bounds"][key]
                    for key in ("result", "count", "complete")
                },
                "possible_collision": {
                    key: page["possible_collision"][key]
                    for key in ("result", "count", "complete")
                },
            }
            for page in render["pages"]
        ],
    }


def _validate_certification_summary(value) -> None:
    value = _exact_dict(
        value,
        (
            "overall",
            "total_pages",
            "selected_pages",
            "render_issue_count",
            "render_issue_sha256",
            "fonts",
            "pages",
        ),
    )
    if (
        value["overall"] != "passed"
        or value["total_pages"] != 1
        or value["selected_pages"] != [1]
        or value["render_issue_count"] != 0
    ):
        _fail()
    _sha(value["render_issue_sha256"])
    if value["fonts"] != [{"font_file_sha256": FONT_SHA256, "outcome": "matched"}]:
        _fail()
    if not isinstance(value["pages"], list) or len(value["pages"]) != 1:
        _fail()
    page = _exact_dict(
        value["pages"][0],
        (
            "page",
            "png_sha256",
            "visual_blank",
            "outside_page_bounds",
            "possible_collision",
        ),
    )
    if page["page"] != 1 or page["visual_blank"] is not False:
        _fail()
    _sha(page["png_sha256"])
    _validate_detection(page["outside_page_bounds"])
    _validate_detection(page["possible_collision"])


def _validate_format(value, expected_format: str) -> None:
    value = _exact_dict(
        value,
        (
            "format",
            "status",
            "reason_codes",
            "two_run_byte_identical",
            "output_sha256",
            "output_bytes",
            "two_run_render_identical",
            "semantic",
            "certification",
        ),
    )
    if value["format"] != expected_format or value["status"] not in ("passed", "failed"):
        _fail()
    reasons = _reason_list(value["reason_codes"], FORMAT_REASONS, 16)
    if type(value["two_run_byte_identical"]) is not bool or type(
        value["two_run_render_identical"]
    ) is not bool:
        _fail()
    if value["output_sha256"] is not None:
        _sha(value["output_sha256"])
    if value["output_bytes"] is not None:
        _integer(value["output_bytes"], 0, MAX_FILE_BYTES)
    if value["semantic"] is not None:
        _validate_semantic(value["semantic"])
    if value["certification"] is not None:
        _validate_certification_summary(value["certification"])
    if value["status"] == "passed":
        if (
            reasons
            or value["two_run_byte_identical"] is not True
            or value["two_run_render_identical"] is not True
            or value["output_sha256"] is None
            or not value["output_bytes"]
            or value["semantic"] is None
            or value["certification"] is None
        ):
            _fail()
    elif not reasons:
        _fail()


def _validate_summary(value, manifest_sha256: str) -> None:
    value = _exact_dict(
        value,
        (
            "schema_version",
            "contract",
            "profile",
            "platform",
            "status",
            "reason_codes",
            "manifest_sha256",
            "policy_sha256",
            "fonts",
            "cases",
            "limits",
            "claims",
        ),
    )
    if (
        value["schema_version"] != "1.0"
        or value["contract"] != "hwp-structured-corpus-run-v1"
        or value["profile"] != "structured-smoke-native-v1"
        or value["status"] not in ("passed", "failed")
        or value["manifest_sha256"] != manifest_sha256
        or value["policy_sha256"] != FROZEN_POLICY_SHA256
        or value["limits"] != LIMITS
        or value["claims"] != CLAIMS
    ):
        _fail()
    platform = _exact_dict(value["platform"], ("os", "arch", "family"))
    for item in platform.values():
        _bounded_ascii(item)
        if re.fullmatch(r"[a-z0-9_]+", item) is None:
            _fail()
    if platform["os"] == "windows":
        if platform["family"] != "windows":
            _fail()
    elif platform["os"] in ("linux", "macos"):
        if platform["family"] != "unix":
            _fail()
    else:
        _fail()
    reasons = _reason_list(value["reason_codes"], {"case_failed"}, 1)
    if value["fonts"] != [
        {
            "sha256": FONT_SHA256,
            "license": "OFL-1.1",
            "source_revision": FONT_SOURCE_REVISION,
            "source_url_sha256": FONT_SOURCE_URL_SHA256,
        }
    ]:
        _fail()
    if not isinstance(value["cases"], list) or len(value["cases"]) != len(CASES):
        _fail()
    any_failed = False
    for case, (expected_id, expected_category) in zip(value["cases"], CASES):
        case = _exact_dict(case, ("id", "category", "status", "reason_codes", "formats"))
        if (
            case["id"] != expected_id
            or case["category"] != expected_category
            or case["status"] not in ("passed", "failed")
            or not isinstance(case["formats"], list)
            or len(case["formats"]) != 2
        ):
            _fail()
        case_reasons = _reason_list(case["reason_codes"], CASE_REASONS, 2)
        for format_value, expected_format in zip(case["formats"], FORMATS):
            _validate_format(format_value, expected_format)
        format_failed = any(item["status"] == "failed" for item in case["formats"])
        semantics_match = (
            all(item["semantic"] is not None for item in case["formats"])
            and case["formats"][0]["semantic"] == case["formats"][1]["semantic"]
        )
        expected_reasons = []
        if format_failed:
            expected_reasons.append("format_failed")
        if not semantics_match:
            expected_reasons.append("cross_format_semantic_mismatch")
        if case_reasons != expected_reasons or (case["status"] == "passed") != (
            not expected_reasons
        ):
            _fail()
        any_failed |= case["status"] == "failed"
    if reasons != (["case_failed"] if any_failed else []) or (
        value["status"] == "passed"
    ) != (not any_failed):
        _fail()


def _validate_artifacts(value) -> list[dict]:
    value = _exact_dict(
        value, ("schema_version", "contract", "file_count", "total_bytes", "files")
    )
    if (
        value["schema_version"] != "1.0"
        or value["contract"] != "hwp-structured-corpus-artifacts-v1"
        or not isinstance(value["files"], list)
        or not 1 <= len(value["files"]) <= MAX_TREE_FILES - 1
    ):
        _fail()
    paths = []
    total = 0
    for artifact in value["files"]:
        artifact = _exact_dict(artifact, ("path", "bytes", "sha256"))
        path = artifact["path"]
        _portable_path(path)
        if (
            ARTIFACT_PATH.fullmatch(path) is None
            or path not in ALLOWED_ARTIFACT_PATHS
        ):
            _fail()
        paths.append(path)
        total += _integer(artifact["bytes"], 1, MAX_FILE_BYTES)
        _sha(artifact["sha256"])
    if (
        paths != sorted(paths)
        or len(set(paths)) != len(paths)
        or value["file_count"] != len(paths)
        or value["total_bytes"] != total
        or total > MAX_TREE_BYTES
    ):
        _fail()
    return value["files"]


def _expected_directories(paths) -> set[str]:
    return {
        "/".join(path.split("/")[:end])
        for path in paths
        for end in range(1, len(path.split("/")))
    }


def _validate_correlations(root: Path, summary: dict, actual) -> None:
    passed_expected_paths = {"summary.json"}
    for case in summary["cases"]:
        for format_value in case["formats"]:
            extension = format_value["format"]
            document_entries = []
            certification_reports = []
            for run in ("run-a", "run-b"):
                document_path = f"documents/{case['id']}/{run}.{extension}"
                if document_path in actual:
                    document_entries.append(actual[document_path])
                elif format_value["status"] == "passed":
                    _fail()
                if summary["status"] == "passed":
                    passed_expected_paths.add(document_path)
                cert_root = root / "certification" / case["id"] / extension / run
                cert_prefix = f"certification/{case['id']}/{extension}/{run}/"
                cert_paths = {path for path in actual if path.startswith(cert_prefix)}
                if not cert_paths:
                    if format_value["status"] == "passed":
                        _fail()
                    continue
                report = certification.validate_certification_directory(cert_root)
                certification_reports.append(report)
                for suffix in (
                    "manifest.json",
                    "pages/page-000001.png",
                    "report.json",
                ):
                    passed_expected_paths.add(f"{cert_prefix}{suffix}")
                if len(document_entries) != (1 if run == "run-a" else 2):
                    _fail()
                if (
                    report["input"]["format"] != ("hwpx" if extension == "hwpx" else "hwp5")
                    or report["input"]["bytes"] != document_entries[-1][0]
                    or report["input"]["sha256"] != document_entries[-1][1]
                    or report["policy_sha256"] != CERTIFICATION_POLICY_SHA256
                ):
                    _fail()
            if format_value["output_sha256"] is not None:
                if not document_entries or (
                    format_value["output_bytes"], format_value["output_sha256"]
                ) != document_entries[0]:
                    _fail()
            documents_identical = (
                len(document_entries) == 2 and document_entries[0] == document_entries[1]
            )
            if format_value["two_run_byte_identical"] != documents_identical:
                _fail()
            certifications_identical = False
            certification_projection = None
            if (
                len(certification_reports) == 2
                and certification_reports[0] == certification_reports[1]
            ):
                candidate = _certification_projection(certification_reports[0])
                try:
                    _validate_certification_summary(candidate)
                except ContractError:
                    pass
                else:
                    certifications_identical = True
                    certification_projection = candidate
            if format_value["two_run_render_identical"] != certifications_identical:
                _fail()
            if format_value["certification"] != certification_projection:
                _fail()
            if format_value["status"] == "passed" and (
                document_entries[0] != document_entries[1]
                or len(certification_reports) != 2
                or (
                    format_value["output_bytes"],
                    format_value["output_sha256"],
                )
                != document_entries[0]
            ):
                _fail()
    if summary["status"] == "passed" and set(actual) - {
        "artifacts.json"
    } != passed_expected_paths:
        _fail()


def validate_corpus_directory(report_dir: str | Path, manifest_path: str | Path) -> dict:
    """Return a validated summary or raise ContractError without source details."""
    root = Path(report_dir)
    files, directories = _walk_tree(root)
    if "summary.json" not in files or "artifacts.json" not in files:
        _fail()
    manifest_size, manifest_sha256 = _hash_file(Path(manifest_path), MAX_MANIFEST_BYTES)
    if manifest_size == 0 or manifest_sha256 != FROZEN_MANIFEST_SHA256:
        _fail()
    summary, summary_bytes = _read_json(files["summary.json"])
    artifact_manifest, artifact_bytes = _read_json(files["artifacts.json"])
    _validate_summary(summary, manifest_sha256)
    artifacts = _validate_artifacts(artifact_manifest)

    expected_files = {artifact["path"] for artifact in artifacts} | {"artifacts.json"}
    if set(files) != expected_files or directories != _expected_directories(expected_files):
        _fail()
    actual = {relative: _hash_file(path) for relative, path in files.items()}
    if actual["summary.json"] != (
        len(summary_bytes),
        hashlib.sha256(summary_bytes).hexdigest(),
    ) or actual["artifacts.json"] != (
        len(artifact_bytes),
        hashlib.sha256(artifact_bytes).hexdigest(),
    ):
        _fail()
    for artifact in artifacts:
        if actual[artifact["path"]] != (artifact["bytes"], artifact["sha256"]):
            _fail()
    if sum(size for size, _digest in actual.values()) > MAX_TREE_BYTES:
        _fail()
    _validate_correlations(root, summary, actual)
    return summary
