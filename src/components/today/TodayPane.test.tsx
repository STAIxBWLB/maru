// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocaleContext, t as translate } from "../../lib/i18n";
import { DEFAULT_MARU_SETTINGS } from "../../lib/settings";
import type { TodayRoute, TodaySnapshot } from "../../lib/today";
import type { TasksPaneProps } from "../tasks/TasksPane";
import { TodayPane } from "./TodayPane";

vi.mock("../../lib/today", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/today")>();
  return {
    ...original,
    todayOpen: vi.fn(),
    todayMutate: vi.fn(),
  };
});

vi.mock("../tasks/TasksPane", () => ({
  TasksPane: () => <div data-testid="tasks-pane-stub" />,
}));

import { todayMutate, todayOpen } from "../../lib/today";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SNAPSHOT: TodaySnapshot = {
  logicalDay: "2026-07-21",
  generatedAt: "2026-07-21T03:30:00+09:00",
  revision: "rev-1",
  dayState: "preparing",
  route: "prepare",
  stage: "prepare",
  timezone: "Asia/Seoul",
  dayStart: "03:30",
  sleepStart: "21:30",
  brainDump: "",
  plan: null,
  yesterday: [],
  capacity: null,
  carryovers: [],
  sources: [],
  unconfirmedContent: false,
};

interface RenderOptions {
  route: TodayRoute;
  workPath?: string | null;
  onRouteChange?: (route: TodayRoute) => void;
}

async function renderPane({ route, workPath = null, onRouteChange = () => {} }: RenderOptions) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <LocaleContext.Provider
        value={{
          locale: "ko",
          setLocale: () => {},
          t: (key, vars) => translate("ko", key, vars),
        }}
      >
        <TodayPane
          route={route}
          onRouteChange={onRouteChange}
          workPath={workPath}
          effectiveSettings={DEFAULT_MARU_SETTINGS.tasks}
          tasksProps={{} as unknown as TasksPaneProps}
        />
      </LocaleContext.Provider>,
    );
  });
  return { container, root };
}

describe("TodayPane", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(todayOpen).mockResolvedValue(SNAPSHOT);
    vi.mocked(todayMutate).mockResolvedValue({ ...SNAPSHOT, revision: "rev-2" });
  });

  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("renders the existing tasks experience on route 'all'", async () => {
    const { container } = await renderPane({ route: "all" });
    expect(container.querySelector('[data-testid="tasks-pane-stub"]')).not.toBeNull();
  });

  it("renders the stepper with 3 steps and an active step on route 'prepare'", async () => {
    const { container } = await renderPane({ route: "prepare" });
    const steps = container.querySelectorAll(".today-stepper .today-step");
    expect(steps).toHaveLength(3);
    const active = container.querySelector('.today-step-button[aria-current="step"]');
    expect(active).not.toBeNull();
    expect(active?.closest(".today-step")?.getAttribute("data-step-id")).toBe("yesterday");
    expect(container.querySelector('[data-today-section="braindump"]')).not.toBeNull();
  });

  it("switches routes via the sidebar nav", async () => {
    const onRouteChange = vi.fn();
    const { container } = await renderPane({ route: "prepare", onRouteChange });
    const executeButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".today-sidebar .today-nav-item"),
    ).find((button) => button.getAttribute("aria-label") === translate("ko", "today.nav.execute"));
    expect(executeButton).toBeDefined();
    await act(async () => {
      executeButton!.click();
    });
    expect(onRouteChange).toHaveBeenCalledWith("execute");
  });

  it("marks the active sidebar item with aria-current", async () => {
    const { container } = await renderPane({ route: "prepare" });
    const current = container.querySelector('.today-nav-item[aria-current="page"]');
    expect(current).not.toBeNull();
    expect(current?.getAttribute("aria-label")).toBe(translate("ko", "today.nav.prepare"));
  });

  it("persists the route into the snapshot when one is loaded", async () => {
    const { container } = await renderPane({ route: "prepare", workPath: "/tmp/work" });
    // Snapshot loads async; todayMutate fires on the next route change.
    expect(vi.mocked(todayOpen)).toHaveBeenCalledTimes(1);
    const reviewButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".today-sidebar .today-nav-item"),
    ).find((button) => button.getAttribute("aria-label") === translate("ko", "today.nav.review"));
    await act(async () => {
      reviewButton!.click();
    });
    expect(vi.mocked(todayMutate)).toHaveBeenCalledWith("/tmp/work", "2026-07-21", "rev-1", {
      type: "setRoute",
      route: "review",
    });
  });

  it("skips route persistence in degraded mode (no snapshot)", async () => {
    const { container } = await renderPane({ route: "prepare", workPath: null });
    expect(vi.mocked(todayOpen)).not.toHaveBeenCalled();
    const reviewButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".today-sidebar .today-nav-item"),
    ).find((button) => button.getAttribute("aria-label") === translate("ko", "today.nav.review"));
    await act(async () => {
      reviewButton!.click();
    });
    expect(vi.mocked(todayMutate)).not.toHaveBeenCalled();
  });
});
