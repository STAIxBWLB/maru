---
last_mapped_commit: a938128cd8f34d36b2f2361d683d8b419c8ca534
---

# Testing Patterns

**Analysis Date:** 2026-08-22

Maru has three test layers: Vitest for TypeScript/React (188 test files - 184
under `src/` plus 4 under `scripts/` - and ~1810 `it()` cases), `cargo test` for
Rust (132 `#[cfg(test)]` modules, ~1200 `#[test]` functions), and Playwright for
browser e2e (23 specs, 193 `test()` cases). All three are reachable from the
`Makefile`.

## Test Framework

**Runner:**
- Vitest 4 (`vitest`), configured entirely by `vite.config.ts` - there is no
  `vitest.config.ts`, no setup file, and no `test` block in the Vite config at
  all. Defaults apply; per-file pragmas supply anything else. The roots come from
  the script, not the config: `"test": "vitest run src scripts"`.
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
make verify                # typecheck + version sync + icons + guards + TS/Rust unit tests + frontend build
make release-checks        # verify + CLI tests + debug Tauri build (version-changing PRs)
make verify-integration    # Smokes the real installed AI CLIs; NOT part of verify
```

CI (`.github/workflows/ci.yml`) runs `make verify` plus `make test-e2e` on every
PR. `make verify` must stay hermetic - anything that depends on installed AI CLIs
or live tokens belongs in `make verify-integration` instead.

## Test File Organization

**Location:**
- Co-located with the source: `src/lib/scratchpadTree.ts` ->
  `src/lib/scratchpadTree.test.ts`; `src/components/ScratchpadPane.tsx` ->
  `src/components/ScratchpadPane.test.tsx`.
- Cross-cutting flows that do not belong to one module live in
  `src/__tests__/` - `src/__tests__/taskIngestion.test.ts`,
  `src/__tests__/settingsNav.test.ts`, `src/__tests__/editorPreviewDebounce.test.tsx`.
- Build script tests sit beside the script: `scripts/lib/releaseVersion.test.mjs`,
  `scripts/tauri-window-policy.test.mjs`. `pnpm test` covers both `src` and
  `scripts`.
- Rust tests are inline `#[cfg(test)] mod tests` at the bottom of the module they
  cover - `src-tauri/src/today_store.rs`, `src-tauri/src/scratchpad.rs`. There is
  no `src-tauri/tests/` directory.
- Playwright specs live only in `e2e/`; shared page-side fixtures in
  `e2e/helpers/` (currently just `todayFixtures.ts`).

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
src/components/<C>.test.tsx         # component render tests, needs jsdom pragma
src/__tests__/<flow>.test.ts        # cross-module flows
e2e/<feature>.spec.ts               # Playwright
e2e/helpers/<feature>Fixtures.ts    # in-page fake registered via addInitScript
```

**Where a new test goes:** if the behavior can be reached through a pure function,
extract that function into `src/lib/` and test it there in the node environment -
`src/lib/scratchpadTree.test.ts` covers the whole Scratchpad folder-tree feature
(nesting, recursive counts, ancestor expansion, folder + query filtering) with no
DOM at all, and `src/components/ScratchpadPane.test.tsx` is left to cover only what
needs a rendered pane. Prefer that split over a bigger component test.

## Test Structure

**Suite Organization** - `describe` per exported function, module, or component,
`it` with a behavioral sentence. `test()` is never used in Vitest files.

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

Suite names may describe a slice rather than a symbol when the tests span one
feature of a large component - `describe("ScratchpadPane safety flows", ...)`.

**Environment pragma** - the default Vitest environment is node. Any test that
touches `document`, `window`, `localStorage`, or `requestAnimationFrame` must
declare jsdom on the very first line of the file, before all imports:

```typescript
// @vitest-environment jsdom
```

42 files carry it. The rule is about what the test touches, not the extension:
- All 34 `*.test.tsx` files need it except `src/__tests__/inboxKeyboard.test.tsx`,
  which is `.tsx` only for its imports and asserts on pure functions.
- Nine `*.test.ts` files need it because the module under test reaches for a DOM
  API: `src/lib/findInDocument.test.ts`, `src/lib/htmlDocument.test.ts`,
  `src/lib/scratchpadSanitizer.test.ts`, `src/lib/scratchpadApi.test.ts`,
  `src/lib/useScopedSelectAll.test.ts`, `src/lib/diagram/codecs.test.ts`,
  `src/lib/diagram/shortcuts.test.ts`, `src/components/decoratePreviewHtml.test.ts`,
  `src/components/graph/graphStyle.test.ts`.
- Pure logic tests stay in node - `src/lib/scratchpadTree.test.ts`,
  `src/lib/settings.test.ts`.

Forgetting the pragma produces `document is not defined` (or
`localStorage is not defined`), not a helpful error.

**Patterns:**
- Setup: local `beforeEach` only where state leaks; most suites build their input
  inline with a factory function instead.
- Teardown: unmount the root you created and drop the container -
  `afterEach(async () => { if (root) await act(async () => root?.unmount()); container?.remove(); vi.useRealTimers(); })`.
  Older suites clear `document.body.innerHTML` instead; either is accepted, but
  unmounting is required when the component registers listeners or watchers.
- Assertions: prefer exact `toBe` / `toEqual` on computed values over snapshot
  matching. There are no snapshot files in the repo.

## Mocking

**Framework:** Vitest `vi` only (`vi.mock`, `vi.fn`, `vi.mocked`, `vi.hoisted`,
`vi.spyOn`). No `jest`, no `msw`, no `sinon`.

**Two accepted shapes.** For one or two mocked functions, factory-form `vi.mock`
plus `vi.mocked(fn)` for typed per-test behavior:
```typescript
vi.mock("../../lib/koreanDate", () => ({
  parseKoreanDate: vi.fn(),
}));

vi.mocked(parseKoreanDate).mockImplementation(async (input) =>
  input.startsWith("내일") ? "2026-07-19T09:00:00+09:00" : "2026-07-24T09:00:00+09:00",
);
```
(`src/components/tasks/NaturalScheduleDialog.test.tsx`)

For a component that consumes a whole slice of `src/lib/api.ts`, declare one
hoisted mock bag and wire the module factory to it (7 files:
`src/components/ScratchpadPane.test.tsx`, `src/components/drafts/DraftsPane.test.tsx`,
`src/components/sites/SitesPane.test.tsx`, `src/components/jobs/DotSyncPanel.test.tsx`,
`src/__tests__/AgentUsageBar.test.tsx`, `src/__tests__/editorPreviewDebounce.test.tsx`,
`src/lib/siteView.test.ts`):
```typescript
const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(),
  list: vi.fn(),
  read: vi.fn(),
  save: vi.fn(),
  startWatcher: vi.fn(),
  stopWatcher: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  isTauri: mocks.isTauri,
  listScratchpad: mocks.list,
  readScratchpadDocument: mocks.read,
  saveScratchpadDocument: mocks.save,
  startScratchpadWatcher: mocks.startWatcher,
  stopScratchpadWatcher: mocks.stopWatcher,
}));

import { ScratchpadPane } from "./ScratchpadPane";
```
(`src/components/ScratchpadPane.test.tsx`)

`vi.hoisted` is what makes the handles reachable from `beforeEach` without
`await import`; the component import goes *after* the `vi.mock` calls. Reset with
`vi.clearAllMocks()` in `beforeEach` and re-arm the defaults there.
32 files use `vi.mock`; `vi.spyOn` stays rare and targeted -
`vi.spyOn(window, "confirm").mockReturnValue(true)` for a confirm gate.

**What to Mock:**
- The typed API layer rather than raw `invoke` whenever the component imports it:
  `vi.mock("../lib/api")`, `vi.mock("./api")`.
- The Tauri IPC boundary directly when there is no wrapper:
  `vi.mock("@tauri-apps/api/core")` (10 files) and `@tauri-apps/api/event`
  (6 files).
- Tauri plugins that have no browser implementation:
  `@tauri-apps/plugin-dialog`, `@tauri-apps/plugin-clipboard-manager`.
- Browser-only libraries jsdom cannot run - `vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }))`.
- Heavy leaf components whose rendering is not under test:
  `vi.mock("../studio/MarkdownSourceEditor")`.
- Callbacks passed as props: plain `vi.fn()`.

**What NOT to Mock:**
- Pure logic modules under test. The majority of `src/lib/*.test.ts` files import
  the real module and feed it constructed input - no mocks at all.
- The i18n dictionary. Component tests either wrap the tree in a real
  `LocaleContext.Provider` backed by `translate("ko", key, vars)`, use
  `src/lib/i18n/testing.ts` to pre-register dictionaries synchronously, or - when
  the component takes `t` as a prop - pass an identity translator that only
  substitutes `{vars}` and assert on the raw key:
  ```typescript
  const t = (key: string, vars?: Record<string, string | number>) => { /* {name} substitution */ };
  // ...
  expect(candidate.textContent?.includes("rightPane.scratchpad.reviewTemp"));
  ```
  This keeps the test from breaking on copy edits.
- The filesystem in Rust tests - use a real `tempfile::tempdir()` instead
  (~250 call sites across 74 modules).

## React Component Testing

No `@testing-library/react` in this repo. Components are rendered with
`react-dom/client` directly inside React's `act`:

```typescript
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  vi.useRealTimers();
});
```
(`src/components/ScratchpadPane.test.tsx`; the older provider-wrapping variant is
`src/components/today/TodayCapacityCards.test.tsx`)

Rules that come with this approach:
- Set `IS_REACT_ACT_ENVIRONMENT = true` at module scope or React warns on every
  update.
- Wrap every render, state change, and event dispatch in `await act(async () => ...)`.
- A component whose mount fires several chained promises needs an explicit
  microtask drain after the render; the house helper is:
  ```typescript
  async function settle(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }
  ```
- Prop transitions are tested by calling `root.render(<Pane {...nextProps} />)`
  again inside `act` - that is how the workspace-switch cases in
  `ScratchpadPane.test.tsx` exercise watcher restart and draft scoping.
- Query with `container.querySelector` / `document.querySelector`; assert on
  `textContent` and attributes. When a control has no stable class, find it by
  its (raw i18n key) label:
  `Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes(key))`.
- Drive inputs through the native setter so React's synthetic listener fires:
  ```typescript
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  ```
- Stub `localStorage` per test rather than trusting jsdom's shared instance:
  ```typescript
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: (k) => values.delete(k), clear: () => values.clear() },
  });
  ```

**Debounced work needs fake timers.** Autosave, watcher coalescing, and preview
debounce are advanced explicitly (9 files use fake timers):
```typescript
vi.useFakeTimers();
// ...type into the editor, then:
await act(async () => { await vi.advanceTimersByTimeAsync(700); });
```
Always restore with `vi.useRealTimers()` in `afterEach`.

**Tauri events are tested by capturing the listener.** Mock
`@tauri-apps/api/event` and stash each handler, then replay payloads - including
stale ones - to prove the generation guard:
```typescript
const watcherListeners = new Map<string, (event: { payload: never }) => void>();
mocks.listen.mockImplementation(async (name, handler) => {
  watcherListeners.set(name, handler);
  return vi.fn(); // the unlisten function
});
// ...
watcherListeners.get("scratchpad://changed")?.({ payload: { workPath: "/work", paths: ["memos/a.md"], generation: 6 } as never });
```
Ordering guarantees are asserted with `mock.invocationCallOrder`, not with
call counts.

**Accessibility and focus are assertable.** Dialog behavior is covered in unit
tests, not only e2e: query `[role="dialog"]`, dispatch
`new KeyboardEvent("keydown", { key: "Tab", bubbles: true })` (and `shiftKey`, and
`Escape`), and check `document.activeElement`. Focus restoration happens on the
next frame, so flush it:
```typescript
await act(async () => {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
});
expect(document.activeElement).toBe(review);
```
The same suite asserts `role="separator"` + `aria-valuenow` on resize handles and
`aria-pressed` on the segmented sort toggle.

## Fixtures and Factories

**Test Data:** local factory functions with a `Partial<T>` override argument,
declared above the suite:

```typescript
function memoEntry(patch: Partial<ScratchpadEntry> = {}): ScratchpadEntry {
  return {
    collection: "memos",
    relativePath: "memo.md",
    name: "memo.md",
    source: "maru",
    format: "markdown",
    updatedAt: "2026-07-22T01:00:00Z",
    sizeBytes: 12,
    preview: "memo",
    revision: "rev-1",
    stale: false,
    editable: true,
    ...patch,
  };
}
```
(`src/components/ScratchpadPane.test.tsx`; `src/lib/todayPlan.test.ts` uses the
same shape for `TaskEntry`)

A richer record layers factories rather than repeating fields:
`function memoDocument(patch = {}) { return { ...memoEntry(), content: "saved", ...patch }; }`.
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

For a single-command failure injection, a spec can set the global inline instead
of pulling in a fixture module:
```typescript
await page.addInitScript(() => {
  (window as unknown as { __MARU_E2E_INVOKE__: Record<string, () => unknown> }).__MARU_E2E_INVOKE__ = {
    save_document: () => { throw new Error("document_conflict: revision changed"); },
  };
});
```
(`e2e/smoke.spec.ts`)

**Spec conventions:**
- Flat `test()` calls, no `test.describe` blocks anywhere.
- Reset browser storage once per spec in `test.beforeEach` via `addInitScript`,
  guarded by a `sessionStorage` marker so it runs on the first navigation only.
- Scope before you select: resolve the surface first
  (`const files = page.locator(".files-workbench")`) and chain from it, so the same
  class name in two panes cannot cross-match.
- Selector mix across the 23 specs: `page.locator(".css-class")` (499 uses - the
  app's CSS class names are treated as stable test hooks), `getByRole` (422),
  `getByTestId` (145, backed by 198 `data-testid` attributes in `src/`),
  `getByText` (41). Prefer `getByTestId`/`getByRole` for anything interactive;
  reach for a class locator when you are asserting on app structure.
- Korean UI text appears in selectors because the fixtures pin locale `ko`.
- Layout and design regressions are asserted with real geometry:
  `boundingBox()` / `getComputedStyle` (111 assertions). See
  `e2e/workbench-layout.spec.ts` and `e2e/today-design-qa.spec.ts`.
- Platform-dependent shortcuts are resolved in-page, not hardcoded:
  ```typescript
  const saveShortcut = await page.evaluate(() =>
    navigator.platform.toLowerCase().includes("mac") ? "Meta+S" : "Control+S",
  );
  ```

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

- Filesystem behavior is tested against a real `tempfile::tempdir()`, not a mock.
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
layout math, tree building, parsing, formatting, settings normalization, store
reducers. Real module in, constructed data, no mocks. This is the bulk of the
suite and where new logic should land.

**Component Tests (Vitest, jsdom env):** one component rendered through
`createRoot` + `act` with real or identity translators, mocked `src/lib/api`, and
mocked leaf dependencies. Assert rendered text, ARIA attributes, focus, CSS
custom properties, and callback arguments.

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

**Conflict/recovery flows** are tested as a sequence on the same mock, not as two
tests: `mockRejectedValueOnce(new Error("scratchpad_conflict: ..."))` then
`mockResolvedValueOnce(...)`, and the assertion is on the *arguments* of the
retry - that it carried the freshly read revision and the overwrite flag:
```typescript
expect(mocks.save).toHaveBeenLastCalledWith("/work", "memos", "memo.md", "markdown", "draft", "rev-2", true);
```
(`src/components/ScratchpadPane.test.tsx`)

**Deterministic Time:** pin dates as string constants
(`const DAY = "2026-07-21";`) and pass an explicit `now_iso` / timezone into the
function under test. Playwright specs use the fake clock plus a fixed logical day
in `e2e/helpers/todayFixtures.ts`. Never call `new Date()` inside a test
expectation.

---

*Testing analysis: 2026-08-22*
