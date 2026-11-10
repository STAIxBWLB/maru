/**
 * Semantic inspector (issue #433 P2): shown at the top of the property panel
 * for a single node or edge that projects a semantic dataset member.
 *
 * Read-only facts come from the spec (type, dataset, role, id, label,
 * lane/stage/boundary membership). Structural editors (message order, state
 * type, classification, lane, stage) are spec edits planned by
 * `planSemanticEdit` and committed as one `withSnapshot` undo entry; a
 * refused edit shows its diagnostics in `semantic-status`. "Detach to
 * freeform..." drops the dataset after a confirm listing what is lost.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { confirmDialog } from "../../../lib/confirmDialog";
import { defaultCoalescer, withSnapshot } from "../../../lib/diagram/actions";
import {
  LIFECYCLE_STATE_TYPES,
  SEMANTIC_TYPES,
  resolveSemanticMember,
  semanticLosses,
  semanticTypeLabelKey,
  sequenceOrder,
  specEntries,
} from "../../../lib/diagram/semantic";
import {
  detachSemanticDatasetAction,
  moveMessage,
  setClassification,
  setLane,
  setStage,
  setStateType,
  setSpecField,
  type SpecTransform,
} from "../../../lib/diagram/semanticEdit";
import { FLOORPLAN_EDGE_KINDS, FLOORPLAN_NODE_KINDS, floorplanDescendants } from "../../../lib/diagram/floorplan";
import type { ValidationDiagnostic } from "../../../lib/diagram/validation";
import { applyValidatedSemanticEdit } from "../../../lib/diagram/semanticApply";
import { validateEngineCandidate, type EngineCandidateValidation } from "../../../lib/diagram/engine";
import { deleteSelection } from "../deleteSelection";
import { useTranslation } from "../../../lib/i18n";
import { useDiagram, useDiagramStore, useDiagramValidationHost } from "../DiagramStoreContext";
import { SemanticStructureEditor } from "./SemanticStructureEditor";

function Row({ labelKey, value, testId }: { labelKey: string; value: string; testId?: string }) {
  const { t } = useTranslation();
  return (
    <div className="maru-diagram-prop">
      <span>{t(labelKey)}</span>
      <span data-testid={testId}>{value}</span>
    </div>
  );
}

function labelOf(entry: Record<string, unknown> | undefined, fallback: string): string {
  return typeof entry?.label === "string" ? entry.label : fallback;
}

/** Floorplan node inspector (issue #535): summary, kind and parent, one undo step each. */
function FloorplanNodeFields({ entry, index, spec, run }: {
  entry: Record<string, unknown>;
  index: number;
  spec: Record<string, unknown>;
  run: (transform: SpecTransform) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [summaryDraft, setSummaryDraft] = useState<string | null>(null);
  const summary = typeof entry.summary === "string" ? entry.summary : "";
  const id = String(entry.id ?? "");
  // A node cannot move under itself or its own descendants.
  const blocked = new Set([id, ...floorplanDescendants(spec, [id])]);
  const parents = specEntries(spec, "nodes").filter((node) => typeof node.id === "string" && !blocked.has(node.id));
  const commitSummary = () => {
    if (summaryDraft === null) return;
    const text = summaryDraft.trim();
    setSummaryDraft(null);
    if (text !== summary) void run(setSpecField("nodes", index, "summary", text.length > 0 ? text : undefined));
  };
  return (
    <>
      <label className="maru-diagram-prop">
        <span>{t("diagram.semantic.summary")}</span>
        <textarea
          value={summaryDraft ?? summary}
          onChange={(e) => setSummaryDraft(e.target.value)}
          onBlur={commitSummary}
          data-testid="semantic-floorplan-summary"
        />
      </label>
      <label className="maru-diagram-prop">
        <span>{t("diagram.semantic.floorplanKind")}</span>
        <select
          value={typeof entry.kind === "string" ? entry.kind : ""}
          onChange={(e) => void run(setSpecField("nodes", index, "kind", e.target.value))}
          data-testid="semantic-floorplan-kind"
        >
          {FLOORPLAN_NODE_KINDS.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
      <label className="maru-diagram-prop">
        <span>{t("diagram.semantic.parent")}</span>
        <select
          value={typeof entry.parent === "string" ? entry.parent : ""}
          onChange={(e) => void run(setSpecField("nodes", index, "parent", e.target.value || undefined))}
          data-testid="semantic-floorplan-parent"
        >
          <option value="">{t("diagram.semantic.parentNone")}</option>
          {parents.map((node) => (
            <option key={String(node.id)} value={String(node.id)}>{labelOf(node, String(node.id))}</option>
          ))}
        </select>
      </label>
    </>
  );
}

export function SemanticProps({ nodeId, edgeId }: { nodeId?: string; edgeId?: string }) {
  const { t } = useTranslation();
  const store = useDiagramStore();
  const validationHost = useDiagramValidationHost();
  const pending = useRef(false);
  const [validating, setValidating] = useState(false);
  const doc = useDiagram((s) => s.doc);
  const member = useMemo(
    () =>
      nodeId !== undefined
        ? resolveSemanticMember(doc, { nodeId })
        : edgeId !== undefined
          ? resolveSemanticMember(doc, { edgeId })
          : null,
    [doc, nodeId, edgeId],
  );
  const [status, setStatus] = useState<ValidationDiagnostic[]>([]);
  const [engineValidation, setEngineValidation] = useState<EngineCandidateValidation | null>(null);
  const [engineValidationError, setEngineValidationError] = useState<string | null>(null);
  const [classificationDraft, setClassificationDraft] = useState<string | null>(null);
  const activeDataset = member && member.dataset.diagramType !== "floorplan" ? member.dataset : null;

  useEffect(() => {
    let current = true;
    setEngineValidation(null);
    setEngineValidationError(null);
    if (!activeDataset) return () => { current = false; };

    void validateEngineCandidate(activeDataset.diagramType, activeDataset.spec)
      .then((result) => {
        if (current) setEngineValidation(result);
      })
      .catch((error: unknown) => {
        if (!current) return;
        setEngineValidationError(error instanceof Error ? error.message : String(error));
      });

    return () => { current = false; };
  }, [activeDataset]);

  if (!member) return null;

  const { dataset } = member;
  const type = dataset.diagramType;
  const descriptor = SEMANTIC_TYPES[type];
  const spec = dataset.spec;

  const run = async (transform: SpecTransform): Promise<boolean> => {
    if (pending.current) return false;
    pending.current = true;
    setValidating(true);
    try {
      const outcome = await applyValidatedSemanticEdit(store, dataset.id, transform, validationHost);
      if (outcome.status === "applied") { setStatus(outcome.warnings); return true; }
      if (outcome.status === "invalid") setStatus([{ key: "diagram.semantic.editRefused" }, ...outcome.diagnostics]);
      return false;
    } finally { pending.current = false; setValidating(false); }
  };

  const detach = async () => {
    const losses = semanticLosses(dataset).map((loss) => `- ${t(loss.key, loss.params ?? {})}`);
    if (!(await confirmDialog([t("diagram.semantic.detachConfirm", { name: dataset.name }), ...losses].join("\n")))) {
      return;
    }
    store.setState(withSnapshot(detachSemanticDatasetAction(dataset.id), defaultCoalescer()));
  };

  const lanes = specEntries(spec, "lanes");
  const stages = specEntries(spec, "stages");
  const role = member.kind === "container" ? member.role : member.kind;
  const id =
    member.kind === "entity"
      ? member.specId
      : member.kind === "container"
        ? member.key
        : typeof member.entry.id === "string"
          ? member.entry.id
          : "-";

  const participantLabel = typeof member.entry.participant === "string"
    ? labelOf(specEntries(spec, "participants").find((entry) => entry.id === member.entry.participant), member.entry.participant)
    : "";
  const membership: Array<{ labelKey: string; value: string }> = [];
  if (member.kind === "entity") {
    const lane = lanes.find((entry) => entry.id === member.entry.lane);
    if (lane) membership.push({ labelKey: "diagram.semantic.lane", value: labelOf(lane, String(lane.id)) });
    if (type === "dataflow" && typeof member.entry.stage === "number") {
      const stage = stages[member.entry.stage];
      membership.push({ labelKey: "diagram.semantic.stage", value: labelOf(stage, String(member.entry.stage + 1)) });
    }
    const boundaries = specEntries(spec, "boundaries").filter(
      (entry) => Array.isArray(entry.wraps) && entry.wraps.includes(member.specId),
    );
    if (type === "architecture" && boundaries.length > 0) {
      membership.push({
        labelKey: "diagram.semantic.boundary",
        value: boundaries.map((entry) => labelOf(entry, "")).join(", "),
      });
    }
  } else if (member.kind === "container") {
    const entities = specEntries(spec, descriptor.entities);
    let count = 0;
    if (member.role === "lane") count = entities.filter((entry) => entry.lane === member.key).length;
    else if (member.role === "stage") count = entities.filter((entry) => entry.stage === member.index).length;
    else if (member.role === "phase" || member.role === "group") {
      count = entities.filter((entry) => typeof entry.col === "number" &&
        entry.col >= Number(member.entry.fromCol) && entry.col <= Number(member.entry.toCol) &&
        (member.role === "phase" || entry.lane === member.entry.lane)).length;
    } else if (member.role === "segment" || member.role === "activation") {
      count = specEntries(spec, "messages").filter((entry) => typeof entry.y === "number" &&
        entry.y >= Number(member.entry.from) && entry.y <= Number(member.entry.to) &&
        (member.role === "segment" || entry.from === member.entry.participant || entry.to === member.entry.participant)).length;
    } else if (Array.isArray(member.entry.wraps)) count = member.entry.wraps.length;
    membership.push({ labelKey: "diagram.semantic.members", value: String(count) });
  }

  const order = type === "sequence" && member.kind === "relation" ? sequenceOrder(spec) : [];
  const position = order.indexOf(member.index);
  const classification =
    typeof member.entry.classification === "string" ? member.entry.classification : "";
  const commitClassification = () => {
    if (classificationDraft === null) return;
    void run(setClassification(member.index, classificationDraft.trim()));
    setClassificationDraft(null);
  };

  return (
    <section className="maru-diagram-prop-sections" data-testid="semantic-props">
      <section>
        <h3>{t("diagram.semantic.title")}</h3>
        <Row labelKey="diagram.semantic.type" value={t(semanticTypeLabelKey(type))} />
        <Row labelKey="diagram.semantic.dataset" value={dataset.name} />
        <Row labelKey="diagram.semantic.role" value={t(`diagram.semantic.role.${role}`)} />
        <Row labelKey="diagram.semantic.id" value={id} />
        <Row labelKey="diagram.semantic.label" value={labelOf(member.entry, participantLabel)} testId="semantic-label" />
        {membership.map((row) => (
          <Row key={row.labelKey} labelKey={row.labelKey} value={row.value} />
        ))}

        {position >= 0 ? (
          <div className="maru-diagram-prop">
            <span>{t("diagram.semantic.order")}</span>
            <span data-testid="semantic-order">{`${position + 1}/${order.length}`}</span>
            <button
              type="button"
              onClick={() => void run(moveMessage(member.index, -1))}
              disabled={position === 0}
              data-testid="semantic-move-earlier"
            >
              {t("diagram.semantic.moveEarlier")}
            </button>
            <button
              type="button"
              onClick={() => void run(moveMessage(member.index, 1))}
              disabled={position === order.length - 1}
              data-testid="semantic-move-later"
            >
              {t("diagram.semantic.moveLater")}
            </button>
          </div>
        ) : null}

        {type === "lifecycle" && member.kind === "entity" ? (
          <label className="maru-diagram-prop">
            <span>{t("diagram.semantic.stateType")}</span>
            <select
              value={typeof member.entry.type === "string" ? member.entry.type : ""}
              onChange={(e) => void run(setStateType(member.index, e.target.value))}
              data-testid="semantic-state-type"
            >
              {LIFECYCLE_STATE_TYPES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {(type === "workflow" || type === "lifecycle") && member.kind === "entity" ? (
          <label className="maru-diagram-prop">
            <span>{t("diagram.semantic.lane")}</span>
            <select
              value={typeof member.entry.lane === "string" ? member.entry.lane : ""}
              onChange={(e) => void run(setLane(descriptor.entities as "nodes" | "states", member.index, e.target.value))}
              data-testid="semantic-lane"
            >
              {lanes.map((lane) => (
                <option key={String(lane.id)} value={String(lane.id)}>
                  {labelOf(lane, String(lane.id))}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {type === "dataflow" && member.kind === "entity" ? (
          <label className="maru-diagram-prop">
            <span>{t("diagram.semantic.stage")}</span>
            <select
              value={String(member.entry.stage ?? 0)}
              onChange={(e) => void run(setStage(member.index, Number(e.target.value)))}
              data-testid="semantic-stage"
            >
              {stages.map((stage, index) => (
                <option key={index} value={String(index)}>
                  {labelOf(stage, String(index + 1))}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {type === "dataflow" && member.kind === "relation" ? (
          <label className="maru-diagram-prop">
            <span>{t("diagram.semantic.classification")}</span>
            <input
              value={classificationDraft ?? classification}
              onChange={(e) => setClassificationDraft(e.target.value)}
              onBlur={commitClassification}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) commitClassification();
              }}
              data-testid="semantic-classification"
            />
          </label>
        ) : null}

        {type === "floorplan" && member.kind === "entity" ? (
          <FloorplanNodeFields key={`${dataset.id}:${member.index}:${String(member.entry.summary ?? "")}`} entry={member.entry} index={member.index} spec={spec} run={run} />
        ) : null}

        {type === "floorplan" && member.kind === "relation" ? (
          <label className="maru-diagram-prop">
            <span>{t("diagram.semantic.floorplanKind")}</span>
            <select
              value={typeof member.entry.kind === "string" ? member.entry.kind : ""}
              onChange={(e) => void run(setSpecField("edges", member.index, "kind", e.target.value || undefined))}
              data-testid="semantic-floorplan-edge-kind"
            >
              <option value="">-</option>
              {FLOORPLAN_EDGE_KINDS.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
        ) : null}

        <SemanticStructureEditor key={`${dataset.id}:${member.field}:${member.index}:${JSON.stringify(member.entry)}`} member={member} run={run}
          remove={() => deleteSelection(store, defaultCoalescer(), t, validationHost,
            { nodes: nodeId ? [nodeId] : [], edges: edgeId ? [edgeId] : [] })} />

        {validating ? <p role="status">{t("diagram.semantic.validating")}</p> : null}
        {engineValidationError ? (
          <p role="alert" data-testid="semantic-engine-error">{engineValidationError}</p>
        ) : null}
        {engineValidation && (engineValidation.diagnostics.length > 0 || (!engineValidation.ok && engineValidation.errors.length > 0)) ? (
          <ul className="maru-diagram-ie-warnings" data-testid="semantic-engine-diagnostics">
            {engineValidation.diagnostics.map((diagnostic, i) => (
              <li key={`${diagnostic.code}:${diagnostic.path}:${i}`}>
                <strong>{diagnostic.code}</strong>{diagnostic.path ? ` (${diagnostic.path})` : ""}: {diagnostic.message}
                {diagnostic.fix ? ` Fix: ${diagnostic.fix}` : ""}
              </li>
            ))}
            {engineValidation.diagnostics.length === 0 ? engineValidation.errors.map((error, i) => (
              <li key={`engine-error:${i}`}>{error}</li>
            )) : null}
          </ul>
        ) : null}
        {status.length > 0 ? (
          <ul className="maru-diagram-ie-warnings" data-testid="semantic-status">
            {status.map((diagnostic, i) => (
              <li key={`${diagnostic.key}:${i}`}>{t(diagnostic.key, diagnostic.params ?? {})}</li>
            ))}
          </ul>
        ) : null}

        <button type="button" onClick={() => void detach()} data-testid="semantic-detach">
          {t("diagram.semantic.detach")}
        </button>
      </section>
    </section>
  );
}
