// Insight / ideation panel — the "derive new relationships" layer over the
// graph. Four groups: hidden-link candidates (common-neighbor link
// prediction), surprising cross-community connections, community bridges, and
// neglected notes (orphans + stale). Rows highlight on the canvas.

import { ArrowLeftRight, Copy, ExternalLink, Lightbulb, Link2, Sparkles, Waypoints } from "lucide-react";
import { Children, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "../../lib/i18n";
import type { InsightBundle } from "../../lib/graph/analysis.worker";
import type { GraphModel } from "../../lib/graph/model";

const STALE_DAYS = 120;
const INSIGHT_PREVIEW_COUNT = 6;

interface GraphInsightsPanelProps {
  model: GraphModel;
  now: number;
  onHighlightPair: (a: string, b: string) => void;
  onSelectNode: (id: string) => void;
  onCopyWikilink: (id: string) => void;
  onOpenNode: (id: string) => void;
  onConnect: (source: string, target: string) => void;
}

export function GraphInsightsPanel({
  model,
  now,
  onHighlightPair,
  onSelectNode,
  onCopyWikilink,
  onOpenNode,
  onConnect,
}: GraphInsightsPanelProps) {
  const { t } = useTranslation();
  const labelById = useMemo(
    () => new Map(model.nodes.map((n) => [n.id, n.label])),
    [model],
  );
  const label = (id: string) => labelById.get(id) ?? id;
  const [bundle, setBundle] = useState<InsightBundle | null>(null);
  const epochRef = useRef(0);
  useEffect(() => {
    const worker = new Worker(new URL("../../lib/graph/analysis.worker.ts", import.meta.url), { type: "module" });
    const epoch = ++epochRef.current;
    setBundle(null);
    worker.onmessage = (event: MessageEvent<{ epoch: number; bundle: InsightBundle }>) => {
      if (event.data.epoch === epochRef.current) setBundle(event.data.bundle);
    };
    worker.postMessage({ epoch, model, now, staleDays: STALE_DAYS });
    return () => worker.terminate();
  }, [model, now]);
  const hidden = bundle?.hidden ?? [];
  const surprising = bundle?.surprising ?? [];
  const bridges = bundle?.bridges ?? [];
  const orphans = bundle?.orphans ?? [];
  const stale = bundle?.stale ?? [];

  return (
    <div className="graph-insights" data-testid="graph-insights">
      <InsightSection
        icon={<Lightbulb size={13} />}
        title={t("graph.insight.hidden")}
        hint={t("graph.insight.hiddenHint")}
        count={hidden.length}
      >
        {hidden.map((link) => (
          <div className="graph-insight-rowgroup" key={`${link.source}-${link.target}`}>
            <button
              type="button"
              className="graph-insight-action primary"
              title={t("graph.relation.apply")}
              data-testid="graph-insight-connect"
              onClick={() => onConnect(link.source, link.target)}
            >
              <Link2 size={11} />
            </button>
            <button
              type="button"
              className="graph-insight-row"
              onClick={() => onHighlightPair(link.source, link.target)}
            >
              <span className="graph-insight-pair">
                {label(link.source)} <ArrowLeftRight size={11} /> {label(link.target)}
              </span>
              <span className="graph-insight-meta">
                {t("graph.insight.shared", { count: link.shared })} · {link.score.toFixed(2)}
              </span>
              {link.via.length > 0 ? (
                <span className="graph-insight-via" title={link.via.map(label).join(", ")}>
                  {t("graph.insight.via", { nodes: link.via.slice(0, 3).map(label).join(", ") })}
                </span>
              ) : null}
            </button>
            <button
              type="button"
              className="graph-insight-action"
              title={t("graph.action.copyWikilink")}
              data-testid="graph-insight-copy"
              onClick={() => onCopyWikilink(link.target)}
            >
              <Copy size={11} />
            </button>
            <button
              type="button"
              className="graph-insight-action"
              title={t("graph.insight.openSource")}
              data-testid="graph-insight-open"
              onClick={() => onOpenNode(link.source)}
            >
              <ExternalLink size={11} />
            </button>
          </div>
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
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const empty = count === 0;
  // Show INSIGHT_PREVIEW_COUNT rows initially; a "more" expander reveals the
  // rest (up to the section's existing limit).
  const items = Children.toArray(children);
  const shown = expanded ? items : items.slice(0, INSIGHT_PREVIEW_COUNT);
  const hiddenCount = items.length - shown.length;
  return (
    <section className="graph-insight-section">
      <header className="graph-insight-header">
        <span className="graph-insight-title">
          {icon} {title}
        </span>
        <span className="graph-insight-count">{count}</span>
      </header>
      {empty ? (
        <p className="graph-insight-hint">{hint}</p>
      ) : (
        <div className="graph-insight-rows">
          {shown}
          {hiddenCount > 0 ? (
            <button type="button" className="graph-insight-more" onClick={() => setExpanded(true)}>
              {t("graph.insight.more", { count: hiddenCount })}
            </button>
          ) : null}
          {expanded && items.length > INSIGHT_PREVIEW_COUNT ? (
            <button type="button" className="graph-insight-more" onClick={() => setExpanded(false)}>
              {t("graph.insight.less")}
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}
