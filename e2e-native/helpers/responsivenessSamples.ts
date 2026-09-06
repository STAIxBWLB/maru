// Plan 08-27 sampling helpers for the native saturation harness.
//
// Every timing value is measured inside the webview with performance.now()
// around real IPC promises (the async probe and the unrelated production
// parse_korean_date_cmd), never around WDIO calls: a WebDriver round trip
// measures the driver, not the app's main-thread responsiveness. The loaded
// window is created by four real registered commands (git_status x2,
// scan_vault over a 2000-file tree, skills_sync_source against a local bare
// remote) whose deterministic pre-work intervals are held inside their real
// blocking closures by the feature-gated load control.
//
// Webview-callback hygiene: executeAsync serializes ONLY the callback
// function, so no callback may reference module-scope helpers or types —
// every bridge access is an inline property read on window. Long rounds are
// also split into per-window scripts (warmup+idle / loaded / recovery) so no
// single driver script outlives the WebKit script timeout; operations cross
// script boundaries through the keyed fire/poll slots below.
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type {} from "webdriverio";

export const PARSE_INPUT = "내일";
export const PARSE_NOW_ISO = "2026-09-05T09:00:00+09:00";
export const PARSE_EXPECTED = "2026-09-06T09:00:00+09:00";
export const SAMPLE_CADENCE_MS = 25;
export const WARMUP_SAMPLES = 40;
export const WINDOW_SAMPLES = 120;
export const MAX_STALL_MS = 250;

export interface SampleEntry {
  /** performance.now() timestamp of the dispatch that produced this sample
   *  (per sampling-script origin — only settle values feed the stats). */
  t: number;
  /** ms from dispatch to settlement. */
  settle: number;
  ok: boolean;
  error?: string;
}

export interface SeriesSamples {
  probe: SampleEntry[];
  parse: SampleEntry[];
}

export interface OpOutcome {
  op: string;
  ok: boolean;
  error?: string;
  settleMs?: number;
  entries?: number;
  modified?: number;
  skills?: number;
}

export interface RoundResult {
  ok: boolean;
  error?: string;
  warmup: SeriesSamples;
  idle: SeriesSamples;
  loaded: SeriesSamples;
  recovery: SeriesSamples;
  ops: OpOutcome[];
  loadStatus: unknown;
  workerCount: number;
}

export interface SeriesStats {
  count: number;
  missing: number;
  median: number;
  p95: number;
  max: number;
}

export interface RoundStats {
  probe: { idle: SeriesStats; loaded: SeriesStats; recovery: SeriesStats };
  parse: { idle: SeriesStats; loaded: SeriesStats; recovery: SeriesStats };
  maxStall: number;
}

/** The bridge methods the in-page scripts rely on, redeclared locally
 *  because e2e-native's tsconfig does not include src/. Keep in sync with
 *  src/lib/nativeE2eBridge.ts. ptyAssertions.ts already declares the
 *  `__MARU_NATIVE_E2E__` Window global with its own narrower shape, so this
 *  file must not redeclare it; in-page callbacks read the property inline. */
export interface HarnessBridge {
  asyncProbe(): Promise<{ ok: boolean; yielded: boolean; workerCount: number; hook: string }>;
  loadControl(request: Record<string, unknown>): Promise<Record<string, unknown>>;
  gitStatus(vaultPath: string): Promise<{ isRepo: boolean; modified: number; staged: number; untracked: number; clean: boolean }>;
  scanVault(vaultPath: string): Promise<Array<{ relPath: string }>>;
  skillsSyncSource(sourceId: string): Promise<Array<{ title: string }>>;
  skillsSyncAllSources(): Promise<{
    total: number;
    succeeded: number;
    failed: number;
    skipped: number;
    results: Array<{ sourceId: string; kind: string; ok: boolean; skipped: boolean; skills: number; lastSyncedAt: string | null; error: string | null; errorCode: string | null }>;
  }>;
  skillsRemoveSource(sourceId: string): Promise<void>;
  parseKoreanDate(input: string, nowIso: string): Promise<string | null>;
  menuCommand(id: string): void;
}

export interface SaturationOpsConfig {
  repoA: string;
  repoB: string;
  tree: string;
  sourceA: string;
  expectedEntries: number;
}

interface OpConfigEntry {
  op: string;
  method: string;
  args: unknown[];
}

function opsConfigFor(config: SaturationOpsConfig): OpConfigEntry[] {
  return [
    { op: "git_status_a", method: "gitStatus", args: [config.repoA] },
    { op: "git_status_b", method: "gitStatus", args: [config.repoB] },
    { op: "scan_vault", method: "scanVault", args: [config.tree] },
    { op: "skills_sync_source", method: "skillsSyncSource", args: [config.sourceA] },
  ];
}

export interface FiredOutcome {
  ok: boolean;
  value?: unknown;
  error?: string;
  settleMs?: number;
}

/** Fire-and-forget bridge call whose settlement lands in a keyed webview
 *  slot the spec polls with pollBridgeCall. Each key holds at most one
 *  in-flight call; settleMs is measured in-page from dispatch to
 *  settlement. */
export async function fireBridgeCall(method: string, key: string, ...args: unknown[]): Promise<void> {
  const result = await browser.executeAsync(
    (name: string, slotKey: string, callArgs: unknown[], done: (outcome: { ok: boolean; error?: string }) => void) => {
      const bridge = window.__MARU_NATIVE_E2E__ as unknown as Record<string, (...call: unknown[]) => Promise<unknown>> | undefined;
      const fn = bridge?.[name];
      if (typeof fn !== "function") {
        done({ ok: false, error: `bridge method missing: ${name}` });
        return;
      }
      const host = window as unknown as Record<string, Record<string, unknown> | undefined>;
      // Inlined literal: executeAsync serializes only this function, so the
      // module-scope RESULTS_KEY constant is not visible in the webview.
      const slots = (host["__MARU_HARNESS_RESULTS__"] ??= {});
      slots[slotKey] = null;
      const firedAt = performance.now();
      Promise.resolve(fn(...callArgs)).then(
        (value) => {
          slots[slotKey] = { ok: true, value, settleMs: performance.now() - firedAt };
        },
        (error: unknown) => {
          slots[slotKey] = {
            ok: false,
            error:
              error && typeof error === "object" && "message" in error
                ? String((error as { message: unknown }).message)
                : String(error),
            settleMs: performance.now() - firedAt,
          };
        },
      );
      done({ ok: true });
    },
    method,
    key,
    args,
  );
  if (!result.ok) throw new Error(result.error ?? "bridge fire failed");
}

/** Poll one keyed slot until it holds a settlement or the deadline passes.
 *  Returns immediately once the fired call has settled. The slot travels in
 *  a neutral { settled } envelope: WebKit's async-script bridge surfaces a
 *  callback argument shaped like an error (an object with an `error` field)
 *  as a WebDriverError, which would turn every expected rejection into a
 *  thrown driver error instead of a settled outcome. */
export async function pollBridgeCall(key: string, timeoutMs = 90_000): Promise<FiredOutcome> {
  const result = await browser.executeAsync(
    (slotKey: string, timeout: number, done: (envelope: { settled: FiredOutcome }) => void) => {
      const host = window as unknown as Record<string, Record<string, FiredOutcome | null> | undefined>;
      const deadline = Date.now() + timeout;
      const tick = () => {
        const slot = host["__MARU_HARNESS_RESULTS__"]?.[slotKey];
        if (slot) {
          done({ settled: slot });
          return;
        }
        if (Date.now() > deadline) {
          done({ settled: { ok: false, error: `fired bridge call ${slotKey} never settled` } });
          return;
        }
        setTimeout(tick, 100);
      };
      tick();
    },
    key,
    timeoutMs,
  );
  return result.settled;
}

interface SamplerConfig {
  probeCount: number;
  parseCount: number;
  cadence: number;
  parseInput: string;
  parseNowIso: string;
  parseExpected: string;
}

interface SamplerResult {
  ok: boolean;
  error?: string;
  samples: SeriesSamples;
}

/**
 * One sampling window (probe + parse series at the target cadence,
 * performance.now()-timed around the real IPC promises). Self-contained for
 * executeAsync serialization: no module references, only window/performance
 * and the serialized config argument.
 */
async function sampleWindow(config: SaturationOpsConfig, counts: Omit<SamplerConfig, "parseInput" | "parseNowIso" | "parseExpected">): Promise<SamplerResult> {
  return browser.executeAsync(
    (cfg: SamplerConfig, done: (result: SamplerResult) => void) => {
      const bridge = (window as unknown as { __MARU_NATIVE_E2E__?: HarnessBridge }).__MARU_NATIVE_E2E__;
      const fail = (error: string) => done({ ok: false, error, samples: { probe: [], parse: [] } });
      if (!bridge || typeof bridge.asyncProbe !== "function") {
        fail("responsiveness bridge is not installed — the app is serving a frontend built without VITE_NATIVE_E2E=1");
        return;
      }
      const roundStart = performance.now();
      const run = async () => {
        const probe: SampleEntry[] = [];
        const parse: SampleEntry[] = [];
        for (let index = 0; index < cfg.probeCount; index += 1) {
          const start = performance.now();
          try {
            const value = await bridge.asyncProbe();
            probe.push({ t: start - roundStart, settle: performance.now() - start, ok: value.ok === true && value.yielded === true });
          } catch (error) {
            probe.push({ t: start - roundStart, settle: performance.now() - start, ok: false, error: String(error) });
          }
          try {
            const value = await bridge.parseKoreanDate(cfg.parseInput, cfg.parseNowIso);
            parse.push({ t: start - roundStart, settle: performance.now() - start, ok: value === cfg.parseExpected });
          } catch (error) {
            parse.push({ t: start - roundStart, settle: performance.now() - start, ok: false, error: String(error) });
          }
          const elapsed = performance.now() - start;
          if (elapsed < cfg.cadence) await new Promise((resolve) => setTimeout(resolve, cfg.cadence - elapsed));
        }
        done({ ok: true, samples: { probe, parse } });
      };
      void run().catch((error: unknown) => fail(String(error && (error as { message?: unknown }).message ? (error as { message: unknown }).message : error)));
    },
    { ...counts, parseInput: PARSE_INPUT, parseNowIso: PARSE_NOW_ISO, parseExpected: PARSE_EXPECTED },
  );
}

function emptyRound(error: string): RoundResult {
  return { ok: false, error, warmup: { probe: [], parse: [] }, idle: { probe: [], parse: [] }, loaded: { probe: [], parse: [] }, recovery: { probe: [], parse: [] }, ops: [], loadStatus: null, workerCount: 0 };
}

function opOutcomeFrom(op: OpConfigEntry, outcome: FiredOutcome): OpOutcome {
  const value = outcome.value as { length?: number; modified?: number } | undefined;
  return {
    op: op.op,
    ok: outcome.ok,
    error: outcome.error,
    settleMs: outcome.settleMs,
    entries: typeof value?.length === "number" ? value.length : undefined,
    modified: typeof value?.modified === "number" ? value.modified : undefined,
    skills: typeof value?.length === "number" ? value.length : undefined,
  };
}

/**
 * One full idle/load/recovery round, chunked into per-window driver scripts
 * so no single executeAsync outlives the WebKit script timeout. The four
 * real operations are fired from the runner between the idle and loaded
 * windows and settle on the webview-global keyed slots; the recovery window
 * opens only after every operation has settled. Sample counts are fixed; a
 * missing sample fails the round, never pads it.
 */
export async function runIsolatedRound(config: SaturationOpsConfig, label: string): Promise<RoundResult> {
  void label;
  const ops = opsConfigFor(config);
  const pre = await sampleWindow(config, { probeCount: WARMUP_SAMPLES + WINDOW_SAMPLES, parseCount: WARMUP_SAMPLES + WINDOW_SAMPLES, cadence: SAMPLE_CADENCE_MS });
  if (!pre.ok) return emptyRound(pre.error ?? "warmup/idle sampling failed");
  const warmup = { probe: pre.samples.probe.slice(0, WARMUP_SAMPLES), parse: pre.samples.parse.slice(0, WARMUP_SAMPLES) };
  const idle = { probe: pre.samples.probe.slice(WARMUP_SAMPLES), parse: pre.samples.parse.slice(WARMUP_SAMPLES) };

  for (const op of ops) {
    await fireBridgeCall(op.method, op.op, ...op.args);
  }

  const loadedResult = await sampleWindow(config, { probeCount: WINDOW_SAMPLES, parseCount: WINDOW_SAMPLES, cadence: SAMPLE_CADENCE_MS });
  if (!loadedResult.ok) return emptyRound(loadedResult.error ?? "loaded sampling failed");

  const opOutcomes: OpOutcome[] = [];
  for (const op of ops) {
    opOutcomes.push(opOutcomeFrom(op, await pollBridgeCall(op.op)));
  }

  const post = await browser.executeAsync(
    (done: (result: { ok: boolean; error?: string; recovery: SeriesSamples; loadStatus: unknown; workerCount: number }) => void) => {
      const bridge = (window as unknown as { __MARU_NATIVE_E2E__?: HarnessBridge }).__MARU_NATIVE_E2E__;
      if (!bridge || typeof bridge.asyncProbe !== "function") {
        done({ ok: false, error: "responsiveness bridge is not installed", recovery: { probe: [], parse: [] }, loadStatus: null, workerCount: 0 });
        return;
      }
      const roundStart = performance.now();
      const run = async () => {
        const probe: SampleEntry[] = [];
        const parse: SampleEntry[] = [];
        for (let index = 0; index < 120; index += 1) {
          const start = performance.now();
          try {
            const value = await bridge.asyncProbe();
            probe.push({ t: start - roundStart, settle: performance.now() - start, ok: value.ok === true && value.yielded === true });
          } catch (error) {
            probe.push({ t: start - roundStart, settle: performance.now() - start, ok: false, error: String(error) });
          }
          try {
            const value = await bridge.parseKoreanDate("내일", "2026-09-05T09:00:00+09:00");
            parse.push({ t: start - roundStart, settle: performance.now() - start, ok: value === "2026-09-06T09:00:00+09:00" });
          } catch (error) {
            parse.push({ t: start - roundStart, settle: performance.now() - start, ok: false, error: String(error) });
          }
          const elapsed = performance.now() - start;
          if (elapsed < 25) await new Promise((resolve) => setTimeout(resolve, 25 - elapsed));
        }
        const loadStatus = await bridge.loadControl({ action: "status" });
        const probeCheck = await bridge.asyncProbe();
        done({
          ok: true,
          recovery: { probe, parse },
          loadStatus,
          workerCount: typeof probeCheck.workerCount === "number" ? probeCheck.workerCount : 0,
        });
      };
      void run().catch((error: unknown) => done({ ok: false, error: String(error && (error as { message?: unknown }).message ? (error as { message: unknown }).message : error), recovery: { probe: [], parse: [] }, loadStatus: null, workerCount: 0 }));
    },
  );
  if (!post.ok) return emptyRound(post.error ?? "recovery sampling failed");

  return {
    ok: true,
    warmup,
    idle,
    loaded: loadedResult.samples,
    recovery: post.recovery,
    ops: opOutcomes,
    loadStatus: post.loadStatus,
    workerCount: post.workerCount,
  };
}

/**
 * Negative-control round: the same four operations are routed back onto the
 * async workers (blocking_async mode) so both runtime workers stall. Probe
 * and parse calls are fired as concurrent bursts whose promise arrays stay
 * on a webview global until a follow-up script collects them: awaiting each
 * one sequentially would serialize the measurement and hide the queueing
 * delay this control must demonstrate.
 */
export async function runNegativeRound(config: SaturationOpsConfig, bursts = 60, burstCadenceMs = 100): Promise<RoundResult> {
  const ops = opsConfigFor(config);
  const pre = await sampleWindow(config, { probeCount: 50, parseCount: 50, cadence: SAMPLE_CADENCE_MS });
  if (!pre.ok) return emptyRound(pre.error ?? "warmup/idle sampling failed");
  const warmup = { probe: pre.samples.probe.slice(0, 10), parse: pre.samples.parse.slice(0, 10) };
  const idle = { probe: pre.samples.probe.slice(10), parse: pre.samples.parse.slice(10) };

  for (const op of ops) {
    await fireBridgeCall(op.method, op.op, ...op.args);
  }

  const dispatch = await browser.executeAsync(
    (cfg: { bursts: number; cadenceMs: number }, done: (result: { ok: boolean; error?: string }) => void) => {
      const bridge = (window as unknown as { __MARU_NATIVE_E2E__?: HarnessBridge }).__MARU_NATIVE_E2E__;
      if (!bridge || typeof bridge.asyncProbe !== "function") {
        done({ ok: false, error: "responsiveness bridge is not installed" });
        return;
      }
      const host = window as unknown as Record<string, unknown>;
      const probe: Array<Promise<SampleEntry>> = [];
      const parse: Array<Promise<SampleEntry>> = [];
      const run = async () => {
        for (let index = 0; index < cfg.bursts; index += 1) {
          const start = performance.now();
          probe.push(
            Promise.resolve(bridge.asyncProbe()).then(
              (value) => ({ t: start, settle: performance.now() - start, ok: value.ok === true }),
              (error: unknown) => ({ t: start, settle: performance.now() - start, ok: false, error: String(error) }),
            ),
          );
          await new Promise((resolve) => setTimeout(resolve, cfg.cadenceMs));
        }
        for (let index = 0; index < 20; index += 1) {
          const start = performance.now();
          parse.push(
            Promise.resolve(bridge.parseKoreanDate("내일", "2026-09-05T09:00:00+09:00")).then(
              (value) => ({ t: start, settle: performance.now() - start, ok: value === "2026-09-06T09:00:00+09:00" }),
              (error: unknown) => ({ t: start, settle: performance.now() - start, ok: false, error: String(error) }),
            ),
          );
          await new Promise((resolve) => setTimeout(resolve, cfg.cadenceMs));
        }
        host.__MARU_HARNESS_NEG__ = { probe, parse };
        done({ ok: true });
      };
      void run().catch((error: unknown) => done({ ok: false, error: String(error) }));
    },
    { bursts, cadenceMs: burstCadenceMs },
  );
  if (!dispatch.ok) return emptyRound(dispatch.error ?? "negative-control burst dispatch failed");

  const collect = await browser.executeAsync(
    (done: (result: { ok: boolean; error?: string; loaded: SeriesSamples; loadStatus: unknown; workerCount: number }) => void) => {
      const bridge = (window as unknown as { __MARU_NATIVE_E2E__?: HarnessBridge }).__MARU_NATIVE_E2E__;
      const host = window as unknown as Record<string, { probe: Array<Promise<SampleEntry>>; parse: Array<Promise<SampleEntry>> } | undefined>;
      const pending = host.__MARU_HARNESS_NEG__;
      if (!bridge || !pending) {
        done({ ok: false, error: "negative-control burst promises missing", loaded: { probe: [], parse: [] }, loadStatus: null, workerCount: 0 });
        return;
      }
      void Promise.all(pending.probe)
        .then((probe) => Promise.all(pending.parse).then((parse) => ({ probe, parse })))
        .then(async (loaded) => {
          const loadStatus = await bridge.loadControl({ action: "status" });
          const probeCheck = await bridge.asyncProbe();
          host.__MARU_HARNESS_NEG__ = undefined;
          done({ ok: true, loaded, loadStatus, workerCount: typeof probeCheck.workerCount === "number" ? probeCheck.workerCount : 0 });
        })
        .catch((error: unknown) => done({ ok: false, error: String(error), loaded: { probe: [], parse: [] }, loadStatus: null, workerCount: 0 }));
    },
  );
  if (!collect.ok) return emptyRound(collect.error ?? "negative-control collection failed");

  const opOutcomes: OpOutcome[] = [];
  for (const op of ops) {
    opOutcomes.push(opOutcomeFrom(op, await pollBridgeCall(op.op)));
  }

  const post = await sampleWindow(config, { probeCount: 40, parseCount: 40, cadence: SAMPLE_CADENCE_MS });
  if (!post.ok) return emptyRound(post.error ?? "recovery sampling failed");

  return {
    ok: true,
    warmup,
    idle,
    loaded: collect.loaded,
    recovery: post.samples,
    ops: opOutcomes,
    loadStatus: collect.loadStatus,
    workerCount: collect.workerCount,
  };
}

export function seriesStats(samples: SampleEntry[], expectedCount: number): SeriesStats {
  const settles = samples.map((sample) => sample.settle).sort((a, b) => a - b);
  const count = settles.length;
  const pick = (q: number) => (count === 0 ? 0 : settles[Math.min(count - 1, Math.ceil((q / 100) * count) - 1)] ?? 0);
  return {
    count,
    missing: expectedCount - count,
    median: pick(50),
    p95: pick(95),
    max: count === 0 ? 0 : settles[count - 1],
  };
}

export function roundStats(round: RoundResult): RoundStats {
  const probe = {
    idle: seriesStats(round.idle.probe, round.idle.probe.length),
    loaded: seriesStats(round.loaded.probe, round.loaded.probe.length),
    recovery: seriesStats(round.recovery.probe, round.recovery.probe.length),
  };
  const parse = {
    idle: seriesStats(round.idle.parse, round.idle.parse.length),
    loaded: seriesStats(round.loaded.parse, round.loaded.parse.length),
    recovery: seriesStats(round.recovery.parse, round.recovery.parse.length),
  };
  const maxStall = Math.max(
    probe.loaded.max,
    probe.recovery.max,
    parse.loaded.max,
    parse.recovery.max,
  );
  return { probe, parse, maxStall };
}

/** Frozen bound: loaded/recovery p95 must stay at or under
 * max(idleP95 * 2, idleP95 + 25ms). */
export function frozenBound(idleP95: number): number {
  return Math.max(idleP95 * 2, idleP95 + 25);
}

export function buildRevision(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

export async function writeArtifact(name: string, data: unknown): Promise<void> {
  const dir = path.resolve("artifacts/native-responsiveness");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), JSON.stringify(data, null, 2), "utf8");
}

export async function readArtifact<T>(name: string): Promise<T> {
  return JSON.parse(await fs.readFile(path.resolve("artifacts/native-responsiveness", name), "utf8")) as T;
}

export async function sha256File(filePath: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const content = await fs.readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}
