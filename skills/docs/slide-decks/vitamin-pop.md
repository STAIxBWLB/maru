# NotebookLM Slide Deck Prompt — Vitamin Pop

> NotebookLM의 Slide Deck (Visual / Video Overview) 생성 시 일관된 디자인 시스템을 강제하기 위한 마스터 프롬프트.
> Style: **Vitamin Pop / Digital Neo** — 유기적 형태 + 비비드 네온 + SNS 친화 톤

**작성일**: 2026-04-30
**용도**: 커뮤니티·캠페인·청년 대상 발표, 정보량 많은 강의를 친근하게 풀어야 할 때
**언어 정책**: Headline·body 모두 입력 언어 우선

---

## 사용 방법

1. NotebookLM에서 **Studio → Slide Deck (또는 Video Overview)** 진입
2. "Customize" 또는 프롬프트 입력란에 아래 [📋 Master Prompt](#-master-prompt) 블록을 통째로 붙여넣기
3. 마지막에 *"Topic / Source: …"* 한 줄 추가하여 주제 명시

---

## 📋 Master Prompt

```
Style: Vitamin Pop / Digital Neo
Theme: Digital Pop × Academic
Tone & Manner: Modern, fluid, friendly, high information density. SNS-friendly visual tone with playful but disciplined typography.

Key Visuals
- Motifs: organic amoeba-like or cloud-like shapes. Random placement around slide edges, partially cropped (pieces of blob bleed off-canvas).
- Decorations: dot patterns, hand-drawn highlight strokes, SNS-style icon decorations (sparkle, heart, star, comment bubble).

Color Palette
- Base: white (#FFFFFF) or light-gray dot-pattern background
- Main pop colors: vivid pink (#FF3DA0), cyan (#3DD9FF), purple (#9D4DFF) — neon-sign inspired
- Accent: black, used for text, outlines, and to anchor the pop colors
- Chart colors: gradient-filled bars (e.g., green → yellow, cyan → purple)

Typography
- Headings: bold gothic, impact-focused. Outline text (white fill + black stroke) allowed for hero words.
- Body: highly readable gothic sans-serif, comfortable size, slightly looser leading.
- Numerals: large Western type for emphasis, especially percentages and stats.
- Headline language: input language. The language should be what users said in the prompt. Short English pop words ("HI", "NEW", "+1") allowed as decorative accents.

Design Guidelines
- Organic Shapes: use irregular, hand-drawn, wavy shapes rather than strict rectangles or circles to express community fluidity.
- Icons: prefer pop illustrations or abstract avatar icons (shapes with eyes, abstract faces) over photos of real people.
- Information Contrast: balance text-heavy slides with highly visual slides — alternate dense and breathing pages.

Layout Variations (Catalog)
- Title Composition — Place an organic blob or cloud shape at the center; position the title inside it. Add small stars and sparkles around it.
- Text + Data Pop — Split layout: left = text, right = colorful donut chart (vivid pink, cyan, purple). Emphasize numbers at extremely large scale.
- Organic Timeline — A wavy vertical line like a plant stem. Use leaf/bud-like icons at timeline milestones.
- Bubble Cluster — Overlapping translucent circles like soap bubbles. Dot pattern in background to enhance pop feeling.
- SNS Chat Style — A smartphone-style frame containing chat bubbles and icons. Important insights highlighted with bold text or marker strokes. Speakers represented by differently colored amoeba-shaped icons.
- Concept Formula / Flow Diagram — Explain formulas like "Energy × Empathy" using hand-drawn arrows, icons, and crayon-like strokes.
- Colorful Step Flow — Large arrow flowing left → right. Each step in a different color (cyan → purple → pink). Clearly marks progression.
- Lollipop Chart — Use lollipop-style bars (round tips) or rounded bar charts. Color-code categories. Optionally overlay a line chart for combined visualization.
- Sticker Grid — Slightly tilted square cards, appearing taped or stickered on the slide. Mimics a collage of sticky notes.
- Character Ending — A cloud/amoeba character in the center. Arrange SNS icons (circular) around it to display contact information.

Additional Notes
- Organic Shapes: hand-drawn, wavy — never rigid geometric forms — to convey community fluidity.
- Icons: mix monochrome cut-out photos with bright pop illustrations and abstract avatar icons (eyes, blobs) to maintain friendliness.
- Information Contrast: ensure clear rhythm between dense-text pages and visual-heavy pages.

What to Avoid
- No corporate stock photos, no smiling team shots
- No flat lifeless gradients on backgrounds — gradients live inside chart bars and icons only
- No emoji as primary content — use the abstract avatar icons instead
- No more than 3 main pop colors; black is the only neutral allowed
- No rigid bordered boxes — soften everything with rounded or organic edges

Generation Instruction
Generate a cohesive multi-slide deck following this system. Vary the layout variants so the deck reads like a friendly digital zine, alternating dense and visual slides. Maintain organic shapes, neon pop colors, hand-drawn accents, and the abstract-avatar friendliness throughout.

---
Topic / Source: <여기에 주제 또는 소스 노트 명시>
```

---

## 변형 가이드

| 상황 | 권장 패턴 조합 |
|------|---------------|
| 커뮤니티·동아리 소개 | Title Composition → Bubble Cluster → SNS Chat Style → Sticker Grid → Character Ending |
| 청년 대상 강의 (AI·창의력) | Title Composition → Concept Formula → Colorful Step Flow → Lollipop Chart → Character Ending |
| 캠페인·소셜 임팩트 | Title Composition → Text + Data Pop → Organic Timeline → SNS Chat Style → Character Ending |
| 학생 행사·OT | Title Composition → Sticker Grid → Bubble Cluster → Colorful Step Flow → Character Ending |

## 컬러 베리에이션

기본 핑크+시안+퍼플 조합이 부담스러우면 다음 조합으로 교체. Master Prompt의 `Main pop colors`만 바꾸면 됨.

| 변주 | 색 조합 | 인상 |
|------|---------|------|
| Neon Trio (default) | `#FF3DA0` / `#3DD9FF` / `#9D4DFF` | 본격 SNS 팝 |
| Citrus Trio | `#FF6B1A` / `#FFE93D` / `#00E68A` | 따뜻하고 활기, 봄·여름 |
| Pastel Trio | `#FFB3D1` / `#A0E7E5` / `#C8B6FF` | 차분한 라이프스타일 |
| Cyber Trio | `#00E5FF` / `#FF1493` / `#9D4DFF` | 더 미래적, 게이밍·이스포츠 |

## NotebookLM 디렉팅 팁

유기적 톤이 약하게 그려질 때 추가:

- "amoeba-shaped blob, hand-drawn wavy edge"
- "abstract avatar with two simple dot eyes, no realistic face"
- "marker stroke highlight, slightly uneven"
- "lollipop bar chart with rounded tips"
- "soap-bubble cluster, transparent overlap"

---

## 변경 이력

- **2026-04-30**: 초기 작성. Vitamin Pop 스타일 + 10개 레이아웃 + 컬러 변주 4종.
