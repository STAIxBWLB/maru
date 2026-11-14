import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyPrChanges, evaluateCiJobs, isDocsOnlyPath, geometryForPushComparison } from "./ci-policy.mjs";
import { ENGINE_E3_ARTIFACT_PATHS, isE0SelectedPath } from "./diagram-engine-e0-paths.mjs";

const policyPath = resolve(process.cwd(), "scripts/ci-policy.mjs");
const decisionOutputs = {
  run_full: "false",
  run_e2e: "false",
  run_native: "false",
  run_native_compile: "false",
  run_geometry: "false",
  macos_deferred: "false",
};

function needs(overrides: Record<string, unknown> = {}) {
  return {
    decision: { result: "success", outputs: { ...decisionOutputs } },
    verify: { result: "skipped" },
    e2e: { result: "skipped" },
    "native-e2e-compile": { result: "skipped" },
    "native-e2e": { result: "skipped" },
    "geometry-determinism": { result: "skipped" },
    ...overrides,
  };
}

function classifyThroughCli(files: unknown[], event: { pull_request: { changed_files: number; draft?: unknown; labels?: Array<{ name: string }> } }) {
  const root = mkdtempSync(join(tmpdir(), "maru-ci-policy-"));
  try {
    const filesPath = join(root, "files.json");
    const eventPath = join(root, "event.json");
    writeFileSync(filesPath, JSON.stringify([files]));
    writeFileSync(eventPath, JSON.stringify(event));
    return spawnSync(process.execPath, [policyPath, "classify", filesPath, eventPath], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "", HOME: root, USERPROFILE: root,
        TMPDIR: root, TEMP: root, TMP: root,
        ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("CI sparse-checkout policy", () => {
  it("keeps the trusted policy free of static, dynamic and side-effect relative imports", () => {
    const source = readFileSync(policyPath, "utf8");
    expect(source).not.toMatch(/\bfrom\s*["']\.\.?\//);
    expect(source).not.toMatch(/\bimport\s*\(\s*["']\.\.?\//);
    expect(source).not.toMatch(/\bimport\s*["']\.\.?\//);
  });

  it("runs both decision and aggregate with only the policy file checked out", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "maru-ci-policy-sparse-")));
    try {
      const isolatedPolicy = join(root, "ci-policy.mjs");
      writeFileSync(isolatedPolicy, readFileSync(policyPath, "utf8"));
      const filesPath = join(root, "files.json");
      const eventPath = join(root, "event.json");
      writeFileSync(filesPath, JSON.stringify([[{ filename: "src/lib/diagram/engineSvg.ts" }]]));
      writeFileSync(eventPath, JSON.stringify({ pull_request: { changed_files: 1, labels: [] } }));
      const env = {
        PATH: process.env.PATH ?? "", HOME: root, USERPROFILE: root,
        TMPDIR: root, TEMP: root, TMP: root,
        ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      };
      const decision = spawnSync(process.execPath, [isolatedPolicy, "classify", filesPath, eventPath], {
        cwd: root, encoding: "utf8", env,
      });
      expect(decision.status, decision.stderr).toBe(0);
      expect(JSON.parse(decision.stdout)).toMatchObject({ run_geometry: true, run_native: true });
      const aggregate = spawnSync(process.execPath, [isolatedPolicy, "aggregate"], {
        cwd: root, encoding: "utf8", env: { ...env, CI_NEEDS_JSON: JSON.stringify(needs()) },
      });
      expect(aggregate.status, aggregate.stderr).toBe(0);
      expect(aggregate.stdout).toContain("CI jobs passed with only decision-authorized skips");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("PR change classification", () => {
  it("allows docs-only changes to skip full verify, Playwright, and native compile", () => {
    expect(classifyPrChanges([
      "README.md",
      "CHANGELOG.md",
      "docs/guide/verification.md",
      ".planning/STATE.md",
      ".github/CONTRIBUTING.md",
    ])).toEqual({
      run_full: false,
      run_e2e: false,
      run_native: false,
      run_native_compile: false,
      run_geometry: false,
      macos_deferred: false,
    });
    expect(isDocsOnlyPath("docs/performance/evidence.json")).toBe(false);
    expect(classifyPrChanges(["docs/performance/evidence.json"]).run_full).toBe(true);
  });

  it("selects the SVG matrix for render-only facade and E3 fixture changes", () => {
    for (const file of ["src/lib/diagram/engineSvgForTest.ts", "scripts/diagram-engine-e3-fonts.mjs", "scripts/diagram-engine-e3-screenshots.mjs"]) {
      const decision = classifyPrChanges([file]);
      expect(decision.run_geometry, file).toBe(true);
      expect(decision.run_full, file).toBe(true);
    }
  });

  it("selects both geometry and native gates and the E0 build for every artifact adapter", () => {
    const paths = [
      "src/lib/diagram/engine.ts",
      "src/lib/diagram/engineArtifact.ts",
      "src/lib/diagram/engineCandidate.ts",
      "src/lib/diagram/enginePreflight.ts",
      "src/lib/diagram/engineUnavailable.ts",
      "src/lib/diagram/semanticApply.ts",
      "src/lib/diagram/generation.ts",
      "src/lib/diagram/generationHost.ts",
      "src/lib/diagram/validation.ts",
      "src/lib/diagram/semantic.ts",
      "src/lib/diagram/codecs.ts",
      "src/lib/diagram/reportInsert.ts",
      "src/components/diagram/panels/SemanticProps.tsx",
      "src/lib/diagram/engineArtifactForTest.ts",
      "src/lib/diagram/engineSvg.ts",
      "src/lib/diagram/verifiedExport.ts",
      "src/lib/diagram/export.ts",
      "src/lib/diagram/renders.ts",
      "src/lib/nativeE2eBridge.ts",
    ];
    expect(ENGINE_E3_ARTIFACT_PATHS).toEqual(paths);
    for (const path of paths) {
      const decision = classifyPrChanges([path]);
      expect(decision.run_geometry, path).toBe(true);
      expect(decision.run_native, path).toBe(true);
      expect(decision.run_native_compile, path).toBe(false);
      expect(isE0SelectedPath(path), path).toBe(true);
    }
    expect(classifyPrChanges(["scripts/diagram-engine-e0-paths.mjs"]).run_geometry).toBe(true);
    expect(isE0SelectedPath("scripts/diagram-engine-e0-paths.mjs")).toBe(true);
    expect(isE0SelectedPath("src/lib/diagram/types.ts")).toBe(false);
  });

  it("runs both costly gates when an E0/E3 selection, build or coverage harness changes", () => {
    for (const path of [
      "scripts/diagram-engine-e0.mjs",
      "scripts/diagram-engine-e0-cache.mjs",
      "rust-toolchain.toml",
      "scripts/diagram-engine-e0-paths.mjs",
      "scripts/diagram-engine-e3-integration-coverage.mjs",
    ]) {
      expect(classifyPrChanges([path]), path).toMatchObject({
        run_geometry: true,
        run_native: true,
        run_native_compile: false,
      });
      expect(isE0SelectedPath(path), path).toBe(true);
    }
  });

  it("routes ordinary source changes to verify, Playwright, and native compile", () => {
    expect(classifyPrChanges(["src/components/NewPanel.tsx"])).toEqual({
      run_full: true,
      run_e2e: true,
      run_native: false,
      run_native_compile: true,
      run_geometry: false,
      macos_deferred: false,
    });
  });

  it("routes native paths and the native-e2e label to the full native suite without duplicate compile", () => {
    for (const path of [
      "e2e-native/specs/menu.spec.ts",
      "src-tauri/crates/maru-diagram-engine/src/lib.rs",
      "src-tauri/src/terminal/input.rs",
      "src-tauri/capabilities/main.json",
      "src/components/sites/SitesPane.tsx",
      "src/lib/terminalStore.ts",
      "src-tauri/src/app_menu.rs",
      "src-tauri/src/paths.rs",
      "src-tauri/src/terminal_hooks.rs",
    ]) {
      expect(classifyPrChanges([path]), path).toEqual({
        run_full: true,
        run_e2e: true,
        run_native: true,
        run_native_compile: false,
        run_geometry: path.startsWith("src-tauri/crates/"),
        macos_deferred: false,
      });
    }
    expect(classifyPrChanges(["src/lib/ordinary.ts"], ["Native-E2E"])).toEqual({
      run_full: true,
      run_e2e: true,
      run_native: true,
      run_native_compile: false,
      run_geometry: false,
      macos_deferred: false,
    });
  });

  it("selects deterministic SDK hashes only for engine/workflow paths", () => {
    expect(classifyPrChanges(["src-tauri/crates/maru-diagram-engine/src/metrics/mod.rs"]).run_geometry).toBe(true);
    expect(classifyPrChanges([".github/workflows/diagram-determinism.yml"]).run_geometry).toBe(true);
    expect(classifyPrChanges(["rust-toolchain.toml"]).run_geometry).toBe(true);
    expect(classifyPrChanges(["src/lib/ordinary.ts"]).run_geometry).toBe(false);
    expect(classifyPrChanges(["docs/diagram.md"]).run_geometry).toBe(false);
    expect(evaluateCiJobs(needs({ decision: { result: "success", outputs: { ...decisionOutputs, run_geometry: "true" } }, "geometry-determinism": { result: "failure" } })).ok).toBe(false);
  });

  it("treats deletions as their changed path and renames as both old and new paths through the CLI", () => {
    const deletedDocs = classifyThroughCli(
      [{ filename: "docs/retired-guide.md", status: "removed" }],
      { pull_request: { changed_files: 1 } },
    );
    expect(deletedDocs.status).toBe(0);
    expect(JSON.parse(deletedDocs.stdout)).toEqual({
      run_full: false,
      run_e2e: false,
      run_native: false,
      run_native_compile: false,
      run_geometry: false,
      macos_deferred: false,
    });

    const renamedIntoNative = classifyThroughCli(
      [{ filename: "e2e-native/specs/renamed.spec.ts", previous_filename: "docs/old-test-plan.md", status: "renamed" }],
      { pull_request: { changed_files: 1 } },
    );
    expect(renamedIntoNative.status).toBe(0);
    expect(JSON.parse(renamedIntoNative.stdout)).toEqual({
      run_full: true,
      run_e2e: true,
      run_native: true,
      run_native_compile: false,
      run_geometry: false,
      macos_deferred: false,
    });
  });

  it("fails closed when path lookup is unavailable or the paginated file list is incomplete", () => {
    expect(() => classifyPrChanges(null as unknown as string[])).toThrow("changed paths are unavailable");
    const root = mkdtempSync(join(tmpdir(), "maru-ci-policy-incomplete-"));
    try {
      const filesPath = join(root, "files.json");
      const eventPath = join(root, "event.json");
      writeFileSync(filesPath, JSON.stringify([[{ filename: "README.md" }]]));
      writeFileSync(eventPath, JSON.stringify({ pull_request: { changed_files: 2 } }));
      const result = spawnSync(process.execPath, [policyPath, "classify", filesPath, eventPath], {
        encoding: "utf8",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("changed-file list is incomplete");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("CI job aggregation", () => {
  it("accepts documented skips only when the decision outputs explicitly disable those jobs", () => {
    // A documentation-only PR skips every validation job, including the
    // reusable native workflow; the aggregator accepts exactly that gate.
    expect(evaluateCiJobs(needs())).toEqual({
      ok: true,
      message: "CI jobs passed with only decision-authorized skips",
    });

    const sourceOutputs = {
      run_full: "true",
      run_e2e: "true",
      run_native: "false",
      run_native_compile: "true",
      run_geometry: "false",
      macos_deferred: "false",
    };
    expect(evaluateCiJobs(needs({
      decision: { result: "success", outputs: sourceOutputs },
      verify: { result: "success" },
      e2e: { result: "success" },
      "native-e2e-compile": { result: "success" },
    })).ok).toBe(true);

    const nativeOutputs = { ...sourceOutputs, run_native: "true", run_native_compile: "false" };
    expect(evaluateCiJobs(needs({
      decision: { result: "success", outputs: nativeOutputs },
      verify: { result: "success" },
      e2e: { result: "success" },
      "native-e2e-compile": { result: "skipped" },
      "native-e2e": { result: "success" },
    })).ok).toBe(true);

    for (const result of ["failure", "cancelled", "skipped", undefined]) {
      const nativeState = result === undefined ? undefined : { result };
      const outcome = evaluateCiJobs(needs({
        decision: { result: "success", outputs: nativeOutputs },
        verify: { result: "success" },
        e2e: { result: "success" },
        "native-e2e-compile": { result: "skipped" },
        "native-e2e": nativeState,
      }));
      expect(outcome.ok).toBe(false);
      expect(outcome.message).toContain(`native-e2e concluded ${result ?? "missing"}, inconsistent with decision run_native=true`);
    }
  });

  it("rejects missing/bad needs, unauthorized skips, failed or cancelled required jobs, and missing outputs", () => {
    expect(evaluateCiJobs(null).ok).toBe(false);
    expect(evaluateCiJobs({ decision: { result: "failure", outputs: decisionOutputs } }).message)
      .toContain("CI decision did not succeed");

    for (const [flag, outputs] of [
      ["run_full", { ...decisionOutputs, run_full: undefined }],
      ["run_e2e", { ...decisionOutputs, run_e2e: "sometimes" }],
      ["run_native", { ...decisionOutputs, run_native: undefined }],
      ["run_native_compile", { ...decisionOutputs, run_native_compile: undefined }],
      ["run_geometry", { ...decisionOutputs, run_geometry: undefined }],
      ["macos_deferred", { ...decisionOutputs, macos_deferred: undefined }],
      ["macos_deferred", { ...decisionOutputs, macos_deferred: "draft" }],
    ] as const) {
      const result = evaluateCiJobs(needs({ decision: { result: "success", outputs } }));
      expect(result.ok).toBe(false);
      expect(result.message).toContain(`CI decision output ${flag} is invalid`);
    }

    expect(evaluateCiJobs(needs({
      decision: {
        result: "success",
        outputs: { ...decisionOutputs, run_full: "true" },
      },
      verify: { result: "skipped" },
    })).message).toContain("verify concluded skipped, inconsistent with decision run_full=true");
    for (const [job, result] of [
      ["verify", "failure"],
      ["e2e", "cancelled"],
      ["native-e2e-compile", undefined],
      ["native-e2e", "cancelled"],
      ["geometry-determinism", "cancelled"],
    ] as const) {
      const resultState = result === undefined ? undefined : { result };
      const outcome = evaluateCiJobs(needs({ [job]: resultState }));
      expect(outcome.ok).toBe(false);
      expect(outcome.message).toContain(`${job} concluded ${result ?? "missing"}`);
    }
    expect(evaluateCiJobs(needs({ lint: { result: "skipped" } })).message)
      .toContain("additional CI gate lint did not succeed");
  });
});


describe("geometry intent on main pushes", () => {
  it("uses the PR path policy for docs, code, and renamed SDK paths", () => {
    expect(geometryForPushComparison({ status: "ahead", files: [{ filename: "docs/diagram.md" }] })).toBe(false);
    expect(geometryForPushComparison({ status: "ahead", files: [{ filename: "src/lib/other.ts" }] })).toBe(false);
    expect(geometryForPushComparison({ status: "ahead", files: [{ filename: "src-tauri/crates/core.rs" }] })).toBe(true);
    expect(geometryForPushComparison({ status: "ahead", files: [{ filename: "docs/moved.md", previous_filename: "src-tauri/crates/core.rs" }] })).toBe(true);
    expect(geometryForPushComparison({ status: "identical", files: [] })).toBe(false);
  });
  it("fails closed on API errors, invalid paths, divergent history, and the API cap", () => {
    for (const value of [null, {}, { status: "diverged", files: [] }, { status: "ahead", files: [null] }]) {
      expect(() => geometryForPushComparison(value)).toThrow("keep the geometry gate enabled");
    }
    expect(geometryForPushComparison({ status: "ahead", files: Array.from({ length: 300 }, () => ({ filename: "docs/page.md" })) })).toBe(true);
  });
});

describe("shared browser test bootstrap", () => {
  it("builds ignored engine assets even when a non-engine change skips geometry CI", () => {
    const policy = classifyPrChanges(["src/components/UnrelatedPane.tsx"]);
    expect(policy.run_geometry).toBe(false);
    const config = readFileSync(resolve(process.cwd(), "playwright.config.ts"), "utf8");
    expect(config).toContain("command: `pnpm engine:assets && pnpm exec vite");
  });
});

// maru#625: macOS PR jobs run only on ready PRs.
describe("draft PRs defer macOS jobs", () => {
  const nativePath = "src-tauri/src/terminal/input.rs";
  const compilePath = "src/components/NewPanel.tsx";
  const geometryPath = "src-tauri/crates/maru-diagram-engine/src/lib.rs";

  it("keeps the selection unchanged and marks a draft that would run macOS as deferred", () => {
    for (const path of [nativePath, compilePath, geometryPath]) {
      const ready = classifyPrChanges([path], [], false);
      const draft = classifyPrChanges([path], [], true);
      expect(ready.macos_deferred, path).toBe(false);
      expect(draft.macos_deferred, path).toBe(true);
      const { macos_deferred: _ready, ...readySelection } = ready;
      const { macos_deferred: _draft, ...draftSelection } = draft;
      expect(draftSelection, path).toEqual(readySelection);
    }
  });

  it("counts unknown draft state as ready", () => {
    for (const draft of [undefined, null, "true", 1, {}]) {
      expect(classifyPrChanges([nativePath], [], draft as unknown as boolean).macos_deferred, String(draft)).toBe(false);
    }
  });

  it("lets the native-e2e label override draft, in any case", () => {
    for (const label of ["native-e2e", "Native-E2E"]) {
      expect(classifyPrChanges([nativePath], [label], true)).toMatchObject({ run_native: true, macos_deferred: false });
      expect(classifyPrChanges([compilePath], [label], true)).toMatchObject({ run_native: true, macos_deferred: false });
    }
  });

  it("does not defer a draft that selects no macOS job", () => {
    expect(classifyPrChanges(["docs/guide.md"], [], true).macos_deferred).toBe(false);
  });

  it("reads only a boolean draft flag from the PR event through the CLI", () => {
    const files = [{ filename: nativePath }];
    for (const [draft, deferred] of [[true, true], [false, false], [undefined, false], ["true", false]] as const) {
      const result = classifyThroughCli(files, { pull_request: { changed_files: 1, draft } });
      expect(result.status, String(draft)).toBe(0);
      expect(JSON.parse(result.stdout).macos_deferred, String(draft)).toBe(deferred);
    }
    const labelled = classifyThroughCli(files, { pull_request: { changed_files: 1, draft: true, labels: [{ name: "native-e2e" }] } });
    expect(JSON.parse(labelled.stdout).macos_deferred).toBe(false);
  });

  it("never accepts a deferred plan as success, even when every job that ran passed", () => {
    const deferred = { run_full: "true", run_e2e: "true", run_native: "true", run_native_compile: "false", run_geometry: "true", macos_deferred: "true" };
    const outcome = evaluateCiJobs(needs({
      decision: { result: "success", outputs: deferred },
      verify: { result: "success" },
      e2e: { result: "success" },
      "native-e2e": { result: "skipped" },
      "geometry-determinism": { result: "success" },
    }));
    expect(outcome).toEqual({ ok: false, deferred: true, message: "draft PR; macOS jobs run when the PR is marked ready (gh pr ready)" });

    // A real failure on a deferred draft still reports that failure first.
    const failed = evaluateCiJobs(needs({
      decision: { result: "success", outputs: deferred },
      verify: { result: "failure" },
      e2e: { result: "success" },
      "geometry-determinism": { result: "success" },
    }));
    expect(failed.ok).toBe(false);
    expect(failed.message).toContain("verify concluded failure");

    // The Linux/Windows geometry legs still run on a draft, so skipping the
    // whole geometry workflow is not an authorized deferral.
    const skippedGeometry = evaluateCiJobs(needs({
      decision: { result: "success", outputs: deferred },
      verify: { result: "success" },
      e2e: { result: "success" },
      "geometry-determinism": { result: "skipped" },
    }));
    expect(skippedGeometry.message).toContain("geometry-determinism concluded skipped");
  });

  it("fails the aggregate step with the deferred annotation", () => {
    const deferred = { ...decisionOutputs, run_native: "true", macos_deferred: "true" };
    const result = spawnSync(process.execPath, [policyPath, "aggregate"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", CI_NEEDS_JSON: JSON.stringify(needs({ decision: { result: "success", outputs: deferred } })) },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("::error title=macOS deferred::draft PR; macOS jobs run when the PR is marked ready (gh pr ready)");
  });

  it("wires the deferral through ci.yml and the determinism workflow", () => {
    const ci = readFileSync(resolve(process.cwd(), ".github/workflows/ci.yml"), "utf8");
    expect(ci).toMatch(/types: \[[^\]]*ready_for_review[^\]]*\]/);
    expect(ci).toContain("macos_deferred: ${{ steps.dedupe.outputs.macos_deferred }}");
    expect(ci).toContain("if: needs.decision.outputs.run_native_compile == 'true' && needs.decision.outputs.macos_deferred != 'true'");
    expect(ci).toContain("if: needs.decision.outputs.run_native == 'true' && needs.decision.outputs.macos_deferred != 'true'");
    expect(ci).toContain("macos: ${{ needs.decision.outputs.macos_deferred != 'true' }}");
    // Push and dispatch start undeferred; only the classified PR value is read.
    expect(ci).toMatch(/^ {10}macos_deferred=false$/m);
    expect(ci).toContain('macos_deferred="$PR_MACOS_DEFERRED"');

    const determinism = readFileSync(resolve(process.cwd(), ".github/workflows/diagram-determinism.yml"), "utf8");
    expect(determinism).toMatch(/^ {6}macos:\n {8}type: boolean\n {8}default: true$/m);
    const legs = [...determinism.matchAll(/include: \$\{\{ fromJSON\(inputs\.macos && '(\[.*?\])' \|\| '(\[.*?\])'\) \}\}/g)];
    expect(legs).toHaveLength(2);
    for (const [, withMacos, withoutMacos] of legs) {
      const full = JSON.parse(withMacos).map((leg: { os: string }) => leg.os);
      const deferred = JSON.parse(withoutMacos).map((leg: { os: string }) => leg.os);
      expect(full).toEqual(["ubuntu-22.04", "macos-26", "windows-latest"]);
      expect(deferred).toEqual(["ubuntu-22.04", "windows-latest"]);
    }
    // The comparisons need the macOS receipt, so they wait for a ready run.
    expect(determinism.match(/^ {4}if: inputs\.macos$/gm)).toHaveLength(2);
  });
});

// AC5: neither the main-push dedup nor the release lookup can borrow a
// draft-deferred ci-ok, because both read the run conclusion, and a deferred
// aggregate fails the run.
describe("deferred runs are never reused as success", () => {
  it("main-push dedup reuses only a successful PR run", () => {
    const ci = readFileSync(resolve(process.cwd(), ".github/workflows/ci.yml"), "utf8");
    expect(ci).toContain('if [ "$push_tree" = "$head_tree" ] && [ "$latest_conclusion" = "success" ]; then');
    expect(ci).toContain('if [ "$previous" = "success" ]; then');
  });

  it("the release lookup admits only main/tag or manual runs that concluded success", () => {
    const release = readFileSync(resolve(process.cwd(), "scripts/check-release-workflows.mjs"), "utf8");
    expect(release).toContain('run.event === "push" && (run.head_branch === "main" || run.head_branch === tag)');
    expect(release).toContain('if (run.conclusion !== "success")');
  });
});
