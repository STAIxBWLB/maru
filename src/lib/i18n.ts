// Maru i18n — ko-KR and en-US are equal first-class locales.
//
// Rules:
// - Every UI string lives in `i18n/locales/ko.ts` / `i18n/locales/en.ts`.
//   Never hard-code Korean or English in components.
// - When adding/changing a key, update BOTH `ko` and `en` simultaneously.
//   `pnpm lint:i18n` (scripts/lint-i18n.mjs, wired into `make verify` / CI)
//   fails on key parity drift and on hardcoded UI strings in src/**/*.tsx.
// - Dictionaries are lazy chunks (they are ~400 KB raw and used to be the
//   largest entry-bundle item). `useLocaleState` awaits `loadLocale()` for
//   the active locale and exposes `ready`; provider sites gate their tree
//   on it so `t()` below can stay synchronous.
// - Use `useTranslation()` in React components, or `t(locale, key)` in
//   plain TS. Variable interpolation: `{name}` placeholders.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

export type Locale = "ko" | "en";

export const LOCALES: Locale[] = ["ko", "en"];

const STORAGE_KEY = "maru:locale:v1";

type Dictionary = Record<string, string>;

const dictionaries: Partial<Record<Locale, Dictionary>> = {};
const localeLoads: Partial<Record<Locale, Promise<void>>> = {};

/** Load a locale dictionary into the registry. Idempotent — concurrent
 *  callers share one dynamic import. */
export function loadLocale(locale: Locale): Promise<void> {
  if (dictionaries[locale]) return Promise.resolve();
  localeLoads[locale] ??= (async () => {
    if (locale === "ko") {
      dictionaries.ko = (await import("./i18n/locales/ko")).ko;
    } else {
      dictionaries.en = (await import("./i18n/locales/en")).en;
    }
  })().catch((err: unknown) => {
    // Never cache a rejection: a transient chunk-load failure must stay
    // retryable, or every later loadLocale() call fails forever.
    delete localeLoads[locale];
    throw err;
  });
  return localeLoads[locale];
}

/** Test support: pre-populate dictionaries synchronously so specs can call
 *  `t()` without awaiting `loadLocale`. See `src/lib/i18n/testing.ts`. */
export function registerDictionaries(entries: Partial<Record<Locale, Dictionary>>): void {
  Object.assign(dictionaries, entries);
}

/** Translate `key` for the given locale, with optional `{var}` interpolation.
 *  Returns the key itself if missing — useful as a development signal that a
 *  translation has not been authored yet. Requires the locale to be loaded
 *  (see `loadLocale`); an unloaded locale warns and returns the key. */
export function t(
  locale: Locale,
  key: string,
  vars: Record<string, string | number> = {},
): string {
  const dict = dictionaries[locale] ?? dictionaries.en;
  let template = dict?.[key];
  if (template === undefined) {
    console.warn(`[i18n] missing key "${key}" for locale "${locale}"`);
    return key;
  }
  for (const [name, value] of Object.entries(vars)) {
    template = template.split(`{${name}}`).join(String(value));
  }
  return template;
}

/** Detect missing keys — fail loudly if ko/en drift. Parity is enforced in
 *  CI by `pnpm lint:i18n`; this stays as the vitest-level guard. */
export async function assertParityOrThrow(): Promise<void> {
  const [{ ko }, { en }] = await Promise.all([
    import("./i18n/locales/ko"),
    import("./i18n/locales/en"),
  ]);
  const koKeys = new Set(Object.keys(ko));
  const enKeys = new Set(Object.keys(en));
  const missingInEn = [...koKeys].filter((k) => !enKeys.has(k));
  const missingInKo = [...enKeys].filter((k) => !koKeys.has(k));
  if (missingInEn.length > 0 || missingInKo.length > 0) {
    throw new Error(
      `[i18n] locale parity broken — missing in en: ${missingInEn.join(", ")}; missing in ko: ${missingInKo.join(", ")}`,
    );
  }
}

export async function assertNoLegacyVaultWording(): Promise<void> {
  const offenders: string[] = [];
  for (const locale of LOCALES) {
    await loadLocale(locale);
    const dict = dictionaries[locale] ?? {};
    for (const [key, value] of Object.entries(dict)) {
      if (/\bvault\b/i.test(value) || value.includes("볼트")) {
        offenders.push(`${locale}.${key}`);
      }
    }
  }
  if (offenders.length > 0) {
    throw new Error(`[i18n] legacy vault wording remains in: ${offenders.join(", ")}`);
  }
}

interface LocaleContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

export const LocaleContext = createContext<LocaleContextValue | null>(null);

function detectInitialLocale(): Locale {
  if (typeof window === "undefined") return "ko";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "ko" || stored === "en") return stored;
  const browser = window.navigator.language.toLowerCase();
  if (browser.startsWith("ko")) return "ko";
  // Fall back to ko since the primary user is Korean — env detection
  // will still respect explicit en preference once the user toggles.
  return "ko";
}

export interface LocaleState {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  /** True once the active locale's dictionary is loaded. Provider sites
   *  should gate their tree on this so UI never renders raw keys. */
  ready: boolean;
}

export function useLocaleState(): LocaleState {
  const [locale, setLocaleState] = useState<Locale>(detectInitialLocale);
  const [ready, setReady] = useState<boolean>(() => dictionaries[locale] !== undefined);
  useEffect(() => {
    if (ready) return;
    let cancelled = false;
    void loadLocale(locale)
      .catch(() => loadLocale(locale))
      .catch((err: unknown) => {
        console.error(`[i18n] failed to load locale "${locale}"`, err);
        // Fall through to ready: rendering raw keys beats a window that
        // stays blank forever behind the `ready` gate.
      })
      .then(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [locale, ready]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, locale);
    document.documentElement.lang = locale === "ko" ? "ko-KR" : "en-US";
  }, [locale]);
  // Load-then-switch: the current locale keeps rendering until the new
  // dictionary is registered, so switching never flashes raw keys either.
  // The token makes rapid toggles last-write-wins instead of
  // completion-order-wins (ko -> en -> ko must settle on ko).
  const localeRequestRef = useRef(0);
  const setLocale = useCallback((next: Locale) => {
    const token = ++localeRequestRef.current;
    void loadLocale(next)
      .then(() => {
        if (localeRequestRef.current === token) setLocaleState(next);
      })
      .catch(() => {
        // Keep the current locale; loadLocale stays retryable on failure.
      });
  }, []);
  const translate = useCallback(
    (key: string, vars?: Record<string, string | number>) => t(locale, key, vars),
    // `ready` is a dep on purpose: t()'s result changes when the dictionary
    // registers, so memoized consumers of `t` must recompute after load.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- translate's body doesn't read `ready` directly, but consumers memoized on this callback need to re-run once the dictionary loads
    [locale, ready],
  );
  return useMemo(
    () => ({ locale, setLocale, t: translate, ready }),
    [locale, setLocale, translate, ready],
  );
}

export function useTranslation(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) {
    throw new Error("useTranslation must be used inside <LocaleContext.Provider>");
  }
  return ctx;
}
