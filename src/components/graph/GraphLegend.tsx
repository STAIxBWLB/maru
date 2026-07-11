// Canvas legend overlay (spec §F2 비주얼라이제이션): a collapsible color key that
// doubles as a filter. Shows communities when the overlay is present, else
// domains. Clicking a swatch toggles the matching filter.

import { ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "../../lib/i18n";
import { communityColor, domainColor } from "./graphStyle";
import type { FacetItem, GraphFilters } from "./GraphFilterPanel";

interface GraphLegendProps {
  enriched: boolean;
  domains: FacetItem<string>[];
  communities: FacetItem<number>[];
  filters: GraphFilters;
  onFiltersChange: (next: GraphFilters) => void;
}

export function GraphLegend({
  enriched,
  domains,
  communities,
  filters,
  onFiltersChange,
}: GraphLegendProps) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(false);

  const items = enriched
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

  return (
    <div className="graph-legend" data-testid="graph-legend">
      <button
        type="button"
        className="graph-legend-head"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
      >
        <span>{enriched ? t("graph.legend.community") : t("graph.legend.domain")}</span>
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
