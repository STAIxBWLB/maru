import { Eye, EyeOff, GripVertical, Lock, Unlock } from "lucide-react";
import { useCallback, useState, type DragEvent } from "react";

import {
  defaultCoalescer,
  moveNodeToIndex,
  setNodeHidden,
  setNodeLocked,
  setSelection,
  updateNode,
  withSnapshot,
} from "../../../lib/diagram/actions";
import type { DiagramNode, NodeId } from "../../../lib/diagram/types";
import { useTranslation } from "../../../lib/i18n";
import { useDiagram, useDiagramStore } from "../DiagramStoreContext";

const KIND_TO_LABEL: Record<string, string> = {
  simple: "diagram.toolbar.addSimple",
  text: "diagram.toolbar.addText",
  section: "diagram.toolbar.addSection",
  numbered: "diagram.toolbar.addNumbered",
  "titled-box": "diagram.toolbar.addTitledBox",
  "split-box": "diagram.toolbar.addSplitBox",
  diamond: "diagram.toolbar.addDiamond",
  oval: "diagram.toolbar.addOval",
  hexagon: "diagram.toolbar.addHexagon",
  cylinder: "diagram.toolbar.addCylinder",
  callout: "diagram.toolbar.addCallout",
  table: "diagram.toolbar.addTable",
  image: "diagram.toolbar.addImage",
};

function defaultLabelFor(node: DiagramNode, t: (key: string) => string): string {
  if (node.title && node.title.trim().length > 0) return node.title.trim();
  return t(KIND_TO_LABEL[node.kind] ?? "diagram.toolbar.addSimple");
}

export function LeftPanel() {
  const { t } = useTranslation();
  const store = useDiagramStore();
  const nodes = useDiagram((s) => s.doc.nodes);
  const selection = useDiagram((s) => s.ephemeral.selection.nodes);
  const [dragId, setDragId] = useState<NodeId | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: NodeId; pos: "above" | "below" } | null>(
    null,
  );

  const handleClick = useCallback(
    (event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }, id: NodeId) => {
      if (event.metaKey || event.ctrlKey) {
        const next = new Set(selection);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        store.setState(setSelection(next));
      } else {
        store.setState(setSelection([id]));
      }
    },
    [selection, store],
  );

  const handleToggleVisible = useCallback(
    (node: DiagramNode) => {
      store.setState(withSnapshot(setNodeHidden(node.id, !node.hidden), defaultCoalescer()));
    },
    [store],
  );

  const handleToggleLocked = useCallback(
    (node: DiagramNode) => {
      store.setState(withSnapshot(setNodeLocked(node.id, !node.locked), defaultCoalescer()));
    },
    [store],
  );

  const handleRename = useCallback(
    (id: NodeId, value: string) => {
      store.setState(withSnapshot(updateNode(id, { title: value }), defaultCoalescer()));
    },
    [store],
  );

  const handleDragStart = useCallback(
    (event: DragEvent<HTMLLIElement>, id: NodeId) => {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/anchor-diagram-layer", id);
      setDragId(id);
    },
    [],
  );

  const handleDragOver = useCallback(
    (event: DragEvent<HTMLLIElement>, id: NodeId) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const rect = event.currentTarget.getBoundingClientRect();
      const pos = event.clientY - rect.top < rect.height / 2 ? "above" : "below";
      setDropTarget({ id, pos });
    },
    [],
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLLIElement>, targetId: NodeId) => {
      event.preventDefault();
      const sourceId = event.dataTransfer.getData("text/anchor-diagram-layer");
      if (!sourceId || sourceId === targetId) {
        setDragId(null);
        setDropTarget(null);
        return;
      }
      const reversed = [...nodes].reverse(); // visual order top-to-bottom
      const targetVisualIdx = reversed.findIndex((n) => n.id === targetId);
      if (targetVisualIdx < 0) return;
      const pos = dropTarget?.pos ?? "above";
      const visualIdx = pos === "above" ? targetVisualIdx : targetVisualIdx + 1;
      const targetArrayIdx = nodes.length - visualIdx; // convert visual to array idx
      store.setState(
        withSnapshot(moveNodeToIndex(sourceId, Math.max(0, targetArrayIdx - 1)), defaultCoalescer()),
      );
      setDragId(null);
      setDropTarget(null);
    },
    [dropTarget, nodes, store],
  );

  const handleDragEnd = useCallback(() => {
    setDragId(null);
    setDropTarget(null);
  }, []);

  if (nodes.length === 0) {
    return (
      <aside className="anchor-diagram-side-panel" aria-label={t("diagram.panel.layers")}>
        <h2>{t("diagram.panel.layers")}</h2>
        <p className="anchor-diagram-side-panel-empty">{t("diagram.panel.layers.empty")}</p>
      </aside>
    );
  }

  const visualOrder = [...nodes].reverse();

  return (
    <aside className="anchor-diagram-side-panel" aria-label={t("diagram.panel.layers")}>
      <h2>{t("diagram.panel.layers")}</h2>
      <ul className="anchor-diagram-layers">
        {visualOrder.map((node) => {
          const isSelected = selection.has(node.id);
          const isDragging = dragId === node.id;
          const dropHint =
            dropTarget && dropTarget.id === node.id ? `drop-${dropTarget.pos}` : "";
          return (
            <li
              key={node.id}
              className={`anchor-diagram-layer${isSelected ? " is-selected" : ""}${
                isDragging ? " is-dragging" : ""
              }${dropHint ? ` is-${dropHint}` : ""}`}
              draggable
              onDragStart={(e) => handleDragStart(e, node.id)}
              onDragOver={(e) => handleDragOver(e, node.id)}
              onDrop={(e) => handleDrop(e, node.id)}
              onDragEnd={handleDragEnd}
              onClick={(e) => handleClick(e, node.id)}
            >
              <span className="anchor-diagram-layer-grip" aria-hidden="true">
                <GripVertical size={12} />
              </span>
              <input
                className="anchor-diagram-layer-name"
                value={node.title ?? ""}
                placeholder={defaultLabelFor(node, t)}
                onChange={(e) => handleRename(node.id, e.target.value)}
                onClick={(e) => e.stopPropagation()}
              />
              <button
                type="button"
                className="anchor-diagram-layer-button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleToggleVisible(node);
                }}
                title={t("diagram.hide.toggle")}
                aria-label={t("diagram.hide.toggle")}
              >
                {node.hidden ? <EyeOff size={12} /> : <Eye size={12} />}
              </button>
              <button
                type="button"
                className="anchor-diagram-layer-button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleToggleLocked(node);
                }}
                title={t("diagram.lock.toggle")}
                aria-label={t("diagram.lock.toggle")}
              >
                {node.locked ? <Lock size={12} /> : <Unlock size={12} />}
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
