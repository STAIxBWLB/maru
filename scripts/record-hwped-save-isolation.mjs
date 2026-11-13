#!/usr/bin/env node
// Record successful hwped_save behavior output; never synthesize test outcomes.
// Run the fixed selector on a committed source head, retain its complete stdout,
// then pass --log <file> --source-commit <tested-head>. The separate registration
// manifest is refreshed with check-command-isolation.mjs after source is clean.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { maskRust } from "./check-command-isolation.mjs";

export const HWPED_SAVE_CASES = [
  "phase08_21_hwped_save_yields_same_poll_and_maps_join_failure",
  "phase08_21_hwped_save_serializes_aliases_and_releases_failed_admission",
  "phase08_21_hwped_save_persists_exact_snapshot_and_conflicts",
];
export const HWPED_SAVE_CHECK = "cargo test --manifest-path src-tauri/Cargo.toml --lib hwped_save -- --test-threads=2";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
function insist(condition, message) { if (!condition) throw new Error(message); }

export function parseHwpedSaveBehavior(log) {
  const summaries = [...log.matchAll(/^test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out;/gm)];
  insist(summaries.length === 1, "Expected one complete successful Rust library test result; retain the full hwped_save check output.");
  const [, passed, failed, ignored, measured] = summaries[0].map(Number);
  insist(passed >= HWPED_SAVE_CASES.length && failed === 0 && ignored === 0 && measured === 0,
    "hwped_save behavioral evidence must have passing, non-ignored tests only; repair the check and rerun it.");
  const observed = [...log.matchAll(/^test (hwped::phase08_21::\w+) \.\.\. ok\s*$/gm)].map((match) => match[1]);
  for (const name of HWPED_SAVE_CASES) insist(observed.filter((test) => test === `hwped::phase08_21::${name}`).length === 1,
    `Missing unique passing behavior case ${name}; run the fixed hwped_save selector and retain its complete output.`);
  return { passed, failed, ignored, exitCode: 0 };
}

export function recordHwpedSaveIsolation(root, logFile, sourceCommit) {
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  insist(/^[a-f0-9]{40}$/.test(sourceCommit) && git("rev-parse", "HEAD") === sourceCommit,
    "The tested source commit must equal current HEAD; commit the intended source and run the fixed selector before recording.");
  const paths = ["src-tauri/src/lib.rs", "src-tauri/src/hwped.rs", "src-tauri/src/hwped/persistence.rs",
    "src-tauri/src/hwped/persistence/tests.rs", "src-tauri/src/atomic_file.rs", "src-tauri/src/vault_list.rs", "src/lib/hwpedPersistence.ts",
    "src/components/binaryViewers/HwpxEditorPane.tsx"];
  for (const path of paths) git("ls-files", "--error-unmatch", "--", path);
  insist(!git("status", "--porcelain", "--untracked-files=all", "--", ...paths),
    "Behavior source changed after the tested commit; commit and rerun the fixed selector before recording.");
  const log = readFileSync(logFile, "utf8");
  const result = parseHwpedSaveBehavior(log);
  const source = maskRust(readFileSync(resolve(root, "src-tauri/src/hwped.rs"), "utf8"));
  for (const name of HWPED_SAVE_CASES) insist(new RegExp(`\\bfn\\s+${name}\\s*\\(`).test(source),
    `Behavior case ${name} is absent from the registered command module; repair the source/evidence mismatch.`);
  const load = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
  const save = (path, value) => writeFileSync(resolve(root, path), `${JSON.stringify(value, null, 2)}\n`);
  const changes = load("docs/performance/phase08-registration-changes.json");
  const addition = { name: "hwped_save", owner: "08-21", module: "src-tauri/src/hwped.rs", originalDisposition: "ISOLATED",
    reason: "Issue #610: revision-checked HWPX overwrite with byte-exact recovery snapshots and shared lexical/physical path admission inside an awaited blocking worker." };
  const existing = changes.additions.findIndex((entry) => entry.name === addition.name);
  if (existing >= 0) changes.additions[existing] = addition;
  else changes.additions.push(addition);
  const shard = load("docs/performance/phase08-21.json");
  const row = {
    name: "hwped_save", module: "src-tauri/src/hwped.rs", registrationPath: "src-tauri/src/lib.rs::hwped::hwped_save",
    originalDisposition: "ISOLATED", disposition: "ISOLATED",
    helperChain: [
      "src-tauri/src/hwped.rs::hwped_save owns the request and awaits spawn_blocking calling src-tauri/src/hwped/persistence.rs::save_now; worker join failure becomes a display-only IpcError.",
      "src-tauri/src/hwped/persistence.rs::save_now delegates to src-tauri/src/hwped/persistence.rs::save_with_engine, which bounds both byte buffers, validates the privately staged candidate with the selected engine, snapshots the exact original and replaces through src-tauri/src/atomic_file.rs::write_atomic_checked only after final path, owner, policy and revision checks.",
    ],
    workerBoundary: "src-tauri/src/hwped.rs::hwped_save awaits tauri::async_runtime::spawn_blocking before filesystem access, registry checks, admission waits or engine subprocess work; owned Strings cross the await and structured inner document_conflict errors pass through unchanged.",
    syncCallers: ["No production synchronous caller invokes hwped_save; src-tauri/src/hwped/persistence.rs::save_now remains private to the worker and focused fixture tests."],
    mutationKey: {
      readOnly: false,
      lexicalPaths: ["selected workspace .hwpx", ".maru/versions and the generated recovery snapshot", "current workspace registry output and legacy registry input, always reserved even after migration"],
      aliasPaths: ["PathTransactionRequest reserves lexical and physical file/ancestor aliases while authorization remains lexical; replacement follows the existing physical destination without replacing its symlink entry."],
      sharedAdmissionEntry: "src-tauri/src/hwped/persistence.rs::save_with_engine reserves the target, versions and both paths from src-tauri/src/vault_list.rs::workspace_registry_path and src-tauri/src/vault_list.rs::legacy_vault_list_path through src-tauri/src/atomic_file.rs::PathTransactionRequest with with_workspace_registry and require_parent before any workspace effect.",
      postAdmissionPreconditions: ["Registry lease, owner/write policy and full path coverage are checked inside admission; before_effect precedes any legacy migration.", "Final revalidate_paths, before_effect, owner/policy and expected revision run after candidate sync and immediately before replacement."],
      domainLockOrder: "Complete shared path admission happens before any domain lock or workspace write; the lease spans validation, snapshots, replacement and failure cleanup.",
    },
    tests: [{ command: HWPED_SAVE_CHECK, ...result }],
    processingCaller: {
      path: ["src/lib/hwpedPersistence.ts", "src/components/binaryViewers/HwpxEditorPane.tsx"],
      payload: "saveHwpedDocument sends selected workspace path, applied bytes and the original expected revision; the host pane captures its session generation and persists only on fulfilled save.",
      terminalNoticeOwner: "HwpxEditorPane owns Saved, conflict and failure status for the originating session.",
      classifier: "Known document_conflict enters explicit keep-editing/reload recovery; unknown IPC codes normalize to a plain Error.",
      successRetention: "Only the captured session baseline advances to the returned revision; preview metadata refresh follows success.",
      failureReasons: "Edits and persisted baseline remain on failed save; the pane displays cause and retry/reload guidance.",
      singleTerminalNoticeOwner: true,
    },
    evidence: {
      behaviorCases: HWPED_SAVE_CASES,
      workerProof: "Actual-wrapper same-task polling proves off-thread progress and join-failure propagation. Competing alias saves and failed admission prove serialization and release; the original snapshot and stale/missing conflicts are checked on fixture files. src-tauri/src/hwped/persistence/tests.rs::hwped_save_holds_existing_registry_lease_and_observes_new_policy also proves existing-registry writer exclusion and post-admission policy refusal.",
      platformScope: "Disposable fixture workspaces and fake engine processes only; these Rust checks do not establish native WebView, Korean IME or production acceptance.",
      limits: "Admission serializes cooperating same-process writers. An external non-cooperating writer can still race the final revision check and rename; no cross-process compare-and-swap is claimed.",
      sourceCommit, logSha256: sha256(log),
      sourceFiles: paths.map((path) => ({ path, sha256: sha256(readFileSync(resolve(root, path))) })),
    },
  };
  const index = shard.commands.findIndex((entry) => entry.name === row.name);
  if (index >= 0) shard.commands[index] = row;
  else shard.commands.push(row);
  const overlay = load("docs/performance/phase08-29-integration.json");
  overlay.commandCount = changes.baselineCount + changes.additions.length;
  save("docs/performance/phase08-registration-changes.json", changes);
  save("docs/performance/phase08-21.json", shard);
  save("docs/performance/phase08-29-integration.json", overlay);
  return { sourceCommit, passed: result.passed, logSha256: row.evidence.logSha256 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    insist(args.length === 4 && args[0] === "--log" && args[2] === "--source-commit",
      "Usage: node scripts/record-hwped-save-isolation.mjs --log <complete-passing-log> --source-commit <tested-head>");
    console.log(JSON.stringify(recordHwpedSaveIsolation(process.cwd(), args[1], args[3])));
  } catch (error) {
    console.error(`hwped-save-evidence: ${error.message}`);
    process.exitCode = 1;
  }
}
