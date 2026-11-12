# academic-pptx

Human companion. Instructions live in `SKILL.md`; agents read this file only when editing the skill.

## Provenance

- Upstream: [Gabberflast/academic-pptx-skill](https://github.com/Gabberflast/academic-pptx-skill), commit `9f2b703`, MIT (`LICENSE` keeps the upstream notice).
- `references/content_guidelines.md` and `references/slide_patterns.md` are the upstream files with these edits:
  - decorative rule shapes removed from the patterns (title dividers, accent bars); upstream SKILL.md already forbids them, and the bundle's design rule bans single-edge accent lines
  - pattern font default changed from Arial (no Hangul) to a Hangul-capable family; canvas note points to `LAYOUT_WIDE`
  - References placed after Conclusions, resolving the upstream conflict between "References is last before the appendix" and "Conclusions is the last slide"
  - the pointer to `pptxgenjs.md` made host-neutral; the example contact line uses placeholders
- `SKILL.md` is rewritten around the upstream one: same steps and checklist, plus the Korean section and the PowerPoint render step. Upstream's LibreOffice render step is dropped (banned in this bundle).

## Evidence for the Korean rules (2026-10-31)

The same 10-minute Korean seminar deck was built twice by independent agents (pptx skill alone; pptx + upstream academic-pptx) and rendered in PowerPoint for Mac.

- Upstream rules on the 10 in canvas produced 39-60 character action titles at 24 pt; nearly all wrapped to two or three lines.
- 20 pt body in columns under about 4 in wrapped every two or three words.
- Hangul split mid-word in titles, table cells and bullets. pptxgenjs writes `lang="en-US"` on every run; re-tagging to `ko-KR` alone fixed the splits. Adding `eaLnBrk="0"` produced a pixel-identical render, so it is not used.
- pptxgenjs writes only the Latin theme font; without the East Asian and Hangul slots, Hangul falls back to the host default font.

## Render script notes

`scripts/render_powerpoint.sh` copies the deck into PowerPoint's sandbox container before opening it. Opening or saving outside the container raises a "Grant File Access" dialog that blocks AppleScript until a person answers it. Exports are serialized with a lock directory because PowerPoint handles one scripted export at a time.

## Rebuild checks

Two fresh agents rebuilt the same deck from this skill alone. The first build had every title on one line and no mid-word Hangul breaks, but slides were top-heavy; that led to the layout balance rule and the pattern fixes (19 pt text, centred callout, extra colours). The second build was clean after four render rounds and surfaced two pattern bugs, now fixed: `bullet` set once on a run array bullets only the first paragraph (it belongs on each paragraph's first run), and shape borders take `width`, not `pt`.
