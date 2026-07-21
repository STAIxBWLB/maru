/**
 * Pattern presets — Report Pattern Studio Phase 2a.
 *
 * A preset is DATA ONLY: a pattern id, optional theme/style hints, and an
 * optional dataset seed. Presets are stored as `<name>.pattern.json` files
 * under `<workspace>/.maru/diagram-patterns/` (see `diagram/mod.rs`) and must
 * never carry executable content — `validatePreset` is a hand-rolled
 * structural validator (no `eval`, no schema lib, no new deps) that rejects
 * anything but plain JSON primitives in the expected shape.
 */

import { getPattern } from "./patterns";
import { validateMatrix, type MatrixDataset, type ReportDataset } from "./reportTypes";

export interface PatternPresetV1 {
  v: 1;
  id: string;
  name: string;
  patternId: string;
  theme?: string;
  style?: Record<string, string | number | boolean>;
  datasetSeed?: ReportDataset;
  createdAt: number;
  updatedAt: number;
}

export type PresetValidation =
  | { ok: true; preset: PatternPresetV1 }
  | { ok: false; errors: string[] };

const DATASET_KINDS = ["matrix", "hierarchy", "timeline", "flow", "network", "scorecard"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function checkArray(
  value: unknown,
  field: string,
  errors: string[],
  opts: { optional?: boolean } = {},
): value is unknown[] {
  if (value === undefined && opts.optional) return true;
  if (!Array.isArray(value)) {
    errors.push(`${field}: must be an array`);
    return false;
  }
  return true;
}

function validateDatasetSeed(seed: unknown, errors: string[]): void {
  if (!isPlainObject(seed)) {
    errors.push("datasetSeed: must be an object");
    return;
  }
  if (!isNonEmptyString(seed.id)) errors.push("datasetSeed.id: must be a non-empty string");
  if (typeof seed.name !== "string") errors.push("datasetSeed.name: must be a string");
  const kind = seed.kind;
  if (typeof kind !== "string" || !DATASET_KINDS.includes(kind as (typeof DATASET_KINDS)[number])) {
    errors.push(`datasetSeed.kind: unknown kind ${String(kind)}`);
    return;
  }
  switch (kind as (typeof DATASET_KINDS)[number]) {
    case "matrix": {
      if (!checkArray(seed.columns, "datasetSeed.columns", errors)) return;
      if (!checkArray(seed.rows, "datasetSeed.rows", errors)) return;
      if (!isPlainObject(seed.cells)) {
        errors.push("datasetSeed.cells: must be an object");
        return;
      }
      const result = validateMatrix(seed as unknown as MatrixDataset);
      for (const error of result.errors) errors.push(`datasetSeed: ${error}`);
      return;
    }
    case "hierarchy": {
      if (!checkArray(seed.nodes, "datasetSeed.nodes", errors)) return;
      (seed.nodes as unknown[]).forEach((node, i) => {
        if (!isPlainObject(node)) {
          errors.push(`datasetSeed.nodes[${i}]: must be an object`);
          return;
        }
        if (!isNonEmptyString(node.id)) errors.push(`datasetSeed.nodes[${i}].id: required`);
        if (!(node.parentId === null || typeof node.parentId === "string")) {
          errors.push(`datasetSeed.nodes[${i}].parentId: must be a string or null`);
        }
        if (typeof node.label !== "string") errors.push(`datasetSeed.nodes[${i}].label: must be a string`);
        if (node.fields !== undefined) {
          if (!isPlainObject(node.fields)) {
            errors.push(`datasetSeed.nodes[${i}].fields: must be an object`);
          } else {
            for (const [key, value] of Object.entries(node.fields)) {
              if (typeof value !== "string") {
                errors.push(`datasetSeed.nodes[${i}].fields.${key}: must be a string`);
              }
            }
          }
        }
      });
      return;
    }
    case "timeline": {
      if (!checkArray(seed.items, "datasetSeed.items", errors)) return;
      (seed.items as unknown[]).forEach((item, i) => {
        if (!isPlainObject(item)) {
          errors.push(`datasetSeed.items[${i}]: must be an object`);
          return;
        }
        for (const field of ["id", "label", "start", "end"] as const) {
          if (typeof item[field] !== "string") {
            errors.push(`datasetSeed.items[${i}].${field}: must be a string`);
          }
        }
        if (!isOptionalString(item.owner) || !isOptionalString(item.status)) {
          errors.push(`datasetSeed.items[${i}]: owner/status must be strings`);
        }
      });
      return;
    }
    case "flow":
    case "network": {
      if (!checkArray(seed.nodes, "datasetSeed.nodes", errors)) return;
      if (!checkArray(seed.links, "datasetSeed.links", errors)) return;
      (seed.nodes as unknown[]).forEach((node, i) => {
        if (!isPlainObject(node) || !isNonEmptyString(node.id) || typeof node.label !== "string") {
          errors.push(`datasetSeed.nodes[${i}]: id/label required`);
        }
      });
      (seed.links as unknown[]).forEach((link, i) => {
        if (
          !isPlainObject(link) ||
          !isNonEmptyString(link.id) ||
          typeof link.from !== "string" ||
          typeof link.to !== "string"
        ) {
          errors.push(`datasetSeed.links[${i}]: id/from/to required`);
        }
      });
      return;
    }
    case "scorecard": {
      if (!checkArray(seed.entries, "datasetSeed.entries", errors)) return;
      (seed.entries as unknown[]).forEach((entry, i) => {
        if (!isPlainObject(entry)) {
          errors.push(`datasetSeed.entries[${i}]: must be an object`);
          return;
        }
        if (!isNonEmptyString(entry.id)) errors.push(`datasetSeed.entries[${i}].id: required`);
        if (typeof entry.label !== "string") {
          errors.push(`datasetSeed.entries[${i}].label: must be a string`);
        }
        for (const field of ["target", "actual", "status", "evidence"] as const) {
          if (!isOptionalString(entry[field])) {
            errors.push(`datasetSeed.entries[${i}].${field}: must be a string`);
          }
        }
      });
      return;
    }
  }
}

/**
 * Validate an untrusted preset payload. Rejects non-objects, wrong versions,
 * unknown pattern ids, non-primitive style values, and malformed dataset
 * seeds (matrix seeds go through the full span-invariant `validateMatrix`).
 */
export function validatePreset(json: unknown): PresetValidation {
  const errors: string[] = [];
  if (!isPlainObject(json)) {
    return { ok: false, errors: ["preset: must be a plain object"] };
  }
  if (json.v !== 1) errors.push(`preset.v: must be 1 (got ${JSON.stringify(json.v)})`);
  if (!isNonEmptyString(json.id)) errors.push("preset.id: must be a non-empty string");
  if (!isNonEmptyString(json.name)) errors.push("preset.name: must be a non-empty string");
  if (!isNonEmptyString(json.patternId)) {
    errors.push("preset.patternId: must be a non-empty string");
  } else if (!getPattern(json.patternId)) {
    errors.push(`preset.patternId: unknown pattern ${json.patternId}`);
  }
  if (json.theme !== undefined && typeof json.theme !== "string") {
    errors.push("preset.theme: must be a string");
  }
  if (json.style !== undefined) {
    if (!isPlainObject(json.style)) {
      errors.push("preset.style: must be a flat object of primitives");
    } else {
      for (const [key, value] of Object.entries(json.style)) {
        const t = typeof value;
        if (t !== "string" && t !== "number" && t !== "boolean") {
          errors.push(`preset.style.${key}: must be a string, number, or boolean`);
        }
      }
    }
  }
  if (json.datasetSeed !== undefined) validateDatasetSeed(json.datasetSeed, errors);
  if (typeof json.createdAt !== "number" || !Number.isFinite(json.createdAt)) {
    errors.push("preset.createdAt: must be a finite number");
  }
  if (typeof json.updatedAt !== "number" || !Number.isFinite(json.updatedAt)) {
    errors.push("preset.updatedAt: must be a finite number");
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, preset: json as unknown as PatternPresetV1 };
}

/** Serialize a validated preset for storage (pretty JSON, trailing newline). */
export function serializePreset(preset: PatternPresetV1): string {
  return `${JSON.stringify(preset, null, 2)}\n`;
}
