// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  siteViewOpenExternal: vi.fn(async () => undefined),
}));

vi.mock("./siteView", () => ({
  siteViewOpenExternal: mocks.siteViewOpenExternal,
}));

import { interceptPreviewLinkClick } from "./previewLinks";

describe("interceptPreviewLinkClick", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mocks.siteViewOpenExternal.mockClear();
  });

  afterEach(() => {
    container.remove();
  });

  function click(target: Element): MouseEvent {
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  }

  it("opens http(s) links in the system browser instead of navigating", () => {
    container.innerHTML = '<p>see <a href="https://example.com/docs">docs</a></p>';
    container.addEventListener("click", interceptPreviewLinkClick);

    const event = click(container.querySelector("a")!);

    expect(event.defaultPrevented).toBe(true);
    expect(mocks.siteViewOpenExternal).toHaveBeenCalledTimes(1);
    expect(mocks.siteViewOpenExternal).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("resolves the anchor from a nested click target", () => {
    container.innerHTML = '<a href="http://example.com"><span>nested</span></a>';
    container.addEventListener("click", interceptPreviewLinkClick);

    const event = click(container.querySelector("span")!);

    expect(event.defaultPrevented).toBe(true);
    expect(mocks.siteViewOpenExternal).toHaveBeenCalledWith("http://example.com");
  });

  it("swallows non-http(s) schemes without opening anything", () => {
    container.innerHTML =
      '<a href="mailto:dev@example.com">mail</a><a href="file:///etc/passwd">file</a>' +
      '<a href="#anchor">jump</a><a href="relative/page.md">rel</a>';
    container.addEventListener("click", interceptPreviewLinkClick);

    for (const anchor of container.querySelectorAll("a")) {
      const event = click(anchor);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(mocks.siteViewOpenExternal).not.toHaveBeenCalled();
  });

  it("ignores clicks outside anchors", () => {
    container.innerHTML = "<p>plain text</p>";
    container.addEventListener("click", interceptPreviewLinkClick);

    const event = click(container.querySelector("p")!);

    expect(event.defaultPrevented).toBe(false);
    expect(mocks.siteViewOpenExternal).not.toHaveBeenCalled();
  });
});
