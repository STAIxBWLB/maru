import { architecture, workflow } from "../../../sidecars/archify/renderers/shared/generated-validators.mjs";
/**
 * Archify interchange codec (issue #433).
 *
 * A typed Archify spec (architecture / workflow JSON) is the semantic source
 * of truth for a generated diagram; canvas members are only a projection.
 * This module converts between the spec and the v9 `SemanticSpecDataset`,
 * owns the reversible Maru-id ↔ Archify-id mapping, and provides the
 * strict-ish ingress used by the import dialog and the generation pipeline.
 *
 * ID rules: Archify ids match `^[a-zA-Z][a-zA-Z0-9_-]*$`; Maru ids may contain
 * `:` (pattern member ids like `ds:m0`) or start with a digit. The mapping is
 * stored explicitly in `SemanticSpecDataset.idMap` — decoding is a lookup,
 * not an inverse function, so sanitization only needs to be deterministic,
 * valid and collision-free per spec, never unambiguous in isolation.
 *
 * Fields the pinned engine's schemas do not cover (`additionalProperties:
 * false` at every level) are preserved verbatim in
 * `dataset.preservedExtensions` and reported as fidelity diagnostics — never
 * silently stripped, never re-emitted into the spec.
 */

import {
  SEMANTIC_DIAGRAM_TYPES,
  createDatasetId,
  type SemanticDiagramType,
  type SemanticProvenance,
  type SemanticSpecDataset,
} from "./reportTypes";
import { validateArchifySpecPreCheck, type ValidationDiagnostic } from "./validation";

/** Pinned engine identity; the tree hash lives in `sidecars/archify/PIN.json`. */
export const ARCHIFY_ENGINE = { name: "archify", version: "3.0.0" } as const;

export const ARCHIFY_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

// ---------------------------------------------------------------------------
// ID mapping
// ---------------------------------------------------------------------------

/**
 * Sanitize a Maru id into a valid, unique Archify id. Disallowed characters
 * become `_x<hex>_`; a leading non-letter gets an `n` prefix; collisions with
 * ids already in `taken` get a `-2`, `-3`, ... suffix. The exact mapping must
 * be recorded in an idMap — this function is not invertible on its own.
 */
export function toArchifyId(maruId: string, taken: Set<string> = new Set()): string {
  if (ARCHIFY_ID_PATTERN.test(maruId) && !taken.has(maruId)) {
    taken.add(maruId);
    return maruId;
  }
  const sanitized = maruId.replace(/[^a-zA-Z0-9_-]/g, (ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return `_x${code.toString(16)}_`;
  });
  let base = sanitized;
  if (base.length === 0) base = "n";
  if (!/^[a-zA-Z]/.test(base)) base = `n${base}`;
  let candidate = base;
  let suffix = 2;
  while (taken.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  taken.add(candidate);
  return candidate;
}

/**
 * Resolve the Archify id for a Maru id against an existing idMap, assigning
 * (and recording in `taken`) a fresh sanitized id when unmapped.
 */
export function archifyIdFor(maruId: string, idMap: Record<string, string>, taken: Set<string>): string {
  for (const [archifyId, mapped] of Object.entries(idMap)) {
    if (mapped === maruId) return archifyId;
  }
  return toArchifyId(maruId, taken);
}

// ---------------------------------------------------------------------------
// Spec <-> dataset
// ---------------------------------------------------------------------------

/** Top-level spec fields the pinned schemas define per diagram type. */
const KNOWN_SPEC_FIELDS: Record<SemanticDiagramType, readonly string[]> = {
  architecture: ["schema_version", "diagram_type", "meta", "components", "layout", "boundaries", "connections", "cards"],
  workflow: ["schema_version", "diagram_type", "meta", "lanes", "nodes", "edges", "phases", "groups", "mainPath", "semanticChecks", "cards"],
};

/** Arrays of objects whose `id` fields participate in the id map. */
const ID_ARRAY_FIELDS: Record<SemanticDiagramType, readonly string[]> = {
  architecture: ["components", "connections", "boundaries"],
  workflow: ["lanes", "nodes", "edges", "phases", "groups"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Collect every declared id in a spec, in stable document order. */
export function collectArchifyIds(diagramType: SemanticDiagramType, spec: Record<string, unknown>): string[] {
  const ids: string[] = [];
  for (const field of ID_ARRAY_FIELDS[diagramType]) {
    const entries = spec[field];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (isRecord(entry) && typeof entry.id === "string" && entry.id.length > 0) {
        ids.push(entry.id);
      }
    }
  }
  return ids;
}

export interface SpecToDatasetOptions {
  id?: string;
  name?: string;
  provenance?: SemanticProvenance;
}

/**
 * Wrap a validated Archify spec in a semantic dataset. The id map starts as
 * the identity over the spec's own ids (already Archify-safe); canvas
 * projection rewrites the values to Maru member ids. Top-level fields the
 * schema does not define are moved to `preservedExtensions` and reported.
 */
export function archifySpecToDataset(
  diagramType: SemanticDiagramType,
  spec: Record<string, unknown>,
  opts: SpecToDatasetOptions = {},
): { dataset: SemanticSpecDataset; diagnostics: ValidationDiagnostic[] } {
  const diagnostics: ValidationDiagnostic[] = [];
  const known = new Set(KNOWN_SPEC_FIELDS[diagramType]);
  const clean: Record<string, unknown> = {};
  const preserved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(spec)) {
    if (known.has(key)) clean[key] = value;
    else preserved[key] = value;
  }
  for (const key of Object.keys(preserved)) {
    diagnostics.push({ key: "diagram.archify.unsupportedField", params: { field: key, diagramType } });
  }

  const ids = collectArchifyIds(diagramType, spec);
  const idMap: Record<string, string> = {};
  const taken = new Set<string>();
  for (const id of ids) {
    const safe = toArchifyId(id, taken);
    if (safe !== id) {
      diagnostics.push({ key: "diagram.archify.idSanitized", params: { from: id, to: safe } });
    }
    idMap[safe] = id;
  }

  const meta = isRecord(spec.meta) ? spec.meta : {};
  const name =
    opts.name ??
    (typeof meta.title === "string" && meta.title.length > 0 ? meta.title : diagramType);
  const dataset: SemanticSpecDataset = {
    id: opts.id ?? createDatasetId(),
    kind: "semanticSpec",
    name,
    diagramType,
    spec: clean,
    idMap,
    engine: { ...ARCHIFY_ENGINE },
    ...(Object.keys(preserved).length > 0 ? { preservedExtensions: preserved } : {}),
    ...(opts.provenance ? { provenance: opts.provenance } : {}),
  };
  return { dataset, diagnostics };
}

/** The Archify spec JSON for export, exactly as the engine consumes it. */
export function datasetToArchifySpec(dataset: SemanticSpecDataset): Record<string, unknown> {
  return dataset.spec;
}

// ---------------------------------------------------------------------------
// Import ingress (strict-ish: structural pre-check + semantic wrap)
// ---------------------------------------------------------------------------

export interface ArchifyParseResult {
  dataset: SemanticSpecDataset;
  diagnostics: ValidationDiagnostic[];
}

export type ArchifyParseOutcome =
  | { ok: true; result: ArchifyParseResult }
  | { ok: false; diagnostics: ValidationDiagnostic[] };

/**
 * Parse Archify typed JSON into a semantic dataset. Unlike the tolerant
 * document migrator, a structural failure (unknown diagram type, broken meta
 * contract, oversized payload) refuses the import with diagnostics — an AI
 * or file candidate is never coerced.
 */
export function parseArchifySpec(
  text: string,
  opts: SpecToDatasetOptions = {},
): ArchifyParseOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        {
          key: "diagram.archify.invalidJson",
          params: { message: error instanceof Error ? error.message : String(error) },
        },
      ],
    };
  }
  const diagramType = isRecord(raw) && typeof raw.diagram_type === "string" ? raw.diagram_type : "";
  const pre = validateArchifySpecPreCheck(diagramType, raw);
  if (!pre.ok) return { ok: false, diagnostics: pre.diagnostics };
  if (!isRecord(raw)) {
    // Unreachable after the pre-check, kept for the type system.
    return { ok: false, diagnostics: [{ key: "diagram.validation.specShape" }] };
  }
  const { dataset, diagnostics } = archifySpecToDataset(
    diagramType as SemanticDiagramType,
    raw,
    opts,
  );
  const validator = diagramType === "architecture" ? architecture : workflow;
  if (!validator(dataset.spec)) {
    return {
      ok: false,
      diagnostics: (validator.errors ?? []).map((error) => ({
        key: "diagram.validation.specMeta",
        params: { field: error.instancePath || "spec" },
      })),
    };
  }
  return { ok: true, result: { dataset, diagnostics } };
}

export { SEMANTIC_DIAGRAM_TYPES };
