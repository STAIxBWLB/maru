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
