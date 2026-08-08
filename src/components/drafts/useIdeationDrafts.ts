import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri, listAiMissions, readScratchpadDocument } from "../../lib/api";
import {
  agentErrorMessage,
  requireAgent,
  runAgent,
  type AgentRecord,
} from "../../lib/agents";
import { setError } from "../../lib/errorStore";
import { useTranslation } from "../../lib/i18n";
import {
  activeImplementationDraft,
  buildIdeateToDraftPrompt,
  IDEATION_DRAFTS_SKILL_NAME,
  IMPLEMENTATION_DRAFT_MISSION_KIND,
  implementationDraftMissionIdeaPath,
  ingestImplementationDraftRun,
  isCompletedImplementationDraftMission,
} from "../../lib/ideationDrafts";
import type { AiSettings } from "../../lib/settings";
import type { SkillRecord } from "../../lib/skills";
import type { DraftEntry, MissionRecord, ScratchpadEntry } from "../../lib/types";

interface UseIdeationDraftsParams {
  workPath: string | null;
  skills: SkillRecord[];
  agents: AgentRecord[];
  ai: AiSettings;
  drafts: DraftEntry[];
  /** Opens a draft in the detail column (existing or freshly ingested). */
  onOpenDraft: (draft: DraftEntry) => void;
  /** Re-lists drafts after an ingestion created one. */
  onDraftsChanged: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


/**
 * Ideation -> implementation-draft mission lifecycle.
 *
 * Dispatch: `generate` runs `ideation-drafts ideate-to-draft` in the
 * background with {kind: "implementation-draft", ideaPath} metadata, guarded
 * against in-flight runs and existing non-discarded drafts for the idea.
 *
 * Completion: a done mission's run events carry one
 * `maru_implementation_draft_v1` artifact, ingested into Drafts once per
 * run — live via `ai://mission_update`, and on mount for runs that finished
 * while the pane was unmounted (same pattern as useTaskCandidateIngestion).
 */
export function useIdeationDrafts({
  workPath,
  skills,
  agents,
  ai,
  drafts,
  onOpenDraft,
  onDraftsChanged,
}: UseIdeationDraftsParams) {
  const { t } = useTranslation();
  /** ideaPath -> runId for missions known to be in flight. */
  const [pendingRuns, setPendingRuns] = useState<Record<string, string>>({});
  const pendingRunsRef = useRef(pendingRuns);

  useEffect(() => {
    pendingRunsRef.current = pendingRuns;
  }, [pendingRuns]);

  const clearPending = useCallback((runId: string) => {
    setPendingRuns((current) => {
      if (!Object.values(current).includes(runId)) return current;
      const next = Object.fromEntries(
        Object.entries(current).filter(([, pendingRunId]) => pendingRunId !== runId),
      );
      pendingRunsRef.current = next;
      return next;
    });
  }, []);

  const markPending = useCallback((ideaPath: string, runId: string) => {
    const next = { ...pendingRunsRef.current, [ideaPath]: runId };
    pendingRunsRef.current = next;
    setPendingRuns(next);
  }, []);

  // Once-per-run and mutual exclusion live in ingestImplementationDraftRun, not
  // here: this hook remounts on every mode switch while mission records are
  // process-global, so a ref-based guard replayed every completed run and
  // resurrected drafts the user had discarded.
  const ingestRun = useCallback(
    async (runId: string, ideaPath: string, autoOpen: boolean) => {
      if (!workPath) return;
      try {
        const result = await ingestImplementationDraftRun(workPath, runId, ideaPath);
        if (!result?.created) return;
        onDraftsChanged();
        if (autoOpen) onOpenDraft(result.created);
      } catch (error) {
        setError(errorMessage(error));
      } finally {
        // Keep the idea locked through artifact read/list/create bookkeeping;
        // stage and save mutations must not race the lineage write here.
        clearPending(runId);
      }
    },
    [clearPending, onDraftsChanged, onOpenDraft, workPath],
  );

  // Mount scan: pick up missions that started or finished while the pane was
  // unmounted — running ones restore the in-progress indicator, done ones get
  // ingested (without stealing the current selection).
  useEffect(() => {
    if (!workPath) return;
    let cancelled = false;
    void listAiMissions()
      .then((missions) => {
        if (cancelled) return;
        const running: Record<string, string> = {};
        for (const mission of missions) {
          const ideaPath = implementationDraftMissionIdeaPath(mission);
          if (!ideaPath) continue;
          if (mission.status === "running" || mission.status === "idle") {
            running[ideaPath] = mission.id;
          }
        }
        const completed = missions
          .filter(isCompletedImplementationDraftMission)
          .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
        const nextPending = { ...pendingRunsRef.current, ...running };
        for (const mission of completed) {
          const ideaPath = implementationDraftMissionIdeaPath(mission);
          if (ideaPath) nextPending[ideaPath] = mission.id;
        }
        pendingRunsRef.current = nextPending;
        setPendingRuns((current) => {
          const keys = Object.keys(nextPending);
          const unchanged =
            keys.length === Object.keys(current).length &&
            keys.every((key) => nextPending[key] === current[key]);
          return unchanged ? current : nextPending;
        });
        for (const mission of completed) {
          const ideaPath = implementationDraftMissionIdeaPath(mission);
          if (ideaPath) void ingestRun(mission.id, ideaPath, false);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [ingestRun, workPath]);

  // Live completions. Auto-opens the new draft only when this session
  // initiated the run.
  useEffect(() => {
    if (!workPath || !isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen<MissionRecord>("ai://mission_update", (event) => {
      if (disposed) return;
      const mission = event.payload;
      const ideaPath = implementationDraftMissionIdeaPath(mission);
      if (!ideaPath) return;
      if (mission.status === "done") {
        const initiatedHere = Object.values(pendingRunsRef.current).includes(mission.id);
        void ingestRun(mission.id, ideaPath, initiatedHere);
      } else if (mission.status === "failed" || mission.status === "stopped") {
        clearPending(mission.id);
      }
    })
      .then((off) => {
        unlisten = off;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [clearPending, ingestRun, workPath]);

  const generate = useCallback(
    async (idea: ScratchpadEntry) => {
      if (!workPath) return;
      const ideaPath = idea.relativePath;
      // Guard: no second run while one is in flight; an existing
      // non-discarded draft is opened instead of duplicated.
      if (pendingRunsRef.current[ideaPath]) return;
      const existing = activeImplementationDraft(drafts, ideaPath);
      if (existing) {
        onOpenDraft(existing);
        return;
      }
      setError(null);
      try {
        const doc = await readScratchpadDocument(workPath, "ideation", ideaPath);
        // Gains the runtime-availability probe and the command-override /
        // permission-mode threading this call site used to skip.
        const runId = await runAgent(requireAgent(agents, "ideation-draft"), {
          skills,
          ai,
          workPath,
          prompt: buildIdeateToDraftPrompt({
            title: idea.name,
            relativePath: ideaPath,
            content: doc.content,
          }),
          context: [{ path: ideaPath, kind: "file" }],
          metadata: {
            origin: "ideationDraft",
            kind: IMPLEMENTATION_DRAFT_MISSION_KIND,
            ideaPath,
            ideaName: idea.name,
          },
        });
        markPending(ideaPath, runId);
      } catch (error) {
        setError(agentErrorMessage(error, t));
      }
    },
    [agents, ai, drafts, markPending, onOpenDraft, skills, t, workPath],
  );

  return { pendingIdeaPaths: new Set(Object.keys(pendingRuns)), generate };
}
