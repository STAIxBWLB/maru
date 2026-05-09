import { describe, expect, it } from "vitest";
import {
  firstPendingInboxKey,
  nextInboxFocusKey,
  toggleInboxSelectionKeys,
} from "../lib/inbox";

describe("inbox keyboard helpers", () => {
  const keys = ["file:a", "file:b", "gmail:c", "gmail:d"];

  it("finds the first pending row across file and gmail keys", () => {
    expect(
      firstPendingInboxKey([
        { key: "file:a", decision: "accepted" },
        { key: "gmail:c", decision: "pending" },
      ]),
    ).toBe("gmail:c");
  });

  it("moves focus with clamped arrow navigation", () => {
    expect(nextInboxFocusKey(keys, null, 1)).toBe("file:a");
    expect(nextInboxFocusKey(keys, "file:a", 1)).toBe("file:b");
    expect(nextInboxFocusKey(keys, "gmail:d", 1)).toBe("gmail:d");
    expect(nextInboxFocusKey(keys, "file:a", -1)).toBe("file:a");
  });

  it("toggles command-click style selection", () => {
    const selected = toggleInboxSelectionKeys(keys, new Set(), "file:b", null, false);
    expect([...selected]).toEqual(["file:b"]);
    expect([...toggleInboxSelectionKeys(keys, selected, "file:b", "file:b", false)]).toEqual([]);
  });

  it("adds a shift range without dropping existing selections", () => {
    const selected = toggleInboxSelectionKeys(
      keys,
      new Set(["file:a"]),
      "gmail:d",
      "file:b",
      true,
    );
    expect([...selected]).toEqual(["file:a", "file:b", "gmail:c", "gmail:d"]);
  });
});
