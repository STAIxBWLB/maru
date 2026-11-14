#!/usr/bin/env node
// Record actual fixed-selector output from the same clean committed source.
// This does not run tests, invent behavior outcomes, or refresh the source manifest.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { maskRust } from "./check-command-isolation.mjs";

export const TASK_COMPLETION_CASES = [
  "task_completion_isolation_actual_wrapper_yields_and_maps_worker_failure",
  "task_completion_isolation_policy_serializes_aliases_rechecks_and_releases",
  "task_completion_isolation_unknown_and_forged_actions_are_refused_by_ipc",
  "task_completion_isolation_command_requires_main_webview_and_window",
];
export const TASK_COMPLETION_CHECK = "cargo test --manifest-path src-tauri/Cargo.toml --lib task_completion_isolation -- --test-threads=2";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
function insist(condition, message) { if (!condition) throw new Error(message); }
export function parseTaskCompletionBehavior(log) {
  const summaries = [...log.matchAll(/^test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out;/gm)];
  insist(summaries.length === 1, "Keep one complete successful fixed-selector Rust library output; rerun task_completion_isolation and retain its full log.");
  const [, passed, failed, ignored, measured] = summaries[0].map(Number);
  insist(passed === TASK_COMPLETION_CASES.length && failed === 0 && ignored === 0 && measured === 0,
    "Completion isolation evidence needs exactly four passing, non-ignored cases; repair and rerun the fixed selector.");
  const observed = [...log.matchAll(/^test task_completion::phase08_09_completion::(\w+) \.\.\. ok\s*$/gm)].map((match) => match[1]);
  for (const name of TASK_COMPLETION_CASES) insist(observed.filter((test) => test === name).length === 1,
    `Missing unique passing completion case ${name}; rerun the fixed selector and retain its complete output.`);
  return { passed, failed, ignored, exitCode: 0 };
}

export function recordTaskCompletionIsolation(root, logFile, sourceCommit) {
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  insist(/^[a-f0-9]{40}$/.test(sourceCommit) && git("rev-parse", "HEAD") === sourceCommit,
    "The tested commit must equal HEAD; commit the intended source and rerun the selector before recording.");
  const paths = [
    "src-tauri/src/lib.rs", "src-tauri/src/task_completion.rs", "src-tauri/src/task_completion_isolation_tests.rs",
    "src-tauri/src/task_execution_claims.rs", "src-tauri/src/task_execution_runtime.rs", "src-tauri/src/tasks.rs",
    "src-tauri/src/agent_host/proposal.rs", "src-tauri/src/agent_host/protected_write.rs", "src-tauri/src/agent_host/event_store.rs",
    "src-tauri/src/document.rs", "src-tauri/src/drafts.rs", "src-tauri/src/today_lifecycle.rs",
    "src-tauri/src/atomic_file.rs", "src-tauri/src/approval.rs", "src-tauri/src/ai_router.rs",
    "src/lib/taskCompletion.ts", "src/components/tasks/TaskCompletionSection.tsx",
    "scripts/record-task-completion-isolation.mjs", "scripts/check-command-isolation.mjs",
  ];
  for (const path of paths) git("ls-files", "--error-unmatch", "--", path);
  insist(!git("status", "--porcelain", "--untracked-files=all", "--", ...paths),
    "Completion source changed after the tested commit; commit and rerun the selector before recording.");
  const log = readFileSync(logFile, "utf8");
  const result = parseTaskCompletionBehavior(log);
  const source = maskRust(readFileSync(resolve(root, "src-tauri/src/task_completion.rs"), "utf8"));
  for (const name of TASK_COMPLETION_CASES) insist(new RegExp(`\\bfn\\s+${name}\\s*\\(`).test(source),
    `Named behavior case ${name} is missing from the command module; reconcile the source and rerun tests.`);
  const load = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
  const save = (path, value) => writeFileSync(resolve(root, path), `${JSON.stringify(value, null, 2)}\n`);
  const changes = load("docs/performance/phase08-registration-changes.json");
  const addition = { name: "task_completion", owner: "08-09", module: "src-tauri/src/task_completion.rs", originalDisposition: "ISOLATED",
    reason: "Issue #429: main-window-only completion policy, reviewed evidence and fresh acceptance run in an awaited worker with revision-bound shared admission." };
  const existing = changes.additions.findIndex((entry) => entry.name === addition.name);
  if (existing >= 0) changes.additions[existing] = addition;
  else changes.additions.push(addition);
  const shard = load("docs/performance/phase08-09.json");
  const row = {
    name: "task_completion", module: "src-tauri/src/task_completion.rs", registrationPath: "src-tauri/src/lib.rs::task_completion::task_completion",
    originalDisposition: "ISOLATED", disposition: "ISOLATED",
    helperChain: [
      "src-tauri/src/task_completion.rs::task_completion checks both native main identities, owns request payloads and awaits spawn_blocking before filesystem, revision, claim and receipt work.",
      "src-tauri/src/task_completion.rs::set_policy reserves the task, completion records, versions and workspace registry; src-tauri/src/task_completion.rs::with_context bounds claim/run/receipt identity and protected mutations; src-tauri/src/task_completion.rs::finalize consumes fresh approval and revision-bound evidence before managed publication.",
    ],
    workerBoundary: "src-tauri/src/task_completion.rs::task_completion awaits tauri::async_runtime::spawn_blocking; its main-webview/main-window check precedes the worker without filesystem or lock work. Inner structured IpcError survives; JoinError gains cause and retry guidance.",
    syncCallers: ["src-tauri/src/task_completion.rs::view supports backend readback; src-tauri/src/task_completion.rs::set_policy is invoked only by the main-window command and hermetic fixtures. Agent completion routes do not set policy or perform final person acceptance."],
    mutationKey: {
      readOnly: false,
      lexicalPaths: ["task Markdown note", "workspace .maru/task-completion records", "task claim and execution records", "workspace .maru/versions", "workspace registry and legacy input"],
      aliasPaths: ["Shared PathTransactionRequest resolves lexical and physical aliases with parent reservations; task execution claim generations retain their existing OS lock."],
      sharedAdmissionEntry: "src-tauri/src/task_completion.rs::set_policy and src-tauri/src/task_completion.rs::with_context use src-tauri/src/atomic_file.rs::PathTransactionRequest and with_path_transactions, reserve all task/completion/claim/version destinations and include workspace registry before managed effects.",
      postAdmissionPreconditions: ["Claim generation, task source revision and workspace policy are rechecked inside admission; receipt/artifact digests and reviewer run identity bind the acceptance.", "Fresh person approval and final file revisions are rechecked before frontmatter publication through the existing managed writer."],
      domainLockOrder: "Task claim OS guard is acquired before shared path admission consistently with existing execution writers; registry/domain mutation locks and effects follow the complete admission. No new lock order is claimed.",
    },
    tests: [{ command: TASK_COMPLETION_CHECK, ...result }],
    processingCaller: {
      path: ["src/lib/taskCompletion.ts", "src/components/tasks/TaskCompletionSection.tsx"],
      payload: "Typed completion actions carry task source, token, review binding and approval revisions, never caller-authoritative reviewer identity.",
      terminalNoticeOwner: "TaskCompletionSection owns the command result and refresh/error display for the selected task.",
      classifier: "normalizeIpcError preserves known document_conflict for refresh/review recovery; unknown/forged codes degrade to plain failure.",
      successRetention: "The section refreshes current evidence after fulfilled commands; review launch does not finalize a task.",
      failureReasons: "Refusal leaves current task/evidence intact and names the cause plus next app action.",
      singleTerminalNoticeOwner: true,
    },
    evidence: {
      behaviorCases: TASK_COMPLETION_CASES,
      workerProof: "Actual command same-task polling observes a distinct held worker, continued caller progress and mapped worker panic. Actual policy command waits on a competing alias writer, rejects stale revision, then releases admission. IPC refuses unknown actions and forged authority fields. Main identity checks are exercised on main, Sites, local child and a main-labelled child inside another window.",
      platformScope: "Disposable workspace/home fixtures and Tauri MockRuntime only. This is not native WebView, provider/live execution, Korean IME or release acceptance evidence.",
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
  save("docs/performance/phase08-09.json", shard);
  save("docs/performance/phase08-29-integration.json", overlay);
  return { sourceCommit, passed: result.passed, logSha256: row.evidence.logSha256 };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    insist(args.length === 4 && args[0] === "--log" && args[2] === "--source-commit",
      "Usage: node scripts/record-task-completion-isolation.mjs --log <complete-passing-log> --source-commit <tested-head>");
    console.log(JSON.stringify(recordTaskCompletionIsolation(process.cwd(), args[1], args[3])));
  } catch (error) {
    console.error(`task-completion-evidence: ${error.message}`);
    process.exitCode = 1;
  }
}
