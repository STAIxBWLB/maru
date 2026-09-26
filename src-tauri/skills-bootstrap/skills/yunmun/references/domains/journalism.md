# Domain — long-form journalism

Covers features, investigative and data stories, explanatory news, interviews, press releases written as news, and a reporter's first-person account of reported events. Run with `professional-pass.md` (article-like weighting) and `discourse-pass.md` §1–3. Adapted from upstream sepia, whose version rests on a measured Taiwan corpus; no Korean journalism corpus is measured here, so the Korean examples below are editorial inference.

## Human baseline

Lead and body are two registers: the lead gives the result, the first body paragraph puts a person, a place or a number in front of the reader before any definition. Subheads carry the transitions, so paragraphs rarely open on a connective. Quotations keep the speaker's spoken texture. Every number carries a comparison.

## AI tells in this domain

| Tell | Fix |
|---|---|
| One quotation frame throughout: `OOO은 "완결된 문어체 문장"이라고 밝혔다` | Vary the frame around the quotation only: attribute by context, move the name, split the lead-in. The quoted words are never changed |
| Every spoken quotation complete, tidy and particle-free | On write, keep the speaker's repetitions and half-sentences from the transcript. Quotations from written records are faithful when tidy and are not this tell |
| A manner adverb on every speech verb (`담담하게 말했다`, `힘주어 강조했다`) | Delete the adverb; the verb or a gesture after the quotation carries it |
| Summary or moral ending: `~의 중요성을 보여준다`, `귀추가 주목된다`, `~라는 과제를 남겼다` | End on the last fact, the last quotation, or the person |
| Consecutive paragraphs opening on connectives (`한편`, `이에 따라`, `또한`) | Let the subhead or the juxtaposition do the switching |
| Round, sourceless numbers (`수많은`, `약 절반`, `크게 늘었다`) | The figure, its source, and the baseline it is compared with |

## Rules

1. **Two registers.** The lead may give the result; the first body paragraph must put a person, a place or a number in front of the reader. No scene is written without scene facts from the reporting: a missing detail is a TODO or a question, never prose.
2. **Subheads switch, paragraphs do not announce.** A single paragraph-initial connective is register-normal; what fails is the chain, or a numbered "first, second, third" walk.
3. **Quotations.** Keep spoken texture; terminology in quotation marks is not speech; the speaker's words are never rewritten. Quotation marks follow the venue's style.
4. **Numbers.** A figure carries a comparison (baseline, prior period, or a referent the reader knows) and, when the reporter built the dataset, the method stated in the body.
5. **The reporter's first person** appears to state method, to record a silence or a refusal, and to narrate what the reporter went to see. It does not deliver a verdict the reporting did not establish.
6. **Endings.** No summary, no moral, no speculative outlook. A concrete, sourced next event (a scheduled ruling, a dated data release) is a fact and may close the piece.
7. **Stance (check 4).** The judgment a report commits to is what the reporting established and where the parties disagree, named as such. Blurring a documented disagreement into "both sides" fails.
8. **Density and relevance (checks 2 and 3).** A concrete detail that builds the picture is information and passes; a generic statement true in any context still fails.
