---
phase: 04
slug: editor-surface-state-extraction
status: verified
threats_open: 0
asvs_level: 1
block_on: high
register_authored_at_plan_time: true
created: 2026-08-26
---

# Phase 04 - Security

> Per-phase security contract for the editor-surface state extraction.

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| Pane command ports -> App/backend orchestration | Narrow Outline and Editor ports delegate filesystem effects to existing capability and write checks | File-operation intent and capability decisions |
| Canonical workspace/tab stores -> pane facades | Facades compose canonical state without creating a second draft owner | Document paths, drafts, active tab identity |
| Workspace/request identity -> facade hydration | Hydration publishes only when workspace identity and the captured request ID still match | Persisted view state and pane selections |
| Workspace/group/tab keys -> transient state | Exact cleanup prevents closed or switched scopes from retaining transient state | Draft-adjacent view, operation, and acknowledgement state |
| Sanitized preview HTML -> React-owned DOM | DOMPurify output and memoized markup remain the only preview rendering path | Sanitized document HTML and mark decorations |
| Editor draft publish -> memoized shell surfaces | Draft updates may re-execute MainApp but must not fan out into unrelated shell surfaces | Render notifications and static component identities |
| Test render observer -> production components | The observer is inert by default and reports only a closed set of static target names | Static render target name only |

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-04-W0-01 | Tampering | Expected-red validation | high | mitigate | Green controls, isolated intentional-red classification, lint, and the normal focused suite distinguish contract failure from broken setup | closed |
| T-04-W0-02 | Elevation of Privilege | Command-port contracts | high | mitigate | Separate Outline and Editor method inventories plus current-snapshot delegate tests | closed |
| T-04-W0-03 | Denial of Service | Render-counter harness | medium | mitigate | Deterministic real-store updates and exact component/domain counters replace timing assertions | closed |
| T-04-01 | Elevation of Privilege | OutlinePaneCommands | high | mitigate | Narrow typed port delegates to existing App/backend capability checks; inventory and delegate tests pass | closed |
| T-04-02 | Tampering | Outline canonical composition | medium | mitigate | Workspace-keyed facade reads canonical tab/workspace getters and stores pane-local slices only | closed |
| T-04-03 | Denial of Service | Outline facade publication | medium | mitigate | Per-domain subscriber maps and identity guards prevent unrelated notification fan-out | closed |
| T-04-04 | Elevation of Privilege | Final Outline command port | high | mitigate | Outline effects cross the typed port; the component makes no direct backend call | closed |
| T-04-05 | Tampering | Outline persistence hydration | high | mitigate | Workspace identity and captured request ID are checked before publish; stale-load regression passes | closed |
| T-04-06 | Information Disclosure | Outline transient state | medium | mitigate | Exact workspace cleanup removes facade-local selection and operation state without touching canonical drafts | closed |
| T-04-07 | Tampering | Editor hydration generation | high | mitigate | Editor hydration uses the same workspace/request-ID guard and atomic publish | closed |
| T-04-08 | Information Disclosure | Editor keyed transient state | high | mitigate | Workspace/group/tab keying and exact tab/group/workspace cleanup prevent cross-scope bleed | closed |
| T-04-09 | Tampering | Canonical draft ownership | medium | mitigate | Editor facade delegates draft reads/writes to editorTabsStore and owns no duplicate draft storage | closed |
| T-04-10 | Elevation of Privilege | EditorPaneCommands | high | mitigate | Distinct narrow port resolves current state at invocation and preserves existing write checks | closed |
| T-04-11 | Tampering | Preview decorations | high | mitigate | DOMPurify sanitization, React-owned markup, previewHtml-only memoization, and exact-node regression | closed |
| T-04-12 | Denial of Service | Editor publish/render path | medium | mitigate | Real left/right draft publishes and changed-domain counters prove unrelated render isolation | closed |
| T-04-13 | Elevation of Privilege | Final pane command ports | high | mitigate | Port inventory plus the native save/conflict smoke confirm delegation through existing checks | closed |
| T-04-14 | Tampering / Information Disclosure | Workspace generation and cleanup | high | mitigate | Guarded hydration, exact cleanup tests, and native tab/group/workspace switching show no transient bleed | closed |
| T-04-15 | Tampering | React-owned preview HTML | high | mitigate | Sanitized-string decoration and same-node component/native preview evidence prohibit imperative sinks | closed |
| T-04-16 | Information Disclosure | shellSurfaceRenderProbe | medium | mitigate | Closed static target union, null default observer, and test cleanup prevent content/path/callback capture | closed |
| T-04-17 | Tampering / Elevation of Privilege | Stable DocumentList callbacks | high | mitigate | Dependency-complete callbacks preserve current workspace/capability inputs and existing orchestration checks | closed |
| T-04-18 | Denial of Service | Draft publish -> shell surfaces | medium | mitigate | Non-vacuous production counters stay stable through real left/right updateTabDraft calls | closed |
| T-04-19 | Tampering | Editor/preview state | high | mitigate | Canonical draft ownership, split persistence tests, and preview identity regression remain green | closed |
| T-04-SC | Tampering | Package supply chain | low | accept | Phase 4 changed no dependency or package manifests and ran no package installation | closed |

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-04-01 | T-04-SC | Residual package supply-chain exposure is unchanged because this phase introduced no dependency, manifest, lockfile, or package-manager operation | Phase 4 plan register | 2026-08-26 |

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-08-26 | 23 | 23 | 0 | gsd-security-auditor |

## Sign-Off

- [x] All threats have a disposition
- [x] Accepted risks documented in the Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-08-26
