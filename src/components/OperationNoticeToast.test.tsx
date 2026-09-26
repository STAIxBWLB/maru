// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openInFileManager: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  openInFileManager: mocks.openInFileManager,
}));

import { OperationNoticeToast } from "./OperationNoticeToast";
import {
  clearError,
  dismissOperationNotice,
  getOperationNotice,
  publishOperationNotice,
  useError,
  type OperationNotice,
} from "../lib/errorStore";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const t = (key: string) => key;

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `toast-test:${idCounter}`;
}

function notice(patch: Partial<OperationNotice> = {}): OperationNotice {
  return {
    operationId: nextId(),
    kind: "error",
    message: "Could not save memo.md: disk full. A recovery copy was kept.",
    ...patch,
  };
}

function ErrorProbe({ onValue }: { onValue: (value: string | null) => void }) {
  onValue(useError());
  return null;
}

describe("OperationNoticeToast", () => {
  let container: HTMLDivElement;
  let root: Root | null;
  let seenErrors: (string | null)[];

  beforeEach(() => {
    vi.clearAllMocks();
    clearError();
    seenErrors = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    root = null;
  });

  async function render(n: OperationNotice) {
    await act(async () => {
      root?.render(
        createElement(
          "div",
          null,
          createElement(OperationNoticeToast, { notice: n, t }),
          createElement(ErrorProbe, { onValue: (value) => seenErrors.push(value) }),
        ),
      );
    });
  }

  function findOpenButton(): HTMLButtonElement | undefined {
    return Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("save.teardown.openCopy"),
    );
  }

  it("renders the message and a close button", async () => {
    await render(notice());
    expect(container.textContent).toContain(
      "Could not save memo.md: disk full. A recovery copy was kept.",
    );
    expect(container.querySelector('[aria-label="app.errorClose"]')).toBeTruthy();
  });

  it("renders an Open recovery copy button only when the notice carries a recovery", async () => {
    await render(notice({ recovery: { workPath: "/work", path: ".maru/recovery/x.md" } }));
    expect(findOpenButton()).toBeTruthy();
  });

  it("renders no Open recovery copy button without a recovery", async () => {
    await render(notice());
    expect(findOpenButton()).toBeUndefined();
  });

  it("opens the recovery copy once and dismisses the notice", async () => {
    mocks.openInFileManager.mockResolvedValue(undefined);
    const n = notice({ recovery: { workPath: "/work", path: ".maru/recovery/x.md" } });
    publishOperationNotice(n);
    await render(n);

    await act(async () => findOpenButton()?.click());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.openInFileManager).toHaveBeenCalledTimes(1);
    expect(mocks.openInFileManager).toHaveBeenCalledWith("/work", ".maru/recovery/x.md");
    expect(getOperationNotice()).toBeNull();
  });

  it("raises setError with the rejection message and still dismisses", async () => {
    mocks.openInFileManager.mockRejectedValue(new Error("no default app"));
    const n = notice({ recovery: { workPath: "/work", path: ".maru/recovery/x.md" } });
    publishOperationNotice(n);
    await render(n);

    await act(async () => findOpenButton()?.click());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getOperationNotice()).toBeNull();
    expect(seenErrors.at(-1)).toBe("no default app");
  });

  afterEach(() => {
    // Belt-and-suspenders: never leave a dangling notice for the next test
    // in this file (module-level queue is a shared singleton).
    const remaining = getOperationNotice();
    if (remaining) dismissOperationNotice(remaining.operationId);
  });
});
