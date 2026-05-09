# NotebookLM Slide Deck Prompt — Royal Watercolor

> NotebookLM의 Slide Deck (Visual / Video Overview) 생성 시 일관된 디자인 시스템을 강제하기 위한 마스터 프롬프트.
> Style: **Royal Watercolor** — 로열 블루 × 레드 wet 수채 톤, 회화적·예술적 발표

**작성일**: 2026-04-30
**용도**: 인문학·문학·예술·역사·강연 톤 발표. 회화적 무드가 필요한 경우
**언어 정책**: Headline·body 모두 사용자 입력 언어 우선

---

## 사용 방법

1. NotebookLM에서 **Studio → Slide Deck (또는 Video Overview)** 진입
2. "Customize" 또는 프롬프트 입력란에 아래 [📋 Master Prompt](#-master-prompt) 블록을 통째로 붙여넣기
3. 마지막에 *"Topic / Source: …"* 한 줄 추가하여 주제 명시

---

## 📋 Master Prompt

```
Style: Royal Watercolor
Vibe: Painterly, lyrical, contemplative, artisanal. Like a literary essay collection or a museum exhibition catalogue.
Concept: Wet-on-wet watercolor — pigments of royal blue and red bloom and bleed into each other across the canvas.

Global Design Settings
- Canvas: cold-press paper texture (visible fine fiber tooth) on warm off-white (#F4EFE6).
- Pigment palette (used as washes, never as flat fills)
  - Royal Blue: #1F3A93 (deep) bleeding into #4F7BC9 (mid) and #BFD4F2 (pale)
  - Cinnabar Red: #C8262C (deep) bleeding into #E25B4F (mid) and #F2C9C2 (pale)
  - Ink Black: #15161C — used only for text and the occasional thin brush stroke
- Allow blue and red washes to overlap, creating violet/plum bloom zones at the edges.
- Each slide should feel like a single hand-painted page; no two slides have an identical wash pattern.

Typography
- Display: refined serif with humanist warmth (e.g., GT Sectra, Canela, Tiempos Headline). Italics encouraged for poetic phrases.
- Body: book-grade serif (e.g., Tiempos Text, Source Serif) at comfortable reading size.
- Optional: a small handwritten ink label or signature mark in the corner, drawn with a fine nib.
- Language: the language users requested in the prompt. The language should be what users said in the prompt. English used only for short labels (chapter, plate, vol.).

Painting / Composition Rules
- Wet-on-wet bleeds: soft edges, granulation, salt-effect blooms allowed.
- Dry-brush accents: occasional rough textured stroke for emphasis.
- Negative space: large breathing areas of bare paper between washes.
- One dominant gesture per slide (a vertical bleed, a horizontal horizon wash, a circular bloom). Do not overcrowd.
- Imagery, when used, looks like a watercolor illustration — never a photograph, never a flat vector.

Slide Patterns (mix across the deck)
- Title Page — A single dramatic blue-into-red bleed filling the upper third. Title in serif beneath, calm and small.
- Plate / Chapter — "PLATE I" or chapter numeral in italic serif at the top, painted illustration centered, caption beneath in tiny type.
- Quote / Poem — One quote rendered in italic serif, surrounded by pale washes that frame but never overwhelm the text.
- Two-Column Essay — Left: paragraph of body serif. Right: a tall vertical wash of mixed pigments. A thin ink rule between.
- Diagram in Watercolor — Concept diagram drawn with hand-painted lines, dots, and labels. Looks like a notebook sketch, not a tech diagram.
- Timeline as River — A meandering watercolor river runs across the slide; events sit at bends with small ink labels.
- Closing Mark — A solitary bloom of red into blue centered on the page, "FIN" or input-language equivalent in small italic serif.

Tone of Copy
Reflective, slightly literary, unhurried. Short paragraphs over bullets. Sentences may breathe. Avoid corporate filler entirely; this is essay voice, not pitch voice.

What to Avoid
- No flat vector illustration, no clipart, no emoji
- No photographs (illustrate instead, or leave the wash to speak)
- No gradients or digital glassmorphism — only painterly transitions
- No extra accent colors — only blue, red, their bloom (violet), and ink black
- No grid-aligned card layouts — this is a painted page, not a dashboard

Generation Instruction
Generate a cohesive multi-slide deck following this system. Vary the wash composition on each slide so the deck feels like the pages of a hand-bound watercolor book. Maintain serif typography, painterly washes, generous bare-paper margins, and the disciplined royal-blue × red palette throughout.

---
Topic / Source: <여기에 주제 또는 소스 노트 명시>
```

---

## 변형 가이드

| 상황 | 권장 패턴 조합 |
|------|---------------|
| 인문·문학 강연 | Title Page → Quote → Two-Column Essay → Plate → Closing Mark |
| 예술·전시 소개 | Title Page → Plate (×3) → Quote → Closing Mark |
| 역사·연대기 발표 | Title Page → Timeline as River → Plate → Two-Column Essay → Closing Mark |
| 가치·비전 메시지 (재단·NGO) | Title Page → Quote → Diagram in Watercolor → Two-Column Essay → Closing Mark |

## 팔레트 변주

기본 royal blue × cinnabar red가 너무 강하면 톤 다운 가능. Master Prompt의 `Pigment palette`만 교체.

| 변주 | 블루 | 레드 | 인상 |
|------|------|------|------|
| Royal × Cinnabar (default) | `#1F3A93` | `#C8262C` | 가장 본격, 클래식 |
| Indigo × Vermilion | `#283673` | `#E2533B` | 약간 동양화 톤 |
| Cobalt × Madder | `#1E5BA8` | `#A82235` | 차분한 박물관 톤 |
| Prussian × Burnt Sienna | `#1A3A52` | `#A04A2C` | 가을·고서 톤 |

## NotebookLM 디렉팅 팁

수채 느낌이 약하게 그려질 때 추가:

- "wet-on-wet watercolor on cold-press paper, visible fiber tooth"
- "pigment granulation and edge blooms"
- "soft bleeding gradient, salt-effect texture"
- "dry-brush stroke at the edge for contrast"
- "no digital gradient — painterly only"

---

## 변경 이력

- **2026-04-30**: 초기 작성. Royal Watercolor 스타일 + 7개 슬라이드 패턴 + 팔레트 변주 4종.
