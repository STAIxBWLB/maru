// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useKeyboardShortcuts, type ShortcutMap } from "./useKeyboardShortcuts";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root | null;

function Fixture({ shortcuts }: { shortcuts: ShortcutMap }) {
  useKeyboardShortcuts(shortcuts, [shortcuts]);
  return <input aria-label="Focused control" />;
}
beforeEach(() => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container.remove();
  vi.restoreAllMocks();
});
async function render(shortcuts: ShortcutMap) {
  await act(async () => root!.render(<Fixture shortcuts={shortcuts} />));
}
function press(init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  container.querySelector("input")!.dispatchEvent(event);
  return event;
}

it("reloads once for physical Cmd+R with a Korean input source before a control consumes the key", async () => {
  const reload = vi.fn();
  await render({ "mod+r": reload });
  const consume = vi.fn((event: Event) => event.stopPropagation());
  container.querySelector("input")!.addEventListener("keydown", consume);
  const event = press({ key: "ㄱ", code: "KeyR", metaKey: true });
  expect(reload).toHaveBeenCalledTimes(1);
  expect(consume).not.toHaveBeenCalled();
  expect(event.defaultPrevented).toBe(true);
});
it("supports Cmd+R events without a physical code and prevents page reload", async () => {
  const reload = vi.fn();
  await render({ "mod+r": reload });
  expect(press({ key: "r", metaKey: true }).defaultPrevented).toBe(true);
  expect(reload).toHaveBeenCalledTimes(1);
});
it("handles a document-targeted Cmd+R without requiring a focused element", async () => {
  const reload = vi.fn();
  await render({ "mod+r": reload });
  const event = new KeyboardEvent("keydown", { key: "r", code: "KeyR", metaKey: true, bubbles: true, cancelable: true });
  document.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(reload).toHaveBeenCalledTimes(1);
});
it("retains bubbling ownership for other shortcuts", async () => {
  const save = vi.fn();
  await render({ "mod+s": save });
  container.querySelector("input")!.addEventListener("keydown", (event) => event.stopPropagation());
  expect(press({ key: "s", code: "KeyS", metaKey: true }).defaultPrevented).toBe(false);
  expect(save).not.toHaveBeenCalled();
});
it("leaves ordinary typing and alternate modifier chords alone", async () => {
  const reload = vi.fn();
  await render({ "mod+r": reload });
  for (const init of [
    { key: "r", code: "KeyR" },
    { key: "r", code: "KeyR", ctrlKey: true },
    { key: "R", code: "KeyR", metaKey: true, shiftKey: true },
    { key: "r", code: "KeyR", metaKey: true, altKey: true },
  ]) expect(press(init).defaultPrevented).toBe(false);
  expect(reload).not.toHaveBeenCalled();
});
it("keeps Ctrl+R routing on other platforms", async () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  const reload = vi.fn();
  await render({ "mod+r": reload });
  expect(press({ key: "r", ctrlKey: true }).defaultPrevented).toBe(true);
  expect(reload).toHaveBeenCalledTimes(1);
});
it("updates the callback and removes both listeners on unmount", async () => {
  const first = vi.fn();
  const latest = vi.fn();
  await render({ "mod+r": first });
  await render({ "mod+r": latest });
  press({ key: "r", metaKey: true });
  expect(first).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledTimes(1);
  await act(async () => root!.unmount());
  root = null;
  const event = new KeyboardEvent("keydown", { key: "r", metaKey: true, bubbles: true, cancelable: true });
  document.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  expect(latest).toHaveBeenCalledTimes(1);
});
