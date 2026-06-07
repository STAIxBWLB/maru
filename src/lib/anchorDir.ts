// Thin wrappers around the Rust commands that own layered settings plus
// `<work>/.anchor/` workspace resources (workspace registration + System mode).
// Mirrors the pattern in `api.ts`:
// browser-dev fallbacks return inert no-ops so the React layer can be
// exercised without the Tauri shell.

import { invoke } from "@tauri-apps/api/core";
import type {
  AnchorWorkspaceMeta,
  AnchorWorkspaceMetaPatch,
  ImportPlan,
  ImportReceipt,
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
  DEFAULT_ANCHOR_SETTINGS,
  normalizeAnchorSettings,
  serializeAnchorSettings,
  type AnchorSettings,
} from "./settings";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

const isTauri = () =>
  typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);

const SETTINGS_FALLBACK_KEY = "anchor:settings:fallback:v1";
const MOCK_SECRET_TEXTS_KEY_PREFIX = "anchor:mock-secret-texts:";
const GENERATED_SECRET_LEAF_FILES = new Set([
  ".ds_store",
  ".localized",
  "thumbs.db",
  "desktop.ini",
]);
export const ANCHOR_SETTINGS_UPDATED_EVENT = "anchor://settings-updated";

export interface AnchorSettingsUpdatedPayload {
  workPath: string;
  settings: AnchorSettings;
  globalChanged?: boolean;
  workspaceChanged?: boolean;
}

interface AnchorSettingsSaveOutcome {
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
    "workspace/local.env": "ANCHOR_LOCAL_ONLY=1\n",
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
      absPath: `${workPath}/.anchor/secrets/${relPath}`,
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
      primaryRoot: `${workPath}/.anchor/secrets`,
      primaryExists: true,
      legacyPath: `${workPath}/.secrets`,
      legacyExists: true,
      legacyKind: "symlink_to_primary",
      legacyTarget: ".anchor/secrets",
    },
    managed: [
      ...managed,
      {
        relPath: "apple/DeveloperIDApplication.p12",
        absPath: `${workPath}/.anchor/secrets/apple/DeveloperIDApplication.p12`,
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
        recommendedAbsPath: `${workPath}/.anchor/secrets/sites/demo/local.env`,
      },
    ],
    legacySymlinks: [
      {
        relPath: "services/legacy-monitor.env",
        absPath: `${workPath}/services/legacy-monitor.env`,
        reason: "legacy .secrets symlink target",
        recommendedRelPath: "services/legacy-monitor.env",
        recommendedAbsPath: `${workPath}/.anchor/secrets/services/legacy-monitor.env`,
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
        targetPath: `${workPath}/.anchor/secrets`,
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
      absPath: `${workPath}/.anchor/secrets/${relPath}`,
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

// === .anchor/ workspace meta ===

export async function bootstrapAnchorDir(workPath: string): Promise<AnchorWorkspaceMeta> {
  if (!isTauri()) {
    throw new Error(".anchor bootstrap requires the Tauri shell");
  }
  return invoke<AnchorWorkspaceMeta>("bootstrap_anchor_dir", { workPath });
}

export async function readAnchorWorkspace(workPath: string): Promise<AnchorWorkspaceMeta> {
  if (!isTauri()) {
    throw new Error(".anchor workspace requires the Tauri shell");
  }
  return invoke<AnchorWorkspaceMeta>("read_anchor_workspace", { workPath });
}

export async function updateAnchorWorkspace(
  workPath: string,
  patch: AnchorWorkspaceMetaPatch,
): Promise<AnchorWorkspaceMeta> {
  if (!isTauri()) {
    throw new Error(".anchor workspace requires the Tauri shell");
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
  return invoke<AnchorWorkspaceMeta>("update_anchor_workspace", {
    workPath,
    patch: pruned,
  });
}

// === Rules ===

export async function listAnchorRules(workPath: string): Promise<RuleEntry[]> {
  if (!isTauri()) return [];
  return invoke<RuleEntry[]>("list_anchor_rules", { workPath });
}

export async function readAnchorRule(workPath: string, name: string): Promise<RuleDocument> {
  if (!isTauri()) {
    throw new Error(".anchor rules require the Tauri shell");
  }
  return invoke<RuleDocument>("read_anchor_rule", { workPath, name });
}

export async function saveAnchorRule(
  workPath: string,
  name: string,
  content: string,
): Promise<RuleEntry> {
  if (!isTauri()) {
    throw new Error(".anchor rules require the Tauri shell");
  }
  return invoke<RuleEntry>("save_anchor_rule", { workPath, name, content });
}

export async function deleteAnchorRule(workPath: string, name: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("delete_anchor_rule", { workPath, name });
}

// === Templates ===

export async function listAnchorTemplates(workPath: string): Promise<TemplateEntry[]> {
  if (!isTauri()) return [];
  return invoke<TemplateEntry[]>("list_anchor_templates", { workPath });
}

export async function readAnchorTemplate(workPath: string, name: string): Promise<string> {
  if (!isTauri()) {
    throw new Error(".anchor templates require the Tauri shell");
  }
  return invoke<string>("read_anchor_template", { workPath, name });
}

export async function saveAnchorTemplate(
  workPath: string,
  name: string,
  content: string,
): Promise<TemplateEntry> {
  if (!isTauri()) {
    throw new Error(".anchor templates require the Tauri shell");
  }
  return invoke<TemplateEntry>("save_anchor_template", { workPath, name, content });
}

export async function deleteAnchorTemplate(workPath: string, name: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("delete_anchor_template", { workPath, name });
}

// === MCP / Projects / Skills (raw JSON) ===

export async function readAnchorMcp(workPath: string): Promise<unknown> {
  if (!isTauri()) return null;
  return invoke<unknown>("read_anchor_mcp", { workPath });
}

export async function saveAnchorMcp(workPath: string, value: unknown): Promise<void> {
  if (!isTauri()) return;
  await invoke("save_anchor_mcp", { workPath, value });
}

export async function readAnchorProjects(workPath: string): Promise<unknown> {
  if (!isTauri()) return null;
  return invoke<unknown>("read_anchor_projects", { workPath });
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

export async function saveAnchorProjects(workPath: string, value: unknown): Promise<void> {
  if (!isTauri()) return;
  await invoke("save_anchor_projects", { workPath, value });
}

export async function readAnchorSkills(workPath: string): Promise<unknown> {
  if (!isTauri()) return null;
  return invoke<unknown>("read_anchor_skills", { workPath });
}

export async function readAnchorSettings(workPath: string): Promise<AnchorSettings> {
  if (!isTauri()) {
    try {
      const raw = window.localStorage.getItem(`${SETTINGS_FALLBACK_KEY}:${workPath}`);
      return normalizeAnchorSettings(raw ? JSON.parse(raw) : DEFAULT_ANCHOR_SETTINGS);
    } catch {
      return normalizeAnchorSettings(DEFAULT_ANCHOR_SETTINGS);
    }
  }
  const value = await invoke<unknown>("read_anchor_settings", { workPath });
  return normalizeAnchorSettings(value);
}

export async function saveAnchorSettings(
  workPath: string,
  value: AnchorSettings,
  baseValue?: AnchorSettings,
): Promise<void> {
  const normalized = normalizeAnchorSettings(value);
  const normalizedBase = baseValue ? normalizeAnchorSettings(baseValue) : undefined;
  if (!isTauri()) {
    window.localStorage.setItem(
      `${SETTINGS_FALLBACK_KEY}:${workPath}`,
      JSON.stringify(normalized),
    );
    window.dispatchEvent(
      new CustomEvent<AnchorSettingsUpdatedPayload>(ANCHOR_SETTINGS_UPDATED_EVENT, {
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
  const outcome = await invoke<AnchorSettingsSaveOutcome>("save_anchor_settings", {
    workPath,
    value: serializeAnchorSettings(normalized),
    baseValue: normalizedBase ? serializeAnchorSettings(normalizedBase) : null,
  });
  await emitAnchorSettingsUpdated({
    workPath,
    settings: normalized,
    globalChanged: outcome.globalChanged,
    workspaceChanged: outcome.workspaceChanged,
  });
}

export async function listenAnchorSettingsUpdated(
  handler: (payload: AnchorSettingsUpdatedPayload) => void,
): Promise<() => void> {
  if (!isTauri()) {
    const onEvent = (event: Event) => {
      handler((event as CustomEvent<AnchorSettingsUpdatedPayload>).detail);
    };
    window.addEventListener(ANCHOR_SETTINGS_UPDATED_EVENT, onEvent);
    return () => window.removeEventListener(ANCHOR_SETTINGS_UPDATED_EVENT, onEvent);
  }
  const { listen } = await import("@tauri-apps/api/event");
  return listen<AnchorSettingsUpdatedPayload>(ANCHOR_SETTINGS_UPDATED_EVENT, (event) => {
    handler(event.payload);
  });
}

async function emitAnchorSettingsUpdated(
  payload: AnchorSettingsUpdatedPayload,
): Promise<void> {
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit(ANCHOR_SETTINGS_UPDATED_EVENT, payload);
  } catch {
    // Settings persistence has already succeeded. Event fanout is best-effort.
  }
}

export async function readAnchorImports(workPath: string): Promise<unknown> {
  if (!isTauri()) return null;
  return invoke<unknown>("read_anchor_imports", { workPath });
}

// === _sys/ → .anchor/ import ===

export async function planSysImport(workPath: string): Promise<ImportPlan> {
  if (!isTauri()) {
    return {
      workPath,
      sysPresent: false,
      rules: [],
      templates: [],
      mcp: null,
      projects: null,
      skills: null,
    };
  }
  return invoke<ImportPlan>("plan_sys_import", { workPath });
}

export async function applySysImport(
  workPath: string,
  plan: ImportPlan,
  selected: string[],
): Promise<ImportReceipt> {
  if (!isTauri()) return { applied: [], skipped: [] };
  return invoke<ImportReceipt>("apply_sys_import", { workPath, plan, selected });
}

// === Helpers (frontend only) ===

/**
 * Identify the private workspace root. Used by the frontend to decide where
 * System mode should store workspace-local `.anchor/` resources and state.
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
