# Per-model fingerprints

**Prose layer (vendor guidance, unmeasured).** What a model's own vendor says its current release does at the sentence level, taken from the vendor's prompting documentation and tagged with the exact release the page names. Loaded at the vocabulary and syntax scan, whether or not `style-pass.md` is loaded. Upstream sepia also carries measured narrative layers for fiction; this skill covers professional prose and does not port them.

Stable source identities live in the upstream sepia research ledger (see `ATTRIBUTION.md`); the alias V = vendor guidance is file-local. Corrections are inferences of this skill unless a source explicitly tested the intervention.

**Which rows apply is decided by the model-identity rule in `SKILL.md`, not here.** Each role (author, executor) is resolved on its own. A table is *operative* only when the release matches its tag and a *prior* otherwise. Nothing in this file infers a model from the prose.

## Claude

### Prose layer (V; Claude Fable 5.1 and Claude Mythos 5.1, `ANTHROPIC-FABLE-5-1-PROMPTING`)

| Vendor-stated default | Handling |
|---|---|
| Mannered prose: metaphor and flourish where a literal phrase exists | The block below, operative or prior per the model-identity rule in `SKILL.md`: operative for a role whose release is Claude Fable 5.1 or Claude Mythos 5.1 (the page names both), a prior for any other or unknown Claude release. As the author's layer: hunt metaphor standing in for an available literal phrase in the given text. As the executor's layer: apply the block to what you write |
| Denser than Fable 5: longer sentences, fewer paragraph breaks | Split run-ons (style-pass §1, row 2 (if loaded)); break paragraphs where the topic turns |
| Less bold, fewer headers and lists than earlier Claude | Sparse formatting is not evidence of a human author. Do not add anti-formatting rules to compensate |

The vendor's own instruction, verbatim (compared against the source page 2026-09-02, matched):

```text
Mannered prose substitutes metaphor and flourish for direct statement. Instead of "a parameter worth varying," the mannered writer produces "a dial worth turning." Instead of "this point still matters," they write "this point earns its keep." The phrases exist to display the writer, not to convey the idea, and readers can tell. That is why mannered prose irritates: it makes the reader work harder so the writer can perform. It is also imprecise. Metaphors drag in connotations the writer did not choose and cannot control. The fix is to say what you mean. When a literal phrase is available, use it.
```

### Prose layer (V; Claude Fable 5 and Claude Mythos 5, `ANTHROPIC-FABLE-5-PROMPTING`)

| Vendor-stated default | Handling |
|---|---|
| Un-steered, elaborates past the task: "surveying options it won't pursue, explaining root causes at length, producing heavily-structured PR descriptions, or writing comments that narrate what the next line does" | The brevity instruction below, operative or prior per the model-identity rule in `SKILL.md`: operative for a role whose release is Claude Fable 5 or Claude Mythos 5, a prior for any other Claude release. As the author's layer: hunt option surveys, root-cause essays, and structure that outweighs the content (professional-pass checks 2, 3, 6). As the executor's layer: apply the instruction to the non-narrative text you write |
| In long agentic sessions, "dense arrow-chain shorthand, deep implementation detail, references to thinking the user never saw, or overly technical phrasing" | Hunt arrow chains, hyphen-stacked compounds, and labels the reader never saw defined; expand them into sentences (style-pass §6 (if loaded) read-aloud test) |

The vendor's brevity instruction, verbatim (compared against the source page 2026-09-03, matched):

```text
Lead with the outcome. Your first sentence after finishing should answer "what happened" or "what did you find": the thing the user would ask for if they said "just give me the TLDR." Supporting detail and reasoning come after. Being readable and being concise are different things, and readability matters more.

The way to keep output short is to be selective about what you include (drop details that don't change what the reader would do next), not to compress the writing into fragments, abbreviations, arrow chains like A → B → fails, or jargon.
```

### Prose layer (V; Claude Opus 5, `ANTHROPIC-OPUS-5-PROMPTING`)

| Vendor-stated default | Handling |
|---|---|
| "Default user-facing responses run longer than prior Opus models'"; effort changes thinking volume, not visible length | Run density (professional-pass check 2) at the role's operative or prior strength. The conciseness instruction below, operative or prior per the model-identity rule in `SKILL.md`: operative for a role whose release is Claude Opus 5, a prior for any other Claude release; as the executor's layer, apply it to the non-narrative text you write |
| Written files "are often longer than on prior models": filler sections, redundant summaries, boilerplate | Hunt the fractal-summary shape and sections that exist for completeness (professional-pass checks 6, 7). Vendor instruction: "Match the length of written documents to what the task needs: cover the substance, but do not pad with filler sections, redundant summaries, or boilerplate." |
| "Narrates readily during agentic work": announces what it is about to do; narrates corrections to earlier statements more than prior models | In produced text, cut announcements of intent and corrections that change nothing for the reader |

The vendor's conciseness instruction, verbatim (compared against the source page 2026-09-03, matched):

```text
Keep responses focused, brief, and concise. Keep disclaimers and caveats short, and spend most of the response on the main answer. When asked to explain something, give a high-level summary unless an in-depth explanation is specifically requested.
```

### Prose layer (V; Claude Opus 4.8, `ANTHROPIC-OPUS-4-8-PROMPTING`)

| Vendor-stated default | Handling |
|---|---|
| "A direct, opinionated style with minimal validation-forward phrasing and sparing emoji use" | Absence of validation openers and emoji is this release's default, not evidence of a human. Stance (check 4) is usually present; look instead at density and specificity |
| Response length "calibrated to how complex it judges the task to be" | Length varies with the task by default; uniform length across tasks would be the tell, not variation |

Consulted with no prose-layer statement (2026-09-03): the Claude Sonnet 5 page says only that "prose style on long-form writing may shift"; Claude Opus 4.7, Opus 4.6, and Sonnet 4.6 have no model-specific prompting page. Those releases have no operative row; per the rule in `SKILL.md`, the Claude prose tables above apply to them as priors.

## GPT

### Prose layer (V; GPT-5.6, `OPENAI-GPT-5-6-PROMPTING`)

| Vendor-stated default | Handling |
|---|---|
| More concise by default than GPT-5.5; brevity instructions can make answers too brief | Density fails in both directions. In non-narrative text, a short answer that dropped a required caveat or the next action is a defect (professional-pass check 2) |
| The vendor's recommended trims name the expected residue: introductions, repetition, generic reassurance, optional background, generic praise, sign-offs | Already hunted by professional-pass checks 1, 2, and 7; run them on non-narrative text at the role's operative or prior strength |
| Editing tasks drift: the vendor's preservation snippet warns against "adding new claims, sections, or a more promotional tone" | Vendor-implied, not stated as a defect. Enforce the register-drift clause of the `SKILL.md` guardrail "Deletion beats addition" |

### Prose layer (V; GPT-6 Astra, `OPENAI-GPT-6-ASTRA-PROMPTING`)

| Vendor-stated default | Handling |
|---|---|
| "Tends to use lists, tables and Markdown to make responses scannable" | Heavy formatting is this release's default. Run professional-pass check 6 on non-narrative text at the role's operative or prior strength; the fix is the vendor's own: paragraphs that each develop one idea, a list only where the items are parallel or sequential |
| "May use recurring phrases across sessions"; the vendor's slop prompt (below) names the set | Two of its words already sit in the shared tables (delve, foster: style-pass §3 (if loaded) Performance verbs) and one frame does ("it's not X, it's Y": style-pass §2 (if loaded)); count those at operative or prior strength as usual. The rest stays in this table as a release habit and is hunted in non-narrative text, operative or prior per the model-identity rule in `SKILL.md`: the self-answered question ("Question? Answer."); a contrast the reader did not ask for, in any form ("X, not Y", "X—not Y", "This isn't about X. It's about Y."), which is wider than the §2 frame; closing-summary labels ("Bottom Line:", "In short:", "The simplest mental model is:"); hyphenated compound descriptors and invented compound labels ("exact-head checks"), the same shape Fable 5's table sends to the style-pass §6 (if loaded) read-aloud test; unprompted negative scoping, a sentence added to say what will not be done, what stays unchanged, or how results will be categorized when nobody asked (a "won't fix" that answers the request is the answer, per `domains/dev-replies.md`, and stays); and the words leverage, importantly, it's worth noting, genuinely. skill inference: no measurement backs any of these as a model-agnostic tell, so they do not move into the shared tables |

The vendor's slop instruction, verbatim (compared against the source page 2026-09-08, matched):

```text
Avoid using slop words or phrases like "Bottom Line:" in conclusions, "delve," "foster," "leverage," "it's worth noting," "importantly," "Question? Answer." or "This isn't about X. It's about Y.", "genuinely" or hyphenated compound descriptions and adjectives. Do not use concluding summary statements such as "In short:..", "The simplest mental model is:...".

State the intended action directly. Avoid adding what you won't do, what will remain unchanged, or how you'll separate or categorize results. Do not use contrastive framing such as "X, not Y" or "X—not Y" that introduces an unprompted alternative that the user didn't ask about. Avoid invented compound labels like "exact-head checks" and "editorial-row layouts", vague qualifiers, and canned transitions; use plain verbs and prepositions to state the actual relationship directly.
```

## Gemini

### Prose layer (V; Gemini 3 series, `GOOGLE-GEMINI-3-DEV-GUIDE`)

The vendor scopes its statements to the series (Gemini 3 Flash through Gemini 3.8 Flash), so any Gemini 3.x release matches this table.

| Vendor-stated default | Handling |
|---|---|
| "By default, Gemini 3 is less verbose and prefers providing direct, efficient answers"; a conversational or "chatty" persona appears only when explicitly prompted | Terse and unadorned is this series' default, so brevity is not evidence of a human here. In non-narrative text, check density in the other direction (professional-pass check 2): required caveats and next steps dropped for efficiency |

## Other families

DeepSeek, Kimi, Qwen, Solar, HyperCLOVA X, EXAONE and other vendors publish no sentence-level prose guidance that this file records. A role whose family has no table here loads nothing and reports `none`; do not guess.
