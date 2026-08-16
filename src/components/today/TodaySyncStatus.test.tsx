// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocaleContext, t as translate } from "../../lib/i18n";
import "../../lib/i18n/testing";
import { DEFAULT_MARU_SETTINGS } from "../../lib/settings";
import type { OutboxRecord, WebActionSummary } from "../../lib/today";
import type { TodayContextValue } from "./todayContext";
import { TodayContext } from "./todayContext";
import { TodaySyncStatus } from "./TodaySyncStatus";

vi.mock("../../lib/today", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/today")>();
  return {
    ...original,
    readTaskIntegrations: vi.fn(),
    taskIntegrationsRetry: vi.fn(),
    taskIntegrationsDrain: vi.fn(),
    webActionsScan: vi.fn(),
    webActionsApply: vi.fn(),
  };
});

import {
  readTaskIntegrations,
  taskIntegrationsDrain,
  taskIntegrationsRetry,
  webActionsApply,
  webActionsScan,
} from "../../lib/today";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function record(overrides: Partial<OutboxRecord>): OutboxRecord {
  return {
    id: "ob-1",
    op: "complete",
    taskPath: "tasks/active/alpha.md",
    googleTaskId: "gt-1",
    googleTaskListId: null,
    status: "synced",
    attempts: 1,
    nextRetryAt: null,
    lastError: null,
    createdAt: "2026-07-21T00:00:00Z",
    updatedAt: "2026-07-21T00:01:00Z",
    ...overrides,
  };
}

function webAction(overrides: Partial<WebActionSummary> = {}): WebActionSummary {
  return {
    receiptPath: "shared/web/task-actions/pending/2026-08/wa-1.yaml",
    id: "wa-1",
    operation: "complete",
    taskPath: "tasks/active/alpha.md",
    requestedAt: "2026-08-16T00:00:00Z",
    requestedBy: "web:owner@example.com",
    state: "pending",
    reason: null,
    ...overrides,
  };
}

async function renderSection(
  records: OutboxRecord[],
  pending: WebActionSummary[] = [],
): Promise<HTMLElement> {
  vi.mocked(readTaskIntegrations).mockResolvedValue(records);
  vi.mocked(webActionsScan).mockResolvedValue(pending);
  const contextValue: TodayContextValue = {
    workPath: "/tmp/work",
    settings: { ...DEFAULT_MARU_SETTINGS.tasks.today, autoPlan: false },
    timezone: "Asia/Seoul",
    snapshot: null,
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
          <TodaySyncStatus />
        </TodayContext.Provider>
      </LocaleContext.Provider>,
    );
  });
  return container;
}

function headerButton(container: HTMLElement): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>(".today-sync-status-header")!;
}

describe("TodaySyncStatus", () => {
  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("renders nothing when the outbox and the web receipts are both empty", async () => {
    const container = await renderSection([]);
    expect(container.querySelector(".today-sync-status")).toBeNull();
  });

  it("surfaces pending web receipts even with an empty outbox", async () => {
    const container = await renderSection([], [webAction()]);
    expect(container.querySelector(".today-sync-status")).not.toBeNull();
    expect(container.querySelector(".today-sync-status-count.neutral")?.textContent).toContain("1");
  });

  it("applying web actions drains and reloads, and never commits", async () => {
    const container = await renderSection([], [webAction(), webAction({ id: "wa-2" })]);
    vi.mocked(webActionsApply).mockResolvedValue({
      applied: 1,
      skipped: 0,
      stale: 1,
      invalid: 0,
      items: [],
    });
    vi.mocked(taskIntegrationsDrain).mockResolvedValue({ drained: 1, failed: 0, blocked: 0 });
    await act(async () => {
      headerButton(container).click();
    });
    expect(container.querySelector(".today-sync-web-summary")?.textContent).toContain("2");
    const apply = container.querySelector<HTMLButtonElement>(".today-sync-web .today-panel-link")!;
    const loadsBefore = vi.mocked(readTaskIntegrations).mock.calls.length;
    await act(async () => {
      apply.click();
    });
    expect(webActionsApply).toHaveBeenCalledWith("/tmp/work", expect.any(String));
    // The provider ops the receipts queued go out in the same click.
    expect(taskIntegrationsDrain).toHaveBeenCalledWith("/tmp/work", expect.any(String));
    expect(vi.mocked(readTaskIntegrations).mock.calls.length).toBe(loadsBefore + 1);
    // Result line reports every bucket, and points at Git Sync for the push.
    const result = container.querySelector(".today-sync-web-result")?.textContent ?? "";
    expect(result).toContain("Git Sync");
    expect(result).toContain("재시도 필요 1건");
  });

  it("renders rows with op and status badges once expanded", async () => {
    const container = await renderSection([
      record({ id: "ob-1", status: "synced", taskPath: "tasks/active/alpha.md" }),
      record({ id: "ob-2", status: "ready", op: "reopen", taskPath: "tasks/active/beta.md" }),
    ]);
    // Collapsed by default: header only, no rows.
    expect(headerButton(container).getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelectorAll(".today-sync-status-row")).toHaveLength(0);
    await act(async () => {
      headerButton(container).click();
    });
    const rows = container.querySelectorAll(".today-sync-status-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("alpha");
    expect(rows[0].textContent).toContain("동기화됨");
    // In-flight states (prepared/ready/syncing) all read as "syncing".
    expect(rows[1].textContent).toContain("다시 열기");
    expect(rows[1].textContent).toContain("동기화 중");
  });

  it("shows a problem count badge on the collapsed header", async () => {
    const container = await renderSection([
      record({ id: "ob-1", status: "synced" }),
      record({ id: "ob-2", status: "retryNeeded", lastError: "network down" }),
      record({ id: "ob-3", status: "authBlocked" }),
    ]);
    const badge = container.querySelector(".today-sync-status-count");
    expect(badge?.textContent).toContain("2");
  });

  it("retry button requeues, drains, then reloads", async () => {
    const failing = record({ id: "ob-9", status: "retryNeeded", attempts: 3 });
    const container = await renderSection([failing]);
    vi.mocked(taskIntegrationsRetry).mockResolvedValue({ requeued: 1 });
    vi.mocked(taskIntegrationsDrain).mockResolvedValue({ drained: 1, failed: 0, blocked: 0 });
    await act(async () => {
      headerButton(container).click();
    });
    const retry = container.querySelector<HTMLButtonElement>(
      ".today-sync-status-row .today-panel-link",
    )!;
    expect(retry.textContent).toContain("다시 시도");
    const loadsBefore = vi.mocked(readTaskIntegrations).mock.calls.length;
    await act(async () => {
      retry.click();
    });
    expect(taskIntegrationsRetry).toHaveBeenCalledWith("/tmp/work", ["ob-9"], expect.any(String));
    expect(taskIntegrationsDrain).toHaveBeenCalledWith("/tmp/work", expect.any(String));
    expect(vi.mocked(readTaskIntegrations).mock.calls.length).toBe(loadsBefore + 1);
  });

  it("shows the re-auth guidance for authBlocked rows", async () => {
    const container = await renderSection([
      record({ id: "ob-1", status: "authBlocked", lastError: "insufficient authentication scopes" }),
    ]);
    await act(async () => {
      headerButton(container).click();
    });
    expect(container.querySelector(".today-sync-status-hint")?.textContent).toContain("gws CLI");
    expect(container.querySelector(".today-sync-status-row")?.getAttribute("title")).toBe(
      "insufficient authentication scopes",
    );
  });

  it("refresh-all requeues everything failed, drains, and reloads", async () => {
    const container = await renderSection([record({ id: "ob-1", status: "synced" })]);
    vi.mocked(taskIntegrationsRetry).mockResolvedValue({ requeued: 0 });
    vi.mocked(taskIntegrationsDrain).mockResolvedValue({ drained: 1, failed: 0, blocked: 0 });
    await act(async () => {
      headerButton(container).click();
    });
    const refresh = container.querySelector<HTMLButtonElement>(
      ".today-sync-status-toolbar .today-panel-link",
    )!;
    const loadsBefore = vi.mocked(readTaskIntegrations).mock.calls.length;
    await act(async () => {
      refresh.click();
    });
    expect(taskIntegrationsRetry).toHaveBeenCalledWith("/tmp/work", null, expect.any(String));
    expect(taskIntegrationsDrain).toHaveBeenCalled();
    expect(vi.mocked(readTaskIntegrations).mock.calls.length).toBe(loadsBefore + 1);
  });
});
