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

Run: ~/.maru/env/.venv/bin/python3 -m pytest scripts/tests
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
