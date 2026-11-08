// Spec-owned synthetic inputs and rule mappings. No engine implementation is
// imported here: the pinned CLI is an external oracle in the host generator.
/** @typedef {Record<string, any>} RawSpec */
export const TYPES = ["architecture", "workflow", "sequence", "dataflow", "lifecycle"];
export const PRIMARY = { architecture: "components", workflow: "nodes", sequence: "participants", dataflow: "nodes", lifecycle: "states" };
export const RELATIONS = { architecture: "connections", workflow: "edges", sequence: "messages", dataflow: "flows", lifecycle: "transitions" };
const REFERENCE_RULE = { architecture: "reference", workflow: "edge-endpoint", sequence: "participant-reference", dataflow: "reference", lifecycle: "transition-endpoint" };
const LEGEND_KEY = { architecture: "backend", workflow: "backend", sequence: "default", dataflow: "default", lifecycle: "active" };
const sharedRules = {
  "shape": "Required object/array/scalar shape and integer representation",
  "unknown-field": "Only the documented fields of a spec object are accepted",
  "schema-version": "Workflow/lifecycle accept schema versions 1 and 2; the other three types accept version 1",
  "diagram-type": "The dispatcher requires a supported diagram_type",
  "id": "Authored identifiers use the shared identifier syntax",
  "duplicate-id": "Primary IDs and authored relationship IDs are unique in their collections",
  "text": "Required labels and metadata meet their documented text lengths",
  "range": "Authored scalar values meet schema bounds, without layout computation",
  "integer": "Authored schema integers are whole numbers",
  "enum": "Authored enum fields use a documented value",
  "cardinality": "Required collections meet their schema size bounds",
  "locale": "Locale tags use the documented portable language-tag syntax",
  "output-path": "Output is a portable relative HTML path",
  "translations": "Translation keys, values and count meet the shared limits",
  "brand": "Brand names/URLs and pinned hashes meet the shared format",
  "sources": "Source references contain one to three documented entries",
  "views": "Guided-view declarations meet their schema limits",
  "legend": "Legend entries contain a label or a visibility value",
  "repository": "Repository metadata contains a complete commit hash",
};
const specificRules = {
  architecture: { "reference": "Connections and boundary members name existing components", "grid-column": "A grid column lies below the authored layout.cols", "ownership": "Deployment-ownership memberships do not partially overlap", "deployment-boundary-kind": "The deployment profile declares both required boundary kinds", "deployment-owner-missing": "Every nonexternal component names an owner", "deployment-region-scope": "Every nonexternal component belongs to a region", "deployment-region-ambiguous": "Every nonexternal component belongs to exactly one region", "deployment-private-state": "Database components belong to a private security group", "deployment-private-region-consistency": "Each private group belongs to one common region", "deployment-crossing-mechanism": "Cross-boundary connections name their mechanism", "placement-input": "Free/grid placement has the fields needed to locate a component", "grid-cell": "Declared grid cells are not assigned to two unpositioned components" },
  workflow: { "lane-reference": "Nodes/groups name existing lanes", "phase-range": "Phase column bounds are ordered", "group-range": "Group column bounds are ordered", "phase-overlap": "Workflow phases do not share columns", "empty-group": "A group contains a node in its lane/range", "edge-endpoint": "Edges name existing workflow nodes", "main-path-node": "Main-path steps name existing nodes", "main-path-edge": "Adjacent main-path steps have a direct edge", "main-path-order": "Main-path edges move forward in column order", "semantic-checks-empty": "A semanticChecks object declares at least one check", "semantic-node-reference": "Semantic checks name existing nodes", "unexpected-root": "Graph roots belong to allowedRoots when declared", "unexpected-terminal": "Graph terminals belong to allowedTerminals when declared", "required-edge": "Every required direct edge exists", "required-path": "Every required reachability path exists" },
  sequence: { "participant-reference": "Messages and activations name participants", "range-order": "Segment and activation ends follow their starts" },
  dataflow: { "reference": "Flows name existing nodes", "stage-reference": "A node stage is an existing zero-based index" },
  lifecycle: { "lane-count": "At most four lanes are declared", "lane-reference": "States name existing lanes", "transition-endpoint": "Transitions name existing states" },
};
export const RULE_TABLE = Object.fromEntries(TYPES.map((type) => [type,
  Object.entries({ ...sharedRules, ...specificRules[type] }).map(([rule, description]) => ({
    rule, code: rule === "diagram-type" ? "document/diagram-type" : `${type}/${rule}`, description,
  })),
]));

/** @param {string} type @returns {RawSpec} */
export function seedFor(type) {
  const meta = { title: `${type} fixture`, output: "fixture.html" };
  const header = { schema_version: 1, diagram_type: type, meta };
  if (type === "architecture") return { ...header, layout: { mode: "grid", cols: 4 }, components: [{ id: "a", type: "frontend", label: "A", row: 0, col: 0 }, { id: "b", type: "backend", label: "B", row: 0, col: 1 }], connections: [{ from: "a", to: "b", label: "Call" }] };
  if (type === "workflow") return { ...header, lanes: [{ id: "main", label: "Main" }], nodes: [{ id: "a", lane: "main", col: 0, type: "frontend", label: "A", width: 96, height: 48 }, { id: "b", lane: "main", col: 2, type: "backend", label: "B", width: 96, height: 48 }, { id: "c", lane: "main", col: 4, type: "backend", label: "C", width: 96, height: 48 }], edges: [{ from: "a", to: "b", role: "main" }, { from: "b", to: "c", role: "main" }] };
  if (type === "sequence") return { ...header, participants: [{ id: "a", type: "frontend", label: "A" }, { id: "b", type: "backend", label: "B" }], messages: [{ from: "a", to: "b", y: 180, label: "Call" }] };
  if (type === "dataflow") return { ...header, stages: [{ label: "Input" }, { label: "Output" }], nodes: [{ id: "a", type: "frontend", label: "A", stage: 0, row: 0 }, { id: "b", type: "backend", label: "B", stage: 1, row: 0 }], flows: [{ from: "a", to: "b", label: "Data" }] };
  if (type === "lifecycle") return { ...header, lanes: [{ id: "main", label: "Main" }], states: [{ id: "a", type: "start", label: "A", lane: "main", col: 0 }, { id: "b", type: "active", label: "B", lane: "main", col: 1 }], transitions: [{ from: "a", to: "b", label: "Start" }] };
  throw new Error(`Unknown synthetic diagram type ${type}; add a documented seed before generating cases.`);
}

/** @returns {RawSpec} */
export function deploymentSeed() {
  const spec = seedFor("architecture");
  spec.meta.engineering_profile = "deployment-ownership";
  spec.components[0].tag = "Application";
  spec.components[1].tag = "Service";
  spec.components.push({ id: "c", type: "database", label: "DB", tag: "Storage", row: 0, col: 2 });
  spec.boundaries = [
    { kind: "region", label: "Deployment", wraps: ["a", "b", "c"] },
    { kind: "security-group", label: "Private", wraps: ["b", "c"] },
  ];
  spec.connections = [{ from: "a", to: "b", label: "HTTPS" }, { from: "b", to: "c", label: "SQL" }];
  return spec;
}
export const MAPPING_NOTES = {
  "architecture-placement-input": "For synthetic missing-position/grid-cell input only, the pinned renderer dereferences an absent coordinate and reports internal/unclassified. E1 rejects the same missing authored placement with an actionable placement-input diagnostic; no other internal error is mapped this way.",
};

export const INTENDED_DIFFERENCES = {
  "floorplan-outside-e1": "Floorplan has no E1 validator and remains an E5 input; its unsupported-type receipt is not a document-validity verdict.",
  "repository-evidence-stripped": "The differential document-validity input removes repository/source evidence, while preserving original input and original verdict; repository checkout verification is outside the pure E1 contract.",
  "dataflow-fixed-row-slots": "The pinned renderer's fixed row slots are a layout limitation, not an unbounded integer schema rule; E2 owns the geometry limit.",
  "dataflow-stage-canvas-width": "Five declared stages are schema-valid but exceed the pinned renderer's default canvas width; E2 owns computed frame clearance.",
  "lifecycle-reserved-main-lane": "The requirement for a lane named main is a reserved-lane layout convention explicitly deferred to E2.",
};

export function generatedCases() {
  const result = [];
  for (const type of TYPES) {
    const add = (rule, suffix, change, difference) => {
      const spec = seedFor(type);
      change(spec);
      result.push({ id: `e1-${type}-${rule}-${suffix}`, diagramType: type, rule, spec,
        expectedEngineCode: rule === "diagram-type" ? "document/diagram-type" : `${type}/${rule}`,
        ...(difference ? { currentScope: { kind: "e2-geometry", reasonId: difference, reason: INTENDED_DIFFERENCES[difference] } } : {}),
      });
    };
    add("valid", "minimal", () => {});
    add("valid", "metadata", (s) => {
      s.meta.locale = "en"; s.meta.translations = { "legend.title": "Legend" };
      s.meta.views = [{ id: "overview", label: "Overview", focus: ["a"] }];
      s.meta.legend = { mode: "hidden", entries: { [LEGEND_KEY[type]]: { label: "Kind" } } };
      s.cards = [{ dot: "cyan", title: "Notes", items: [] }];
    });
    add("shape", "missing-meta", (s) => { delete s.meta; });
    add("shape", "null-option", (s) => { s.meta.locale = null; });
    // JSON Schema objects must stay objects. Serde struct visitors also
    // support positional sequences, so each object boundary needs a negative.
    add("shape", "meta-array", (s) => { s.meta = [s.meta.title, s.meta.output]; });
    add("shape", "brand-array", (s) => { s[PRIMARY[type]][0].brand = ["https://example.test/logo.svg", "a".repeat(64)]; });
    add("shape", "primary-item-array", (s) => {
      const node = s[PRIMARY[type]][0];
      s[PRIMARY[type]][0] = type === "workflow" ? [node.id, node.lane, node.col, node.type, node.label]
        : type === "lifecycle" ? [node.id, node.type, node.label, "", "", "none", "Brand", [{ path: "fixture.ts" }], "Step", node.lane, node.col]
          : type === "dataflow" ? [node.id, node.type, node.label, node.stage, node.row]
            : type === "architecture" ? [node.id, node.type, node.label, node.row, node.col]
              : [node.id, node.type, node.label];
    });
    add("shape", "source-item-array", (s) => { s[PRIMARY[type]][0].sources = [["fixture.ts", 1, 2, "Lines"]]; });
    add("shape", "card-item-array", (s) => { s.cards = [["cyan", "Notes", ["Item"]]]; });
    add("shape", "view-item-array", (s) => { s.meta.views = [["overview", "Overview", ["a"]]]; });
    add("shape", "repository-array", (s) => { s.meta.repository = ["https://github.com/example/fixture", "a".repeat(40)]; });
    add("shape", "legend-array", (s) => { s.meta.legend = ["hidden", { [LEGEND_KEY[type]]: { label: "Kind" } }]; });
    add("shape", "legend-entry-array", (s) => { s.meta.legend = { mode: "hidden", entries: { [LEGEND_KEY[type]]: ["Kind", true] } }; });
    add("unknown-field", "top-level", (s) => { s.unexpected = true; });
    add("schema-version", "unsupported-version", (s) => { s.schema_version = ["workflow", "lifecycle"].includes(type) ? 3 : 2; });
    if (["workflow", "lifecycle"].includes(type)) add("valid", "minimal-version-two", (s) => { s.schema_version = 2; });
    add("diagram-type", "unsupported", (s) => { s.diagram_type = "unsupported"; });
    add("id", "invalid-primary", (s) => { s[PRIMARY[type]][0].id = "bad id"; });
    add("duplicate-id", "primary", (s) => { s[PRIMARY[type]][1].id = "a"; });
    add("duplicate-id", "relationship", (s) => {
      const relations = s[RELATIONS[type]]; relations[0].id = "relation";
      relations.push({ ...structuredClone(relations[0]), id: "relation" });
    });
    add("text", "empty-label", (s) => { s[PRIMARY[type]][0].label = ""; });
    add("enum", "unknown-node-type", (s) => { s[PRIMARY[type]][0].type = "unsupported"; });
    add("cardinality", "primary", (s) => { s[PRIMARY[type]] = []; });
    add("locale", "invalid", (s) => { s.meta.locale = "not a locale"; });
    add("output-path", "traversal", (s) => { s.meta.output = "../unsafe.html"; });
    add("output-path", "device-name", (s) => { s.meta.output = "con.html"; });
    add("output-path", "utf8-component-limit", (s) => { s.meta.output = `${"가".repeat(100)}.html`; });
    add("translations", "key", (s) => { s.meta.translations = { "Bad Key": "Text" }; });
    add("brand", "hash", (s) => { s[PRIMARY[type]][0].brand = { url: "https://example.test/logo.svg", sha256: "invalid" }; });
    add("sources", "too-many", (s) => { s[PRIMARY[type]][0].sources = Array.from({ length: 4 }, (_, i) => ({ path: `file-${i}.ts` })); });
    add("integer", "fractional-source-line", (s) => { s[PRIMARY[type]][0].sources = [{ path: "fixture.ts", line: 0.5 }]; });
    add("views", "too-many", (s) => { s.meta.views = Array.from({ length: 6 }, (_, i) => ({ id: `view-${i}`, label: "View", focus: ["a"] })); });
    add("legend", "empty-entry", (s) => { s.meta.legend = { entries: { [LEGEND_KEY[type]]: {} } }; });
    add("repository", "revision", (s) => { s.meta.repository = { url: "https://github.com/example/fixture", revision: "short" }; });
    add(REFERENCE_RULE[type], "missing-endpoint", (s) => { s[RELATIONS[type]][0].to = "missing"; });
    if (type === "architecture") {
      add("shape", "layout-array", (s) => { s.layout = ["grid"]; });
      add("range", "cols-zero", (s) => { s.layout.cols = 0; });
      add("integer", "fractional-row", (s) => { s.components[0].row = 0.5; });
      add("grid-column", "outside-declared-grid", (s) => { s.components[1].col = 4; });
      add("placement-input", "missing-free-position", (s) => { delete s.layout; });
      add("placement-input", "missing-grid-position", (s) => { delete s.components[0].row; delete s.components[0].col; });
      add("grid-cell", "duplicate", (s) => { s.components[1].col = 0; });
      add("valid", "position-overrides-grid-hints", (s) => {
        s.components[0].pos = [100, 180]; s.components[1].pos = [420, 180];
        s.components[0].col = 99; s.components[1].col = 99;
      });

      const profile = (rule, suffix, mutate) => add(rule, suffix, (s) => {
        Object.assign(s, deploymentSeed());
        mutate(s);
      });
      profile("valid", "deployment-profile", () => {});
      profile("deployment-boundary-kind", "missing-private-kind", (s) => { s.components[2].type = "backend"; s.boundaries = s.boundaries.filter((boundary) => boundary.kind === "region"); });
      profile("deployment-owner-missing", "untagged", (s) => { delete s.components[1].tag; });
      profile("deployment-region-scope", "unassigned", (s) => { s.boundaries[0].wraps = ["b", "c"]; });
      profile("deployment-region-ambiguous", "two-regions", (s) => { s.boundaries.push({ kind: "region", label: "Other", wraps: ["a"] }); });
      profile("deployment-private-state", "database-outside-private", (s) => { s.boundaries[1].wraps = ["b"]; });
      profile("deployment-private-region-consistency", "mixed-regions", (s) => { s.boundaries[0].wraps = ["a", "b"]; s.boundaries.push({ kind: "region", label: "Other", wraps: ["c"] }); });
      profile("deployment-crossing-mechanism", "unlabelled-crossing", (s) => { delete s.connections[0].label; });
      profile("ownership", "partial-membership", (s) => {
        s.components[2].type = "backend";
        s.boundaries = [
          { kind: "region", label: "Deployment", wraps: ["a", "b", "c"] },
          { kind: "security-group", label: "Left", wraps: ["a", "b"] },
          { kind: "security-group", label: "Right", wraps: ["b", "c"] },
        ];
      });
    } else if (type === "workflow") {
      add("shape", "lane-item-array", (s) => { s.lanes[0] = ["main", "Main"]; });
      add("shape", "required-edge-array", (s) => { s.semanticChecks = { requiredEdges: [["a", "b"]] }; });
      add("shape", "required-path-array", (s) => { s.semanticChecks = { requiredPaths: [["a", "c"]] }; });
      add("range", "column", (s) => { s.nodes[0].col = 6; });
      add("lane-reference", "node", (s) => { s.nodes[0].lane = "missing"; });
      add("phase-range", "reversed", (s) => { s.phases = [{ id: "phase", label: "Phase", fromCol: 3, toCol: 1 }]; });
      add("group-range", "reversed", (s) => { s.groups = [{ id: "group", label: "Group", lane: "main", fromCol: 3, toCol: 1 }]; });
      add("phase-overlap", "shared-column", (s) => { s.phases = [{ id: "first", label: "First", fromCol: 0, toCol: 1 }, { id: "second", label: "Second", fromCol: 1, toCol: 2 }]; });
      add("empty-group", "no-member", (s) => { s.groups = [{ id: "group", label: "Group", lane: "main", fromCol: 3, toCol: 3 }]; });
      add("main-path-node", "missing", (s) => { s.mainPath = ["a", "missing"]; });
      add("main-path-edge", "missing", (s) => { s.mainPath = ["a", "c"]; });
      add("main-path-order", "backward", (s) => { s.edges.push({ from: "b", to: "a" }); s.mainPath = ["b", "a"]; });
      add("semantic-checks-empty", "empty", (s) => { s.semanticChecks = {}; });
      add("semantic-node-reference", "missing", (s) => { s.semanticChecks = { requiredEdges: [{ from: "a", to: "missing" }] }; });
      add("unexpected-root", "not-allowed", (s) => { s.semanticChecks = { allowedRoots: [] }; });
      add("unexpected-terminal", "not-allowed", (s) => { s.semanticChecks = { allowedTerminals: [] }; });
      add("required-edge", "missing", (s) => { s.semanticChecks = { requiredEdges: [{ from: "a", to: "c" }] }; });
      add("required-path", "unreachable", (s) => { s.edges = [{ from: "a", to: "b" }]; s.semanticChecks = { requiredPaths: [{ from: "a", to: "c" }] }; });
    } else if (type === "sequence") {
      add("shape", "segment-item-array", (s) => { s.segments = [[170, 230, "Phase"]]; });
      add("shape", "activation-item-array", (s) => { s.activations = [["a", 180, 220]]; });
      add("range", "message-y", (s) => { s.messages[0].y = 159; });
      add("participant-reference", "activation", (s) => { s.activations = [{ participant: "missing", from: 180, to: 220 }]; });
      add("range-order", "segment", (s) => { s.segments = [{ from: 230, to: 180, label: "Phase" }]; });
      add("range-order", "activation", (s) => { s.activations = [{ participant: "a", from: 230, to: 180 }]; });
      add("valid", "below-canvas", (s) => { s.messages[0].y = 2000; });
    } else if (type === "dataflow") {
      add("shape", "stage-item-array", (s) => { s.stages[0] = ["Input"]; });
      add("range", "node-width", (s) => { s.nodes[0].width = 47; });
      add("integer", "fractional-row", (s) => { s.nodes[0].row = 0.5; });
      add("stage-reference", "past-last", (s) => { s.nodes[0].stage = 2; });
      add("valid", "unbounded-row", (s) => { s.nodes[0].row = 1_000_000_000_000; }, "dataflow-fixed-row-slots");
      add("valid", "five-stages", (s) => { s.stages.push({ label: "Third" }, { label: "Fourth" }, { label: "Fifth" }); }, "dataflow-stage-canvas-width");
    } else if (type === "lifecycle") {
      add("shape", "lane-item-array", (s) => { s.lanes[0] = ["main", "Main"]; });
      add("range", "column", (s) => { s.states[0].col = 5; });
      add("lane-count", "too-many", (s) => { s.lanes.push(...["one", "two", "three", "four"].map((id) => ({ id, label: id }))); });
      add("lane-reference", "state", (s) => { s.states[0].lane = "missing"; });
      add("valid", "nonreserved-lane", (s) => { s.lanes[0].id = "ordinary"; s.states.forEach((state) => { state.lane = "ordinary"; }); }, "lifecycle-reserved-main-lane");
    }
  }
  return result;
}

// Map only observed oracle causes. An expectedEngineCode is a checked hint:
// it may narrow an independently derived set, never create a candidate itself.
const PORTABLE_OUTPUT_REASONS = new Set([
  "type", "empty", "absolute", "drive-relative", "uri", "backslash", "empty-segment", "dot-segment",
  "control", "unpaired-surrogate", "windows-ads", "windows-invalid-character", "windows-trailing-dot-space",
  "windows-reserved-name", "windows-short-name", "component-too-long",
]);
const SEMANTIC_CODES = {
  "relationship/duplicate-id": "duplicate-id",
  "workflow/duplicate-lane-id": "duplicate-id",
  "workflow/duplicate-node-id": "duplicate-id",
  "workflow/unknown-edge-endpoint": "edge-endpoint",
  "workflow/unknown-node-lane": "lane-reference",
  "workflow/invalid-node-column": "range",
  "workflow/semantic-node-reference": "semantic-node-reference",
  "workflow/unexpected-root": "unexpected-root",
  "workflow/unexpected-terminal": "unexpected-terminal",
  "workflow/required-edge": "required-edge",
  "workflow/required-path": "required-path",
};
/** @type {Array<[RegExp, string]>} */
const SEMANTIC_MESSAGES = [
  [/ids must be unique|node id .* is duplicated|lane id .* is duplicated/i, "duplicate-id"],
  [/col .* exceeds layout[.]cols/, "grid-column"],
  [/references unknown (source|target)/, "endpoint"],
  [/uses unknown lane|references unknown lane/, "lane-reference"],
  [/uses invalid stage/, "stage-reference"],
  [/Activation references unknown participant/, "participant-reference"],
  [/Segment .* has invalid y range|Activation .* has invalid time range/, "range-order"],
  [/Phase .* uses invalid columns/, "phase-range"],
  [/Group .* uses invalid columns/, "group-range"],
  [/Phase .* overlaps phase/, "phase-overlap"],
  [/Group .* does not contain any nodes/, "empty-group"],
  [/mainPath references unknown node/, "main-path-node"],
  [/mainPath step .* has no matching edge/, "main-path-edge"],
  [/mainPath step .* moves backward/, "main-path-order"],
  [/Boundary .* memberships partially overlap|Boundary .* crosses boundary .*memberships partially overlap/, "ownership"],
  [/already assigned.*cell|share grid cell row|same grid cell|duplicate.*grid cell|grid cell .*already|same row.*col/i, "grid-cell"],
  [/must include pos .*when layout[.]mode is omitted|needs pos .*or grid row\/col when layout[.]mode/, "placement-input"],
];
function schemaRule(diagnostic, type) {
  const code = diagnostic.code ?? "";
  const path = diagnostic.subject?.path ?? "";
  const keyword = code.slice("schema/".length);
  if (["required", "type"].includes(keyword)) return ["shape"];
  if (keyword === "additionalProperties") return ["unknown-field", "shape"];
  if (path === "/schema_version") return ["schema-version"];
  if (path === "/diagram_type") return ["document/diagram-type"];
  if (path.includes("/meta/output")) return ["output-path"];
  if (path.includes("/meta/locale")) return ["locale"];
  if (path.includes("/meta/translations")) return ["translations"];
  if (path.includes("/meta/repository/revision")) return ["repository"];
  if (path.includes("/brand")) return ["brand", "shape"];
  if (path.endsWith("/id") || path.includes("/wraps/") || path.includes("/focus/")) return ["id"];
  if (path.includes("/sources") && ["minItems", "maxItems"].includes(keyword)) return ["sources"];
  if (path === "/meta/views" && keyword === "maxItems") return ["views"];
  if (path.includes("/meta/legend/entries") && keyword === "minProperties") return ["legend"];
  if (path === "/semanticChecks" && keyword === "minProperties") return ["semantic-checks-empty"];
  if (type === "lifecycle" && path === "/lanes" && keyword === "maxItems") return ["lane-count"];
  if (["minimum", "maximum"].includes(keyword)) return ["range"];
  if (["minItems", "maxItems"].includes(keyword)) return ["cardinality"];
  if (["minLength", "maxLength"].includes(keyword)) return ["text"];
  if (["enum", "const"].includes(keyword)) return ["enum"];
  return [];
}
function missingArchitecturePlacement(item) {
  if (item.diagramType !== "architecture" || item.origin?.kind !== "synthetic-generated" || item.rule !== "placement-input") return false;
  const spec = JSON.parse(item.inputJson);
  return spec.components?.some((component) => !Array.isArray(component.pos)
    && (!spec.layout || component.row === undefined || component.col === undefined));
}
export function equivalentCodes(item, report) {
  const type = item.diagramType;
  const result = new Set();
  for (const diagnostic of report.diagnostics ?? []) {
    const code = diagnostic.code ?? "";
    const message = diagnostic.message ?? "";
    const add = (suffix) => result.add(suffix.includes("/") ? suffix : `${type}/${suffix}`);
    const portableReason = diagnostic.evidence?.reason;
    if (typeof portableReason === "string" && PORTABLE_OUTPUT_REASONS.has(portableReason)
        && diagnostic.subject?.path === "/meta/output"
        && (code === `portable-path/${portableReason}` || ["output/meta-path-syntax", "output/meta-absolute"].includes(code))) {
      add("output-path");
    } else if (code.startsWith("schema/")) {
      for (const suffix of schemaRule(diagnostic, type)) add(suffix);
      // Fractional schema integers may be decoded by a bounded integer model
      // or reach the shared integer validator; both reject the same property.
      if (code === "schema/type" && diagnostic.evidence?.type === "integer") { add("integer"); add("shape"); }
    } else if (code.startsWith("engineering/deployment-") && Object.hasOwn(specificRules.architecture, code.slice("engineering/".length))) {
      add(code.slice("engineering/".length));
    } else if (SEMANTIC_CODES[code]) add(SEMANTIC_CODES[code]);
    else {
      for (const [pattern, suffix] of SEMANTIC_MESSAGES) if (pattern.test(message)) add(suffix === "endpoint" ? REFERENCE_RULE[type] : suffix);
      if (code === "internal/unclassified" && missingArchitecturePlacement(item)
          && /Cannot read properties of undefined.*reading ["']0["']/.test(message)) add("placement-input");
    }
  }
  const mapped = [...result];
  if (item.expectedEngineCode) {
    if (!result.has(item.expectedEngineCode)) throw new Error(`Oracle cause for ${item.id} does not map to expected rule ${item.expectedEngineCode}; observed ${report.codes.join(", ")} -> ${mapped.join(", ")}. Inspect the actual diagnostic before changing a rule.`);
    return [item.expectedEngineCode];
  }
  if (!mapped.length) throw new Error(`Unmapped oracle refusal for ${item.id}: ${report.codes.join(", ")}; add a specific equivalent rule or a named scope decision.`);
  return mapped;
}

const GEOMETRY_SIGNATURES = {
  "dataflow-fixed-row-slots": /uses invalid row|produced non-finite coordinates/,
  "dataflow-stage-canvas-width": /Stages exceed viewBox width/,
  "lifecycle-reserved-main-lane": /need[s]? a lane with id ["']main["']/,
};
export function comparisonFor(item) {
  const full = item.validityOracle ?? item.oracle;
  const schema = item.validitySchemaOracle ?? item.schemaOracle;
  const document = item.validityDocumentOracle ?? item.documentOracle;
  if (full.ok && document && !document.ok) throw new Error(`Oracle document/CLI layers disagree for ${item.id}; inspect the pinned profile contract before regenerating.`);
  if (full.ok && schema && !schema.ok) throw new Error(`Oracle layers disagree for ${item.id}; inspect the pinned schema/CLI before regenerating.`);
  // A schema refusal is the document-validity reason even if a later CLI
  // boundary would also require repository evidence. Do not attribute it to
  // layout or filesystem verification.
  const selected = schema && !schema.ok ? schema : document && !document.ok ? document : full;
  const inputJson = item.validityInputJson ?? item.inputJson;
  if (item.diagramType === "floorplan") return {
    inputJson, accepted: false, equivalentCodes: ["document/diagram-type"],
    currentScope: { kind: "e5-floorplan", reasonId: "floorplan-outside-e1", reason: INTENDED_DIFFERENCES["floorplan-outside-e1"] },
  };
  if (item.currentScope?.kind === "e2-geometry") {
    if (!item.documentOracle?.ok) throw new Error(`Named E2 case ${item.id} fails a nongeometry document rule; repair its scoped input before regenerating.`);
    if (!item.schemaOracle?.ok) throw new Error(`Named E2 case ${item.id} is not schema-valid; repair the synthetic case before regenerating.`);
    if (selected.ok) throw new Error(`Named E2 case ${item.id} was accepted by the oracle; remove the unnecessary difference before regenerating.`);
    const signature = GEOMETRY_SIGNATURES[item.currentScope.reasonId];
    const messages = (selected.diagnostics ?? []).map((diagnostic) => diagnostic.message ?? "").join("\n");
    if (!signature || !signature.test(messages)) throw new Error(`Named E2 case ${item.id} did not produce its specific deferred geometry cause; inspect the oracle diagnostic rather than waiving it.`);
    return { inputJson, accepted: true, equivalentCodes: [], currentScope: item.currentScope };
  }
  return { inputJson, accepted: selected.ok, equivalentCodes: selected.ok ? [] : equivalentCodes(item, selected),
    oracleLayer: schema && !schema.ok ? "schema" : document && !document.ok ? "document-profile" : item.validityOracle ? "evidence-stripped-full" : "full",
    ...(item.rule === "placement-input" && selected.codes.includes("internal/unclassified") ? { oracleMapping: { reasonId: "architecture-placement-input", reason: MAPPING_NOTES["architecture-placement-input"] } } : {}),
    currentScope: item.validityOracle ? { kind: "document-validity", reasonId: "repository-evidence-stripped", reason: INTENDED_DIFFERENCES["repository-evidence-stripped"] } : { kind: "document-validity" },
  };
}
