# python-hwpx API 치트시트

설치된 버전 기준 (v2.5 in `_sys/skills/env/.venv`). 전체 API는 `pydoc hwpx.document.HwpxDocument`.

## 기본 import

```python
import logging
logging.getLogger("hwpx").setLevel(logging.ERROR)  # manifest fallback 경고 무음

from hwpx import HwpxDocument, templates
from hwpx.tools.text_extractor import TextExtractor
from hwpx.tools.object_finder import ObjectFinder
```

## 문서 열기 · 저장

```python
# 파일로부터
doc = HwpxDocument.open("input.hwpx")

# bytes로부터
with open("input.hwpx", "rb") as f:
    doc = HwpxDocument.open(f)

# 신규 blank 문서
doc = HwpxDocument.new()

# 템플릿 blank bytes만 필요할 때
raw_bytes = templates.blank_document_bytes()

# 저장
doc.save_to_path("out.hwpx")            # 파일
doc.save_to_stream(file_obj)            # 스트림
out_bytes = doc.to_bytes()              # bytes (save()는 deprecated)
```

## 텍스트 읽기

### 전체 문서

```python
text = doc.export_text()        # 플레인 텍스트
md = doc.export_markdown()      # markdown
html = doc.export_html()        # HTML
```

### 섹션·단락 순회

```python
for sec in doc.sections:
    for para in sec.paragraphs:
        # para는 HwpxOxmlParagraph
        print(f"style={para.style_id_ref} paraPr={para.para_pr_id_ref}")
        for run in para.runs:
            # run.text는 없음 — TextExtractor로 추출
            pass
```

### 런 내부 텍스트 추출

```python
extractor = TextExtractor(doc)
for para in doc.paragraphs:
    text = extractor.paragraph_text(para.element)  # raw XML element 전달
    print(text)
```

**주의**: `paragraph_text`는 **XML element**를 받는다. wrapper 객체가 아니라 `.element` 속성.

## 본문 추가

### 단순 단락

```python
doc.add_paragraph("한 줄 텍스트")
doc.add_paragraph("스타일 지정", style_id_ref=1, para_pr_id_ref=0)
```

### 섹션 지정

```python
# 새 섹션 추가
new_sec = doc.add_section()
doc.add_paragraph("두 번째 섹션 본문", section=new_sec)

# 기존 섹션 선택
doc.add_paragraph("첫 섹션에 추가", section_index=0)
```

### 표

```python
tbl = doc.add_table(rows=3, cols=4)
# 각 셀에 접근하여 단락 추가 — API는 HwpxOxmlTable 참조
```

### 이미지

```python
doc.add_image("/path/to/photo.jpg")                   # 현재 커서 위치
doc.add_image("/path/to/photo.jpg", width=100, height=60)  # mm 단위
```

### 하이퍼링크 · 북마크

```python
doc.add_hyperlink("링크 텍스트", "https://example.com")
doc.add_bookmark("북마크이름")
```

### 도형

```python
doc.add_rectangle(x=0, y=0, width=100, height=50)
doc.add_ellipse(x=0, y=0, width=100, height=50)
doc.add_line(x1=0, y1=0, x2=100, y2=100)
doc.add_shape(shape_type="STAR")
```

### 각주 · 미주 · 메모

```python
doc.add_footnote("각주 텍스트")
doc.add_endnote("미주 텍스트")
doc.add_memo("메모 텍스트")
```

## 텍스트 치환

### 런 단위 치환 (빠름, 권장)

```python
count = doc.replace_text_in_runs("{{제목}}", "실제 제목")
print(f"{count}건 치환")

# 처음 N개만
doc.replace_text_in_runs("{{TODO}}", "완료", limit=1)

# 치환하며 스타일 변경
doc.replace_text_in_runs("강조", "중요",
                        text_color="#FF0000",
                        underline_type="BOTTOM",
                        underline_color="#000000")
```

**제약**: anchor가 여러 run에 걸쳐 있으면 매칭되지 않는다. Hancom Office에서 템플릿을 작성할 때 anchor 문자열 전체를 한 번에 입력하여 단일 run으로 유지할 것.

### 고급: ObjectFinder로 XPath 검색

```python
finder = ObjectFinder(doc)
results = finder.find("hp:t")
for found in results:
    print(f"{found.section.part_name} {found.path}: {found.element.text}")
    found.element.text = "수정된 내용"
```

## 스타일 관리

### 스타일 조회

```python
for style in doc.styles:
    print(style.id, style.name, style.type)

for char_pr in doc.char_properties:
    print(char_pr.id, char_pr.element.attrib)

for para_pr in doc.paragraph_properties:
    print(para_pr.id)
```

### 스타일 보장 (없으면 생성)

```python
# 런에 특정 스타일 적용 보장
doc.ensure_run_style(char_pr_id_ref=5)
```

## 헤더 · 푸터

```python
doc.set_header_text("문서 제목")
doc.set_footer_text("- %PAGE% -")  # %PAGE% 플레이스홀더
doc.remove_header()
doc.remove_footer()

for header in doc.headers:
    print(header)
```

## 이미지 관리

```python
for img in doc.list_images():
    print(img)  # 속성: path, bin_item_id_ref (버전에 따라)

doc.remove_image(bin_item_id_ref="image1")
```

## 단 설정

```python
doc.set_columns(count=2, gap=8.5)  # 2단, 간격 8.5mm
```

## 변경 이력 · 버전

```python
for history in doc.histories:
    print(history)

print(doc.version.element.attrib)
# {'tagetApplication': 'WORDPROCESSOR', 'major': '5', 'minor': '1', ...}

for author in doc.track_change_authors:
    print(author)
```

## 검증

```python
result = doc.validate()
# 반환형은 버전마다 다름 — 이 스킬은 직접 zipfile+lxml로 구조 검증 수행
```

## 저수준 접근 (oxml)

python-hwpx가 커버하지 않는 연산이 필요하면 저수준 oxml 직접 조작:

```python
package = doc.package  # HwpxPackage
part = package.part("Contents/section0.xml")
root = part.element  # lxml.etree.Element
# 직접 XML 수정
```

또는 `unpack` → Edit 도구 → `repack` 경로가 더 명확.

## 자주 쓰이는 레시피

### 레시피 1: 템플릿 채우기

```python
import logging; logging.getLogger("hwpx").setLevel(logging.ERROR)
from hwpx import HwpxDocument

doc = HwpxDocument.open("template.hwpx")
data = {"제목": "...", "본문": "...", "붙임": "..."}
for key, val in data.items():
    doc.replace_text_in_runs("{{" + key + "}}", val)
doc.save_to_path("output.hwpx")
```

### 레시피 2: 섹션 내용 전체를 새 텍스트로 대체

```python
sec = list(doc.sections)[0]
for para in list(sec.paragraphs):
    doc.remove_paragraph(para)
for line in new_content.split("\n"):
    doc.add_paragraph(line, section=sec)
```

### 레시피 3: 표 생성 후 셀에 텍스트 주입

(API는 버전별로 변동 — `./hwpx unpack`으로 참고 XML 확인 후 직접 빌드 권장)

### 레시피 4: markdown → HWPX (단순)

```python
doc = HwpxDocument.new()
for line in md_text.splitlines():
    stripped = line.lstrip("#").strip()
    if stripped:
        doc.add_paragraph(stripped)
doc.save_to_path("out.hwpx")
```

복잡한 markdown(표·리스트·강조)은 직접 파싱하거나 pandoc → docx → 변환 체인.

## 공식 문서 · 소스

- [python-hwpx on GitHub (airmang/python-hwpx)](https://github.com/airmang/python-hwpx)
- PyPI: `pip install python-hwpx` (단, 이 워크스페이스 venv에 기설치)
- 설치 경로: `_sys/skills/env/.venv/lib/python3.11/site-packages/hwpx/`
- **라이선스**: Non-Commercial — 상업 재배포 시 유의

## 버전별 차이

v2.5 (현재 venv 설치) 기준:
- `save()`는 deprecated — `save_to_path()` 사용
- `TextExtractor`는 wrapper 객체가 아닌 XML element를 받음
- `image.path` 속성 유·무는 이미지 삽입 방식에 따라 다름 (fallback으로 getattr 사용)

새 버전 채택 시 이 치트시트 갱신.
