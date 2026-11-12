SKILL.md is the instruction source for this skill. This file is background for maintainers; it holds no directives.

# Canva deck background

## Why a separate skill from notebooklm-deck

| Aspect | NotebookLM | Canva |
|------|-----------|-------|
| Input length | Effectively unlimited (a long master prompt works) | Short (Magic Design input is about 150-300 characters; AI 프레젠테이션 prompts are mostly short) |
| Style control | The prompt is the design system | Canva templates and the brand kit come first; the prompt is secondary |
| Slide count | NotebookLM decides | The user can set it (5/10/15/20) |
| Layout vocabulary | Free description | Works best when it matches Canva's built-in template categories |
| Images | Text to AI illustration | Built-in stock plus Magic Media generation |

Canva ignores a NotebookLM master prompt pasted as is. It responds to a compressed combination of four or five elements: tone, template search terms, slide count, and audience.

## Shared catalog

The style catalog lives in `docs/slide-decks/` of the skills bundle and is shared with `notebooklm-deck`. A new style file added there is picked up by both skills without a skill edit.

## Further usage examples

These examples were trimmed from SKILL.md; the workflow steps already cover the behavior they show.

- Vibe only: "캐주얼 캠페인 제안서를 Canva로 7장 만들고 싶어." leads to a first choice of Blood Orange Agency and a second of Yellow Fashion Mag, then the user's pick, then the step 3 output.
- Interactive outline: "위 프롬프트로 슬라이드별 outline도 같이 줘." adds the fourth block of step 4, one line per slide for ten slides (Cover / Setup / Year 2 KPIs / Pivot / Outcomes / etc.).
