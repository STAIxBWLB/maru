// hwp-editor engine bridge — typed wrappers over the hwped_* Rust commands
// (src-tauri/src/hwped.rs). Mirrors the @hwp-editor/core protocol.ts wire
// shapes (kept as local types until @hwp-editor/core is vendored). See
// docs/hwp-editor.md for the full integration path.

import { invoke } from "@tauri-apps/api/core";

/** How a document crosses the bridge: a workspace path when the bytes are
 *  already on disk (preferred), base64 bytes otherwise. */
export interface HwpedDocumentRef {
  /** File name, including the .hwp/.hwpx extension. */
  name: string;
  /** Workspace-relative (or absolute) path; requires workspaceRoot when relative. */
  path?: string;
  /** Base64-encoded bytes — only when the document is not on disk. */
  dataBase64?: string;
}

/** `hwp cat --format markdown --with-segments` envelope. */
export interface HwpedCatEnvelope {
  markdown: string;
  segments: {
    start: number;
    end: number;
    kind: string;
    section: number;
    para: number;
  }[];
}

export interface HwpedRenderOptions {
  /** Page range: "1", "1-3", "all" (default "all"). */
  pages?: string;
  /** Resolution, 36..=600 (default 96). */
  dpi?: number;
  /** "svg" (default) or "png". */
  format?: "svg" | "png";
}

export interface HwpedRenderPage {
  page: number;
  width: number;
  height: number;
  dpi: number;
  format: string;
  dataBase64: string;
}

export interface HwpedRenderResponse {
  pages: HwpedRenderPage[];
}

export interface HwpedEditResponse {
  name: string;
  dataBase64: string;
}

export interface HwpedComposeResponse {
  name: string;
  dataBase64: string;
  report?: unknown;
}

export interface HwpedValidationError {
  code: string;
  message: string;
}

export interface HwpedValidationReport {
  valid: boolean;
  errors: HwpedValidationError[];
}

export interface HwpedCapabilities {
  version: string;
  editable: boolean;
  formats: string[];
}

export async function hwpedRead(
  document: HwpedDocumentRef,
  workspaceRoot?: string,
): Promise<HwpedCatEnvelope> {
  return invoke<HwpedCatEnvelope>("hwped_read", {
    document,
    workspaceRoot: workspaceRoot ?? null,
  });
}

export async function hwpedRender(
  document: HwpedDocumentRef,
  options?: HwpedRenderOptions,
  workspaceRoot?: string,
): Promise<HwpedRenderResponse> {
  return invoke<HwpedRenderResponse>("hwped_render", {
    document,
    options: options ?? null,
    workspaceRoot: workspaceRoot ?? null,
  });
}

/** `opsArgv` is @hwp-editor/core `opsToArgv(ops)` output: `--flag value`
 *  pairs, spliced into `hwp edit` verbatim (no shell anywhere). */
export async function hwpedEdit(
  document: HwpedDocumentRef,
  opsArgv: string[],
  options?: { verify?: boolean; allowPartial?: boolean },
  workspaceRoot?: string,
): Promise<HwpedEditResponse> {
  return invoke<HwpedEditResponse>("hwped_edit", {
    document,
    opsArgv,
    verify: options?.verify ?? null,
    allowPartial: options?.allowPartial ?? null,
    workspaceRoot: workspaceRoot ?? null,
  });
}

export async function hwpedCompose(
  spec: unknown,
  name: string,
): Promise<HwpedComposeResponse> {
  return invoke<HwpedComposeResponse>("hwped_compose", { spec, name });
}

export async function hwpedValidate(
  document: HwpedDocumentRef,
  workspaceRoot?: string,
): Promise<HwpedValidationReport> {
  return invoke<HwpedValidationReport>("hwped_validate", {
    document,
    workspaceRoot: workspaceRoot ?? null,
  });
}

export async function hwpedCapabilities(): Promise<HwpedCapabilities> {
  return invoke<HwpedCapabilities>("hwped_capabilities");
}
