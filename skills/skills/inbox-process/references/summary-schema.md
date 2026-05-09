# Inbox Summary Schema

Every new summary created by `inbox-process` must have YAML frontmatter followed
by exactly these sections:

```markdown
---
title: <original title>
description: <one sentence, 200 chars max>
source: <work-relative source or inbox item id>
received: YYYY-MM-DD
type: regulation|report|plan|proposal|memo|guide|form|presentation|letter|data|transcript|message
project: <project id or ->
domain: research|projects|teaching|operations|people|ai-practice
topics: ["[[operations]]"]
keywords: [keyword]
entities: []
---

## 요약

2-3 sentences.

## 핵심

- Key point

## 실행

- [ ] Action item, if any
```

## Hard Rules

- No H1 title body block.
- No extra sections.
- `description`, `domain`, and `topics` are required because explicit vault
  extraction hooks may reuse them.
- Preserve uncertain actions as text; do not infer dates that are not present.
- Use `type: transcript` only for transcript-like material that is being routed
  through inbox rather than directly through `meeting-notes`.
