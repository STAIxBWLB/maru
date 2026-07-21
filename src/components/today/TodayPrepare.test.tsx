// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocaleContext, t as translate } from "../../lib/i18n";
import { DEFAULT_MARU_SETTINGS } from "../../lib/settings";
import type {
  CaptureCandidate,
  DailyPlanItem,
  DailyPlanV1,
  PlanItemRef,
  TodayMutation,
  TodaySnapshot,
} from "../../lib/today";
import type { TodayContextValue } from "./todayContext";
import { TodayContext } from "./todayContext";
import { TodayPrepare } from "./TodayPrepare";

vi.mock("../../lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...original,
    scanTaskNotes: vi.fn(),
  };
});

vi.mock("../../lib/todayCapture", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/todayCapture")>();
  return {
    ...original,
    buildCaptureCandidates: vi.fn(),
  };
});

import { scanTaskNotes } from "../../lib/api";
import { buildCaptureCandidates } from "../../lib/todayCapture";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function planItem(ref: PlanItemRef, order: number, estimateMinutes: number): DailyPlanItem {
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
  logicalDay: "2026-07-21",
  inputRevision: "rev-1",
  top: [
    planItem({ kind: "task", taskId: "t1" }, 0, 120),
    planItem({ kind: "task", taskId: "t2" }, 1, 90),
    planItem({ kind: "task", taskId: "t3" }, 2, 60),
  ],
  flexible: [],
  overflow: [],
  reasons: [],
  warnings: [],
};

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
  plan: PLAN,
  yesterday: [
    { taskId: "y1", title: "완료된 일", status: "done" },
    { taskId: "y2", title: "진행 중인 일", status: "in-progress", progress: 40 },
    { taskId: "y3", title: "이월된 일", status: "todo", resolution: null },
  ],
  capacity: null,
  carryovers: [],
  sources: [],
  unconfirmedContent: false,
};

function candidate(
  captureId: string,
  provider: string,
  title: string,
  confidence: CaptureCandidate["confidence"],
): CaptureCandidate {
  return {
    captureId,
    provider,
    providerItemId: captureId,
    fingerprint: `fp-${captureId}`,
    confidence,
    category: "action",
    title,
    summary: `${title} 요약`,
    dueDate: null,
    estimateMinutes: 30,
    project: null,
    reason: "action_requested",
    receivedAt: "2026-07-20T21:14:00+09:00",
  };
}

const CANDIDATES: CaptureCandidate[] = [
  candidate("c1", "gws", "공유대학 예산안 검토 요청", "high"),
  candidate("c2", "gws", "사업계획서 초안 확인 부탁", "high"),
  candidate("c3", "telegram", "연구계약서 검토 회신", "high"),
  candidate("c4", "kakao", "인사팀 근무제도 안내", "medium"),
];

interface RenderResult {
  container: HTMLElement;
  root: ReturnType<typeof createRoot>;
  mutate: ReturnType<typeof vi.fn<(mutation: TodayMutation) => Promise<TodaySnapshot | null>>>;
}

async function renderPrepare(snapshot: TodaySnapshot = SNAPSHOT): Promise<RenderResult> {
  const mutate = vi.fn<(mutation: TodayMutation) => Promise<TodaySnapshot | null>>(
    async () => ({ ...snapshot, revision: "rev-2" }),
  );
  const contextValue: TodayContextValue = {
    workPath: "/tmp/work",
    settings: { ...DEFAULT_MARU_SETTINGS.tasks.today, autoPlan: false },
    timezone: "Asia/Seoul",
    snapshot,
    loading: false,
    mutate,
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
          <TodayPrepare onNavigate={() => {}} />
        </TodayContext.Provider>
      </LocaleContext.Provider>,
    );
  });
  return { container, root, mutate };
}

function typeText(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buttonByLabel(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.getAttribute("aria-label") === label,
  );
}

describe("TodayPrepare", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(buildCaptureCandidates).mockResolvedValue(CANDIDATES);
    vi.mocked(scanTaskNotes).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("updates the brain dump text and counter while typing, then autosaves", async () => {
    const { container, mutate } = await renderPrepare();
    const textarea = container.querySelector<HTMLTextAreaElement>(".today-braindump-textarea")!;
    await act(async () => {
      typeText(textarea, "할 일 메모");
    });
    expect(textarea.value).toBe("할 일 메모");
    expect(container.querySelector(".today-braindump-counter")?.textContent).toBe("6/2000");
    await act(async () => {
      await sleep(900);
    });
    expect(mutate).toHaveBeenCalledWith({ type: "setBrainDump", brainDump: "할 일 메모" });
  });

  it("hard-caps the brain dump at 2000 characters", async () => {
    const { container } = await renderPrepare();
    const textarea = container.querySelector<HTMLTextAreaElement>(".today-braindump-textarea")!;
    await act(async () => {
      typeText(textarea, "가".repeat(2100));
    });
    expect(textarea.value.length).toBe(2000);
    expect(container.querySelector(".today-braindump-counter")?.textContent).toBe("2000/2000");
  });

  it("disables undo after the backend reports nothing to undo", async () => {
    const { container, mutate } = await renderPrepare();
    const undo = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes(translate("ko", "today.prepare.braindump.undo")),
    )!;
    expect(undo.disabled).toBe(false);
    mutate.mockResolvedValueOnce(null);
    await act(async () => {
      undo.click();
    });
    expect(mutate).toHaveBeenCalledWith({ type: "undo" });
    expect(undo.disabled).toBe(true);
  });

  it("renders capture rows with filter chips derived from the candidates", async () => {
    const { container } = await renderPrepare();
    const chips = Array.from(container.querySelectorAll(".today-chip")).map(
      (chip) => chip.textContent ?? "",
    );
    expect(chips.some((text) => text.includes("Gmail") && text.includes("2"))).toBe(true);
    expect(chips.some((text) => text.includes("Telegram") && text.includes("1"))).toBe(true);
    const rows = container.querySelectorAll(".today-capture-list > .today-capture-row");
    expect(rows).toHaveLength(3); // high-confidence only; medium stays under 제안
    expect(container.textContent).toContain("공유대학 예산안 검토 요청");
  });

  it("filters capture rows when a source chip is selected", async () => {
    const { container } = await renderPrepare();
    const telegramChip = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".today-chip"),
    ).find((chip) => chip.textContent?.includes("Telegram"))!;
    await act(async () => {
      telegramChip.click();
    });
    const rows = container.querySelectorAll(".today-capture-list > .today-capture-row");
    expect(rows).toHaveLength(1);
    expect(container.textContent).toContain("연구계약서 검토 회신");
    expect(container.textContent).not.toContain("공유대학 예산안 검토 요청");
  });

  it("issues a setPlan mutation with the capture ref on add-to-today", async () => {
    const { container, mutate } = await renderPrepare();
    const add = buttonByLabel(container, translate("ko", "today.capture.action.add"))!;
    await act(async () => {
      add.click();
    });
    const setPlan = mutate.mock.calls
      .map(([mutation]) => mutation)
      .find((mutation) => mutation.type === "setPlan");
    expect(setPlan).toBeDefined();
    const flexible = (setPlan as { plan: DailyPlanV1 }).plan.flexible;
    expect(
      flexible.some(
        (item) => item.itemRef.kind === "capture" && item.itemRef.captureId === "c1",
      ),
    ).toBe(true);
  });

  it("announces the new rank in the live region on keyboard-style reorder", async () => {
    const { container, mutate } = await renderPrepare();
    const moveDown = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).filter((b) => b.getAttribute("aria-label") === translate("ko", "today.top3.moveDown"))[0];
    await act(async () => {
      moveDown.click();
    });
    const live = container.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toContain("2번째로 이동");
    const setPlan = mutate.mock.calls
      .map(([mutation]) => mutation)
      .find((mutation) => mutation.type === "setPlan");
    const top = (setPlan as { plan: DailyPlanV1 }).plan.top;
    expect(top[0].itemRef).toEqual({ kind: "task", taskId: "t2" });
    expect(top[1].itemRef).toEqual({ kind: "task", taskId: "t1" });
  });

  it("rejects adding a 4th Top 3 item with a warning", async () => {
    const { container, mutate } = await renderPrepare();
    const addButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent?.includes(translate("ko", "today.top3.addOutcome")),
    )!;
    await act(async () => {
      addButton.click();
    });
    expect(container.textContent).toContain(translate("ko", "today.top3.maxWarning"));
    expect(container.querySelector(".today-top3-addform")).toBeNull();
    expect(mutate).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "setPlan", plan: expect.objectContaining({}) }),
    );
  });

  it("fires applyYesterdayDecision from the carryover row actions", async () => {
    const { container, mutate } = await renderPrepare();
    const carryoverRow = Array.from(
      container.querySelectorAll<HTMLElement>(".today-yesterday-row"),
    ).find((row) => row.textContent?.includes("이월된 일"))!;
    const todayButton = Array.from(carryoverRow.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent?.includes(translate("ko", "today.yesterday.decision.today")),
    )!;
    await act(async () => {
      todayButton.click();
    });
    expect(mutate).toHaveBeenCalledWith({
      type: "applyYesterdayDecision",
      taskId: "y3",
      resolution: "today",
    });
  });

  it("shows the over-capacity warning when the plan exceeds the focus cap", async () => {
    const heavy: TodaySnapshot = {
      ...SNAPSHOT,
      plan: {
        ...PLAN,
        top: [
          planItem({ kind: "task", taskId: "t1" }, 0, 300),
          planItem({ kind: "task", taskId: "t2" }, 1, 180),
          planItem({ kind: "task", taskId: "t3" }, 2, 120),
        ],
      },
    };
    const { container } = await renderPrepare(heavy);
    // focus cap: 480분 → "8시간"; proposed 600분 > 480 → warning
    expect(container.textContent).toContain("8시간");
    expect(container.textContent).toContain(translate("ko", "today.capacity.overWarning"));
  });
});
