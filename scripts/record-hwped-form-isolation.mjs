#!/usr/bin/env node
// Record successful form-binding host behavior output; never synthesize test
// outcomes (maru#626). Run the fixed selector on a committed source head, retain
// its complete stdout, then pass --log <file> --source-commit <tested-head>. The
// separate registration manifest is refreshed with check-command-isolation.mjs
// after source is clean.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { maskRust } from "./check-command-isolation.mjs";

export const HWPED_FORM_COMMANDS = ["hwped_discover_forms", "hwped_apply_form_bindings"];
// The worker-boundary case lives in the registered module; the host contract
// cases live beside the worker in hwped/forms/tests.rs.
export const HWPED_FORM_BOUNDARY_CASE = "phase08_21_hwped_each_wrapper_yields_same_poll_and_maps_join_failure";
export const HWPED_FORM_CASES = [
  "capabilities_advertise_form_bindings_only_from_engine_2_0_0",
  "discovery_returns_the_engine_catalogue_and_removes_its_directory",
  "discovery_on_an_older_engine_is_refused_by_version",
  "a_dry_run_returns_receipt_and_preview_without_document_bytes",
  "an_apply_returns_same_format_bytes_and_one_exclusive_host_owned_op",
  "a_refused_plan_is_reported_by_class_without_engine_prose_or_paths",
  "growth_without_reflow_is_refused_before_the_edit_runs",
  "a_cross_format_request_is_refused_before_the_engine_runs",
  "caller_artifact_paths_and_non_literal_values_never_reach_the_engine",
  "a_workspace_document_path_keeps_the_json_edit_containment",
  "artifacts_cross_the_bridge_reduced_to_the_v1_contract",
  "an_oversized_artifact_is_refused_by_size_without_its_path",
  "a_successful_edit_without_its_document_names_the_missing_product",
  "a_plan_or_value_upstream_refuses_is_refused_by_its_path",
];
export const HWPED_FORM_CHECK = "cargo test --manifest-path src-tauri/Cargo.toml --lib hwped -- --test-threads=4";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
function insist(condition, message) { if (!condition) throw new Error(message); }

export function parseHwpedFormBehavior(log) {
  const summaries = [...log.matchAll(/^test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out;/gm)];
  insist(summaries.length === 1, "Expected one complete successful Rust library test result; retain the full hwped check output.");
  const [, passed, failed, ignored, measured] = summaries[0].map(Number);
  // Opt-in real-engine cases are ignored in the hermetic run; the gate counts
  // only passing tests, so they are excluded rather than claimed.
  insist(passed > HWPED_FORM_CASES.length && failed === 0 && measured === 0,
    "hwped form evidence must have passing tests and no failures; repair the check and rerun it.");
  const observed = [...log.matchAll(/^test (hwped::[\w:]+) \.\.\. ok\s*$/gm)].map((match) => match[1]);
  const once = (name) => observed.filter((test) => test === name).length === 1;
  insist(once(`hwped::phase08_21::${HWPED_FORM_BOUNDARY_CASE}`),
    `Missing unique passing worker-boundary case ${HWPED_FORM_BOUNDARY_CASE}; run the fixed hwped selector and retain its complete output.`);
  for (const name of HWPED_FORM_CASES) insist(once(`hwped::forms::tests::${name}`),
    `Missing unique passing behavior case ${name}; run the fixed hwped selector and retain its complete output.`);
  return { passed, failed, ignored: 0, exitCode: 0 };
}

const PATHS = ["src-tauri/src/lib.rs", "src-tauri/src/hwped.rs", "src-tauri/src/hwped/forms.rs",
  "src-tauri/src/hwped/forms/wire.rs", "src-tauri/src/hwped/forms/tests.rs", "src/lib/hwped.ts"];

function row(name, sourceCommit, log, result, root) {
  const discover = name === "hwped_discover_forms";
  const worker = discover ? "discover_now" : "apply_now";
  return {
    name, module: "src-tauri/src/hwped.rs", registrationPath: `src-tauri/src/lib.rs::hwped::${name}`,
    originalDisposition: "ISOLATED", disposition: "ISOLATED",
    helperChain: [
      `src-tauri/src/hwped.rs::${name} owns its request and awaits tauri::async_runtime::spawn_blocking calling src-tauri/src/hwped/forms.rs::${worker}; a JoinError becomes the display-only hwped_task_failed String.`,
      discover
        ? "src-tauri/src/hwped/forms.rs::discover_now gates on agent-hwp >= 2.0.0, stages the source through src-tauri/src/hwped.rs::stage_document (lexical workspace containment) into a private tempdir, and runs the bounded `ahwp slots --forms --occurrences --json` process through src-tauri/src/hwped.rs::run_hwp_feature_ok with the fixed 60s HWP_TIMEOUT."
        : "src-tauri/src/hwped/forms.rs::apply_now refuses cross-format and malformed requests before the engine runs, stages the source through src-tauri/src/hwped.rs::stage_document, runs discovery for the reflow preflight, writes one exclusive apply_form_bindings op with host-made receipt and preview paths into the private tempdir, and runs the bounded `ahwp edit --verify [--dry-run]` through src-tauri/src/hwped.rs::run_hwp_feature_ok.",
    ],
    workerBoundary: `src-tauri/src/hwped.rs::${name} awaits tauri::async_runtime::spawn_blocking before any filesystem access or process wait runs; owned values cross the await and every domain error String passes through unchanged.`,
    syncCallers: [`No Rust or CLI caller invokes ${name} synchronously; src-tauri/src/hwped/forms.rs::${worker} stays private behind the spawn_blocking boundary.`],
    mutationKey: {
      readOnly: true, lexicalPaths: [], aliasPaths: [],
      sharedAdmissionEntry: `${name} performs no filesystem mutation outside its private per-call tempdir: src-tauri/src/hwped/forms.rs::${worker} reads a workspace source in place and returns ${discover ? "the discovery JSON" : "receipt, preview and (on apply) document bytes"} over IPC, so no workspace mutation admission is required.`,
      postAdmissionPreconditions: ["No mutation admission is required: the command performs no workspace filesystem mutation, so there is no transaction key to admit and nothing to release."],
      domainLockOrder: "No path admission exists; the command takes no domain lock, so there is no admission-before-domain-lock order to record.",
    },
    tests: [{ command: HWPED_FORM_CHECK, ...result }],
    processingCaller: {
      path: ["src/lib/hwped.ts"],
      payload: `src/lib/hwped.ts builds the @hwp-editor/core Tauri engine, whose ${discover ? "discoverForms" : "applyFormBindings"} invokes ${name} only after hwped_capabilities advertises formBindings v1.`,
      terminalNoticeOwner: "The hwp-editor Form panel inside the hwped editor surface owns preview, apply and refusal display for its document.",
      classifier: "The client maps hwped_bad_request, hwp_version and hwp_failed prefixes to bad_request, version and failed; engine refusals surface as engine_refused without engine prose.",
      successRetention: discover ? "The panel keeps the discovery until the source changes." : "A dry run keeps the reviewed preview; an apply becomes one undoable editor transition.",
      failureReasons: "The document and pending preview are unchanged on failure; the panel shows the cause and next step.",
      singleTerminalNoticeOwner: true,
    },
    evidence: {
      behaviorCases: [HWPED_FORM_BOUNDARY_CASE],
      // Named outside a `*Cases` key: the gate resolves those against the
      // registered module only, and these live in hwped/forms/tests.rs.
      contractTests: HWPED_FORM_CASES.map((test) => `src-tauri/src/hwped/forms/tests.rs::${test}`),
      workerProof: `hwped::phase08_21::${HWPED_FORM_BOUNDARY_CASE} holds the ${name} future at spawn_blocking worker entry through the test-only worker-stage hook, polls it on the same task while a distinct worker thread stays blocked, and maps the panicked worker to hwped_task_failed.`,
      platformScope: "Fake agent-hwp shell engines and disposable tempdirs only; the opt-in released_engine_discovers_previews_applies_and_refuses_a_stale_plan case runs the real engine and is not part of this hermetic record. No native WebView acceptance is claimed.",
      limits: "Containment covers the source path and the host-made artifact paths. Discovery, receipt and preview cross the bridge only after the ported upstream parsers (src-tauri/src/hwped/forms/wire.rs), checked against outputs recorded from hwp-editor's own functions; engine-side plan semantics are the engine's own contract.",
      sourceCommit, logSha256: sha256(log),
      sourceFiles: PATHS.map((path) => ({ path, sha256: sha256(readFileSync(resolve(root, path))) })),
    },
  };
}

export function recordHwpedFormIsolation(root, logFile, sourceCommit) {
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  insist(/^[a-f0-9]{40}$/.test(sourceCommit) && git("rev-parse", "HEAD") === sourceCommit,
    "The tested source commit must equal current HEAD; commit the intended source and run the fixed selector before recording.");
  for (const path of PATHS) git("ls-files", "--error-unmatch", "--", path);
  insist(!git("status", "--porcelain", "--untracked-files=all", "--", ...PATHS),
    "Behavior source changed after the tested commit; commit and rerun the fixed selector before recording.");
  const log = readFileSync(logFile, "utf8");
  const result = parseHwpedFormBehavior(log);
  const source = maskRust(readFileSync(resolve(root, "src-tauri/src/hwped.rs"), "utf8"));
  insist(new RegExp(`\\bfn\\s+${HWPED_FORM_BOUNDARY_CASE}\\s*\\(`).test(source),
    "The worker-boundary case is absent from the registered command module; repair the source/evidence mismatch.");
  const load = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
  const save = (path, value) => writeFileSync(resolve(root, path), `${JSON.stringify(value, null, 2)}\n`);
  const changes = load("docs/performance/phase08-registration-changes.json");
  const shard = load("docs/performance/phase08-21.json");
  for (const name of HWPED_FORM_COMMANDS) {
    const addition = { name, owner: "08-21", module: "src-tauri/src/hwped.rs", originalDisposition: "ISOLATED",
      reason: "Issue #626: source-bound form binding through agent-hwp 2.0.0 in an awaited blocking worker with host-owned per-call artifacts." };
    const existing = changes.additions.findIndex((entry) => entry.name === name);
    if (existing >= 0) changes.additions[existing] = addition;
    else changes.additions.push(addition);
    const entry = row(name, sourceCommit, log, result, root);
    const index = shard.commands.findIndex((command) => command.name === name);
    if (index >= 0) shard.commands[index] = entry;
    else shard.commands.push(entry);
  }
  const overlay = load("docs/performance/phase08-29-integration.json");
  overlay.commandCount = changes.baselineCount + changes.additions.length;
  save("docs/performance/phase08-registration-changes.json", changes);
  save("docs/performance/phase08-21.json", shard);
  save("docs/performance/phase08-29-integration.json", overlay);
  return { sourceCommit, passed: result.passed, logSha256: sha256(log) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    insist(args.length === 4 && args[0] === "--log" && args[2] === "--source-commit",
      "Usage: node scripts/record-hwped-form-isolation.mjs --log <complete-passing-log> --source-commit <tested-head>");
    console.log(JSON.stringify(recordHwpedFormIsolation(process.cwd(), args[1], args[3])));
  } catch (error) {
    console.error(`hwped-form-evidence: ${error.message}`);
    process.exitCode = 1;
  }
}
