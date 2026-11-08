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

  it("keeps fallback compile for code PRs while full native selection is decision-owned", () => {
    expect(compileJob).toMatch(/^ {4}needs: decision$/m);
    expect(compileJob).toMatch(/^ {4}if: needs\.decision\.outputs\.run_native_compile == 'true'$/m);
    const decision = jobBlock(ciYml, "decision");
    for (const output of ["run_full", "run_e2e", "run_native", "run_native_compile"]) {
      expect(decision).toContain(output + ": " + '${{ steps.dedupe.outputs.' + output + ' }}');
    }
    expect(decision).toContain('node scripts/ci-policy.mjs classify');
    const suite = jobBlock(ciYml, "native-e2e");
    expect(suite).toContain("uses: ./.github/workflows/native-e2e.yml");
    expect(suite).toContain("if: needs.decision.outputs.run_native == 'true'");
  });

  it("always aggregates every gate and admits only intentional skips", () => {
    const aggregate = jobBlock(ciYml, "ci-ok");
    expect(aggregate).toMatch(/^ {4}if: always\(\)$/m);
    expect(aggregate).toContain("needs: [decision, verify, e2e, native-e2e-compile, native-e2e]");
    const jobs = Array.from(ciYml.slice(ciYml.indexOf("\njobs:")).matchAll(/^ {2}([A-Za-z0-9_-]+):$/gm), (match) => match[1]);
    const needs = aggregate.match(/^ {4}needs: \[(.*)\]$/m)?.[1].split(", ") ?? [];
    expect(new Set(needs)).toEqual(new Set(jobs.filter((job) => job !== "ci-ok")));
    expect(aggregate).toContain("node scripts/ci-policy.mjs aggregate");
    for (const mask of FAILURE_MASKS) expect(aggregate).not.toMatch(mask);
    const prTrigger = ciYml.match(/^  pull_request:\n[\s\S]*?(?=^  [A-Za-z0-9_-]+:)/m)?.[0] ?? "";
    expect(prTrigger).not.toContain("paths-ignore");
    expect(prTrigger).toContain("labeled");
  });

  it("keeps PR caller/callee concurrency separate from each other and main/tag", () => {
    expect(ciYml).toContain("group: ci-");
    expect(ciYml).toContain("ignored-label-{0}");
    expect(ciYml).toContain("ci-label-ignored");
    expect(nativeE2eYml).toContain("group: native-e2e-");
    expect(nativeE2eYml).toContain("format('pr-{0}'");
    expect(nativeE2eYml).not.toContain("github.workflow");
    expect(nativeE2eYml).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
    expect(nativeE2eYml).toContain("workflow_call:");
  });

  it("the compile job runs on macOS and compiles and typechecks the native-e2e build", () => {
    expect(compileJob).toMatch(/^ {4}runs-on: macos-26$/m);
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
      /^ {8}shell: bash\n {8}run: \|\n {10}export MARU_DIAGRAM_ENGINE_REVISION=\$\(git rev-parse HEAD:src-tauri\/crates\)\n {10}make test-e2e-native 2>&1 \| tee \/tmp\/native-e2e-run\.log$/m,
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
