---
name: vault-extract
trigger: /vault-extract
description: Extract insights from a source document into vault notes
---

# /vault-extract [source]

Extract insights, decisions, observations from a source document and create vault notes.

## Input
- source: path to a file in work/ or a URL

## Preconditions (MANDATORY — enforce before any vault write)

Before writing ANY vault note, verify the source summary.md frontmatter has **all three required fields with non-empty values**:

1. **`description`** — string, ≥10 chars, not equal to title
2. **`domain`** — ∈ `{research | projects | teaching | operations | people | ai-practice}`
3. **`topics`** — array containing ≥1 `[[wiki-link]]` **AND every `[[target]]` must exist as a real note in `vault/notes/<target>.md`** (MOC enforcement — topics carry hub navigation only, not keyword tags)
   - Verify existence via `mcp__obsidian__get_notes_info(paths: [notes/<target>.md, ...])` for the full list of topic targets, or by listing `vault/notes/` and checking each
   - If any `[[target]]` is missing: **ABORT** (do NOT auto-create the MOC) — the caller (or user) must either fix the summary's topics or create the MOC note first
   - Concept/keyword tags (e.g., `credit-recognition`, `partnership-mapping`) belong in body text, NOT in `topics`. Schema is "topics = MOC only" per `vault/CLAUDE.md §Schema`.

**Read the summary's frontmatter via `mcp__obsidian__get_frontmatter` (or equivalent YAML parse) BEFORE building the vault note body.**

If any check fails:
- **ABORT** the extract for this summary
- Emit failed event to `log.md`: `YYYY-MM-DD HH:MM  EXTRACT  <proj>  <summary> → -  — failed: <reason>` (reasons include: `missing required fields: <field list>`, `dead topic: [[<target>]] not in vault/notes/`)
- Return error to caller (`inbox-process`, /vault-sync, /vault-pipeline) — caller decides whether to continue with other items
- **Do NOT synthesize empty values. Do NOT guess. Do NOT proceed to write.**
- User must fix summary.md and re-run. `inbox-process` must re-emit summary with correct fields when the summary came from an inbox item.

**Why strict**:
- 2026-04-11 L02 incident — 2 notes created via automated EXTRACT without these fields, caught only by later `/vault-lint`.
- 2026-05-22 L01 incident — 21 notes accumulated 26 unique dead `topics` wiki-links (e.g., `[[credit-recognition]]`, `[[partnership-mapping]]`) because `topics` was copied verbatim from summary.md without MOC existence check. The MOC check above prevents recurrence at the write site.

## Process

1. Read the source document completely
2. Classify the source document's project via registry:
   - Read `<workspace-root>/project-registry.yaml` (status: active only)
   - Extract signals from the source (keywords, people, organizations, acronyms)
   - Score: people +3, acronyms +2, keywords +2, orgs +1, tags +1
   - top score >= 3 & single match → use `vault_note` for topics, `path` to validate source
   - tie/ambiguous → disambiguation field → ask user
   - score < 3 → fall back to content-based domain analysis
3. Identify extractable items by domain:
   - research: claims, methods, contradictions, open-questions, tech-trends
   - projects: decisions, rationale, lessons-learned, risks, milestones
   - teaching: pedagogy-insights, curriculum-patterns, student-feedback, course-design
   - operations: policies, process-improvements, resource-decisions, institutional-strategy
   - people: collaboration-patterns, preferences, expertise, relationship-dynamics
   - ai-practice: gap-patterns, effective-prompts, tool-comparisons, workflow-optimizations
4. **Run Preconditions** (see §Preconditions above). ABORT on failure before any write.
5. For each item, create a note in vault/notes/:
   - Filename: prose-as-title (lowercase, hyphens, .md)
   - YAML frontmatter with required fields (`description`, `type`, `domain`, `topics`)
   - **Copy source-derived fields verbatim**: `description`, `domain`, `topics` are copied directly from summary.md frontmatter (verified in preconditions above). See `~/.anchor/skills/_builtin/lib/vault_adapter.md` for the summary-to-vault field policy.
   - **type remapping**: summary `type` (regulation|report|plan|...) maps to vault `type` (insight|decision|observation|person|project|method|moc) based on semantic intent. Common mappings: report→observation, plan→decision, memo→insight, proposal→decision, regulation→observation.
   - If registry matched in step 2, add `vault_note` wiki link to topics array
   - Set source field to the work/ relative path. If the source carries backref
     frontmatter (`source_doc`, `meetingSourcePath`, `relatedMeetings`,
     `relatedTasks` — context-enrichment §4), preserve those origins in the
     note's source / Relevant Notes; emit a `[[wiki-link]]` only for targets that
     resolve (consistent with the MOC dead-link gate above)
   - Body: the insight with context
   - Relevant Notes section with wiki links
   - Topics section with MOC wiki links
6. **Post-write verification** (MANDATORY): re-read the created note via `mcp__obsidian__get_frontmatter`. If `description`, `domain`, or `topics` is missing or empty in the written note, **delete the note** via `mcp__obsidian__delete_note`, log `— failed: post-write verification`, and return error. This catches edge cases where write succeeds but frontmatter gets stripped (Obsidian linter, encoding, etc.).
7. Register the source in vault/inbox/ if not already there
8. After creating notes, invoke /vault-connect with entities hint (from summary.md):
   - Read `entities` field from source summary.md (if present — list of 인물/기관 names)
   - Pass entities list to `/vault-connect` as wiki-link candidate seeds (`entities_hint` parameter)
   - `/vault-connect` uses entities to prioritize wiki-link discovery in its first pass
   - **Note**: `keywords` field is NOT carried forward to vault notes — it exists only for route scoring reproducibility
9. **Append EXTRACT event to vault/log.md** (ingest chain audit trail)

> **Registry fallback**: when project registry scoring < 3 → content-based domain analysis → if still ambiguous, prompt user. SSOT: `<workspace-root>/_sys/rules/project-registry-scoring.md`

## Log Append (Step 9 — REQUIRED)

Every note created or updated by /vault-extract must produce one `log.md` line via MCP Obsidian (`read_note` → append → `write_note`, or `patch_note`).

**Format** (see `<workspace-root>/_sys/rules/ingest-chain.md` §"vault/log.md 포맷"):

```
YYYY-MM-DD HH:MM  EXTRACT  <project>  <source> → <vault/notes/x.md>  — <type>
```

- `<project>`: project id from registry (`project-registry.yaml`), or `-` if unclassified
- `<source>`: work/ relative path of the source document
- `<vault/notes/x.md>`: newly created note path (use `notes/x.md` form)
- `<type>`: note type (`insight | decision | observation | person | project | method | moc`)

**Multiple notes from single source**: one log line per note created.

**Update vs create**: for updates, use `— updated: <type>` to distinguish.

**Failure**: if note creation succeeds but log append fails, warn user and proceed (do not roll back). If note creation fails, do not append.

**Vault access**: MCP Obsidian only. No filesystem Write/Edit on vault paths.

## Sibling Meeting Merge Rule (2026-04-16)

복수 회의 소스(같은 프로젝트·같은 날·보완적 관점)를 **단일 vault 노트**로 merge할지, **분리**할지 결정:

**Merge 조건 (모두 충족 시)**:
1. 같은 이니셔티브/프로젝트 (registry score 동일 결과)
2. 같은 날 또는 ±1일 이내
3. 보완적 관점 (한쪽이 다른 쪽의 전제·후속·다른 stakeholder view)
4. 각 회의만으로는 독립된 vault 노트로 composability 성립 안 함

**분리 조건 (하나라도 해당)**:
- 서로 다른 프로젝트/도메인
- 동일 주제의 **독립 의사결정** 또는 시간 간격 ≥7일
- 각 회의 독립 composability 성립 (각자 "This note argues that ..." 문장 성립)

**Merge 시 구조**:
- 단일 frontmatter `source`는 **주도 회의** 하나 경유
- 본문에 `## Update (YYYY-MM-DD, AM/PM): 출처: ...` 형태로 **각 회의 출처 명시**
- EXTRACT 로그는 **노트당 1줄** + 회의 각각 별도 `SOURCE`로 기록

**Purpose**: prevent fragmented notes when two source documents describe the same initiative from complementary perspectives.

## Quality Gates

- description must add information beyond the title (max 200 chars)
- Composability test: "This note argues that [title]" must make sense
- Each note must link to at least 1 domain MOC
- source field must be set
- **EXTRACT event appended to log.md for every created/updated note**

## Output
- List of created notes with descriptions
- Count of log.md lines appended
- Suggestion to run /vault-connect on new notes
