// M1 Operations Catalog client-side types + Tauri command wrappers.
// Phase 3 scaffold — Rust commands ship in W1, UI consumes here.

import { invoke } from "@tauri-apps/api/core";

export type DocCategory =
  | "formal-report"
  | "admin-approval"
  | "evidence-cert"
  | "operations";

export type CatalogItemKind =
  | "deadline-due"
  | "approval-in-flight"
  | "evidence-unlinked"
  | "inbox-pending"
  | "task-due";

export interface CatalogEntry {
  path: string;
  kind: CatalogItemKind;
  title: string;
  business_unit: string | null;
  category: DocCategory | null;
  deadline: string | null;
  approval_status: string | null;
  evidence_kind: string | null;
  last_updated: string;
}

export interface CatalogScanReport {
  scanned_at: string;
  entries_count: number;
  by_kind: Record<string, number>;
  bus_seen: string[];
  warnings: string[];
  elapsed_ms: number;
}

export interface CatalogDrilldownResponse {
  frontmatter_yaml: string | null;
  manifest_yaml: string | null;
  readme_excerpt: string | null;
  related_paths: string[];
}

export async function catalogScan(
  workspaceRoot: string,
  forceRefresh = false,
): Promise<CatalogScanReport> {
  return invoke<CatalogScanReport>("catalog_scan", {
    req: { workspace_root: workspaceRoot, force_refresh: forceRefresh },
  });
}

export interface CatalogQueryParams {
  workspaceRoot: string;
  businessUnit?: string;
  category?: DocCategory;
  kinds?: CatalogItemKind[];
  limit?: number;
}

export async function catalogQuery(params: CatalogQueryParams): Promise<CatalogEntry[]> {
  return invoke<CatalogEntry[]>("catalog_query", {
    req: {
      workspace_root: params.workspaceRoot,
      business_unit: params.businessUnit,
      category: params.category,
      kinds: params.kinds,
      limit: params.limit,
    },
  });
}

export async function catalogDrilldown(
  workspaceRoot: string,
  entryPath: string,
): Promise<CatalogDrilldownResponse> {
  return invoke<CatalogDrilldownResponse>("catalog_drilldown", {
    req: { workspace_root: workspaceRoot, entry_path: entryPath },
  });
}
