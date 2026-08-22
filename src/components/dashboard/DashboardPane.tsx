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
  agentStatusTiers,
  catalogKindChips,
  dashboardLogicalDay,
  draftStatusCounts,
  filterTasksForDashboard,
  gitSummary,
  inboxIntakeCounts,
  inboxSummary,
  planLaneCounts,
  planTopTitles,
  projectPortfolio,
  todayPressure,
  topRecentEntries,
  type DashboardTaskFilter,
  type DashboardView,
  type ProjectPortfolioRow,
} from "../../lib/dashboard";
import { formatRelativeDate } from "../../lib/document";
import { deriveDotSyncBadge } from "../../lib/dotSync";
import { useTranslation, type Locale } from "../../lib/i18n";
import type { MaruAppMode, TasksSettings } from "../../lib/settings";
import { taskFilterCounts, type TaskEntry } from "../../lib/tasks";
import type { VaultEntry } from "../../lib/types";
import { Button } from "../ui/Button";
import { DashboardWidget } from "./DashboardWidget";
import {
  useDashboardAgents,
  useDashboardCatalog,
  useDashboardDrafts,
  useDashboardGit,
  useDashboardInbox,
  useDashboardProjects,
  useDashboardSchedule,
  useDashboardSync,
  useDashboardTasks,
  useDashboardToday,
} from "./useDashboardData";

export interface DashboardPaneProps {
  workPath: string | null;
  effectiveSettings: TasksSettings;
  /** Rows each list renders before it stops (ui.dashboardListRows). */
  listRows: number;
  recentEntries: VaultEntry[];
  onOpenMode: (mode: Exclude<MaruAppMode, "pkm">) => void;
  onOpenDocument: (entry: VaultEntry) => void;
  onOpenSettings: (tab?: string | null) => void;
}

export function DashboardPane({
  workPath,
  effectiveSettings,
  listRows,
  recentEntries,
  onOpenMode,
  onOpenDocument,
  onOpenSettings,
}: DashboardPaneProps) {
  const { t, locale } = useTranslation();
  const [view, setView] = useState<DashboardView>("overview");
  const [taskFilter, setTaskFilter] = useState<DashboardTaskFilter>("today");
  const [catalogKind, setCatalogKind] = useState<CatalogItemKind>("deadline-due");
  const [projectCategoryFilter, setProjectCategoryFilter] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);

  const today = useDashboardToday(workPath, effectiveSettings, epoch);
  const tasks = useDashboardTasks(workPath, epoch);
  const schedule = useDashboardSchedule(workPath, effectiveSettings, epoch, today.data?.logicalDay ?? null);
  const catalog = useDashboardCatalog(workPath, epoch);
  const inbox = useDashboardInbox(workPath, epoch);
  const projects = useDashboardProjects(workPath, epoch);
  const agents = useDashboardAgents(workPath, epoch);
  const drafts = useDashboardDrafts(workPath, epoch);
  const git = useDashboardGit(workPath, epoch);
  const sync = useDashboardSync(epoch);

  const todayIso = useMemo(
    // Prefer the backend-computed logical day (configured timezone aware),
    // matching the Today flow; the local computation is the degraded fallback.
    () => today.data?.logicalDay ?? dashboardLogicalDay(new Date(), effectiveSettings.today.dayStart),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- epoch drives the refetch that produces today.data; keeping it here documents that relationship even though today.data alone would retrigger this memo
    [today.data, epoch, effectiveSettings.today.dayStart],
  );
  const taskEntries = useMemo(() => tasks.data ?? [], [tasks.data]);
  const taskCounts = useMemo(() => taskFilterCounts(taskEntries, todayIso), [taskEntries, todayIso]);
  const catalogChips = useMemo(() => catalogKindChips(catalog.data), [catalog.data]);
  const draftChips = useMemo(() => draftStatusCounts(drafts.data), [drafts.data]);
  const inboxData = useMemo(
    () => inboxSummary(inbox.data?.dropItems, inbox.data?.entries, listRows),
    [inbox.data, listRows],
  );
  const agentSummary = useMemo(
    () => (agents.data ? agentBoardSummary(agents.data) : null),
    [agents.data],
  );
  const agentTiers = useMemo(() => agentStatusTiers(agents.data), [agents.data]);
  const intakeCounts = useMemo(() => inboxIntakeCounts(inbox.data?.entries), [inbox.data]);
  const portfolio = useMemo(
    () => projectPortfolio(projects.data?.projects, projects.data?.activity, taskEntries, todayIso),
    [projects.data, taskEntries, todayIso],
  );
  const gitData = useMemo(() => gitSummary(git.data), [git.data]);
  const syncBadge = useMemo(() => deriveDotSyncBadge(sync.data), [sync.data]);
  const laneCounts = useMemo(() => planLaneCounts(today.data?.plan), [today.data]);
  const pressure = useMemo(() => todayPressure(today.data), [today.data]);
  const topTitles = useMemo(
    () => planTopTitles(today.data?.plan, taskEntries, effectiveSettings.today.topLaneSize),
    [today.data, taskEntries, effectiveSettings.today.topLaneSize],
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
      : view === "catalog"
        ? t("dashboard.widget.catalog.title")
        : view === "projects"
          ? t("dashboard.widget.projects.title")
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
        <>
        <div className="dashboard-status-strip">
          <DashboardWidget
            kind="agents"
            compact
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
                {agentTiers.length > 0 ? (
                  <p className="dashboard-inline-meta muted">
                    {agentTiers
                      .map((tier) => `${t(`dashboard.agents.status.${tier.key}`)} ${tier.count}`)
                      .join(" · ")}
                  </p>
                ) : null}
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
            compact
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
                <span
                  key={chip.key}
                  className={`dashboard-chip dashboard-chip-static${
                    chip.count === 0 ? " dashboard-chip-zero" : ""
                  }`}
                >
                  {t(`drafts.status.${chip.key}`)}
                  <span className="dashboard-chip-count">{chip.count}</span>
                </span>
              ))}
            </div>
          </DashboardWidget>


          <DashboardWidget
            kind="git"
            compact
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
            kind="sync"
            compact
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

        <div className="dashboard-grid">
          <DashboardWidget
            kind="today"
            title={t("dashboard.widget.today.title")}
            count={laneCounts.top > 0 ? laneCounts.top : null}
            onViewAll={() => onOpenMode("today")}
            loading={today.loading || schedule.loading}
            error={today.error ?? schedule.error}
            onRetry={() => {
              today.refresh();
              schedule.refresh();
            }}
            empty={
              (!effectiveSettings.today.enabled || laneCounts.top === 0) &&
              commitments.length === 0
            }
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
            {/* Pressure the lanes line cannot answer. Carryover is a count on
                purpose: this workspace runs three-digit piles, and a list of
                them would bury the plan it sits above. */}
            {pressure.carryovers > 0 ||
            pressure.overCapacity ||
            pressure.unconfirmed ||
            pressure.staleSources > 0 ||
            pressure.freeMinutes !== null ? (
              <div className="dashboard-today-pressure">
                {pressure.carryovers > 0 ? (
                  <span className="dashboard-pill">
                    {t("dashboard.today.carryover", { count: pressure.carryovers })}
                  </span>
                ) : null}
                {pressure.overCapacity ? (
                  <span className="dashboard-pill dashboard-pill-accent">
                    {t("dashboard.today.overCapacity")}
                  </span>
                ) : null}
                {pressure.unconfirmed ? (
                  <span className="dashboard-pill">{t("dashboard.today.unconfirmed")}</span>
                ) : null}
                {pressure.staleSources > 0 ? (
                  <span className="dashboard-pill">
                    {t("dashboard.today.staleSources", { count: pressure.staleSources })}
                  </span>
                ) : null}
                {pressure.freeMinutes !== null ? (
                  <span className="dashboard-inline-meta muted">
                    {t("dashboard.today.capacity", {
                      free: pressure.freeMinutes,
                      busy: pressure.busyMinutes ?? 0,
                    })}
                  </span>
                ) : null}
              </div>
            ) : null}
            {topTitles.length > 0 ? (
              <ol className="dashboard-list">
                {topTitles.map((title) => (
                  <li key={title} title={title}>
                    {title}
                  </li>
                ))}
              </ol>
            ) : null}
            {commitments.length > 0 ? (
              <>
                <p className="dashboard-section-label">{t("dashboard.schedule.agenda")}</p>
                <ul className="dashboard-list">
                  {commitments.slice(0, listRows).map((commitment) => (
                    <li key={`${commitment.startIso}:${commitment.title}`} title={commitment.title}>
                      <span className="dashboard-list-meta">
                        {format(parseISO(commitment.startIso), "HH:mm")}
                      </span>
                      {commitment.title}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </DashboardWidget>


          {/* Recents rides beside Today: the full-width Projects band below
              strands any card left alone on its side of it, which used to
              leave Today above and Recents below in half-empty rows. */}
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
              {topRecentEntries(recentEntries, listRows).map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    className="dashboard-link"
                    title={entry.title}
                    onClick={() => onOpenDocument(entry)}
                  >
                    {entry.title}
                  </button>
                </li>
              ))}
            </ul>
          </DashboardWidget>


          {/* The registry carries 60+ projects and nothing on this pane used to
              name a single one. Rows are the ones asking for a human: overdue
              work, or open work on a project nothing has touched in two weeks.
              Sub-projects fold into their parent here and split apart in the
              drilldown, which is the unit the project picker uses. */}
          <DashboardWidget
            kind="projects"
            title={t("dashboard.widget.projects.title")}
            count={portfolio.attentionCount > 0 ? portfolio.attentionCount : null}
            onViewAll={() => openDrilldown("projects")}
            loading={projects.loading}
            error={projects.error}
            onRetry={projects.refresh}
            empty={portfolio.rows.length === 0}
            emptyLabel={t("dashboard.widget.projects.empty")}
          >
            {portfolio.attention.length > 0 ? (
              <ul className="dashboard-rows">
                {portfolio.attention.slice(0, listRows).map((row) => (
                  <ProjectRow key={row.id} row={row} locale={locale} t={t} />
                ))}
              </ul>
            ) : (
              <p className="dashboard-inline-meta muted">{t("dashboard.projects.allClear")}</p>
            )}
            {portfolio.unassignedOpenTasks > 0 ? (
              <p className="dashboard-inline-meta muted">
                {t("dashboard.projects.unassigned", { count: portfolio.unassignedOpenTasks })}
              </p>
            ) : null}
          </DashboardWidget>

          {/* Task counts and catalog signals were two adjacent chip grids saying
              overlapping things: the catalog's `inbox-pending` and `task-due`
              kinds restated the Inbox card's badge and the task chips beside
              them, and because the catalog scan is a snapshot the two could
              disagree on screen. One card, one chip vocabulary, counts that
              come from the source that owns them. */}
          <DashboardWidget
            kind="attention"
            title={t("dashboard.widget.attention.title")}
            count={taskCounts.today + taskCounts.overdue}
            onViewAll={() => onOpenMode("tasks")}
            loading={tasks.loading}
            error={tasks.error}
            onRetry={tasks.refresh}
            empty={
              !catalog.error &&
              !catalog.loading &&
              taskEntries.length === 0 &&
              catalogChips.every((chip) => chip.count === 0)
            }
            emptyLabel={t("dashboard.widget.attention.empty")}
          >
            <p className="dashboard-section-label">{t("dashboard.widget.tasks.title")}</p>
            <div className="dashboard-chips">
              {DASHBOARD_TASK_FILTERS.map((filter) => (
                <button
                  key={filter}
                  type="button"
                  className={`dashboard-chip${taskCounts[filter] === 0 ? " dashboard-chip-zero" : ""}`}
                  onClick={() => openTaskFilter(filter)}
                >
                  {t(`dashboard.tasks.filter.${filter}`)}
                  <span className="dashboard-chip-count">{taskCounts[filter]}</span>
                </button>
              ))}
            </div>
            <p className="dashboard-section-label">{t("dashboard.widget.catalog.title")}</p>
            {/* The catalog scan fails on its own schedule. Merging the two chip
                groups must not merge their failure: a dead scan takes out this
                group only, and the task chips above keep rendering. */}
            {catalog.error ? (
              <div className="dashboard-widget-error" role="alert">
                <p>{t("dashboard.widget.error")}</p>
                <button
                  type="button"
                  className="dashboard-widget-retry"
                  onClick={catalog.refresh}
                >
                  <RefreshCcw size={12} strokeWidth={1.9} aria-hidden="true" />
                  {t("dashboard.widget.retry")}
                </button>
              </div>
            ) : (
              <div className="dashboard-chips">
                {catalogChips.map((chip) => (
                  <button
                    key={chip.key}
                    type="button"
                    className={`dashboard-chip${chip.count === 0 ? " dashboard-chip-zero" : ""}`}
                    onClick={() => openCatalogKind(chip.key)}
                  >
                    {t(`dashboard.catalog.kind.${catalogKindKey(chip.key)}`)}
                    <span className="dashboard-chip-count">{chip.count}</span>
                  </button>
                ))}
              </div>
            )}
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
                <li key={item.id} title={item.title}>
                  <span className="dashboard-list-meta">
                    {formatRelativeDate(item.receivedAt, locale)}
                  </span>
                  {item.title}
                </li>
              ))}
            </ul>
            {/* The badge above merges drop files with pending entries, which is
                the right total but hides which half a human has to stage. */}
            {intakeCounts.auto + intakeCounts.manual > 0 ? (
              <p className="dashboard-inline-meta muted">
                {t("dashboard.inbox.intake", {
                  auto: intakeCounts.auto,
                  manual: intakeCounts.manual,
                })}
              </p>
            ) : null}
          </DashboardWidget>
        </div>
        </>
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
          ) : view === "catalog" ? (
            <CatalogDrilldown
              workPath={workPath}
              kind={catalogKind}
              chips={catalogChips}
              onSelectKind={setCatalogKind}
            />
          ) : view === "projects" ? (
            <ProjectsDrilldown
              portfolio={portfolio}
              category={projectCategoryFilter}
              locale={locale}
              t={t}
              onSelectCategory={setProjectCategoryFilter}
              onOpenTasks={() => onOpenMode("tasks")}
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


type Translate = (key: string, vars?: Record<string, string | number>) => string;

interface ProjectRowProps {
  row: ProjectPortfolioRow;
  locale: Locale;
  t: Translate;
}

/** One project line: what is late, what is open, and when the project last
 *  showed a sign of life. Meeting day and file activity answer different
 *  questions (people vs work), so both are shown when present. */
function ProjectRow({ row, locale, t }: ProjectRowProps) {
  const meta = [
    row.overdueTasks > 0 ? t("dashboard.projects.overdue", { count: row.overdueTasks }) : null,
    row.openTasks > 0 ? t("dashboard.projects.open", { count: row.openTasks }) : null,
    row.lastActivityAt
      ? t("dashboard.projects.lastActivity", {
          time: formatRelativeDate(row.lastActivityAt, locale),
        })
      : t("dashboard.projects.noActivity"),
    row.lastMeetingDay
      ? t("dashboard.projects.lastMeeting", {
          time: formatRelativeDate(row.lastMeetingDay, locale),
        })
      : null,
  ].filter((value): value is string => Boolean(value));

  return (
    <li className="dashboard-row-static dashboard-project-row" title={row.path}>
      <span className="dashboard-row-title">{row.name}</span>
      <span className="dashboard-row-meta">{meta.join(" · ")}</span>
    </li>
  );
}

interface ProjectsDrilldownProps {
  portfolio: ReturnType<typeof projectPortfolio>;
  category: string | null;
  locale: Locale;
  t: Translate;
  onSelectCategory: (category: string | null) => void;
  onOpenTasks: () => void;
}

/** The full registry, unfolded to the same unit as the project picker, with
 *  category chips built from the data (the registry has no category field, so
 *  the labels are path segments and stay untranslated). */
function ProjectsDrilldown({
  portfolio,
  category,
  locale,
  t,
  onSelectCategory,
  onOpenTasks,
}: ProjectsDrilldownProps) {
  const rows = category
    ? portfolio.allRows.filter((row) => row.category === category)
    : portfolio.allRows;

  return (
    <>
      <div className="dashboard-chips">
        <button
          type="button"
          className={`dashboard-chip${category === null ? " active" : ""}`}
          onClick={() => onSelectCategory(null)}
        >
          {t("dashboard.projects.allCategories")}
          <span className="dashboard-chip-count">{portfolio.allRows.length}</span>
        </button>
        {portfolio.categories.map((chip) => (
          <button
            key={chip.key}
            type="button"
            className={`dashboard-chip${category === chip.key ? " active" : ""}`}
            onClick={() => onSelectCategory(chip.key)}
          >
            {chip.key}
            <span className="dashboard-chip-count">{chip.count}</span>
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <p className="dashboard-widget-empty">{t("dashboard.widget.projects.empty")}</p>
      ) : (
        <ul className="dashboard-rows">
          {rows.map((row) => (
            <ProjectRow key={row.id} row={row} locale={locale} t={t} />
          ))}
        </ul>
      )}
      <div className="dashboard-drilldown-footer">
        <Button size="sm" variant="secondary" onClick={onOpenTasks}>
          {t("dashboard.projects.openTasks")}
        </Button>
      </div>
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
