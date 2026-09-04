# Maru Coding Conventions

## Language and Toolchain

- **Frontend**: React 19, TypeScript ~5.9.3, Vite 7.
- **Backend / native**: Rust edition 2021, MSRV 1.77.2, pinned toolchain `1.98.0` (`rust-toolchain.toml`).
- **Package manager**: pnpm 9.15.0.
- **Build orchestration**: `Makefile` is the SSOT for dev / build / test / verify workflows.

## TypeScript Conventions

### Compiler

- Project references via `tsconfig.json`:
  - `tsconfig.app.json` for `src/`
  - `tsconfig.node.json` for Node config tooling
  - `tsconfig.e2e.json` for Playwright specs
  - `tsconfig.e2e-native.json` for WebdriverIO specs
  - `tsconfig.scripts.json` for repository scripts
- `tsconfig.app.json` uses:
  - `"strict": true`
  - `"target": "ES2022"`
  - `"module": "ESNext"`, `"moduleResolution": "Bundler"`
  - `"jsx": "react-jsx"`
  - `"noEmit": true`

### Naming and file organization

- Components: `PascalCase.tsx` (e.g., `AgentUsageBar.tsx`).
- Domain logic / stores: `camelCase.ts` under `src/lib/`.
- Tests: co-located `*.test.ts(x)` or `*.bench.ts`, plus cross-cutting specs under `src/__tests__/`.
- Types / interfaces: `PascalCase`; prefer explicit `type` exports where applicable.
- Unused identifiers must start with `_` to satisfy ESLint.

### Module boundaries

- `src/lib/` owns frontend domain logic and module stores.
- `src/components/` owns rendering, editors, user interaction, graph layout, and diagram canvas behavior.
- `src/lib/` must not import components, except for documented type-only legacy boundaries.
- Nothing imports `src/App.tsx`.
- Shared UI state uses keyed module stores plus `useSyncExternalStore`; no additional global state library or provider tree.

### React patterns

- Functional components with hooks.
- `react-hooks/rules-of-hooks` and `react-hooks/exhaustive-deps` are errors.
- Lazy-loaded mode adapters for the 18 work surfaces.
- `MainApp` intentionally caps `useState` / `useEffect` usage (tracked as an architecture metric).

## Rust Conventions

### Format and style

- `rustfmt` and `clippy` are gates; clippy runs with `-D warnings`.
- Module declaration order in `src-tauri/src/lib.rs` is the canonical module index.
- Public Tauri command surface is exported from `src-tauri/src/lib.rs`.
- Workspace member: `maru-cli` (standalone CLI crate).

### Naming

- Functions / variables: `snake_case`.
- Types / traits: `PascalCase`.
- Constants: `SCREAMING_SNAKE_CASE`.
- Modules: `snake_case`.

### Safety and architecture

- Rust owns workspace filesystem access, cache, git operations, frontmatter, provider bridges, terminal sessions, skill ownership, agent execution, catalog, Studio, export, Diagram, Graph storage, and write enforcement.
- `src-tauri/src/frontmatter/ops.rs` is the only allowed frontmatter write path.
- Path containment helpers stay lexical; managed writes pass `vault_guard::validate_managed_write`, create snapshots, and use revision-checked atomic replacement.
- Every conflict code the frontend consumes crosses as structured `IpcError` (ERR-06).
- Provider and subprocess commands use fixed argv rather than a shell when input can cross a trust boundary.

## Linting

### ESLint

- Flat config (`eslint.config.js`) for ESLint 10.
- Scope: `src/`, `e2e/`, `e2e-native/`; `scripts/` is intentionally excluded.
- No preset extends; exactly four correctness rules:
  - `react-hooks/rules-of-hooks`: error
  - `react-hooks/exhaustive-deps`: error
  - `@typescript-eslint/no-unused-vars`: error (ignores `^_`)
  - `@typescript-eslint/no-floating-promises`: error
- `console` linting is deliberately disabled.
- `pnpm lint` runs with `--max-warnings 0`.

### Static guards

- `check-select-chrome`: select rules must not wipe the base chevron via background shorthand.
- `check-type-tokens`: `src/styles.css` font sizes must use `--type-*` / `--read-*` tokens.
- `check-native-e2e-isolation`: no native-e2e runner affordances in the production bundle or Cargo manifest.
- `lint-i18n`: Korean/English key parity plus hardcoded UI string scan.
- `release-version-check`: all version surfaces stay synchronized.

## Formatting

- No Prettier config is present.
- Rust formatting is enforced by `cargo fmt`.
- `git diff --check` is part of release preflight to catch whitespace errors.

## Commit and Documentation Style

- Git commit messages are written in English (per `AGENTS.md`).
- Markdown files use standard markdown syntax:
  - `#` headings without numbering.
  - Lists with `-` bullets.
  - Emphasis with `**bold**` only.
  - No trailing spaces, `<br>`, or inline HTML.
- Korean public documents use gaejosik style when converted to HWP; markdown source uses plain markdown.

## Project-Specific Rules

- **Filesystem authoritative**: notes, tasks, drafts, evidence, and diagrams remain usable without Maru; caches are disposable.
- **Local-first writes**: ordinary editing happens inside user-owned workspace folders; cloud or Hub writes require an explicit supported path and approval.
- **Byte-stable documents**: frontmatter edits preserve unrelated keys, comments, order, quoting, and document body bytes.
- **Fail-closed mutation**: revision checks, workspace ownership, write policy, path containment, and managed-write validation run again in Rust.
- **Inspectable automation**: AI work is suggestion-first; protected writes use approval staging and durable audit events.
- **Korean document fidelity**: HWPX, DOCX, PDF, Korean filenames, Korean IME, and public-document writing workflows are first-class concerns.
- No default telemetry, no Maru account, no cloud-sync engine, no unsigned updater feeds.
