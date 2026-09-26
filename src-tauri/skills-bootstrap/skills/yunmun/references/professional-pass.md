# Professional pass — shared layer for non-fiction

Applies to every non-fiction domain (release notes, PR/issue replies, postmortems, tickets, technical articles, long-form journalism, and anything else that isn't invented narrative). Evidence: the slop taxonomy (Shaib et al., S), expert AI-detector studies (Russell et al., R), genre-alignment findings (Reinhart et al., P), and the Wikipedia/humanizer corpus of documented tells (W). Stable source identities live in the upstream sepia research ledger (see `ATTRIBUTION.md`); single-letter aliases in this file are file-local. Prescriptions are design inferences of this skill unless a cited source explicitly tested the intervention.

> In professional genres the goal is not "fool a detector" — it is that the text carries information, has a stance, and sounds like it came from the person whose name is on it. Conventional structure is *fine* here; slop is the filler inside the structure.

## Read the venue first

Before writing or editing, sample 2–3 recent human-written artifacts from the same venue — the repo's past release notes, the maintainer's recent replies, the team's last postmortem — and match their register, length norms, and formatting habits. Reinhart et al. report that instruction-tuned models favor an informationally dense, noun-heavy style and struggle to match genre-aligned variation (P). The venue corpus, not this skill, defines the target voice. When no corpus exists, the domain file's baseline applies.

## The checklist

Run these one at a time (a combined pass goes blind — measured on this very taxonomy). Slop is **cumulative**: one hit means nothing; clusters mean rewrite.

| # | Check | What to hunt |
|---|---|---|
| 1 | Chatbot residue | "Great question", "Thanks for raising this!", "I hope this helps", "Certainly!", "You're absolutely right", offers of further help, apology openers, "Let's dive in". Delete — a colleague doesn't talk like a support desk. |
| 2 | Density | Could this say the same at half the length? Generic statements true in any context ("in today's fast-paced world", "it's important to note") carry zero information — cut. Length must be proportional to stakes, in both directions: a trimmed answer that lost a required caveat or the next step fails too. |
| 3 | Relevance | Does every paragraph serve *the reader's task* — the thing they came to find out? Background the reader already has, restated questions, and scope tours are filler. |
| 4 | Stance | Where a judgment is required, the author must commit to one. On review, report the missing verdict; on refactor never manufacture it by deleting the author's hedges (closing check 3). Absent subjectivity is a measured slop dimension (S): a review without a verdict, a comparison without a recommendation, a postmortem without an admitted mistake. Hedge once per genuinely fragile claim, not per sentence. |
| 5 | Specificity | Versions, numbers, file:line, commands, error text verbatim, names — present and **real**. Never pad with invented specifics; a wrong fact stated confidently is itself a top-tier tell (R). Missing info → ask or leave an explicit TODO. |
| 6 | Formatting tells | Bold-mini-heading bullet lists where prose would do; emoji as decoration; Title Case headings; every section the same length; lists of exactly three, everywhere; a heading restated by its first sentence; fractal summaries (announce → say → recap at every level) (W). The absence of these is not evidence of a human: which formatting a model over- or under-uses changes with its release (see the prose layers in `model-fingerprints.md`). |
| 7 | Conclusion residue | "In conclusion/summary" sections, restating what was said, generic future outlook ("we will continue to improve…"). End when the content ends. |
| 8 | Templatedness | The same sentence frame recycled ("X, a Y at Z, said that…" three times); every item phrased identically. Vary or tabulate. |
| 9 | Sameness of rhythm | Uniform paragraph and sentence lengths throughout. Human professional prose is uneven — depth where it matters, one-liners where it doesn't. Measure sentence rhythm with the check in `style-pass.md` §5. |
| 10 | Fluency | Grammatically correct but unsayable ("the earthen area that formerly held the puddle"). Read it aloud; if no one would say or write it in an email, redo it in speech-shaped syntax. |

For Korean targets the quoted English phrases above are examples of the shape only; the Korean forms of checks 1, 2, 6, 7 and 10 are listed in `languages/ko.md` §2.

Then finish with the vocabulary and syntax scan (English: `style-pass.md` §2–3; Korean: `languages/ko.md` §2, which replaces those lists) and the closing checks below.

## Domain weighting

Which checks dominate depends on document shape (measured: S):

| Document shape | Weight first |
|---|---|
| Article-like (postmortem, tech article, announcement, report or plan, proposal, academic text) | Relevance, density, stance/tone, coherence |
| Short answers (PR/issue replies, review comments, tickets, email and messenger) | Factuality, specificity, templatedness — density and tone matter less at short length |

Weighting sets the order and depth of attention, not an exemption: a short reply drowning in filler still fails density.

For long-form (articles, postmortems), also run `discourse-pass.md` §1–3. It looks for redundant paragraphs, material the reader did not need, and a body that only elaborates the opening. A first-sentence outline that reads as a clean summary is conventional structure and passes.

## Report format (review; refactor stage 1 prints the same report before editing)

```text
YUNMUN REVIEW — <document type, venue>
Loaded: <files used>
Model: author=<value> executor=<value>   (value: none (human author, per user) | unknown | <family> version=unknown | <family> <release>; a release is an exact tag like Fable 5.1 or GPT-5.6 — "GPT-5" alone is a family, write "GPT version=unknown")
Prose layer: author=<operative | prior | none> executor=<operative | prior | none | n/a>   (n/a = review: the executor produces no prose)   (operative = the release's own table is operative and the family's other tables are priors)
Venue corpus: <artifacts sampled, or "none — using domain baseline">
Style scan: <English: style-pass §2–3 hits; Korean: ko.md §2 hits cited as ko-r<row>; plus rhythm hits; each with quoted evidence, or none>
Failed: <#n check-name — quoted evidence>   (one line per failed check; #n is a checklist number, never a ko.md row)
Missing: <facts the text needs and does not contain: figure, date, owner, source | none>   (absent facts are not slop; never fill them; an unrecoverable omitted constituent, ko-r30, goes on both the Style scan and the Missing line)
Notes: <suspected factual or consistency errors, convention mismatches (ko.md §0), quoted; reported, never fixed | none>
Deferred: <#n check-name — quoted evidence — needs human | none>   (unattended runs only; omitted otherwise)
Protected: <#n check-name — quoted evidence | none>   (only when ranges were declared, omitted otherwise; the passage is identified by its quoted words, never by a number the model derives — the caller already holds its own ranges)
Passed: <check numbers only>
Gates: <refactor and recreate stage 2 only, printed after the edit: hedges before/after, obligations before/after, hunted-pattern counts source → result, share of characters changed, sentences touched>
Verdict: <clean / isolated hits / cluster> → <ship / ship (resolve Notes first) / refactor / recreate / recreate (blocked: needs <list from Missing>)>
```

Choosing the verdict. Two kinds of finding are judged separately. **Substantive failures** (checks 2–5: a dropped caveat or next step, irrelevant content, a missing required judgment, a wrong or unsupported fact) count singly: one is enough for refactor. **Style signals** (checks 1, 6–10 and every vocabulary, syntax and rhythm hit) are cumulative: a single hit → clean, because one hit means nothing; isolated hits (two or more rows, or one row repeated) → refactor. A cluster inside a sound structure → refactor. A cluster where relevance, stance or structure fails (checks 3, 4, 8) and the text is short → recreate. When the facts a rewrite needs are on the `Missing:` line, the verdict is blocked: report, ask, and do not produce a skeleton of markers. Blocked applies to recreate only; refactor proceeds. Place a `〔확인필요〕` marker only where a flagged defect could not be fixed without the missing fact; every other gap goes to the question list after the change list. Clean text with an error on the `Notes:` line is `ship (resolve Notes first)`.

## Closing checks — every route

These four are language-neutral and close every route, so a short piece does not need `style-pass.md` opened for them. Long pieces and English targets load `style-pass.md` in full.

1. **Sentence rhythm** (`style-pass.md` §5). Look for runs of three or more adjacent sentences of about the same length, counted in one consistent unit (words; 어절 for Korean). A run is a candidate signal that counts only beside other hits. Fix by moving words, never by adding them: split one, merge two, or delete a clause. Text with no running prose of paragraph length (a one-line reply, a list, a table, a 개조식 block) reports `none`.
2. **Deletion and reversion tests** (refactor and recreate; `style-pass.md` §4, last paragraph). On every word you added: strike it; if the sentence still parses and says the same thing, it was filler. On every replacement: put the old wording back; if it was sound and shorter, keep the old. Repair stays: the words a broken or split sentence needs, the verb that replaces a nominalization, and in Korean the particles, endings and constituents restored under `ko.md` §2B.
3. **Rewriter gates** (refactor and recreate). Your edit must not change the claim or plant new tells. Each claim keeps its own certainty, obligation and polarity (hedge and obligation totals before and after are a cross-check); no hedge, emphatic or negation is added for effect; polarity, causal direction and the conclusion are unchanged; numbers, dates, names and quotations are byte-identical; the result holds no more of the hunted patterns than the source did; and a refactor that changed more than about half the text was a recreate, so say so. Korean markers and the full table: `ko.md` §7.
4. **Whitelists.** The table below, `style-pass.md` §7 when loaded, and `ko.md` §4–5 for Korean.

## Whitelist — conventional ≠ slop

| Do not flag | Why |
|---|---|
| Changelog categories, issue/PR templates, RFC sections, runbook formats | Formulaic containers by convention; the community expects them |
| Formal register in a formal venue | Register match beats forced casualness |
| A form owned by another rule: 개조식 noun endings, an official-document template, a workspace style rule | Form belongs to that rule or skill (for 개조식, `gaejosik`); check the content inside it, never the form. Parallel item phrasing and colon labels inside such a form are not checks 6 or 8 hits |
| Bullets for genuinely enumerable items | Tables and lists are correct for enumerable facts |
| Terse, unadorned replies | Brevity is the human default in dev venues, not a tell |
| The author's own verified habits | Edit toward their voice, not a generic "human" |
