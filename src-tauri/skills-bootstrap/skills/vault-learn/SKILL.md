---
name: vault-learn
trigger: /vault-learn
description: Query→Wiki 환원 — research a topic (or promote a conversation answer) into vault with user approval gate and LEARN event logging
---

# /vault-learn [topic]

Promote a research finding or conversation answer into the vault graph **only after explicit user approval**. Implements the Query→Wiki 환원 루프 defined in `<workspace-root>/CLAUDE.md` §"Query→Wiki 환원 루프".

## When to invoke

1. **Automatic trigger**: user question required cross-referencing 2+ work/ files and synthesizing a conclusion
2. **Manual trigger**: user says `/vault-learn` or `$learn` to promote the current conversation
3. **Research trigger**: user says `/vault-learn <topic>` to initiate web research + vault promotion

## Input
- topic: subject to research or promote (optional if current conversation context is the source)

## Process

### Step 1: Source gather
- If research mode: WebSearch / WebFetch the topic, collect primary sources
- If conversation mode: collect the question, the files cross-referenced, and the synthesized answer

### Step 2: Vault duplicate check
- `mcp__obsidian__search_notes(query: "...")` on the topic + key terms
- `mcp__obsidian__read_note("notes/glossary.md")` for term collisions

### Step 3: Propose (user approval gate — MANDATORY)
Present a proposal block:
```
LEARN PROPOSAL
==============
topic: <topic>
type: insight | observation | decision
domain: research | projects | teaching | operations | people | ai-practice
confidence: experimental (new research) | validated (consensus + sources)

Option A (NEW note):
  - path: notes/<prose-title>.md
  - description: <one-line>
  - topics: [[<moc>]]
  - source: <url | work/ path | conversation:<date>>

Option B (UPDATE existing):
  - path: notes/<existing-note>.md
  - change: <add wiki-link to [[new-term]] + 1 paragraph>

Accept: [a] new, [b] update, [s] skip, [q] quit
```

**Do NOT write to vault without explicit accept.** If user skips, append `— proposed, skipped` LEARN line anyway (see Step 6).

### Step 4: Execute (on accept)
- Write note via `mcp__obsidian__write_note` (new) or `patch_note` (update)
- Schema: YAML frontmatter with `description`, `type`, `domain`, `topics`, `confidence`, `source`
- Body: atomic insight, context, relevant notes section

### Step 5: Connect
- Call `/vault-connect note=<new-note>` to wire wiki-links (delegates log append to /vault-connect for CONNECT event)

### Step 6: Append LEARN event to vault/log

Always append — even when user skips — so the query history is preserved.

**Format**:

```
YYYY-MM-DD HH:MM  LEARN  <project>  <source> → <vault/notes/x.md>  — <note>
```

- `<source>`: `query` (conversation origin), `url:<hash>` (web research), or `work/<path>` (file cross-ref)
- `<note>`: one of
  - `promoted: <type>` (new note created)
  - `updated: <title>` (existing note updated)
  - `proposed, skipped` (user declined the proposal)
  - `failed: <reason>` (write error)

**Vault access**: MCP Obsidian only.

## Quality Gates
- Each promoted note must be a single atomic insight (composability test: "This note argues that [title]")
- Source must be recorded (`source:` frontmatter for notes; `— <source>` column in log)
- Confidence field required; default `experimental` for new research
- Must link to at least 1 existing note or MOC
- **User approval is non-negotiable** — never auto-promote

## Output
- Research/conversation summary
- Proposal block (Step 3)
- On accept: created/updated note path + /vault-connect result
- LEARN event confirmation (log append status)

## Related

- `<workspace-root>/CLAUDE.md` §"Query→Wiki 환원 루프" — the policy
- `<workspace-root>/_sys/rules/ingest-chain.md` §"vault/log 포맷" — log line format
- `/vault-extract`, `/vault-connect` — downstream skills invoked in steps 4-5
