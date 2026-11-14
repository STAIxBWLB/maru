/** Apply-time engine admission. Preview/projection stays pure and synchronous. */
import { defaultCoalescer, withSnapshot } from "./actions";
import type { GenerationHost } from "./generation";
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
