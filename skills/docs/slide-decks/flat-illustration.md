# NotebookLM Slide Deck Prompt — Flat Illustration

> NotebookLM의 Slide Deck (Visual / Video Overview) 생성 시 일관된 디자인 시스템을 강제하기 위한 마스터 프롬프트.
> Style: **Flat Illustration** — 두꺼운 외곽선 + 부드러운 톤 + 살짝 변형된 인물 + 단색 배경 + 최대 3색 제약

**작성일**: 2026-04-30
**용도**: 친근한 가이드·매뉴얼·스토리북 톤 발표. 강의 자료, 일상적 캠페인, 안내 문서
**언어 정책**: Headline·body 모두 입력 언어 우선

---

## 사용 방법

1. NotebookLM에서 **Studio → Slide Deck (또는 Video Overview)** 진입
2. "Customize" 또는 프롬프트 입력란에 아래 [📋 Master Prompt](#-master-prompt) 블록을 통째로 붙여넣기
3. 마지막에 *"Topic / Source: …"* 한 줄 추가하여 주제 명시
4. 톤이 더 따뜻해야 하면 *"Palette:"* 라인의 색을 직접 교체

---

## 📋 Master Prompt

```
Style: Flat Illustration
Vibe: Soft picture-book aesthetic. Friendly, calm, hand-made. Like a printed children's primer crossed with a modern indie zine.

Illustration Rules
- Subject: a person (or small group), slightly deformed proportions — large head, small hands, simplified body, expressive minimal face (two dots for eyes, a small line for mouth).
- Outline: thick, even-weight black or dark-tinted outline around every subject and object. No tapered calligraphy strokes.
- Fill: flat solid colors only. Absolutely no gradients, no textures, no shading layers. One color per region.
- Hands, feet, and details simplified to essential shapes.

Color Rules (strict)
- Maximum 3 colors per slide, including background.
- All colors are gentle pastels — each base hue mixed with a noticeable amount of white. No fully saturated neons. No deep blacks (use a soft charcoal or dark version of one of the 3 colors).
- Palette example (replace as needed): warm peach (#F8C9A8), sage green (#B7CDB1), cream (#F5EFE0).
- Outlines may be a slightly darker version of one of the 3 chosen colors instead of pure black.

Background
- Solid flat color — exactly ONE color, edge-to-edge, no patterns, no gradients, no dots.
- The background color counts as one of the 3 allowed colors.

Typography
- Headlines: rounded humanist sans-serif (e.g., Recoleta Rounded, Quicksand Bold, GT Maru) with the same friendly weight as the illustrations.
- Body: clean rounded sans-serif at comfortable size, generous line height.
- Headline language: input language. The language should be what users said in the prompt. English titles only when the source explicitly uses English.
- Text color: one of the 3 palette colors (typically the darkest), never a fourth color.

Layout Rules
- Center or off-center the illustrated character; leave generous breathing space.
- Headline above or beside the character, never on top.
- Avoid grids of multiple boxes; this is one calm scene per slide, not a dashboard.

Slide Patterns (mix across the deck)
- Cover — Single illustrated character on solid background, large rounded headline beside or above. Maybe a tiny prop.
- Concept Page — Character interacting with one simple object (a book, a phone, a plant). One sentence caption.
- Step Page — Same character in two or three poses across the slide showing a simple sequence (1→2→3). Tiny numerals beside each.
- Dialogue Page — Two characters facing each other, simple speech indication (a small rounded text block, no comic-style bubble required).
- Insight Page — Character with a small lightbulb or question mark prop. One short takeaway sentence.
- Closing Page — Character waving or sitting calmly, short sign-off line, optional small heart or star.

Tone of Copy
Warm, simple, plainspoken. Sentences short. Read aloud as if explaining to a friend. Avoid jargon and corporate language.

What to Avoid
- No more than 3 colors total per slide
- No gradients, no shadows, no inner glows, no textures
- No realistic faces or photographic elements
- No 3D rendering, no isometric perspective with depth shading
- No emoji or AI-uncanny stylized characters
- No dense paragraphs — if it doesn't fit in 1–2 short sentences, split the slide

Generation Instruction
Generate a cohesive multi-slide deck following this system. Keep the SAME palette across all slides (don't redesign colors per slide). Keep the SAME character style across all slides (recurring protagonist preferred). The deck should feel like pages from one calm picture book — friendly, restrained, hand-made.

---
Topic / Source: <여기에 주제 또는 소스 노트 명시>
Palette: <bg color + 2 illustration colors, all soft pastels — e.g., "cream / peach / sage">
```

---

## 변형 가이드

| 상황 | 권장 패턴 조합 |
|------|---------------|
| 학과·서비스 안내 매뉴얼 | Cover → Concept Page → Step Page → Insight → Closing |
| 어린이·청소년 콘텐츠 | Cover → Dialogue (×2) → Step Page → Closing |
| AI 리터러시·생활 가이드 | Cover → Concept → Step Page → Insight → Closing |
| 가치·캠페인 메시지 | Cover → Insight → Concept → Insight → Closing |

## 팔레트 예시 (3색 제약 유지)

각 팔레트 모두 배경 1 + 일러스트 2색. Master Prompt 마지막의 `Palette:` 라인에 그대로 입력.

| 팔레트 | 배경 | 일러스트 1 | 일러스트 2 | 인상 |
|--------|------|-----------|-----------|------|
| Cream Picnic | `#F5EFE0` cream | `#F8C9A8` peach | `#B7CDB1` sage | 따뜻하고 평온 |
| Soft Sky | `#E6EEF5` sky cream | `#A4C2DC` dusty blue | `#F4C9B6` rose | 차분, 사색 |
| Mint Study | `#EAF1E8` mint cream | `#94B49F` muted green | `#E2A57E` apricot | 학습·성장 톤 |
| Lavender Bath | `#EFE6F2` lavender wash | `#B9A1C9` mauve | `#E8C49B` butter | 휴식·웰니스 |
| Paper Sun | `#F2EBD3` paper | `#D9A24A` sun ochre | `#7AA47C` forest | 따뜻한 매뉴얼 톤 |

## NotebookLM 디렉팅 팁

플랫 일러스트 톤이 약할 때 추가:

- "thick uniform outline, no tapered strokes"
- "flat solid color fills only, no shading, no gradient"
- "deformed character — large head, small hands, two-dot eyes"
- "soft pastel palette, each color mixed with white"
- "single solid color background, edge-to-edge"
- "absolute maximum of 3 colors per slide"

## 캐릭터 일관성 팁

NotebookLM이 슬라이드마다 캐릭터를 바꾸지 않도록 *Topic / Source* 줄에 1줄로 캐릭터를 박제:

> 예: `Character: short-haired person in a yellow sweater, large head, two-dot eyes, peach skin tone — same in every slide`

---

## 변경 이력

- **2026-04-30**: 초기 작성. Flat Illustration 스타일 + 6개 패턴 + 5개 팔레트 예시 + 캐릭터 일관성 팁.
