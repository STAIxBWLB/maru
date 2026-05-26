import { ClipboardCopy, ClipboardPaste, Redo2, Trash2, Undo2 } from "lucide-react";
import { useCallback, useState } from "react";

import {
  alignSelection,
  bringForward,
  bringToFront,
  defaultCoalescer,
  distributeSelection,
  equalizeSelection,
  pasteStyleToSelection,
  pickStyle,
  redo as redoAction,
  removeEdges,
  removeNodes,
  sendBackward,
  sendToBack,
  undo as undoAction,
  withSnapshot,
} from "../../../lib/diagram/actions";
import { useDiagram, useDiagramStore } from "../DiagramStoreContext";
import { RibbonButton, RibbonGroup, RibbonSeparator } from "./ribbonPrimitives";

export function RibbonEdit() {
  const store = useDiagramStore();
  const history = useDiagram((s) => s.ephemeral.history);
  const selection = useDiagram((s) => s.ephemeral.selection);
  const nodes = useDiagram((s) => s.doc.nodes);
  const [styleClipboard, setStyleClipboard] = useState<
    ReturnType<typeof pickStyle> | null
  >(null);

  const canUndo = history.past.length > 0;
  const canRedo = history.future.length > 0;
  const nodeCount = selection.nodes.size;
  const edgeCount = selection.edges.size;
  const hasSelection = nodeCount + edgeCount > 0;
  const canAlign = nodeCount >= 2;
  const canDistribute = nodeCount >= 3;
  const canCopyStyle = nodeCount === 1;

  const handleDelete = useCallback(() => {
    if (selection.nodes.size > 0) {
      store.setState(withSnapshot(removeNodes(selection.nodes), defaultCoalescer()));
    }
    if (selection.edges.size > 0) {
      store.setState(withSnapshot(removeEdges(selection.edges), defaultCoalescer()));
    }
  }, [selection, store]);

  const handleCopyStyle = useCallback(() => {
    const id = [...selection.nodes][0];
    if (!id) return;
    const node = nodes.find((n) => n.id === id);
    if (!node) return;
    setStyleClipboard(pickStyle(node) ?? null);
  }, [nodes, selection]);

  const handlePasteStyle = useCallback(() => {
    if (!styleClipboard) return;
    store.setState(withSnapshot(pasteStyleToSelection(styleClipboard), defaultCoalescer()));
  }, [store, styleClipboard]);

  return (
    <>
      <RibbonGroup labelKey="diagram.ribbon.group.history">
        <RibbonButton
          labelKey="diagram.toolbar.undo"
          onClick={() => store.setState(undoAction())}
          disabled={!canUndo}
          icon={<Undo2 size={14} />}
        />
        <RibbonButton
          labelKey="diagram.toolbar.redo"
          onClick={() => store.setState(redoAction())}
          disabled={!canRedo}
          icon={<Redo2 size={14} />}
        />
        <RibbonButton
          labelKey="diagram.toolbar.delete"
          onClick={handleDelete}
          disabled={!hasSelection}
          icon={<Trash2 size={14} />}
        />
      </RibbonGroup>
      <RibbonSeparator />
      <RibbonGroup labelKey="diagram.ribbon.group.style">
        <RibbonButton
          labelKey="diagram.style.copy"
          onClick={handleCopyStyle}
          disabled={!canCopyStyle}
          icon={<ClipboardCopy size={14} />}
        />
        <RibbonButton
          labelKey="diagram.style.paste"
          onClick={handlePasteStyle}
          disabled={!styleClipboard || nodeCount === 0}
          icon={<ClipboardPaste size={14} />}
        />
      </RibbonGroup>
      <RibbonSeparator />
      <RibbonGroup labelKey="diagram.ribbon.group.alignment">
        <RibbonButton labelKey="diagram.align.left" onClick={() => store.setState(withSnapshot(alignSelection("left"), defaultCoalescer()))} disabled={!canAlign}>⇤</RibbonButton>
        <RibbonButton labelKey="diagram.align.centerH" onClick={() => store.setState(withSnapshot(alignSelection("center-h"), defaultCoalescer()))} disabled={!canAlign}>↔</RibbonButton>
        <RibbonButton labelKey="diagram.align.right" onClick={() => store.setState(withSnapshot(alignSelection("right"), defaultCoalescer()))} disabled={!canAlign}>⇥</RibbonButton>
        <RibbonButton labelKey="diagram.align.top" onClick={() => store.setState(withSnapshot(alignSelection("top"), defaultCoalescer()))} disabled={!canAlign}>⇡</RibbonButton>
        <RibbonButton labelKey="diagram.align.centerV" onClick={() => store.setState(withSnapshot(alignSelection("center-v"), defaultCoalescer()))} disabled={!canAlign}>↕</RibbonButton>
        <RibbonButton labelKey="diagram.align.bottom" onClick={() => store.setState(withSnapshot(alignSelection("bottom"), defaultCoalescer()))} disabled={!canAlign}>⇣</RibbonButton>
      </RibbonGroup>
      <RibbonGroup labelKey="diagram.ribbon.group.distribute">
        <RibbonButton labelKey="diagram.distribute.h" onClick={() => store.setState(withSnapshot(distributeSelection("h"), defaultCoalescer()))} disabled={!canDistribute}>↔균</RibbonButton>
        <RibbonButton labelKey="diagram.distribute.v" onClick={() => store.setState(withSnapshot(distributeSelection("v"), defaultCoalescer()))} disabled={!canDistribute}>↕균</RibbonButton>
      </RibbonGroup>
      <RibbonGroup labelKey="diagram.ribbon.group.equalize">
        <RibbonButton labelKey="diagram.equalize.w" onClick={() => store.setState(withSnapshot(equalizeSelection("w"), defaultCoalescer()))} disabled={!canAlign}>↔=</RibbonButton>
        <RibbonButton labelKey="diagram.equalize.h" onClick={() => store.setState(withSnapshot(equalizeSelection("h"), defaultCoalescer()))} disabled={!canAlign}>↕=</RibbonButton>
      </RibbonGroup>
      <RibbonSeparator />
      <RibbonGroup labelKey="diagram.ribbon.group.zorder">
        <RibbonButton labelKey="diagram.order.front" onClick={() => store.setState(withSnapshot(bringToFront(), defaultCoalescer()))} disabled={nodeCount === 0}>⬆⬆</RibbonButton>
        <RibbonButton labelKey="diagram.order.forward" onClick={() => store.setState(withSnapshot(bringForward(), defaultCoalescer()))} disabled={nodeCount === 0}>⬆</RibbonButton>
        <RibbonButton labelKey="diagram.order.backward" onClick={() => store.setState(withSnapshot(sendBackward(), defaultCoalescer()))} disabled={nodeCount === 0}>⬇</RibbonButton>
        <RibbonButton labelKey="diagram.order.back" onClick={() => store.setState(withSnapshot(sendToBack(), defaultCoalescer()))} disabled={nodeCount === 0}>⬇⬇</RibbonButton>
      </RibbonGroup>
    </>
  );
}
