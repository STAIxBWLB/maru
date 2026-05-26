import { Network } from "lucide-react";

import { useTranslation } from "../../lib/i18n";
import "./diagram.css";

export interface DiagramModeProps {
  workPath: string | null;
  onError?: (message: string | null) => void;
}

/**
 * Phase 0 scaffold for the diagram mode.
 *
 * Renders an empty pane with title and i18n-aware empty-state. Phase 1 mounts
 * the canvas and persistence wiring; subsequent phases populate ribbon, panels,
 * modals, templates, export, and history.
 */
export function DiagramMode({ workPath }: DiagramModeProps) {
  const { t } = useTranslation();
  return (
    <div className="anchor-diagram" data-testid="diagram-mode" role="region" aria-label={t("mode.diagram")}>
      <header className="anchor-diagram-header">
        <div className="anchor-diagram-title">
          <Network size={20} strokeWidth={1.9} aria-hidden="true" />
          <div>
            <h1>{t("diagram.scaffold.title")}</h1>
            <p>{t("diagram.scaffold.subtitle")}</p>
          </div>
        </div>
        <div className="anchor-diagram-meta">
          <span className="anchor-diagram-meta-label">{t("diagram.scaffold.workspace")}</span>
          <code>{workPath ?? "—"}</code>
        </div>
      </header>
      <section className="anchor-diagram-empty" aria-live="polite">
        <p>{t("diagram.scaffold.empty")}</p>
        <p className="anchor-diagram-flag-hint">{t("diagram.scaffold.flagHint")}</p>
      </section>
    </div>
  );
}

export default DiagramMode;
