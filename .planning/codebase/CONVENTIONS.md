---
last_mapped_commit: a938128cd8f34d36b2f2361d683d8b419c8ca534
---

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
- A component shared by more than one pane sits at the top of
  `src/components/` rather than inside a feature folder -
  `src/components/DocumentModeSurface.tsx` (used by `EditorPane` and
  `ScratchpadPane`), `src/components/InlineDocumentEditor.tsx` (used by
  `src/App.tsx` for the Files surface).
- TypeScript modules (logic, stores, hooks, API wrappers): `camelCase.ts` -
  `src/lib/todayPlan.ts`, `src/lib/workspaceStore.ts`, `src/lib/api.ts`,
  `src/lib/scratchpadTree.ts`.
- React hooks live in `src/lib/use*.ts` - `src/lib/useKeyboardShortcuts.ts`,
  `src/lib/useWorkspaceConfigLoad.ts`. A hook that belongs to one feature may sit
  beside it instead: `src/components/today/useActiveSection.tsx`.
- Unit tests are co-located: `<module>.test.ts` / `<Component>.test.tsx` next to
  the source - `src/lib/tasks.test.ts`, `src/lib/scratchpadTree.test.ts`,
  `src/components/ScratchpadPane.test.tsx`.
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
  `buildDeterministicPlan`, `mergeBusyIntervals` (`src/lib/todayPlan.ts`),
  `buildScratchpadFolderTree`, `filterScratchpadFolderEntries`
  (`src/lib/scratchpadTree.ts`).
- React components are `PascalCase` function declarations, never arrow consts:
  `export function TodayCapacityCards({ ... }: TodayCapacityCardsProps) {`.
- Rust functions are `snake_case`; Tauri commands are named after the IPC command
  string: `pub fn agents_list()` in `src-tauri/src/agents.rs`.

**Variables:**
- `camelCase` locals; module-level constants are `SCREAMING_SNAKE_CASE` declared
  at the top of the file - `const MAX_SHOWN_RANGES = 2;`
  (`src/components/today/TodayCapacityCards.tsx`),
  `const SCRATCHPAD_LOCATION_KEY = "maru:scratchpad-location:v1";`
  (`src/components/ScratchpadPane.tsx:95`).
- Rust constants are `SCREAMING_SNAKE_CASE` with explicit types -
  `const DEFAULT_EDITABLE_MAX_BYTES: u64 = 2 * 1024 * 1024;`
  (`src-tauri/src/scratchpad.rs`).
- Refs end in `Ref`: `activeDragRef`, `mountedRef`, `htmlFlushRef`
  (`src/components/ui/PaneResizeHandle.tsx`,
  `src/components/InlineDocumentEditor.tsx`).

**Types:**
- `PascalCase`. Object shapes are `interface`; unions, aliases, and string-literal
  enums are `type`. The codebase leans on `interface` (753 exported interfaces vs
  266 exported type aliases).
- Component prop types are `interface <Component>Props` declared directly above
  the component: `interface DocumentModeSurfaceProps { ... }`. Props interfaces
  are not exported unless another module constructs them.
- String unions instead of TS enums: `export type TaskPriority = "highest" | "high"
  | "medium" | "low" | "none";` (`src/lib/tasks.ts`),
  `export type EditorViewMode = "rich" | "source" | "preview";`
  (`src/components/DocumentModeSurface.tsx`).
- A closed set that also needs a runtime list is a `as const` tuple with the union
  derived from it, not two declarations that can drift:
  ```ts
  export const SCRATCHPAD_NAV_COLLECTIONS = ["memos", "temp"] as const;
  export type ScratchpadNavCollection = (typeof SCRATCHPAD_NAV_COLLECTIONS)[number];
  ```
  (`src/lib/scratchpadTree.ts`). Pair it with a `value is T` type guard when the
  input is a wider string.
- Rust structs crossing the IPC boundary carry `#[serde(rename_all = "camelCase")]`;
  enums crossing it carry `#[serde(rename_all = "lowercase")]`
  (`src-tauri/src/scratchpad.rs`) so the TS side sees idiomatic JS casing.

**Keys and identifiers:**
- Browser storage keys are namespaced `maru:<domain>:<name>` with an explicit
  version suffix when the shape can migrate - `maru:locale:v1`,
  `maru:scratchpad-location:v1`, `maru:settings:fallback:v1:<workspace>`,
  `maru:today:lastAutoOpenDay:v1:<workspace>`. Workspace-scoped state appends the
  workspace path; per-document drafts append the document identity
  (`maru:scratchpad-draft:<workspace>/<collection>/<relPath>`).
- Cross-pane commands that are not shared state travel as custom `window` events
  under the same `maru:<domain>:<action>` namespace -
  `window.dispatchEvent(new Event("maru:scratchpad:new-memo"))` listened for in
  `src/components/ScratchpadPane.tsx:881`. Use this only for fire-and-forget
  imperative triggers; anything with a value belongs in a store.
- Native/menu-level events use the `maru://` scheme instead - `maru://menu-command`,
  `maru://settings-updated`, `maru://check-for-updates`.
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

**Order** (observed in `src/components/ScratchpadPane.tsx`,
`src/components/InlineDocumentEditor.tsx`, `src/lib/api.ts`):
1. Third-party packages, roughly alphabetical by module specifier
   (`@tauri-apps/api/event`, `lucide-react`, `react`, `date-fns`, `vitest`).
   `lucide-react` icon lists and multi-name `react` imports are one name per line.
2. Local value imports, relative paths, grouped by source module.
3. Local `import type { ... }` blocks last.

Type-only imports always use `import type` (506 occurrences) - required by
`isolatedModules`. Inline type specifiers are used for mixed imports:
`import { useEffect, useRef, type KeyboardEvent } from "react";`. A React type
that collides with a DOM global is aliased at the import:
`type KeyboardEvent as ReactKeyboardEvent`.

**Path Aliases:**
- None. `tsconfig.app.json` declares no `paths`; every local import is relative
  (`../../lib/i18n`, `./todayContext`). Do not introduce an alias for a single
  module.

**Barrel Files:**
- None exist anywhere in `src/`. Import the concrete module, not a folder.

**Lazy chunks:** heavy editors and surfaces are code-split at the import site with
`lazy()` (24 sites). Because components use named exports, the promise is mapped:
```ts
const LazyRichMarkdownEditor = lazy(() =>
  import("./RichMarkdownEditor").then((module) => ({ default: module.RichMarkdownEditor })),
);
```
(`src/components/InlineDocumentEditor.tsx`). Every lazy child is wrapped in a
`<Suspense fallback={<div className="editor-loading" role="status">…</div>}>`.

## Error Handling

**Frontend patterns:**
- Async Tauri calls are wrapped in `try` / `catch (err)` at the UI boundary; the
  message is pushed into the global error toast store:
  ```ts
  } catch (err) {
    setError(err instanceof Error ? err.message : String(err));
  }
  ```
  (`src/components/tasks/TasksPane.tsx:317`). This exact shape appears ~215 times -
  use it verbatim rather than inventing a variant.
- Name the caught binding `err`. `error` appears in older code; new code should use
  `err`. Use bare `} catch {` when the value is genuinely unused (120 sites).
- The toast store is `src/lib/errorStore.ts`: `setError(value | updater)`,
  `clearError()`, `useError()` - a module-level slot plus `useSyncExternalStore`,
  so no `onError` prop drilling.
- An error the user must resolve *in place* (a save conflict, a failed reload)
  renders inline next to its editor with `role="alert"` and recovery buttons
  instead of a toast - `src/components/InlineDocumentEditor.tsx`
  (`.inline-document-editor-error`), the conflict banner in
  `src/components/ScratchpadPane.tsx`. Toast for "you should know", inline for
  "you must choose".
- Domain-specific formatting goes through a helper instead of raw stringification:
  `agentErrorMessage(err, t)` in `src/lib/agents.ts:272`; revision conflicts are
  classified by `isRevisionConflict(err)` in `src/lib/scratchpad.ts` rather than by
  matching the message at the call site.
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
  rejected locale load is never cached; `src/lib/settings.ts` explains why an empty
  `collapsedTreeFolders` array means "fully collapsed" and not "unset". Follow that
  standard.
- Named known gaps are stated explicitly rather than hidden - see the "Known gap
  (deliberate)" note in `scripts/lint-i18n.mjs`.
- A test may carry a one-line comment pinning an intentional UI decision -
  `// A segmented toggle, never a native select that would open an OS popup.`
  (`src/components/ScratchpadPane.test.tsx`).
- Do not narrate what the code already says.

**JSDoc/TSDoc:**
- `/** ... */` on exported functions and on individual interface fields whose
  meaning is not obvious (~1220 blocks). Field-level docs are common:
  ```ts
  /** Canonical completion date (YYYY-MM-DD). */
  done?: string;
  ```
  (`src/lib/tasks.ts`). Exported constants that encode a policy get one too:
  `/** Drag limits for the Scratchpad virtual folder tree. */`
  (`src/lib/settings.ts:142`). No `@param` / `@returns` tag ceremony - prose only.

## Function Design

**Size:** Pure logic modules keep functions small and single-purpose
(`src/lib/todayPlan.ts`, `src/lib/workbenchLayout.ts`, `src/lib/scratchpadTree.ts`).
Pane components are large by comparison; when adding to one, extract the new logic
into `src/lib/` rather than growing the component. `src/lib/scratchpadTree.ts` is
the reference for this: the Scratchpad folder-tree feature landed as a pure,
separately tested module (`buildScratchpadFolderTree`,
`filterScratchpadFolderEntries`, `scratchpadFolderAncestors`,
`parseScratchpadFolderId`) with only rendering left in
`src/components/ScratchpadPane.tsx`.

**Parameters:** Three or more related parameters become a single options object
with a named interface - `computeCapacitySummary({ dayStart, sleepStart, busy,
focusCapMinutes, plan, provisionalEstimateMinutes })`. Component props always use
a destructured object with defaults in the signature:
`({ orientation = "vertical", direction = 1, disabled = false })`
(`src/components/ui/PaneResizeHandle.tsx`), `({ className = "", ... })`
(`src/components/DocumentModeSurface.tsx`).

**Return Values:** Explicit return type annotations on exported functions
(`: Promise<DocumentPayload>`, `: string`, `: void`). Prefer `null` over
`undefined` for "absent" in serialized shapes - the Rust side sends `null`, and
`expectedRevision ?? null` normalizes at the call site (`src/lib/api.ts`).

## Module Design

**Exports:** Named exports everywhere. Only three `export default` sites exist in
`src/` (`src/App.tsx`, `src/components/settings/SettingsSurface.tsx`,
`src/components/diagram/DiagramMode.tsx`) - do not add more.

**Re-exporting a shared type:** when a pane owns the public surface of a type that
now lives in a shared component, re-export rather than duplicating -
`export type { EditorViewMode, HtmlViewMode } from "./DocumentModeSurface";` in
`src/components/EditorPane.tsx:63` keeps existing importers working.

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

Pane-level UI state that must survive a restart is *not* a store: it is lifted to
`src/App.tsx`, persisted through `MaruSettings`, and handed down as a
value + `onChange` prop pair (`sortKey`/`onSortKeyChange`,
`treeWidth`/`onTreeWidthChange`, `expandedFolders`/`onExpandedFoldersChange` on
`ScratchpadPane`). Keep the pane a controlled component.

## Shared UI Primitives

`src/components/ui/` holds the cross-pane primitives - `Button.tsx`,
`DialogSurface.tsx`, `Field.tsx`, `ModeChrome.tsx`, `PaneResizeHandle.tsx`,
`SortModeToggle.tsx`, `Toggle.tsx`, `usePointerReorder.ts`. Reach for these before
writing a raw element:
- `Button` for any labelled action (`variant="primary" | "ghost"`, `size="sm"`,
  `icon={<Save size={14} />}`). A bare `<button className="icon-button">` is only
  for icon-only affordances that carry `title` + `aria-label`.
- `PaneResizeHandle` for every drag split; it renders `role="separator"` with
  `aria-orientation` and `aria-valuenow`, which the tests assert on.
- `SortModeToggle` for sort switching - a segmented `role="group"` of buttons with
  `aria-pressed`, deliberately never a native `<select>`.

**The document editing surface is shared, not re-implemented.** Any pane that
offers rich/source/preview editing renders
`src/components/DocumentModeSurface.tsx`, which owns the Radix
`Tabs.Root` / `Tabs.List` / `Tabs.Content` chrome, the `.tab-trigger` class names,
and the `kind`-driven tab set (`"markdown"` → rich, `"html"` → visual, `"plain"` →
source only). `EditorPane`, `ScratchpadPane`, and `InlineDocumentEditor` all go
through it. `src/components/InlineDocumentEditor.tsx` is the next level up: a
complete embedded editor (header with dirty/saved/read-only chips, inline error
banner, mode surface, `.editor-status` footer) for hosting a document inside
another surface - `src/App.tsx:8709` uses it for Files. Do not stand up a new tab
strip or a new save-state header.

## Persisted Settings

Adding a persisted UI preference touches exactly four places in
`src/lib/settings.ts`, and missing one is the usual bug:
1. The field on the interface - `MaruSettings["ui"]` or `LayoutSettings`.
2. A value in `DEFAULT_MARU_SETTINGS`.
3. A parse/clamp line in `normalizeMaruSettings` / `normalizeLayout`.
4. A copy line in `cloneDefaultSettings` for anything mutable (arrays, objects).

Drag limits are declared as a single frozen spec next to their siblings and reused
by the clamp:
```ts
/** Drag limits for the Scratchpad virtual folder tree. */
export const SCRATCHPAD_TREE_WIDTH = { defaultValue: 240, min: 200, max: 360 } as const;
// ...
scratchpadTreeWidth: normalizePaneWidth(
  layout.scratchpadTreeWidth,
  SCRATCHPAD_TREE_WIDTH.defaultValue,
  SCRATCHPAD_TREE_WIDTH.min,
  SCRATCHPAD_TREE_WIDTH.max,
),
```
Normalization is total: every field falls back to its default rather than throwing,
enum-ish strings go through a `parse*` helper that returns `undefined` on a miss
(`parseEditorViewModeSetting(ui.filesEditorViewMode) ?? "source"`), and an array
whose empty value is meaningful distinguishes `undefined` from `[]` explicitly.
Cover the new field in `src/lib/settings.test.ts` - both the default and a
clamped/rejected input.

## UI Strings (i18n)

Hard rule, gated in CI by `pnpm lint:i18n`:
- Never hardcode Korean or English UI text in a `.tsx` file. Every string lives in
  both `src/lib/i18n/locales/ko.ts` and `src/lib/i18n/locales/en.ts`, added in the
  same commit and in the same position. ko-KR and en-US are equal first-class
  locales.
- Read strings with `const { t } = useTranslation();` in components, or
  `t(locale, key, vars)` in plain TS. Interpolation uses `{name}` placeholders:
  `t("today.capacity.hoursMinutes", { hours, minutes: rest })`.
- A leaf component that is rendered by several panes takes `t` as a prop rather
  than calling `useTranslation()` itself, so its tests can pass an identity
  translator - `t: (key: string, vars?: Record<string, string | number>) => string`
  on `DocumentModeSurface` and `ScratchpadPane`.
- Key names are dotted and namespaced by surface: `scratchpad.tree.title`,
  `files.editor.openInDocuments`, `list.tree.expand`.
- Dictionaries are lazy chunks (~400 KB raw); provider sites gate their tree on
  `ready` from `useLocaleState` so `t()` stays synchronous.
- Escape hatch for a genuine proper noun: a trailing `// i18n-lint-ignore` on the
  line.

## Styling

- Plain CSS with kebab-case, component-prefixed class names -
  `.inline-document-editor-header`, `.scratchpad-collection`, `.today-capacity-card`.
  No CSS modules, no CSS-in-JS, no Tailwind.
- Font sizes in `src/styles.css` must use `--type-*` (dense chrome) or `--read-*`
  (rendered document prose) tokens from `src/foundations.css`. The two scales are
  deliberately separate so retuning the UI never resizes user prose. The
  `check-type-tokens` guard fails the build on a raw `font-size: NNpx`.
- Geometry that a drag handle controls is published as a CSS custom property on the
  pane root and consumed by the stylesheet, never written as a per-element inline
  height:
  ```tsx
  style={{ "--scratchpad-list-height": `${listHeight}px` } as CSSProperties}
  ```
  (`src/components/ScratchpadPane.tsx`). The e2e and unit tests assert on the
  property, so keep the name in sync with `src/styles.css`.
- Shell geometry comes from tokens too (`--shell-topbar-height`,
  `--shell-sidebar-expanded`).
- Keep `word-break: keep-all` intact for Korean text; more specific
  `word-break: break-all` rules on paths and hashes already override it.

---

*Convention analysis: 2026-08-22*
