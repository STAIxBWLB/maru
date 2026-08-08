import { listen } from "@tauri-apps/api/event";
import { Check, FileDiff, Lightbulb, PenLine, RefreshCcw, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApprovalInput } from "../../approval/ApprovalDialog";
import {
  createScratchpadIdea,
  discardDraft,
  isTauri,
  listDrafts,
  listScratchpad,
  readDraft,
  readScratchpadDocument,
  saveDraft,
  saveScratchpadDocument,
  setDraftStatus,
  transitionScratchpadIdea,
} from "../../lib/api";
import { formatRelativeDate } from "../../lib/document";
import {
  countImplementationDraftsByIdea,
  implementationDraftsForIdea,
} from "../../lib/ideationDrafts";
import {
  draftItemId,
  draftItemKind,
  draftItemTitle,
  draftItemUpdatedAt,
  filterDraftItems,
  formatConfidence,
  mergeDraftItems,
  sortDraftItemsNewestFirst,
  type DraftKindFilter,
  type DraftListItem,
  type DraftStatusFilter,
} from "../../lib/drafts";
import type { AgentRecord } from "../../lib/agents";
import { setError } from "../../lib/errorStore";
import { useTranslation } from "../../lib/i18n";
import { renderMarkdown } from "../../lib/markdown";
import type { AiRuntime, AiSettings, AiTaskIngestMinImportance } from "../../lib/settings";
import type { SkillRecord } from "../../lib/skills";
import type {
  DraftDocument,
  DraftEntry,
  DraftKind,
  DraftStatus,
  DraftsChangedEvent,
  IdeationStage,
  ScratchpadChangedEvent,
  ScratchpadDocument,
  ScratchpadEntry,
} from "../../lib/types";
import { Button, IconButton } from "../ui/Button";
import { CompactSelect, EmptyState, ModeHeader, StatusBanner } from "../ui/ModeChrome";
import { NewDraftDialog } from "./NewDraftDialog";
import { PromoteDraftDialog } from "./PromoteDraftDialog";
import { useIdeationDrafts } from "./useIdeationDrafts";
import { useTaskCandidateIngestion } from "./useTaskCandidateIngestion";

interface DraftsPaneProps {
  workPath: string | null;
  skills: SkillRecord[];
  defaultRuntime: AiRuntime;
  agents: AgentRecord[];
  ai: AiSettings;
  taskIngestMinImportance: AiTaskIngestMinImportance;
  onTaskIngestMinImportanceChange: (value: AiTaskIngestMinImportance) => void;
  onConfirmApproval: (input: ApprovalInput) => Promise<string | null>;
  /** Switches to the Agents mode, which now owns schedules. */
  onOpenAgents: () => void;
  /** Switches to gap-analysis mode with this draft preselected. */
  onOpenGapAnalysis?: (draftId: string) => void;
}

const KIND_FILTERS: DraftKindFilter[] = ["all", "task", "idea", "implementation"];
const STATUS_FILTERS: DraftStatusFilter[] = [
  "open",
  "new",
  "in-review",
  "accepted",
  "discarded",
  "all",
];

const IDEATION_STAGE_TRANSITIONS: Record<IdeationStage, IdeationStage[]> = {
  seed: ["developing", "archive"],
  developing: ["proposal", "archive"],
  proposal: ["archive"],
  archive: ["seed"],
};

type SaveState = "idle" | "saving" | "saved" | "error";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function DraftsPane({
  workPath,
  skills,
  defaultRuntime,
  agents,
  ai,
  taskIngestMinImportance,
  onTaskIngestMinImportanceChange,
  onConfirmApproval,
  onOpenAgents,
  onOpenGapAnalysis,
}: DraftsPaneProps) {
  const { t, locale } = useTranslation();
  const [drafts, setDrafts] = useState<DraftEntry[]>([]);
  const [ideas, setIdeas] = useState<ScratchpadEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<DraftKindFilter>("all");
  const [statusFilter, setStatusFilter] = useState<DraftStatusFilter>("open");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DraftDocument | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [editing, setEditing] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [ideaDetail, setIdeaDetail] = useState<ScratchpadDocument | null>(null);
  const [ideaEditContent, setIdeaEditContent] = useState("");
  const [ideaEditing, setIdeaEditing] = useState(false);
  const [ideaSaveState, setIdeaSaveState] = useState<SaveState>("idle");
  const [ideaMutationBusy, setIdeaMutationBusy] = useState(false);
  const [promoteTarget, setPromoteTarget] = useState<DraftEntry | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const detailReadSequenceRef = useRef(0);
  const ideaMutationRef = useRef(false);

  // Held in a ref, not read from state, so the open/promote callbacks keep a
  // stable identity while the user types — onOpenDraft feeds useIdeationDrafts'
  // effects, and a per-keystroke identity change would re-run its mount scan.
  const dirtyRef = useRef(false);
  useEffect(() => {
    dirtyRef.current =
      (editing && detail !== null && editContent !== detail.content) ||
      (ideaEditing && ideaDetail !== null && ideaEditContent !== ideaDetail.content);
  }, [detail, editContent, editing, ideaDetail, ideaEditContent, ideaEditing]);

  const confirmDiscardEdits = useCallback(
    () => !dirtyRef.current || window.confirm(t("drafts.discardEdits")),
    [t],
  );

  const beginIdeaMutation = useCallback(() => {
    if (ideaMutationRef.current) return false;
    ideaMutationRef.current = true;
    setIdeaMutationBusy(true);
    return true;
  }, []);

  const endIdeaMutation = useCallback(() => {
    ideaMutationRef.current = false;
    setIdeaMutationBusy(false);
  }, []);

  const refresh = useCallback(async () => {
    if (!workPath) {
      setDrafts([]);
      setIdeas([]);
      return;
    }
    setLoading(true);
    setLocalError(null);
    try {
      const [nextDrafts, scratchpad] = await Promise.all([
        listDrafts(workPath),
        listScratchpad(workPath),
      ]);
      setDrafts(nextDrafts);
      setIdeas(scratchpad.filter((entry) => entry.collection === "ideation"));
    } catch (error) {
      const message = errorMessage(error);
      setLocalError(message);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [workPath]);

  useEffect(() => {
    detailReadSequenceRef.current += 1;
    setSelectedId(null);
    setDetail(null);
    setIdeaDetail(null);
    setIdeaEditContent("");
    setIdeaEditing(false);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!workPath || !isTauri()) return;
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const setup = async () => {
      unlisteners.push(
        await listen<DraftsChangedEvent>("drafts://changed", (event) => {
          if (disposed || event.payload.workPath !== workPath) return;
          void refresh();
        }),
        await listen<ScratchpadChangedEvent>("scratchpad://changed", (event) => {
          if (disposed || event.payload.workPath !== workPath) return;
          void refresh();
        }),
      );
      if (disposed) unlisteners.forEach((unlisten) => unlisten());
    };
    void setup().catch(() => undefined);
    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [refresh, workPath]);

  const items = useMemo(
    () =>
      sortDraftItemsNewestFirst(
        filterDraftItems(mergeDraftItems(drafts, ideas), kindFilter, statusFilter),
      ),
    [drafts, ideas, kindFilter, statusFilter],
  );

  const openDraft = useCallback(
    async (draft: DraftEntry) => {
      if (!workPath || !confirmDiscardEdits()) return;
      const requestId = ++detailReadSequenceRef.current;
      setSelectedId(draftItemId({ itemKind: "draft", draft }));
      setIdeaDetail(null);
      setIdeaEditing(false);
      setDetailLoading(true);
      setLocalError(null);
      try {
        let doc = await readDraft(workPath, draft.id);
        if (detailReadSequenceRef.current !== requestId) return;
        // Opening a fresh draft moves it into review.
        if (doc.status === "new") {
          const updated = await setDraftStatus(workPath, doc.id, "in-review");
          if (detailReadSequenceRef.current !== requestId) return;
          doc = { ...doc, status: updated.status, updatedAt: updated.updatedAt };
          setDrafts((current) =>
            current.map((entry) => (entry.id === updated.id ? updated : entry)),
          );
        }
        if (detailReadSequenceRef.current !== requestId) return;
        setDetail(doc);
        setEditContent(doc.content);
        setEditing(false);
        setSaveState("idle");
      } catch (error) {
        if (detailReadSequenceRef.current !== requestId) return;
        const message = errorMessage(error);
        setLocalError(message);
        setError(message);
      } finally {
        if (detailReadSequenceRef.current === requestId) setDetailLoading(false);
      }
    },
    [confirmDiscardEdits, workPath],
  );

  const handleOpenDraft = useCallback((draft: DraftEntry) => void openDraft(draft), [openDraft]);
  const handleDraftsChanged = useCallback(() => void refresh(), [refresh]);

  // Ingestion has to live here, not with the schedules: it only runs while its
  // host is mounted, and the drafts it creates land in this pane.
  const { ingesting, lastIngest } = useTaskCandidateIngestion({
    workPath,
    minImportance: taskIngestMinImportance,
    onDraftsIngested: handleDraftsChanged,
  });

  const { pendingIdeaPaths, generate: generateIdea } = useIdeationDrafts({
    workPath,
    skills,
    agents,
    ai,
    drafts,
    onOpenDraft: handleOpenDraft,
    onDraftsChanged: handleDraftsChanged,
  });

  const generate = useCallback(
    async (idea: ScratchpadEntry) => {
      if (!beginIdeaMutation()) return;
      try {
        await generateIdea(idea);
      } finally {
        endIdeaMutation();
      }
    },
    [beginIdeaMutation, endIdeaMutation, generateIdea],
  );

  const ideaDraftCounts = useMemo(() => countImplementationDraftsByIdea(drafts), [drafts]);

  const openIdea = useCallback(
    async (entry: ScratchpadEntry) => {
      if (!workPath || !confirmDiscardEdits()) return;
      const requestId = ++detailReadSequenceRef.current;
      const selectionId = draftItemId({ itemKind: "idea", entry });
      setSelectedId(selectionId);
      setDetail(null);
      setIdeaDetail(null);
      setIdeaEditing(false);
      setDetailLoading(true);
      setLocalError(null);
      try {
        const document = await readScratchpadDocument(
          workPath,
          "ideation",
          entry.relativePath,
        );
        if (detailReadSequenceRef.current !== requestId) return;
        setIdeaDetail(document);
        setIdeaEditContent(document.content);
        setIdeaSaveState("idle");
      } catch (error) {
        if (detailReadSequenceRef.current !== requestId) return;
        const message = errorMessage(error);
        setLocalError(message);
        setError(message);
      } finally {
        if (detailReadSequenceRef.current === requestId) setDetailLoading(false);
      }
    },
    [confirmDiscardEdits, workPath],
  );

  const openItem = (item: DraftListItem) => {
    if (item.itemKind === "draft") void openDraft(item.draft);
    else void openIdea(item.entry);
  };

  /** Returns the saved document, or null when there was nothing to save or the
   *  save failed — callers that publish the body must not proceed on null. */
  const saveDetail = async (): Promise<DraftDocument | null> => {
    if (!workPath || !detail) return null;
    setSaveState("saving");
    setLocalError(null);
    try {
      const saved = await saveDraft(workPath, detail.id, editContent, detail.updatedAt);
      setDetail(saved);
      setSaveState("saved");
      setEditing(false);
      void refresh();
      return saved;
    } catch (error) {
      const message = errorMessage(error);
      setSaveState("error");
      setLocalError(message);
      setError(message);
      return null;
    }
  };

  const saveIdeaDetail = async (
    sharedMutation = false,
  ): Promise<ScratchpadDocument | null> => {
    if (
      !workPath ||
      !ideaDetail ||
      !ideaDetail.editable ||
      pendingIdeaPaths.has(ideaDetail.relativePath)
    ) {
      return null;
    }
    if (!sharedMutation && !beginIdeaMutation()) return null;
    setIdeaSaveState("saving");
    setLocalError(null);
    try {
      const saved = await saveScratchpadDocument(
        workPath,
        "ideation",
        ideaDetail.relativePath,
        ideaDetail.format,
        ideaEditContent,
        ideaDetail.revision,
      );
      setIdeaDetail(saved);
      setIdeaEditContent(saved.content);
      setIdeaSaveState("saved");
      setIdeaEditing(false);
      void refresh();
      return saved;
    } catch (error) {
      const message = errorMessage(error);
      setIdeaSaveState("error");
      setLocalError(message);
      setError(message);
      return null;
    } finally {
      if (!sharedMutation) endIdeaMutation();
    }
  };

  const transitionIdea = async (stage: IdeationStage) => {
    if (
      !workPath ||
      !ideaDetail ||
      !ideaDetail.revision ||
      pendingIdeaPaths.has(ideaDetail.relativePath) ||
      !beginIdeaMutation()
    ) {
      return;
    }
    try {
      let current = ideaDetail;
      if (ideaEditing && ideaEditContent !== ideaDetail.content) {
        const saved = await saveIdeaDetail(true);
        if (!saved) return;
        current = saved;
      }
      setLocalError(null);
      const transitioned = await transitionScratchpadIdea(
        workPath,
        current.relativePath,
        stage,
        current.revision,
      );
      setSelectedId(`idea:${transitioned.relativePath}`);
      setIdeaDetail(transitioned);
      setIdeaEditContent(transitioned.content);
      setIdeaEditing(false);
      setIdeaSaveState("saved");
      await refresh();
    } catch (error) {
      const message = errorMessage(error);
      setLocalError(message);
      setError(message);
    } finally {
      endIdeaMutation();
    }
  };

  const createIdea = async () => {
    if (!workPath || !beginIdeaMutation()) return;
    try {
      if (!confirmDiscardEdits()) return;
      const title = window.prompt(t("drafts.idea.prompt"))?.trim();
      if (!title) return;
      setLocalError(null);
      const created = await createScratchpadIdea(workPath, title);
      await refresh();
      setSelectedId(`idea:${created.relativePath}`);
      setDetail(null);
      setIdeaDetail(created);
      setIdeaEditContent(created.content);
      setIdeaEditing(false);
      setIdeaSaveState("saved");
    } catch (error) {
      const message = errorMessage(error);
      setLocalError(message);
      setError(message);
    } finally {
      endIdeaMutation();
    }
  };

  useEffect(() => {
    const handleNewIdea = () => void createIdea();
    window.addEventListener("maru:drafts:new-idea", handleNewIdea);
    return () => window.removeEventListener("maru:drafts:new-idea", handleNewIdea);
  });

  // Promotion reads the body from disk, so an unsaved buffer would be published
  // as the pre-edit text AND frozen as the gap baseline. Flush first, and abort
  // if the flush fails (a revision conflict here means the body on disk is not
  // what the user approved).
  const promoteDetail = async () => {
    if (!detail) return;
    if (!dirtyRef.current) {
      setPromoteTarget(detail);
      return;
    }
    const saved = await saveDetail();
    if (saved) setPromoteTarget(saved);
  };

  const discardSelected = async () => {
    if (!workPath || !detail) return;
    if (!window.confirm(t("drafts.discard.confirm", { title: detail.title }))) return;
    setLocalError(null);
    try {
      await discardDraft(workPath, detail.id);
      setDetail(null);
      setSelectedId(null);
      void refresh();
    } catch (error) {
      const message = errorMessage(error);
      setLocalError(message);
      setError(message);
    }
  };

  const openIdeaFromPath = useCallback(
    (relativePath: string) => {
      const entry = ideas.find((candidate) => candidate.relativePath === relativePath);
      if (entry) void openIdea(entry);
    },
    [ideas, openIdea],
  );

  const selectedIdea =
    selectedId?.startsWith("idea:")
      ? (ideas.find((entry) => draftItemId({ itemKind: "idea", entry }) === selectedId) ?? null)
      : null;
  const activeIdea = selectedIdea ?? ideaDetail;

  const selectedIdeaDrafts = useMemo(
    () => (activeIdea ? implementationDraftsForIdea(drafts, activeIdea.relativePath) : []),
    [activeIdea, drafts],
  );
  const selectedIdeaActiveDraft =
    selectedIdeaDrafts.find((draft) => draft.status !== "discarded") ?? null;
  const selectedIdeaPending = activeIdea
    ? pendingIdeaPaths.has(activeIdea.relativePath)
    : false;

  const previewHtml = useMemo(
    () => (detail && !editing ? renderMarkdown(editContent) : ""),
    [detail, editing, editContent],
  );

  const kindLabel = (kind: DraftKind | "all") =>
    kind === "all" ? t("drafts.filter.all") : t(`drafts.kind.${kind}`);
  const statusLabel = (status: DraftStatusFilter) =>
    status === "all" ? t("drafts.filter.all") : t(`drafts.status.${status}`);

  return (
    <section className="drafts-pane" aria-label={t("mode.drafts")}>
      <ModeHeader
        eyebrow={t("drafts.header.eyebrow")}
        title={t("drafts.header.title")}
        subtitle={t("drafts.header.subtitle")}
        actions={
          <>
            <IconButton
              label={t("drafts.idea.create")}
              onClick={() => void createIdea()}
              disabled={ideaMutationBusy}
            >
              <Lightbulb size={15} />
            </IconButton>
            <IconButton label={t("drafts.create.open")} onClick={() => setCreateOpen(true)}>
              <PenLine size={15} />
            </IconButton>
            <IconButton label={t("drafts.refresh")} onClick={() => void refresh()}>
              <RefreshCcw size={15} />
            </IconButton>
          </>
        }
      />

      <div className="drafts-ingest-bar">
        <label className="drafts-ingest-threshold">
          <span>{t("drafts.automation.minImportance")}</span>
          <CompactSelect
            value={taskIngestMinImportance}
            onChange={(event) =>
              onTaskIngestMinImportanceChange(
                event.target.value as AiTaskIngestMinImportance,
              )
            }
          >
            {(["low", "medium", "high"] as AiTaskIngestMinImportance[]).map((level) => (
              <option key={level} value={level}>
                {t(`drafts.importance.${level}`)}
              </option>
            ))}
          </CompactSelect>
        </label>
        <span className="drafts-ingest-status">
          {ingesting
            ? t("drafts.automation.ingesting")
            : lastIngest
              ? t("drafts.automation.lastIngest", {
                  created: lastIngest.created,
                  skippedLow: lastIngest.skippedLow,
                  skippedDup: lastIngest.skippedDup,
                })
              : ""}
        </span>
        <Button variant="ghost" size="sm" onClick={onOpenAgents}>
          {t("drafts.automation.openAgents")}
        </Button>
      </div>

      {localError ? (
        <StatusBanner tone="danger">
          <span>{localError}</span>
        </StatusBanner>
      ) : null}

      <div className="drafts-body">
        <div className="drafts-list-col">
          <div className="drafts-filters" role="group" aria-label={t("drafts.filter.kind.label")}>
            {KIND_FILTERS.map((kind) => (
              <button
                key={kind}
                type="button"
                className={kindFilter === kind ? "drafts-chip active" : "drafts-chip"}
                aria-pressed={kindFilter === kind}
                onClick={() => setKindFilter(kind)}
              >
                {kindLabel(kind)}
              </button>
            ))}
          </div>
          <div className="drafts-filters" role="group" aria-label={t("drafts.filter.status.label")}>
            {STATUS_FILTERS.map((status) => (
              <button
                key={status}
                type="button"
                className={statusFilter === status ? "drafts-chip active" : "drafts-chip"}
                aria-pressed={statusFilter === status}
                onClick={() => setStatusFilter(status)}
              >
                {statusLabel(status)}
              </button>
            ))}
          </div>

          <div className="drafts-list" aria-busy={loading}>
            {!loading && items.length === 0 ? (
              <EmptyState
                icon={<PenLine size={18} />}
                title={t("drafts.list.empty")}
                description={t("drafts.list.emptyHint")}
              />
            ) : null}
            {items.map((item) => {
              const id = draftItemId(item);
              const draft = item.itemKind === "draft" ? item.draft : null;
              const ideaDraftCount =
                item.itemKind === "idea"
                  ? (ideaDraftCounts.get(item.entry.relativePath) ?? 0)
                  : 0;
              const ideaPending =
                item.itemKind === "idea" && pendingIdeaPaths.has(item.entry.relativePath);
              return (
                <button
                  key={id}
                  type="button"
                  className={selectedId === id ? "drafts-list-item active" : "drafts-list-item"}
                  onClick={() => openItem(item)}
                  disabled={ideaMutationBusy}
                >
                  <span className="drafts-list-title">
                    <strong>{draftItemTitle(item)}</strong>
                  </span>
                  <span className="drafts-list-meta">
                    <span className={`drafts-kind-chip kind-${draftItemKind(item)}`}>
                      {t(`drafts.kind.${draftItemKind(item)}`)}
                    </span>
                    {ideaPending ? (
                      <span className="drafts-idea-generating" role="status">
                        {t("drafts.idea.generating")}
                      </span>
                    ) : null}
                    {ideaDraftCount > 0 ? (
                      <span className="drafts-idea-count">
                        {t("drafts.idea.draftCount", { count: ideaDraftCount })}
                      </span>
                    ) : null}
                    {draft?.importance ? (
                      <span className={`drafts-importance-badge importance-${draft.importance}`}>
                        {t(`drafts.importance.${draft.importance}`)}
                      </span>
                    ) : null}
                    {draft && formatConfidence(draft.confidence) ? (
                      <span
                        className="drafts-confidence"
                        title={t("drafts.detail.confidence", {
                          value: formatConfidence(draft.confidence),
                        })}
                      >
                        {formatConfidence(draft.confidence)}
                      </span>
                    ) : null}
                    <span className="drafts-source">
                      {item.itemKind === "draft" ? item.draft.source : item.entry.source}
                    </span>
                    {draft ? (
                      <span className={`drafts-status status-${draft.status}`}>
                        {t(`drafts.status.${draft.status}`)}
                      </span>
                    ) : null}
                    <span className="drafts-updated">
                      {formatRelativeDate(draftItemUpdatedAt(item), locale)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="drafts-detail-col">
          {detailLoading ? (
            <div className="drafts-detail-empty" role="status">
              …
            </div>
          ) : detail ? (
            <div className="drafts-detail">
              <header className="drafts-detail-header">
                <div>
                  <h3>{detail.title}</h3>
                  <span className="drafts-list-meta">
                    <span className={`drafts-kind-chip kind-${detail.kind}`}>
                      {t(`drafts.kind.${detail.kind}`)}
                    </span>
                    <span className={`drafts-status status-${detail.status}`}>
                      {t(`drafts.status.${detail.status}`)}
                    </span>
                    <span className="drafts-source">{detail.source}</span>
                    <span className="drafts-updated">
                      {formatRelativeDate(detail.updatedAt, locale)}
                    </span>
                  </span>
                </div>
                <div className="drafts-detail-actions">
                  {detail.status === "accepted" && detail.promotedTo && onOpenGapAnalysis ? (
                    <Button
                      type="button"
                      size="sm"
                      icon={<FileDiff size={13} />}
                      onClick={() => onOpenGapAnalysis(detail.id)}
                    >
                      {t("drafts.actions.openGap")}
                    </Button>
                  ) : null}
                  {detail.status !== "accepted" && detail.status !== "discarded" ? (
                    <>
                      <Button
                        type="button"
                        size="sm"
                        icon={<Check size={13} />}
                        onClick={() => void promoteDetail()}
                      >
                        {t("drafts.actions.accept")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="danger"
                        icon={<Trash2 size={13} />}
                        onClick={() => void discardSelected()}
                      >
                        {t("drafts.actions.discard")}
                      </Button>
                    </>
                  ) : null}
                </div>
              </header>

              {detail.promotedTo ? (
                <StatusBanner tone="success">
                  <span>{t("drafts.detail.promotedTo", { path: detail.promotedTo })}</span>
                </StatusBanner>
              ) : null}

              {detail.kind === "implementation" && detail.originRefs.length > 0 ? (
                <div className="drafts-lineage">
                  <strong>{t("drafts.detail.lineage")}</strong>
                  <span className="drafts-lineage-chain">
                    <button
                      type="button"
                      className="drafts-lineage-link"
                      title={detail.originRefs[0]}
                      onClick={() => openIdeaFromPath(detail.originRefs[0])}
                    >
                      {detail.originRefs[0].split("/").pop() ?? detail.originRefs[0]}
                    </button>
                    <span className="drafts-lineage-sep">→</span>
                    <span className="drafts-lineage-current">{detail.title}</span>
                    {detail.promotedTo ? (
                      <>
                        <span className="drafts-lineage-sep">→</span>
                        <code className="drafts-lineage-path">{detail.promotedTo}</code>
                      </>
                    ) : null}
                  </span>
                </div>
              ) : null}

              {detail.originRefs.length > 0 ? (
                <div className="drafts-origin-refs">
                  <strong>{t("drafts.detail.originRefs")}</strong>
                  <ul>
                    {detail.originRefs.map((ref) => (
                      <li key={ref}>
                        <code>{ref}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="drafts-detail-toolbar">
                <button
                  type="button"
                  className={!editing ? "active" : ""}
                  onClick={() => setEditing(false)}
                >
                  {t("drafts.detail.preview")}
                </button>
                <button
                  type="button"
                  className={editing ? "active" : ""}
                  onClick={() => setEditing(true)}
                  disabled={detail.status === "accepted" || detail.status === "discarded"}
                >
                  {t("drafts.detail.edit")}
                </button>
                {editing ? (
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void saveDetail()}
                    disabled={saveState === "saving"}
                  >
                    {saveState === "saving"
                      ? t("drafts.detail.saving")
                      : t("drafts.detail.save")}
                  </Button>
                ) : null}
                <span className={`memo-autosave-status ${saveState}`} role="status">
                  {saveState === "saved" ? t("drafts.detail.saved") : ""}
                </span>
              </div>

              {editing ? (
                <textarea
                  className="drafts-editor"
                  value={editContent}
                  onChange={(event) => {
                    setEditContent(event.target.value);
                    setSaveState("idle");
                  }}
                />
              ) : (
                <article
                  className="drafts-preview markdown-preview"
                  dangerouslySetInnerHTML={{ __html: previewHtml }}
                />
              )}
            </div>
          ) : ideaDetail ? (
            <div className="drafts-detail">
              <header className="drafts-detail-header">
                <div>
                  <h3>{ideaDetail.name}</h3>
                  <span className="drafts-list-meta">
                    <span className="drafts-kind-chip kind-idea">{t("drafts.kind.idea")}</span>
                    <span className="drafts-source">{ideaDetail.source}</span>
                    <span className="drafts-updated">
                      {formatRelativeDate(ideaDetail.updatedAt ?? null, locale)}
                    </span>
                  </span>
                </div>
              </header>
              <div className="drafts-detail-toolbar">
                <button
                  type="button"
                  className={!ideaEditing ? "active" : ""}
                  onClick={() => setIdeaEditing(false)}
                  disabled={ideaMutationBusy || selectedIdeaPending}
                >
                  {t("drafts.detail.preview")}
                </button>
                <button
                  type="button"
                  className={ideaEditing ? "active" : ""}
                  onClick={() => setIdeaEditing(true)}
                  disabled={ideaMutationBusy || selectedIdeaPending || !ideaDetail.editable}
                >
                  {t("drafts.detail.edit")}
                </button>
                {ideaEditing ? (
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void saveIdeaDetail()}
                    disabled={
                      ideaMutationBusy || selectedIdeaPending || ideaSaveState === "saving"
                    }
                  >
                    {ideaSaveState === "saving"
                      ? t("drafts.detail.saving")
                      : t("drafts.detail.save")}
                  </Button>
                ) : null}
                <span className={`memo-autosave-status ${ideaSaveState}`} role="status">
                  {ideaSaveState === "saved" ? t("drafts.detail.saved") : ""}
                </span>
              </div>
              {ideaEditing ? (
                <textarea
                  className="drafts-editor"
                  value={ideaEditContent}
                  onChange={(event) => {
                    setIdeaEditContent(event.target.value);
                    setIdeaSaveState("idle");
                  }}
                />
              ) : (
                <article
                  className="drafts-preview markdown-preview"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(ideaEditContent) }}
                />
              )}
              <div className="drafts-idea-actions">
                {selectedIdeaPending ? (
                  <Button type="button" size="sm" icon={<Sparkles size={13} />} disabled>
                    {t("drafts.idea.generating")}
                  </Button>
                ) : selectedIdeaActiveDraft ? (
                  <Button
                    type="button"
                    size="sm"
                    icon={<PenLine size={13} />}
                    onClick={() => void openDraft(selectedIdeaActiveDraft)}
                    disabled={ideaMutationBusy || selectedIdeaPending}
                  >
                    {t("drafts.idea.openExistingDraft")}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="primary"
                    icon={<Sparkles size={13} />}
                    onClick={() => {
                      if (activeIdea) void generate(activeIdea);
                    }}
                    disabled={ideaMutationBusy || selectedIdeaPending}
                  >
                    {t("drafts.idea.generateDraft")}
                  </Button>
                )}
              </div>
              {ideaDetail.ideationStage ? (
                <div className="drafts-idea-actions">
                  <span>{t(`rightPane.scratchpad.stage.${ideaDetail.ideationStage}`)}</span>
                  {IDEATION_STAGE_TRANSITIONS[ideaDetail.ideationStage].map((stage) => (
                    <Button
                      key={stage}
                      type="button"
                      size="sm"
                      onClick={() => void transitionIdea(stage)}
                      disabled={ideaMutationBusy || selectedIdeaPending}
                    >
                      {t(`rightPane.scratchpad.stage.${stage}`)}
                    </Button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : selectedIdea ? (
            <div className="drafts-detail">
              <header className="drafts-detail-header">
                <div>
                  <h3>{selectedIdea.name}</h3>
                </div>
              </header>
              <div className="drafts-idea-actions">
                <Button type="button" size="sm" onClick={() => void openIdea(selectedIdea)}>
                  {t("drafts.idea.open")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="drafts-detail-empty">
              <PenLine size={18} />
              <span>{t("drafts.detail.selectPrompt")}</span>
            </div>
          )}
        </div>
      </div>

      <NewDraftDialog
        open={createOpen}
        workPath={workPath}
        onClose={() => setCreateOpen(false)}
        onCreated={(entry) => {
          setCreateOpen(false);
          void refresh();
          void openDraft(entry);
        }}
      />

      <PromoteDraftDialog
        draft={promoteTarget}
        workPath={workPath}
        onConfirmApproval={onConfirmApproval}
        onClose={() => setPromoteTarget(null)}
        onPromoted={(entry) => {
          setPromoteTarget(null);
          setDetail((current) =>
            current && current.id === entry.id ? { ...current, ...entry } : current,
          );
          void refresh();
        }}
      />
    </section>
  );
}
