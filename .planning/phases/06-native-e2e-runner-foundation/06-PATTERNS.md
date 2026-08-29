# Phase 6: Native E2E Runner Foundation - Pattern Map

**Mapped:** 2026-08-29
**Files analyzed:** 19 (10 new, 9 modified)
**Analogs found:** 17 / 19 (2 have no in-repo analog, listed under "No Analog Found")

Source inventory: RESEARCH.md "Wave 0 Gaps" (authoritative new-file list) + CONTEXT.md
`<code_context>` "Integration Points" (authoritative modified-file list). All line numbers
below were re-verified against the live tree this session, not copied from RESEARCH.md
without checking.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `e2e-native/wdio.conf.ts` | config | request-response | `playwright.config.ts` | role-match (explicit anti-pattern: do not copy its retry/trace values, Pitfall 7) |
| `e2e-native/specs/webview.spec.ts` | test | request-response | `e2e/smoke.spec.ts` | role-match (organizational shape only; Playwright `test`/`expect` API does not port to wdio/mocha) |
| `e2e-native/specs/pty.spec.ts` | test | streaming | `src/components/NativeTerminalView.tsx` (`frameLineToText`, canvas) | exact (this is the literal read target, not a structural analog) |
| `e2e-native/specs/ime.spec.ts` | test | event-driven | `NativeTerminalView.tsx` composition handlers + `RichMarkdownEditor.tsx` | exact |
| `e2e-native/specs/menu.spec.ts` | test | request-response (human-attended) | none | no analog |
| `e2e-native/helpers/fixtureWorkspace.ts` | utility | file-I/O | `scripts/e2e-mcp-smoke.mjs` | exact |
| `e2e-native/helpers/ptyAssertions.ts` | utility | transform | `NativeTerminalView.tsx:238-243,1204-1206,2129` | exact |
| `src/lib/e2eNativeInvoke.ts` (name: Claude's discretion, D-06) | utility (seam) | event-driven | `src/lib/e2eInvoke.ts` + `graphBridge.ts`/`GraphCanvas.tsx` DEV-gate | exact (composite of two analogs) |
| `scripts/check-native-e2e-isolation.mjs` (name: Claude's discretion, D-10) | utility (static guard) | batch | `scripts/check-bundle-budget.mjs`, `scripts/check-select-chrome.mjs` | exact |
| `src-tauri/Cargo.toml` (modify) | config | n/a | existing dependency/target blocks | role-match (no `[features]` table exists yet — this is the first one) |
| `src-tauri/src/maru_dir.rs` (modify) | model/utility | CRUD (path resolution) | `src-tauri/src/skill_host/fs.rs:15-50,203-243` | exact |
| `src-tauri/src/vault_list.rs` (modify) | model/utility | CRUD (path resolution) | same file's own `test_config_dir_override()` (174-189) + `skill_host/fs.rs` non-test-branch shape | exact |
| `tsconfig.e2e-native.json` (name: Claude's discretion) | config | n/a | `tsconfig.e2e.json` | exact |
| `tsconfig.json` (modify, root) | config | n/a | its own existing `references` array | exact |
| `eslint.config.js` (modify) | config | n/a | its own existing `e2e/**/*.ts` block (lines 35-49) | exact |
| `Makefile` (modify) | build tooling | batch | `test-e2e` (207-209) + `release-preflight` (267-271) + `cli-smoke` (134-142) | exact |
| `.github/workflows/ci.yml` (modify) | CI config | batch | its own `verify` job (101-178) + `release-bundles.yml` macOS matrix leg | role-match |
| `docs/native-e2e.md` (path: Claude's discretion within `docs/`, D-04) | doc | n/a | `docs/macos-passkeys.md` | role-match |
| `.planning/PROJECT.md` (modify, "CI reality" constraint) | doc | n/a | its own text at lines 232-234 | direct edit, no code analog |

## Pattern Assignments

### `e2e-native/wdio.conf.ts` (config, request-response)

**Analog:** `playwright.config.ts` (structural shape only — see Anti-Pattern below)

**What to copy** — the shape of a single exported config object with a `use`/`services`
block, a `webServer`/launch block, and a `projects`/`capabilities` array:
```typescript
// playwright.config.ts:1-11
import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.MARU_E2E_PORT ?? 5307);

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: {
    timeout: 8_000,
  },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
```

**What NOT to copy** — the retry/trace block, verbatim, is the anti-pattern this phase's
research explicitly calls out:
```typescript
// playwright.config.ts:30 — no `retries` key set anywhere in this file, so
// "on-first-retry" semantics quoted below never actually fire.
trace: { mode: "retain-on-failure", snapshots: false, screenshots: false },
```
`e2e-native/wdio.conf.ts` must define its own retry/flake policy from scratch — native
automation flake sources (focus stealing, Gatekeeper dialogs, leftover PTY processes) have
no analogue in this config. See RESEARCH.md Pitfall 7 and Architecture Pattern 1/4 for the
actual wdio-side config shape (`services: ["@wdio/tauri-service"]`, `tauri:options`).

---

### `e2e-native/specs/webview.spec.ts`, `pty.spec.ts`, `ime.spec.ts`, `menu.spec.ts` (test, D-13's four surfaces)

**Analog for file organization only:** `e2e/smoke.spec.ts` — one spec file per behavior
area, with a shared `test.beforeEach` for cross-cutting setup:
```typescript
// e2e/smoke.spec.ts:1-9
import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.sessionStorage.getItem("maru:e2e:storage-cleared") === "true") return;
    window.localStorage.clear();
    window.sessionStorage.setItem("maru:e2e:storage-cleared", "true");
  });
});
```
This is organizational precedent only — WebdriverIO/Mocha's `describe`/`it` API and
`browser.executeScript` replace Playwright's `test`/`page.evaluate`. Do not import
`@playwright/test` into `e2e-native/`.

**`pty.spec.ts` and `ime.spec.ts` read the real app's own code, not a mock.** See the
dedicated pattern sections below (`ptyAssertions.ts`, IME surfaces) for the exact lines
each spec drives.

**`menu.spec.ts` has no in-repo analog** — see "No Analog Found" below.

---

### `e2e-native/helpers/fixtureWorkspace.ts` (utility, file-I/O, D-09)

**Analog:** `scripts/e2e-mcp-smoke.mjs` — this is the closest thing in the repo to
"seed a fresh tempdir with fixture files, then launch a real process pointed at it via an
env var," which is exactly D-09's contract, in the same runtime (Node) the new helper runs
in.

**Tempdir + fixture-file seeding** (lines 8-24):
```javascript
// scripts/e2e-mcp-smoke.mjs:8-24
const root = path.resolve(import.meta.dirname, "..");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "maru-e2e-mcp-"));
const runId = "maru-e2e-smoke";
const runDir = path.join(tmp, ".maru", "e2e-runs", runId);
await fs.mkdir(runDir, { recursive: true });
await fs.writeFile(
  path.join(runDir, "metadata.json"),
  JSON.stringify({ /* ... */ }),
);
await fs.writeFile(path.join(runDir, "report.md"), "# Maru E2E Development Report\n");
```

**Launching a real process pointed at the tempdir via env var** (lines 26-31):
```javascript
// scripts/e2e-mcp-smoke.mjs:26-31
const child = spawn(process.execPath, [path.join(root, "sidecars/maru-mcp/index.mjs")], {
  cwd: tmp,
  env: { ...process.env, MARU_MCP_WORKSPACE: tmp },
  stdio: ["pipe", "pipe", "inherit"],
});
```
This is the pattern D-09 + Pitfall 8 need: since `tauri:options` has no documented `env`
key (RESEARCH.md Assumption A2), `fixtureWorkspace.ts` should set the D-09 env var(s) on
`process.env` of the wdio Node process itself before it spawns the app — the same
"env object with one added key, passed to `spawn`" idiom this file already uses. Cleanup
(`child.kill()`) is at line 52.

**Cross-reference:** this seeded tempdir is only useful once `src-tauri/src/maru_dir.rs`
and `vault_list.rs` gain a real (non-`#[cfg(test)]`) override that reads the env var this
helper sets — see the Rust pattern section below. Without that Rust-side change, this
helper's env var has no effect on the real launched `.app` (RESEARCH.md Pitfall 1).

---

### `e2e-native/helpers/ptyAssertions.ts` (utility, transform, D-05)

**Analog:** `src/components/NativeTerminalView.tsx` — the exact grid-to-text serialization
and canvas element this helper reads via `executeScript`.

**Text-serialization to reuse verbatim** (lines 238-243):
```typescript
// src/components/NativeTerminalView.tsx:238-243
export function frameLineToText(line: TerminalCell[]): string {
  return line
    .filter((cell) => cell.width !== 0)
    .map((cell) => cell.ch || " ")
    .join("")
    .replace(/\s+$/u, "");
}
```

**Whole-grid call-site shape to copy** (lines 1204-1206):
```typescript
// src/components/NativeTerminalView.tsx:1204-1206
allSelectionTextRef.current =
  text ?? gridRef.current.map(frameLineToText).join("\n");
```

**Canvas element the ink-check samples** (line 2129):
```typescript
// src/components/NativeTerminalView.tsx:2129
<canvas ref={canvasRef} className="native-terminal-canvas" aria-hidden="true" />
```
Selector for wdio: `.native-terminal-canvas`. The canvas paints via `fillText`/`fillRect`
2D-context calls (not `drawImage()` from an external source), so `getImageData` reads are
not subject to CORS canvas-tainting regardless of Tauri's custom-protocol origin — safe to
read back directly, per RESEARCH.md Assumption A4.

---

### `src/lib/e2eNativeInvoke.ts` (utility/seam, event-driven, D-06)

**Analog 1 — the build-inert seam shape to invert:** `src/lib/e2eInvoke.ts` (whole file,
27 lines):
```typescript
// src/lib/e2eInvoke.ts:1-26
declare global {
  interface Window {
    __MARU_E2E_INVOKE__?: Record<string, (args: Record<string, unknown>) => unknown>;
    __TAURI_INTERNALS__?: unknown;
  }
}

export async function invokeE2EOverride<T>(
  command: string,
  args: Record<string, unknown>,
): Promise<T | null> {
  if (typeof window === "undefined" || window.__TAURI_INTERNALS__) return null;
  const handler = window.__MARU_E2E_INVOKE__?.[command];
  if (!handler) return null;
  return (await handler(args)) as T;
}
```
D-06 inverts this precedent: `e2eInvoke.ts` is *runtime*-inert (checks `window.__TAURI_INTERNALS__` at call time, ships in every build); the new D-06 global must be *build*-inert (tree-shaken out of production entirely via `import.meta.env`), because the native runner's target *is* the Tauri shell where `__TAURI_INTERNALS__` is always present.

**Analog 2 — the `import.meta.env.DEV` tree-shaking precedent to actually gate it:**
```typescript
// src/components/graph/graphBridge.ts:1-4
// Development-only observational bridge for real-Sigma e2e (replaces the old
// fake DOM overlay). Active only when import.meta.env.DEV AND
// localStorage["maru:e2e:graph-bridge"] === "1" — Vite drops DEV-gated code
// from production builds, and the flag keeps it off in normal dev sessions.
```
```typescript
// src/components/graph/graphBridge.ts:59-69
export function graphBridgeEnabled(): boolean {
  try {
    return (
      (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV === true &&
      typeof localStorage !== "undefined" &&
      localStorage.getItem("maru:e2e:graph-bridge") === "1"
    );
  } catch {
    return false;
  }
}
```
```typescript
// src/components/graph/GraphCanvas.tsx:773
const bridgeEnabled = import.meta.env.DEV && graphBridgeEnabled();
```
Copy this exact shape: `import.meta.env.DEV` as the outer build-time gate (Vite drops the
branch from production), an optional second runtime flag if a narrower on/off toggle is
wanted within dev builds, and a declared global on `window` guarded by the same check at
every read site.

---

### `scripts/check-native-e2e-isolation.mjs` (static guard, batch, D-10)

**Analog:** `scripts/check-bundle-budget.mjs` and `scripts/check-select-chrome.mjs` — both
read the *produced artifact*, never the source, matching D-10's explicit "declaring the
intent and checking the output are different acts" rationale.

```javascript
// scripts/check-bundle-budget.mjs:1-13
import { readdirSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const assetsDir = new URL("../dist/assets/", import.meta.url);
const files = readdirSync(assetsDir);

function largestMatching(pattern) {
  const matches = files.filter((file) => pattern.test(file));
  if (matches.length === 0) throw new Error(`bundle-budget: no asset matched ${pattern}`);
  return matches
    .map((file) => ({ file, bytes: readFileSync(new URL(file, assetsDir)) }))
    .sort((a, b) => b.bytes.length - a.bytes.length)[0];
}
```
The new guard should follow the same shape: read `dist/assets/*.js`, assert the built
bundle text does **not** contain the D-06 global's string (e.g.
`"__MARU_NATIVE_TERMINAL_TEXT__"`), and `throw`/`process.exit(1)` loudly on violation —
`check-select-chrome.mjs`'s exit-code convention:
```javascript
// scripts/check-select-chrome.mjs:71-77
if (violations.length > 0) {
  console.error(
    `select-chrome: select rules must use background-color, not the background shorthand:\n  ${violations.join("\n  ")}`,
  );
  process.exit(1);
}
console.log("select-chrome: all select rules preserve the base chevron");
```

**Wiring precedent (Makefile + package.json):**
```makefile
# Makefile:174-176
.PHONY: check-select-chrome
check-select-chrome: ## Static guard: select rules must not wipe the base chevron via background shorthand
	$(NODE) scripts/check-select-chrome.mjs
```
```makefile
# Makefile:325
verify: typecheck lint release-version-check icons-check lint-i18n check-select-chrome check-type-tokens test-ts test-rust fmt-check clippy build-frontend
```
```json
// package.json:14-18 (also gives the pnpm-script convention)
"build:frontend": "vite build && node scripts/check-bundle-budget.mjs",
"check:bundle-budget": "node scripts/check-bundle-budget.mjs",
"check:select-chrome": "node scripts/check-select-chrome.mjs",
```
The new guard joins `verify` the same way `check-select-chrome` does — a `.PHONY` target
running the script, added to `verify`'s prerequisite list.

---

### `src-tauri/src/maru_dir.rs` and `src-tauri/src/vault_list.rs` (modify, model/utility, D-09/D-10)

**Analog:** `src-tauri/src/skill_host/fs.rs` — this file already implements the exact
"env-var override + restore guard + tempdir" idiom D-09 needs, one level more mature than
`vault_list.rs`'s own `#[cfg(test)]`-only version (RESEARCH.md Pitfall 1-2).

**Override function + absolute-path guard** (lines 19-29):
```rust
// src-tauri/src/skill_host/fs.rs:19-29
pub fn maru_home() -> Result<PathBuf, String> {
    // The final value is validated on every return path, including the
    // test-override branch (D-08/D-09): a relative base would silently
    // materialize directory trees in the process cwd.
    let base = if let Some(path) = test_maru_home_override() {
        path.join(".maru")
    } else {
        home_dir()?.join(".maru")
    };
    require_absolute(base)
}
```

**The override + restore-guard pair** (lines 203-243):
```rust
// src-tauri/src/skill_host/fs.rs:203-222
#[cfg(test)]
fn test_maru_home_override() -> Option<PathBuf> {
    std::env::var_os("MARU_TEST_HOME").map(PathBuf::from)
}

#[cfg(test)]
static MARU_TEST_HOME_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[cfg(test)]
pub(crate) fn test_maru_home_lock() -> MutexGuard<'static, ()> {
    MARU_TEST_HOME_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(not(test))]
fn test_maru_home_override() -> Option<PathBuf> {
    None
}

/// Shared test fixture: sandbox MARU_TEST_HOME into a TempDir, holding the
/// process-global home lock until dropped. Field order is load-bearing (the
/// guard must drop last) — see store::tests::TestHome.
#[cfg(test)]
pub(crate) struct BundleTestHome {
    _dir: tempfile::TempDir,
    previous: Option<std::ffi::OsString>,
    _guard: MutexGuard<'static, ()>,
}
```
This phase's new override must swap `#[cfg(test)]`/`#[cfg(not(test))]` for the new
default-off cargo feature (D-10) — the same two-branch shape, gated on
`#[cfg(feature = "...")]` instead. Apply this to both:
- `maru_home_dir()` (`src-tauri/src/maru_dir.rs:158-161`), which currently has **no**
  override branch at all (a plain 3-line function — Pitfall 2):
  ```rust
  // src-tauri/src/maru_dir.rs:158-161
  fn maru_home_dir() -> Result<PathBuf, String> {
      dirs::home_dir()
          .map(|home| home.join(".maru"))
          .ok_or_else(|| "Could not determine home directory for ~/.maru".to_string())
  }
  ```
- `app_config_dir()`/`test_config_dir_override()` (`src-tauri/src/vault_list.rs:174-189`),
  which already has the indirection shape ready to extend to a non-test build:
  ```rust
  // src-tauri/src/vault_list.rs:174-189
  #[cfg(test)]
  fn test_config_dir_override() -> Option<PathBuf> {
      std::env::var_os("MARU_TEST_CONFIG_DIR").map(PathBuf::from)
  }

  #[cfg(not(test))]
  fn test_config_dir_override() -> Option<PathBuf> {
      None
  }

  fn app_config_dir() -> Result<PathBuf, String> {
      if let Some(dir) = test_config_dir_override() {
          return Ok(dir);
      }
      dirs::config_dir().ok_or_else(|| "Could not determine config directory".to_string())
  }
  ```

**Security note carried from RESEARCH.md's Security Domain section:** the new override
must fail closed — refuse to launch / error loudly — if the gating feature is active but
the expected env var is absent, rather than silently falling back to the real home
directory (Tampering / accidental-data-loss mitigation).

---

### `tsconfig.e2e-native.json` (config, D-15)

**Analog:** `tsconfig.e2e.json` (whole file, 17 lines) — copy verbatim except `include`:
```json
// tsconfig.e2e.json:1-17
{
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.e2e.tsbuildinfo",
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["node"],
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "forceConsistentCasingInFileNames": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "noEmit": true
  },
  "include": ["e2e"]
}
```
Change `tsBuildInfoFile` to a distinct cache name and `include` to `["e2e-native"]`.

---

### `tsconfig.json` (modify, root, D-15)

**Analog:** its own existing `references` array — add one more entry, same shape:
```json
// tsconfig.json:1-9
{
  "files": [],
  "references": [
    { "path": "./tsconfig.app.json" },
    { "path": "./tsconfig.node.json" },
    { "path": "./tsconfig.e2e.json" },
    { "path": "./tsconfig.scripts.json" }
  ]
}
```

---

### `eslint.config.js` (modify, D-15)

**Analog:** its own existing `e2e/**/*.ts` block (lines 35-49) — add a matching block for
`e2e-native/**/*.ts` pointed at the new tsconfig project:
```javascript
// eslint.config.js:35-49
{
  files: ["e2e/**/*.ts"],
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      project: "./tsconfig.e2e.json",
      tsconfigRootDir: import.meta.dirname,
    },
  },
  plugins: { "@typescript-eslint": tseslint.plugin },
  rules: {
    "@typescript-eslint/no-unused-vars": [
      "error",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
    ],
    "@typescript-eslint/no-floating-promises": "error",
  },
},
```
Note the file's own header comment: `// D-03: scope is src/ + e2e/, not scripts/.` — that
comment becomes stale once `e2e-native/` is added and should be updated in the same edit.

---

### `Makefile` (modify, D-03/D-15/D-16)

**Analog 1 — the target-composition shape (`test-e2e` + `release-preflight`):**
```makefile
# Makefile:207-209
.PHONY: test-e2e
test-e2e: node_modules ## Playwright e2e (requires browsers; run `pnpm playwright install` first)
	$(PNPM) test:e2e
```
```makefile
# Makefile:267-271
.PHONY: release-preflight
release-preflight: ## Complete local release preflight: core checks, release CLI smoke, and e2e
	$(MAKE) release-preflight-core
	$(MAKE) cli-smoke
	$(MAKE) test-e2e
```
The new target (e.g. `test-e2e-native`) joins this composition exactly as D-03 specifies:
blocking in `release-preflight` in both branches of the spike verdict.

**Analog 2 — isolating a real launched process via env var, shell-side (`cli-smoke`):**
```makefile
# Makefile:134-142
.PHONY: cli-smoke
cli-smoke: cli-build ## Smoke test standalone Maru CLI with an isolated HOME under .context/
	@set -euo pipefail; \
	rm -rf "$(CLI_SMOKE_HOME)"; \
	mkdir -p "$(CLI_SMOKE_HOME)"; \
	smoke_home="$$(cd "$(CLI_SMOKE_HOME)" && pwd)"; \
	HOME="$$smoke_home" "$(CLI_RELEASE_BIN)" --version; \
	HOME="$$smoke_home" "$(CLI_RELEASE_BIN)" doctor --quiet; \
	HOME="$$smoke_home" "$(CLI_RELEASE_BIN)" skills dirty --json
```
This is the closest in-repo precedent for "launch the real binary with an isolated,
disposable directory bound through an env var" at the shell/Makefile level — the same
principle `fixtureWorkspace.ts` implements in Node for the wdio-launched app.

**Analog 3 — the "deliberately excluded from `verify`" precedent (`verify-integration`):**
```makefile
# Makefile:216-223
# Deliberately NOT part of `verify`: this depends on which AI CLIs are installed
# and whether their tokens are live, and a merge gate that fails on an expired
# token is a gate people learn to bypass. Run it when touching provider.rs,
# skill_host/dispatch.rs, agent_host/status.rs or terminal/mod.rs.
.PHONY: verify-integration
verify-integration: $(ICON_PATH) ## Smoke the real installed AI CLIs...
	cd $(TAURI_DIR) && MARU_CLI_SMOKE=1 \
		$(CARGO) test --lib cli_backends_real_smoke -- --ignored --nocapture --test-threads=1
```
This is the exact precedent D-15's own note cites for why the native target stays outside
`make verify` (hermetic) and inside `release-preflight` instead.

---

### `.github/workflows/ci.yml` (modify, D-03)

**Analog:** its own existing `verify` job's checkout/setup/cache steps (lines 108-157),
plus `release-bundles.yml`'s macOS-specific toolchain step for the parts that differ:
```yaml
# .github/workflows/ci.yml:139-157
- name: Setup pnpm
  uses: pnpm/action-setup@v6
  with:
    version: 9.15.0

- name: Setup Node
  uses: actions/setup-node@v5
  with:
    node-version: 22.22.3
    cache: pnpm

- name: Setup Rust
  uses: dtolnay/rust-toolchain@stable

- name: Cache Rust build
  uses: Swatinem/rust-cache@v2
  with:
    workspaces: src-tauri -> target
    shared-key: ubuntu-22.04-validation
```
The new macOS compile-and-typecheck job (D-03) copies this shape with `runs-on: macos-14`
(or `macos-15`) and a distinct `shared-key`, dropping the Linux-only
`libwebkit2gtk`/`libxdo` apt step. `release-bundles.yml` already proves a working macOS
runner leg exists in this repo's CI (`matrix.platform: macos-latest`, confirmed at
`.github/workflows/release-bundles.yml:123-129`) — the new job is a new leg on a proven
path, not new ground.

---

### `docs/native-e2e.md` (D-04, path/name Claude's discretion)

**Analog:** `docs/macos-passkeys.md` — a macOS-specific runbook already following the
"scope → eligibility/process → evidence" shape D-04 needs (what this enables, how to run
it, what's out of scope, a table of criteria and how the codebase answers each):
```markdown
# docs/macos-passkeys.md:1-9
# macOS browser passkeys

Operator runbook for the opt-in, fail-closed browser-passkey build: request →
approval → provisioning profile → build → notarize.

The default Maru build is unaffected. It carries no managed entitlement and no
HTTP/HTTPS browser-role metadata, and the runtime returns `unsupported` before
touching Apple's API, so everything below applies only to the separate
provisioned build.
```
D-04's document should mirror this structure: what the runner is, its scope (CI-gated
subset vs. local-only, per the recorded verdict), how to run it (`make
test-e2e-native`, or the local human-attended path), and the evidence trail (the spike's
recorded failure class/cap per D-02).

---

### `.planning/PROJECT.md` (modify, D-04)

**Direct edit target**, no code analog — the exact text D-04 requires updating:
```markdown
# .planning/PROJECT.md:232-234
- **CI reality**: `make verify` runs on `ubuntu-22.04` only, and e2e runs
  Chromium against Vite with mocked IPC. macOS-native changes ship unverified by
  CI - validate them by running the real app
```
Rewrite this bullet at phase end to reflect whichever verdict the spike returns (CI-gated
subset exists now, or the runner stays local-only per D-01/D-02), per D-04's "Phase 8 and
Phase 9 plan their verification against those two [docs], not against this CONTEXT."

## Shared Patterns

### Build-inert / DEV-gated debug seam
**Sources:** `src/lib/e2eInvoke.ts` (runtime-inert shape) + `src/components/graph/graphBridge.ts:1-4,59-69` and `src/components/graph/GraphCanvas.tsx:773` (`import.meta.env.DEV` tree-shaking)
**Apply to:** `src/lib/e2eNativeInvoke.ts` (D-06)

### Static artifact guard family
**Sources:** `scripts/check-bundle-budget.mjs`, `scripts/check-select-chrome.mjs`, wired via `Makefile:174-176` and `verify`'s prerequisite list at `Makefile:325`
**Apply to:** `scripts/check-native-e2e-isolation.mjs` (D-10)

### Rust env-var override + restore-guard idiom
**Source:** `src-tauri/src/skill_host/fs.rs:19-29,203-243` (the more mature sibling of `vault_list.rs`'s own `#[cfg(test)]`-only version)
**Apply to:** `src-tauri/src/maru_dir.rs` and `src-tauri/src/vault_list.rs` (D-09/D-10's new feature-gated override — Pitfalls 1-2)

### Tempdir-seed + real-process-launch-via-env-var
**Source:** `scripts/e2e-mcp-smoke.mjs:8-31` (Node `fs.mkdtemp` + fixture writes + `spawn` with an added `env` key)
**Apply to:** `e2e-native/helpers/fixtureWorkspace.ts` (D-09), and informs how `wdio.conf.ts`/the launch code should pass its env var to the child process given `tauri:options` has no documented `env` key (Pitfall 8)

### "Excluded from `verify`, wired into `release-preflight`" precedent
**Source:** `Makefile:134-142` (`cli-smoke`'s isolated-`HOME` launch) + `Makefile:216-223` (`verify-integration`'s exclusion rationale) + `Makefile:267-271` (`release-preflight` composition)
**Apply to:** the new native e2e make target (D-03, D-15)

### Per-tree TS project + lint scoping
**Source:** `tsconfig.e2e.json` (whole file) + `eslint.config.js:35-49` (`e2e/**/*.ts` block) + `tsconfig.json:1-9` (`references` array)
**Apply to:** `tsconfig.e2e-native.json`, `eslint.config.js`'s new block, `tsconfig.json`'s new reference entry (D-15)

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `e2e-native/specs/menu.spec.ts` | test | request-response (human-attended) | No AXUIElement/Accessibility-API automation exists anywhere in this repo — D-13 itself notes the menu bar has no unattended path on any tier; RESEARCH.md's Architectural Responsibility Map assigns it to "Human (local, Accessibility-permission-gated)" with no automated-tier fallback |
| `src-tauri/Cargo.toml`'s new `[features]` table | config | n/a | This Cargo.toml has zero `[features]` entries today (confirmed by direct read) — the default-off cargo feature gating `tauri-plugin-wdio-webdriver` (D-10) is the first feature this manifest declares, so there is no in-repo `[features]` block to pattern-match against. Use the standard Cargo manual syntax (`[features]` + `default = []` + a named feature listing the optional dependency) — no project-specific convention exists to deviate from |

## Metadata

**Analog search scope:** `src/`, `src/lib/`, `src/components/`, `src/components/graph/`, `src-tauri/src/`, `src-tauri/src/skill_host/`, `scripts/`, `e2e/`, `e2e/helpers/`, root config files (`tsconfig*.json`, `eslint.config.js`, `playwright.config.ts`, `package.json`), `Makefile`, `.github/workflows/`, `docs/`, `.planning/PROJECT.md`
**Files scanned (read in full or targeted ranges):** `src/lib/e2eInvoke.ts`, `src/components/graph/graphBridge.ts`, `src/components/graph/GraphCanvas.tsx` (line 773 area), `src/components/NativeTerminalView.tsx` (multiple ranges: 80-140, 465-534, 2120-2165), `src/components/RichMarkdownEditor.tsx` (imports/DOM), `tsconfig.e2e.json`, `tsconfig.json`, `scripts/check-bundle-budget.mjs`, `scripts/check-select-chrome.mjs`, `scripts/e2e-mcp-smoke.mjs`, `eslint.config.js`, `Makefile` (multiple ranges: 16-19, 109-158, 200-280, 325), `src-tauri/Cargo.toml`, `src-tauri/src/vault_list.rs` (160-199), `src-tauri/src/maru_dir.rs` (1-170), `src-tauri/src/skill_host/fs.rs` (1-60, 195-244), `.github/workflows/ci.yml` (full), `.github/workflows/release-bundles.yml` (grep + targeted lines), `playwright.config.ts` (full), `e2e/helpers/todayFixtures.ts` (full — ruled out as fixture-seeding analog, see note below), `e2e/smoke.spec.ts` (partial), `docs/macos-passkeys.md` (partial), `.planning/PROJECT.md` (CI reality section)
**Pattern extraction date:** 2026-08-29

**Note on a rejected analog:** `e2e/helpers/todayFixtures.ts` was read in full as a
candidate for `fixtureWorkspace.ts` (it is the repo's largest existing "fixture" helper)
but rejected — it seeds a Playwright page-side in-memory mock (`window.__MARU_E2E_INVOKE__`
handlers + `localStorage`), never touches the real filesystem, and runs against plain Vite
with no Tauri backend. D-09 needs the opposite: real files on a real disk, read by the real
Rust backend. `scripts/e2e-mcp-smoke.mjs` is the correct analog because it actually writes
files to a real tempdir and launches a real child process against it.
