/** Apply-time engine admission. Preview/projection stays pure and synchronous. */
import { defaultCoalescer, withSnapshot } from "./actions";
import type { Coalescer } from "./history";
import type { GenerationHost } from "./generation";
import { prepareProposalApply, type Proposal, type ProposalApplyOutcome } from "./proposal";
import { semanticDatasetsOf } from "./semantic";
import { planSemanticEdit, type SemanticEditOutcome, type SpecTransform } from "./semanticEdit";
import type { DiagramStore } from "./state";
import type { DiagramDoc } from "./types";
import type { ValidationDiagnostic } from "./validation";

export type SemanticValidationHost = Pick<GenerationHost, "validateCandidate">;

export async function validateSemanticDraft(
  draft: DiagramDoc,
  datasetIds: readonly string[],
  host: SemanticValidationHost,
): Promise<ValidationDiagnostic[]> {
  for (const id of new Set(datasetIds)) {
    const dataset = semanticDatasetsOf(draft).find((item) => item.id === id);
    if (!dataset) return [{ key: "diagram.semantic.editStale" }];
    // Every family, Floorplan included (`maru#553` E5 T4), passes the
    // asynchronous SDK schema and geometry gate before the edit commits.
    try {
      const receipt = await host.validateCandidate(dataset.diagramType, dataset.spec);
      if (receipt.ok !== true) return receipt.errors.length > 0
        ? receipt.errors.map((message) => ({ key: "diagram.semantic.engineRejected", params: { message } }))
        : [{ key: "diagram.semantic.engineNoSuccess" }];
    } catch (error) {
      const message = error instanceof Error ? error.message : typeof error === "object" && error !== null && "message" in error
        ? String(error.message) : String(error);
      return [{ key: "diagram.semantic.engineValidationFailed", params: { message } }];
    }
  }
  return [];
}

export async function applyValidatedSemanticEdit(
  store: DiagramStore,
  datasetId: string,
  transform: SpecTransform,
  host: SemanticValidationHost,
): Promise<SemanticEditOutcome> {
  const before = store.getState();
  const plan = planSemanticEdit(before, datasetId, transform);
  if (plan.status !== "applied") return plan;
  const diagnostics = await validateSemanticDraft(plan.transformer(before).doc, [datasetId], host);
  if (store.getState().doc !== before.doc) return { status: "invalid", diagnostics: [{ key: "diagram.semantic.editStale" }] };
  if (diagnostics.length > 0) return { status: "invalid", diagnostics };
  store.setState(withSnapshot(plan.transformer, defaultCoalescer()));
  return plan;
}

/**
 * Scoped proposal apply (Generate dialog). Generation validates Floorplan
 * candidates locally, so every Floorplan dataset a proposal upserts passes the
 * engine here before the commit (`maru#553` E5 T4). The other families were
 * already admitted by the engine while generating. A refusal, an unavailable
 * engine or a document change during validation commits nothing.
 *
 * `revisionOf` computes the memory revision of the very snapshot this apply
 * gates and validates, so the stale check, the engine input and the
 * post-validation identity check all bind to one document. A change while the
 * revision is computed is stale too.
 */
export async function applyValidatedProposal(
  store: DiagramStore,
  proposal: Proposal,
  revisionOf: (doc: DiagramDoc) => Promise<string> | string,
  host: SemanticValidationHost,
  coalescer: Coalescer = defaultCoalescer(),
): Promise<ProposalApplyOutcome> {
  const before = store.getState();
  const currentMemoryRevision = await revisionOf(before.doc);
  if (store.getState().doc !== before.doc) return { status: "invalid", diagnostics: [{ key: "diagram.semantic.editStale" }] };
  const outcome = prepareProposalApply(before, proposal, currentMemoryRevision);
  if (outcome.status !== "applied") return outcome;
  const floorplanIds = proposal.ops.flatMap((op) =>
    op.kind === "upsertSemanticDataset" && op.dataset.diagramType === "floorplan" ? [op.dataset.id] : []);
  if (floorplanIds.length > 0) {
    const diagnostics = await validateSemanticDraft(outcome.transformer(before).doc, floorplanIds, host);
    if (store.getState().doc !== before.doc) return { status: "invalid", diagnostics: [{ key: "diagram.semantic.editStale" }] };
    if (diagnostics.length > 0) return { status: "invalid", diagnostics };
  }
  store.setState(withSnapshot(outcome.transformer, coalescer));
  return outcome;
}
