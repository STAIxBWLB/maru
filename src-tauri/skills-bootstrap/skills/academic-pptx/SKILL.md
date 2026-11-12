---
name: academic-pptx
description: "Use when the user wants an editable .pptx for an academic or evidence-evaluated talk (conference paper, seminar, thesis defense, grant briefing, lab meeting, invited lecture), including Korean-language decks. Governs argument structure, action titles, exhibits, citations and communication-first design, then applies the Korean layout fix and a PowerPoint render check."
license: MIT
---

# Academic Presentations

Derived from Gabberflast/academic-pptx-skill (MIT, see `LICENSE`); `README.md` holds provenance and the evidence behind the Korean rules.

This skill governs content, structure and design. The technical work of writing the `.pptx` (pptxgenjs API gotchas, structured decks, `validate.py`) comes from the host's pptx skill: read both before writing code. The skill requires that host skill for pptxgenjs build guidance, `validate.py` and text extraction; when the host has none, stop before building and tell the user the skill cannot run without it. Where they conflict, this skill wins.

| Need | Read |
|---|---|
| Argument structure, action titles, exhibits, citations, deck architecture, timing | `references/content_guidelines.md`, before outlining |
| Per-slide-type patterns with pptxgenjs code | `references/slide_patterns.md`, before building |

## Step 1: Presentation type

- **Structured argument** (default): conference papers, seminars, defenses, grant and policy briefings, lab meetings. Priority: argument → data → layout → aesthetics. Follow `references/content_guidelines.md` in full.
- **Visual / narrative**: public engagement, lay-panel pitches, keynotes. Use the pptx skill's design-forward guidance; argument structure still matters.

Default to structured argument whenever a paper, study, dataset, thesis, grant or conference is mentioned.

## Step 2: Outline before building

Write a slide-by-slide outline (action title, exhibit type). Confirm it with the user when the deck exceeds 10 slides or the content is complex. Run the ghost deck test: the action titles alone, in order, must carry the whole argument; fix the outline until they do.

## Step 3: Design standards

Communication-first design; these override the pptx skill's design-forward defaults.

- **Canvas**: `LAYOUT_WIDE` (13.33 × 7.5 in). The patterns' positions are for 10 in; scale them by 1.333, keep margins and font sizes as stated here. The patterns show placement and sizes: in a structured deck, put those positions on the layouts and placeholders. Where a scaled pattern conflicts with a rule in this file, this file wins.
- **Color**: white content slides; at most three colors. Default primary `1F4E79`, accent `2E75B6`, highlight `FFF2CC` for the one key finding. Color directs attention, never decorates.
- **Font**: one sans family with Hangul glyphs, installed where the deck will be presented (for example Noto Sans KR or the institution's font). Use it for the theme's heading and body fonts.
- **Sizes**: action title 26-28 pt bold; section header 20-22 pt; body 20 pt minimum; chart labels 16-18 pt; on-slide citations 12-14 pt muted. When text does not fit at these sizes, cut words or split the slide.
- **Layout**: left-align body text; 0.5 in minimum margins on one grid; set `margin: 0` on text boxes so their left edge lines up with the title; results slides put the exhibit left and interpretation right. Balance each slide vertically: with few words on the wide canvas, enlarge the exhibit or set body text up to 24 pt rather than leaving the lower half empty.
- **No decoration**: no icons in circles, stock images or clip art; no rules under titles or accent bars; no full-bleed images on content slides; about 40 words (Korean: about 40 eojeol) of body text per content slide.

## Korean decks

Each rule answers a failure seen when the upstream rules were applied to a Korean deck.

- **Action titles**: one complete sentence that fits one line at 28 pt on the wide canvas (about 30 Hangul syllables; Latin letters take less width) and never exceeds two. Longer Korean titles wrapped to two or three lines.
- **Columns**: give 20 pt body text at least 4.5 in of width; narrower columns wrapped every two or three words.
- **Word wrap and fonts**: pptxgenjs tags every run `en-US`, so PowerPoint splits Hangul mid-word, and it leaves the theme's Hangul font slots empty. After `writeFile()` (and the pptx skill's theme step), run:

  ```bash
  python3 scripts/ko_fix.py deck.pptx --font "<the theme font>"
  ```

  It re-tags runs `ko-KR` in slides and speaker notes (PowerPoint then wraps at word boundaries) and sets the theme's East Asian and Hangul fonts. Run it after every rebuild.

## Step 4: Build and QA

1. Build per the pptx skill as a structured deck, then run `ko_fix.py` for Korean text.
2. **File QA**: the pptx skill's `validate.py`. **Content QA**: its text extraction script; check order, typos and leftover placeholders.
3. **Visual QA**: `bash scripts/render_powerpoint.sh deck.pptx` writes `deck.pdf` and `deck-slide-*.png` (zero-padded numbers) through Microsoft PowerPoint for Mac. Look at every image, looking for: Korean words split across lines, titles over two lines, text overflow or clipping, chart data labels touching bars or each other, citations colliding with content, uneven gaps. Fix in the generator, rebuild, rerun `ko_fix.py`, re-render the deck and recheck the changed slides. Exit code 3 means no PowerPoint and exit code 4 means no `pdftoppm` on this host: report visual QA as unverified. LibreOffice is not a substitute renderer.
4. **Academic QA**:
   - every content slide has an action title, and the ghost deck test passes
   - one exhibit per results slide, each with its "so what" marked on the exhibit
   - every borrowed figure or data point is cited on its slide
   - the deck ends in the order `references/content_guidelines.md` §Deck Architecture states
   - body text ≥ 20 pt; no decorative elements; section dividers or a breadcrumb row in decks over 15 slides

## Key principles

- Action titles, not topic labels.
- One argument per talk; the rest goes to the appendix.
- One insight and one exhibit per slide, with the key finding marked on it.
- Slides support speech: narration goes in speaker notes, not on the slide.
- Cite everything borrowed, on the slide and on the References slide.
- End on conclusions, never on "Thank you".

## Dependencies

pptxgenjs and the host pptx skill's scripts (the host requirement stated at the top); Python 3 (`ko_fix.py` uses the standard library only); for visual QA, macOS with Microsoft PowerPoint and `pdftoppm` (Poppler).
