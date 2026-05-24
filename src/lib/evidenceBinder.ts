import { invoke } from "@tauri-apps/api/core";
import { MOCK_VAULT_PATH } from "./fixtures";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

const isTauri = () => typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);

export interface EvidenceBinding {
  candidateId: string;
  note?: string | null;
  verified: boolean;
  linkedAt?: string | null;
}

export interface EvidenceBinderState {
  schemaVersion: 1;
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
  detectedFormat: "hwpx" | "docx" | "xlsx" | "pdf" | "hwp" | "hwp3" | "hwpml" | "unknown" | string;
  validationChecks: EvidenceValidationCheck[];
  hwpFieldCount: number;
  hwpFieldLabels: string[];
  sidecarPath?: string | null;
  inboxItemId?: string | null;
  summary?: string | null;
}

export interface EvidenceBinderResponse {
  state: EvidenceBinderState;
  candidates: EvidenceBinderCandidate[];
}

export async function readEvidenceBinder(params: {
  workPath: string;
  docId: string;
  documentPath?: string | null;
}): Promise<EvidenceBinderResponse> {
  if (!isTauri()) return mockEvidenceBinder(params.docId, params.documentPath);
  return invoke<EvidenceBinderResponse>("evidence_binder_read", { req: params });
}

export async function saveEvidenceBinder(
  workPath: string,
  state: EvidenceBinderState,
): Promise<EvidenceBinderState> {
  const next = { ...state, updatedAt: new Date().toISOString() };
  if (!isTauri()) return next;
  return invoke<EvidenceBinderState>("evidence_binder_save", {
    req: { workPath, state: next },
  });
}

export function evidenceCandidateSummary(candidate: EvidenceBinderCandidate): string {
  const parts = [
    candidate.detectedFormat.toUpperCase(),
    candidate.evidenceKind ?? null,
    candidate.hwpFieldCount > 0 ? `${candidate.hwpFieldCount} HWP fields` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

function mockEvidenceBinder(
  docId: string,
  documentPath?: string | null,
): EvidenceBinderResponse {
  const now = "2026-05-24T09:00:00+09:00";
  return {
    state: {
      schemaVersion: 1,
      docId,
      documentPath,
      bindings: [],
      updatedAt: now,
    },
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
        inboxItemId: null,
        summary: "Mock receipt evidence",
      },
    ],
  };
}
