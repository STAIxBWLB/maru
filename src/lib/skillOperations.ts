import { listen } from "@tauri-apps/api/event";
import { IpcError } from "./ipcError";
import { publishOperationNotice, type OperationNotice } from "./errorStore";
import type { SkillProgressEvent, SkillRecord, SyncAllOutcome } from "./skills";

type SkillResult = SkillRecord[] | SyncAllOutcome;
type Translate = (key: string, vars?: Record<string, string | number>) => string;

export interface SkillOperationClassification {
  kind: OperationNotice["kind"];
  key: string;
  reason?: string;
}

export interface SkillOperation<T = SkillResult> {
  operationId: string;
  workspace: string;
  sourceId: string | null;
  label: string;
  active: boolean;
  total: number;
  completed: number;
  message: string | null;
  errors: readonly string[];
  log: readonly string[];
  result?: T;
}
interface StartSkillOperation<T = SkillResult> {
  workspace: string;
  workspaceLabel: string;
  sourceId: string | null;
  label: string;
  total: number;
  execute: (progressId: string) => Promise<T>;
  t: Translate;
  classify?: (result: T) => SkillOperationClassification;
}
let snapshot: readonly SkillOperation<unknown>[] = [];
const subscribers = new Set<() => void>();
const running = new Map<string, Promise<SkillOperation<unknown>>>();
const keyFor = (workspace: string, sourceId: string | null) => JSON.stringify([workspace, sourceId]);
export const getSkillOperationsSnapshot = (): readonly SkillOperation<unknown>[] => snapshot;
export function subscribeSkillOperations(subscriber: () => void): () => void {
  subscribers.add(subscriber);
  return () => { subscribers.delete(subscriber); };
}
export function isSkillOperationActive(workspace: string, sourceId: string | null): boolean {
  return running.has(keyFor(workspace, sourceId));
}
export function getLatestSkillOperation(workspace: string): SkillOperation<unknown> | undefined {
  return snapshot.filter((operation) => operation.workspace === workspace).at(-1);
}

/** View refresh tickets expire on every navigation, including A -> B -> A. */
export function createSkillViewScope() {
  let generation = 0;
  let requestSequence = 0;
  let workspace: string | null = null;
  return {
    enter(next: string) { workspace = next; generation += 1; },
    leave() { workspace = null; generation += 1; },
    current(expected: string) {
      const ticket = generation;
      return () => workspace === expected && generation === ticket;
    },
    request(expected: string) {
      const ticket = ++requestSequence;
      const view = generation;
      return () => workspace === expected && generation === view && requestSequence === ticket;
    },
  };
}

/** The module owns mutation settlement and progress cleanup; view disposal only
 * removes subscribers. No queue, retry, persistence, or navigation side effect. */
export function startSkillOperation<T = SkillResult>(options: StartSkillOperation<T>): Promise<SkillOperation<T>> {
  const key = keyFor(options.workspace, options.sourceId);
  const existing = running.get(key);
  if (existing) return existing as unknown as Promise<SkillOperation<T>>;
  const operationId = crypto.randomUUID();
  let operation: SkillOperation<T> = Object.freeze({
    operationId, workspace: options.workspace, sourceId: options.sourceId,
    label: options.label, active: true, total: options.total, completed: 0,
    message: null, errors: [], log: [],
  });
  function publish(patch: Partial<SkillOperation<T>>) {
    operation = Object.freeze({ ...operation, ...patch });
    snapshot = [...snapshot.filter((item) => keyFor(item.workspace, item.sourceId) !== key), operation];
    for (const subscriber of subscribers) subscriber();
  }
  let off: (() => void) | undefined;
  let settled = false;
  // Start registration without making IPC depend on a possibly late listener.
  void Promise.resolve().then(() => listen<SkillProgressEvent>("skills-op://progress", ({ payload }) => {
    if (settled || payload.progressId !== operationId) return;
    publish({
      total: payload.total ?? operation.total,
      completed: payload.completed ?? operation.completed,
      message: payload.message,
      log: [...operation.log, `[${payload.level}] ${payload.message}`].slice(-100),
    });
  })).then((unlisten) => {
    if (settled) unlisten(); else off = unlisten;
  }).catch(() => { /* Mutation and its terminal notice remain authoritative. */ });

  const finish = (kind: OperationNotice["kind"], key: string, reason: string, result?: T) => {
    settled = true;
    try { off?.(); } catch { /* Cleanup cannot suppress the terminal result. */ }
    const message = options.t(key, { workspace: options.workspaceLabel, source: options.label, reason });
    running.delete(keyFor(options.workspace, options.sourceId));
    publish({ active: false, completed: operation.total, message, errors: kind === "error" ? [reason] : [], result });
    publishOperationNotice({ operationId, kind, message });
    return operation;
  };
  const promise = Promise.resolve().then(() => options.execute(operationId)).then((result) => {
    if (options.classify) {
      const classification = options.classify(result);
      return finish(classification.kind, classification.key, classification.reason ?? "", result);
    }
    const builtin = result as SkillResult;
    if (Array.isArray(builtin)) return finish("success", "skills.operation.success", "", result);
    const summary = options.t("system.skills.syncAllComplete", { succeeded: builtin.succeeded, failed: builtin.failed, skipped: builtin.skipped });
    const reasons = [summary, builtin.results.filter((item) => !item.ok).map((item) => `${item.sourceId}: ${item.error ?? ""}`).join("; ")].filter(Boolean).join("; ");
    if (builtin.failed > 0) {
      const stale = builtin.results.some((item) => item.errorCode === "skills_source_stale");
      return finish("error", stale ? "skills.operation.stale" : "skills.operation.failed", reasons, result);
    }
    if (builtin.skipped > 0) return finish("info", "skills.operation.skipped", reasons, result);
    return finish("success", "skills.operation.success", "", result);
  }, (error: unknown) => {
    const code = error instanceof IpcError ? error.code : null;
    const reason = error instanceof Error ? error.message : String(error);
    return finish(code === "skills_source_busy" ? "info" : "error",
      code === "skills_source_busy" ? "skills.operation.skipped" : code === "skills_source_stale" ? "skills.operation.stale" : "skills.operation.failed", reason);
  });
  running.set(key, promise);
  publish({});
  return promise;
}
