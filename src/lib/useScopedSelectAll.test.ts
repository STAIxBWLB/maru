import { describe, expect, it } from "vitest";
import { isEditableTarget, selectAllComboPressed } from "./useScopedSelectAll";

type ComboEvent = Parameters<typeof selectAllComboPressed>[0];

function combo(overrides: Partial<ComboEvent>): ComboEvent {
  return {
    key: "a",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  };
}

describe("selectAllComboPressed", () => {
  it("matches Cmd+A on macOS and Ctrl+A elsewhere", () => {
    expect(selectAllComboPressed(combo({ metaKey: true }), true)).toBe(true);
    expect(selectAllComboPressed(combo({ ctrlKey: true }), false)).toBe(true);
  });

  it("ignores the wrong modifier for the platform", () => {
    expect(selectAllComboPressed(combo({ ctrlKey: true }), true)).toBe(false);
    expect(selectAllComboPressed(combo({ metaKey: true }), false)).toBe(false);
  });

  it("requires no shift/alt and the 'a' key", () => {
    expect(selectAllComboPressed(combo({ metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(selectAllComboPressed(combo({ metaKey: true, altKey: true }), true)).toBe(false);
    expect(selectAllComboPressed(combo({ metaKey: true, key: "s" }), true)).toBe(false);
    expect(selectAllComboPressed(combo({ metaKey: true, key: "A" }), true)).toBe(true);
  });
});

describe("isEditableTarget", () => {
  const asTarget = (o: unknown) => o as unknown as EventTarget;

  it("treats inputs, textareas and contentEditable as editable", () => {
    expect(isEditableTarget(asTarget({ tagName: "INPUT" }))).toBe(true);
    expect(isEditableTarget(asTarget({ tagName: "TEXTAREA" }))).toBe(true);
    expect(isEditableTarget(asTarget({ tagName: "DIV", isContentEditable: true }))).toBe(true);
  });

  it("treats other elements and null as non-editable", () => {
    expect(isEditableTarget(asTarget({ tagName: "DIV" }))).toBe(false);
    expect(isEditableTarget(asTarget({ tagName: "BUTTON" }))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});
