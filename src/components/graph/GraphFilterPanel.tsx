// Filter side panel (V5): Data (generated/unresolved/min visible neighbors),
// Groups (searchable Domain / Type / Relation / Community facets), Paused
// filters (persisted values absent from the current graph — inactive chips,
// click to remove), and Display (arrows / labels / scales, persisted to
// graphSettings.display). Reset clears the active profile.

import { useState } from "react";
import { RotateCcw, Search, X } from "lucide-react";
import { useTranslation } from "../../lib/i18n";
import {
  defaultGraphFilterProfile,
  GRAPH_SCALE_MAX,
  GRAPH_SCALE_MIN,
  type GraphDisplaySettings,
  type GraphFilterProfile,
} from "../../lib/settings";
import { communityColor, domainColor, relationColor } from "./graphStyle";

export interface GraphFilters {
  domains: Set<string>;
  types: Set<string>;
  relations: Set<string>;
  community: number | null;
  showUnresolved: boolean;
  showGenerated: boolean;
  minVisibleNeighbors: number;
}

export const DEFAULT_GRAPH_FILTERS: GraphFilters = filtersFromSettings(defaultGraphFilterProfile());

/** Persisted (JSON-friendly, array-based) ↔ runtime (Set-based) filter shape. */
export function filtersFromSettings(f: GraphFilterProfile): GraphFilters {
  return {
    domains: new Set(f.domains),
    types: new Set(f.types),
    relations: new Set(f.relations),
    community: f.community,
    showUnresolved: f.showUnresolved,
    showGenerated: f.showGenerated,
    minVisibleNeighbors: f.minVisibleNeighbors,
  };
}

export function filtersToSettings(f: GraphFilters): GraphFilterProfile {
  return {
    domains: [...f.domains],
    types: [...f.types],
    relations: [...f.relations],
    community: f.community,
    showUnresolved: f.showUnresolved,
    showGenerated: f.showGenerated,
    minVisibleNeighbors: f.minVisibleNeighbors,
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
    filters.relations.size === 0 &&
    filters.community == null &&
    !filters.showUnresolved &&
    !filters.showGenerated &&
    filters.minVisibleNeighbors === DEFAULT_GRAPH_FILTERS.minVisibleNeighbors
  );
}

function toggle(set: Set<string>, value: string): Set<string> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

/** One facet group (Domain / Type / Relation / Community): selected values
 *  sort first, a filter input appears when the group has more than 8 items. */
function FacetGroup<T extends string | number>({
  title,
  items,
  selected,
  swatch,
  format,
  onToggle,
}: {
  title: string;
  items: FacetItem<T>[];
  selected: (value: T) => boolean;
  swatch?: (value: T) => string;
  format?: (value: T) => string;
  onToggle: (value: T) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  if (items.length === 0) return null;
  const q = query.trim().toLowerCase();
  const label = (value: T) => (format ? format(value) : String(value));
  const sorted = [...items].sort((a, b) => {
    const sa = selected(a.value) ? 0 : 1;
    const sb = selected(b.value) ? 0 : 1;
    return sa - sb || b.count - a.count;
  });
  const visible = q ? sorted.filter((item) => label(item.value).toLowerCase().includes(q)) : sorted;
  return (
    <section className="graph-filter-section">
      <h4>{title}</h4>
      {items.length > 8 ? (
        <label className="graph-facet-search">
          <Search size={11} aria-hidden />
          <input
            type="search"
            value={query}
            placeholder={t("graph.filter.groupSearch")}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      ) : null}
      <div className="graph-chip-row">
        {visible.map(({ value, count }) => (
          <button
            key={String(value)}
            type="button"
            className={selected(value) ? "graph-chip active" : "graph-chip"}
            aria-pressed={selected(value)}
            onClick={() => onToggle(value)}
          >
            {swatch ? <span className="graph-swatch" style={{ background: swatch(value) }} /> : null}
            {label(value)}
            <span className="graph-chip-count" aria-hidden>{count}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

interface GraphFilterPanelProps {
  filters: GraphFilters;
  domains: FacetItem<string>[];
  types: FacetItem<string>[];
  relations: FacetItem<string>[];
  communities: FacetItem<number>[];
  enriched: boolean;
  maxVisibleNeighbors: number;
  pausedFilters: string[];
  onRemovePaused: (descriptor: string) => void;
  display: GraphDisplaySettings;
  onDisplayChange: (next: GraphDisplaySettings) => void;
  onFiltersChange: (next: GraphFilters) => void;
}

export function GraphFilterPanel({
  filters,
  domains,
  types,
  relations,
  communities,
  enriched,
  maxVisibleNeighbors,
  pausedFilters,
  onRemovePaused,
  display,
  onDisplayChange,
  onFiltersChange,
}: GraphFilterPanelProps) {
  const { t } = useTranslation();
  const dirty = !filtersAreDefault(filters);
  // Draft lets the field go transiently blank while retyping; Number("") is 0
  // and would otherwise commit minVisibleNeighbors 0 on clear. Blur restores the value.
  const [degreeDraft, setDegreeDraft] = useState<string | null>(null);

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
        <h4>{t("graph.filter.data")}</h4>
        <label className="graph-toggle">
          <input
            type="checkbox"
            checked={filters.showGenerated}
            data-testid="graph-show-noise"
            onChange={(event) => onFiltersChange({ ...filters, showGenerated: event.target.checked })}
          />
          {t("graph.filter.showNoise")}
        </label>
        <label className="graph-toggle">
          <input
            type="checkbox"
            checked={filters.showUnresolved}
            onChange={(event) => onFiltersChange({ ...filters, showUnresolved: event.target.checked })}
          />
          {t("graph.filter.showGhosts")}
        </label>
        <h4 className="graph-filter-subhead">
          {t("graph.filter.minDegree")}
          <input
            type="number"
            className="graph-degree-input"
            min={0}
            value={degreeDraft ?? String(filters.minVisibleNeighbors)}
            data-testid="graph-min-degree-input"
            onChange={(event) => {
              const raw = event.target.value;
              setDegreeDraft(raw);
              if (raw.trim() === "") return;
              const parsed = Math.floor(Number(raw));
              if (!Number.isFinite(parsed)) return;
              onFiltersChange({ ...filters, minVisibleNeighbors: Math.max(0, parsed) });
            }}
            onBlur={() => setDegreeDraft(null)}
          />
        </h4>
        <input
          type="range"
          min={0}
          max={Math.max(maxVisibleNeighbors, filters.minVisibleNeighbors, 1)}
          value={filters.minVisibleNeighbors}
          onChange={(event) => onFiltersChange({ ...filters, minVisibleNeighbors: Number(event.target.value) })}
        />
      </section>

      <FacetGroup
        title={t("graph.filter.domain")}
        items={domains}
        selected={(value) => filters.domains.has(value)}
        swatch={(value) => domainColor(value)}
        onToggle={(value) => onFiltersChange({ ...filters, domains: toggle(filters.domains, value) })}
      />
      <FacetGroup
        title={t("graph.filter.type")}
        items={types}
        selected={(value) => filters.types.has(value)}
        onToggle={(value) => onFiltersChange({ ...filters, types: toggle(filters.types, value) })}
      />
      <FacetGroup
        title={t("graph.filter.relation")}
        items={relations}
        selected={(value) => filters.relations.has(value)}
        swatch={(value) => relationColor(value)}
        onToggle={(value) => onFiltersChange({ ...filters, relations: toggle(filters.relations, value) })}
      />
      {enriched ? (
        <FacetGroup
          title={t("graph.filter.community")}
          items={communities}
          selected={(value) => filters.community === value}
          swatch={(value) => communityColor(value)}
          format={(value) => `#${value}`}
          onToggle={(value) =>
            onFiltersChange({ ...filters, community: filters.community === value ? null : value })
          }
        />
      ) : null}

      {pausedFilters.length > 0 ? (
        <section className="graph-filter-section">
          <h4>{t("graph.filter.paused")}</h4>
          <div className="graph-chip-row">
            {pausedFilters.map((descriptor) => (
              <button
                key={descriptor}
                type="button"
                className="graph-chip paused"
                title={t("graph.filter.pausedHint")}
                onClick={() => onRemovePaused(descriptor)}
              >
                {descriptor}
                <X size={10} aria-hidden />
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section className="graph-filter-section">
        <h4>{t("graph.display.title")}</h4>
        <label className="graph-display-field">
          <span>{t("graph.display.arrows")}</span>
          <select
            value={display.arrows}
            data-testid="graph-display-arrows"
            onChange={(event) =>
              onDisplayChange({ ...display, arrows: event.target.value as GraphDisplaySettings["arrows"] })
            }
          >
            <option value="typed">{t("graph.display.arrows.typed")}</option>
            <option value="all">{t("graph.display.arrows.all")}</option>
            <option value="none">{t("graph.display.arrows.none")}</option>
          </select>
        </label>
        <label className="graph-display-field">
          <span>{t("graph.display.labels")}</span>
          <select
            value={display.labels}
            data-testid="graph-display-labels"
            onChange={(event) =>
              onDisplayChange({ ...display, labels: event.target.value as GraphDisplaySettings["labels"] })
            }
          >
            <option value="low">{t("graph.display.labels.low")}</option>
            <option value="balanced">{t("graph.display.labels.balanced")}</option>
            <option value="high">{t("graph.display.labels.high")}</option>
          </select>
        </label>
        <label className="graph-display-field">
          <span>{t("graph.display.nodeScale")}</span>
          <input
            type="range"
            min={GRAPH_SCALE_MIN}
            max={GRAPH_SCALE_MAX}
            step={0.1}
            value={display.nodeScale}
            data-testid="graph-display-node-scale"
            onChange={(event) => onDisplayChange({ ...display, nodeScale: Number(event.target.value) })}
          />
        </label>
        <label className="graph-display-field">
          <span>{t("graph.display.edgeScale")}</span>
          <input
            type="range"
            min={GRAPH_SCALE_MIN}
            max={GRAPH_SCALE_MAX}
            step={0.1}
            value={display.edgeScale}
            data-testid="graph-display-edge-scale"
            onChange={(event) => onDisplayChange({ ...display, edgeScale: Number(event.target.value) })}
          />
        </label>
      </section>
    </aside>
  );
}
