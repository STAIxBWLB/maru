// @vitest-environment jsdom

import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useActiveSection } from "./useActiveSection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  callback: IntersectionObserverCallback;
  observed: Element[] = [];

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    FakeIntersectionObserver.instances.push(this);
  }

  observe(el: Element) {
    this.observed.push(el);
  }

  unobserve() {}
  disconnect() {}

  trigger(entries: Array<Partial<IntersectionObserverEntry>>) {
    this.callback(entries as IntersectionObserverEntry[], this as unknown as IntersectionObserver);
  }
}

function Probe({ rootRef }: { rootRef: React.RefObject<HTMLDivElement | null> }) {
  const { activeId, select } = useActiveSection(["a", "b", "c"], rootRef);
  return (
    <div>
      <span data-testid="active">{activeId}</span>
      <button type="button" data-testid="select-b" onClick={() => select("b")}>
        b
      </button>
    </div>
  );
}

function Harness() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  return (
    <div ref={rootRef}>
      <section data-today-section="a">
        <button type="button" data-testid="focus-a">
          a
        </button>
      </section>
      <section data-today-section="b">
        <button type="button" data-testid="focus-b">
          b
        </button>
      </section>
      <section data-today-section="c">
        <button type="button" data-testid="focus-c">
          c
        </button>
      </section>
      <Probe rootRef={rootRef} />
    </div>
  );
}

async function renderHarness() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Harness />);
  });
  return container;
}

function activeId(container: HTMLElement): string {
  return container.querySelector('[data-testid="active"]')!.textContent ?? "";
}

describe("useActiveSection", () => {
  beforeEach(() => {
    FakeIntersectionObserver.instances = [];
    Element.prototype.scrollIntoView = vi.fn();
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
      FakeIntersectionObserver;
  });

  afterEach(() => {
    delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
    document.body.innerHTML = "";
  });

  it("starts on the first step and observes all sections", async () => {
    const container = await renderHarness();
    expect(activeId(container)).toBe("a");
    expect(FakeIntersectionObserver.instances).toHaveLength(1);
    expect(FakeIntersectionObserver.instances[0].observed).toHaveLength(3);
  });

  it("follows the most-visible intersecting section", async () => {
    const container = await renderHarness();
    const observer = FakeIntersectionObserver.instances[0];
    const sectionB = container.querySelector('[data-today-section="b"]')!;
    await act(async () => {
      observer.trigger([{ isIntersecting: true, intersectionRatio: 0.6, target: sectionB }]);
    });
    expect(activeId(container)).toBe("b");
  });

  it("follows focus into a section", async () => {
    const container = await renderHarness();
    const focusC = container.querySelector('[data-testid="focus-c"]')!;
    await act(async () => {
      focusC.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    expect(activeId(container)).toBe("c");
  });

  it("select() activates the step and scrolls its section into view", async () => {
    const container = await renderHarness();
    const selectB = container.querySelector<HTMLButtonElement>('[data-testid="select-b"]')!;
    await act(async () => {
      selectB.click();
    });
    expect(activeId(container)).toBe("b");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });
});
