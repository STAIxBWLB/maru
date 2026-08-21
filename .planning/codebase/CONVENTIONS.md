# Coding Conventions

**Analysis Date:** 2026-08-22

Maru is a Tauri 2 desktop app: a React 19 + TypeScript frontend in `src/`, a
Rust backend in `src-tauri/src/`, Node build/guard scripts in `scripts/`, and
Playwright specs in `e2e/`. There is no ESLint, Prettier, Biome, rustfmt, or
EditorConfig file in the repo - conventions are enforced by `tsc --strict`,
purpose-built guard scripts wired into `make verify`, and consistency with
surrounding code. Match the file you are editing.

## Naming Patterns

**Files:**
- React components: `PascalCase.tsx`, one exported component per file, filename
  equals the component name - `src/components/today/TodayCapacityCards.tsx`,
  `src/components/ui/PaneResizeHandle.tsx`.
- TypeScript modules (logic, stores, hooks, API wrappers): `camelCase.ts` -
  `src/lib/todayPlan.ts`, `src/lib/workspaceStore.ts`, `src/lib/api.ts`.
- React hooks live in `src/lib/use*.ts` - `src/lib/useKeyboardShortcuts.ts`,
  `src/lib/useWorkspaceConfigLoad.ts`. A hook that belongs to one feature may sit
  beside it instead: `src/components/today/useActiveSection.tsx`.
- Unit tests are co-located: `<module>.test.ts` / `<Component>.test.tsx` next to
  the source - `src/lib/tasks.test.ts`, `src/components/today/TodayPane.test.tsx`.
- Cross-cutting tests with no single owner go in `src/__tests__/` -
  `src/__tests__/taskIngestion.test.ts`.
- Playwright specs: `e2e/<feature>.spec.ts` - `e2e/today.spec.ts`.
- Benchmarks: `perf.bench.ts` - `src/lib/graph/perf.bench.ts`,
  `src/lib/diagram/perf.bench.ts`.
- Rust modules: `snake_case.rs` - `src-tauri/src/today_store.rs`,
  `src-tauri/src/scratchpad.rs`. Multi-file areas become directories with a
  `mod.rs` - `src-tauri/src/agent_host/`, `src-tauri/src/frontmatter/`.
- Node scripts: `kebab-case.mjs` - `scripts/lint-i18n.mjs`,
  `scripts/check-bundle-budget.mjs`. Their tests are `*.test.mjs`.
- CSS: one shared sheet `src/styles.css` plus tokens in `src/foundations.css`;
  heavy lazily-loaded surfaces own a local sheet - `src/components/graph/graph.css`,
  `src/components/diagram/diagram.css`, `src/components/settings/settings.css`.

**Functions:**
- `camelCase`, verb-first: `computeCapacitySummary`, `resolveWorkbenchPlacement`,
  `buildDeterministicPlan`, `mergeBusyIntervals` (`src/lib/todayPlan.ts`).
- React components are `PascalCase` function declarations, never arrow consts:
  `export function TodayCapacityCards({ ... }: TodayCapacityCardsProps) {`.
- Rust functions are `snake_case`; Tauri commands are named after the IPC command
  string: `pub fn agents_list()` in `src-tauri/src/agents.rs`.

**Variables:**
- `camelCase` locals; module-level constants are `SCREAMING_SNAKE_CASE` declared
  at the top of the file - `const MAX_SHOWN_RANGES = 2;`
  (`src/components/today/TodayCapacityCards.tsx`), `const STORAGE_KEY = "maru:locale:v1";`
  (`src/lib/i18n.ts`).
- Rust constants are `SCREAMING_SNAKE_CASE` with explicit types -
  `const DEFAULT_EDITABLE_MAX_BYTES: u64 = 2 * 1024 * 1024;`
  (`src-tauri/src/scratchpad.rs`).
- Refs end in `Ref`: `activeDragRef`, `mountedRef`, `optionsRef`
  (`src/components/ui/PaneResizeHandle.tsx`).

**Types:**
- `PascalCase`. Object shapes are `interface`; unions, aliases, and string-literal
  enums are `type`. The codebase leans on `interface` (~750 exported interfaces vs
  ~260 exported type aliases).
- Component prop types are `interface <Component>Props` declared directly above
  the component: `interface TodayCapacityCardsProps { ... }`.
- String unions instead of TS enums: `export type TaskPriority = "highest" | "high"
  | "medium" | "low" | "none";` (`src/lib/tasks.ts`).
- Rust structs crossing the IPC boundary carry `#[serde(rename_all = "camelCase")]`;
  enums crossing it carry `#[serde(rename_all = "lowercase")]`
  (`src-tauri/src/scratchpad.rs`) so the TS side sees idiomatic JS casing.

**Keys and identifiers:**
- Browser storage keys are namespaced `maru:<domain>:<name>` with an explicit
  version suffix when the shape can migrate - `maru:locale:v1`,
  `maru:settings:fallback:v1:<workspace>`, `maru:today:lastAutoOpenDay:v1:<workspace>`.
  Workspace-scoped state appends the workspace path.
- Tauri command names are `snake_case` (`read_document`, `today_open`); their
  argument objects use `camelCase` keys (`{ vaultPath, documentPath }`) - Tauri
  performs the conversion.

## Code Style

**Formatting:**
- No formatter config is committed. Effective house style: 2-space indent, double
  quotes, semicolons, trailing commas in multi-line literals, ~100-column soft
  wrap. Keep new code visually identical to its neighbors.
- Rust follows default `rustfmt` output (4-space indent) even though no config or
  CI fmt check exists.

**Linting:**
- No ESLint. `tsc -b` with `"strict": true`, `isolatedModules`, and
  `forceConsistentCasingInFileNames` (`tsconfig.app.json`) is the type gate:
  `pnpm typecheck`.
- Custom static guards, all wired into `make verify`:
  - `scripts/lint-i18n.mjs` (`pnpm lint:i18n`) - ko/en dictionary key parity plus a
    hardcoded-UI-string scan over `src/**/*.tsx`.
  - `scripts/check-select-chrome.mjs` - rejects any CSS rule whose subject is a
    `select` and that sets the `background` shorthand (it would wipe the base
    chevron).
  - `check-type-tokens` (inline grep in the `Makefile`) - no raw `font-size: NNpx`
    in `src/styles.css`; use the `--type-*` / `--read-*` tokens from
    `src/foundations.css`.
  - `scripts/check-bundle-budget.mjs` - entry-bundle size ceiling, runs as part of
    `pnpm build:frontend`.
  - `scripts/check-release-version.mjs` - `package.json`, `tauri.conf.json`, and
    both `Cargo.toml` versions must agree.
- Run the whole gate with `make verify` before opening a PR; CI runs the same
  target (`.github/workflows/ci.yml`).

## Import Organization

**Order** (observed in `src/components/today/TodayCapacityCards.tsx`,
`src/lib/todayPlan.test.ts`, `src/lib/api.ts`):
1. React and third-party packages (`react`, `date-fns`, `lucide-react`,
   `@tauri-apps/api/core`, `vitest`).
2. Local value imports, relative paths.
3. Local `import type { ... }` blocks.

Type-only imports always use `import type` (~500 occurrences) - required by
`isolatedModules`. Inline type specifiers are used for mixed imports:
`import { useEffect, useRef, type KeyboardEvent } from "react";`.

**Path Aliases:**
- None. `tsconfig.app.json` declares no `paths`; every local import is relative
  (`../../lib/i18n`, `./todayContext`). Do not introduce an alias for a single
  module.

**Barrel Files:**
- None exist anywhere in `src/`. Import the concrete module, not a folder.

## Error Handling

**Frontend patterns:**
- Async Tauri calls are wrapped in `try` / `catch (err)` at the UI boundary; the
  message is pushed into the global error toast store:
  ```ts
  } catch (err) {
    setError(err instanceof Error ? err.message : String(err));
  }
  ```
  (`src/components/tasks/TasksPane.tsx:317`). This exact shape appears ~200 times -
  use it verbatim rather than inventing a variant.
- Name the caught binding `err`. `error` appears in older code; new code should use
  `err`. Use bare `} catch {` when the value is genuinely unused (~118 sites).
- The toast store is `src/lib/errorStore.ts`: `setError(value | updater)`,
  `clearError()`, `useError()` - a module-level slot plus `useSyncExternalStore`,
  so no `onError` prop drilling.
- Domain-specific formatting goes through a helper instead of raw stringification:
  `agentErrorMessage(err, t)` in `src/lib/agents.ts:272`.
- Rethrow after reporting only when a caller must also react:
  `setError(...); throw err;`.

**Rust patterns:**
- Every `#[tauri::command]` returns `Result<T, String>` (~1100 signatures). Map
  internal errors to a human-readable string at the command boundary; do not leak
  `Debug` formatting of internal types to the UI.
- Long or IO-heavy commands are declared `#[tauri::command(async)]` (76 of 356
  commands) so they do not block the main thread.
- Writes go through `src-tauri/src/atomic_file.rs` (`write_atomic`,
  `write_atomic_create`), and workspace writes are gated by
  `vault_list::assert_maru_can_write` before touching the filesystem.

## Logging

**Framework:** none. `console.*` only, and deliberately rare - 35 non-test call
sites across all of `src/`.

**Patterns:**
- Reserve `console.warn` / `console.error` for conditions a developer must see but
  a user cannot act on: a missing i18n key (`src/lib/i18n.ts`), a Sigma renderer
  failure (`src/components/graph/GraphCanvas.tsx`), an updater callback error
  (`src/lib/useUpdaterToasts.ts`).
- Anything the user should see goes to `setError()` (toast) or an inline pane
  state, never to the console.
- Do not add `console.log` for tracing. Temporary field-trace logging is removed
  before merge.

## Comments

**When to Comment:**
- Write a header comment block at the top of any module with a non-obvious
  contract, stating the rules a future editor must not break. Canonical examples:
  `src/lib/i18n.ts` (the ko/en parity rules), `src/lib/e2eInvoke.ts` (the
  browser-only e2e seam), `src/lib/errorStore.ts`, `e2e/helpers/todayFixtures.ts`,
  `scripts/lint-i18n.mjs`.
- Comment the *why*, especially for a deliberate non-obvious choice. `src/foundations.css`
  explains `word-break: keep-all` for Korean eojeol wrapping and why the reading
  scale is separate from the chrome scale; `src/lib/i18n.ts` explains why a
  rejected locale load is never cached. Follow that standard.
- Named known gaps are stated explicitly rather than hidden - see the "Known gap
  (deliberate)" note in `scripts/lint-i18n.mjs`.
- Do not narrate what the code already says.

**JSDoc/TSDoc:**
- `/** ... */` on exported functions and on individual interface fields whose
  meaning is not obvious (~1200 blocks). Field-level docs are common:
  ```ts
  /** Canonical completion date (YYYY-MM-DD). */
  done?: string;
  ```
  (`src/lib/tasks.ts`). No `@param` / `@returns` tag ceremony - prose only.

## Function Design

**Size:** Pure logic modules keep functions small and single-purpose
(`src/lib/todayPlan.ts`, `src/lib/workbenchLayout.ts`). Pane components are large
by comparison; when adding to one, extract the new logic into `src/lib/` rather
than growing the component.

**Parameters:** Three or more related parameters become a single options object
with a named interface - `computeCapacitySummary({ dayStart, sleepStart, busy,
focusCapMinutes, plan, provisionalEstimateMinutes })`. Component props always use
a destructured object with defaults in the signature:
`({ orientation = "vertical", direction = 1, disabled = false })`
(`src/components/ui/PaneResizeHandle.tsx`).

**Return Values:** Explicit return type annotations on exported functions
(`: Promise<DocumentPayload>`, `: string`, `: void`). Prefer `null` over
`undefined` for "absent" in serialized shapes - the Rust side sends `null`, and
`expectedRevision ?? null` normalizes at the call site (`src/lib/api.ts`).

## Module Design

**Exports:** Named exports everywhere. Only three `export default` sites exist in
`src/` (`src/App.tsx`, `src/components/settings/SettingsSurface.tsx`,
`src/components/diagram/DiagramMode.tsx`) - do not add more.

**Layering:** UI components in `src/components/` never call `invoke` directly.
Every Tauri command has a typed wrapper in `src/lib/api.ts` (or a feature module
like `src/lib/today.ts`, `src/lib/catalog.ts`) that also owns the browser
fallback:
```ts
export async function readDocument(vaultPath: string, documentPath: string): Promise<DocumentPayload> {
  if (!isTauri()) {
    const override = await invokeE2EOverride<DocumentPayload>("read_document", { vaultPath, documentPath });
    if (override) return override;
    return readMockDocument(documentPath);
  }
  return invoke<DocumentPayload>("read_document", { vaultPath, documentPath });
}
```
New commands must follow this three-branch shape: e2e override → browser mock →
real `invoke`.

**State:** Shared cross-pane state uses the module-slot + `useSyncExternalStore`
store pattern, not Context or an external state library -
`src/lib/errorStore.ts`, `src/lib/workspaceStore.ts`, `src/lib/editorTabsStore.ts`,
`src/lib/appOverlayStore.ts`,
`src/lib/telegramEventsStore.ts`, `src/lib/missionProgress.ts`,
`src/lib/useActiveMissions.ts`. React Context is used only for tree-scoped values
(`LocaleContext` in `src/lib/i18n.ts`, `TodayContext` in
`src/components/today/todayContext.ts`, `DiagramStoreContext`).

## UI Strings (i18n)

Hard rule, gated in CI by `pnpm lint:i18n`:
- Never hardcode Korean or English UI text in a `.tsx` file. Every string lives in
  both `src/lib/i18n/locales/ko.ts` and `src/lib/i18n/locales/en.ts`, added in the
  same commit. ko-KR and en-US are equal first-class locales.
- Read strings with `const { t } = useTranslation();` in components, or
  `t(locale, key, vars)` in plain TS. Interpolation uses `{name}` placeholders:
  `t("today.capacity.hoursMinutes", { hours, minutes: rest })`.
- Dictionaries are lazy chunks (~400 KB raw); provider sites gate their tree on
  `ready` from `useLocaleState` so `t()` stays synchronous.
- Escape hatch for a genuine proper noun: a trailing `// i18n-lint-ignore` on the
  line.

## Styling

- Plain CSS with kebab-case, component-prefixed class names -
  `.agent-usage-chip-name`, `.today-capacity-card`, `.tasks-pane`. No CSS modules,
  no CSS-in-JS, no Tailwind.
- Font sizes in `src/styles.css` must use `--type-*` (dense chrome) or `--read-*`
  (rendered document prose) tokens from `src/foundations.css`. The two scales are
  deliberately separate so retuning the UI never resizes user prose.
- Shell geometry comes from tokens too (`--shell-topbar-height`,
  `--shell-sidebar-expanded`).
- Keep `word-break: keep-all` intact for Korean text; more specific
  `word-break: break-all` rules on paths and hashes already override it.

---

*Convention analysis: 2026-08-22*
