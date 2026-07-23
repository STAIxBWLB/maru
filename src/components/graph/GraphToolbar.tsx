import {
  Bookmark,
  ChevronDown,
  FileDown,
  ImageDown,
  ListFilter,
  Maximize2,
  Minus,
  MoreHorizontal,
  PanelRight,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "../../lib/i18n";
import type { GraphMode, GraphSavedView, GraphSource } from "../../lib/settings";
import type { GraphSearchResult } from "../../lib/graph/search";

interface GraphSearchBoxProps {
  search: string;
  onSearchChange: (next: string) => void;
  inputRef?: React.Ref<HTMLInputElement>;
  results: GraphSearchResult[];
  onSelect: (id: string) => void;
  onActiveChange: (id: string | null) => void;
}

function GraphSearchBox({
  search,
  onSearchChange,
  inputRef,
  results,
  onSelect,
  onActiveChange,
}: GraphSearchBoxProps) {
  const { t } = useTranslation();
  const [active, setActive] = useState(0);
  const activeId = results[Math.min(active, results.length - 1)]?.id ?? null;

  useEffect(() => {
    setActive(0);
  }, [search]);
  useEffect(() => {
    onActiveChange(activeId);
  }, [activeId, onActiveChange]);

  const select = (id: string) => {
    onSelect(id);
    onActiveChange(null);
  };

  return (
    <label className="graph-search-field">
      <Search size={15} aria-hidden />
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-expanded={results.length > 0}
        aria-controls="graph-search-listbox"
        aria-activedescendant={activeId ? `graph-search-option-${activeId}` : undefined}
        aria-autocomplete="list"
        aria-label={t("graph.searchPlaceholder")}
        placeholder={t("graph.searchPlaceholder")}
        value={search}
        data-testid="graph-search"
        onChange={(event) => onSearchChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            if (results.length === 0) return;
            event.preventDefault();
            setActive((current) => {
              const delta = event.key === "ArrowDown" ? 1 : -1;
              return (current + delta + results.length) % results.length;
            });
          } else if (event.key === "Enter" && activeId) {
            event.preventDefault();
            select(activeId);
          }
        }}
      />
      {search ? (
        <button
          type="button"
          className="graph-search-clear"
          aria-label={t("graph.search.clear")}
          title={t("graph.search.clear")}
          onClick={() => onSearchChange("")}
        >
          <X size={14} />
        </button>
      ) : null}
      {results.length > 0 ? (
        <ul
          className="graph-search-results"
          role="listbox"
          id="graph-search-listbox"
          data-testid="graph-search-results"
        >
          {results.slice(0, 8).map((result, index) => (
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
              {result.relPath ? (
                <span className="graph-search-result-path">{result.relPath}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </label>
  );
}

interface GraphToolbarProps {
  mode: GraphMode;
  onModeChange: (mode: GraphMode) => void;
  source: GraphSource;
  onSourceChange: (next: GraphSource) => void;
  search: string;
  onSearchChange: (next: string) => void;
  searchOpen: boolean;
  onSearchOpenChange: (open: boolean) => void;
  searchInputRef?: React.Ref<HTMLInputElement>;
  searchResults: GraphSearchResult[];
  onSearchSelect: (id: string) => void;
  onSearchActiveChange: (id: string | null) => void;
  searchAsFilter: boolean;
  onSearchAsFilterChange: (next: boolean) => void;
  visibleCount: number;
  totalCount: number;
  filtersOpen: boolean;
  activeFilterCount: number;
  onToggleFilters: () => void;
  workbenchOpen: boolean;
  onToggleWorkbench: () => void;
  onRefreshOverlay: () => void;
  onExportPng: () => void;
  onExportSvg: () => void;
  onRelayout: () => void;
  refreshing: boolean;
  savedViews: GraphSavedView[];
  onSaveView: (name: string) => void;
  onApplyView: (view: GraphSavedView) => void;
  onDeleteView: (id: string) => void;
}

export function GraphToolbar({
  mode,
  onModeChange,
  source,
  onSourceChange,
  search,
  onSearchChange,
  searchOpen,
  onSearchOpenChange,
  searchInputRef,
  searchResults,
  onSearchSelect,
  onSearchActiveChange,
  searchAsFilter,
  onSearchAsFilterChange,
  visibleCount,
  totalCount,
  filtersOpen,
  activeFilterCount,
  onToggleFilters,
  workbenchOpen,
  onToggleWorkbench,
  onRefreshOverlay,
  onExportPng,
  onExportSvg,
  onRelayout,
  refreshing,
  savedViews,
  onSaveView,
  onApplyView,
  onDeleteView,
}: GraphToolbarProps) {
  const { t } = useTranslation();
  const [viewOpen, setViewOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [savedName, setSavedName] = useState("");
  const viewRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!viewOpen && !moreOpen) return;
    const close = (event: Event) => {
      if (event.target instanceof Node) {
        if (viewRef.current?.contains(event.target) || moreRef.current?.contains(event.target)) {
          return;
        }
      }
      setViewOpen(false);
      setMoreOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setViewOpen(false);
      setMoreOpen(false);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [moreOpen, viewOpen]);

  const saveCurrentView = () => {
    const value = savedName.trim();
    if (!value) return;
    onSaveView(value);
    setSavedName("");
  };

  const modeLabel =
    mode === "local"
      ? t("graph.view.local")
      : mode === "chains"
        ? t("graph.view.chains")
        : t("graph.view.graph");

  return (
    <div className="graph-toolbar" data-testid="graph-toolbar">
      <div className="graph-view-menu" ref={viewRef}>
        <button
          type="button"
          className="graph-view-pill"
          aria-haspopup="menu"
          aria-expanded={viewOpen}
          data-testid="graph-view-menu"
          onClick={() => setViewOpen((open) => !open)}
        >
          <span>{source === "vault" ? t("graph.source.vault") : t("graph.source.workspace")}</span>
          <span className="graph-view-pill-divider">·</span>
          <strong>{modeLabel}</strong>
          <span className="graph-view-pill-count">{visibleCount}/{totalCount}</span>
          <ChevronDown size={13} aria-hidden />
        </button>
        {viewOpen ? (
          <div className="graph-view-popover" role="menu">
            <div className="graph-menu-label">{t("graph.view.label")}</div>
            {(["global", "local", "chains"] as GraphMode[]).map((value) => (
              <button
                key={value}
                type="button"
                role="menuitemradio"
                aria-checked={mode === value}
                className={mode === value ? "active" : ""}
                data-testid={
                  value === "global"
                    ? "graph-view-graph"
                    : value === "local"
                      ? "graph-view-local"
                      : "graph-chain-toggle"
                }
                onClick={() => {
                  onModeChange(value);
                  setViewOpen(false);
                }}
              >
                {value === "global"
                  ? t("graph.view.graph")
                  : value === "local"
                    ? t("graph.view.local")
                    : t("graph.view.chains")}
              </button>
            ))}
            <div className="graph-menu-separator" />
            <div className="graph-menu-label">{t("graph.source.label")}</div>
            {(["vault", "workspace"] as GraphSource[]).map((value) => (
              <button
                key={value}
                type="button"
                role="menuitemradio"
                aria-checked={source === value}
                className={source === value ? "active" : ""}
                onClick={() => {
                  onSourceChange(value);
                  setViewOpen(false);
                }}
              >
                {value === "vault" ? t("graph.source.vault") : t("graph.source.workspace")}
              </button>
            ))}
            <div className="graph-menu-separator" />
            <div className="graph-menu-label graph-saved-heading">
              <Bookmark size={12} aria-hidden />
              {t("graph.saved.title")}
            </div>
            <div className="graph-saved-create">
              <input
                value={savedName}
                placeholder={t("graph.saved.name")}
                aria-label={t("graph.saved.name")}
                onChange={(event) => setSavedName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") saveCurrentView();
                }}
              />
              <button
                type="button"
                disabled={!savedName.trim()}
                title={t("graph.saved.save")}
                onClick={saveCurrentView}
              >
                <Save size={13} />
              </button>
            </div>
            {savedViews.length === 0 ? (
              <div className="graph-saved-empty">{t("graph.saved.empty")}</div>
            ) : (
              <div className="graph-saved-list">
                {savedViews.map((view) => (
                  <div key={view.id} className="graph-saved-row">
                    <button
                      type="button"
                      className="graph-saved-apply"
                      onClick={() => {
                        onApplyView(view);
                        setViewOpen(false);
                      }}
                    >
                      <span>{view.name}</span>
                      <small>
                        {t(
                          view.source === "workspace"
                            ? "graph.source.workspace"
                            : "graph.source.vault",
                        )}
                        {" · "}
                        {t(
                          view.mode === "local"
                            ? "graph.view.local"
                            : view.mode === "chains"
                              ? "graph.view.chains"
                              : "graph.view.graph",
                        )}
                      </small>
                    </button>
                    <button
                      type="button"
                      className="graph-saved-delete"
                      aria-label={t("graph.saved.delete")}
                      title={t("graph.saved.delete")}
                      onClick={() => onDeleteView(view.id)}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </div>

      <div className="graph-toolbar-actions">
        <button
          type="button"
          className={searchOpen ? "graph-icon-button active" : "graph-icon-button"}
          aria-expanded={searchOpen}
          title={t("graph.searchPlaceholder")}
          data-testid="graph-search-toggle"
          onClick={() => onSearchOpenChange(!searchOpen)}
        >
          <Search size={15} />
        </button>
        <button
          type="button"
          className={filtersOpen ? "graph-icon-button active" : "graph-icon-button"}
          aria-pressed={filtersOpen}
          title={
            activeFilterCount > 0
              ? t("graph.filter.activeCount", { count: activeFilterCount })
              : t("graph.panels.filters")
          }
          data-testid="graph-toggle-filters"
          onClick={onToggleFilters}
        >
          <ListFilter size={15} />
          {activeFilterCount > 0 ? (
            <span className="graph-icon-count">{activeFilterCount}</span>
          ) : null}
        </button>
        <button
          type="button"
          className={workbenchOpen ? "graph-icon-button active" : "graph-icon-button"}
          aria-pressed={workbenchOpen}
          title={t("graph.tab.insights")}
          data-testid="graph-toggle-workbench"
          onClick={onToggleWorkbench}
        >
          <PanelRight size={15} />
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
            <MoreHorizontal size={15} />
          </button>
          {moreOpen ? (
            <div className="graph-more-menu" role="menu">
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={searchAsFilter}
                data-testid="graph-search-filter-toggle"
                onClick={() => onSearchAsFilterChange(!searchAsFilter)}
              >
                <ListFilter size={13} /> {t("graph.search.filterToggle")}
              </button>
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
                <RefreshCw size={13} className={refreshing ? "spin" : ""} />
                {t("graph.overlay.refresh")}
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

      {searchOpen ? (
        <div className="graph-search-popover">
          <GraphSearchBox
            search={search}
            onSearchChange={onSearchChange}
            inputRef={searchInputRef}
            results={searchResults}
            onSelect={onSearchSelect}
            onActiveChange={onSearchActiveChange}
          />
        </div>
      ) : null}
    </div>
  );
}

export function GraphZoomCluster({
  onZoomIn,
  onZoomOut,
  onFit,
}: {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="graph-zoom-cluster graph-zoom-floating" data-testid="graph-zoom-cluster">
      <button
        type="button"
        className="graph-icon-button"
        title={t("graph.zoom.out")}
        onClick={onZoomOut}
      >
        <Minus size={14} />
      </button>
      <button
        type="button"
        className="graph-icon-button"
        title={t("graph.zoom.fit")}
        onClick={onFit}
      >
        <Maximize2 size={14} />
      </button>
      <button
        type="button"
        className="graph-icon-button"
        title={t("graph.zoom.in")}
        onClick={onZoomIn}
      >
        <Plus size={14} />
      </button>
    </div>
  );
}
