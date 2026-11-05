// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { siteViewOpenExternal } from "../../lib/siteView";
import { KakaoRelayConsole } from "./KakaoRelayConsole";

vi.mock("../../lib/siteView", () => ({ siteViewOpenExternal: vi.fn() }));
vi.mock("../../lib/i18n", () => ({
  useTranslation: () => ({ t: (key: string, vars?: Record<string, string>) => `${key} ${vars?.error ?? ""}` }),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.resetAllMocks();
});

async function render(url: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<KakaoRelayConsole relayUiUrl={url} themeMode="dark" />));
  return container;
}

describe("relay console browser handoff", () => {
  it("opens only on an explicit click with the initial theme and no iframe", async () => {
    vi.mocked(siteViewOpenExternal).mockResolvedValue(undefined);
    const container = await render("https://relay.example/ui?session=existing");
    expect(container.querySelector("iframe")).toBeNull();
    expect(siteViewOpenExternal).not.toHaveBeenCalled();
    await act(async () => container.querySelector("button")!.click());
    expect(siteViewOpenExternal).toHaveBeenCalledExactlyOnceWith("https://relay.example/ui?session=existing&theme=dark");
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("does not hand off an invalid URL", async () => {
    const container = await render("file:///etc/passwd");
    expect(container.querySelector("button")!.disabled).toBe(true);
    expect(container.textContent).toContain("comms.kakao.console.invalidUrl");
    expect(siteViewOpenExternal).not.toHaveBeenCalled();
  });

  it("surfaces browser failures and keeps retry available", async () => {
    vi.mocked(siteViewOpenExternal).mockRejectedValueOnce(new Error("browser unavailable")).mockResolvedValueOnce(undefined);
    const container = await render("http://relay.local:8787/");
    await act(async () => container.querySelector("button")!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("browser unavailable");
    await act(async () => container.querySelector("button")!.click());
    expect(siteViewOpenExternal).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
  });
});
