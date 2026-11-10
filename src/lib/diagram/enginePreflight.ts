import {
  ENGINE_DIAGRAM_TYPES,
  SEMANTIC_SPEC_MAX_BYTES,
  type EngineDiagramType,
} from "./reportTypes";
import type { ValidationDiagnostic, ValidationResult } from "./validation";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function portableHtmlOutput(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || !/[.]html$/i.test(value)) return false;
  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/u.test(value)
      || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value) || value.includes("\\")) return false;
  const segments = value.split("/");
  return segments.every((segment) => {
    if (!segment || segment === "." || segment === ".." || /\p{Cc}/u.test(segment)
        || new TextDecoder().decode(new TextEncoder().encode(segment)) !== segment
        || /[<>:"|?*]/u.test(segment) || /[. ]$/u.test(segment)) return false;
    if (/^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(segment)) return false;
    return !/~[1-9][0-9]*(?:\.|$)/iu.test(segment);
  });
}

const SUPPORTED_SCHEMA_VERSIONS: Readonly<Record<EngineDiagramType, readonly number[]>> = {
  architecture: [1],
  workflow: [1, 2],
  sequence: [1],
  dataflow: [1],
  lifecycle: [1, 2],
};

const REQUIRED_COLLECTIONS: Readonly<Record<EngineDiagramType, readonly string[]>> = {
  architecture: ["components"],
  workflow: ["lanes", "nodes", "edges"],
  sequence: ["participants", "messages"],
  dataflow: ["stages", "nodes", "flows"],
  lifecycle: ["lanes", "states", "transitions"],
};

function diagnostic(field: string): ValidationDiagnostic {
  return { key: "diagram.validation.specMeta", params: { field } };
}

/** Cheap product-side envelope checks; the SDK owns full family schema and geometry validation. */
export function validateEngineSpecPreCheck(
  diagramType: string,
  spec: unknown,
): ValidationResult {
  const diagnostics: ValidationDiagnostic[] = [];
  if (!(ENGINE_DIAGRAM_TYPES as readonly string[]).includes(diagramType)) {
    diagnostics.push({ key: "diagram.validation.specType", params: { diagramType } });
  }
  if (!record(spec)) {
    return { ok: false, diagnostics: [...diagnostics, { key: "diagram.validation.specShape" }] };
  }

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(spec);
  } catch {
    diagnostics.push({
      key: "diagram.validation.specBudget",
      params: { bytes: "n/a", maxBytes: SEMANTIC_SPEC_MAX_BYTES },
    });
  }
  if (typeof serialized !== "string") {
    if (!diagnostics.some((item) => item.key === "diagram.validation.specBudget")) {
      diagnostics.push({
        key: "diagram.validation.specBudget",
        params: { bytes: "n/a", maxBytes: SEMANTIC_SPEC_MAX_BYTES },
      });
    }
    return { ok: diagnostics.length === 0, diagnostics };
  }
  const bytes = new TextEncoder().encode(serialized).length;
  if (bytes > SEMANTIC_SPEC_MAX_BYTES) {
    diagnostics.push({
      key: "diagram.validation.specBudget",
      params: { bytes, maxBytes: SEMANTIC_SPEC_MAX_BYTES },
    });
  }

  if (typeof spec.diagram_type !== "string" || spec.diagram_type !== diagramType) {
    diagnostics.push(diagnostic("diagram_type"));
  }
  if (typeof spec.schema_version !== "number" || !Number.isInteger(spec.schema_version)
      || !Number.isFinite(spec.schema_version)) {
    diagnostics.push(diagnostic("schema_version"));
  } else if ((ENGINE_DIAGRAM_TYPES as readonly string[]).includes(diagramType)
      && !SUPPORTED_SCHEMA_VERSIONS[diagramType as EngineDiagramType].includes(spec.schema_version)) {
    diagnostics.push(diagnostic("schema_version"));
  }
  if ((ENGINE_DIAGRAM_TYPES as readonly string[]).includes(diagramType)) {
    for (const field of REQUIRED_COLLECTIONS[diagramType as EngineDiagramType]) {
      if (!Array.isArray(spec[field])) diagnostics.push(diagnostic(field));
    }
  }
  const meta = spec.meta;
  if (!record(meta) || typeof meta.title !== "string" || meta.title.length === 0) {
    diagnostics.push(diagnostic("meta.title"));
  }
  if (!record(meta) || !portableHtmlOutput(meta.output)) {
    diagnostics.push(diagnostic("meta.output"));
  }
  return { ok: diagnostics.length === 0, diagnostics };
}
