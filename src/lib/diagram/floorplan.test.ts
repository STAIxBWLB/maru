import { describe, expect, it } from "vitest";

import { defaultCoalescer, undo, withSnapshot } from "./actions";
import { FLOORPLAN_FIXTURE } from "./__fixtures__/floorplan";
import { SEMANTIC_FIXTURES } from "./__fixtures__/semantic";
import { codecForFilename, getCodec } from "./codecs";
import { floorplanGlobMatches, isFloorplanRef, validateFloorplanSpec } from "./floorplan";
import { floorplanSpecToDataset, isFloorplanFile, parseFloorplanSpec } from "./floorplanCodec";
import { buildGenerationPrompt, createGenerationJob, runGenerationJob, type GenerationHost } from "./generation";
import { deserializeDoc, serializeDoc } from "./persistence";
import { validateSemanticSpec, type SemanticSpecDataset } from "./reportTypes";
import { projectSemanticDataset, projectSemanticDocument, semanticLosses, writeThroughText } from "./semantic";
import { applyValidatedSemanticEdit, validateSemanticDraft } from "./semanticApply";
import { addSemanticEntry, planSemanticEdit, removeSemanticEntries, setSpecField } from "./semanticEdit";
import { createDiagramStore } from "./state";
import { createEmptyDoc, createInitialEphemeral } from "./types";

const fixture = () => structuredClone(FLOORPLAN_FIXTURE);
const nodeIndex = (spec: Record<string, unknown>, id: string) =>
  (spec.nodes as Record<string, unknown>[]).findIndex((node) => node.id === id);

function storeOf(spec = fixture()) {
  const { dataset } = floorplanSpecToDataset(spec, { id: "fp" });
  return createDiagramStore({ doc: projectSemanticDocument(dataset).doc, ephemeral: createInitialEphemeral() });
}
const specOf = (store: ReturnType<typeof storeOf>) =>
  (store.getState().doc.datasets!.find((d) => d.id === "fp") as SemanticSpecDataset).spec;

/** Engine host that must never be called for floorplan. */
const refusingHost = {
  validateCandidate: async () => {
    throw new Error("engine must not be called for floorplan");
  },
};

describe("floorplan validation", () => {
  it("accepts the trimmed public fixture", () => {
    expect(validateFloorplanSpec(fixture())).toEqual([]);
  });

  it("names the field of every problem", () => {
    const spec = fixture();
    const nodes = spec.nodes as Record<string, unknown>[];
    nodes[1]!.kind = "widget";
    nodes.push({ id: "ahub", label: "dup", kind: "ui" });
    nodes.push({ id: "orphan", label: "Orphan", kind: "ui", parent: "ghost" });
    (spec.edges as Record<string, unknown>[]).push({ from: "ahub", to: "ahub.ghost", kind: "call" });
    (spec.flows as Record<string, unknown>[]).push({ id: "short", title: "Short", steps: [{ node: "ahub" }] });
    (spec.tour as Record<string, unknown>[]).push({ node: "amem.ghost", title: "x", note: "y" });
    const keys = validateFloorplanSpec(spec);
    expect(keys).toContainEqual({ key: "diagram.validation.specMeta", params: { field: "nodes[1].kind" } });
    expect(keys).toContainEqual(expect.objectContaining({ key: "diagram.semantic.duplicateId", params: expect.objectContaining({ id: "ahub" }) }));
    expect(keys).toContainEqual({ key: "diagram.semantic.danglingReference", params: { field: `nodes[${nodes.length - 1}].parent`, id: "ghost" } });
    expect(keys).toContainEqual(expect.objectContaining({ key: "diagram.semantic.danglingReference", params: expect.objectContaining({ id: "ahub.ghost" }) }));
    expect(keys).toContainEqual(expect.objectContaining({ key: "diagram.semantic.flowTooShort" }));
    expect(keys).toContainEqual(expect.objectContaining({ key: "diagram.semantic.danglingReference", params: expect.objectContaining({ field: "tour[4].node" }) }));
  });

  it("refuses a parent cycle", () => {
    const spec = fixture();
    (spec.nodes as Record<string, unknown>[])[0]!.parent = "ahub.hub";
    expect(validateFloorplanSpec(spec).map((d) => d.key)).toContain("diagram.semantic.parentCycle");
  });

  it("tells file paths from dangling dotted ids", () => {
    const ids = new Set(["api", "web"]);
    expect(isFloorplanRef("api", ids)).toBe(true);
    expect(isFloorplanRef("shop-api/app.py", ids)).toBe(true);
    expect(isFloorplanRef("app.py", ids)).toBe(true);
    expect(isFloorplanRef("api.ghost", ids)).toBe(false);
    expect(isFloorplanRef("ghost", ids)).toBe(false);
  });

  it("matches upstream globs", () => {
    expect(floorplanGlobMatches("agent-hub/**", "agent-hub/src/a.ts")).toBe(true);
    expect(floorplanGlobMatches("shop-api/app", "shop-api/app/routes/x.py")).toBe(true);
    expect(floorplanGlobMatches("src/{a,b}.ts", "src/b.ts")).toBe(true);
    expect(floorplanGlobMatches("src/*.ts", "src/x/y.ts")).toBe(false);
  });
});

describe("floorplan codec", () => {
  it("is recognized by suffix, or architecture.json only by $schema", () => {
    const text = JSON.stringify(FLOORPLAN_FIXTURE);
    expect(codecForFilename("map.floorplan.json")?.id).toBe("floorplan-json");
    expect(codecForFilename("architecture.json", text)?.id).toBe("floorplan-json");
    expect(codecForFilename("floorplan/architecture.json", text)?.id).toBe("floorplan-json");
    expect(codecForFilename("architecture.json")?.id).toBe("maru-json");
    expect(codecForFilename("architecture.json", JSON.stringify(SEMANTIC_FIXTURES.architecture))?.id).toBe("maru-json");
    expect(codecForFilename("shop.architecture.json", text)?.id).toBe("archify-json");
    expect(isFloorplanFile("architecture.json", "{")).toBe(false);
  });

  it("round-trips every field, unknown ones included, through import, save and export (AC1)", async () => {
    const input = fixture();
    input.futureTop = { keep: true };
    (input.nodes as Record<string, unknown>[])[0]!.owner = "team-a";
    (input.edges as Record<string, unknown>[])[0]!.weight = 3;
    input.annotations = [{ path: "agent-hub/src/hub/tasks.ts", note: "hotspot", tags: ["hotspot"] }];
    const codec = getCodec("floorplan-json")!;
    const imported = codec.parse!(JSON.stringify(input), "x.floorplan.json");
    if (imported.result.kind !== "doc") throw new Error("expected doc");
    const warnings = imported.warnings.map((w) => `${w.key}:${String(w.params?.field ?? "")}`);
    expect(warnings).toEqual(expect.arrayContaining([
      "diagram.floorplan.unknownField:futureTop",
      "diagram.floorplan.unknownField:nodes[0].owner",
      "diagram.floorplan.unknownField:edges[0].weight",
      "diagram.semantic.notProjected:paths",
      "diagram.semantic.notProjected:flows",
      "diagram.semantic.notProjected:tour",
      "diagram.semantic.notProjected:annotations",
    ]));
    const reloaded = deserializeDoc(serializeDoc(imported.result.doc));
    const exported = await codec.serialize!({ doc: reloaded });
    expect(JSON.parse(exported.bytes as string)).toEqual(input);
    const dataset = reloaded.datasets!.find((d) => d.kind === "semanticSpec") as SemanticSpecDataset;
    expect(validateSemanticSpec(dataset).ok).toBe(true);
    expect(semanticLosses(dataset).map((l) => l.key)).toContain("diagram.semantic.loss.notProjected");
  });

  it("refuses an invalid map with the field named", () => {
    const spec = fixture();
    (spec.nodes as Record<string, unknown>[])[0]!.kind = "nope";
    const outcome = parseFloorplanSpec(JSON.stringify(spec));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.diagnostics[0]).toEqual({ key: "diagram.validation.specMeta", params: { field: "nodes[0].kind" } });
    expect(() => getCodec("floorplan-json")!.parse!(JSON.stringify(spec), "x.floorplan.json")).toThrow(/nodes\[0\]\.kind/);
  });

  it("does not let the Archify codec export a floorplan dataset", async () => {
    const doc = storeOf().getState().doc;
    expect(() => getCodec("archify-json")!.serialize!({ doc })).toThrow("diagram.archify.noSemanticDataset");
  });
});

describe("floorplan projection", () => {
  it("projects nested containers, members and kind-labelled edges deterministically", () => {
    const { dataset } = floorplanSpecToDataset(fixture(), { id: "fp" });
    const a = projectSemanticDataset(dataset);
    expect(a).toEqual(projectSemanticDataset(dataset));
    const byId = new Map(a.nodes.map((node) => [node.id, node]));
    expect(a.nodes).toHaveLength(21);
    expect(byId.get("ahub")!.kind).toBe("section");
    expect(byId.get("ahub.hub")!.kind).toBe("section");
    expect(byId.get("ahub.cli")!.kind).toBe("simple");
    expect(byId.get("github")!.kind).toBe("hexagon");
    const inside = (outer: string, inner: string) => {
      const o = byId.get(outer)!;
      const i = byId.get(inner)!;
      return i.x >= o.x && i.y >= o.y && i.x + i.w <= o.x + o.w && i.y + i.h <= o.y + o.h;
    };
    expect(inside("ahub", "ahub.hub")).toBe(true);
    expect(inside("ahub.hub", "ahub.hub.tasks")).toBe(true);
    expect(inside("acon.server", "acon.plugins")).toBe(true);
    expect(inside("ahub", "amem.core")).toBe(false);
    // Parents paint before their children.
    expect(a.nodes.findIndex((n) => n.id === "ahub")).toBeLessThan(a.nodes.findIndex((n) => n.id === "ahub.hub.tasks"));
    expect(a.edges).toHaveLength((FLOORPLAN_FIXTURE.edges as unknown[]).length);
    expect(a.edges[0]).toMatchObject({ id: "fp-e0", fromNode: "ahub.hub.memory", toNode: "amem.core", label: "embeds @staix/agent-mem" });
  });

  it("draws a file-path endpoint on the deepest node that claims it", () => {
    const spec = fixture();
    spec.edges = [{ from: "agent-hub/src/hub/bus.ts", to: "github", kind: "http" }];
    const { dataset } = floorplanSpecToDataset(spec, { id: "fp" });
    expect(projectSemanticDataset(dataset).edges[0]).toMatchObject({ fromNode: "ahub.hub.bus", toNode: "github", label: "http" });
  });

  it("writes a canvas body edit through to summary", () => {
    const store = storeOf();
    const doc = writeThroughText(store.getState().doc, { nodeId: "ahub.cli" }, { title: "CLI", body: "New summary" })!;
    const spec = (doc.datasets![0] as SemanticSpecDataset).spec;
    const node = (spec.nodes as Record<string, unknown>[])[nodeIndex(spec, "ahub.cli")]!;
    expect(node).toMatchObject({ label: "CLI", summary: "New summary" });
    expect(node.sublabel).toBeUndefined();
  });
});

describe("floorplan editing (AC2)", () => {
  it("edits kind and parent as one undo step each, through the local gate only", async () => {
    const store = storeOf();
    const before = JSON.stringify(store.getState().doc);
    const index = nodeIndex(specOf(store), "ahub.cli");
    const kind = await applyValidatedSemanticEdit(store, "fp", setSpecField("nodes", index, "kind", "script"), refusingHost);
    expect(kind.status).toBe("applied");
    const moved = await applyValidatedSemanticEdit(store, "fp", setSpecField("nodes", index, "parent", "amem"), refusingHost);
    expect(moved.status).toBe("applied");
    const doc = store.getState().doc;
    const amem = doc.nodes.find((n) => n.id === "amem")!;
    const cli = doc.nodes.find((n) => n.id === "ahub.cli")!;
    expect(cli.x >= amem.x && cli.x + cli.w <= amem.x + amem.w).toBe(true);
    expect(store.getState().ephemeral.history.past).toHaveLength(2);
    store.setState(undo());
    store.setState(undo());
    expect(JSON.stringify(store.getState().doc)).toBe(before);
  });

  it("refuses a parent cycle without committing", async () => {
    const store = storeOf();
    const before = store.getState().doc;
    const outcome = await applyValidatedSemanticEdit(store, "fp", setSpecField("nodes", 0, "parent", "ahub.hub.tasks"), refusingHost);
    expect(outcome.status).toBe("invalid");
    if (outcome.status === "invalid") expect(outcome.diagnostics.map((d) => d.key)).toContain("diagram.semantic.parentCycle");
    expect(store.getState().doc).toBe(before);
    expect(store.getState().ephemeral.history.past).toHaveLength(0);
  });

  it("adds a nested node and an id-less edge", async () => {
    const store = storeOf();
    const add = await applyValidatedSemanticEdit(store, "fp",
      addSemanticEntry("floorplan", "nodes", { id: "ahub.hub.audit", label: "Audit", kind: "feature", parent: "ahub.hub" }), refusingHost);
    expect(add.status).toBe("applied");
    const edge = await applyValidatedSemanticEdit(store, "fp",
      addSemanticEntry("floorplan", "edges", { from: "ahub.hub.audit", to: "github", kind: "http" }), refusingHost);
    expect(edge.status).toBe("applied");
    const spec = specOf(store);
    expect((spec.edges as Record<string, unknown>[]).at(-1)).toEqual({ from: "ahub.hub.audit", to: "github", kind: "http" });
    expect(store.getState().doc.nodes.some((n) => n.id === "ahub.hub.audit")).toBe(true);
    expect(validateFloorplanSpec(spec)).toEqual([]);
  });

  it("cascades descendants, edges, flow steps, tour stops and annotations", () => {
    const spec = fixture();
    spec.annotations = [
      { path: "agent-hub/src/hub/bus.ts", note: "re-claimed by ahub after the cascade" },
      { path: "vault-mem/src/cli.ts", note: "only vmem claims it" },
    ];
    const removal = removeSemanticEntries("floorplan", spec, [{ field: "nodes", index: nodeIndex(spec, "ahub.hub") }]);
    const fields = removal.effects.map((e) => `${e.action}:${e.field}:${e.label}`);
    expect(fields).toEqual(expect.arrayContaining([
      "remove:nodes:Hub daemon",
      "remove:nodes:Task board and review",
      "remove:nodes:Message bus and delivery",
      "remove:nodes:Hub memory bridge",
      "remove:edges:embeds @staix/agent-mem",
      "remove:edges:deliveries",
      "unlink:flows:Build with an agent team",
    ]));
    expect(fields.some((field) => field.includes("annotations"))).toBe(false);
    const next = removal.transform(spec)!.spec;
    expect(validateFloorplanSpec(next)).toEqual([]);
    expect((next.nodes as Record<string, unknown>[]).some((n) => String(n.id).startsWith("ahub.hub"))).toBe(false);
    expect(next.annotations).toEqual(spec.annotations);

    const top = removeSemanticEntries("floorplan", spec, [{ field: "nodes", index: nodeIndex(spec, "vmem") }]);
    expect(top.effects.map((e) => `${e.action}:${e.field}`)).toEqual(expect.arrayContaining(["remove:tour", "remove:annotations"]));
    const topNext = top.transform(spec)!.spec;
    expect(validateFloorplanSpec(topNext)).toEqual([]);
    expect(topNext.annotations).toEqual([(spec.annotations as unknown[])[0]]);
  });

  it("commits a cascade as one undo step; cancel (no commit) changes nothing", async () => {
    const store = storeOf();
    const before = JSON.stringify(store.getState().doc);
    const spec = specOf(store);
    const removal = removeSemanticEntries("floorplan", spec, [{ field: "nodes", index: nodeIndex(spec, "ahub") }]);
    const plan = planSemanticEdit(store.getState(), "fp", removal.transform);
    expect(plan.status).toBe("applied");
    expect(JSON.stringify(store.getState().doc)).toBe(before);
    if (plan.status !== "applied") return;
    const draft = plan.transformer(store.getState()).doc;
    expect(await validateSemanticDraft(draft, ["fp"], refusingHost)).toEqual([]);
    store.setState(withSnapshot(plan.transformer, defaultCoalescer()));
    expect(store.getState().doc.nodes.some((n) => n.id.startsWith("ahub"))).toBe(false);
    expect(store.getState().ephemeral.history.past).toHaveLength(1);
    store.setState(undo());
    expect(JSON.stringify(store.getState().doc)).toBe(before);
  });
});

describe("floorplan generation (AC3)", () => {
  const jobOf = () => createGenerationJob({
    id: "job",
    diagramType: "floorplan",
    prompt: { requirements: "map the repo", locale: "en", sourceFilePaths: ["src/main.ts"] },
    doc: createEmptyDoc("doc"),
    baseMemoryRevision: "",
  });
  const hostOf = (output: unknown): GenerationHost => ({
    runAgent: async () => JSON.stringify(output),
    validateCandidate: refusingHost.validateCandidate,
  });

  it("prompts with the Floorplan schema summary and source files", () => {
    const prompt = buildGenerationPrompt(jobOf());
    expect(prompt).toContain("floorplan/architecture@1");
    expect(prompt).toContain("ui | service | worker");
    expect(prompt).toContain("<untrusted_source_paths>");
    expect(prompt).not.toContain("Archify");
  });

  it("reaches ready on a valid map without the engine", async () => {
    const job = await runGenerationJob(jobOf(), hostOf(FLOORPLAN_FIXTURE));
    expect(job.state).toBe("ready");
    expect(job.candidate?.diagramType).toBe("floorplan");
    expect(job.candidate?.spec).toEqual(FLOORPLAN_FIXTURE);
  });

  it("refuses an invalid candidate with the field named", async () => {
    const spec = fixture();
    (spec.edges as Record<string, unknown>[])[0]!.to = "ahub.ghost";
    const job = await runGenerationJob(jobOf(), hostOf(spec));
    expect(job.state).toBe("failed");
    expect(job.diagnostics).toContainEqual({ key: "diagram.semantic.danglingReference", params: { field: "edges[0].to", id: "ahub.ghost" } });
  });
});
