# Korean calibration — 한국어 보정

Load whenever the target text is Korean, and apply it at the vocabulary and syntax scan that follows the ten checks of `professional-pass.md`, whether or not `style-pass.md` is loaded. It replaces the English-only lists in `style-pass.md` §2–4 and supplies the Korean forms of `professional-pass.md` checks 1, 2, 6, 7 and 10. It changes nothing else about the route. English ban lists do not transfer to Korean; what transfers is the *shape* of each check. Mixed Korean and English text is judged passage by passage.

Evidence, with file-local aliases. The class of every row below is one of these:

- **K** = KatFishNet (Park et al., ACL 2025, arXiv:2503.00032). Measured. 470 human texts (181 student essays, 189 poems, 100 computer-science abstracts from 2016–2018) against 1,624 texts from GPT-4o, Solar, Qwen2 72B and Llama 3.1 70B.
- **I** = the corpus study published with im-not-ai (epoko77-ai, 2026, MIT, <https://github.com/epoko77-ai/im-not-ai>, `references/empirical-validation.md` and its taxonomy). Measured. 60 AI pieces (Fable 5, GPT-5.6-sol, Haiku 4.5, bare prompts) against 60 Korean opinion, essay and analysis pieces published before 2022, log-likelihood G², later extended to 99 AI pieces and a task-matched control. It also publishes the rules its data *rejected*, which this file follows.
- **N** = normative Korean references: 한글 맞춤법 (including 부록 문장 부호, 2014 개정), 외래어 표기법, 공문서 표기 in 행정업무의 운영 및 혁신에 관한 규정 시행규칙, and the National Institute of Korean Language guide 「한눈에 알아보는 공공언어 바로 쓰기」. Venue rules and quality rules, not evidence about authorship.
- **F** = fluent-korean (snflkd, 2026, MIT, <https://github.com/snflkd/fluent-korean>): a practitioner guideline against the *compressed* failure of machine Korean. Not measured.
- **D** = the humanizer in korean-skills (Dale Seo, 2026, MIT, <https://github.com/DaleSeo/korean-skills>): practitioner patterns; by its own labelling everything outside its KatFishNet rows is community observation. Not measured.
- **H** = editorial heuristics of this skill. Not measured.

Only K and I rows may be called AI signals. N, F, D and H rows are quality edits: worth making, never evidence that a model wrote the text. Ideas are restated and examples are new; no text is copied from F, D or I.

## 0 Korean conventions (N; venue rules, not authorship signals)

A mismatch here is a register or notation error to fix when the venue demands it. Report it on the `Notes:` line. A workspace or organization style rule outranks every row.

| Convention | Rule | How yunmun applies it |
|---|---|---|
| Date in official documents | `2026. 9. 19.` (periods, spaces, final period); weekday `2026. 9. 19.(토)` | Fix only in 공문·보고서 venues. Prose venues may write `2026년 9월 19일` |
| Time | 24-hour `14:30` in official documents | Same gate |
| Money | `금113,560원(금일십일만삼천오백육십원)` in official documents; elsewhere `113,560원` or `11만 3,560원` | Never change the amount, only the notation |
| Numerals | One system per document for the same kind of quantity; fixed idioms (`한두 번`, `두세 개`) stay in Hangul | Flag drift, not a consistent choice |
| Units | A unit noun is spaced from a Hangul numeral (`열 개`) and may be closed up after an Arabic numeral (`10개`, `10,000원`, `5명`); `%` closed up (한글 맞춤법 제43항) | Do not "correct" `10개` to `10 개` |
| Range | 물결표 `3~5개월`, `10. 1.~10. 15.` | Consistency only |
| Quotation | Direct speech " ", quotation inside a quotation or emphasis ' ' | Do not swap a writer's consistent choice |
| Titles of works | 「 」『 』 or " " ' ' ; one system per document | Flag only mixed systems |
| 가운뎃점 and comma | 가운뎃점 binds paired or grouped items (`한·미`, `금·은·동메달`) and is conventional in Korean official enumeration; comma for looser lists | Keep a consistent writer or venue choice |
| Ellipsis and dash | 줄임표 may be `……` or `...`; the dash is rare in Korean prose | Row 36 applies where a dash leaves the relation between its two sides unstated; a dash whose relation is clear is not a hit |
| Sentence ending register | One of 합쇼체(-습니다), 해요체(-어요), 해라체(-다), or 개조식 noun endings per document or section | Mixed registers are a fluency finding. 개조식 form belongs to `gaejosik` |
| List items | Items of one list end the same way (all sentences, or all noun endings) | Flag a mixed list |
| First person and honorifics | One of 저희 / 우리 / 본 연구 · 필자, and one way of naming each person or body | Flag drift only when it confuses reference |
| Terms and loanwords | One term per concept (사용자 / 유저 / 이용자: pick one); spelling per 외래어 표기법; Korean term first with the abbreviation in parentheses at first use in public documents | Majority usage in the document wins; venue-gated to public and official text |

## 1 Measured

### 1.1 KatFishNet (K)

All comma metrics are sentence-level values averaged per text; lengths are in morphemes.

| Feature | Human (essay / poem / abstract) | LLM | Reading |
|---|---|---|---|
| Sentences containing a comma | 26.31% / 27.01% / 47.48% | 61.03% / 42.90% / 65.21% | Higher in all three genres; a majority of sentences in essays and abstracts |
| Commas per morpheme | 1.13% / 2.61% / 1.73% | 2.56% / 4.84% / 2.40% | Roughly double in essays and poems |
| **Comma right after a connective ending** (-고, -며, -지만, -아서/어서, -는데) | 4.10% / 4.68% / 13.27% | 19.83% / 15.57% / 28.01% | The sharpest single Korean feature: the ending already marks the boundary |
| Comma position in the sentence (0 = start) | 0.09 / 0.14 / 0.20 | 0.18 / 0.28 / 0.25 | LLM commas sit later, closing long clauses |
| Segment length between commas | 4.35 / 1.96 / 9.07 | 8.56 / 2.13 / 11.55 | Long comma-joined clauses |
| Spacing (띄어쓰기) | Omits spaces for stylistic and grammatical reasons | "Strictly follow spacing rules"; essay spacing ratio SD 0.02 | Rule-perfect spacing is the LLM side |
| Part-of-speech combinations | More diverse | Less diverse | The Korean form of templatedness |

### 1.2 The im-not-ai corpus study (I)

Rates per 1,000 어절 unless noted.

| Finding | AI | Human | Reading |
|---|---|---|---|
| **Negative antithesis `A가 아니라 B`** | 5.8 | 0.6 | 9.2×, G² 41.7, in all three model families sampled. The strongest signal in that sample |
| Cleft framing `필요한 것은 X다` · `문제는/핵심은/관건은 ~다` | 0.92 | 0.09 | About 10×; `필요한 것은` had 0 human uses; holds under task matching |
| Paragraph closing on an obligation (`~해야 한다` as the last sentence, repeatedly) | 13.51 | 1.87 | 7.22× in a 24-pair control |
| Generated metaphor with a sensory verdict (`진단은 서늘하다`), counted as a family | 1.46 | 0.34 | 4.3×; single metaphors are too rare to judge alone |
| Convergence on plain policy verbs (확대·강화·개선·구축·마련 and the like, 9 words) | 31.3 per 10,000 characters | 9.3 per 10,000 characters | 3.4×. Old bureaucratic Sino-Korean (제고·도모·박차) showed **no** gap |
| Passive progressive `심화되고 있다` | 3.44 | 1.38 | Specific to the passive: active `~하고 있다` shows no gap (1.28×) |
| Comma excess | 49.1 | 33.4 | 1.5×, same direction as K |
| Emphasis in quotation marks | — | — | 2.4× more in AI once tasks are matched |
| Placard sentence standing alone (`과제도 남아 있다`, `한계도 분명하다`) | 8 pieces | 0 | Human 0 |
| **Absent: sentences of 100+ characters** | 8.1 | 91.3 | 11× against edited prose, about 4× against personal blogs |
| Absent: quotations / parentheses | 0.0 / 1.2 | 8.7 / 10.6 | Observe only |

**Rejected by the same data: humans use these *more* than models.**

| Construction | AI | Human | Consequence |
|---|---|---|---|
| `~에 대해/대한` | 1.46 | 4.39 | Default preserve |
| `~를 통해` | barely present | native text 84.4 vs translated 42.1 (최희경 2016) | Not translationese. Default preserve |
| `~것이다` ending | 20.4 | 43.0 | Default preserve |
| Third-person pronouns `그는/그의` | 0.0 | 1.9 | A translation-context issue only |
| Connective adverbs | gap came from one model | — | Fable and GPT were indistinguishable from humans |
| Inflation adjectives | 0.00 under task matching | — | A quality edit, not a signal |
| Three-item enumeration | — | — | Native Korean rhetoric; acting at three items caused over-polish |

What follows, as inference of this skill: frequency is not a ban. A construction good writers use more than models must not be hunted, and a rule's origin (who uses it more) is not grounds for treatment (whether fixing it helps).

## 2 What to hunt

Machine Korean fails at two opposite poles, and a text usually sits at one of them:

- **Padded (§2A):** long documents, reports, proposals, email. Commas by rule, antithesis and cleft framing, generic verbs, filler.
- **Compressed (§2B):** agent reports, chat answers, summaries, notes written under a brevity instruction. Dropped particles and endings, noun strings, omitted constituents.

Decide the pole first. **Fixing one pole must not push the text to the other.** Slop is cumulative: one hit means nothing, clusters mean rewrite. Thresholds such as "3+ per paragraph" are reading conventions from I and D, not measured cutoffs.

### 2A Padded pole

**Measured signals (K, I).** Cite as `ko-r<row>`.

| # | Shape | Korean form | Fix | Class |
|---|---|---|---|---|
| 1 | Comma by rule | A comma after connective endings (`날씨가 좋아서, 산책을`), after sentence-initial connectives (`또한, `), late in long clauses, in most sentences | Delete the comma; the ending marks the boundary. The vocative and greeting comma (`안녕하세요, 김 팀장님.`) and list commas are not this row | K, I |
| 2 | Negative antithesis | `A가 아니라 B` · `단순히 X가 아니라 Y` · `X를 넘어 Y로` as a slogan | State B. If A is itself a claim the author makes (a rejected option, a denied cause), keep it in a non-slogan form (`A 대신 B`, or its own clause); never drop it. Keep one antithesis where a real misconception is being corrected | I |
| 3 | Cleft framing and signposting | `필요한 것은 X다` · `문제는/핵심은/관건은 ~다` · `중요한 것은` · `주목할 점은` | Direct statement: `방향이 필요하다` | I |
| 4 | Paragraph closing on an obligation | `~해야 한다` · `~할 필요가 있다` as the last sentence of two or more paragraphs | Move the obligation sentence off the paragraph end. Never delete it, merge it, or weaken `해야 한다` into something else: the obligation is content. Stop when at most one paragraph ends on an obligation. If moving would change what an anaphor points to, or would need new content, leave it and say so | I |
| 5 | Generic policy verbs | 확대 · 강화 · 개선 · 구축 · 마련, and all-purpose 설계 · 구조 · 기준, converging in one passage. Old bureaucratic words (제고 · 도모 · 박차) are not this row: they showed no gap | The concrete action: `지원 대상을 1인 가구까지 넓힌다`. Only if the source says what the action is | I |
| 6 | Placard and closure formulas | `과제도 남아 있다` · `한계도 분명하다` standing alone; `결국 ~로 이어진다` · `~하는 이유다` · `~라는 뜻이다` · `~인 셈이다` | State the actual issue or the causal path, or delete | I |
| 7 | Outlook openers in the closing part | `향후` · `앞으로` · `중장기적으로` opening sentences in the last third | Delete, or use the real date if the source has one | I |
| 8 | Passive progressive | `심화되고 있다` · `확산되고 있다` three or more times in a paragraph | The active progressive, which keeps the aspect: `심해지고 있다` · `퍼지고 있다`. Never turn it into a past or completed form. Isolated uses stay; the active progressive is not a signal | I |
| 9 | Generated metaphor | A sensory verdict on an abstraction (`진단은 서늘하다`, `숫자는 차갑다`); one metaphor root recurring three or more times | The literal proposition; keep at most one. See also row 35 | I |
| 10 | Emphasis in quotation marks | Five or more scare-quoted phrases in a piece (`'옥석 가리기'`) | Quotation marks for real quotation and first-use terms | I |
| 11 | No long sentence | Every sentence short across several paragraphs, so that relations between adjacent statements (cause, condition, contrast) are left for the reader to supply. The 100-character figure in §1.2 is a corpus observation, not a cutoff for any passage | Where two adjacent sentences leave their relation unstated, join them with a connective ending or a modifier clause that names it. **Adding content is forbidden**, and sentences are not joined to reach a length | I (direction only) |
| 12 | Uniform sentence length | Runs of three or more adjacent sentences of about the same 어절 count | `professional-pass.md` closing check 1; count in 어절 | measured in other languages, inference here |

**Quality edits (N, D, H). Worth making, not AI signals.** Rows 13–17 are documented faults that human bureaucratic writing is full of. They count toward a cluster only beside measured rows.

| # | Shape | Korean form | Fix | Class |
|---|---|---|---|---|
| 13 | Light-verb padding | `검토를 진행하다` · `분석을 수행하다` · `개선을 실시하다` · `경쟁력을 가지고 있다` | 검토하다 · 분석하다 · 개선하다 · `경쟁력이 있다`. The fix removes the wrapper and adds no degree | N, D |
| 14 | Double passive and agentless passive | `되어지다` · `보여지다`; `~된다` throughout with no actor | Double passives are always wrong. Name the actor where the source gives one | N |
| 15 | `의` chains and stacked postpositions | `AI 기반의 교육 시스템의 개발의 필요성`; `~에서의` · `~으로의` · `~으로부터의` three or more times | Drop `의`, put a verb back, or split | N |
| 16 | Abstract noun wrappers | `~적 N` chains (`전략적 함의`, `실천적 기반`) three or more per paragraph; `~라는 점에서` · `~와 관련하여` · `~에 기반하여` · `~의 경우` | Unpack: `빨라서 효율적이다`, `보안을 강화한다`, `데이터로 결정한다` | D, H |
| 17 | Abstract subject with an all-purpose verb | `이러한 변화는 기회를 가져온다` | A concrete subject or an adverbial: `이렇게 바꾸면 기회가 열린다` | D |
| 18 | Redundant plural and demonstratives | `많은 사용자들` · `세 가지 기능들`; `해당 기능 … 해당 결과` on repeat | Drop `-들`; `이 기능` or nothing. Official documents keep `본` · `해당` (§5) | D |
| 19 | Dense repetition of a normal construction | Three or more of `~에 대한` · `~를 통해` · `~로 인해` · `~을 위해` in one paragraph, or the same ending (`~것이다`, `~할 수 있다`) on three or more consecutive sentences | Rework some, keep one or two. Vary the *form* of an ending, never its modality (§7). Below that density, leave them: §1.2 shows humans use them more | I (as a limit) |
| 20 | Connective density | Three or more sentence-initial connectives in one paragraph (또한 · 더불어 · 아울러 · 따라서 · 이처럼) | Halve them within that paragraph. Never strip them document-wide | I (as a limit) |
| 21 | Metronomic enumeration | Four or more triples in a passage, each with the same rhythm | Break some. A list of three is ordinary Korean | I (as a limit) |
| 22 | Inflation vocabulary | 혁신적인 · 획기적인 · 체계적인 · 핵심적인 · 새로운 패러다임 · 시너지 · 극대화 | The fact the adjective stands in for, or delete | H |
| 23 | Chatbot residue (check 1) | `좋은 질문입니다` · `물론입니다` · `도움이 되셨기를 바랍니다` · `추가로 궁금한 점이 있으시면` · `아래와 같이 정리해 보았습니다` | Delete | H |
| 24 | Empty framing (check 2) | `오늘날 급변하는 환경에서` · `4차 산업혁명 시대를 맞아` · `~는 아무리 강조해도 지나치지 않다` | Start where the content starts | H |
| 25 | Conclusion residue (check 7) | `이상으로` · `앞으로도 지속적으로 노력하겠습니다` · `~할 것으로 기대된다` closing every section | End when the content ends. Flag expected-effect lines that are repeated or have no basis in the document. Distinct effects stay, qualitative ones included; a number is used only when the source has it | H |
| 26 | Formatting tells (check 6) | Bold lead-in on every bullet, `소제목: 설명` colon headings and `다음과 같습니다:` lead-ins in prose, emoji headings, every section the same length, a closing 요약 that repeats the body | Prose where prose would do; vary depth by importance | H |
| 27 | Unsayable Korean (check 10) | `해당 사항에 대한 확인이 필요한 상황입니다` | Speech-shaped: `이 부분은 확인이 필요합니다` | H |

### 2B Compressed pole (F)

The cost here is meaning, not style: the reader has to reconstruct what the writer skipped, and may reconstruct it wrongly. These rows apply to running prose. Headings, list items, table cells, 개조식 lines, code, commit messages and log strings keep their own conventions. None of the other references covers this pole.

| # | Shape | Korean form | Fix | Class |
|---|---|---|---|---|
| 28 | Dropped particles and endings (전보체) | `설정 변경 후 서버 재시작 필요.` in a paragraph of prose | Restore particles, endings and auxiliaries: `설정을 변경한 뒤에는 서버를 다시 시작해야 합니다.` Restore only relations the source fixes. `캐시 영향 없음 확인` does not say whether the check was done or is still to do: ask, or mark `〔확인필요〕`; do not pick a tense for the writer | F |
| 29 | Sentence ending on a noun phrase or a connective ending | `이 방식은 비용이 낮은 편.` · `일정이 촉박해서.` | Close with a predicate and a final ending | F |
| 30 | Omitted constituent | `그러면 경고가 붙습니다` with no statement of where or to what | State it if the source allows; otherwise mark `〔확인필요〕`. Ellipsis is for what the reader already holds | F |
| 31 | `의` standing in for a predicate | `사본의 문구` · `작업의 상황` hiding `사본에 적힌` · `작업이 진행되는` | Put the verb back. The reverse of row 15 | F |
| 32 | Noun strings without relations | `토큰 계산 함수 오류 발생 시 비용 추정 중단` | Apt Sino-Korean words joined by particles and endings: `토큰 계산 함수에서 오류가 발생하면 비용 추정을 중단합니다`. When the string does not fix which noun modifies which (`지출 비용 추론 용도 함수`), ask or mark; do not choose a reading | F |
| 33 | Short sentences only | No complex sentence anywhere; every relation left to the reader | Join with connective endings and modifier clauses (row 11 seen from this pole) | F, I |
| 34 | Rare dictionary words | Correct but uncommon words where a common one exists | The word people use | F |
| 35 | Workshop metaphor for the plain word | `코드로 박다` · `기능을 얹다` · `규칙을 녹이다` · `정책이 갈리는 자리` · `논의의 결` | The literal verb or noun: 명시하다 · 추가하다 · 반영하다 · 달라지는 지점. Keep an idiom the field actually uses | F |
| 36 | Dash compressing the relation | `A — B` where the reader must guess whether B explains, contrasts or follows | A connective or a colon that names the relation | F |

Rows 9 and 35 are one fault at two poles: a figure standing where the plain word belongs. Row 35 is also an author-voice question: blunt workshop verbs in an engineer's own notes are a habit. Flag them in text meant for other readers.

## 3 What to restore — sprinkled, never poured

Restore to the degree the venue and the author's voice allow. Restoring is not padding: run the deletion and reversion tests (`professional-pass.md`, closing check 2) on everything you add.

| Restore | Korean form |
|---|---|
| Fewer commas | Let connective endings do the work (row 1) |
| A long sentence | Join adjacent sentences; no new content (row 11) |
| Sentence-length spread | One short sentence among long ones, or the reverse; move words, never add them |
| The apt word | The precise word for the context, native or Sino-Korean, joined by particles and endings. It beats both light-verb padding and a vague native verb that loses meaning (`쓴 비용` for `지출 비용`) |
| Particles, endings, auxiliaries | On compressed text, restore 조사 · 어미 · 보조 용언 · 보조사 until every relation is stated. This is repair |
| Subject and topic ellipsis, within limits | Drop `저는` · `우리는` when the reader already holds the referent. Never drop a constituent that carries meaning (row 30), and never delete pronouns by quota |
| Plain causal links | `~해서` · `~니까` · `그래서` where a closure formula stood (row 6) |
| Concrete particulars | The name, the number with its unit and date, the actual file or clause. Only if real |
| Register-true bluntness | `안 됩니다` · `틀렸습니다` where the author is making that judgment |

**Observe, never prescribe.** Human text in I carries things machine text lacks: quotations, parentheses, past-tense narration, self-intervention (`솔직히 말하면`), `당시`, benefactive `~해 주다`. Their absence may be reported. Producing them is fabrication and is forbidden, as is adding typos, spacing errors, slang or 해요체 endings to a formal text in order to look human.

## 4 Reported tells that do not stand alone

| Reported tell | What it actually is | Treatment |
|---|---|---|
| `~에 대한` · `~를 통해` · `~것이다` · three-item lists | Constructions humans use as much or more (§1.2) | Rows 19–21 density limits only |
| Third-person pronouns `그는` · `그의` · `그들은` | Humans use them more in native prose (§1.2) | Preserve. Rework only in text translated from another language, and never by quota |
| Frequent `~습니다` formality, uniform endings | Register, set by venue | Not a tell. Check only register drift |
| High share of Sino-Korean words | Register; old bureaucratic words show no human–AI gap (§1.2) | Not a tell. Replace only a word that is imprecise |
| Em dash or colon in a sentence | Release-specific habit (`model-fingerprints.md`) and rare in Korean | Counts only in clusters |
| English terms in parentheses after every noun | Translation habit, common in human technical writing too | Keep at first use, delete repeats |
| Bullet lists | Conventional in Korean business documents | Flag only bold-lead-in bullets replacing an argument |
| Perfect spelling and spacing | Proofread human text looks the same; K measured unedited student text | Not a tell on edited or published text |

## 5 Not signals in Korean

Do not flag these, and do not "fix" them:

- Uniform line length, noun endings, `항목: 내용` colon labels and parallel item phrasing in 개조식 documents. That form is prescribed, and it belongs to `gaejosik`. Row 26 and professional-pass check 8 do not apply inside it.
- One conventional greeting and one closing line in formal external mail (`안녕하십니까` · `감사합니다` · `~드림`). Venue convention.
- Fixed official-document phrases and words: `귀 기관의 무궁한 발전을 기원합니다` · `붙임` · `끝.` · `~하고자 합니다` · `본` · `해당`. Venue convention.
- A high share of Sino-Korean vocabulary in academic, legal or administrative text.
- The honorific level itself, or the absence of colloquial endings in formal text.
- Paragraph count or average paragraph length (`style-pass.md` §7).
- The author's own verified habits. One metric is never a verdict: a pre-ChatGPT human essay has been documented tripping a comma rule on every count.

## 6 Evidence boundary

K covers three genres (student essays, poetry, computer-science abstracts), fully human against fully generated text, and four models from 2024; its human side is mostly student and amateur writing. I has 60 pieces per side, opinion, essay and analysis genres only, corpora not topic-matched, and a human side of edited professional prose: against a personal-blog subset its gaps shrank sharply (long sentences from 11× to about 4×), so read its multipliers conservatively. Its directions are what that sample showed; whether they carry over to the business genres this skill edits has not been tested. Neither measured business documents, official documents, email, or human-edited machine text, which is most of what this skill edits. No row licenses a per-passage cutoff or a verdict that a text is machine-written. F, D and H rows have no published measurement behind them, and §2B describes a failure of clarity that human note-takers also produce. Treat a future measurement as superior to any of them.

## 7 Rewriter gates — check your own edit

A rewrite leaves its own traces, and I measured the rewriter creating new tells. After refactor or recreate, before showing the result:

| Gate | Test |
|---|---|
| Modality preserved | Count epistemic hedges (`~할 수 있다` meaning *may* · `~로 보인다` · `~일 가능성`) and obligations (`~해야 한다` · `~할 필요가 있다`) before and after, proposition by proposition: every claim keeps its own certainty, obligation and polarity. The totals are a cross-check, not the test. Restoring a compressed obligation (`재시작 필요` → `다시 시작해야 합니다`) keeps the force it already had and is not a new obligation. Never add a hedge, an emphatic or a negation for effect. `~할 수 있다` meaning ability or permission (`확인할 수 있다`) is not a hedge, but leave it unchanged too. Turning a hedge into an assertion, or an obligation into a description, changes the claim. Restore any sentence that lost its marker |
| Polarity and direction preserved | No negative turned positive (`더 이상 ~ 않다` stays negative), no cause and effect reversed, no conclusion changed |
| No reverse injection | The result must not contain more commas, `A가 아니라 B`, `결국`, `~하는 이유다`, `~로 이어진다` or cleft openers than the source. Editors add exactly the tells they were removing elsewhere |
| Protected content identical | Numbers, dates, amounts, names, quotations, legal and regulatory text, and declared protected ranges are byte-identical |
| Change budget (practitioner value from I and D) | On refactor, more than about 30% of characters changed is a warning to re-read every edit, and more than about 50% means the work was a recreate: say so and follow that contract. Character change understates structural edits, so also count the sentences touched |
