// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  agentsUsageStatus: vi.fn(),
  openSettingsWindow: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  AGENT_PROVIDERS: ["claude", "codex", "kimi", "kiro"],
  agentsUsageStatus: mocks.agentsUsageStatus,
}));

vi.mock("../lib/windowLayout", () => ({
  openSettingsWindow: mocks.openSettingsWindow,
}));

import { AgentUsageBar } from "../components/AgentUsageBar";
import { LocaleContext } from "../lib/i18n";
import type { AgentUsageStatus } from "../lib/api";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const t = (key: string, vars?: Record<string, string | number>) => {
  if (key === "agents.usage.usedSuffix") return "used";
  if (key.startsWith("system.agents.agent.")) return key.slice("system.agents.agent.".length);
  let result = key;
  for (const [name, value] of Object.entries(vars ?? {})) {
    result = result.replace(`{${name}}`, String(value));
  }
  return result;
};

function usageEntry(patch: Partial<AgentUsageStatus> = {}): AgentUsageStatus {
  return {
    id: "claude",
    state: "ok",
    windows: [],
    updatedAt: new Date().toISOString(),
    message: null,
    ...patch,
  };
}

describe("AgentUsageBar", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mocks.openSettingsWindow.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  async function render(workPath: string | null = "/work") {
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <LocaleContext.Provider value={{ locale: "en", setLocale: () => {}, t }}>
          <AgentUsageBar workPath={workPath} />
        </LocaleContext.Provider>,
      );
    });
    // Flush the initial agentsUsageStatus() promise.
    await act(async () => {});
  }

  it("renders one chip per agent with usage segments for ok state", async () => {
    const in48m = new Date(Date.now() + 48 * 60_000).toISOString();
    const in2d20h = new Date(Date.now() + (2 * 24 + 20) * 3_600_000).toISOString();
    mocks.agentsUsageStatus.mockResolvedValue([
      usageEntry({
        id: "claude",
        windows: [
          { label: "Session", usedPercent: 19, resetsAt: in48m },
          { label: "Weekly", usedPercent: 89, resetsAt: in2d20h },
        ],
      }),
      usageEntry({
        id: "codex",
        windows: [{ label: "Session", usedPercent: 5, resetsAt: null }],
      }),
    ]);
    await render();

    const chips = container.querySelectorAll(".agent-usage-chip");
    expect(chips).toHaveLength(2);
    expect(chips[0].textContent).toContain("claude");
    expect(chips[0].textContent).toContain("19% used 48m");
    expect(chips[0].textContent).toContain("89% used 2d 20h");
    expect(chips[0].textContent).toContain(" · ");
    expect(chips[1].textContent).toContain("5% used");
    expect(chips[0].classList.contains("dimmed")).toBe(false);
  });

  it("renders dimmed chips with a dash for unsupported agents", async () => {
    mocks.agentsUsageStatus.mockResolvedValue([
      usageEntry({ id: "kimi", state: "unsupported" }),
    ]);
    await render();

    const chip = container.querySelector(".agent-usage-chip");
    expect(chip).not.toBeNull();
    expect(chip?.classList.contains("dimmed")).toBe(true);
    expect(chip?.textContent).toContain("—");
  });

  it("renders nothing when every agent is cli_missing", async () => {
    mocks.agentsUsageStatus.mockResolvedValue([
      usageEntry({ id: "claude", state: "cli_missing" }),
      usageEntry({ id: "kiro", state: "cli_missing" }),
    ]);
    await render();

    expect(container.querySelector(".agent-usage-bar")).toBeNull();
  });

  it("opens the settings window Agents tab when a chip is clicked", async () => {
    mocks.agentsUsageStatus.mockResolvedValue([
      usageEntry({ id: "claude", windows: [{ label: "Session", usedPercent: 1, resetsAt: null }] }),
    ]);
    await render("/work/vault");

    const chip = container.querySelector<HTMLButtonElement>(".agent-usage-chip");
    await act(async () => {
      chip?.click();
    });
    expect(mocks.openSettingsWindow).toHaveBeenCalledWith("/work/vault", "agents");
  });

  it("passes force only on manual refresh", async () => {
    mocks.agentsUsageStatus.mockResolvedValue([usageEntry()]);
    await render();
    expect(mocks.agentsUsageStatus).toHaveBeenCalledWith(false);

    const refresh = container.querySelector<HTMLButtonElement>(".agent-usage-refresh");
    await act(async () => {
      refresh?.click();
    });
    expect(mocks.agentsUsageStatus).toHaveBeenLastCalledWith(true);
  });
});
