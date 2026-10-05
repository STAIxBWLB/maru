// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listArchitectureBlueprints: vi.fn(),
  prepareArchitectureBlueprint: vi.fn(async (_root: string, path: string) => path),
  openInFileManager: vi.fn(async () => undefined),
  architectureReadSiblingSpec: vi.fn(),
  listDiagrams: vi.fn(async () => [] as { name: string }[]),
  writeDiagram: vi.fn(async (_root: string, _name: string, doc: unknown) => doc),
}));

vi.mock("../../lib/api", () => mocks);
vi.mock("../../lib/diagram/persistence", () => ({
  listDiagrams: mocks.listDiagrams,
  writeDiagram: mocks.writeDiagram,
}));

import { IpcError } from "../../lib/ipcError";
import { ArchitecturePane } from "./ArchitecturePane";
import { LocaleContext } from "../../lib/i18n";

const t = (key: string) => key;
const blueprint = (group: "dev" | "sites", repo: string, slug: string, title: string) => ({
  slug,
  title,
  group,
  repoPath: `${group}/${repo}`,
  htmlPath: `/work/${group}/${repo}/docs/${slug}-rendered.html`,
  modifiedAt: 1,
});

describe("ArchitecturePane", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.documentElement.dataset.theme = "light";
    container = document.createElement("div");
    document.body.appendChild(container);
    mocks.prepareArchitectureBlueprint.mockClear();
    mocks.listArchitectureBlueprints.mockResolvedValue([
      blueprint("dev", "alpha", "alpha", "Alpha Service"),
      blueprint("sites", "beta", "beta", "Beta Site"),
      blueprint("sites", "gamma", "gamma", "Gamma Site"),
    ]);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    container.remove();
  });

  async function render(): Promise<void> {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <LocaleContext.Provider value={{ locale: "en", setLocale: () => {}, t }}>
          <ArchitecturePane workspacePath="/work" onRevealInFiles={() => {}} />
        </LocaleContext.Provider>,
      );
    });
  }

  const frame = () => container.querySelector<HTMLIFrameElement>('[data-testid="architecture-frame"]');
  const titles = () => [...container.querySelectorAll(".architecture-item strong")].map((node) => node.textContent);

  it("groups blueprints and shows the first one in a sandbox without same-origin", async () => {
    await render();

    const groups = [...container.querySelectorAll(".architecture-group")].map((node) => node.getAttribute("aria-label"));
    expect(groups).toEqual(["architecture.group.dev", "architecture.group.sites"]);
    expect(titles()).toEqual(["Alpha Service", "Beta Site", "Gamma Site"]);
    expect(mocks.prepareArchitectureBlueprint).toHaveBeenCalledWith("/work", "/work/dev/alpha/docs/alpha-rendered.html");

    const sandbox = frame()!.getAttribute("sandbox")!.split(" ");
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
    expect(sandbox).not.toContain("allow-top-navigation");
    expect(frame()!.getAttribute("src")).toMatch(/alpha-rendered\.html\?theme=light$/);
  });

  it("follows a live app theme toggle", async () => {
    await render();

    await act(async () => {
      document.documentElement.dataset.theme = "dark";
      await Promise.resolve();
    });

    expect(frame()!.getAttribute("src")).toMatch(/\?theme=dark$/);
  });

  it("shows a failed grant in the viewer and clears it on the next selection", async () => {
    mocks.prepareArchitectureBlueprint.mockRejectedValueOnce(new Error("Not a listed architecture blueprint"));
    await render();

    expect(frame()).toBeNull();
    expect(container.querySelector(".architecture-viewer-col [role=alert]")?.textContent).toBe("architecture.error");
    expect(container.querySelector(".architecture-list-col [role=alert]")).toBeNull();

    await act(async () => {
      container.querySelectorAll<HTMLButtonElement>(".architecture-item")[1].click();
    });
    expect(container.querySelector("[role=alert]")).toBeNull();
    expect(frame()!.getAttribute("src")).toMatch(/beta-rendered\.html\?theme=light$/);
  });

  it("filters by title or repo and grants the clicked blueprint", async () => {
    await render();

    const search = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "sites/gam");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(titles()).toEqual(["Gamma Site"]);

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".architecture-item")!.click();
    });
    expect(mocks.prepareArchitectureBlueprint).toHaveBeenLastCalledWith(
      "/work",
      "/work/sites/gamma/docs/gamma-rendered.html",
    );
    expect(frame()!.getAttribute("src")).toMatch(/gamma-rendered\.html\?theme=light$/);
  });
});

describe("ArchitecturePane copy-to-Diagram handoff (issue #433)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  const specJson = JSON.stringify({
    schema_version: 1,
    diagram_type: "architecture",
    meta: { title: "Alpha Service", output: "alpha.html" },
    components: [
      { id: "web", type: "frontend", label: "Web" },
      { id: "api", type: "backend", label: "API" },
    ],
    connections: [{ from: "web", to: "api", label: "HTTPS" }],
  });

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.documentElement.dataset.theme = "light";
    container = document.createElement("div");
    document.body.appendChild(container);
    mocks.listArchitectureBlueprints.mockResolvedValue([blueprint("dev", "alpha", "alpha", "Alpha Service")]);
    mocks.architectureReadSiblingSpec.mockResolvedValue({
      specJson,
      title: "Alpha Service",
      submodule: "dev/alpha",
      commit: "abc123",
    });
    mocks.listDiagrams.mockResolvedValue([{ name: "Alpha Service" }]);
    mocks.writeDiagram.mockReset();
    mocks.writeDiagram.mockImplementation(async (_root: string, _name: string, doc: unknown) => doc);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    container.remove();
  });

  async function render(onOpenDiagram?: (name: string) => void, copyWorkspacePath?: string): Promise<void> {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <LocaleContext.Provider value={{ locale: "en", setLocale: () => {}, t }}>
          <ArchitecturePane workspacePath="/work" copyWorkspacePath={copyWorkspacePath} onOpenDiagram={onOpenDiagram} />
        </LocaleContext.Provider>,
      );
    });
  }

  it("writes a new workspace diagram with provenance and opens it", async () => {
    const opened: string[] = [];
    await render((name) => opened.push(name));

    const button = container.querySelector<HTMLButtonElement>('[data-testid="architecture-copy-to-diagram"]');
    expect(button).not.toBeNull();
    await act(async () => {
      button!.click();
    });

    // "Alpha Service" exists already, so the copy takes a suffixed name.
    expect(mocks.writeDiagram).toHaveBeenCalledTimes(1);
    const [root_, name, doc] = mocks.writeDiagram.mock.calls[0] as [string, string, {
      docTitle: string;
      datasets?: { kind: string; provenance?: { origin?: string; repository?: string } }[];
      nodes: unknown[];
      edges: unknown[];
    }];
    expect(root_).toBe("/work");
    expect(name).toBe("Alpha Service-2");
    expect(doc.docTitle).toBe("Alpha Service");
    expect(doc.datasets?.[0]?.kind).toBe("semanticSpec");
    expect(doc.datasets?.[0]?.provenance?.origin).toBe("gallery-copy");
    expect(doc.datasets?.[0]?.provenance?.repository).toBe("dev/alpha");
    expect(doc.nodes.length).toBe(2);
    expect(doc.edges.length).toBe(1);
    expect(opened).toEqual(["Alpha Service-2"]);
  });

  it("creates the copy in the Diagram workspace while retaining gallery source provenance", async () => {
    await render(() => {}, "/diagram-workspace");
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="architecture-copy-to-diagram"]')!.click());
    expect(mocks.listDiagrams).toHaveBeenCalledWith("/diagram-workspace");
    expect(mocks.writeDiagram.mock.calls[0][0]).toBe("/diagram-workspace");
    expect(mocks.architectureReadSiblingSpec).toHaveBeenCalledWith("/work", "/work/dev/alpha/docs/alpha-rendered.html");
  });

  it("retries a name raced by another creator using create-only writes", async () => {
    mocks.writeDiagram.mockRejectedValueOnce(new IpcError({ code: "document_conflict", message: "exists" }));
    const opened: string[] = [];
    await render((name) => opened.push(name));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="architecture-copy-to-diagram"]')!.click());
    expect(mocks.writeDiagram.mock.calls.map((call) => call[1])).toEqual(["Alpha Service-2", "Alpha Service-3"]);
    expect(mocks.writeDiagram.mock.calls.every((call) => (call as unknown[])[3] === "")).toBe(true);
    expect(opened).toEqual(["Alpha Service-3"]);
  });

  it("hides the action when the sibling spec is missing or unsupported", async () => {
    mocks.architectureReadSiblingSpec.mockRejectedValue(new Error("Sibling spec not found"));
    const opened: string[] = [];
    await render((name) => opened.push(name));
    expect(container.querySelector('[data-testid="architecture-copy-to-diagram"]')).toBeNull();
    expect(opened).toEqual([]);
  });

  it("does not offer the action without a handoff channel", async () => {
    await render();
    expect(container.querySelector('[data-testid="architecture-copy-to-diagram"]')).toBeNull();
  });
});
