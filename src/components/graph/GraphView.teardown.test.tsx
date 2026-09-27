// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocaleContext, registerDictionaries, t } from "../../lib/i18n";
import { ko } from "../../lib/i18n/locales/ko";
import { en } from "../../lib/i18n/locales/en";
import { vaultGraphLayoutSave, vaultGraphLayoutRead, vaultGraphRead } from "../../lib/api";
import { writeRecoveryCopy } from "../../lib/maruDir";
import {
  defaultGraphFilterProfile,
  defaultGraphDisplay,
  type GraphSettingsV3,
} from "../../lib/settings";
import type { VaultEntry } from "../../lib/types";
import { GraphView } from "./GraphView";

vi.mock("../../lib/api", async (original) => ({
  ...(await original<typeof import("../../lib/api")>()),
  vaultGraphLayoutSave: vi.fn(),
  vaultGraphLayoutRead: vi.fn(),
  vaultGraphRead: vi.fn(),
  isTauri: () => false,
}));

vi.mock("../../lib/maruDir", async (original) => ({
  ...(await original<typeof import("../../lib/maruDir")>()),
  writeRecoveryCopy: vi.fn(),
}));

let capturedOnLayoutSettled: ((positions: Float64Array, pinnedIds: string[]) => void) | null = null;
let capturedNodeCount = 0;

vi.mock("./GraphCanvas", () => ({
  GraphCanvas: (props: { nodes: unknown[]; onLayoutSettled: (p: Float64Array, ids: string[]) => void }) => {
    capturedOnLayoutSettled = props.onLayoutSettled;
    capturedNodeCount = props.nodes.length;
    return null;
  },
}));
vi.mock("./GraphFilterPanel", async (original) => ({
  ...(await original<typeof import("./GraphFilterPanel")>()),
  GraphFilterPanel: () => null,
}));
vi.mock("./GraphInspector", () => ({ GraphInspector: () => null }));
vi.mock("./GraphInsightsPanel", () => ({ GraphInsightsPanel: () => null }));
vi.mock("./GraphLegend", () => ({ GraphLegend: () => null }));
vi.mock("./GraphRelationReviewDialog", () => ({ GraphRelationReviewDialog: () => null }));
vi.mock("./DecisionChainLanes", () => ({ DecisionChainLanes: () => null }));
vi.mock("./GraphToolbar", () => ({ GraphToolbar: () => null, GraphZoomCluster: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function entry(patch: Partial<VaultEntry> = {}): VaultEntry {
  return {
    path: "/vault/note.md",
    relPath: "note.md",
    title: "Note",
    frontmatter: {},
    updatedAt: "2026-09-01T00:00:00Z",
    wordCount: 3,
    snippet: "",
    fileKind: "markdown",
    versionCount: 1,
    ...patch,
  };
}

function settings(): GraphSettingsV3 {
  return {
    schemaVersion: 3,
    source: "vault",
    mode: "global",
    localDepth: 1,
    localDirection: "both",
    searchAsFilter: false,
    generatedPatterns: [],
    profiles: { vault: defaultGraphFilterProfile(), workspace: defaultGraphFilterProfile() },
    display: defaultGraphDisplay(),
    panels: { pinned: false, width: 320 },
    savedViews: [],
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("GraphView teardown flush (REL-02, D3)", () => {
  let host: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    registerDictionaries({ ko, en });
    window.matchMedia = window.matchMedia ?? ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList);
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    capturedOnLayoutSettled = null;
    capturedNodeCount = 0;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    vi.mocked(vaultGraphLayoutRead).mockResolvedValue(null);
    vi.mocked(vaultGraphRead).mockResolvedValue(null);
    vi.mocked(vaultGraphLayoutSave).mockRejectedValue(new Error("disk full"));
    vi.mocked(writeRecoveryCopy).mockResolvedValue(".maru/recovery/graph-layout.json");
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root!.unmount());
    }
    host.remove();
    vi.useRealTimers();
  });

  it("flushes a pending layout write made inside the 1500ms debounce window when GraphView unmounts", async () => {
    const entries = [entry()];

    await act(async () => {
      root!.render(
        <LocaleContext.Provider value={{ locale: "ko", setLocale: () => {}, t: (key, vars) => t("ko", key, vars) }}>
          <GraphView
            workspacePath="/work"
            entries={entries}
            focusTarget={null}
            onFocusTargetChange={() => {}}
            onOpenEntry={() => {}}
            onCreateNote={() => {}}
            graphSettings={settings()}
            onGraphSettingsChange={() => {}}
            isFavorite={() => false}
            onToggleFavorite={() => {}}
          />
        </LocaleContext.Provider>,
      );
    });
    await settle();

    expect(capturedOnLayoutSettled).toBeTruthy();
    expect(capturedNodeCount).toBeGreaterThan(0);

    // Simulate the layout worker settling positions for every node.
    await act(async () => {
      const positions = new Float64Array(capturedNodeCount * 2);
      for (let i = 0; i < capturedNodeCount; i++) {
        positions[i * 2] = i * 10;
        positions[i * 2 + 1] = i * 10 + 1;
      }
      capturedOnLayoutSettled?.(positions, []);
    });
    await settle();

    // Still inside GraphView's 1500ms SAVE_DEBOUNCE_MS window: nothing saved yet.
    await act(async () => {
      vi.advanceTimersByTime(1499);
    });
    expect(vaultGraphLayoutSave).not.toHaveBeenCalled();

    await act(async () => root!.unmount());
    root = null;
    await settle();

    expect(vaultGraphLayoutSave).toHaveBeenCalledTimes(1);
    expect(vaultGraphLayoutSave).toHaveBeenCalledWith(
      "/work",
      expect.objectContaining({
        version: 2,
        positions: expect.objectContaining({ note: [0, 1] }),
      }),
    );

    // The save was made to fail above so the failure path (which the plan
    // requires to name the cache file) has to run to completion — proving the
    // teardown flush is a real settle, not a fire-and-forget cancel.
    expect(writeRecoveryCopy).toHaveBeenCalledTimes(1);
    expect(writeRecoveryCopy).toHaveBeenCalledWith(
      "/work",
      ".maru/cache/graph-layout.json",
      expect.stringContaining('"note":[0,1]'),
      "disk full",
    );
  });
});
