# Domain — 보고서·계획서 (reports and plans)

Covers status reports, result reports, analysis reports, trip and event reports, operating plans, and internal briefings, in prose or in 개조식. Run with `professional-pass.md` (article-like weighting) and `languages/ko.md`.

**Form is not yours.** 개조식 noun endings, heading numbering, symbol ladders and official templates belong to the `gaejosik` skill, the organization's template, or the workspace style rule. Check the content inside the form. Never flag uniform line length or noun endings in a 개조식 document (`ko.md` §5).

## Human baseline

A report written by the person who did the work leads with the result and the decision it needs. It is uneven: two lines on what went as planned, a page on what did not. Numbers carry their unit, date and source. It names who does what by when.

## AI tells in this domain

| Tell | Fix |
|---|---|
| Background and 추진 배경 longer than the result | Result and requested decision first; background is what the reader does not already know |
| Every section the same depth, every item the same length | Depth follows importance; an item with nothing to report gets one line or is cut |
| Expected effects with no basis: `업무 효율성 제고`, `역량 강화 기대`, `시너지 창출` | The figure and baseline when the source has them. Otherwise keep the claim, report it on `Missing:`, and delete only a line that repeats another |
| Sourceless round numbers and invented statistics | Real figure with source and date. Missing: leave `〔확인필요〕` or ask. Never fill in |
| Problems described without an owner: `미흡한 부분이 있었음`, `개선이 필요함` | What failed, why, who fixes it, by when |
| 향후 계획 as aspiration: `지속적으로 노력`, `적극 검토`, `긴밀히 협력` | Action, owner, date. If undecided, say what decision is pending and with whom |
| Inflation adjectives stacked in one line (`ko.md` §2 row 22); generic policy verbs with no stated action (row 5) | The fact the adjective stands in for; the action the source actually names, otherwise `Missing:` |
| A closing 종합 or 결론 that restates the body | End at the last decision or schedule item |

## Rules

1. **Result first.** The first screen answers: what happened, what it means, what the reader must decide.
2. **Claims of effect are checked, not culled.** Flag an effect that is repeated or has no basis in the document. Keep distinct effects, qualitative ones included. A number and its baseline are used when the source has them; when it does not, report it on the `Missing:` line and never supply one.
3. **Schedule and ownership are concrete**: date, owner, deliverable. Tables are correct for these.
4. **Admit the miss.** A report with no deviation from plan, in a project that had one, fails stance (check 4).
5. **Attachments carry the detail.** Link or attach rather than restating.
6. **Do not change facts, amounts, names, dates, or article numbers** on refactor. They are protected content. Recompute derived figures (rates, sums, totals across tables) from the numbers on the page; report a mismatch on the `Notes:` line and never fix it.
