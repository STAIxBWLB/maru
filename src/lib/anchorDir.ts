// Thin wrappers around the Rust commands that own `<work>/.anchor/`
// (workspace pairing + System mode). Mirrors the pattern in `api.ts`:
// browser-dev fallbacks return inert no-ops so the React layer can be
// exercised without the Tauri shell.

import { invoke } from "@tauri-apps/api/core";
import type {
  AnchorWorkspaceMeta,
  AnchorWorkspaceMetaPatch,
  ImportPlan,
  ImportReceipt,
  RegisterWorkspaceOutcome,
  RuleDocument,
  RuleEntry,
  TemplateEntry,
  VaultList,
  WorkspaceConfig,
  WorkspaceDetect,
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
export const ANCHOR_SETTINGS_UPDATED_EVENT = "anchor://settings-updated";

export interface AnchorSettingsUpdatedPayload {
  workPath: string;
  settings: AnchorSettings;
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

export async function registerWorkspacePair(
  workPath: string,
): Promise<RegisterWorkspaceOutcome> {
  if (!isTauri()) {
    throw new Error("Workspace pairing requires the Tauri shell");
  }
  return invoke<RegisterWorkspaceOutcome>("register_workspace_pair", { workPath });
}

export async function listWorkspaces(): Promise<WorkspaceSummary[]> {
  if (!isTauri()) return [];
  return invoke<WorkspaceSummary[]>("list_workspaces");
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
): Promise<void> {
  const normalized = normalizeAnchorSettings(value);
  if (!isTauri()) {
    window.localStorage.setItem(
      `${SETTINGS_FALLBACK_KEY}:${workPath}`,
      JSON.stringify(normalized),
    );
    window.dispatchEvent(
      new CustomEvent<AnchorSettingsUpdatedPayload>(ANCHOR_SETTINGS_UPDATED_EVENT, {
        detail: { workPath, settings: normalized },
      }),
    );
    return;
  }
  await invoke("save_anchor_settings", {
    workPath,
    value: serializeAnchorSettings(normalized),
  });
  await emitAnchorSettingsUpdated({ workPath, settings: normalized });
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
 * Identify which registered VaultList entry is the "work" half of an
 * anchored workspace. Used by the frontend to decide whether to show
 * System mode (Rules / Templates / MCP / Projects / Skills tabs).
 */
export function findWorkRoleEntry(list: VaultList) {
  return list.vaults.find((v) => v.role === "work") ?? null;
}

export function findVaultRoleEntryForRoot(list: VaultList, workspaceRoot: string) {
  return (
    list.vaults.find((v) => v.role === "vault" && v.workspaceRoot === workspaceRoot) ?? null
  );
}
