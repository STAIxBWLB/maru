SKILL.md is the instruction source for this skill. This file is background for maintainers; it holds no directives.

# Yunmun background

## Provenance

Yunmun is adapted from sepia v0.11.0 (MIT; see `references/ATTRIBUTION.md`) with a Korean calibration added. It combines measured findings with marked editorial heuristics, and every reference file says which is which.

## Approach

The skill makes AI-assisted text read as written by the person whose name is on it. It checks structure, density, stance, and specificity before word choice, then applies either the Korean calibration (built on two measured corpora and covering both failure poles: padded text with comma-by-rule, `A가 아니라 B` antithesis, cleft framing, and generic policy verbs; compressed text with dropped particles and endings and noun strings) or the English lists.

## Why the two-stage protocol is mandatory

Paraphrasing without a defect list makes AI fingerprints more visible, not less. Refactor and recreate therefore start from the full review report.

## Why invented specifics are a hard stop

A confident wrong fact is itself a top-tier tell, on top of being an error. Missing information is marked or asked about instead of filled.
