import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { maskRust, parseArgs } from "./check-command-isolation.mjs";

const CHECKER = fileURLToPath(new URL("./check-command-isolation.mjs", import.meta.url));
const PHASE = ".planning/phases/08-main-thread-responsiveness";
const MOD = "src-tauri/src/model.rs";
const integrationModules = ["skill_host/store", "skill_host/env", "skill_host/dispatch", "git", "dot_sync", "mission_state", "agent_host/event_store"];
function fixture(t, specs = [{ name: "sample", plan: "06", module: MOD }]) {
  const root = mkdtempSync(join(tmpdir(), "maru-command-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value, null, 2)); };
  const grouped = Map.groupBy(specs, (spec) => spec.module);
  for (const [module, entries] of grouped) {
    write(module, entries.map(({ name, disposition = "CONVERT" }) => `
#[tauri::command]
pub ${disposition === "CONVERT" ? "async " : ""}fn ${name}() -> u32 {
  ${disposition === "CONVERT" ? `tauri::async_runtime::spawn_blocking(move || ${name}_blocking()).await.unwrap()` : "1"}
}
fn ${name}_blocking() -> u32 { std::fs::read("synthetic").unwrap().len() as u32 }
#[cfg(test)]
mod tests_${name} {
  #[test]
  fn ${name}_behavior() { assert_eq!(super::${name}_blocking(), 1); }
}
`).join("\n"));
  }
  const pathOf = ({ module, name }) => module.replace(/^src-tauri\/src\//, "").replace(/\/mod\.rs$|\.rs$/, "").replaceAll("/", "::") + "::" + name;
  write("src-tauri/src/lib.rs", `fn run() { tauri::generate_handler![${specs.map(pathOf).join(",")}]; }`);
  write(`${PHASE}/08-COMMAND-INVENTORY.md`, specs.map(({ name, module, disposition = "CONVERT" }) => `| \`${name}\` | \`${module}:1\` | sync | **${disposition}**: research |`).join("\n"));
  write(`${PHASE}/08-PLAN-MAP.md`, specs.map(({ plan, module, name }) => `| 08-${plan} | \`${module}\` | \`${name}\` |`).join("\n"));
  const shards = new Map();
  for (const spec of specs) {
    const { name, module, plan, disposition = "CONVERT" } = spec;
    if (!shards.has(plan)) shards.set(plan, { plan: `08-${plan}`, moduleIntegrationOwner: `08-${plan}`, commands: [] });
    const row = {
      name, module, registrationPath: `src-tauri/src/lib.rs::${pathOf(spec)}`, originalDisposition: disposition,
      disposition: disposition === "CONVERT" ? "ISOLATED" : disposition,
      helperChain: [`${module}::${name} -> ${name}_blocking; inspected finite I/O path`, `${module}::${name}_blocking uses std::fs::read in the worker`],
      workerBoundary: disposition === "CONVERT" ? `${module}::${name} -> tauri::async_runtime::spawn_blocking awaited owned worker` : "UI platform main-thread dispatch or pure bounded model with fixed one item",
      syncCallers: [`${module}::${name}_blocking remains available to synchronous domain tests`],
      mutationKey: "read-only; no mutation",
      tests: [{ command: `cargo test --manifest-path src-tauri/Cargo.toml --lib ${name}_behavior`, passed: 1, failed: 0, ignored: 0 }],
      processingCaller: { path: "src/lib/model.ts::invoke", payload: "Real returned result, classified success and retained errors", terminalNoticeOwner: "model action store", classifier: "Classify fulfilled domain success/failure", successRetention: "Retain successful sibling data", failureReasons: "Expose actionable reason from domain payload", singleTerminalNoticeOwner: true },
      evidence: { behaviorCases: [`tests_${name}::${name}_behavior`], bounds: "Fixed one-item model bound or finite worker I/O" },
    };
    shards.get(plan).commands.push(row);
  }
  write("src/lib/model.ts", "export const invoke = () => 1;\n");
  const save = () => { for (const [plan, shard] of shards) write(`docs/performance/phase08-${plan}.json`, shard); };
  save();
  return { root, write, specs, shards, save, row: shards.values().next().value.commands[0], read: (path) => readFileSync(join(root, path), "utf8"), run: (...args) => spawnSync(process.execPath, [CHECKER, ...args, "--expected-count", String(specs.length)], { cwd: root, encoding: "utf8" }) };
}
function pass(result) { assert.equal(result.status, 0, result.stderr || result.stdout); assert.match(result.stdout, /PASS/); }
function fail(result, reason) { assert.notEqual(result.status, 0, result.stdout); assert.match(result.stderr, reason); }

test("valid isolated command resolves physical worker, helper and behavior case", (t) => { const f = fixture(t); pass(f.run("--plan", "06")); });
test("valid bounded model and UI dispositions pass", (t) => {
  const f = fixture(t, [{ name: "pure", plan: "06", module: MOD, disposition: "RETAIN" }, { name: "ui", plan: "06", module: MOD, disposition: "UI" }]);
  pass(f.run("--plan", "06"));
});
test("missing exact assigned command fails", (t) => { const f = fixture(t); f.shards.get("06").commands = []; f.save(); fail(f.run("--plan", "06"), /missing\/extra/); });
test("duplicate command row fails even with the same row count", (t) => {
  const f = fixture(t, [{ name: "a", plan: "06", module: MOD }, { name: "b", plan: "06", module: MOD }]);
  f.shards.get("06").commands[1] = structuredClone(f.row); f.save(); fail(f.run("--plan", "06"), /Duplicate evidence/);
});
test("unknown command row fails", (t) => { const f = fixture(t); f.row.name = "invented"; f.save(); fail(f.run("--plan", "06"), /unknown\/unowned/); });
test("wrong exclusive owner fails", (t) => { const f = fixture(t); f.row.module = "src-tauri/src/other.rs"; f.save(); fail(f.run("--plan", "06"), /wrong exclusive owner/); });
test("AUDIT cannot pass final disposition", (t) => { const f = fixture(t); f.row.disposition = "AUDIT"; f.save(); fail(f.run("--plan", "06"), /AUDIT/); });
test("CONVERT cannot be relabeled as bounded", (t) => { const f = fixture(t); f.row.disposition = "RETAIN"; f.save(); fail(f.run("--plan", "06"), /CONVERT requires/); });
test("empty evidence fails", (t) => { const f = fixture(t); f.row.evidence = {}; f.save(); fail(f.run("--plan", "06"), /empty evidence/); });
test("missing physical helper path fails", (t) => { const f = fixture(t); f.row.helperChain.push("src-tauri/src/missing.rs::helper"); f.save(); fail(f.run("--plan", "06"), /Missing source\/helper path/); });
test("missing physical helper symbol fails", (t) => { const f = fixture(t); f.row.helperChain.push(`${MOD}::ghost`); f.save(); fail(f.run("--plan", "06"), /missing physical symbol/); });
test("comment-only helper symbol does not count", (t) => { const f = fixture(t); f.write(MOD, f.read(MOD) + "\n// fn ghost() {}\n"); f.row.helperChain.push(`${MOD}::ghost`); f.save(); fail(f.run("--plan", "06"), /missing physical symbol/); });
test("stale registration path fails", (t) => { const f = fixture(t); f.row.registrationPath += "_old"; f.save(); fail(f.run("--plan", "06"), /stale registrationPath/); });
test("changed original disposition fails", (t) => { const f = fixture(t); f.row.originalDisposition = "AUDIT"; f.save(); fail(f.run("--plan", "06"), /changed original disposition/); });
test("command(async) attribute on synchronous blocking body fails", (t) => {
  const f = fixture(t); f.write(MOD, f.read(MOD).replace("#[tauri::command]", "#[tauri::command(async)]").replace("pub async fn sample", "pub fn sample"));
  fail(f.run("--plan", "06"), /blocking command\(async\)\/sync registration/);
});
test("spawn_blocking mentioned in a string is not a boundary", (t) => {
  const f = fixture(t); f.write(MOD, f.read(MOD).replace("tauri::async_runtime::spawn_blocking(move || sample_blocking()).await.unwrap()", 'let note = "spawn_blocking().await"; sample_blocking()'));
  fail(f.run("--plan", "06"), /missing actual spawn_blocking/);
});
test("worker must be awaited before command completion", (t) => { const f = fixture(t); f.write(MOD, f.read(MOD).replace(".await.unwrap()", ".unwrap()")); fail(f.run("--plan", "06"), /await completion/); });
test("omitted indirect helper in isolated evidence fails", (t) => { const f = fixture(t); f.row.helperChain = [`${MOD}::sample worker boundary reviewed`]; f.save(); fail(f.run("--plan", "06"), /omitted indirect helper/); });
test("omitted indirect blocking helper behind RETAIN fails", (t) => {
  const f = fixture(t, [{ name: "sample", plan: "06", module: MOD, disposition: "RETAIN" }]);
  f.write(MOD, f.read(MOD).replace("-> u32 {\n  1", "-> u32 {\n  middle()") + "\nfn middle() -> u32 { sample_blocking() }\n");
  f.row.helperChain = [`${MOD}::sample bounded model entry`]; f.save(); fail(f.run("--plan", "06"), /blocking operation in retained\/UI helper chain/);
});
test("UI requires positive affinity evidence", (t) => { const f = fixture(t, [{ name: "ui", plan: "06", module: MOD, disposition: "UI" }]); f.row.workerBoundary = "safe"; f.save(); fail(f.run("--plan", "06"), /UI lacks positive affinity/); });
test("RETAIN requires positive bounds", (t) => { const f = fixture(t, [{ name: "pure", plan: "06", module: MOD, disposition: "RETAIN" }]); f.row.workerBoundary = "safe"; f.row.evidence = { behaviorCases: ["pure_behavior"] }; f.save(); fail(f.run("--plan", "06"), /RETAIN lacks positive bound/); });
test("compile check alone cannot replace nonzero behavior tests", (t) => { const f = fixture(t); f.row.tests = [{ command: "cargo check --lib", exitCode: 0 }]; f.save(); fail(f.run("--plan", "06"), /no nonzero passing behavioral tests/); });
for (const [field, value] of [["passed", 0], ["failed", 1], ["ignored", 1], ["skipped", 1]]) test(`behavior ${field}=${value} fails closed`, (t) => { const f = fixture(t); f.row.tests[0][field] = value; f.save(); fail(f.run("--plan", "06"), /zero\/failed\/skipped/); });
test("missing behavior test name fails", (t) => { const f = fixture(t); f.row.evidence.behaviorCases = ["invented_behavior"]; f.save(); fail(f.run("--plan", "06"), /missing physical behavior-test/); });
test("test selector unrelated to named case fails", (t) => { const f = fixture(t); f.row.tests[0].command = "cargo test --lib unrelated"; f.save(); fail(f.run("--plan", "06"), /not covered by a recorded passing selector/); });
test("missing synchronous caller evidence fails", (t) => { const f = fixture(t); f.row.syncCallers = []; f.save(); fail(f.run("--plan", "06"), /empty syncCallers/); });
test("missing processing outcome owner fails", (t) => { const f = fixture(t); delete f.row.processingCaller.terminalNoticeOwner; f.save(); fail(f.run("--plan", "06"), /processingCaller.terminalNoticeOwner/); });
test("new unowned production registration fails", (t) => { const f = fixture(t); f.write(MOD, f.read(MOD) + "\npub fn surprise() {}\n"); f.write("src-tauri/src/lib.rs", "fn run() { tauri::generate_handler![model::sample, model::surprise]; }"); fail(f.run("--plan", "06"), /New production registration/); });
test("missing production registration fails", (t) => { const f = fixture(t); f.write("src-tauri/src/lib.rs", "fn run() { tauri::generate_handler![]; }"); fail(f.run("--plan", "06"), /No generate_handler/); });
test("duplicate production registration fails", (t) => { const f = fixture(t); f.write("src-tauri/src/lib.rs", "fn run() { tauri::generate_handler![model::sample,model::sample]; }"); fail(f.run("--plan", "06"), /Duplicate production/); });
test("native feature commands use a separate positive allowlist", (t) => {
  const f = fixture(t); f.write(MOD, f.read(MOD) + "\n#[cfg(feature = \"native-e2e\")]\npub fn probe() {}\n");
  f.write("src-tauri/src/lib.rs", 'fn run() { tauri::generate_handler![model::sample, #[cfg(feature = "native-e2e")] model::probe]; }');
  fail(f.run("--plan", "06"), /Native feature command missing separate allowlist/);
  f.write("docs/performance/phase08-native-allowlist.json", { commands: [{ name: "probe", registrationPath: "src-tauri/src/lib.rs::model::probe", feature: "native-e2e", reason: "synthetic observation only" }] });
  pass(f.run("--plan", "06"));
  f.write("src-tauri/src/lib.rs", "fn run() { tauri::generate_handler![model::sample, model::probe]; }");
  fail(f.run("--plan", "06"), /New production registration/);
});
test("reexports and same-name ipc wrappers resolve current physical definition", (t) => {
  const f = fixture(t); f.write("src-tauri/src/lib.rs", "use bridge::sample; fn run() { tauri::generate_handler![sample]; }");
  f.write("src-tauri/src/bridge.rs", "pub use crate::model::sample;"); pass(f.run("--plan", "06"));
});
test("early-stage integration obligation passes without future overlay", (t) => {
  const f = fixture(t, [{ name: "sample", plan: "04", module: "src-tauri/src/skill_host/env.rs" }]);
  const shard = f.shards.get("04"); shard.moduleIntegrationOwner = "08-29"; shard.integrationRequired = "08-29"; f.save();
  pass(f.run("--plan", "04"));
  delete shard.integrationRequired; f.save(); fail(f.run("--plan", "04"), /missing explicit 08-29/);
});
test("final closure requires future integration overlay", (t) => { const f = fixture(t); fail(f.run("--all"), /phase08-29-integration.json/); });
test("overlay cannot inject duplicate inventory rows", (t) => { const f = fixture(t); f.write("docs/performance/phase08-29-integration.json", { plan: "08-29", commandCount: 1, commands: [f.row] }); fail(f.run("--integration", "29"), /cannot inject commands/); });

function overlayFixture(t) {
  const specs = integrationModules.map((module, i) => ({ name: `entry_${i}`, module: `src-tauri/src/${module}.rs`, plan: i < 5 ? "04" : i === 5 ? "16" : "17" }));
  specs[0].name = "skills_save_skill_file";
  specs[3].name = "git_sync_pull_rebase";
  specs.push({ name: "skills_sync_source", module: specs[0].module, plan: "04" });
  specs.push({ name: "rename_workspace_entry", module: "src-tauri/src/workspace_files.rs", plan: "06" });
  specs.push({ name: "trash_workspace_entries", module: "src-tauri/src/workspace_files.rs", plan: "06" });
  const f = fixture(t, specs);
  const shard = f.shards.get("04"); shard.moduleIntegrationOwner = "08-29"; shard.integrationRequired = "08-29";
  f.save();
  const entryRef = (name) => { const spec = specs.find((v) => v.name === name); return `${spec.module}::${name}`; };
  const pair = (writer, other, future = false) => ({ entryPair: future ? [writer, other] : [entryRef(writer), entryRef(other)], orders: ["writer-first", "other-first"], aliases: ["lexical", "symlink", "ancestor"], failureRelease: "Injected error releases admission", outcome: "Complete serial persisted fixture result", module: specs.find((v) => v.name === writer)?.module, tests: [{ command: `cargo test --lib ${writer}_behavior`, passed: 1, failed: 0 }], evidence: { behaviorCases: [`${writer}_behavior`] } });
  const overlay = {
    plan: "08-29", commandCount: specs.length,
    integrations: integrationModules.map((module, i) => {
      const spec = specs[i], ref = `${spec.module}::${spec.name}`;
      return { id: `integration-${i}`, module: spec.module, entrySymbols: [ref], commandRefs: [{ module: spec.module, name: spec.name }], stageOwner: "08-29", finalModuleOwner: i < 5 ? "08-29" : i === 5 ? "08-16" : "08-17", admissionEntry: ref, pathSources: [ref], lexicalPaths: ["fixture/whole-checkout", "fixture/registry.json"], aliasPaths: ["canonical fixture checkout and existing ancestor"], parentPreconditions: ["Existing parent identity rechecked after admission"], sourceReservationOrder: "Nonqueued source reservation before path admission", domainLockOrder: "Shared admission before all domain locks", lifetime: { scope: i === 1 || i === 2 ? "background" : "finite", admissionHeldThroughEffects: true, admissionHeldThroughRollback: true, backgroundCallbacksCovered: true, evidence: ref }, networkRegistryAvailability: { networkWork: true, registryReleasedDuringNetwork: true, registryReleasedDuringAdmissionWait: true, listAndMetadataRemoveProgress: true, sourceDuplicateReturnsBusy: true, batchBusySourceSkipped: true, evidence: ref }, writeSetCoverage: { wholeCheckout: true, gitDirectory: true, gitCommonDirectory: true, stagingRollback: true, registrySidecars: true }, testCases: [pair(spec.name, "rename_workspace_entry")], evidence: "Real synthetic fixture source/test paths" };
    }),
    documentRaceConsumer: { plan: "08-07", selector: "phase08_07_earlier_writer_document_races", requiredPairs: ["skills_save_skill_file", "skills_sync_source", "git_sync_pull_rebase"].flatMap((name) => ["save_document", "create_document"].map((target) => pair(name, target, true))) },
  };
  overlay.integrations[0].testCases = ["skills_save_skill_file", "skills_sync_source"].flatMap((writer) => ["rename_workspace_entry", "trash_workspace_entries"].map((other) => pair(writer, other)));
  overlay.integrations[3].testCases = ["rename_workspace_entry", "trash_workspace_entries"].map((other) => pair("git_sync_pull_rebase", other));
  const saveOverlay = () => f.write("docs/performance/phase08-29-integration.json", overlay);
  saveOverlay();
  return { ...f, overlay, saveOverlay };
}
test("integration29 accepts produced parent evidence with future document obligation", (t) => { const f = overlayFixture(t); pass(f.run("--integration", "29")); });
test("integration29 rejects missing module", (t) => { const f = overlayFixture(t); f.overlay.integrations.pop(); f.saveOverlay(); fail(f.run("--integration", "29"), /exactly seven/); });
test("integration29 rejects conflicting final ownership", (t) => { const f = overlayFixture(t); f.overlay.integrations[0].finalModuleOwner = "08-03"; f.saveOverlay(); fail(f.run("--integration", "29"), /conflicting ownership/); });
test("integration29 rejects unknown commandRefs", (t) => { const f = overlayFixture(t); f.overlay.integrations[0].commandRefs[0].name = "ghost"; f.saveOverlay(); fail(f.run("--integration", "29"), /invalid command reference/); });
test("integration29 rejects missing source symbol", (t) => { const f = overlayFixture(t); f.overlay.integrations[0].pathSources = ["src-tauri/src/git.rs::ghost"]; f.saveOverlay(); fail(f.run("--integration", "29"), /missing physical symbol/); });
test("integration29 rejects missing real parent pair", (t) => { const f = overlayFixture(t); f.overlay.integrations[0].testCases.pop(); f.saveOverlay(); fail(f.run("--integration", "29"), /missing skills_sync_source\/trash_workspace_entries pair/); });
test("integration29 rejects missing admission ordering", (t) => { const f = overlayFixture(t); f.overlay.integrations[0].testCases[0].orders = ["writer-first"]; f.saveOverlay(); fail(f.run("--integration", "29"), /missing orders\/aliases/); });
test("integration29 rejects missing alias variant", (t) => { const f = overlayFixture(t); f.overlay.integrations[0].testCases[0].aliases = ["lexical"]; f.saveOverlay(); fail(f.run("--integration", "29"), /missing orders\/aliases/); });
test("integration29 rejects zero real behavior tests", (t) => { const f = overlayFixture(t); f.overlay.integrations[0].testCases[0].tests[0].passed = 0; f.saveOverlay(); fail(f.run("--integration", "29"), /zero\/failed\/skipped/); });
test("integration29 requires exact 07 obligation", (t) => { const f = overlayFixture(t); delete f.overlay.documentRaceConsumer; f.saveOverlay(); fail(f.run("--integration", "29"), /exact 07 document consumer/); });
test("final closure rejects missing 16/17 completed handoff", (t) => { const f = overlayFixture(t); fail(f.run("--all"), /completed handoff/); });
function completeFinal(f) {
  const module = "src-tauri/src/document.rs";
  const commands = [];
  let source = "";
  for (const name of ["save_document", "create_document"]) {
    const row = JSON.parse(JSON.stringify(f.row).replaceAll("skills_save_skill_file", name).replaceAll("skill_host/store.rs", "document.rs").replaceAll("skill_host::store", "document"));
    row.module = module;
    commands.push(row);
    f.specs.push({ name, module, plan: "07" });
    source += `
#[tauri::command]
pub async fn ${name}() -> u32 { tauri::async_runtime::spawn_blocking(move || ${name}_blocking()).await.unwrap() }
fn ${name}_blocking() -> u32 { std::fs::read("fixture").unwrap().len() as u32 }
#[cfg(test)] mod tests_${name} { #[test] fn ${name}_behavior() { assert_eq!(1, 1); } }
`;
    f.write(`${PHASE}/08-COMMAND-INVENTORY.md`, f.read(`${PHASE}/08-COMMAND-INVENTORY.md`) + `\n| \`${name}\` | \`${module}:1\` | sync | **CONVERT**: research |`);
    f.write(`${PHASE}/08-PLAN-MAP.md`, f.read(`${PHASE}/08-PLAN-MAP.md`) + `\n| 08-07 | \`${module}\` | \`${name}\` |`);
    f.write("src-tauri/src/lib.rs", f.read("src-tauri/src/lib.rs").replace("];", `,document::${name}];`));
  }
  const selector = "phase08_07_earlier_writer_document_races";
  const cases = f.overlay.documentRaceConsumer.requiredPairs.map((pair) => {
    const [writer, target] = pair.entryPair;
    const behavior = `${writer}_versus_${target}_behavior`;
    const writerModule = f.specs.find((spec) => spec.name === writer).module;
    return { ...pair, entryPair: [`${writerModule}::${writer}`, `${module}::${target}`], module, tests: [{ command: `cargo test --lib ${selector}`, passed: 6, failed: 0, ignored: 0 }], evidence: { behaviorCases: [`${selector}::${behavior}`] } };
  });
  source += `\n#[cfg(test)] mod ${selector} {` + cases.map((record) => `\n#[test] fn ${record.evidence.behaviorCases[0].split("::").at(-1)}() { assert_eq!(1,1); }`).join("") + "\n}";
  f.write(module, source);
  f.shards.set("07", { plan: "08-07", moduleIntegrationOwner: "08-07", commands, crossDomainConsumers: [{ integration: "08-29", selector, testCases: cases }] });
  for (const [plan, index] of [["16", 5], ["17", 6]]) {
    const row = f.shards.get(plan).commands[0];
    f.shards.get(plan).moduleIntegrations = [{ integrationId: `integration-${index}`, status: "complete", module: row.module, entrySymbols: [`${row.module}::${row.name}`], tests: row.tests, evidence: row.evidence }];
  }
  f.overlay.commandCount = f.specs.length;
  f.save(); f.saveOverlay();
}
test("final closure passes with actual 07 consumer and tested 16/17 handoffs", (t) => { const f = overlayFixture(t); completeFinal(f); pass(f.run("--all")); });
test("final closure rejects missing actual 07 consumer even with completed handoffs", (t) => {
  const f = overlayFixture(t); completeFinal(f); delete f.shards.get("07").crossDomainConsumers; f.save(); fail(f.run("--all"), /Missing actual 07 crossDomainConsumers/);
});
test("final closure rejects untested handoff marked complete", (t) => {
  const f = overlayFixture(t); completeFinal(f); delete f.shards.get("16").moduleIntegrations[0].tests; f.save(); fail(f.run("--all"), /missing tests/);
});
test("final closure rejects document result missing pair or ancestor", (t) => {
  const f = overlayFixture(t); completeFinal(f); f.shards.get("07").crossDomainConsumers[0].testCases[0].aliases = ["lexical", "symlink"]; f.save(); fail(f.run("--all"), /ancestor variants/);
});
test("integration29 rejects missing ancestor alias", (t) => { const f = overlayFixture(t); f.overlay.integrations[0].testCases[0].aliases = ["lexical", "symlink"]; f.saveOverlay(); fail(f.run("--integration", "29"), /missing orders\/aliases/); });
test("integration29 rejects registry exclusion held over network", (t) => { const f = overlayFixture(t); f.overlay.integrations[0].networkRegistryAvailability.registryReleasedDuringNetwork = false; f.saveOverlay(); fail(f.run("--integration", "29"), /network registry exclusion violation/); });
test("integration29 rejects incomplete background callback lifetime", (t) => { const f = overlayFixture(t); delete f.overlay.integrations[2].lifetime.backgroundCallbacksCovered; f.saveOverlay(); fail(f.run("--integration", "29"), /background callback/); });
test("integration29 rejects abbreviated checkout write set", (t) => { const f = overlayFixture(t); f.overlay.integrations[0].writeSetCoverage.wholeCheckout = false; f.saveOverlay(); fail(f.run("--integration", "29"), /abbreviated write set/); });
test("empty nested evidence and placeholders fail outside helperChain", (t) => {
  const f = fixture(t); f.row.evidence = { behaviorCases: ["sample_behavior"], safety: { review: "" } }; f.save(); fail(f.run("--plan", "06"), /empty evidence/);
  f.row.evidence.safety.review = "TODO: review this"; f.save(); fail(f.run("--plan", "06"), /unresolved placeholder/);
});
test("wrong nonstaged module integration owner fails", (t) => { const f = fixture(t); f.shards.get("06").moduleIntegrationOwner = "08-29"; f.save(); fail(f.run("--plan", "06"), /wrong final moduleIntegrationOwner/); });
test("blocking work before worker boundary fails", (t) => { const f = fixture(t); f.write(MOD, f.read(MOD).replace("tauri::async_runtime::spawn_blocking", 'std::fs::read("early").unwrap(); tauri::async_runtime::spawn_blocking')); fail(f.run("--plan", "06"), /blocking work before/); });
test("native registration feature gate does not excuse ungated definition", (t) => {
  const f = fixture(t); f.write(MOD, f.read(MOD) + "\npub fn probe() {}\n");
  f.write("src-tauri/src/lib.rs", 'fn run() { tauri::generate_handler![model::sample, #[cfg(feature = "native-e2e")] model::probe]; }');
  f.write("docs/performance/phase08-native-allowlist.json", { commands: [{ name: "probe", registrationPath: "src-tauri/src/lib.rs::model::probe", feature: "native-e2e", reason: "synthetic observation only" }] });
  fail(f.run("--plan", "06"), /definition is not feature-gated/);
});
test("native module definition feature gate is accepted", (t) => {
  const f = fixture(t); f.write("src-tauri/src/probe.rs", "pub fn inspect() {}\n");
  f.write("src-tauri/src/lib.rs", '#[cfg(feature = "native-e2e")] mod probe; fn run() { tauri::generate_handler![model::sample, #[cfg(feature = "native-e2e")] probe::inspect]; }');
  f.write("docs/performance/phase08-native-allowlist.json", { commands: [{ name: "inspect", registrationPath: "src-tauri/src/lib.rs::probe::inspect", feature: "native-e2e", reason: "synthetic observation only" }] });
  pass(f.run("--plan", "06"));
});
test("Rust mask preserves offsets and ignores nested comments, raw strings and lifetimes", () => {
  const source = '/* outer /* nested } */ } */ fn real<\'a>() { let x = r##" } // \" "##; let y = "{"; }';
  const masked = maskRust(source); assert.equal(masked.length, source.length); assert.equal(masked.match(/\{/g).length, 1); assert.equal(masked.match(/\}/g).length, 1); assert.match(masked, /real<'a>/);
});
test("CLI rejects missing/mixed/unknown modes and invalid counts", () => {
  for (const args of [[], ["--all", "--plan", "04"], ["--plan"], ["--plan", "29"], ["--integration", "07"], ["--all", "--expected-count", "0"], ["--wat"]]) assert.throws(() => parseArgs(args));
  assert.deepEqual(parseArgs(["--plan", "4"]), { plan: "04", expectedCount: 365 });
});

test("read-only evidence permits explicitly empty write sets", (t) => {
  const f = fixture(t); f.row.mutationKey = { readOnly: true, lexicalPaths: [], aliasPaths: [], domainLockOrder: "Read-only diagnostics", sharedAdmissionEntry: "No filesystem mutation" }; f.save(); pass(f.run("--plan", "06"));
  f.row.mutationKey.readOnly = false; f.save(); fail(f.run("--plan", "06"), /empty mutationKey/);
});
test("cited shell helper path must physically exist", (t) => {
  const f = fixture(t); f.row.helperChain.push("src-tauri/skills-bootstrap/envs/default/setup.sh owns finite setup work"); f.save(); fail(f.run("--plan", "06"), /Missing source\/helper path/);
  f.write("src-tauri/skills-bootstrap/envs/default/setup.sh", "#!/bin/sh\nexit 0\n"); pass(f.run("--plan", "06"));
});
test("invented named case cannot hide behind another valid case", (t) => {
  const f = fixture(t); f.row.evidence.behaviorCases.push("invented_case"); f.save(); fail(f.run("--plan", "06"), /missing physical named case/);
});
test("final processing caller requires fulfilled-domain classification and single owner", (t) => {
  const f = overlayFixture(t); completeFinal(f); delete f.row.processingCaller.classifier; f.save(); fail(f.run("--all"), /final processingCaller missing classifier/);
});
test("final closure rejects pending integration outside early staged modules", (t) => {
  const f = overlayFixture(t); completeFinal(f); f.shards.get("07").commands[0].mutationKey = { lexicalPaths: ["fixture/document.md"], aliasPaths: ["fixture/canonical/document.md"], postAdmissionPreconditions: ["Parent still exists"], domainLockOrder: "Shared admission before domain lock", sharedAdmissionEntry: "integrationRequired: 08-29" }; f.save(); fail(f.run("--all"), /pending integration/);
});

test("store/git cannot relabel network work to omit registry availability", (t) => { const f = overlayFixture(t); f.overlay.integrations[0].networkRegistryAvailability = { networkWork: false, reason: "Assumed no network", evidence: "src-tauri/src/git.rs::git_sync_pull_rebase" }; f.saveOverlay(); fail(f.run("--integration", "29"), /store\/git must prove network/); });
test("env/dispatch cannot relabel callback lifetime as finite", (t) => { const f = overlayFixture(t); f.overlay.integrations[1].lifetime.scope = "finite"; f.saveOverlay(); fail(f.run("--integration", "29"), /env\/dispatch require background/); });
test("explicit processing caller source path must exist", (t) => { const f = fixture(t); f.row.processingCaller.path = "src/lib/nonexistent.ts::invoke"; f.save(); fail(f.run("--plan", "06"), /Missing source\/helper path/); });
