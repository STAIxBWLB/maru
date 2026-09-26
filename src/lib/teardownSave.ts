import { useEffect, useRef } from "react";
import type { SettlingDebouncedSaver } from "./debouncedSave";
import { publishOperationNotice, setError, type OperationNotice } from "./errorStore";
import { writeRecoveryCopy } from "./maruDir";

export type Translate = (key: string, vars?: Record<string, string | number>) => string;

export interface TeardownSaveTarget {
  workPath: string;
  filePath: string;
  content: string;
}

interface TeardownSaveEntry {
  settle: () => Promise<"failed" | "ok">;
}

// Module-private registry of mounted savers. A later quit-flush step walks
// this set to settle every mounted autosave surface before the app exits.
const teardownSaves = new Set<TeardownSaveEntry>();

/** Budget for flushPendingSavesForQuit (D-04): the quit path waits this long
 * for every mounted autosave surface to settle before giving up. */
export const QUIT_FLUSH_BUDGET_MS = 3000;

export type QuitFlushOutcome =
  | { kind: "clean" }
  | { kind: "failed"; failures: number }
  | { kind: "timeout" };

let saveFailureCounter = 0;

/**
 * Reports a failed teardown save (D-07, D-08): keeps the unsaved content as a
 * real recovery file under `.maru/recovery/`, raises a toast naming the file
 * and the reason (with an "Open recovery copy" action when the copy
 * succeeded), and logs one line. Never puts `target.content` into the
 * message or the log. Also clears the single-slot error toast a surface may
 * have raised for this same failure, so it is not shown twice.
 */
export async function reportTeardownSaveFailure(
  target: TeardownSaveTarget,
  error: unknown,
  t: Translate,
): Promise<void> {
  const reason = error instanceof Error ? error.message : String(error);
  let recovery: { workPath: string; path: string } | undefined;
  let copyReason: string | undefined;
  try {
    const path = await writeRecoveryCopy(target.workPath, target.filePath, target.content, reason);
    recovery = { workPath: target.workPath, path };
  } catch (writeError) {
    copyReason = writeError instanceof Error ? writeError.message : String(writeError);
  }

  const message = recovery
    ? t("save.teardown.failed", { file: target.filePath, reason })
    : t("save.teardown.failedNoCopy", { file: target.filePath, reason });
  const notice: OperationNotice = recovery
    ? { operationId: `save-failure:${saveFailureCounter++}`, kind: "error", message, recovery }
    : { operationId: `save-failure:${saveFailureCounter++}`, kind: "error", message };
  publishOperationNotice(notice);

  console.error(
    recovery
      ? `[save] teardown save failed for ${target.filePath}: ${reason}; kept ${recovery.path}`
      : `[save] teardown save failed for ${target.filePath}: ${reason}; recovery copy failed: ${copyReason}`,
  );

  setError((current) => (current === reason ? null : current));
}

export function settleTeardownSave<T>(
  saver: SettlingDebouncedSaver<T>,
  describe: (value: T) => TeardownSaveTarget | null,
  t: Translate,
): Promise<"failed" | "ok"> {
  return saver.flushSettled().then((settlement) => {
    if (settlement.status !== "failed") return "ok";
    const target = describe(settlement.value);
    if (!target) return "ok";
    return reportTeardownSaveFailure(target, settlement.error, t).then(() => "failed" as const);
  });
}

/**
 * Flushes every mounted autosave surface for an app quit (D-03, D-04): with
 * no registered surfaces resolves `clean` immediately with no timer armed;
 * otherwise settles each one and races the settles against `budgetMs`. A
 * failed settlement is reported (recovery copy + toast, via
 * `reportTeardownSaveFailure` inside `settleTeardownSave`) whenever it lands,
 * even after the budget already expired and this promise resolved `timeout`
 * — that in-flight settle keeps running and still reports on its own.
 */
export function flushPendingSavesForQuit(
  budgetMs: number = QUIT_FLUSH_BUDGET_MS,
): Promise<QuitFlushOutcome> {
  const entries = Array.from(teardownSaves);
  if (entries.length === 0) {
    return Promise.resolve({ kind: "clean" });
  }

  return new Promise<QuitFlushOutcome>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ kind: "timeout" });
    }, budgetMs);

    void Promise.all(entries.map((entry) => entry.settle())).then((results) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const failures = results.filter((result) => result === "failed").length;
      resolve(failures > 0 ? { kind: "failed", failures } : { kind: "clean" });
    });
  });
}

/**
 * Registers a mounted saver so its pending/in-flight work is settled — never
 * merely cancelled — when the caller unmounts or swaps to a different saver.
 * A failed settlement is reported via `reportTeardownSaveFailure` (a
 * recovery copy, a toast, and a log line — D-07, D-08).
 */
export function useTeardownFlush<T>(
  saver: SettlingDebouncedSaver<T> | null,
  describe: (value: T) => TeardownSaveTarget | null,
  t: Translate,
): void {
  const describeRef = useRef(describe);
  const tRef = useRef(t);
  // Refreshed after commit, not during render: React runs the saver effect's
  // cleanup below before this effect's next run, so a saver swapped out in
  // place (StudioMode is not keyed by workspace) still sees its own last
  // render's describe rather than its successor's workspace, or none.
  useEffect(() => {
    describeRef.current = describe;
    tRef.current = t;
  });

  useEffect(() => {
    if (!saver) return undefined;
    const entry: TeardownSaveEntry = {
      settle: () => settleTeardownSave(saver, (value) => describeRef.current(value), tRef.current),
    };
    teardownSaves.add(entry);
    return () => {
      teardownSaves.delete(entry);
      // Pin them now: the flush settles only after the successor's commit.
      void settleTeardownSave(saver, describeRef.current, tRef.current);
    };
  }, [saver]);
}
