// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocaleContext, t as translate } from "../../lib/i18n";
import { DEFAULT_MARU_SETTINGS } from "../../lib/settings";
import type {
  DailyPlanItem,
  DailyPlanV1,
  PlanItemRef,
  TaskEvent,
  TodayMutation,
  TodaySnapshot,
} from "../../lib/today";
import type { DocumentPayload, TaskNoteRow } from "../../lib/types";
import type { TodayContextValue } from "./todayContext";
import { TodayContext } from "./todayContext";
import { TodayExecute } from "./TodayExecute";

vi.mock("../../lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...original,
    scanTaskNotes: vi.fn(),
    readDocument: vi.fn(),
    readTaskMetadata: vi.fn(),
    updateTaskDetails: vi.fn(),
  };
});

vi.mock("../../lib/today", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/today")>();
  return {
    ...original,
    readTaskEvents: vi.fn(),
    readTaskIntegrations: vi.fn(),
    taskTransition: vi.fn(),
    todayCalendarPublish: vi.fn(),
    sha256Hex: vi.fn(),
  };
});

vi.mock("../studio/MarkdownSourceEditor", () => ({
  MarkdownSourceEditor: ({ value }: { value: string }) => (
    <textarea data-testid="body-editor" value={value} readOnly />
  ),
}));

import { readDocument, readTaskMetadata, scanTaskNotes } from "../../lib/api";
import {
  readTaskEvents,
  readTaskIntegrations,
  sha256Hex,
  taskTransition,
  todayCalendarPublish,
} from "../../lib/today";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DAY = "2026-07-21";

function planItem(ref: PlanItemRef, order: number, estimateMinutes: number | null): DailyPlanItem {
  return {
    itemRef: ref,
    lane: "top",
    order,
    outcome: null,
    estimateMinutes,
    estimateProvisional: false,
    pinned: false,
    proposedBlock: null,
    calendarSync: { status: "none" },
  };
}

const PLAN: DailyPlanV1 = {
  logicalDay: DAY,
  inputRevision: "rev-1",
  top: [
    planItem({ kind: "task", taskId: "t1" }, 0, 60),
    planItem({ kind: "task", taskId: "t2" }, 1, 30),
    planItem({ kind: "task", taskId: "t3" }, 2, null),
  ],
  flexible: [],
  overflow: [],
  reasons: [],
  warnings: [],
};

const SNAPSHOT: TodaySnapshot = {
  logicalDay: DAY,
  generatedAt: "2026-07-21T03:30:00+09:00",
  revision: "rev-1",
  dayState: "executing",
  route: "execute",
  stage: "execute",
  timezone: "Asia/Seoul",
  dayStart: "03:30",
  sleepStart: "21:30",
  brainDump: "",
  plan: PLAN,
  yesterday: [],
  capacity: null,
  carryovers: [],
  sources: [],
  unconfirmedContent: false,
};

function taskRow(relPath: string, frontmatter: Record<string, unknown>): TaskNoteRow {
  return {
    path: `/tmp/work/${relPath}`,
    relPath,
    fileName: relPath.split("/").pop() ?? relPath,
    bucket: relPath.includes("archive") ? "archive" : "active",
    sizeBytes: 12,
    updatedAt: null,
    frontmatter,
  };
}

const ACTIVE_ROWS: TaskNoteRow[] = [
  taskRow("tasks/active/alpha.md", { taskId: "t1", title: "알파 작업", status: "active" }),
  taskRow("tasks/active/beta.md", { taskId: "t2", title: "베타 작업", status: "active" }),
  taskRow("tasks/active/gamma.md", { taskId: "t3", title: "감마 작업", status: "active" }),
];

function doc(relPath: string, content: string, revision = "rev-d1"): DocumentPayload {
  return {
    path: `/tmp/work/${relPath}`,
    relPath,
    title: relPath,
    content,
    body: content,
    meta: {},
    fileKind: "markdown",
    revision,
  };
}

interface RenderResult {
  container: HTMLElement;
  root: ReturnType<typeof createRoot>;
  mutate: ReturnType<typeof vi.fn<(mutation: TodayMutation) => Promise<TodaySnapshot | null>>>;
  reload: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

async function renderExecute(
  snapshot: TodaySnapshot = SNAPSHOT,
  rows: TaskNoteRow[] = ACTIVE_ROWS,
  events: TaskEvent[] = [],
): Promise<RenderResult> {
  vi.mocked(scanTaskNotes).mockResolvedValue(rows);
  vi.mocked(readTaskEvents).mockResolvedValue(events);
  vi.mocked(readTaskIntegrations).mockResolvedValue([]);
  vi.mocked(sha256Hex).mockResolvedValue("hash-abc");
  vi.mocked(readDocument).mockResolvedValue(doc("tasks/active/alpha.md", "note content"));
  vi.mocked(readTaskMetadata).mockResolvedValue({
    relPath: "tasks/active/alpha.md",
    frontmatter: {},
    body: "",
    preview: "",
    lineCount: 0,
    charCount: 0,
    tags: [],
  });
  const mutate = vi.fn<(mutation: TodayMutation) => Promise<TodaySnapshot | null>>(
    async () => ({ ...snapshot, revision: "rev-2" }),
  );
  const reload = vi.fn<() => Promise<void>>(async () => {});
  const contextValue: TodayContextValue = {
    workPath: "/tmp/work",
    settings: { ...DEFAULT_MARU_SETTINGS.tasks.today, autoPlan: false },
    timezone: "Asia/Seoul",
    snapshot,
    loading: false,
    mutate,
    reload,
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <LocaleContext.Provider
        value={{ locale: "ko", setLocale: () => {}, t: (key, vars) => translate("ko", key, vars) }}
      >
        <TodayContext.Provider value={contextValue}>
          <TodayExecute onNavigate={() => {}} />
        </TodayContext.Provider>
      </LocaleContext.Provider>,
    );
  });
  return { container, root, mutate, reload };
}

function completeButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>("button.today-exec-complete"),
  );
}

describe("TodayExecute", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("issues taskTransition with the expected note hash on complete", async () => {
    const { container } = await renderExecute();
    vi.mocked(taskTransition).mockResolvedValue({
      taskId: "t1",
      newTaskHash: "hash-new",
      bucket: "archive",
      syncStatus: "local",
    });
    await act(async () => {
      completeButtons(container)[0].click();
    });
    expect(readDocument).toHaveBeenCalledWith("/tmp/work", "tasks/active/alpha.md");
    expect(taskTransition).toHaveBeenCalledWith("/tmp/work", {
      taskId: "t1",
      taskPath: "tasks/active/alpha.md",
      kind: "complete",
      expectedTaskHash: "hash-abc",
      date: DAY,
      nowIso: expect.any(String),
    });
  });

  it("shows the completed row in Done Today immediately with a syncing badge", async () => {
    const { container } = await renderExecute();
    vi.mocked(taskTransition).mockResolvedValue({
      taskId: "t1",
      newTaskHash: "hash-new",
      bucket: "archive",
      syncStatus: "syncing",
    });
    await act(async () => {
      completeButtons(container)[0].click();
    });
    const donePanel = container.querySelector(".today-panel-done")!;
    expect(donePanel.textContent).toContain("알파 작업");
    expect(donePanel.textContent).toContain(translate("ko", "today.execute.sync.syncing"));
  });

  it("shows a conflict notice and reloads on task_conflict", async () => {
    const { container, reload } = await renderExecute();
    vi.mocked(taskTransition).mockRejectedValue("task_conflict: expected hash a, found b");
    await act(async () => {
      completeButtons(container)[0].click();
    });
    expect(container.querySelector(".today-notice")?.textContent).toContain(
      translate("ko", "today.execute.conflict"),
    );
    expect(reload).toHaveBeenCalled();
  });

  it("always renders the Done Today section, with an empty state when idle", async () => {
    const { container } = await renderExecute();
    const donePanel = container.querySelector(".today-panel-done")!;
    expect(donePanel.textContent).toContain(translate("ko", "today.execute.done.title"));
    expect(donePanel.textContent).toContain(translate("ko", "today.execute.done.empty"));
  });

  it("issues a reopen transition from the Done Today undo action", async () => {
    const events: TaskEvent[] = [
      {
        ts: "2026-07-21T10:00:00+09:00",
        kind: "task_completed",
        taskId: "t8",
        payload: { taskPath: "tasks/archive/done8.md", bucket: "archive" },
      },
    ];
    const rows = [
      ...ACTIVE_ROWS,
      taskRow("tasks/archive/done8.md", {
        taskId: "t8",
        title: "완료된 작업",
        status: "done",
        done: DAY,
        completedAt: "2026-07-21T10:00:00+09:00",
      }),
    ];
    const { container } = await renderExecute(SNAPSHOT, rows, events);
    const donePanel = container.querySelector(".today-panel-done")!;
    expect(donePanel.textContent).toContain("완료된 작업");
    const undo = Array.from(donePanel.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.getAttribute("aria-label") === translate("ko", "today.execute.done.undo"),
    )!;
    vi.mocked(taskTransition).mockResolvedValue({
      taskId: "t8",
      newTaskHash: "hash-new",
      bucket: "active",
      syncStatus: "local",
    });
    await act(async () => {
      undo.click();
    });
    expect(taskTransition).toHaveBeenCalledWith(
      "/tmp/work",
      expect.objectContaining({ kind: "reopen", taskPath: "tasks/archive/done8.md" }),
    );
  });

  it("opens the task sheet from a plan row and closes it on Escape", async () => {
    const { container } = await renderExecute();
    const row = container.querySelector<HTMLElement>(".today-panel-top3 .today-exec-row")!;
    await act(async () => {
      row.click();
    });
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    const titleInput = dialog!.querySelector<HTMLInputElement>(".task-schedule-editor input")!;
    expect(titleInput.value).toBe("알파 작업");
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("opens the task sheet from a plan row via keyboard (Enter)", async () => {
    const { container } = await renderExecute();
    const row = container.querySelector<HTMLElement>(".today-panel-top3 .today-exec-row")!;
    await act(async () => {
      row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("does not open the sheet when an inner row button handles the key", async () => {
    const { container } = await renderExecute();
    const pin = container.querySelector<HTMLElement>(
      ".today-panel-top3 .today-exec-row .today-icon-button",
    )!;
    await act(async () => {
      pin.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  // --- Selective calendar sync ------------------------------------------------

  function blockSnapshot(calendarSync: DailyPlanItem["calendarSync"]): TodaySnapshot {
    return {
      ...SNAPSHOT,
      plan: {
        ...PLAN,
        top: [
          {
            ...planItem({ kind: "task", taskId: "t1" }, 0, 60),
            proposedBlock: {
              startIso: `${DAY}T10:00:00+09:00`,
              endIso: `${DAY}T11:00:00+09:00`,
            },
            calendarSync,
          },
        ],
      },
    };
  }

  function fixedPanel(container: HTMLElement): HTMLElement {
    return container.querySelector<HTMLElement>(".today-panel-fixed")!;
  }

  function linkButton(panel: HTMLElement, label: string): HTMLButtonElement {
    return Array.from(panel.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.includes(label),
    )!;
  }

  it("opts a fixed block into calendar sync via setCalendarSync", async () => {
    const { container, mutate } = await renderExecute(blockSnapshot({ status: "none" }));
    const add = linkButton(fixedPanel(container), translate("ko", "today.calendar.add"));
    await act(async () => {
      add.click();
    });
    expect(mutate).toHaveBeenCalledWith({
      type: "setCalendarSync",
      itemRef: { kind: "task", taskId: "t1" },
      selected: true,
      destination: null,
    });
    expect(todayCalendarPublish).not.toHaveBeenCalled();
  });

  it("publishes selected blocks for the day on demand", async () => {
    const snapshot = blockSnapshot({ status: "selected", destination: null });
    const { container, reload } = await renderExecute(snapshot);
    vi.mocked(todayCalendarPublish).mockResolvedValue({
      published: 1,
      failed: 0,
      blocked: false,
      snapshot: blockSnapshot({ status: "synced", eventId: "evt-1" }),
    });
    const publish = linkButton(fixedPanel(container), translate("ko", "today.calendar.publishNow"));
    await act(async () => {
      publish.click();
    });
    expect(todayCalendarPublish).toHaveBeenCalledWith("/tmp/work", DAY, "rev-1", null, null);
    expect(reload).toHaveBeenCalled();
  });

  it("shows a non-color synced badge for published blocks", async () => {
    const { container } = await renderExecute(
      blockSnapshot({ status: "synced", eventId: "evt-1" }),
    );
    const badge = fixedPanel(container).querySelector(".today-sync-badge")!;
    expect(badge.textContent).toContain(translate("ko", "today.calendar.synced"));
    expect(badge.classList.contains("warn")).toBe(false);
  });

  it("shows the error message and retries via re-select + publish", async () => {
    const { container, mutate } = await renderExecute(
      blockSnapshot({ status: "error", message: "network unreachable" }),
    );
    const panel = fixedPanel(container);
    const warn = panel.querySelector(".today-sync-badge.warn")!;
    expect(warn.getAttribute("title")).toBe("network unreachable");
    vi.mocked(todayCalendarPublish).mockResolvedValue({
      published: 1,
      failed: 0,
      blocked: false,
      snapshot: blockSnapshot({ status: "synced", eventId: "evt-2" }),
    });
    await act(async () => {
      linkButton(panel, translate("ko", "today.calendar.retry")).click();
    });
    // Retry re-selects first (clears the error), then publishes with the
    // fresh revision that mutation returned.
    expect(mutate).toHaveBeenCalledWith({
      type: "setCalendarSync",
      itemRef: { kind: "task", taskId: "t1" },
      selected: true,
      destination: null,
    });
    expect(todayCalendarPublish).toHaveBeenCalledWith("/tmp/work", DAY, "rev-2", null, null);
  });

  it("surfaces an auth-blocked publish without marking items failed", async () => {
    const { container } = await renderExecute(
      blockSnapshot({ status: "selected", destination: null }),
    );
    vi.mocked(todayCalendarPublish).mockResolvedValue({
      published: 0,
      failed: 0,
      blocked: true,
      snapshot: blockSnapshot({ status: "selected", destination: null }),
    });
    await act(async () => {
      linkButton(fixedPanel(container), translate("ko", "today.calendar.publishNow")).click();
    });
    expect(container.querySelector(".today-notice")?.textContent).toContain(
      translate("ko", "today.calendar.blocked"),
    );
  });
});
