import { useEffect, useRef } from "react";
import type { SettlingDebouncedSaver } from "./debouncedSave";

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

function settleTeardownSave<T>(
  saver: SettlingDebouncedSaver<T>,
  describe: (value: T) => TeardownSaveTarget | null,
): Promise<void> {
  return saver.flushSettled().then((settlement) => {
    if (settlement.status !== "failed") return;
    const target = describe(settlement.value);
    if (!target) return;
    const reason =
      settlement.error instanceof Error ? settlement.error.message : String(settlement.error);
    // Never log content — only the file label and the failure reason.
    console.error(`[save] teardown save failed for ${target.filePath}: ${reason}`);
  });
}

/**
 * Registers a mounted saver so its pending/in-flight work is settled — never
 * merely cancelled — when the caller unmounts or swaps to a different saver.
 *
 * `t` is threaded through now even though its first consumer (the failure
 * toast) lands in a later plan; defining the full signature here lets every
 * autosave surface wire this hook once instead of twice.
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
      settle: () => settleTeardownSave(saver, (value) => describeRef.current(value)),
    };
    teardownSaves.add(entry);
    return () => {
      teardownSaves.delete(entry);
      void entry.settle();
    };
  }, [saver]);
}
