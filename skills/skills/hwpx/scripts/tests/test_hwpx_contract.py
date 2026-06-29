"""Contract / delegation tests for the hwpx skill's python layer.

The skill delegates generation·conversion·render·validation to the Rust hwp-cli
(`hwp`) and keeps lxml only for slot/structure surgery. These tests pin that
contract:

  * read / to-md fall back to the lxml extractor when hwp-cli is unavailable.
  * validate exit-code contract (valid -> 0, corrupt -> nonzero).
  * fill / slots delegate to hwp-cli and their JSON output parses.
  * styled --reference uses the lxml path and yields a valid hwpx.

Hermetic: every write lands in a pytest tmp dir; the real fixture is a bundled
template under templates/. hwp-cli-only cases skip when `hwp` is absent.

Run: ~/.anchor/env/.venv/bin/python3 -m pytest scripts/tests
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1]          # .../hwpx/scripts
SKILL = SCRIPTS.parent                                  # .../hwpx
TEMPLATE = SKILL / "templates" / "공문서_기본.hwpx"      # real {{slot}} fixture

sys.path.insert(0, str(SCRIPTS))
import hwpx_cli  # noqa: E402

HAVE_CLI = hwpx_cli._find_hwp_cli() is not None
requires_cli = pytest.mark.skipif(not HAVE_CLI, reason="hwp-cli('hwp') not installed")


def _run(*subargs: str) -> subprocess.CompletedProcess:
    """Invoke the dispatcher out-of-process so we observe the real exit code."""
    return subprocess.run(
        [sys.executable, str(SCRIPTS / "hwpx_cli.py"), *subargs],
        capture_output=True,
        text=True,
    )


def test_fixture_exists():
    assert TEMPLATE.is_file(), f"missing test fixture: {TEMPLATE}"


# --- engine fallback: hwp-cli unavailable -> pure-lxml extraction ----------------

def test_read_text_falls_back_to_lxml(monkeypatch, capsys):
    monkeypatch.setattr(hwpx_cli, "_find_hwp_cli", lambda: None)
    # the cli probe must signal "fall back" by returning None
    assert hwpx_cli._hwpx_text_via_cli(TEMPLATE, "plain") is None
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
