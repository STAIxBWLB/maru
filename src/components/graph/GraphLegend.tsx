// Canvas legend overlay (spec §F2 비주얼라이제이션): a collapsible color key
// that doubles as a filter. Its content follows the selected color mode, so
// the key always describes the colors currently drawn on the canvas.

import { ChevronDown, ChevronUp, Palette } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "../../lib/i18n";
import { communityColor, domainColor } from "./graphStyle";
import type { FacetItem, GraphFilters } from "./GraphFilterPanel";

interface GraphLegendProps {
  mode: "domain" | "community";
  domains: FacetItem<string>[];
  communities: FacetItem<number>[];
  filters: GraphFilters;
  onFiltersChange: (next: GraphFilters) => void;
  /** Outside the wide tier the legend starts collapsed to an icon button. */
  iconOnly?: boolean;
}

export function GraphLegend({
  mode,
  domains,
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

  const items = mode === "community"
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

  if (iconOnly && collapsed) {
    return (
      <button
        type="button"
        className="graph-legend-icon"
        data-testid="graph-legend"
        title={mode === "community" ? t("graph.legend.community") : t("graph.legend.domain")}
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
        <span>{mode === "community" ? t("graph.legend.community") : t("graph.legend.domain")}</span>
        {collapsed ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>
      {!collapsed ? (
        <ul className="graph-legend-list">
          {items.map((item) => (
            <li key={item.key}>
              <button
                type="button"
                className={item.active ? "graph-legend-item active" : "graph-legend-item"}
                aria-pressed={item.active}
                onClick={item.toggle}
              >
                <span className="graph-swatch" style={{ background: item.color }} />
                <span className="graph-legend-label">{item.label}</span>
                <span className="graph-legend-count" aria-hidden>
                  {item.count}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
