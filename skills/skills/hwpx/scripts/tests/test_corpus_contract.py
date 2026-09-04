from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))

import corpus_contract as corpus
import hwpx_cli


def _clear_corpus_caches() -> None:
    hwpx_cli._find_hwp_cli.cache_clear()
    hwpx_cli._find_hwp_cli_with_corpus.cache_clear()
    hwpx_cli._supports_corpus.cache_clear()


def _stub_corpus_hwp(path: Path, usage: str) -> Path:
    path.write_text(
        "#!/bin/sh\n"
        'if [ "$1" = "--version" ]; then echo "hwp 9.9.9"; exit 0; fi\n'
        'if [ "$1" = "corpus" ] && [ "$2" = "--help" ]; then\n'
        f"  printf '%s\\n' '{usage}' '--manifest <MANIFEST>' '--report <REPORT>'\n"
        "  exit 0\n"
        "fi\n"
        "exit 2\n",
        encoding="utf-8",
    )
    path.chmod(0o755)
    return path


def _corpus_source_root() -> Path:
    configured = os.environ.get("HWP_CLI_SOURCE")
    return Path(configured) if configured else Path.cwd().parent / "hwp-cli"


def test_corpus_frozen_schema_hashes_match_source_when_available():
    schema_dir = _corpus_source_root() / "schemas"
    expected = {
        "structured-corpus-v1.schema.json": corpus.MANIFEST_SCHEMA_SHA256,
        "structured-corpus-run-v1.schema.json": corpus.RUN_SCHEMA_SHA256,
        "structured-corpus-artifacts-v1.schema.json": corpus.ARTIFACTS_SCHEMA_SHA256,
    }
    if not all((schema_dir / name).is_file() for name in expected):
        if os.environ.get("HWPX_REQUIRE_CORPUS") == "1":
            pytest.fail("HWPX_REQUIRE_CORPUS=1 requires all frozen source schemas")
        pytest.skip("hwp-cli structured corpus schemas are not present")
    for name, expected_sha256 in expected.items():
        observed = hashlib.sha256((schema_dir / name).read_bytes()).hexdigest()
        assert observed == expected_sha256


def test_corpus_parser_contract_is_exact():
    args = hwpx_cli._build_parser().parse_args(
        ["corpus", "--manifest", "manifest.json", "--report", "new-report"]
    )
    assert args.func is hwpx_cli.cmd_corpus
    assert args.manifest == "manifest.json"
    assert args.report == "new-report"


def test_corpus_capability_requires_exact_frozen_usage(tmp_path):
    exact = _stub_corpus_hwp(
        tmp_path / "exact",
        "Usage: hwp corpus --manifest <MANIFEST> --report <REPORT>",
    )
    reordered = _stub_corpus_hwp(
        tmp_path / "reordered",
        "Usage: hwp corpus --report <REPORT> --manifest <MANIFEST>",
    )
    _clear_corpus_caches()
    try:
        assert hwpx_cli._supports_corpus(str(exact)) is True
        assert hwpx_cli._supports_corpus(str(reordered)) is False
    finally:
        _clear_corpus_caches()


def test_explicit_corpus_incapable_binary_fails_without_fallback(
    tmp_path, monkeypatch, capsys
):
    unsupported = _stub_corpus_hwp(
        tmp_path / "hwp",
        "Usage: hwp corpus --report <REPORT> --manifest <MANIFEST>",
    )
    monkeypatch.setenv("HWP_CLI", str(unsupported))
    _clear_corpus_caches()
    try:
        with pytest.raises(SystemExit) as exc:
            hwpx_cli._hwp_cli_or_die(require_corpus=True)
        assert exc.value.code == 1
        assert "structured corpus v1" in capsys.readouterr().err
    finally:
        _clear_corpus_caches()


def test_corpus_environment_removes_ambient_font_overrides(monkeypatch):
    monkeypatch.setenv("HWP_FONT_DIR", "/ambient/fonts")
    monkeypatch.setenv("FONTCONFIG_FILE", "/ambient/fonts.conf")
    monkeypatch.setenv("FONTCONFIG_PATH", "/ambient/fontconfig")
    normal = hwpx_cli._hwp_env()
    isolated = hwpx_cli._hwp_env(isolated_fonts=True)
    assert normal["HWP_FONT_DIR"] == "/ambient/fonts"
    assert "HWP_FONT_DIR" not in isolated
    assert "FONTCONFIG_FILE" not in isolated
    assert "FONTCONFIG_PATH" not in isolated


def test_corpus_wrapper_validates_before_printing(tmp_path, monkeypatch, capsys):
    manifest = tmp_path / "manifest.json"
    manifest.write_text("{}", encoding="utf-8")
    report = tmp_path / "report"

    def fake_run(argv, **kwargs):
        assert argv == [
            "corpus",
            "--manifest",
            str(manifest),
            "--report",
            str(report),
        ]
        assert kwargs["require_corpus"] is True
        assert kwargs["redact_failure_output"] is True
        assert kwargs["isolated_fonts"] is True
        report.mkdir()
        return subprocess.CompletedProcess(["hwp", *argv], 0, "", "")

    monkeypatch.setattr(hwpx_cli, "_run_hwp", fake_run)
    monkeypatch.setattr(
        corpus,
        "validate_corpus_directory",
        lambda observed_report, observed_manifest: {
            "status": "passed",
            "report": str(observed_report),
            "manifest": str(observed_manifest),
        },
    )
    assert hwpx_cli.cmd_corpus(
        argparse.Namespace(manifest=str(manifest), report=str(report))
    ) == 0
    printed = json.loads(capsys.readouterr().out)
    assert printed["status"] == "passed"


def test_corpus_contract_rejection_without_report_preserves_native_exit(
    tmp_path, monkeypatch
):
    manifest = tmp_path / "manifest.json"
    manifest.write_text("{}", encoding="utf-8")
    report = tmp_path / "report"
    monkeypatch.setattr(
        hwpx_cli,
        "_run_hwp",
        lambda *_args, **_kwargs: subprocess.CompletedProcess(["hwp"], 7, "", ""),
    )
    assert hwpx_cli.cmd_corpus(
        argparse.Namespace(manifest=str(manifest), report=str(report))
    ) == 7
    assert not report.exists()


def test_corpus_completed_failure_preserves_native_exit(tmp_path, monkeypatch, capsys):
    manifest = tmp_path / "manifest.json"
    manifest.write_text("{}", encoding="utf-8")
    report = tmp_path / "report"

    def fake_run(*_args, **_kwargs):
        report.mkdir()
        return subprocess.CompletedProcess(["hwp"], 9, "", "")

    monkeypatch.setattr(hwpx_cli, "_run_hwp", fake_run)
    monkeypatch.setattr(
        corpus,
        "validate_corpus_directory",
        lambda *_args: {"status": "failed"},
    )
    assert hwpx_cli.cmd_corpus(
        argparse.Namespace(manifest=str(manifest), report=str(report))
    ) == 9
    assert json.loads(capsys.readouterr().out) == {"status": "failed"}


def test_corpus_existing_report_is_rejected_before_native_call(
    tmp_path, monkeypatch, capsys
):
    manifest = tmp_path / "manifest.json"
    manifest.write_text("{}", encoding="utf-8")
    report = tmp_path / "report"
    report.mkdir()
    monkeypatch.setattr(
        hwpx_cli,
        "_run_hwp",
        lambda *_args, **_kwargs: pytest.fail("native corpus must not run"),
    )
    with pytest.raises(SystemExit) as exc:
        hwpx_cli.cmd_corpus(
            argparse.Namespace(manifest=str(manifest), report=str(report))
        )
    assert exc.value.code == 2
    assert "존재하지 않는 새 경로" in capsys.readouterr().err


def test_corpus_contract_rejects_paths_and_type_confusion():
    for path in (
        "../escape.json",
        "/absolute.json",
        "documents\\case\\run-a.hwpx",
        "documents/CON/run-a.hwpx",
        "documents/case./run-a.hwpx",
        "documents/case/run-a.hwpx:stream",
    ):
        with pytest.raises(corpus.ContractError):
            corpus._portable_path(path)
    with pytest.raises(corpus.ContractError):
        corpus._integer(True)


def test_native_corpus_roundtrip_when_required(tmp_path, monkeypatch, capsys):
    if os.environ.get("HWPX_REQUIRE_CORPUS") != "1":
        pytest.skip("native structured corpus gate is opt-in")
    root = _corpus_source_root()
    manifest = root / "corpus/structured-v1/manifest.json"
    assert manifest.is_file(), "HWPX_REQUIRE_CORPUS=1 requires the frozen manifest"
    binary = hwpx_cli._find_hwp_cli_with_corpus()
    assert binary, "HWPX_REQUIRE_CORPUS=1 requires the exact native corpus surface"
    monkeypatch.setenv("HWP_CLI", binary)
    _clear_corpus_caches()
    report = tmp_path / "corpus-report"
    assert hwpx_cli.cmd_corpus(
        argparse.Namespace(manifest=str(manifest), report=str(report))
    ) == 0
    summary = json.loads(capsys.readouterr().out)
    assert summary["status"] == "passed"
    assert len(summary["cases"]) == 7
