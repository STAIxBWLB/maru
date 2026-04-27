// Anchor i18n — ko-KR and en-US are equal first-class locales.
//
// Rules:
// - Every UI string lives here. Never hard-code Korean or English in
//   components.
// - When adding/changing a key, update BOTH `ko` and `en` simultaneously.
//   The lint script (scripts/lint-i18n.ts, Phase 0) fails CI if any key
//   is missing in either locale.
// - Use `useTranslation()` in React components, or `t(locale, key)` in
//   plain TS. Variable interpolation: `{name}` placeholders.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

export type Locale = "ko" | "en";

export const LOCALES: Locale[] = ["ko", "en"];

const STORAGE_KEY = "anchor:locale:v1";

const ko: Record<string, string> = {
  "app.title": "Anchor",
  "app.subtitle.work": "로컬 우선 마크다운 볼트",
  "app.subtitle.note": "파일 원천 · 깨지지 않는 frontmatter · 다중 볼트",
  "app.locale.ko": "KO",
  "app.locale.en": "EN",
  "app.locale.label": "언어",
  "app.refresh": "볼트 다시 읽기",
  "app.confirmUnsaved": "저장하지 않은 변경이 있습니다. 다른 문서를 열까요?",
  "app.errorClose": "닫기",

  "vault.current": "현재 볼트",
  "vault.add": "볼트 추가",
  "vault.remove": "볼트 제거",
  "vault.remove.label": "{label} 볼트 제거",
  "vault.remove.confirm": "이 볼트를 목록에서 제거할까요?",
  "vault.choose": "선택",
  "vault.useSample": "샘플 볼트 열기",
  "vault.switcher.empty": "볼트 선택",
  "vault.switcher.none": "등록된 볼트가 없습니다",
  "vault.empty.title": "등록된 볼트가 없습니다",
  "vault.empty.description":
    "디렉토리를 선택해 첫 번째 볼트를 등록하거나 샘플 볼트로 시작할 수 있습니다.",
  "vault.empty.cta": "볼트 추가",
  "vault.empty.sample": "샘플 사용",
  "vault.dialog.title": "볼트 추가",
  "vault.dialog.description":
    "마크다운 파일이 포함된 폴더를 선택해 anchor에서 열 수 있도록 등록합니다.",
  "vault.dialog.label": "표시 이름",
  "vault.dialog.path": "폴더 경로",
  "vault.dialog.pickPath": "폴더 선택...",
  "vault.dialog.externalWriter": "쓰기 위임 (선택)",
  "vault.dialog.externalWriter.help":
    "Obsidian 등 외부 앱이 이 폴더를 관리하는 경우 표시. anchor 는 읽기만 합니다.",
  "vault.dialog.externalWriter.none": "없음 (anchor 가 직접 쓰기)",
  "vault.dialog.externalWriter.obsidian": "Obsidian (MCP 위임, Phase 2)",
  "vault.dialog.cancel": "취소",
  "vault.dialog.confirm": "추가",
  "vault.dialog.error.label": "이름을 입력하세요.",
  "vault.dialog.error.path": "경로를 선택하세요.",

  "sidebar.commandPalette": "명령 팔레트",
  "sidebar.types": "문서 타입",
  "sidebar.types.all": "전체",
  "sidebar.types.untyped": "타입 없음",
  "sidebar.recent": "최근 문서",
  "sidebar.recent.empty": "아직 열어본 문서가 없습니다.",

  "list.title": "문서",
  "list.searchPlaceholder": "제목, 본문 검색",
  "list.loading": "문서 목록 로딩",
  "list.empty.title": "표시할 문서가 없습니다",
  "list.empty.description": "샘플 볼트를 열거나 새 문서를 만들어 시작하세요.",
  "list.meta.words": "{count} 단어",
  "list.meta.versions": "{count} 버전",
  "list.meta.count": "{count} 건",
  "list.group.today": "오늘",
  "list.group.thisWeek": "이번 주",
  "list.group.earlier": "이전",

  "editor.empty.title": "문서를 선택하세요",
  "editor.empty.description":
    "왼쪽 목록에서 문서를 열면 편집과 미리보기가 같은 화면에 배치됩니다.",
  "editor.dirty": "저장 필요",
  "editor.saved": "저장됨",
  "editor.save": "저장",
  "editor.saving": "저장 중",
  "editor.snapshot": "스냅샷",
  "editor.tab.edit": "원문",
  "editor.tab.preview": "미리보기",
  "editor.status.lines": "{count} 줄",
  "editor.status.words": "{count} 단어",
  "editor.status.chars": "{count} 자",

  "outline.title": "문서 개요",
  "outline.open": "개요 열기",
  "outline.close": "개요 닫기",
  "outline.empty": "이 문서에는 제목(#) 헤딩이 없습니다.",
  "outline.empty.noDocument": "문서를 선택하면 개요가 표시됩니다.",
  "outline.meta.created": "생성",
  "outline.meta.updated": "수정",

  "cmdk.placeholder": "문서 또는 명령 검색...",
  "cmdk.empty": "결과가 없습니다.",
  "cmdk.openHint": "⌘K 로 명령 팔레트를 엽니다",
  "cmdk.section.commands": "명령",
  "cmdk.section.documents": "문서",
  "cmdk.action.newDocument": "새 문서 만들기",
  "cmdk.action.save": "현재 문서 저장",
  "cmdk.action.snapshot": "버전 스냅샷 만들기",
  "cmdk.action.togglePreview": "미리보기 토글",
  "cmdk.action.toggleOutline": "개요 패널 토글",
  "cmdk.action.toggleLocale": "한국어/English 전환",
  "cmdk.action.refresh": "볼트 다시 읽기",
  "cmdk.action.addVault": "볼트 추가",

  "newDoc.button": "새 문서",
  "newDoc.dialog.title": "새 Anchor 문서",
  "newDoc.dialog.description":
    "표준 frontmatter (type, status, created_at, updated_at, id) 가 포함된 마크다운 문서를 볼트 루트에 만듭니다.",
  "newDoc.field.title": "제목",
  "newDoc.field.title.placeholder": "예: 2분기 운영위원회 보고",
  "newDoc.field.type": "타입",
  "newDoc.field.type.placeholder": "예: meeting, project, reference",
  "newDoc.field.body": "초기 본문",
  "newDoc.field.body.helper": "비워두면 제목만 포함된 문서가 생성됩니다.",
  "newDoc.cancel": "취소",
  "newDoc.create": "생성",
  "newDoc.creating": "생성 중",
  "newDoc.error.title": "제목을 입력하세요.",
  "newDoc.error.type": "타입을 입력하세요.",

  "snapshot.summary": "사용자 요청으로 생성한 편집 스냅샷",
  "snapshot.success": "스냅샷 저장됨: {path}",

  "footer.tagline": "로컬 우선 · 파일 원천 · ko/en",
};

const en: Record<string, string> = {
  "app.title": "Anchor",
  "app.subtitle.work": "Local-first markdown vault",
  "app.subtitle.note": "Files-as-truth · resilient frontmatter · multi-vault",
  "app.locale.ko": "KO",
  "app.locale.en": "EN",
  "app.locale.label": "Language",
  "app.refresh": "Reload vault",
  "app.confirmUnsaved": "You have unsaved changes. Open a different document?",
  "app.errorClose": "Close",

  "vault.current": "Current vault",
  "vault.add": "Add vault",
  "vault.remove": "Remove vault",
  "vault.remove.label": "Remove {label} vault",
  "vault.remove.confirm": "Remove this vault from the list?",
  "vault.choose": "Choose",
  "vault.useSample": "Open sample vault",
  "vault.switcher.empty": "Choose vault",
  "vault.switcher.none": "No vaults registered",
  "vault.empty.title": "No vaults registered",
  "vault.empty.description":
    "Pick a folder to register your first vault, or start with the sample vault.",
  "vault.empty.cta": "Add vault",
  "vault.empty.sample": "Use sample",
  "vault.dialog.title": "Add vault",
  "vault.dialog.description":
    "Register a folder containing markdown files so anchor can open it.",
  "vault.dialog.label": "Display name",
  "vault.dialog.path": "Folder path",
  "vault.dialog.pickPath": "Pick folder…",
  "vault.dialog.externalWriter": "Write delegation (optional)",
  "vault.dialog.externalWriter.help":
    "Set if another app (e.g. Obsidian) owns this folder. anchor will read but not write.",
  "vault.dialog.externalWriter.none": "None (anchor writes directly)",
  "vault.dialog.externalWriter.obsidian": "Obsidian (MCP delegation, Phase 2)",
  "vault.dialog.cancel": "Cancel",
  "vault.dialog.confirm": "Add",
  "vault.dialog.error.label": "Display name is required.",
  "vault.dialog.error.path": "Folder path is required.",

  "sidebar.commandPalette": "Command palette",
  "sidebar.types": "Document types",
  "sidebar.types.all": "All documents",
  "sidebar.types.untyped": "Untyped",
  "sidebar.recent": "Recent",
  "sidebar.recent.empty": "No recently opened documents.",

  "list.title": "Documents",
  "list.searchPlaceholder": "Search titles or contents",
  "list.loading": "Loading documents",
  "list.empty.title": "No documents to show",
  "list.empty.description": "Open the sample vault or create a new document to get started.",
  "list.meta.words": "{count} words",
  "list.meta.versions": "{count} versions",
  "list.meta.count": "{count} items",
  "list.group.today": "Today",
  "list.group.thisWeek": "This week",
  "list.group.earlier": "Earlier",

  "editor.empty.title": "Select a document",
  "editor.empty.description":
    "Open a note from the list to view and edit it side-by-side with a preview.",
  "editor.dirty": "Unsaved",
  "editor.saved": "Saved",
  "editor.save": "Save",
  "editor.saving": "Saving",
  "editor.snapshot": "Snapshot",
  "editor.tab.edit": "Source",
  "editor.tab.preview": "Preview",
  "editor.status.lines": "{count} lines",
  "editor.status.words": "{count} words",
  "editor.status.chars": "{count} chars",

  "outline.title": "Outline",
  "outline.open": "Show outline",
  "outline.close": "Hide outline",
  "outline.empty": "This document has no headings yet.",
  "outline.empty.noDocument": "Open a document to see its outline.",
  "outline.meta.created": "created",
  "outline.meta.updated": "updated",

  "cmdk.placeholder": "Search documents or commands…",
  "cmdk.empty": "No results.",
  "cmdk.openHint": "⌘K opens the command palette",
  "cmdk.section.commands": "Commands",
  "cmdk.section.documents": "Documents",
  "cmdk.action.newDocument": "Create new document",
  "cmdk.action.save": "Save current document",
  "cmdk.action.snapshot": "Create version snapshot",
  "cmdk.action.togglePreview": "Toggle preview",
  "cmdk.action.toggleOutline": "Toggle outline panel",
  "cmdk.action.toggleLocale": "Switch ko / en",
  "cmdk.action.refresh": "Reload vault",
  "cmdk.action.addVault": "Add vault",

  "newDoc.button": "New document",
  "newDoc.dialog.title": "New Anchor document",
  "newDoc.dialog.description":
    "Creates a markdown file at the vault root with standard frontmatter (type, status, created_at, updated_at, id).",
  "newDoc.field.title": "Title",
  "newDoc.field.title.placeholder": "e.g. 2026 Q2 ops review",
  "newDoc.field.type": "Type",
  "newDoc.field.type.placeholder": "e.g. meeting, project, reference",
  "newDoc.field.body": "Initial body",
  "newDoc.field.body.helper": "Leave empty to create a title-only document.",
  "newDoc.cancel": "Cancel",
  "newDoc.create": "Create",
  "newDoc.creating": "Creating",
  "newDoc.error.title": "Title is required.",
  "newDoc.error.type": "Type is required.",

  "snapshot.summary": "User-requested editing snapshot",
  "snapshot.success": "Snapshot saved: {path}",

  "footer.tagline": "Local-first · files-as-truth · ko/en",
};

const dictionaries: Record<Locale, Record<string, string>> = { ko, en };

/** Translate `key` for the given locale, with optional `{var}` interpolation.
 *  Returns the key itself if missing — useful as a development signal that a
 *  translation has not been authored yet. */
export function t(
  locale: Locale,
  key: string,
  vars: Record<string, string | number> = {},
): string {
  const dict = dictionaries[locale] ?? dictionaries.en;
  let template = dict[key];
  if (template === undefined) {
    // eslint-disable-next-line no-console
    console.warn(`[i18n] missing key "${key}" for locale "${locale}"`);
    return key;
  }
  for (const [name, value] of Object.entries(vars)) {
    template = template.replace(new RegExp(`\\{${name}\\}`, "g"), String(value));
  }
  return template;
}

/** Detect missing keys at module load — fail loudly if ko/en drift. */
export function assertParityOrThrow(): void {
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

export function useLocaleState() {
  const [locale, setLocaleState] = useState<Locale>(detectInitialLocale);
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, locale);
    document.documentElement.lang = locale === "ko" ? "ko-KR" : "en-US";
  }, [locale]);
  const setLocale = useCallback((next: Locale) => setLocaleState(next), []);
  const translate = useCallback(
    (key: string, vars?: Record<string, string | number>) => t(locale, key, vars),
    [locale],
  );
  return useMemo(
    () => ({ locale, setLocale, t: translate }),
    [locale, setLocale, translate],
  );
}

export function useTranslation(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) {
    throw new Error("useTranslation must be used inside <LocaleContext.Provider>");
  }
  return ctx;
}
