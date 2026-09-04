"""Contract / delegation tests for the hwpx skill's python layer.

The skill delegates generation·conversion·render·validation to the Rust hwp-cli
(`hwp`) and keeps lxml only for slot/structure surgery. These tests pin that
contract:

  * read / to-md fall back to the lxml extractor when hwp-cli is unavailable.
  * validate exit-code contract (valid -> 0, corrupt -> nonzero).
  * fill / slots delegate to hwp-cli and their JSON output parses.
  * styled --reference uses the lxml path and yields a valid hwpx.
  * styled --header/--footer fail before writing until structured controls exist.

Hermetic: every write lands in a pytest tmp dir; the real fixture is a bundled
template under templates/. hwp-cli-only cases skip when `hwp` is absent.

Run: make test-hwpx-skill
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import shutil
import stat
import struct
import subprocess
import sys
import zipfile
import zlib
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1]          # .../hwpx/scripts
SKILL = SCRIPTS.parent                                  # .../hwpx
TEMPLATE = SKILL / "templates" / "공문서_기본.hwpx"      # real {{slot}} fixture
DOCUMENT_SPEC_FIXTURES = Path(__file__).parent / "fixtures" / "document-spec-v1"
DOCUMENT_SPEC_V2_FIXTURES = Path(__file__).parent / "fixtures" / "document-spec-v2"
TEMPLATE_SPEC_FIXTURES = Path(__file__).parent / "fixtures" / "template-spec-v1"
CERTIFICATION_FIXTURES = Path(__file__).parent / "fixtures" / "certification-v1"
DOCUMENT_SPEC_V1_SCHEMA_SHA256 = (
    "1607cb19c9068306da8c76ba6ebee4ae8e5c6d650490fc0737dadd1a08b9ed1b"
)
DOCUMENT_SPEC_V2_SCHEMA_SHA256 = (
    "d14b6f7bc8a3753a8a2c0e39431ac20ae86be38ceffdf649c804dec3905be746"
)
DOCUMENT_REPORT_V2_SCHEMA_SHA256 = (
    "0474ac0a6c3c5cfff4d33bd11259b26169a676a078be5952ab83e2839f54090b"
)
TEMPLATE_SPEC_V1_SCHEMA_SHA256 = (
    "590b9ac7dd2b30d1f8fafc4e087adf3117a831f9e38de39267a102141c549039"
)
TEMPLATE_DATA_V1_SCHEMA_SHA256 = (
    "484bc86d01dcba17122507fad250791f88235be4dd933c12c721ef7b46eea298"
)
TEMPLATE_REPORT_V1_SCHEMA_SHA256 = (
    "aa2f011e02a52b29d07a458f84875e512cf1b1c80e6f2edea40ce756d436f705"
)

sys.path.insert(0, str(SCRIPTS))
import hwpx_cli  # noqa: E402
import hwpx_xml  # noqa: E402
import styled  # noqa: E402
import certification_contract as certification  # noqa: E402

HAVE_CLI = hwpx_cli._find_hwp_cli() is not None
requires_cli = pytest.mark.skipif(not HAVE_CLI, reason="hwp-cli('hwp') not installed")


def _run(*subargs: str) -> subprocess.CompletedProcess:
    """Invoke the dispatcher out-of-process so we observe the real exit code."""
    return subprocess.run(
        [sys.executable, str(SCRIPTS / "hwpx_cli.py"), *subargs],
        capture_output=True,
        text=True,
    )


def _validation_json(path: str | Path, *, valid: bool = True, warnings=None) -> str:
    return json.dumps(
        {
            "file": str(path),
            "format": "hwpx",
            "valid": valid,
            "errors": [] if valid else ["mock invalid HWPX"],
            "warnings": list(warnings or []),
        }
    )


def _native_validate(path: Path) -> dict:
    return hwpx_cli._validate_hwp_json(path, context="styled 참조 결과")


def test_fixture_exists():
    assert TEMPLATE.is_file(), f"missing test fixture: {TEMPLATE}"


def test_required_native_cli_version_and_capabilities():
    if os.environ.get("HWPX_REQUIRE_NATIVE") != "1":
        pytest.skip("native hard gate is enabled by make test-hwpx-skill")
    binary = hwpx_cli._find_hwp_cli()
    assert binary, "HWP_CLI 또는 compatible hwp-cli가 반드시 필요함"
    version = hwpx_cli._hwp_version(binary)
    assert version is not None
    expected = os.environ.get("HWPX_EXPECT_HWP_VERSION", "").strip()
    if expected:
        assert ".".join(map(str, version)) == expected
    for argv, token in [
        (["new", "--help"], "--preset"),
        (["validate", "--help"], "--json"),
        (["fill", "--help"], "--set"),
        (["slots", "--help"], "--json"),
    ]:
        result = hwpx_cli._run_external_bounded([binary, *argv], timeout=5)
        assert result.returncode == 0, result.stderr
        assert token in result.stdout + result.stderr
    if os.environ.get("HWPX_REQUIRE_COMPOSE") == "1":
        assert hwpx_cli._supports_compose(binary), (
            "HWP_CLI가 frozen native `hwp compose SPEC -o OUTPUT` contract를 "
            "제공해야 함"
        )
    if os.environ.get("HWPX_REQUIRE_TEMPLATE") == "1":
        assert hwpx_cli._supports_template(binary), (
            "HWP_CLI가 frozen native `hwp template TEMPLATE --data DATA "
            "-o OUTPUT` contract를 제공해야 함"
        )
    if os.environ.get("HWPX_REQUIRE_CERTIFY") == "1":
        assert hwpx_cli._supports_certify(binary), (
            "HWP_CLI가 frozen native `hwp certify --policy --report` contract를 "
            "제공해야 함"
        )
    if os.environ.get("HWPX_REQUIRE_CORPUS") == "1":
        assert hwpx_cli._supports_corpus(binary), (
            "HWP_CLI가 frozen native `hwp corpus --manifest --report` contract를 "
            "제공해야 함"
        )


# --- engine fallback: hwp-cli unavailable -> pure-lxml extraction ----------------

def test_read_text_falls_back_to_lxml(monkeypatch, capsys):
    monkeypatch.setattr(hwpx_cli, "_find_hwp_cli", lambda: None)
    # the streaming cli probe must signal "fall back" without writing.
    destination = io.StringIO()
    assert hwpx_cli._hwpx_text_via_cli(TEMPLATE, "plain", destination) is False
    assert destination.getvalue() == ""
    rc = hwpx_cli.cmd_read(
        argparse.Namespace(file=str(TEMPLATE), format="text", section=None, engine="auto")
    )
    assert rc == 0
    assert "수신" in capsys.readouterr().out  # lxml-extracted body text


def test_to_md_falls_back_to_lxml(monkeypatch, capsys):
    monkeypatch.setattr(hwpx_cli, "_find_hwp_cli", lambda: None)
    rc = hwpx_cli.cmd_to_md(
        argparse.Namespace(file=str(TEMPLATE), output=None, section=None, engine="auto")
    )
    assert rc == 0
    assert "수신" in capsys.readouterr().out


def _to_md_args(output: Path) -> argparse.Namespace:
    return argparse.Namespace(
        file=str(TEMPLATE),
        output=str(output),
        section=None,
        engine="auto",
        media_dir=None,
    )


def test_to_md_timeout_after_partial_stream_preserves_destination_and_cleans_stage(
    tmp_path, monkeypatch
):
    output = tmp_path / "existing.md"
    output.write_text("existing markdown", encoding="utf-8")
    monkeypatch.setattr(hwpx_cli, "_find_hwp_cli", lambda: "/mock/hwp")
    monkeypatch.setattr(
        hwpx_cli,
        "_run_hwp",
        lambda *_args, **_kwargs: subprocess.CompletedProcess([], 1, "", "convert failed"),
    )

    def timeout_after_partial(_path, _fmt, destination):
        destination.write("partial output")
        raise SystemExit(2)

    monkeypatch.setattr(hwpx_cli, "_hwpx_text_via_cli", timeout_after_partial)
    with pytest.raises(SystemExit) as error:
        hwpx_cli.cmd_to_md(_to_md_args(output))

    assert error.value.code == 2
    assert output.read_text(encoding="utf-8") == "existing markdown"
    assert not list(tmp_path.glob(f".{output.name}.to-md-*"))


def test_to_md_partial_nonzero_and_failed_fallback_preserve_destination(
    tmp_path, monkeypatch
):
    output = tmp_path / "existing.md"
    output.write_text("existing markdown", encoding="utf-8")
    monkeypatch.setattr(hwpx_cli, "_find_hwp_cli", lambda: "/mock/hwp")
    monkeypatch.setattr(
        hwpx_cli,
        "_run_hwp",
        lambda *_args, **_kwargs: subprocess.CompletedProcess([], 1, "", "convert failed"),
    )

    def failed_cat(_path, _fmt, destination):
        destination.write("partial output")
        return False

    monkeypatch.setattr(hwpx_cli, "_hwpx_text_via_cli", failed_cat)
    monkeypatch.setattr(
        hwpx_cli,
        "_extract_structure",
        lambda _path: (_ for _ in ()).throw(ValueError("fallback failed")),
    )
    with pytest.raises(ValueError, match="fallback failed"):
        hwpx_cli.cmd_to_md(_to_md_args(output))

    assert output.read_text(encoding="utf-8") == "existing markdown"
    assert not list(tmp_path.glob(f".{output.name}.to-md-*"))


def test_to_md_failed_stream_discards_partial_before_lxml_publish(
    tmp_path, monkeypatch
):
    output = tmp_path / "result.md"
    monkeypatch.setattr(hwpx_cli, "_find_hwp_cli", lambda: "/mock/hwp")
    monkeypatch.setattr(
        hwpx_cli,
        "_run_hwp",
        lambda *_args, **_kwargs: subprocess.CompletedProcess([], 1, "", "convert failed"),
    )

    def failed_cat(_path, _fmt, destination):
        destination.write("partial output must disappear")
        return False

    monkeypatch.setattr(hwpx_cli, "_hwpx_text_via_cli", failed_cat)
    assert hwpx_cli.cmd_to_md(_to_md_args(output)) == 0
    result = output.read_text(encoding="utf-8")
    assert "수신" in result
    assert "partial output must disappear" not in result
    assert not list(tmp_path.glob(f".{output.name}.to-md-*"))


# --- validate exit-code contract -------------------------------------------------

def test_validate_valid_returns_zero():
    assert _run("validate", str(TEMPLATE)).returncode == 0


def test_validate_corrupt_returns_nonzero(tmp_path):
    bad = tmp_path / "bad.hwpx"
    bad.write_bytes(b"not a zip file")
    assert _run("validate", str(bad)).returncode != 0


# --- slots / fill JSON-contract (delegated to hwp-cli) ---------------------------

@requires_cli
def test_slots_json_contract():
    proc = _run("slots", str(TEMPLATE), "--format", "json")
    assert proc.returncode == 0, proc.stderr
    payload = json.loads(proc.stdout)
    fields = payload["fields"]
    assert fields, "expected at least one {{slot}}"
    keys = {f["key"] for f in fields}
    assert "제목" in keys
    assert all(f["occurrences"] >= 1 for f in fields)


@requires_cli
def test_fill_replaces_slots_and_validates(tmp_path):
    out = tmp_path / "filled.hwpx"
    proc = _run(
        "fill", str(TEMPLATE),
        "--kv", "기관명=테스트대학", "--kv", "제목=시험",
        "-o", str(out),
    )
    assert proc.returncode == 0, proc.stderr
    assert out.is_file()
    assert "치환" in proc.stderr  # delegation summary parsed from hwp-cli --json
    assert _run("validate", str(out)).returncode == 0


# --- styled --reference: lxml slot-fill path -------------------------------------

def test_styled_reference_produces_valid_hwpx(tmp_path):
    md = tmp_path / "body.md"
    md.write_text("# 제목\n\n본문 한 줄\n", encoding="utf-8")
    out = tmp_path / "styled.hwpx"
    proc = _run("styled", "--reference", str(TEMPLATE), "--markdown", str(md), "-o", str(out))
    assert proc.returncode == 0, proc.stderr
    assert out.is_file()
    assert _run("validate", str(out)).returncode == 0


def _reference_without_supported_slots(tmp_path: Path) -> Path:
    reference = tmp_path / "no-supported-slots.hwpx"
    slots = hwpx_xml.scan_slots(TEMPLATE)
    replacements = {f"{{{{{key}}}}}": "이미 채운 값" for key in slots}
    counts = hwpx_xml.edit_text(TEMPLATE, reference, replacements)
    assert sum(counts.values()) == sum(slots.values())
    assert hwpx_xml.scan_slots(reference) == {}
    styled.validate_hwpx_package(reference)
    return reference


def test_styled_reference_zero_slot_leaves_no_output_or_temp(tmp_path):
    reference = _reference_without_supported_slots(tmp_path)
    out = tmp_path / "must-not-exist.hwpx"

    with pytest.raises(RuntimeError, match="일치하는 슬롯이 없음"):
        styled.follow_template(
            [styled.title("제목"), styled.para("본문")],
            reference=reference,
            output=out,
            native_validate=_native_validate,
        )

    assert not out.exists()
    assert not list(tmp_path.glob(f".{out.name}.*"))


def test_styled_reference_failure_preserves_existing_destination(tmp_path):
    reference = _reference_without_supported_slots(tmp_path)
    out = tmp_path / "existing.hwpx"
    original = b"existing destination must survive"
    out.write_bytes(original)

    with pytest.raises(RuntimeError, match="일치하는 슬롯이 없음"):
        styled.follow_template(
            [styled.title("제목"), styled.para("본문")],
            reference=reference,
            output=out,
            native_validate=_native_validate,
        )

    assert out.read_bytes() == original
    assert not list(tmp_path.glob(f".{out.name}.*"))


def test_styled_reference_validation_failure_preserves_destination_and_cleans_temp(
    tmp_path, monkeypatch
):
    out = tmp_path / "existing.hwpx"
    original = b"existing destination must survive validation failure"
    out.write_bytes(original)
    real_validate = styled.validate_hwpx_package

    def fail_generated_output(path):
        if Path(path) == TEMPLATE:
            real_validate(path)
            return
        raise ValueError("mock generated-package validation failure")

    monkeypatch.setattr(styled, "validate_hwpx_package", fail_generated_output)

    with pytest.raises(ValueError, match="mock generated-package validation failure"):
        styled.follow_template(
            [styled.title("제목"), styled.para("본문")],
            reference=TEMPLATE,
            output=out,
            native_validate=_native_validate,
        )

    assert out.read_bytes() == original
    assert not list(tmp_path.glob(f".{out.name}.*"))


def test_styled_reference_success_atomically_replaces_destination(
    tmp_path, monkeypatch
):
    out = tmp_path / "existing.hwpx"
    out.write_bytes(b"old destination")
    calls: list[tuple[Path, Path]] = []
    real_replace = styled.os.replace

    def observed_replace(source, destination):
        source_path = Path(source)
        destination_path = Path(destination)
        if destination_path == out:
            assert source_path.parent.parent == destination_path.parent == tmp_path
            assert stat.S_IMODE(source_path.parent.stat().st_mode) == 0o700
            styled.validate_hwpx_package(source_path)
            calls.append((source_path, destination_path))
        real_replace(source, destination)

    monkeypatch.setattr(styled.os, "replace", observed_replace)
    result = styled.follow_template(
        [styled.title("교체 제목"), styled.para("교체 본문")],
        reference=TEMPLATE,
        output=out,
        native_validate=_native_validate,
    )

    assert result == out
    assert len(calls) == 1
    assert calls[0][1] == out
    styled.validate_hwpx_package(out)
    assert not list(tmp_path.glob(f".{out.name}.*"))


def test_styled_reference_replace_failure_preserves_destination_and_cleans_staging(
    tmp_path, monkeypatch
):
    out = tmp_path / "existing.hwpx"
    original = b"existing destination survives replace failure"
    out.write_bytes(original)

    def fail_replace(_source, _destination):
        raise OSError("mock replace failure")

    monkeypatch.setattr(styled.os, "replace", fail_replace)
    with pytest.raises(OSError, match="mock replace failure"):
        styled.follow_template(
            [styled.title("제목"), styled.para("본문")],
            reference=TEMPLATE,
            output=out,
            native_validate=_native_validate,
        )

    assert out.read_bytes() == original
    assert not list(tmp_path.glob(f".{out.name}.staging-*"))


def test_styled_reference_preserves_existing_destination_mode(tmp_path):
    out = tmp_path / "existing.hwpx"
    out.write_bytes(b"old")
    out.chmod(0o640)

    styled.follow_template(
        [styled.title("제목"), styled.para("본문")],
        reference=TEMPLATE,
        output=out,
        native_validate=_native_validate,
    )

    assert stat.S_IMODE(out.stat().st_mode) == 0o640


def test_styled_reference_new_destination_uses_process_umask(tmp_path):
    out = tmp_path / "new.hwpx"
    previous_umask = os.umask(0o027)
    try:
        styled.follow_template(
            [styled.title("제목"), styled.para("본문")],
            reference=TEMPLATE,
            output=out,
            native_validate=_native_validate,
        )
    finally:
        os.umask(previous_umask)

    assert stat.S_IMODE(out.stat().st_mode) == 0o640


@pytest.mark.parametrize("name", ["result.hwp", "result.zip", "result"])
def test_styled_reference_rejects_non_hwpx_output_before_staging(tmp_path, name):
    md = tmp_path / "body.md"
    md.write_text("# 제목\n\n본문\n", encoding="utf-8")
    out = tmp_path / name
    out.write_bytes(b"destination must survive")

    proc = _run(
        "styled",
        "--reference",
        str(TEMPLATE),
        "--markdown",
        str(md),
        "-o",
        str(out),
    )

    assert proc.returncode == 2
    assert "출력 형식은 .hwpx" in proc.stderr
    assert out.read_bytes() == b"destination must survive"
    assert not list(tmp_path.glob(f".{out.name}.*"))


def test_styled_reference_accepts_case_insensitive_hwpx_suffix(tmp_path):
    md = tmp_path / "body.md"
    md.write_text("# 제목\n\n본문\n", encoding="utf-8")
    out = tmp_path / "result.HWPX"

    proc = _run(
        "styled",
        "--reference",
        str(TEMPLATE),
        "--markdown",
        str(md),
        "-o",
        str(out),
    )

    assert proc.returncode == 0, proc.stderr
    assert out.is_file()
    assert _run("validate", str(out)).returncode == 0
    assert not list(tmp_path.glob(f".{out.name}.*"))


def test_styled_rejects_binary_hwp_reference_output_alias(tmp_path):
    reference = tmp_path / "reference.hwp"
    original = b"binary source must survive"
    reference.write_bytes(original)
    md = tmp_path / "body.md"
    md.write_text("# 제목\n\n본문\n", encoding="utf-8")

    proc = _run(
        "styled",
        "--reference",
        str(reference),
        "--markdown",
        str(md),
        "-o",
        str(reference),
    )

    assert proc.returncode == 2
    assert "binary .hwp 참조 파일을 출력 별칭" in proc.stderr
    assert reference.read_bytes() == original
    assert not list(tmp_path.glob(f".{reference.name}.*"))


def test_styled_rejects_hwpx_reference_output_path_alias(tmp_path):
    reference = tmp_path / "reference.hwpx"
    shutil.copyfile(TEMPLATE, reference)
    original = reference.read_bytes()
    md = tmp_path / "body.md"
    md.write_text("# 제목\n\n본문\n", encoding="utf-8")

    proc = _run(
        "styled",
        "--reference",
        str(reference),
        "--markdown",
        str(md),
        "-o",
        str(tmp_path / "." / "reference.hwpx"),
    )

    assert proc.returncode == 2
    assert "같은 경로 별칭" in proc.stderr
    assert reference.read_bytes() == original
    assert not list(tmp_path.glob(f".{reference.name}.*"))


def test_styled_rejects_reference_hard_link_and_symlink_destinations(tmp_path):
    md = tmp_path / "body.md"
    md.write_text("# 제목\n\n본문\n", encoding="utf-8")
    hard_link = tmp_path / "hard-link.hwpx"
    os.link(TEMPLATE, hard_link)
    symlink = tmp_path / "symlink.hwpx"
    symlink.symlink_to(TEMPLATE)

    hard_proc = _run(
        "styled",
        "--reference",
        str(TEMPLATE),
        "--markdown",
        str(md),
        "-o",
        str(hard_link),
    )
    link_proc = _run(
        "styled",
        "--reference",
        str(TEMPLATE),
        "--markdown",
        str(md),
        "-o",
        str(symlink),
    )

    assert hard_proc.returncode == 2
    assert "같은 파일" in hard_proc.stderr
    assert link_proc.returncode == 2
    assert "심볼릭 링크" in link_proc.stderr
    assert os.path.samefile(TEMPLATE, hard_link)
    assert symlink.is_symlink()
    assert not list(tmp_path.glob(f".{hard_link.name}.*"))
    assert not list(tmp_path.glob(f".{symlink.name}.*"))


@pytest.mark.parametrize("with_reference", [False, True])
@pytest.mark.parametrize(
    ("flag", "value"),
    [
        ("--header", "예시대학교"),
        ("--footer", "- # / ## -"),
        ("--footer", "none"),
        ("--footer", ""),
    ],
)
def test_styled_header_footer_fail_before_write(
    tmp_path, with_reference, flag, value
):
    md = tmp_path / "body.md"
    md.write_text("# 제목\n\n본문 한 줄\n", encoding="utf-8")
    out = tmp_path / "must-not-exist.hwpx"
    args = ["styled", "--markdown", str(md), flag, value, "-o", str(out)]
    if with_reference:
        args[1:1] = ["--reference", str(TEMPLATE)]

    proc = _run(*args)

    assert proc.returncode == 2
    assert "현재 지원하지 않음" in proc.stderr
    assert "출력 전에 중단" in proc.stderr
    assert not out.exists()


def test_follow_template_rejects_header_footer_without_body_fallback(tmp_path):
    out = tmp_path / "must-not-exist.hwpx"

    with pytest.raises(ValueError, match="본문 삽입 fallback을 사용하지 않음"):
        styled.follow_template(
            [styled.para("본문")],
            reference=TEMPLATE,
            output=out,
            header="예시대학교",
            native_validate=_native_validate,
        )

    assert not out.exists()


# --- styled preset delegation ----------------------------------------------------

@pytest.mark.parametrize(
    ("public_name", "canonical_name"),
    [
        ("gongmun", "gian"),
        ("gian", "gian"),
        ("bogoseo", "report"),
        ("report", "report"),
    ],
)
def test_styled_preset_aliases_delegate_to_hwp_new(
    tmp_path, monkeypatch, public_name, canonical_name
):
    calls = []

    def fake_run(argv, *, require_new_preset=False):
        calls.append((argv, require_new_preset))
        return subprocess.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(hwpx_cli, "_run_hwp", fake_run)
    assert (
        hwpx_cli._new_from_markdown(
            "# 제목", tmp_path / "out.hwpx", public_name, plain=True
        )
        == 0
    )
    argv, require_new_preset = calls.pop()
    assert argv[0:2] == ["new", "--from"]
    assert argv[-2:] == ["--preset", canonical_name]
    assert require_new_preset is True


@pytest.mark.parametrize(
    "source_kind",
    ["markdown", "stdin_markdown", "json", "stdin_json"],
)
def test_styled_all_non_reference_sources_forward_preset(
    tmp_path, monkeypatch, source_kind
):
    calls = []

    def fake_run(argv, *, require_new_preset=False):
        calls.append((argv, require_new_preset))
        if argv[0] == "new":
            shutil.copyfile(TEMPLATE, Path(argv[argv.index("-o") + 1]))
            return subprocess.CompletedProcess(argv, 0, "", "")
        if argv[0] == "validate":
            return subprocess.CompletedProcess(
                argv, 0, _validation_json(argv[1]), ""
            )
        return subprocess.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(hwpx_cli, "_run_hwp", fake_run)
    md_path = tmp_path / "input.md"
    md_path.write_text("# 제목\n\n본문\n", encoding="utf-8")
    json_path = tmp_path / "input.json"
    json_path.write_text('{"title":"제목","paragraphs":["본문"]}', encoding="utf-8")
    stdin_payload = (
        '{"title":"제목","paragraphs":["본문"]}'
        if source_kind == "stdin_json"
        else "# 제목\n\n본문\n"
    )
    monkeypatch.setattr(sys, "stdin", io.StringIO(stdin_payload))
    args = argparse.Namespace(
        output=str(tmp_path / f"{source_kind}.hwpx"),
        preset="bogoseo",
        reference=None,
        markdown=str(md_path) if source_kind == "markdown" else None,
        json=str(json_path) if source_kind == "json" else None,
        stdin_markdown=source_kind == "stdin_markdown",
        stdin_json=source_kind == "stdin_json",
        header=None,
        footer=None,
        plain=True,
    )

    assert hwpx_cli.cmd_styled(args) == 0
    new_calls = [call for call in calls if call[0][0] == "new"]
    validate_calls = [call for call in calls if call[0][0] == "validate"]
    assert len(new_calls) == len(validate_calls) == 1
    argv, require_new_preset = new_calls[0]
    assert argv[0:2] == ["new", "--from"]
    assert argv[-2:] == ["--preset", "report"]
    assert require_new_preset is True
    assert validate_calls[0][0][0] == "validate"
    assert validate_calls[0][0][-1] == "--json"


def test_styled_reference_does_not_delegate_preset(tmp_path, monkeypatch):
    md = tmp_path / "body.md"
    md.write_text("# 제목\n\n본문 한 줄\n", encoding="utf-8")

    def reject_new(*_args, **_kwargs):
        raise AssertionError("reference path must not call hwp new")

    monkeypatch.setattr(hwpx_cli, "_new_from_markdown", reject_new)
    args = argparse.Namespace(
        output=str(tmp_path / "reference.hwpx"),
        preset="report",
        reference=str(TEMPLATE),
        markdown=str(md),
        json=None,
        stdin_markdown=False,
        stdin_json=False,
        header=None,
        footer=None,
        plain=False,
    )
    assert hwpx_cli.cmd_styled(args) == 0


def _styled_hwp_args(reference: Path, output: Path, markdown: Path) -> argparse.Namespace:
    return argparse.Namespace(
        output=str(output),
        preset="report",
        reference=str(reference),
        markdown=str(markdown),
        json=None,
        stdin_markdown=False,
        stdin_json=False,
        header=None,
        footer=None,
        plain=False,
    )


def test_styled_hwp_reference_failed_conversion_preserves_destination(
    tmp_path, monkeypatch, capsys
):
    reference = tmp_path / "reference.hwp"
    reference.write_bytes(b"not relevant: converter is mocked")
    markdown = tmp_path / "body.md"
    markdown.write_text("# 제목\n\n본문\n", encoding="utf-8")
    out = tmp_path / "existing.hwpx"
    original = b"existing destination must survive conversion failure"
    out.write_bytes(original)
    calls = []

    def fake_run(argv, *, require_new_preset=False):
        calls.append((argv, require_new_preset))
        return subprocess.CompletedProcess(argv, 2, "", "mock conversion failure")

    monkeypatch.setattr(hwpx_cli, "_run_hwp", fake_run)

    with pytest.raises(SystemExit) as exc_info:
        hwpx_cli.cmd_styled(_styled_hwp_args(reference, out, markdown))

    stderr = capsys.readouterr().err
    assert exc_info.value.code == 2
    assert calls[0][0][0:4] == ["convert", str(reference), "--to", "hwpx"]
    assert "HWP 참조 양식 변환 실패" in stderr
    assert "mock conversion failure" in stderr
    assert out.read_bytes() == original
    assert not list(tmp_path.glob(f".{out.name}.reference-*"))


def test_styled_hwp_reference_converts_validates_and_composes(
    tmp_path, monkeypatch, capsys
):
    reference = tmp_path / "reference.hwp"
    reference.write_bytes(b"not relevant: converter is mocked")
    markdown = tmp_path / "body.md"
    markdown.write_text("# 변환 제목\n\n변환 본문\n", encoding="utf-8")
    out = tmp_path / "result.hwpx"
    calls = []

    def fake_run(argv, *, require_new_preset=False):
        calls.append((argv, require_new_preset))
        if argv[0] == "convert":
            converted = Path(argv[argv.index("-o") + 1])
            assert not converted.exists()
            shutil.copyfile(TEMPLATE, converted)
            return subprocess.CompletedProcess(
                argv, 0, "", "경고: mock conversion warning"
            )
        if argv[0] == "validate":
            return subprocess.CompletedProcess(
                argv,
                0,
                _validation_json(argv[1], warnings=["mock validator warning"]),
                "",
            )
        raise AssertionError(argv)

    monkeypatch.setattr(hwpx_cli, "_run_hwp", fake_run)

    assert hwpx_cli.cmd_styled(_styled_hwp_args(reference, out, markdown)) == 0

    assert len(calls) == 3
    argv, require_new_preset = calls[0]
    assert argv[0:4] == ["convert", str(reference), "--to", "hwpx"]
    assert Path(argv[argv.index("-o") + 1]).suffix == ".hwpx"
    assert argv[-2:] == ["--strict", "--preserve-layout"]
    assert require_new_preset is False
    assert calls[1][0][0] == "validate"
    assert calls[1][0][-1] == "--json"
    assert calls[2][0][0] == "validate"
    assert calls[2][0][-1] == "--json"
    stderr = capsys.readouterr().err
    assert "mock conversion warning" in stderr
    assert "mock validator warning" in stderr
    styled.validate_hwpx_package(out)
    assert not list(tmp_path.glob(f".{out.name}.reference-*"))


def test_styled_hwp_reference_strict_loss_failure_preserves_destination(
    tmp_path, monkeypatch, capsys
):
    reference = tmp_path / "reference.hwp"
    reference.write_bytes(b"mock hwp")
    markdown = tmp_path / "body.md"
    markdown.write_text("# 제목\n\n본문\n", encoding="utf-8")
    out = tmp_path / "existing.hwpx"
    original = b"existing destination"
    out.write_bytes(original)

    def fake_run(argv, *, require_new_preset=False):
        assert argv[-2:] == ["--strict", "--preserve-layout"]
        return subprocess.CompletedProcess(
            argv,
            1,
            "",
            "--strict: 보존 불가 데이터 1건 드롭\n  - DROP: mock object",
        )

    monkeypatch.setattr(hwpx_cli, "_run_hwp", fake_run)
    with pytest.raises(SystemExit) as exc_info:
        hwpx_cli.cmd_styled(_styled_hwp_args(reference, out, markdown))

    assert exc_info.value.code == 2
    assert "--strict" in capsys.readouterr().err
    assert out.read_bytes() == original
    assert not list(tmp_path.glob(f".{out.name}.reference-*"))


def test_styled_hwp_reference_validator_failure_preserves_destination(
    tmp_path, monkeypatch, capsys
):
    reference = tmp_path / "reference.hwp"
    reference.write_bytes(b"mock hwp")
    markdown = tmp_path / "body.md"
    markdown.write_text("# 제목\n\n본문\n", encoding="utf-8")
    out = tmp_path / "existing.hwpx"
    original = b"existing destination"
    out.write_bytes(original)

    def fake_run(argv, *, require_new_preset=False):
        if argv[0] == "convert":
            shutil.copyfile(TEMPLATE, Path(argv[argv.index("-o") + 1]))
            return subprocess.CompletedProcess(argv, 0, "", "")
        return subprocess.CompletedProcess(
            argv, 1, _validation_json(argv[1], valid=False), ""
        )

    monkeypatch.setattr(hwpx_cli, "_run_hwp", fake_run)
    with pytest.raises(SystemExit) as exc_info:
        hwpx_cli.cmd_styled(_styled_hwp_args(reference, out, markdown))

    assert exc_info.value.code == 2
    assert "mock invalid HWPX" in capsys.readouterr().err
    assert out.read_bytes() == original
    assert not list(tmp_path.glob(f".{out.name}.reference-*"))


def test_styled_final_reference_native_validator_failure_preserves_destination(
    tmp_path, monkeypatch, capsys
):
    markdown = tmp_path / "body.md"
    markdown.write_text("# 제목\n\n본문\n", encoding="utf-8")
    out = tmp_path / "existing.hwpx"
    original = b"existing destination"
    out.write_bytes(original)
    calls = []

    def reject_final(argv, *, require_new_preset=False):
        calls.append((argv, require_new_preset))
        assert argv[0] == "validate"
        return subprocess.CompletedProcess(
            argv, 1, _validation_json(argv[1], valid=False), ""
        )

    monkeypatch.setattr(hwpx_cli, "_run_hwp", reject_final)

    with pytest.raises(SystemExit) as exc_info:
        hwpx_cli.cmd_styled(_styled_hwp_args(TEMPLATE, out, markdown))

    assert exc_info.value.code == 2
    assert len(calls) == 1
    assert "styled 참조 결과 hwp validate 실패" in capsys.readouterr().err
    assert out.read_bytes() == original
    assert not list(tmp_path.glob(f".{out.name}.staging-*"))


def _atomic_new_runner(calls):
    def fake_run(argv, *, require_new_preset=False):
        calls.append((argv, require_new_preset))
        if argv[0] == "new":
            staged = Path(argv[argv.index("-o") + 1])
            assert not staged.exists()
            shutil.copyfile(TEMPLATE, staged)
            return subprocess.CompletedProcess(argv, 0, "", "")
        if argv[0] == "validate":
            return subprocess.CompletedProcess(
                argv, 0, _validation_json(argv[1]), ""
            )
        raise AssertionError(argv)

    return fake_run


def test_styled_non_reference_atomic_success_and_real_validator_argv(
    tmp_path, monkeypatch
):
    out = tmp_path / "result.hwpx"
    calls = []
    replace_calls = []
    real_replace = hwpx_cli.os.replace

    def observed_replace(source, destination):
        source_path = Path(source)
        destination_path = Path(destination)
        assert source_path.parent.parent == destination_path.parent == tmp_path
        assert stat.S_IMODE(source_path.parent.stat().st_mode) == 0o700
        replace_calls.append((source_path, destination_path))
        real_replace(source, destination)

    monkeypatch.setattr(hwpx_cli, "_run_hwp", _atomic_new_runner(calls))
    monkeypatch.setattr(hwpx_cli.os, "replace", observed_replace)

    assert (
        hwpx_cli._styled_new_from_markdown_atomic(
            "# 제목\n\n본문\n", out, "report", plain=True
        )
        == 0
    )

    assert out.is_file()
    assert len(replace_calls) == 1
    assert calls[0][0][0:2] == ["new", "--from"]
    assert calls[1][0] == ["validate", str(calls[0][0][4]), "--json"]
    assert not list(tmp_path.glob(f".{out.name}.staging-*"))


def test_styled_non_reference_validation_failure_preserves_destination(
    tmp_path, monkeypatch
):
    out = tmp_path / "existing.hwpx"
    original = b"existing destination"
    out.write_bytes(original)

    def fake_run(argv, *, require_new_preset=False):
        if argv[0] == "new":
            shutil.copyfile(TEMPLATE, Path(argv[argv.index("-o") + 1]))
            return subprocess.CompletedProcess(argv, 0, "", "")
        return subprocess.CompletedProcess(
            argv, 1, _validation_json(argv[1], valid=False), ""
        )

    monkeypatch.setattr(hwpx_cli, "_run_hwp", fake_run)
    with pytest.raises(RuntimeError, match="mock invalid HWPX"):
        hwpx_cli._styled_new_from_markdown_atomic(
            "# 제목\n\n본문\n", out, plain=True
        )

    assert out.read_bytes() == original
    assert not list(tmp_path.glob(f".{out.name}.staging-*"))


def test_styled_non_reference_style_failure_preserves_destination(
    tmp_path, monkeypatch
):
    import style_pass

    out = tmp_path / "existing.hwpx"
    original = b"existing destination"
    out.write_bytes(original)
    calls = []

    def fail_style(_path):
        raise ValueError("mock style failure")

    monkeypatch.setattr(hwpx_cli, "_run_hwp", _atomic_new_runner(calls))
    monkeypatch.setattr(style_pass, "apply_default_style", fail_style)
    with pytest.raises(ValueError, match="mock style failure"):
        hwpx_cli._styled_new_from_markdown_atomic(
            "# 제목\n\n본문\n", out, plain=False
        )

    assert out.read_bytes() == original
    assert not list(tmp_path.glob(f".{out.name}.staging-*"))
    assert not any(call[0][0] == "validate" for call in calls)


def test_styled_non_reference_replace_failure_preserves_destination(
    tmp_path, monkeypatch
):
    out = tmp_path / "existing.hwpx"
    original = b"existing destination"
    out.write_bytes(original)
    calls = []

    def fail_replace(_source, _destination):
        raise OSError("mock replace failure")

    monkeypatch.setattr(hwpx_cli, "_run_hwp", _atomic_new_runner(calls))
    monkeypatch.setattr(hwpx_cli.os, "replace", fail_replace)
    with pytest.raises(OSError, match="mock replace failure"):
        hwpx_cli._styled_new_from_markdown_atomic(
            "# 제목\n\n본문\n", out, plain=True
        )

    assert out.read_bytes() == original
    assert not list(tmp_path.glob(f".{out.name}.staging-*"))


def test_styled_non_reference_preserves_existing_destination_mode(
    tmp_path, monkeypatch
):
    out = tmp_path / "existing.hwpx"
    out.write_bytes(b"old")
    out.chmod(0o640)
    calls = []
    monkeypatch.setattr(hwpx_cli, "_run_hwp", _atomic_new_runner(calls))

    hwpx_cli._styled_new_from_markdown_atomic(
        "# 제목\n\n본문\n", out, plain=True
    )

    assert stat.S_IMODE(out.stat().st_mode) == 0o640


def test_styled_non_reference_new_destination_uses_process_umask(
    tmp_path, monkeypatch
):
    out = tmp_path / "new.hwpx"
    calls = []
    monkeypatch.setattr(hwpx_cli, "_run_hwp", _atomic_new_runner(calls))
    previous_umask = os.umask(0o027)
    try:
        hwpx_cli._styled_new_from_markdown_atomic(
            "# 제목\n\n본문\n", out, plain=True
        )
    finally:
        os.umask(previous_umask)

    assert stat.S_IMODE(out.stat().st_mode) == 0o640


def test_styled_non_reference_rejects_unrelated_hardlinked_destination(
    tmp_path, monkeypatch
):
    original = tmp_path / "original.bin"
    original.write_bytes(b"shared destination")
    out = tmp_path / "result.hwpx"
    os.link(original, out)
    calls = []
    monkeypatch.setattr(hwpx_cli, "_run_hwp", _atomic_new_runner(calls))

    with pytest.raises(ValueError, match="하드링크 수가 1보다 큼"):
        hwpx_cli._styled_new_from_markdown_atomic(
            "# 제목\n\n본문\n",
            out,
            plain=True,
        )

    assert calls == []
    assert original.read_bytes() == out.read_bytes() == b"shared destination"


def test_styled_reference_rejects_unrelated_hardlinked_destination(tmp_path):
    original = tmp_path / "original.bin"
    original.write_bytes(b"shared destination")
    out = tmp_path / "result.hwpx"
    os.link(original, out)

    with pytest.raises(ValueError, match="하드링크 수가 1보다 큼"):
        styled.follow_template(
            [styled.title("제목"), styled.para("본문")],
            reference=TEMPLATE,
            output=out,
            native_validate=lambda _path: {},
        )

    assert original.read_bytes() == out.read_bytes() == b"shared destination"


@pytest.mark.parametrize("with_reference", [False, True])
@pytest.mark.parametrize("race", ["create", "replace", "hardlink"])
def test_styled_publish_rechecks_destination_identity_before_replace(
    tmp_path, monkeypatch, with_reference, race
):
    out = tmp_path / "result.hwpx"
    if race != "create":
        out.write_bytes(b"original destination")
    alias = tmp_path / "destination-alias.bin"
    real_fsync = styled._fsync_file
    mutation_done = False

    def race_after_staged_fsync(path):
        nonlocal mutation_done
        real_fsync(path)
        if mutation_done:
            return
        mutation_done = True
        if race == "create":
            out.write_bytes(b"racing creator")
        elif race == "replace":
            attacker = tmp_path / "attacker.bin"
            attacker.write_bytes(b"racing replacement")
            os.replace(attacker, out)
        else:
            os.link(out, alias)

    monkeypatch.setattr(styled, "_fsync_file", race_after_staged_fsync)
    if with_reference:
        action = lambda: styled.follow_template(
            [styled.title("제목"), styled.para("본문")],
            reference=TEMPLATE,
            output=out,
            native_validate=lambda _path: {},
        )
    else:
        calls = []
        monkeypatch.setattr(hwpx_cli, "_run_hwp", _atomic_new_runner(calls))
        action = lambda: hwpx_cli._styled_new_from_markdown_atomic(
            "# 제목\n\n본문\n",
            out,
            plain=True,
        )

    with pytest.raises(RuntimeError, match="게시 직전|생성 시작 후 변경"):
        action()

    expected = {
        "create": b"racing creator",
        "replace": b"racing replacement",
        "hardlink": b"original destination",
    }[race]
    assert out.read_bytes() == expected
    if race == "hardlink":
        assert alias.read_bytes() == expected
    assert not list(tmp_path.glob(f".{out.name}.staging-*"))


def test_post_publish_parent_fsync_failure_is_warning_not_false_failure(
    tmp_path, monkeypatch, capsys
):
    out = tmp_path / "result.hwpx"

    def fail_parent_sync(_path):
        raise OSError("mock directory fsync failure")

    monkeypatch.setattr(styled, "_fsync_parent", fail_parent_sync)
    monkeypatch.setattr(hwpx_cli, "_validate_hwp_json", lambda *_args, **_kwargs: {})
    result = styled.follow_template(
        [styled.title("제목"), styled.para("본문")],
        reference=TEMPLATE,
        output=out,
        native_validate=_native_validate,
    )

    assert result == out
    styled.validate_hwpx_package(out)
    stderr = capsys.readouterr().err
    assert "출력은 게시되었지만 부모 디렉터리 fsync 실패" in stderr
    assert "mock directory fsync failure" in stderr
    assert not list(tmp_path.glob(f".{out.name}.staging-*"))


def test_pre_publish_file_fsync_failure_preserves_destination(
    tmp_path, monkeypatch
):
    out = tmp_path / "existing.hwpx"
    original = b"existing destination"
    out.write_bytes(original)

    def fail_file_sync(_path):
        raise OSError("mock staged fsync failure")

    monkeypatch.setattr(styled, "_fsync_file", fail_file_sync)
    monkeypatch.setattr(hwpx_cli, "_validate_hwp_json", lambda *_args, **_kwargs: {})
    with pytest.raises(OSError, match="mock staged fsync failure"):
        styled.follow_template(
            [styled.title("제목"), styled.para("본문")],
            reference=TEMPLATE,
            output=out,
            native_validate=_native_validate,
        )

    assert out.read_bytes() == original
    assert not list(tmp_path.glob(f".{out.name}.staging-*"))


def _write_minimal_hwpx(path: Path, *, section: bytes = b"<x/>") -> None:
    with zipfile.ZipFile(path, "w") as zf:
        mimetype = zipfile.ZipInfo("mimetype")
        mimetype.compress_type = zipfile.ZIP_STORED
        zf.writestr(mimetype, b"application/hwp+zip")
        zf.writestr("version.xml", b"<x/>")
        zf.writestr("META-INF/container.xml", b"<x/>")
        zf.writestr("Contents/content.hpf", b"<x/>")
        zf.writestr("Contents/header.xml", b"<x/>")
        zf.writestr("Contents/section0.xml", section)


def _corrupt_stored_entry_crc(path: Path, name: str) -> None:
    with zipfile.ZipFile(path) as archive:
        info = archive.getinfo(name)
        expected_crc = info.CRC
    raw = bytearray(path.read_bytes())
    cursor = 0
    encoded_name = name.encode()
    while True:
        cursor = raw.find(b"PK\x01\x02", cursor)
        assert cursor >= 0
        name_len, extra_len, comment_len = struct.unpack_from(
            "<HHH",
            raw,
            cursor + 28,
        )
        entry_name = bytes(raw[cursor + 46 : cursor + 46 + name_len])
        if entry_name == encoded_name:
            assert struct.unpack_from("<I", raw, cursor + 16)[0] == expected_crc
            struct.pack_into("<I", raw, cursor + 16, expected_crc ^ 0xFFFFFFFF)
            path.write_bytes(raw)
            return
        cursor += 46 + name_len + extra_len + comment_len


def test_python_package_limits_match_native_public_defaults():
    assert hwpx_xml.PACKAGE_LIMITS_PROFILE == "hwp-cli-native-v1"
    assert hwpx_xml.PACKAGE_LIMITS == hwpx_xml.PackageLimits(
        max_entries=4_096,
        reject_duplicate_names=True,
        max_entry_uncompressed_bytes=512 * 1024 * 1024,
        max_total_uncompressed_bytes=2 * 1024 * 1024 * 1024,
        max_xml_uncompressed_bytes=64 * 1024 * 1024,
        max_compression_ratio=1_000,
        max_entry_name_bytes=64 * 1024,
        max_total_name_bytes=16 * 1024 * 1024,
    )


@pytest.mark.parametrize(
    "name",
    [
        b"",
        b"../escape",
        b"/absolute",
        b"C:/windows",
        b"dir\\windows",
        b"dir//empty",
        b"dir/./current",
        b"nul\0name",
        b"invalid-\xff",
    ],
)
def test_python_entry_name_rules_match_native_rejections(name):
    with pytest.raises(ValueError):
        hwpx_xml._validate_entry_name(name)


@pytest.mark.parametrize(
    "name",
    [b"mimetype", "Contents/section0.xml", "BinData/", "한글/본문.xml"],
)
def test_python_entry_name_rules_match_native_acceptance(name):
    assert hwpx_xml._validate_entry_name(name)


def test_raw_preflight_rejects_entry_count_before_zipfile_allocation(
    tmp_path, monkeypatch
):
    candidate = tmp_path / "declared-count.hwpx"
    _write_minimal_hwpx(candidate)
    raw = bytearray(candidate.read_bytes())
    eocd = raw.rfind(b"PK\x05\x06")
    assert eocd >= 0
    struct.pack_into("<HH", raw, eocd + 8, 4_097, 4_097)
    candidate.write_bytes(raw)

    def forbid_zipfile(*_args, **_kwargs):
        raise AssertionError("ZipFile must not allocate before raw preflight")

    monkeypatch.setattr(zipfile.ZipFile, "__init__", forbid_zipfile)
    with pytest.raises(ValueError, match="ZIP 엔트리 수 제한 초과"):
        hwpx_xml.preflight_zip(candidate)


def test_raw_preflight_enforces_name_byte_budgets_before_zipfile_allocation(
    tmp_path, monkeypatch
):
    candidate = tmp_path / "names.hwpx"
    _write_minimal_hwpx(candidate)
    strict = hwpx_xml.PackageLimits(
        max_entry_name_bytes=4,
        max_total_name_bytes=8,
    )

    def forbid_zipfile(*_args, **_kwargs):
        raise AssertionError("ZipFile must not allocate before raw preflight")

    monkeypatch.setattr(zipfile.ZipFile, "__init__", forbid_zipfile)
    with pytest.raises(ValueError, match="이름 크기 제한 초과"):
        hwpx_xml.preflight_zip(candidate, strict)


def test_unpack_rejects_parent_traversal_and_keeps_output_contained(tmp_path):
    candidate = tmp_path / "traversal.hwpx"
    _write_minimal_hwpx(candidate)
    with zipfile.ZipFile(candidate, "a") as archive:
        archive.writestr("../escaped.bin", b"escape")
    output = tmp_path / "unpacked"

    with pytest.raises(ValueError, match="경로|상위"):
        hwpx_xml.extract_bounded_zip(candidate, output)

    assert not (tmp_path / "escaped.bin").exists()


def test_bounded_unpack_repack_round_trip_is_valid(tmp_path):
    unpacked = tmp_path / "unpacked"
    output = tmp_path / "roundtrip.hwpx"

    hwpx_xml.extract_bounded_zip(TEMPLATE, unpacked)
    hwpx_xml.pack_dir(unpacked, output)

    styled.validate_hwpx_package(output)
    with hwpx_xml.open_bounded_zip(output) as archive:
        assert archive.namelist()[0] == "mimetype"
        assert (
            hwpx_xml.read_bounded_entry(archive, "mimetype")
            == b"application/hwp+zip"
        )


def test_structural_validator_rejects_corrupted_bindata_crc(tmp_path):
    candidate = tmp_path / "bad-crc.hwpx"
    _write_minimal_hwpx(candidate)
    with zipfile.ZipFile(candidate, "a", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr("BinData/picture.bin", b"original picture bytes")
    _corrupt_stored_entry_crc(candidate, "BinData/picture.bin")

    with pytest.raises(ValueError, match="CRC|Bad CRC"):
        styled.validate_hwpx_package(candidate)


def test_generated_crc_failure_preserves_destination_before_native_validator(
    tmp_path, monkeypatch
):
    reference = tmp_path / "reference.hwpx"
    shutil.copyfile(TEMPLATE, reference)
    with zipfile.ZipFile(reference, "a", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr("BinData/picture.bin", b"original picture bytes")
    out = tmp_path / "existing.hwpx"
    original = b"existing destination"
    out.write_bytes(original)
    rewrite = styled._rewrite_template_slots
    native_calls = []

    def corrupt_generated(template, output, replacements):
        hits = rewrite(template, output, replacements)
        _corrupt_stored_entry_crc(output, "BinData/picture.bin")
        return hits

    monkeypatch.setattr(styled, "_rewrite_template_slots", corrupt_generated)
    with pytest.raises(ValueError, match="CRC|Bad CRC"):
        styled.follow_template(
            [styled.title("제목"), styled.para("본문")],
            reference=reference,
            output=out,
            native_validate=lambda path: native_calls.append(path),
        )

    assert native_calls == []
    assert out.read_bytes() == original
    assert not list(tmp_path.glob(f".{out.name}.staging-*"))


def test_structural_validator_rejects_oversized_xml_metadata(
    tmp_path, monkeypatch
):
    candidate = tmp_path / "oversized-entry.hwpx"
    _write_minimal_hwpx(candidate, section=b"<x>" + (b" " * 32) + b"</x>")
    monkeypatch.setattr(styled, "MAX_XML_ENTRY_BYTES", 16)
    monkeypatch.setattr(styled, "MAX_XML_TOTAL_BYTES", 1_024)

    with pytest.raises(ValueError, match="XML 엔트리 크기 제한 초과"):
        styled.validate_hwpx_package(candidate)


def test_structural_validator_rejects_oversized_xml_total(
    tmp_path, monkeypatch
):
    candidate = tmp_path / "oversized-total.hwpx"
    _write_minimal_hwpx(candidate)
    monkeypatch.setattr(styled, "MAX_XML_ENTRY_BYTES", 32)
    monkeypatch.setattr(styled, "MAX_XML_TOTAL_BYTES", 11)

    with pytest.raises(ValueError, match="XML 전체 크기 제한 초과"):
        styled.validate_hwpx_package(candidate)


def test_structural_validator_rejects_duplicate_names(tmp_path):
    candidate = tmp_path / "duplicate.hwpx"
    with pytest.warns(UserWarning, match="Duplicate name"):
        with zipfile.ZipFile(candidate, "w") as zf:
            mimetype = zipfile.ZipInfo("mimetype")
            mimetype.compress_type = zipfile.ZIP_STORED
            zf.writestr(mimetype, b"application/hwp+zip")
            zf.writestr("version.xml", b"<x/>")
            zf.writestr("META-INF/container.xml", b"<x/>")
            zf.writestr("Contents/header.xml", b"<x/>")
            zf.writestr("Contents/section0.xml", b"<x/>")
            zf.writestr("Contents/section0.xml", b"<y/>")

    with pytest.raises(ValueError, match="중복 ZIP 엔트리"):
        styled.validate_hwpx_package(candidate)


def _write_compressed_entry(
    archive: zipfile.ZipFile, name: str, size: int
) -> None:
    chunk = b"A" * (1024 * 1024)
    remaining = size
    with archive.open(name, "w", force_zip64=True) as stream:
        while remaining:
            part = chunk[: min(len(chunk), remaining)]
            stream.write(part)
            remaining -= len(part)


@pytest.mark.parametrize("expanded_mib", [32, 128])
def test_structural_validator_rejects_large_compressed_bindata_before_expansion(
    tmp_path, monkeypatch, expanded_mib
):
    candidate = tmp_path / f"bomb-{expanded_mib}.hwpx"
    _write_minimal_hwpx(candidate)
    with zipfile.ZipFile(
        candidate, "a", compression=zipfile.ZIP_DEFLATED, compresslevel=9
    ) as zf:
        _write_compressed_entry(
            zf, "BinData/compressed.bin", expanded_mib * 1024 * 1024
        )

    def forbid_expansion(*_args, **_kwargs):
        raise AssertionError("metadata gate must reject before opening an entry")

    monkeypatch.setattr(zipfile.ZipFile, "open", forbid_expansion)
    # Native defaults allow these sizes but reject the >1000:1 bomb ratio
    # during raw central-directory preflight, before ZipFile.open.
    with pytest.raises(ValueError, match="ZIP 압축률 제한 초과"):
        styled.validate_hwpx_package(candidate)


def test_structural_validator_rejects_aggregate_uncompressed_budget(
    tmp_path, monkeypatch
):
    candidate = tmp_path / "aggregate.hwpx"
    _write_minimal_hwpx(candidate)
    with zipfile.ZipFile(candidate, "a", compression=zipfile.ZIP_STORED) as zf:
        zf.writestr("BinData/a.bin", b"a" * 32)
        zf.writestr("BinData/b.bin", b"b" * 32)

    monkeypatch.setattr(styled, "MAX_ZIP_ENTRY_BYTES", 128)
    monkeypatch.setattr(styled, "MAX_ZIP_TOTAL_BYTES", 80)
    with pytest.raises(ValueError, match="ZIP 전체 크기 제한 초과"):
        styled.validate_hwpx_package(candidate)


def test_structural_validator_rejects_compression_ratio_before_expansion(
    tmp_path, monkeypatch
):
    candidate = tmp_path / "ratio.hwpx"
    _write_minimal_hwpx(candidate)
    with zipfile.ZipFile(
        candidate, "a", compression=zipfile.ZIP_DEFLATED, compresslevel=9
    ) as zf:
        _write_compressed_entry(zf, "BinData/ratio.bin", 1024 * 1024)

    monkeypatch.setattr(styled, "MAX_ZIP_ENTRY_BYTES", 2 * 1024 * 1024)
    monkeypatch.setattr(styled, "MAX_ZIP_TOTAL_BYTES", 4 * 1024 * 1024)
    monkeypatch.setattr(styled, "MAX_COMPRESSION_RATIO", 10)

    def forbid_expansion(*_args, **_kwargs):
        raise AssertionError("ratio gate must reject before opening an entry")

    monkeypatch.setattr(zipfile.ZipFile, "open", forbid_expansion)
    with pytest.raises(ValueError, match="ZIP 압축률 제한 초과"):
        styled.validate_hwpx_package(candidate)


def test_rewrite_entries_streams_unchanged_payloads_and_preserves_content(
    tmp_path, monkeypatch
):
    source = tmp_path / "source.hwpx"
    output = tmp_path / "output.hwpx"
    payload = bytes(range(256)) * 64
    _write_minimal_hwpx(source, section=b"<x>before</x>")
    with zipfile.ZipFile(source, "a", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("BinData/blob.bin", payload)

    def forbid_eager_read(*_args, **_kwargs):
        raise AssertionError("rewrite_entries must stream through ZipFile.open")

    monkeypatch.setattr(zipfile.ZipFile, "read", forbid_eager_read)
    hwpx_xml.rewrite_entries(
        source,
        output,
        {"Contents/section0.xml": b"<x>after</x>"},
    )

    with zipfile.ZipFile(output) as zf:
        with zf.open("BinData/blob.bin") as stream:
            assert stream.read() == payload
        with zf.open("Contents/section0.xml") as stream:
            assert stream.read() == b"<x>after</x>"
        assert zf.namelist()[0] == "mimetype"


def test_in_place_stream_rewrite_failure_preserves_source_and_cleans_temp(
    tmp_path, monkeypatch
):
    source = tmp_path / "source.hwpx"
    shutil.copyfile(TEMPLATE, source)
    original = source.read_bytes()

    def fail_rewrite(_src, _dst, _overrides):
        raise ValueError("mock stream failure")

    monkeypatch.setattr(hwpx_xml, "_write_rewritten_zip", fail_rewrite)
    with pytest.raises(ValueError, match="mock stream failure"):
        hwpx_xml.rewrite_entries(source, source, {})

    assert source.read_bytes() == original
    assert not list(tmp_path.glob(f".{source.name}.rewrite-*"))


def test_non_in_place_stream_rewrite_failure_preserves_destination_and_cleans_temp(
    tmp_path, monkeypatch
):
    source = tmp_path / "source.hwpx"
    output = tmp_path / "existing.hwpx"
    shutil.copyfile(TEMPLATE, source)
    output.write_bytes(b"existing destination")

    def fail_rewrite(_src, stage, _overrides):
        Path(stage).write_bytes(b"partial staged package")
        raise ValueError("mock stream failure")

    monkeypatch.setattr(hwpx_xml, "_write_rewritten_zip", fail_rewrite)
    with pytest.raises(ValueError, match="mock stream failure"):
        hwpx_xml.rewrite_entries(source, output, {})

    assert output.read_bytes() == b"existing destination"
    assert not list(tmp_path.glob(f".{output.name}.rewrite-*"))


def _forge_central_uncompressed_size(path: Path, name: str, size: int) -> None:
    raw = bytearray(path.read_bytes())
    encoded = name.encode()
    name_at = raw.rfind(encoded)
    assert name_at >= 46
    central_at = name_at - 46
    assert raw[central_at : central_at + 4] == b"PK\x01\x02"
    struct.pack_into("<I", raw, central_at + 24, size)
    path.write_bytes(raw)


def test_rewrite_rejects_forged_size_and_preserves_destination(tmp_path):
    source = tmp_path / "forged.hwpx"
    output = tmp_path / "existing.hwpx"
    _write_minimal_hwpx(source)
    with zipfile.ZipFile(source, "a", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr("BinData/later.bin", b"later payload")
    _forge_central_uncompressed_size(source, "BinData/later.bin", 1)
    output.write_bytes(b"existing destination")

    with pytest.raises((ValueError, zipfile.BadZipFile), match="크기|CRC|Bad CRC"):
        hwpx_xml.rewrite_entries(source, output, {})

    assert output.read_bytes() == b"existing destination"
    assert not list(tmp_path.glob(f".{output.name}.rewrite-*"))


def test_rewrite_rechecks_destination_identity_before_publish(tmp_path, monkeypatch):
    source = tmp_path / "source.hwpx"
    output = tmp_path / "existing.hwpx"
    shutil.copyfile(TEMPLATE, source)
    output.write_bytes(b"original destination")
    real_validate = styled.validate_hwpx_package

    def validate_then_replace_destination(path):
        real_validate(path)
        output.write_bytes(b"concurrent replacement")

    monkeypatch.setattr(styled, "validate_hwpx_package", validate_then_replace_destination)
    with pytest.raises(RuntimeError, match="변경됨"):
        hwpx_xml.rewrite_entries(source, output, {})

    assert output.read_bytes() == b"concurrent replacement"
    assert not list(tmp_path.glob(f".{output.name}.rewrite-*"))


def test_run_hwp_timeout_is_exit_two_and_diagnostic_is_bounded(
    monkeypatch, capsys
):
    monkeypatch.setattr(hwpx_cli, "_hwp_cli_or_die", lambda **_kwargs: "/mock/hwp")
    monkeypatch.setenv(hwpx_cli.HWP_CLI_TIMEOUT_ENV, "7")

    def timeout(*_args, **_kwargs):
        raise subprocess.TimeoutExpired(
            ["hwp", "validate"],
            7,
            output="o" * 80_000,
            stderr="e" * 80_000,
        )

    monkeypatch.setattr(hwpx_cli.subprocess, "run", timeout)
    with pytest.raises(SystemExit) as exc_info:
        hwpx_cli._run_hwp(["validate", "candidate.hwpx", "--json"])

    assert exc_info.value.code == 2
    stderr = capsys.readouterr().err
    assert "타임아웃 (7s)" in stderr
    assert hwpx_cli.HWP_CLI_TIMEOUT_ENV in stderr
    assert "출력 47232자 생략" in stderr
    assert len(stderr) < 35_000


def test_run_hwp_invalid_timeout_and_os_error_are_exit_two(
    monkeypatch, capsys
):
    monkeypatch.setattr(hwpx_cli, "_hwp_cli_or_die", lambda **_kwargs: "/mock/hwp")
    monkeypatch.setenv(hwpx_cli.HWP_CLI_TIMEOUT_ENV, "forever")
    with pytest.raises(SystemExit) as invalid:
        hwpx_cli._run_hwp(["validate", "candidate.hwpx"])
    assert invalid.value.code == 2
    assert "범위의 정수" in capsys.readouterr().err

    monkeypatch.setenv(hwpx_cli.HWP_CLI_TIMEOUT_ENV, "120")

    def fail_os(*_args, **_kwargs):
        raise OSError("mock spawn failure")

    monkeypatch.setattr(hwpx_cli.subprocess, "run", fail_os)
    with pytest.raises(SystemExit) as os_error:
        hwpx_cli._run_hwp(["validate", "candidate.hwpx"])
    assert os_error.value.code == 2
    assert "mock spawn failure" in capsys.readouterr().err


def test_run_hwp_preserves_success_stdout_but_bounds_diagnostics(monkeypatch):
    monkeypatch.setattr(hwpx_cli, "_hwp_cli_or_die", lambda **_kwargs: "/mock/hwp")
    monkeypatch.delenv(hwpx_cli.HWP_CLI_TIMEOUT_ENV, raising=False)

    def emit(_command, *, stdout, stderr, **_kwargs):
        stdout.write(b"o" * 40_000)
        stderr.write(b"e" * 40_000)
        return subprocess.CompletedProcess(_command, 0)

    monkeypatch.setattr(hwpx_cli.subprocess, "run", emit)
    proc = hwpx_cli._run_hwp(["cat", "candidate.hwpx"])

    assert len(proc.stdout) == 40_000
    assert len(proc.stderr) < 34_000
    assert "bytes 생략" in proc.stderr


def test_run_hwp_rejects_oversized_success_control_output(monkeypatch, capsys):
    monkeypatch.setattr(hwpx_cli, "_hwp_cli_or_die", lambda **_kwargs: "/mock/hwp")

    def emit(_command, *, stdout, **_kwargs):
        stdout.write(b"x" * (hwpx_cli.MAX_HWP_CONTROL_OUTPUT_BYTES + 1))
        return subprocess.CompletedProcess(_command, 0)

    monkeypatch.setattr(hwpx_cli.subprocess, "run", emit)
    with pytest.raises(SystemExit) as exc_info:
        hwpx_cli._run_hwp(["info", "candidate.hwpx", "--json"])

    assert exc_info.value.code == 2
    stderr = capsys.readouterr().err
    assert "제어 출력" in stderr
    assert "streaming" in stderr


def test_hwp_cat_success_is_streamed_through_configured_runner(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(hwpx_cli, "_find_hwp_cli", lambda: "/configured/hwp")
    seen = []

    def fake_stream(argv, *, stdout, **_kwargs):
        seen.append(argv)
        for _ in range(8):
            stdout.write(("가" * 100_000).encode())
        return subprocess.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(hwpx_cli, "_run_hwp_stream", fake_stream)

    class ChunkWriter:
        def __init__(self):
            self.total = 0
            self.max_chunk = 0

        def write(self, value):
            self.total += len(value)
            self.max_chunk = max(self.max_chunk, len(value))

    destination = ChunkWriter()
    assert hwpx_cli._hwpx_text_via_cli(
        tmp_path / "large.hwpx",
        "markdown",
        destination,
    )
    assert seen == [
        ["cat", str(tmp_path / "large.hwpx"), "--format", "markdown"]
    ]
    assert destination.total == 800_000
    assert destination.max_chunk <= 64 * 1024


def test_binary_hwp_delegate_uses_streaming_runner(
    tmp_path, monkeypatch, capsys
):
    source = tmp_path / "legacy.hwp"
    source.write_bytes(b"mock legacy hwp")
    monkeypatch.setattr(hwpx_cli, "_find_hwp_cli", lambda: "/configured/hwp")
    calls = []

    def fake_stream(argv, *, stdout, **_kwargs):
        calls.append(argv)
        stdout.write("위임 본문".encode())
        return subprocess.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(hwpx_cli, "_run_hwp_stream", fake_stream)
    assert hwpx_cli._delegate_hwp_read(source, "text") == 0
    captured = capsys.readouterr()
    assert captured.out == "위임 본문"
    assert calls == [["cat", str(source), "--format", "plain"]]
    assert "hwp-cli 위임" in captured.err


def test_create_and_write_java_keep_raw_hwp_new(tmp_path, monkeypatch):
    presets = []

    def fake_new(_md, _out, preset=None, **_kwargs):
        presets.append(preset)
        return 0

    monkeypatch.setattr(hwpx_cli, "_new_from_markdown", fake_new)
    create_args = argparse.Namespace(
        out_file=str(tmp_path / "create.hwpx"),
        markdown=None,
        title="제목",
        body="본문",
        json=None,
        plain=True,
    )
    write_args = argparse.Namespace(
        out_file=str(tmp_path / "write.hwpx"),
        markdown=None,
        input=None,
        plain=True,
    )
    monkeypatch.setattr(sys, "stdin", io.StringIO("P: 본문"))

    assert hwpx_cli.cmd_create(create_args) == 0
    assert hwpx_cli.cmd_write_java(write_args) == 0
    assert presets == [None, None]


def test_plain_skips_only_style_pass_not_preset(tmp_path, monkeypatch):
    calls = []

    def fake_run(argv, *, require_new_preset=False):
        calls.append((argv, require_new_preset))
        return subprocess.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(hwpx_cli, "_run_hwp", fake_run)
    assert (
        hwpx_cli._new_from_markdown(
            "# 제목", tmp_path / "plain.hwpx", "gongmun", plain=True
        )
        == 0
    )
    argv, require_new_preset = calls.pop()
    assert argv[-2:] == ["--preset", "gian"]
    assert require_new_preset is True


# --- DocumentSpec v1 compose handoff -------------------------------------------

def test_document_spec_fixtures_pin_exact_v1_root_contract():
    minimal = json.loads(
        (DOCUMENT_SPEC_FIXTURES / "minimal.json").read_text(encoding="utf-8")
    )
    comprehensive = json.loads(
        (DOCUMENT_SPEC_FIXTURES / "comprehensive.json").read_text(encoding="utf-8")
    )
    for fixture in (minimal, comprehensive):
        assert fixture["version"] == "1.0"
        assert isinstance(fixture["sections"], list) and fixture["sections"]
    assert set(comprehensive["styles"]) == {"body", "heading", "emphasis"}
    assert set(comprehensive["lists"]) == {"outline", "bullet"}
    assert {block["type"] for block in comprehensive["sections"][0]["blocks"]} >= {
        "paragraph",
        "table",
        "equation",
        "field",
        "break",
    }


def test_document_spec_fixtures_match_frozen_native_schema_when_source_available():
    source_root = os.environ.get("HWP_CLI_SOURCE")
    schema = (
        Path(source_root) / "schemas" / "document-spec-v1.schema.json"
        if source_root
        else Path.cwd().parent / "hwp-cli" / "schemas" / "document-spec-v1.schema.json"
    )
    if not schema.is_file():
        pytest.skip("hwp-cli source schema is not present in this checkout")
    raw = schema.read_bytes()
    assert hashlib.sha256(raw).hexdigest() == DOCUMENT_SPEC_V1_SCHEMA_SHA256
    contract = json.loads(raw)
    assert contract["$id"] == (
        "https://hwp-cli.dev/schemas/document-spec-v1.schema.json"
    )
    assert contract["required"] == ["version", "sections"]
    assert contract["properties"]["version"]["const"] == "1.0"
    assert contract["additionalProperties"] is False


def test_compose_parser_contract_is_exact():
    args = hwpx_cli._build_parser().parse_args(
        ["compose", "--spec", "document.json", "--output", "out.hwpx"]
    )
    assert args.func is hwpx_cli.cmd_compose
    assert args.spec == "document.json"
    assert args.output == "out.hwpx"
    assert args.dry_run is False
    assert args.report is False

    report_args = hwpx_cli._build_parser().parse_args(
        [
            "compose",
            "--spec",
            "document.json",
            "--output",
            "out.hwpx",
            "--dry-run",
            "--report",
        ]
    )
    assert report_args.dry_run is True
    assert report_args.report is True


def test_compose_dry_run_forwards_native_report_without_publishing(
    tmp_path, monkeypatch, capsys
):
    spec = tmp_path / "document.json"
    spec.write_text('{"version":"2.0"}', encoding="utf-8")
    destination = tmp_path / "existing.hwpx"
    destination.write_bytes(b"ORIGINAL")
    native_report = {
        "schema_version": "2.0",
        "dry_run": True,
        "target_format": "hwpx",
        "visuals": [],
    }

    def fake_run(argv, *, require_new_preset=False, require_compose=False):
        assert argv[:2] == ["compose", str(spec)]
        assert argv[-1] == "--dry-run"
        assert Path(argv[3]).name == "output.hwpx"
        assert require_compose is True
        return subprocess.CompletedProcess(
            ["/fake/hwp", *argv], 0, json.dumps(native_report), ""
        )

    monkeypatch.setattr(hwpx_cli, "_run_hwp", fake_run)
    assert (
        hwpx_cli.cmd_compose(
            argparse.Namespace(
                spec=str(spec),
                output=str(destination),
                dry_run=True,
                report=False,
            )
        )
        == 0
    )
    assert destination.read_bytes() == b"ORIGINAL"
    assert json.loads(capsys.readouterr().out) == native_report


def test_compose_report_is_validated_before_atomic_publish(tmp_path, monkeypatch, capsys):
    spec = tmp_path / "document.json"
    spec.write_text('{"version":"2.0"}', encoding="utf-8")
    destination = tmp_path / "report.hwpx"
    destination.write_bytes(b"ORIGINAL")
    native_report = {
        "schema_version": "2.0",
        "dry_run": False,
        "target_format": "hwpx",
        "visuals": [],
    }

    def fake_run(argv, **_kwargs):
        assert argv[-1] == "--report"
        shutil.copyfile(TEMPLATE, Path(argv[3]))
        return subprocess.CompletedProcess(
            ["/fake/hwp", *argv], 0, json.dumps(native_report), ""
        )

    monkeypatch.setattr(hwpx_cli, "_run_hwp", fake_run)
    monkeypatch.setattr(
        hwpx_cli,
        "_validate_hwp_json",
        lambda *_args, **_kwargs: {"valid": True, "format": "hwpx"},
    )
    assert (
        hwpx_cli.cmd_compose(
            argparse.Namespace(
                spec=str(spec),
                output=str(destination),
                dry_run=False,
                report=True,
            )
        )
        == 0
    )
    styled.validate_hwpx_package(destination)
    assert json.loads(capsys.readouterr().out) == native_report


def test_compose_malformed_report_preserves_existing_destination(
    tmp_path, monkeypatch
):
    spec = tmp_path / "document.json"
    spec.write_text('{"version":"2.0"}', encoding="utf-8")
    destination = tmp_path / "report.hwpx"
    destination.write_bytes(b"ORIGINAL")

    def fake_run(argv, **_kwargs):
        shutil.copyfile(TEMPLATE, Path(argv[3]))
        return subprocess.CompletedProcess(["/fake/hwp", *argv], 0, "not-json", "")

    monkeypatch.setattr(hwpx_cli, "_run_hwp", fake_run)
    monkeypatch.setattr(
        hwpx_cli,
        "_validate_hwp_json",
        lambda *_args, **_kwargs: {"valid": True, "format": "hwpx"},
    )
    with pytest.raises(SystemExit) as exc:
        hwpx_cli.cmd_compose(
            argparse.Namespace(
                spec=str(spec),
                output=str(destination),
                dry_run=False,
                report=True,
            )
        )
    assert exc.value.code == 2
    assert destination.read_bytes() == b"ORIGINAL"


def test_compose_success_stages_validates_and_atomically_publishes(
    tmp_path, monkeypatch
):
    spec = tmp_path / "document.json"
    spec.write_text("{}", encoding="utf-8")
    destination = tmp_path / "report.hwpx"
    destination.write_bytes(b"ORIGINAL")
    destination.chmod(0o640)
    calls = []

    def fake_run(argv, *, require_new_preset=False, require_compose=False):
        calls.append((list(argv), require_new_preset, require_compose))
        assert argv[:2] == ["compose", str(spec)]
        assert argv[2] == "--output"
        shutil.copyfile(TEMPLATE, Path(argv[3]))
        return subprocess.CompletedProcess(["/fake/hwp", *argv], 0, "", "")

    native_validations = []
    monkeypatch.setattr(hwpx_cli, "_run_hwp", fake_run)
    monkeypatch.setattr(
        hwpx_cli,
        "_validate_hwp_json",
        lambda path, *, context, binary=None: native_validations.append(
            (Path(path), context, binary)
        )
        or {"valid": True, "format": "hwpx"},
    )

    assert (
        hwpx_cli.cmd_compose(
            argparse.Namespace(spec=str(spec), output=str(destination))
        )
        == 0
    )
    styled.validate_hwpx_package(destination)
    assert stat.S_IMODE(destination.stat().st_mode) == 0o640
    assert calls and calls[0][1:] == (False, True)
    assert native_validations[0][1] == "compose 생성 결과"
    assert native_validations[0][2] == "/fake/hwp"
    assert not list(tmp_path.glob(".report.hwpx.compose-*"))


@pytest.mark.parametrize("output_name", ["report.hwp", "report", "report.zip"])
def test_compose_rejects_non_hwpx_output_before_native_call(
    tmp_path, monkeypatch, capsys, output_name
):
    spec = tmp_path / "document.json"
    spec.write_text("{}", encoding="utf-8")
    destination = tmp_path / output_name
    monkeypatch.setattr(
        hwpx_cli,
        "_run_hwp",
        lambda *_args, **_kwargs: pytest.fail("native compose must not run"),
    )

    with pytest.raises(SystemExit) as exc:
        hwpx_cli.cmd_compose(
            argparse.Namespace(spec=str(spec), output=str(destination))
        )
    assert exc.value.code == 2
    assert "compose 출력 형식은 .hwpx여야 함" in capsys.readouterr().err
    assert not destination.exists()


@pytest.mark.parametrize("failure", ["native", "invalid_package", "native_validate"])
def test_compose_failure_preserves_existing_destination(
    tmp_path, monkeypatch, failure
):
    spec = tmp_path / "document.json"
    spec.write_text("{}", encoding="utf-8")
    destination = tmp_path / "report.hwpx"
    destination.write_bytes(b"ORIGINAL")

    def fake_run(argv, *, require_new_preset=False, require_compose=False):
        assert require_compose is True
        if failure == "native":
            return subprocess.CompletedProcess(argv, 2, "partial", "invalid spec")
        if failure == "invalid_package":
            Path(argv[-1]).write_bytes(b"NOT-A-ZIP")
        else:
            shutil.copyfile(TEMPLATE, Path(argv[-1]))
        return subprocess.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(hwpx_cli, "_run_hwp", fake_run)
    if failure == "native_validate":
        monkeypatch.setattr(
            hwpx_cli,
            "_validate_hwp_json",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(
                RuntimeError("semantic validation failed")
            ),
        )

    with pytest.raises(SystemExit) as exc:
        hwpx_cli.cmd_compose(
            argparse.Namespace(spec=str(spec), output=str(destination))
        )
    assert exc.value.code == 2
    assert destination.read_bytes() == b"ORIGINAL"
    assert not list(tmp_path.glob(".report.hwpx.compose-*"))


def test_compose_destination_race_aborts_without_clobbering_racer(
    tmp_path, monkeypatch
):
    spec = tmp_path / "document.json"
    spec.write_text("{}", encoding="utf-8")
    destination = tmp_path / "report.hwpx"
    destination.write_bytes(b"ORIGINAL")

    def fake_run(argv, **_kwargs):
        shutil.copyfile(TEMPLATE, Path(argv[-1]))
        return subprocess.CompletedProcess(argv, 0, "", "")

    def validate_then_race(_path, *, context, binary=None):
        assert context == "compose 생성 결과"
        assert binary == "compose"
        destination.write_bytes(b"RACER")
        return {"valid": True, "format": "hwpx"}

    monkeypatch.setattr(hwpx_cli, "_run_hwp", fake_run)
    monkeypatch.setattr(hwpx_cli, "_validate_hwp_json", validate_then_race)

    with pytest.raises(SystemExit) as exc:
        hwpx_cli.cmd_compose(
            argparse.Namespace(spec=str(spec), output=str(destination))
        )
    assert exc.value.code == 2
    assert destination.read_bytes() == b"RACER"


@pytest.mark.skipif(not hasattr(os, "symlink"), reason="symlink unsupported")
def test_compose_rejects_symlink_destination_before_native_call(
    tmp_path, monkeypatch
):
    spec = tmp_path / "document.json"
    spec.write_text("{}", encoding="utf-8")
    target = tmp_path / "target.hwpx"
    target.write_bytes(b"TARGET")
    destination = tmp_path / "report.hwpx"
    destination.symlink_to(target)
    monkeypatch.setattr(
        hwpx_cli,
        "_run_hwp",
        lambda *_args, **_kwargs: pytest.fail("native compose must not run"),
    )

    with pytest.raises(SystemExit) as exc:
        hwpx_cli.cmd_compose(
            argparse.Namespace(spec=str(spec), output=str(destination))
        )
    assert exc.value.code == 2
    assert target.read_bytes() == b"TARGET"


@pytest.mark.parametrize(
    "fixture_name",
    ["minimal.json", "minimal.yaml", "comprehensive.json"],
)
def test_native_compose_fixtures_roundtrip_when_capability_available(
    tmp_path, fixture_name
):
    binary = hwpx_cli._find_hwp_cli_with_compose()
    if binary is None:
        pytest.skip("native hwp compose is not available yet")
    spec = DOCUMENT_SPEC_FIXTURES / fixture_name
    destination = tmp_path / f"{Path(fixture_name).stem}.hwpx"
    env = dict(os.environ, HWP_CLI=binary)
    proc = subprocess.run(
        [
            sys.executable,
            str(SCRIPTS / "hwpx_cli.py"),
            "compose",
            "--spec",
            str(spec),
            "--output",
            str(destination),
        ],
        capture_output=True,
        text=True,
        env=env,
    )
    assert proc.returncode == 0, proc.stderr
    styled.validate_hwpx_package(destination)
    validation = subprocess.run(
        [binary, "validate", str(destination), "--json"],
        capture_output=True,
        text=True,
    )
    assert validation.returncode == 0, validation.stderr
    payload = json.loads(validation.stdout)
    assert payload["valid"] is True
    assert payload["format"] == "hwpx"


def test_native_compose_asset_fixture_roundtrips_when_capability_available(
    tmp_path,
):
    binary = hwpx_cli._find_hwp_cli_with_compose()
    if binary is None:
        pytest.skip("native hwp compose is not available yet")
    fixture_dir = tmp_path / "spec"
    fixture_dir.mkdir()
    shutil.copyfile(
        DOCUMENT_SPEC_FIXTURES / "asset.json",
        fixture_dir / "asset.json",
    )
    png = b"\x89PNG\r\n\x1a\n"
    png += b"\x00\x00\x00\rIHDR"
    png += (100).to_bytes(4, "big") + (50).to_bytes(4, "big")
    png += b"\x08\x06\x00\x00\x00\x00\x00\x00\x00"
    (fixture_dir / "fixture.png").write_bytes(png)
    destination = tmp_path / "asset.hwpx"
    proc = subprocess.run(
        [
            sys.executable,
            str(SCRIPTS / "hwpx_cli.py"),
            "compose",
            "--spec",
            str(fixture_dir / "asset.json"),
            "--output",
            str(destination),
        ],
        capture_output=True,
        text=True,
        env=dict(os.environ, HWP_CLI=binary),
    )
    assert proc.returncode == 0, proc.stderr
    styled.validate_hwpx_package(destination)
    with zipfile.ZipFile(destination) as archive:
        embedded = [
            name
            for name in archive.namelist()
            if name.startswith("BinData/")
        ]
    assert len(embedded) == 1, "동일 asset bytes는 하나의 native package item으로 재사용"


@pytest.mark.parametrize(
    "fixture_name",
    [
        "invalid-unknown-field.json",
        "invalid-version.json",
        "invalid-reference.json",
        "invalid-table-overlap.json",
        "invalid-unsupported-native.json",
    ],
)
def test_native_compose_adversarial_fixtures_fail_closed_when_capability_available(
    tmp_path, fixture_name
):
    binary = hwpx_cli._find_hwp_cli_with_compose()
    if binary is None:
        pytest.skip("native hwp compose is not available yet")
    destination = tmp_path / "existing.hwpx"
    destination.write_bytes(b"ORIGINAL")
    env = dict(os.environ, HWP_CLI=binary)
    proc = subprocess.run(
        [
            sys.executable,
            str(SCRIPTS / "hwpx_cli.py"),
            "compose",
            "--spec",
            str(DOCUMENT_SPEC_FIXTURES / fixture_name),
            "--output",
            str(destination),
        ],
        capture_output=True,
        text=True,
        env=env,
    )
    assert proc.returncode != 0
    assert destination.read_bytes() == b"ORIGINAL"


# --- DocumentSpec v2 target-aware visual handoff -------------------------------

def test_document_spec_v2_fixtures_and_frozen_schema_contract():
    svg = json.loads(
        (DOCUMENT_SPEC_V2_FIXTURES / "svg-fallback.json").read_text(encoding="utf-8")
    )
    text_box = json.loads(
        (DOCUMENT_SPEC_V2_FIXTURES / "text-box-target-policy.json").read_text(
            encoding="utf-8"
        )
    )
    assert svg["version"] == "2.0"
    assert svg["document"]["version"] == "1.0"
    assert svg["visuals"][0]["placement"] == "inline"
    assert svg["visuals"][0]["policy"] == {
        "hwp": "force_visual_fallback",
        "hwpx": "force_visual_fallback",
    }
    assert text_box["visuals"][0]["policy"] == {
        "hwp": "required_native",
        "hwpx": "required_native",
    }

    source_root = os.environ.get("HWP_CLI_SOURCE")
    schema_root = (
        Path(source_root) / "schemas"
        if source_root
        else Path.cwd().parent / "hwp-cli" / "schemas"
    )
    spec_raw = (schema_root / "document-spec-v2.schema.json").read_bytes()
    report_raw = (schema_root / "document-report-v2.schema.json").read_bytes()
    assert hashlib.sha256(spec_raw).hexdigest() == DOCUMENT_SPEC_V2_SCHEMA_SHA256
    assert hashlib.sha256(report_raw).hexdigest() == DOCUMENT_REPORT_V2_SCHEMA_SHA256

    spec_schema = json.loads(spec_raw)
    report_schema = json.loads(report_raw)
    assert spec_schema["$id"] == (
        "https://hwp-cli.dev/schemas/document-spec-v2.schema.json"
    )
    assert report_schema["$id"] == (
        "https://hwp-cli.dev/schemas/document-report-v2.schema.json"
    )
    assert spec_schema["required"] == ["version", "document"]
    assert spec_schema["properties"]["version"]["const"] == "2.0"
    assert spec_schema["properties"]["document"]["$ref"] == (
        "document-spec-v1.schema.json"
    )
    assert spec_schema["$defs"]["policyValue"]["enum"] == [
        "required_native",
        "prefer_native",
        "force_visual_fallback",
    ]
    assert spec_schema["$defs"]["visual"]["properties"]["placement"]["const"] == (
        "inline"
    )
    assert spec_schema["$defs"]["visual"]["required"] == [
        "id",
        "location",
        "alt",
        "width_mm",
        "height_mm",
        "content",
    ]
    visual_report = report_schema["$defs"]["visualReport"]
    assert visual_report["additionalProperties"] is False
    assert set(visual_report["properties"]) == {
        "id",
        "kind",
        "requested_policy",
        "resolved_representation",
        "target_format",
        "capability_reason",
        "semantic_sha256",
        "source_sha256",
        "sanitized_svg_sha256",
        "media_sha256",
        "media_type",
        "dimensions",
    }
    for forbidden in ["title", "alt", "description", "source", "path", "output"]:
        assert forbidden not in visual_report["properties"]


def _native_compose(
    binary: str,
    spec: Path,
    output: Path,
    *extra: str,
) -> subprocess.CompletedProcess:
    return subprocess.run(
        [binary, "compose", str(spec), "-o", str(output), *extra],
        capture_output=True,
        text=True,
        timeout=120,
    )


def _decode_png_pixels(data: bytes) -> tuple[int, int, int, bytes]:
    assert data.startswith(b"\x89PNG\r\n\x1a\n")
    offset = 8
    width = height = color_type = 0
    compressed = bytearray()
    while offset < len(data):
        length = int.from_bytes(data[offset : offset + 4], "big")
        kind = data[offset + 4 : offset + 8]
        payload = data[offset + 8 : offset + 8 + length]
        offset += 12 + length
        if kind == b"IHDR":
            width = int.from_bytes(payload[0:4], "big")
            height = int.from_bytes(payload[4:8], "big")
            assert payload[8] == 8, "test decoder supports 8-bit PNG only"
            color_type = payload[9]
            assert color_type in (2, 6), "test decoder supports RGB/RGBA PNG only"
            assert payload[10:13] == b"\x00\x00\x00", "interlaced PNG unsupported"
        elif kind == b"IDAT":
            compressed.extend(payload)
        elif kind == b"IEND":
            break
    channels = 4 if color_type == 6 else 3
    stride = width * channels
    raw = zlib.decompress(bytes(compressed))
    assert len(raw) == height * (stride + 1)
    rows = bytearray()
    previous = bytearray(stride)
    cursor = 0

    def paeth(a: int, b: int, c: int) -> int:
        estimate = a + b - c
        distances = (abs(estimate - a), abs(estimate - b), abs(estimate - c))
        return (a, b, c)[distances.index(min(distances))]

    for _ in range(height):
        filter_type = raw[cursor]
        cursor += 1
        encoded = raw[cursor : cursor + stride]
        cursor += stride
        row = bytearray(stride)
        for index, value in enumerate(encoded):
            left = row[index - channels] if index >= channels else 0
            above = previous[index]
            upper_left = previous[index - channels] if index >= channels else 0
            if filter_type == 0:
                decoded = value
            elif filter_type == 1:
                decoded = value + left
            elif filter_type == 2:
                decoded = value + above
            elif filter_type == 3:
                decoded = value + ((left + above) // 2)
            elif filter_type == 4:
                decoded = value + paeth(left, above, upper_left)
            else:
                raise AssertionError(f"unknown PNG filter {filter_type}")
            row[index] = decoded & 0xFF
        rows.extend(row)
        previous = row
    return width, height, channels, bytes(rows)


def _has_blue_visual(data: bytes) -> bool:
    _width, _height, channels, pixels = _decode_png_pixels(data)
    return any(
        pixels[index + 2] > pixels[index] + 20
        and pixels[index + 2] > pixels[index + 1] + 10
        and (channels == 3 or pixels[index + 3] != 0)
        for index in range(0, len(pixels), channels)
    )


def test_native_v2_svg_fallback_is_png_only_nonblank_and_redacted_for_both_targets(
    tmp_path,
):
    binary = hwpx_cli._find_hwp_cli_with_compose()
    if binary is None:
        pytest.skip("native DocumentSpec v2 compose is unavailable")
    spec = DOCUMENT_SPEC_V2_FIXTURES / "svg-fallback.json"
    reports = {}
    for extension in ("hwp", "hwpx"):
        first = tmp_path / f"first.{extension}"
        second = tmp_path / f"second.{extension}"
        for output in (first, second):
            result = _native_compose(binary, spec, output, "--report")
            assert result.returncode == 0, result.stderr
            report = json.loads(result.stdout)
            assert report["schema_version"] == "2.0"
            assert report["target_format"] == extension
            visual = report["visuals"][0]
            assert visual["requested_policy"] == "force_visual_fallback"
            assert visual["resolved_representation"] == "visual_fallback"
            assert visual["media_type"] == "image/png"
            assert re.fullmatch(r"[0-9a-f]{64}", visual["source_sha256"])
            assert re.fullmatch(r"[0-9a-f]{64}", visual["sanitized_svg_sha256"])
            assert re.fullmatch(r"[0-9a-f]{64}", visual["media_sha256"])
            for secret in [
                "visual.svg",
                "SECRET-V2-TITLE",
                "SECRET-V2-ALT",
                str(DOCUMENT_SPEC_V2_FIXTURES),
                str(output),
            ]:
                assert secret not in result.stdout
            reports[extension] = report
        assert first.read_bytes() == second.read_bytes()

        info = subprocess.run(
            [binary, "info", str(first), "--json"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        assert info.returncode == 0, info.stderr
        info_payload = json.loads(info.stdout)
        names = [
            item.get("name", item.get("path", ""))
            for item in info_payload.get("entries", info_payload.get("streams", []))
        ]
        binary_names = [name for name in names if "BinData" in name]
        assert binary_names and all(name.lower().endswith(".png") for name in binary_names)

        rendered = tmp_path / f"rendered-{extension}.png"
        render = subprocess.run(
            [binary, "render", str(first), "-o", str(rendered), "--pages", "1"],
            capture_output=True,
            text=True,
            timeout=120,
        )
        assert render.returncode == 0, render.stderr
        assert _has_blue_visual(rendered.read_bytes()), "fallback visual rendered blank"

    assert reports["hwp"]["visuals"][0]["media_sha256"] == (
        reports["hwpx"]["visuals"][0]["media_sha256"]
    )


def test_maru_v2_compose_wrapper_forwards_report_and_dry_run(tmp_path):
    binary = hwpx_cli._find_hwp_cli_with_compose()
    if binary is None:
        pytest.skip("native DocumentSpec v2 compose is unavailable")
    spec = DOCUMENT_SPEC_V2_FIXTURES / "svg-fallback.json"
    output = tmp_path / "maru-v2.hwpx"
    env = dict(os.environ, HWP_CLI=binary)

    composed = subprocess.run(
        [
            sys.executable,
            str(SCRIPTS / "hwpx_cli.py"),
            "compose",
            "--spec",
            str(spec),
            "--output",
            str(output),
            "--report",
        ],
        capture_output=True,
        text=True,
        env=env,
        timeout=120,
    )
    assert composed.returncode == 0, composed.stderr
    report = json.loads(composed.stdout)
    assert report["schema_version"] == "2.0"
    assert report["target_format"] == "hwpx"
    assert report["visuals"][0]["media_type"] == "image/png"
    styled.validate_hwpx_package(output)

    before = output.read_bytes()
    dry_run = subprocess.run(
        [
            sys.executable,
            str(SCRIPTS / "hwpx_cli.py"),
            "compose",
            "--spec",
            str(spec),
            "--output",
            str(output),
            "--dry-run",
        ],
        capture_output=True,
        text=True,
        env=env,
        timeout=120,
    )
    assert dry_run.returncode == 0, dry_run.stderr
    assert json.loads(dry_run.stdout)["dry_run"] is True
    assert output.read_bytes() == before


def test_native_v2_text_box_is_hwpx_native_and_hwp_fails_closed(tmp_path):
    binary = hwpx_cli._find_hwp_cli_with_compose()
    if binary is None:
        pytest.skip("native DocumentSpec v2 compose is unavailable")
    spec = DOCUMENT_SPEC_V2_FIXTURES / "text-box-target-policy.json"

    hwp_output = tmp_path / "box.hwp"
    hwp_output.write_bytes(b"ORIGINAL")
    hwp_result = _native_compose(binary, spec, hwp_output, "--report")
    assert hwp_result.returncode != 0
    assert "native_text_box_unavailable_for_hwp" in hwp_result.stderr
    assert hwp_output.read_bytes() == b"ORIGINAL"

    hwpx_output = tmp_path / "box.hwpx"
    hwpx_result = _native_compose(binary, spec, hwpx_output, "--report")
    assert hwpx_result.returncode == 0, hwpx_result.stderr
    report = json.loads(hwpx_result.stdout)
    visual = report["visuals"][0]
    assert visual["requested_policy"] == "required_native"
    assert visual["resolved_representation"] == "native"
    assert visual["capability_reason"] == "native_hwpx_rectangle_text_box_available"
    assert "media_sha256" not in visual
    with zipfile.ZipFile(hwpx_output) as archive:
        section = archive.read("Contents/section0.xml").decode("utf-8")
    assert "first line" in section and "second line" in section
    assert "<hp:shapeComment>Summary\n\nTwo-line summary box</hp:shapeComment>" in section


@pytest.mark.parametrize(
    ("fixture_name", "expected_error"),
    [
        ("invalid-required-native-svg.json", "native_unavailable"),
        ("invalid-missing-alt.json", "missing field `alt`"),
        ("invalid-floating.json", "unknown variant `floating`"),
        ("invalid-hostile-svg.json", "forbidden SVG element: image"),
        ("invalid-transparent-svg.json", "SVG render is empty or fully transparent"),
    ],
)
def test_native_v2_adversarial_visuals_fail_without_publishing(
    tmp_path, fixture_name, expected_error
):
    binary = hwpx_cli._find_hwp_cli_with_compose()
    if binary is None:
        pytest.skip("native DocumentSpec v2 compose is unavailable")
    output = tmp_path / "existing.hwpx"
    output.write_bytes(b"ORIGINAL")
    result = _native_compose(
        binary,
        DOCUMENT_SPEC_V2_FIXTURES / fixture_name,
        output,
        "--report",
    )
    assert result.returncode != 0
    assert expected_error in result.stderr
    assert output.read_bytes() == b"ORIGINAL"


def test_native_v2_deprecated_global_fallback_conflicts_and_preserves_output(tmp_path):
    binary = hwpx_cli._find_hwp_cli_with_compose()
    if binary is None:
        pytest.skip("native DocumentSpec v2 compose is unavailable")
    output = tmp_path / "existing.hwpx"
    output.write_bytes(b"ORIGINAL")
    result = _native_compose(
        binary,
        DOCUMENT_SPEC_V2_FIXTURES / "svg-fallback.json",
        output,
        "--allow-visual-fallback",
    )
    assert result.returncode != 0
    assert "policy_conflict" in result.stderr
    assert output.read_bytes() == b"ORIGINAL"


def test_native_v2_aggregate_raster_budget_fails_before_publish(tmp_path):
    binary = hwpx_cli._find_hwp_cli_with_compose()
    if binary is None:
        pytest.skip("native DocumentSpec v2 compose is unavailable")
    visuals = [
        {
            "id": f"box{index}",
            "location": {"section": 0, "paragraph": 0},
            "policy": {"hwpx": "required_native"},
            "alt": f"box {index}",
            "width_mm": 500,
            "height_mm": 500,
            "content": {"type": "text_box", "text": "bounded"},
        }
        for index in range(19)
    ]
    spec = tmp_path / "raster-budget.json"
    spec.write_text(
        json.dumps(
            {
                "version": "2.0",
                "document": {
                    "version": "1.0",
                    "sections": [
                        {
                            "blocks": [
                                {
                                    "type": "paragraph",
                                    "runs": [{"type": "text", "text": "anchor"}],
                                }
                            ]
                        }
                    ],
                },
                "visuals": visuals,
            }
        ),
        encoding="utf-8",
    )
    output = tmp_path / "budget.hwpx"
    result = _native_compose(binary, spec, output, "--dry-run")
    assert result.returncode != 0
    assert "visual raster budget" in result.stderr
    assert not output.exists()


# --- hwp-cli passthrough: info / fields / bookmarks / render / convert ------------

@requires_cli
def test_info_json_contract():
    proc = _run("info", str(TEMPLATE), "--json")
    assert proc.returncode == 0, proc.stderr
    payload = json.loads(proc.stdout)
    names = {e["name"] for e in payload["entries"]}
    assert "mimetype" in names  # first zip entry always present


@requires_cli
@pytest.mark.parametrize("cmd", ["fields", "bookmarks"])
def test_fields_bookmarks_exit_zero(cmd):
    # the base template has neither, so an empty listing must still succeed
    proc = _run(cmd, str(TEMPLATE))
    assert proc.returncode == 0, proc.stderr


@requires_cli
def test_render_produces_nonempty_png(tmp_path):
    out = tmp_path / "page.png"
    proc = _run("render", str(TEMPLATE), "-o", str(out))
    assert proc.returncode == 0, proc.stderr
    assert out.is_file() and out.stat().st_size > 0


@requires_cli
def test_convert_to_markdown_writes_file(tmp_path):
    out = tmp_path / "out.md"
    proc = _run("convert", str(TEMPLATE), "--to", "md", "-o", str(out))
    assert proc.returncode == 0, proc.stderr
    assert out.is_file() and out.stat().st_size > 0


# ── hwp-cli 바이너리 해석 (버전 최대 선택) ──────────────────────────────────

def test_resolver_picks_highest_version(tmp_path, monkeypatch):
    """여러 곳에 설치된 `hwp` 중 버전이 가장 높은 것을 골라야 한다 — 고정 순서로
    오래된 사본을 집으면 신기능(수식 방출 등)이 조용히 사라진다."""
    def stub(path: Path, version: str) -> Path:
        path.write_text(f'#!/bin/sh\necho "hwp {version}"\n')
        path.chmod(0o755)
        return path

    old = stub(tmp_path / "old_hwp", "0.2.0")
    new = stub(tmp_path / "new_hwp", "9.9.9")
    monkeypatch.delenv("HWP_CLI", raising=False)
    # PATH 후보 = 낡은 사본, cargo 후보 = 새 사본 → 새 사본이 이겨야 한다
    monkeypatch.setattr(hwpx_cli.shutil, "which", lambda _n: str(old))
    monkeypatch.setattr(hwpx_cli.Path, "home", staticmethod(lambda: tmp_path))
    (tmp_path / ".cargo" / "bin").mkdir(parents=True)
    (tmp_path / ".cargo" / "bin" / "hwp").symlink_to(new)

    hwpx_cli._find_hwp_cli.cache_clear()
    try:
        assert hwpx_cli._hwp_version(hwpx_cli._find_hwp_cli()) == (9, 9, 9)
    finally:
        hwpx_cli._find_hwp_cli.cache_clear()


def test_resolver_rejects_non_hwp_cli(tmp_path, monkeypatch):
    """`hwp`라는 이름을 공유하는 다른 도구(구 hwp-toolkit 래퍼)는 배제한다."""
    impostor = tmp_path / "hwp"
    impostor.write_text('#!/bin/sh\necho "hwp-toolkit 1.0"\n')
    impostor.chmod(0o755)
    monkeypatch.delenv("HWP_CLI", raising=False)
    monkeypatch.setattr(hwpx_cli.shutil, "which", lambda _n: str(impostor))
    monkeypatch.setattr(hwpx_cli.Path, "home", staticmethod(lambda: tmp_path / "empty"))

    hwpx_cli._find_hwp_cli.cache_clear()
    try:
        assert hwpx_cli._find_hwp_cli() is None
    finally:
        hwpx_cli._find_hwp_cli.cache_clear()


@requires_cli
def test_resolved_cli_meets_minimum_version():
    """스킬이 문서화한 기능(수식 방출 등)을 실제로 갖춘 바이너리가 잡혔는지."""
    assert hwpx_cli._hwp_version(hwpx_cli._find_hwp_cli()) >= hwpx_cli.HWP_CLI_MIN


def test_stale_version_warns_even_when_explicitly_pinned(tmp_path, monkeypatch, capsys):
    """구버전은 hwpx 쓰기에서 수식을 무경고로 버리므로, `$HWP_CLI`로 직접 지정한
    경우에도 경고해야 한다(무경고 데이터 유실 방지)."""
    old = tmp_path / "hwp"
    old.write_text('#!/bin/sh\necho "hwp 0.2.0"\n')
    old.chmod(0o755)
    monkeypatch.setenv("HWP_CLI", str(old))

    hwpx_cli._find_hwp_cli.cache_clear()
    try:
        assert hwpx_cli._find_hwp_cli() == str(old)  # 명시 지정은 존중
        assert "0.2.0" in capsys.readouterr().err  # 그러나 경고는 낸다
    finally:
        hwpx_cli._find_hwp_cli.cache_clear()


def _stub_hwp(path: Path, version: str, *, supports_preset: bool) -> Path:
    preset_help = 'echo "  --preset <PRESET>"' if supports_preset else 'echo "new help"'
    path.write_text(
        "#!/bin/sh\n"
        'if [ "$1" = "--version" ]; then\n'
        f'  echo "hwp {version}"\n'
        'elif [ "$1" = "new" ] && [ "$2" = "--help" ]; then\n'
        f"  {preset_help}\n"
        "else\n"
        "  exit 2\n"
        "fi\n"
    )
    path.chmod(0o755)
    return path


def _clear_preset_resolver_caches() -> None:
    hwpx_cli._find_hwp_cli.cache_clear()
    hwpx_cli._find_hwp_cli_with_new_preset.cache_clear()
    hwpx_cli._supports_new_preset.cache_clear()


def _stub_compose_hwp(path: Path, *, supported: bool) -> Path:
    help_line = (
        'echo "Usage: hwp compose <SPEC> --output <OUTPUT> --dry-run --report"'
        if supported
        else 'echo "unknown command" >&2; exit 2'
    )
    path.write_text(
        "#!/bin/sh\n"
        'if [ "$1" = "--version" ]; then\n'
        '  echo "hwp 9.9.9"\n'
        'elif [ "$1" = "compose" ] && [ "$2" = "--help" ]; then\n'
        f"  {help_line}\n"
        "else\n"
        "  exit 2\n"
        "fi\n"
    )
    path.chmod(0o755)
    return path


def _clear_compose_resolver_caches() -> None:
    hwpx_cli._find_hwp_cli.cache_clear()
    hwpx_cli._find_hwp_cli_with_compose.cache_clear()
    hwpx_cli._supports_compose.cache_clear()


def test_compose_capability_requires_exact_native_flags(tmp_path):
    supported = _stub_compose_hwp(tmp_path / "supported", supported=True)
    unsupported = _stub_compose_hwp(tmp_path / "unsupported", supported=False)
    _clear_compose_resolver_caches()
    try:
        assert hwpx_cli._supports_compose(str(supported)) is True
        assert hwpx_cli._supports_compose(str(unsupported)) is False
    finally:
        _clear_compose_resolver_caches()


def test_explicit_compose_incapable_binary_fails_actionably(
    tmp_path, monkeypatch, capsys
):
    unsupported = _stub_compose_hwp(tmp_path / "hwp", supported=False)
    monkeypatch.setenv("HWP_CLI", str(unsupported))
    _clear_compose_resolver_caches()
    try:
        with pytest.raises(SystemExit) as exc:
            hwpx_cli._hwp_cli_or_die(require_compose=True)
        assert exc.value.code == 1
        err = capsys.readouterr().err
        assert "compose SPEC -o OUTPUT --dry-run --report" in err
        assert "DocumentSpec v1/v2" in err
        assert "HWP_CLI" in err
    finally:
        _clear_compose_resolver_caches()


@pytest.mark.parametrize(
    ("path_version", "path_supports_preset", "cargo_version"),
    [
        ("9.9.9", False, "0.4.0"),
        ("0.4.0", False, "0.4.0"),
        ("0.4.0", True, "9.9.9"),
    ],
)
def test_preset_resolver_selects_highest_capable_build(
    tmp_path,
    monkeypatch,
    path_version,
    path_supports_preset,
    cargo_version,
):
    path_hwp = _stub_hwp(
        tmp_path / "path_hwp",
        path_version,
        supports_preset=path_supports_preset,
    )
    cargo_hwp = _stub_hwp(
        tmp_path / "cargo_hwp", cargo_version, supports_preset=True
    )
    cargo_bin = tmp_path / ".cargo" / "bin"
    cargo_bin.mkdir(parents=True)
    (cargo_bin / "hwp").symlink_to(cargo_hwp)
    monkeypatch.delenv("HWP_CLI", raising=False)
    monkeypatch.setattr(hwpx_cli.shutil, "which", lambda _name: str(path_hwp))
    monkeypatch.setattr(hwpx_cli.Path, "home", staticmethod(lambda: tmp_path))

    _clear_preset_resolver_caches()
    try:
        assert hwpx_cli._find_hwp_cli_with_new_preset() == str(cargo_bin / "hwp")
    finally:
        _clear_preset_resolver_caches()


def test_explicit_preset_incapable_binary_fails_actionably(
    tmp_path, monkeypatch, capsys
):
    unsupported = _stub_hwp(
        tmp_path / "hwp", "0.4.0", supports_preset=False
    )
    monkeypatch.setenv("HWP_CLI", str(unsupported))

    _clear_preset_resolver_caches()
    try:
        with pytest.raises(SystemExit) as exc:
            hwpx_cli._hwp_cli_or_die(require_new_preset=True)
        assert exc.value.code == 1
        err = capsys.readouterr().err
        assert "new --preset" in err
        assert "v0.4.1" in err
        assert "HWP_CLI" in err
    finally:
        _clear_preset_resolver_caches()


# --- TemplateSpec v1 native handoff --------------------------------------------


def _template_args(
    template: Path,
    data: Path,
    output: Path,
    *,
    dry_run: bool = False,
    report: bool = False,
) -> argparse.Namespace:
    return argparse.Namespace(
        template=str(template),
        data=str(data),
        output=str(output),
        template_format=None,
        data_format=None,
        dry_run=dry_run,
        report=report,
    )


def test_template_parser_contract_is_exact():
    args = hwpx_cli._build_parser().parse_args(
        [
            "template",
            "template.yaml",
            "--data",
            "data.json",
            "--output",
            "out.hwpx",
            "--template-format",
            "yaml",
            "--data-format",
            "json",
            "--dry-run",
            "--report",
        ]
    )
    assert args.func is hwpx_cli.cmd_template
    assert args.template == "template.yaml"
    assert args.data == "data.json"
    assert args.output == "out.hwpx"
    assert args.template_format == "yaml"
    assert args.data_format == "json"
    assert args.dry_run is True
    assert args.report is True


def test_template_success_stages_validates_with_same_binary_and_publishes(
    tmp_path, monkeypatch, capsys
):
    template = tmp_path / "template.json"
    data = tmp_path / "data.json"
    template.write_text("{}", encoding="utf-8")
    data.write_text("{}", encoding="utf-8")
    destination = tmp_path / "report.hwpx"
    destination.write_bytes(b"ORIGINAL")
    destination.chmod(0o640)
    calls = []

    def fake_run(
        argv,
        *,
        require_new_preset=False,
        require_compose=False,
        require_template=False,
        redact_failure_output=False,
        binary=None,
    ):
        calls.append(
            (
                list(argv),
                require_new_preset,
                require_compose,
                require_template,
                redact_failure_output,
                binary,
            )
        )
        assert argv[:4] == ["template", str(template), "--data", str(data)]
        staged = Path(argv[argv.index("--output") + 1])
        shutil.copyfile(TEMPLATE, staged)
        return subprocess.CompletedProcess(
            ["/fake/hwp", *argv],
            0,
            json.dumps(
                {
                    "output": str(staged),
                    "mode": "compose",
                    "compose": {"output": str(staged), "valid": True},
                }
            ),
            "",
        )

    validations = []

    def fake_validate(
        path,
        *,
        context,
        binary=None,
        redact_diagnostics=False,
    ):
        validations.append((Path(path), context, binary, redact_diagnostics))
        return {"valid": True, "format": "hwpx"}

    monkeypatch.setattr(hwpx_cli, "_run_hwp", fake_run)
    monkeypatch.setattr(hwpx_cli, "_validate_hwp_json", fake_validate)

    assert (
        hwpx_cli.cmd_template(
            _template_args(template, data, destination, report=True)
        )
        == 0
    )
    styled.validate_hwpx_package(destination)
    assert stat.S_IMODE(destination.stat().st_mode) == 0o640
    assert calls[0][1:] == (False, False, True, True, None)
    assert validations == [
        (
            validations[0][0],
            "template 생성 결과",
            "/fake/hwp",
            True,
        )
    ]
    report = json.loads(capsys.readouterr().out)
    assert report["output"] == str(destination)
    assert report["compose"]["output"] == str(destination)
    assert ".template-" not in json.dumps(report)
    assert not list(tmp_path.glob(".report.hwpx.template-*"))


def test_template_dry_run_requires_report_and_never_publishes(
    tmp_path, monkeypatch, capsys
):
    template = tmp_path / "template.json"
    data = tmp_path / "data.json"
    template.write_text("{}", encoding="utf-8")
    data.write_text("{}", encoding="utf-8")
    destination = tmp_path / "report.hwpx"
    destination.write_bytes(b"ORIGINAL")

    def fake_run(argv, **kwargs):
        assert "--dry-run" in argv
        assert kwargs["require_template"] is True
        return subprocess.CompletedProcess(
            ["/fake/hwp", *argv],
            0,
            json.dumps({"dry_run": True, "mode": "compose"}),
            "",
        )

    monkeypatch.setattr(hwpx_cli, "_run_hwp", fake_run)
    monkeypatch.setattr(
        hwpx_cli,
        "_validate_hwp_json",
        lambda *_args, **_kwargs: pytest.fail("dry-run must not validate output"),
    )

    assert (
        hwpx_cli.cmd_template(
            _template_args(template, data, destination, dry_run=True)
        )
        == 0
    )
    assert destination.read_bytes() == b"ORIGINAL"
    assert json.loads(capsys.readouterr().out) == {
        "dry_run": True,
        "mode": "compose",
        "output": str(destination),
    }
    assert not list(tmp_path.glob(".report.hwpx.template-*"))


def test_template_native_failure_redacts_data_values_and_preserves_destination(
    tmp_path, monkeypatch, capsys
):
    template = tmp_path / "template.json"
    data = tmp_path / "data.json"
    template.write_text("{}", encoding="utf-8")
    data.write_text(
        '{"version":"1.0","values":{"secret":"TOPSECRET_CANARY"}}',
        encoding="utf-8",
    )
    destination = tmp_path / "report.hwpx"
    destination.write_bytes(b"ORIGINAL")
    envelope = {
        "error": "template_spec",
        "issues": [
            {
                "code": "type_mismatch",
                "pointer": "/values/secret",
                "message": "TOPSECRET_CANARY",
            }
        ],
    }
    monkeypatch.setattr(
        hwpx_cli,
        "_run_hwp",
        lambda argv, **_kwargs: subprocess.CompletedProcess(
            ["/fake/hwp", *argv],
            2,
            "",
            "Error: " + json.dumps(envelope),
        ),
    )

    with pytest.raises(SystemExit) as exc:
        hwpx_cli.cmd_template(_template_args(template, data, destination))
    assert exc.value.code == 2
    assert destination.read_bytes() == b"ORIGINAL"
    stderr = capsys.readouterr().err
    assert "type_mismatch" in stderr
    assert "/values/secret" in stderr
    assert "TOPSECRET_CANARY" not in stderr
    assert not list(tmp_path.glob(".report.hwpx.template-*"))


def test_template_unknown_success_report_is_rejected_before_publish(
    tmp_path, monkeypatch
):
    template = tmp_path / "template.json"
    data = tmp_path / "data.json"
    template.write_text("{}", encoding="utf-8")
    data.write_text("{}", encoding="utf-8")
    destination = tmp_path / "report.hwpx"
    destination.write_bytes(b"ORIGINAL")

    def fake_run(argv, **_kwargs):
        staged = Path(argv[argv.index("--output") + 1])
        shutil.copyfile(TEMPLATE, staged)
        return subprocess.CompletedProcess(
            ["/fake/hwp", *argv],
            0,
            '{"unknown_secret_field":"TOPSECRET_CANARY"}',
            "",
        )

    monkeypatch.setattr(hwpx_cli, "_run_hwp", fake_run)
    with pytest.raises(SystemExit) as exc:
        hwpx_cli.cmd_template(
            _template_args(template, data, destination, report=True)
        )
    assert exc.value.code == 2
    assert destination.read_bytes() == b"ORIGINAL"


def test_template_destination_race_does_not_clobber_racer(
    tmp_path, monkeypatch
):
    template = tmp_path / "template.json"
    data = tmp_path / "data.json"
    template.write_text("{}", encoding="utf-8")
    data.write_text("{}", encoding="utf-8")
    destination = tmp_path / "report.hwpx"
    destination.write_bytes(b"ORIGINAL")

    def fake_run(argv, **_kwargs):
        shutil.copyfile(TEMPLATE, Path(argv[argv.index("--output") + 1]))
        return subprocess.CompletedProcess(["/fake/hwp", *argv], 0, "", "")

    def validate_then_race(
        _path,
        *,
        context,
        binary=None,
        redact_diagnostics=False,
    ):
        assert context == "template 생성 결과"
        assert binary == "/fake/hwp"
        assert redact_diagnostics is True
        destination.write_bytes(b"RACER")
        return {"valid": True, "format": "hwpx"}

    monkeypatch.setattr(hwpx_cli, "_run_hwp", fake_run)
    monkeypatch.setattr(hwpx_cli, "_validate_hwp_json", validate_then_race)
    with pytest.raises(SystemExit) as exc:
        hwpx_cli.cmd_template(_template_args(template, data, destination))
    assert exc.value.code == 2
    assert destination.read_bytes() == b"RACER"


@pytest.mark.skipif(not hasattr(os, "symlink"), reason="symlink unsupported")
def test_template_rejects_symlink_destination_before_native_call(
    tmp_path, monkeypatch
):
    template = tmp_path / "template.json"
    data = tmp_path / "data.json"
    template.write_text("{}", encoding="utf-8")
    data.write_text("{}", encoding="utf-8")
    target = tmp_path / "target.hwpx"
    target.write_bytes(b"TARGET")
    destination = tmp_path / "report.hwpx"
    destination.symlink_to(target)
    monkeypatch.setattr(
        hwpx_cli,
        "_run_hwp",
        lambda *_args, **_kwargs: pytest.fail("native template must not run"),
    )

    with pytest.raises(SystemExit) as exc:
        hwpx_cli.cmd_template(_template_args(template, data, destination))
    assert exc.value.code == 2
    assert target.read_bytes() == b"TARGET"


@pytest.mark.parametrize("output_name", ["report.hwp", "report", "report.zip"])
def test_template_rejects_non_hwpx_output_before_native_call(
    tmp_path, monkeypatch, output_name
):
    template = tmp_path / "template.json"
    data = tmp_path / "data.json"
    template.write_text("{}", encoding="utf-8")
    data.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(
        hwpx_cli,
        "_run_hwp",
        lambda *_args, **_kwargs: pytest.fail("native template must not run"),
    )
    with pytest.raises(SystemExit) as exc:
        hwpx_cli.cmd_template(
            _template_args(template, data, tmp_path / output_name)
        )
    assert exc.value.code == 2


def _stub_template_hwp(path: Path, *, supported: bool) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    help_text = (
        "Usage: hwp template [OPTIONS] --data <DATA> --output <OUTPUT> "
        "<TEMPLATE>\\n--data\\n--output\\n--dry-run\\n--report"
        if supported
        else "Usage: hwp template <TEMPLATE>"
    )
    path.write_text(
        "#!/bin/sh\n"
        'if [ "$1" = "--version" ]; then echo "hwp 9.9.9"; exit 0; fi\n'
        'if [ "$1" = "template" ] && [ "$2" = "--help" ]; then\n'
        f"  printf '%s\\n' '{help_text}'\n"
        "  exit 0\n"
        "fi\n"
        "exit 2\n",
        encoding="utf-8",
    )
    path.chmod(0o755)
    return path


def _clear_template_resolver_caches() -> None:
    hwpx_cli._find_hwp_cli.cache_clear()
    hwpx_cli._find_hwp_cli_with_template.cache_clear()
    hwpx_cli._supports_template.cache_clear()


def test_template_capability_requires_exact_native_surface(tmp_path):
    supported = _stub_template_hwp(tmp_path / "supported", supported=True)
    unsupported = _stub_template_hwp(tmp_path / "unsupported", supported=False)
    _clear_template_resolver_caches()
    try:
        assert hwpx_cli._supports_template(str(supported)) is True
        assert hwpx_cli._supports_template(str(unsupported)) is False
    finally:
        _clear_template_resolver_caches()


def test_explicit_template_incapable_binary_fails_without_fallback(
    tmp_path, monkeypatch, capsys
):
    unsupported = _stub_template_hwp(tmp_path / "hwp", supported=False)
    monkeypatch.setenv("HWP_CLI", str(unsupported))
    _clear_template_resolver_caches()
    try:
        with pytest.raises(SystemExit) as exc:
            hwpx_cli._hwp_cli_or_die(require_template=True)
        assert exc.value.code == 1
        stderr = capsys.readouterr().err
        assert "template TEMPLATE --data DATA -o OUTPUT" in stderr
        assert "TemplateSpec v1" in stderr
        assert "HWP_CLI" in stderr
    finally:
        _clear_template_resolver_caches()


def test_template_fixtures_cover_frozen_v1_value_and_control_surface():
    minimal = json.loads(
        (TEMPLATE_SPEC_FIXTURES / "minimal.json").read_text(encoding="utf-8")
    )
    comprehensive = json.loads(
        (TEMPLATE_SPEC_FIXTURES / "comprehensive.json").read_text(encoding="utf-8")
    )
    for fixture in (minimal, comprehensive):
        assert fixture["version"] == "1.0"
        assert fixture["source"]["mode"] == "compose"
        assert fixture["source"]["document"]["version"] == "1.0"
    assert {
        declaration["type"]
        for declaration in comprehensive["variables"].values()
    } == {"string", "number", "date", "enum", "bool", "rich_blocks", "list"}
    serialized = json.dumps(comprehensive, ensure_ascii=False)
    for node in ('"node": "value"', '"node": "if"', '"node": "each"'):
        assert node in serialized


def test_template_schemas_match_frozen_native_contract_when_source_available():
    source_root = os.environ.get("HWP_CLI_SOURCE")
    schema_dir = (
        Path(source_root) / "schemas"
        if source_root
        else Path.cwd().parent / "hwp-cli" / "schemas"
    )
    expected = {
        "template-spec-v1.schema.json": (
            TEMPLATE_SPEC_V1_SCHEMA_SHA256,
            "https://hwp-cli.dev/schemas/template-spec-v1.schema.json",
        ),
        "template-data-v1.schema.json": (
            TEMPLATE_DATA_V1_SCHEMA_SHA256,
            "https://hwp-cli.dev/schemas/template-data-v1.schema.json",
        ),
        "template-report-v1.schema.json": (
            TEMPLATE_REPORT_V1_SCHEMA_SHA256,
            "https://hwp-cli.dev/schemas/template-report-v1.schema.json",
        ),
    }
    if not all((schema_dir / name).is_file() for name in expected):
        pytest.skip("hwp-cli source schemas are not present in this checkout")
    contracts = {}
    for name, (digest, schema_id) in expected.items():
        raw = (schema_dir / name).read_bytes()
        assert hashlib.sha256(raw).hexdigest() == digest
        contract = json.loads(raw)
        assert contract["$id"] == schema_id
        assert contract["additionalProperties"] is False
        contracts[name] = contract

    template_contract = contracts["template-spec-v1.schema.json"]
    assert template_contract["required"] == ["version", "variables", "source"]
    assert template_contract["properties"]["version"]["const"] == "1.0"
    data_contract = contracts["template-data-v1.schema.json"]
    assert data_contract["required"] == ["version", "values"]
    assert data_contract["properties"]["version"]["const"] == "1.0"

    report_contract = contracts["template-report-v1.schema.json"]
    assert set(report_contract["properties"]) == hwpx_cli._TEMPLATE_REPORT_FIELDS
    optional_report_fields = {"reference_sha256", "output_sha256", "compose"}
    assert set(report_contract["required"]) == (
        hwpx_cli._TEMPLATE_REPORT_FIELDS - optional_report_fields
    )
    for field in ("unsupported", "fallback", "dropped"):
        assert report_contract["properties"][field]["maxItems"] == 0
    assert report_contract["properties"]["template_validation"] == {
        "const": "passed"
    }
    assert report_contract["properties"]["data_validation"] == {
        "const": "passed"
    }


def _native_template_binary() -> str | None:
    binary = hwpx_cli._find_hwp_cli_with_template()
    if binary is None:
        return None
    return binary


def _run_native_template(
    binary: str,
    template: Path,
    data: Path,
    destination: Path,
    *,
    timeout: int = 20,
    dry_run: bool = False,
) -> subprocess.CompletedProcess:
    command = [
        sys.executable,
        str(SCRIPTS / "hwpx_cli.py"),
        "template",
        str(template),
        "--data",
        str(data),
        "--output",
        str(destination),
        "--report",
    ]
    if dry_run:
        command.append("--dry-run")
    return subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=timeout,
        env=dict(os.environ, HWP_CLI=binary),
    )


@pytest.mark.parametrize(
    ("template_name", "data_name"),
    [
        ("minimal.json", "minimal-data.json"),
        ("minimal.yaml", "minimal-data.yaml"),
        ("comprehensive.json", "comprehensive-data.json"),
    ],
)
def test_native_template_fixtures_roundtrip_when_capability_available(
    tmp_path, template_name, data_name
):
    binary = _native_template_binary()
    if binary is None:
        pytest.skip("native hwp template is not available yet")
    destination = tmp_path / f"{Path(template_name).stem}.hwpx"
    proc = _run_native_template(
        binary,
        TEMPLATE_SPEC_FIXTURES / template_name,
        TEMPLATE_SPEC_FIXTURES / data_name,
        destination,
    )
    assert proc.returncode == 0, proc.stderr
    report = json.loads(proc.stdout)
    assert report["output"] == str(destination)
    assert report["template_validation"] == "passed"
    assert report["data_validation"] == "passed"
    assert report["semantic_validation"] == "passed"
    assert report["package_validation"] == "passed"
    assert report["fallback"] == []
    assert report["dropped"] == []
    assert ".template-" not in proc.stdout
    styled.validate_hwpx_package(destination)


def test_native_template_dry_run_reports_not_run_without_publish(
    tmp_path,
):
    binary = _native_template_binary()
    if binary is None:
        pytest.skip("native hwp template is not available yet")
    destination = tmp_path / "existing.hwpx"
    destination.write_bytes(b"ORIGINAL")
    proc = _run_native_template(
        binary,
        TEMPLATE_SPEC_FIXTURES / "minimal.json",
        TEMPLATE_SPEC_FIXTURES / "minimal-data.json",
        destination,
        dry_run=True,
    )
    assert proc.returncode == 0, proc.stderr
    assert destination.read_bytes() == b"ORIGINAL"
    report = json.loads(proc.stdout)
    assert report["output"] == str(destination)
    assert report["dry_run"] is True
    assert report["template_validation"] == "passed"
    assert report["data_validation"] == "passed"
    assert report["semantic_validation"] == "not_run"
    assert report["package_validation"] == "not_run"
    assert "output_sha256" not in report


@pytest.mark.parametrize(
    ("template_name", "data_name"),
    [
        ("invalid-unknown-field.json", "minimal-data.json"),
        ("invalid-expression.json", "minimal-data.json"),
        ("invalid-prototype-key.json", "minimal-data.json"),
        ("string-only.json", "invalid-yaml-coercion-data.yaml"),
        ("rich-blocks.json", "invalid-asset-path-data.json"),
        ("rich-blocks.json", "invalid-rich-style-data.json"),
        (
            "invalid-table-span-after-filter.json",
            "invalid-table-span-after-filter-data.json",
        ),
    ],
)
def test_native_template_adversarial_fixtures_fail_closed_when_capability_available(
    tmp_path, template_name, data_name
):
    binary = _native_template_binary()
    if binary is None:
        pytest.skip("native hwp template is not available yet")
    destination = tmp_path / "existing.hwpx"
    destination.write_bytes(b"ORIGINAL")
    proc = _run_native_template(
        binary,
        TEMPLATE_SPEC_FIXTURES / template_name,
        TEMPLATE_SPEC_FIXTURES / data_name,
        destination,
    )
    assert proc.returncode != 0
    assert destination.read_bytes() == b"ORIGINAL"
    assert "TOPSECRET_CANARY" not in proc.stdout
    assert "TOPSECRET_CANARY" not in proc.stderr
    assert not list(tmp_path.glob(".existing.hwpx.template-*"))


def test_native_template_each_limit_fails_before_publish_when_capability_available(
    tmp_path,
):
    binary = _native_template_binary()
    if binary is None:
        pytest.skip("native hwp template is not available yet")
    data = tmp_path / "too-many-items.json"
    data.write_text(
        json.dumps(
            {
                "version": "1.0",
                "values": {
                    "title": "bounded",
                    "items": [{"label": "item"}] * 10_001,
                },
            }
        ),
        encoding="utf-8",
    )
    destination = tmp_path / "existing.hwpx"
    destination.write_bytes(b"ORIGINAL")
    proc = _run_native_template(
        binary,
        TEMPLATE_SPEC_FIXTURES / "minimal.json",
        data,
        destination,
    )
    assert proc.returncode != 0
    assert destination.read_bytes() == b"ORIGINAL"


def test_native_template_regex_is_linear_time_bounded_when_capability_available(
    tmp_path,
):
    binary = _native_template_binary()
    if binary is None:
        pytest.skip("native hwp template is not available yet")
    template = tmp_path / "regex.json"
    template.write_text(
        json.dumps(
            {
                "version": "1.0",
                "variables": {
                    "value": {
                        "type": "string",
                        "required": True,
                        "regex": "^(a+)+$",
                    }
                },
                "source": {
                    "mode": "compose",
                    "document": {
                        "version": "1.0",
                        "sections": [{"blocks": []}],
                    },
                },
            }
        ),
        encoding="utf-8",
    )
    data = tmp_path / "regex-data.json"
    data.write_text(
        json.dumps(
            {
                "version": "1.0",
                "values": {"value": ("a" * 100_000) + "!"},
            }
        ),
        encoding="utf-8",
    )
    destination = tmp_path / "existing.hwpx"
    destination.write_bytes(b"ORIGINAL")
    proc = _run_native_template(
        binary,
        template,
        data,
        destination,
        timeout=10,
    )
    assert proc.returncode != 0
    assert destination.read_bytes() == b"ORIGINAL"


def _raw_zip_member(path: Path, info: zipfile.ZipInfo) -> bytes:
    with path.open("rb") as source:
        source.seek(info.header_offset)
        header = source.read(30)
        fields = struct.unpack("<IHHHHHIIIHH", header)
        assert fields[0] == 0x04034B50
        name_length, extra_length = fields[-2:]
        source.seek(name_length + extra_length, os.SEEK_CUR)
        return source.read(info.compress_size)


def _multi_section_reference(path: Path) -> None:
    with zipfile.ZipFile(TEMPLATE) as source:
        entries = [(info, source.read(info.filename)) for info in source.infolist()]
    section0 = dict((info.filename, data) for info, data in entries)[
        "Contents/section0.xml"
    ]
    section1 = re.sub(rb"\{\{[^{}]+\}\}", b"UNTOUCHED", section0)
    with zipfile.ZipFile(path, "w") as destination:
        for info, data in entries:
            if info.filename == "Contents/content.hpf":
                data = data.replace(
                    b'<opf:item id="section0" href="Contents/section0.xml" '
                    b'media-type="application/xml"/>',
                    b'<opf:item id="section0" href="Contents/section0.xml" '
                    b'media-type="application/xml"/>'
                    b'<opf:item id="section1" href="Contents/section1.xml" '
                    b'media-type="application/xml"/>',
                ).replace(
                    b'<opf:itemref idref="section0" linear="yes"/>',
                    b'<opf:itemref idref="section0" linear="yes"/>'
                    b'<opf:itemref idref="section1" linear="yes"/>',
                )
            destination.writestr(info, data)
        section1_info = zipfile.ZipInfo(
            "Contents/section1.xml",
            date_time=(2024, 2, 4, 6, 8, 10),
        )
        section1_info.compress_type = zipfile.ZIP_STORED
        section1_info.comment = b"raw-preservation-canary"
        section1_info.external_attr = 0o640 << 16
        destination.writestr(section1_info, section1)


def test_native_template_reference_changes_only_target_section_raw_bytes(
    tmp_path,
):
    binary = _native_template_binary()
    if binary is None:
        pytest.skip("native hwp template is not available yet")
    reference = tmp_path / "reference.hwpx"
    _multi_section_reference(reference)
    styled.validate_hwpx_package(reference)
    native_reference_validation = subprocess.run(
        [binary, "validate", str(reference), "--json"],
        capture_output=True,
        text=True,
    )
    assert native_reference_validation.returncode == 0, (
        native_reference_validation.stderr
    )

    template = tmp_path / "reference-template.json"
    template.write_text(
        json.dumps(
            {
                "version": "1.0",
                "variables": {"title": {"type": "string", "required": True}},
                "source": {
                    "mode": "reference_hwpx",
                    "path": "reference.hwpx",
                    "bindings": [
                        {
                            "region": "title",
                            "variable": "title",
                            "target": "placeholder",
                            "name": "제목",
                        }
                    ],
                },
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    data = tmp_path / "reference-data.json"
    data.write_text(
        json.dumps(
            {"version": "1.0", "values": {"title": "치환된 제목"}},
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    destination = tmp_path / "reference-output.hwpx"
    proc = _run_native_template(binary, template, data, destination)
    assert proc.returncode == 0, proc.stderr
    report = json.loads(proc.stdout)
    assert report["mode"] == "reference_package_preserving"
    assert [region["id"] for region in report["changed_regions"]] == ["title"]
    assert report["fallback"] == []
    assert report["dropped"] == []

    with zipfile.ZipFile(reference) as before, zipfile.ZipFile(destination) as after:
        before_infos = {info.filename: info for info in before.infolist()}
        after_infos = {info.filename: info for info in after.infolist()}
        assert list(before_infos) == list(after_infos)
        assert b"UNTOUCHED" in after.read("Contents/section1.xml")
        for name, before_info in before_infos.items():
            if name == "Contents/section0.xml":
                continue
            after_info = after_infos[name]
            before_metadata = (
                before_info.CRC,
                before_info.compress_size,
                before_info.file_size,
                before_info.compress_type,
                before_info.date_time,
                before_info.flag_bits,
                before_info.external_attr,
                before_info.internal_attr,
                before_info.extra,
                before_info.comment,
            )
            after_metadata = (
                after_info.CRC,
                after_info.compress_size,
                after_info.file_size,
                after_info.compress_type,
                after_info.date_time,
                after_info.flag_bits,
                after_info.external_attr,
                after_info.internal_attr,
                after_info.extra,
                after_info.comment,
            )
            assert before_metadata == after_metadata, name
            assert _raw_zip_member(reference, before_info) == _raw_zip_member(
                destination, after_info
            )


def _write_certification_tree(root: Path, *, mutate=None) -> dict:
    page = b"\x89PNG\r\n\x1a\n"
    page_sha256 = hashlib.sha256(page).hexdigest()
    empty_issue_sha256 = hashlib.sha256(
        b"hwp-render-typed-issues-v1\0"
    ).hexdigest()
    empty_sha256 = hashlib.sha256(b"").hexdigest()
    rules = [
        {
            "id": rule_id,
            "status": "passed",
            "observed_count": 0,
            "reason_codes": [],
        }
        for rule_id in certification.RULE_IDS
    ]
    report = {
        "schema_version": "1.0",
        "contract": "hwp-certification-report-v1",
        "overall": "passed",
        "scope": "native_only",
        "input": {
            "format": "hwpx",
            "bytes": 0,
            "sha256": empty_sha256,
        },
        "policy_sha256": empty_sha256,
        "checks": {
            "package": {
                "status": "passed",
                "reason_codes": [],
                "issue_count": 0,
                "issue_sha256": empty_sha256,
            },
            "repeat_import_consistency": {
                "status": "passed",
                "reason_codes": [],
                "issue_count": 0,
                "issue_sha256": empty_sha256,
            },
            "rules": rules,
        },
        "render": {
            "profile": "hwp-cli-native-certification-render-v1",
            "dpi": 96.0,
            "total_pages": 1,
            "selected_pages": [1],
            "status": "passed",
            "reason_codes": [],
            "fonts": [],
            "pages": [
                {
                    "page": 1,
                    "width_pt": 595.28,
                    "height_pt": 841.86,
                    "item_count": 0,
                    "visual_blank": True,
                    "outside_page_bounds": {
                        "result": "not_detected",
                        "count": 0,
                        "algorithm": "display_item_finite_bbox_vs_page_rect_v1",
                        "complete": True,
                    },
                    "possible_collision": {
                        "result": "not_detected",
                        "count": 0,
                        "algorithm": (
                            "cross_baseline_glyph_bbox_overlap_ge_0_25_v1"
                        ),
                        "complete": True,
                    },
                    "png_sha256": page_sha256,
                    "png_bytes": len(page),
                }
            ],
            "issues": [],
            "info": [],
            "issue_count": 0,
            "info_count": 0,
            "issue_log_complete": True,
            "issue_sha256": empty_issue_sha256,
        },
        "oracle": {
            "mode": "disabled",
            "status": "disabled",
            "reason_code": None,
            "expected": None,
            "observed": None,
            "stdout": None,
            "stderr": None,
            "artifact_determinism": "not_applicable",
        },
        "artifacts": [
            {
                "path": "pages/page-000001.png",
                "bytes": len(page),
                "sha256": page_sha256,
                "deterministic": True,
            }
        ],
        "limitations": list(certification.LIMITATIONS),
    }
    if mutate is not None:
        mutate(report)
    root.mkdir()
    pages = root / "pages"
    pages.mkdir()
    (pages / "page-000001.png").write_bytes(page)
    report_bytes = (
        json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    ).encode()
    (root / "report.json").write_bytes(report_bytes)
    report_entry = {
        "path": "report.json",
        "bytes": len(report_bytes),
        "sha256": hashlib.sha256(report_bytes).hexdigest(),
        "deterministic": True,
    }
    manifest = {
        "schema_version": "1.0",
        "contract": "hwp-certification-artifact-manifest-v1",
        "artifact_count": 3,
        "total_bytes": 0,
        "files": sorted(
            [*report["artifacts"], report_entry], key=lambda item: item["path"]
        ),
        "self": {
            "path": "manifest.json",
            "bytes": 0,
            "sha256": None,
            "deterministic": True,
            "reason": "self_hash_not_representable",
        },
    }
    for _ in range(16):
        manifest["total_bytes"] = len(page) + len(report_bytes) + manifest["self"]["bytes"]
        manifest_bytes = (
            json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
        ).encode()
        if len(manifest_bytes) == manifest["self"]["bytes"]:
            break
        manifest["self"]["bytes"] = len(manifest_bytes)
    else:
        raise AssertionError("manifest length did not converge")
    (root / "manifest.json").write_bytes(manifest_bytes)
    return report


def _clear_certify_resolver_caches() -> None:
    hwpx_cli._find_hwp_cli.cache_clear()
    hwpx_cli._find_hwp_cli_with_certify.cache_clear()
    hwpx_cli._supports_certify.cache_clear()


def _stub_certify_hwp(path: Path, usage: str) -> Path:
    path.write_text(
        "#!/bin/sh\n"
        'if [ "$1" = "--version" ]; then echo "hwp 9.9.9"; exit 0; fi\n'
        'if [ "$1" = "certify" ] && [ "$2" = "--help" ]; then\n'
        f"  printf '%s\\n' '{usage}' '--policy <POLICY>' '--report <REPORT>'\n"
        "  exit 0\n"
        "fi\n"
        "exit 2\n",
        encoding="utf-8",
    )
    path.chmod(0o755)
    return path


def test_certification_frozen_schema_hashes_match_source_when_available():
    source_root = os.environ.get("HWP_CLI_SOURCE")
    schema_dir = (
        Path(source_root) / "schemas"
        if source_root
        else Path.cwd().parent / "hwp-cli" / "schemas"
    )
    expected = {
        "certification-policy-v1.schema.json": certification.POLICY_SCHEMA_SHA256,
        "certification-report-v1.schema.json": certification.REPORT_SCHEMA_SHA256,
        "certification-oracle-result-v1.schema.json": certification.ORACLE_SCHEMA_SHA256,
    }
    if not all((schema_dir / name).is_file() for name in expected):
        if os.environ.get("HWPX_REQUIRE_CERTIFY") == "1":
            pytest.fail("HWPX_REQUIRE_CERTIFY=1 requires all frozen source schemas")
        pytest.skip("hwp-cli certification schemas are not present")
    for name, expected_sha256 in expected.items():
        assert hashlib.sha256((schema_dir / name).read_bytes()).hexdigest() == expected_sha256


def test_certify_capability_requires_exact_frozen_usage(tmp_path):
    exact = _stub_certify_hwp(
        tmp_path / "exact",
        "Usage: hwp certify --policy <POLICY> --report <REPORT> <INPUT>",
    )
    reordered = _stub_certify_hwp(
        tmp_path / "reordered",
        "Usage: hwp certify <INPUT> --policy <POLICY> --report <REPORT>",
    )
    _clear_certify_resolver_caches()
    try:
        assert hwpx_cli._supports_certify(str(exact)) is True
        assert hwpx_cli._supports_certify(str(reordered)) is False
    finally:
        _clear_certify_resolver_caches()


def test_explicit_certify_incapable_binary_fails_without_fallback(
    tmp_path, monkeypatch, capsys
):
    unsupported = _stub_certify_hwp(
        tmp_path / "hwp",
        "Usage: hwp certify <INPUT> --policy <POLICY> --report <REPORT>",
    )
    monkeypatch.setenv("HWP_CLI", str(unsupported))
    _clear_certify_resolver_caches()
    try:
        with pytest.raises(SystemExit) as exc:
            hwpx_cli._hwp_cli_or_die(require_certify=True)
        assert exc.value.code == 1
        assert "certification v1" in capsys.readouterr().err
    finally:
        _clear_certify_resolver_caches()


def test_certification_validator_accepts_exact_native_only_tree(tmp_path):
    root = tmp_path / "report"
    expected = _write_certification_tree(root)
    assert certification.validate_certification_directory(root) == expected


@pytest.mark.parametrize(
    "mutate",
    [
        lambda report: report.__setitem__("secret", "TOPSECRET_CANARY"),
        lambda report: report["render"].__setitem__("issue_sha256", "0" * 64),
        lambda report: report.__setitem__("limitations", 7),
    ],
)
def test_certification_validator_rejects_malformed_closed_report(tmp_path, mutate):
    root = tmp_path / "report"
    _write_certification_tree(root, mutate=mutate)
    with pytest.raises(certification.ContractError):
        certification.validate_certification_directory(root)


def test_certification_validator_rejects_manifest_type_confusion(tmp_path):
    root = tmp_path / "report"
    _write_certification_tree(root)
    manifest_path = root / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["artifact_count"] = "3"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(certification.ContractError):
        certification.validate_certification_directory(root)


def test_certification_validator_rejects_unmanifested_file(tmp_path):
    root = tmp_path / "report"
    _write_certification_tree(root)
    (root / "TOPSECRET_CANARY").write_text("secret", encoding="utf-8")
    with pytest.raises(certification.ContractError):
        certification.validate_certification_directory(root)


def test_certification_validator_rejects_duplicate_json_keys(tmp_path):
    root = tmp_path / "report"
    _write_certification_tree(root)
    report_path = root / "report.json"
    report_path.write_bytes(
        report_path.read_bytes().replace(
            b'"artifacts":',
            b'"artifacts": [], "artifacts":',
            1,
        )
    )
    with pytest.raises(certification.ContractError):
        certification.validate_certification_directory(root)


@pytest.mark.skipif(not hasattr(os, "symlink"), reason="symlink unsupported")
def test_certification_validator_rejects_symlink(tmp_path):
    root = tmp_path / "report"
    _write_certification_tree(root)
    (root / "link").symlink_to(root / "report.json")
    with pytest.raises(certification.ContractError):
        certification.validate_certification_directory(root)


@pytest.mark.skipif(not hasattr(os, "link"), reason="hardlink unsupported")
def test_certification_validator_rejects_hardlink(tmp_path):
    root = tmp_path / "report"
    _write_certification_tree(root)
    os.link(root / "pages" / "page-000001.png", root / "hardlink")
    with pytest.raises(certification.ContractError):
        certification.validate_certification_directory(root)


def test_certification_validator_enforces_259_file_tree_cap(tmp_path):
    root = tmp_path / "report"
    _write_certification_tree(root)
    for index in range(certification.MAX_TREE_FILES - 2):
        (root / f"extra-{index:03}.bin").write_bytes(b"")
    with pytest.raises(certification.ContractError):
        certification.validate_certification_directory(root)


def _native_certify_binary() -> str | None:
    binary = hwpx_cli._find_hwp_cli_with_certify()
    if binary is None and os.environ.get("HWPX_REQUIRE_CERTIFY") == "1":
        pytest.fail("HWPX_REQUIRE_CERTIFY=1 but the exact certify capability is absent")
    return binary


@pytest.mark.parametrize(
    ("policy_name", "expected_code", "expected_overall"),
    [
        ("native-only.json", 0, "passed"),
        ("required-unavailable.json", 1, "partial"),
    ],
)
def test_native_certify_handoff_preserves_result_and_validates_tree(
    tmp_path, policy_name, expected_code, expected_overall
):
    binary = _native_certify_binary()
    if binary is None:
        pytest.skip("native hwp certify is not available yet")
    source = tmp_path / "input.hwpx"
    created = subprocess.run(
        [binary, "new", "-o", str(source)],
        capture_output=True,
        text=True,
    )
    assert created.returncode == 0, created.stderr
    report_dir = tmp_path / "report"
    env = dict(os.environ, HWP_CLI=binary)
    for name in (
        "HWP_CERTIFY_ORACLE_RUNTIME",
        "HWP_CERTIFY_ORACLE_EXTENSION",
        "HWP_CERTIFY_ORACLE_IMAGE",
        "HWP_CERTIFY_ORACLE_DOCKER_CLIENT_VERSION",
        "HWP_CERTIFY_ORACLE_DOCKER_SERVER_VERSION",
        "HWP_CERTIFY_ORACLE_IMAGE_ID",
    ):
        env.pop(name, None)
    proc = subprocess.run(
        [
            sys.executable,
            str(SCRIPTS / "hwpx_cli.py"),
            "certify",
            str(source),
            "--policy",
            str(CERTIFICATION_FIXTURES / policy_name),
            "--report",
            str(report_dir),
        ],
        capture_output=True,
        text=True,
        env=env,
    )
    assert proc.returncode == expected_code, proc.stderr
    assert json.loads(proc.stdout)["overall"] == expected_overall
    validated = certification.validate_certification_directory(report_dir)
    assert validated["overall"] == expected_overall


def test_certify_wrapper_never_forwards_native_diagnostics(
    tmp_path, monkeypatch, capsys
):
    source = tmp_path / "input.hwpx"
    policy = tmp_path / "policy.json"
    source.write_bytes(b"input")
    policy.write_text("{}", encoding="utf-8")
    report = tmp_path / "report"

    def fake_run(*_args, **_kwargs):
        return subprocess.CompletedProcess(
            ["hwp", "certify"],
            1,
            "TOPSECRET_CANARY_STDOUT",
            "TOPSECRET_CANARY_STDERR",
        )

    monkeypatch.setattr(hwpx_cli, "_run_hwp", fake_run)
    args = argparse.Namespace(file=str(source), policy=str(policy), report=str(report))
    with pytest.raises(SystemExit) as exc:
        hwpx_cli.cmd_certify(args)
    assert exc.value.code == 2
    captured = capsys.readouterr()
    assert "TOPSECRET_CANARY" not in captured.out
    assert "TOPSECRET_CANARY" not in captured.err
