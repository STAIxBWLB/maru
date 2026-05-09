# NotebookLM Slide Deck Prompt — Refined Minimal Portfolio

> NotebookLM의 Slide Deck (Visual / Video Overview) 생성 시 일관된 디자인 시스템을 강제하기 위한 마스터 프롬프트.
> Style: **Refined Minimal Portfolio** — 좌상단 네비게이션, 여백의 미학, 그리드 기반 레이아웃

**작성일**: 2026-04-30
**용도**: 건축적·아카이브적 톤이 필요한 발표(연구 포트폴리오, 회사 소개, 사업 결과 보고)
**언어 정책**: Body는 사용자 입력 언어(주로 한국어) Gothic 계열, Heading은 영문 sans-serif

---

## 사용 방법

1. NotebookLM에서 **Studio → Slide Deck (또는 Video Overview)** 진입
2. "Customize" 또는 프롬프트 입력란에 아래 [📋 Master Prompt](#-master-prompt) 블록을 통째로 붙여넣기
3. 마지막에 *"Topic / Source: …"* 한 줄 추가하여 주제 명시
4. 본문 언어를 명시적으로 고정하려면 *Typography → Body* 항목의 괄호 부분을 직접 *"Korean"* 등으로 교체

---

## 📋 Master Prompt

```
Style: Refined Minimal Portfolio
Characteristics: Top-left navigation, aesthetics of whitespace, grid-based layout

Global Design Settings
- Tone: Professional, architectural, sharp-edged minimalism
- Color Palette
  - Base: #E9E9E9 (light gray) or #FFFFFF (white)
  - Text: #000000 (jet black) or #333333 (dark gray)
  - Accent: #000000 (black) — used for bold lines and emphasized text
  - Special: Dark mode (black background) — used for slides that need emphasis
- Typography
  - Headings: English sans-serif (Helvetica Now, Inter). Bold and decoratively positioned.
  - Body: (the language users requested in the prompt) Gothic typeface. Small size with generous letter spacing and line height. The language should be what users said in the prompt.

Common Layout Rules
- Navigation: Place a small section number and title such as "01. INTRODUCTION" in the top-left (or top-right) of every slide.
- Grid: Use a strict grid system to align elements.
- Whitespace: Intentionally leave large areas empty (negative space) to create a sense of luxury.

Layout Variations (Catalog) — pick the variant that best matches each slide's purpose:
- Title Typography — Scattered layout. Randomly place award badges or keywords like stamps. The central title is small, bold, and restrained.
- Text + Data Emphasis — Asymmetrical split. Narrative text on the left, oversized numbers (black) on the right. Include thin divider lines.
- Card Grid — Tightly spaced grid. Arrange high-quality images with a web-like interaction feel (e.g., hover-reveal text).
- Full-Screen Graphic — Office interior photography occupying the full screen (or more than half). Concrete textures, desks lined with Macs. Reduce saturation for a cool tone. Add a very small caption in the bottom-left.
- Photo + List Split — 50:50 split. Left: architectural or abstract photography. Right: data list (bold headings + light-weight descriptions). Used for company info. Bold item names, thin body text. Generous spacing; avoid overcrowding. The language should be what users said in the prompt.
- Minimal Map — Silhouette-style map. Light gray background with a white map. Use ultra-thin callout lines to indicate locations.
- Vertical Timeline — Vertical axis. A single thin line with text branching left and right. Clean chronological order.
- Bubble Chart / Venn Diagram — Wireframe style. Black background with thin white line art. Semi-transparent overlapping circles.
- Dialogue (Chat Style) — Minimal conversational format. Not comic speech bubbles, but simple text blocks with bold speaker names.
- Chronological List — Rhythmic list. Large years (e.g., 2024) on the left, descriptions on the right. Strong contrast in font sizes.
- Dark Mode Diagram — Intellectual tech aesthetic. Black background with thin white lines connecting nodes. Constellation- or network-like appearance. Circles connected by fine lines or geometric patterns, expressing a fusion of technology and creativity.
- 3-Step Columns — Typography-driven columns. Large numbers (01, 02, 03) act as pillars. No icons; rely on typographic contrast.
- Logo Grid — Monochrome grid. Convert all logos to black or gray and align them in a strict grid.
- Two Columns (Problem vs Solution) — Sharp contrast. A thick black vertical line separates "Problem" and "Solution". Text aligned in block form.
- Centered Layout (Dark Mode) — Cinematic. A small video thumbnail or key visual centered on a black background. Add an emotional English tagline.
- Formula / Flow Diagram — Mathematical style. Expressions like "A × B = C" rendered in large serif type. Minimal arrows.
- Arrow Steps — Linear process. Place text inside large arrows. High contrast (black arrows with white text).
- Chart — Precision data. Graphs with thin lines ending in small black dots. Scientific instrument-like appearance.

Generation Instruction
Generate a cohesive multi-slide deck. Maintain the top-left section navigation, strict grid alignment, and abundant negative space across every slide. Choose layout variants per slide intent rather than repeating one variant. The deck should read like a refined architectural portfolio — restrained, precise, archival.

---
Topic / Source: <여기에 주제 또는 소스 노트 명시>
```

---

## 변형 가이드

| 상황 | 권장 레이아웃 조합 |
|------|-------------------|
| 회사·연구실 소개 | Title Typography → Photo + List Split → Logo Grid → Full-Screen Graphic |
| 사업 결과 보고 (regional innovation, international cooperation) | Text + Data Emphasis → Vertical Timeline → Chart → Two Columns(Problem vs Solution) |
| 학술 발표·논문 | Formula / Flow Diagram → Bubble Chart → Dark Mode Diagram → Chart |
| 포트폴리오·작품집 | Card Grid → Full-Screen Graphic → Centered Layout (Dark Mode) → Chronological List |
| 행정·정책 브리핑 | 3-Step Columns → Arrow Steps → Minimal Map → Two Columns |

---

## 변경 이력

- **2026-04-30**: 초기 작성. Refined Minimal Portfolio 스타일 + 18개 레이아웃 변형 카탈로그 정리.
