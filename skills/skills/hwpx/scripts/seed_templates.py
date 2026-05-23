#!/usr/bin/env python3
"""Seed the six skill templates.

These are MVP placeholder templates: structurally valid HWPX with
{{anchor}} placeholders in the right positions, generated through the
bundled Java writer. Style/font fine-tuning (font table, margins, 160%
line spacing, 함초롬바탕/맑은고딕 registration) is defer-able. The output
renders with default Hancom fonts and can be refined by opening in
Hancom Office and saving.

Run: python3 scripts/seed_templates.py
Outputs: templates/*.hwpx (overwrites).

For production 공문서, replace these seeds with templates exported from
Hancom Office (keep the anchor names identical so fill_template.py keeps
working).
"""
from __future__ import annotations

import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from write_java import write_java  # noqa: E402

TEMPLATES_DIR = Path(__file__).resolve().parent.parent / "templates"
TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)


def _save(paragraphs: list[str], name: str) -> None:
    out = TEMPLATES_DIR / name
    lines = [f"P:{line}" if line else "P:" for line in paragraphs]
    write_java(out, lines)
    print(f"  wrote {out.relative_to(TEMPLATES_DIR.parent)} ({out.stat().st_size} bytes)")


def _doc_with(paragraphs: list[str]) -> list[str]:
    return paragraphs


def seed_gongmunseo_basic() -> None:
    """공문서 기본 (대외시행) — receiver / subject / body / 붙임 / 발신명의."""
    doc = _doc_with(
        [
            "{{기관명}}",
            "",
            "수신  {{수신}} (수신처참조)",
            "(경유)  {{경유}}",
            "제목  {{제목}}",
            "",
            "{{본문}}",
            "",
            "붙임  1. {{붙임}}.  끝.",
            "",
            "{{발신명의}}",
            "",
            "기안자 {{기안자}}    검토자 {{검토자}}    결재자 {{결재자}}",
            "시행 {{시행번호}} ({{시행일자}})    접수",
            "우 {{주소}}  /  {{홈페이지}}",
            "전화 {{전화}}  /  팩스 {{팩스}}  /  {{이메일}}  /  공개구분 {{공개구분}}",
        ]
    )
    _save(doc, "공문서_기본.hwpx")


def seed_gianmun_internal() -> None:
    """기안문 — 내부결재. 결재란 자리 표시는 placeholder로, 실제 결재란은
    e-결재 시스템(온나라/K-Office)이 주입."""
    doc = _doc_with(
        [
            "{{기관명}}",
            "",
            "[결재란 영역 — 전자결재 시스템에서 자동 삽입됨]",
            "",
            "수신  내부결재",
            "제목  {{제목}}",
            "",
            "{{본문}}",
            "",
            "붙임  1. {{붙임}}.  끝.",
            "",
            "{{발신명의}}",
            "",
            "기안자 {{기안자}} ({{기안자직위}})",
            "협조자 {{협조자}}",
            "시행 {{시행번호}} ({{시행일자}})",
        ]
    )
    _save(doc, "기안문_내부결재.hwpx")


def seed_gianmun_external() -> None:
    """기안문 — 대외시행 공문. 발신명의 오른쪽 관인 자리는 placeholder."""
    doc = _doc_with(
        [
            "{{기관명}}",
            "",
            "수신  {{수신}}",
            "(경유)  {{경유}}",
            "제목  {{제목}}",
            "",
            "{{본문}}",
            "",
            "붙임  1. {{붙임}}.  끝.",
            "",
            "{{발신명의}}    [관인 — 전자문서시스템이 삽입]",
            "",
            "기안자 {{기안자}}    검토자 {{검토자}}    결재자 {{결재자}}",
            "시행 {{시행번호}} ({{시행일자}})    접수 {{접수번호}} ({{접수일자}})",
            "우 {{주소}}  /  {{홈페이지}}",
            "전화 {{전화}}  /  팩스 {{팩스}}  /  {{이메일}}  /  공개구분 {{공개구분}}",
        ]
    )
    _save(doc, "기안문_대외시행.hwpx")


def seed_bogoseo() -> None:
    """보고서 — 휴먼명조 15pt 개조식 표준."""
    doc = _doc_with(
        [
            "{{제목}}",
            "",
            "작성: {{작성자}} ({{작성부서}})    작성일: {{작성일자}}",
            "",
            "1. 추진 배경",
            "  가. {{배경1}}",
            "  나. {{배경2}}",
            "",
            "2. 주요 내용",
            "  가. {{내용1}}",
            "  나. {{내용2}}",
            "  다. {{내용3}}",
            "",
            "3. 향후 계획",
            "  가. {{계획1}}",
            "  나. {{계획2}}",
            "",
            "4. 행정사항",
            "  가. {{행정사항}}",
            "",
            "붙임  1. {{붙임}}.  끝.",
        ]
    )
    _save(doc, "보고서_일반.hwpx")


def seed_project_plan() -> None:
    """사업계획서 — 9-section 표준 skeleton."""
    doc = _doc_with(
        [
            "{{사업명}} 사업계획서",
            "",
            "주관기관: {{주관기관}}    책임자: {{책임자}}",
            "사업기간: {{사업기간}}    총사업비: {{총사업비}}",
            "",
            "I. 사업 개요",
            "  1. 사업명: {{사업명}}",
            "  2. 사업기간: {{사업기간}}",
            "  3. 총사업비: {{총사업비}}",
            "  4. 주관기관·참여기관: {{참여기관}}",
            "",
            "II. 추진 배경 및 필요성",
            "  1. 추진 배경",
            "    가. {{배경1}}",
            "    나. {{배경2}}",
            "  2. 추진 필요성",
            "    가. {{필요성1}}",
            "    나. {{필요성2}}",
            "",
            "III. 추진 목표 및 전략",
            "  1. 최종 목표: {{최종목표}}",
            "  2. 연차별 목표: {{연차목표}}",
            "  3. 추진 전략: {{추진전략}}",
            "",
            "IV. 세부 추진 내용",
            "  1. {{세부과제1}}",
            "  2. {{세부과제2}}",
            "  3. {{세부과제3}}",
            "",
            "V. 추진 일정",
            "  {{추진일정}}",
            "",
            "VI. 소요 예산",
            "  {{예산내역}}",
            "",
            "VII. 기대 효과",
            "  1. 정량적 효과: {{정량효과}}",
            "  2. 정성적 효과: {{정성효과}}",
            "",
            "VIII. 성과 지표",
            "  {{성과지표}}",
            "",
            "IX. 붙임",
            "  1. {{붙임1}}",
            "  2. {{붙임2}}.  끝.",
        ]
    )
    _save(doc, "사업계획서_기본.hwpx")


def seed_meeting_notes() -> None:
    """회의록 — 참석자/안건/결정사항 기본 구조."""
    doc = _doc_with(
        [
            "{{회의명}} 회의록",
            "",
            "일시: {{일시}}    장소: {{장소}}",
            "주관: {{주관}}    작성: {{작성자}}",
            "",
            "□ 참석자",
            "  {{참석자}}",
            "",
            "□ 안건",
            "  1. {{안건1}}",
            "  2. {{안건2}}",
            "",
            "□ 주요 논의 사항",
            "  1. {{논의1}}",
            "  2. {{논의2}}",
            "",
            "□ 결정 사항",
            "  1. {{결정1}}",
            "  2. {{결정2}}",
            "",
            "□ 후속 조치 (Action Items)",
            "  1. {{조치1}} — 담당 {{담당1}} / 기한 {{기한1}}",
            "  2. {{조치2}} — 담당 {{담당2}} / 기한 {{기한2}}",
            "",
            "□ 차기 회의",
            "  일시: {{차기일시}}    장소: {{차기장소}}",
        ]
    )
    _save(doc, "회의록.hwpx")


def main() -> int:
    print("[seed] templates/ 생성 시작")
    for fn in (
        seed_gongmunseo_basic,
        seed_gianmun_internal,
        seed_gianmun_external,
        seed_bogoseo,
        seed_project_plan,
        seed_meeting_notes,
    ):
        fn()
    print(f"[seed] 완료 → {TEMPLATES_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
