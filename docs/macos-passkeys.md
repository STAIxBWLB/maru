# macOS browser passkeys

Operator runbook for the opt-in, fail-closed browser-passkey build: request →
approval → provisioning profile → build → notarize.

The default Maru build is unaffected. It carries no managed entitlement and no
HTTP/HTTPS browser-role metadata, and the runtime returns `unsupported` before
touching Apple's API, so everything below applies only to the separate
provisioned build.

## 1. What this enables

`com.apple.developer.web-browser.public-key-credential` (Boolean, macOS 13.3+ /
Mac Catalyst 16.3+) lets an app make passkey and security-key registration and
assertion requests for **any** relying party. It is what allows passkeys stored
in Apple Passwords (and other providers that plug into Authentication
Services) to be used inside Maru's Sites webview, the same mechanism Chrome and Firefox
use on macOS.

Apple's guidance: *"Only add this entitlement if your app can act as a user's
web browser."*

## 2. Eligibility and request

- You must hold the **Account Holder** role on an organization's Apple Developer
  account. Individual accounts and other roles cannot submit.
- Submit the request at
  <https://developer.apple.com/contact/request/macos-browsers-passkeys/>
  (Apple ID sign-in required).
- Apple reviews each application against fixed criteria (§3). If approved, the
  entitlement is added to the developer account as a **managed capability**.

## 3. Apple's criteria, and how Maru answers each

| Apple's criterion | Maru |
|---|---|
| Specifies HTTP and HTTPS schemes in `Info.plist` | `src-tauri/Info.passkeys.plist` declares `CFBundleURLSchemes = [http, https]` |
| On launch, provides a URL text field, search tools, or curated bookmark lists | The provisioned build boots into the Sites surface: URL bar plus the saved-sites registry. See `bootAppMode` in `src/lib/startupAppMode.ts` |
| Opening an HTTP/HTTPS URL navigates directly to the destination, no unexpected redirect | `RunEvent::Opened` → http/https filter (`src-tauri/src/site_view.rs`) → new Sites tab at that exact URL |
| May operate in a parental-controls/locked-down mode | Not implemented; optional |
| May present Safe Browsing warnings | Not implemented; optional |
| May offer native authentication UI | Not implemented; optional |

Be honest in the submission: **the launch-surface criterion is met only by the
provisioned overlay build.** The default Maru build starts in Docs mode.

## 4. After approval

1. Enable the managed capability on the **explicit** App ID `kr.maru.desktop`.
   Wildcard App IDs are not eligible for managed capabilities.
2. Create a **Developer ID** provisioning profile for that App ID, bound to the
   Developer ID Application certificate on the build machine.
3. Verify before using it:

   ```bash
   security cms -D -i /path/to/Maru.provisionprofile
   ```

   Confirm `ProvisionsAllDevices` is `true`, there is **no** `ProvisionedDevices`
   array, `get-task-allow` is not `true`, and `Entitlements` contains
   `com.apple.developer.web-browser.public-key-credential`.

> **Stop condition.** Apple states that managed-capability entitlements *"may
> only be assigned for a subset of distribution options such as development or
> ad-hoc."* If the capability is not offered for Developer ID distribution, do
> not enable the overlay. Keep the system-browser (Safari) fallback that ships
> today. `make macos-passkey-readiness-check` detects this case and says so
> explicitly rather than failing on a certificate mismatch.

## 5. Build and notarize

```bash
export MARU_MACOS_PROVISIONING_PROFILE=/absolute/path/to/Maru.provisionprofile
export APPLE_SIGNING_IDENTITY='Developer ID Application: Example (TEAMID)'
export APPLE_TEAM_ID=TEAMID

make macos-passkey-readiness-check     # validates every prerequisite, changes nothing
make macos-passkey-notarized-build     # build + sign + notarize + staple
```

`make macos-passkey-build` stops after signing and prints a warning that the
artifact is **not** notarized and therefore not distributable. Use it only for
local verification.

Notarization reads App Store Connect API credentials from
`~/workspace/work/.maru/secrets/apple` (override with `MARU_APPLE_SECRETS_DIR`):
`AuthKey_<APPLE_API_KEY_ID>.p8`, `api-issuer-id`, and optionally `api-key-id`.
These are the same credentials `make macos-notarize-local` uses.

Every prerequisite is checked before anything is built, and every check fails
closed. The staged copy of the profile at `src-tauri/Passkeys.provisionprofile`
is gitignored, written `0600`, and removed after the build.

## 6. Operational facts that bite later

- A Developer ID provisioning profile is evaluated **at install time and at
  every app launch**. If it expires, *"the app will no longer launch"*, not
  just passkeys, the whole app. The readiness check fails below 30 days
  remaining and warns below one year.
- Developer ID profiles issued after 2017-02-22 are valid for **18 years**,
  independent of the certificate's own expiry. A short remaining window is
  itself evidence that a development profile was supplied by mistake.
- A Developer ID certificate that was valid when the app was compiled keeps
  working after it expires; the profile is the part that must stay valid.
- Notarization is mandatory for distribution outside the App Store.
- **CI never builds this overlay.** `.github/workflows/release-bundles.yml`
  always uses the default `tauri.conf.json`, so no published release asset
  contains the entitlement. Distribution of a passkey build is a deliberate,
  local, manual act.

## 7. Deliberately not requested

- `com.apple.developer.web-browser`: the default-browser role. A separate
  approval Maru does not need for passkeys.
- `com.apple.developer.browser.app-installation`: alternative app
  distribution. Not applicable.

Do not add either to `src-tauri/Entitlements.plist`; the passkey request is
reviewed against what the app actually does.

## 8. Failure behaviour

If the entitlement is absent, revoked, or the profile is invalid, the runtime's
`SecTaskCopyValueForEntitlement` check fails and
`browser_passkey_status` returns `unsupported`. The Sites pane then offers
"Open in Safari" for the current page, which launches `com.apple.Safari` by
bundle id so a Maru registered as the default HTTP handler cannot recursively
reopen itself.

## Sources

- [`com.apple.developer.web-browser.public-key-credential`](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.web-browser.public-key-credential)
- [Provisioning with managed capabilities](https://developer.apple.com/help/account/reference/provisioning-with-managed-capabilities)
- [Developer ID support](https://developer.apple.com/support/developer-id/)
