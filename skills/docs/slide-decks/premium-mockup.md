# NotebookLM Slide Deck Prompt — Premium Mockup

> NotebookLM의 Slide Deck (Visual / Video Overview) 생성 시 일관된 디자인 시스템을 강제하기 위한 마스터 프롬프트.
> Style: **Premium Mockup / Modern UI / Clean Tech** — "Showcase in Perfection"

**작성일**: 2026-04-30
**용도**: 프로덕트 런치, 앱·SaaS 데모, UI/UX 케이스 스터디, 테크 키노트
**언어 정책**: Headline은 영문 large + 입력 언어 small, Body는 입력 언어

---

## 사용 방법

1. NotebookLM에서 **Studio → Slide Deck (또는 Video Overview)** 진입
2. "Customize" 또는 프롬프트 입력란에 아래 [📋 Master Prompt](#-master-prompt) 블록을 통째로 붙여넣기
3. 마지막에 *"Topic / Source: …"* 한 줄 추가하여 주제 명시

---

## 📋 Master Prompt

```
Style: Premium Mockup / Modern UI / Clean Tech
Concept: "Showcase in Perfection"
Tone: High-quality, advanced, clean, refined, professional. Studio-grade product photography meets minimal UI design.

Color Palette
- Backgrounds
  - #FFFFFF (pure white)
  - #F5F5F7 (very light gray, studio-like)
  - #000000 (jet black, switching by slide)
- Accent
  - #8D59E9 (Electric Purple — main action color)
  - #EBE021 (Acid Yellow — highlight points & badges)
- Sub
  - #D8E2EC (pale blue-gray for cards and base areas)
  - #2D2D2D (charcoal for text and UI parts)

Visual Identity
- Devices: high-quality 3D mockups of Apple products (Studio Display, MacBook Pro, iPad, iPhone 16 Pro)
- UI screen design
  - Background: jet black (#000000) or vivid gradients (purple, yellow, orange)
  - Typography on screen: extra-bold sans-serif (e.g., Helvetica Now Display Bold) in white
  - Layout on screen: card-based UI, grid layout, oversized numerals

Typography
- Headings: blocky sans-serif with a large jump ratio. English LARGE, language users requested in the prompt SMALL beneath. The language should be what users said in the prompt.
- Body: thin gray gothic. For emphasis, place text on black (#000000), white (#FFFFFF), Electric Purple (#8D59E9), or Acid Yellow (#EBE021).

Common Layout Rules
- Studio Lighting: apply soft realistic shadows under devices to evoke a real studio environment.
- Screen as Hero: device screens occupy 70–80% of slide area.
- Crop / Overflow: allow part of the device to extend beyond slide boundaries for scale and impact.

Layout Variations (Catalog) — pick the variant per slide intent:
- Hero Display — Center the Studio Display with a black-background UI and ultra-bold white title (e.g., "STUDIO DISPLAY MOCKUPS"). Large English title, small subtitle in input language.
- Floating Mobile — Float an iPhone mockup in mid-air showing an app UI. Add blurred accent-colored lighting behind it.
- Grid Interface — Inside a MacBook screen, arrange colorful UI cards (purple, cyan, yellow) in a clean grid.
- Dark Mode Presentation — Device screen in dark mode. Use white + Acid Yellow for high-contrast emphasis.
- Angle Shot — Show device from a diagonal side angle to highlight thinness and texture. Add spec info in the whitespace.
- Split Screen — Left: half a device mockup. Right: large typography. Ensure seamless connection between screen colors and background.
- Card Grid (Text Only) — Extend the device's UI layout to the whole slide. Place white or purple cards on #D8E2EC.
- Big Typography — Black background (#000000) with massive white ultra-bold text. English LARGE, input language very small. Thin white dividers.
- Split UI — Left: large numerals ("16", "3680"). Right: descriptive text. Wrap in card-like frames.
- Feature List Card — White background with rounded gray band (#F5F5F7). Inside: aligned icons + text, large English title, small input-language subtitle.

Design Rules
- High Resolution: all mockup images must be high resolution with no visible pixels.
- Reflection & Gloss: reproduce realistic screen reflections for premium feel.
- UI Spacing: device UI itself follows a spacious, minimal layout (don't crowd the screen).

What to Avoid
- No low-res mockups, no obvious compositing seams
- No accent colors beyond Electric Purple + Acid Yellow + neutrals (no rainbow)
- No skeuomorphic textures, no soft "vintage" treatments
- No emoji as decoration; if icons are needed, use clean line/SF Symbol style

Generation Instruction
Generate a cohesive multi-slide deck following this system. Vary the layout variants so the deck reads like a flagship product launch. Maintain device hero proportions (70–80%), studio lighting, accent discipline (purple + yellow only), and the English-large / input-language-small typographic hierarchy throughout.

---
Topic / Source: <여기에 주제 또는 소스 노트 명시>
```

---

## 변형 가이드

| 상황 | 권장 패턴 조합 |
|------|---------------|
| 앱·SaaS 런치 | Hero Display → Floating Mobile → Grid Interface → Feature List Card → Big Typography |
| UI/UX 케이스 스터디 | Hero Display → Angle Shot → Split Screen → Card Grid → Big Typography |
| 프로덕트 키노트 | Hero Display → Dark Mode → Split UI → Floating Mobile → Big Typography |
| 학과·연구실 디지털 도구 소개 | Feature List Card → Grid Interface → Split UI → Hero Display → Big Typography |

## 액센트 베리에이션

기본 보라+옐로 조합이 과할 경우 다음으로 교체. Master Prompt의 `Accent` 라인만 바꾸면 됨.

| 변주 | Action | Highlight | 인상 |
|------|--------|-----------|------|
| Electric Purple × Acid Yellow (default) | `#8D59E9` | `#EBE021` | 본격 테크 키노트 |
| Indigo × Lime | `#5856D6` | `#CCFF00` | 약간 더 차분한 SaaS |
| Magenta × Mint | `#E54FA0` | `#9BE8C9` | 컨슈머·라이프스타일 앱 |
| Royal Blue × Sunshine | `#2563EB` | `#FACC15` | 엔터프라이즈·금융 톤 |

## NotebookLM 디렉팅 팁

목업 디테일이 약할 때 추가하면 효과적:

- "high-resolution 3D render of Apple device, studio lighting"
- "soft contact shadow, realistic screen reflection"
- "device crops past the slide edge for scale"
- "no visible pixels, no compositing seams"
- "UI screen mock at 70–80% of slide area"

---

## 변경 이력

- **2026-04-30**: 초기 작성. Premium Mockup 스타일 + 10개 레이아웃 변형 + 액센트 변주 4종.
