// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocaleContext, t as translate } from "../../lib/i18n";
import { DEFAULT_MARU_SETTINGS } from "../../lib/settings";
import type { CalendarCommitment, TodaySnapshot } from "../../lib/today";
import type { TodayContextValue } from "./todayContext";
import { TodayContext } from "./todayContext";
import { TodayCapacityCards } from "./TodayCapacityCards";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DAY = "2026-07-21";

const SNAPSHOT: TodaySnapshot = {
  logicalDay: DAY,
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

function commitment(title: string, startIso: string, endIso: string): CalendarCommitment {
  return { title, startIso, endIso, source: `calendar/${title}.md` };
}

async function renderCards(commitments: CalendarCommitment[] = []) {
  const contextValue: TodayContextValue = {
    workPath: "/tmp/work",
    settings: { ...DEFAULT_MARU_SETTINGS.tasks.today, autoPlan: false },
    timezone: "Asia/Seoul",
    snapshot: SNAPSHOT,
    loading: false,
    mutate: vi.fn(async () => null),
    reload: vi.fn(async () => {}),
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
          <TodayCapacityCards onNavigate={() => {}} commitments={commitments} />
        </TodayContext.Provider>
      </LocaleContext.Provider>,
    );
  });
  return { container, root };
}

describe("TodayCapacityCards", () => {
  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("shows the honest empty state without commitments", async () => {
    const { container } = await renderCards();
    expect(container.textContent).toContain(translate("ko", "today.capacity.constraints.none"));
  });

  it("renders the commitment count and compact merged ranges", async () => {
    // Local-time ISO strings keep the formatted ranges timezone-independent.
    const commitments = [
      commitment("아침 점검", `${DAY}T09:00:00`, `${DAY}T10:00:00`),
      commitment("주간 회의", `${DAY}T10:00:00`, `${DAY}T12:00:00`),
      commitment("집중 작업", `${DAY}T13:30:00`, `${DAY}T17:00:00`),
      commitment("저녁 리뷰", `${DAY}T18:00:00`, `${DAY}T19:00:00`),
    ];
    const { container } = await renderCards(commitments);
    expect(container.textContent).toContain(
      translate("ko", "today.capacity.constraints.reflected", { count: 4 }),
    );
    // Adjacent 09:00-10:00 + 10:00-12:00 merge; only two ranges are spelled
    // out, the rest collapses into the "외 N개" suffix.
    expect(container.textContent).toContain("09:00-12:00");
    expect(container.textContent).toContain("13:30-17:00");
    expect(container.textContent).toContain(
      translate("ko", "today.calendar.rangesMore", { count: 1 }),
    );
    expect(container.textContent).not.toContain("18:00-19:00");
    // Busy time feeds the capacity math: 18h window - 8h busy = 10h free,
    // focus capped at the 8h default.
    expect(container.textContent).toContain(
      translate("ko", "today.capacity.hoursOnly", { hours: 8 }),
    );
  });
});
