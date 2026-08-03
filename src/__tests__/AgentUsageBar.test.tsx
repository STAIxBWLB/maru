// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  agentsUsageStatus: vi.fn(),
  dotSyncOverview: vi.fn(),
  skillsBundleStatus: vi.fn(),
  activeMissions: [] as Array<{
    id: string;
    status: "idle" | "running";
    startedAt: string;
  }>,
}));

vi.mock("../lib/api", () => ({
  AGENT_PROVIDERS: ["claude", "codex", "kimi", "kiro"],
  agentsUsageStatus: mocks.agentsUsageStatus,
  dotSyncOverview: mocks.dotSyncOverview,
}));

vi.mock("../lib/skills", () => ({
  skillsBundleStatus: mocks.skillsBundleStatus,
}));

vi.mock("../lib/useActiveMissions", () => ({
  useActiveMissions: () => mocks.activeMissions,
}));

import { AgentUsageBar } from "../components/AgentUsageBar";
import { LocaleContext } from "../lib/i18n";
import type { AgentUsageStatus, DotSyncOverview } from "../lib/api";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const t = (key: string, vars?: Record<string, string | number>) => {
  if (key === "agents.usage.usedSuffix") return "used";
  if (key === "agents.usage.filesLabel") return "files";
  if (key === "agents.usage.skillsVersion") return `Skills ${vars?.version ?? ""}`;
  if (key === "agents.usage.sync.scheduled") return `${vars?.count ?? 0} jobs`;
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
    mocks.agentsUsageStatus.mockResolvedValue([]);
    mocks.dotSyncOverview.mockResolvedValue({
      cli: {
        available: false,
        compatible: false,
        path: null,
        version: null,
        minimumVersion: "2.62.0",
        message: null,
      },
      mirror: null,
      peer: null,
    } satisfies DotSyncOverview);
    mocks.skillsBundleStatus.mockResolvedValue(null);
    mocks.activeMissions = [];
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  async function render(
    onOpenSettings?: (tab: string) => void,
    commandOverrides = { claude: "/opt/bin/claude" },
    statusProps: {
      onOpenAgents?: () => void;
      workspaceName?: string | null;
      workspaceFileCount?: number | null;
    } = {},
  ) {
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <LocaleContext.Provider value={{ locale: "en", setLocale: () => {}, t }}>
          <AgentUsageBar
            commandOverrides={commandOverrides}
            onOpenSettings={onOpenSettings}
            {...statusProps}
          />
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

  it("keeps the status bar and an empty chips region when every agent is cli_missing", async () => {
    mocks.agentsUsageStatus.mockResolvedValue([
      usageEntry({ id: "claude", state: "cli_missing" }),
      usageEntry({ id: "kiro", state: "cli_missing" }),
    ]);
    await render();

    expect(container.querySelector(".agent-usage-bar")).not.toBeNull();
    expect(container.querySelector(".agent-usage-chips")).not.toBeNull();
    expect(container.querySelectorAll(".agent-usage-chip")).toHaveLength(0);
    expect(container.querySelector(".agent-usage-stat")?.textContent).toContain("0");
  });

  it("shows the active mission count and opens Agents", async () => {
    mocks.activeMissions = [
      { id: "mission-1", status: "running", startedAt: "2026-08-03T00:00:00Z" },
      { id: "mission-2", status: "idle", startedAt: "2026-08-02T00:00:00Z" },
    ];
    const onOpenAgents = vi.fn();
    await render(undefined, undefined, { onOpenAgents });

    const missions = container.querySelector<HTMLButtonElement>(".agent-usage-stat");
    expect(missions?.textContent).toContain("2");
    expect(missions?.classList.contains("idle")).toBe(false);
    await act(async () => {
      missions?.click();
    });
    expect(onOpenAgents).toHaveBeenCalledOnce();
  });

  it("dims the mission chip at zero", async () => {
    await render();

    const missions = container.querySelector(".agent-usage-stat");
    expect(missions?.textContent).toContain("0");
    expect(missions?.classList.contains("idle")).toBe(true);
  });

  it("shows the workspace label and ready file count", async () => {
    await render(undefined, undefined, {
      workspaceName: "Private notes",
      workspaceFileCount: 42,
    });

    expect(container.querySelector(".agent-usage-workspace-name")?.textContent).toBe(
      "Private notes",
    );
    expect(
      container.querySelector(".agent-usage-workspace-name")?.nextElementSibling?.textContent,
    ).toBe("42 files");
  });

  it("shows a dash while the workspace file count is unknown", async () => {
    await render(undefined, undefined, {
      workspaceName: "Private notes",
      workspaceFileCount: null,
    });

    expect(
      container.querySelector(".agent-usage-workspace-name")?.nextElementSibling?.textContent,
    ).toBe("— files");
  });

  it("omits the workspace chip when there is no workspace", async () => {
    await render(undefined, undefined, { workspaceName: null, workspaceFileCount: 0 });

    expect(container.querySelector(".agent-usage-workspace-name")).toBeNull();
  });

  it("opens Projects when the workspace chip is clicked", async () => {
    const onOpenSettings = vi.fn();
    await render(onOpenSettings, undefined, {
      workspaceName: "Private notes",
      workspaceFileCount: 3,
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(".agent-usage-workspace-name")
        ?.parentElement?.click();
    });
    expect(onOpenSettings).toHaveBeenCalledWith("projects");
  });

  it("shows dot sync job health and opens Jobs", async () => {
    const syncOverview: DotSyncOverview = {
      cli: {
        available: true,
        compatible: true,
        path: "/opt/homebrew/bin/dot",
        version: "2.62.0",
        minimumVersion: "2.62.0",
        message: null,
      },
      mirror: {
        schemaVersion: 1,
        kind: "mirror",
        profile: "sync",
        configured: true,
        workspacePath: "/work",
        storeDir: "/work/.dotfiles/sync",
        target: { kind: "local", spec: "local:/mirror", path: "/mirror" },
        localExists: true,
        targetExists: true,
        paused: false,
        lockHeld: false,
        owner: "mac-a",
        canPush: true,
        machineNames: ["mac-a"],
        filterMode: "include",
        allowCount: 0,
        submoduleCount: 0,
        propagation: { create: true, update: true, delete: false },
        maxDelete: 1000,
        lastPullAt: null,
        lastPushAt: null,
        lastIntakeAt: null,
        conflictCount: 0,
        logPath: "/log",
        includePath: "/include",
        excludePath: "/exclude",
        ignorePath: "/ignore",
        allowPath: "/allow",
        jobs: [{ id: "push", action: "push", label: "push", intervalSeconds: 600, mode: "clean", state: "running", lastRunAt: null }],
      },
      peer: null,
    };
    mocks.dotSyncOverview.mockResolvedValue(syncOverview);
    const onOpenSettings = vi.fn();
    await render(onOpenSettings);

    const sync = container.querySelector<HTMLButtonElement>(".dot-sync-status");
    expect(sync?.classList.contains("scheduled")).toBe(true);
    expect(sync?.textContent).toContain("1");
    await act(async () => sync?.click());
    expect(onOpenSettings).toHaveBeenCalledWith("jobs");
  });

  it("shows the skills version alongside usage chips", async () => {
    mocks.agentsUsageStatus.mockResolvedValue([
      usageEntry({
        id: "claude",
        windows: [{ label: "Session", usedPercent: 4, resetsAt: null }],
      }),
    ]);
    mocks.skillsBundleStatus.mockResolvedValue({
      active: { displayVersion: "2026.08.03" },
      updateAvailable: true,
    });
    const onOpenSettings = vi.fn();
    await render(onOpenSettings);

    expect(container.querySelector(".agent-usage-chip")).not.toBeNull();
    const skills = container.querySelector<HTMLButtonElement>(".agent-usage-skills");
    expect(skills?.textContent).toContain("2026.08.03");
    expect(skills?.querySelector(".agent-usage-skills-dot")).not.toBeNull();
    await act(async () => {
      skills?.click();
    });
    expect(onOpenSettings).toHaveBeenCalledWith("skills");
  });

  it("opens the settings Agents tab when a chip is clicked", async () => {
    mocks.agentsUsageStatus.mockResolvedValue([
      usageEntry({ id: "claude", windows: [{ label: "Session", usedPercent: 1, resetsAt: null }] }),
    ]);
    const onOpenSettings = vi.fn();
    await render(onOpenSettings);

    const chip = container.querySelector<HTMLButtonElement>(".agent-usage-chip");
    await act(async () => {
      chip?.click();
    });
    expect(onOpenSettings).toHaveBeenCalledWith("agents");
  });

  it("debounces focus reloads to at most one per 30s", async () => {
    vi.useFakeTimers();
    try {
      mocks.agentsUsageStatus.mockResolvedValue([usageEntry()]);
      await render();
      const calls = () => mocks.agentsUsageStatus.mock.calls.length;
      expect(calls()).toBe(1);

      // Focus right after the initial load: debounced.
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      expect(calls()).toBe(1);

      // Focus once the last load is older than 30s: reloads.
      await act(async () => {
        vi.advanceTimersByTime(31_000);
        window.dispatchEvent(new Event("focus"));
      });
      expect(calls()).toBe(2);

      // Focus again within 30s of that reload: debounced.
      await act(async () => {
        vi.advanceTimersByTime(5_000);
        window.dispatchEvent(new Event("focus"));
      });
      expect(calls()).toBe(2);

      // The 60s interval still polls independently of focus.
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(calls()).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes force only on manual refresh", async () => {
    mocks.agentsUsageStatus.mockResolvedValue([usageEntry()]);
    await render();
    expect(mocks.agentsUsageStatus).toHaveBeenCalledWith(
      { claude: "/opt/bin/claude" },
      false,
    );

    const refresh = container.querySelector<HTMLButtonElement>(".agent-usage-refresh");
    await act(async () => {
      refresh?.click();
    });
    expect(mocks.agentsUsageStatus).toHaveBeenLastCalledWith(
      { claude: "/opt/bin/claude" },
      true,
    );
  });
});
