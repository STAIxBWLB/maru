import { invoke } from "@tauri-apps/api/core";
import type { MissionMetadata } from "./types";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

const isTauri = () =>
  typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);

export const SKILL_PROPOSAL_APPLY_APPROVAL_KIND = "agent.proposal.apply";

const MOCK_BUILTIN_SKILLS = [
  "meeting-notes",
  "vault-extract",
  "vault-connect",
  "task-management",
  "gaejosik",
  "inbox-process",
].map((name): SkillRecord => ({
  id: `mock:${name}`,
  sourceId: "mock-builtin",
  name,
  relPath: `skills/${name}/SKILL.md`,
  absPath: `mock://skills/${name}/SKILL.md`,
  title: name,
  description: null,
  runtime: null,
  category: null,
  tier: "core",
  valid: true,
  validationErrors: [],
  editable: false,
  dirty: false,
  contentHash: null,
  savedHash: null,
}));

export type SkillSourceKind = "linked" | "cloned" | "imported" | "managed" | "adopted" | "builtin";
export type SkillInstallTarget = "claude" | "codex";
export type SkillInstallMode = "symlink" | "copy";
export type SkillDispatchRuntime = "claude" | "codex";
export type SkillTier = "core" | "public" | "private" | "imported" | "managed";

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
  tier: SkillTier | string;
  valid?: boolean;
  validationErrors?: string[];
  editable: boolean;
  dirty: boolean;
  contentHash?: string | null;
  savedHash?: string | null;
}

export interface SkillInstall {
  skillId: string;
  target: SkillInstallTarget;
  installedAs: string;
  managedBy: "maru" | "external" | string;
  entrypointPath: string;
  targetPath: string;
  mode?: SkillInstallMode | string;
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

export interface SkillRuntimeStatus {
  runtime: SkillDispatchRuntime;
  available: boolean;
  binaryPath?: string | null;
  version?: string | null;
  authStatus: string;
  errorKind?: string | null;
  message: string;
  suggestedAction?: string | null;
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

export interface AgentRunEvent {
  id: string;
  runId: string;
  ts: string;
  type: string;
  actor: string;
  payload: unknown;
  schemaVersion: string;
  parentId?: string | null;
}

export interface RunReplaySummary {
  runId: string;
  eventCount: number;
  lastType?: string | null;
  proposalCount: number;
  writeClaimedCount: number;
  writeCommittedCount: number;
  writeConflictCount: number;
}

export interface RedactedRunSummary extends RunReplaySummary {
  providers: string[];
  skills: string[];
}

export interface SkillProposalFile {
  path: string;
  operation: "create" | "replace" | "append" | "delete" | string;
  content?: string | null;
  expectedHash?: string | null;
  diff?: string | null;
}

export interface SkillProposalCommand {
  command: string;
  cwd?: string | null;
  requiresApproval: boolean;
}

export interface SkillProposal {
  summary: string;
  files: SkillProposalFile[];
  commands: SkillProposalCommand[];
  risks: string[];
  requiresApproval: boolean;
  schemaVersion: string;
}

export interface ProposalApplyReport {
  summary: string;
  writes: Array<{
    path: string;
    operation: string;
    previousHash?: string | null;
    committedHash?: string | null;
  }>;
}

export interface MarketplaceSourceManifest {
  schemaVersion: string;
  sourceId: string;
  name: string;
  version: string;
  skillsSubdir: string;
  signed: boolean;
  signature?: string | null;
  repoUrl?: string | null;
}

export interface MarketplaceValidationReport {
  valid: boolean;
  errors: string[];
}

export interface AdoptOutcome {
  adopted: number;
  skipped: number;
  installs: SkillInstall[];
}

export interface SyncSourceResult {
  sourceId: string;
  kind: string;
  ok: boolean;
  skills: number;
  lastSyncedAt?: string | null;
  error?: string | null;
}

export interface SyncAllOutcome {
  total: number;
  succeeded: number;
  failed: number;
  results: SyncSourceResult[];
}

export interface InstallOutcome {
  install: SkillInstall;
  maruEntrypoint: string;
}

export interface ResetOutcome {
  backupPath?: string | null;
  sources: number;
  skills: number;
}

export interface DirtyRecord {
  skillId: string;
  name: string;
  sourceId: string;
  sourceKind: SkillSourceKind | string;
  tier: SkillTier | string;
  relPath: string;
  absPath: string;
  gitAvailable: boolean;
  gitRepoRoot?: string | null;
  contentHash?: string | null;
  savedHash?: string | null;
}

export interface ReconcileOutcome {
  skillId: string;
  name: string;
  action: "accept" | "discard" | string;
  dryRun: boolean;
  committed: boolean;
  pushed: boolean;
  hashUpdated: boolean;
  gitRepoRoot?: string | null;
  commands: string[];
  commandsShell?: "posix" | string | null;
  message: string;
}

export interface ImportOutcome {
  skill: SkillRecord;
  mode: "copy" | "link" | string;
  importedPath: string;
  maruEntrypoint: string;
}

export interface ImportUnmanageOutcome {
  name: string;
  removedInstalls: number;
  removedEntrypoint: boolean;
  deletedFiles: boolean;
}

export interface SkillDoctorIssue {
  severity: "error" | "warn" | "info" | string;
  code: string;
  skillName?: string | null;
  sourceIds: string[];
  message: string;
}

export interface SkillDoctorReport {
  ok: boolean;
  sources: number;
  skills: number;
  installs: number;
  issues: SkillDoctorIssue[];
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

export async function skillsSyncAllSources(
  workPath: string | null = null,
  progressId: string | null = null,
): Promise<SyncAllOutcome> {
  if (!isTauri()) return { total: 0, succeeded: 0, failed: 0, results: [] };
  return invoke<SyncAllOutcome>("skills_sync_all_sources", { workPath, progressId });
}

export async function skillsListSkills(
  workPath: string | null,
  options: { refresh?: boolean } = {},
): Promise<SkillRecord[]> {
  if (!isTauri()) return MOCK_BUILTIN_SKILLS;
  return invoke<SkillRecord[]>("skills_list_skills", {
    workPath,
    refresh: Boolean(options.refresh),
  });
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

export async function skillsSaveSkillAs(
  skillId: string,
  name: string,
  content: string,
): Promise<SkillRecord> {
  if (!isTauri()) throw new Error("Skill creation requires the Tauri shell.");
  return invoke<SkillRecord>("skills_save_skill_as", { skillId, name, content });
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
  mode: SkillInstallMode = "symlink",
): Promise<InstallOutcome> {
  if (!isTauri()) throw new Error("Skill install requires the Tauri shell.");
  return invoke<InstallOutcome>("skills_install_skill", { skillId, target, installedAs, mode });
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

export async function skillsDoctor(workPath: string | null): Promise<SkillDoctorReport> {
  if (!isTauri()) return { ok: true, sources: 0, skills: 0, installs: 0, issues: [] };
  return invoke<SkillDoctorReport>("skills_doctor", { workPath });
}

export async function skillsListDirty(workPath: string | null): Promise<DirtyRecord[]> {
  if (!isTauri()) return [];
  return invoke<DirtyRecord[]>("skills_list_dirty", { workPath });
}

export async function skillsReconcileSkill(params: {
  workPath: string | null;
  skill: string;
  action: "accept" | "discard";
  message?: string | null;
  dryRun?: boolean | null;
}): Promise<ReconcileOutcome> {
  if (!isTauri()) throw new Error("Skill reconcile requires the Tauri shell.");
  return invoke<ReconcileOutcome>("skills_reconcile_skill", params);
}

export async function skillsImportExternal(params: {
  workPath: string | null;
  sourcePath: string;
  name?: string | null;
  mode?: "copy" | "link" | null;
}): Promise<ImportOutcome> {
  if (!isTauri()) throw new Error("Skill import requires the Tauri shell.");
  return invoke<ImportOutcome>("skills_import_external", params);
}

export async function skillsImportUnmanage(params: {
  workPath: string | null;
  name: string;
  deleteFiles?: boolean | null;
}): Promise<ImportUnmanageOutcome> {
  if (!isTauri()) throw new Error("Skill import management requires the Tauri shell.");
  return invoke<ImportUnmanageOutcome>("skills_import_unmanage", params);
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

export interface SkillBundleRef {
  bundleId: string;
  revision: number;
  displayVersion: string;
  commit?: string | null;
  source: "bootstrap" | "remote";
  envHash: string;
  appliedAt: string;
}

export interface SkillBundleAvailable {
  bundleId: string;
  revision: number;
  displayVersion: string;
  commit?: string | null;
  publishedAt?: string | null;
  minAppVersion: string;
  envHash: string;
  archiveSize: number;
}

export interface SkillBundleStatus {
  appVersion: string;
  active?: SkillBundleRef | null;
  available?: SkillBundleAvailable | null;
  updateAvailable: boolean;
  dirtySkills: string[];
  staleCopyInstalls: string[];
  envUpdateRequired: boolean;
  minAppOk: boolean;
  autoApplicable: boolean;
}

export interface SkillBundleApplyOutcome {
  previous?: SkillBundleRef | null;
  current: SkillBundleRef;
  addedSkills: string[];
  updatedSkills: string[];
  removedSkills: string[];
  staleCopyInstalls: string[];
  removedInstalls: number;
  restartRequired: boolean;
}

export async function skillsBundleStatus(): Promise<SkillBundleStatus | null> {
  if (!isTauri()) return null;
  return invoke<SkillBundleStatus>("skills_bundle_status");
}

export async function skillsCheckBundleUpdate(
  force = false,
): Promise<SkillBundleStatus | null> {
  if (!isTauri()) return null;
  return invoke<SkillBundleStatus>("skills_check_bundle_update", { force });
}

export async function skillsApplyBundleUpdate(params: {
  bundleId?: string | null;
  repairEnv?: boolean;
  progressId?: string | null;
}): Promise<SkillBundleApplyOutcome | null> {
  if (!isTauri()) return null;
  return invoke<SkillBundleApplyOutcome>("skills_apply_bundle_update", {
    bundleId: params.bundleId ?? null,
    repairEnv: params.repairEnv ?? false,
    progressId: params.progressId ?? null,
  });
}

export async function skillsRuntimeStatus(params: {
  runtime: SkillDispatchRuntime;
  commandOverride?: string | null;
}): Promise<SkillRuntimeStatus> {
  if (!isTauri()) {
    return {
      runtime: params.runtime,
      available: true,
      binaryPath: `mock://${params.runtime}`,
      version: `${params.runtime} mock`,
      authStatus: "authenticated",
      errorKind: null,
      message: `${params.runtime} runtime ready`,
      suggestedAction: null,
    };
  }
  return invoke<SkillRuntimeStatus>("skills_runtime_status", params);
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
  commandOverride?: string | null;
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
  metadata?: MissionMetadata | null;
  commandOverride?: string | null;
  permissionMode?: string | null;
}): Promise<string> {
  if (!isTauri()) return `mock-skill-run-${params.runtime}-${Date.now()}`;
  return invoke<string>("skills_dispatch_background", params);
}

export async function agentReadRunEvents(
  cwd: string,
  runId: string,
): Promise<AgentRunEvent[]> {
  if (!isTauri()) return [];
  return invoke<AgentRunEvent[]>("agent_read_run_events", { cwd, runId });
}

export async function agentReplayRunSummary(
  cwd: string,
  runId: string,
): Promise<RunReplaySummary> {
  if (!isTauri()) {
    return {
      runId,
      eventCount: 0,
      lastType: null,
      proposalCount: 0,
      writeClaimedCount: 0,
      writeCommittedCount: 0,
      writeConflictCount: 0,
    };
  }
  return invoke<RunReplaySummary>("agent_replay_run_summary", { cwd, runId });
}

export async function agentExportRedactedRunSummary(
  cwd: string,
  runId: string,
): Promise<RedactedRunSummary> {
  if (!isTauri()) {
    return {
      runId,
      eventCount: 0,
      lastType: null,
      proposalCount: 0,
      writeClaimedCount: 0,
      writeCommittedCount: 0,
      writeConflictCount: 0,
      providers: [],
      skills: [],
    };
  }
  return invoke<RedactedRunSummary>("agent_export_redacted_run_summary", { cwd, runId });
}

/** Build the redacted summary backend-side and write it to `targetPath`.
 *  Returns the written path (there is no JS-side file write). */
export async function agentWriteRedactedRunSummary(
  cwd: string,
  runId: string,
  targetPath: string,
): Promise<string> {
  if (!isTauri()) throw new Error("Redacted summary export requires the Tauri shell.");
  return invoke<string>("agent_write_redacted_run_summary", { cwd, runId, targetPath });
}

export interface FiveRoleLoopResult {
  status: string;
  iterations: number;
  advisorCalled: boolean;
  roleOutputs: Array<{ role: string; content: string }>;
  proposal: SkillProposal | null;
  review: { passed: boolean; findings: string[] } | null;
}

/** Run the five-role structured loop against a real CLI provider. Returns the
 *  run id immediately; the loop runs in the background and emits run events
 *  (`proposal.created` etc.) + `ai://done`/`ai://error`, so the resulting
 *  proposal is reviewed/applied through the existing SkillRunsPanel path. */
export async function agentRunStructuredLoop(params: {
  provider: SkillDispatchRuntime;
  directive: string;
  cwd: string;
  highRisk?: boolean | null;
  ambiguous?: boolean | null;
  maxRework?: number | null;
  commandOverride?: string | null;
  permissionMode?: string | null;
}): Promise<string> {
  if (!isTauri()) return `mock-structured-loop-${params.provider}`;
  return invoke<string>("agent_run_structured_loop", {
    provider: params.provider,
    directive: params.directive,
    cwd: params.cwd,
    highRisk: params.highRisk ?? null,
    ambiguous: params.ambiguous ?? null,
    maxRework: params.maxRework ?? null,
    commandOverride: params.commandOverride ?? null,
    permissionMode: params.permissionMode ?? null,
  });
}

export async function agentParseSkillProposal(raw: string): Promise<SkillProposal> {
  if (!isTauri()) throw new Error("Proposal parsing requires the Tauri shell.");
  return invoke<SkillProposal>("agent_parse_skill_proposal", { raw });
}

export async function agentApplySkillProposal(params: {
  cwd: string;
  proposal: SkillProposal;
  approvalId: string;
  runId?: string | null;
}): Promise<ProposalApplyReport> {
  if (!isTauri()) throw new Error("Proposal apply requires the Tauri shell.");
  return invoke<ProposalApplyReport>("agent_apply_skill_proposal", {
    cwd: params.cwd,
    proposal: params.proposal,
    approvalId: params.approvalId,
    runId: params.runId ?? null,
  });
}

export async function agentValidateMarketplaceManifest(
  manifest: MarketplaceSourceManifest,
): Promise<MarketplaceValidationReport> {
  if (!isTauri()) return { valid: false, errors: ["tauri_required"] };
  return invoke<MarketplaceValidationReport>("agent_validate_marketplace_manifest", { manifest });
}
