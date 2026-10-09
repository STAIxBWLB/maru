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

import { useMemo, useState } from "react";

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
  planSemanticEdit,
  setClassification,
  setLane,
  setStage,
  setStateType,
  type SpecTransform,
} from "../../../lib/diagram/semanticEdit";
import type { ValidationDiagnostic } from "../../../lib/diagram/validation";
import { useTranslation } from "../../../lib/i18n";
import { useDiagram, useDiagramStore } from "../DiagramStoreContext";

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

export function SemanticProps({ nodeId, edgeId }: { nodeId?: string; edgeId?: string }) {
  const { t } = useTranslation();
  const store = useDiagramStore();
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
  const [classificationDraft, setClassificationDraft] = useState<string | null>(null);
  if (!member) return null;

  const { dataset } = member;
  const type = dataset.diagramType;
  const descriptor = SEMANTIC_TYPES[type];
  const spec = dataset.spec;

  const run = (transform: SpecTransform) => {
    const outcome = planSemanticEdit(store.getState(), dataset.id, transform);
    if (outcome.status === "applied") {
      store.setState(withSnapshot(outcome.transformer, defaultCoalescer()));
      setStatus(outcome.warnings);
    } else if (outcome.status === "invalid") {
      setStatus(outcome.diagnostics);
    }
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
    const count =
      member.role === "lane"
        ? entities.filter((entry) => entry.lane === member.key).length
        : member.role === "stage"
          ? entities.filter((entry) => entry.stage === member.index).length
          : Array.isArray(member.entry.wraps)
            ? member.entry.wraps.length
            : 0;
    membership.push({ labelKey: "diagram.semantic.members", value: String(count) });
  }

  const order = type === "sequence" && member.kind === "relation" ? sequenceOrder(spec) : [];
  const position = order.indexOf(member.index);
  const classification =
    typeof member.entry.classification === "string" ? member.entry.classification : "";
  const commitClassification = () => {
    if (classificationDraft === null) return;
    run(setClassification(member.index, classificationDraft.trim()));
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
        <Row labelKey="diagram.semantic.label" value={labelOf(member.entry, "")} testId="semantic-label" />
        {membership.map((row) => (
          <Row key={row.labelKey} labelKey={row.labelKey} value={row.value} />
        ))}

        {position >= 0 ? (
          <div className="maru-diagram-prop">
            <span>{t("diagram.semantic.order")}</span>
            <span data-testid="semantic-order">{`${position + 1}/${order.length}`}</span>
            <button
              type="button"
              onClick={() => run(moveMessage(member.index, -1))}
              disabled={position === 0}
              data-testid="semantic-move-earlier"
            >
              {t("diagram.semantic.moveEarlier")}
            </button>
            <button
              type="button"
              onClick={() => run(moveMessage(member.index, 1))}
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
              onChange={(e) => run(setStateType(member.index, e.target.value))}
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
              onChange={(e) => run(setLane(descriptor.entities as "nodes" | "states", member.index, e.target.value))}
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
              onChange={(e) => run(setStage(member.index, Number(e.target.value)))}
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
