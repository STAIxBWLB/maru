// Maru Today — Prepare band: yesterday review. Groups yesterday's items into
// 완료 / 진척 / 이월 and exposes the four routing decisions (오늘 / 유연 /
// 날짜 미루기 / 취소) for items that still need one. Decisions persist via
// applyYesterdayDecision; rows update from the returned snapshot.

import { format, subDays } from "date-fns";
import { enUS } from "date-fns/locale/en-US";
import { ko } from "date-fns/locale/ko";
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Info,
  MoreHorizontal,
  Search,
  Sun,
  Waves,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { readDocument } from "../../lib/api";
import { useTranslation } from "../../lib/i18n";
import type { TaskEntry } from "../../lib/tasks";
import type {
  DailyPlanItem,
  YesterdayItem,
  YesterdayResolution,
} from "../../lib/today";
import { sha256Hex, taskTransition } from "../../lib/today";
import { useToday } from "./todayContext";
import { addDaysIso, taskKeyOf } from "./todayPrepareUtils";

const COLLAPSED_ROW_COUNT = 2;
const PAGE_SIZE = 25;

type YesterdayGroup = "done" | "progress" | "carryover";

interface TodayYesterdayProps {
  /** Auto-plan trigger after a decision lands. */
  onChanged: (kind: string) => void;
  tasks: TaskEntry[];
}

function groupOf(item: YesterdayItem): YesterdayGroup | null {
  if (item.status === "done") return "done";
  if (item.resolution === "defer" || item.resolution === "cancel") return null;
  const progress = item.progress ?? 0;
  if (item.status === "in-progress" || progress > 0) return "progress";
  return "carryover";
}

/** Small circular progress indicator (shape + % text, not color-only). */
function ProgressRing({ percent }: { percent: number }) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const filled = (clamped / 100) * circumference;
  return (
    <span className="today-progress">
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <circle cx="9" cy="9" r={radius} className="today-progress-track" />
        <circle
          cx="9"
          cy="9"
          r={radius}
          className="today-progress-fill"
          strokeDasharray={`${filled} ${circumference}`}
          transform="rotate(-90 9 9)"
        />
      </svg>
      <span className="today-progress-text">{clamped}%</span>
    </span>
  );
}

export function TodayYesterday({ onChanged, tasks }: TodayYesterdayProps) {
  const { t, locale } = useTranslation();
  const { workPath, snapshot, mutate } = useToday();
  const [expanded, setExpanded] = useState<Record<YesterdayGroup, boolean>>({
    done: false,
    progress: false,
    carryover: false,
  });
  const [query, setQuery] = useState("");
  const [resolutionFilter, setResolutionFilter] = useState<
    "all" | "unresolved" | "resolved"
  >("unresolved");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [menuTaskId, setMenuTaskId] = useState<string | null>(null);
  const [busyTaskIds, setBusyTaskIds] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!menuTaskId) return;
    const close = () => setMenuTaskId(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuTaskId]);

  const filteredItems = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return [...(snapshot?.yesterday ?? [])]
      .filter((item) => {
        if (resolutionFilter === "unresolved" && item.resolution != null) return false;
        if (resolutionFilter === "resolved" && item.resolution == null) return false;
        return !needle || item.title.toLowerCase().includes(needle);
      })
      .sort(
        (a, b) =>
          Number(a.resolution != null) - Number(b.resolution != null) ||
          a.title.localeCompare(b.title),
      );
  }, [query, resolutionFilter, snapshot]);

  const pagedIds = useMemo(
    () => new Set(filteredItems.slice(0, page * PAGE_SIZE).map((item) => item.taskId)),
    [filteredItems, page],
  );

  const groups = useMemo(() => {
    const result: Record<YesterdayGroup, YesterdayItem[]> = {
      done: [],
      progress: [],
      carryover: [],
    };
    for (const item of filteredItems) {
      if (!pagedIds.has(item.taskId)) continue;
      const group = groupOf(item);
      if (group) result[group].push(item);
    }
    return result;
  }, [filteredItems, pagedIds]);

  const dateLabel = useMemo(() => {
    if (!snapshot) return "";
    const dateLocale = locale === "ko" ? ko : enUS;
    const day = subDays(new Date(`${snapshot.logicalDay}T00:00:00`), 1);
    return locale === "ko"
      ? format(day, "M월 d일 (EEE)", { locale: dateLocale })
      : format(day, "MMM d (EEE)", { locale: dateLocale });
  }, [snapshot, locale]);

  const routePlan = async (
    item: YesterdayItem,
    resolution: YesterdayResolution,
    nextSnapshot: NonNullable<typeof snapshot>,
  ) => {
    const current = nextSnapshot.plan;
    if (!current) return;
    const isTarget = (planItem: DailyPlanItem) =>
      planItem.itemRef.kind === "task" &&
      planItem.itemRef.taskId === item.taskId;
    const existing = [...current.top, ...current.flexible, ...current.overflow].find(
      isTarget,
    );
    const top = current.top.filter((entry) => !isTarget(entry));
    const flexible = current.flexible.filter((entry) => !isTarget(entry));
    const overflow = current.overflow.filter((entry) => !isTarget(entry));
    const routed: DailyPlanItem =
      existing ?? {
        itemRef: { kind: "task", taskId: item.taskId },
        lane: resolution === "today" ? "top" : "flexible",
        order: 0,
        outcome: item.title,
        estimateMinutes: 30,
        estimateProvisional: true,
        pinned: false,
        proposedBlock: null,
        calendarSync: { status: "none" },
      };
    if (resolution === "today" && top.length < 3) {
      top.push({ ...routed, lane: "top", order: top.length });
    } else if (resolution === "flexible") {
      flexible.push({ ...routed, lane: "flexible", order: flexible.length });
    }
    await mutate({
      type: "setPlan",
      plan: {
        ...current,
        top: top.map((entry, order) => ({ ...entry, order, lane: "top" })),
        flexible: flexible.map((entry, order) => ({
          ...entry,
          order,
          lane: "flexible",
        })),
        overflow: overflow.map((entry, order) => ({
          ...entry,
          order,
          lane: "overflow",
        })),
      },
    });
  };

  const decide = async (item: YesterdayItem, resolution: YesterdayResolution) => {
    if (!snapshot || busyTaskIds.has(item.taskId)) return;
    const topContainsItem = snapshot.plan?.top.some(
      (entry) =>
        entry.itemRef.kind === "task" && entry.itemRef.taskId === item.taskId,
    );
    if (
      resolution === "today" &&
      !topContainsItem &&
      (snapshot.plan?.top.length ?? 0) >= 3
    ) {
      setNotice(t("today.yesterday.topFull"));
      return;
    }
    setBusyTaskIds((current) => new Set(current).add(item.taskId));
    setNotice(null);
    try {
      const deferDate =
        resolution === "defer" ? addDaysIso(snapshot.logicalDay, 1) : null;
      if ((resolution === "defer" || resolution === "cancel") && workPath) {
        const entry = tasks.find(
          (task) =>
            taskKeyOf(task) === item.taskId || task.relPath === item.taskId,
        );
        if (entry) {
          const doc = await readDocument(workPath, entry.relPath);
          await taskTransition(workPath, {
            taskId: entry.taskId ?? item.taskId,
            taskPath: entry.relPath,
            kind: resolution,
            expectedTaskHash: await sha256Hex(doc.content),
            deferDate,
            date: snapshot.logicalDay,
            nowIso: new Date().toISOString(),
            payload: deferDate ? { due: deferDate } : {},
          });
        }
      }
      const next = await mutate({
        type: "applyYesterdayDecision",
        taskId: item.taskId,
        resolution,
        ...(deferDate ? { deferDate } : {}),
      });
      if (!next) throw new Error("today carryover decision failed");
      await routePlan(item, resolution, next);
      setSelected((current) => {
        const nextSelected = new Set(current);
        nextSelected.delete(item.taskId);
        return nextSelected;
      });
      setMenuTaskId(null);
      onChanged("carryover");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyTaskIds((current) => {
        const next = new Set(current);
        next.delete(item.taskId);
        return next;
      });
    }
  };

  const decisionButtons = (item: YesterdayItem) => {
    const topContainsItem = snapshot?.plan?.top.some(
      (entry) =>
        entry.itemRef.kind === "task" && entry.itemRef.taskId === item.taskId,
    );
    const topFull = !topContainsItem && (snapshot?.plan?.top.length ?? 0) >= 3;
    return (
      <div
        className="today-yesterday-menu-wrap"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="today-icon-button today-icon-button-sm"
          aria-label={t("today.yesterday.actions")}
          aria-expanded={menuTaskId === item.taskId}
          onClick={() =>
            setMenuTaskId((current) => (current === item.taskId ? null : item.taskId))
          }
        >
          <MoreHorizontal size={15} aria-hidden="true" />
        </button>
        {menuTaskId === item.taskId ? (
          <div className="today-yesterday-decisions" role="menu">
            <button
              type="button"
              role="menuitem"
              disabled={topFull}
              onClick={() => void decide(item, "today")}
            >
              <Sun size={12} aria-hidden="true" />
              {t("today.yesterday.decision.today")}
            </button>
            <button type="button" role="menuitem" onClick={() => void decide(item, "flexible")}>
              <Waves size={12} aria-hidden="true" />
              {t("today.yesterday.decision.flexible")}
            </button>
            <button type="button" role="menuitem" onClick={() => void decide(item, "keepLater")}>
              <Clock size={12} aria-hidden="true" />
              {t("today.yesterday.decision.keepLater")}
            </button>
            <button type="button" role="menuitem" onClick={() => void decide(item, "defer")}>
              <Clock size={12} aria-hidden="true" />
              {t("today.yesterday.decision.defer")}
            </button>
            <button type="button" role="menuitem" onClick={() => void decide(item, "cancel")}>
              <X size={12} aria-hidden="true" />
              {t("today.yesterday.decision.cancel")}
            </button>
          </div>
        ) : null}
      </div>
    );
  };

  const selectedItems = filteredItems.filter((item) => selected.has(item.taskId));
  const availableTopSlots = Math.max(0, 3 - (snapshot?.plan?.top.length ?? 0));
  const applyBulk = async (resolution: YesterdayResolution) => {
    for (const item of selectedItems) {
      await decide(item, resolution);
    }
  };

  const renderRow = (group: YesterdayGroup, item: YesterdayItem) => {
    const needsDecision = item.resolution == null;
    return (
      <li key={item.taskId} className="today-yesterday-row">
        <div className="today-yesterday-row-main">
          {needsDecision ? (
            <input
              type="checkbox"
              checked={selected.has(item.taskId)}
              aria-label={t("today.yesterday.select", { title: item.title })}
              onChange={(event) =>
                setSelected((current) => {
                  const next = new Set(current);
                  if (event.target.checked) next.add(item.taskId);
                  else next.delete(item.taskId);
                  return next;
                })
              }
            />
          ) : null}
          {group === "done" ? (
            <CheckCircle2 size={15} strokeWidth={1.9} className="today-yesterday-done-icon" aria-hidden="true" />
          ) : null}
          {group === "progress" ? <ProgressRing percent={item.progress ?? 0} /> : null}
          {group === "carryover" ? (
            <span className="today-yesterday-warn-dot" aria-hidden="true" />
          ) : null}
          <span className="today-yesterday-title">
            {item.title || t("today.task.untitled")}
          </span>
          {group === "carryover" && needsDecision ? (
            <span className="today-yesterday-flag">{t("today.yesterday.needsDecision")}</span>
          ) : null}
          {group !== "done" && item.resolution ? (
            <span className="today-yesterday-flag">
              {t(`today.yesterday.decision.${item.resolution}`)}
            </span>
          ) : null}
        </div>
        {group !== "done" && needsDecision ? decisionButtons(item) : null}
      </li>
    );
  };

  const renderGroup = (
    group: YesterdayGroup,
    titleKey: string,
    subtitleKey: string,
  ) => {
    const items = groups[group];
    const shown = expanded[group] ? items : items.slice(0, COLLAPSED_ROW_COUNT);
    const hidden = items.length - shown.length;
    return (
      <div className="today-yesterday-group" key={group}>
        <header className="today-yesterday-group-header">
          <h4 className="today-yesterday-group-title">
            {t(titleKey)} {items.length}
          </h4>
          <button
            type="button"
            className="today-panel-link"
            onClick={() =>
              setExpanded((prev) => ({ ...prev, [group]: true }))
            }
          >
            {t("today.yesterday.viewAll")}
          </button>
        </header>
        <p className="today-yesterday-group-subtitle">{t(subtitleKey)}</p>
        {items.length > 0 ? (
          <ul className="today-yesterday-list">
            {shown.map((item) => renderRow(group, item))}
          </ul>
        ) : null}
        {hidden > 0 ? (
          <button
            type="button"
            className="today-panel-link today-yesterday-more"
            onClick={() => setExpanded((prev) => ({ ...prev, [group]: true }))}
          >
            {t("today.yesterday.more", { count: hidden })}
            <ChevronDown size={12} strokeWidth={1.9} aria-hidden="true" />
          </button>
        ) : null}
        {expanded[group] && items.length > COLLAPSED_ROW_COUNT ? (
          <button
            type="button"
            className="today-panel-link today-yesterday-more"
            onClick={() => setExpanded((prev) => ({ ...prev, [group]: false }))}
          >
            <ChevronUp size={12} strokeWidth={1.9} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    );
  };

  const total = groups.done.length + groups.progress.length + groups.carryover.length;

  return (
    <section className="today-panel today-panel-yesterday" data-today-section="yesterday">
      <header className="today-panel-header">
        <h3 className="today-panel-title">
          {snapshot
            ? t("today.yesterday.heading", { date: dateLabel })
            : t("today.panel.yesterday.title")}
        </h3>
        <Info size={14} strokeWidth={1.9} className="today-panel-info" aria-hidden="true" />
      </header>
      <div className="today-panel-body">
        <div className="today-yesterday-toolbar">
          <label className="today-yesterday-search">
            <Search size={13} aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
              placeholder={t("today.yesterday.search")}
            />
          </label>
          <div className="today-capture-chips" role="group" aria-label={t("today.yesterday.filter")}>
            {(["unresolved", "resolved", "all"] as const).map((filter) => (
              <button
                key={filter}
                type="button"
                className={
                  resolutionFilter === filter
                    ? "today-chip today-chip-active"
                    : "today-chip"
                }
                onClick={() => {
                  setResolutionFilter(filter);
                  setPage(1);
                }}
              >
                {t(`today.yesterday.filter.${filter}`)}
              </button>
            ))}
          </div>
        </div>
        {selectedItems.length > 0 ? (
          <div className="today-yesterday-bulk" role="toolbar" aria-label={t("today.yesterday.bulk")}>
            <strong>{t("today.yesterday.selected", { count: selectedItems.length })}</strong>
            <button
              type="button"
              disabled={selectedItems.length > availableTopSlots}
              onClick={() => void applyBulk("today")}
            >
              {t("today.yesterday.decision.today")}
            </button>
            <button type="button" onClick={() => void applyBulk("flexible")}>
              {t("today.yesterday.decision.flexible")}
            </button>
            <button type="button" onClick={() => void applyBulk("keepLater")}>
              {t("today.yesterday.decision.keepLater")}
            </button>
            <button type="button" onClick={() => void applyBulk("defer")}>
              {t("today.yesterday.decision.defer")}
            </button>
            <button type="button" onClick={() => void applyBulk("cancel")}>
              {t("today.yesterday.decision.cancel")}
            </button>
          </div>
        ) : null}
        {notice ? (
          <p className="today-notice" role="alert">{notice}</p>
        ) : null}
        {total === 0 ? (
          <p className="today-panel-empty">{t("today.yesterday.empty")}</p>
        ) : (
          <div className="today-yesterday-groups">
            {renderGroup("done", "today.yesterday.done.title", "today.yesterday.done.subtitle")}
            {renderGroup(
              "progress",
              "today.yesterday.progress.title",
              "today.yesterday.progress.subtitle",
            )}
            {renderGroup(
              "carryover",
              "today.yesterday.carryover.title",
              "today.yesterday.carryover.subtitle",
            )}
          </div>
        )}
        {filteredItems.length > page * PAGE_SIZE ? (
          <button
            type="button"
            className="today-panel-link today-yesterday-load-more"
            onClick={() => setPage((current) => current + 1)}
          >
            {t("today.yesterday.loadMore", {
              count: Math.min(PAGE_SIZE, filteredItems.length - page * PAGE_SIZE),
            })}
          </button>
        ) : null}
      </div>
    </section>
  );
}
