# openpyxl Quick Reference

> openpyxl 3.1.5 (이미 `~/.anchor/env/.venv`에 설치됨)
> 공식 문서: https://openpyxl.readthedocs.io/en/stable/

## 로드 모드

```python
import openpyxl

# 표준 모드 — 전체 파일 메모리
wb = openpyxl.load_workbook("file.xlsx")

# 수식 대신 캐시 값 (Excel이 마지막으로 연 시점)
wb = openpyxl.load_workbook("file.xlsx", data_only=True)

# read_only 모드 — 대용량 파일 스트리밍 (병합셀·차트 접근 불가)
wb = openpyxl.load_workbook("file.xlsx", read_only=True)
```

## 시트 접근

```python
wb.sheetnames              # ['Sheet1', '2026', '참조']
wb.active                  # 활성 시트 (기본 첫 시트)
ws = wb["2026"]            # 이름으로
ws = wb[wb.sheetnames[0]]  # 인덱스로
```

## 셀 접근

```python
ws["A1"].value             # 단일 셀
ws.cell(row=1, column=1).value  # 1-based
ws.iter_rows(values_only=True)  # 빠른 행 이터
ws.iter_rows(min_row=2, max_col=5, values_only=True)
```

## 병합 셀

```python
ws.merged_cells.ranges     # [<MergedCellRange A1:C1>, ...]
# 병합 범위의 좌상단에만 값이 있음. 나머지는 None.
# read_only 모드에서는 merged_cells 접근 불가.
```

## 수식 vs 값

```python
# data_only=False (기본)
ws["B2"].value  # '=SUM(A1:A10)'  ← 수식 문자열

# data_only=True
ws["B2"].value  # 55.0             ← 캐시된 값 (Excel이 마지막으로 저장 시점)
```

**주의**: openpyxl는 수식을 평가하지 않는다. `data_only=True`로 열어도 캐시가 없으면 `None`.

## 차트·이미지

```python
ws._charts        # Chart 객체 리스트 (ws.charts 아님)
ws._images        # Image 객체 리스트
# MVP에서는 개수만 표시하고 파싱하지 않는다.
```

## 셀 형식 (MVP 제외)

```python
cell = ws["A1"]
cell.font.name          # 'Calibri'
cell.font.size          # 11
cell.fill.fgColor.rgb   # 'FFFFFF00'
cell.number_format      # 'yyyy-mm-dd' 등
# xlsx-toolkit MVP는 서식 무시. v2에서 처리.
```

## 트러블슈팅

- **`zipfile.BadZipFile: File is not a zip file`**
  → `.xlsx`가 아니거나 손상. `.xls` (Excel 97-2003)는 xlrd 필요. `.xlsm`은 `keep_vba=True` 필요.

- **`KeyError: 'xl/sharedStrings.xml'`**
  → 특수한 xlsx 형태. pandoc 폴백 시도.

- **대용량에서 OOM**
  → `read_only=True` + `iter_rows` 사용. 모든 셀을 한 번에 로드하지 말 것.

- **merged 셀이 None**
  → 정상 동작. 좌상단 값을 수동 복제해야 한다 (xlsx_cli.py `_expand_merged_cells` 참조).
