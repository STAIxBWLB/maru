// Filter side panel for graph mode (spec §F2 필터): domain / type / community /
// show-ghosts (default off) / min-degree slider, plus search.

import { useTranslation } from "../../lib/i18n";

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

interface GraphFilterPanelProps {
  filters: GraphFilters;
  domains: string[];
  types: string[];
  communities: number[];
  search: string;
  maxDegree: number;
  onFiltersChange: (next: GraphFilters) => void;
  onSearchChange: (next: string) => void;
  onRelayout: () => void;
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
  search,
  maxDegree,
  onFiltersChange,
  onSearchChange,
  onRelayout,
}: GraphFilterPanelProps) {
  const { t } = useTranslation();
  return (
    <aside className="graph-filter-panel" data-testid="graph-filter-panel">
      <input
        type="search"
        className="graph-search"
        placeholder={t("graph.searchPlaceholder")}
        value={search}
        onChange={(event) => onSearchChange(event.target.value)}
      />
      <section>
        <h4>{t("graph.filter.domain")}</h4>
        <div className="graph-chip-row">
          {domains.map((domain) => (
            <button
              key={domain}
              type="button"
              className={filters.domains.has(domain) ? "graph-chip active" : "graph-chip"}
              onClick={() =>
                onFiltersChange({ ...filters, domains: toggle(filters.domains, domain) })
              }
            >
              {domain}
            </button>
          ))}
        </div>
      </section>
      <section>
        <h4>{t("graph.filter.type")}</h4>
        <div className="graph-chip-row">
          {types.map((type) => (
            <button
              key={type}
              type="button"
              className={filters.types.has(type) ? "graph-chip active" : "graph-chip"}
              onClick={() =>
                onFiltersChange({ ...filters, types: toggle(filters.types, type) })
              }
            >
              {type}
            </button>
          ))}
        </div>
      </section>
      {communities.length > 0 ? (
        <section>
          <h4>{t("graph.filter.community")}</h4>
          <select
            value={filters.community ?? ""}
            onChange={(event) =>
              onFiltersChange({
                ...filters,
                community: event.target.value === "" ? null : Number(event.target.value),
              })
            }
          >
            <option value="">{t("graph.filter.allCommunities")}</option>
            {communities.map((community) => (
              <option key={community} value={community}>
                #{community}
              </option>
            ))}
          </select>
        </section>
      ) : null}
      <section>
        <label className="graph-toggle">
          <input
            type="checkbox"
            checked={filters.showGhosts}
            onChange={(event) =>
              onFiltersChange({ ...filters, showGhosts: event.target.checked })
            }
          />
          {t("graph.filter.showGhosts")}
        </label>
      </section>
      <section>
        <h4>
          {t("graph.filter.minDegree")}: {filters.minDegree}
        </h4>
        <input
          type="range"
          min={0}
          max={Math.max(maxDegree, 1)}
          value={filters.minDegree}
          onChange={(event) =>
            onFiltersChange({ ...filters, minDegree: Number(event.target.value) })
          }
        />
      </section>
      <button type="button" className="graph-relayout" onClick={onRelayout}>
        {t("graph.relayout")}
      </button>
    </aside>
  );
}
