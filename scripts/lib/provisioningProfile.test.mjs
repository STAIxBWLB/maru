import { describe, expect, it } from "vitest";
import {
  evaluateProvisioningProfile,
  MIN_PROFILE_DAYS,
  PASSKEY_ENTITLEMENT,
  WARN_PROFILE_DAYS,
} from "./provisioningProfile.mjs";

const NOW = Date.UTC(2026, 0, 1);
const DAY = 24 * 60 * 60 * 1000;
const BUNDLE_ID = "kr.maru.desktop";
const TEAM = "ABCDE12345";

function profile(overrides = {}) {
  const { Entitlements, ...rest } = overrides;
  return {
    ProvisionsAllDevices: true,
    TeamIdentifier: [TEAM],
    // Developer ID profiles are issued with 18 years of validity.
    ExpirationDate: new Date(NOW + 18 * 365 * DAY).toISOString(),
    Entitlements: {
      [PASSKEY_ENTITLEMENT]: true,
      "get-task-allow": false,
      "com.apple.developer.team-identifier": TEAM,
      "com.apple.application-identifier": `${TEAM}.${BUNDLE_ID}`,
      ...Entitlements,
    },
    ...rest,
  };
}

function evaluate(overrides, options = {}) {
  return evaluateProvisioningProfile(profile(overrides), {
    expectedBundleId: BUNDLE_ID,
    now: NOW,
    ...options,
  });
}

describe("evaluateProvisioningProfile", () => {
  it("accepts a Developer ID profile carrying the managed capability", () => {
    const result = evaluate();
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.teamIdentifier).toBe(TEAM);
  });

  it("rejects a Development profile instead of blaming the certificate", () => {
    const result = evaluate({
      ProvisionsAllDevices: false,
      ProvisionedDevices: ["00008103-000000000000001E"],
      Entitlements: { "get-task-allow": true },
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("not a Developer ID profile");
    expect(result.errors[0]).toContain("development or ad-hoc only");
  });

  it("rejects each Developer ID shape signal on its own", () => {
    for (const overrides of [
      { ProvisionsAllDevices: false },
      { ProvisionedDevices: [] },
      { Entitlements: { "get-task-allow": true } },
    ]) {
      expect(evaluate(overrides).errors.join(" ")).toContain("not a Developer ID profile");
    }
  });

  it("fails a profile that expires before the minimum window", () => {
    const result = evaluate({
      ExpirationDate: new Date(NOW + (MIN_PROFILE_DAYS - 20) * DAY).toISOString(),
    });
    expect(result.errors.join(" ")).toContain("stops launching");
    expect(result.warnings).toEqual([]);
  });

  it("warns on a short but usable window without failing", () => {
    const result = evaluate({
      ExpirationDate: new Date(NOW + (WARN_PROFILE_DAYS - 265) * DAY).toISOString(),
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings.join(" ")).toContain("valid 18 years");
  });

  it("fails an expired or unparseable expiration date", () => {
    expect(evaluate({ ExpirationDate: new Date(NOW - DAY).toISOString() }).errors.join(" ")).toContain(
      "expired or has no valid ExpirationDate",
    );
    expect(evaluate({ ExpirationDate: undefined }).errors.join(" ")).toContain(
      "expired or has no valid ExpirationDate",
    );
  });

  it("fails a missing or disabled passkey entitlement", () => {
    expect(evaluate({ Entitlements: { [PASSKEY_ENTITLEMENT]: undefined } }).errors.join(" ")).toContain(
      "does not contain the managed passkey entitlement",
    );
  });

  it("fails a profile issued for another bundle identifier", () => {
    const result = evaluate({
      Entitlements: { "com.apple.application-identifier": `${TEAM}.kr.maru.other` },
    });
    expect(result.errors.join(" ")).toContain(`must be ${TEAM}.${BUNDLE_ID}`);
    expect(result.teamIdentifier).toBeNull();
  });

  it("fails when APPLE_TEAM_ID contradicts the profile", () => {
    const result = evaluate({}, { appleTeamId: "ZZZZZ99999" });
    expect(result.errors.join(" ")).toContain("APPLE_TEAM_ID does not match");
  });

  it("fails when the entitlement team is absent from TeamIdentifier", () => {
    const result = evaluate({ TeamIdentifier: ["OTHER00000"] });
    expect(result.errors.join(" ")).toContain("TeamIdentifier and entitlement team identifier do not match");
  });
});
