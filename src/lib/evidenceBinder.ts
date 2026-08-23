import { invoke } from "@tauri-apps/api/core";
import { MOCK_VAULT_PATH } from "./fixtures";
import { IpcError, normalizeIpcError } from "./ipcError";
import { extractOutline } from "./markdown";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

const isTauri = () => typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);

export type LocalVerificationStatus = "unverified" | "verified";
export type SidecarStatus =
  | "none"
  | "unverified"
  | "verified"
  | "rejected"
  | "retired"
  | "unknown";

export interface EvidenceBinding {
  bindingId: string;
  candidateId?: string | null;
  evidenceSha256?: string | null;
  relPath: string;
  note?: string | null;
  sectionBindings: string[];
  kpiBindings: string[];
  submissionChecklistBindings: string[];
  localVerificationStatus: LocalVerificationStatus;
  verifiedAt?: string | null;
  includeInSubmission: boolean;
  submissionSelectedAt?: string | null;
  linkedAt: string;
}

export interface EvidenceBinderState {
  schemaVersion: 2;
  docId: string;
  documentPath?: string | null;
  bindings: EvidenceBinding[];
  updatedAt: string;
}

export interface EvidenceValidationCheck {
  name: string;
  status: "pass" | "fail" | "skipped" | string;
  reason?: string | null;
}

export interface EvidenceBinderCandidate {
  id: string;
  source: "sidecar" | "inboxProcessed" | string;
  path: string;
  relPath: string;
  title: string;
  evidenceKind?: string | null;
  businessUnit?: string | null;
  sizeBytes: number;
  updatedAt?: string | null;
  detectedFormat:
    | "hwpx"
    | "docx"
    | "xlsx"
    | "pdf"
    | "hwp"
    | "hwp3"
    | "hwpml"
    | "unknown"
    | string;
  validationChecks: EvidenceValidationCheck[];
  hwpFieldCount: number;
  hwpFieldLabels: string[];
  sidecarPath?: string | null;
  sidecarStatus: SidecarStatus;
  sidecarSha256?: string | null;
  companionFor?: string | null;
  inboxItemId?: string | null;
  summary?: string | null;
}

export interface EvidenceBinderResponse {
  state: EvidenceBinderState;
  candidates: EvidenceBinderCandidate[];
  revision: string;
}

export type EvidenceBinderMutation =
  | { type: "link"; candidateId: string }
  | { type: "unlink"; bindingId: string }
  | {
      type: "setTargets";
      bindingId: string;
      sectionBindings: string[];
      kpiBindings: string[];
      submissionChecklistBindings: string[];
    }
  | { type: "setNote"; bindingId: string; note?: string | null }
  | { type: "setLocalVerified"; bindingId: string; verified: boolean }
  | { type: "setIncludeInSubmission"; bindingId: string; include: boolean };

export interface EvidenceTargetSuggestions {
  sections: string[];
  kpis: string[];
  checklist: string[];
}

const mockBinderStates = new Map<string, EvidenceBinderResponse>();

export async function readEvidenceBinder(params: {
  workPath: string;
  docId: string;
  documentPath?: string | null;
}): Promise<EvidenceBinderResponse> {
  if (!isTauri()) {
    const key = `${params.workPath}:${params.docId}`;
    const existing = mockBinderStates.get(key);
    if (existing) return structuredClone(existing);
    const initial = mockEvidenceBinder(params.docId, params.documentPath);
    mockBinderStates.set(key, initial);
    return structuredClone(initial);
  }
  return invoke<EvidenceBinderResponse>("evidence_binder_read", { req: params });
}

export async function mutateEvidenceBinder(params: {
  workPath: string;
  docId: string;
  documentPath?: string | null;
  expectedRevision: string;
  mutation: EvidenceBinderMutation;
}): Promise<EvidenceBinderResponse> {
  try {
    if (!isTauri()) {
      const key = `${params.workPath}:${params.docId}`;
      const current =
        mockBinderStates.get(key) ?? mockEvidenceBinder(params.docId, params.documentPath);
      if (current.revision !== params.expectedRevision) {
        throw new IpcError({
          code: "evidence_binder_revision_conflict",
          message: `expected revision ${params.expectedRevision}, found ${current.revision}`,
        });
      }
      const next = applyMockMutation(current, params.mutation);
      mockBinderStates.set(key, next);
      return structuredClone(next);
    }
    return await invoke<EvidenceBinderResponse>("evidence_binder_mutate", { req: params });
  } catch (err) {
    throw normalizeIpcError(err);
  }
}

export function evidenceCandidateSummary(candidate: EvidenceBinderCandidate): string {
  const parts = [
    candidate.detectedFormat.toUpperCase(),
    candidate.evidenceKind ?? null,
    candidate.hwpFieldCount > 0 ? `${candidate.hwpFieldCount} HWP fields` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

export function evidenceTargetSuggestions(
  markdown: string,
  candidates: EvidenceBinderCandidate[],
): EvidenceTargetSuggestions {
  const sections = stableUnique(
    extractOutline(markdown).map((heading) => heading.text.replace(/\s+#+\s*$/, "").trim()),
  );
  const checklist = stableUnique([
    ...extractMarkdownTasks(markdown),
    ...candidates.flatMap((candidate) => candidate.hwpFieldLabels),
  ]);
  const kpis = stableUnique(
    sections.filter((value) => /\bKPI\b|성과\s*지표|핵심\s*성과|지표/i.test(value)),
  );
  return { sections, kpis, checklist };
}

export function splitEvidenceTargets(value: string): string[] {
  return stableUnique(
    value
      .split(/[,\n]/)
      .map((item) => item.replace(/\s+/g, " ").trim())
      .filter(Boolean),
  );
}

export function candidateCanBeLocallyVerified(
  candidate: EvidenceBinderCandidate,
  binding?: EvidenceBinding | null,
): boolean {
  return (
    !candidate.validationChecks.some((check) => check.status === "fail") &&
    candidate.sidecarStatus !== "rejected" &&
    candidate.sidecarStatus !== "retired" &&
    sidecarHashMatchesBinding(candidate, binding)
  );
}

export function bindingCanBeIncluded(
  binding: EvidenceBinding,
  candidate: EvidenceBinderCandidate | null,
): boolean {
  return (
    binding.localVerificationStatus === "verified" ||
    (candidate?.sidecarStatus === "verified" && sidecarHashMatchesBinding(candidate, binding))
  );
}

function sidecarHashMatchesBinding(
  candidate: EvidenceBinderCandidate,
  binding?: EvidenceBinding | null,
): boolean {
  if (!candidate.sidecarSha256) return true;
  const sidecarSha = candidate.sidecarSha256.replace(/^sha256:/i, "").toLowerCase();
  const evidenceSha = binding?.evidenceSha256?.replace(/^sha256:/i, "").toLowerCase();
  return Boolean(
    evidenceSha && sidecarSha === evidenceSha,
  );
}

function extractMarkdownTasks(markdown: string): string[] {
  const body = markdown.replace(/^---\n[\s\S]*?\n---\n?/, "");
  return body
    .split("\n")
    .map((line) => /^\s*[-*+]\s+\[[ xX]\]\s+(.+?)\s*$/.exec(line)?.[1] ?? "")
    .filter(Boolean);
}

function stableUnique(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => value.length > 0 && !seen.has(value) && Boolean(seen.add(value)));
}

function mockEvidenceBinder(
  docId: string,
  documentPath?: string | null,
): EvidenceBinderResponse {
  const now = "2026-05-24T09:00:00+09:00";
  return {
    state: {
      schemaVersion: 2,
      docId,
      documentPath,
      bindings: [],
      updatedAt: now,
    },
    revision: "mock:0",
    candidates: [
      {
        id: "ev_mock_receipt",
        source: "sidecar",
        path: `${MOCK_VAULT_PATH}/projects/sample/03-evidence-cert/receipt.pdf`,
        relPath: "projects/sample/03-evidence-cert/receipt.pdf",
        title: "receipt.pdf",
        evidenceKind: "receipt",
        businessUnit: "sample",
        sizeBytes: 128_000,
        updatedAt: now,
        detectedFormat: "pdf",
        validationChecks: [{ name: "pdf-structure", status: "pass" }],
        hwpFieldCount: 0,
        hwpFieldLabels: [],
        sidecarPath: `${MOCK_VAULT_PATH}/projects/sample/03-evidence-cert/receipt.pdf.evidence.yaml`,
        sidecarStatus: "verified",
        sidecarSha256: null,
        companionFor: null,
        inboxItemId: null,
        summary: "Mock receipt evidence",
      },
    ],
  };
}

function applyMockMutation(
  current: EvidenceBinderResponse,
  mutation: EvidenceBinderMutation,
): EvidenceBinderResponse {
  const now = new Date().toISOString();
  let bindings = current.state.bindings;
  if (mutation.type === "link") {
    const candidate = current.candidates.find((item) => item.id === mutation.candidateId);
    if (!candidate) throw new Error("evidence_binder_candidate_not_found");
    const bindingId = `sha256:${mutation.candidateId.padEnd(64, "0").slice(0, 64)}`;
    if (!bindings.some((binding) => binding.bindingId === bindingId)) {
      bindings = [
        ...bindings,
        {
          bindingId,
          candidateId: candidate.id,
          evidenceSha256: bindingId.slice(7),
          relPath: candidate.relPath,
          note: candidate.summary,
          sectionBindings: [],
          kpiBindings: [],
          submissionChecklistBindings: [],
          localVerificationStatus: "unverified",
          verifiedAt: null,
          includeInSubmission: false,
          submissionSelectedAt: null,
          linkedAt: now,
        },
      ];
    }
  } else if (mutation.type === "unlink") {
    bindings = bindings.filter((binding) => binding.bindingId !== mutation.bindingId);
  } else {
    bindings = bindings.map((binding) => {
      if (binding.bindingId !== mutation.bindingId) return binding;
      if (mutation.type === "setTargets") {
        return {
          ...binding,
          sectionBindings: mutation.sectionBindings,
          kpiBindings: mutation.kpiBindings,
          submissionChecklistBindings: mutation.submissionChecklistBindings,
        };
      }
      if (mutation.type === "setNote") return { ...binding, note: mutation.note };
      if (mutation.type === "setLocalVerified") {
        return {
          ...binding,
          localVerificationStatus: mutation.verified ? "verified" : "unverified",
          verifiedAt: mutation.verified ? now : null,
          includeInSubmission: mutation.verified ? binding.includeInSubmission : false,
          submissionSelectedAt: mutation.verified ? binding.submissionSelectedAt : null,
        };
      }
      return {
        ...binding,
        includeInSubmission: mutation.include,
        submissionSelectedAt: mutation.include ? now : null,
      };
    });
  }
  const revisionNumber = Number(current.revision.split(":")[1] ?? 0) + 1;
  return {
    ...current,
    revision: `mock:${revisionNumber}`,
    state: { ...current.state, bindings, updatedAt: now },
  };
}
