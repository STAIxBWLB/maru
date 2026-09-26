# Discourse pass — paragraph flow (long-form professional prose)

The layer between structure and sentences: how paragraphs advance, where the body sags, and where things sit on the page. Rewritten for professional prose from upstream sepia's fiction-oriented pass. Evidence: QUDsim/COLM 2025 (Q), Tripto et al. EMNLP 2025 (T), Russell et al. ACL 2025 (R), asavvin's outline test (A). Stable source identities live in the upstream sepia research ledger (see `ATTRIBUTION.md`); single-letter aliases in this file are file-local. Q and A were developed on narrative text; applying them to reports, papers and articles is an inference of this skill.

**Conventional structure is not a defect.** Topic sentences, an abstract that summarizes, IMRaD, a report that leads with its result, and a first-sentence outline that reads as a clean summary are what these venues teach and expect. This pass looks for redundancy and misplaced material, never for tidiness itself.

## 1 The QUD check — what question does each paragraph answer?

Every paragraph implicitly answers a question. Models given the same premise independently reuse the same question sequence, and surface rewording does not change it (Q).

**Check:** list one implicit question per paragraph.

| Flag | Symptom |
|---|---|
| Two paragraphs, one question | The second restates the first in other words |
| A question the reader did not have | Background the reader already holds, a scope tour, a restated prompt (check 3) |
| The reflection tail | Closing paragraphs that answer only "what does this mean" or "what comes next" in general terms (check 7) |
| A required question never asked | The venue expects a comparison with an alternative, a test of the claim, or a limitation, and no paragraph supplies it |

**Fix:** delete or merge the redundant paragraph; move a paragraph to where its question arises. For a required question that was never asked, report it on the `Missing:` line. Never write a comparison, a counter-argument or a limitation that the source does not contain.

**Outline test (A):** extract the first sentence of every paragraph and read them as a list. Use it to find two first sentences that say the same thing, a first sentence that only restates its heading, and a paragraph whose first sentence promises something the paragraph does not deliver. A list that reads as a clean summary passes.

## 2 The body is the choke point

Detectors and human judges find AI text most identifiable in the **body**, least in openings and endings: models imitate formulaic bookends well and expose themselves in the long middle. This was measured on news, essays and email as well as fiction (T).

**Check the middle third:** is each section doing work the opening did not already do, or is it elaborating the introduction at the same level of generality? Does depth follow importance, or does every section get the same space? Human writing shows high cross-paragraph variance; models hold one register and one depth for the whole text (T).

**Fix:** cut what the opening already said; move depth to where the source material has it. Do not add material to even things out.

## 3 Structural positions on the page

Position patterns survive paraphrase better than word choice does: after full paraphrasing, position tells became more visible to expert detectors, not less (R).

| Position tell | Machine habit | Human habit |
|---|---|---|
| Paragraph lengths | Uniform | Ragged, including a one-sentence paragraph |
| Quotations and key lines | Always closing a paragraph | Anywhere, including mid-paragraph |
| Section transitions | The same connective formula each time | Varied, or carried by the heading |
| Emphasis | Evenly distributed | Clustered where it matters, absent elsewhere |

The paragraph-length row means uniformity *within the text*. Paragraph length and paragraph count on their own are not signals: measured directions contradict across corpora and follow prompt limits and venue conventions (`style-pass.md` §7). Lists of exactly three are covered by `professional-pass.md` check 6 and, for Korean, by `languages/ko.md` §2 row 21, where a list of three is ordinary. These tells are candidates that count only beside other hits.
