import { activeLocale, t } from "./i18n";
import { publishOperationNotice, type OperationNotice } from "./errorStore";

export type ProcessingCompletionStatus =
  | "all-success"
  | "partial-success"
  | "all-failed"
  | "empty"
  | "manual";

export interface ProcessingFailure {
  label: string;
  reason: string;
}

export interface ProcessingCompletion {
  status: ProcessingCompletionStatus;
  succeeded: readonly string[];
  failed: readonly ProcessingFailure[];
  detail?: string;
}

export interface ProcessingOperationContext {
  operationId: string;
  workspace: string;
  labelKey: string;
  progressId?: string | null;
  outerOperationId?: string | null;
}

export interface ProcessingWrapperOptions {
  operationId?: string;
  outerOperationId?: string | null;
}

export interface ProcessingOperationRecord {
  operationId: string;
  workspace: string;
  labelKey: string;
  progressId: string | null;
  status: "active" | "settled";
  completion: ProcessingCompletion | null;
  settledAt: string | null;
}

let snapshot: readonly ProcessingOperationRecord[] = [];
const subscribers = new Set<() => void>();

export function getProcessingOperationsSnapshot(): readonly ProcessingOperationRecord[] {
  return snapshot;
}

export function getProcessingOperation(
  operationId: string,
): ProcessingOperationRecord | undefined {
  return snapshot.find((record) => record.operationId === operationId);
}

export function subscribeProcessingOperations(subscriber: () => void): () => void {
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
}

function noticeKind(status: ProcessingCompletionStatus): OperationNotice["kind"] {
  if (status === "all-success") return "success";
  if (status === "all-failed") return "error";
  return "info";
}

function noticeKey(status: ProcessingCompletionStatus): string {
  if (status === "all-success") return "processing.operation.success";
  if (status === "partial-success") return "processing.operation.partial";
  if (status === "all-failed") return "processing.operation.failed";
  if (status === "manual") return "processing.operation.manual";
  return "processing.operation.empty";
}

function formatNoticeMessage(
  context: ProcessingOperationContext,
  completion: ProcessingCompletion,
): string {
  const locale = activeLocale();
  const reason =
    completion.detail?.trim() ||
    completion.failed.map((failure) => `${failure.label}: ${failure.reason}`).join("; ");
  return t(locale, noticeKey(completion.status), {
    workspace: context.workspace,
    label: t(locale, context.labelKey),
    succeeded: completion.succeeded.length,
    failed: completion.failed.length,
    reason,
  });
}

function rejectionReason(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    const record = error as { code?: unknown; message?: unknown };
    if (typeof record.message === "string") {
      const code = typeof record.code === "string" && record.code ? `${record.code}: ` : "";
      return `${code}${record.message}`;
    }
  }
  return String(error);
}

export function runProcessingOperation<T>(
  context: ProcessingOperationContext,
  run: () => Promise<T>,
  classifyResult: (result: T) => ProcessingCompletion | null,
): Promise<T> {
  let settled = false;
  let record: ProcessingOperationRecord = Object.freeze({
    operationId: context.operationId,
    workspace: context.workspace,
    labelKey: context.labelKey,
    progressId: context.progressId ?? null,
    status: "active",
    completion: null,
    settledAt: null,
  });
  snapshot = [...snapshot, record];
  for (const subscriber of subscribers) subscriber();

  const finish = (completion: ProcessingCompletion | null) => {
    if (settled) return;
    settled = true;
    record = Object.freeze({ ...record, status: "settled", completion, settledAt: new Date().toISOString() });
    snapshot = snapshot.map((item) =>
      item.operationId === context.operationId ? record : item,
    );
    for (const subscriber of subscribers) subscriber();
    if (completion && !context.outerOperationId) {
      publishOperationNotice({
        operationId: context.operationId,
        kind: noticeKind(completion.status),
        message: formatNoticeMessage(context, completion),
      });
    }
  };

  return Promise.resolve()
    .then(run)
    .then(
      (result) => {
        let completion: ProcessingCompletion | null;
        try {
          completion = classifyResult(result);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          completion = {
            status: "all-failed",
            succeeded: [],
            failed: [{ label: "classifier", reason: reason.trim() || "classification failed" }],
          };
          finish(completion);
          throw error;
        }
        finish(completion);
        return result;
      },
      (error: unknown) => {
        const reason = rejectionReason(error);
        finish({
          status: "all-failed",
          succeeded: [],
          failed: [{ label: "operation", reason: reason.trim() || "unknown error" }],
        });
        throw error;
      },
    );
}
