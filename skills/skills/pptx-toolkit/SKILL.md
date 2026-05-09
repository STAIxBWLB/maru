---
name: pptx-toolkit
description: >
  PowerPoint(.pptx) 파일 읽기·아웃라인·노트 추출 스킬. python-pptx 기반
  (_sys/skills/env/.venv 기설치). MVP는 read-only — 슬라이드 텍스트, 제목 아웃라인,
  발표자 노트, markdown 변환. inbox-process 추출 도구로 사용.
  트리거: pptx, 파워포인트, powerpoint, 프레젠테이션, 슬라이드, .pptx 읽기,
  슬라이드 아웃라인, 발표자료, 프리젠테이션 추출
---

# pptx-toolkit (PowerPoint 파일 읽기 MVP)

## Overview

PowerPoint `.pptx` 파일을 read-only로 파싱하여 텍스트·제목·노트 추출, markdown 변환을 수행한다. `_sys/skills/env/.venv`의 python-pptx 1.0.2 사용. `inbox-process` 추출 단계에서 발표자료 처리에 사용할 수 있다.

## MVP scope

- ✅ Read — 전체 슬라이드 텍스트 + shape 정보
- ✅ Outline — 슬라이드 제목만 번호 순으로
- ✅ Notes — 발표자 노트만 분리 추출
- ✅ Convert — markdown 아웃라인, 플레인 텍스트 dump

## v2 (현재 MVP 제외)

- Write (신규 프레젠테이션 생성, 슬라이드 추가)
- Edit (순서 변경, find-replace, 노트 추가)
- 애니메이션·전환·임베디드 미디어·커스텀 레이아웃
- 이미지 추출

## Quick Reference

```bash
PPTX=~/workspace/work/_sys/skills/skills/pptx-toolkit/pptx

$PPTX read <file.pptx>               # 전체 텍스트 + 노트 (markdown)
$PPTX read <file.pptx> --slide 3     # 특정 슬라이드만

$PPTX outline <file.pptx>            # 슬라이드 제목 목록

$PPTX notes <file.pptx>              # 발표자 노트만
$PPTX notes <file.pptx> --slide 3

$PPTX to-md <file.pptx>              # markdown 아웃라인 (저장 옵션)
$PPTX to-md <file.pptx> -o out.md
```

## 종료 코드

- `0` — 성공
- `1` — 인자 오류 또는 파일 없음
- `2` — python-pptx 파싱 실패 (`.ppt` 구형식 또는 손상)
- `3` — 지정한 슬라이드 번호 범위 밖

## inbox-process 통합

추출 도구 표:

```markdown
| `.pptx` | pptx-toolkit | `_sys/skills/skills/pptx-toolkit/pptx read <file>` |
```

요약 생성 시 slide outline을 markdown body로 포함.

## 제약

- `.ppt` (PowerPoint 97-2003)는 python-pptx가 지원하지 않음. pandoc 또는 LibreOffice 변환 필요.
- 이미지·차트·다이어그램은 MVP에서 개수만 표시.
- 애니메이션·전환은 무시.
- 텍스트 박스가 아닌 도형(Shape)의 텍스트는 `shape.text_frame`에서 추출.

## 응답 원칙

1. 한국어 소통
2. `.ppt` 감지 시 변환 안내 (pandoc / soffice)
3. 100+ 슬라이드 파일은 자동으로 outline 먼저 제시, 세부는 --slide로
4. notes가 없는 슬라이드는 "_(no notes)_"로 표시
