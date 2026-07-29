// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_INBOX_RUNTIME_CONFIG } from "../../lib/api";
import { LocaleContext, t as translate } from "../../lib/i18n";
import { DEFAULT_MARU_SETTINGS } from "../../lib/settings";
import { CommsSettingsTab } from "./CommsSettingsTab";
import { SourceControls } from "./SourceControls";
import { SourceHeaderCard } from "./SourceHeaderCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${label}`);
  }
  return button;
}

async function render(element: ReactNode) {
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
        {element}
      </LocaleContext.Provider>,
    );
  });
  return { container, root };
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("M365 reauth readiness controls", () => {
  it("disables only M365 reauth while workspace config is pending", async () => {
    const onRefresh = vi.fn();
    const onReauth = vi.fn();
    const { container, root } = await render(
      <SourceControls
        channel="mso"
        onRefresh={onRefresh}
        onReauth={onReauth}
        msoReauthDisabled
      />,
    );

    const msoReauth = findButton(container, translate("ko", "comms.auth.reauth"));
    expect(msoReauth.disabled).toBe(true);
    await act(async () => {
      msoReauth.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onReauth).not.toHaveBeenCalled();
    expect(findButton(container, translate("ko", "comms.source.refresh")).disabled).toBe(
      false,
    );

    await act(async () => {
      root.render(
        <LocaleContext.Provider
          value={{
            locale: "ko",
            setLocale: () => {},
            t: (key, vars) => translate("ko", key, vars),
          }}
        >
          <SourceControls
            channel="gws"
            onRefresh={onRefresh}
            onReauth={onReauth}
            msoReauthDisabled
          />
        </LocaleContext.Provider>,
      );
    });
    expect(findButton(container, translate("ko", "comms.auth.reauth")).disabled).toBe(false);

    await act(async () => {
      root.render(
        <LocaleContext.Provider
          value={{
            locale: "ko",
            setLocale: () => {},
            t: (key, vars) => translate("ko", key, vars),
          }}
        >
          <SourceControls
            channel="telegram"
            onRefresh={onRefresh}
            onReauth={onReauth}
            msoReauthDisabled
          />
        </LocaleContext.Provider>,
      );
    });
    expect(findButton(container, translate("ko", "comms.telegram.login")).disabled).toBe(
      false,
    );

    await act(async () => root.unmount());
  });

  it("keeps Settings GWS reauth enabled while M365 config is pending", async () => {
    const { container, root } = await render(
      <CommsSettingsTab
        settings={DEFAULT_MARU_SETTINGS.comms}
        gmailSettings={DEFAULT_INBOX_RUNTIME_CONFIG.gmail}
        onSettingsChange={vi.fn()}
        onGmailSettingsChange={vi.fn()}
        onGwsReauth={vi.fn()}
        onMsoReauth={vi.fn()}
        msoReauthDisabled
      />,
    );

    expect(findButton(container, translate("ko", "comms.gws.reauth")).disabled).toBe(false);
    const msoReauth = findButton(container, translate("ko", "comms.outlook.reauth"));
    expect(msoReauth.disabled).toBe(true);

    await act(async () => root.unmount());
  });

  it("native-disables Outlook Process Now while other source actions remain enabled", async () => {
    const onProcessNow = vi.fn();
    const { container, root } = await render(
      <SourceHeaderCard
        channel="mso"
        run={null}
        running={false}
        processedCount={0}
        actionBusy={false}
        processDisabled
        onProcessNow={onProcessNow}
      />,
    );

    const processButton = findButton(
      container,
      translate("ko", "comms.source.processNow"),
    );
    expect(processButton.disabled).toBe(true);
    await act(async () => {
      processButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onProcessNow).not.toHaveBeenCalled();

    await act(async () => {
      root.render(
        <LocaleContext.Provider
          value={{
            locale: "ko",
            setLocale: () => {},
            t: (key, vars) => translate("ko", key, vars),
          }}
        >
          <SourceHeaderCard
            channel="gws"
            run={null}
            running={false}
            processedCount={0}
            actionBusy={false}
            onProcessNow={onProcessNow}
          />
        </LocaleContext.Provider>,
      );
    });
    expect(findButton(container, translate("ko", "comms.source.processNow")).disabled).toBe(
      false,
    );

    await act(async () => root.unmount());
  });
});
