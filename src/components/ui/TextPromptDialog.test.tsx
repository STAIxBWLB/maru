// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { LocaleContext, t as translate } from "../../lib/i18n";
import { useTextPrompt } from "./TextPromptDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let askText: ((message: string, defaultValue?: string) => Promise<string | null>) | null = null;

function Harness() {
  const prompt = useTextPrompt();
  askText = prompt.askText;
  return prompt.dialog;
}

async function openPrompt(): Promise<{ input: HTMLInputElement; answer: Promise<string | null> }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <LocaleContext.Provider
        value={{ locale: "ko", setLocale: () => {}, t: (key, vars) => translate("ko", key, vars) }}
      >
        <Harness />
      </LocaleContext.Provider>,
    );
  });
  let answer!: Promise<string | null>;
  await act(async () => {
    answer = askText!("이름", "초안");
  });
  const input = document.querySelector<HTMLInputElement>(".dialog-content input")!;
  return { input, answer };
}

function keydown(target: EventTarget, init: KeyboardEventInit & { keyCode?: number }): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  if (init.keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: init.keyCode });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
});

describe("useTextPrompt IME handling (#384 review)", () => {
  it("keeps the Enter that commits a composition from submitting the field", async () => {
    const { input } = await openPrompt();
    expect(keydown(input, { key: "Enter", isComposing: true }).defaultPrevented).toBe(true);
    expect(keydown(input, { key: "Enter", keyCode: 229 }).defaultPrevented).toBe(true);
    expect(keydown(input, { key: "Enter" }).defaultPrevented).toBe(false);
  });

  it("keeps the field open on an Escape that ends a composition, and closes it on a plain Escape", async () => {
    const { input, answer } = await openPrompt();
    keydown(input, { key: "Escape", keyCode: 229 });
    expect(document.querySelector(".dialog-content")).not.toBeNull();
    keydown(input, { key: "Escape" });
    await act(async () => {
      await Promise.resolve();
    });
    await expect(answer).resolves.toBeNull();
  });
});
