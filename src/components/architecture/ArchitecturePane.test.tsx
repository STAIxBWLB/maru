// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listArchitectureBlueprints: vi.fn(),
  prepareArchitectureBlueprint: vi.fn(async (_root: string, path: string) => path),
  openInFileManager: vi.fn(async () => undefined),
}));

vi.mock("../../lib/api", () => mocks);

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
