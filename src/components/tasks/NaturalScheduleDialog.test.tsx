// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocaleContext, t as translate } from "../../lib/i18n";
import { parseKoreanDate } from "../../lib/koreanDate";
import { NaturalScheduleDialog } from "./NaturalScheduleDialog";

vi.mock("../../lib/koreanDate", () => ({
  parseKoreanDate: vi.fn(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("NaturalScheduleDialog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("reparses the current text on submit instead of sending a stale preview", async () => {
    vi.mocked(parseKoreanDate).mockImplementation(async (input) =>
      input.startsWith("내일") ? "2026-07-19T09:00:00+09:00" : "2026-07-24T09:00:00+09:00",
    );
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <LocaleContext.Provider
          value={{
            locale: "ko",
            setLocale: () => {},
            t: (key, vars) => translate("ko", key, vars),
          }}
        >
          <NaturalScheduleDialog open onClose={() => {}} onSubmit={onSubmit} />
        </LocaleContext.Provider>,
      );
    });

    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      setTextareaValue(textarea, "내일 회의");
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(parseKoreanDate).toHaveBeenLastCalledWith("내일 회의");

    // Change the phrase and submit before the second 300 ms preview debounce.
    await act(async () => {
      setTextareaValue(textarea, "다음 주 금요일 회의");
    });
    const submit = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === translate("ko", "tasks.natural.submit"),
    )!;
    await act(async () => {
      submit.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(parseKoreanDate).toHaveBeenLastCalledWith("다음 주 금요일 회의");
    expect(onSubmit).toHaveBeenCalledWith(
      "다음 주 금요일 회의",
      "2026-07-24T09:00:00+09:00",
    );

    await act(async () => {
      root.unmount();
    });
  });
});
