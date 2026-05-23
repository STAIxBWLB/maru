import { invoke } from "@tauri-apps/api/core";
import { frontmatterScalar } from "./document";
import type { CreateDocumentExtras } from "./api";
import type { DocumentPayload } from "./types";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

const isTauri = () => typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);

export const STUDIO_SCHEMA_VERSION = 1;

export const STUDIO_STEPS = [
  "source",
  "template",
  "guidelines",
  "sections",
  "hwp",
  "export",
  "package",
] as const;

export type StudioStep = (typeof STUDIO_STEPS)[number];
export type StudioSourceMode = "activeDocument" | "newDocument";

export interface StudioSourceState {
  mode: StudioSourceMode;
  documentPath: string | null;
  title: string;
  docType: string;
  targetRelPath: string | null;
}

export interface StudioTemplateState {
  id: string;
  slug: string;
  version: number;
  title: string;
  businessUnit: string | null;
  documentTypeCode: string | null;
}

export interface StudioHwpFieldsState {
  status: "placeholder";
  values: Record<string, string>;
}

export interface StudioExportState {
  formats: string[];
  manifestPath: string | null;
  summary: string | null;
  lastRunAt: string | null;
}

export interface StudioPackageState {
  frozen: boolean;
  frozenAt: string | null;
  snapshotPath: string | null;
}

export interface StudioState {
  schemaVersion: 1;
  docId: string;
  currentStep: StudioStep;
  source: StudioSourceState;
  template: StudioTemplateState | null;
  guidelineIds: string[];
  bodyDraft: string;
  hwpFields: StudioHwpFieldsState;
  export: StudioExportState;
  package: StudioPackageState;
  updatedAt: string;
}

export interface StudioStateSummary {
  docId: string;
  currentStep: StudioStep;
  documentPath: string | null;
  title: string;
  updatedAt: string;
}

export interface StudioCreateDocumentInput {
  title: string;
  docType: string;
  body: string;
  targetRelPath: string | null;
  extras?: CreateDocumentExtras;
}

export interface StudioPackageResult {
  document: DocumentPayload;
  snapshotPath: string;
  snapshotRelPath: string;
}

export function studioStepIndex(step: StudioStep): number {
  return Math.max(0, STUDIO_STEPS.indexOf(step));
}

export function nextStudioStep(step: StudioStep): StudioStep {
  return STUDIO_STEPS[Math.min(STUDIO_STEPS.length - 1, studioStepIndex(step) + 1)];
}

export function previousStudioStep(step: StudioStep): StudioStep {
  return STUDIO_STEPS[Math.max(0, studioStepIndex(step) - 1)];
}

export function sanitizeStudioDocId(input: string | null | undefined, fallback = "studio"): string {
  const base = (input ?? "")
    .trim()
    .replace(/\.md$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.+/g, ".")
    .replace(/^\.+/, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return base || fallback;
}

export function studioDocIdFromDocument(document: DocumentPayload | null): string {
  if (!document) return sanitizeStudioDocId(`studio-${Date.now()}`);
  const frontmatterId = frontmatterScalar(document.meta, "id");
  if (frontmatterId) return sanitizeStudioDocId(frontmatterId, "studio-document");
  return sanitizeStudioDocId(document.relPath || document.path, "studio-document");
}

export function createInitialStudioState(document: DocumentPayload | null): StudioState {
  const now = new Date().toISOString();
  return {
    schemaVersion: STUDIO_SCHEMA_VERSION,
    docId: studioDocIdFromDocument(document),
    currentStep: "source",
    source: {
      mode: document ? "activeDocument" : "newDocument",
      documentPath: document?.path ?? null,
      title: document?.title ?? "",
      docType: frontmatterScalar(document?.meta, "type") ?? "report",
      targetRelPath: document?.relPath ?? null,
    },
    template: null,
    guidelineIds: [],
    bodyDraft: document?.body ?? "",
    hwpFields: {
      status: "placeholder",
      values: {},
    },
    export: {
      formats: ["docx", "hwpx", "pdf"],
      manifestPath: null,
      summary: null,
      lastRunAt: null,
    },
    package: {
      frozen: false,
      frozenAt: null,
      snapshotPath: null,
    },
    updatedAt: now,
  };
}

export async function studioStateList(workPath: string): Promise<StudioStateSummary[]> {
  if (!isTauri()) return [];
  return invoke<StudioStateSummary[]>("studio_state_list", { workPath });
}

export async function studioStateRead(
  workPath: string,
  docId: string,
): Promise<StudioState | null> {
  if (!isTauri()) return null;
  return invoke<StudioState | null>("studio_state_read", { workPath, docId });
}

export async function studioStateSave(workPath: string, state: StudioState): Promise<StudioState> {
  if (!isTauri()) return { ...state, updatedAt: new Date().toISOString() };
  return invoke<StudioState>("studio_state_save", { workPath, state });
}

export async function studioStateDelete(workPath: string, docId: string): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>("studio_state_delete", { workPath, docId });
}

export async function studioApplyBody(
  workPath: string,
  documentPath: string,
  bodyMarkdown: string,
): Promise<DocumentPayload> {
  if (!isTauri()) throw new Error("studio_apply_body_requires_tauri");
  return invoke<DocumentPayload>("studio_apply_body", {
    workPath,
    documentPath,
    bodyMarkdown,
  });
}
