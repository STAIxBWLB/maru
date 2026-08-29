// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { VaultEntry } from "../types";

const readVaultCache = vi.fn<() => Promise<VaultEntry[] | null>>();
const scanVault = vi.fn<() => Promise<VaultEntry[]>>();
const scanVaultPaths = vi.fn<() => Promise<VaultEntry[]>>();
const vaultGraphRoot = vi.fn<() => Promise<string | null>>();
const startVaultWatcher = vi.fn<() => Promise<void>>();
const stopVaultWatcher = vi.fn<() => Promise<void>>();
const indexDeltaListeners = new Set<(event: { payload: { workspacePath: string; paths: string[] } }) => void>();
let graphProps: { workspacePath?: string | null; entries?: VaultEntry[]; onGraphChanged?(): void } | null = null;

vi.mock("../api", () => ({
  listWorkspaceSubmodules: async (): Promise<string[]> => [],
  readVaultCache: (...args: []) => readVaultCache(...args),
  scanVault: (...args: []) => scanVault(...args),
  scanVaultPaths: (...args: []) => scanVaultPaths(...args),
  vaultGraphRoot: (...args: []) => vaultGraphRoot(...args),
  startVaultWatcher: (...args: []) => startVaultWatcher(...args),
  stopVaultWatcher: (...args: []) => stopVaultWatcher(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_event: string, listener: (event: { payload: { workspacePath: string; paths: string[] } }) => void) => {
    indexDeltaListeners.add(listener);
    return () => { indexDeltaListeners.delete(listener); };
  }),
}));
vi.mock("../../components/graph/GraphView", () => ({
  GraphView: (props: typeof graphProps) => {
    graphProps = props;
    return <div data-testid="graph-view" />;
  },
}));

import { GraphModeAdapter } from "./GraphModeAdapter";
import { listen as listenForTest } from "@tauri-apps/api/event";
import { setWorkspaceRegistry } from "../workspaceStore";

const parent = "/workspace";
const nestedVault = "/workspace/vault";
let resolveVaultGraphRoot: (root: string | null) => void;

function entry(relPath: string): VaultEntry {
  return {
    path: `${nestedVault}/${relPath}`,
    relPath,
    title: relPath,
    frontmatter: {},
    updatedAt: null,
    wordCount: 0,
    snippet: "",
    fileKind: "markdown",
    versionCount: 0,
  };
}

describe("GraphModeAdapter", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    indexDeltaListeners.clear();
    graphProps = null;
    readVaultCache.mockReset();
    scanVault.mockReset();
    scanVaultPaths.mockReset();
    vaultGraphRoot.mockReset();
    startVaultWatcher.mockReset();
    stopVaultWatcher.mockReset();
    vaultGraphRoot.mockImplementation(
      () => new Promise<string | null>((resolve) => { resolveVaultGraphRoot = resolve; }),
    );
    readVaultCache.mockResolvedValue([entry("cached.md")]);
    scanVault.mockResolvedValue([entry("initial.md")]);
    scanVaultPaths.mockResolvedValue([entry("changed.md")]);
    startVaultWatcher.mockResolvedValue();
    stopVaultWatcher.mockResolvedValue();
    setWorkspaceRegistry({
      workspaces: [{ label: "workspace", path: parent, visibility: "private", provider: "local", writePolicy: "direct" }],
      activeByVisibility: { private: parent, public: null },
      hiddenDefaults: [],
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("loads and watches a nested graph workspace that the document shell never opened", async () => {
    const onGraphChanged = vi.fn();
    await act(async () => {
      root.render(
        <GraphModeAdapter
          scope={{ workspacePath: parent, documentBrowserScope: { workspacePath: parent, visibility: "private" } }}
          commands={{ renderPrimarySurface: () => null, graphScanOptions: { includeDotFolders: [] }, onGraphChanged }}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(listenForTest).toHaveBeenCalledTimes(1));

    await act(async () => {
      resolveVaultGraphRoot(nestedVault);
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(listenForTest).toHaveBeenCalledTimes(2));

    expect(readVaultCache).toHaveBeenCalledWith(nestedVault);
    expect(scanVault).toHaveBeenCalledWith(nestedVault, { includeDotFolders: [] });
    expect(startVaultWatcher).toHaveBeenCalledWith(nestedVault);
    expect(graphProps?.workspacePath).toBe(nestedVault);
    expect(graphProps?.entries?.map((item) => item.relPath)).toEqual(["initial.md"]);
    graphProps?.onGraphChanged?.();
    expect(onGraphChanged).toHaveBeenCalledWith(nestedVault);
    expect(indexDeltaListeners.size).toBe(1);

    await act(async () => {
      // Exercise the adapter-owned watcher path: the Tauri listener receives
      // a nested-vault delta, then dispatches the incremental scan after its
      // trailing debounce. The document shell never opens this workspace.
      for (const listener of indexDeltaListeners) {
        listener({ payload: { workspacePath: nestedVault, paths: ["changed.md"] } });
      }
      await vi.advanceTimersByTimeAsync(151);
    });

    expect(scanVaultPaths).toHaveBeenCalledWith(nestedVault, ["changed.md"], { includeDotFolders: [] });
    expect(graphProps?.entries?.map((item) => item.relPath)).toEqual(expect.arrayContaining(["initial.md", "changed.md"]));
  });
});
