import { describe, expect, it } from "vitest";

import { SEMANTIC_FIXTURES } from "./__fixtures__/semantic";
import { archifySpecToDataset } from "./archifyCodec";
import { deserializeDoc, serializeDoc } from "./persistence";
import { SEMANTIC_DIAGRAM_TYPES, type SemanticDiagramType, type SemanticSpecDataset } from "./reportTypes";
import {
  detachSemanticDataset,
  mintRelationIds,
  orderSemanticContainers,
  projectSemanticDataset,
  projectSemanticDocument,
  resolveSemanticMember,
  semanticDatasetsIn,
  validateSemanticContent,
  writeThroughText,
} from "./semantic";
import type { DiagramDoc, DiagramNode } from "./types";

const fixture = (type: SemanticDiagramType) => structuredClone(SEMANTIC_FIXTURES[type]);
const datasetOf = (type: SemanticDiagramType, spec = fixture(type), id = `ds-${type}`) =>
  archifySpecToDataset(type, spec, { id }).dataset;
const docOf = (type: SemanticDiagramType, spec = fixture(type)) =>
  projectSemanticDocument(datasetOf(type, spec)).doc;

const keys = (type: SemanticDiagramType, spec: Record<string, unknown>) =>
  validateSemanticContent(type, spec).map((d) => d.key);

function contains(outer: DiagramNode, inner: DiagramNode): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

describe("validateSemanticContent", () => {
  it("accepts every fixture, with and without minted relation ids", () => {
    for (const type of SEMANTIC_DIAGRAM_TYPES) {
      expect(validateSemanticContent(type, fixture(type))).toEqual([]);
      expect(validateSemanticContent(type, mintRelationIds(type, fixture(type)).spec)).toEqual([]);
    }
  });

  it("reports references the schema cannot express", () => {
    const sequence = fixture("sequence");
    (sequence.messages as Record<string, unknown>[])[0]!.to = "ghost";
    expect(validateSemanticContent("sequence", sequence)).toContainEqual({
      key: "diagram.semantic.danglingReference",
      params: { field: "messages[0].to", id: "ghost" },
    });

    const self = fixture("sequence");
    (self.messages as Record<string, unknown>[])[1]!.to = "api";
    expect(validateSemanticContent("sequence", self)).toContainEqual({
      key: "diagram.semantic.selfMessage",
      params: { field: "messages[1]" },
    });

    const lifecycle = fixture("lifecycle");
    (lifecycle.states as Record<string, unknown>[])[2]!.lane = "nowhere";
    expect(keys("lifecycle", lifecycle)).toContain("diagram.semantic.danglingReference");

    const dataflow = fixture("dataflow");
    (dataflow.nodes as Record<string, unknown>[])[1]!.stage = 2;
    expect(validateSemanticContent("dataflow", dataflow)).toContainEqual({
      key: "diagram.semantic.danglingReference",
      params: { field: "nodes[1].stage", id: "2" },
    });

    const architecture = fixture("architecture");
    (architecture.boundaries as Record<string, unknown>[])[0]!.wraps = ["api", "cache"];
    expect(keys("architecture", architecture)).toContain("diagram.semantic.danglingReference");

    const workflow = fixture("workflow");
    workflow.mainPath = ["draft", "nope"];
    expect(keys("workflow", workflow)).toContain("diagram.semantic.danglingReference");
  });

  it("reports duplicate relation ids", () => {
    const spec = fixture("dataflow");
    spec.flows = [
      { id: "f", from: "app", to: "wh", label: "a" },
      { id: "f", from: "wh", to: "app", label: "b" },
    ];
    expect(validateSemanticContent("dataflow", spec)).toContainEqual({
      key: "diagram.semantic.duplicateId",
      params: { field: "flows[1]", id: "f" },
    });
  });

  it("reports schema errors as specMeta", () => {
    const spec = fixture("lifecycle");
    (spec.states as Record<string, unknown>[])[0]!.col = 9;
    expect(keys("lifecycle", spec)).toContain("diagram.validation.specMeta");
  });
});

describe("mintRelationIds", () => {
  it("mints prefixed ids that avoid every declared id, id first", () => {
    const spec = fixture("sequence");
    (spec.participants as Record<string, unknown>[])[0]!.id = "msg1";
    (spec.messages as Record<string, unknown>[]).forEach((message) => {
      if (message.from === "web") message.from = "msg1";
      if (message.to === "web") message.to = "msg1";
    });
    const { spec: minted, minted: count } = mintRelationIds("sequence", spec);
    expect(count).toBe(4);
    const ids = (minted.messages as Record<string, unknown>[]).map((m) => m.id);
    expect(ids).toEqual(["msg2", "msg3", "msg4", "msg5"]);
    expect(Object.keys((minted.messages as Record<string, unknown>[])[0]!)[0]).toBe("id");
  });

  it("also avoids reserved canvas ids", () => {
    const { spec: minted } = mintRelationIds("sequence", fixture("sequence"), ["msg1", "msg2"]);
    const ids = (minted.messages as Record<string, unknown>[]).map((m) => m.id);
    expect(ids).toEqual(["msg3", "msg4", "msg5", "msg6"]);
  });

  it("is idempotent and leaves explicit ids alone", () => {
    for (const type of SEMANTIC_DIAGRAM_TYPES) {
      const once = mintRelationIds(type, fixture(type)).spec;
      const twice = mintRelationIds(type, once);
      expect(twice.minted).toBe(0);
      expect(twice.spec).toBe(once);
    }
  });
});

describe("projectSemanticDataset", () => {
  it("is deterministic", () => {
    for (const type of SEMANTIC_DIAGRAM_TYPES) {
      const a = projectSemanticDataset(datasetOf(type), { containers: true });
      const b = projectSemanticDataset(datasetOf(type), { containers: true });
      expect(a).toEqual(b);
    }
  });

  it("orders sequence messages by y with strictly increasing midOff brackets", () => {
    const spec = fixture("sequence");
    const messages = spec.messages as Record<string, unknown>[];
    // Swap array positions of messages 2 and 3 without touching y.
    [messages[1], messages[2]] = [messages[2]!, messages[1]!];
    const { nodes, edges } = projectSemanticDataset(datasetOf("sequence", spec));
    expect(nodes.map((n) => [n.id, n.x, n.y])).toEqual([
      ["web", 40, 40],
      ["api", 240, 40],
      ["db", 440, 40],
    ]);
    const byLabel = new Map(edges.map((e) => [e.label, e]));
    const order = ["POST /login", "find user", "row", "200 OK"].map((label) => byLabel.get(label)!.midOff!);
    expect(order).toEqual([40, 72, 104, 136]);
    expect(edges.every((e) => e.fromPort === "s" && e.toPort === "s")).toBe(true);
    expect(byLabel.get("row")!.dash).toBe("dashed");
    expect(byLabel.get("find user")!.dash).toBe("solid");
  });

  it("maps lifecycle state types to node kinds", () => {
    const spec = fixture("lifecycle");
    (spec.states as Record<string, unknown>[]).push(
      { id: "gate", type: "decision", label: "Gate", lane: "main", col: 3 },
      { id: "err", type: "failure", label: "Error", lane: "main", col: 4 },
    );
    const kinds = Object.fromEntries(projectSemanticDataset(datasetOf("lifecycle", spec)).nodes.map((n) => [n.id, n.kind]));
    expect(kinds).toEqual({ queued: "oval", running: "simple", done: "oval", gate: "diamond", err: "oval" });
  });

  it("puts namespaced containers first and encloses their members", () => {
    const lifecycle = projectSemanticDataset(datasetOf("lifecycle"), { containers: true }).nodes;
    expect(lifecycle[0]).toMatchObject({
      id: "ds-lifecycle:lane:main",
      kind: "section",
      title: "Main",
      meta: { memberId: "ds-lifecycle:lane:main", semanticContainer: "lane" },
    });
    for (const member of lifecycle.slice(1)) expect(contains(lifecycle[0]!, member)).toBe(true);

    const dataflow = projectSemanticDataset(datasetOf("dataflow"), { containers: true }).nodes;
    expect(dataflow.slice(0, 2).map((n) => n.id)).toEqual(["ds-dataflow:stage:0", "ds-dataflow:stage:1"]);
    expect(contains(dataflow[0]!, dataflow.find((n) => n.id === "app")!)).toBe(true);
    expect(contains(dataflow[1]!, dataflow.find((n) => n.id === "wh")!)).toBe(true);

    const workflow = projectSemanticDataset(datasetOf("workflow"), { containers: true }).nodes;
    const reviewer = workflow.find((n) => n.id === "ds-workflow:lane:reviewer")!;
    expect(contains(reviewer, workflow.find((n) => n.id === "review")!)).toBe(true);
    expect(contains(reviewer, workflow.find((n) => n.id === "draft")!)).toBe(false);
  });

  it("stacks entities that share a lane cell and grows the band", () => {
    const spec = fixture("lifecycle");
    (spec.states as Record<string, unknown>[]).push({ id: "retry", type: "waiting", label: "Retry", lane: "main", col: 1 });
    const nodes = projectSemanticDataset(datasetOf("lifecycle", spec), { containers: true }).nodes;
    const running = nodes.find((n) => n.id === "running")!;
    const retry = nodes.find((n) => n.id === "retry")!;
    expect(retry.x).toBe(running.x);
    expect(retry.y).toBe(running.y + 80);
    expect(contains(nodes[0]!, retry)).toBe(true);
  });

  it("projects workflow column ranges as owned phase/group containers without moving members", () => {
    const spec = fixture("workflow");
    spec.phases = [{ id: "build", label: "Build", fromCol: 0, toCol: 2 }];
    spec.groups = [{ id: "publish", label: "Publish", lane: "author", fromCol: 2, toCol: 2 }];
    const dataset = datasetOf("workflow", spec);
    expect(validateSemanticContent("workflow", spec)).toEqual([]);
    const projected = projectSemanticDataset(dataset, { containers: true });
    expect(projected.diagnostics).toEqual([]);
    expect(projected.nodes[0]!.id).toBe("ds-workflow:phase:build");
    const phase = projected.nodes.find((node) => node.id === "ds-workflow:phase:build")!;
    const group = projected.nodes.find((node) => node.id === "ds-workflow:group:publish")!;
    for (const id of ["draft", "review", "merge"]) expect(contains(phase, projected.nodes.find((node) => node.id === id)!)).toBe(true);
    expect(contains(group, projected.nodes.find((node) => node.id === "merge")!)).toBe(true);
    expect(contains(group, projected.nodes.find((node) => node.id === "review")!)).toBe(false);
    expect(projectSemanticDataset(dataset).nodes).toEqual(projectSemanticDataset(datasetOf("workflow")).nodes);
    const doc = projectSemanticDocument(dataset).doc;
    expect(resolveSemanticMember(doc, { nodeId: phase.id })).toMatchObject({ kind: "container", role: "phase", field: "phases", key: "build" });
    expect(resolveSemanticMember(doc, { nodeId: group.id })).toMatchObject({ kind: "container", role: "group", field: "groups", key: "publish" });
    const detached = detachSemanticDataset(doc, dataset.id);
    expect(detached.losses).toContainEqual({ key: "diagram.semantic.loss.phases", params: { count: 1 } });
    expect(detached.losses).toContainEqual({ key: "diagram.semantic.loss.groups", params: { count: 1 } });
    const forged = { ...doc, nodes: doc.nodes.map((node) => node.id === phase.id ? { ...node, meta: { ...node.meta, semanticContainer: "group" } } : node) };
    expect(resolveSemanticMember(forged, { nodeId: phase.id })).toBeNull();
  });

  it.each(["workflow", "sequence"] as const)("reopens an existing %s canvas without adding ranges or changing geometry", (type) => {
    // Persisted canvases already carry the migrator's default fields.
    const doc = deserializeDoc(serializeDoc(docOf(type)));
    const spec = fixture(type);
    if (type === "workflow") {
      spec.phases = [{ id: "build", label: "Build", fromCol: 0, toCol: 2 }];
      spec.groups = [{ id: "publish", label: "Publish", lane: "author", fromCol: 2, toCol: 2 }];
    } else {
      spec.segments = [{ from: 170, to: 290, label: "Lookup" }];
      spec.activations = [{ participant: "api", from: 180, to: 280 }];
    }
    doc.datasets = [datasetOf(type, spec)];
    doc.nodes = doc.nodes.map((node) => ({ ...node, x: node.x + 7, y: node.y + 3 }));
    const body = serializeDoc(doc);
    const reopened = deserializeDoc(body);
    expect(serializeDoc(reopened)).toBe(body);
    expect(reopened.nodes.map((node) => node.id)).toEqual(doc.nodes.map((node) => node.id));
  });

  it("maps sequence ranges to the unchanged message brackets and resolves their index keys", () => {
    const spec = fixture("sequence");
    spec.segments = [{ from: 170, to: 290, label: "Lookup" }];
    spec.activations = [{ participant: "api", from: 180, to: 280 }];
    expect(validateSemanticContent("sequence", spec)).toEqual([]);
    const dataset = datasetOf("sequence", spec);
    const doc = projectSemanticDocument(dataset).doc;
    const segment = doc.nodes.find((node) => node.id === "ds-sequence:segment:0")!;
    const activation = doc.nodes.find((node) => node.id === "ds-sequence:activation:0")!;
    expect(segment.y).toBeCloseTo(105.6);
    expect(segment.y + segment.h).toBeCloseTo(230.4);
    expect(segment.style?.bg).toBe("transparent");
    expect(activation).toMatchObject({ kind: "simple", x: 304, y: 144, w: 32, h: 64, title: "API", style: { bg: "transparent" } });
    expect(doc.edges).toEqual(projectSemanticDataset(datasetOf("sequence")).edges);
    expect(resolveSemanticMember(doc, { nodeId: segment.id })).toMatchObject({ role: "segment", field: "segments", index: 0 });
    expect(resolveSemanticMember(doc, { nodeId: activation.id })).toMatchObject({ role: "activation", field: "activations", index: 0 });
    const renamed = writeThroughText(doc, { nodeId: segment.id }, { title: "Fetch" })!;
    expect((renamed.datasets![0] as SemanticSpecDataset).spec.segments).toEqual([{ from: 170, to: 290, label: "Fetch" }]);
    expect(writeThroughText(doc, { nodeId: activation.id }, { title: "Work" })).toBeNull();
    const detached = detachSemanticDataset(doc, dataset.id);
    expect(detached.losses).toContainEqual({ key: "diagram.semantic.loss.segments", params: { count: 1 } });
    expect(detached.losses).toContainEqual({ key: "diagram.semantic.loss.activations", params: { count: 1 } });
    expect(detached.doc.nodes.every((node) => node.meta?.semanticContainer === undefined)).toBe(true);
  });

  it("keeps empty, single-message and equal-y sequence ranges finite and deterministic", () => {
    for (const ys of [[], [180], [180, 180], [180, 180, 280]]) {
      const spec = fixture("sequence");
      spec.messages = ys.map((y) => ({ from: "web", to: "api", y, label: "Request" }));
      spec.segments = [{ from: 160, to: 340, label: "Exchange" }];
      const dataset = datasetOf("sequence", spec);
      const projection = projectSemanticDataset(dataset, { containers: true });
      const segment = projection.nodes.find((node) => node.meta?.semanticContainer === "segment")!;
      expect([segment.x, segment.y, segment.w, segment.h].every(Number.isFinite)).toBe(true);
      expect(segment.h).toBeGreaterThan(0);
      expect(projection).toEqual(projectSemanticDataset(dataset, { containers: true }));
    }
  });

  it("orders nested frames only inside the owning dataset's container slots", () => {
    const frame = (dataset: string, role: "phase" | "lane" | "group"): DiagramNode => ({
      id: `${dataset}:${role}:x`, kind: "section", x: 0, y: 0, w: 100, h: 100,
      meta: { memberId: `${dataset}:${role}:x`, semanticContainer: role },
    });
    const nodes = [frame("other", "group"), frame("ds", "group"), frame("other", "phase"), frame("ds", "lane"), frame("ds", "phase")];
    const ordered = orderSemanticContainers(nodes, "ds");
    expect(ordered.map((node) => node.id)).toEqual(["other:group:x", "ds:phase:x", "other:phase:x", "ds:lane:x", "ds:group:x"]);
    expect(ordered[0]).toBe(nodes[0]);
    expect(ordered[2]).toBe(nodes[2]);
  });

  it("reports not-projected fields as informational diagnostics", () => {
    const spec = fixture("workflow");
    spec.mainPath = ["draft", "review", "merge"];
    spec.semanticChecks = {};
    const { diagnostics } = projectSemanticDataset(datasetOf("workflow", spec));
    expect(diagnostics).toEqual(["mainPath", "semanticChecks"].map((field) => ({ key: "diagram.semantic.notProjected", params: { field } })));
  });
});

describe("projectSemanticDocument", () => {
  it("builds a doc with dataset, members and containers for every type", () => {
    const counts = Object.fromEntries(
      SEMANTIC_DIAGRAM_TYPES.map((type) => {
        const doc = docOf(type);
        return [type, [doc.nodes.length, doc.edges.length, doc.datasets?.length]];
      }),
    );
    expect(counts).toEqual({
      architecture: [4, 2, 1],
      workflow: [5, 2, 1],
      sequence: [3, 4, 1],
      dataflow: [4, 1, 1],
      lifecycle: [4, 2, 1],
    });
  });

  it("wraps architecture boundaries around the laid-out members", () => {
    const doc = docOf("architecture");
    const boundary = doc.nodes[0]!;
    expect(boundary.id).toBe("ds-architecture:boundary:0");
    expect(contains(boundary, doc.nodes.find((n) => n.id === "api")!)).toBe(true);
    expect(contains(boundary, doc.nodes.find((n) => n.id === "db")!)).toBe(true);
  });
});

describe("resolveSemanticMember / writeThroughText", () => {
  const specOf = (doc: DiagramDoc) =>
    (doc.datasets![0] as SemanticSpecDataset).spec as Record<string, Record<string, unknown>[]>;

  it("resolves entities, containers and relations; freeform stays unresolved", () => {
    const doc = docOf("lifecycle");
    expect(resolveSemanticMember(doc, { nodeId: "running" })).toMatchObject({ kind: "entity", specId: "running", index: 1 });
    expect(resolveSemanticMember(doc, { nodeId: "ds-lifecycle:lane:main" })).toMatchObject({ kind: "container", key: "main" });
    expect(resolveSemanticMember(doc, { edgeId: "tr2" })).toMatchObject({ kind: "relation", index: 1 });
    const freeform = { ...doc, nodes: [...doc.nodes, { id: "note", kind: "text" as const, x: 0, y: 0, w: 10, h: 10 }] };
    expect(resolveSemanticMember(freeform, { nodeId: "note" })).toBeNull();
    expect(writeThroughText(freeform, { nodeId: "note" }, { title: "x" })).toBeUndefined();
  });

  it("writes title/body through to label/sublabel and refuses an empty label", () => {
    const doc = docOf("dataflow");
    const renamed = writeThroughText(doc, { nodeId: "wh" }, { title: "Lake", body: "S3" })!;
    expect(specOf(renamed).nodes![1]).toMatchObject({ label: "Lake", sublabel: "S3" });
    const cleared = writeThroughText(renamed, { nodeId: "wh" }, { body: "" })!;
    expect(specOf(cleared).nodes![1]).not.toHaveProperty("sublabel");
    expect(writeThroughText(doc, { nodeId: "wh" }, { title: "" })).toBeNull();
    expect(writeThroughText(doc, { nodeId: "wh" }, { x: 10 })).toBeUndefined();
  });

  it("renames containers but refuses a container body", () => {
    const doc = docOf("dataflow");
    const next = writeThroughText(doc, { nodeId: "ds-dataflow:stage:1" }, { title: "Persist" })!;
    expect(specOf(next).stages![1]).toEqual({ label: "Persist" });
    expect(writeThroughText(doc, { nodeId: "ds-dataflow:stage:1" }, { body: "x" })).toBeNull();
  });

  it("refuses empty required relation labels and drops optional ones", () => {
    expect(writeThroughText(docOf("dataflow"), { edgeId: "flow1" }, { label: "" })).toBeNull();
    const lifecycle = writeThroughText(docOf("lifecycle"), { edgeId: "tr1" }, { label: "" })!;
    expect(specOf(lifecycle).transitions![0]).not.toHaveProperty("label");
    const relabeled = writeThroughText(docOf("sequence"), { edgeId: "msg2" }, { label: "lookup" })!;
    expect(specOf(relabeled).messages![1]!.label).toBe("lookup");
  });

  it("resolves legacy index edge ids of id-less P1 relations", () => {
    const dataset = { ...datasetOf("workflow"), spec: fixture("workflow") };
    const doc: DiagramDoc = { ...docOf("workflow"), datasets: [dataset] };
    const next = writeThroughText(doc, { edgeId: "ds-workflow-e1" }, { label: "ship" })!;
    expect(specOf(next).edges![1]!.label).toBe("ship");
  });
});

describe("detachSemanticDataset / semanticDatasetsIn", () => {
  it("drops the dataset and member markers, keeps the canvas, lists losses", () => {
    const doc = docOf("dataflow");
    expect(semanticDatasetsIn(doc, ["app"]).map((d) => d.id)).toEqual(["ds-dataflow"]);
    expect(semanticDatasetsIn(doc, [], ["flow1"]).map((d) => d.id)).toEqual(["ds-dataflow"]);
    const { doc: detached, losses } = detachSemanticDataset(doc, "ds-dataflow");
    expect(detached.datasets).toEqual([]);
    expect(detached.nodes.map((n) => n.id)).toEqual(doc.nodes.map((n) => n.id));
    expect(detached.nodes.every((n) => n.meta === undefined)).toBe(true);
    expect(detached.edges).toEqual(doc.edges);
    expect(losses.map((l) => l.key)).toEqual([
      "diagram.semantic.loss.entityTypes",
      "diagram.semantic.loss.classifications",
      "diagram.semantic.loss.stages",
    ]);
    expect(semanticDatasetsIn(detached, ["app"])).toEqual([]);
  });

  it("is a no-op for an unknown dataset", () => {
    const doc = docOf("sequence");
    expect(detachSemanticDataset(doc, "missing")).toEqual({ doc, losses: [] });
  });
});
