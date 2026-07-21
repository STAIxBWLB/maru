import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  isTaskConflict,
  isTodayConflict,
  readTaskEvents,
  readTaskIntegrations,
  sha256Hex,
  taskIntegrationsDrain,
  taskIntegrationsRetry,
  taskTransition,
  taskTrash,
  todayApplyPlanResult,
  todayBuildPlanRequest,
  todayErrorCode,
  todayLogicalDay,
  todayMutate,
  todayNotifyNewDay,
  todayOpen,
  todayRollover,
  type PlanItemRef,
  type TodayMutation,
  type TodaySnapshot,
} from "./today";

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(null);
});

describe("today command wrappers", () => {
  it("todayLogicalDay passes camelCase args", async () => {
    await todayLogicalDay("/work", "2026-07-21T10:00:00+09:00", "Asia/Seoul", "03:30");
    expect(invokeMock).toHaveBeenCalledWith("today_logical_day", {
      workPath: "/work",
      nowIso: "2026-07-21T10:00:00+09:00",
      timezone: "Asia/Seoul",
      dayStart: "03:30",
    });
  });

  it("todayOpen passes the full day-window args", async () => {
    await todayOpen("/work", "2026-07-21T10:00:00+09:00", "Asia/Seoul", "03:30", "21:30");
    expect(invokeMock).toHaveBeenCalledWith("today_open", {
      workPath: "/work",
      nowIso: "2026-07-21T10:00:00+09:00",
      timezone: "Asia/Seoul",
      dayStart: "03:30",
      sleepStart: "21:30",
    });
  });

  it("todayMutate sends the explicit logicalDay and the mutation payload", async () => {
    const mutation: TodayMutation = {
      type: "applyYesterdayDecision",
      taskId: "task-1",
      resolution: "defer",
      deferDate: "2026-07-22",
    };
    await todayMutate("/work", "2026-07-21", "abc123", mutation);
    expect(invokeMock).toHaveBeenCalledWith("today_mutate", {
      workPath: "/work",
      logicalDay: "2026-07-21",
      expectedRevision: "abc123",
      mutation,
    });
  });

  it("todayRollover passes the day-window args", async () => {
    await todayRollover("/work", "2026-07-21T10:00:00+09:00", "Asia/Seoul", "03:30", "21:30");
    expect(invokeMock).toHaveBeenCalledWith("today_rollover", {
      workPath: "/work",
      nowIso: "2026-07-21T10:00:00+09:00",
      timezone: "Asia/Seoul",
      dayStart: "03:30",
      sleepStart: "21:30",
    });
  });

  it("readTaskEvents normalizes missing month/day to null", async () => {
    await readTaskEvents("/work");
    expect(invokeMock).toHaveBeenCalledWith("read_task_events", {
      workPath: "/work",
      month: null,
      day: null,
    });
    await readTaskEvents("/work", undefined, "2026-07-21");
    expect(invokeMock).toHaveBeenLastCalledWith("read_task_events", {
      workPath: "/work",
      month: null,
      day: "2026-07-21",
    });
  });

  it("taskTransition wraps the request object", async () => {
    const request = {
      taskId: "task-1",
      taskPath: "/work/tasks/active/a.md",
      kind: "complete" as const,
      expectedTaskHash: "deadbeef",
      date: "2026-07-21",
      nowIso: "2026-07-21T10:00:00+09:00",
    };
    await taskTransition("/work", request);
    expect(invokeMock).toHaveBeenCalledWith("task_transition", { workPath: "/work", request });
  });

  it("taskTrash defaults remoteDelete to null", async () => {
    await taskTrash("/work", "/work/tasks/active/a.md", "deadbeef");
    expect(invokeMock).toHaveBeenCalledWith("task_trash", {
      workPath: "/work",
      taskPath: "/work/tasks/active/a.md",
      expectedTaskHash: "deadbeef",
      remoteDelete: null,
    });
  });

  it("taskIntegrationsDrain defaults gwsPath to null", async () => {
    await taskIntegrationsDrain("/work", "2026-07-21T10:00:00+09:00");
    expect(invokeMock).toHaveBeenCalledWith("task_integrations_drain", {
      workPath: "/work",
      nowIso: "2026-07-21T10:00:00+09:00",
      gwsPath: null,
    });
  });

  it("taskIntegrationsRetry defaults ids to null", async () => {
    await taskIntegrationsRetry("/work", null, "2026-07-21T10:00:00+09:00");
    expect(invokeMock).toHaveBeenCalledWith("task_integrations_retry", {
      workPath: "/work",
      ids: null,
      nowIso: "2026-07-21T10:00:00+09:00",
    });
  });

  it("readTaskIntegrations passes only the work path", async () => {
    await readTaskIntegrations("/work");
    expect(invokeMock).toHaveBeenCalledWith("read_task_integrations", { workPath: "/work" });
  });

  it("todayNotifyNewDay defaults title/body to null", async () => {
    await todayNotifyNewDay("/work", "2026-07-21");
    expect(invokeMock).toHaveBeenCalledWith("today_notify_new_day", {
      workPath: "/work",
      logicalDay: "2026-07-21",
      title: null,
      body: null,
    });
  });

  it("todayBuildPlanRequest passes workPath and logicalDay", async () => {
    await todayBuildPlanRequest("/work", "2026-07-21");
    expect(invokeMock).toHaveBeenCalledWith("today_build_plan_request", {
      workPath: "/work",
      logicalDay: "2026-07-21",
    });
  });

  it("todayApplyPlanResult forwards the full apply payload", async () => {
    const validRefs: PlanItemRef[] = [
      { kind: "task", taskId: "task-1" },
      { kind: "capture", captureId: "cap-1" },
    ];
    await todayApplyPlanResult("/work", "2026-07-21", "rev-1", "{\"schema\":\"maru_today_plan_v1\"}", validRefs, "21:30");
    expect(invokeMock).toHaveBeenCalledWith("today_apply_plan_result", {
      workPath: "/work",
      logicalDay: "2026-07-21",
      expectedRevision: "rev-1",
      outputJson: "{\"schema\":\"maru_today_plan_v1\"}",
      validRefs,
      sleepStart: "21:30",
    });
  });
});

describe("sha256Hex", () => {
  it("hashes the empty string and a known vector", async () => {
    await expect(sha256Hex("")).resolves.toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    await expect(sha256Hex("abc")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("todayErrorCode", () => {
  it("extracts the machine-readable prefix before ': '", () => {
    expect(todayErrorCode("today_conflict: expected revision abc, found def")).toBe(
      "today_conflict",
    );
    expect(todayErrorCode("task_conflict: expected hash bogus, found deadbeef")).toBe(
      "task_conflict",
    );
    expect(todayErrorCode("today_state_missing")).toBeNull();
  });

  it("reads Error instances and rejects non-string input", () => {
    expect(todayErrorCode(new Error("today_invalid_day_start: 25:00"))).toBe(
      "today_invalid_day_start",
    );
    expect(todayErrorCode(null)).toBeNull();
    expect(todayErrorCode({ message: "today_conflict: x" })).toBeNull();
    expect(todayErrorCode("no machine prefix here")).toBeNull();
  });
});

describe("conflict helpers", () => {
  it("isTodayConflict matches only today_conflict", () => {
    expect(isTodayConflict("today_conflict: expected revision a, found b")).toBe(true);
    expect(isTodayConflict(new Error("today_conflict: x"))).toBe(true);
    expect(isTodayConflict("task_conflict: x")).toBe(false);
    expect(isTodayConflict("today_state_missing")).toBe(false);
  });

  it("isTaskConflict matches only task_conflict", () => {
    expect(isTaskConflict("task_conflict: expected hash bogus, found abc")).toBe(true);
    expect(isTaskConflict("today_conflict: x")).toBe(false);
    expect(isTaskConflict(undefined)).toBe(false);
  });
});

describe("contract type smoke", () => {
  it("builds a minimal snapshot and mutation matching the wire shape", () => {
    const ref: PlanItemRef = { kind: "task", taskId: "task-1" };
    const snapshot: TodaySnapshot = {
      logicalDay: "2026-07-21",
      generatedAt: "2026-07-21T10:00:00+09:00",
      revision: "",
      dayState: "unstarted",
      route: "prepare",
      stage: "prepare",
      timezone: "Asia/Seoul",
      dayStart: "03:30",
      sleepStart: "21:30",
      brainDump: "",
      plan: {
        logicalDay: "2026-07-21",
        inputRevision: "",
        top: [
          {
            itemRef: ref,
            lane: "top",
            order: 0,
            estimateProvisional: true,
            pinned: false,
            calendarSync: { status: "none" },
          },
        ],
        flexible: [],
        overflow: [],
        reasons: [],
        warnings: [],
      },
      yesterday: [],
      carryovers: [{ itemRef: { kind: "capture", captureId: "cap-1" }, carriedFrom: "2026-07-20" }],
      sources: [],
      unconfirmedContent: false,
    };
    const mutation: TodayMutation = { type: "setPlan", plan: snapshot.plan! };
    expect(mutation.type).toBe("setPlan");
    expect(snapshot.plan?.top[0].itemRef).toEqual({ kind: "task", taskId: "task-1" });
  });
});
