import { useEffect } from "react";
import type { MutableRefObject } from "react";

// ---------------------------------------------------------------------------
// ai://output stream subscription (extracted from MainApp in step 9): appends
// output lines of tracked missions into processingLogLines, capped at the
// last 120 lines per mission. The log state itself stays in MainApp (other
// writers: the mission-completion diff and the mission-start seeders), so the
// setter arrives as a param alongside the tracked-ids ref.
// ---------------------------------------------------------------------------

export interface AiOutputEvent {
  invocationId: string;
  stream: string;
  line: string;
}

export function useAiOutputLog(
  trackedIdsRef: MutableRefObject<ReadonlySet<string>>,
  setProcessingLogLines: (
    updater: (current: Record<string, string[]>) => Record<string, string[]>,
  ) => void,
): void {
  useEffect(() => {
    let cancelled = false;
    let unlistenOutput: (() => void) | null = null;
    void import("@tauri-apps/api/event")
      .then(async ({ listen }) => {
        const offOutput = await listen<AiOutputEvent>("ai://output", (event) => {
          const payload = event.payload;
          if (!trackedIdsRef.current.has(payload.invocationId)) return;
          const line = `[${payload.stream}] ${payload.line}`;
          setProcessingLogLines((current) => {
            const lines = [...(current[payload.invocationId] ?? []), line].slice(-120);
            return { ...current, [payload.invocationId]: lines };
          });
        });
        if (cancelled) {
          offOutput();
        } else {
          unlistenOutput = offOutput;
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlistenOutput?.();
    };
  }, [trackedIdsRef, setProcessingLogLines]);
}
