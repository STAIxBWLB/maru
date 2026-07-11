// Filter side panel for graph mode (spec §F2 필터): domain / type / community /
// show-ghosts / min-degree, each chip carrying a count and color swatch, plus
// a reset action.

import { RotateCcw } from "lucide-react";
import { useTranslation } from "../../lib/i18n";
import type { GraphSettings } from "../../lib/settings";
import { communityColor, domainColor } from "./graphStyle";

export interface GraphFilters {
  domains: Set<string>;
  types: Set<string>;
  community: number | null;
  showGhosts: boolean;
  minDegree: number;
}

export const DEFAULT_GRAPH_FILTERS: GraphFilters = {
  domains: new Set(),
  types: new Set(),
  community: null,
  showGhosts: false,
  minDegree: 0,
};

/** Persisted (JSON-friendly, array-based) ↔ runtime (Set-based) filter shape. */
export function filtersFromSettings(f: GraphSettings["filters"]): GraphFilters {
  return {
    domains: new Set(f.domains),
    types: new Set(f.types),
    community: f.community,
    showGhosts: f.showGhosts,
    minDegree: f.minDegree,
  };
}

export function filtersToSettings(f: GraphFilters): GraphSettings["filters"] {
  return {
    domains: [...f.domains],
    types: [...f.types],
    community: f.community,
    showGhosts: f.showGhosts,
    minDegree: f.minDegree,
  };
}

export interface FacetItem<T> {
  value: T;
  count: number;
}

export function filtersAreDefault(filters: GraphFilters): boolean {
  return (
    filters.domains.size === 0 &&
    filters.types.size === 0 &&
    filters.community == null &&
    !filters.showGhosts &&
    filters.minDegree === 0
  );
}

interface GraphFilterPanelProps {
  filters: GraphFilters;
  domains: FacetItem<string>[];
  types: FacetItem<string>[];
  communities: FacetItem<number>[];
  maxDegree: number;
  onFiltersChange: (next: GraphFilters) => void;
  /** Community-area toggle: only meaningful when the overlay supplies them. */
  hullsAvailable: boolean;
  showHulls: boolean;
  onShowHullsChange: (next: boolean) => void;
}

function toggle(set: Set<string>, value: string): Set<string> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export function GraphFilterPanel({
  filters,
  domains,
  types,
  communities,
  maxDegree,
  onFiltersChange,
  hullsAvailable,
  showHulls,
  onShowHullsChange,
}: GraphFilterPanelProps) {
  const { t } = useTranslation();
  const dirty = !filtersAreDefault(filters);

  return (
    <aside className="graph-filter-panel" data-testid="graph-filter-panel">
      <div className="graph-filter-head">
        <span>{t("graph.filter.title")}</span>
        <button
          type="button"
          className="graph-filter-reset"
          disabled={!dirty}
          onClick={() => onFiltersChange(DEFAULT_GRAPH_FILTERS)}
          title={t("graph.filter.reset")}
        >
          <RotateCcw size={12} /> {t("graph.filter.reset")}
        </button>
      </div>

      <section className="graph-filter-section">
        <h4>{t("graph.filter.domain")}</h4>
        <div className="graph-chip-row">
          {domains.map(({ value, count }) => (
            <button
              key={value}
              type="button"
              className={filters.domains.has(value) ? "graph-chip active" : "graph-chip"}
              onClick={() => onFiltersChange({ ...filters, domains: toggle(filters.domains, value) })}
            >
              <span className="graph-swatch" style={{ background: domainColor(value) }} />
              {value}
              <span className="graph-chip-count" aria-hidden>{count}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="graph-filter-section">
        <h4>{t("graph.filter.type")}</h4>
        <div className="graph-chip-row">
          {types.map(({ value, count }) => (
            <button
              key={value}
              type="button"
              className={filters.types.has(value) ? "graph-chip active" : "graph-chip"}
              onClick={() => onFiltersChange({ ...filters, types: toggle(filters.types, value) })}
            >
              {value}
              <span className="graph-chip-count" aria-hidden>{count}</span>
            </button>
          ))}
        </div>
      </section>

      {communities.length > 0 ? (
        <section className="graph-filter-section">
          <h4>{t("graph.filter.community")}</h4>
          <div className="graph-community-list">
            <button
              type="button"
              className={filters.community == null ? "graph-community active" : "graph-community"}
              onClick={() => onFiltersChange({ ...filters, community: null })}
            >
              {t("graph.filter.allCommunities")}
            </button>
            {communities.map(({ value, count }) => (
              <button
                key={value}
                type="button"
                className={filters.community === value ? "graph-community active" : "graph-community"}
                onClick={() => onFiltersChange({ ...filters, community: value })}
              >
                <span className="graph-swatch" style={{ background: communityColor(value) }} />
                #{value}
                <span className="graph-chip-count" aria-hidden>{count}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section className="graph-filter-section">
        <label className="graph-toggle">
          <input
            type="checkbox"
            checked={filters.showGhosts}
            onChange={(event) => onFiltersChange({ ...filters, showGhosts: event.target.checked })}
          />
          {t("graph.filter.showGhosts")}
        </label>
        {hullsAvailable ? (
          <label className="graph-toggle">
            <input
              type="checkbox"
              checked={showHulls}
              data-testid="graph-hulls-toggle"
              onChange={(event) => onShowHullsChange(event.target.checked)}
            />
            {t("graph.filter.showHulls")}
          </label>
        ) : null}
      </section>

      <section className="graph-filter-section">
        <h4>
          {t("graph.filter.minDegree")}
          <span className="graph-slider-value">{filters.minDegree}</span>
        </h4>
        <input
          type="range"
          min={0}
          max={Math.max(maxDegree, 1)}
          value={filters.minDegree}
          onChange={(event) => onFiltersChange({ ...filters, minDegree: Number(event.target.value) })}
        />
      </section>
    </aside>
  );
}
