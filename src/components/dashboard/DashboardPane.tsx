// Maru Dashboard — at-a-glance workspace overview. The overview is a widget
// grid; each widget can drill down into an in-mode detail view and deep-link
// into the mode that owns its data. Widget data comes from useDashboardData
// (one hook per domain, isolated failures); all shaping logic lives in
// src/lib/dashboard.ts.

import { format, parseISO } from "date-fns";
import { ArrowLeft, RefreshCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { catalogQuery, type CatalogEntry, type CatalogItemKind } from "../../lib/catalog";
import {
  DASHBOARD_TASK_FILTERS,
  agentBoardSummary,
  catalogKindChips,
  dashboardLogicalDay,
  draftStatusCounts,
  filterTasksForDashboard,
  gitSummary,
  inboxSummary,
  planLaneCounts,
  planTopTitles,
  topRecentEntries,
  upcomingTaskEvents,
  type DashboardTaskFilter,
  type DashboardView,
} from "../../lib/dashboard";
import { formatRelativeDate } from "../../lib/document";
import { deriveDotSyncBadge } from "../../lib/dotSync";
import { useTranslation } from "../../lib/i18n";
import type { MaruAppMode, TasksSettings } from "../../lib/settings";
import { taskFilterCounts, type TaskCalendarEvent, type TaskEntry } from "../../lib/tasks";
import type { CalendarCommitment } from "../../lib/today";
import type { VaultEntry } from "../../lib/types";
import { Button } from "../ui/Button";
import { DashboardWidget } from "./DashboardWidget";
import {
  useDashboardAgents,
  useDashboardCatalog,
  useDashboardDrafts,
  useDashboardGit,
  useDashboardInbox,
  useDashboardSchedule,
  useDashboardSync,
  useDashboardTasks,
  useDashboardToday,
} from "./useDashboardData";

export interface DashboardPaneProps {
  workPath: string | null;
  effectiveSettings: TasksSettings;
  recentEntries: VaultEntry[];
  onOpenMode: (mode: Exclude<MaruAppMode, "pkm">) => void;
  onOpenDocument: (entry: VaultEntry) => void;
  onOpenSettings: (tab?: string | null) => void;
}

const RECENTS_WIDGET_LIMIT = 5;

export function DashboardPane({
  workPath,
  effectiveSettings,
  recentEntries,
  onOpenMode,
  onOpenDocument,
  onOpenSettings,
}: DashboardPaneProps) {
  const { t, locale } = useTranslation();
  const [view, setView] = useState<DashboardView>("overview");
  const [taskFilter, setTaskFilter] = useState<DashboardTaskFilter>("today");
  const [catalogKind, setCatalogKind] = useState<CatalogItemKind>("deadline-due");
  const [epoch, setEpoch] = useState(0);

  const today = useDashboardToday(workPath, effectiveSettings, epoch);
  const tasks = useDashboardTasks(workPath, epoch);
  const schedule = useDashboardSchedule(workPath, effectiveSettings, epoch);
  const catalog = useDashboardCatalog(workPath, epoch);
  const inbox = useDashboardInbox(workPath, epoch);
  const agents = useDashboardAgents(workPath, epoch);
  const drafts = useDashboardDrafts(workPath, epoch);
  const git = useDashboardGit(workPath, epoch);
  const sync = useDashboardSync(epoch);

  const todayIso = useMemo(
    () => dashboardLogicalDay(new Date(), effectiveSettings.today.dayStart),
    [epoch, effectiveSettings.today.dayStart],
  );
  const taskEntries = useMemo(() => tasks.data ?? [], [tasks.data]);
  const taskCounts = useMemo(() => taskFilterCounts(taskEntries, todayIso), [taskEntries, todayIso]);
  const catalogChips = useMemo(() => catalogKindChips(catalog.data), [catalog.data]);
  const draftChips = useMemo(() => draftStatusCounts(drafts.data), [drafts.data]);
  const inboxData = useMemo(
    () => inboxSummary(inbox.data?.dropItems, inbox.data?.entries),
    [inbox.data],
  );
  const agentSummary = useMemo(
    () => (agents.data ? agentBoardSummary(agents.data) : null),
    [agents.data],
  );
  const gitData = useMemo(() => gitSummary(git.data), [git.data]);
  const syncBadge = useMemo(() => deriveDotSyncBadge(sync.data), [sync.data]);
  const laneCounts = useMemo(() => planLaneCounts(today.data?.plan), [today.data]);
  const topTitles = useMemo(
    () => planTopTitles(today.data?.plan, taskEntries),
    [today.data, taskEntries],
  );
  const upcoming = useMemo(
    () => upcomingTaskEvents(taskEntries, new Date(), 5),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [taskEntries, epoch],
  );
  const commitments = schedule.data ?? [];

  const refreshAll = () => setEpoch((value) => value + 1);

  const openDrilldown = (next: DashboardView) => setView(next);
  const openTaskFilter = (filter: DashboardTaskFilter) => {
    setTaskFilter(filter);
    setView("tasks");
  };
  const openCatalogKind = (kind: CatalogItemKind) => {
    setCatalogKind(kind);
    setView("catalog");
  };

  const drilldownTitle =
    view === "tasks"
      ? t("dashboard.widget.tasks.title")
      : view === "schedule"
        ? t("dashboard.widget.schedule.title")
        : view === "catalog"
          ? t("dashboard.widget.catalog.title")
          : view === "inbox"
            ? t("dashboard.widget.inbox.title")
            : t("dashboard.widget.recents.title");

  return (
    <div className="dashboard-pane">
      <header className="dashboard-header">
        <div>
          <h2 className="dashboard-title">{t("dashboard.title")}</h2>
          <p className="dashboard-subtitle muted">{t("dashboard.subtitle")}</p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          icon={<RefreshCcw size={14} />}
          onClick={refreshAll}
        >
          {t("dashboard.refresh")}
        </Button>
      </header>

      {view === "overview" ? (
        <div className="dashboard-grid">
          <DashboardWidget
            kind="today"
            title={t("dashboard.widget.today.title")}
            count={laneCounts.top > 0 ? laneCounts.top : null}
            onViewAll={() => onOpenMode("today")}
            loading={today.loading}
            error={today.error}
            onRetry={today.refresh}
            empty={!effectiveSettings.today.enabled || laneCounts.top === 0}
            emptyLabel={
              effectiveSettings.today.enabled
                ? t("dashboard.widget.today.empty")
                : t("dashboard.widget.today.disabled")
            }
          >
            <div className="dashboard-today-summary">
              {today.data ? (
                <span className="dashboard-pill">{t(`dashboard.today.state.${today.data.dayState}`)}</span>
              ) : null}
              <span className="dashboard-lanes muted">
                {t("dashboard.today.lanes", {
                  top: laneCounts.top,
                  flexible: laneCounts.flexible,
                  overflow: laneCounts.overflow,
                })}
              </span>
            </div>
            {topTitles.length > 0 ? (
              <ol className="dashboard-list">
                {topTitles.map((title) => (
                  <li key={title}>{title}</li>
                ))}
              </ol>
            ) : null}
          </DashboardWidget>

          <DashboardWidget
            kind="tasks"
            title={t("dashboard.widget.tasks.title")}
            count={taskCounts.today + taskCounts.overdue}
            onViewAll={() => onOpenMode("tasks")}
            loading={tasks.loading}
            error={tasks.error}
            onRetry={tasks.refresh}
            empty={taskEntries.length === 0}
          >
            <div className="dashboard-chips">
              {DASHBOARD_TASK_FILTERS.map((filter) => (
                <button
                  key={filter}
                  type="button"
                  className="dashboard-chip"
                  onClick={() => openTaskFilter(filter)}
                >
                  {t(`dashboard.tasks.filter.${filter}`)}
                  <span className="dashboard-chip-count">{taskCounts[filter]}</span>
                </button>
              ))}
            </div>
          </DashboardWidget>

          <DashboardWidget
            kind="schedule"
            title={t("dashboard.widget.schedule.title")}
            count={commitments.length > 0 ? commitments.length : null}
            onViewAll={() => onOpenMode("tasks")}
            loading={schedule.loading || tasks.loading}
            error={schedule.error ?? tasks.error}
            onRetry={() => {
              schedule.refresh();
              tasks.refresh();
            }}
            empty={commitments.length === 0 && upcoming.length === 0}
            emptyLabel={t("dashboard.widget.schedule.empty")}
          >
            <p className="dashboard-section-label">{t("dashboard.schedule.agenda")}</p>
            <ul className="dashboard-list">
              {commitments.slice(0, 4).map((commitment) => (
                <li key={`${commitment.startIso}:${commitment.title}`}>
                  <span className="dashboard-list-meta">
                    {format(parseISO(commitment.startIso), "HH:mm")}
                  </span>
                  {commitment.title}
                </li>
              ))}
            </ul>
            {upcoming.length > 0 ? (
              <>
                <p className="dashboard-section-label">{t("dashboard.schedule.upcoming")}</p>
                <ul className="dashboard-list">
                  {upcoming.slice(0, 3).map((event) => (
                    <li key={event.id}>
                      <span className="dashboard-list-meta">
                        {format(event.start, event.allDay ? "MM/dd" : "MM/dd HH:mm")}
                      </span>
                      {event.title}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </DashboardWidget>

          <DashboardWidget
            kind="catalog"
            title={t("dashboard.widget.catalog.title")}
            count={catalog.data?.entries_count ?? null}
            onViewAll={() => onOpenMode("catalog")}
            loading={catalog.loading}
            error={catalog.error}
            onRetry={catalog.refresh}
            empty={(catalog.data?.entries_count ?? 0) === 0}
            emptyLabel={t("dashboard.widget.catalog.empty")}
          >
            <div className="dashboard-chips">
              {catalogChips.map((chip) => (
                <button
                  key={chip.key}
                  type="button"
                  className="dashboard-chip"
                  onClick={() => openCatalogKind(chip.key)}
                >
                  {t(`dashboard.catalog.kind.${catalogKindKey(chip.key)}`)}
                  <span className="dashboard-chip-count">{chip.count}</span>
                </button>
              ))}
            </div>
          </DashboardWidget>

          <DashboardWidget
            kind="inbox"
            title={t("dashboard.widget.inbox.title")}
            count={inboxData.pendingCount > 0 ? inboxData.pendingCount : null}
            onViewAll={() => onOpenMode("inbox")}
            loading={inbox.loading}
            error={inbox.error}
            onRetry={inbox.refresh}
            empty={inboxData.pendingCount === 0}
            emptyLabel={t("dashboard.widget.inbox.empty")}
          >
            <ul className="dashboard-list">
              {inboxData.latest.map((item) => (
                <li key={item.id}>{item.title}</li>
              ))}
            </ul>
          </DashboardWidget>

          <DashboardWidget
            kind="agents"
            title={t("dashboard.widget.agents.title")}
            count={agentSummary && agentSummary.running > 0 ? agentSummary.running : null}
            onViewAll={() => onOpenMode("agents")}
            loading={agents.loading}
            error={agents.error}
            onRetry={agents.refresh}
            empty={agentSummary?.agents === 0}
            emptyLabel={t("dashboard.widget.agents.empty")}
          >
            {agentSummary ? (
              <div className="dashboard-kv">
                <p>{t("dashboard.agents.summary", {
                  running: agentSummary.running,
                  scheduled: agentSummary.scheduled,
                })}</p>
                {agentSummary.nextRunAt ? (
                  <p className="muted">
                    {t("dashboard.agents.nextRun", {
                      time: formatRelativeDate(agentSummary.nextRunAt, locale),
                    })}
                  </p>
                ) : null}
              </div>
            ) : null}
          </DashboardWidget>

          <DashboardWidget
            kind="drafts"
            title={t("dashboard.widget.drafts.title")}
            count={draftChips.reduce((sum, chip) => sum + chip.count, 0) || null}
            onViewAll={() => onOpenMode("drafts")}
            loading={drafts.loading}
            error={drafts.error}
            onRetry={drafts.refresh}
            empty={draftChips.every((chip) => chip.count === 0)}
            emptyLabel={t("dashboard.widget.drafts.empty")}
          >
            <div className="dashboard-chips">
              {draftChips.map((chip) => (
                <span key={chip.key} className="dashboard-chip dashboard-chip-static">
                  {t(`drafts.status.${chip.key}`)}
                  <span className="dashboard-chip-count">{chip.count}</span>
                </span>
              ))}
            </div>
          </DashboardWidget>

          <DashboardWidget
            kind="git"
            title={t("dashboard.widget.git.title")}
            count={gitData.isRepo && !gitData.clean ? gitData.total : null}
            onViewAll={() => onOpenMode("files")}
            loading={git.loading}
            error={git.error}
            onRetry={git.refresh}
            empty={!gitData.isRepo}
            emptyLabel={t("dashboard.widget.git.notRepo")}
          >
            <div className="dashboard-kv">
              {gitData.branch ? <p className="dashboard-git-branch">{gitData.branch}</p> : null}
              <p className="muted">
                {gitData.clean
                  ? t("dashboard.widget.git.clean")
                  : t("dashboard.git.summary", {
                      modified: gitData.modified,
                      staged: gitData.staged,
                      untracked: gitData.untracked,
                    })}
              </p>
            </div>
          </DashboardWidget>

          <DashboardWidget
            kind="recents"
            title={t("dashboard.widget.recents.title")}
            count={recentEntries.length > 0 ? recentEntries.length : null}
            onViewAll={() => openDrilldown("recents")}
            loading={false}
            empty={recentEntries.length === 0}
            emptyLabel={t("dashboard.widget.recents.empty")}
          >
            <ul className="dashboard-list">
              {topRecentEntries(recentEntries, RECENTS_WIDGET_LIMIT).map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    className="dashboard-link"
                    onClick={() => onOpenDocument(entry)}
                  >
                    {entry.title}
                  </button>
                </li>
              ))}
            </ul>
          </DashboardWidget>

          <DashboardWidget
            kind="sync"
            title={t("dashboard.widget.sync.title")}
            count={syncBadge.scheduledJobs > 0 ? syncBadge.scheduledJobs : null}
            onViewAll={() => onOpenSettings("jobs")}
            loading={sync.loading}
            error={sync.error}
            onRetry={sync.refresh}
          >
            <span className={`dashboard-pill dashboard-sync-${syncBadge.state}`}>
              {t(`system.dotSync.state.${syncBadge.state}`, { count: syncBadge.scheduledJobs })}
            </span>
          </DashboardWidget>
        </div>
      ) : (
        <div className={`dashboard-drilldown dashboard-drilldown-${view}`}>
          <div className="dashboard-drilldown-header">
            <button type="button" className="dashboard-back" onClick={() => setView("overview")}>
              <ArrowLeft size={14} strokeWidth={1.9} aria-hidden="true" />
              {t("dashboard.back")}
            </button>
            <h2 className="dashboard-drilldown-title">{drilldownTitle}</h2>
          </div>
          {view === "tasks" ? (
            <TasksDrilldown
              entries={taskEntries}
              counts={taskCounts}
              filter={taskFilter}
              todayIso={todayIso}
              loading={tasks.loading}
              error={tasks.error}
              onRetry={tasks.refresh}
              onSelectFilter={setTaskFilter}
              onOpenTasks={() => onOpenMode("tasks")}
            />
          ) : view === "schedule" ? (
            <ScheduleDrilldown
              commitments={commitments}
              upcoming={upcoming}
              loading={schedule.loading || tasks.loading}
              error={schedule.error ?? tasks.error}
              onRetry={() => {
                schedule.refresh();
                tasks.refresh();
              }}
            />
          ) : view === "catalog" ? (
            <CatalogDrilldown
              workPath={workPath}
              kind={catalogKind}
              chips={catalogChips}
              onSelectKind={setCatalogKind}
            />
          ) : view === "inbox" ? (
            <InboxDrilldown
              items={inboxData.latest}
              pendingCount={inboxData.pendingCount}
              loading={inbox.loading}
              error={inbox.error}
              onRetry={inbox.refresh}
              locale={locale}
            />
          ) : (
            <RecentsDrilldown entries={recentEntries} onOpenDocument={onOpenDocument} />
          )}
        </div>
      )}
    </div>
  );
}

function catalogKindKey(kind: CatalogItemKind): string {
  switch (kind) {
    case "deadline-due":
      return "deadlineDue";
    case "approval-in-flight":
      return "approvalInFlight";
    case "evidence-unlinked":
      return "evidenceUnlinked";
    case "inbox-pending":
      return "inboxPending";
    case "task-due":
      return "taskDue";
  }
}

interface TasksDrilldownProps {
  entries: TaskEntry[];
  counts: ReturnType<typeof taskFilterCounts>;
  filter: DashboardTaskFilter;
  todayIso: string;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onSelectFilter: (filter: DashboardTaskFilter) => void;
  onOpenTasks: () => void;
}

function TasksDrilldown({
  entries,
  counts,
  filter,
  todayIso,
  loading,
  error,
  onRetry,
  onSelectFilter,
  onOpenTasks,
}: TasksDrilldownProps) {
  const { t } = useTranslation();
  const filtered = useMemo(
    () => filterTasksForDashboard(entries, filter, todayIso),
    [entries, filter, todayIso],
  );
  return (
    <>
      <div className="dashboard-chips">
        {DASHBOARD_TASK_FILTERS.map((item) => (
          <button
            key={item}
            type="button"
            className={item === filter ? "dashboard-chip active" : "dashboard-chip"}
            onClick={() => onSelectFilter(item)}
          >
            {t(`dashboard.tasks.filter.${item}`)}
            <span className="dashboard-chip-count">{counts[item]}</span>
          </button>
        ))}
      </div>
      {loading ? (
        <div className="dashboard-widget-skeleton" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      ) : error ? (
        <div className="dashboard-widget-error" role="alert">
          <p>{t("dashboard.widget.error")}</p>
          <button type="button" className="dashboard-widget-retry" onClick={onRetry}>
            <RefreshCcw size={12} strokeWidth={1.9} aria-hidden="true" />
            {t("dashboard.widget.retry")}
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <p className="dashboard-widget-empty">{t("dashboard.widget.empty")}</p>
      ) : (
        <ul className="dashboard-rows">
          {filtered.map((entry) => (
            <li key={entry.relPath}>
              <button type="button" className="dashboard-row" onClick={onOpenTasks}>
                <span className="dashboard-row-title">{entry.title}</span>
                <span className="dashboard-row-meta muted">
                  {[entry.projectLabels[0] ?? entry.project, entry.due, entry.status]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

interface ScheduleDrilldownProps {
  commitments: CalendarCommitment[];
  upcoming: TaskCalendarEvent[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}

function ScheduleDrilldown({ commitments, upcoming, loading, error, onRetry }: ScheduleDrilldownProps) {
  const { t } = useTranslation();
  if (loading) {
    return (
      <div className="dashboard-widget-skeleton" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    );
  }
  if (error) {
    return (
      <div className="dashboard-widget-error" role="alert">
        <p>{t("dashboard.widget.error")}</p>
        <button type="button" className="dashboard-widget-retry" onClick={onRetry}>
          {t("dashboard.widget.retry")}
        </button>
      </div>
    );
  }
  if (commitments.length === 0 && upcoming.length === 0) {
    return <p className="dashboard-widget-empty">{t("dashboard.widget.schedule.empty")}</p>;
  }
  return (
    <>
      <p className="dashboard-section-label">{t("dashboard.schedule.agenda")}</p>
      {commitments.length === 0 ? (
        <p className="dashboard-widget-empty">{t("dashboard.widget.empty")}</p>
      ) : (
        <ul className="dashboard-rows">
          {commitments.map((commitment) => (
            <li key={`${commitment.startIso}:${commitment.title}`} className="dashboard-row-static">
              <span className="dashboard-row-meta">
                {format(parseISO(commitment.startIso), "HH:mm")}
                {" - "}
                {format(parseISO(commitment.endIso), "HH:mm")}
              </span>
              <span className="dashboard-row-title">{commitment.title}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="dashboard-section-label">{t("dashboard.schedule.upcoming")}</p>
      {upcoming.length === 0 ? (
        <p className="dashboard-widget-empty">{t("dashboard.widget.empty")}</p>
      ) : (
        <ul className="dashboard-rows">
          {upcoming.map((event) => (
            <li key={event.id} className="dashboard-row-static">
              <span className="dashboard-row-meta">
                {format(event.start, event.allDay ? "MM/dd" : "MM/dd HH:mm")}
              </span>
              <span className="dashboard-row-title">{event.title}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

interface CatalogDrilldownProps {
  workPath: string | null;
  kind: CatalogItemKind;
  chips: ReturnType<typeof catalogKindChips>;
  onSelectKind: (kind: CatalogItemKind) => void;
}

function CatalogDrilldown({ workPath, kind, chips, onSelectKind }: CatalogDrilldownProps) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    if (!workPath) {
      setEntries([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    catalogQuery({ workspaceRoot: workPath, kinds: [kind], limit: 50 })
      .then((result) => {
        if (!cancelled) {
          setEntries(result);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workPath, kind, retryNonce]);

  return (
    <>
      <div className="dashboard-chips">
        {chips.map((chip) => (
          <button
            key={chip.key}
            type="button"
            className={chip.key === kind ? "dashboard-chip active" : "dashboard-chip"}
            onClick={() => onSelectKind(chip.key)}
          >
            {t(`dashboard.catalog.kind.${catalogKindKey(chip.key)}`)}
            <span className="dashboard-chip-count">{chip.count}</span>
          </button>
        ))}
      </div>
      {loading ? (
        <div className="dashboard-widget-skeleton" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      ) : error ? (
        <div className="dashboard-widget-error" role="alert">
          <p>{t("dashboard.widget.error")}</p>
          <button
            type="button"
            className="dashboard-widget-retry"
            onClick={() => setRetryNonce((value) => value + 1)}
          >
            {t("dashboard.widget.retry")}
          </button>
        </div>
      ) : entries.length === 0 ? (
        <p className="dashboard-widget-empty">{t("dashboard.widget.catalog.empty")}</p>
      ) : (
        <ul className="dashboard-rows">
          {entries.map((entry) => (
            <li key={entry.path} className="dashboard-row-static">
              <span className="dashboard-row-title">{entry.title}</span>
              <span className="dashboard-row-meta muted">
                {[entry.business_unit, entry.deadline].filter(Boolean).join(" · ")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

interface InboxDrilldownProps {
  items: ReturnType<typeof inboxSummary>["latest"];
  pendingCount: number;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  locale: "ko" | "en";
}

function InboxDrilldown({ items, pendingCount, loading, error, onRetry, locale }: InboxDrilldownProps) {
  const { t } = useTranslation();
  return (
    <>
      <p className="dashboard-section-label">
        {t("dashboard.inbox.pending", { count: pendingCount })}
      </p>
      {loading ? (
        <div className="dashboard-widget-skeleton" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      ) : error ? (
        <div className="dashboard-widget-error" role="alert">
          <p>{t("dashboard.widget.error")}</p>
          <button type="button" className="dashboard-widget-retry" onClick={onRetry}>
            <RefreshCcw size={12} strokeWidth={1.9} aria-hidden="true" />
            {t("dashboard.widget.retry")}
          </button>
        </div>
      ) : items.length === 0 ? (
        <p className="dashboard-widget-empty">{t("dashboard.widget.inbox.empty")}</p>
      ) : (
        <ul className="dashboard-rows">
          {items.map((item) => (
            <li key={item.id} className="dashboard-row-static">
              <span className="dashboard-row-title">{item.title}</span>
              {item.receivedAt ? (
                <span className="dashboard-row-meta muted">
                  {formatRelativeDate(item.receivedAt, locale)}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

interface RecentsDrilldownProps {
  entries: VaultEntry[];
  onOpenDocument: (entry: VaultEntry) => void;
}

function RecentsDrilldown({ entries, onOpenDocument }: RecentsDrilldownProps) {
  const { t, locale } = useTranslation();
  if (entries.length === 0) {
    return <p className="dashboard-widget-empty">{t("dashboard.widget.recents.empty")}</p>;
  }
  return (
    <ul className="dashboard-rows">
      {entries.map((entry) => (
        <li key={entry.path}>
          <button type="button" className="dashboard-row" onClick={() => onOpenDocument(entry)}>
            <span className="dashboard-row-title">{entry.title}</span>
            <span className="dashboard-row-meta muted">
              {[entry.relPath, formatRelativeDate(entry.updatedAt, locale)]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
