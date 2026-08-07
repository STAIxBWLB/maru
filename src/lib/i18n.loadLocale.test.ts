import { describe, expect, it, vi } from "vitest";

describe("loadLocale failure recovery", () => {
  it("does not cache a rejected chunk load — a retry re-imports", async () => {
    vi.resetModules();
    let failNext = true;
    vi.doMock("./i18n/locales/en", () => {
      if (failNext) throw new Error("chunk load failed");
      return { en: { "probe.key": "Probe" } };
    });

    const { loadLocale, t } = await import("./i18n");

    await expect(loadLocale("en")).rejects.toThrow();

    failNext = false;
    await expect(loadLocale("en")).resolves.toBeUndefined();
    expect(t("en", "probe.key")).toBe("Probe");

    vi.doUnmock("./i18n/locales/en");
    vi.resetModules();
  });
});
