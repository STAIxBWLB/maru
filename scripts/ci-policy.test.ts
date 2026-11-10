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

function classifyThroughCli(files: unknown[], event: { pull_request: { changed_files: number; labels?: Array<{ name: string }> } }) {
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
      });
    }
    expect(classifyPrChanges(["src/lib/ordinary.ts"], ["Native-E2E"])).toEqual({
      run_full: true,
      run_e2e: true,
      run_native: true,
      run_native_compile: false,
      run_geometry: false,
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
