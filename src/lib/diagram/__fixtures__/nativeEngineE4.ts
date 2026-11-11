/** Fixed, public, path-free sources for the real-app T4 canvas check
 *  (maru#552 E4 T4). One mixed Korean/English label per family, kept close to
 *  the fixture's own width so the real engine keeps fitting it, plus the two
 *  legacy document bodies the native runner saves and reopens through the
 *  app's own `diagram_save_document` path. */
import type { EngineDiagramType } from "../reportTypes";
import { SEMANTIC_FIXTURES } from "./semantic";

export const NATIVE_E4_DIAGRAM_TYPES: readonly EngineDiagramType[] = [
  "architecture",
  "workflow",
  "sequence",
  "dataflow",
  "lifecycle",
];

/** The authored entity array each family's first label lives in. */
export const NATIVE_E4_ENTITY_FIELD: Record<EngineDiagramType, string> = {
  architecture: "components",
  workflow: "nodes",
  sequence: "participants",
  dataflow: "nodes",
  lifecycle: "states",
};

export const NATIVE_E4_MIXED_LABEL: Record<EngineDiagramType, string> = {
  architecture: "웹 Web",
  workflow: "초안 Draft",
  sequence: "웹 Web",
  dataflow: "앱 App",
  lifecycle: "대기 Queued",
};

/** One family's spec with its first entity relabelled; the rest of the fixture
 *  stays exactly as the browser suite sends it. */
export function nativeE4Spec(type: EngineDiagramType): Record<string, unknown> {
  const spec = structuredClone(SEMANTIC_FIXTURES[type]) as Record<string, unknown>;
  const entries = spec[NATIVE_E4_ENTITY_FIELD[type]];
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`the ${type} fixture has no ${NATIVE_E4_ENTITY_FIELD[type]} entry to relabel`);
  }
  (entries[0] as Record<string, unknown>).label = NATIVE_E4_MIXED_LABEL[type];
  return spec;
}

/** Title of the document whose label the real engine cannot fit, so the canvas
 *  refuses the layout and anchors a diagnostic next to that member. */
export const NATIVE_E4_REFUSED_TITLE = "T4 거부 Refused";

/**
 * One unbreakable label the fit rule cannot wrap, shrink into its box or split
 * at 10 px, so the engine answers with a refusal whose diagnostic path names
 * that member. Nothing else in the fixture changes, which keeps the refusal
 * about geometry alone.
 */
export function nativeE4RefusedSpec(): Record<string, unknown> {
  const spec = nativeE4Spec("workflow");
  spec.meta = { ...(spec.meta as Record<string, unknown>), title: NATIVE_E4_REFUSED_TITLE };
  const nodes = spec[NATIVE_E4_ENTITY_FIELD.workflow] as Array<Record<string, unknown>>;
  nodes[0]!.label = "점검".repeat(40);
  return spec;
}

/**
 * v7 carries a table only as `meta.rows/cols` and v8 is a version bump away
 * from the current schema, so opening either proves the migration the app
 * performs on a document a user already had on disk.
 */
export const NATIVE_E4_LEGACY_DOCUMENTS = {
  v7: {
    v: 7,
    id: "native-e4-v7",
    docTitle: "T4 v7 표 Table",
    createdAt: 1,
    updatedAt: 2,
    nodes: [
      { id: "t4-v7-table", kind: "table", x: 60, y: 60, w: 220, h: 120, meta: { rows: 2, cols: 2 } },
      { id: "t4-v7-note", kind: "simple", x: 340, y: 60, w: 180, h: 72, title: "v7 메모 Memo" },
    ],
    edges: [],
  },
  v8: {
    v: 8,
    id: "native-e4-v8",
    docTitle: "T4 v8 노트 Note",
    createdAt: 1,
    updatedAt: 2,
    nodes: [
      { id: "t4-v8-a", kind: "simple", x: 60, y: 60, w: 180, h: 72, title: "v8 시작 Start" },
      { id: "t4-v8-b", kind: "simple", x: 300, y: 60, w: 180, h: 72, title: "v8 끝 End" },
    ],
    edges: [],
  },
} as const;
