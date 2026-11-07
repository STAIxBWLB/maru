import { useState, type ReactNode } from "react";

import { confirmDialog, messageDialog } from "../../../lib/confirmDialog";
import {
  LIFECYCLE_STATE_TYPES, SEMANTIC_TYPES, semanticContainers, specEntries, type SemanticMember,
} from "../../../lib/diagram/semantic";
import {
  addSemanticEntry, removeSemanticEntries, setBoundaryMembership, setSpecField, type SpecTransform,
} from "../../../lib/diagram/semanticEdit";
import { createDiagramId } from "../../../lib/diagram/types";
import { useTranslation } from "../../../lib/i18n";
import { useDiagramStore } from "../DiagramStoreContext";
import { semanticCascadeLines } from "../semanticCascade";

const COMPONENT_TYPES = ["frontend", "backend", "database", "cloud", "security", "messagebus", "external"];
const entryId = (entry: Record<string, unknown>) => String(entry.id ?? "");
const entryLabel = (entry: Record<string, unknown>) => String(entry.label ?? entry.id ?? "");

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="maru-diagram-prop"><span>{label}</span>{children}</label>;
}

export function SemanticStructureEditor({ member, run }: {
  member: SemanticMember;
  run: (transform: SpecTransform) => boolean;
}) {
  const { t } = useTranslation();
  const store = useDiagramStore();
  const { dataset } = member;
  const type = dataset.diagramType;
  const descriptor = SEMANTIC_TYPES[type];
  const spec = dataset.spec;
  const entities = specEntries(spec, descriptor.entities);
  const [field, setField] = useState(descriptor.entities);
  const [label, setLabel] = useState("");
  const [entityType, setEntityType] = useState(type === "lifecycle" ? "active" : "backend");
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const [lane, setLane] = useState("");
  const [stage, setStage] = useState(0);
  const [col, setCol] = useState(0);
  const [toCol, setToCol] = useState(1);
  const [fromY, setFromY] = useState(170);
  const [toY, setToY] = useState(290);
  const [wraps, setWraps] = useState<string[]>([]);
  const [membershipDraft, setMembershipDraft] = useState<string[] | null>(null);
  const [rangeDraft, setRangeDraft] = useState<{ from: number; to: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const lanes = specEntries(spec, "lanes");
  const stages = specEntries(spec, "stages");
  const from = entities.some((entry) => entry.id === source) ? source : entryId(entities[0] ?? {});
  const to = entities.some((entry) => entry.id === target) ? target : entryId(entities[1] ?? entities[0] ?? {});
  const laneId = lanes.some((entry) => entry.id === lane) ? lane : entryId(lanes[0] ?? {});
  const isEntity = field === descriptor.entities;
  const isRelation = field === descriptor.relations;
  const isRange = field === "phases" || field === "groups";
  const isTimeline = field === "segments" || field === "activations";
  const options = [descriptor.entities, descriptor.relations, ...semanticContainers(descriptor).map((entry) => entry.field)];
  const collectionLabel = (value: string) => t(`diagram.semantic.collection.${value}`);
  const entityOptions = entities.map((entry) => <option key={entryId(entry)} value={entryId(entry)}>{entryLabel(entry)}</option>);
  const laneOptions = lanes.map((entry) => <option key={entryId(entry)} value={entryId(entry)}>{entryLabel(entry)}</option>);
  const checkboxList = (selected: readonly string[], change: (ids: string[]) => void) => entities.map((entry) => {
    const id = entryId(entry);
    return <label key={id}><input type="checkbox" value={id} checked={selected.includes(id)}
      onChange={(event) => change(event.target.checked ? [...selected, id] : selected.filter((item) => item !== id))} />{entryLabel(entry)}</label>;
  });
  const add = () => {
    let entry: Record<string, unknown> = { label: label.trim() };
    if (isEntity) {
      entry.type = entityType;
      if (type === "workflow" || type === "lifecycle") Object.assign(entry, { lane: laneId, col });
      if (type === "dataflow") Object.assign(entry, { stage, row: Math.max(-1, ...entities.filter((item) => item.stage === stage).map((item) => Number(item.row) || 0)) + 1 });
      if (type === "architecture") Object.assign(entry, { col, row: Math.max(-1, ...entities.filter((item) => item.col === col).map((item) => Number(item.row) || 0)) + 1 });
    } else if (isRelation) Object.assign(entry, { from, to });
    else if (field === "boundaries") Object.assign(entry, { kind: "region", wraps });
    else if (isRange) Object.assign(entry, { fromCol: col, toCol, ...(field === "groups" ? { lane: laneId } : {}) });
    else if (isTimeline) {
      Object.assign(entry, { from: fromY, to: toY });
      if (field === "activations") entry = { participant: from, from: fromY, to: toY };
    }
    if (isEntity || isRelation || semanticContainers(descriptor).some((container) => container.field === field && container.keyedBy === "id")) {
      entry.id = `item-${createDiagramId()}`;
    }
    if (run(addSemanticEntry(type, field, entry))) setLabel("");
  };
  const remove = async () => {
    if (busy) return;
    const before = store.getState().doc;
    const removal = removeSemanticEntries(type, spec, [{ field: member.field, index: member.index }]);
    setBusy(true);
    try {
      if (!(await confirmDialog([t("diagram.semantic.removeConfirm"), ...semanticCascadeLines(removal.effects, t)].join("\n")))) return;
      if (store.getState().doc !== before) {
        await messageDialog(t("diagram.semantic.editStale"), "warning");
        return;
      }
      run(removal.transform);
    } finally { setBusy(false); }
  };
  const columnRange = member.kind === "container" && (member.role === "phase" || member.role === "group");
  const timelineRange = member.kind === "container" && (member.role === "segment" || member.role === "activation");
  const range = rangeDraft ?? {
    from: Number(member.entry[columnRange ? "fromCol" : "from"]),
    to: Number(member.entry[columnRange ? "toCol" : "to"]),
  };
  const commitRange = () => {
    const fromKey = columnRange ? "fromCol" : "from";
    const toKey = columnRange ? "toCol" : "to";
    if (member.entry[fromKey] === range.from && member.entry[toKey] === range.to) {
      setRangeDraft(null);
      return;
    }
    if (run((current) => ({ spec: { ...current, [member.field]: specEntries(current, member.field).map((entry, index) =>
      index === member.index ? { ...entry, [fromKey]: range.from, [toKey]: range.to } : entry) } }))) setRangeDraft(null);
  };

  return <div data-testid="semantic-structure">
    {member.kind === "container" && member.role === "boundary" ? <fieldset>
      <legend>{t("diagram.semantic.members")}</legend>
      {checkboxList(membershipDraft ?? (Array.isArray(member.entry.wraps) ? member.entry.wraps as string[] : []), setMembershipDraft)}
      <button type="button" data-testid="semantic-apply-membership" disabled={membershipDraft === null}
        onClick={() => { if (run(setBoundaryMembership(member.index, membershipDraft ?? []))) setMembershipDraft(null); }}>{t("diagram.semantic.applyMembership")}</button>
    </fieldset> : null}
    {member.kind === "container" && member.role === "group" ? <Field label={t("diagram.semantic.lane")}>
      <select data-testid="semantic-group-lane" value={String(member.entry.lane)}
        onChange={(event) => run(setSpecField(member.field, member.index, "lane", event.target.value))}>{laneOptions}</select>
    </Field> : null}
    {member.kind === "container" && member.role === "activation" ? <Field label={t("diagram.semantic.participant")}>
      <select data-testid="semantic-activation-participant" value={String(member.entry.participant)}
        onChange={(event) => run(setSpecField(member.field, member.index, "participant", event.target.value))}>{entityOptions}</select>
    </Field> : null}
    {columnRange || timelineRange ? <fieldset>
      <legend>{t("diagram.semantic.range")}</legend>
      <Field label={t("diagram.semantic.rangeFrom")}><input type="number" data-testid="semantic-range-from" value={range.from}
        min={columnRange ? 0 : 72} max={columnRange ? 5 : undefined}
        onChange={(event) => setRangeDraft({ ...range, from: Number(event.target.value) })} /></Field>
      <Field label={t("diagram.semantic.rangeTo")}><input type="number" data-testid="semantic-range-to" value={range.to}
        min={columnRange ? 0 : 72} max={columnRange ? 5 : undefined}
        onChange={(event) => setRangeDraft({ ...range, to: Number(event.target.value) })} /></Field>
      <button type="button" data-testid="semantic-apply-range" disabled={rangeDraft === null}
        onClick={commitRange}>{t("diagram.semantic.applyRange")}</button>
    </fieldset> : null}
    <button type="button" data-testid="semantic-remove" disabled={busy} onClick={() => void remove()}>{t("diagram.semantic.remove")}</button>
    <fieldset>
      <legend>{t("diagram.semantic.add")}</legend>
      <Field label={t("diagram.semantic.collection")}><select data-testid="semantic-add-collection" value={field} onChange={(event) => setField(event.target.value)}>
        {options.map((value) => <option key={value} value={value}>{collectionLabel(value)}</option>)}
      </select></Field>
      {field !== "activations" ? <Field label={t("diagram.semantic.label")}><input data-testid="semantic-add-label" value={label} onChange={(event) => setLabel(event.target.value)} /></Field> : null}
      {isEntity ? <Field label={t("diagram.semantic.type")}><select data-testid="semantic-add-type" value={entityType} onChange={(event) => setEntityType(event.target.value)}>
        {(type === "lifecycle" ? LIFECYCLE_STATE_TYPES : COMPONENT_TYPES).map((value) => <option key={value} value={value}>{value}</option>)}
      </select></Field> : null}
      {isRelation || field === "activations" ? <Field label={t(field === "activations" ? "diagram.semantic.participant" : "diagram.semantic.from")}>
        <select data-testid="semantic-add-from" value={from} onChange={(event) => setSource(event.target.value)}>{entityOptions}</select>
      </Field> : null}
      {isRelation ? <Field label={t("diagram.semantic.to")}><select data-testid="semantic-add-to" value={to} onChange={(event) => setTarget(event.target.value)}>{entityOptions}</select></Field> : null}
      {((isEntity && (type === "workflow" || type === "lifecycle")) || field === "groups") ? <Field label={t("diagram.semantic.lane")}>
        <select data-testid="semantic-add-lane" value={laneId} onChange={(event) => setLane(event.target.value)}>{laneOptions}</select>
      </Field> : null}
      {isEntity && type === "dataflow" ? <Field label={t("diagram.semantic.stage")}><select data-testid="semantic-add-stage" value={stage} onChange={(event) => setStage(Number(event.target.value))}>
        {stages.map((entry, index) => <option key={index} value={index}>{entryLabel(entry)}</option>)}
      </select></Field> : null}
      {(isEntity && ["architecture", "workflow", "lifecycle"].includes(type)) || isRange ? <Field label={t("diagram.semantic.column")}>
        <input type="number" min={0} max={5} value={col} data-testid="semantic-add-col" onChange={(event) => setCol(Number(event.target.value))} />
      </Field> : null}
      {isRange ? <Field label={t("diagram.semantic.rangeTo")}><input type="number" min={0} max={5} value={toCol} data-testid="semantic-add-to-col" onChange={(event) => setToCol(Number(event.target.value))} /></Field> : null}
      {isTimeline ? <>
        <Field label={t("diagram.semantic.rangeFrom")}><input type="number" min={72} value={fromY} data-testid="semantic-add-from-y" onChange={(event) => setFromY(Number(event.target.value))} /></Field>
        <Field label={t("diagram.semantic.rangeTo")}><input type="number" min={72} value={toY} data-testid="semantic-add-to-y" onChange={(event) => setToY(Number(event.target.value))} /></Field>
      </> : null}
      {field === "boundaries" ? <fieldset><legend>{t("diagram.semantic.members")}</legend>{checkboxList(wraps, setWraps)}</fieldset> : null}
      <button type="button" data-testid="semantic-add-confirm" disabled={field !== "activations" && label.trim().length === 0}
        onClick={add}>{t("diagram.semantic.add")}</button>
    </fieldset>
  </div>;
}
