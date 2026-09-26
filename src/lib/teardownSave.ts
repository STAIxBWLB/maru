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
  settle: () => Promise<void>;
}

// Module-private registry of mounted savers. A later quit-flush step walks
// this set to settle every mounted autosave surface before the app exits.
const teardownSaves = new Set<TeardownSaveEntry>();

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

function settleTeardownSave<T>(
  saver: SettlingDebouncedSaver<T>,
  describe: (value: T) => TeardownSaveTarget | null,
  t: Translate,
): Promise<void> {
  return saver.flushSettled().then((settlement) => {
    if (settlement.status !== "failed") return;
    const target = describe(settlement.value);
    if (!target) return;
    return reportTeardownSaveFailure(target, settlement.error, t);
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
  describeRef.current = describe;
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    if (!saver) return undefined;
    const entry: TeardownSaveEntry = {
      settle: () => settleTeardownSave(saver, (value) => describeRef.current(value), tRef.current),
    };
    teardownSaves.add(entry);
    return () => {
      teardownSaves.delete(entry);
      void entry.settle();
    };
  }, [saver]);
}
