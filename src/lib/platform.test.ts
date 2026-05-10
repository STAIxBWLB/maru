import { describe, expect, it } from "vitest";
import { isMacPlatform } from "./platform";

describe("isMacPlatform", () => {
  it("detects macOS platform strings", () => {
    expect(isMacPlatform("MacIntel")).toBe(true);
    expect(isMacPlatform("macOS")).toBe(true);
  });

  it("rejects non-macOS platform strings", () => {
    expect(isMacPlatform("Win32")).toBe(false);
    expect(isMacPlatform("Linux x86_64")).toBe(false);
    expect(isMacPlatform("")).toBe(false);
    expect(isMacPlatform(null)).toBe(false);
  });
});
