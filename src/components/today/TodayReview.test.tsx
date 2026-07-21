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
import { TodayReview } from "./TodayReview";

vi.mock("../../lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...original,
    scanTaskNotes: vi.fn(),
    readDocument: vi.fn(),
    saveDocument: vi.fn(),
  };
});

vi.mock("../../lib/today", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/today")>();
  return {
    ...original,
    readTaskEvents: vi.fn(),
  };
});

import { readDocument, saveDocument, scanTaskNotes } from "../../lib/api";
import { readTaskEvents } from "../../lib/today";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DAY = "2026-07-21";
const JOURNAL_PATH = `tasks/daily/${DAY}.md`;

function planItem(ref: PlanItemRef, order: number): DailyPlanItem {
  return {
    itemRef: ref,
    lane: "top",
    order,
    outcome: null,
    estimateMinutes: 60,
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
    planItem({ kind: "task", taskId: "t1" }, 0),
    planItem({ kind: "task", taskId: "t2" }, 1),
  ],
  flexible: [{ ...planItem({ kind: "task", taskId: "t3" }, 0), lane: "flexible" }],
  overflow: [],
  reasons: [],
  warnings: [],
};

const SNAPSHOT: TodaySnapshot = {
  logicalDay: DAY,
  generatedAt: "2026-07-21T03:30:00+09:00",
  revision: "rev-1",
  dayState: "executing",
  route: "review",
  stage: "review",
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

const ROWS: TaskNoteRow[] = [
  taskRow("tasks/archive/alpha.md", {
    taskId: "t1",
    title: "알파 작업",
    status: "done",
    done: DAY,
    completedAt: "2026-07-21T10:00:00+09:00",
  }),
  taskRow("tasks/active/beta.md", { taskId: "t2", title: "베타 작업", status: "active" }),
  taskRow("tasks/active/gamma.md", { taskId: "t3", title: "감마 작업", status: "active" }),
  taskRow("tasks/archive/extra.md", {
    taskId: "t9",
    title: "추가 작업",
    status: "done",
    done: DAY,
  }),
];

const EVENTS: TaskEvent[] = [
  {
    ts: "2026-07-21T10:00:00+09:00",
    kind: "task_completed",
    taskId: "t1",
    payload: { taskPath: "tasks/archive/alpha.md", bucket: "archive" },
  },
  {
    ts: "2026-07-21T11:00:00+09:00",
    kind: "task_completed",
    taskId: "t9",
    payload: { taskPath: "tasks/archive/extra.md", bucket: "archive" },
  },
  {
    ts: "2026-07-21T12:00:00+09:00",
    kind: "task_deferred",
    taskId: "t3",
    payload: { taskPath: "tasks/active/gamma.md", deferDate: "2026-07-22" },
  },
];

const JOURNAL_CONTENT = [
  "<!-- maru:today:start -->",
  "# 2026-07-21",
  "",
  "- planned block",
  "<!-- maru:today:end -->",
  "",
  "## Reflection",
  "old note",
  "",
].join("\n");

function doc(relPath: string, content: string, revision = "rev-j1"): DocumentPayload {
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
}

async function renderReview(options?: { journalMissing?: boolean }): Promise<RenderResult> {
  vi.mocked(scanTaskNotes).mockResolvedValue(ROWS);
  vi.mocked(readTaskEvents).mockResolvedValue(EVENTS);
  if (options?.journalMissing) {
    vi.mocked(readDocument).mockRejectedValue(new Error("not found"));
  } else {
    vi.mocked(readDocument).mockResolvedValue(doc(JOURNAL_PATH, JOURNAL_CONTENT));
  }
  vi.mocked(saveDocument).mockImplementation(async (_work, path, content) =>
    doc(path, content, "rev-j2"),
  );
  const contextValue: TodayContextValue = {
    workPath: "/tmp/work",
    settings: { ...DEFAULT_MARU_SETTINGS.tasks.today, autoPlan: false },
    timezone: "Asia/Seoul",
    snapshot: SNAPSHOT,
    loading: false,
    mutate: vi.fn<(mutation: TodayMutation) => Promise<TodaySnapshot | null>>(async () => null),
    reload: async () => {},
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
          <TodayReview onNavigate={() => {}} />
        </TodayContext.Provider>
      </LocaleContext.Provider>,
    );
  });
  return { container, root };
}

function typeText(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("TodayReview", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("groups planned vs completed with a summary count", async () => {
    const { container } = await renderReview();
    expect(container.textContent).toContain(
      translate("ko", "today.review.summary.counts", { total: 3, completed: 1 }),
    );
    const groups = container.querySelectorAll(".today-panel-summary .today-review-group");
    expect(groups).toHaveLength(3);
    expect(groups[0].textContent).toContain("알파 작업");
    expect(groups[0].textContent).not.toContain("베타 작업");
    expect(groups[1].textContent).toContain("추가 작업");
    expect(groups[2].textContent).toContain("베타 작업");
    expect(groups[2].textContent).toContain("감마 작업");
  });

  it("lists deferred items with their defer date", async () => {
    const { container } = await renderReview();
    const deferred = container.querySelector(".today-panel-deferred")!;
    expect(deferred.textContent).toContain("감마 작업");
    expect(deferred.textContent).toContain(
      translate("ko", "today.review.deferred.deferred", { date: "2026-07-22" }),
    );
    // A deferred plan item is planned-not-completed but not unresolved.
    const unresolved = container.querySelector(".today-panel-unresolved")!;
    expect(unresolved.textContent).toContain("베타 작업");
    expect(unresolved.textContent).not.toContain("감마 작업");
  });

  it("saves the reflection via saveDocument with the expected revision and keeps markers", async () => {
    const { container } = await renderReview();
    const textarea = container.querySelector<HTMLTextAreaElement>(
      ".today-review-reflection-input",
    )!;
    expect(textarea.value).toBe("old note");
    await act(async () => {
      typeText(textarea, "새 회고");
    });
    const save = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.includes(translate("ko", "today.review.reflection.save")),
    )!;
    await act(async () => {
      save.click();
    });
    expect(saveDocument).toHaveBeenCalledWith(
      "/tmp/work",
      JOURNAL_PATH,
      expect.any(String),
      "rev-j1",
    );
    const savedContent = vi.mocked(saveDocument).mock.calls[0][2];
    expect(savedContent).toContain("<!-- maru:today:start -->");
    expect(savedContent).toContain("<!-- maru:today:end -->");
    expect(savedContent).toContain("- planned block");
    expect(savedContent).toContain("## Reflection");
    expect(savedContent).toContain("새 회고");
    expect(savedContent).not.toContain("old note");
  });

  it("disables the reflection editor with a hint when the journal is missing", async () => {
    const { container } = await renderReview({ journalMissing: true });
    const textarea = container.querySelector<HTMLTextAreaElement>(
      ".today-review-reflection-input",
    )!;
    expect(textarea.disabled).toBe(true);
    expect(container.textContent).toContain(
      translate("ko", "today.review.reflection.disabled"),
    );
  });
});
