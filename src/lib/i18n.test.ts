import { describe, expect, it } from "vitest";
import { assertNoLegacyVaultWording, assertParityOrThrow, t } from "./i18n";

describe("i18n", () => {
  it("keeps Korean and English dictionaries in parity", () => {
    expect(() => assertParityOrThrow()).not.toThrow();
  });

  it("keeps visible legacy vault wording out of translations", () => {
    expect(() => assertNoLegacyVaultWording()).not.toThrow();
  });

  it("interpolates variables and returns missing keys as development signals", () => {
    expect(t("en", "snapshot.success", { path: "notes/a.md" })).toBe(
      "Snapshot saved: notes/a.md",
    );
    expect(t("ko", "missing.key")).toBe("missing.key");
  });

  it("keeps Comms provider status strings localized", () => {
    expect(t("ko", "comms.telegram.login")).toBe("로그인");
    expect(t("ko", "comms.migration.loaded")).toBe("로드됨");
    expect(t("en", "comms.telegram.unknownChat")).toBe("Telegram chat");
  });

  it("treats interpolated values literally without regex replacement tokens", () => {
    expect(t("en", "snapshot.success", { path: "$& — $1" })).toBe(
      "Snapshot saved: $& — $1",
    );
  });

  it("localizes skill install-mode and sync-all strings in both locales", () => {
    expect(t("ko", "system.skills.installMode.copy")).toBe("복사");
    expect(t("en", "system.skills.installMode.copy")).toBe("Copy");
    expect(t("ko", "system.skills.syncAll")).toBe("전체 동기화");
    expect(t("en", "system.skills.syncAll")).toBe("Sync all");
    expect(t("en", "system.skills.neverSynced")).toBe("Never synced");
    expect(t("en", "system.skills.syncAllComplete", { succeeded: 2, failed: 1 })).toBe(
      "Sync all complete: 2 ok, 1 failed",
    );
    expect(t("en", "system.skills.installConfirm", { count: 1, target: "Claude", mode: "Copy" })).toBe(
      "Proceed with 1 Claude install task(s) (Copy)?",
    );
  });
});
