import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./api";
import { invokeE2EOverride } from "./e2eInvoke";
import { normalizeIpcError } from "./ipcError";
import type { ApprovalRequest, TaskNoteRow } from "./types";

export interface TaskCompletionToken {
  taskId: string;
  requestId: string;
  runId: string;
  generation: number;
}

export interface TaskCompletionView {
  required: boolean;
  sourceRevision: string;
  token?: TaskCompletionToken | null;
  receipt?: Record<string, unknown> | null;
  bindingRevision?: string | null;
  reviewRevision?: string | null;
  creatorPrincipal?: string | null;
  reviewProviders: string[];
  canReview: boolean;
  canAccept: boolean;
  acceptedCurrent: boolean;
  blockedReason?: string | null;
}

async function completionRequest<T>(workPath: string, request: Record<string, unknown>): Promise<T> {
  try {
    if (!isTauri()) {
      const result = await invokeE2EOverride<T>("task_completion", { workPath, request });
      if (result !== undefined && result !== null) return result;
      throw new Error("Task completion evidence requires the desktop app. Open this workspace in Maru and retry.");
    }
    return await invoke<T>("task_completion", { workPath, request });
  } catch (error) {
    throw normalizeIpcError(error);
  }
}

export function readTaskCompletion(workPath: string, taskPath: string): Promise<TaskCompletionView> {
  return completionRequest(workPath, { action: "read", taskPath });
}

export function setTaskCompletionPolicy(workPath: string, taskPath: string, required: boolean, expectedSourceRevision: string): Promise<TaskCompletionView> {
  return completionRequest(workPath, { action: "setPolicy", taskPath, required, expectedRevision: expectedSourceRevision });
}

export function startTaskCompletionReview(workPath: string, token: TaskCompletionToken, bindingRevision: string, provider: string, requestId: string): Promise<{ reviewRunId: string }> {
  return completionRequest(workPath, { action: "review", token, bindingRevision, provider, requestId });
}

export function prepareTaskCompletionAcceptance(workPath: string, token: TaskCompletionToken, reviewRevision: string): Promise<{ preparedRequest: ApprovalRequest }> {
  return completionRequest(workPath, { action: "prepareAcceptance", token, reviewRevision });
}

export function finalizeTaskCompletion(workPath: string, token: TaskCompletionToken, approvalId: string, reviewRevision: string): Promise<{ task: TaskNoteRow; receipt: Record<string, unknown>; duplicate: boolean }> {
  return completionRequest(workPath, { action: "finalize", token, approvalId, reviewRevision });
}
