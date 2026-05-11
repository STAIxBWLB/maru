import "react-big-calendar/lib/css/react-big-calendar.css";

import {
  AlertTriangle,
  Calendar as CalendarIcon,
  CheckCircle2,
  ClipboardCheck,
  FilePlus2,
  FileText,
  FolderOpen,
  GitCompare,
  Link2,
  List,
  Loader2,
  Pencil,
  Play,
  RefreshCcw,
  Search,
  Settings,
  Square,
  WandSparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Calendar,
  dateFnsLocalizer,
  type EventPropGetter,
  type View,
} from "react-big-calendar";
import { format, getDay, parse, startOfWeek } from "date-fns";
import { ko } from "date-fns/locale/ko";
import { enUS } from "date-fns/locale/en-US";
import {
  appendMeetingsLog,
  chooseFiles,
  readDocument,
  readMeetingGuides,
  readMeetingMetadata,
  scanMeetingNotes,
} from "../../lib/api";
import { useTranslation } from "../../lib/i18n";
import {
  createMeetingReviewChecks,
  emptyMeetingReviewArtifact,
  extractProviderOutput,
  extractSkillProposal,
  meetingReviewChecksComplete,
  parseMeetingReviewArtifact,
  rebuildSkillProposal,
  selectedProposalFileCount,
  type MeetingFollowupCandidate,
  type MeetingProposalFileDraft,
  type MeetingReviewArtifact,
  type MeetingReviewCheck,
  type MeetingReviewCheckStatus,
} from "../../lib/meetingReview";
import {
  activeMeetingsMissions,
  filterMeetingsByQuery,
  meetingsToCalendarEvents,
  rowsToMeetingEntries,
  type MeetingCalendarEvent,
  type MeetingNoteEntry,
} from "../../lib/meetings";
import type { MeetingsSettings } from "../../lib/settings";
import {
  agentApplySkillProposal,
  agentParseSkillProposal,
  agentReadRunEvents,
  skillsDispatchBackground,
  type SkillContextItem,
  type SkillProposal,
  type SkillRecord,
} from "../../lib/skills";
import type { MeetingMetadata, MeetingNoteRow, MissionRecord } from "../../lib/types";

type MeetingsView = "all" | "month" | "transcript" | "external" | "date";
type DisplayMode = "list" | "calendar";

interface MeetingsPaneProps {
  workPath: string | null;
  settings: MeetingsSettings;
  effectiveSettings: MeetingsSettings;
  skills: SkillRecord[];
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
}

const locales = { ko, en: enUS };
const localizer = dateFnsLocalizer({
  format,
  parse,
  startOfWeek: (date: Date) => startOfWeek(date, { weekStartsOn: 1 }),
  getDay,
  locales,
});

export function MeetingsPane({
  workPath,
  settings,
  effectiveSettings,
  skills,
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
}: MeetingsPaneProps) {
  const { t, locale } = useTranslation();
  const [view, setView] = useState<MeetingsView>("all");
  const [displayMode, setDisplayMode] = useState<DisplayMode>("list");
  const [rows, setRows] = useState<MeetingNoteRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [lookupDate, setLookupDate] = useState(() => todayIso());
  const [selectedRelPath, setSelectedRelPath] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<MeetingMetadata | null>(null);
  const [metadataLoading, setMetadataLoading] = useState(false);

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
    return filterMeetingsByQuery(scoped, query, typeFilter === "all" ? [] : [typeFilter]);
  }, [entries, lookupDate, monthKey, query, typeFilter, view]);
  const calendarEvents = useMemo(() => meetingsToCalendarEvents(viewEntries), [viewEntries]);
  const meetingsMissions = useMemo(
    () => activeMeetingsMissions(processingMissions),
    [processingMissions],
  );

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

  const openNewMeeting = useCallback(() => {
    const skill = findSkill(skills, "meeting-notes");
    onOpenSkillCompose(
      skill,
      [],
      [
        "Create a new meeting note.",
        `Root: ${effectiveSettings.root ?? "meetings"}`,
        `Filename template: ${effectiveSettings.filenameTemplate}`,
        "Use the workspace meeting-note conventions and ask only if essential details are missing.",
      ].join("\n"),
    );
  }, [effectiveSettings.filenameTemplate, effectiveSettings.root, onOpenSkillCompose, skills]);

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
        {view === "transcript" ? (
          <MeetingsTranscriptFlow
            workPath={workPath}
            settings={effectiveSettings}
            skills={skills}
            missions={meetingsMissions}
            logLines={processingLogLines}
            onMissionStarted={onMissionStarted}
            onStopMission={onStopMission}
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
            missions={meetingsMissions}
            logLines={processingLogLines}
            onMissionStarted={onMissionStarted}
            onStopMission={onStopMission}
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
                  <MeetingsCalendarView
                    events={calendarEvents}
                    locale={locale}
                    startHour={effectiveSettings.calendarStartHour}
                    defaultDate={selectedEntry ? new Date(`${selectedEntry.date}T00:00:00`) : new Date()}
                    onSelect={(entry) => setSelectedRelPath(entry.relPath)}
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
            missions={meetingsMissions}
            logLines={processingLogLines}
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
  const items: Array<{ id: MeetingsView; label: string; count?: number; icon: ReactNode }> = [
    { id: "all", label: t("meetings.sidebar.all"), count: entries.length, icon: <List size={15} /> },
    { id: "month", label: t("meetings.sidebar.month"), count: monthCount, icon: <CalendarIcon size={15} /> },
    { id: "transcript", label: t("meetings.sidebar.transcript"), icon: <FileText size={15} /> },
    { id: "external", label: t("meetings.sidebar.external"), icon: <WandSparkles size={15} /> },
    { id: "date", label: t("meetings.sidebar.date"), count: dateCount, icon: <Search size={15} /> },
  ];
  return (
    <aside className="meetings-sidebar">
      <div className="meetings-sidebar-head">
        <strong>{t("meetings.title")}</strong>
        <span>{t("meetings.subtitle", { count: entries.length })}</span>
      </div>
      <div className="meetings-sidebar-list">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className={view === item.id ? "meetings-sidebar-item active" : "meetings-sidebar-item"}
            onClick={() => onView(item.id)}
          >
            {item.icon}
            <span>{item.label}</span>
            {typeof item.count === "number" ? <strong>{item.count}</strong> : null}
          </button>
        ))}
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

function MeetingsCalendarView({
  events,
  locale,
  startHour,
  defaultDate,
  onSelect,
}: {
  events: MeetingCalendarEvent[];
  locale: "ko" | "en";
  startHour: number;
  defaultDate: Date;
  onSelect: (entry: MeetingNoteEntry) => void;
}) {
  const { t } = useTranslation();
  const eventPropGetter: EventPropGetter<MeetingCalendarEvent> = (event) => ({
    className: `meeting-event meeting-type-${hashType(event.resource.type)}`,
  });
  return (
    <div className="meetings-calendar">
      <Calendar<MeetingCalendarEvent>
        localizer={localizer}
        culture={locale}
        events={events}
        defaultDate={defaultDate}
        defaultView={"month" as View}
        views={["month", "agenda"]}
        startAccessor="start"
        endAccessor="end"
        popup
        step={60}
        min={new Date(1970, 0, 1, startHour, 0, 0)}
        messages={{
          today: t("meetings.calendar.today"),
          previous: t("meetings.calendar.previous"),
          next: t("meetings.calendar.next"),
          month: t("meetings.calendar.month"),
          agenda: t("meetings.calendar.agenda"),
          noEventsInRange: t("meetings.calendar.empty"),
        }}
        eventPropGetter={eventPropGetter}
        onSelectEvent={(event) => onSelect(event.resource)}
      />
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

function MeetingsTranscriptFlow({
  workPath,
  settings,
  skills,
  missions,
  logLines,
  onMissionStarted,
  onStopMission,
  onRefreshMissions,
  onConfirmApproval,
  onApplied,
  onError,
}: {
  workPath: string | null;
  settings: MeetingsSettings;
  skills: SkillRecord[];
  missions: MissionRecord[];
  logLines: Record<string, string[]>;
  onMissionStarted: (invocationId: string) => void;
  onStopMission: (id: string) => void;
  onRefreshMissions: () => void;
  onConfirmApproval: MeetingsPaneProps["onConfirmApproval"];
  onApplied: () => void;
  onError: (message: string | null) => void;
}) {
  return (
    <MeetingsSkillWorkbench
      sourceKind="transcript"
      workPath={workPath}
      settings={settings}
      skills={skills}
      missions={missions}
      logLines={logLines}
      onMissionStarted={onMissionStarted}
      onStopMission={onStopMission}
      onRefreshMissions={onRefreshMissions}
      onConfirmApproval={onConfirmApproval}
      onApplied={onApplied}
      onError={onError}
    />
  );
}

function MeetingsExternalFlow({
  workPath,
  settings,
  skills,
  missions,
  logLines,
  onMissionStarted,
  onStopMission,
  onRefreshMissions,
  onConfirmApproval,
  onApplied,
  onError,
}: {
  workPath: string | null;
  settings: MeetingsSettings;
  skills: SkillRecord[];
  missions: MissionRecord[];
  logLines: Record<string, string[]>;
  onMissionStarted: (invocationId: string) => void;
  onStopMission: (id: string) => void;
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
      missions={missions}
      logLines={logLines}
      onMissionStarted={onMissionStarted}
      onStopMission={onStopMission}
      onRefreshMissions={onRefreshMissions}
      onConfirmApproval={onConfirmApproval}
      onApplied={onApplied}
      onError={onError}
    />
  );
}

type MeetingSourceKind = "transcript" | "external";

interface MeetingReviewBundle {
  runId: string;
  mission: MissionRecord;
  proposal: SkillProposal | null;
  review: MeetingReviewArtifact;
  files: MeetingProposalFileDraft[];
  checks: MeetingReviewCheck[];
  followups: MeetingFollowupCandidate[];
}

function MeetingsSkillWorkbench({
  sourceKind,
  workPath,
  settings,
  skills,
  missions,
  logLines,
  onMissionStarted,
  onStopMission,
  onRefreshMissions,
  onConfirmApproval,
  onApplied,
  onError,
}: {
  sourceKind: MeetingSourceKind;
  workPath: string | null;
  settings: MeetingsSettings;
  skills: SkillRecord[];
  missions: MissionRecord[];
  logLines: Record<string, string[]>;
  onMissionStarted: (invocationId: string) => void;
  onStopMission: (id: string) => void;
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
  const [reviewLoading, setReviewLoading] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [bundle, setBundle] = useState<MeetingReviewBundle | null>(null);
  const isExternal = sourceKind === "external";
  const canRun = Boolean(
    workPath &&
      topic.trim() &&
      (isExternal ? paths.length > 0 || note.trim() : paths.length > 0),
  );
  const sourceTitle = isExternal ? t("meetings.external.title") : t("meetings.transcript.title");
  const sourceDescription = isExternal
    ? t("meetings.external.description")
    : t("meetings.transcript.description");
  const runLabel = isExternal ? t("meetings.external.run") : t("meetings.transcript.run");
  const pickLabel = isExternal ? t("meetings.external.pick") : t("meetings.transcript.pick");

  const run = async () => {
    if (!workPath || !canRun) return;
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
        runtime: "claude",
        cwd: workPath,
        prompt,
        context: paths.map((path) => ({ path, kind: "file" })),
        metadata: {
          origin: sourceKind === "transcript"
            ? "meetingNotesFromTranscript"
            : "meetingNotesExternalRefine",
          reviewFlow: true,
          sourceKind,
          inputPaths: paths,
          workspacePath: workPath,
          skillName: "meeting-notes",
        },
      });
      onMissionStarted(invocationId);
      onRefreshMissions();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
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
      setBundle({
        runId: mission.id,
        mission,
        proposal,
        review,
        files,
        checks: createMeetingReviewChecks(review),
        followups: review.followups,
      });
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setReviewLoading(false);
    }
  };

  const checksComplete = bundle ? meetingReviewChecksComplete(bundle.checks) : false;
  const selectedFiles = bundle ? selectedProposalFileCount(bundle.files) : 0;
  const canApply = Boolean(bundle?.proposal && checksComplete && selectedFiles > 0 && !applyBusy);

  const applyReview = async () => {
    if (!workPath || !bundle?.proposal || !canApply) return;
    const proposal = rebuildSkillProposal(bundle.proposal, bundle.files);
    const approvalId = await onConfirmApproval({
      kind: "meetings.proposal.apply",
      summary: t("meetings.review.applySummary", { count: proposal.files.length }),
      target: proposal.files.map((file) => file.path).join("\n"),
      payloadPreview: [
        proposal.summary,
        ...bundle.checks.map((check) => `${check.kind}: ${check.label} -> ${check.normalized} (${check.status})`),
      ].join("\n"),
    });
    if (!approvalId) return;
    setApplyBusy(true);
    onError(null);
    try {
      await agentApplySkillProposal({
        cwd: workPath,
        proposal,
        approvalId,
        runId: bundle.runId,
      });
      await dispatchSelectedFollowups({
        workPath,
        skills,
        bundle,
        onMissionStarted,
      });
      onApplied();
      onRefreshMissions();
      onError(t("meetings.review.applySuccess"));
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
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
          {isExternal ? (
            <textarea
              className="meetings-textarea compact"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder={t("meetings.external.placeholder")}
            />
          ) : null}
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
          <FlowFields
            types={settings.defaultTypes}
            type={type}
            topic={topic}
            detail={detail}
            onType={setType}
            onTopic={setTopic}
            onDetail={setDetail}
          />
          <button type="button" className="primary-button" disabled={!canRun || busy} onClick={() => void run()}>
            {busy ? <Loader2 size={14} className="spin" /> : isExternal ? <WandSparkles size={14} /> : <Play size={14} />}
            {runLabel}
          </button>
        </section>

        <MeetingReviewPanel
          bundle={bundle}
          loading={reviewLoading}
          applyBusy={applyBusy}
          canApply={canApply}
          onApply={() => void applyReview()}
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
        />

        <MeetingsRunPanel
          missions={missions}
          logLines={logLines}
          activeRunId={bundle?.runId ?? null}
          loadingReview={reviewLoading}
          onRefresh={onRefreshMissions}
          onStopMission={onStopMission}
          onReviewResult={(mission) => void loadReviewResult(mission)}
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
    <div className="settings-grid two">
      <label className="field">
        <span>{t("meetings.field.type")}</span>
        <select value={type} onChange={(event) => onType(event.target.value)}>
          {types.map((item) => <option key={item}>{item}</option>)}
        </select>
      </label>
      <label className="field">
        <span>{t("meetings.field.topic")}</span>
        <input value={topic} onChange={(event) => onTopic(event.target.value)} />
      </label>
      <label className="field">
        <span>{t("meetings.field.detail")}</span>
        <input value={detail} onChange={(event) => onDetail(event.target.value)} />
      </label>
    </div>
  );
}

function MeetingReviewPanel({
  bundle,
  loading,
  applyBusy,
  canApply,
  onApply,
  onUpdateFile,
  onUpdateCheck,
  onToggleFollowup,
}: {
  bundle: MeetingReviewBundle | null;
  loading: boolean;
  applyBusy: boolean;
  canApply: boolean;
  onApply: () => void;
  onUpdateFile: (id: string, patch: Partial<MeetingProposalFileDraft>) => void;
  onUpdateCheck: (id: string, patch: Partial<MeetingReviewCheck>) => void;
  onToggleFollowup: (id: string) => void;
}) {
  const { t } = useTranslation();
  const pendingRequired = bundle?.checks.filter((check) => check.required && check.status === "pending").length ?? 0;
  const selectedFiles = bundle ? selectedProposalFileCount(bundle.files) : 0;
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
          <span>{t("meetings.review.empty")}</span>
        </div>
      ) : null}

      {bundle ? (
        <>
          <div className="meetings-review-summary">
            <span>{t("meetings.review.files", { count: bundle.files.length })}</span>
            <span>{t("meetings.review.pending", { count: pendingRequired })}</span>
          </div>

          <div className="meetings-proposal-files">
            {bundle.files.length === 0 ? (
              <div className="meetings-review-empty compact">
                <AlertTriangle size={15} />
                <span>{t("meetings.review.noProposal")}</span>
              </div>
            ) : null}
            {bundle.files.map((file) => (
              <article className="meetings-proposal-file" key={file.id}>
                <header>
                  <label>
                    <input
                      type="checkbox"
                      checked={file.selected}
                      onChange={(event) => onUpdateFile(file.id, { selected: event.target.checked })}
                    />
                    <span>{t("meetings.review.applyFile")}</span>
                  </label>
                  <select
                    value={file.operation}
                    onChange={(event) => onUpdateFile(file.id, { operation: event.target.value })}
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
                <div className="meetings-before-after">
                  <label>
                    <span>{t("meetings.review.before")}</span>
                    <pre>{file.beforeContent || t("meetings.review.newFile")}</pre>
                  </label>
                  <label>
                    <span>{t("meetings.review.after")}</span>
                    <textarea
                      value={file.afterContent}
                      onChange={(event) => onUpdateFile(file.id, { afterContent: event.target.value })}
                      disabled={file.operation === "delete"}
                    />
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
            {bundle.checks.map((check) => (
              <article className={`meetings-check-row ${check.status}`} key={check.id}>
                <div>
                  <span>{t(`meetings.review.kind.${check.kind}`)}</span>
                  <strong>{check.label}</strong>
                  {check.note ? <small>{check.note}</small> : null}
                </div>
                <input
                  value={check.normalized}
                  onChange={(event) => onUpdateCheck(check.id, {
                    normalized: event.target.value,
                    status: "edited",
                  })}
                />
                <div className="meetings-check-actions">
                  {(["accepted", "edited", "rejected"] as MeetingReviewCheckStatus[]).map((status) => (
                    <button
                      key={status}
                      type="button"
                      className={check.status === status ? "active" : ""}
                      onClick={() => onUpdateCheck(check.id, { status })}
                    >
                      {t(`meetings.review.status.${status}`)}
                    </button>
                  ))}
                </div>
              </article>
            ))}
          </div>

          <div className="meetings-followups">
            <h3>{t("meetings.review.followups")}</h3>
            {bundle.followups.length === 0 ? (
              <div className="meetings-review-empty compact">{t("meetings.review.noFollowups")}</div>
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

          <div className="meetings-review-actions">
            <span>
              {pendingRequired > 0
                ? t("meetings.review.applyBlocked", { count: pendingRequired })
                : t("meetings.review.applyReady", { count: selectedFiles })}
            </span>
            <button type="button" className="primary-button" disabled={!canApply} onClick={onApply}>
              {applyBusy ? <Loader2 size={14} className="spin" /> : <CheckCircle2 size={14} />}
              {t("meetings.review.apply")}
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
  loadingReview,
  onRefresh,
  onStopMission,
  onReviewResult,
}: {
  missions: MissionRecord[];
  logLines: Record<string, string[]>;
  activeRunId: string | null;
  loadingReview: boolean;
  onRefresh: () => void;
  onStopMission: (id: string) => void;
  onReviewResult: (mission: MissionRecord) => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="meetings-workbench-card meetings-run-panel">
      <header>
        <div>
          <span>{t("meetings.workbench.status")}</span>
          <h2>{t("meetings.progress.title")}</h2>
          <p>{t("meetings.progress.count", { count: missions.length })}</p>
        </div>
        <button type="button" className="icon-button" onClick={onRefresh} title={t("meetings.refresh")} aria-label={t("meetings.refresh")}>
          <RefreshCcw size={14} />
        </button>
      </header>
      <div className="meetings-run-list">
        {missions.length === 0 ? (
          <div className="meetings-run-empty">
            <ClipboardCheck size={16} />
            <span>{t("meetings.progress.empty")}</span>
          </div>
        ) : null}
        {missions.map((mission) => {
          const lines = logLines[mission.id] ?? [];
          const canStop = mission.status === "running" || mission.status === "idle";
          const canReview = mission.status === "done" || mission.status === "failed";
          const statusClass = activeRunId === mission.id ? "review-ready" : mission.status;
          return (
            <article className={`meetings-run-card ${statusClass}`} key={mission.id}>
              <div className="meetings-run-card-head">
                <div>
                  <strong>{meetingMissionTitle(mission)}</strong>
                  <span>{mission.status} · {formatMissionTime(mission.startedAt)}</span>
                </div>
                {canStop ? (
                  <button type="button" className="button button-ghost button-sm" onClick={() => onStopMission(mission.id)}>
                    <Square size={12} />
                    <span>{t("meetings.progress.stop")}</span>
                  </button>
                ) : null}
              </div>
              <pre>{lines.length > 0 ? lines.slice(-8).join("\n") : t("meetings.progress.noLog")}</pre>
              <div className="meetings-run-card-actions">
                <span>{meetingMissionSource(mission)}</span>
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
  onStopMission,
}: {
  missions: MissionRecord[];
  logLines: Record<string, string[]>;
  onStopMission: (id: string) => void;
}) {
  const { t } = useTranslation();
  if (missions.length === 0) return null;
  return (
    <section className="meetings-progress-dock">
      <header>
        <strong>{t("meetings.progress.title")}</strong>
        <span>{t("meetings.progress.count", { count: missions.length })}</span>
      </header>
      <div className="meetings-progress-list">
        {missions.map((mission) => (
          <article key={mission.id} className="meetings-mission-card">
            <div>
              <strong>{mission.id}</strong>
              <span>{mission.status}</span>
            </div>
            <pre>{(logLines[mission.id] ?? []).slice(-4).join("\n") || t("meetings.progress.noLog")}</pre>
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

function findSkill(skills: SkillRecord[], name: string): SkillRecord | null {
  return (
    skills.find((skill) => skill.name === name) ??
    skills.find((skill) => skill.id === name || skill.id.endsWith(`:${name}`)) ??
    null
  );
}

function formatGuide(label: string, content: string | null): string | null {
  return content ? `${label}:\n${content}` : null;
}

function buildMeetingNotesPrompt({
  sourceKind,
  settings,
  type,
  topic,
  detail,
  note,
  guides,
}: {
  sourceKind: MeetingSourceKind;
  settings: MeetingsSettings;
  type: string;
  topic: string;
  detail: string;
  note: string;
  guides: Awaited<ReturnType<typeof readMeetingGuides>> | null;
}): string {
  const action = sourceKind === "transcript"
    ? "Convert the selected transcript file(s) into a polished meeting note."
    : "Refine the external note into the workspace meeting-note standard.";
  return [
    action,
    "",
    "Run contract:",
    "- Do not directly write files.",
    "- Emit concise human-readable progress logs while working.",
    "- Final output must include exactly one JSON object with schemaVersion \"anchor_skill_proposal_v1\".",
    "- Final output must include exactly one JSON object with schemaVersion \"anchor_meeting_review_v1\".",
    "- The review JSON must include summary, terms, people, properNouns, uncertainties, and followups.",
    "- Followups may include only vault-extract, vault-connect, and task-management.",
    "",
    `Root: ${settings.root ?? "meetings"}`,
    `Filename template: ${settings.filenameTemplate}`,
    `Type: ${type}`,
    `Topic: ${topic.trim()}`,
    detail.trim() ? `Detail: ${detail.trim()}` : null,
    "Use the six-section meeting note structure, normalized tags, and wiki-link conventions.",
    guides ? formatGuide("QUICK_START", guides.quickStart) : null,
    guides ? formatGuide("GLOSSARY", guides.glossary) : null,
    guides ? formatGuide("PEOPLE", guides.people) : null,
    guides ? formatGuide("TAG_STANDARDS", guides.tagStandards) : null,
    guides ? formatGuide("NOTES_GUIDELINES", guides.notesGuidelines) : null,
    note.trim() ? `EXTERNAL_NOTE:\n${note.trim()}` : null,
  ].filter(Boolean).join("\n\n");
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
  bundle,
  onMissionStarted,
}: {
  workPath: string;
  skills: SkillRecord[];
  bundle: MeetingReviewBundle;
  onMissionStarted: (invocationId: string) => void;
}) {
  const selected = bundle.followups.filter((item) => item.selected);
  const appliedPaths = bundle.files.filter((file) => file.selected).map((file) => file.path);
  for (const followup of selected) {
    const skill = findSkill(skills, followup.skill);
    if (!skill) continue;
    const invocationId = await skillsDispatchBackground({
      skillId: skill.id,
      runtime: "claude",
      cwd: workPath,
      prompt: [
        followup.prompt,
        "",
        "Run contract:",
        "- Do not directly write files.",
        "- Emit progress logs.",
        "- Return an anchor_skill_proposal_v1 JSON proposal for user review.",
        appliedPaths.length > 0 ? `Meeting note path(s):\n${appliedPaths.join("\n")}` : null,
      ].filter(Boolean).join("\n"),
      context: appliedPaths.map((path) => ({ path, kind: "document" })),
      metadata: {
        origin: followupOrigin(followup.skill),
        reviewFlow: true,
        parentRunId: bundle.runId,
        workspacePath: workPath,
        skillName: followup.skill,
      },
    });
    onMissionStarted(invocationId);
  }
}

function followupOrigin(skill: string): string {
  if (skill === "vault-connect") return "meetingNotesVaultConnect";
  if (skill === "task-management") return "meetingNotesTaskManagement";
  return "meetingNotesVaultExtract";
}

function meetingMissionTitle(mission: MissionRecord): string {
  const metadata = mission.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return mission.id;
  const skillName = (metadata as Record<string, unknown>).skillName;
  return typeof skillName === "string" && skillName.trim() ? skillName : mission.id;
}

function meetingMissionSource(mission: MissionRecord): string {
  const metadata = mission.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return mission.id;
  const sourceKind = (metadata as Record<string, unknown>).sourceKind;
  const origin = (metadata as Record<string, unknown>).origin;
  return typeof sourceKind === "string"
    ? sourceKind
    : typeof origin === "string"
      ? origin
      : mission.id;
}

function formatMissionTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function hashType(type: string): number {
  let hash = 0;
  for (const char of type) hash = (hash + char.charCodeAt(0)) % 5;
  return hash + 1;
}

function todayIso(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}
