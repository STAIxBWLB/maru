import { createElement, useEffect, useSyncExternalStore } from "react";
import type { ComponentProps } from "react";

import { MeetingsPane } from "../components/meetings/MeetingsPane";
import { TodayPane } from "../components/today/TodayPane";
import { TasksPane } from "../components/tasks/TasksPane";
import { DashboardPane } from "../components/dashboard/DashboardPane";
import { onAction as onNotificationAction } from "@tauri-apps/plugin-notification";
import {
  todayLogicalDay,
  todayNotifyNewDay,
  todayRollover,
  type TodayRoute,
} from "./today";
import { resolveNewDayNotice } from "./todayRouting";

export type PlanningModeDomain = "meetings" | "today" | "tasks" | "dashboard";
export type MeetingsModeProps = Omit<ComponentProps<typeof MeetingsPane>, "requestedView" | "onViewConsumed">;
export type TodayModeProps = Omit<ComponentProps<typeof TodayPane>, "route" | "onRouteChange" | "rolloverEpoch" | "refreshRequestEpoch">;
export type TasksModeProps = ComponentProps<typeof TasksPane>;
export type DashboardModeProps = ComponentProps<typeof DashboardPane>;

export interface PlanningModeHost {
  meetings?: MeetingsModeProps;
  today?: TodayModeProps;
  tasks?: TasksModeProps;
  dashboard?: DashboardModeProps;
}

export interface MeetingsModeSlice {
  requestedView: "transcript" | "external" | null;
  requestEpoch: number;
  host: MeetingsModeProps | null;
}

export interface TodayModeSlice {
  route: TodayRoute;
  logicalDay: string | null;
  bannerPending: boolean;
  bannerVisible: boolean;
  rolloverEpoch: number;
  refreshRequestEpoch: number;
  host: TodayModeProps | null;
}

export interface TasksModeSlice { host: TasksModeProps | null; }
export interface DashboardModeSlice { host: DashboardModeProps | null; }

export interface PlanningModeController {
  subscribe(domain: PlanningModeDomain, listener: () => void): () => void;
  getMeetingsSlice(): MeetingsModeSlice;
  getTodaySlice(): TodayModeSlice;
  getTasksSlice(): TasksModeSlice;
  getDashboardSlice(): DashboardModeSlice;
  bind(host: PlanningModeHost): void;
  requestMeetingsView(view: "transcript" | "external"): void;
  consumeMeetingsView(requestEpoch: number): void;
  setTodayRoute(route: TodayRoute): void;
  setLogicalDay(logicalDay: string | null): void;
  requestTodayRollover(): void;
  requestTodayRefresh(): void;
  showTodayBanner(): void;
  revealTodayBanner(): void;
  dismissTodayBanner(): void;
}

const EMPTY_MEETINGS: MeetingsModeSlice = Object.freeze({ requestedView: null, requestEpoch: 0, host: null });
const EMPTY_TODAY: TodayModeSlice = Object.freeze({
  route: "all", logicalDay: null, bannerPending: false, bannerVisible: false,
  rolloverEpoch: 0, refreshRequestEpoch: 0, host: null,
});
const EMPTY_TASKS: TasksModeSlice = Object.freeze({ host: null });
const EMPTY_DASHBOARD: DashboardModeSlice = Object.freeze({ host: null });

/**
 * Planning presentation state is split by surface. Canonical settings, agent
 * runtime, task, calendar, approval, and workspace owners remain in their
 * existing stores; this controller only owns shell intents and host projection.
 */
export function createPlanningModeController(): PlanningModeController {
  const listeners: Record<PlanningModeDomain, Set<() => void>> = {
    meetings: new Set(), today: new Set(), tasks: new Set(), dashboard: new Set(),
  };
  let meetings = EMPTY_MEETINGS;
  let today = EMPTY_TODAY;
  let tasks = EMPTY_TASKS;
  let dashboard = EMPTY_DASHBOARD;
  const notify = (domain: PlanningModeDomain) => listeners[domain].forEach((listener) => listener());
  const publishMeetings = (next: MeetingsModeSlice) => {
    if (meetings.requestedView === next.requestedView && meetings.requestEpoch === next.requestEpoch && meetings.host === next.host) return;
    meetings = Object.freeze(next); notify("meetings");
  };
  const publishToday = (next: TodayModeSlice) => {
    if (today.route === next.route && today.logicalDay === next.logicalDay && today.bannerPending === next.bannerPending && today.bannerVisible === next.bannerVisible && today.rolloverEpoch === next.rolloverEpoch && today.refreshRequestEpoch === next.refreshRequestEpoch && today.host === next.host) return;
    today = Object.freeze(next); notify("today");
  };
  const publishTasks = (next: TasksModeSlice) => { if (tasks.host !== next.host) { tasks = Object.freeze(next); notify("tasks"); } };
  const publishDashboard = (next: DashboardModeSlice) => { if (dashboard.host !== next.host) { dashboard = Object.freeze(next); notify("dashboard"); } };

  return {
    subscribe(domain, listener) { listeners[domain].add(listener); return () => listeners[domain].delete(listener); },
    getMeetingsSlice: () => meetings,
    getTodaySlice: () => today,
    getTasksSlice: () => tasks,
    getDashboardSlice: () => dashboard,
    bind(host) {
      publishMeetings({ ...meetings, host: host.meetings ?? null });
      publishToday({ ...today, host: host.today ?? null });
      publishTasks({ host: host.tasks ?? null });
      publishDashboard({ host: host.dashboard ?? null });
    },
    requestMeetingsView(view) { publishMeetings({ ...meetings, requestedView: view, requestEpoch: meetings.requestEpoch + 1 }); },
    consumeMeetingsView(requestEpoch) { if (meetings.requestEpoch === requestEpoch && meetings.requestedView) publishMeetings({ ...meetings, requestedView: null }); },
    setTodayRoute(route) { publishToday({ ...today, route }); },
    setLogicalDay(logicalDay) { publishToday({ ...today, logicalDay }); },
    requestTodayRollover() { publishToday({ ...today, rolloverEpoch: today.rolloverEpoch + 1 }); },
    requestTodayRefresh() { publishToday({ ...today, refreshRequestEpoch: today.refreshRequestEpoch + 1 }); },
    showTodayBanner() { publishToday({ ...today, bannerPending: true }); },
    revealTodayBanner() { if (today.bannerPending && !today.bannerVisible) publishToday({ ...today, bannerVisible: true }); },
    dismissTodayBanner() { publishToday({ ...today, bannerPending: false, bannerVisible: false }); },
  };
}

export const planningModeController = createPlanningModeController();

function usePlanningSlice<T>(domain: PlanningModeDomain, getSnapshot: () => T): T {
  return useSyncExternalStore((listener) => planningModeController.subscribe(domain, listener), getSnapshot, getSnapshot);
}
export function useMeetingsModeSlice(): MeetingsModeSlice { return usePlanningSlice("meetings", planningModeController.getMeetingsSlice); }
export function useTodayModeSlice(): TodayModeSlice { return usePlanningSlice("today", planningModeController.getTodaySlice); }
export function useTasksModeSlice(): TasksModeSlice { return usePlanningSlice("tasks", planningModeController.getTasksSlice); }
export function useDashboardModeSlice(): DashboardModeSlice { return usePlanningSlice("dashboard", planningModeController.getDashboardSlice); }

/** In-app fallback for notification delivery, subscribed directly to Today only. */
export function TodayNewDayBanner({ translate, onOpenToday }: { translate(key: string): string; onOpenToday(): void }) {
  const today = useTodayModeSlice();
  if (!today.bannerVisible) return null;
  return createElement("div", { className: "today-banner", role: "status" },
    createElement("p", null, translate("today.banner.newDay")),
    createElement("div", { className: "today-banner-actions" },
      createElement("button", { type: "button", className: "today-banner-open", onClick: () => { planningModeController.dismissTodayBanner(); onOpenToday(); } }, translate("today.banner.openToday")),
      createElement("button", { type: "button", className: "today-banner-dismiss", "aria-label": translate("today.banner.dismiss"), onClick: planningModeController.dismissTodayBanner }, translate("today.banner.dismiss")),
    ),
  );
}

export interface TodayLifecycleBridgeProps {
  workPath: string | null;
  settingsOverlay: unknown;
  timezone: string | null | undefined;
  today: { enabled: boolean; dayStart: string; sleepStart: string; notificationEnabled: boolean };
  translate(key: string): string;
  onOpenToday(): void;
}

/** Runs the logical-day watcher outside MainApp and publishes only Today updates. */
export function TodayLifecycleBridge({ workPath, settingsOverlay, timezone, today: todaySettings, translate, onOpenToday }: TodayLifecycleBridgeProps) {
  const todaySlice = useTodayModeSlice();
  useEffect(() => {
    if (!workPath || !todaySettings.enabled || settingsOverlay !== null) return;
    const resolvedTimezone = timezone ?? "Asia/Seoul";
    let cancelled = false;
    let rolloverInFlight = false;
    const tick = async () => {
      let info;
      try { info = await todayLogicalDay(workPath, new Date().toISOString(), resolvedTimezone, todaySettings.dayStart); } catch { return; }
      if (cancelled) return;
      const previous = planningModeController.getTodaySlice().logicalDay;
      if (previous === null) { planningModeController.setLogicalDay(info.logicalDay); return; }
      if (previous === info.logicalDay || rolloverInFlight) return;
      rolloverInFlight = true;
      try { await todayRollover(workPath, new Date().toISOString(), resolvedTimezone, todaySettings.dayStart, todaySettings.sleepStart); }
      catch (error) { console.warn("today rollover failed", error); return; }
      finally { rolloverInFlight = false; }
      if (cancelled) return;
      planningModeController.setLogicalDay(info.logicalDay);
      planningModeController.requestTodayRollover();
      if (!todaySettings.notificationEnabled) return;
      let sent = false;
      try { sent = (await todayNotifyNewDay(workPath, info.logicalDay, translate("today.notify.newDayTitle"), translate("today.notify.newDayBody"))).sent; }
      catch (error) { console.warn("today notification failed", error); }
      if (resolveNewDayNotice({ notificationEnabled: todaySettings.notificationEnabled, sent }) === "banner") planningModeController.showTodayBanner();
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 60_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [workPath, settingsOverlay, timezone, todaySettings, translate]);

  useEffect(() => {
    if (!todaySlice.bannerPending || todaySlice.bannerVisible) return;
    const show = () => {
      const current = planningModeController.getTodaySlice();
      if (current.bannerPending && !current.bannerVisible) planningModeController.revealTodayBanner();
    };
    window.addEventListener("focus", show);
    return () => window.removeEventListener("focus", show);
  }, [todaySlice.bannerPending, todaySlice.bannerVisible]);

  useEffect(() => {
    let cancelled = false;
    let unregister: (() => void) | null = null;
    onNotificationAction(() => onOpenToday()).then((listener) => {
      if (cancelled) void listener.unregister(); else unregister = () => void listener.unregister();
    }).catch(() => {});
    return () => { cancelled = true; unregister?.(); };
  }, [onOpenToday]);
  return null;
}
