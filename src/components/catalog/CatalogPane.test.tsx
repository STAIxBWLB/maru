// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogEntry, CatalogScanReport } from "../../lib/catalog";
import { LocaleContext, t as translate, type Locale } from "../../lib/i18n";
import { CatalogPane } from "./CatalogPane";

vi.mock("../../lib/catalog", () => ({
  catalogScan: vi.fn(),
  catalogQuery: vi.fn(),
}));
vi.mock("../../lib/hubClient", () => ({
  hubStatus: vi.fn(),
  hubQueueDrain: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(true),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { catalogQuery, catalogScan } from "../../lib/catalog";
import { hubQueueDrain, hubStatus } from "../../lib/hubClient";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const reportFixture: CatalogScanReport = {
  scanned_at: "2026-07-18T09:00:00Z",
  entries_count: 2,
  by_kind: { "deadline-due": 1, "approval-in-flight": 1 },
  bus_seen: ["bu-a"],
  warnings: [],
  elapsed_ms: 12,
};

const entriesFixture: CatalogEntry[] = [
  {
    path: "projects/x/a.md",
    kind: "deadline-due",
    title: "Alpha report",
    business_unit: "bu-a",
    category: "formal-report",
    deadline: "2026-07-20",
    approval_status: null,
    evidence_kind: null,
    last_updated: "2026-07-17T00:00:00Z",
  },
  {
    path: "projects/x/b.md",
    kind: "approval-in-flight",
    title: "Beta approval",
    business_unit: "bu-a",
    category: "admin-approval",
    deadline: null,
    approval_status: "review",
    evidence_kind: null,
    last_updated: "2026-07-16T00:00:00Z",
  },
];

function localeValue(locale: Locale) {
  return {
    locale,
    setLocale: () => {},
    t: (key: string, vars?: Record<string, string | number>) => translate(locale, key, vars),
  };
}

async function renderCatalog(locale: Locale): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <LocaleContext.Provider value={localeValue(locale)}>
        <CatalogPane workspaceRoot="/ws" />
      </LocaleContext.Provider>,
    );
  });
  // Flush the refresh() promise chain (scan → query → hubStatus).
  await act(async () => {
    await Promise.resolve();
  });
  return { container, root };
}

describe("CatalogPane i18n", () => {
  beforeEach(() => {
    vi.mocked(catalogScan).mockResolvedValue(reportFixture);
    vi.mocked(catalogQuery).mockResolvedValue(entriesFixture);
    vi.mocked(hubStatus).mockResolvedValue({
      enabled: false,
      endpoint: "",
      deployment_mode: "private",
      reachable: false,
      cached_etags_count: 0,
      last_fetch_at: null,
      queue_depth: 2,
    });
    vi.mocked(hubQueueDrain).mockResolvedValue({
      attempted: 0,
      submitted: 0,
      failed: 0,
      remaining: 0,
      items: [],
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders Korean strings in the ko locale", async () => {
    const { container, root } = await renderCatalog("ko");
    expect(container.textContent).toContain("운영 카탈로그");
    expect(container.textContent).toContain("마감 임박");
    expect(container.textContent).toContain("결재 진행 중");
    expect(container.textContent).toContain("전체 사업단");
    expect(container.textContent).toContain("마지막 스캔:");
    expect(container.textContent).toContain("Hub 전송 대기 2건");
    await act(async () => {
      root.unmount();
    });
  });

  it("renders English strings in the en locale", async () => {
    const { container, root } = await renderCatalog("en");
    expect(container.textContent).toContain("Operations Catalog");
    expect(container.textContent).toContain("Upcoming deadlines");
    expect(container.textContent).toContain("Approvals in flight");
    expect(container.textContent).toContain("All business units");
    expect(container.textContent).toContain("Last scan:");
    expect(container.textContent).toContain("2 Hub submission(s) queued");
    await act(async () => {
      root.unmount();
    });
  });

  it("drains the hub queue from the footer retry button", async () => {
    const { container, root } = await renderCatalog("ko");
    const retry = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("재시도"),
    );
    expect(retry).toBeDefined();
    await act(async () => {
      retry!.click();
    });
    expect(hubQueueDrain).toHaveBeenCalledWith("/ws");
    expect(container.textContent).not.toContain("Hub 전송 대기");
    await act(async () => {
      root.unmount();
    });
  });
});
