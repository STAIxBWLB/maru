// M7 Hub Connector client-side types + Tauri command wrappers.
// Spec: ~/workspace/work/_sys/rules/hub-sync.md

import { invoke } from "@tauri-apps/api/core";

export type HubDeploymentMode = "public" | "private";

export interface HubStatus {
  enabled: boolean;
  endpoint: string;
  deployment_mode: HubDeploymentMode;
  reachable: boolean;
  cached_etags_count: number;
  last_fetch_at: string | null;
  queue_depth: number;
}

export async function hubStatus(workspaceRoot: string): Promise<HubStatus> {
  return invoke<HubStatus>("hub_status", { workspaceRoot });
}

export type HubResource =
  | "templates"
  | "guidelines"
  | "glossary"
  | "context_packs"
  | "evidence_index"
  | "kpi_status"
  | "submission_gates";

export interface HubFetchRequest {
  workspaceRoot: string;
  resource: HubResource;
  params?: Record<string, string>;
  revalidate?: boolean;
}

export interface HubFetchResponse {
  from_cache: boolean;
  etag: string | null;
  body_json: string;
  fetched_at: string;
}

export async function hubFetchCatalog(req: HubFetchRequest): Promise<HubFetchResponse> {
  return invoke<HubFetchResponse>("hub_fetch_catalog", {
    req: {
      workspace_root: req.workspaceRoot,
      resource: req.resource,
      params: req.params ?? {},
      revalidate: req.revalidate ?? false,
    },
  });
}

export interface HubSubmitGateRequest {
  workspaceRoot: string;
  programId: string;
  businessUnitId: string;
  documentUri: string;
  documentType: string;
  documentSha256: string;
  submissionKind: string;
  targetOrg: string;
  deadline?: string;
  evidenceSha256List: string[];
  frontmatterSnapshot: Record<string, unknown>;
  notes?: string;
}

export interface HubSubmitGateResponse {
  gate_id: string | null;
  state: string;
  queued_at: string | null;
  created_at: string | null;
}

export async function hubSubmitGate(
  req: HubSubmitGateRequest,
): Promise<HubSubmitGateResponse> {
  return invoke<HubSubmitGateResponse>("hub_submit_gate", {
    req: {
      workspace_root: req.workspaceRoot,
      program_id: req.programId,
      business_unit_id: req.businessUnitId,
      document_uri: req.documentUri,
      document_type: req.documentType,
      document_sha256: req.documentSha256,
      submission_kind: req.submissionKind,
      target_org: req.targetOrg,
      deadline: req.deadline,
      evidence_sha256_list: req.evidenceSha256List,
      frontmatter_snapshot: req.frontmatterSnapshot,
      notes: req.notes,
    },
  });
}
