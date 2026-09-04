"""Strict consumer for the frozen hwp-certification-report-v1 contract.

This module intentionally has no jsonschema dependency. It validates the closed
wire shape plus runtime invariants that JSON Schema cannot express, then audits
the native atomic artifact directory before callers print any report content.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import stat
import struct
from pathlib import Path


POLICY_SCHEMA_SHA256 = "b3ba583032d12385b8cfe6994d6736bd8c22138c020465d1d3e01d66505a0cca"
REPORT_SCHEMA_SHA256 = "438a34903c99385cdc7791e57991b397171912d8ce0991d68e3f03e0b2b39681"
ORACLE_SCHEMA_SHA256 = "caa5523a7259048632e706a77dabc448d64c8482a1f3e6fbfccc19764b0f2086"

MAX_REPORT_BYTES = 4 * 1024 * 1024
MAX_MANIFEST_BYTES = 1024 * 1024
MAX_ARTIFACT_BYTES = 512 * 1024 * 1024
MAX_TREE_FILES = 259
MAX_REPORT_ARTIFACTS = 257
MAX_SELECTED_PAGES = 256
MAX_PAGE = 4096
MAX_FONT_RESOLUTIONS = 512

RULE_IDS = (
    "defined_styles",
    "used_styles",
    "numbering.definitions",
    "numbering.used",
    "tables",
    "links",
    "metadata",
    "macros",
    "external_references",
    "accessibility",
    "unresolved_fields",
    "fonts",
)
LIMITATIONS = (
    "native_not_detected_is_algorithm_scoped",
    "hancom_rendering_parity_not_claimed",
    "oracle_artifact_determinism_not_claimed",
    "oracle_page_count_not_host_verified",
    "selected_pages_only_when_policy_selects_pages",
)
REASON_CODES = frozenset(
    {
        "package_validation_failed",
        "package_or_import_warnings",
        "document_parse_failed",
        "repeat_import_mismatch",
        "repeat_import_failed",
        "not_run",
        "parse_budget_exceeded",
        "render_policy_failed",
        "layout_budget_exceeded",
        "image_decode_budget_exceeded",
        "pagination_drift_detected",
        "font_manifest_or_resolution_failed",
        "render_page_scope_invalid",
        "render_execution_failed",
        "disallowed_value",
        "required_value_missing",
        "style_reference_out_of_range",
        "below_minimum",
        "above_maximum",
        "disallowed_definition_index",
        "required_definition_index_missing",
        "disallowed_scheme",
        "disallowed_field_present",
        "required_field_missing",
        "forbidden_field_present",
        "forbidden_present",
        "required_missing",
        "inspection_incomplete",
        "picture_description_missing",
        "shape_description_missing",
        "unresolved_field_binding",
        "requested_font_name_invalid",
        "disallowed_requested_font",
        "required_requested_font_missing",
        "font_or_glyph_missing",
        "font_substitution_forbidden",
        "font_resolution_report_incomplete",
        "resolved_font_outside_manifest",
        "font_resolution_not_run",
    }
)
ORACLE_REASONS = frozenset(
    {
        "local_certification_failed",
        "policy_configuration_missing",
        "trusted_runner_not_configured",
        "oracle_process_group_unavailable_on_platform",
        "trusted_image_digest_mismatch",
        "runtime_unavailable_or_mismatched",
        "runtime_snapshot_not_executable",
        "runtime_version_probe_failed",
        "runtime_version_mismatch",
        "host_daemon_unattested",
        "trusted_image_attestation_invalid",
        "image_attestation_probe_failed",
        "image_attestation_mismatch",
        "extension_unavailable_or_mismatched",
        "oracle_workspace_unavailable",
        "oracle_input_snapshot_unavailable",
        "oracle_extension_snapshot_unavailable",
        "oracle_output_workspace_unavailable",
        "oracle_mount_source_invalid",
        "container_identity_unavailable",
        "container_cleanup_unverified",
        "runner_execution_failed",
        "oracle_timeout",
        "oracle_output_allowlist_violation",
        "runner_contract_missing",
        "runner_contract_invalid",
        "oracle_output_contract_mismatch",
        "runner_attestation_mismatch",
        "conversion_failed",
        "oracle_artifact_missing",
        "oracle_artifact_contract_invalid",
        "oracle_pdf_invalid",
        "oracle_artifact_copy_failed",
        "oracle_artifact_mismatch",
    }
)
ISSUE_TUPLES = {
    "parse_budget_exceeded": ("fatal", "input_parse"),
    "render_execution_failed": ("fatal", "layout"),
    "pagination_drift_detected": ("fatal", "layout"),
    "font_matched": ("info", "font_resolution"),
    "font_substituted": ("warning", "font_resolution"),
    "font_missing": ("incomplete", "font_resolution"),
    "font_manifest_load_failed": ("fatal", "font_resolution"),
    "font_resolution_budget_exceeded": ("fatal", "font_resolution"),
    "shaping_failed": ("incomplete", "shaping"),
    "page_definition_fallback": ("incomplete", "layout"),
    "page_control_payload_omitted": ("incomplete", "layout"),
    "page_number_format_fallback": ("incomplete", "layout"),
    "page_number_position_omitted": ("incomplete", "layout"),
    "page_number_shaping_omitted": ("incomplete", "shaping"),
    "unsupported_control_omitted": ("incomplete", "layout"),
    "image_size_missing_omitted": ("incomplete", "layout"),
    "image_data_missing_omitted": ("incomplete", "layout"),
    "image_decode_placeholder": ("incomplete", "rasterization"),
    "image_decode_budget_exceeded": ("fatal", "rasterization"),
    "invalid_table_cell_omitted": ("incomplete", "layout"),
    "text_box_geometry_invalid_omitted": ("incomplete", "layout"),
    "shape_depth_limit_omitted": ("incomplete", "layout"),
    "shape_style_invalid_omitted": ("incomplete", "layout"),
    "shape_geometry_invalid_omitted": ("incomplete", "layout"),
    "font_subset_fallback": ("warning", "pdf_export"),
    "layout_budget_exceeded": ("fatal", "layout"),
}
ISSUE_ORDER = {code: index for index, code in enumerate(ISSUE_TUPLES)}
PAGE_ARTIFACT = re.compile(r"^pages/page-([0-9]{6})\.png$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
IMAGE_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")


class ContractError(ValueError):
    """The native artifact directory does not satisfy the frozen contract."""


def _fail() -> None:
    raise ContractError("certification contract rejected")


def _exact_dict(value, keys) -> dict:
    if not isinstance(value, dict) or set(value) != set(keys):
        _fail()
    return value


def _integer(value, minimum: int = 0, maximum: int | None = None) -> int:
    if type(value) is not int or value < minimum or (
        maximum is not None and value > maximum
    ):
        _fail()
    return value


def _number(value, minimum: float, maximum: float, *, exclusive_min=False) -> float:
    if type(value) not in (int, float) or not math.isfinite(value):
        _fail()
    if (value <= minimum if exclusive_min else value < minimum) or value > maximum:
        _fail()
    return value


def _sha(value) -> str:
    if not isinstance(value, str) or SHA256.fullmatch(value) is None:
        _fail()
    return value


def _short_string(value) -> str:
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= 256
        or any(ord(character) < 32 or ord(character) == 127 for character in value)
    ):
        _fail()
    return value


def _unique_list(value, maximum: int) -> list:
    if not isinstance(value, list) or len(value) > maximum:
        _fail()
    return value


def _reason_list(value, *, oracle=False) -> list[str]:
    values = _unique_list(value, 32)
    allowed = ORACLE_REASONS if oracle else REASON_CODES
    if any(not isinstance(item, str) or item not in allowed for item in values):
        _fail()
    if len(set(values)) != len(values):
        _fail()
    return values


def _no_duplicate_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            _fail()
        result[key] = value
    return result


def _reject_constant(_value):
    _fail()


def _regular_stat(path: Path, maximum: int | None = None):
    try:
        metadata = path.lstat()
    except OSError:
        _fail()
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_nlink != 1
        or (maximum is not None and metadata.st_size > maximum)
    ):
        _fail()
    return metadata


def _read_json(path: Path, maximum: int) -> tuple[dict, bytes]:
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
    except OSError:
        _fail()
    if len(data) != metadata.st_size or len(data) > maximum:
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


def _hash_file(path: Path, maximum: int = MAX_ARTIFACT_BYTES) -> tuple[int, str]:
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
    ):
        _fail()
    return total, digest.hexdigest()


def _walk_tree(root: Path) -> tuple[dict[str, Path], set[str]]:
    try:
        root_metadata = root.lstat()
    except OSError:
        _fail()
    if not stat.S_ISDIR(root_metadata.st_mode) or stat.S_ISLNK(root_metadata.st_mode):
        _fail()
    files: dict[str, Path] = {}
    directories: set[str] = set()
    stack = [(root, "")]
    while stack:
        directory, prefix = stack.pop()
        try:
            entries = list(os.scandir(directory))
        except OSError:
            _fail()
        for entry in entries:
            relative = f"{prefix}/{entry.name}" if prefix else entry.name
            if (
                not relative
                or "\\" in relative
                or any(part in ("", ".", "..") for part in relative.split("/"))
                or any(ord(character) < 32 or ord(character) == 127 for character in relative)
            ):
                _fail()
            try:
                metadata = entry.stat(follow_symlinks=False)
            except OSError:
                _fail()
            path = Path(entry.path)
            if stat.S_ISLNK(metadata.st_mode):
                _fail()
            if stat.S_ISDIR(metadata.st_mode):
                directories.add(relative)
                if len(directories) >= MAX_TREE_FILES:
                    _fail()
                stack.append((path, relative))
            elif stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1:
                if relative in files:
                    _fail()
                files[relative] = path
                if len(files) > MAX_TREE_FILES:
                    _fail()
            else:
                _fail()
    if sum(_regular_stat(path).st_size for path in files.values()) > MAX_ARTIFACT_BYTES:
        _fail()
    return files, directories


def _validate_check(value) -> None:
    value = _exact_dict(value, ("status", "reason_codes", "issue_count", "issue_sha256"))
    status_value = value["status"]
    if status_value not in ("passed", "failed", "skipped"):
        _fail()
    reasons = _reason_list(value["reason_codes"])
    count = _integer(value["issue_count"], 0, 1_000_000)
    _sha(value["issue_sha256"])
    if status_value == "passed":
        if reasons or count != 0:
            _fail()
    elif not reasons or count == 0:
        _fail()


def _validate_rules(value) -> None:
    rules = _unique_list(value, 12)
    if rules and len(rules) != 12:
        _fail()
    rule_ids = tuple(
        rule.get("id") if isinstance(rule, dict) else None for rule in rules
    )
    if rules and rule_ids != RULE_IDS:
        _fail()
    for rule in rules:
        rule = _exact_dict(rule, ("id", "status", "observed_count", "reason_codes"))
        if rule["id"] not in RULE_IDS or rule["status"] not in ("passed", "failed"):
            _fail()
        _integer(rule["observed_count"], 0, 1_000_000)
        reasons = _reason_list(rule["reason_codes"])
        if (rule["status"] == "passed") != (not reasons):
            _fail()


def _validate_detection(value, algorithm: str) -> None:
    value = _exact_dict(value, ("result", "count", "algorithm", "complete"))
    if value["algorithm"] != algorithm or type(value["complete"]) is not bool:
        _fail()
    count = _integer(value["count"], 0, 10_000_000)
    result = value["result"]
    if result == "not_detected":
        valid = count == 0 and value["complete"]
    elif result == "detected":
        valid = count >= 1 and value["complete"]
    elif result == "incomplete":
        valid = not value["complete"]
    else:
        valid = False
    if not valid:
        _fail()


def _validate_issue(value, *, info: bool) -> None:
    value = _exact_dict(
        value,
        ("code", "severity", "stage", "count", "sample_sha256", "samples_complete"),
    )
    code = value["code"]
    if code not in ISSUE_TUPLES or (value["severity"], value["stage"]) != ISSUE_TUPLES[code]:
        _fail()
    if info != (code == "font_matched" and value["severity"] == "info"):
        _fail()
    _integer(value["count"], 1, 1_000_000)
    samples = _unique_list(value["sample_sha256"], 4)
    if not samples or len(set(samples)) != len(samples) or samples != sorted(samples):
        _fail()
    for sample in samples:
        _sha(sample)
    if type(value["samples_complete"]) is not bool:
        _fail()
    if not value["samples_complete"] and len(samples) != 4:
        _fail()


def _issue_hash(issues: list[dict]) -> str:
    digest = hashlib.sha256(b"hwp-render-typed-issues-v1\0")
    for issue in issues:
        for key in ("code", "severity", "stage"):
            encoded = issue[key].encode("utf-8")
            digest.update(struct.pack("<Q", len(encoded)))
            digest.update(encoded)
        digest.update(struct.pack("<Q", issue["count"]))
        digest.update(bytes((int(issue["samples_complete"]),)))
        digest.update(struct.pack("<Q", len(issue["sample_sha256"])))
        for sample in issue["sample_sha256"]:
            encoded = sample.encode("utf-8")
            digest.update(struct.pack("<Q", len(encoded)))
            digest.update(encoded)
    return digest.hexdigest()


def _validate_font(value) -> None:
    value = _exact_dict(
        value,
        (
            "requested_name_sha256",
            "resolved_family_sha256",
            "font_file_sha256",
            "face_index",
            "outcome",
        ),
    )
    _sha(value["requested_name_sha256"])
    for key in ("resolved_family_sha256", "font_file_sha256"):
        if value[key] is not None:
            _sha(value[key])
    if value["face_index"] is not None:
        _integer(value["face_index"], 0, 4_294_967_295)
    if value["outcome"] not in ("matched", "substituted", "missing", "coverage_substituted"):
        _fail()
    resolved = (
        value["resolved_family_sha256"],
        value["font_file_sha256"],
        value["face_index"],
    )
    if value["outcome"] == "missing":
        if any(item is not None for item in resolved):
            _fail()
    elif any(item is None for item in resolved):
        _fail()


def _validate_render(value) -> None:
    value = _exact_dict(
        value,
        (
            "profile",
            "dpi",
            "total_pages",
            "selected_pages",
            "status",
            "reason_codes",
            "fonts",
            "pages",
            "issues",
            "info",
            "issue_count",
            "info_count",
            "issue_log_complete",
            "issue_sha256",
        ),
    )
    if value["profile"] != "hwp-cli-native-certification-render-v1":
        _fail()
    _number(value["dpi"], 36, 600)
    _integer(value["total_pages"], 0, MAX_PAGE)
    selected = _unique_list(value["selected_pages"], MAX_SELECTED_PAGES)
    if any(type(page) is not int or not 1 <= page <= MAX_PAGE for page in selected):
        _fail()
    if selected != sorted(set(selected)):
        _fail()
    status_value = value["status"]
    if status_value not in ("passed", "failed", "skipped"):
        _fail()
    reasons = _reason_list(value["reason_codes"])
    if (status_value == "passed") != (not reasons):
        _fail()
    fonts = _unique_list(value["fonts"], MAX_FONT_RESOLUTIONS)
    for font in fonts:
        _validate_font(font)
    if len({json.dumps(font, sort_keys=True) for font in fonts}) != len(fonts):
        _fail()
    pages = _unique_list(value["pages"], MAX_SELECTED_PAGES)
    page_numbers = []
    for page in pages:
        page = _exact_dict(
            page,
            (
                "page",
                "width_pt",
                "height_pt",
                "item_count",
                "visual_blank",
                "outside_page_bounds",
                "possible_collision",
                "png_sha256",
                "png_bytes",
            ),
        )
        page_numbers.append(_integer(page["page"], 1, MAX_PAGE))
        _number(page["width_pt"], 0, 100_000, exclusive_min=True)
        _number(page["height_pt"], 0, 100_000, exclusive_min=True)
        _integer(page["item_count"], 0, 1_000_000)
        if type(page["visual_blank"]) is not bool:
            _fail()
        _validate_detection(
            page["outside_page_bounds"],
            "display_item_finite_bbox_vs_page_rect_v1",
        )
        _validate_detection(
            page["possible_collision"],
            "cross_baseline_glyph_bbox_overlap_ge_0_25_v1",
        )
        _sha(page["png_sha256"])
        _integer(page["png_bytes"], 0, MAX_ARTIFACT_BYTES)
    if page_numbers != selected:
        _fail()
    issues = _unique_list(value["issues"], 24)
    info = _unique_list(value["info"], 1)
    for issue in issues:
        _validate_issue(issue, info=False)
    for issue in info:
        _validate_issue(issue, info=True)
    codes = [issue["code"] for issue in issues + info]
    if len(set(codes)) != len(codes):
        _fail()
    if [ISSUE_ORDER[issue["code"]] for issue in issues] != sorted(
        ISSUE_ORDER[issue["code"]] for issue in issues
    ):
        _fail()
    issue_count = _integer(value["issue_count"], 0, 1_000_000)
    info_count = _integer(value["info_count"], 0, 1_000_000)
    if issue_count != sum(issue["count"] for issue in issues):
        _fail()
    if info_count != sum(issue["count"] for issue in info):
        _fail()
    if type(value["issue_log_complete"]) is not bool:
        _fail()
    if _sha(value["issue_sha256"]) != _issue_hash(issues):
        _fail()


def _validate_attestation(value, *, observed: bool) -> None:
    base = (
        "runtime_kind",
        "runtime_version",
        "runtime_sha256",
        "libreoffice_version",
        "libreoffice_executable_sha256",
        "extension_version",
        "extension_sha256",
        "image_digest",
    )
    host = (
        "docker_client_version_sha256",
        "docker_server_version_sha256",
        "image_id",
        "image_reference_sha256",
    )
    value = _exact_dict(value, base + host if observed else base)
    if value["runtime_kind"] != "docker":
        _fail()
    for key in ("runtime_version", "libreoffice_version", "extension_version"):
        _short_string(value[key])
    for key in (
        "runtime_sha256",
        "libreoffice_executable_sha256",
        "extension_sha256",
    ):
        _sha(value[key])
    if (
        not isinstance(value["image_digest"], str)
        or IMAGE_DIGEST.fullmatch(value["image_digest"]) is None
    ):
        _fail()
    if observed:
        _sha(value["docker_client_version_sha256"])
        _sha(value["docker_server_version_sha256"])
        if (
            not isinstance(value["image_id"], str)
            or IMAGE_DIGEST.fullmatch(value["image_id"]) is None
        ):
            _fail()
        _sha(value["image_reference_sha256"])


def _validate_log(value) -> None:
    value = _exact_dict(value, ("bytes_observed", "bytes_hashed", "truncated", "sha256"))
    observed = _integer(value["bytes_observed"], 0)
    hashed = _integer(value["bytes_hashed"], 0, 65_536)
    if hashed > observed or type(value["truncated"]) is not bool:
        _fail()
    if value["truncated"] != (observed > hashed):
        _fail()
    _sha(value["sha256"])


def _validate_oracle(value, *, local_passed: bool) -> None:
    value = _exact_dict(
        value,
        (
            "mode",
            "status",
            "reason_code",
            "expected",
            "observed",
            "stdout",
            "stderr",
            "artifact_determinism",
        ),
    )
    mode = value["mode"]
    status_value = value["status"]
    if mode not in ("disabled", "optional", "required") or status_value not in (
        "disabled",
        "not_run",
        "passed",
        "failed",
        "oracle_unavailable",
    ):
        _fail()
    if value["reason_code"] is not None:
        if value["reason_code"] not in ORACLE_REASONS:
            _fail()
    if value["expected"] is not None:
        _validate_attestation(value["expected"], observed=False)
    if value["observed"] is not None:
        _validate_attestation(value["observed"], observed=True)
    for key in ("stdout", "stderr"):
        if value[key] is not None:
            _validate_log(value[key])

    if mode == "disabled":
        if (
            status_value != "disabled"
            or value["reason_code"] is not None
            or value["expected"] is not None
            or value["observed"] is not None
            or value["stdout"] is not None
            or value["stderr"] is not None
            or value["artifact_determinism"]
            != ("not_applicable" if local_passed else "not_claimed")
        ):
            _fail()
        return
    if value["expected"] is None or value["artifact_determinism"] != "not_claimed":
        _fail()
    if not local_passed:
        if (
            status_value != "not_run"
            or value["reason_code"] != "local_certification_failed"
            or value["observed"] is not None
            or value["stdout"] is not None
            or value["stderr"] is not None
        ):
            _fail()
        return
    if status_value == "oracle_unavailable":
        if (
            value["reason_code"] is None
            or value["observed"] is not None
            or value["stdout"] is not None
            or value["stderr"] is not None
        ):
            _fail()
    elif status_value == "failed":
        if value["reason_code"] is None:
            _fail()
    elif status_value == "passed":
        if (
            value["reason_code"] is not None
            or value["observed"] is None
            or value["stdout"] is None
            or value["stderr"] is None
        ):
            _fail()
    else:
        _fail()


def _validate_artifact(value, *, allow_report=False) -> None:
    value = _exact_dict(value, ("path", "bytes", "sha256", "deterministic"))
    path = value["path"]
    if not isinstance(path, str):
        _fail()
    page = PAGE_ARTIFACT.fullmatch(path)
    if page:
        if not 1 <= int(page.group(1)) <= MAX_PAGE or value["deterministic"] is not True:
            _fail()
        minimum = 0
    elif path == "oracle/import.pdf":
        if value["deterministic"] is not False:
            _fail()
        minimum = 16
    elif allow_report and path == "report.json":
        if value["deterministic"] is not True:
            _fail()
        minimum = 0
    else:
        _fail()
    _integer(value["bytes"], minimum, MAX_ARTIFACT_BYTES)
    _sha(value["sha256"])


def _validate_report(value) -> bool:
    value = _exact_dict(
        value,
        (
            "schema_version",
            "contract",
            "overall",
            "scope",
            "input",
            "policy_sha256",
            "checks",
            "render",
            "oracle",
            "artifacts",
            "limitations",
        ),
    )
    if value["schema_version"] != "1.0" or value["contract"] != "hwp-certification-report-v1":
        _fail()
    if value["overall"] not in ("passed", "failed", "partial") or value["scope"] not in (
        "native_only",
        "native_plus_independent_import",
    ):
        _fail()
    input_value = _exact_dict(value["input"], ("format", "bytes", "sha256"))
    if input_value["format"] not in ("hwp5", "hwpx", "unknown"):
        _fail()
    _integer(input_value["bytes"], 0, 128 * 1024 * 1024)
    _sha(input_value["sha256"])
    _sha(value["policy_sha256"])
    checks = _exact_dict(value["checks"], ("package", "repeat_import_consistency", "rules"))
    _validate_check(checks["package"])
    _validate_check(checks["repeat_import_consistency"])
    _validate_rules(checks["rules"])
    _validate_render(value["render"])
    local_passed = (
        checks["package"]["status"] == "passed"
        and checks["repeat_import_consistency"]["status"] == "passed"
        and len(checks["rules"]) == 12
        and all(rule["status"] == "passed" for rule in checks["rules"])
        and value["render"]["status"] == "passed"
    )
    _validate_oracle(value["oracle"], local_passed=local_passed)
    artifacts = _unique_list(value["artifacts"], MAX_REPORT_ARTIFACTS)
    paths = []
    for artifact in artifacts:
        _validate_artifact(artifact)
        paths.append(artifact["path"])
    if len(paths) != len(set(paths)):
        _fail()
    page_artifacts = {path for path in paths if path.startswith("pages/")}
    expected_pages = {
        f"pages/page-{page:06}.png" for page in value["render"]["selected_pages"]
    }
    if page_artifacts != expected_pages:
        _fail()
    artifact_by_path = {artifact["path"]: artifact for artifact in artifacts}
    for page in value["render"]["pages"]:
        artifact = artifact_by_path.get(f"pages/page-{page['page']:06}.png")
        if (
            artifact is None
            or artifact["bytes"] != page["png_bytes"]
            or artifact["sha256"] != page["png_sha256"]
        ):
            _fail()
    oracle_pdf = "oracle/import.pdf" in artifact_by_path
    oracle_passed = value["oracle"]["status"] == "passed"
    if value["scope"] == "native_plus_independent_import":
        if not (local_passed and oracle_passed and oracle_pdf):
            _fail()
    elif oracle_pdf or oracle_passed:
        _fail()
    expected_overall = "failed"
    if local_passed:
        mode = value["oracle"]["mode"]
        oracle_status = value["oracle"]["status"]
        if oracle_status == "passed" or mode == "disabled":
            expected_overall = "passed"
        elif oracle_status == "oracle_unavailable":
            expected_overall = "passed" if mode == "optional" else "partial"
        elif oracle_status == "failed":
            expected_overall = "partial" if mode == "optional" else "failed"
    if value["overall"] != expected_overall:
        _fail()
    limitations = _unique_list(value["limitations"], len(LIMITATIONS))
    if tuple(limitations) != LIMITATIONS:
        _fail()
    return local_passed


def validate_certification_directory(report_dir: str | Path) -> dict:
    """Return the validated report, or raise ContractError without source details."""
    root = Path(report_dir)
    files, directories = _walk_tree(root)
    if "report.json" not in files or "manifest.json" not in files:
        _fail()
    report, report_bytes = _read_json(files["report.json"], MAX_REPORT_BYTES)
    manifest, manifest_bytes = _read_json(files["manifest.json"], MAX_MANIFEST_BYTES)
    _validate_report(report)

    expected_files = {artifact["path"] for artifact in report["artifacts"]}
    expected_files.update(("report.json", "manifest.json"))
    if set(files) != expected_files:
        _fail()
    expected_directories = {
        "/".join(path.split("/")[:end])
        for path in expected_files
        for end in range(1, len(path.split("/")))
    }
    if directories != expected_directories or len(files) > MAX_TREE_FILES:
        _fail()

    actual: dict[str, tuple[int, str]] = {}
    for relative, path in files.items():
        actual[relative] = _hash_file(path)
    for artifact in report["artifacts"]:
        if actual[artifact["path"]] != (artifact["bytes"], artifact["sha256"]):
            _fail()

    manifest = _exact_dict(
        manifest,
        ("schema_version", "contract", "artifact_count", "total_bytes", "files", "self"),
    )
    if (
        manifest["schema_version"] != "1.0"
        or manifest["contract"] != "hwp-certification-artifact-manifest-v1"
    ):
        _fail()
    manifest_files = _unique_list(manifest["files"], MAX_TREE_FILES - 1)
    manifest_paths = []
    for artifact in manifest_files:
        _validate_artifact(artifact, allow_report=True)
        manifest_paths.append(artifact["path"])
    if manifest_paths != sorted(manifest_paths) or len(set(manifest_paths)) != len(manifest_paths):
        _fail()
    report_entry = {
        "path": "report.json",
        "bytes": len(report_bytes),
        "sha256": hashlib.sha256(report_bytes).hexdigest(),
        "deterministic": True,
    }
    expected_manifest_files = sorted(
        [*report["artifacts"], report_entry],
        key=lambda artifact: artifact["path"],
    )
    if manifest_files != expected_manifest_files:
        _fail()
    self_entry = _exact_dict(
        manifest["self"],
        ("path", "bytes", "sha256", "deterministic", "reason"),
    )
    if self_entry != {
        "path": "manifest.json",
        "bytes": len(manifest_bytes),
        "sha256": None,
        "deterministic": True,
        "reason": "self_hash_not_representable",
    }:
        _fail()
    artifact_count = _integer(manifest["artifact_count"], 0, MAX_TREE_FILES)
    declared_total_bytes = _integer(
        manifest["total_bytes"],
        0,
        MAX_ARTIFACT_BYTES,
    )
    total_bytes = sum(size for size, _digest in actual.values())
    if (
        artifact_count != len(files)
        or declared_total_bytes != total_bytes
        or total_bytes > MAX_ARTIFACT_BYTES
    ):
        _fail()
    return report
