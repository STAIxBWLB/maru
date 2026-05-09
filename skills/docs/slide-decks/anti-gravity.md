# NotebookLM Slide Deck Prompt — Anti-Gravity / Living Artifact

> NotebookLM의 Slide Deck (Visual / Video Overview) 생성 시 일관된 디자인 시스템을 강제하기 위한 마스터 프롬프트.
> Style: **Anti-Gravity / Living Artifact Presentation**

**작성일**: 2026-04-30
**용도**: NotebookLM 슬라이드 덱·Visual Overview 생성용 style directive
**언어 정책**: 슬라이드 본문은 사용자가 입력한 언어(주로 한국어)를 primary, 영어를 secondary 라벨로 사용

---

## 사용 방법

1. NotebookLM에서 **Studio → Slide Deck (또는 Video Overview)** 진입
2. "Customize" 또는 프롬프트 입력란에 아래 [📋 Master Prompt](#-master-prompt) 블록을 통째로 붙여넣기
3. 마지막에 *"Topic / Source: …"* 한 줄 추가하여 주제 명시
4. 한국어 입력의 경우 1번 항목의 *"the language should be what users said in the prompt"*가 자동으로 한국어로 해석됨

---

## 📋 Master Prompt

```
Style Name: Anti-Gravity / Living Artifact Presentation

1. Core Concept (This Matters Most)
This presentation is not a slide deck.
It is a living artifact.
- Visualizes thinking becoming structure
- Feels like an interface for ideas
- Calm, modern, confident, precise
- Built for agents, systems, and future workflows
Think:
- Apple-level clarity
- Google DeepMind research decks
- Calm AI infrastructure product launches

2. Overall Aesthetic
Minimal · Airy · High negative space · No visual noise · Everything feels intentional and breathable
Emotion: "This system already works. We are just showing you."

3. Background & Canvas
- Pure white background as default
- Soft, flowing gradient accents: blue → cyan → violet, very low opacity, corners/edges only, never behind text
- Gradients feel like: light, motion, energy, anti-gravity fields
- No hard shapes. No grids. No textures.

4. Typography System
Headlines: clean modern sans-serif, slightly rounded geometry, medium–bold weight, calm authority (not aggressive)
Examples: "Anti-gravity", "Artifact", "Agent-controlled Browser"
Language: the language should be what users said in the prompt (primary), English as secondary labels (smaller and lighter)
Hierarchy: large headline → one concise explanatory sentence → short bullet or paragraph blocks. No long paragraphs.

5. Color System
- Primary text: black or very dark gray
- Accent: calm blue, used sparingly for headline emphasis, arrows, key icons
- Gradients are decorative, not structural
- If everything looks calm and confident, it's correct.

6. Layout Language
Left-aligned · clear reading flow · wide margins · lots of white space
Common structures: text on left + visual on right · three-column feature cards · one idea per slide
Slides feel like product docs turned into visuals.

7. Visual Metaphors
A. Thought → Structure: messy scribble → arrow → clean diagram/checklist/UI ("Agents turn ambiguity into artifacts")
B. Interface as Proof: realistic browser/app screenshots, cursor highlights, click indicators ("The agent actually does this")
C. Cards as Capabilities: soft rounded rectangles, subtle shadows, icon + title + 1–2 lines. No decoration beyond function.

8. Iconography
Thin-line outline icons · consistent stroke weight · calm and professional
Examples: code brackets, network/manager node, browser window, checklist, diagram nodes
No pixel art. No emojis. No playful icons.

9. Motion & Flow (Implied)
Even in static slides, imply motion: arrows, directional flow, sequential layouts.
Everything suggests systems in operation, not static diagrams.

10. Tone of Copy
Clear · precise · slightly philosophical · no hype language
Avoid: buzzwords, marketing slogans, emotional exaggeration

11. What to Avoid (Strict)
No pixel art · no thick borders · no bright blocks · no collage · no stickers · no loud contrasts
If it feels "fun", it's wrong. If it feels "inevitable", it's right.

12. Generation Instruction
Generate a cohesive multi-slide presentation following this system.
Maintain: white space discipline · soft gradient accents · calm typographic hierarchy · minimal but meaningful visuals.
Every slide should feel like part of one product narrative, not standalone posters.

---
Topic / Source: <여기에 주제 또는 소스 노트 명시>
```

---

## 변형 가이드

| 상황 | 조정 |
|------|------|
| 학술 발표 (regional innovation, 논문 발표) | Section 7-A "Thought → Structure" 메타포를 강조. 인용·근거 카드 추가 |
| 기업 협력 제안 (collabs/) | Section 7-C "Cards as Capabilities"를 메인 레이아웃으로. accent blue를 파트너 브랜드 컬러로 치환 가능 |
| 행정 보고 (admin/) | 개조식 톤 + Section 10 "Tone of Copy" 적용. 한국어 명사형 종결 |
| international cooperation·ODA 영문 발표 | 1번 항목의 primary 언어를 English로 명시적으로 override |

---

## 변경 이력

- **2026-04-30**: 초기 작성. Anti-Gravity / Living Artifact 스타일 시스템 12개 섹션 정리.
