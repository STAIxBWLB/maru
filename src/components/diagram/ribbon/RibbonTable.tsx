import { defaultCoalescer, updateNode, withSnapshot } from "../../../lib/diagram/actions";
import type { DiagramNode } from "../../../lib/diagram/types";
import { useTranslation } from "../../../lib/i18n";
import { useDiagram, useDiagramStore } from "../DiagramStoreContext";
import { RibbonButton, RibbonGroup, RibbonSeparator } from "./ribbonPrimitives";

export function RibbonTable() {
  const { t } = useTranslation();
  const store = useDiagramStore();
  const selection = useDiagram((s) => s.ephemeral.selection);
  const nodes = useDiagram((s) => s.doc.nodes);
  const table = nodes.find((node) => selection.nodes.has(node.id) && node.kind === "table");
  const rows = Math.max(1, Number(table?.meta?.rows) || 3);
  const cols = Math.max(1, Number(table?.meta?.cols) || 3);
  const disabled = !table;

  const patchTable = (node: DiagramNode, patch: Record<string, unknown>) => {
    store.setState(
      withSnapshot(
        updateNode(node.id, { meta: { ...(node.meta ?? {}), ...patch } }),
        defaultCoalescer(),
      ),
    );
  };

  return (
    <>
      <RibbonGroup labelKey="diagram.ribbon.group.tableSize">
        <RibbonButton
          labelKey="diagram.table.rowAdd"
          disabled={disabled || rows >= 20}
          onClick={() => table && patchTable(table, { rows: rows + 1 })}
        />
        <RibbonButton
          labelKey="diagram.table.rowRemove"
          disabled={disabled || rows <= 1}
          onClick={() => table && patchTable(table, { rows: rows - 1 })}
        />
        <RibbonButton
          labelKey="diagram.table.colAdd"
          disabled={disabled || cols >= 20}
          onClick={() => table && patchTable(table, { cols: cols + 1 })}
        />
        <RibbonButton
          labelKey="diagram.table.colRemove"
          disabled={disabled || cols <= 1}
          onClick={() => table && patchTable(table, { cols: cols - 1 })}
        />
      </RibbonGroup>
      <RibbonSeparator />
      <RibbonGroup labelKey="diagram.ribbon.group.tableMeta">
        <span className="anchor-diagram-ribbon-hint">
          {disabled
            ? t("diagram.table.selectHint")
            : t("diagram.table.count", { rows: String(rows), cols: String(cols) })}
        </span>
      </RibbonGroup>
    </>
  );
}
