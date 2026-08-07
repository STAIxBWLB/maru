// Test-only helper: registers both locale dictionaries synchronously so
// specs can call `t()` / render `useTranslation` consumers without
// awaiting `loadLocale`. Import for side effects:
//
//   import "../lib/i18n/testing";
//
// Never import this from production code — it statically bundles both
// dictionaries, which is exactly what the lazy split avoids.
import { registerDictionaries } from "../i18n";
import { en } from "./locales/en";
import { ko } from "./locales/ko";

registerDictionaries({ ko, en });
