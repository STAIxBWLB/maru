/**
 * Floorplan interchange codec (issue #535).
 *
 * A `floorplan/architecture@1` JSON is stored verbatim as the dataset spec:
 * every field, known or not, survives import, save and export unchanged.
 * Fields the canvas does not draw (paths, flows, tour, ...) and fields the
 * upstream schema does not define are reported as fidelity diagnostics, never
 * dropped. Node ids are already valid Maru ids, so the id map is the
 * identity. Import and apply still validate locally with
 * {@link validateFloorplanSpec}: the engine validates, lays out and renders the
 * same document (`maru-diagram-engine` `src/floorplan.rs`), but the apply gate
 * does not call it yet (#553 E5 T4).
 */

import {
  FLOORPLAN_ENGINE,
  floorplanNodeIds,
  floorplanUnknownFields,
  isFloorplanSchema,
  validateFloorplanSpec,
} from "./floorplan";
import { SEMANTIC_SPEC_MAX_BYTES, createDatasetId, type SemanticSpecDataset } from "./reportTypes";
import type { SpecToDatasetOptions } from "./archifyCodec";
import type { ValidationDiagnostic } from "./validation";

export const FLOORPLAN_EXTENSIONS = [".floorplan.json"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a file is Floorplan interchange: a `.floorplan.json` suffix, or a
 * file named exactly `architecture.json` whose `$schema` is
 * `floorplan/architecture@1`. An Archify `*.architecture.json` is never
 * claimed by name alone.
 */
export function isFloorplanFile(filename: string, text?: string): boolean {
  const lower = filename.toLowerCase();
  if (FLOORPLAN_EXTENSIONS.some((extension) => lower.endsWith(extension))) return true;
  const base = lower.split(/[\\/]/).pop() ?? "";
  if (base !== "architecture.json" || text === undefined) return false;
  try {
    return isFloorplanSchema(JSON.parse(text));
  } catch {
    return false;
  }
}

/** Shape and budget floor shared by import and generation (no content checks). */
export function floorplanPreCheck(spec: unknown): ValidationDiagnostic[] {
  if (!isRecord(spec)) return [{ key: "diagram.validation.specShape" }];
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(spec)).length;
    if (bytes > SEMANTIC_SPEC_MAX_BYTES) {
      return [{ key: "diagram.validation.specBudget", params: { bytes, maxBytes: SEMANTIC_SPEC_MAX_BYTES } }];
    }
  } catch {
    return [{ key: "diagram.validation.specBudget", params: { bytes: "n/a", maxBytes: SEMANTIC_SPEC_MAX_BYTES } }];
  }
  return [];
}

/** Wrap a Floorplan spec, verbatim, in a semantic dataset. */
export function floorplanSpecToDataset(
  spec: Record<string, unknown>,
  opts: SpecToDatasetOptions = {},
): { dataset: SemanticSpecDataset; diagnostics: ValidationDiagnostic[] } {
  const diagnostics: ValidationDiagnostic[] = floorplanUnknownFields(spec).map((field) => ({
    key: "diagram.floorplan.unknownField",
    params: { field },
  }));
  const idMap: Record<string, string> = {};
  // Identity map. `__proto__` would set the prototype instead of an entry; the
  // lookup falls back to the id itself, so it is left out.
  for (const id of floorplanNodeIds(spec)) if (id !== "__proto__") idMap[id] = id;
  const project = isRecord(spec.project) ? spec.project : {};
  const name = opts.name ?? (typeof project.name === "string" && project.name.length > 0 ? project.name : "floorplan");
  return {
    dataset: {
      id: opts.id ?? createDatasetId(),
      kind: "semanticSpec",
      name,
      diagramType: "floorplan",
      spec,
      idMap,
      engine: { ...FLOORPLAN_ENGINE },
      ...(opts.provenance ? { provenance: opts.provenance } : {}),
    },
    diagnostics,
  };
}

export type FloorplanParseOutcome =
  | { ok: true; dataset: SemanticSpecDataset; diagnostics: ValidationDiagnostic[] }
  | { ok: false; diagnostics: ValidationDiagnostic[] };

/** Parse Floorplan JSON; any shape or content failure refuses the import. */
export function parseFloorplanSpec(text: string, opts: SpecToDatasetOptions = {}): FloorplanParseOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      diagnostics: [{ key: "diagram.floorplan.invalidJson", params: { message: error instanceof Error ? error.message : String(error) } }],
    };
  }
  const pre = floorplanPreCheck(raw);
  if (pre.length > 0 || !isRecord(raw)) return { ok: false, diagnostics: pre };
  const content = validateFloorplanSpec(raw);
  if (content.length > 0) return { ok: false, diagnostics: content };
  return { ok: true, ...floorplanSpecToDataset(raw, opts) };
}

/** The Floorplan JSON for export: the spec verbatim. */
export function datasetToFloorplanSpec(dataset: SemanticSpecDataset): Record<string, unknown> {
  return dataset.spec;
}
