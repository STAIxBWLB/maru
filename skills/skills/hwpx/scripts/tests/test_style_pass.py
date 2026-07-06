"""style_pass(공문서 기본 스타일 후처리) 계약 테스트.

`hwp new` 산출물에 패스를 적용해 corpus 관례가 실제 XML에 반영되는지 고정한다:
칼럼 폭(총폭 보존·라벨 클램프·균등 유지), 헤더행 음영/굵게/가운데, itemCnt 정합,
멱등성(2회 적용 byte-stable), --plain 시 순정과 동일.

Hermetic: pytest tmp dir. hwp-cli 부재 시 skip.
Run: ~/.anchor/env/.venv/bin/python3 -m pytest scripts/tests/test_style_pass.py
"""
from __future__ import annotations

import hashlib
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest
from lxml import etree

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
import hwpx_cli  # noqa: E402
import hwpx_xml as hx  # noqa: E402
import style_pass  # noqa: E402

HAVE_CLI = hwpx_cli._find_hwp_cli() is not None
requires_cli = pytest.mark.skipif(not HAVE_CLI, reason="hwp-cli('hwp') not installed")

MD = """# 제목 문서

본문 문단.

| 항목 | 내용 |
|------|------|
| 사업명 | 지역혁신중심 대학지원체계 구축 사업 장문 값 |
| 기간 | 2026. 3. ~ 2027. 2. |

| 번호 | 항목 | 내용 | 비고 |
|------|------|------|------|
| 1 | 과정 | 아주 길게 서술되는 내용 칼럼 텍스트 열두어 글자 이상 | 완료 |

| 구분A | 구분B | 구분C |
|------|------|------|
| 내용가 | 내용나 | 내용다 |
"""


def _new(tmp: Path, name: str) -> Path:
    md = tmp / "t.md"
    md.write_text(MD, encoding="utf-8")
    out = tmp / name
    tool = hwpx_cli._find_hwp_cli()
    subprocess.run([tool, "new", "--from", str(md), "-o", str(out)], check=True)
    return out


def _entry(path: Path, name: str) -> etree._Element:
    with zipfile.ZipFile(path) as z:
        return hx.parse_xml(z.read(name)).getroot()


def _tables(sec_root):
    return [e for e in sec_root.iter() if hx.localname(e) == "tbl"]


def _row_widths(tbl, row: int) -> list[int]:
    out = []
    for tc in tbl.iter():
        if hx.localname(tc) != "tc":
            continue
        addr = next(c for c in tc if hx.localname(c) == "cellAddr")
        if int(addr.get("rowAddr")) != row:
            continue
        sz = next(c for c in tc if hx.localname(c) == "cellSz")
        out.append((int(addr.get("colAddr")), int(sz.get("width"))))
    return [w for _, w in sorted(out)]


@requires_cli
def test_widths_header_title_and_itemcnt(tmp_path):
    f = _new(tmp_path, "styled.hwpx")
    # 순정 generator charPr 수(버전마다 달라짐) — style_pass는 여기서 늘리지 않아야.
    raw_head = _entry(f, "Contents/header.xml")
    raw_charpr = len(next(e for e in raw_head.iter() if hx.localname(e) == "charProperties"))
    stats = style_pass.apply_default_style(f)
    assert stats["tables"] == 3 and stats["title_centered"]

    sec = _entry(f, "Contents/section0.xml")
    t_label, t_mixed, t_uniform = _tables(sec)

    # 2col 라벨:값 — 라벨 클램프 + 총폭 보존
    w = _row_widths(t_label, 0)
    assert style_pass.LABEL_MIN <= w[0] <= style_pass.LABEL_MAX
    assert sum(w) == 42520
    # 4col — 좁은 칼럼 바닥 + 내용 칼럼 최광 + 총폭 보존
    w4 = _row_widths(t_mixed, 0)
    assert sum(w4) == 42520 and min(w4) >= style_pass.MIN_COL_HWPU
    assert max(w4) == w4[2]
    # 균등 내용 표는 불변(균등 유지)
    wu = _row_widths(t_uniform, 0)
    assert max(wu) - min(wu) <= 2

    # 헤더행 음영 + 본문행은 원래 borderFill 유지
    head = _entry(f, "Contents/header.xml")
    bfs = next(e for e in head.iter() if hx.localname(e) == "borderFills")
    assert bfs.get("itemCnt") == str(len(bfs))
    shaded = [
        c
        for c in bfs
        if any(
            hx.localname(x) == "winBrush" and x.get("faceColor") == "#F2F2F2"
            for x in c.iter()
        )
    ]
    assert len(shaded) == 1
    sid = shaded[0].get("id")
    for tbl in (t_label, t_mixed, t_uniform):
        for tc in tbl.iter():
            if hx.localname(tc) != "tc":
                continue
            addr = next(c for c in tc if hx.localname(c) == "cellAddr")
            expect = sid if addr.get("rowAddr") == "0" else "3"
            assert tc.get("borderFillIDRef") == expect

    # CENTER paraPr 추가 + itemCnt 정합, 제목 15pt(charPr height 1500 bold 재사용)
    pps = next(e for e in head.iter() if hx.localname(e) == "paraProperties")
    assert pps.get("itemCnt") == str(len(pps))
    centers = [
        p
        for p in pps
        if any(
            hx.localname(a) == "align" and a.get("horizontal") == "CENTER" for a in p
        )
    ]
    assert centers
    cps = next(e for e in head.iter() if hx.localname(e) == "charProperties")
    # itemCnt 정합 + style_pass가 charPr을 새로 만들지 않음(제목 15pt = 기존 charPr 재사용).
    assert cps.get("itemCnt") == str(len(cps)) == str(raw_charpr)
    title_p = next(p for p in sec if hx.localname(p) == "p")
    title_run = next(r for r in title_p if hx.localname(r) == "run")
    title_cp = next(c for c in cps if c.get("id") == title_run.get("charPrIDRef"))
    assert title_cp.get("height") == str(style_pass.TITLE_HEIGHT)


@requires_cli
def test_idempotent_and_valid(tmp_path):
    f = _new(tmp_path, "idem.hwpx")
    style_pass.apply_default_style(f)
    h1 = hashlib.sha256(f.read_bytes()).hexdigest()
    stats2 = style_pass.apply_default_style(f)
    assert hashlib.sha256(f.read_bytes()).hexdigest() == h1
    assert stats2["widths_changed"] == 0
    assert stats2["header_cells"] == 0
    assert stats2["body_centered"] == 0
    assert not stats2["title_centered"]
    tool = hwpx_cli._find_hwp_cli()
    assert subprocess.run([tool, "validate", str(f)], capture_output=True).returncode == 0


@requires_cli
def test_plain_matches_raw_generator(tmp_path):
    raw = _new(tmp_path, "raw.hwpx")
    out = tmp_path / "plain.hwpx"
    rc = subprocess.run(
        [
            sys.executable,
            str(SCRIPTS / "hwpx_cli.py"),
            "create",
            str(out),
            "--markdown",
            str(tmp_path / "t.md"),
            "--plain",
        ],
        capture_output=True,
        text=True,
    )
    assert rc.returncode == 0, rc.stderr
    for entry in ("Contents/header.xml", "Contents/section0.xml"):
        with zipfile.ZipFile(raw) as a, zipfile.ZipFile(out) as b:
            assert a.read(entry) == b.read(entry)
