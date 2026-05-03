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
});
