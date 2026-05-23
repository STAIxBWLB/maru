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
  hwpxTemplateKey: string | null;
}

export interface StudioHwpTemplateFieldState {
  key: string;
  label: string;
  required: boolean;
  occurrences: number;
  source?: "placeholder" | "formLabel" | "inlineLabel" | string;
  confidence?: number;
  matchedKey?: string | null;
}

export type StudioHwpFieldsStatus =
  | "placeholder"
  | "ready"
  | "filled"
  | "manualFallback"
  | "error";

export interface StudioHwpFieldsState {
  status: StudioHwpFieldsStatus;
  templatePath: string | null;
  fields: StudioHwpTemplateFieldState[];
  values: Record<string, string>;
  lastOutputPath: string | null;
  formFilledCount: number;
  unmatchedFields: string[];
  validationChecks: TemplateValidationCheck[];
  warnings: string[];
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
  lintDismissals: string[];
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

export interface TemplateFieldRequest {
  templateKey?: string | null;
  templatePath?: string | null;
}

export interface TemplateFieldResponse {
  templatePath: string;
  source: "workspace" | "bundled" | string;
  fields: StudioHwpTemplateFieldState[];
  warnings: string[];
}

export interface TemplatePrepareResponse {
  inputPath: string;
  preparedPath: string | null;
  status: "ready" | "manualFallback" | string;
  reason: string | null;
}

export interface TemplateFillRequest {
  templateKey?: string | null;
  templatePath?: string | null;
  values: Record<string, string>;
  outputPath?: string | null;
}

export interface TemplateValidationCheck {
  name: string;
  status: "pass" | "fail" | "skipped" | string;
  reason?: string | null;
}

export interface TemplateFillResponse {
  outputPath: string;
  replacedCount: number;
  validationOk: boolean;
  command: string;
  formFilledCount: number;
  unmatchedFields: string[];
  validationChecks: TemplateValidationCheck[];
  warnings: string[];
}

export interface GaejosikLintIssue {
  id: string;
  rule: "formalVerbEnding" | "declarativeEnding" | string;
  severity: "warning" | "error" | string;
  line: number;
  column: number;
  endColumn: number;
  text: string;
  message: string;
  suggestion: string;
}

export interface GaejosikLintResponse {
  issues: GaejosikLintIssue[];
  dismissedCount: number;
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
    lintDismissals: [],
    hwpFields: {
      status: "placeholder",
      templatePath: null,
      fields: [],
      values: {},
      lastOutputPath: null,
      formFilledCount: 0,
      unmatchedFields: [],
      validationChecks: [],
      warnings: [],
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

export function normalizeStudioState(state: StudioState): StudioState {
  return {
    ...state,
    template: state.template
      ? {
          ...state.template,
          hwpxTemplateKey: state.template.hwpxTemplateKey ?? null,
        }
      : null,
    guidelineIds: state.guidelineIds ?? [],
    lintDismissals: state.lintDismissals ?? [],
    hwpFields: {
      status: state.hwpFields?.status ?? "placeholder",
      templatePath: state.hwpFields?.templatePath ?? null,
      fields: state.hwpFields?.fields ?? [],
      values: state.hwpFields?.values ?? {},
      lastOutputPath: state.hwpFields?.lastOutputPath ?? null,
      formFilledCount: state.hwpFields?.formFilledCount ?? 0,
      unmatchedFields: state.hwpFields?.unmatchedFields ?? [],
      validationChecks: state.hwpFields?.validationChecks ?? [],
      warnings: state.hwpFields?.warnings ?? [],
    },
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
  const state = await invoke<StudioState | null>("studio_state_read", { workPath, docId });
  return state ? normalizeStudioState(state) : null;
}

export async function studioStateSave(workPath: string, state: StudioState): Promise<StudioState> {
  const normalized = normalizeStudioState(state);
  if (!isTauri()) return { ...normalized, updatedAt: new Date().toISOString() };
  return invoke<StudioState>("studio_state_save", { workPath, state: normalized });
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

export async function templateGetFields(
  workPath: string,
  request: TemplateFieldRequest,
): Promise<TemplateFieldResponse> {
  if (!isTauri()) {
    return {
      templatePath: request.templatePath ?? request.templateKey ?? "",
      source: request.templatePath ? "workspace" : "bundled",
      fields: [],
      warnings: ["HWPX field extraction requires the desktop runtime."],
    };
  }
  return invoke<TemplateFieldResponse>("template_get_fields", { workPath, request });
}

export async function templatePrepareHwpxTemplate(
  workPath: string,
  sourcePath: string,
): Promise<TemplatePrepareResponse> {
  if (!isTauri()) throw new Error("template_prepare_requires_tauri");
  return invoke<TemplatePrepareResponse>("template_prepare_hwpx_template", {
    workPath,
    sourcePath,
  });
}

export async function templateFillHwpx(
  workPath: string,
  request: TemplateFillRequest,
): Promise<TemplateFillResponse> {
  if (!isTauri()) throw new Error("template_fill_requires_tauri");
  return invoke<TemplateFillResponse>("template_fill_hwpx", { workPath, request });
}

export async function gaejosikLint(
  workPath: string,
  bodyMarkdown: string,
  dismissedIds: string[],
): Promise<GaejosikLintResponse> {
  if (!isTauri()) return lintGaejosikBrowser(bodyMarkdown, dismissedIds);
  return invoke<GaejosikLintResponse>("gaejosik_lint", {
    workPath,
    bodyMarkdown,
    dismissedIds,
  });
}

function lintGaejosikBrowser(
  bodyMarkdown: string,
  dismissedIds: string[],
): GaejosikLintResponse {
  const dismissed = new Set(dismissedIds);
  const issues: GaejosikLintIssue[] = [];
  let dismissedCount = 0;
  let inCodeFence = false;
  let inFrontmatter = bodyMarkdown.split(/\r?\n/, 1)[0]?.trim() === "---";
  const lines = bodyMarkdown.split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (index > 0 && inFrontmatter && trimmed === "---") {
      inFrontmatter = false;
      return;
    }
    if (inFrontmatter) return;
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inCodeFence = !inCodeFence;
      return;
    }
    if (inCodeFence || shouldSkipLintLine(trimmed)) return;
    const match = matchGaejosikLine(line);
    if (!match) return;
    const lineNumber = index + 1;
    const { column, endColumn } = matchedLintSpan(line, match.text);
    const id = browserIssueId(match.rule, lineNumber, column, line);
    if (dismissed.has(id)) {
      dismissedCount += 1;
      return;
    }
    issues.push({
      id,
      rule: match.rule,
      severity: "warning",
      line: lineNumber,
      column,
      endColumn,
      text: match.text,
      message: match.message,
      suggestion: match.suggestion,
    });
  });
  return { issues, dismissedCount };
}

function shouldSkipLintLine(trimmed: string): boolean {
  return (
    !trimmed ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("|") ||
    trimmed.startsWith(">") ||
    trimmed === "---" ||
    Array.from(trimmed).every((char) => char === "-" || char === ":" || char === "|")
  );
}

function matchGaejosikLine(line: string):
  | {
      rule: "formalVerbEnding" | "declarativeEnding";
      text: string;
      message: string;
      suggestion: string;
    }
  | null {
  const stripped = stripMarkdownPrefix(line).trimEnd();
  const core = stripped.replace(/[.。!?)\]"']+$/u, "");
  const formalEndings = [
    "하였습니다",
    "되었습니다",
    "했습니다",
    "됩니다",
    "합니다",
    "있습니다",
    "없습니다",
    "드립니다",
    "입니다",
    "였습니다",
  ];
  const formal = formalEndings.find((ending) => core.endsWith(ending));
  if (formal) {
    return {
      rule: "formalVerbEnding",
      text: formal,
      message: "격식체 문장 종결은 개조식 문서에서 눈에 띕니다.",
      suggestion: "명사형 종결(예: 추진, 완료, 필요) 또는 함/임/됨으로 정리",
    };
  }
  if (core.endsWith("다")) {
    return {
      rule: "declarativeEnding",
      text: "다",
      message: "서술형 종결은 개조식 톤과 맞지 않습니다.",
      suggestion: "문장 끝을 명사형 또는 함/임/됨 형태로 축약",
    };
  }
  return null;
}

function matchedLintSpan(line: string, suffix: string): { column: number; endColumn: number } {
  const stripped = stripMarkdownPrefix(line).trimEnd();
  const core = stripped.replace(/[.。!?)\]"']+$/u, "");
  const startIndex = Math.max(0, line.indexOf(stripped));
  const prefixLength = Array.from(line.slice(0, startIndex)).length;
  const coreLength = Array.from(core).length;
  const suffixLength = Array.from(suffix).length;
  return {
    column: Math.max(1, prefixLength + coreLength - suffixLength + 1),
    endColumn: Math.max(1, prefixLength + coreLength + 1),
  };
}

function stripMarkdownPrefix(line: string): string {
  const trimmed = line.trimStart();
  const checkbox = trimmed.match(/^- \[[ xX]\] (.*)$/u);
  if (checkbox) return checkbox[1] ?? "";
  const bullet = trimmed.match(/^[-*+] (.*)$/u);
  if (bullet) return bullet[1] ?? "";
  const numbered = trimmed.match(/^\d+\. (.*)$/u);
  if (numbered) return numbered[1] ?? "";
  return trimmed;
}

function browserIssueId(rule: string, line: number, column: number, text: string): string {
  const source = `${rule}:${line}:${column}:${text.trim()}`;
  let hash = 0;
  for (let index = 0; index < source.length; index += 1) {
    hash = (hash * 31 + source.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
