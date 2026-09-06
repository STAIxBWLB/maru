// Plan 08-27: native saturation and source-race harness — PERF-01's
// concurrency proof gate and PERF-02's removed-source-not-resurrected race.
//
// What this spec proves, in order:
//  1. Idle calibration: three rounds of fixed-cadence webview-timed samples
//     of the same-runtime async probe and the unrelated production
//     parse_korean_date_cmd ('내일' against a fixed now must return the exact
//     next-day instant — a no-op wrapper cannot pass).
//  2. Thresholds frozen from calibration BEFORE any loaded run.
//  3. blocking_async negative control: the same four real operations routed
//     back onto the two async workers must violate the frozen probe bounds;
//     a green harness without this red control is not accepted.
//  4. Isolated fixed run: three full rounds while git_status x2, scan_vault
//     (2000-file tree) and skills_sync_source (local bare remote) overlap
//     inside their real blocking closures; loaded/recovery p95 and max stall
//     must meet the frozen bounds with zero missing samples.
//  5. D-01..D-05 native decision flows: change/change-revert during an
//     in-flight sync discards its result; a removed source is never
//     resurrected by a late sync write-back (PERF-02); a duplicate sync
//     reports busy once; Sync All skips the busy source and persists the
//     others; a UI-started sync completes across a screen change with
//     exactly one existing-surface notice; one failing source keeps the
//     other sources' successes and retries manually.
//
// Every destructive D-case restores the disposable fixture afterwards
// (restoreSkillFixtures), so specs running later in the same suite keep
// their seeded pending commits.
import assert from "node:assert/strict";
import path from "node:path";
import type {} from "webdriverio";

import {
  FIXTURE_FAIL_SOURCE,
  FIXTURE_PENDING_DESCRIPTION,
  FIXTURE_SKILL_TITLE_A,
  FIXTURE_SKILL_TITLE_B,
  FIXTURE_SYNC_SOURCE_A,
  FIXTURE_SYNC_SOURCE_B,
  FIXTURE_VAULT_TREE_FILES,
  readFixtureMetadata,
  readFixtureSkillRegistry,
  restoreSkillFixtures,
  restoreFailSourceRemote,
  breakFailSourceRemote,
  saturationFixturePaths,
} from "../helpers/fixtureWorkspace";
import {
  buildRevision,
  fireBridgeCall,
  frozenBound,
  MAX_STALL_MS,
  pollBridgeCall,
  readArtifact,
  roundStats,
  runIsolatedRound,
  runNegativeRound,
  sha256File,
  WINDOW_SAMPLES,
  writeArtifact,
  type RoundResult,
  type SaturationOpsConfig,
} from "../helpers/responsivenessSamples";

const TEST_TIMEOUT_MS = 300_000;

interface BridgeCallResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

/** One awaited bridge call: a single WebDriver round trip whose promise
 *  settles inside the webview. */
async function bridgeCall<T>(method: string, ...args: unknown[]): Promise<T> {
  const result = await browser.executeAsync(
    (name: string, callArgs: unknown[], done: (outcome: BridgeCallResult) => void) => {
      const bridge = window.__MARU_NATIVE_E2E__ as unknown as Record<string, (...call: unknown[]) => Promise<unknown>> | undefined;
      const fn = bridge?.[name];
      if (typeof fn !== "function") {
        done({ ok: false, error: `bridge method missing: ${name}` });
        return;
      }
      Promise.resolve(fn(...callArgs)).then(
        (value) => done({ ok: true, value }),
        (error: unknown) =>
          done({
            ok: false,
            error:
              error && typeof error === "object" && "message" in error
                ? String((error as { message: unknown }).message)
                : String(error),
          }),
      );
    },
    method,
    args,
  );
  if (!result.ok) throw new Error(result.error ?? "bridge call failed");
  return result.value as T;
}

async function loadControl(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  return bridgeCall<Record<string, unknown>>("loadControl", request);
}

async function armIsolated(ops: Array<Record<string, unknown>>): Promise<void> {
  const status = await loadControl({ action: "arm", mode: "isolated", ops });
  assert.equal(Array.isArray(status.armed), true, JSON.stringify(status));
}

async function armBlockingAsync(): Promise<void> {
  const paths = saturationFixturePaths();
  const status = await loadControl({
    action: "arm",
    mode: "blockingAsync",
    ops: [
      { op: "git_status", paths: [paths.repoA, paths.repoB] },
      { op: "scan_vault", paths: [paths.tree] },
      { op: "skills_sync_source", sourceId: FIXTURE_SYNC_SOURCE_A },
    ],
  });
  assert.equal((status.armed as unknown[]).length, 3, JSON.stringify(status));
}

async function disarmAndReset(): Promise<void> {
  await loadControl({ action: "disarm" });
  await loadControl({ action: "reset" });
}

function saturationConfig(): SaturationOpsConfig {
  const paths = saturationFixturePaths();
  return {
    repoA: paths.repoA,
    repoB: paths.repoB,
    tree: paths.tree,
    sourceA: FIXTURE_SYNC_SOURCE_A,
    expectedEntries: FIXTURE_VAULT_TREE_FILES,
  };
}

function assertRoundOutcomes(round: RoundResult, config: SaturationOpsConfig, requireOverlap: boolean): void {
  assert.equal(round.ok, true, round.error ?? "round failed");
  const byOp = new Map(round.ops.map((op) => [op.op, op]));
  const gitA = byOp.get("git_status_a");
  const gitB = byOp.get("git_status_b");
  const scan = byOp.get("scan_vault");
  const sync = byOp.get("skills_sync_source");
  assert.ok(gitA?.ok && (gitA.modified ?? 0) >= 1, `git_status(repo A) must report real changes: ${JSON.stringify(gitA)}`);
  assert.ok(gitB?.ok && (gitB.modified ?? 0) >= 1, `git_status(repo B) must report real changes: ${JSON.stringify(gitB)}`);
  assert.ok(scan?.ok && (scan.entries ?? 0) >= config.expectedEntries, `scan_vault must scan the whole ${config.expectedEntries}-file tree: ${JSON.stringify(scan)}`);
  assert.ok(sync?.ok && (sync.skills ?? 0) >= 1, `skills_sync_source must return synced skill records: ${JSON.stringify(sync)}`);
  if (requireOverlap) {
    const status = round.loadStatus as { maxConcurrent?: number; windows?: Record<string, Array<[number, number]>> };
    assert.equal(status.maxConcurrent, 4, `four operations must overlap, got ${JSON.stringify(status.maxConcurrent)}`);
    for (const op of ["git_status_a", "git_status_b", "scan_vault", "skills_sync_source"]) {
      assert.ok((status.windows?.[op === "git_status_a" || op === "git_status_b" ? "git_status" : op]?.length ?? 0) >= 1, `missing overlap window for ${op}`);
    }
  }
  assert.equal(round.workerCount, 2, `installed runtime must report exactly two workers, got ${round.workerCount}`);
}

interface ThresholdsFile {
  plan: string;
  kind: string;
  frozenAt: string;
  buildRevision: string;
  formula: string;
  series: {
    probe: { idleP95Calibrated: number; bound: number };
    parse: { idleP95Calibrated: number; bound: number };
  };
  maxStallMs: number;
  windowSamples: number;
  maxMissingSamples: number;
  workerCount: number;
}

function assertWithinThresholds(round: RoundResult, thresholds: ThresholdsFile, label: string): void {
  const stats = roundStats(round);
  for (const series of ["probe", "parse"] as const) {
    const bound = thresholds.series[series].bound;
    for (const window of ["loaded", "recovery"] as const) {
      const windowStats = stats[series][window];
      assert.equal(windowStats.missing, 0, `${label}/${series}/${window}: missing samples`);
      assert.equal(windowStats.count, thresholds.windowSamples, `${label}/${series}/${window}: sample count`);
      assert.ok(
        windowStats.p95 <= bound,
        `${label}/${series}/${window} p95 ${windowStats.p95}ms exceeds frozen bound ${bound}ms`,
      );
    }
  }
  assert.ok(
    stats.maxStall <= thresholds.maxStallMs,
    `${label}: max stall ${stats.maxStall}ms exceeds ${thresholds.maxStallMs}ms`,
  );
}

describe("native saturation and source-race harness", () => {
  before(async () => {
    // One saturation round runs 10+ seconds of in-page sampling behind a
    // single executeAsync callback; the WebKit driver's default 30s script
    // timeout kills long rounds mid-window and every later test then reads a
    // wedged session. Raise the script timeout below the 120s mocha backstop.
    await browser.setTimeout({ script: 110_000 });
  });

  after(async () => {
    await disarmAndReset().catch(() => {});
    await restoreFailSourceRemote().catch(() => {});
    await restoreSkillFixtures().catch(() => {});
  });

  it("calibrates idle responsiveness over three rounds with real command outcomes", async () => {
    const config = saturationConfig();
    const rounds: RoundResult[] = [];
    for (let index = 0; index < 3; index += 1) {
      const round = await runIsolatedRound(config, `calibration-${index + 1}`);
      // Calibration arms nothing: operations must still succeed through the
      // real registrations without the load window.
      const byOp = new Map(round.ops.map((op) => [op.op, op]));
      assert.equal(round.ok, true, round.error);
      assert.ok((byOp.get("git_status_a")?.modified ?? 0) >= 1);
      assert.ok((byOp.get("scan_vault")?.entries ?? 0) >= config.expectedEntries);
      assert.ok((byOp.get("skills_sync_source")?.skills ?? 0) >= 1);
      assert.ok(round.idle.probe.every((sample) => sample.ok), "idle probe samples must all settle");
      assert.ok(round.idle.parse.every((sample) => sample.ok), "idle parse samples must all return the exact next-day instant");
      rounds.push(round);
    }
    const stats = rounds.map((round) => roundStats(round));
    const calibration = {
      plan: "08-27",
      kind: "idle-calibration",
      buildRevision: buildRevision(),
      generatedAt: new Date().toISOString(),
      cadenceMs: 25,
      warmupSamples: 40,
      windowSamples: WINDOW_SAMPLES,
      fixture: await readFixtureMetadata(),
      rounds: rounds.map((round, index) => ({ round: index + 1, raw: round, stats: stats[index] })),
      idleP95: {
        probe: Math.max(...stats.map((entry) => entry.probe.idle.p95)),
        parse: Math.max(...stats.map((entry) => entry.parse.idle.p95)),
      },
      idleMaxStall: Math.max(...stats.map((entry) => Math.max(entry.probe.idle.max, entry.parse.idle.max))),
      workerCount: rounds[0].workerCount,
    };
    await writeArtifact("calibration.json", calibration);
    assert.equal(calibration.workerCount, 2, "calibration must observe the installed two-worker runtime");
  }).timeout(TEST_TIMEOUT_MS);

  it("freezes responsiveness thresholds from calibration before any loaded run", async () => {
    const calibration = await readArtifact<{ idleP95: { probe: number; parse: number }; windowSamples: number }>("calibration.json");
    const thresholds: ThresholdsFile = {
      plan: "08-27",
      kind: "frozen-thresholds",
      frozenAt: new Date().toISOString(),
      buildRevision: buildRevision(),
      formula: "per series: loaded/recovery p95 <= max(calibrated idle p95 * 2, calibrated idle p95 + 25ms); max stall <= 250ms",
      series: {
        probe: { idleP95Calibrated: calibration.idleP95.probe, bound: frozenBound(calibration.idleP95.probe) },
        parse: { idleP95Calibrated: calibration.idleP95.parse, bound: frozenBound(calibration.idleP95.parse) },
      },
      maxStallMs: MAX_STALL_MS,
      windowSamples: calibration.windowSamples,
      maxMissingSamples: 0,
      workerCount: 2,
    };
    assert.ok(thresholds.series.probe.bound > 0 && thresholds.series.parse.bound > 0);
    await writeArtifact("thresholds.json", thresholds);
  }).timeout(60_000);

  it("blocking_async negative control violates the frozen probe latency bounds", async () => {
    const thresholds = await readArtifact<ThresholdsFile>("thresholds.json");
    const config = saturationConfig();
    let violation = false;
    let round: RoundResult | null = null;
    try {
      await armBlockingAsync();
      round = await runNegativeRound(config);
      assert.equal(round.ok, true, round.error);
      const stats = roundStats(round);
      const probeViolation = stats.probe.loaded.p95 > thresholds.series.probe.bound || stats.probe.loaded.max > thresholds.maxStallMs;
      assert.ok(
        probeViolation,
        `negative control must violate the frozen probe bound (${thresholds.series.probe.bound}ms): loaded p95=${stats.probe.loaded.p95}ms max=${stats.probe.loaded.max}ms`,
      );
      violation = true;
    } finally {
      await disarmAndReset();
    }
    const restored = await loadControl({ action: "status" });
    assert.equal((restored.armed as unknown[]).length, 0, "isolated mode must be restored after the negative control");
    await writeArtifact("negative-control.json", {
      plan: "08-27",
      kind: "blocking-async-negative-control",
      buildRevision: buildRevision(),
      generatedAt: new Date().toISOString(),
      violatedFrozenBounds: violation,
      thresholds,
      stats: round ? roundStats(round) : null,
      raw: round,
      restoredStatus: restored,
    });
    assert.equal(violation, true, "negative control produced no latency-bound violation");
  }).timeout(TEST_TIMEOUT_MS);

  it("isolated saturation meets frozen bounds across three full rounds", async () => {
    const thresholds = await readArtifact<ThresholdsFile>("thresholds.json");
    const config = saturationConfig();
    const thresholdPath = path.resolve("artifacts/native-responsiveness/thresholds.json");
    const thresholdHash = await sha256File(thresholdPath);
    const rounds: RoundResult[] = [];
    for (let index = 0; index < 3; index += 1) {
      await armSaturationIsolated();
      let round: RoundResult;
      try {
        round = await runIsolatedRound(config, `fixed-${index + 1}`);
      } finally {
        await disarmAndReset();
      }
      assertRoundOutcomes(round, config, true);
      assertWithinThresholds(round, thresholds, `fixed-round-${index + 1}`);
      rounds.push(round);
    }
    await writeArtifact("fixed-run.json", {
      plan: "08-27",
      kind: "isolated-fixed-run",
      buildRevision: buildRevision(),
      generatedAt: new Date().toISOString(),
      thresholdHash,
      thresholds,
      rounds: rounds.map((round, index) => ({ round: index + 1, raw: round, stats: roundStats(round) })),
    });
  }).timeout(TEST_TIMEOUT_MS);

  it("D-01 discards an in-flight sync invalidated by change and by change/revert", async () => {
    const before = await readFixtureSkillRegistry();
    const originalSubdir = before.sources.find((source) => source.id === FIXTURE_SYNC_SOURCE_B)?.skillsSubdir ?? "skills";
    try {
      await armIsolated([{ op: "skills_sync_source", sourceId: FIXTURE_SYNC_SOURCE_B }]);

      // Change while the sync is inside its deterministic pre-work window.
      await fireBridgeCall("skillsSyncSource", "d1-sync", FIXTURE_SYNC_SOURCE_B);
      await sleep(600);
      await loadControl({ action: "changeSource", sourceId: FIXTURE_SYNC_SOURCE_B });
      const changed = await pollBridgeCall("d1-sync");
      assert.equal(changed.ok, false, `sync must be rejected after a settings change, got ${JSON.stringify(changed)}`);
      assert.match(String(changed.error), /source_changed|unknown_source/);
      let registry = await readFixtureSkillRegistry();
      const changedSource = registry.sources.find((source) => source.id === FIXTURE_SYNC_SOURCE_B);
      assert.equal(changedSource?.skillsSubdir, `${originalSubdir}-race`, "latest settings must be preserved");
      await loadControl({ action: "revertSource" });
      registry = await readFixtureSkillRegistry();
      assert.equal(registry.sources.find((source) => source.id === FIXTURE_SYNC_SOURCE_B)?.skillsSubdir, originalSubdir);

      // Change then revert is still a mutation generation change: the old
      // in-flight result must be discarded too.
      await fireBridgeCall("skillsSyncSource", "d1-sync", FIXTURE_SYNC_SOURCE_B);
      await sleep(600);
      await loadControl({ action: "changeSource", sourceId: FIXTURE_SYNC_SOURCE_B });
      await sleep(300);
      await loadControl({ action: "revertSource" });
      const reverted = await pollBridgeCall("d1-sync");
      assert.equal(reverted.ok, false, `sync must be rejected after change/revert, got ${JSON.stringify(reverted)}`);
      assert.match(String(reverted.error), /source_changed|unknown_source/);
      registry = await readFixtureSkillRegistry();
      assert.equal(registry.sources.find((source) => source.id === FIXTURE_SYNC_SOURCE_B)?.skillsSubdir, originalSubdir);
      // The discarded sync must not have persisted the pending commit's
      // content. An old-content record can legitimately be present — the
      // app's startup catalog refresh rescans every source when the catalog
      // is empty — so the assertion targets the pending marker exactly.
      assert.ok(
        !registry.skills.some((skill) => skill.sourceId === FIXTURE_SYNC_SOURCE_B && skill.description === FIXTURE_PENDING_DESCRIPTION),
        `discarded sync must not persist the pending update, got: ${JSON.stringify(registry.skills.filter((skill) => skill.sourceId === FIXTURE_SYNC_SOURCE_B))}`,
      );
    } finally {
      await disarmAndReset();
    }
  }).timeout(TEST_TIMEOUT_MS);

  it("D-02 a duplicate sync reports busy and runs the operation once", async () => {
    try {
      await armIsolated([{ op: "skills_sync_source", sourceId: FIXTURE_SYNC_SOURCE_A }]);
      await fireBridgeCall("skillsSyncSource", "d2-sync", FIXTURE_SYNC_SOURCE_A);
      await sleep(500);
      let busyError = "";
      try {
        await bridgeCall("skillsSyncSource", FIXTURE_SYNC_SOURCE_A);
      } catch (error) {
        busyError = String((error as Error).message);
      }
      assert.match(busyError, /source_busy|already syncing/, `duplicate sync must report busy, got: ${busyError}`);
      const first = await pollBridgeCall("d2-sync");
      assert.equal(first.ok, true, `first sync must succeed, got ${JSON.stringify(first)}`);
      const registry = await readFixtureSkillRegistry();
      assert.ok(registry.sources.find((source) => source.id === FIXTURE_SYNC_SOURCE_A)?.lastSyncedAt);
    } finally {
      await disarmAndReset();
    }
  }).timeout(TEST_TIMEOUT_MS);

  it("D-03 Sync All skips the busy source and persists the other source", async () => {
    let outcome: { skipped: number; succeeded: number; failed: number; results: Array<{ sourceId: string; ok: boolean; skipped: boolean }> } | null = null;
    try {
      await armIsolated([{ op: "skills_sync_source", sourceId: FIXTURE_SYNC_SOURCE_A }]);
      await fireBridgeCall("skillsSyncSource", "d3-sync", FIXTURE_SYNC_SOURCE_A);
      await sleep(600);
      outcome = await bridgeCall("skillsSyncAllSources");
      const first = await pollBridgeCall("d3-sync");
      assert.equal(first.ok, true, `in-flight sync A must still succeed, got ${JSON.stringify(first)}`);
    } finally {
      await disarmAndReset();
    }
    assert.ok(outcome, "Sync All must return an outcome");
    const skipped = outcome.results.find((row) => row.sourceId === FIXTURE_SYNC_SOURCE_A);
    assert.ok(skipped?.skipped && !skipped.ok, `busy source A must be reported skipped, not synchronized: ${JSON.stringify(skipped)}`);
    assert.equal(outcome.skipped, 1, `exactly one skipped source expected: ${JSON.stringify(outcome)}`);
    assert.equal(outcome.failed, 0);
    assert.ok(outcome.results.find((row) => row.sourceId === FIXTURE_SYNC_SOURCE_B)?.ok, "source B must succeed while A is busy");
    const registry = await readFixtureSkillRegistry();
    assert.ok(registry.skills.some((skill) => skill.sourceId === FIXTURE_SYNC_SOURCE_B && skill.title === FIXTURE_SKILL_TITLE_B && skill.valid), "source B success must be persisted");
  }).timeout(TEST_TIMEOUT_MS);

  it("D-04 a UI-started sync completes across a screen change with exactly one notice", async () => {
    try {
      await armIsolated([{ op: "skills_sync_source", sourceId: FIXTURE_SYNC_SOURCE_A }]);
      const result = await browser.executeAsync(
        (sourceId: string, timeout: number, done: (outcome: Record<string, unknown>) => void) => {
          const deadline = Date.now() + timeout;
          let stage = "settings";
          const tick = () => {
            const bridge = window.__MARU_NATIVE_E2E__ as unknown as
              | { menuCommand(id: string): void }
              | undefined;
            if (!bridge?.menuCommand) {
              done({ ok: false, stage, error: "bridge missing" });
              return;
            }
            if (stage === "settings") {
              const settings = document.querySelector<HTMLButtonElement>('.activity-rail button[aria-label="설정"]');
              if (settings) {
                settings.click();
                stage = "skills";
              }
            } else if (stage === "skills") {
              const tab = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
                (button) => button.getAttribute("role") === "tab" && button.textContent?.trim() === "Skills",
              );
              if (tab) {
                tab.click();
                stage = "source";
              }
            } else if (stage === "source") {
              const card = Array.from(document.querySelectorAll(".source-card")).find(
                (element) => element.querySelector(".system-skill-name")?.textContent === sourceId,
              );
              const sync = Array.from(card?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
                (button) => button.textContent?.trim() === "Sync" && !button.disabled,
              );
              if (sync) {
                sync.click();
                stage = "confirm";
              }
            } else if (stage === "confirm") {
              const proceed = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
                (button) => button.closest('[role="dialog"]') && button.textContent?.trim() === "진행",
              );
              if (proceed) {
                proceed.click();
                stage = "navigate";
              }
            } else if (stage === "navigate") {
              const log = document.querySelector(".skills-operation")?.textContent ?? "";
              if (log.includes(sourceId)) {
                bridge.menuCommand("view.documents");
                stage = "notice";
              }
            } else if (stage === "notice") {
              const notices = Array.from(document.querySelectorAll("[data-skill-operation]"));
              const notice = notices[0]?.textContent ?? "";
              const documentsVisible = Boolean(document.querySelector(".document-list"));
              if (notice.includes(sourceId) && notice.includes("동기화를 완료")) {
                done({ ok: true, noticeCount: notices.length, documentsVisible, notice });
                return;
              }
            }
            if (Date.now() > deadline) {
              done({ ok: false, stage, body: document.body.innerText.slice(-4000) });
              return;
            }
            setTimeout(tick, 150);
          };
          tick();
        },
        FIXTURE_SYNC_SOURCE_A,
        60_000,
      );
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.noticeCount, 1, `exactly one existing-surface notice expected: ${JSON.stringify(result)}`);
      assert.equal(result.documentsVisible, true, "completion must not force navigation back to the initiating screen");
      const registry = await readFixtureSkillRegistry();
      assert.ok(registry.sources.find((source) => source.id === FIXTURE_SYNC_SOURCE_A)?.lastSyncedAt, "sync result must persist on disk");
      assert.ok(registry.skills.some((skill) => skill.sourceId === FIXTURE_SYNC_SOURCE_A && skill.title === FIXTURE_SKILL_TITLE_A && skill.valid));
    } finally {
      await disarmAndReset();
    }
  }).timeout(TEST_TIMEOUT_MS);

  it("D-05 one failing source keeps the other sources' successes and retries manually", async () => {
    let failureReason = "";
    let outcome: { failed: number; succeeded: number; results: Array<{ sourceId: string; ok: boolean; error?: string | null }> } | null = null;
    try {
      await breakFailSourceRemote();
      try {
        await bridgeCall("skillsSyncSource", FIXTURE_FAIL_SOURCE);
        assert.fail("sync of the broken source must reject with an actionable reason");
      } catch (error) {
        failureReason = (error as Error).message;
      }
      assert.ok(failureReason.trim().length > 0, "failure must carry a reason");
      outcome = await bridgeCall("skillsSyncAllSources");
    } finally {
      await restoreFailSourceRemote();
    }
    assert.ok(outcome, "Sync All must return an outcome");
    assert.equal(outcome.failed, 1, `exactly one source must fail: ${JSON.stringify(outcome)}`);
    const failedRow = outcome.results.find((row) => !row.ok);
    assert.equal(failedRow?.sourceId, FIXTURE_FAIL_SOURCE);
    assert.ok(failedRow?.error && failedRow.error.trim().length > 0, "failed source must keep an actionable reason");
    assert.ok(outcome.results.find((row) => row.sourceId === FIXTURE_SYNC_SOURCE_A)?.ok, "source A success must be preserved while another source fails");
    // Retry is manual: after restoring the remote, one explicit user retry
    // succeeds; nothing retried automatically in between.
    const retry = await bridgeCall<Array<{ title: string }>>("skillsSyncSource", FIXTURE_FAIL_SOURCE);
    assert.ok(Array.isArray(retry) && retry.length >= 1, `manual retry must succeed after the fault is removed: ${JSON.stringify(retry)}`);
    assert.ok(retry.some((skill) => skill.title === "Native Failing Skill"));
  }).timeout(TEST_TIMEOUT_MS);

  it("PERF-02 a source removed during sync is never resurrected by its late write-back", async () => {
    try {
      await armIsolated([{ op: "skills_sync_source", sourceId: FIXTURE_SYNC_SOURCE_B }]);
      await fireBridgeCall("skillsSyncSource", "perf2-sync", FIXTURE_SYNC_SOURCE_B);
      await sleep(600);
      await bridgeCall("skillsRemoveSource", FIXTURE_SYNC_SOURCE_B);
      const syncResult = await pollBridgeCall("perf2-sync");
      assert.equal(syncResult.ok, false, `in-flight sync must be rejected after removal, got ${JSON.stringify(syncResult)}`);
      assert.match(String(syncResult.error), /source_changed|unknown_source/);
      let registry = await readFixtureSkillRegistry();
      assert.ok(!registry.sources.some((source) => source.id === FIXTURE_SYNC_SOURCE_B), "removed source must stay removed");
      // The late write-back lands after the rejection: deletion still wins.
      await sleep(1200);
      registry = await readFixtureSkillRegistry();
      assert.ok(!registry.sources.some((source) => source.id === FIXTURE_SYNC_SOURCE_B), "late sync write-back resurrected the removed source");
      assert.ok(registry.removedSourceIds?.includes(FIXTURE_SYNC_SOURCE_B), "removal tombstone must be recorded");
    } finally {
      await disarmAndReset();
    }
    // The destructive D-case restored nothing itself; the suite-level
    // after() hook reseeds the registry and checkouts from the fixture
    // metadata for the specs that run after this file.
  }).timeout(TEST_TIMEOUT_MS);
});

async function armSaturationIsolated(): Promise<void> {
  const paths = saturationFixturePaths();
  await armIsolated([
    { op: "git_status", paths: [paths.repoA, paths.repoB] },
    { op: "scan_vault", paths: [paths.tree] },
    { op: "skills_sync_source", sourceId: FIXTURE_SYNC_SOURCE_A },
  ]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
