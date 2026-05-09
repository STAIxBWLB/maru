---
name: vault-stats
trigger: /vault-stats
description: Show vault statistics and health overview
---

# /vault-stats

Display comprehensive vault statistics.

## Metrics

1. **Size**: total notes, by type, by domain
2. **MOCs**: domain MOC note counts, topic MOC list
3. **Connections**: average links per note, orphan count/ratio
4. **Inbox**: current count, WIP status
5. **Activity**: recently created/modified notes
6. **Growth**: notes per week/month trend
7. **Quality**: schema compliance rate

## Process

1. Scan vault/notes/ for all .md files
2. Parse frontmatter for type, domain, topics
3. Count wiki links (incoming and outgoing)
4. Check inbox/ and ops/queue/ sizes
5. Calculate metrics

## Output
- Formatted statistics report
- Highlight any metrics outside healthy thresholds
