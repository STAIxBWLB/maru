// Shared PR cost/coverage policy for CI and the standalone native workflow.
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
// This file is the sole trusted input in the decision and aggregate sparse checkouts.
export const ENGINE_E3_ARTIFACT_PATHS = Object.freeze([
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
]);

export const NATIVE_PREFIXES = [
  "e2e-native/", "src-tauri/crates/", "src-tauri/src/terminal/", "src-tauri/capabilities/",
  "src-tauri/permissions/", "src/components/sites/", "src/lib/terminal",
];
export const NATIVE_FILES = [
  "src-tauri/src/ipc_policy.rs", "src-tauri/src/channel_delivery.rs", "src-tauri/src/lib.rs",
  "src-tauri/src/main.rs", "src-tauri/src/diagram_engine_e0.rs", "src-tauri/src/app_menu.rs", "src-tauri/src/site_view.rs",
  "src-tauri/src/site_launcher.rs", "src-tauri/src/native_e2e.rs", "src-tauri/src/browser_passkeys.rs",
  "src-tauri/src/paths.rs", "src-tauri/src/terminal_hooks.rs",
  "src-tauri/build.rs", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock",
  "package.json", "pnpm-lock.yaml", "src/App.tsx", "src/lib/menu.ts", "src/lib/windowLayout.ts",
  "src/lib/useDestructiveActionGuard.ts", "src/lib/siteView.ts", ...ENGINE_E3_ARTIFACT_PATHS,
  "src/components/NativeTerminalView.tsx", "src/components/TerminalPanel.tsx",
  "src/components/skills/SkillEditorWindow.tsx", ".github/workflows/ci.yml",
  ".github/workflows/native-e2e.yml", "scripts/ci-policy.mjs",
  "scripts/diagram-engine-e0-paths.mjs", "scripts/diagram-engine-e3-integration-coverage.mjs",
];

export function needsGeometryDeterminism(paths) {
  return paths.some((name) => name.startsWith("src-tauri/crates/")
    || name.startsWith("scripts/diagram-engine-e2")
    || name.startsWith("scripts/diagram-engine-e3")
    || name.startsWith("scripts/diagram-engine-e0")
    || ENGINE_E3_ARTIFACT_PATHS.includes(name)
    || ["rust-toolchain.toml", "src/lib/diagram/engineGeometry.ts", "src/lib/diagram/engineSvgForTest.ts", ".github/workflows/diagram-determinism.yml", ".github/workflows/ci.yml", "scripts/ci-policy.mjs"].includes(name));
}

// Compare responses expose at most 300 files. At the cap, preserve the costly
// gate rather than interpreting an incomplete list as a docs-only push.
export function geometryForPushComparison(comparison) {
  if (!comparison || !["ahead", "identical"].includes(comparison.status)
      || !Array.isArray(comparison.files)
      || comparison.files.some((file) => !file || typeof file.filename !== "string"
        || (file.previous_filename !== undefined && typeof file.previous_filename !== "string"))) {
    throw new Error("Push changed-file comparison is unavailable or incomplete; keep the geometry gate enabled and inspect the compare API result");
  }
  if (comparison.files.length >= 300) return true;
  const paths = comparison.files.flatMap((file) => file.previous_filename ? [file.filename, file.previous_filename] : [file.filename]);
  return needsGeometryDeterminism(paths);
}

export function isDocsOnlyPath(name) {
  // Performance JSON is gate input, even though it lives under docs/.
  if (name.startsWith("docs/performance/") && name.endsWith(".json")) return false;
  return /^[^/]+\.md$/i.test(name) || name.startsWith("docs/") || name.startsWith(".planning/")
    || (name.startsWith(".github/") && name.endsWith(".md"));
}

export function classifyPrChanges(paths, labels = []) {
  if (!Array.isArray(paths) || paths.some((name) => typeof name !== "string")) {
    throw new Error("PR changed paths are unavailable; inspect the changed-file lookup and rerun CI");
  }
  if (!Array.isArray(labels) || labels.some((label) => typeof label !== "string")) {
    throw new Error("PR labels are unavailable; inspect the PR event and rerun CI");
  }
  const docsOnly = paths.length > 0 && paths.every(isDocsOnlyPath);
  const runNative = labels.some((label) => typeof label === "string" && label.toLowerCase() === "native-e2e")
    || paths.some((name) => NATIVE_FILES.includes(name) || NATIVE_PREFIXES.some((prefix) => name.startsWith(prefix)));
  return {
    run_full: !docsOnly,
    run_e2e: !docsOnly,
    run_native: runNative,
    run_native_compile: !docsOnly && !runNative,
    run_geometry: !docsOnly && needsGeometryDeterminism(paths),
  };
}

export function evaluateCiJobs(needs) {
  if (!needs || needs.decision?.result !== "success") {
    return { ok: false, message: "CI decision did not succeed; inspect its logs and rerun CI" };
  }
  const outputs = needs.decision.outputs ?? {};
  for (const flag of ["run_full", "run_e2e", "run_native", "run_native_compile", "run_geometry"]) {
    if (!["true", "false"].includes(outputs[flag])) {
      return { ok: false, message: `CI decision output ${flag} is invalid; inspect the decision and rerun CI` };
    }
  }
  const gates = { verify: "run_full", e2e: "run_e2e", "native-e2e-compile": "run_native_compile", "native-e2e": "run_native", "geometry-determinism": "run_geometry" };
  for (const [job, flag] of Object.entries(gates)) {
    const result = needs[job]?.result;
    if (result === "success" || (result === "skipped" && outputs[flag] === "false")) continue;
    return { ok: false, message: `${job} concluded ${result ?? "missing"}, inconsistent with decision ${flag}=${outputs[flag]}; inspect the job and rerun CI` };
  }
  for (const [job, state] of Object.entries(needs)) {
    if (job !== "decision" && !(job in gates) && state?.result !== "success") {
      return { ok: false, message: `additional CI gate ${job} did not succeed; inspect its result and rerun CI` };
    }
  }
  return { ok: true, message: "CI jobs passed with only decision-authorized skips" };
}

function classifyFiles(filesPath, eventPath) {
  let pages;
  let event;
  try {
    pages = JSON.parse(readFileSync(filesPath, "utf8"));
    event = JSON.parse(readFileSync(eventPath, "utf8"));
  } catch {
    throw new Error("PR file/event inputs could not be read as JSON; inspect the decision lookup and rerun CI");
  }
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new Error("PR changed-file response is invalid; inspect the lookup and rerun CI");
  }
  const files = pages.flat();
  if (!event?.pull_request || !Number.isSafeInteger(event.pull_request.changed_files)
      || !Array.isArray(event.pull_request.labels ?? [])) {
    throw new Error("PR event metadata is invalid; inspect the decision inputs and rerun CI");
  }
  if (files.some((file) => !file || typeof file.filename !== "string"
      || (file.previous_filename !== undefined && typeof file.previous_filename !== "string"))) {
    throw new Error("PR changed-file paths are invalid; inspect the lookup and rerun CI");
  }
  if (files.length !== event.pull_request.changed_files) {
    throw new Error("PR changed-file list is incomplete; inspect the PR diff and rerun CI");
  }
  const paths = files.flatMap((file) => file.previous_filename ? [file.filename, file.previous_filename] : [file.filename]);
  return classifyPrChanges(paths, (event.pull_request.labels ?? []).map((label) => label.name));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv[2] === "classify" && process.argv.length === 5) {
      const decision = classifyFiles(process.argv[3], process.argv[4]);
      console.log(JSON.stringify(decision));
      if (process.env.GITHUB_OUTPUT) {
        try {
          appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(decision).map(([name, value]) => `${name}=${value}\n`).join(""));
        } catch {
          throw new Error("CI intent could not be recorded in GITHUB_OUTPUT; check runner file permissions and rerun CI");
        }
      }
    } else if (process.argv[2] === "geometry-push" && process.argv.length === 4) {
      let comparison;
      try { comparison = JSON.parse(readFileSync(process.argv[3], "utf8")); }
      catch { throw new Error("Push comparison could not be read as JSON; keep the geometry gate enabled and inspect the API response"); }
      console.log(String(geometryForPushComparison(comparison)));
    } else if (process.argv[2] === "aggregate" && process.argv.length === 3) {
      let needs;
      try { needs = JSON.parse(process.env.CI_NEEDS_JSON ?? "null"); }
      catch { throw new Error("CI job results are not valid JSON; inspect ci-ok inputs and rerun CI"); }
      const result = evaluateCiJobs(needs);
      if (!result.ok) throw new Error(result.message);
      console.log(result.message);
    } else throw new Error("usage: ci-policy.mjs classify <files.json> <event.json> or geometry-push <compare.json> or aggregate with CI_NEEDS_JSON; correct inputs and rerun CI");
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : "CI policy failed; inspect the decision and rerun CI"}`);
    process.exitCode = 1;
  }
}
