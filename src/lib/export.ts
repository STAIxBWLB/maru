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

export async function exportManifestLoad(manifestPath: string): Promise<ExportManifest> {
  return invoke<ExportManifest>("export_manifest_load", { manifestPath });
}

export interface ValidationEntry {
  format: ExportFormat;
  path: string;
  status: ValidationStatus;
  reason: string | null;
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

// ---------- W9 transition wrappers ----------

export async function exportRecordPending(
  manifestPath: string,
  format: ExportFormat,
): Promise<ExportManifest> {
  return invoke<ExportManifest>("export_record_pending", {
    req: { manifest_path: manifestPath, format },
  });
}

export async function exportRecordSuccess(
  manifestPath: string,
  format: ExportFormat,
  outputPath: string,
): Promise<ExportManifest> {
  return invoke<ExportManifest>("export_record_success", {
    req: {
      manifest_path: manifestPath,
      format,
      output_path: outputPath,
    },
  });
}

export async function exportRecordFailure(
  manifestPath: string,
  format: ExportFormat,
  reason: string,
): Promise<ExportManifest> {
  return invoke<ExportManifest>("export_record_failure", {
    req: {
      manifest_path: manifestPath,
      format,
      reason,
    },
  });
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
  return [
    `source: ${report.source_status}`,
    `pass: ${counts.pass}`,
    `missing: ${counts.missing}`,
    `hash-mismatch: ${counts["hash-mismatch"]}`,
    `skipped: ${counts.skipped}`,
  ].join(" · ");
}
