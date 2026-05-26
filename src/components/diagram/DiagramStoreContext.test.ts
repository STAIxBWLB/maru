import { afterEach, describe, expect, it } from "vitest";

import {
  _resetDiagramSessionForTests,
  _resetDiagramSharedStoreForTests,
  getDiagramSession,
  setDiagramSession,
} from "./DiagramStoreContext";

describe("DiagramStoreContext workspace sessions", () => {
  afterEach(() => {
    _resetDiagramSessionForTests();
    _resetDiagramSharedStoreForTests();
  });

  it("keeps active filenames isolated by workspace key", () => {
    setDiagramSession({ activeName: "alpha", lastSavedBody: "{\"docTitle\":\"A\"}" }, "/w/a");
    setDiagramSession({ activeName: "beta", lastSavedBody: "{\"docTitle\":\"B\"}" }, "/w/b");

    expect(getDiagramSession("/w/a")).toMatchObject({
      activeName: "alpha",
      lastSavedBody: "{\"docTitle\":\"A\"}",
    });
    expect(getDiagramSession("/w/b")).toMatchObject({
      activeName: "beta",
      lastSavedBody: "{\"docTitle\":\"B\"}",
    });
    expect(getDiagramSession("/w/c")).toMatchObject({
      activeName: null,
      lastSavedBody: null,
    });
  });
});
