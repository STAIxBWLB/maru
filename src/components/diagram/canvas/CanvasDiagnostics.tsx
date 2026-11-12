import { useMemo } from "react";
import type { Diagnostic } from "../../../../src-tauri/crates/maru-diagram-engine/bindings/engine";
import { CANVAS_DIAGNOSTIC_BADGE, mapCanvasDiagnostics, type CanvasDiagnosticPlacement } from "../../../lib/diagram/canvasDiagnostics";
import type { CanvasGeometry } from "../../../lib/diagram/engineCanvasGeometry";
import type { DiagramDoc, DiagramNode } from "../../../lib/diagram/types";
import { useTranslation } from "../../../lib/i18n";

type Scope = "elements" | "canvas";

/** Badges describe engine results only; none of their events mutate the document. */
export function CanvasDiagnostics({ items, scope = "elements" }: {
  items: readonly CanvasDiagnosticPlacement[];
  scope?: Scope;
}) {
  const { t } = useTranslation();
  const visible = items.filter((item) => scope === "elements" ? item.target !== null : item.target === null);
  if (visible.length === 0) return null;
  const original = (item: CanvasDiagnosticPlacement) => `${t("diagram.canvasDiagnostic.original")}\n${t("diagram.canvasDiagnostic.cause")}: ${item.diagnostic.message}\n${t("diagram.canvasDiagnostic.nextStep")}: ${item.diagnostic.fix}\n${item.diagnostic.code}\n${item.diagnostic.path}`;
  if (scope === "canvas") {
    return (
      <foreignObject data-export-ignore data-canvas-diagnostic-notice x={12} y={12} width={360} height={Math.min(300, visible.length * 76 + 30)}>
        <div
          style={{ boxSizing: "border-box", maxHeight: 300, overflowY: "auto", padding: 8, border: "1px solid #b45309", borderRadius: 6, background: "#fffbeb", color: "#78350f", fontSize: 12, lineHeight: 1.4 }}
          onPointerDown={(event) => event.stopPropagation()}
          onWheel={(event) => event.stopPropagation()}
        >
          <strong>{t("diagram.canvasDiagnostic.canvas")}</strong>
          {visible.map((item, index) => (
            <div key={`${item.diagnostic.code}:${item.diagnostic.path}:${index}`} data-canvas-diagnostic={item.diagnostic.code} role="note" title={original(item)} aria-label={original(item)} style={{ paddingTop: 6, paddingBottom: 6 }}>
              <div>{t(`diagram.canvasDiagnostic.${item.category}.summary`)}</div>
              <div>{t(`diagram.canvasDiagnostic.${item.category}.fix`)}</div>
            </div>
          ))}
        </div>
      </foreignObject>
    );
  }
  return (
    <g data-export-ignore>
      {visible.map((item, index) => {
        const target = item.target!;
        return (
          // `tabIndex` matters: WebKit does not put an SVG group in the tab
          // order without it, and a reader that can see this badge has to be
          // able to reach its text as well. The position comes from the mapper,
          // which has already moved the badge clear of every other box.
          <g
            key={`${item.diagnostic.code}:${item.diagnostic.path}:${index}`}
            data-canvas-diagnostic={item.diagnostic.code}
            data-target-kind={target.kind}
            data-target-id={target.id}
            transform={`translate(${target.x},${target.y})`}
            role="note"
            tabIndex={0}
            aria-label={original(item)}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <title>{original(item)}</title>
            <rect width={CANVAS_DIAGNOSTIC_BADGE.width} height={CANVAS_DIAGNOSTIC_BADGE.height} rx={4} fill="#fffbeb" stroke="#b45309" />
            <text x={8} y={16} fontSize={12} fill="#78350f">{t(`diagram.canvasDiagnostic.${item.category}.summary`)}</text>
            <text x={8} y={33} fontSize={10} fill="#78350f">{t(`diagram.canvasDiagnostic.${item.category}.fix`)}</text>
          </g>
        );
      })}
    </g>
  );
}

/** Lazy-load this layer with its mapper only when current diagnostics exist. */
export function CanvasDiagnosticLayer({ doc, datasetId, geometry, diagnostics, displayedNodes, scope }: {
  doc: DiagramDoc;
  datasetId: string;
  geometry: CanvasGeometry | null;
  diagnostics: readonly Diagnostic[];
  displayedNodes?: readonly DiagramNode[];
  scope?: Scope;
}) {
  const items = useMemo(() => mapCanvasDiagnostics(doc, datasetId, geometry, diagnostics, displayedNodes), [doc, datasetId, geometry, diagnostics, displayedNodes]);
  return <CanvasDiagnostics items={items} scope={scope} />;
}
