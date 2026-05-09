# python-pptx Quick Reference

> python-pptx 1.0.2 (`_sys/skills/env/.venv`)
> 공식 문서: https://python-pptx.readthedocs.io/en/latest/

## 로드

```python
from pptx import Presentation
pres = Presentation("deck.pptx")
```

## 슬라이드 이터

```python
for idx, slide in enumerate(pres.slides, start=1):
    print(idx, slide.slide_layout.name)
```

## 제목 추출

```python
if slide.shapes.title is not None:
    title = slide.shapes.title.text_frame.text
```

`shapes.title`은 `None`일 수 있다 (제목 placeholder가 없으면). Fallback: 첫 text_frame을 제목으로 간주.

## 텍스트 추출

```python
for shape in slide.shapes:
    if shape.has_text_frame:
        for para in shape.text_frame.paragraphs:
            # 각 paragraph는 여러 run으로 구성
            text = "".join(run.text for run in para.runs)
            indent = para.level  # 0-based
```

## 발표자 노트

```python
if slide.has_notes_slide:
    notes_text = slide.notes_slide.notes_text_frame.text
```

## Shape 타입

```python
from pptx.enum.shapes import MSO_SHAPE_TYPE

for shape in slide.shapes:
    if shape.shape_type == MSO_SHAPE_TYPE.PICTURE:
        # image
        pass
    elif shape.shape_type == MSO_SHAPE_TYPE.TABLE:
        # table
        for row in shape.table.rows:
            for cell in row.cells:
                print(cell.text)
```

## 레이아웃·마스터

```python
slide.slide_layout          # SlideLayout
slide.slide_layout.slide_master  # SlideMaster
pres.slide_masters          # 전체 마스터
```

## 제약

- **`.ppt` (97-2003) 미지원** — `Presentation("foo.ppt")`는 에러. 변환 필요:
  ```bash
  soffice --headless --convert-to pptx foo.ppt
  pandoc -f pptx foo.pptx -o foo.md  # lossy
  ```
- **애니메이션·전환은 파싱되지 않음** (런타임 효과라 무시)
- **SmartArt/Chart 내부 텍스트**는 shape.has_text_frame이 False. 추출 복잡.
- **글꼴·색상·배경**은 MVP에서 무시.

## 트러블슈팅

- **`PackageNotFoundError`** — `.pptx`가 아님 또는 손상. `unzip -l foo.pptx`로 내부 구조 확인.
- **빈 텍스트** — `run.text`가 아니라 `para.text` 써보기.
- **한글 깨짐** — python-pptx는 UTF-8 기본. 로케일 문제면 stdout에 `sys.stdout.reconfigure(encoding='utf-8')`.
