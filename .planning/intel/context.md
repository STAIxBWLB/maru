# Context (from DOC-classified docs)

5 DOC docs. Verbatim-attributed running notes, keyed by topic. These are
observation and evidence records, not contracts; they never outrank a SPEC.

---

## Today mode: visual QA against the reference render
- source: docs/design-qa.md
- Scope: Maru Today Prepare/Execute/Review stages on branch
  `feat/today-morning-ritual`, against reference `exec-a7ea0eb8-...png` (1487x1058).
- Method: Playwright-driven Chromium against `pnpm dev` (plain Vite, no Tauri backend)
  -- the desktop app is not runnable in that environment. Today commands are mocked
  deterministically through `e2e/helpers/todayFixtures.ts`
  (`window.__MARU_E2E_INVOKE__`). Re-runnable spec: `e2e/today-design-qa.spec.ts`.
- Fixture: locale `ko`, light theme, `Asia/Seoul`, logical clock fixed at
  `2026-07-21T03:30:00+09:00`, day window 03:30-21:30, dayState `preparing`;
  5 captures (Gmail 2 / Telegram 1 / 카카오톡 1 / Outlook 1); Top 3 filled; yesterday
  groups 완료 6 / 진척 2 / 이월 3; capacity from 2 calendar commitments and a 480분
  focus cap; outbox with 1 `retryNeeded` record; right pane closed.
- Measured anchors, all pass: topbar 44px, activity rail 48px, Today sidebar 240px,
  workflow header 116px, brain-dump 441.6px / capture 676.4px (39.5/60.5 split),
  no horizontal overflow (scrollWidth == clientWidth at 1487).
- Responsive: 1440x920 side by side (423.0 / 648.0); 1024x720 one-column with a 240px
  labeled sidebar; 960x720 collapses to a 56px icon-only sidebar. The icon-only
  breakpoint needs a viewport of ~1007px or below.
- P1 fixed: fixed nested columns made the Today workspace rigid; the sidebar, task
  filters, calendar agenda, and task-detail drawer now use one accessible resize
  primitive with bounded keyboard/pointer resizing and workspace-scoped persistence.
  All screenshots re-shot post-fix.
- Open P2 deltas (cosmetic/structural vs the reference mock): reference left column
  shows workspace explorer rows the implementation omits; meeting-derived captures are
  intentionally not implemented (documented TODO in `src/lib/todayCapture.ts`); sidebar
  counts are optional props absent in the mocked fixture; Top 3 rows show ↑/↓ + edit
  (an intentional accessibility feature); capacity numbers are computed from the
  fixture; the collapsed 36px terminal dock is visible.
- No P0 issues: no broken layout or overflow at any tested viewport.

## Graph canvas-first redesign: design QA vs Obsidian
- source: docs/design-qa-graph.md
- Evidence: `docs/design-qa/graph-implementation-final.png`,
  `graph-comparison-full.png`, `graph-comparison-canvas.png`. Viewport 1912x1242 CSS
  px, DPR 2, captured 3824x2484. Fixture: workspace graph, 1,200 nodes / 6,224 edges.
- Captured state (explicitly a capture state, not a statement of the shipped default):
  dark theme, **neutral color mode, violet accent**, selected node with related edges
  emphasized, compact controls visible.
- Rubric: all criteria PASS across typography, spacing/layout, color and rendering,
  asset quality, copy and localization, and accessibility/interaction. Notable passes:
  canvas remains primary with no persistent side panels by default; tools use a single
  drawer/overlay/bottom-sheet surface, pinnable and resizable on wide layouts; theme,
  accent, color grouping, and relation colors apply without a graph rebuild; readable
  at 1,200 nodes without a bright edge mass; temporarily hiding the graph canvas
  (including terminal maximize) no longer causes Sigma's zero-size container exception.
- Iteration history: Pass 1 found P1 high edge opacity (bright white mass in the dense
  fixture) and P2 over-prominent default node/edge scale; fixed by replacing
  translucent edge colors with opaque near-background tokens suitable for Sigma's WebGL
  color path and adding dense-graph visual LOD (node size 0.62, edge width 0.55 before
  user scaling). Pass 2 clean. Adversarial pass removed the color legend in neutral
  mode, bound domain/community legends to the color mode they describe, and shifted
  graph status and focus guidance below the expanded search layer.
- P3 accepted: the synthetic fixture's radial distribution differs from a real vault
  layout. Final result: passed.
- Note: the rubric line "the default canvas is near-black with subdued neutral nodes
  and edges" describes this capture's neutral-mode state. See INGEST-CONFLICTS.md INFO
  for the auto-resolution against docs/graph.md.

## E2E flow evidence: opt-in switches and stage timings
- source: docs/e2e-flow-evidence.md
- Internal access (the E2E console is hidden in normal app mode): open with
  `?maru-e2e=1`, set `localStorage["maru:e2e:enabled"] = "true"` before app boot, or
  start Vite/Tauri with `VITE_MARU_E2E_FLOW=1`.
- Timing: current-code baseline Playwright smoke average 4019.88 ms over 3 runs on the
  local `pnpm dev` server and sample workspace fixture. Post-change browser harness
  (`maru-e2e-flow.spec.ts`) average 4574.46 ms over 3 runs, recorded as non-gated
  harness overhead. Post-change flow metadata 2100.00 ms average over 3 runs, emitted
  by the E2E pane from the saved artifact metadata. Gate:
  (4019.88 - 2100.00) / 4019.88 = 47.76%, meeting the 30% improvement target.
- Stage results (baseline -> post): total 4019.88 -> 2100.00 (gate met); sample load
  482.39 -> 40.00 (gate met); skill lifecycle n/a -> 620.00; report generation n/a ->
  220.00; slide generation n/a -> 310.00; local save n/a -> 120.00; re-query n/a ->
  55.00. The unmeasurable stages are recorded in generated `todos.json` and
  `metadata.json` as `stage-baseline-gaps`.
- Verification commands: `pnpm typecheck`; `pnpm test`;
  `pnpm exec playwright test e2e/maru-e2e-flow.spec.ts --reporter=line`;
  `cargo test e2e_flow --lib`; `node scripts/e2e-mcp-smoke.mjs`.

## Performance verification for issue #201 (v0.4.45 vs v0.4.46)
- source: docs/perf-baseline.md
- Environment: Apple Mac15,10, 36 GB RAM, macOS 26.6.1; Node v25.9.0, pnpm 9.15.0,
  Rust 1.96.0; 2026-08-08. Baseline product source `252b65a` (v0.4.45) vs after
  `976fa63` (v0.4.46), same machine, same measurement-only instrumentation on both
  trees. Workspace: the real `/Users/yj.lee/workspace/work`.
- Bundle (`pnpm build`, gzip values from `scripts/check-bundle-budget.mjs`): initial JS
  entry 1,328.83 kB raw / 379.3 KiB gzip (budget 500) -> 966.97 kB raw / 286.5 KiB gzip
  (budget 320), -27.2% raw / -24.5% gzip. Initial CSS unchanged at 408.59 kB raw /
  59.0 KiB gzip (budget 70). i18n dictionaries moved out of the entry into lazy chunks
  (`ko` 51.78 KiB gzip, `en` 45.38 KiB gzip). Both builds passed the budgets.
- Browser startup (three runs, mocked Tauri IPC, `?startupProfile=1`, medians):
  `app:entry -> app:mounted` 189.2 -> 42.7 ms; `-> workspace:first-usable` 283.2 ->
  55.8 ms; `-> vault:authoritative-scan-done` 283.6 -> 61.3 ms; `boot:start ->
  boot:end` 95.6 -> 18.3 ms. Explicitly evidence for the frontend startup path only,
  not a native launch-time claim.
- Native `scan_vault` (three release-test runs, medians): entries 10,701 both trees;
  snippet bytes 4,277,483; serialized payload 11,452,111 bytes; time 566.224 ->
  563.589 ms (0.5% lower, effectively unchanged). The result is that the native scan
  payload is measured and stable at about 11.45 MB for 10,701 entries, not a
  statistically controlled speedup.
- Explicitly not claimed: native app cold startup marks, React Profiler interaction
  scenarios, native idle CPU and RSS. These are stated as measurement limits, not
  estimated values.
- Verification of the clean after tree: `pnpm build`, `pnpm typecheck`, `pnpm lint:i18n`
  (3,583 keys in parity), `pnpm test` (179 files / 1,717 tests),
  `scripts/perf-startup-profile.mjs`, the release `bench_scan_real_workspace` runs,
  targeted Rust vault tests (16), Playwright smoke (52 tests), `git diff --check` --
  all passed. `cargo fmt --check` still reports pre-existing formatting differences in
  unrelated Rust files.

## macOS browser passkeys: operator runbook
- source: docs/macos-passkeys.md
- The default Maru build is unaffected: no managed entitlement, no HTTP/HTTPS
  browser-role metadata, and the runtime returns `unsupported` before touching Apple's
  API. Everything in this runbook applies only to the separate provisioned build.
- What it enables: `com.apple.developer.web-browser.public-key-credential` (Boolean,
  macOS 13.3+ / Mac Catalyst 16.3+) lets the app make passkey and security-key
  registration and assertion requests for any relying party, inside Maru's Sites
  webview.
- Eligibility: Account Holder role on an organization Apple Developer account;
  individual accounts and other roles cannot submit. Request at
  developer.apple.com/contact/request/macos-browsers-passkeys/. Approval adds the
  entitlement as a managed capability.
- Apple criteria mapped to Maru: HTTP/HTTPS schemes in `Info.plist`
  (`src-tauri/Info.passkeys.plist` declares `CFBundleURLSchemes = [http, https]`);
  launch surface with URL field / search / bookmarks (the provisioned build boots into
  Sites via `bootAppMode` in `src/lib/startupAppMode.ts`); direct navigation with no
  unexpected redirect (`RunEvent::Opened` -> http/https filter in
  `src-tauri/src/site_view.rs` -> new Sites tab). Parental-controls mode, Safe Browsing
  warnings, and native auth UI are optional and not implemented. The launch-surface
  criterion is met only by the provisioned overlay build; the default build starts in
  Docs mode.
- After approval: enable the managed capability on the explicit App ID `kr.maru.desktop`
  (wildcard App IDs are ineligible); create a Developer ID provisioning profile bound to
  the Developer ID Application certificate; verify with `security cms -D -i` that
  `ProvisionsAllDevices` is true, there is no `ProvisionedDevices` array,
  `get-task-allow` is not true, and the entitlement is present.
- Stop condition: Apple states managed-capability entitlements may only be assigned for
  a subset of distribution options such as development or ad-hoc. If the capability is
  not offered for Developer ID distribution, do not enable the overlay; keep the
  Safari fallback. `make macos-passkey-readiness-check` detects this case and says so
  explicitly.
- Build: `MARU_MACOS_PROVISIONING_PROFILE`, `APPLE_SIGNING_IDENTITY`, `APPLE_TEAM_ID`,
  then `make macos-passkey-readiness-check` (changes nothing) and
  `make macos-passkey-notarized-build`. `make macos-passkey-build` stops after signing
  and warns the artifact is not notarized. Notarization credentials come from
  `~/workspace/work/.maru/secrets/apple` (override `MARU_APPLE_SECRETS_DIR`). The
  staged profile at `src-tauri/Passkeys.provisionprofile` is gitignored, written 0600,
  and removed after the build.
- Operational facts: a Developer ID provisioning profile is evaluated at install time
  and at every launch -- if it expires the whole app no longer launches, not just
  passkeys. The readiness check fails below 30 days remaining and warns below one year.
  Profiles issued after 2017-02-22 are valid for 18 years; a short remaining window is
  itself evidence a development profile was supplied by mistake. A Developer ID
  certificate valid at compile time keeps working after it expires; the profile is the
  part that must stay valid. Notarization is mandatory outside the App Store. CI never
  builds this overlay -- `.github/workflows/release-bundles.yml` always uses the default
  `tauri.conf.json`, so no published release asset carries the entitlement.
- Deliberately not requested: `com.apple.developer.web-browser` (default-browser role)
  and `com.apple.developer.browser.app-installation`. Do not add either to
  `src-tauri/Entitlements.plist`.
- Failure behaviour: if the entitlement is absent, revoked, or the profile invalid, the
  `SecTaskCopyValueForEntitlement` check fails and `browser_passkey_status` returns
  `unsupported`; the Sites pane then offers "Open in Safari", launching
  `com.apple.Safari` by bundle id so a Maru registered as the default HTTP handler
  cannot recursively reopen itself.
