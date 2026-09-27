// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  binaryViewerExtractHwpx: vi.fn(),
  siteViewOpenExternal: vi.fn(async () => undefined),
}));

vi.mock("../../lib/api", () => ({
  binaryViewerExtractHwpx: mocks.binaryViewerExtractHwpx,
}));

vi.mock("../../lib/siteView", () => ({
  siteViewOpenExternal: mocks.siteViewOpenExternal,
}));

import { HwpxViewer } from "./HwpxViewer";
import { LocaleContext } from "../../lib/i18n";
import type { WorkspaceFileEntry } from "../../lib/types";

const t = (key: string) => key;

const entry: WorkspaceFileEntry = {
  path: "/workspace/report.hwpx",
  relPath: "report.hwpx",
  name: "report.hwpx",
  extension: "hwpx",
  fileKind: "hwpx",
  sizeBytes: 10,
  updatedAt: null,
  gitTracked: false,
  binary: true,
};

describe("HwpxViewer link handling", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    container = document.createElement("div");
    document.body.appendChild(container);
    mocks.siteViewOpenExternal.mockClear();
    mocks.binaryViewerExtractHwpx.mockResolvedValue({
      html: '<p>본문 <a href="https://example.com/report">참고</a> ' +
        '<a href="mailto:dev@example.com">메일</a></p>',
      sections: 1,
      warnings: [],
    });
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container.remove();
  });

  async function renderViewer(): Promise<void> {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <LocaleContext.Provider value={{ locale: "en", setLocale: () => {}, t }}>
          <HwpxViewer
            entry={entry}
            workspacePath="/workspace"
            onPreviewExternal={() => {}}
            onOpenExternal={() => {}}
          />
        </LocaleContext.Provider>,
      );
    });
  }

  it("opens an http(s) link in the system browser instead of navigating", async () => {
    await renderViewer();
    const anchor = container.querySelector<HTMLAnchorElement>('a[href^="https://"]');
    expect(anchor).toBeInstanceOf(HTMLAnchorElement);

    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    anchor!.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(mocks.siteViewOpenExternal).toHaveBeenCalledTimes(1);
    expect(mocks.siteViewOpenExternal).toHaveBeenCalledWith("https://example.com/report");
  });

  it("swallows non-http(s) links without opening anything", async () => {
    await renderViewer();
    const anchor = container.querySelector<HTMLAnchorElement>('a[href^="mailto:"]');
    expect(anchor).toBeInstanceOf(HTMLAnchorElement);

    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    anchor!.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(mocks.siteViewOpenExternal).not.toHaveBeenCalled();
  });
});
