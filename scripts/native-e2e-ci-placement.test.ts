// Behavioral proof for 06-05 T1 (CI placement, T-06-11) and T2 (verdict
// recorded consistently, T-06-04). Reads the actual workflow/Makefile/doc
// files and asserts only what they state — no invented contract.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ciYml = readFileSync(resolve(process.cwd(), ".github/workflows/ci.yml"), "utf8");
const nativeE2eYml = readFileSync(
  resolve(process.cwd(), ".github/workflows/native-e2e.yml"),
  "utf8",
);
const makefile = readFileSync(resolve(process.cwd(), "Makefile"), "utf8");

// A top-level job block: from `  <name>:` up to the next two-space-indented key or EOF.
function jobBlock(yml: string, name: string): string {
  const match = yml.match(new RegExp(`^  ${name}:\\n[\\s\\S]*?(?=^  [A-Za-z0-9_-]+:\\n|(?![\\s\\S]))`, "m"));
  expect(match, `workflow has no ${name} job`).not.toBeNull();
  return match![0];
}

const FAILURE_MASKS = [/\|\|\s*true/, /continue-on-error:\s*true/];

describe("native-e2e CI placement (T-06-11)", () => {
  const compileJob = jobBlock(ciYml, "native-e2e-compile");

  it("ci.yml runs on pull_request", () => {
    const on = ciYml.match(/^on:\n[\s\S]*?(?=^\S)/m)?.[0] ?? "";
    expect(on).toMatch(/^ {2}pull_request:/m);
  });

  it("the compile job is eligible on every pull request through the shared decision gate", () => {
    expect(compileJob).toMatch(/^ {4}needs: decision$/m);
    expect(compileJob).toMatch(/^ {4}if: needs\.decision\.outputs\.run_full == 'true'$/m);
    // The decision job only ever skips a push whose tree a PR already
    // verified: run_full starts true and is set false only under the push guard.
    const decision = jobBlock(ciYml, "decision");
    const pushGuard = decision.indexOf('if [ "$GITHUB_EVENT_NAME" = "push" ]; then');
    expect(decision.indexOf("run_full=true")).toBeGreaterThan(-1);
    expect(pushGuard).toBeGreaterThan(decision.indexOf("run_full=true"));
    expect(decision.indexOf("run_full=false")).toBeGreaterThan(pushGuard);
  });

  it("the compile job runs on macOS and compiles and typechecks the native-e2e build", () => {
    expect(compileJob).toMatch(/^ {4}runs-on: macos-14$/m);
    expect(compileJob).toMatch(/^ {8}run: pnpm typecheck$/m);
    expect(compileJob).toMatch(/^ {8}run: cd src-tauri && cargo check --locked --features native-e2e$/m);
  });

  it("the compile job never runs the suite and never masks a failure", () => {
    expect(compileJob).not.toContain("test-e2e-native");
    for (const mask of FAILURE_MASKS) expect(compileJob).not.toMatch(mask);
  });

  it("native-e2e.yml runs the suite on main pushes, v* tags, and workflow_dispatch, failing on a failed spec", () => {
    const onBlock = nativeE2eYml.match(/^on:[\s\S]*?(?=\njobs:)/m);
    expect(onBlock, "native-e2e.yml has no `on:` trigger block").not.toBeNull();
    const on = onBlock![0];
    expect(on).toMatch(/branches:\s*\n\s*-\s*main/);
    expect(on).toMatch(/tags:\s*\n\s*-\s*'v\*'/);
    expect(on).toContain("workflow_dispatch:");
    // `shell: bash` adds pipefail, so tee cannot swallow make's exit status (#368).
    expect(nativeE2eYml).toMatch(
      /^ {8}shell: bash\n {8}run: make test-e2e-native 2>&1 \| tee \/tmp\/native-e2e-run\.log$/m,
    );
  });

  it("Makefile's release-preflight recipe blocks on test-e2e-native", () => {
    const recipeMatch = makefile.match(/^release-preflight:[\s\S]*?(?=\n\.PHONY|\n[a-zA-Z_-]+:)/m);
    expect(recipeMatch, "Makefile has no release-preflight recipe").not.toBeNull();
    // Exact line: a `-` prefix or an `|| true` suffix would ignore the failure.
    expect(recipeMatch![0]).toMatch(/^\t\$\(MAKE\) test-e2e-native$/m);
  });

  it("Makefile's verify recipe does not include test-e2e-native", () => {
    const verifyLine = makefile.match(/^verify:[^\n]*/m);
    expect(verifyLine, "Makefile has no verify recipe line").not.toBeNull();
    expect(verifyLine![0]).not.toContain("test-e2e-native");
  });
});

describe("native-e2e CI-viability verdict recorded consistently (T-06-04)", () => {
  it("docs/native-e2e.md and .planning/PROJECT.md both name the ci-viable verdict", () => {
    const docs = readFileSync(resolve(process.cwd(), "docs/native-e2e.md"), "utf8");
    const project = readFileSync(resolve(process.cwd(), ".planning/PROJECT.md"), "utf8");
    expect(docs).toMatch(/\*\*ci-viable\*\*|`ci-viable`/);
    expect(project).toContain("ci-viable");
  });
});
