/**
 * Pure evaluation of a decoded macOS provisioning profile for the opt-in
 * browser-passkey build. Kept free of `security`/`plutil`/`openssl` so the
 * rules can be exercised without an Apple-approved profile.
 *
 * Apple facts this encodes:
 * - Managed-capability entitlements "may only be assigned for a subset of
 *   distribution options such as development or ad-hoc", so a Development
 *   profile is a realistic outcome of an approved request and must be named
 *   as such rather than surfacing later as a certificate mismatch.
 * - A Developer ID provisioning profile is evaluated at install time and at
 *   every app launch; if it expires, the app no longer launches at all.
 * - Developer ID profiles issued after 2017-02-22 are valid 18 years, so a
 *   short remaining window is itself evidence of the wrong profile type.
 */

export const PASSKEY_ENTITLEMENT = "com.apple.developer.web-browser.public-key-credential";

/** Below this, the shipped app would stop launching within weeks. */
export const MIN_PROFILE_DAYS = 30;
/** Below this, the profile is almost certainly not a Developer ID profile. */
export const WARN_PROFILE_DAYS = 365;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {object} profile
 * @param {{ expectedBundleId?: string, appleTeamId?: string | null, now?: number }} [options]
 */
export function evaluateProvisioningProfile(
  profile,
  { expectedBundleId, appleTeamId = null, now = Date.now() } = {},
) {
  const errors = [];
  const warnings = [];
  const successes = [];
  const entitlements = profile?.Entitlements ?? {};

  if (entitlements[PASSKEY_ENTITLEMENT] === true) {
    successes.push("provisioning profile contains the managed passkey entitlement");
  } else {
    errors.push("provisioning profile does not contain the managed passkey entitlement");
  }

  // Developer ID profiles provision every device and never allow debugging.
  // A Development/ad-hoc profile carries ProvisionedDevices and get-task-allow.
  const developerIdShape =
    profile?.ProvisionsAllDevices === true &&
    !Array.isArray(profile?.ProvisionedDevices) &&
    entitlements["get-task-allow"] !== true;
  if (developerIdShape) {
    successes.push("provisioning profile has the Developer ID distribution shape");
  } else {
    errors.push(
      "provisioning profile is not a Developer ID profile (expected ProvisionsAllDevices, " +
        "no ProvisionedDevices, and get-task-allow disabled). Apple may have assigned the " +
        "managed capability for development or ad-hoc only; if so, do not enable the " +
        "passkey overlay and keep the Safari fallback",
    );
  }

  const expiration = new Date(profile?.ExpirationDate ?? "");
  const expiresAt = expiration.getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    errors.push("provisioning profile is expired or has no valid ExpirationDate");
  } else {
    const remainingDays = Math.floor((expiresAt - now) / DAY_MS);
    if (remainingDays < MIN_PROFILE_DAYS) {
      errors.push(
        `provisioning profile expires in ${remainingDays} day(s); the app stops launching ` +
          `once it expires, so at least ${MIN_PROFILE_DAYS} days are required`,
      );
    } else {
      if (remainingDays < WARN_PROFILE_DAYS) {
        warnings.push(
          `provisioning profile expires in ${remainingDays} day(s); Developer ID profiles ` +
            "are normally valid 18 years, so verify this is not a development profile",
        );
      }
      successes.push(`provisioning profile is valid until ${expiration.toISOString()}`);
    }
  }

  const teamIdentifiers = Array.isArray(profile?.TeamIdentifier) ? profile.TeamIdentifier : [];
  const entitlementTeam = entitlements["com.apple.developer.team-identifier"];
  const teamIdentifier = entitlementTeam ?? teamIdentifiers[0];
  let resolvedTeam = null;
  if (typeof teamIdentifier !== "string" || !teamIdentifiers.includes(teamIdentifier)) {
    errors.push("provisioning profile TeamIdentifier and entitlement team identifier do not match");
  } else if (entitlements["com.apple.application-identifier"] !== `${teamIdentifier}.${expectedBundleId}`) {
    errors.push(
      `provisioning profile com.apple.application-identifier must be ${teamIdentifier}.${expectedBundleId}`,
    );
  } else if (appleTeamId && appleTeamId !== teamIdentifier) {
    errors.push(`APPLE_TEAM_ID does not match provisioning profile team ${teamIdentifier}`);
  } else {
    resolvedTeam = teamIdentifier;
    successes.push(`provisioning profile matches team ${teamIdentifier} and ${expectedBundleId}`);
  }

  return { errors, warnings, successes, teamIdentifier: resolvedTeam };
}
