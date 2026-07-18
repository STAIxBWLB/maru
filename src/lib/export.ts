// M4 Export Pipeline (Phase 4 W8) — client-side wrappers + types.
// Spec: plan §M4, src-tauri/src/export/.

import { invoke } from "@tauri-apps/api/core";

export type ExportFormat = "docx" | "hwpx" | "pdf";
export type ExportOutputStatus = "planned" | "pending" | "ready" | "failed";
export type ValidationStatus = "pass" | "missing" | "hash-mismatch" | "skipped";

export interface ExportOutputEntry {
  format: ExportFormat;
  path: string;
  status: ExportOutputStatus;
  sha256: string | null;
  byte_size: number | null;
  reason: string | null;
}

export interface ExportManifest {
  schema_version: number;
  source: string;
  source_sha256: string;
  source_byte_size: number;
  generated_at: string;
  outputs: ExportOutputEntry[];
}

export interface ExportPlanRequest {
  workspaceRoot: string;
  sourcePath: string;
  formats: ExportFormat[];
  outputDir?: string;
}

export interface ExportPlanResponse {
  manifest_path: string;
  manifest: ExportManifest;
}

export async function exportPlan(req: ExportPlanRequest): Promise<ExportPlanResponse> {
  return invoke<ExportPlanResponse>("export_plan", {
    req: {
      workspace_root: req.workspaceRoot,
      source_path: req.sourcePath,
      formats: req.formats,
      output_dir: req.outputDir,
    },
  });
}

export interface ValidationEntry {
  format: ExportFormat;
  path: string;
  status: ValidationStatus;
  reason: string | null;
  checks: ValidationCheck[];
}

export interface ValidationCheck {
  name: string;
  status: "pass" | "fail" | "skipped" | string;
  reason?: string | null;
}

export interface ValidationReport {
  manifest_path: string;
  source_path: string;
  source_status: ValidationStatus;
  entries: ValidationEntry[];
}

export async function exportValidate(manifestPath: string): Promise<ValidationReport> {
  return invoke<ValidationReport>("export_validate", { manifestPath });
}

export interface ExportDispatchResult {
  format: ExportFormat;
  output_path: string;
  success: boolean;
  command: string;
  reason?: string | null;
}

export interface ExportDispatchResponse {
  manifest_path: string;
  manifest: ExportManifest;
  validation: ValidationReport;
  results: ExportDispatchResult[];
}

export async function exportDispatch(params: {
  workspaceRoot: string;
  manifestPath: string;
  formats?: ExportFormat[];
}): Promise<ExportDispatchResponse> {
  return invoke<ExportDispatchResponse>("export_dispatch", {
    req: {
      workspace_root: params.workspaceRoot,
      manifest_path: params.manifestPath,
      formats: params.formats ?? [],
    },
  });
}

/**
 * Summary string for an ExportDispatchResponse (palette/status surfaces).
 *
 * Export can finish with partial failures when a converter is missing or a
 * source hash changed. Keep that visible instead of calling every run success.
 */
export function summarizeDispatch(response: ExportDispatchResponse): string {
  const ready = response.results.filter((result) => result.success).length;
  const failed = response.results.length - ready;
  const firstFailureReason = response.results
    .find((result) => !result.success && result.reason?.trim())
    ?.reason?.trim();
  const parts = [`ready: ${ready}`, `failed: ${failed}`, summarizeValidation(response.validation)];
  if (firstFailureReason) {
    parts.push(`first failure: ${firstFailureReason}`);
  }
  return parts.join(" · ");
}

/**
 * Summary string for a ValidationReport (palette/status surfaces).
 */
export function summarizeValidation(report: ValidationReport): string {
  const counts: Record<ValidationStatus, number> = {
    pass: 0,
    missing: 0,
    "hash-mismatch": 0,
    skipped: 0,
  };
  for (const entry of report.entries) counts[entry.status]++;
  const failedChecks = report.entries.flatMap((entry) => entry.checks ?? []).filter((check) => check.status === "fail").length;
  return [
    `source: ${report.source_status}`,
    `pass: ${counts.pass}`,
    `missing: ${counts.missing}`,
    `hash-mismatch: ${counts["hash-mismatch"]}`,
    `skipped: ${counts.skipped}`,
    `checks failed: ${failedChecks}`,
  ].join(" · ");
}
