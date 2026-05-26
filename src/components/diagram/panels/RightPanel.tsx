import { useCallback, type ChangeEvent } from "react";

import {
  defaultCoalescer,
  updateEdge,
  updateNode,
  withSnapshot,
} from "../../../lib/diagram/actions";
import type {
  DiagramEdge,
  DiagramNode,
  EdgeArrowKind,
  EdgeDash,
  EdgeRouteMode,
} from "../../../lib/diagram/types";
import { useTranslation } from "../../../lib/i18n";
import { useDiagram, useDiagramStore } from "../DiagramStoreContext";

function NumberField({
  labelKey,
  value,
  onCommit,
  min,
  max,
  step = 1,
}: {
  labelKey: string;
  value: number;
  onCommit: (next: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  const { t } = useTranslation();
  return (
    <label className="anchor-diagram-prop">
      <span>{t(labelKey)}</span>
      <input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const next = parseFloat(e.target.value);
          if (Number.isFinite(next)) onCommit(next);
        }}
      />
    </label>
  );
}

function TextField({
  labelKey,
  value,
  onCommit,
}: {
  labelKey: string;
  value: string;
  onCommit: (next: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <label className="anchor-diagram-prop">
      <span>{t(labelKey)}</span>
      <input value={value} onChange={(e) => onCommit(e.target.value)} />
    </label>
  );
}

function ColorField({
  labelKey,
  value,
  onCommit,
}: {
  labelKey: string;
  value: string;
  onCommit: (next: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <label className="anchor-diagram-prop anchor-diagram-prop-color">
      <span>{t(labelKey)}</span>
      <input
        type="color"
        value={value}
        onChange={(e) => onCommit(e.target.value)}
        aria-label={t(labelKey)}
      />
      <input
        type="text"
        value={value}
        onChange={(e) => onCommit(e.target.value)}
        spellCheck={false}
      />
    </label>
  );
}

function SelectField<T extends string>({
  labelKey,
  value,
  onCommit,
  options,
}: {
  labelKey: string;
  value: T;
  onCommit: (next: T) => void;
  options: Array<{ value: T; labelKey: string }>;
}) {
  const { t } = useTranslation();
  return (
    <label className="anchor-diagram-prop">
      <span>{t(labelKey)}</span>
      <select value={value} onChange={(e) => onCommit(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {t(o.labelKey)}
          </option>
        ))}
      </select>
    </label>
  );
}

function NodeProps({ node }: { node: DiagramNode }) {
  const { t } = useTranslation();
  const store = useDiagramStore();
  const patch = useCallback(
    (delta: Partial<DiagramNode>) =>
      store.setState(withSnapshot(updateNode(node.id, delta), defaultCoalescer())),
    [node.id, store],
  );
  const patchStyle = useCallback(
    (delta: Partial<NonNullable<DiagramNode["style"]>>) =>
      patch({ style: { ...node.style, ...delta } }),
    [node.style, patch],
  );

  return (
    <div className="anchor-diagram-prop-sections">
      <section>
        <h3>{t("diagram.panel.properties.text")}</h3>
        <TextField labelKey="diagram.properties.title" value={node.title ?? ""} onCommit={(v) => patch({ title: v })} />
      </section>
      <section>
        <h3>{t("diagram.panel.properties.position")}</h3>
        <div className="anchor-diagram-prop-row">
          <NumberField labelKey="diagram.properties.x" value={node.x} onCommit={(v) => patch({ x: v })} />
          <NumberField labelKey="diagram.properties.y" value={node.y} onCommit={(v) => patch({ y: v })} />
        </div>
      </section>
      <section>
        <h3>{t("diagram.panel.properties.size")}</h3>
        <div className="anchor-diagram-prop-row">
          <NumberField labelKey="diagram.properties.w" value={node.w} onCommit={(v) => patch({ w: Math.max(20, v) })} min={20} />
          <NumberField labelKey="diagram.properties.h" value={node.h} onCommit={(v) => patch({ h: Math.max(20, v) })} min={20} />
        </div>
      </section>
      <section>
        <h3>{t("diagram.panel.properties.style")}</h3>
        <ColorField labelKey="diagram.properties.bg" value={node.style?.bg ?? "#ffffff"} onCommit={(v) => patchStyle({ bg: v })} />
        <ColorField labelKey="diagram.properties.border" value={node.style?.border ?? "#1f2937"} onCommit={(v) => patchStyle({ border: v })} />
        <ColorField labelKey="diagram.properties.fc" value={node.style?.fc ?? "#111827"} onCommit={(v) => patchStyle({ fc: v })} />
        <div className="anchor-diagram-prop-row">
          <NumberField labelKey="diagram.properties.fs" value={node.style?.fs ?? 12} onCommit={(v) => patchStyle({ fs: v })} min={8} max={48} />
          <NumberField labelKey="diagram.properties.br" value={node.style?.br ?? 4} onCommit={(v) => patchStyle({ br: v })} min={0} max={40} />
          <NumberField labelKey="diagram.properties.bw" value={node.style?.bw ?? 1.5} onCommit={(v) => patchStyle({ bw: v })} min={0} max={10} step={0.5} />
        </div>
        <SelectField
          labelKey="diagram.properties.fw"
          value={String(node.style?.fw ?? 600)}
          onCommit={(v) => patchStyle({ fw: Number(v) })}
          options={[
            { value: "300", labelKey: "diagram.fw.light" },
            { value: "400", labelKey: "diagram.fw.regular" },
            { value: "600", labelKey: "diagram.fw.bold" },
            { value: "900", labelKey: "diagram.fw.black" },
          ]}
        />
        <SelectField
          labelKey="diagram.properties.textAlign"
          value={node.style?.align ?? "center"}
          onCommit={(v) => patchStyle({ align: v })}
          options={[
            { value: "left", labelKey: "diagram.align.left" },
            { value: "center", labelKey: "diagram.align.centerH" },
            { value: "right", labelKey: "diagram.align.right" },
          ]}
        />
      </section>
    </div>
  );
}

function EdgeProps({ edge }: { edge: DiagramEdge }) {
  const { t } = useTranslation();
  const store = useDiagramStore();
  const patch = useCallback(
    (delta: Partial<DiagramEdge>) =>
      store.setState(withSnapshot(updateEdge(edge.id, delta), defaultCoalescer())),
    [edge.id, store],
  );
  return (
    <div className="anchor-diagram-prop-sections">
      <section>
        <h3>{t("diagram.panel.properties.edge")}</h3>
        <SelectField<EdgeRouteMode>
          labelKey="diagram.edge.routeMode"
          value={edge.routeMode ?? "auto"}
          onCommit={(v) => patch({ routeMode: v })}
          options={[
            { value: "auto", labelKey: "diagram.edge.routeAuto" },
            { value: "straight", labelKey: "diagram.edge.routeStraight" },
          ]}
        />
        <SelectField<EdgeArrowKind>
          labelKey="diagram.edge.arrowStart"
          value={edge.arrowStart ?? "none"}
          onCommit={(v) => patch({ arrowStart: v })}
          options={[
            { value: "none", labelKey: "diagram.edge.arrow.none" },
            { value: "filled", labelKey: "diagram.edge.arrow.filled" },
            { value: "open", labelKey: "diagram.edge.arrow.open" },
          ]}
        />
        <SelectField<EdgeArrowKind>
          labelKey="diagram.edge.arrowEnd"
          value={edge.arrowEnd ?? "filled"}
          onCommit={(v) => patch({ arrowEnd: v })}
          options={[
            { value: "none", labelKey: "diagram.edge.arrow.none" },
            { value: "filled", labelKey: "diagram.edge.arrow.filled" },
            { value: "open", labelKey: "diagram.edge.arrow.open" },
          ]}
        />
        <SelectField<EdgeDash>
          labelKey="diagram.edge.dash"
          value={edge.dash ?? "solid"}
          onCommit={(v) => patch({ dash: v })}
          options={[
            { value: "solid", labelKey: "diagram.edge.dash.solid" },
            { value: "dashed", labelKey: "diagram.edge.dash.dashed" },
          ]}
        />
        <NumberField
          labelKey="diagram.edge.width"
          value={edge.width ?? 1.5}
          onCommit={(v) => patch({ width: Math.max(0.5, v) })}
          min={0.5}
          max={10}
          step={0.5}
        />
        <ColorField
          labelKey="diagram.edge.color"
          value={edge.color ?? "#1f2937"}
          onCommit={(v) => patch({ color: v })}
        />
        <TextField
          labelKey="diagram.edge.label"
          value={edge.label ?? ""}
          onCommit={(v) => patch({ label: v })}
        />
      </section>
    </div>
  );
}

export function RightPanel() {
  const { t } = useTranslation();
  const selection = useDiagram((s) => s.ephemeral.selection);
  const nodes = useDiagram((s) => s.doc.nodes);
  const edges = useDiagram((s) => s.doc.edges);

  const nodeCount = selection.nodes.size;
  const edgeCount = selection.edges.size;
  const total = nodeCount + edgeCount;

  if (total === 0) {
    return (
      <aside className="anchor-diagram-side-panel" aria-label={t("diagram.panel.properties")}>
        <h2>{t("diagram.panel.properties")}</h2>
        <p className="anchor-diagram-side-panel-empty">{t("diagram.panel.properties.empty")}</p>
      </aside>
    );
  }

  if (total > 1) {
    return (
      <aside className="anchor-diagram-side-panel" aria-label={t("diagram.panel.properties")}>
        <h2>{t("diagram.panel.properties")}</h2>
        <p className="anchor-diagram-side-panel-empty">
          {t("diagram.panel.properties.multi", { count: String(total) })}
        </p>
      </aside>
    );
  }

  if (nodeCount === 1) {
    const id = [...selection.nodes][0]!;
    const node = nodes.find((n) => n.id === id);
    return (
      <aside className="anchor-diagram-side-panel" aria-label={t("diagram.panel.properties")}>
        <h2>{t("diagram.panel.properties")}</h2>
        {node ? <NodeProps node={node} /> : null}
      </aside>
    );
  }

  if (edgeCount === 1) {
    const id = [...selection.edges][0]!;
    const edge = edges.find((e) => e.id === id);
    return (
      <aside className="anchor-diagram-side-panel" aria-label={t("diagram.panel.properties")}>
        <h2>{t("diagram.panel.properties")}</h2>
        {edge ? <EdgeProps edge={edge} /> : null}
      </aside>
    );
  }

  return null;
}
