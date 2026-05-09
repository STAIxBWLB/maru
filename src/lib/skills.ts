import { invoke } from "@tauri-apps/api/core";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

const isTauri = () =>
  typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);

export type SkillSourceKind = "linked" | "cloned" | "imported" | "managed" | "adopted";
export type SkillInstallTarget = "claude" | "codex";
export type SkillDispatchRuntime = "claude" | "codex";

export interface SkillSource {
  id: string;
  kind: SkillSourceKind;
  path?: string | null;
  repoUrl?: string | null;
  skillsSubdir: string;
  branch?: string | null;
  lastSyncedAt?: string | null;
}

export interface SkillRecord {
  id: string;
  sourceId: string;
  name: string;
  relPath: string;
  absPath: string;
  title: string;
  description?: string | null;
  runtime?: string | null;
  category?: string | null;
  editable: boolean;
  dirty: boolean;
}

export interface SkillInstall {
  skillId: string;
  target: SkillInstallTarget;
  installedAs: string;
  managedBy: "anchor" | "external" | string;
  entrypointPath: string;
  targetPath: string;
  createdAt?: string | null;
}

export interface SkillDocument {
  skill: SkillRecord;
  content: string;
}

export interface SkillsEnvStatus {
  root: string;
  venvPath: string;
  venvExists: boolean;
  nodeModulesPath: string;
  nodeModulesExists: boolean;
  setupScript?: string | null;
  statusPath: string;
  lastBootstrapAt?: string | null;
  lastError?: string | null;
  healthy: boolean;
}

export interface SkillContextItem {
  path: string;
  kind?: "file" | "directory" | "document" | "folder" | string | null;
}

export interface DispatchComposition {
  skillId: string;
  skillName: string;
  cwd: string;
  prompt: string;
  context: SkillContextItem[];
  extraEnv: Record<string, string>;
}

export interface TerminalDispatchSpec {
  kind: SkillDispatchRuntime;
  cwd: string;
  command?: string | null;
  extraArgs: string[];
  extraEnv: Record<string, string>;
  title: string;
}

export interface AdoptOutcome {
  adopted: number;
  skipped: number;
  installs: SkillInstall[];
}

export interface InstallOutcome {
  install: SkillInstall;
  anchorEntrypoint: string;
}

export interface ResetOutcome {
  backupPath?: string | null;
  sources: number;
  skills: number;
}

export interface SkillProgressEvent {
  progressId: string;
  level: "info" | "success" | "warn" | "error" | string;
  message: string;
  completed?: number | null;
  total?: number | null;
}

export async function skillsListSources(workPath: string | null): Promise<SkillSource[]> {
  if (!isTauri()) return [];
  return invoke<SkillSource[]>("skills_list_sources", { workPath });
}

export async function skillsAddSource(params: {
  id: string;
  kind: SkillSourceKind;
  path?: string | null;
  repoUrl?: string | null;
  skillsSubdir?: string | null;
}): Promise<SkillSource> {
  if (!isTauri()) throw new Error("Skills source management requires the Tauri shell.");
  return invoke<SkillSource>("skills_add_source", params);
}

export async function skillsRemoveSource(sourceId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("skills_remove_source", { sourceId });
}

export async function skillsSyncSource(
  sourceId: string,
  progressId: string | null = null,
): Promise<SkillRecord[]> {
  if (!isTauri()) return [];
  return invoke<SkillRecord[]>("skills_sync_source", { sourceId, progressId });
}

export async function skillsRescanSource(
  sourceId: string,
  progressId: string | null = null,
): Promise<SkillRecord[]> {
  if (!isTauri()) return [];
  return invoke<SkillRecord[]>("skills_rescan_source", { sourceId, progressId });
}

export async function skillsListSkills(workPath: string | null): Promise<SkillRecord[]> {
  if (!isTauri()) return [];
  return invoke<SkillRecord[]>("skills_list_skills", { workPath });
}

export async function skillsReadSkill(skillId: string): Promise<SkillDocument> {
  if (!isTauri()) throw new Error("Skill editing requires the Tauri shell.");
  return invoke<SkillDocument>("skills_read_skill", { skillId });
}

export async function skillsReadSkillFile(
  skillId: string,
  filePath: string,
): Promise<string> {
  if (!isTauri()) throw new Error("Skill editing requires the Tauri shell.");
  return invoke<string>("skills_read_skill_file", { skillId, filePath });
}

export async function skillsSaveSkillFile(
  skillId: string,
  filePath: string,
  content: string,
): Promise<SkillRecord> {
  if (!isTauri()) throw new Error("Skill editing requires the Tauri shell.");
  return invoke<SkillRecord>("skills_save_skill_file", { skillId, filePath, content });
}

export async function skillsCreateSkill(
  name: string,
  title: string | null,
): Promise<SkillRecord> {
  if (!isTauri()) throw new Error("Skill creation requires the Tauri shell.");
  return invoke<SkillRecord>("skills_create_skill", { name, title });
}

export async function skillsDeleteSkill(skillId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("skills_delete_skill", { skillId });
}

export async function skillsListInstalls(workPath: string | null): Promise<SkillInstall[]> {
  if (!isTauri()) return [];
  return invoke<SkillInstall[]>("skills_list_installs", { workPath });
}

export async function skillsInstallSkill(
  skillId: string,
  target: SkillInstallTarget,
  installedAs: string | null = null,
): Promise<InstallOutcome> {
  if (!isTauri()) throw new Error("Skill install requires the Tauri shell.");
  return invoke<InstallOutcome>("skills_install_skill", { skillId, target, installedAs });
}

export async function skillsUninstallSkill(
  target: SkillInstallTarget,
  installedAs: string,
): Promise<void> {
  if (!isTauri()) return;
  await invoke("skills_uninstall_skill", { target, installedAs });
}

export async function skillsAdoptExternalLinks(
  progressId: string | null = null,
): Promise<AdoptOutcome> {
  if (!isTauri()) return { adopted: 0, skipped: 0, installs: [] };
  return invoke<AdoptOutcome>("skills_adopt_external_links", { progressId });
}

export async function skillsResetRegistry(
  workPath: string | null,
  progressId: string | null = null,
): Promise<ResetOutcome> {
  if (!isTauri()) return { sources: 0, skills: 0 };
  return invoke<ResetOutcome>("skills_reset_registry", { workPath, progressId });
}

export async function skillsEnvStatus(workPath: string | null): Promise<SkillsEnvStatus | null> {
  if (!isTauri()) return null;
  return invoke<SkillsEnvStatus>("skills_env_status", { workPath });
}

export async function skillsEnvBootstrap(
  workPath: string | null,
  dryRun = false,
): Promise<string> {
  if (!isTauri()) throw new Error("Skills env bootstrap requires the Tauri shell.");
  return invoke<string>("skills_env_bootstrap", { workPath, dryRun });
}

export async function skillsEnvRepair(workPath: string | null): Promise<string> {
  if (!isTauri()) throw new Error("Skills env repair requires the Tauri shell.");
  return invoke<string>("skills_env_repair", { workPath });
}

export async function skillsDispatchCompose(params: {
  skillId: string;
  prompt: string;
  cwd?: string | null;
  context?: SkillContextItem[] | null;
}): Promise<DispatchComposition> {
  if (!isTauri()) throw new Error("Skill compose requires the Tauri shell.");
  return invoke<DispatchComposition>("skills_dispatch_compose", params);
}

export async function skillsDispatchTerminal(params: {
  skillId: string;
  runtime: SkillDispatchRuntime;
  prompt: string;
  cwd?: string | null;
  context?: SkillContextItem[] | null;
}): Promise<TerminalDispatchSpec> {
  if (!isTauri()) throw new Error("Skill terminal dispatch requires the Tauri shell.");
  return invoke<TerminalDispatchSpec>("skills_dispatch_terminal", params);
}

export async function skillsDispatchBackground(params: {
  skillId: string;
  runtime: SkillDispatchRuntime;
  prompt: string;
  cwd?: string | null;
  context?: SkillContextItem[] | null;
}): Promise<string> {
  if (!isTauri()) throw new Error("Skill background dispatch requires the Tauri shell.");
  return invoke<string>("skills_dispatch_background", params);
}
