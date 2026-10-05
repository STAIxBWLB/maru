import type { MaruAppMode } from "./settings";

/**
 * Apple grants `com.apple.developer.web-browser.public-key-credential` only to
 * apps that, on launch, present "a text field for entering URLs, search tools
 * for finding links, or curated bookmark lists". Maru's Sites surface is that
 * screen — URL bar plus the saved-sites registry — so the provisioned
 * browser-passkey build always starts there.
 *
 * This never touches persisted settings: the default build and the passkey
 * build share `~/.maru/settings.json`, and the stored mode must survive
 * launching either one.
 */
export function bootAppMode(input: {
  storedMode: MaruAppMode;
  browserPasskeyBuild: boolean;
}): MaruAppMode {
  return input.browserPasskeyBuild ? "sites" : input.storedMode;
}

/**
 * A mode the user picked can race the boot-time stored-mode applications
 * (boot, settings hydration, settings-save echo): before the workspace
 * settings are writable the pick lives only in memory, and every stored-mode
 * application would revert it (#387). While a pick is pending in the ref it
 * wins over the stored mode; once the stored settings catch up — the pick
 * reached the disk and echoed back — the guard lifts after boot by clearing
 * the ref. During boot even a matching hydration/save echo must retain the
 * explicit pick, because the pending Today route has not settled yet.
 */
export function applyStoredAppMode(
  userPickRef: { current: MaruAppMode | null },
  storedMode: MaruAppMode,
  booting = false,
): MaruAppMode {
  if (!booting && userPickRef.current === storedMode) {
    userPickRef.current = null;
    return storedMode;
  }
  return userPickRef.current ?? storedMode;
}
