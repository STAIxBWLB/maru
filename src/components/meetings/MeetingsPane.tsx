import "react-big-calendar/lib/css/react-big-calendar.css";

import {
  Calendar as CalendarIcon,
  CheckCircle2,
  FilePlus2,
  FileText,
  FolderOpen,
  Link2,
  List,
  Loader2,
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
  readMeetingGuides,
  readMeetingMetadata,
  scanMeetingNotes,
} from "../../lib/api";
import { useTranslation } from "../../lib/i18n";
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
  skillsDispatchBackground,
  type SkillContextItem,
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
            onMissionStarted={onMissionStarted}
            onError={onError}
          />
        ) : view === "external" ? (
          <MeetingsExternalFlow
            workPath={workPath}
            settings={effectiveSettings}
            skills={skills}
            onMissionStarted={onMissionStarted}
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
        <MeetingsProgressDock
          missions={meetingsMissions}
          logLines={processingLogLines}
          onStopMission={onStopMission}
        />
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
  onMissionStarted,
  onError,
}: {
  workPath: string | null;
  settings: MeetingsSettings;
  skills: SkillRecord[];
  onMissionStarted: (invocationId: string) => void;
  onError: (message: string | null) => void;
}) {
  const { t } = useTranslation();
  const [paths, setPaths] = useState<string[]>([]);
  const [type, setType] = useState(settings.defaultTypes[0] ?? "회의");
  const [topic, setTopic] = useState("");
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const canRun = Boolean(workPath && paths.length > 0 && topic.trim());
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
      const prompt = [
        "Convert the selected transcript file(s) into a polished meeting note.",
        `Root: ${settings.root ?? "meetings"}`,
        `Filename template: ${settings.filenameTemplate}`,
        `Type: ${type}`,
        `Topic: ${topic.trim()}`,
        detail.trim() ? `Detail: ${detail.trim()}` : null,
        "Use the six-section meeting note structure, normalized tags, and wiki-link conventions.",
      ].filter(Boolean).join("\n");
      const invocationId = await skillsDispatchBackground({
        skillId: skill.id,
        runtime: "claude",
        cwd: workPath,
        prompt,
        context: paths.map((path) => ({ path, kind: "file" })),
        metadata: {
          origin: "meetingNotesFromTranscript",
          inputPaths: paths,
          workspacePath: workPath,
          skillName: "meeting-notes",
        },
      });
      onMissionStarted(invocationId);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="meetings-flow">
      <h2>{t("meetings.transcript.title")}</h2>
      <p>{t("meetings.transcript.description")}</p>
      <button
        type="button"
        className="secondary-button"
        onClick={() => void chooseFiles(t("meetings.transcript.pick")).then(setPaths)}
      >
        <FolderOpen size={14} />
        {t("meetings.transcript.pick")}
      </button>
      <div className="meetings-selected-files">
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
        {busy ? <Loader2 size={14} className="spin" /> : <Play size={14} />}
        {t("meetings.transcript.run")}
      </button>
    </section>
  );
}

function MeetingsExternalFlow({
  workPath,
  settings,
  skills,
  onMissionStarted,
  onError,
}: {
  workPath: string | null;
  settings: MeetingsSettings;
  skills: SkillRecord[];
  onMissionStarted: (invocationId: string) => void;
  onError: (message: string | null) => void;
}) {
  const { t } = useTranslation();
  const [paths, setPaths] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [type, setType] = useState(settings.defaultTypes[0] ?? "회의");
  const [topic, setTopic] = useState("");
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const canRun = Boolean(workPath && (paths.length > 0 || note.trim()) && topic.trim());
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
      const guides = await readMeetingGuides(workPath);
      const prompt = [
        "Refine the external note into the workspace meeting-note standard.",
        `Root: ${settings.root ?? "meetings"}`,
        `Filename template: ${settings.filenameTemplate}`,
        `Type: ${type}`,
        `Topic: ${topic.trim()}`,
        detail.trim() ? `Detail: ${detail.trim()}` : null,
        formatGuide("QUICK_START", guides.quickStart),
        formatGuide("GLOSSARY", guides.glossary),
        formatGuide("PEOPLE", guides.people),
        formatGuide("TAG_STANDARDS", guides.tagStandards),
        formatGuide("NOTES_GUIDELINES", guides.notesGuidelines),
        note.trim() ? `EXTERNAL_NOTE:\n${note.trim()}` : null,
      ].filter(Boolean).join("\n\n");
      const invocationId = await skillsDispatchBackground({
        skillId: skill.id,
        runtime: "claude",
        cwd: workPath,
        prompt,
        context: paths.map((path) => ({ path, kind: "file" })),
        metadata: {
          origin: "meetingNotesExternalRefine",
          inputPaths: paths,
          workspacePath: workPath,
          skillName: "meeting-notes",
        },
      });
      onMissionStarted(invocationId);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="meetings-flow">
      <h2>{t("meetings.external.title")}</h2>
      <p>{t("meetings.external.description")}</p>
      <textarea
        className="meetings-textarea"
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder={t("meetings.external.placeholder")}
      />
      <button
        type="button"
        className="secondary-button"
        onClick={() => void chooseFiles(t("meetings.external.pick")).then(setPaths)}
      >
        <FolderOpen size={14} />
        {t("meetings.external.pick")}
      </button>
      <div className="meetings-selected-files">
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
        {busy ? <Loader2 size={14} className="spin" /> : <WandSparkles size={14} />}
        {t("meetings.external.run")}
      </button>
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
