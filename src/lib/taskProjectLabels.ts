import type { ProjectPickerEntry } from "./types";

export interface ResolvedTaskProject {
  raw: string;
  key: string;
  label: string;
  resolution: "registry" | "alias" | "fallback";
}

interface ParsedProjectReference {
  target: string;
  alias: string | null;
}

function parseProjectReference(raw: string): ParsedProjectReference {
  const trimmed = raw.trim();
  const wiki = trimmed.match(/^\[\[([\s\S]+)\]\]$/);
  const inner = wiki ? wiki[1].trim() : trimmed;
  const separator = inner.indexOf("|");
  const target = (separator >= 0 ? inner.slice(0, separator) : inner).trim();
  const alias = separator >= 0 ? inner.slice(separator + 1).trim() || null : null;
  return { target, alias };
}

function normalizeTarget(value: string): string {
  const parsed = parseProjectReference(value);
  return parsed.target
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.md$/i, "")
    .trim()
    .toLocaleLowerCase();
}

function uniqueRegistryMatch(
  target: string,
  projects: readonly ProjectPickerEntry[],
): ProjectPickerEntry | null {
  const normalized = normalizeTarget(target);
  const byId = projects.filter((project) => normalizeTarget(project.id) === normalized);
  if (byId.length === 1) return byId[0];

  const byVaultNote = projects.filter(
    (project) => project.vaultNote && normalizeTarget(project.vaultNote) === normalized,
  );
  return byVaultNote.length === 1 ? byVaultNote[0] : null;
}

function humanizeTarget(target: string): string {
  const normalized = target
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.md$/i, "");
  const leaf = normalized.split("/").filter(Boolean).pop() ?? normalized;
  const words = leaf.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (!words) return target.trim();
  const withInitial = /^[a-z]/.test(words)
    ? `${words[0].toUpperCase()}${words.slice(1)}`
    : words;
  return withInitial.replace(
    /\b(ai|aws|esg|koica|md|pms|rise|tiu|tot)\b/gi,
    (token) => token.toUpperCase(),
  );
}

export function resolveTaskProject(
  raw: string,
  projects: readonly ProjectPickerEntry[] = [],
): ResolvedTaskProject {
  const parsed = parseProjectReference(raw);
  const registry = uniqueRegistryMatch(parsed.target, projects);
  const normalized = normalizeTarget(parsed.target) || raw.trim().toLocaleLowerCase();
  return {
    raw,
    key: registry ? `registry:${registry.id}` : `raw:${normalized}`,
    label: parsed.alias ?? registry?.name ?? humanizeTarget(parsed.target),
    resolution: parsed.alias ? "alias" : registry ? "registry" : "fallback",
  };
}

export function resolveTaskProjects(
  rawProjects: readonly string[],
  projects: readonly ProjectPickerEntry[] = [],
): ResolvedTaskProject[] {
  const seen = new Set<string>();
  const resolved: ResolvedTaskProject[] = [];
  for (const raw of rawProjects) {
    const project = resolveTaskProject(raw, projects);
    if (!project.key || seen.has(project.key)) continue;
    seen.add(project.key);
    resolved.push(project);
  }
  return resolved;
}
