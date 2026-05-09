---
name: xlsx-toolkit
description: >
  Excel(.xlsx) 파일 읽기·요약·변환 스킬. openpyxl 기반(_sys/skills/env/.venv 기설치).
  MVP는 read-only — 셀 값 추출, 시트 요약, markdown/CSV 변환.
  inbox-process 추출 도구로 사용되며, 스프레드시트 자료 처리에 재사용.
  트리거: xlsx, 엑셀, excel, 스프레드시트, .xlsx 읽기, 시트 요약, xlsx 변환,
  셀 값, 엑셀 내용, 스프레드시트 추출
---

# xlsx-toolkit (Excel 파일 읽기 MVP)

## Overview

Excel `.xlsx` 파일을 읽어 markdown/CSV/요약으로 변환하는 read-only 스킬. `_sys/skills/env/.venv`에 이미 설치된 openpyxl 3.1.5를 사용한다. `inbox-process` 내용 추출 도구로 호출될 수 있다.

## MVP scope

- ✅ Read — 셀 값, 시트 목록, 병합 셀, 빈 행/열 감지
- ✅ Summary — 시트별 행/열 카운트 + 첫 행 헤더
- ✅ Convert — CSV / markdown 표 / 플레인 텍스트

## v2 (현재 MVP 제외)

- Write — 신규 통합문서 생성
- Edit — 행·열 추가/삭제, find-replace
- 서식·수식 보존, 차트·피벗테이블, VBA

## Quick Reference

```bash
# 경로는 work repo 기준 (서브모듈 _sys/skills 내부)
XLSX=~/workspace/work/_sys/skills/skills/xlsx-toolkit/xlsx

$XLSX read <file.xlsx>                    # 전체 시트 → markdown 표
$XLSX read <file.xlsx> --sheet 1          # 특정 시트만
$XLSX read <file.xlsx> --sheet "데이터"    # 시트 이름으로
$XLSX read <file.xlsx> --max-rows 50      # 처음 N행만

$XLSX summary <file.xlsx>                 # 시트 목록 + 행/열 카운트 + 헤더

$XLSX to-csv <file.xlsx>                  # 첫 시트 → CSV (stdout)
$XLSX to-csv <file.xlsx> --sheet 2 -o out.csv
$XLSX to-csv <file.xlsx> --all-sheets     # 시트별로 CSV 파일

$XLSX to-md <file.xlsx>                   # markdown 표
$XLSX to-md <file.xlsx> --sheet 1
```

## 종료 코드

- `0` — 성공
- `1` — 인자 오류 또는 파일 접근 실패
- `2` — openpyxl 파싱 실패 (파일이 .xlsx가 아니거나 손상)
- `3` — 지정한 시트/범위 없음

## inbox-process 통합

추출 도구 표:

```markdown
| `.xlsx` | xlsx-toolkit | `_sys/skills/skills/xlsx-toolkit/xlsx read <file>` |
```

요약 생성에 xlsx 콘텐츠를 markdown 표로 포함하여 전달.

## 제약

- **openpyxl는 `data_only=False`로 읽으면 수식(`=SUM(...)`)을 그대로 반환**한다. 결과 값이 필요하면 `--values-only` 플래그를 써야 하는데, 이건 Excel이 마지막으로 연 시점의 캐시값만 반환한다.
- **병합 셀**은 좌상단 셀에만 값이 있고 나머지는 `None`이다. read 출력에서 병합 셀 감지 후 값 복제로 처리한다.
- **매우 큰 파일** (>50MB, >100만 행)은 `openpyxl.load_workbook(read_only=True)` 모드로 스트리밍 처리한다.
- **이미지/차트/피벗**은 MVP에서 무시한다 (summary에만 개수 표시).

## 응답 원칙

1. 한국어 소통
2. 읽기 실패 시 pandoc 폴백 제안 (lossy but 읽힘)
3. 대용량 파일은 자동으로 read_only 모드 + --max-rows 100 적용 후 경고
4. 병합 셀·빈 행 감지 시 로그에 기록
