// Task-candidate ingestion: a completed scheduled skill run may print one
// `maru_task_candidates_v1` artifact, which becomes task drafts.
//
// This lives with Drafts, not with Agents, on purpose: ingestion only runs
// while its host component is mounted, and the drafts it creates appear in the
// Drafts pane. Hosting it beside the schedule list — which is where it used to
// live — would silently stop ingestion unless the user happened to be sitting
// in that mode.
//
// Once-per-run and mutual exclusion live in `ingestTaskCandidateRun` at module
// scope, not here: the host remounts on every mode switch while mission records
// are process-global, so a ref-based guard replayed every completed run.

import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import { isTauri, listAiMissions } from "../../lib/api";
import type { AiTaskIngestMinImportance } from "../../lib/settings";
import {
  ingestTaskCandidateRun,
  isCompletedSchedulerSkillMission,
  type TaskIngestResult,
} from "../../lib/taskIngestion";
import type { MissionRecord } from "../../lib/types";

export interface UseTaskCandidateIngestionParams {
  workPath: string | null;
  minImportance: AiTaskIngestMinImportance;
  onDraftsIngested: () => void;
  onError: (message: string) => void;
}

export function useTaskCandidateIngestion({
  workPath,
  minImportance,
  onDraftsIngested,
  onError,
}: UseTaskCandidateIngestionParams): {
  ingesting: boolean;
  lastIngest: TaskIngestResult | null;
} {
  const [ingesting, setIngesting] = useState(false);
  const [lastIngest, setLastIngest] = useState<TaskIngestResult | null>(null);

  const ingestRun = useCallback(
    async (runId: string) => {
      if (!workPath) return;
      setIngesting(true);
      try {
        const result = await ingestTaskCandidateRun(workPath, runId, minImportance);
        if (!result) return;
        setLastIngest(result);
        if (result.created > 0) onDraftsIngested();
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error));
      } finally {
        setIngesting(false);
      }
    },
    [minImportance, onDraftsIngested, onError, workPath],
  );

  // Runs that finished while the pane was unmounted.
  useEffect(() => {
    if (!workPath) return;
    let cancelled = false;
    void listAiMissions()
      .then((missions) => {
        if (cancelled) return;
        const completed = missions
          .filter(isCompletedSchedulerSkillMission)
          .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
        for (const mission of completed) {
          void ingestRun(mission.id);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [ingestRun, workPath]);

  // Live completions.
  useEffect(() => {
    if (!workPath || !isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen<MissionRecord>("ai://mission_update", (event) => {
      if (disposed || !isCompletedSchedulerSkillMission(event.payload)) return;
      void ingestRun(event.payload.id);
    })
      .then((off) => {
        unlisten = off;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [ingestRun, workPath]);

  return { ingesting, lastIngest };
}
