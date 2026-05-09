# NotebookLM Slide Deck Prompt — Comic Story

> NotebookLM의 Slide Deck (Visual / Video Overview) 생성 시 일관된 디자인 시스템을 강제하기 위한 마스터 프롬프트.
> Style: **Comic Story** — 만화적 스토리텔링으로 정보를 더 쉽게, 더 오래 기억하게 만드는 스타일

**작성일**: 2026-04-30
**용도**: 교육·강의·튜토리얼·온보딩처럼 "재미있게 이해시켜야 하는" 발표
**언어 정책**: 모든 본문(말풍선·내레이션 포함)은 사용자 입력 언어(주로 한국어)

---

## 핵심 철학

> Understanding becomes deeper with "fun." Sometimes, it's recommended to turn information into a comic and input it along with a story. You can relate it to your own situation, and it's easier to remember.

- 정보를 **한 명의 주인공이 겪는 사건**으로 바꾼다
- 시청자가 자기 상황에 대입할 수 있도록 **일상적·구체적인 장면**을 사용한다
- 재미는 장식이 아니라 **기억을 위한 인지 도구**

---

## 사용 방법

1. NotebookLM에서 **Studio → Slide Deck (또는 Video Overview)** 진입
2. "Customize" 또는 프롬프트 입력란에 아래 [📋 Master Prompt](#-master-prompt) 블록을 통째로 붙여넣기
3. 마지막에 *"Topic / Source: …"* 와 *"Protagonist / 주인공: …"* 두 줄 추가
4. 주인공 설정은 청중 페르소나와 가깝게 (예: "신입 연구원 지수", "AI 처음 쓰는 50대 행정직원 김 주임")

---

## 📋 Master Prompt

```
Style: Comic Story — informational comic deck
Philosophy: Understanding becomes deeper with "fun." Turn the information into a comic with a story, so the audience can relate it to their own situation and remember it longer.

Narrative System
- Pick ONE protagonist who is similar to the audience and follow them across the entire deck.
- Each slide is a panel (or a short panel sequence) that advances ONE beat of the story.
- Story arc: Setup → Problem → Friction → Insight → Resolution → Takeaway.
- Every abstract concept is grounded in a concrete moment the protagonist experiences.

Language Rules
- All dialogue, narration, captions, and onomatopoeia must be in the language users requested in the prompt. The language should be what users said in the prompt.
- Short sentences. Spoken-sounding. No textbook phrasing.
- One key term per panel may be highlighted (bold or accent color) — never more.

Visual System
- Comic-style illustration: clean line art, flat color fills, expressive faces, simple backgrounds.
- Reference vibe: editorial webcomic / instructional manga / Calm-app-meets-XKCD. NOT corporate clipart, NOT 3D render, NOT photorealistic.
- Color palette: warm off-white background (#FAF7F2), black line art, 2–3 muted accent colors max (e.g., soft coral, dusty teal, mustard). Keep it cohesive across all slides.
- Speech bubbles: simple rounded rectangles or ovals with a small tail. Bold speaker labels are optional. Avoid heavy comic-book outlines.
- Sound effects (onomatopoeia) used sparingly for emphasis, hand-drawn feel.
- Panels: 1–4 panels per slide. Use gutters (white space between panels) to create rhythm.
- Typography: friendly humanist sans-serif for narration; slightly more handwritten feel for dialogue (still legible). Headings can be bold and large but never shouty.

Slide Patterns (mix across the deck)
- Cover Panel — Single illustration of the protagonist in their everyday context. Title overlaid in a calm corner. One-line hook beneath.
- Setup Panel — "Meet [protagonist]." Establish who they are and what they want. Single panel.
- Problem Panel — Protagonist hits a wall. Visual confusion / question mark / sweat drop. Caption states the problem in plain language.
- Dialogue Panel — Two characters in conversation. Use this when introducing a concept through Q&A.
- Aha Panel — Lightbulb / lifted brow / wide eyes. The insight lands. Key term highlighted once.
- Diagram-in-Comic Panel — A simple diagram (arrows, boxes, icons) drawn in the same hand-drawn style, with the protagonist pointing at it.
- Before/After Panel — Two panels side-by-side: protagonist before applying the idea, protagonist after.
- Relatable Scene Panel — Mundane setting (commute, kitchen, desk at 11pm) where the audience sees themselves.
- Recap Strip — A horizontal strip of 3–5 tiny panels summarizing the journey at the end.
- Takeaway Card — Single calm slide, one sentence, protagonist giving a small wave or thumbs-up.

Tone of Copy
Warm, curious, slightly self-deprecating. The protagonist is allowed to be wrong, confused, surprised. The narrator is a friendly guide, never a lecturer. Humor is gentle and situational — never sarcastic, never punching down.

What to Avoid
- No stock-photo people, no 3D characters, no AI-uncanny faces
- No dense paragraphs. If a panel needs more than ~25 words of narration, split it.
- No corporate icon sets pasted into comic panels
- No fourth-wall-breaking marketing pitches
- No more than ONE highlighted key term per panel

Generation Instruction
Generate a cohesive multi-slide comic deck following this system. Maintain the same protagonist, art style, and palette across all slides. Vary panel patterns so the deck reads like a short illustrated story, not a slide template repeated. End with a Recap Strip and a Takeaway Card.

---
Topic / Source: <여기에 주제 또는 소스 노트 명시>
Protagonist / 주인공: <청중과 닮은 1명의 캐릭터를 한 줄로 묘사>
```

---

## 변형 가이드

| 상황 | 추천 주인공 / 톤 |
|------|----------------|
| 신입생 OT, 학과 소개 | 입학 첫 주 신입생. 약간 긴장한 캠퍼스 첫날 |
| international cooperation·해외 강의 (영문) | "first-year researcher" persona, English everywhere |
| 행정 시스템 사용법 (학내 매뉴얼) | 본인 부서 직원 페르소나, 실제 화면 캡처를 만화 패널 안에 손그림 프레임으로 배치 |
| AI 리터러시 강의 (학생/교수) | 시니어 교수 / 일반 학생 두 캐릭터 대화체 — 세대차 활용 |
| 어린이·청소년 대상 | 또래 캐릭터, 큰 표정, onomatopoeia 비중 ↑ |

## 스토리 비트 체크리스트

발표 전 다음 6개 빈칸을 직접 채운 뒤 NotebookLM에 입력하면 결과 품질이 크게 올라간다:

1. **Setup**: 주인공이 평소 무엇을 하는가?
2. **Problem**: 어떤 순간에 막히는가?
3. **Friction**: 처음 시도한 해결책이 왜 실패하는가?
4. **Insight**: 무엇을 깨닫는가? (오늘의 핵심 개념)
5. **Resolution**: 그 개념을 적용해 무엇이 달라지는가?
6. **Takeaway**: 청중이 한 줄로 가져갈 메시지는?

---

## 변경 이력

- **2026-04-30**: 초기 작성. 만화 스토리텔링 시스템 + 10개 패널 패턴 + 6단계 스토리 비트 정리.
