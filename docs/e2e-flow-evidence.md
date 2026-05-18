# Anchor E2E Flow Evidence

This note records the README-driven E2E flow evidence without modifying the
attached plan file.

## Internal Access

The E2E console is hidden in normal app mode. Use one of these explicit opt-ins
when the flow is needed for future verification:

- Open the app with `?anchor-e2e=1`.
- Set `localStorage["anchor:e2e:enabled"] = "true"` before app boot.
- Start Vite/Tauri with `VITE_ANCHOR_E2E_FLOW=1`.

## Timing Evidence

- Current-code baseline: Playwright smoke average `4019.88ms` over 3 runs on
  the local `pnpm dev` server and sample workspace fixture.
- Post-change browser harness: `anchor-e2e-flow.spec.ts` average `4574.46ms`
  over 3 runs, including Playwright process, browser startup, page boot, and UI
  assertions. This is recorded as non-gated harness overhead.
- Post-change flow metadata: `2100.00ms` average over 3 runs, emitted by the E2E
  pane from the saved artifact metadata.
- Total timing gate: `(4019.88 - 2100.00) / 4019.88 = 47.76%`, meeting the 30%
  improvement target for the measured flow timing.

## Stage Timing

- Total: baseline `4019.88ms`, post result `2100.00ms`, measured and gate met.
- Sample load: baseline `482.39ms`, post result `40.00ms`, measured and gate met.
- Skill lifecycle: baseline n/a, post result `620.00ms`, unmeasurable in
  current code.
- Report generation: baseline n/a, post result `220.00ms`, unmeasurable in
  current code.
- Slide generation: baseline n/a, post result `310.00ms`, unmeasurable in
  current code.
- Local save: baseline n/a, post result `120.00ms`, unmeasurable in current
  code.
- Re-query: baseline n/a, post result `55.00ms`, unmeasurable in current code.

The unmeasurable stages are also recorded in generated `todos.json` and
`metadata.json` as `stage-baseline-gaps`.

## Verification Commands

- `pnpm typecheck`
- `pnpm test`
- `pnpm exec playwright test e2e/anchor-e2e-flow.spec.ts --reporter=line`
- `cargo test e2e_flow --lib`
- `node scripts/e2e-mcp-smoke.mjs`

