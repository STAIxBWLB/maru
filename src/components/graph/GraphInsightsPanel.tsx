// Insight / ideation panel — the "derive new relationships" layer over the
// read-only graph. Four groups: hidden-link candidates (common-neighbor link
// prediction), surprising cross-community connections, community bridges, and
// neglected notes (orphans + stale). Rows highlight on the canvas.

import { ArrowLeftRight, Lightbulb, Sparkles, Waypoints } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "../../lib/i18n";
import {
  findBridges,
  findHiddenLinks,
  findOrphans,
  findStale,
  findSurprisingConnections,
} from "../../lib/graph/insights";
import type { GraphModel } from "../../lib/graph/model";

const STALE_DAYS = 120;

interface GraphInsightsPanelProps {
  model: GraphModel;
  now: number;
  onHighlightPair: (a: string, b: string) => void;
  onSelectNode: (id: string) => void;
}

export function GraphInsightsPanel({
  model,
  now,
  onHighlightPair,
  onSelectNode,
}: GraphInsightsPanelProps) {
  const { t } = useTranslation();
  const labelById = useMemo(
    () => new Map(model.nodes.map((n) => [n.id, n.label])),
    [model],
  );
  const label = (id: string) => labelById.get(id) ?? id;

  const hidden = useMemo(() => findHiddenLinks(model), [model]);
  const surprising = useMemo(() => findSurprisingConnections(model), [model]);
  const bridges = useMemo(() => findBridges(model), [model]);
  const orphans = useMemo(() => findOrphans(model), [model]);
  const stale = useMemo(() => findStale(model, STALE_DAYS, now), [model, now]);

  return (
    <div className="graph-insights" data-testid="graph-insights">
      <InsightSection
        icon={<Lightbulb size={13} />}
        title={t("graph.insight.hidden")}
        hint={t("graph.insight.hiddenHint")}
        count={hidden.length}
      >
        {hidden.map((link) => (
          <button
            key={`${link.source}-${link.target}`}
            type="button"
            className="graph-insight-row"
            onClick={() => onHighlightPair(link.source, link.target)}
          >
            <span className="graph-insight-pair">
              {label(link.source)} <ArrowLeftRight size={11} /> {label(link.target)}
            </span>
            <span className="graph-insight-meta">
              {t("graph.insight.shared", { count: link.shared })}
            </span>
          </button>
        ))}
      </InsightSection>

      <InsightSection
        icon={<Sparkles size={13} />}
        title={t("graph.insight.surprising")}
        hint={model.enriched ? t("graph.insight.surprisingHint") : t("graph.insight.needsOverlay")}
        count={surprising.length}
      >
        {surprising.map((c) => (
          <button
            key={`${c.source}-${c.target}`}
            type="button"
            className="graph-insight-row"
            onClick={() => onHighlightPair(c.source, c.target)}
          >
            <span className="graph-insight-pair">
              {label(c.source)} <ArrowLeftRight size={11} /> {label(c.target)}
            </span>
            <span className="graph-insight-meta">
              #{c.sourceCommunity} · #{c.targetCommunity}
            </span>
          </button>
        ))}
      </InsightSection>

      <InsightSection
        icon={<Waypoints size={13} />}
        title={t("graph.insight.bridges")}
        hint={model.enriched ? t("graph.insight.bridgesHint") : t("graph.insight.needsOverlay")}
        count={bridges.length}
      >
        {bridges.map((b) => (
          <button
            key={b.id}
            type="button"
            className="graph-insight-row"
            onClick={() => onSelectNode(b.id)}
          >
            <span className="graph-insight-label">{label(b.id)}</span>
            <span className="graph-insight-meta">
              {t("graph.insight.communities", { count: b.communityCount })}
            </span>
          </button>
        ))}
      </InsightSection>

      <InsightSection
        icon={<Lightbulb size={13} />}
        title={t("graph.insight.neglected")}
        hint={t("graph.insight.neglectedHint")}
        count={orphans.length + stale.length}
      >
        {orphans.map((o) => (
          <button
            key={`orphan-${o.id}`}
            type="button"
            className="graph-insight-row"
            onClick={() => onSelectNode(o.id)}
          >
            <span className="graph-insight-label">{label(o.id)}</span>
            <span className="graph-insight-meta graph-insight-orphan">
              {t("graph.insight.orphan")}
            </span>
          </button>
        ))}
        {stale.map((s) => (
          <button
            key={`stale-${s.id}`}
            type="button"
            className="graph-insight-row"
            onClick={() => onSelectNode(s.id)}
          >
            <span className="graph-insight-label">{label(s.id)}</span>
            <span className="graph-insight-meta">{s.updatedAt?.slice(0, 10) ?? "—"}</span>
          </button>
        ))}
      </InsightSection>
    </div>
  );
}

function InsightSection({
  icon,
  title,
  hint,
  count,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  count: number;
  children: React.ReactNode;
}) {
  const empty = count === 0;
  return (
    <section className="graph-insight-section">
      <header className="graph-insight-header">
        <span className="graph-insight-title">
          {icon} {title}
        </span>
        <span className="graph-insight-count">{count}</span>
      </header>
      {empty ? <p className="graph-insight-hint">{hint}</p> : <div className="graph-insight-rows">{children}</div>}
    </section>
  );
}
