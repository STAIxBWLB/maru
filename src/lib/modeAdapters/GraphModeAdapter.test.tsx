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
import { scanAndApplyVaultDelta, setWorkspaceRegistry } from "../workspaceStore";

const parent = "/workspace";
const nestedVault = "/workspace/vault";

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
    vaultGraphRoot.mockResolvedValue(nestedVault);
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

    expect(readVaultCache).toHaveBeenCalledWith(nestedVault);
    expect(scanVault).toHaveBeenCalledWith(nestedVault, { includeDotFolders: [] });
    expect(startVaultWatcher).toHaveBeenCalledWith(nestedVault);
    expect(graphProps?.workspacePath).toBe(nestedVault);
    expect(graphProps?.entries?.map((item) => item.relPath)).toEqual(["initial.md"]);
    graphProps?.onGraphChanged?.();
    expect(onGraphChanged).toHaveBeenCalledWith(nestedVault);

    await act(async () => {
      // This is the exact incremental action invoked by the adapter-owned
      // watcher after its debounce; GraphView must receive the delta without
      // the document shell ever loading the nested workspace.
      await scanAndApplyVaultDelta(nestedVault, ["changed.md"], { includeDotFolders: [] });
    });

    expect(scanVaultPaths).toHaveBeenCalledWith(nestedVault, ["changed.md"], { includeDotFolders: [] });
    expect(graphProps?.entries?.map((item) => item.relPath)).toEqual(expect.arrayContaining(["initial.md", "changed.md"]));
  });
});
