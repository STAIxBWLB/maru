import { describe, expect, it } from "vitest";

import { matchesShortcut } from "./shortcuts";

function key(opts: { key: string; meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean }): KeyboardEvent {
  // Build a plain object that satisfies the subset of KeyboardEvent we read.
  return {
    key: opts.key,
    metaKey: opts.meta ?? false,
    ctrlKey: opts.ctrl ?? false,
    shiftKey: opts.shift ?? false,
    altKey: opts.alt ?? false,
  } as KeyboardEvent;
}

describe("shortcuts", () => {
  it("matchesShortcut requires modifier when combo demands", () => {
    expect(matchesShortcut(key({ key: "s", meta: true }), { key: "s", mod: true })).toBe(true);
    expect(matchesShortcut(key({ key: "s" }), { key: "s", mod: true })).toBe(false);
  });

  it("matchesShortcut rejects bare key when modifier present", () => {
    expect(matchesShortcut(key({ key: "f", meta: true }), { key: "f" })).toBe(false);
  });

  it("matchesShortcut respects shift requirement", () => {
    expect(matchesShortcut(key({ key: "z", meta: true, shift: true }), { key: "z", mod: true, shift: true })).toBe(true);
    expect(matchesShortcut(key({ key: "z", meta: true }), { key: "z", mod: true, shift: true })).toBe(false);
  });

  it("matchesShortcut case-insensitive on key", () => {
    expect(matchesShortcut(key({ key: "S", meta: true }), { key: "s", mod: true })).toBe(true);
  });
});
