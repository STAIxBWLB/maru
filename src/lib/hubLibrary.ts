// Phase 3 W5 — Hub Library client.
//
// Builds on `hubFetchCatalog` and parses the JSON body into typed values
// for the NewDocumentDialog template/guideline pickers and (later) a
// dedicated Library pane. Memoizes responses per workspaceRoot+resource
// for the lifetime of the page so the dialog opens instantly after the
// first fetch; explicit `forceRefresh` rebuilds the cache by passing
// `revalidate: true` down to the Tauri command (which then sends
// If-None-Match to Hub).

import { hubFetchCatalog, hubStatus, type HubResource, type HubStatus } from "./hubClient";

// ---------- Types matching anchor_hub/domain/catalog.py ----------

export type DocumentCategory =
  | "formal_report"
  | "admin_approval"
  | "evidence_certification"
  | "operational";

export interface BusinessUnit {
  id: string;
  slug: string;
  name: string;
  kind: string;
  deployment_scope: "public" | "private";
  parent_bu_id?: string | null;
}

export interface DocumentType {
  id: string;
  code: string;
  label_ko: string;
  label_en: string;
  category: DocumentCategory;
  hwpx_template_key?: string | null;
  default_workflow_id?: string | null;
}

export interface TemplateAsset {
  id: string;
  role: string;
  filename: string;
  sort_order: number;
  blob_id: string;
  blob_sha256?: string | null;
  blob_mime_type?: string | null;
  blob_storage_uri?: string | null;
}

export interface TemplateSummary {
  id: string;
  slug: string;
  title: string;
  version: number;
  document_type_code: string;
  document_type_category: DocumentCategory;
  business_unit_slug?: string | null;
  source: "hwpx_skill" | "work_repo" | "vocational_ssot" | "manual";
  hwpx_template_key?: string | null;
  summary?: string | null;
  updated_at: string;
}

export interface Template extends TemplateSummary {
  body_markdown: string;
  frontmatter_schema: Record<string, unknown>;
  assets: TemplateAsset[];
  is_current: boolean;
  created_at: string;
}

export interface GuidelineSummary {
  id: string;
  slug: string;
  title: string;
  scope: "global" | "business_unit" | "document_type";
  business_unit_slug?: string | null;
  document_type_code?: string | null;
  applies_to_categories: string[];
  version: number;
  updated_at: string;
}

export interface Guideline extends GuidelineSummary {
  body_markdown: string;
  is_current: boolean;
  created_at: string;
}

export interface GlossaryTerm {
  id: string;
  term_ko: string;
  term_en?: string | null;
  definition_ko?: string | null;
  definition_en?: string | null;
  business_unit_slug?: string | null;
  synonyms: string[];
  replace_for_public?: string | null;
  is_sensitive: boolean;
}

// ---------- In-memory cache ----------

type CacheKey = string;

interface CacheEntry<T> {
  value: T;
  fetchedAt: number;
}

const CACHE: Map<CacheKey, CacheEntry<unknown>> = new Map();

function cacheKey(workspaceRoot: string, resource: string, params: Record<string, string>): CacheKey {
  const sortedParams = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return `${workspaceRoot}::${resource}::${sortedParams}`;
}

function getCached<T>(key: CacheKey, maxAgeMs: number): T | null {
  const entry = CACHE.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > maxAgeMs) return null;
  return entry.value as T;
}

function setCached<T>(key: CacheKey, value: T): void {
  CACHE.set(key, { value, fetchedAt: Date.now() });
}

export function clearHubLibraryCache(workspaceRoot?: string): void {
  if (!workspaceRoot) {
    CACHE.clear();
    return;
  }
  const prefix = `${workspaceRoot}::`;
  for (const key of Array.from(CACHE.keys())) {
    if (key.startsWith(prefix)) CACHE.delete(key);
  }
}

// ---------- Fetch helpers ----------

interface FetchOptions {
  workspaceRoot: string;
  forceRefresh?: boolean;
  params?: Record<string, string>;
  maxAgeMs?: number;
}

async function fetchTyped<T>(
  resource: HubResource | string,
  opts: FetchOptions,
): Promise<T> {
  const params = opts.params ?? {};
  const key = cacheKey(opts.workspaceRoot, resource, params);
  if (!opts.forceRefresh) {
    const cached = getCached<T>(key, opts.maxAgeMs ?? 60_000);
    if (cached !== null) return cached;
  }
  const response = await hubFetchCatalog({
    workspaceRoot: opts.workspaceRoot,
    resource: resource as HubResource,
    params,
    revalidate: opts.forceRefresh === true,
  });
  if (!response.body_json) {
    // Disabled hub or empty cache; return a sensible empty value (caller
    // typed it as T, which is usually a list).
    return [] as unknown as T;
  }
  let parsed: T;
  try {
    parsed = JSON.parse(response.body_json) as T;
  } catch (err) {
    throw new Error(`hub response is not JSON (${resource}): ${String(err)}`);
  }
  setCached(key, parsed);
  return parsed;
}

// ---------- Public API ----------

export async function fetchBusinessUnits(opts: FetchOptions): Promise<BusinessUnit[]> {
  return fetchTyped<BusinessUnit[]>("business_units" as HubResource, opts);
}

export async function fetchDocumentTypes(opts: FetchOptions): Promise<DocumentType[]> {
  return fetchTyped<DocumentType[]>("document_types" as HubResource, opts);
}

export interface TemplateListOptions extends FetchOptions {
  documentType?: string;
  businessUnit?: string;
  category?: DocumentCategory;
}

export async function fetchTemplates(opts: TemplateListOptions): Promise<TemplateSummary[]> {
  const params: Record<string, string> = { ...(opts.params ?? {}) };
  if (opts.documentType) params.document_type = opts.documentType;
  if (opts.businessUnit) params.business_unit = opts.businessUnit;
  if (opts.category) params.category = opts.category;
  return fetchTyped<TemplateSummary[]>("templates", { ...opts, params });
}

export async function fetchTemplate(
  idOrSlug: string,
  opts: FetchOptions,
): Promise<Template> {
  return fetchTyped<Template>(`templates/${encodeURIComponent(idOrSlug)}`, opts);
}

export interface GuidelineListOptions extends FetchOptions {
  scope?: "global" | "business_unit" | "document_type";
  businessUnit?: string;
  documentType?: string;
}

export async function fetchGuidelines(opts: GuidelineListOptions): Promise<GuidelineSummary[]> {
  const params: Record<string, string> = { ...(opts.params ?? {}) };
  if (opts.scope) params.scope = opts.scope;
  if (opts.businessUnit) params.business_unit = opts.businessUnit;
  if (opts.documentType) params.document_type = opts.documentType;
  return fetchTyped<GuidelineSummary[]>("guidelines", { ...opts, params });
}

export async function fetchGuideline(idOrSlug: string, opts: FetchOptions): Promise<Guideline> {
  return fetchTyped<Guideline>(`guidelines/${encodeURIComponent(idOrSlug)}`, opts);
}

export interface GlossaryOptions extends FetchOptions {
  q?: string;
  businessUnit?: string;
}

export async function searchGlossary(opts: GlossaryOptions): Promise<GlossaryTerm[]> {
  const params: Record<string, string> = { ...(opts.params ?? {}) };
  if (opts.q) params.q = opts.q;
  if (opts.businessUnit) params.business_unit = opts.businessUnit;
  return fetchTyped<GlossaryTerm[]>("glossary", { ...opts, params });
}

// ---------- Status snapshots ----------

export async function getHubStatus(workspaceRoot: string): Promise<HubStatus> {
  return hubStatus(workspaceRoot);
}

// ---------- doc_type code → Anchor docType mapping ----------

/**
 * Map Hub document_type codes (frontmatter-schema §3) to the Anchor
 * editor's local docType field, which is a free-text label. The Anchor
 * UI groups documents by docType under projects/templates, so we keep
 * the Hub category name there and let the user adjust.
 */
export function defaultAnchorDocType(template: TemplateSummary | null): string {
  if (!template) return "reference";
  switch (template.document_type_category) {
    case "formal_report":
      return "report";
    case "admin_approval":
      return "approval";
    case "evidence_certification":
      return "evidence";
    case "operational":
      return template.document_type_code === "meeting-minutes"
        ? "meeting"
        : template.document_type_code === "trip-plan" || template.document_type_code === "trip-report"
          ? "trip"
          : template.document_type_code === "mou"
            ? "collaboration"
            : "reference";
  }
}

/**
 * Strip the `{{slot}}` markers from a template body so the user sees a
 * usable draft. Keeps headings and prose intact; replaces tokens with an
 * inline editing hint.
 */
export function renderTemplateBody(template: Template, hint = "내용 입력"): string {
  return template.body_markdown.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, name) => {
    const label = String(name).trim();
    return `<!-- ${label}: ${hint} -->`;
  });
}
