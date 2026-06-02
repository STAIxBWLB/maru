import {
  AlertTriangle,
  Calendar as CalendarIcon,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  ClipboardCheck,
  FilePlus2,
  FileText,
  FolderOpen,
  GitCompare,
  History,
  Languages,
  Link2,
  List,
  Loader2,
  Pencil,
  Play,
  RefreshCcw,
  RotateCw,
  Search,
  Settings,
  ShieldAlert,
  Square,
  Trash2,
  Users,
  WandSparkles,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  appendMeetingsLog,
  chooseFiles,
  readDocument,
  readMeetingGuides,
  readMeetingMetadata,
  readMeetingsLog,
  scanMeetingNotes,
  searchCalendarNotes,
} from "../../lib/api";
import {
  logLinePhase,
  logLineSeverity,
  parseMeetingsLogLine,
  serializeMeetingsLogLine,
  stripMeetingsLogStreamPrefix,
  type MeetingsLogEventInput,
  type MeetingsLogLine,
} from "../../lib/meetingsLog";
import { useTranslation } from "../../lib/i18n";
import {
  createMeetingReviewChecks,
  deriveMeetingRunSteps,
  emptyMeetingReviewArtifact,
  extractProviderOutput,
  extractSkillProposal,
  meetingReviewCanApply,
  meetingReviewChecksComplete,
  parseMeetingReviewArtifact,
  rebuildSkillProposal,
  selectedMeetingFollowupCount,
  selectedProposalFileCount,
  type MeetingFollowupCandidate,
  type MeetingProposalFileDraft,
  type MeetingReviewArtifact,
  type MeetingReviewCheck,
  type MeetingReviewCheckKind,
  type MeetingReviewCheckStatus,
} from "../../lib/meetingReview";
import {
  activeMeetingsMissions,
  filterMeetingsByQuery,
  rowsToMeetingEntries,
  type MeetingNoteEntry,
} from "../../lib/meetings";
import {
  buildMeetingNotesPrompt,
  type MeetingSourceKind,
} from "../../lib/meetingNotesPrompt";
import { UnifiedCalendarView } from "../calendar/UnifiedCalendarView";
import { toUnifiedMeetingEvents } from "../../lib/calendar/fromEntries";
import type { CalendarView as UnifiedCalendarViewMode } from "../../lib/calendar/types";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import type { DocumentLabelMode, MeetingsSettings } from "../../lib/settings";
import {
  SKILL_PROPOSAL_APPLY_APPROVAL_KIND,
  agentApplySkillProposal,
  agentParseSkillProposal,
  agentReadRunEvents,
  skillsDispatchBackground,
  skillsRuntimeStatus,
  type SkillDispatchRuntime,
  type SkillContextItem,
  type SkillRuntimeStatus,
  type SkillProposal,
  type SkillRecord,
} from "../../lib/skills";
import type {
  MeetingMetadata,
  MeetingNoteRow,
  MeetingsLogLineRecord,
  MissionRecord,
} from "../../lib/types";

type MeetingsView = "all" | "month" | "transcript" | "external" | "date" | "activity";
type DisplayMode = "list" | "calendar";

const MEETINGS_PROGRESS_DOCK_DEFAULT_HEIGHT = 220;
const MEETINGS_PROGRESS_DOCK_MIN_HEIGHT = 96;
const MEETINGS_PROGRESS_DOCK_MAX_VIEWPORT_RATIO = 0.55;

interface MeetingsProgressDockLayout {
  collapsed: boolean;
  height: number;
}

interface MeetingsPaneProps {
  workPath: string | null;
  settings: MeetingsSettings;
  effectiveSettings: MeetingsSettings;
  labelMode: DocumentLabelMode;
  skills: SkillRecord[];
  runtimeCommands: Partial<Record<SkillDispatchRuntime, string | null>>;
  permissionMode?: string | null;
  processingMissions: MissionRecord[];
  processingLogLines: Record<string, string[]>;
  onRefreshMissions: () => void;
  onOpenSettings: () => void;
  onOpenSkillCompose: (
    skill: SkillRecord | null,
    context: SkillContextItem[],
    prompt?: string,
  ) => void;
  onMissionStarted: (invocationId: string) => void;
  onStopMission: (id: string) => void;
  onConfirmApproval: (input: {
    kind: string;
    summary: string;
    target?: string | null;
    payloadPreview?: string | null;
  }) => Promise<string | null>;
  onRevealPath?: (path: string) => void;
  onError: (message: string | null) => void;
  /** When set, the pane switches to this view once and calls onViewConsumed. */
  requestedView?: MeetingsView | null;
  onViewConsumed?: () => void;
}

export function MeetingsPane({
  workPath,
  settings,
  effectiveSettings,
  labelMode,
  skills,
  runtimeCommands,
  permissionMode,
  processingMissions,
  processingLogLines,
  onRefreshMissions,
  onOpenSettings,
  onOpenSkillCompose,
  onMissionStarted,
  onStopMission,
  onConfirmApproval,
  onRevealPath,
  onError,
  requestedView,
  onViewConsumed,
}: MeetingsPaneProps) {
  const { t, locale } = useTranslation();
  const [view, setView] = useState<MeetingsView>("all");
  const [displayMode, setDisplayMode] = useState<DisplayMode>("list");
  const [calendarView, setCalendarView] = useState<UnifiedCalendarViewMode>("month");
  const [viewDate, setViewDate] = useState<Date>(() => new Date());
  const [bodyHits, setBodyHits] = useState<Set<string>>(() => new Set());
  const [rows, setRows] = useState<MeetingNoteRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 250);
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [lookupDate, setLookupDate] = useState(() => todayIso());
  const [selectedRelPath, setSelectedRelPath] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<MeetingMetadata | null>(null);
  const [metadataLoading, setMetadataLoading] = useState(false);
  const clearedRunStorageKey = useMemo(
    () => `anchor:meetings:cleared-runs:${workPath ?? "no-workspace"}`,
    [workPath],
  );
  const progressDockStorageKey = useMemo(
    () => `anchor:meetings:progress-dock:${workPath ?? "no-workspace"}`,
    [workPath],
  );
  const [clearedRunIds, setClearedRunIds] = useState<Set<string>>(() =>
    readClearedMeetingRunIds(clearedRunStorageKey),
  );
  const [lastClearedMissionId, setLastClearedMissionId] = useState<string | null>(null);
  const [optimisticMeetingsMissions, setOptimisticMeetingsMissions] = useState<MissionRecord[]>([]);
  const [progressDockLayout, setProgressDockLayout] = useState<MeetingsProgressDockLayout>(() =>
    readMeetingsProgressDockLayout(progressDockStorageKey),
  );

  const entries = useMemo(() => rowsToMeetingEntries(rows), [rows]);
  const availableTypes = useMemo(
    () => Array.from(new Set(entries.map((entry) => entry.type))).sort((a, b) => a.localeCompare(b)),
    [entries],
  );
  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.relPath === selectedRelPath) ?? entries[0] ?? null,
    [entries, selectedRelPath],
  );
  const monthKey = useMemo(() => todayIso().slice(0, 7), []);
  const viewEntries = useMemo(() => {
    const scoped =
      view === "month"
        ? entries.filter((entry) => entry.date.startsWith(monthKey))
        : view === "date"
          ? entries.filter((entry) => entry.date === lookupDate)
          : entries;
    const titleMatches = filterMeetingsByQuery(scoped, query, typeFilter === "all" ? [] : [typeFilter]);
    if (bodyHits.size === 0) return titleMatches;
    const bodyMatched = filterMeetingsByQuery(
      scoped.filter((entry) => bodyHits.has(entry.relPath)),
      "",
      typeFilter === "all" ? [] : [typeFilter],
    );
    const seen = new Set<string>();
    const merged: MeetingNoteEntry[] = [];
    for (const entry of [...titleMatches, ...bodyMatched]) {
      if (seen.has(entry.relPath)) continue;
      seen.add(entry.relPath);
      merged.push(entry);
    }
    return merged;
  }, [entries, lookupDate, monthKey, query, typeFilter, view, bodyHits]);
  const calendarEvents = useMemo(() => toUnifiedMeetingEvents(viewEntries), [viewEntries]);
  const todayDate = useMemo(() => new Date(), []);
  const meetingsMissions = useMemo(
    () => mergeMeetingsMissions(activeMeetingsMissions(processingMissions), optimisticMeetingsMissions),
    [optimisticMeetingsMissions, processingMissions],
  );
  const visibleMeetingsMissions = useMemo(
    () => meetingsMissions.filter((mission) => !clearedRunIds.has(mission.id)),
    [clearedRunIds, meetingsMissions],
  );

  useEffect(() => {
    setClearedRunIds(readClearedMeetingRunIds(clearedRunStorageKey));
    setLastClearedMissionId(null);
    setOptimisticMeetingsMissions([]);
  }, [clearedRunStorageKey]);

  useEffect(() => {
    setProgressDockLayout(readMeetingsProgressDockLayout(progressDockStorageKey));
  }, [progressDockStorageKey]);

  const updateProgressDockLayout = useCallback(
    (patch: Partial<MeetingsProgressDockLayout>) => {
      setProgressDockLayout((current) => {
        const next = {
          ...current,
          ...patch,
          height: clampMeetingsProgressDockHeight(patch.height ?? current.height),
        };
        writeMeetingsProgressDockLayout(progressDockStorageKey, next);
        return next;
      });
    },
    [progressDockStorageKey],
  );

  const recordOptimisticMeetingMission = useCallback((mission: MissionRecord) => {
    setOptimisticMeetingsMissions((current) =>
      mergeMeetingsMissions([mission], current).slice(0, 20),
    );
  }, []);

  useEffect(() => {
    if (!workPath) {
      setBodyHits(new Set());
      return;
    }
    const trimmed = debouncedQuery.trim();
    if (trimmed.length < 2) {
      setBodyHits(new Set());
      return;
    }
    let cancelled = false;
    void searchCalendarNotes(workPath, [effectiveSettings.root ?? "meetings"], trimmed)
      .then((paths) => {
        if (!cancelled) setBodyHits(new Set(paths));
      })
      .catch((err) => {
        if (!cancelled) onError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, workPath, effectiveSettings.root, onError]);

  const clearMeetingMission = useCallback((id: string) => {
    setClearedRunIds((current) => {
      if (current.has(id)) return current;
      const next = new Set(current);
      next.add(id);
      writeClearedMeetingRunIds(clearedRunStorageKey, next);
      return next;
    });
    setLastClearedMissionId(id);
    const mission = meetingsMissions.find((m) => m.id === id) ?? null;
    if (workPath && effectiveSettings.hooks.appendVaultLog) {
      void appendMeetingsLog(
        workPath,
        serializeMeetingsLogLine({
          event: "clear",
          runId: id,
          status: "cleared",
          skill: mission ? meetingMissionSkillName(mission) ?? "meeting-notes" : "meeting-notes",
          target: mission ? meetingMissionTitle(mission) : undefined,
        }),
      ).catch((err) => console.warn("meetings clear audit log failed", err));
    }
  }, [
    clearedRunStorageKey,
    effectiveSettings.hooks.appendVaultLog,
    meetingsMissions,
    workPath,
  ]);

  const undoClearMission = useCallback((id: string) => {
    setClearedRunIds((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      writeClearedMeetingRunIds(clearedRunStorageKey, next);
      return next;
    });
    setLastClearedMissionId(null);
    if (workPath && effectiveSettings.hooks.appendVaultLog) {
      void appendMeetingsLog(
        workPath,
        serializeMeetingsLogLine({
          event: "clear",
          runId: id,
          status: "undone",
          skill: "meeting-notes",
        }),
      ).catch(() => {});
    }
  }, [clearedRunStorageKey, effectiveSettings.hooks.appendVaultLog, workPath]);

  useEffect(() => {
    if (!lastClearedMissionId) return;
    const handle = window.setTimeout(() => setLastClearedMissionId(null), 6000);
    return () => window.clearTimeout(handle);
  }, [lastClearedMissionId]);

  const refresh = useCallback(async () => {
    if (!workPath || !effectiveSettings.enabled) {
      setRows([]);
      return;
    }
    setLoading(true);
    onError(null);
    try {
      const next = await scanMeetingNotes(workPath, effectiveSettings.root);
      setRows(next);
      setSelectedRelPath((current) =>
        current && next.some((row) => row.relPath === current)
          ? current
          : rowsToMeetingEntries(next)[0]?.relPath ?? null,
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [effectiveSettings.enabled, effectiveSettings.root, onError, workPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!workPath || !selectedEntry) {
      setMetadata(null);
      return;
    }
    let cancelled = false;
    setMetadataLoading(true);
    void readMeetingMetadata(workPath, selectedEntry.relPath)
      .then((next) => {
        if (!cancelled) setMetadata(next);
      })
      .catch((err) => {
        if (!cancelled) onError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setMetadataLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [onError, selectedEntry, workPath]);

  // "New meeting note" leads into the dedicated Transcript workbench (paste /
  // file input → tracked run → review → followups) instead of a generic
  // terminal free-run. The External tab is one click away for auto-organized
  // notes.
  const openNewMeeting = useCallback(() => {
    setView("transcript");
  }, []);

  // Honor an external view request (e.g. the Apply-skill dialog nudge routing
  // the user to the meeting-notes workbench).
  useEffect(() => {
    if (!requestedView) return;
    setView(requestedView);
    onViewConsumed?.();
  }, [requestedView, onViewConsumed]);

  return (
    <section className="meetings-pane">
      <MeetingsSidebar
        view={view}
        entries={entries}
        monthKey={monthKey}
        lookupDate={lookupDate}
        onView={setView}
      />
      <main className="meetings-main">
        <MeetingsActionsBar
          loading={loading}
          displayMode={displayMode}
          onDisplayMode={setDisplayMode}
          onRefresh={() => {
            void refresh();
            onRefreshMissions();
          }}
          onNewMeeting={openNewMeeting}
          onOpenSettings={onOpenSettings}
        />
        {view === "activity" ? (
          <MeetingsActivityPane workPath={workPath} onError={onError} />
        ) : view === "transcript" ? (
          <MeetingsTranscriptFlow
            workPath={workPath}
            settings={effectiveSettings}
            skills={skills}
            runtimeCommands={runtimeCommands}
            permissionMode={permissionMode}
            missions={visibleMeetingsMissions}
            logLines={processingLogLines}
            onMissionStarted={onMissionStarted}
            onLocalMissionStarted={recordOptimisticMeetingMission}
            onStopMission={onStopMission}
            onClearMission={clearMeetingMission}
            lastClearedMissionId={lastClearedMissionId}
            onUndoClearMission={undoClearMission}
            onRefreshMissions={onRefreshMissions}
            onConfirmApproval={onConfirmApproval}
            onApplied={() => void refresh()}
            onError={onError}
          />
        ) : view === "external" ? (
          <MeetingsExternalFlow
            workPath={workPath}
            settings={effectiveSettings}
            skills={skills}
            runtimeCommands={runtimeCommands}
            permissionMode={permissionMode}
            missions={visibleMeetingsMissions}
            logLines={processingLogLines}
            onMissionStarted={onMissionStarted}
            onLocalMissionStarted={recordOptimisticMeetingMission}
            onStopMission={onStopMission}
            onClearMission={clearMeetingMission}
            lastClearedMissionId={lastClearedMissionId}
            onUndoClearMission={undoClearMission}
            onRefreshMissions={onRefreshMissions}
            onConfirmApproval={onConfirmApproval}
            onApplied={() => void refresh()}
            onError={onError}
          />
        ) : (
          <>
            <div className="meetings-toolbar">
              <label className="search-box meetings-search" title={t("meetings.search")}>
                <Search size={14} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("meetings.search")}
                />
              </label>
              <select
                className="meetings-select"
                value={typeFilter}
                onChange={(event) => setTypeFilter(event.target.value)}
                aria-label={t("meetings.typeFilter")}
              >
                <option value="all">{t("meetings.type.all")}</option>
                {availableTypes.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </div>
            {view === "date" ? (
              <MeetingsDateLookup
                date={lookupDate}
                entries={entries.filter((entry) => entry.date === lookupDate)}
                onDate={setLookupDate}
                onSelect={(entry) => setSelectedRelPath(entry.relPath)}
              />
            ) : null}
            <div className="meetings-content-grid">
              <section className="meetings-browser">
                {displayMode === "calendar" ? (
                  <UnifiedCalendarView<MeetingNoteEntry>
                    events={calendarEvents}
                    loading={loading}
                    view={calendarView}
                    viewDate={viewDate}
                    weekStartsOn={1}
                    locale={locale}
                    labelMode={labelMode}
                    today={todayDate}
                    query={query}
                    onQueryChange={setQuery}
                    onViewChange={setCalendarView}
                    onViewDateChange={setViewDate}
                    onSelectEvent={(event) => setSelectedRelPath(event.resource.relPath)}
                    onSelectDate={(date) => {
                      if (calendarView === "month") setCalendarView("day");
                      setViewDate(date);
                    }}
                    searchPlaceholder={t("meetings.search")}
                    emptyLabel={t("meetings.calendar.empty")}
                    startHour={effectiveSettings.calendarStartHour}
                    loadingLabel={t("meetings.loading")}
                  />
                ) : (
                  <MeetingsListView
                    entries={viewEntries}
                    selectedRelPath={selectedEntry?.relPath ?? null}
                    loading={loading}
                    onSelect={(entry) => setSelectedRelPath(entry.relPath)}
                  />
                )}
              </section>
              <MeetingsDetailPane
                entry={selectedEntry}
                metadata={metadata}
                loading={metadataLoading}
                settings={effectiveSettings}
                skills={skills}
                workPath={workPath}
                onOpenSkillCompose={onOpenSkillCompose}
                onRevealPath={onRevealPath}
                onError={onError}
              />
            </div>
          </>
        )}
        {view === "transcript" || view === "external" ? null : (
          <MeetingsProgressDock
            missions={visibleMeetingsMissions}
            logLines={processingLogLines}
            collapsed={progressDockLayout.collapsed}
            height={progressDockLayout.height}
            onCollapsedChange={(collapsed) => updateProgressDockLayout({ collapsed })}
            onHeightChange={(height) => updateProgressDockLayout({ height })}
            onStopMission={onStopMission}
          />
        )}
      </main>
    </section>
  );
}

function MeetingsSidebar({
  view,
  entries,
  monthKey,
  lookupDate,
  onView,
}: {
  view: MeetingsView;
  entries: MeetingNoteEntry[];
  monthKey: string;
  lookupDate: string;
  onView: (view: MeetingsView) => void;
}) {
  const { t } = useTranslation();
  const monthCount = entries.filter((entry) => entry.date.startsWith(monthKey)).length;
  const dateCount = entries.filter((entry) => entry.date === lookupDate).length;
  type SidebarItem = {
    id: MeetingsView;
    label: string;
    hint?: string;
    count?: number;
    icon: ReactNode;
  };
  // The two source flows lead — they are how a transcript / auto-organized note
  // becomes a tracked, reviewable meeting note.
  const createItems: SidebarItem[] = [
    {
      id: "transcript",
      label: t("meetings.sidebar.transcript"),
      hint: t("meetings.sidebar.transcriptHint"),
      icon: <FileText size={15} />,
    },
    {
      id: "external",
      label: t("meetings.sidebar.external"),
      hint: t("meetings.sidebar.externalHint"),
      icon: <WandSparkles size={15} />,
    },
  ];
  const browseItems: SidebarItem[] = [
    { id: "all", label: t("meetings.sidebar.all"), count: entries.length, icon: <List size={15} /> },
    { id: "month", label: t("meetings.sidebar.month"), count: monthCount, icon: <CalendarIcon size={15} /> },
    { id: "date", label: t("meetings.sidebar.date"), count: dateCount, icon: <Search size={15} /> },
    { id: "activity", label: t("meetings.sidebar.activity"), icon: <History size={15} /> },
  ];
  const renderItem = (item: SidebarItem) => (
    <button
      key={item.id}
      type="button"
      className={view === item.id ? "meetings-sidebar-item active" : "meetings-sidebar-item"}
      onClick={() => onView(item.id)}
    >
      {item.icon}
      <span className="meetings-sidebar-item-label">
        <span>{item.label}</span>
        {item.hint ? <small>{item.hint}</small> : null}
      </span>
      {typeof item.count === "number" ? <strong>{item.count}</strong> : null}
    </button>
  );
  return (
    <aside className="meetings-sidebar">
      <div className="meetings-sidebar-head">
        <strong>{t("meetings.title")}</strong>
        <span>{t("meetings.subtitle", { count: entries.length })}</span>
      </div>
      <div className="meetings-sidebar-list">
        <span className="meetings-sidebar-caption">{t("meetings.sidebar.createGroup")}</span>
        {createItems.map(renderItem)}
        <span className="meetings-sidebar-caption">{t("meetings.sidebar.browseGroup")}</span>
        {browseItems.map(renderItem)}
      </div>
    </aside>
  );
}

function MeetingsActionsBar({
  loading,
  displayMode,
  onDisplayMode,
  onRefresh,
  onNewMeeting,
  onOpenSettings,
}: {
  loading: boolean;
  displayMode: DisplayMode;
  onDisplayMode: (mode: DisplayMode) => void;
  onRefresh: () => void;
  onNewMeeting: () => void;
  onOpenSettings: () => void;
}) {
  const { t } = useTranslation();
  return (
    <header className="meetings-actions-bar">
      <div>
        <h1>{t("meetings.title")}</h1>
        <p>{t("meetings.header.description")}</p>
      </div>
      <div className="meetings-actions">
        <div className="segmented-control" role="group" aria-label={t("meetings.displayMode")}>
          <button
            type="button"
            className={displayMode === "list" ? "active" : ""}
            onClick={() => onDisplayMode("list")}
          >
            <List size={14} />
            <span>{t("meetings.display.list")}</span>
          </button>
          <button
            type="button"
            className={displayMode === "calendar" ? "active" : ""}
            onClick={() => onDisplayMode("calendar")}
          >
            <CalendarIcon size={14} />
            <span>{t("meetings.display.calendar")}</span>
          </button>
        </div>
        <button type="button" className="icon-button" onClick={onRefresh} aria-label={t("meetings.refresh")} title={t("meetings.refresh")}>
          <RefreshCcw size={14} className={loading ? "spin" : ""} />
        </button>
        <button type="button" className="secondary-button" onClick={onNewMeeting}>
          <FilePlus2 size={14} />
          {t("meetings.new")}
        </button>
        <button type="button" className="icon-button" onClick={onOpenSettings} aria-label={t("meetings.settings")} title={t("meetings.settings")}>
          <Settings size={14} />
        </button>
      </div>
    </header>
  );
}

function MeetingsListView({
  entries,
  selectedRelPath,
  loading,
  onSelect,
}: {
  entries: MeetingNoteEntry[];
  selectedRelPath: string | null;
  loading: boolean;
  onSelect: (entry: MeetingNoteEntry) => void;
}) {
  const { t } = useTranslation();
  if (loading) {
    return (
      <div className="meetings-empty">
        <Loader2 size={20} className="spin" />
        <span>{t("meetings.loading")}</span>
      </div>
    );
  }
  if (entries.length === 0) {
    return <div className="meetings-empty">{t("meetings.empty")}</div>;
  }
  return (
    <div className="meetings-list" role="list">
      {entries.map((entry) => (
        <button
          key={entry.relPath}
          type="button"
          className={entry.relPath === selectedRelPath ? "meetings-list-row active" : "meetings-list-row"}
          onClick={() => onSelect(entry)}
          title={entry.relPath}
        >
          <time>{entry.date}</time>
          <span className="meetings-type-chip">{entry.type}</span>
          <strong>{entry.topic}</strong>
          {entry.detail ? <span>{entry.detail}</span> : null}
        </button>
      ))}
    </div>
  );
}

function MeetingsDateLookup({
  date,
  entries,
  onDate,
  onSelect,
}: {
  date: string;
  entries: MeetingNoteEntry[];
  onDate: (date: string) => void;
  onSelect: (entry: MeetingNoteEntry) => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="meetings-date-lookup">
      <label className="field">
        <span>{t("meetings.dateLookup.label")}</span>
        <input type="date" value={date} onChange={(event) => onDate(event.target.value)} />
      </label>
      <div className="meetings-date-results">
        <strong>{t("meetings.dateLookup.count", { count: entries.length })}</strong>
        {entries.map((entry) => (
          <button key={entry.relPath} type="button" onClick={() => onSelect(entry)}>
            {entry.type} · {entry.topic}
          </button>
        ))}
      </div>
    </section>
  );
}

function MeetingsDetailPane({
  entry,
  metadata,
  loading,
  settings,
  skills,
  workPath,
  onOpenSkillCompose,
  onRevealPath,
  onError,
}: {
  entry: MeetingNoteEntry | null;
  metadata: MeetingMetadata | null;
  loading: boolean;
  settings: MeetingsSettings;
  skills: SkillRecord[];
  workPath: string | null;
  onOpenSkillCompose: (
    skill: SkillRecord | null,
    context: SkillContextItem[],
    prompt?: string,
  ) => void;
  onRevealPath?: (path: string) => void;
  onError: (message: string | null) => void;
}) {
  const { t } = useTranslation();
  if (!entry) return <aside className="meetings-detail-pane empty">{t("meetings.detail.empty")}</aside>;
  const context = [{ path: entry.absPath, kind: "document" }];
  const runFollowup = async (skillName: string, prompt: string) => {
    const skill = findSkill(skills, skillName);
    if (settings.hooks.appendVaultLog && workPath) {
      try {
        await appendMeetingsLog(
          workPath,
          `- ${new Date().toISOString()} ${skillName}: ${entry.relPath}`,
        );
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      }
    }
    onOpenSkillCompose(skill, context, prompt);
  };
  return (
    <aside className="meetings-detail-pane">
      <header>
        <div>
          <span>{entry.date}</span>
          <h2>{entry.topic}</h2>
          <p>{entry.type}{entry.detail ? ` · ${entry.detail}` : ""}</p>
        </div>
        {onRevealPath ? (
          <button type="button" className="icon-button" onClick={() => onRevealPath(entry.absPath)} title={t("context.revealInFinder")} aria-label={t("context.revealInFinder")}>
            <FolderOpen size={14} />
          </button>
        ) : null}
      </header>
      <div className="meetings-detail-meta">
        {metadata?.tags.map((tag) => (
          <span key={tag}>#{tag}</span>
        ))}
        {metadata?.attendees.map((person) => (
          <span key={person}>{person}</span>
        ))}
      </div>
      <pre className="meetings-preview">
        {loading ? t("meetings.detail.loading") : metadata?.preview ?? t("meetings.detail.noPreview")}
      </pre>
      <div className="meetings-detail-actions">
        {settings.hooks.autoVaultExtract ? (
          <button
            type="button"
            className="secondary-button"
            onClick={() =>
              void runFollowup(
                "vault-extract",
                `Extract durable knowledge from this meeting note: ${entry.relPath}`,
              )
            }
          >
            <FileText size={14} />
            {t("meetings.action.vaultExtract")}
          </button>
        ) : null}
        {settings.hooks.autoVaultConnect ? (
          <button
            type="button"
            className="secondary-button"
            onClick={() =>
              void runFollowup(
                "vault-connect",
                `Connect wiki links and related notes for this meeting note: ${entry.relPath}`,
              )
            }
          >
            <Link2 size={14} />
            {t("meetings.action.vaultConnect")}
          </button>
        ) : null}
        {settings.hooks.autoTaskExtract ? (
          <button
            type="button"
            className="secondary-button"
            onClick={() =>
              void runFollowup(
                "task-management",
                `Extract and register action items from this meeting note: ${entry.relPath}`,
              )
            }
          >
            <CheckCircle2 size={14} />
            {t("meetings.action.task")}
          </button>
        ) : null}
      </div>
    </aside>
  );
}

const ACTIVITY_EVENT_FILTERS: readonly string[] = [
  "apply",
  "clear",
  "error",
  "retry",
  "followup",
  "start",
];

function MeetingsActivityPane({
  workPath,
  onError,
}: {
  workPath: string | null;
  onError: (message: string | null) => void;
}) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<MeetingsLogLineRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [activeEvents, setActiveEvents] = useState<Set<string>>(
    () => new Set(ACTIVITY_EVENT_FILTERS),
  );
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const refresh = useCallback(async () => {
    if (!workPath) {
      setEntries([]);
      return;
    }
    setLoading(true);
    onError(null);
    try {
      const next = await readMeetingsLog(workPath, { limit: 500 });
      setEntries(next);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [onError, workPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return entries.filter((entry) => {
      if (!activeEvents.has(entry.event)) return false;
      if (!needle) return true;
      const haystack = [
        entry.target ?? "",
        entry.runId ?? "",
        entry.skill ?? "",
        entry.raw,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [activeEvents, entries, search]);

  const groups = useMemo(() => groupActivityByDay(filtered), [filtered]);

  const toggleEvent = (event: string) => {
    setActiveEvents((current) => {
      const next = new Set(current);
      if (next.has(event)) next.delete(event);
      else next.add(event);
      return next;
    });
  };

  return (
    <section className="meetings-activity">
      <header className="meetings-activity-head">
        <div>
          <h2>{t("meetings.activity.title")}</h2>
          <p>{t("meetings.activity.description")}</p>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={() => void refresh()}
          aria-label={t("meetings.refresh")}
          title={t("meetings.refresh")}
        >
          <RefreshCcw size={14} className={loading ? "spin" : ""} />
        </button>
      </header>
      <div className="meetings-activity-controls">
        <label className="search-box meetings-search">
          <Search size={14} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("meetings.activity.searchPlaceholder")}
            aria-label={t("meetings.activity.searchPlaceholder")}
          />
        </label>
        <div className="meetings-activity-filters" role="group" aria-label={t("meetings.activity.filterLabel")}>
          {ACTIVITY_EVENT_FILTERS.map((event) => (
            <button
              key={event}
              type="button"
              className={activeEvents.has(event) ? "active" : ""}
              aria-pressed={activeEvents.has(event)}
              onClick={() => toggleEvent(event)}
            >
              {t(`meetings.activity.event.${event}`)}
            </button>
          ))}
        </div>
      </div>
      {filtered.length === 0 ? (
        <div className="meetings-activity-empty">
          <ClipboardCheck size={18} />
          <strong>{t("meetings.activity.emptyTitle")}</strong>
          <span>{t("meetings.activity.emptyDescription")}</span>
        </div>
      ) : (
        <div className="meetings-activity-groups">
          {groups.map(([groupLabel, items]) => (
            <section key={groupLabel} className="meetings-activity-group">
              <h3>{t(`meetings.activity.group.${groupLabel}`)}</h3>
              <ul>
                {items.map((entry) => {
                  const entryId = activityEntryId(entry);
                  const expandedRow = expanded.has(entryId);
                  return (
                    <li
                      key={entryId}
                      data-event={entry.event}
                      data-legacy={entry.legacy ? "true" : "false"}
                    >
                      <button
                        type="button"
                        className="meetings-activity-row"
                        aria-expanded={expandedRow}
                        onClick={() =>
                          setExpanded((current) => {
                            const next = new Set(current);
                            if (next.has(entryId)) next.delete(entryId);
                            else next.add(entryId);
                            return next;
                          })
                        }
                      >
                        <span className="meetings-activity-event">
                          {ACTIVITY_EVENT_FILTERS.includes(entry.event)
                            ? t(`meetings.activity.event.${entry.event}`)
                            : entry.event}
                        </span>
                        <span className="meetings-activity-skill">
                          {entry.skill ?? t("meetings.activity.unknownSkill")}
                        </span>
                        <span className="meetings-activity-target">
                          {entry.target ?? entry.runId ?? entry.raw.slice(0, 80)}
                        </span>
                        <span className="meetings-activity-time">
                          {entry.ts ? formatMissionTime(entry.ts) : "—"}
                        </span>
                      </button>
                      {expandedRow ? (
                        <pre className="meetings-activity-payload">{entry.raw}</pre>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}

function groupActivityByDay(
  entries: MeetingsLogLineRecord[],
): Array<[string, MeetingsLogLineRecord[]]> {
  const today = new Date();
  const todayKey = formatIsoDay(today);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const yesterdayKey = formatIsoDay(yesterday);
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - 7);
  const weekKey = formatIsoDay(weekStart);
  const groups = new Map<string, MeetingsLogLineRecord[]>();
  for (const entry of entries) {
    const day = entry.ts ? entry.ts.slice(0, 10) : null;
    let label: string;
    if (day === todayKey) label = "today";
    else if (day === yesterdayKey) label = "yesterday";
    else if (day && day >= weekKey) label = "thisWeek";
    else label = "earlier";
    const bucket = groups.get(label) ?? [];
    bucket.push(entry);
    groups.set(label, bucket);
  }
  const order = ["today", "yesterday", "thisWeek", "earlier"];
  return order
    .filter((key) => groups.has(key))
    .map((key) => [key, groups.get(key)!] as [string, MeetingsLogLineRecord[]]);
}

function activityEntryId(entry: MeetingsLogLineRecord): string {
  return [
    entry.ts ?? "no-ts",
    entry.event,
    entry.runId ?? "",
    entry.skill ?? "",
    entry.target ?? "",
    entry.raw,
  ].join("|");
}

function formatIsoDay(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function MeetingsTranscriptFlow(props: {
  workPath: string | null;
  settings: MeetingsSettings;
  skills: SkillRecord[];
  runtimeCommands: Partial<Record<SkillDispatchRuntime, string | null>>;
  permissionMode?: string | null;
  missions: MissionRecord[];
  logLines: Record<string, string[]>;
  onMissionStarted: (invocationId: string) => void;
  onLocalMissionStarted: (mission: MissionRecord) => void;
  onStopMission: (id: string) => void;
  onClearMission: (id: string) => void;
  lastClearedMissionId: string | null;
  onUndoClearMission: (id: string) => void;
  onRefreshMissions: () => void;
  onConfirmApproval: MeetingsPaneProps["onConfirmApproval"];
  onApplied: () => void;
  onError: (message: string | null) => void;
}) {
  return <MeetingsSkillWorkbench sourceKind="transcript" {...props} />;
}

function MeetingsExternalFlow({
  workPath,
  settings,
  skills,
  runtimeCommands,
  permissionMode,
  missions,
  logLines,
  onMissionStarted,
  onLocalMissionStarted,
  onStopMission,
  onClearMission,
  lastClearedMissionId,
  onUndoClearMission,
  onRefreshMissions,
  onConfirmApproval,
  onApplied,
  onError,
}: {
  workPath: string | null;
  settings: MeetingsSettings;
  skills: SkillRecord[];
  runtimeCommands: Partial<Record<SkillDispatchRuntime, string | null>>;
  permissionMode?: string | null;
  missions: MissionRecord[];
  logLines: Record<string, string[]>;
  onMissionStarted: (invocationId: string) => void;
  onLocalMissionStarted: (mission: MissionRecord) => void;
  onStopMission: (id: string) => void;
  onClearMission: (id: string) => void;
  lastClearedMissionId: string | null;
  onUndoClearMission: (id: string) => void;
  onRefreshMissions: () => void;
  onConfirmApproval: MeetingsPaneProps["onConfirmApproval"];
  onApplied: () => void;
  onError: (message: string | null) => void;
}) {
  return (
    <MeetingsSkillWorkbench
      sourceKind="external"
      workPath={workPath}
      settings={settings}
      skills={skills}
      runtimeCommands={runtimeCommands}
      permissionMode={permissionMode}
      missions={missions}
      logLines={logLines}
      onMissionStarted={onMissionStarted}
      onLocalMissionStarted={onLocalMissionStarted}
      onStopMission={onStopMission}
      onClearMission={onClearMission}
      lastClearedMissionId={lastClearedMissionId}
      onUndoClearMission={onUndoClearMission}
      onRefreshMissions={onRefreshMissions}
      onConfirmApproval={onConfirmApproval}
      onApplied={onApplied}
      onError={onError}
    />
  );
}

interface MeetingReviewBundle {
  runId: string;
  mission: MissionRecord;
  rawOutput: string;
  proposal: SkillProposal | null;
  review: MeetingReviewArtifact;
  files: MeetingProposalFileDraft[];
  checks: MeetingReviewCheck[];
  followups: MeetingFollowupCandidate[];
  continuationSelected: boolean;
}

interface MeetingApplyResult {
  runId: string;
  files: number;
  followups: number;
  appliedAt: string;
}

function MeetingsSkillWorkbench({
  sourceKind,
  workPath,
  settings,
  skills,
  runtimeCommands,
  permissionMode,
  missions,
  logLines,
  onMissionStarted,
  onLocalMissionStarted,
  onStopMission,
  onClearMission,
  lastClearedMissionId,
  onUndoClearMission,
  onRefreshMissions,
  onConfirmApproval,
  onApplied,
  onError,
}: {
  sourceKind: MeetingSourceKind;
  workPath: string | null;
  settings: MeetingsSettings;
  skills: SkillRecord[];
  runtimeCommands: Partial<Record<SkillDispatchRuntime, string | null>>;
  permissionMode?: string | null;
  missions: MissionRecord[];
  logLines: Record<string, string[]>;
  onMissionStarted: (invocationId: string) => void;
  onLocalMissionStarted: (mission: MissionRecord) => void;
  onStopMission: (id: string) => void;
  onClearMission: (id: string) => void;
  lastClearedMissionId: string | null;
  onUndoClearMission: (id: string) => void;
  onRefreshMissions: () => void;
  onConfirmApproval: MeetingsPaneProps["onConfirmApproval"];
  onApplied: () => void;
  onError: (message: string | null) => void;
}) {
  const { t } = useTranslation();
  const [paths, setPaths] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [type, setType] = useState(settings.defaultTypes[0] ?? "회의");
  const [topic, setTopic] = useState("");
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const [runtimeChooserOpen, setRuntimeChooserOpen] = useState(false);
  const [runtimeStatuses, setRuntimeStatuses] = useState<
    Partial<Record<SkillDispatchRuntime, SkillRuntimeStatus>>
  >({});
  const [runtimeStatusLoading, setRuntimeStatusLoading] = useState(false);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [bundle, setBundle] = useState<MeetingReviewBundle | null>(null);
  const [applyResult, setApplyResult] = useState<MeetingApplyResult | null>(null);
  const [appliedRunIds, setAppliedRunIds] = useState<Set<string>>(() => new Set());
  const [localRuns, setLocalRuns] = useState<MissionRecord[]>([]);
  const isExternal = sourceKind === "external";
  const hasSource = paths.length > 0 || note.trim().length > 0;
  const canRun = Boolean(workPath && hasSource);
  const visibleMissions = useMemo(
    () => mergeMeetingsMissions(missions, localRuns),
    [localRuns, missions],
  );
  const sourceTitle = isExternal ? t("meetings.external.title") : t("meetings.transcript.title");
  const sourceDescription = isExternal
    ? t("meetings.external.description")
    : t("meetings.transcript.description");
  const runLabel = isExternal ? t("meetings.external.run") : t("meetings.transcript.run");
  const pickLabel = isExternal ? t("meetings.external.pick") : t("meetings.transcript.pick");
  const pastePlaceholder = isExternal
    ? t("meetings.external.placeholder")
    : t("meetings.transcript.placeholder");

  useEffect(() => {
    if (missions.length === 0) return;
    const missionIds = new Set(missions.map((mission) => mission.id));
    setLocalRuns((current) => current.filter((mission) => !missionIds.has(mission.id)));
  }, [missions]);

  useEffect(() => {
    if (!runtimeChooserOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setRuntimeChooserOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [runtimeChooserOpen]);

  useEffect(() => {
    if (!runtimeChooserOpen) return;
    let cancelled = false;
    setRuntimeStatusLoading(true);
    Promise.all(
      (["claude", "codex"] as SkillDispatchRuntime[]).map(async (runtime) => {
        const status = await skillsRuntimeStatus({
          runtime,
          commandOverride: runtimeCommands[runtime] ?? null,
        });
        return [runtime, status] as const;
      }),
    )
      .then((entries) => {
        if (!cancelled) {
          setRuntimeStatuses(Object.fromEntries(entries));
        }
      })
      .catch((err) => {
        if (!cancelled) onError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setRuntimeStatusLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [onError, runtimeChooserOpen, runtimeCommands]);

  const run = async (runtime: SkillDispatchRuntime) => {
    if (!workPath || !canRun) return;
    const status = runtimeStatuses[runtime] ?? await skillsRuntimeStatus({
      runtime,
      commandOverride: runtimeCommands[runtime] ?? null,
    });
    if (!status.available) {
      onError([status.message, status.suggestedAction].filter(Boolean).join(" "));
      return;
    }
    const skill = findSkill(skills, "meeting-notes");
    if (!skill) {
      onError(t("meetings.error.skillMissing", { skill: "meeting-notes" }));
      return;
    }
    setBusy(true);
    onError(null);
    try {
      const guides = isExternal ? await readMeetingGuides(workPath) : null;
      const prompt = buildMeetingNotesPrompt({
        sourceKind,
        settings,
        type,
        topic,
        detail,
        note,
        guides,
      });
      const invocationId = await skillsDispatchBackground({
        skillId: skill.id,
        runtime,
        cwd: workPath,
        prompt,
        context: paths.map((path) => ({ path, kind: "file" })),
        commandOverride: runtimeCommands[runtime] ?? null,
        permissionMode: permissionMode ?? null,
        metadata: {
          origin: sourceKind === "transcript"
            ? "meetingNotesFromTranscript"
            : "meetingNotesExternalRefine",
          runtime,
          reviewFlow: true,
          sourceKind,
          inputPaths: paths,
          workspacePath: workPath,
          skillName: "meeting-notes",
        },
      });
      setRuntimeChooserOpen(false);
      const optimisticMission = createOptimisticMeetingMission({
        id: invocationId,
        runtime,
        sourceKind,
        inputPaths: paths,
        workPath,
      });
      setLocalRuns((current) => [
        optimisticMission,
        ...current.filter((mission) => mission.id !== invocationId),
      ]);
      onLocalMissionStarted(optimisticMission);
      setApplyResult(null);
      onMissionStarted(invocationId);
      onRefreshMissions();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const retryMission = async (mission: MissionRecord) => {
    if (!workPath) return;
    const originalRuntime =
      normalizeSkillDispatchRuntime(meetingMissionRuntimeValue(mission)) ?? "claude";
    if (!hasSource) {
      onError(t("meetings.progress.retryNeedsSource"));
      return;
    }
    if (settings.hooks.appendVaultLog) {
      try {
        await appendMeetingsLog(
          workPath,
          serializeMeetingsLogLine({
            event: "retry",
            runId: mission.id,
            status: "started",
            skill: meetingMissionSkillName(mission) ?? "meeting-notes",
            target: meetingMissionTitle(mission),
            extra: { parentRunId: mission.id, runtime: originalRuntime },
          }),
        );
      } catch (err) {
        console.warn("meetings retry audit log failed", err);
      }
    }
    await run(originalRuntime);
  };

  const loadReviewResult = async (mission: MissionRecord) => {
    if (!workPath) return;
    setReviewLoading(true);
    onError(null);
    try {
      const events = await agentReadRunEvents(workPath, mission.id);
      const raw = extractProviderOutput(events, logLines[mission.id] ?? []);
      const proposal = extractSkillProposal(events) ?? await parseProposalFallback(raw);
      const review =
        parseMeetingReviewArtifact(raw) ??
        emptyMeetingReviewArtifact(proposal?.summary ?? t("meetings.review.noReview"));
      const files = await Promise.all(
        (proposal?.files ?? []).map(async (file, index) => ({
          id: `${mission.id}-${index}`,
          selected: file.operation !== "delete",
          path: file.path,
          operation: file.operation,
          beforeContent: await readProposalBeforeContent(workPath, file),
          afterContent: file.content ?? "",
          expectedHash: file.expectedHash ?? null,
          diff: file.diff ?? null,
        })),
      );
      const draftBundle: MeetingReviewBundle = {
        runId: mission.id,
        mission,
        rawOutput: raw,
        proposal,
        review,
        files,
        checks: createMeetingReviewChecks(review),
        followups: review.followups,
        continuationSelected: false,
      };
      draftBundle.continuationSelected = meetingApprovalContinuationAvailable(draftBundle);
      setBundle(draftBundle);
      setApplyResult(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setReviewLoading(false);
    }
  };

  const checksComplete = bundle ? meetingReviewChecksComplete(bundle.checks) : false;
  const selectedFiles = bundle ? selectedProposalFileCount(bundle.files) : 0;
  const selectedFollowups = bundle ? selectedMeetingFollowupCount(bundle.followups) : 0;
  const appliedCurrentRun = Boolean(bundle && appliedRunIds.has(bundle.runId));
  const continuationAvailable = bundle ? meetingApprovalContinuationAvailable(bundle) : false;
  const continuationActive = continuationAvailable && Boolean(bundle?.continuationSelected);
  const canApply = bundle
    ? !appliedCurrentRun && meetingReviewCanApply({
      proposal: bundle.proposal,
      files: bundle.files,
      followups: bundle.followups,
      checksComplete,
      applyBusy,
      continuationAvailable: continuationActive,
    })
    : false;

  const writeAuditLine = useCallback(
    async (input: MeetingsLogEventInput) => {
      if (!workPath || !settings.hooks.appendVaultLog) return;
      try {
        await appendMeetingsLog(workPath, serializeMeetingsLogLine(input));
      } catch (err) {
        console.warn("meetings audit log append failed", err);
      }
    },
    [settings.hooks.appendVaultLog, workPath],
  );

  const applyReview = async () => {
    if (!workPath || !bundle || !canApply) return;
    const proposal = bundle.proposal && selectedFiles > 0
      ? rebuildSkillProposal(bundle.proposal, bundle.files)
      : null;
    const selectedFollowupItems = bundle.followups.filter((item) => item.selected);
    const approvalId = await onConfirmApproval({
      kind: SKILL_PROPOSAL_APPLY_APPROVAL_KIND,
      summary: t("meetings.review.applySummaryDetailed", {
        files: proposal?.files.length ?? 0,
        followups: selectedFollowups + (continuationActive ? 1 : 0),
      }),
      target: [
        ...(proposal?.files.map((file) => file.path) ?? []),
        ...selectedFollowupItems.map((item) => `${item.skill}: ${item.title}`),
        continuationActive ? `${meetingMissionTitle(bundle.mission)}: MCP Obsidian continuation` : null,
      ].filter(Boolean).join("\n"),
      payloadPreview: [
        proposal?.summary ?? bundle.review.summary,
        ...bundle.checks.map((check) => `${check.kind}: ${check.label} -> ${check.normalized} (${check.status})`),
        ...selectedFollowupItems.map((item) => `followup: ${item.skill} - ${item.title}`),
        continuationActive ? `approved-continuation:\n${bundle.rawOutput}` : null,
      ].filter(Boolean).join("\n"),
    });
    if (!approvalId) return;
    setApplyBusy(true);
    onError(null);
    try {
      if (proposal) {
        await agentApplySkillProposal({
          cwd: workPath,
          proposal,
          approvalId,
          runId: bundle.runId,
        });
      }
      if (selectedFollowupItems.length > 0) {
        await dispatchSelectedFollowups({
          workPath,
          skills,
          runtimeCommands,
          permissionMode,
          bundle,
          onMissionStarted,
        });
      }
      if (continuationActive) {
        await dispatchApprovedFollowupContinuation({
          workPath,
          skills,
          runtimeCommands,
          permissionMode,
          bundle,
          onMissionStarted,
        });
      }
      const totalFollowups = selectedFollowupItems.length + (continuationActive ? 1 : 0);
      setApplyResult({
        runId: bundle.runId,
        files: proposal?.files.length ?? 0,
        followups: totalFollowups,
        appliedAt: new Date().toISOString(),
      });
      setAppliedRunIds((current) => new Set([...current, bundle.runId]));
      onApplied();
      onRefreshMissions();
      onError(t("meetings.review.applySuccess"));
      const targetPath =
        proposal?.files[0]?.path ?? selectedFollowupItems[0]?.title ?? meetingMissionTitle(bundle.mission);
      await writeAuditLine({
        event: "apply",
        runId: bundle.runId,
        status: "completed",
        skill: "meeting-notes",
        target: targetPath,
        extra: {
          files: proposal?.files.length ?? 0,
          followups: totalFollowups,
          continuation: continuationActive,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onError(message);
      await writeAuditLine({
        event: "error",
        runId: bundle.runId,
        status: "failed",
        skill: "meeting-notes",
        target: meetingMissionTitle(bundle.mission),
        extra: { phase: "apply", error: message },
      });
    } finally {
      setApplyBusy(false);
    }
  };

  return (
    <section className="meetings-workbench">
      <div className="meetings-workbench-grid">
        <section className="meetings-workbench-card meetings-source-card">
          <header>
            <div>
              <span>{t("meetings.workbench.source")}</span>
              <h2>{sourceTitle}</h2>
              <p>{sourceDescription}</p>
            </div>
          </header>
          <div className="meetings-source-input">
            <textarea
              className="meetings-textarea compact"
              aria-label={sourceTitle}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder={pastePlaceholder}
            />
            <button
              type="button"
              className="secondary-button"
              onClick={() => void chooseFiles(pickLabel).then(setPaths)}
            >
              <FolderOpen size={14} />
              {pickLabel}
            </button>
            <div className="meetings-selected-files compact">
              {paths.length === 0 ? <span>{t("meetings.workbench.noFiles")}</span> : null}
              {paths.map((path) => <span key={path}>{path}</span>)}
            </div>
          </div>
          <FlowFields
            types={settings.defaultTypes}
            type={type}
            topic={topic}
            detail={detail}
            onType={setType}
            onTopic={setTopic}
            onDetail={setDetail}
          />
          <button
            type="button"
            className="primary-button"
            disabled={!canRun || busy}
            onClick={() => setRuntimeChooserOpen((open) => !open)}
          >
            {busy ? <Loader2 size={14} className="spin" /> : isExternal ? <WandSparkles size={14} /> : <Play size={14} />}
            {runLabel}
          </button>
          {runtimeChooserOpen && canRun && !busy ? (
            <div className="meetings-runtime-chooser">
              <div>
                <strong>{t("meetings.runtime.title")}</strong>
                <span>{t("meetings.runtime.description")}</span>
              </div>
          <div className="meetings-runtime-actions">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={runtimeStatusUnavailable(runtimeStatuses.claude)}
                  onClick={() => void run("claude")}
                >
                  {t("meetings.runtime.claude")}
                  <small>{runtimeStatusLabel(runtimeStatuses.claude, runtimeStatusLoading, t)}</small>
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={runtimeStatusUnavailable(runtimeStatuses.codex)}
                  onClick={() => void run("codex")}
                >
                  {t("meetings.runtime.codex")}
                  <small>{runtimeStatusLabel(runtimeStatuses.codex, runtimeStatusLoading, t)}</small>
                </button>
              </div>
            </div>
          ) : null}
          {!hasSource ? <p className="meetings-field-help">{t("meetings.source.noSource")}</p> : null}
        </section>

        <MeetingReviewPanel
          bundle={bundle}
          loading={reviewLoading}
          applyBusy={applyBusy}
          applied={appliedCurrentRun}
          canApply={canApply}
          applyResult={applyResult?.runId === bundle?.runId ? applyResult : null}
          continuationAvailable={continuationAvailable}
          continuationSelected={Boolean(bundle?.continuationSelected)}
          onApply={() => void applyReview()}
          onDismissApplyResult={() => setApplyResult(null)}
          onUpdateFile={(id, patch) => {
            setBundle((current) => current ? {
              ...current,
              files: current.files.map((file) => file.id === id ? { ...file, ...patch } : file),
            } : current);
          }}
          onUpdateCheck={(id, patch) => {
            setBundle((current) => current ? {
              ...current,
              checks: current.checks.map((check) => check.id === id ? { ...check, ...patch } : check),
            } : current);
          }}
          onToggleFollowup={(id) => {
            setBundle((current) => current ? {
              ...current,
              followups: current.followups.map((item) =>
                item.id === id ? { ...item, selected: !item.selected } : item,
              ),
            } : current);
          }}
          onToggleContinuation={() => {
            setBundle((current) => current ? {
              ...current,
              continuationSelected: !current.continuationSelected,
            } : current);
          }}
        />

        <MeetingsRunPanel
          missions={visibleMissions}
          logLines={logLines}
          activeRunId={bundle?.runId ?? null}
          reviewBundle={bundle}
          appliedRunIds={appliedRunIds}
          loadingReview={reviewLoading}
          retryBusy={busy}
          lastClearedMissionId={lastClearedMissionId}
          onRefresh={onRefreshMissions}
          onStopMission={onStopMission}
          onClearMission={onClearMission}
          onUndoClearMission={onUndoClearMission}
          onReviewResult={(mission) => void loadReviewResult(mission)}
          onRetryMission={(mission) => void retryMission(mission)}
        />
      </div>
    </section>
  );
}

function FlowFields({
  types,
  type,
  topic,
  detail,
  onType,
  onTopic,
  onDetail,
}: {
  types: string[];
  type: string;
  topic: string;
  detail: string;
  onType: (value: string) => void;
  onTopic: (value: string) => void;
  onDetail: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="meetings-metadata-panel">
      <div className="meetings-metadata-grid">
        <label className="field">
          <span>{t("meetings.field.type")}</span>
          <select value={type} onChange={(event) => onType(event.target.value)}>
            {types.map((item) => <option key={item}>{item}</option>)}
          </select>
        </label>
        <label className="field">
          <span>{t("meetings.field.topic")}</span>
          <input
            value={topic}
            onChange={(event) => onTopic(event.target.value)}
            placeholder={t("meetings.field.topicPlaceholder")}
          />
        </label>
        <label className="field">
          <span>{t("meetings.field.detail")}</span>
          <input
            value={detail}
            onChange={(event) => onDetail(event.target.value)}
            placeholder={t("meetings.field.detailPlaceholder")}
          />
        </label>
      </div>
      <p className="meetings-field-help">{t("meetings.field.help")}</p>
    </div>
  );
}

function MeetingReviewPanel({
  bundle,
  loading,
  applyBusy,
  applied,
  canApply,
  applyResult,
  continuationAvailable,
  continuationSelected,
  onApply,
  onDismissApplyResult,
  onUpdateFile,
  onUpdateCheck,
  onToggleFollowup,
  onToggleContinuation,
}: {
  bundle: MeetingReviewBundle | null;
  loading: boolean;
  applyBusy: boolean;
  applied: boolean;
  canApply: boolean;
  applyResult: MeetingApplyResult | null;
  continuationAvailable: boolean;
  continuationSelected: boolean;
  onApply: () => void;
  onDismissApplyResult: () => void;
  onUpdateFile: (id: string, patch: Partial<MeetingProposalFileDraft>) => void;
  onUpdateCheck: (id: string, patch: Partial<MeetingReviewCheck>) => void;
  onToggleFollowup: (id: string) => void;
  onToggleContinuation: () => void;
}) {
  const { t } = useTranslation();
  const pendingRequired = bundle?.checks.filter((check) => check.required && check.status === "pending").length ?? 0;
  const selectedFiles = bundle ? selectedProposalFileCount(bundle.files) : 0;
  const selectedFollowups = bundle ? selectedMeetingFollowupCount(bundle.followups) : 0;
  const checkGroups = bundle
    ? ([
      ["term", bundle.checks.filter((check) => check.kind === "term")],
      ["person", bundle.checks.filter((check) => check.kind === "person")],
      ["properNoun", bundle.checks.filter((check) => check.kind === "properNoun")],
      ["uncertainty", bundle.checks.filter((check) => check.kind === "uncertainty")],
    ] as Array<[MeetingReviewCheckKind, MeetingReviewCheck[]]>).filter(([, checks]) => checks.length > 0)
    : [];
  return (
    <section className="meetings-workbench-card meetings-review-card">
      <header>
        <div>
          <span>{t("meetings.workbench.review")}</span>
          <h2>{bundle ? t("meetings.review.ready") : t("meetings.review.waiting")}</h2>
          <p>
            {bundle
              ? bundle.review.summary || bundle.proposal?.summary || t("meetings.review.noReview")
              : t("meetings.review.waitingDescription")}
          </p>
        </div>
        {loading ? <Loader2 size={16} className="spin" /> : <GitCompare size={16} />}
      </header>

      {!bundle ? (
        <div className="meetings-review-empty">
          <ClipboardCheck size={18} />
          <strong>{t("meetings.review.empty")}</strong>
          <span>{t("meetings.review.emptyCta")}</span>
        </div>
      ) : null}

      {bundle ? (
        <div className="meetings-review-active" role="status">
          <span>{t("meetings.review.reviewingLabel")}</span>
          <strong>{meetingMissionTitle(bundle.mission)}</strong>
        </div>
      ) : null}

      {bundle ? (
        <>
          <div className="meetings-review-summary">
            <span>{t("meetings.review.files", { count: bundle.files.length })}</span>
            <span>{t("meetings.review.pending", { count: pendingRequired })}</span>
          </div>

          {applyResult ? (
            <div className="meetings-apply-result" role="status">
              <CheckCircle2 size={16} />
              <div>
                <strong>{t("meetings.review.applyDoneTitle")}</strong>
                <span>{t("meetings.review.applyDoneDescription", {
                  files: applyResult.files,
                  followups: applyResult.followups,
                  time: formatMissionTime(applyResult.appliedAt),
                })}</span>
              </div>
              <button
                type="button"
                className="icon-button meetings-apply-result-dismiss"
                onClick={onDismissApplyResult}
                aria-label={t("meetings.review.dismissApplyResult")}
                title={t("meetings.review.dismissApplyResult")}
              >
                <X size={13} />
              </button>
            </div>
          ) : null}

          <div className="meetings-proposal-files">
            {bundle.files.length === 0 ? (
              <div className="meetings-review-empty compact">
                <AlertTriangle size={15} />
                <span>{t("meetings.review.noProposal")}</span>
              </div>
            ) : null}
            {bundle.files.map((file) => (
              <article
                className="meetings-proposal-file"
                data-operation={file.operation}
                key={file.id}
              >
                <header>
                  <label>
                    <input
                      type="checkbox"
                      checked={file.selected}
                      onChange={(event) => onUpdateFile(file.id, { selected: event.target.checked })}
                    />
                    <span>{t("meetings.review.applyFile")}</span>
                  </label>
                  <span
                    className="meetings-operation-badge"
                    data-operation={file.operation}
                  >
                    {file.operation}
                  </span>
                  <select
                    value={file.operation}
                    onChange={(event) => onUpdateFile(file.id, { operation: event.target.value })}
                    aria-label={t("meetings.review.operationLabel")}
                  >
                    <option value="create">create</option>
                    <option value="replace">replace</option>
                    <option value="append">append</option>
                    <option value="delete">delete</option>
                  </select>
                </header>
                <label className="field">
                  <span>{t("meetings.review.targetPath")}</span>
                  <input
                    value={file.path}
                    onChange={(event) => onUpdateFile(file.id, { path: event.target.value })}
                  />
                </label>
                {file.operation === "delete" ? (
                  <div className="meetings-delete-warning" role="alert">
                    <ShieldAlert size={14} />
                    <span>{t("meetings.review.deleteWarning")}</span>
                  </div>
                ) : null}
                <div className="meetings-before-after">
                  <label>
                    <span>{t("meetings.review.before")}</span>
                    <pre>{file.beforeContent || t("meetings.review.newFile")}</pre>
                  </label>
                  <label>
                    <span>{t("meetings.review.after")}</span>
                    {file.operation === "delete" ? (
                      <pre className="meetings-delete-placeholder">
                        {t("meetings.review.deletePlaceholder")}
                      </pre>
                    ) : (
                      <textarea
                        value={file.afterContent}
                        onChange={(event) => onUpdateFile(file.id, { afterContent: event.target.value })}
                      />
                    )}
                  </label>
                </div>
              </article>
            ))}
          </div>

          <div className="meetings-confirmation-panel">
            <h3>{t("meetings.review.confirmTitle")}</h3>
            {bundle.checks.length === 0 ? (
              <div className="meetings-review-empty compact">
                <CheckCircle2 size={15} />
                <span>{t("meetings.review.noChecks")}</span>
              </div>
            ) : null}
            {checkGroups.map(([kind, checks]) => (
              <section className="meetings-check-group" key={kind}>
                <header>
                  <strong>
                    <CheckKindIcon kind={kind} />
                    {t(`meetings.review.kind.${kind}`)}
                  </strong>
                  <span>{t("meetings.review.pending", {
                    count: checks.filter((check) => check.required && check.status === "pending").length,
                  })}</span>
                </header>
                {checks.map((check) => (
                  <article
                    className={`meetings-check-row ${check.status}`}
                    data-status={check.status}
                    data-required={check.required ? "true" : "false"}
                    key={check.id}
                  >
                    <div>
                      <span>
                        {t(`meetings.review.kind.${check.kind}`)}
                        {check.required ? (
                          <span
                            className="meetings-check-required"
                            aria-label={t("meetings.review.requiredLabel")}
                            title={t("meetings.review.requiredLabel")}
                          >
                            *
                          </span>
                        ) : null}
                      </span>
                      <strong>{check.label}</strong>
                      {check.note ? <small>{check.note}</small> : null}
                    </div>
                    <input
                      value={check.normalized}
                      aria-label={t("meetings.review.normalizedFor", { label: check.label })}
                      aria-required={check.required ? "true" : "false"}
                      onChange={(event) => onUpdateCheck(check.id, {
                        normalized: event.target.value,
                        status: "edited",
                      })}
                    />
                    <div
                      className="meetings-check-actions"
                      role="group"
                      aria-label={t("meetings.review.checkActions")}
                    >
                      {(["accepted", "edited", "rejected"] as MeetingReviewCheckStatus[]).map((status) => (
                        <button
                          key={status}
                          type="button"
                          className={check.status === status ? "active" : ""}
                          aria-pressed={check.status === status}
                          onClick={() => onUpdateCheck(check.id, { status })}
                        >
                          {t(`meetings.review.status.${status}`)}
                        </button>
                      ))}
                    </div>
                  </article>
                ))}
              </section>
            ))}
          </div>

          <div className="meetings-followups">
            <h3>{t("meetings.review.followups")}</h3>
            {bundle.followups.length === 0 && !continuationAvailable ? (
              <div className="meetings-review-empty compact">{t("meetings.review.noFollowups")}</div>
            ) : null}
            {continuationAvailable ? (
              <label
                className="meetings-followup-row continuation"
                data-selected={continuationSelected ? "true" : "false"}
              >
                <input
                  type="checkbox"
                  checked={continuationSelected}
                  onChange={onToggleContinuation}
                />
                <div>
                  <strong>{meetingMissionTitle(bundle.mission)}</strong>
                  <span>{t("meetings.review.approvedContinuation")}</span>
                  <small>
                    {continuationSelected
                      ? t("meetings.review.approvedContinuationHelp")
                      : t("meetings.review.approvedContinuationDisabled")}
                  </small>
                </div>
              </label>
            ) : null}
            {bundle.followups.map((item) => (
              <label className="meetings-followup-row" key={item.id}>
                <input
                  type="checkbox"
                  checked={item.selected}
                  onChange={() => onToggleFollowup(item.id)}
                />
                <div>
                  <strong>{item.skill}</strong>
                  <span>{item.title}</span>
                  {item.reason ? <small>{item.reason}</small> : null}
                </div>
              </label>
            ))}
          </div>

          <div className="meetings-review-actions" data-applied={applied ? "true" : "false"}>
            <span>
              {pendingRequired > 0
                ? t("meetings.review.applyBlocked", { count: pendingRequired })
                : applyBusy
                  ? t("meetings.review.applyingDetailed", {
                    files: selectedFiles,
                    followups: selectedFollowups + (continuationAvailable && continuationSelected ? 1 : 0),
                  })
                : applied
                  ? applyResult
                    ? t("meetings.review.applyDoneDetailed", {
                      files: applyResult.files,
                      followups: applyResult.followups,
                    })
                    : t("meetings.review.applyDoneTitle")
                : t("meetings.review.applyReadyDetailed", {
                  files: selectedFiles,
                  followups: selectedFollowups + (continuationAvailable && continuationSelected ? 1 : 0),
                })}
            </span>
            <button
              type="button"
              className="primary-button"
              disabled={!canApply}
              aria-disabled={!canApply}
              data-state={applyBusy ? "applying" : applied ? "applied" : canApply ? "ready" : "pending"}
              onClick={onApply}
            >
              {applyBusy ? <Loader2 size={14} className="spin" /> : <CheckCircle2 size={14} />}
              {applyBusy
                ? t("meetings.review.applying")
                : applied
                  ? t("meetings.review.applied")
                  : t("meetings.review.apply")}
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}

function MeetingsRunPanel({
  missions,
  logLines,
  activeRunId,
  reviewBundle,
  appliedRunIds,
  loadingReview,
  retryBusy,
  lastClearedMissionId,
  onRefresh,
  onStopMission,
  onClearMission,
  onUndoClearMission,
  onReviewResult,
  onRetryMission,
}: {
  missions: MissionRecord[];
  logLines: Record<string, string[]>;
  activeRunId: string | null;
  reviewBundle: MeetingReviewBundle | null;
  appliedRunIds: Set<string>;
  loadingReview: boolean;
  retryBusy: boolean;
  lastClearedMissionId: string | null;
  onRefresh: () => void;
  onStopMission: (id: string) => void;
  onClearMission: (id: string) => void;
  onUndoClearMission: (id: string) => void;
  onReviewResult: (mission: MissionRecord) => void;
  onRetryMission: (mission: MissionRecord) => void;
}) {
  const { t } = useTranslation();
  const [expandedLogs, setExpandedLogs] = useState<Set<string>>(() => new Set());
  return (
    <section className="meetings-workbench-card meetings-run-panel">
      <header>
        <div>
          <span>{t("meetings.workbench.status")}</span>
          <h2>{t("meetings.progress.title")}</h2>
          <p>{t("meetings.progress.count", { count: missions.length })}</p>
        </div>
        <div className="meetings-run-header-actions">
          {lastClearedMissionId ? (
            <span className="meetings-run-clear-status" role="status">
              <span>{t("meetings.progress.cleared")}</span>
              <button type="button" onClick={() => onUndoClearMission(lastClearedMissionId)}>
                {t("meetings.progress.undoClear")}
              </button>
            </span>
          ) : null}
          <button type="button" className="icon-button" onClick={onRefresh} title={t("meetings.refresh")} aria-label={t("meetings.refresh")}>
            <RefreshCcw size={14} />
          </button>
          {missions.some((mission) => mission.status !== "running" && mission.status !== "idle") ? (
            <button
              type="button"
              className="button button-ghost button-sm"
              onClick={() => {
                for (const mission of missions) {
                  if (mission.status !== "running" && mission.status !== "idle") onClearMission(mission.id);
                }
              }}
            >
              <Trash2 size={12} />
              <span>{t("meetings.progress.clearDone")}</span>
            </button>
          ) : null}
        </div>
      </header>
      <div className="meetings-run-list">
        {missions.length === 0 ? (
          <div className="meetings-run-empty">
            <ClipboardCheck size={16} />
            <strong>{t("meetings.progress.empty")}</strong>
            <span>{t("meetings.progress.emptyCta")}</span>
          </div>
        ) : null}
        {missions.map((mission) => {
          const lines = logLines[mission.id] ?? [];
          const canStop = mission.status === "running" || mission.status === "idle";
          const isFailed =
            mission.status === "failed" ||
            mission.status === "stopped" ||
            (mission.exitCode !== null && mission.exitCode !== 0);
          const canReview = !isFailed && (mission.status === "done" || activeRunId === mission.id);
          const isActive = activeRunId === mission.id;
          const statusClass = isFailed
            ? "failed"
            : isActive
              ? "review-ready"
              : mission.status;
          const activeBundle = isActive && reviewBundle?.runId === mission.id
            ? reviewBundle
            : null;
          const checksComplete = activeBundle ? meetingReviewChecksComplete(activeBundle.checks) : false;
          const steps = deriveMeetingRunSteps({
            missionStatus: mission.status,
            logLines: lines,
            reviewLoaded: Boolean(activeBundle),
            checksComplete,
            applied: appliedRunIds.has(mission.id),
          });
          const expanded = expandedLogs.has(mission.id);
          const parsedLines: MeetingsLogLine[] = lines.map(parseMeetingsLogLine);
          const latestParsed = parsedLines.at(-1);
          const latestLog = latestParsed?.raw ?? t("meetings.progress.noLog");
          return (
            <article
              className={`meetings-run-card ${statusClass}`}
              data-active={isActive ? "true" : "false"}
              key={mission.id}
            >
              <div className="meetings-run-card-head">
                <div>
                  <strong>{meetingMissionTitle(mission)}</strong>
                  <span>{mission.status} · {formatMissionTime(mission.startedAt)}</span>
                </div>
                <div className="meetings-run-card-head-actions">
                  {isFailed ? (
                    <button
                      type="button"
                      className="button button-ghost button-sm meetings-run-retry"
                      disabled={retryBusy}
                      onClick={() => onRetryMission(mission)}
                    >
                      {retryBusy ? <Loader2 size={12} className="spin" /> : <RotateCw size={12} />}
                      <span>{t("meetings.progress.retry")}</span>
                    </button>
                  ) : null}
                  {canStop ? (
                    <button type="button" className="button button-ghost button-sm" onClick={() => onStopMission(mission.id)}>
                      <Square size={12} />
                      <span>{t("meetings.progress.stop")}</span>
                    </button>
                  ) : (
                    <button type="button" className="button button-ghost button-sm" onClick={() => onClearMission(mission.id)}>
                      <Trash2 size={12} />
                      <span>{t("meetings.progress.clear")}</span>
                    </button>
                  )}
                </div>
              </div>
              <div className="meetings-run-meta">
                <span>{meetingMissionRuntime(mission)}</span>
                <span>{meetingMissionSource(mission)}</span>
              </div>
              <ol className="meetings-run-steps" aria-label={t("meetings.progress.steps")}>
                {steps.map((step) => (
                  <li className={`meetings-run-step ${step.status}`} key={step.id}>
                    <span className="meetings-run-step-dot" aria-hidden="true" />
                    <span>{t(`meetings.step.${step.id}`)}</span>
                  </li>
                ))}
              </ol>
              <div className="meetings-run-log-summary">
                <span data-severity={latestParsed ? logLineSeverity(latestParsed) : "info"}>
                  {latestLog}
                </span>
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() =>
                    setExpandedLogs((current) => {
                      const next = new Set(current);
                      if (next.has(mission.id)) next.delete(mission.id);
                      else next.add(mission.id);
                      return next;
                    })
                  }
                >
                  {expanded ? t("meetings.progress.hideLog") : t("meetings.progress.showLog")}
                </button>
              </div>
              {expanded ? (
                parsedLines.length > 0 ? (
                  <ul
                    className="meetings-run-log"
                    aria-label={t("meetings.progress.logLines")}
                  >
                    {parsedLines.slice(-60).map((parsed, index) => {
                      const phase = logLinePhase(parsed);
                      const severity = logLineSeverity(parsed);
                      return (
                        <li
                          key={`${mission.id}-log-${index}`}
                          data-severity={severity}
                          data-phase={phase ?? undefined}
                        >
                          {phase ? <span className="meetings-run-log-phase">{phase}</span> : null}
                          <span className="meetings-run-log-text">{parsed.raw}</span>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <pre>{t("meetings.progress.noLog")}</pre>
                )
              ) : null}
              <div className="meetings-run-card-actions">
                <span>{appliedRunIds.has(mission.id)
                  ? t("meetings.step.applyDone")
                  : isFailed
                    ? t("meetings.progress.failedStatus")
                    : steps.some((step) => step.id === "confirm" && step.status === "blocked")
                      ? t("meetings.step.confirmBlocked")
                      : t("meetings.progress.status", { status: mission.status })}</span>
                {canReview ? (
                  <button type="button" className="secondary-button" disabled={loadingReview} onClick={() => onReviewResult(mission)}>
                    {loadingReview && activeRunId === mission.id ? <Loader2 size={14} className="spin" /> : <Pencil size={14} />}
                    {t("meetings.review.result")}
                  </button>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function MeetingsProgressDock({
  missions,
  logLines,
  collapsed,
  height,
  onCollapsedChange,
  onHeightChange,
  onStopMission,
}: {
  missions: MissionRecord[];
  logLines: Record<string, string[]>;
  collapsed: boolean;
  height: number;
  onCollapsedChange: (collapsed: boolean) => void;
  onHeightChange: (height: number) => void;
  onStopMission: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [draftHeight, setDraftHeight] = useState(() =>
    clampMeetingsProgressDockHeight(height),
  );

  useEffect(() => {
    setDraftHeight(clampMeetingsProgressDockHeight(height));
  }, [height]);

  const commitHeight = useCallback(
    (nextHeight: number) => {
      const clamped = clampMeetingsProgressDockHeight(nextHeight);
      setDraftHeight(clamped);
      onHeightChange(clamped);
    },
    [onHeightChange],
  );

  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (collapsed) return;
      event.preventDefault();
      const handle = event.currentTarget;
      const pointerId = event.pointerId;
      const startY = event.clientY;
      const startHeight = draftHeight;
      let latest = startHeight;
      handle.setPointerCapture(pointerId);

      const onMove = (move: PointerEvent) => {
        if (move.pointerId !== pointerId) return;
        const next = clampMeetingsProgressDockHeight(startHeight + startY - move.clientY);
        latest = next;
        setDraftHeight(next);
      };
      const cleanup = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onEnd);
        handle.removeEventListener("pointercancel", onEnd);
        if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      };
      const onEnd = (end: PointerEvent) => {
        if (end.pointerId !== pointerId) return;
        cleanup();
        onHeightChange(latest);
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onEnd);
      handle.addEventListener("pointercancel", onEnd);
    },
    [collapsed, draftHeight, onHeightChange],
  );

  const handleResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (collapsed) return;
      if (event.key === "ArrowUp") {
        event.preventDefault();
        commitHeight(draftHeight + 16);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        commitHeight(draftHeight - 16);
      }
    },
    [collapsed, commitHeight, draftHeight],
  );

  if (missions.length === 0) return null;
  return (
    <section
      className={collapsed ? "meetings-progress-dock collapsed" : "meetings-progress-dock"}
      style={collapsed ? undefined : { height: draftHeight }}
    >
      <div
        className="meetings-progress-resize-handle"
        role="separator"
        aria-label={t("meetings.progress.resize")}
        aria-orientation="horizontal"
        aria-valuemin={MEETINGS_PROGRESS_DOCK_MIN_HEIGHT}
        aria-valuemax={Math.round(meetingsProgressDockMaxHeight())}
        aria-valuenow={Math.round(draftHeight)}
        tabIndex={collapsed ? -1 : 0}
        onPointerDown={startResize}
        onKeyDown={handleResizeKeyDown}
        hidden={collapsed}
      />
      <header>
        <button
          type="button"
          className="meetings-progress-title"
          aria-expanded={!collapsed}
          title={collapsed ? t("meetings.progress.expandPanel") : t("meetings.progress.collapsePanel")}
          aria-label={collapsed ? t("meetings.progress.expandPanel") : t("meetings.progress.collapsePanel")}
          onClick={() => onCollapsedChange(!collapsed)}
        >
          <strong>{t("meetings.progress.title")}</strong>
          {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
        <span>{t("meetings.progress.count", { count: missions.length })}</span>
      </header>
      <div className="meetings-progress-list" hidden={collapsed}>
        {missions.map((mission) => (
          <article key={mission.id} className="meetings-mission-card">
            <div>
              <strong>{mission.id}</strong>
              <span>{mission.status}</span>
            </div>
            <pre>{formatMeetingsLogPreview(logLines[mission.id] ?? [], 4) || t("meetings.progress.noLog")}</pre>
            {mission.status === "running" || mission.status === "idle" ? (
              <button type="button" className="icon-button" onClick={() => onStopMission(mission.id)} aria-label={t("meetings.progress.stop")} title={t("meetings.progress.stop")}>
                <Square size={13} />
              </button>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}

function readClearedMeetingRunIds(key: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(key) ?? window.sessionStorage.getItem(key);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function writeClearedMeetingRunIds(key: string, ids: Set<string>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(Array.from(ids).slice(-200)));
    window.sessionStorage.removeItem(key);
  } catch {
    // Non-critical UI state; ignore storage failures such as private-mode quota errors.
  }
}

function meetingsProgressDockMaxHeight(): number {
  const viewportHeight = typeof window === "undefined" ? 900 : window.innerHeight;
  return Math.max(
    MEETINGS_PROGRESS_DOCK_MIN_HEIGHT,
    viewportHeight * MEETINGS_PROGRESS_DOCK_MAX_VIEWPORT_RATIO,
  );
}

function clampMeetingsProgressDockHeight(value: number): number {
  const safeValue = Number.isFinite(value) ? value : MEETINGS_PROGRESS_DOCK_DEFAULT_HEIGHT;
  return Math.round(
    Math.min(
      meetingsProgressDockMaxHeight(),
      Math.max(MEETINGS_PROGRESS_DOCK_MIN_HEIGHT, safeValue),
    ),
  );
}

function readMeetingsProgressDockLayout(key: string): MeetingsProgressDockLayout {
  const defaults = {
    collapsed: false,
    height: clampMeetingsProgressDockHeight(MEETINGS_PROGRESS_DOCK_DEFAULT_HEIGHT),
  };
  if (typeof window === "undefined") {
    return defaults;
  }
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return defaults;
    }
    const record = parsed as Record<string, unknown>;
    return {
      collapsed: typeof record.collapsed === "boolean" ? record.collapsed : false,
      height: clampMeetingsProgressDockHeight(
        typeof record.height === "number" ? record.height : MEETINGS_PROGRESS_DOCK_DEFAULT_HEIGHT,
      ),
    };
  } catch {
    return defaults;
  }
}

function writeMeetingsProgressDockLayout(key: string, layout: MeetingsProgressDockLayout) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      key,
      JSON.stringify({
        collapsed: layout.collapsed,
        height: clampMeetingsProgressDockHeight(layout.height),
      }),
    );
  } catch {
    // Non-critical UI state; ignore storage failures such as private-mode quota errors.
  }
}

function formatMeetingsLogPreview(lines: string[], limit: number): string {
  return lines
    .slice(-limit)
    .map(stripMeetingsLogStreamPrefix)
    .join("\n");
}

function CheckKindIcon({ kind }: { kind: MeetingReviewCheckKind }) {
  switch (kind) {
    case "term":
      return <Languages size={13} aria-hidden="true" />;
    case "person":
      return <Users size={13} aria-hidden="true" />;
    case "properNoun":
      return <FileText size={13} aria-hidden="true" />;
    case "uncertainty":
      return <AlertTriangle size={13} aria-hidden="true" />;
    default:
      return null;
  }
}

function findSkill(skills: SkillRecord[], name: string): SkillRecord | null {
  return (
    skills.find((skill) => skill.name === name) ??
    skills.find((skill) => skill.id === name || skill.id.endsWith(`:${name}`)) ??
    null
  );
}

async function parseProposalFallback(raw: string): Promise<SkillProposal | null> {
  if (!raw.trim()) return null;
  try {
    return await agentParseSkillProposal(raw);
  } catch {
    return null;
  }
}

async function readProposalBeforeContent(
  workPath: string,
  file: SkillProposal["files"][number],
): Promise<string> {
  if (file.operation === "create") return "";
  try {
    const document = await readDocument(workPath, file.path);
    return document.content;
  } catch {
    return "";
  }
}

async function dispatchSelectedFollowups({
  workPath,
  skills,
  runtimeCommands,
  permissionMode,
  bundle,
  onMissionStarted,
}: {
  workPath: string;
  skills: SkillRecord[];
  runtimeCommands: Partial<Record<SkillDispatchRuntime, string | null>>;
  permissionMode?: string | null;
  bundle: MeetingReviewBundle;
  onMissionStarted: (invocationId: string) => void;
}) {
  const selected = bundle.followups.filter((item) => item.selected);
  const appliedPaths = bundle.files.filter((file) => file.selected).map((file) => file.path);
  const runtime = normalizeSkillDispatchRuntime(meetingMissionRuntimeValue(bundle.mission)) ?? "claude";
  for (const followup of selected) {
    const skill = findSkill(skills, followup.skill);
    if (!skill) continue;
    const invocationId = await skillsDispatchBackground({
      skillId: skill.id,
      runtime,
      cwd: workPath,
      prompt: [
        "The user approved this selected meeting follow-up. Execute the approved follow-up now.",
        "",
        followup.prompt,
        "",
        "Approved execution contract:",
        "- This is not proposal-only mode; proceed to the actual approved action.",
        "- For vault markdown reads, writes, patches, moves, deletes, tags, and searches, use MCP Obsidian only.",
        "- Do not use filesystem write/edit/shell commands for vault markdown.",
        "- If an item is still genuinely blocked, apply all non-blocked approved changes first, then report the blocker clearly.",
        "- Emit progress logs and a final completion summary with changed note paths.",
        appliedPaths.length > 0 ? `Meeting note path(s):\n${appliedPaths.join("\n")}` : null,
      ].filter(Boolean).join("\n"),
      context: appliedPaths.map((path) => ({ path, kind: "document" })),
      commandOverride: runtimeCommands[runtime] ?? null,
      permissionMode: permissionMode ?? null,
      metadata: {
        origin: followupOrigin(followup.skill),
        runtime,
        reviewFlow: true,
        approvedExecution: true,
        parentRunId: bundle.runId,
        parentRuntime: runtime,
        workspacePath: workPath,
        skillName: followup.skill,
      },
    });
    onMissionStarted(invocationId);
  }
}

async function dispatchApprovedFollowupContinuation({
  workPath,
  skills,
  runtimeCommands,
  permissionMode,
  bundle,
  onMissionStarted,
}: {
  workPath: string;
  skills: SkillRecord[];
  runtimeCommands: Partial<Record<SkillDispatchRuntime, string | null>>;
  permissionMode?: string | null;
  bundle: MeetingReviewBundle;
  onMissionStarted: (invocationId: string) => void;
}) {
  const skillName = meetingMissionSkillName(bundle.mission);
  if (!skillName) return;
  const skill = findSkill(skills, skillName);
  if (!skill) return;
  const runtime = normalizeSkillDispatchRuntime(meetingMissionRuntimeValue(bundle.mission)) ?? "claude";
  const invocationId = await skillsDispatchBackground({
    skillId: skill.id,
    runtime,
    cwd: workPath,
    prompt: [
      "The user approved the follow-up result below. Continue from that result and execute the approved changes now.",
      "",
      "Approved execution contract:",
      "- For vault markdown reads, writes, patches, moves, deletes, tags, and searches, use MCP Obsidian only.",
      "- Do not use filesystem write/edit/shell commands for vault markdown.",
      "- Apply all non-blocked approved changes. If a specific item is still blocked, leave only that item pending and explain it clearly.",
      "- Emit progress logs and a final completion summary with changed note paths.",
      "",
      "Previously reviewed follow-up output:",
      bundle.rawOutput,
    ].filter(Boolean).join("\n\n"),
    context: [],
    commandOverride: runtimeCommands[runtime] ?? null,
    permissionMode: permissionMode ?? null,
    metadata: {
      origin: followupOrigin(skillName),
      runtime,
      reviewFlow: true,
      approvedExecution: true,
      approvedContinuation: true,
      parentRunId: bundle.runId,
      parentRuntime: runtime,
      workspacePath: workPath,
      skillName,
    },
  });
  onMissionStarted(invocationId);
}

function meetingApprovalContinuationAvailable(bundle: MeetingReviewBundle): boolean {
  const skillName = meetingMissionSkillName(bundle.mission);
  if (!skillName || !["vault-extract", "vault-connect", "task-management"].includes(skillName)) {
    return false;
  }
  const metadata = meetingMissionMetadata(bundle.mission);
  if (metadata?.approvedContinuation === true || metadata?.approvedExecution === true) return false;
  if (bundle.proposal || bundle.files.length > 0 || bundle.followups.length > 0) return false;
  return /승인|approval|approved|MCP\s*Obsidian|Obsidian/i.test(bundle.rawOutput);
}

function mergeMeetingsMissions(
  missions: MissionRecord[],
  localRuns: MissionRecord[],
): MissionRecord[] {
  const byId = new Map<string, MissionRecord>();
  for (const mission of localRuns) byId.set(mission.id, mission);
  for (const mission of missions) byId.set(mission.id, mission);
  return Array.from(byId.values()).sort(
    (a, b) => b.lastOutputAt.localeCompare(a.lastOutputAt) || b.startedAt.localeCompare(a.startedAt),
  );
}

function createOptimisticMeetingMission({
  id,
  runtime,
  sourceKind,
  inputPaths,
  workPath,
}: {
  id: string;
  runtime: SkillDispatchRuntime;
  sourceKind: MeetingSourceKind;
  inputPaths: string[];
  workPath: string;
}): MissionRecord {
  const now = new Date().toISOString();
  return {
    id,
    kind: "skill",
    startedAt: now,
    lastOutputAt: now,
    status: "idle",
    exitCode: null,
    outputLogPath: null,
    metadata: {
      origin: sourceKind === "transcript"
        ? "meetingNotesFromTranscript"
        : "meetingNotesExternalRefine",
      runtime,
      reviewFlow: true,
      sourceKind,
      inputPaths,
      workspacePath: workPath,
      skillName: "meeting-notes",
    },
  };
}

function followupOrigin(skill: string): string {
  if (skill === "vault-connect") return "meetingNotesVaultConnect";
  if (skill === "task-management") return "meetingNotesTaskManagement";
  return "meetingNotesVaultExtract";
}

function meetingMissionTitle(mission: MissionRecord): string {
  return meetingMissionSkillName(mission) ?? mission.id;
}

function meetingMissionSource(mission: MissionRecord): string {
  const metadata = meetingMissionMetadata(mission);
  if (!metadata) return mission.id;
  const sourceKind = metadata.sourceKind;
  const origin = metadata.origin;
  return typeof sourceKind === "string"
    ? sourceKind
    : typeof origin === "string"
      ? origin
      : mission.id;
}

function meetingMissionRuntime(mission: MissionRecord): string {
  const runtime = meetingMissionRuntimeValue(mission);
  if (runtime === "codex") return "Codex";
  if (runtime === "claude") return "Claude";
  return runtime ?? "Runtime";
}

function meetingMissionRuntimeValue(mission: MissionRecord): string | null {
  const metadata = meetingMissionMetadata(mission);
  if (!metadata) return null;
  const runtime = metadata.runtime ?? metadata.parentRuntime;
  return typeof runtime === "string" && runtime.trim() ? runtime : null;
}

function runtimeStatusUnavailable(status: SkillRuntimeStatus | undefined): boolean {
  return status?.available === false;
}

function runtimeStatusLabel(
  status: SkillRuntimeStatus | undefined,
  loading: boolean,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  if (!status && loading) return t("skills.runtime.checking");
  if (!status) return t("skills.runtime.notChecked");
  if (status.available) return t("skills.runtime.readyShort");
  return status.errorKind === "auth_required"
    ? t("skills.runtime.authRequired")
    : status.errorKind === "cli_missing"
      ? t("skills.runtime.cliMissing")
      : t("skills.runtime.unavailable");
}

function meetingMissionSkillName(mission: MissionRecord): string | null {
  const metadata = meetingMissionMetadata(mission);
  const skillName = metadata?.skillName;
  return typeof skillName === "string" && skillName.trim() ? skillName : null;
}

function meetingMissionMetadata(mission: MissionRecord): Record<string, unknown> | null {
  const metadata = mission.metadata;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : null;
}

function normalizeSkillDispatchRuntime(value: string | null): SkillDispatchRuntime | null {
  return value === "claude" || value === "codex" ? value : null;
}

function formatMissionTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}


function todayIso(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}
