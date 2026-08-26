import { beforeEach, describe, expect, it } from "vitest";

import {
  acknowledgeDocumentReveal,
  getDocumentBrowserSlice,
  publishDocumentBrowser,
  requestDocumentReveal,
  resetDocumentBrowserStoreForTests,
  type DocumentBrowserScope,
} from "./documentBrowserStore";

const scope: DocumentBrowserScope = {
  workspacePath: "/tmp/workspace",
  visibility: "private",
};

describe("documentBrowserStore", () => {
  beforeEach(() => {
    resetDocumentBrowserStoreForTests();
  });

  it("preserves unrelated slice identity when publishing a query", () => {
    publishDocumentBrowser(scope, {
      query: "before",
      selectedPath: "/tmp/workspace/one.md",
      publicWorkspaceAvailable: true,
      favorites: [],
      selectedFileQueueCount: 0,
    });
    const selected = getDocumentBrowserSlice(scope, "selection");
    const capabilities = getDocumentBrowserSlice(scope, "capabilities");
    const favorites = getDocumentBrowserSlice(scope, "favorites");
    const queue = getDocumentBrowserSlice(scope, "fileQueue");
    const reveal = getDocumentBrowserSlice(scope, "reveal");

    publishDocumentBrowser(scope, { query: "after" });

    expect(getDocumentBrowserSlice(scope, "queryFilter").query).toBe("after");
    expect(getDocumentBrowserSlice(scope, "selection")).toBe(selected);
    expect(getDocumentBrowserSlice(scope, "capabilities")).toBe(capabilities);
    expect(getDocumentBrowserSlice(scope, "favorites")).toBe(favorites);
    expect(getDocumentBrowserSlice(scope, "fileQueue")).toBe(queue);
    expect(getDocumentBrowserSlice(scope, "reveal")).toBe(reveal);
  });

  it("distinguishes and safely acknowledges repeated reveal requests", () => {
    const first = requestDocumentReveal(scope, "/tmp/workspace/one.md");
    const second = requestDocumentReveal(scope, "/tmp/workspace/one.md");

    expect(second.nonce).toBeGreaterThan(first.nonce);
    expect(acknowledgeDocumentReveal(scope, first.nonce)).toBe(false);
    expect(getDocumentBrowserSlice(scope, "reveal").intent).toEqual(second);
    expect(acknowledgeDocumentReveal(scope, second.nonce)).toBe(true);
    expect(getDocumentBrowserSlice(scope, "reveal").intent).toBeNull();
  });
});
