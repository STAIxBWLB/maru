// Thin wrappers around the Rust commands that own layered settings plus
// `<work>/.maru/` workspace resources (workspace registration + System mode).
// Mirrors the pattern in `api.ts`:
// browser-dev fallbacks return inert no-ops so the React layer can be
// exercised without the Tauri shell.

import { invoke } from "@tauri-apps/api/core";
import type {
  MaruWorkspaceMeta,
  MaruWorkspaceMetaPatch,
  ProjectPickerEntry,
  RegisterWorkspaceOutcome,
  RuleDocument,
  RuleEntry,
  SecretTextDocument,
  SecretsMigrationReport,
  SecretsScanReport,
  TemplateEntry,
  WorkspaceConfig,
  WorkspaceDetect,
  WorkspaceRegistry,
  WorkspaceRootEntry,
  WorkspaceSummary,
} from "./types";
import {
  DEFAULT_MARU_SETTINGS,
  normalizeMaruSettings,
  serializeMaruSettings,
  type MaruSettings,
} from "./settings";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

const isTauri = () =>
  typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);

const SETTINGS_FALLBACK_KEY = "maru:settings:fallback:v1";
const SITES_FALLBACK_KEY = "maru:sites:fallback:v1";
const MOCK_SECRET_TEXTS_KEY_PREFIX = "maru:mock-secret-texts:";
const GENERATED_SECRET_LEAF_FILES = new Set([
  ".ds_store",
  ".localized",
  "thumbs.db",
  "desktop.ini",
]);
export const MARU_SETTINGS_UPDATED_EVENT = "maru://settings-updated";
export const MARU_IGNORE_UPDATED_EVENT = "maru://ignore-updated";

export interface MaruSettingsUpdatedPayload {
  workPath: string;
  settings: MaruSettings;
  globalChanged?: boolean;
  workspaceChanged?: boolean;
}

interface MaruSettingsSaveOutcome {
  globalChanged: boolean;
  workspaceChanged: boolean;
}

function defaultMockSecretTexts(): Record<string, string> {
  const generated = Object.fromEntries(
    Array.from({ length: 88 }, (_, index) => {
      const suffix = String(index + 1).padStart(2, "0");
      return [`services/mock-${suffix}.env`, `MOCK_SECRET_${suffix}=placeholder\n`];
    }),
  );
  return {
    "services/telegram-monitor.config.yaml":
      "telegram:\n  api_id: \"12345\"\n  api_hash: \"mock-api-hash\"\n",
    ".DS_Store": "finder metadata\n",
    "workspace/local.env": "MARU_LOCAL_ONLY=1\n",
    "projects/demo/api-token": "demo-token-placeholder\n",
    ...generated,
  };
}

function isGeneratedSecretLeafPath(relPath: string): boolean {
  const name = relPath.split("/").pop()?.toLowerCase() ?? "";
  return name.startsWith("._") || GENERATED_SECRET_LEAF_FILES.has(name);
}

function mockSecretTextsKey(workPath: string): string {
  return `${MOCK_SECRET_TEXTS_KEY_PREFIX}${workPath}`;
}

function readMockSecretTexts(workPath: string): Record<string, string> {
  const defaults = defaultMockSecretTexts();
  if (typeof window === "undefined") return defaults;
  try {
    const raw = window.localStorage.getItem(mockSecretTextsKey(workPath));
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return defaults;
    return { ...defaults, ...(parsed as Record<string, string>) };
  } catch {
    return defaults;
  }
}

function writeMockSecretTexts(workPath: string, texts: Record<string, string>) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(mockSecretTextsKey(workPath), JSON.stringify(texts));
}

function mockSecretsScanReport(workPath: string): SecretsScanReport {
  const texts = readMockSecretTexts(workPath);
  const managed = Object.entries(texts)
    .filter(([relPath]) => !isGeneratedSecretLeafPath(relPath))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([relPath, contents]) => ({
      relPath,
      absPath: `${workPath}/.maru/secrets/${relPath}`,
      root: "primary",
      kind: "file",
      sizeBytes: new TextEncoder().encode(contents).length,
      mode: "0600",
      permissionsOk: true,
      symlinkTarget: null,
    }));
  return {
    ok: true,
    root: {
      workPath,
      primaryRoot: `${workPath}/.maru/secrets`,
      primaryExists: true,
      legacyPath: `${workPath}/.secrets`,
      legacyExists: true,
      legacyKind: "symlink_to_primary",
      legacyTarget: ".maru/secrets",
    },
    managed: [
      ...managed,
      {
        relPath: "apple/DeveloperIDApplication.p12",
        absPath: `${workPath}/.maru/secrets/apple/DeveloperIDApplication.p12`,
        root: "primary",
        kind: "file",
        sizeBytes: 3272,
        mode: "0600",
        permissionsOk: true,
        symlinkTarget: null,
      },
    ],
    candidates: [
      {
        relPath: "sites/demo/.env.local",
        absPath: `${workPath}/sites/demo/.env.local`,
        reason: "environment file",
        recommendedRelPath: "sites/demo/local.env",
        recommendedAbsPath: `${workPath}/.maru/secrets/sites/demo/local.env`,
      },
    ],
    legacySymlinks: [
      {
        relPath: "services/legacy-monitor.env",
        absPath: `${workPath}/services/legacy-monitor.env`,
        reason: "legacy .secrets symlink target",
        recommendedRelPath: "services/legacy-monitor.env",
        recommendedAbsPath: `${workPath}/.maru/secrets/services/legacy-monitor.env`,
      },
    ],
    issues: [
      {
        severity: "warn",
        code: "legacy_config_ref",
        path: "workspace.config.yaml.io.providers.telegram.secrets.monitor_config",
        message: "workspace.config.yaml still references .secrets",
      },
    ],
  };
}

// === Workspace detection / pairing ===

export async function detectWorkspace(path: string): Promise<WorkspaceDetect | null> {
  if (!isTauri()) return null;
  return invoke<WorkspaceDetect | null>("detect_workspace", { path });
}

export async function readWorkspaceConfig(workPath: string): Promise<WorkspaceConfig> {
  if (!isTauri()) {
    throw new Error("workspace.config.yaml requires the Tauri shell");
  }
  return invoke<WorkspaceConfig>("read_workspace_config", { workPath });
}

const MISSING_WORKSPACE_CONFIG_ERROR_PREFIX = "workspace.config.yaml not found at ";
const WORKSPACE_CONFIG_TAURI_REQUIRED_ERROR =
  "workspace.config.yaml requires the Tauri shell";

export function isMissingWorkspaceConfigError(error: unknown): boolean {
  return workspaceConfigErrorText(error).startsWith(
    MISSING_WORKSPACE_CONFIG_ERROR_PREFIX,
  );
}

export function isWorkspaceConfigShellUnavailableError(error: unknown): boolean {
  return workspaceConfigErrorText(error) === WORKSPACE_CONFIG_TAURI_REQUIRED_ERROR;
}

export interface WorkspaceConfigLoadState {
  workPath: string | null;
  status: "idle" | "pending" | "ready" | "error";
  config: WorkspaceConfig | null;
  error: string | null;
}

export type WorkspaceConfigReader = (workPath: string) => Promise<WorkspaceConfig>;
export type WorkspaceConfigValidator = (config: WorkspaceConfig) => string | null;

export async function resolveWorkspaceConfigLoad(
  workPath: string,
  reader: WorkspaceConfigReader = readWorkspaceConfig,
  validator?: WorkspaceConfigValidator,
): Promise<WorkspaceConfigLoadState> {
  try {
    const config = await reader(workPath);
    const validationError = validator?.(config) ?? null;
    if (validationError) {
      return {
        workPath,
        status: "error",
        config: null,
        error: workspaceConfigLoadErrorMessage(validationError),
      };
    }
    return {
      workPath,
      status: "ready",
      config,
      error: null,
    };
  } catch (error) {
    if (
      isMissingWorkspaceConfigError(error) ||
      isWorkspaceConfigShellUnavailableError(error)
    ) {
      return {
        workPath,
        status: "ready",
        config: null,
        error: null,
      };
    }
    return {
      workPath,
      status: "error",
      config: null,
      error: workspaceConfigLoadErrorMessage(error),
    };
  }
}

function workspaceConfigLoadErrorMessage(error: unknown): string {
  const message = workspaceConfigErrorText(error) || "Cannot read workspace.config.yaml";
  return message.trim().slice(0, 2_000) || "Cannot read workspace.config.yaml";
}

function workspaceConfigErrorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : typeof error === "object" &&
          error !== null &&
          "message" in error &&
          typeof error.message === "string"
        ? error.message
        : "";
}

export async function registerWorkspaceRoots(
  workPath: string,
): Promise<RegisterWorkspaceOutcome> {
  if (!isTauri()) {
    throw new Error("Workspace registration requires the Tauri shell");
  }
  return invoke<RegisterWorkspaceOutcome>("register_workspace_roots", { workPath });
}

export async function listWorkspaces(): Promise<WorkspaceSummary[]> {
  if (!isTauri()) return [];
  return invoke<WorkspaceSummary[]>("list_workspaces");
}

export async function scanSecrets(workPath: string): Promise<SecretsScanReport> {
  if (!isTauri()) {
    return mockSecretsScanReport(workPath);
  }
  return invoke<SecretsScanReport>("secrets_scan", { workPath });
}

export async function doctorSecrets(workPath: string): Promise<SecretsScanReport> {
  if (!isTauri()) return scanSecrets(workPath);
  return invoke<SecretsScanReport>("secrets_doctor", { workPath });
}

export async function migrateSecrets(
  workPath: string,
  dryRun: boolean,
  selected?: string[],
): Promise<SecretsMigrationReport> {
  if (!isTauri()) {
    const scan = await scanSecrets(workPath);
    const allowed = new Set(selected ?? []);
    const includeAll = allowed.size === 0;
    const actions = [
      {
        action: "create-legacy-symlink",
        sourcePath: `${workPath}/.secrets`,
        targetPath: `${workPath}/.maru/secrets`,
        relPath: ".secrets",
        status: dryRun ? "planned" : "applied",
      },
      ...scan.candidates.map((candidate) => ({
        action: "move-secret-file",
        sourcePath: candidate.absPath,
        targetPath: candidate.recommendedAbsPath,
        relPath: candidate.relPath,
        status: dryRun ? "planned" : "applied",
      })),
      ...scan.legacySymlinks.map((candidate) => ({
        action: "retarget-legacy-symlink",
        sourcePath: candidate.absPath,
        targetPath: candidate.recommendedAbsPath,
        relPath: candidate.relPath,
        status: dryRun ? "planned" : "applied",
      })),
    ].filter((action) => {
      if (includeAll) return true;
      if (action.action !== "move-secret-file" && action.action !== "retarget-legacy-symlink") {
        return true;
      }
      return action.relPath ? allowed.has(action.relPath) : true;
    });
    return {
      applied: !dryRun,
      ok: true,
      scan,
      actions,
    };
  }
  return invoke<SecretsMigrationReport>("secrets_migrate", {
    workPath,
    dryRun,
    selected: selected ?? null,
  });
}

export async function readSecretText(
  workPath: string,
  relPath: string,
): Promise<SecretTextDocument> {
  if (!isTauri()) {
    const texts = readMockSecretTexts(workPath);
    const contents = texts[relPath] ?? "";
    return {
      relPath,
      absPath: `${workPath}/.maru/secrets/${relPath}`,
      contents,
      sizeBytes: new TextEncoder().encode(contents).length,
      mode: "0600",
    };
  }
  return invoke<SecretTextDocument>("secrets_read_text", { workPath, relPath });
}

export async function writeSecretText(
  workPath: string,
  relPath: string,
  contents: string,
): Promise<void> {
  if (!isTauri()) {
    const texts = readMockSecretTexts(workPath);
    texts[relPath] = contents;
    writeMockSecretTexts(workPath, texts);
    return;
  }
  await invoke("secrets_write_text", { workPath, relPath, contents });
}

export async function deleteSecretText(workPath: string, relPath: string): Promise<SecretsScanReport> {
  if (!isTauri()) {
    const texts = readMockSecretTexts(workPath);
    delete texts[relPath];
    writeMockSecretTexts(workPath, texts);
    return mockSecretsScanReport(workPath);
  }
  return invoke<SecretsScanReport>("secrets_delete_text", { workPath, relPath });
}

// === .maru/ workspace meta ===

export async function bootstrapMaruDir(workPath: string): Promise<MaruWorkspaceMeta> {
  if (!isTauri()) {
    throw new Error(".maru bootstrap requires the Tauri shell");
  }
  return invoke<MaruWorkspaceMeta>("bootstrap_maru_dir", { workPath });
}

export async function readMaruWorkspace(workPath: string): Promise<MaruWorkspaceMeta> {
  if (!isTauri()) {
    throw new Error(".maru workspace requires the Tauri shell");
  }
  return invoke<MaruWorkspaceMeta>("read_maru_workspace", { workPath });
}

export async function updateMaruWorkspace(
  workPath: string,
  patch: MaruWorkspaceMetaPatch,
): Promise<MaruWorkspaceMeta> {
  if (!isTauri()) {
    throw new Error(".maru workspace requires the Tauri shell");
  }
  // Rust uses plain Option<String> with v1 semantics: Some(value) sets,
  // missing/null leaves the existing field unchanged. We can't yet
  // *clear* a field through this patch — none of the v1 callers need
  // that. Strip undefined/null entries before sending so they don't
  // shadow the existing value.
  const pruned: Record<string, string> = {};
  if (typeof patch.pairedVaultPath === "string") pruned.pairedVaultPath = patch.pairedVaultPath;
  if (typeof patch.ownerName === "string") pruned.ownerName = patch.ownerName;
  if (typeof patch.locale === "string") pruned.locale = patch.locale;
  if (typeof patch.lastActiveMode === "string") pruned.lastActiveMode = patch.lastActiveMode;
  return invoke<MaruWorkspaceMeta>("update_maru_workspace", {
    workPath,
    patch: pruned,
  });
}

// === Rules ===

export async function listMaruRules(workPath: string): Promise<RuleEntry[]> {
  if (!isTauri()) return [];
  return invoke<RuleEntry[]>("list_maru_rules", { workPath });
}

export async function readMaruRule(workPath: string, name: string): Promise<RuleDocument> {
  if (!isTauri()) {
    throw new Error(".maru rules require the Tauri shell");
  }
  return invoke<RuleDocument>("read_maru_rule", { workPath, name });
}

export async function saveMaruRule(
  workPath: string,
  name: string,
  content: string,
): Promise<RuleEntry> {
  if (!isTauri()) {
    throw new Error(".maru rules require the Tauri shell");
  }
  return invoke<RuleEntry>("save_maru_rule", { workPath, name, content });
}

// === Ignore list (.maruignore) ===

/** Patterns hiding files from the document list, gitignore-style. */
export interface MaruIgnoreDocument {
  relPath: string;
  /** User-editable lines, in file order. */
  patterns: string[];
  /** Built-ins the backend always applies; not editable. */
  builtin: string[];
}

export async function readMaruIgnore(workPath: string): Promise<MaruIgnoreDocument> {
  if (!isTauri()) return { relPath: ".maruignore", patterns: [], builtin: [] };
  return invoke<MaruIgnoreDocument>("read_maru_ignore", { workPath });
}

export async function saveMaruIgnore(
  workPath: string,
  patterns: string[],
): Promise<MaruIgnoreDocument> {
  if (!isTauri()) {
    throw new Error(".maruignore requires the Tauri shell");
  }
  const saved = await invoke<MaruIgnoreDocument>("save_maru_ignore", { workPath, patterns });
  // The scan reads .maruignore, so every list that was already loaded is now
  // stale. Fanout is best-effort — the save itself has already succeeded.
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit(MARU_IGNORE_UPDATED_EVENT, { workPath });
  } catch {
    /* best-effort */
  }
  return saved;
}

export async function listenMaruIgnoreUpdated(
  handler: (payload: { workPath: string }) => void,
): Promise<() => void> {
  if (!isTauri()) {
    const onEvent = (event: Event) => {
      handler((event as CustomEvent<{ workPath: string }>).detail);
    };
    window.addEventListener(MARU_IGNORE_UPDATED_EVENT, onEvent);
    return () => window.removeEventListener(MARU_IGNORE_UPDATED_EVENT, onEvent);
  }
  const { listen } = await import("@tauri-apps/api/event");
  return listen<{ workPath: string }>(MARU_IGNORE_UPDATED_EVENT, (event) => {
    handler(event.payload);
  });
}

/** The list to save after adding `pattern`, or null when it changes nothing
 *  (blank, already listed, or already covered by a built-in). */
export function nextIgnorePatterns(
  current: MaruIgnoreDocument,
  pattern: string,
): string[] | null {
  const trimmed = pattern.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  if (current.patterns.includes(trimmed) || current.builtin.includes(trimmed)) return null;
  return [...current.patterns, trimmed];
}

/** Append one pattern, keeping the file's order and skipping duplicates.
 *  Returns null when the pattern was already ignored. */
export async function addMaruIgnorePattern(
  workPath: string,
  pattern: string,
): Promise<MaruIgnoreDocument | null> {
  const current = await readMaruIgnore(workPath);
  const next = nextIgnorePatterns(current, pattern);
  if (!next) return null;
  return saveMaruIgnore(workPath, next);
}

export async function deleteMaruRule(workPath: string, name: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("delete_maru_rule", { workPath, name });
}

// === Templates ===

export async function listMaruTemplates(workPath: string): Promise<TemplateEntry[]> {
  if (!isTauri()) return [];
  return invoke<TemplateEntry[]>("list_maru_templates", { workPath });
}

export async function readMaruTemplate(workPath: string, name: string): Promise<string> {
  if (!isTauri()) {
    throw new Error(".maru templates require the Tauri shell");
  }
  return invoke<string>("read_maru_template", { workPath, name });
}

export async function saveMaruTemplate(
  workPath: string,
  name: string,
  content: string,
): Promise<TemplateEntry> {
  if (!isTauri()) {
    throw new Error(".maru templates require the Tauri shell");
  }
  return invoke<TemplateEntry>("save_maru_template", { workPath, name, content });
}

export async function deleteMaruTemplate(workPath: string, name: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("delete_maru_template", { workPath, name });
}

// === MCP / Projects / Skills (raw JSON) ===

export async function readMaruMcp(workPath: string): Promise<unknown> {
  if (!isTauri()) return null;
  return invoke<unknown>("read_maru_mcp", { workPath });
}

export async function saveMaruMcp(workPath: string, value: unknown): Promise<void> {
  if (!isTauri()) return;
  await invoke("save_maru_mcp", { workPath, value });
}

export async function readMaruProjects(workPath: string): Promise<unknown> {
  if (!isTauri()) return null;
  return invoke<unknown>("read_maru_projects", { workPath });
}

export async function listWorkspaceProjects(
  workPath: string,
  includeInactive = false,
): Promise<ProjectPickerEntry[]> {
  if (!isTauri()) {
    return [
      { id: "sample", name: "Sample Project", path: "projects/sample/", status: "active" },
    ];
  }
  return invoke<ProjectPickerEntry[]>("list_workspace_projects", {
    workPath,
    includeInactive,
  });
}

export async function saveMaruProjects(workPath: string, value: unknown): Promise<void> {
  if (!isTauri()) return;
  await invoke("save_maru_projects", { workPath, value });
}

export async function readMaruSkills(workPath: string): Promise<unknown> {
  if (!isTauri()) return null;
  return invoke<unknown>("read_maru_skills", { workPath });
}

// === Sites (raw JSON; normalized at the edge by parseSitesDocument) ===

export async function readSites(): Promise<unknown> {
  if (!isTauri()) {
    try {
      const raw = window.localStorage.getItem(SITES_FALLBACK_KEY);
      return raw ? (JSON.parse(raw) as unknown) : null;
    } catch {
      return null;
    }
  }
  return invoke<unknown>("read_sites");
}

export async function saveSites(value: unknown): Promise<void> {
  if (!isTauri()) {
    window.localStorage.setItem(SITES_FALLBACK_KEY, JSON.stringify(value));
    return;
  }
  await invoke("save_sites", { value });
}

export async function scanWorkSites(dir: string): Promise<unknown> {
  if (!isTauri()) {
    // Browser-dev mock so the import dialog stays exercisable.
    return [
      {
        dirName: "demo-site",
        label: "Demo Site",
        localPath: `${dir}/demo-site`,
        url: "https://demo.example.com",
        devUrl: "http://localhost:4321",
        source: "mock",
      },
      {
        dirName: "docs",
        label: "Docs",
        localPath: `${dir}/docs`,
        url: null,
        devUrl: "http://localhost:3000",
        source: "mock",
      },
    ];
  }
  return invoke<unknown>("scan_work_sites", { dir });
}

export async function readMaruSettings(workPath: string): Promise<MaruSettings> {
  if (!isTauri()) {
    try {
      const raw = window.localStorage.getItem(`${SETTINGS_FALLBACK_KEY}:${workPath}`);
      return normalizeMaruSettings(raw ? JSON.parse(raw) : DEFAULT_MARU_SETTINGS);
    } catch {
      return normalizeMaruSettings(DEFAULT_MARU_SETTINGS);
    }
  }
  const value = await invoke<unknown>("read_maru_settings", { workPath });
  return normalizeMaruSettings(value);
}

export async function saveMaruSettings(
  workPath: string,
  value: MaruSettings,
  baseValue?: MaruSettings,
): Promise<void> {
  const normalized = normalizeMaruSettings(value);
  const normalizedBase = baseValue ? normalizeMaruSettings(baseValue) : undefined;
  if (!isTauri()) {
    window.localStorage.setItem(
      `${SETTINGS_FALLBACK_KEY}:${workPath}`,
      JSON.stringify(normalized),
    );
    window.dispatchEvent(
      new CustomEvent<MaruSettingsUpdatedPayload>(MARU_SETTINGS_UPDATED_EVENT, {
        detail: {
          workPath,
          settings: normalized,
          globalChanged: true,
          workspaceChanged: true,
        },
      }),
    );
    return;
  }
  const outcome = await invoke<MaruSettingsSaveOutcome>("save_maru_settings", {
    workPath,
    value: serializeMaruSettings(normalized),
    baseValue: normalizedBase ? serializeMaruSettings(normalizedBase) : null,
  });
  await emitMaruSettingsUpdated({
    workPath,
    settings: normalized,
    globalChanged: outcome.globalChanged,
    workspaceChanged: outcome.workspaceChanged,
  });
}

export async function listenMaruSettingsUpdated(
  handler: (payload: MaruSettingsUpdatedPayload) => void,
): Promise<() => void> {
  if (!isTauri()) {
    const onEvent = (event: Event) => {
      handler((event as CustomEvent<MaruSettingsUpdatedPayload>).detail);
    };
    window.addEventListener(MARU_SETTINGS_UPDATED_EVENT, onEvent);
    return () => window.removeEventListener(MARU_SETTINGS_UPDATED_EVENT, onEvent);
  }
  const { listen } = await import("@tauri-apps/api/event");
  return listen<MaruSettingsUpdatedPayload>(MARU_SETTINGS_UPDATED_EVENT, (event) => {
    handler(event.payload);
  });
}

async function emitMaruSettingsUpdated(
  payload: MaruSettingsUpdatedPayload,
): Promise<void> {
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit(MARU_SETTINGS_UPDATED_EVENT, payload);
  } catch {
    // Settings persistence has already succeeded. Event fanout is best-effort.
  }
}

// === Helpers (frontend only) ===

/**
 * Identify the private workspace root. Used by the frontend to decide where
 * System mode should store workspace-local `.maru/` resources and state.
 */
export function findPrivateWorkspaceEntry(registry: WorkspaceRegistry): WorkspaceRootEntry | null {
  const active = registry.activeByVisibility.private;
  return (
    registry.workspaces.find((workspace) => workspace.path === active) ??
    registry.workspaces.find((workspace) => workspace.visibility === "private") ??
    null
  );
}

export function findPublicWorkspaceEntry(registry: WorkspaceRegistry): WorkspaceRootEntry | null {
  const active = registry.activeByVisibility.public;
  return (
    registry.workspaces.find((workspace) => workspace.path === active) ??
    registry.workspaces.find((workspace) => workspace.visibility === "public") ??
    null
  );
}
