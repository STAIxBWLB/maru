// Pure helpers for Sites mode: registry document parsing, grouping,
// filtering, and native-webview visibility/bounds math.

export interface SiteEntry {
  id: string;
  label: string;
  url: string;
  category: string | null;
  favicon: string | null;
  localPath: string | null;
  devUrl: string | null;
  order: number;
  createdAt: string | null;
  lastUsedAt: string | null;
  notes: string | null;
}

export interface SitesDocument {
  version: 1;
  sites: SiteEntry[];
}

export interface SiteCandidate {
  dirName: string;
  label: string;
  localPath: string;
  url: string | null;
  devUrl: string | null;
  source: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown, fallback: number): number {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : fallback;
}

export function newSiteId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `site-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Tolerant parse of `{version, sites}` — garbage in, empty document out;
 *  rows missing a url are dropped, everything else gets defaults. */
export function parseSitesDocument(value: unknown): SitesDocument {
  if (!isRecord(value)) return { version: 1, sites: [] };
  const rawSites = Array.isArray(value.sites) ? value.sites : [];
  const sites: SiteEntry[] = [];
  for (const raw of rawSites) {
    if (!isRecord(raw)) continue;
    const url = readString(raw.url);
    if (!url) continue;
    sites.push({
      id: readString(raw.id) ?? newSiteId(),
      label: readString(raw.label) ?? url,
      url,
      category: readString(raw.category),
      favicon: readString(raw.favicon),
      localPath: readString(raw.localPath),
      devUrl: readString(raw.devUrl),
      order: readNumber(raw.order, sites.length),
      createdAt: readString(raw.createdAt),
      lastUsedAt: readString(raw.lastUsedAt),
      notes: typeof raw.notes === "string" && raw.notes.trim() ? raw.notes : null,
    });
  }
  return { version: 1, sites: sortSites(sites) };
}

export function serializeSitesDocument(sites: SiteEntry[]): SitesDocument {
  return { version: 1, sites: sortSites(sites) };
}

export function sortSites(sites: SiteEntry[]): SiteEntry[] {
  return [...sites].sort(
    (a, b) =>
      a.order - b.order || a.label.localeCompare(b.label) || a.id.localeCompare(b.id),
  );
}

export interface SiteCategoryGroup {
  /** null → uncategorized (always last); render label via i18n. */
  category: string | null;
  sites: SiteEntry[];
}

export function groupSitesByCategory(sites: SiteEntry[]): SiteCategoryGroup[] {
  const byCategory = new Map<string, SiteEntry[]>();
  const uncategorized: SiteEntry[] = [];
  for (const site of sortSites(sites)) {
    if (site.category === null) {
      uncategorized.push(site);
      continue;
    }
    const bucket = byCategory.get(site.category);
    if (bucket) bucket.push(site);
    else byCategory.set(site.category, [site]);
  }
  const groups: SiteCategoryGroup[] = [...byCategory.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, grouped]) => ({ category, sites: grouped }));
  if (uncategorized.length > 0) groups.push({ category: null, sites: uncategorized });
  return groups;
}

export function filterSitesByQuery(sites: SiteEntry[], query: string): SiteEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return sites;
  return sites.filter((site) =>
    [site.label, site.url, site.category ?? "", site.devUrl ?? "", site.notes ?? ""].some(
      (field) => field.toLowerCase().includes(q),
    ),
  );
}

export function faviconUrlFor(site: Pick<SiteEntry, "favicon" | "url">): string | null {
  if (site.favicon) return site.favicon;
  try {
    return `${new URL(site.url).origin}/favicon.ico`;
  } catch {
    return null;
  }
}

/** "example.com/x/" and "https://Example.com/x" compare equal. */
export function normalizeSiteUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.host.toLowerCase()}${path}${url.search}`;
  } catch {
    return null;
  }
}

export function upsertSite(sites: SiteEntry[], entry: SiteEntry): SiteEntry[] {
  const index = sites.findIndex((site) => site.id === entry.id);
  if (index === -1) return sortSites([...sites, entry]);
  const next = [...sites];
  next[index] = entry;
  return sortSites(next);
}

export function removeSite(sites: SiteEntry[], id: string): SiteEntry[] {
  return sites.filter((site) => site.id !== id);
}

export function touchSiteUsage(
  sites: SiteEntry[],
  id: string,
  when: Date = new Date(),
): SiteEntry[] {
  return sites.map((site) =>
    site.id === id ? { ...site, lastUsedAt: when.toISOString() } : site,
  );
}

export function nextSiteOrder(sites: SiteEntry[]): number {
  return sites.reduce((max, site) => Math.max(max, site.order), -1) + 1;
}

// ── auto-import candidates ──

export function parseSiteCandidates(value: unknown): SiteCandidate[] {
  if (!Array.isArray(value)) return [];
  const candidates: SiteCandidate[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const dirName = readString(raw.dirName);
    const localPath = readString(raw.localPath);
    if (!dirName || !localPath) continue;
    candidates.push({
      dirName,
      label: readString(raw.label) ?? dirName,
      localPath,
      url: readString(raw.url),
      devUrl: readString(raw.devUrl),
      source: readString(raw.source) ?? "scan",
    });
  }
  return candidates;
}

export function candidateToSite(
  candidate: SiteCandidate,
  overrides: { label?: string; url?: string },
  order: number,
): SiteEntry | null {
  const url = normalizeSiteUrl(overrides.url ?? candidate.url ?? candidate.devUrl ?? "");
  if (!url) return null;
  return {
    id: newSiteId(),
    label: (overrides.label ?? candidate.label).trim() || candidate.dirName,
    url,
    category: null,
    favicon: null,
    localPath: candidate.localPath,
    devUrl: candidate.devUrl,
    order,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    notes: null,
  };
}

// ── native webview visibility / bounds math ──

export interface SiteViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const MIN_SITE_VIEW_SIZE = 2;

/** Rounded logical-px bounds from a DOMRect, or null when the placeholder is
 *  collapsed (display:none under terminal-maximized → 0×0 rect). */
export function siteViewBoundsFromRect(rect: {
  x: number;
  y: number;
  width: number;
  height: number;
}): SiteViewBounds | null {
  if (rect.width < MIN_SITE_VIEW_SIZE || rect.height < MIN_SITE_VIEW_SIZE) return null;
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

/** Single source of truth for "should the native webview be visible". */
export function shouldShowSiteView(args: {
  hasActiveSite: boolean;
  overlayOpen: boolean;
  localDialogOpen: boolean;
}): boolean {
  return args.hasActiveSite && !args.overlayOpen && !args.localDialogOpen;
}
