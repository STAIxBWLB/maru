# Testing Patterns

**Analysis Date:** 2026-08-22

Maru has three test layers: Vitest for TypeScript/React (187 test files, ~1780
`it()` cases), `cargo test` for Rust (132 `#[cfg(test)]` modules, ~1200
`#[test]` functions), and Playwright for browser e2e (23 specs, 189 `test()`
cases). All three are reachable from the `Makefile`.

## Test Framework

**Runner:**
- Vitest 4 (`vitest`), configured entirely by `vite.config.ts` - there is no
  `vitest.config.ts`, no setup file, and no global test config block. Defaults
  apply; per-file pragmas supply anything else.
- Playwright 1.59 (`@playwright/test`), config `playwright.config.ts`.
- Rust built-in test harness, `cargo test --lib` from `src-tauri/`.

**Assertion Library:**
- Vitest `expect` (imported explicitly; `globals` is not enabled).
- Playwright `expect` from `@playwright/test`.
- Rust `assert!` / `assert_eq!`.

**Run Commands:**
```bash
pnpm test                  # Vitest, one pass over src/ and scripts/
pnpm test -- <pattern>     # Filter by file path substring
pnpm exec vitest           # Watch mode
pnpm test:e2e              # Playwright (needs `pnpm playwright install` once)
pnpm test:e2e:graph        # Graph behavior + shell specs only
pnpm bench:graph           # Graph perf bench

make test                  # test-ts + test-rust
make test-ts               # = pnpm test
make test-rust             # cd src-tauri && cargo test --lib
make test-cli              # cargo test -p maru-cli --bin maru-cli
make test-e2e              # = pnpm test:e2e
make verify                # typecheck + version sync + icons + guards + unit tests + frontend build
make release-checks        # verify + CLI tests + debug Tauri build (version-changing PRs)
make verify-integration    # Smokes the real installed AI CLIs; NOT part of verify
```

CI (`.github/workflows/ci.yml`) runs `make verify` plus `make test-e2e` on every
PR. `make verify` must stay hermetic - anything that depends on installed AI CLIs
or live tokens belongs in `make verify-integration` instead.

## Test File Organization

**Location:**
- Co-located with the source: `src/lib/todayPlan.ts` ->
  `src/lib/todayPlan.test.ts`; `src/components/today/TodayPane.tsx` ->
  `src/components/today/TodayPane.test.tsx`.
- Cross-cutting flows that do not belong to one module live in
  `src/__tests__/` - `src/__tests__/taskIngestion.test.ts`,
  `src/__tests__/settingsNav.test.ts`.
- Build script tests sit beside the script: `scripts/lib/releaseVersion.test.mjs`,
  `scripts/tauri-window-policy.test.mjs`. `pnpm test` covers both `src` and
  `scripts`.
- Rust tests are inline `#[cfg(test)] mod tests` at the bottom of the module they
  cover - `src-tauri/src/today_store.rs`, `src-tauri/src/scratchpad.rs`. There is
  no `src-tauri/tests/` directory.
- Playwright specs live only in `e2e/`; shared page-side fixtures in
  `e2e/helpers/`.

**Naming:**
- `<module>.test.ts`, `<Component>.test.tsx`, `<feature>.spec.ts`, `perf.bench.ts`,
  `*.test.mjs` for Node scripts.
- A module with several distinct concerns gets several suffixed files rather than
  one giant file: `src/lib/diagram/actions.test.ts`,
  `actions.zorder.test.ts`, `actions.phase5.test.ts`;
  `src/lib/workspaceStore.test.ts` and `workspaceStore.deltaGate.test.ts`.

**Structure:**
```
src/lib/<module>.test.ts            # pure logic, node environment (default)
src/lib/<module>.test.tsx           # hook/store tests, needs jsdom pragma
src/components/<Area>/<C>.test.tsx  # component render tests, needs jsdom pragma
src/__tests__/<flow>.test.ts        # cross-module flows
e2e/<feature>.spec.ts               # Playwright
e2e/helpers/<feature>Fixtures.ts    # in-page fake registered via addInitScript
```

## Test Structure

**Suite Organization** - `describe` per exported function or component, `it` with
a behavioral sentence. `test()` is never used in Vitest files.

```typescript
import { describe, expect, it } from "vitest";
import { minimumWorkbenchWidth, resolveWorkbenchPlacement } from "./workbenchLayout";

describe("resolveWorkbenchPlacement", () => {
  it("reserves enough width for Docs before sizing a right-docked terminal", () => {
    expect(
      minimumWorkbenchWidth({
        visibleAppMode: "pkm",
        rightWorkbenchMode: null,
        editorSplitOpen: false,
      }),
    ).toBe(736);
  });
});
```
(`src/lib/workbenchLayout.test.ts`)

**Environment pragma** - the default Vitest environment is node. Any test that
touches the DOM must declare jsdom on the very first line of the file (42 files do):

```typescript
// @vitest-environment jsdom
```

Forgetting it produces `document is not defined`, not a helpful error.

**Patterns:**
- Setup: local `beforeEach` only where state leaks; most suites build their input
  inline with a factory function instead.
- Teardown: `afterEach(() => { vi.clearAllMocks(); document.body.innerHTML = ""; })`
  in DOM suites; unmount roots you created.
- Assertions: prefer exact `toBe` / `toEqual` on computed values over snapshot
  matching. There are no snapshot files in the repo.

## Mocking

**Framework:** Vitest `vi` only (`vi.mock`, `vi.fn`, `vi.mocked`, `vi.spyOn`).
No `jest`, no `msw`, no `sinon`.

**Patterns:**
```typescript
vi.mock("../../lib/koreanDate", () => ({
  parseKoreanDate: vi.fn(),
}));

// inside the test, type-safe access to the mock:
vi.mocked(parseKoreanDate).mockImplementation(async (input) =>
  input.startsWith("내일") ? "2026-07-19T09:00:00+09:00" : "2026-07-24T09:00:00+09:00",
);
```
(`src/components/tasks/NaturalScheduleDialog.test.tsx`)

Factory-form `vi.mock` at module top level, then `vi.mocked(fn)` for typed
per-test behavior. 32 files use `vi.mock`; `vi.spyOn` is rare (5 files).

**What to Mock:**
- The Tauri IPC boundary: `vi.mock("@tauri-apps/api/core")` (10 files) and
  `@tauri-apps/api/event` (6 files) when a unit test must not reach a backend.
- The typed API layer instead of raw `invoke` where possible:
  `vi.mock("../../lib/api")`, `vi.mock("./api")` (15 files combined).
- Tauri plugins that have no browser implementation:
  `@tauri-apps/plugin-dialog`, `@tauri-apps/plugin-clipboard-manager`.
- Heavy leaf components whose rendering is not under test:
  `vi.mock("../studio/MarkdownSourceEditor")`.
- Callbacks passed as props: plain `vi.fn()`.

**What NOT to Mock:**
- Pure logic modules under test. The majority of `src/lib/*.test.ts` files import
  the real module and feed it constructed input - no mocks at all.
- The i18n dictionary. Tests wrap the tree in a real `LocaleContext.Provider`
  backed by `translate("ko", key, vars)`, or use `src/lib/i18n/testing.ts` to
  pre-register dictionaries synchronously.
- The filesystem in Rust tests - use a real `tempfile::tempdir()` instead
  (535 sites).

## React Component Testing

No `@testing-library/react` in this repo. Components are rendered with
`react-dom/client` directly inside React's `act`:

```typescript
// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function renderCards(commitments: CalendarCommitment[] = []) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <LocaleContext.Provider
        value={{ locale: "ko", setLocale: () => {}, t: (key, vars) => translate("ko", key, vars) }}
      >
        <TodayContext.Provider value={contextValue}>
          <TodayCapacityCards onNavigate={() => {}} commitments={commitments} />
        </TodayContext.Provider>
      </LocaleContext.Provider>,
    );
  });
  return { container, root };
}
```
(`src/components/today/TodayCapacityCards.test.tsx`)

Rules that come with this approach:
- Set `IS_REACT_ACT_ENVIRONMENT = true` at module scope or React warns on every
  update.
- Wrap every render, state change, and event dispatch in `await act(async () => ...)`.
- Query with `container.querySelector` / `document.querySelector`; assert on
  `textContent` and attributes.
- Drive inputs through the native setter so React's synthetic listener fires:
  ```typescript
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  ```
  (`src/components/tasks/NaturalScheduleDialog.test.tsx`)
- Clean `document.body.innerHTML` in `afterEach`.

## Fixtures and Factories

**Test Data:** local factory functions with a `Partial<T>` override argument,
declared above the suite:

```typescript
function task(overrides: Partial<TaskEntry>): TaskEntry {
  return {
    absPath: "/work/tasks/active/x.md",
    relPath: "tasks/active/x.md",
    bucket: "active",
    title: "Task",
    status: "active",
    priority: "none",
    // ...every required field with a neutral default
    ...overrides,
  };
}
```
(`src/lib/todayPlan.test.ts`)

Shared constants (`const DAY = "2026-07-21";`) sit next to the factories. Dates in
fixtures are fixed literals, never `new Date()`.

**Location:**
- Per-file factories are the norm.
- Browser-mode fixtures that back the app when Tauri is absent:
  `src/lib/fixtures.ts` (documents, workspace files, meeting/task rows) and
  `src/lib/graph/fixtures.ts` (dense synthetic graph).
- Diagram report fixtures: `src/lib/diagram/__fixtures__/reports.ts`.
- Playwright page-side seeds: `e2e/helpers/todayFixtures.ts`.

## E2E Tests

**Runner:** Playwright, Chromium project only, `baseURL http://127.0.0.1:${MARU_E2E_PORT ?? 5307}`,
30s test timeout / 8s expect timeout, `trace: "on-first-retry"`. The `webServer`
block starts plain Vite - there is no Tauri backend in e2e.

**Set `MARU_E2E_PORT` when running from a worktree** so Playwright does not
reuse the main checkout's dev server (`reuseExistingServer` is on outside CI).

**The e2e seam:** because there is no backend, specs register per-command handlers
on `window.__MARU_E2E_INVOKE__` via `page.addInitScript`. `src/lib/e2eInvoke.ts`
consults that map before falling back to the real `invoke` or to the browser
fixtures in `src/lib/api.ts`; in the packaged Tauri shell the global never exists
and the seam is inert. Any new command a spec needs must have its
`invokeE2EOverride` branch in the `src/lib/api.ts` wrapper first.

`e2e/helpers/todayFixtures.ts` is the reference implementation: a
JSON-serializable seed plus an in-page mini store that applies mutations and
records every invoke on `window.__MARU_E2E_CALLS__` for assertions. The whole
page-side store must stay inside one `addInitScript` callback with no imports -
Playwright serializes that function.

**Spec conventions:**
- Flat `test()` calls, no `test.describe` blocks anywhere.
- Reset browser storage once per spec in `test.beforeEach` via `addInitScript`,
  guarded by a `sessionStorage` marker so it runs on the first navigation only.
- Selectors, in order of preference: `page.getByTestId` (134 uses, backed by 166
  `data-testid` attributes in `src/`), `page.getByRole` (124), then
  `page.locator(".css-class")` (488 - the app's CSS class names are treated as
  stable test hooks). `page.getByText` is a last resort (14).
- Korean UI text appears in selectors because the fixtures pin locale `ko`.
- Layout and design regressions are asserted with real geometry:
  `boundingBox()` / `getComputedStyle` (109 assertions across 11 specs). See
  `e2e/workbench-layout.spec.ts` and `e2e/today-design-qa.spec.ts`.

## Rust Tests

**Structure:**
```rust
#[cfg(test)]
mod tests {
    use super::*;

    const SEOUL: &str = "Asia/Seoul";

    fn open_day(work: &str, now_iso: &str) -> TodaySnapshot {
        today_open(work.to_string(), now_iso.to_string(), SEOUL.to_string(), ...).unwrap()
    }

    #[test]
    fn plan_survives_a_revision_bump() { /* ... */ }
}
```
(`src-tauri/src/today_store.rs`)

- Filesystem behavior is tested against a real `tempfile::tempdir()`, not a mock
  (535 sites).
- Process-global env is isolated with `MARU_TEST_HOME` / `MARU_TEST_CONFIG_DIR`
  and restored in a guard, so a test never touches the developer's real
  `workspaces.json` - see `src-tauri/src/telegram_io.rs`,
  `src-tauri/src/vault_list.rs:172`, `src-tauri/src/e2e_flow.rs`.
- `#[cfg(not(test))]` is used to bypass the primary-workspace assertion inside
  tests (`src-tauri/src/scratchpad.rs`).
- Tests that need a real environment are `#[ignore]`d and run explicitly:
  `cli_backends_real_smoke` (`make verify-integration`),
  `bench_scan_real_workspace` (`make bench-scan`),
  plus ignored cases in `src-tauri/src/vault.rs`, `agent_host/status.rs`,
  `ops_catalog/scan.rs`.
- Invariant coverage is deliberate: frontmatter key-order and comment
  preservation is verified by cargo test against
  `src-tauri/src/frontmatter/ops.rs`, the only allowed frontmatter write path.

## Coverage

**Requirements:** none enforced. No coverage provider is installed, no
thresholds, no coverage script, and CI does not collect it. Judge sufficiency by
whether the behavior has a named test, not by a percentage.

**View Coverage:**
```bash
# Not configured. Would require adding @vitest/coverage-v8 first.
pnpm exec vitest run --coverage
```

## Test Types

**Unit Tests (Vitest, node env):** pure logic in `src/lib/**` - planning,
layout math, parsing, formatting, store reducers. Real module in, constructed
data, no mocks. This is the bulk of the suite and where new logic should land.

**Component Tests (Vitest, jsdom env):** one component rendered through
`createRoot` + `act` with real context providers and mocked leaf dependencies.
Assert rendered text, ARIA attributes, and callback invocations.

**Script Tests (Vitest, node env):** `scripts/lib/*.test.mjs` cover release
version validation, updater manifests, provisioning profiles, and the Tauri
window policy - pure functions exported from the `.mjs` scripts.

**Rust Unit/Integration Tests:** in-module `mod tests` over tempdir workspaces;
they exercise real file IO, migration, watcher, and containment behavior.

**E2E (Playwright):** whole-app flows in Chromium against Vite with the invoke
seam faked. Also the only place layout geometry and design QA are asserted.

**Benchmarks (Vitest bench):** `src/lib/graph/perf.bench.ts` and
`src/lib/diagram/perf.bench.ts` guard order-of-magnitude regressions against
stated budgets (10k nodes / 50k edges: `buildVaultGraph` < 500ms, warm
ForceAtlas2 <= 3s, visibility-mask update < 5ms). Not run in CI.

## Common Patterns

**Async Testing:**
```typescript
it("resolves the plan after the store settles", async () => {
  await act(async () => {
    root.render(<Pane />);
  });
  expect(container.querySelector(".today-plan")?.textContent).toContain("45분");
});
```
Always `await act(async () => ...)` around anything that schedules React work.
For plain async logic, `await expect(fn()).resolves.toEqual(...)`.

**Error Testing:**
```typescript
await expect(saveDocument(path, body, "stale-revision")).rejects.toThrow(/revision/);
```
Rust equivalent:
```rust
let err = today_mutate(work, day, "stale".into(), mutation).unwrap_err();
assert!(err.contains("revision"));
```
Because every Tauri command returns `Result<T, String>`, error assertions match
on the message substring rather than an error type.

**Deterministic Time:** pin dates as string constants
(`const DAY = "2026-07-21";`) and pass an explicit `now_iso` / timezone into the
function under test. Playwright specs use the fake clock plus a fixed logical day
in `e2e/helpers/todayFixtures.ts`. Never call `new Date()` inside a test
expectation.

---

*Testing analysis: 2026-08-22*
