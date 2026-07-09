// Graph mode toolbar — search, view switch (graph / chains), zoom cluster,
// re-layout, overlay refresh, and the enriched/stats readout. Controls follow
// the app's segmented-control (.cal-view-toggle) and search-with-icon
// (.cal-search) conventions.

import { ListFilter, Maximize2, Minus, Plus, RefreshCw, RotateCcw, Search } from "lucide-react";
import { useTranslation } from "../../lib/i18n";

export type GraphViewKind = "graph" | "chains";

interface GraphToolbarProps {
  search: string;
  onSearchChange: (next: string) => void;
  searchInputRef?: React.Ref<HTMLInputElement>;
  searchAsFilter: boolean;
  onSearchAsFilterChange: (next: boolean) => void;
  view: GraphViewKind;
  onViewChange: (next: GraphViewKind) => void;
  zoomPercent: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onRelayout: () => void;
  onRefreshOverlay: () => void;
  refreshing: boolean;
  enriched: boolean;
  communityCount: number;
  nodeCount: number;
  edgeCount: number;
}

export function GraphToolbar({
  search,
  onSearchChange,
  searchInputRef,
  searchAsFilter,
  onSearchAsFilterChange,
  view,
  onViewChange,
  zoomPercent,
  onZoomIn,
  onZoomOut,
  onFit,
  onRelayout,
  onRefreshOverlay,
  refreshing,
  enriched,
  communityCount,
  nodeCount,
  edgeCount,
}: GraphToolbarProps) {
  const { t } = useTranslation();
  return (
    <div className="graph-toolbar" data-testid="graph-toolbar">
      <label className="graph-search-field">
        <Search size={14} aria-hidden />
        <input
          ref={searchInputRef}
          type="search"
          placeholder={t("graph.searchPlaceholder")}
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          data-testid="graph-search"
        />
      </label>

      <button
        type="button"
        className={searchAsFilter ? "graph-icon-button active" : "graph-icon-button"}
        aria-pressed={searchAsFilter}
        title={t("graph.search.filterToggle")}
        data-testid="graph-search-filter-toggle"
        onClick={() => onSearchAsFilterChange(!searchAsFilter)}
      >
        <ListFilter size={14} />
      </button>

      <div className="graph-view-toggle" role="tablist" aria-label={t("graph.view.label")}>
        <button
          type="button"
          role="tab"
          aria-selected={view === "graph"}
          className={view === "graph" ? "active" : ""}
          data-testid="graph-view-graph"
          onClick={() => onViewChange("graph")}
        >
          {t("graph.view.graph")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "chains"}
          className={view === "chains" ? "active" : ""}
          data-testid="graph-chain-toggle"
          onClick={() => onViewChange("chains")}
        >
          {t("graph.view.chains")}
        </button>
      </div>

      {view === "graph" ? (
        <div className="graph-zoom-cluster">
          <button type="button" className="graph-icon-button" title={t("graph.zoom.out")} onClick={onZoomOut}>
            <Minus size={14} />
          </button>
          <span className="graph-zoom-value" data-testid="graph-zoom-value">
            {Math.round(zoomPercent)}%
          </span>
          <button type="button" className="graph-icon-button" title={t("graph.zoom.in")} onClick={onZoomIn}>
            <Plus size={14} />
          </button>
          <button type="button" className="graph-icon-button" title={t("graph.zoom.fit")} onClick={onFit}>
            <Maximize2 size={14} />
          </button>
          <button type="button" className="graph-icon-button" title={t("graph.relayout")} onClick={onRelayout}>
            <RotateCcw size={14} />
          </button>
        </div>
      ) : null}

      <div className="graph-toolbar-spacer" />

      <button
        type="button"
        className="graph-icon-button"
        title={t("graph.overlay.refresh")}
        onClick={onRefreshOverlay}
        disabled={refreshing}
        data-testid="graph-refresh-overlay"
      >
        <RefreshCw size={14} className={refreshing ? "spin" : ""} />
      </button>

      {enriched ? (
        <span className="graph-badge" data-testid="graph-enriched-badge">
          {communityCount} {t("graph.badge.communities")}
        </span>
      ) : null}
      <span className="graph-stats" data-testid="graph-stats">
        {nodeCount} · {edgeCount}
      </span>
    </div>
  );
}
