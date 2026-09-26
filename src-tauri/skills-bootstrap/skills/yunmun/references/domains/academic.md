# Domain — 논문·초록·학술 글 (academic writing)

Covers papers, abstracts, research plans, review responses, and scholarly reports, in Korean or English. Run with `professional-pass.md` (article-like weighting), `discourse-pass.md` §1–3 for full papers, and `languages/ko.md` for Korean text.

## Human baseline

Academic prose is formal, dense and conventional by design, and none of that is a tell (`ko.md` §5). What marks a researcher's own text is commitment and limits: the exact claim, the exact condition under which it holds, the result that did not work, and the citation that actually supports the sentence it is attached to. The venue's recent papers are the venue corpus.

## AI tells in this domain

| Tell | Fix |
|---|---|
| Introduction that opens on the importance of the field | Open at the specific problem and the gap |
| Contribution claims by adjective: `새로운`, `효과적인`, `우수한 성능`, novel, comprehensive, robust | What was done and the measured result with its condition |
| Related work as a list: `A는 ~를 제안하였다. B는 ~를 제안하였다.` | Group by approach and state how each group relates to this work |
| Results narrated without numbers, or numbers without conditions | Value, unit, dataset, baseline, variance or interval |
| Limitations that limit nothing: `향후 다양한 데이터로 확장할 필요가 있다` | The specific threat to validity and its likely direction |
| Hedge on every sentence, or on none | Report it. Where a hedge sits is the author's claim: on refactor vary the form of a repeated ending (`ko.md` §2 row 19) but never add or remove a hedge (`ko.md` §7) |
| Abstract that is a table of contents: `본 논문에서는 ~를 살펴보고 ~를 논의한다` | Problem, method, main result with a number, implication |
| English: the `style-pass.md` §3 vocabulary (delve, underscore, pivotal, intricate) in clusters | Plain verbs |

## Rules

1. **Never add, alter or invent a citation, a figure, a result, or a quotation.** A missing reference is a TODO. Citations and quoted text are protected ranges.
2. **Terminology is fixed**: one term per concept throughout, the field's established Korean term, the English original in parentheses at first use only.
3. **Claims carry conditions**: dataset, setting, comparison. Remove a claim the results do not support rather than softening it into vagueness.
4. **Keep the venue's structure and register.** Formal endings, passive constructions where the field uses them, and section conventions are not tells.
5. **Edit for the author's voice.** On refactor, sample the author's own prior papers when available.
6. **Disclosure is the author's decision.** This skill improves clarity; it does not decide whether or how AI assistance is declared, and it states this if asked to help conceal authorship from a venue that forbids it.
