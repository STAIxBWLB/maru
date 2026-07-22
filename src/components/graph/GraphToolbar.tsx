// Graph mode toolbar (V5): mode segmented control (Global / Local / Chains),
// source select, search combobox over the current filtered graph, and (right)
// visible/total counts, Filters + Workbench toggles, and a More menu (refresh
// overlay, export, re-layout). The zoom cluster moved out of the toolbar into
// a floating cluster (GraphZoomCluster) rendered inside the canvas wrap.

import {
  FileDown,
  ImageDown,
  ListFilter,
  Maximize2,
  Minus,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "../../lib/i18n";
import type { GraphMode, GraphSource } from "../../lib/settings";
import type { GraphSearchResult } from "../../lib/graph/search";

interface GraphSearchBoxProps {
  search: string;
  onSearchChange: (next: string) => void;
  inputRef?: React.Ref<HTMLInputElement>;
  results: GraphSearchResult[];
  onSelect: (id: string) => void;
  onActiveChange: (id: string | null) => void;
}

/** Search combobox: exact → prefix → substring → relPath results (ranked by
 *  the caller), arrow-key navigation, Enter selects, Escape closes the list
 *  then clears the query. */
function GraphSearchBox({
  search,
  onSearchChange,
  inputRef,
  results,
  onSelect,
  onActiveChange,
}: GraphSearchBoxProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLLabelElement>(null);
  const activeId = open && results.length > 0 ? results[Math.min(active, results.length - 1)]?.id ?? null : null;

  useEffect(() => {
    setActive(0);
  }, [search]);
  useEffect(() => {
    onActiveChange(activeId);
  }, [activeId, onActiveChange]);

  const select = (id: string) => {
    onSelect(id);
    setOpen(false);
  };

  return (
    <label className="graph-search-field" ref={rootRef}>
      <Search size={14} aria-hidden />
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-expanded={open && results.length > 0}
        aria-controls="graph-search-listbox"
        aria-activedescendant={activeId ? `graph-search-option-${activeId}` : undefined}
        aria-autocomplete="list"
        placeholder={t("graph.searchPlaceholder")}
        value={search}
        data-testid="graph-search"
        onChange={(event) => {
          onSearchChange(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // Delay so an option click (mousedown → click) lands before close.
          setTimeout(() => setOpen(false), 120);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            if (results.length === 0) return;
            event.preventDefault();
            setOpen(true);
            setActive((current) => {
              const delta = event.key === "ArrowDown" ? 1 : -1;
              return (current + delta + results.length) % results.length;
            });
          } else if (event.key === "Enter") {
            if (activeId) {
              event.preventDefault();
              select(activeId);
            }
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (open) setOpen(false);
            else onSearchChange("");
          }
        }}
      />
      {open && results.length > 0 ? (
        <ul className="graph-search-results" role="listbox" id="graph-search-listbox" data-testid="graph-search-results">
          {results.map((result, index) => (
            <li
              key={result.id}
              id={`graph-search-option-${result.id}`}
              role="option"
              aria-selected={index === active}
              className={index === active ? "graph-search-result active" : "graph-search-result"}
              onMouseEnter={() => setActive(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                select(result.id);
              }}
            >
              <span className="graph-search-result-label">{result.label}</span>
              {result.relPath ? <span className="graph-search-result-path">{result.relPath}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </label>
  );
}

interface GraphToolbarProps {
  mode: GraphMode;
  /** True when a local focus anchor exists (Local stays selectable). */
  localAvailable: boolean;
  onModeChange: (mode: GraphMode) => void;
  source: GraphSource;
  onSourceChange: (next: GraphSource) => void;
  search: string;
  onSearchChange: (next: string) => void;
  searchInputRef?: React.Ref<HTMLInputElement>;
  searchResults: GraphSearchResult[];
  onSearchSelect: (id: string) => void;
  onSearchActiveChange: (id: string | null) => void;
  searchAsFilter: boolean;
  onSearchAsFilterChange: (next: boolean) => void;
  visibleCount: number;
  totalCount: number;
  enriched: boolean;
  communityCount: number;
  filtersOpen: boolean;
  onToggleFilters: () => void;
  workbenchOpen: boolean;
  onToggleWorkbench: () => void;
  onRefreshOverlay: () => void;
  onExportPng: () => void;
  onExportSvg: () => void;
  onRelayout: () => void;
  refreshing: boolean;
}

export function GraphToolbar({
  mode,
  localAvailable,
  onModeChange,
  source,
  onSourceChange,
  search,
  onSearchChange,
  searchInputRef,
  searchResults,
  onSearchSelect,
  onSearchActiveChange,
  searchAsFilter,
  onSearchAsFilterChange,
  visibleCount,
  totalCount,
  enriched,
  communityCount,
  filtersOpen,
  onToggleFilters,
  workbenchOpen,
  onToggleWorkbench,
  onRefreshOverlay,
  onExportPng,
  onExportSvg,
  onRelayout,
  refreshing,
}: GraphToolbarProps) {
  const { t } = useTranslation();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!moreOpen) return;
    const close = (event: Event) => {
      if (moreRef.current && event.target instanceof Node && moreRef.current.contains(event.target)) return;
      setMoreOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMoreOpen(false);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);

  const modeButton = (value: GraphMode, label: string, testid: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={mode === value}
      className={mode === value ? "active" : ""}
      data-testid={testid}
      onClick={() => onModeChange(value)}
    >
      {label}
    </button>
  );

  return (
    <div className="graph-toolbar" data-testid="graph-toolbar">
      <div className="graph-view-toggle" role="tablist" aria-label={t("graph.view.label")}>
        {modeButton("global", t("graph.view.graph"), "graph-view-graph")}
        {modeButton("local", t("graph.view.local"), "graph-view-local")}
        {modeButton("chains", t("graph.view.chains"), "graph-chain-toggle")}
      </div>
      <select
        className="graph-source-select"
        aria-label={t("graph.source.label")}
        value={source}
        onChange={(event) => onSourceChange(event.target.value as GraphSource)}
      >
        <option value="vault">{t("graph.source.vault")}</option>
        <option value="workspace">{t("graph.source.workspace")}</option>
      </select>

      <GraphSearchBox
        search={search}
        onSearchChange={onSearchChange}
        inputRef={searchInputRef}
        results={searchResults}
        onSelect={onSearchSelect}
        onActiveChange={onSearchActiveChange}
      />

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

      <div className="graph-toolbar-spacer" />

      {enriched ? (
        <span className="graph-badge" data-testid="graph-enriched-badge">
          {communityCount} {t("graph.badge.communities")}
        </span>
      ) : null}
      <span className="graph-stats" data-testid="graph-stats" title={t("graph.stats.title")}>
        {visibleCount} / {totalCount}
      </span>

      <button
        type="button"
        className={filtersOpen ? "graph-icon-button active" : "graph-icon-button"}
        aria-pressed={filtersOpen}
        title={t("graph.panels.filters")}
        data-testid="graph-toggle-filters"
        onClick={onToggleFilters}
      >
        <PanelLeft size={14} />
      </button>
      <button
        type="button"
        className={workbenchOpen ? "graph-icon-button active" : "graph-icon-button"}
        aria-pressed={workbenchOpen}
        title={t("graph.panels.workbench")}
        data-testid="graph-toggle-workbench"
        onClick={onToggleWorkbench}
      >
        <PanelRight size={14} />
      </button>

      <div className="graph-more" ref={moreRef}>
        <button
          type="button"
          className={moreOpen ? "graph-icon-button active" : "graph-icon-button"}
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          title={t("graph.more")}
          data-testid="graph-more-menu"
          onClick={() => setMoreOpen((open) => !open)}
        >
          <MoreHorizontal size={14} />
        </button>
        {moreOpen ? (
          <div className="graph-more-menu" role="menu">
            <button
              type="button"
              role="menuitem"
              data-testid="graph-refresh-overlay"
              disabled={refreshing}
              onClick={() => {
                setMoreOpen(false);
                onRefreshOverlay();
              }}
            >
              <RefreshCw size={13} className={refreshing ? "spin" : ""} /> {t("graph.overlay.refresh")}
            </button>
            <button
              type="button"
              role="menuitem"
              data-testid="graph-export-png"
              onClick={() => {
                setMoreOpen(false);
                onExportPng();
              }}
            >
              <ImageDown size={13} /> {t("graph.export.png")}
            </button>
            <button
              type="button"
              role="menuitem"
              data-testid="graph-export-svg"
              onClick={() => {
                setMoreOpen(false);
                onExportSvg();
              }}
            >
              <FileDown size={13} /> {t("graph.export.svg")}
            </button>
            <button
              type="button"
              role="menuitem"
              data-testid="graph-relayout"
              onClick={() => {
                setMoreOpen(false);
                onRelayout();
              }}
            >
              <RotateCcw size={13} /> {t("graph.relayout")}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Floating zoom cluster — rendered inside .graph-canvas-wrap (bottom-right,
 *  above the legend), not in the toolbar. */
export function GraphZoomCluster({
  zoomPercent,
  onZoomIn,
  onZoomOut,
  onFit,
  onRelayout,
}: {
  zoomPercent: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onRelayout: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="graph-zoom-cluster graph-zoom-floating" data-testid="graph-zoom-cluster">
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
  );
}
