# NotebookLM Slide Deck Prompt — Constructivism Tech

> NotebookLM의 Slide Deck (Visual / Video Overview) 생성 시 일관된 디자인 시스템을 강제하기 위한 마스터 프롬프트.
> Style: **Constructivism / Tech-Art / Avant-Garde** — "Architecture of Intelligence"

**작성일**: 2026-04-30
**용도**: AI·기술 사상서, 연구 분석 발표, 아카데믹 + 아방가르드 톤이 필요한 키노트
**언어 정책**: Headline·body 모두 입력 언어 우선, 영문 fig.label 허용

---

## 사용 방법

1. NotebookLM에서 **Studio → Slide Deck (또는 Video Overview)** 진입
2. "Customize" 또는 프롬프트 입력란에 아래 [📋 Master Prompt](#-master-prompt) 블록을 통째로 붙여넣기
3. 마지막에 *"Topic / Source: …"* 한 줄 추가하여 주제 명시

---

## 📋 Master Prompt

```
Style: Constructivism / Tech-Art / Avant-Garde
Concept: "Architecture of Intelligence"
Tone: Avant-garde, structural, intellectual, artistic, future-oriented. Like a Russian constructivist poster crossed with a modern AI research dossier.

Visual Identity
- Background: warm gray / beige (#E0E0D0). Matte, paper-like texture, faint fiber tooth.
- Text: charcoal gray (#333333) — never pure black.
- Accent: neon yellow (#DFFF00) — only used for geometric shapes and highlight fills.
- Lines: ultra-thin gray (0.5pt) drafting lines, the way an architectural blueprint reads.

Typography
- Headings: deliberate mix of refined serif (Didot, Bodoni) and clean sans-serif (Helvetica, Söhne). Use serif for titles, sans for labels.
- Body: small grid-aligned text. Generous leading. Strict left alignment.
- Numerals: typewriter-style monospaced (Courier New, IBM Plex Mono) for figure numbers and data.
- Headline language: input language. The language should be what users said in the prompt. English permitted only for technical labels (e.g., "Fig.1", "Plate II", "INDEX", "ARCH.").

Slide Composition Patterns

A. Cover / Concept — Triple Collage
- Structure: screen divided into three vertical or horizontal sections by thin grid lines.
- Visuals: monochrome cut-out portraits (no background, hard edges).
- Accents: neon yellow circles and squares placed behind or in front of the subject as compositional anchors.
- Decoration: concentric rings (target-scope style) placed around the focal point.

B. Analysis / Dissection — Technical Drawing
- Background: fine grid similar to graph paper, very low contrast.
- Main: line-art / wireframe illustration of the product or concept, partially filled in neon yellow.
- Annotations: thin leader lines with blueprint-style labels ("Fig.1", "Fig.2", "§3.2 — agent loop").

C. Process / Flow — Geometric Connection
- Elements: neon yellow circles, squares, triangles as nodes.
- Connections: dotted or dashed lines linking shapes to express logical flow.
- Photography: use shapes as clipping masks to embed monochrome photos inside them.

D. Data / Infographic — Radar Chart Art
- Chart: large spiderweb-style radar chart spanning most of the slide.
- Data lines: thick neon yellow plotting lines, dots at vertices.
- Background: subtle texture resembling old maps or blueprints.

E. Manifesto Page — Single charcoal serif headline at heroic scale, one neon-yellow geometric mark beside it, ample beige negative space.

F. Plate / Section Divider — Roman numeral or "PLATE III" in serif at top-left, thin rule across, one large neon-yellow geometric form occupying lower half.

Design Rules
- Color Limitation: only three main colors — beige background, monochrome photos, neon yellow geometry. Charcoal gray for text. No other accents.
- Collage: never place photos as plain rectangles; always cut out the subject cleanly with sharp edges.
- Layering Order (back → front): grid background → neon geometric shapes → monochrome cut-out photo → foreground text.

What to Avoid
- No additional colors (no blue, no red, no green)
- No drop shadows or gradients
- No photos with their original backgrounds intact
- No corporate clipart or rounded modern icons
- No emoji, no playful decorations

Generation Instruction
Generate a cohesive multi-slide deck following this system. Vary the composition patterns above so the deck reads like a research dossier or constructivist poster series. Maintain the beige paper canvas, thin drafting lines, charcoal serif/sans typography mix, and the disciplined neon-yellow geometric accent throughout.

---
Topic / Source: <여기에 주제 또는 소스 노트 명시>
```

---

## 변형 가이드

| 상황 | 권장 패턴 조합 |
|------|---------------|
| AI·연구 사상서 발표 | Cover Triple Collage → Manifesto → Technical Drawing → Geometric Connection → Radar Chart |
| 정책·인문 학술 발표 | Plate Divider → Triple Collage → Technical Drawing → Manifesto → Radar Chart |
| regional innovation 연구 분석 보고 | Cover → Technical Drawing (×2) → Radar Chart → Geometric Connection → Manifesto |
| 박물관·전시 키노트 | Plate Divider → Triple Collage → Technical Drawing → Plate Divider → Manifesto |

## 액센트 베리에이션 (사용 시 신중)

기본 neon yellow `#DFFF00`을 유지하는 것이 가장 본격. 변경이 필요하면 다음만 가능:

| 변주 | HEX | 인상 |
|------|-----|------|
| Neon Yellow (default) | `#DFFF00` | 본격 constructivist |
| Cadmium Red | `#D32F2F` | 더 정통 러시안 구성주의 |
| Electric Cyan | `#00E5FF` | 사이버펑크 / 미래학 |

## NotebookLM 디렉팅 팁

추상적·구성주의 톤이 약하게 그려질 때 추가:

- "Russian constructivist poster, El Lissitzky / Rodchenko reference"
- "matte beige paper, fiber tooth texture"
- "ultra-thin 0.5pt drafting lines, blueprint annotations"
- "monochrome cut-out portrait, sharp edges"
- "neon yellow geometric primitive — circle, square, triangle"

---

## 변경 이력

- **2026-04-30**: 초기 작성. Constructivism Tech 스타일 + 6개 슬라이드 패턴 + 액센트 변주 3종.
