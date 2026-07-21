// Maru Today — Review stage. Cross-references the confirmed plan against
// today's task events and the task scan: completed-as-planned, unplanned
// additions, planned-not-completed, deferred/cancelled, and the unresolved
// remainder that rolls into tomorrow's review. The reflection editor writes
// only the `## Reflection` body of the daily journal — the managed
// `<!-- maru:today -->` block is preserved verbatim. Review never closes
// the day (rollover owns that).

import { TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { readDocument, saveDocument } from "../../lib/api";
import { useTranslation } from "../../lib/i18n";
import type { DocumentPayload } from "../../lib/types";
import type { TaskEvent, TodayRoute } from "../../lib/today";
import { readTaskEvents, todayErrorCode } from "../../lib/today";
import { planItemRefKey } from "../../lib/todayPlan";
import { TodayStageScaffold } from "./TodayStageScaffold";
import { useToday } from "./todayContext";
import { resolveRefTitle, taskKeyOf } from "./todayPrepareUtils";
import { useTodayTasks } from "./useTodayTasks";

interface TodayReviewProps {
  onNavigate: (route: TodayRoute) => void;
}

interface GroupRow {
  key: string;
  title: string;
  detail?: string | null;
}

const REFLECTION_HEADING = "## Reflection";

export function TodayReview({ onNavigate }: TodayReviewProps) {
  const { t } = useTranslation();
  const { workPath, snapshot } = useToday();
  const { tasks } = useTodayTasks();

  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [journal, setJournal] = useState<DocumentPayload | null>(null);
  const [journalMissing, setJournalMissing] = useState(false);
  const [reflectionDraft, setReflectionDraft] = useState("");
  const [reflectionSaved, setReflectionSaved] = useState(false);
  const [notice, setNotice] = useState<"conflict" | null>(null);

  const logicalDay = snapshot?.logicalDay ?? "";
  const journalPath = logicalDay ? `tasks/daily/${logicalDay}.md` : null;

  useEffect(() => {
    if (!workPath || !logicalDay) return;
    let cancelled = false;
    readTaskEvents(workPath, null, logicalDay)
      .then((rows) => {
        if (!cancelled) setEvents(rows);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workPath, logicalDay]);

  useEffect(() => {
    if (!workPath || !journalPath) return;
    let cancelled = false;
    setJournal(null);
    setJournalMissing(false);
    readDocument(workPath, journalPath)
      .then((doc) => {
        if (cancelled) return;
        setJournal(doc);
        setReflectionDraft(extractReflectionBody(doc.content));
      })
      .catch(() => {
        if (!cancelled) setJournalMissing(true);
      });
    return () => {
      cancelled = true;
    };
  }, [workPath, journalPath]);

  const steps = useMemo(
    () => [
      { id: "prepare", label: t("today.nav.prepare") },
      { id: "execute", label: t("today.nav.execute") },
      { id: "review", label: t("today.nav.review") },
    ],
    [t],
  );

  /** Same-day fold of completion events: completed adds, reopened removes. */
  const doneIds = useMemo(() => {
    const ids = new Set<string>();
    for (const event of events) {
      if (!event.taskId) continue;
      if (event.kind === "task_completed") ids.add(event.taskId);
      else if (event.kind === "task_reopened") ids.delete(event.taskId);
    }
    for (const entry of tasks) {
      if (entry.done === logicalDay) ids.add(taskKeyOf(entry));
    }
    return ids;
  }, [events, tasks, logicalDay]);

  const deferredCancelledIds = useMemo(() => {
    const ids = new Set<string>();
    for (const event of events) {
      if ((event.kind === "task_deferred" || event.kind === "task_cancelled") && event.taskId) {
        ids.add(event.taskId);
      }
    }
    return ids;
  }, [events]);

  const planItems = useMemo(
    () => [
      ...(snapshot?.plan?.top ?? []),
      ...(snapshot?.plan?.flexible ?? []),
      ...(snapshot?.plan?.overflow ?? []),
    ],
    [snapshot],
  );

  const groups = useMemo(() => {
    const titleFor = (taskId: string) =>
      tasks.find((task) => taskKeyOf(task) === taskId)?.title ?? taskId;
    const completedPlanned: GroupRow[] = [];
    const plannedNotCompleted: GroupRow[] = [];
    const unresolved: GroupRow[] = [];
    const plannedTaskIds = new Set<string>();
    for (const item of planItems) {
      const key = planItemRefKey(item.itemRef);
      const title = item.outcome || resolveRefTitle(item.itemRef, tasks, []);
      if (item.itemRef.kind === "task") plannedTaskIds.add(item.itemRef.taskId);
      const completed = item.itemRef.kind === "task" && doneIds.has(item.itemRef.taskId);
      if (completed) {
        completedPlanned.push({ key, title });
      } else {
        plannedNotCompleted.push({ key, title });
        if (item.itemRef.kind !== "task" || !deferredCancelledIds.has(item.itemRef.taskId)) {
          unresolved.push({ key, title });
        }
      }
    }
    const completedUnplanned: GroupRow[] = [...doneIds]
      .filter((taskId) => !plannedTaskIds.has(taskId))
      .map((taskId) => ({ key: `task:${taskId}`, title: titleFor(taskId) }));
    const deferredCancelled: GroupRow[] = events
      .filter(
        (event) =>
          (event.kind === "task_deferred" || event.kind === "task_cancelled") && event.taskId,
      )
      .map((event) => {
        const payload = (event.payload ?? {}) as { deferDate?: string };
        return {
          key: `${event.kind}:${event.taskId}:${event.ts}`,
          title: titleFor(event.taskId!),
          detail:
            event.kind === "task_deferred"
              ? t("today.review.deferred.deferred", { date: payload.deferDate ?? "" })
              : t("today.review.deferred.cancelled"),
        };
      });
    return { completedPlanned, completedUnplanned, plannedNotCompleted, unresolved, deferredCancelled };
  }, [planItems, doneIds, deferredCancelledIds, events, tasks, t]);

  const saveReflection = async () => {
    if (!workPath || !journalPath || !journal) return;
    try {
      const next = replaceReflectionBody(journal.content, reflectionDraft);
      const saved = await saveDocument(workPath, journalPath, next, journal.revision ?? null);
      setJournal(saved);
      setNotice(null);
      setReflectionSaved(true);
      setTimeout(() => setReflectionSaved(false), 2500);
    } catch (err) {
      if (todayErrorCode(err) === "document_conflict") {
        setNotice("conflict");
        try {
          const fresh = await readDocument(workPath, journalPath);
          setJournal(fresh);
          setReflectionDraft(extractReflectionBody(fresh.content));
        } catch {
          setJournalMissing(true);
        }
      } else {
        throw err;
      }
    }
  };

  const renderGroup = (title: string, rows: GroupRow[]) => (
    <div className="today-review-group">
      <h4 className="today-review-group-title">
        {title}
        <span className="today-review-count">{rows.length}</span>
      </h4>
      {rows.length === 0 ? (
        <p className="today-panel-empty">{t("today.review.groups.empty")}</p>
      ) : (
        <ul className="today-review-list">
          {rows.map((row) => (
            <li key={row.key} className="today-review-row">
              <span className="today-exec-title">{row.title}</span>
              {row.detail ? <span className="today-review-detail">{row.detail}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  const plannedTotal = planItems.length;
  const completedCount = groups.completedPlanned.length;

  return (
    <TodayStageScaffold
      steps={steps}
      activeStepId="review"
      onSelectStep={(id) => onNavigate(id as TodayRoute)}
    >
      <div className="today-content">
        <div className="today-grid today-grid-review">
          <section className="today-panel today-panel-summary">
            <header className="today-panel-header">
              <h3 className="today-panel-title">{t("today.review.summary.title")}</h3>
            </header>
            <div className="today-panel-body">
              <p className="today-review-summary">
                {t("today.review.summary.counts", {
                  total: plannedTotal,
                  completed: completedCount,
                })}
              </p>
              {renderGroup(t("today.review.groups.completedPlanned"), groups.completedPlanned)}
              {renderGroup(
                t("today.review.groups.completedUnplanned"),
                groups.completedUnplanned,
              )}
              {renderGroup(
                t("today.review.groups.plannedNotCompleted"),
                groups.plannedNotCompleted,
              )}
            </div>
          </section>

          <section className="today-panel today-panel-deferred">
            <header className="today-panel-header">
              <h3 className="today-panel-title">{t("today.review.deferred.title")}</h3>
            </header>
            <div className="today-panel-body">
              {groups.deferredCancelled.length === 0 ? (
                <p className="today-panel-empty">{t("today.review.deferred.empty")}</p>
              ) : (
                <ul className="today-review-list">
                  {groups.deferredCancelled.map((row) => (
                    <li key={row.key} className="today-review-row">
                      <span className="today-exec-title">{row.title}</span>
                      {row.detail ? (
                        <span className="today-review-detail">{row.detail}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <section className="today-panel today-panel-unresolved">
            <header className="today-panel-header">
              <h3 className="today-panel-title">{t("today.review.unresolved.title")}</h3>
            </header>
            <p className="today-panel-hint">{t("today.review.unresolved.note")}</p>
            <div className="today-panel-body">
              {groups.unresolved.length === 0 ? (
                <p className="today-panel-empty">{t("today.review.groups.empty")}</p>
              ) : (
                <ul className="today-review-list">
                  {groups.unresolved.map((row) => (
                    <li key={row.key} className="today-review-row">
                      <span className="today-exec-title">{row.title}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <section className="today-panel today-panel-reflection">
            <header className="today-panel-header">
              <h3 className="today-panel-title">{t("today.review.reflection.title")}</h3>
            </header>
            <div className="today-panel-body">
              {journalMissing ? (
                <>
                  <textarea
                    className="today-review-reflection-input"
                    disabled
                    value=""
                    aria-label={t("today.review.reflection.title")}
                  />
                  <p className="today-panel-hint">{t("today.review.reflection.disabled")}</p>
                </>
              ) : (
                <>
                  {notice ? (
                    <p className="today-notice" role="alert">
                      <TriangleAlert size={13} strokeWidth={1.9} aria-hidden="true" />
                      {t("today.review.conflict")}
                    </p>
                  ) : null}
                  <textarea
                    className="today-review-reflection-input"
                    value={reflectionDraft}
                    onChange={(event) => setReflectionDraft(event.target.value)}
                    placeholder={t("today.review.reflection.placeholder")}
                    aria-label={t("today.review.reflection.title")}
                    disabled={!journal}
                  />
                  <div className="today-review-reflection-actions">
                    <button
                      type="button"
                      className="today-button-primary"
                      onClick={() => void saveReflection()}
                      disabled={!journal}
                    >
                      {t("today.review.reflection.save")}
                    </button>
                    {reflectionSaved ? (
                      <span className="today-review-saved" role="status">
                        {t("today.review.reflection.saved")}
                      </span>
                    ) : null}
                  </div>
                </>
              )}
            </div>
          </section>
        </div>
      </div>
    </TodayStageScaffold>
  );
}

/** Body text below the `## Reflection` heading (up to the next H2 or EOF). */
function extractReflectionBody(content: string): string {
  const lines = content.split("\n");
  const heading = lines.findIndex((line) => line.trim() === REFLECTION_HEADING);
  if (heading < 0) return "";
  let end = lines.length;
  for (let index = heading + 1; index < lines.length; index++) {
    if (/^##\s/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines
    .slice(heading + 1, end)
    .join("\n")
    .trim();
}

/** Rewrite only the `## Reflection` section body; everything else —
 *  including the managed maru:today marker block — is preserved verbatim. */
function replaceReflectionBody(content: string, body: string): string {
  const lines = content.split("\n");
  const heading = lines.findIndex((line) => line.trim() === REFLECTION_HEADING);
  if (heading < 0) return content;
  let end = lines.length;
  for (let index = heading + 1; index < lines.length; index++) {
    if (/^##\s/.test(lines[index])) {
      end = index;
      break;
    }
  }
  const before = lines.slice(0, heading + 1);
  const after = lines.slice(end);
  const trimmed = body.trim();
  const bodyLines = trimmed ? ["", ...trimmed.split("\n"), ""] : [""];
  return [...before, ...bodyLines, ...after].join("\n");
}
