// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateWorkspaceM365ProviderConfig } from "./settings";
import type { WorkspaceConfig } from "./types";
import { useWorkspaceConfigLoad } from "./useWorkspaceConfigLoad";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
});

describe("useWorkspaceConfigLoad", () => {
  it("retries a rejected read and recovers after Refresh", async () => {
    const repaired: WorkspaceConfig = {
      version: 1,
      paths: {},
      io: { providers: { mso: { command: "/repaired/m365" } } },
    };
    const reader = vi
      .fn<(workPath: string) => Promise<WorkspaceConfig>>()
      .mockRejectedValueOnce(
        new Error("Cannot parse workspace.config.yaml: invalid type at line 2"),
      )
      .mockResolvedValueOnce(repaired);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    function Harness() {
      const { state, reload } = useWorkspaceConfigLoad("/workspace/retry", { reader });
      return (
        <>
          <output data-status={state.status}>{state.error}</output>
          <button type="button" onClick={() => void reload()}>
            Refresh
          </button>
        </>
      );
    }

    await act(async () => {
      root.render(<Harness />);
    });
    await act(async () => {});
    expect(container.querySelector("output")?.dataset.status).toBe("error");
    expect(container.textContent).toContain(
      "Cannot parse workspace.config.yaml: invalid type at line 2",
    );

    await act(async () => {
      container
        .querySelector("button")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector("output")?.dataset.status).toBe("ready");
    expect(container.querySelector("output")?.textContent).toBe("");
    expect(reader).toHaveBeenCalledTimes(2);

    await act(async () => root.unmount());
  });

  it("treats a missing config as a successful null config", async () => {
    const reader = vi
      .fn<(workPath: string) => Promise<WorkspaceConfig>>()
      .mockRejectedValue(
        "workspace.config.yaml not found at /workspace/plain/workspace.config.yaml",
      );
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    function Harness() {
      const { state } = useWorkspaceConfigLoad("/workspace/plain", { reader });
      return <output data-status={state.status}>{String(state.config)}</output>;
    }

    await act(async () => {
      root.render(<Harness />);
    });
    await act(async () => {});
    expect(container.querySelector("output")?.dataset.status).toBe("ready");
    expect(container.querySelector("output")?.textContent).toBe("null");

    await act(async () => root.unmount());
  });

  it("surfaces an invalid present mso alias and does not mark it ready", async () => {
    const reader = vi.fn(async (): Promise<WorkspaceConfig> => ({
      version: 1,
      paths: {},
      io: {
        providers: {
          mso: null,
          outlook: { command: "/outlook/m365" },
        },
      },
    }));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    function Harness() {
      const { state } = useWorkspaceConfigLoad("/workspace/invalid", {
        reader,
        validator: validateWorkspaceM365ProviderConfig,
      });
      return <output data-status={state.status}>{state.error}</output>;
    }

    await act(async () => {
      root.render(<Harness />);
    });
    await act(async () => {});
    expect(container.querySelector("output")?.dataset.status).toBe("error");
    expect(container.textContent).toContain(
      "Invalid workspace.config.yaml: io.providers.mso must be a mapping",
    );

    await act(async () => root.unmount());
  });
});
