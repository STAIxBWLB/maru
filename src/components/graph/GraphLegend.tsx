// Canvas legend overlay (spec §F2 비주얼라이제이션): a collapsible color key
// that doubles as a filter. Its content follows the selected color mode, so
// the key always describes the colors currently drawn on the canvas.

import { ChevronDown, ChevronUp, Palette } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "../../lib/i18n";
import type { GraphEdgeOrigin } from "../../lib/graph/model";
import { communityColor, domainColor, originColor, originEdgeColor } from "./graphStyle";
import type { FacetItem, GraphFilters } from "./GraphFilterPanel";

interface LegendItem {
  key: string;
  label: string;
  color: string;
  count?: number;
  active?: boolean;
  toggle?: () => void;
  /** Render the swatch as a line — the item keys an edge color, not a node. */
  line?: boolean;
}

interface GraphLegendProps {
  mode: "domain" | "community" | "origin";
  domains: FacetItem<string>[];
  origins: FacetItem<string>[];
  communities: FacetItem<number>[];
  filters: GraphFilters;
  onFiltersChange: (next: GraphFilters) => void;
  /** Outside the wide tier the legend starts collapsed to an icon button. */
  iconOnly?: boolean;
}

export function GraphLegend({
  mode,
  domains,
  origins,
  communities,
  filters,
  onFiltersChange,
  iconOnly = false,
}: GraphLegendProps) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(iconOnly);

  useEffect(() => {
    if (!iconOnly) setCollapsed(false);
  }, [iconOnly]);

  // Origin mode: the two node classes filter on click, and one extra row keys
  // the cross-boundary edge color (same-origin edges reuse their node hue).
  // A single-class graph (vault source, or a workspace with no vault) has no
  // color grouping to key — the legend stays out of the way.
  const originItems: LegendItem[] = (origins.length > 1 ? origins : []).map((o) => ({
    key: o.value,
    label: t(`graph.origin.${o.value}`),
    count: o.count,
    color: originColor(o.value as GraphEdgeOrigin),
    active: filters.origins.has(o.value),
    toggle: () => {
      const next = new Set(filters.origins);
      if (next.has(o.value)) next.delete(o.value);
      else next.add(o.value);
      onFiltersChange({ ...filters, origins: next });
    },
  }));
  if (originItems.length > 1) {
    originItems.push({
      key: "cross",
      label: t("graph.legend.origin.cross"),
      color: originEdgeColor("cross"),
      line: true,
    });
  }

  const items: LegendItem[] = mode === "origin"
    ? originItems
    : mode === "community"
    ? communities.map((c) => ({
        key: `c${c.value}`,
        label: `#${c.value}`,
        count: c.count,
        color: communityColor(c.value),
        active: filters.community === c.value,
        toggle: () =>
          onFiltersChange({
            ...filters,
            community: filters.community === c.value ? null : c.value,
          }),
      }))
    : domains.map((d) => ({
        key: d.value,
        label: d.value,
        count: d.count,
        color: domainColor(d.value),
        active: filters.domains.has(d.value),
        toggle: () => {
          const next = new Set(filters.domains);
          if (next.has(d.value)) next.delete(d.value);
          else next.add(d.value);
          onFiltersChange({ ...filters, domains: next });
        },
      }));

  if (items.length === 0) return null;

  const legendTitle =
    mode === "origin"
      ? t("graph.legend.origin")
      : mode === "community"
        ? t("graph.legend.community")
        : t("graph.legend.domain");

  if (iconOnly && collapsed) {
    return (
      <button
        type="button"
        className="graph-legend-icon"
        data-testid="graph-legend"
        title={legendTitle}
        aria-expanded={false}
        onClick={() => setCollapsed(false)}
      >
        <Palette size={13} />
      </button>
    );
  }

  return (
    <div className="graph-legend" data-testid="graph-legend">
      <button
        type="button"
        className="graph-legend-head"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
      >
        <span>{legendTitle}</span>
        {collapsed ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>
      {!collapsed ? (
        <ul className="graph-legend-list">
          {items.map((item) => {
            const body = (
              <>
                <span
                  className={item.line ? "graph-swatch graph-swatch-line" : "graph-swatch"}
                  style={{ background: item.color }}
                />
                <span className="graph-legend-label">{item.label}</span>
                {item.count != null ? (
                  <span className="graph-legend-count" aria-hidden>
                    {item.count}
                  </span>
                ) : null}
              </>
            );
            return (
              <li key={item.key}>
                {item.toggle ? (
                  <button
                    type="button"
                    className={item.active ? "graph-legend-item active" : "graph-legend-item"}
                    aria-pressed={item.active}
                    onClick={item.toggle}
                  >
                    {body}
                  </button>
                ) : (
                  <span className="graph-legend-item static">{body}</span>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
