// Graph app mode (maru-vault-graph-spec §F2). Owns: model build (live layer),
// enrichment overlay (vault_graph_read → community), filters/search/selection/
// path/insights state, adaptive panel tiers, and a single reused layout worker.
// GraphCanvas renders; layout.worker.ts computes positions (warm-started +
// disk-cached).

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { Pin, PinOff, X } from "lucide-react";
import {
  chooseSaveFile,
  isTauri,
  vaultGraphLayoutRead,
  vaultGraphLayoutSave,
  vaultGraphRead,
} from "../../lib/api";
import { diagramExportBlobToPath } from "../../lib/diagram";
import "./graph.css";
import {
  blobToUint8Array,
  downloadGraphBlob,
} from "../../lib/graph/export";
import {
  buildVaultGraph,
  enrichGraph,
  type GraphModel,
  type GraphNode,
} from "../../lib/graph/model";
import { applyGraphSearch, deriveGraphView } from "../../lib/graph/derive";
import { isFinitePositions, sanitizePositions } from "../../lib/graph/positions";
import { shortestPath } from "../../lib/graph/insights";
import { rankGraphSearch } from "../../lib/graph/search";
import {
  graphLocalTargetForNode,
  graphNodeMatchesLocalTarget,
} from "../../lib/graph/target";
import { refreshGraphTheme } from "./graphStyle";
import { useTranslation } from "../../lib/i18n";
import {
  isInEditable,
  matchesShortcut,
  useScopedKeyboardShortcuts,
} from "../../lib/diagram/shortcuts";
import { useContextMenuKeyboard } from "../../lib/useContextMenuKeyboard";
import {
  defaultGraphFilterProfile,
  GRAPH_PANEL_WIDTH_MAX,
  GRAPH_PANEL_WIDTH_MIN,
  type FavoriteKind,
  type GraphDisplaySettings,
  type GraphMode,
  type GraphOpenTarget,
  type GraphLocalTarget,
  type GraphSavedView,
  type GraphPanelSettings,
  type GraphSettingsV3,
  type GraphSource,
} from "../../lib/settings";
import type { FavoriteTarget } from "../FavoritesSection";
import type { VaultEntry } from "../../lib/types";
import { buildEntryIndex } from "../../lib/wikilinkSuggestions";
import { DecisionChainLanes } from "./DecisionChainLanes";
import {
  GraphCanvas,
  type GraphExportController,
  type GraphHighlight,
  type GraphRendererState,
} from "./GraphCanvas";
import {
  filtersFromSettings,
  filtersToSettings,
  GraphFilterPanel,
  type GraphFilters,
} from "./GraphFilterPanel";
import { GraphInspector } from "./GraphInspector";
import { GraphInsightsPanel } from "./GraphInsightsPanel";
import { GraphLegend } from "./GraphLegend";
import { GraphRelationReviewDialog } from "./GraphRelationReviewDialog";
import { GraphToolbar, GraphZoomCluster } from "./GraphToolbar";

interface GraphViewProps {
  workspacePath: string | null;
  overlayPath?: string | null;
  entries: VaultEntry[];
  focusTarget: GraphOpenTarget | null;
  onFocusTargetChange: (target: GraphOpenTarget | null) => void;
  onOpenEntry: (entry: VaultEntry) => void;
  onCreateNote: (target: string) => void;
  graphSettings: GraphSettingsV3;
  onGraphSettingsChange: (next: GraphSettingsV3) => void;
  isFavorite: (kind: FavoriteKind, relPath: string) => boolean;
  onToggleFavorite: (target: FavoriteTarget) => void;
  onError: (message: string) => void;
  onGraphChanged?: () => void;
}

const SAVE_DEBOUNCE_MS = 1500;
const MISSING_LOCAL_FOCUS_ID = "__maru_missing_local_focus__";

export function GraphView({
  workspacePath,
  overlayPath,
  entries,
  focusTarget,
  onFocusTargetChange,
  onOpenEntry,
  onCreateNote,
  graphSettings,
  onGraphSettingsChange,
  isFavorite,
  onToggleFavorite,
  onError,
  onGraphChanged,
}: GraphViewProps) {
  const { t } = useTranslation();
  const source = graphSettings.source;
  const [localDepth, setLocalDepth] = useState<GraphSettingsV3["localDepth"]>(graphSettings.localDepth);
  const [localDirection, setLocalDirection] = useState<GraphSettingsV3["localDirection"]>(graphSettings.localDirection);
  // Seeded from persisted settings; changes are written back (skip-first) below.
  // Stored mode ("global" | "local" | "chains"); effective mode is "local"
  // whenever a focus node is set.
  const [mode, setMode] = useState<GraphMode>(graphSettings.mode);
  const [filters, setFilters] = useState<GraphFilters>(() =>
    filtersFromSettings(graphSettings.profiles[graphSettings.source]),
  );
  const [searchAsFilter, setSearchAsFilter] = useState(graphSettings.searchAsFilter);
  const [search, setSearch] = useState("");
  // Theme subscription lives here (not GraphCanvas) so GraphLegend/GraphFilterPanel/
  // GraphInspector — which read the module-level theme cache at render time — also
  // re-render on a theme flip instead of showing a stale palette.
  const [themeEpoch, setThemeEpoch] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Prime the theme cache before GraphCanvas's first build (layout effects run
  // before child passive effects), so mount needs no epoch bump — bumping on
  // mount rebuilt Sigma twice and restarted layout from scratch.
  const themeReadyRef = useRef(false);
  useLayoutEffect(() => {
    refreshGraphTheme(rootRef.current);
  }, []);
  // The root carries tabIndex=-1 so any click inside (canvas included) grants
  // it focus for the focus-scoped shortcuts. On mount, take focus unless the
  // user is typing elsewhere, so ⌘F works in full graph mode without a click.
  useEffect(() => {
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      (isInEditable(active) || active.closest(".terminal-panel"))
    ) {
      return;
    }
    rootRef.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const apply = () => {
      refreshGraphTheme(rootRef.current);
      if (themeReadyRef.current) setThemeEpoch((epoch) => epoch + 1);
      themeReadyRef.current = true;
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", apply);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", apply);
    };
  }, [graphSettings.display.theme, graphSettings.display.accent]);
  const exportControllerRef = useRef<GraphExportController | null>(null);
  // Right-click node context menu (spec §F2 usability).
  const [menu, setMenu] = useState<{ x: number; y: number; node: GraphNode; index: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const handleMenuKeyDown = useContextMenuKeyboard(menuRef, !!menu, () => setMenu(null));

  // Persist view / filter / search-mode changes (skip the initial seed render).
  // The callback is held in a ref so App re-renders (which re-create it inline)
  // don't re-fire persistence — only real state changes do.
  const onGraphSettingsChangeRef = useRef(onGraphSettingsChange);
  onGraphSettingsChangeRef.current = onGraphSettingsChange;
  const graphSettingsRef = useRef(graphSettings);
  graphSettingsRef.current = graphSettings;
  // Filters are source-scoped. Keep the source that the current filter state
  // belongs to so a source prop change cannot persist the previous source's
  // profile into the newly selected source before the re-seed effect runs.
  const filtersSourceRef = useRef(source);
  const persistSkipRef = useRef(true);
  useEffect(() => {
    if (persistSkipRef.current) {
      persistSkipRef.current = false;
      return;
    }
    if (filtersSourceRef.current !== source) return;
    const current = graphSettingsRef.current;
    onGraphSettingsChangeRef.current({
      ...current,
      source,
      mode,
      localDepth,
      localDirection,
      searchAsFilter,
      // The UI has no pattern editor; pass the current settings value through.
      generatedPatterns: current.generatedPatterns,
      profiles: { ...current.profiles, [source]: filtersToSettings(filters) },
    });
  }, [source, localDepth, localDirection, mode, searchAsFilter, filters]);

  // Re-seed from external (cross-window) settings changes. Deps are only
  // [graphSettings], and each setState is gated on a real diff, so a local
  // edit's own persist round-trip (prop catches up to local) is a no-op — no
  // reset of the in-flight local change and no feedback loop.
  useEffect(() => {
    if (graphSettings.localDepth !== localDepth) setLocalDepth(graphSettings.localDepth);
    if (graphSettings.localDirection !== localDirection) setLocalDirection(graphSettings.localDirection);
    if (graphSettings.mode !== mode) setMode(graphSettings.mode);
    if (graphSettings.searchAsFilter !== searchAsFilter) setSearchAsFilter(graphSettings.searchAsFilter);
    const sourceChanged = filtersSourceRef.current !== graphSettings.source;
    const activeProfile = graphSettings.profiles[graphSettings.source];
    if (sourceChanged) {
      filtersSourceRef.current = graphSettings.source;
      setFilters(filtersFromSettings(activeProfile));
    } else if (
      graphSettings.source === source &&
      JSON.stringify(activeProfile) !== JSON.stringify(filtersToSettings(filters))
    ) {
      // Same-source external edit, for example another window changing this
      // workspace's graph profile.
      setFilters(filtersFromSettings(activeProfile));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphSettings]);
  const [enrichment, setEnrichment] = useState<{ model: GraphModel | null; hint: string | null }>({
    model: null,
    hint: null,
  });
  const [refreshing, setRefreshing] = useState(false);
  const [settled, setSettled] = useState<Float64Array | null>(null);
  const latestPositionsRef = useRef<Float64Array | null>(null);
  const latestPositionNodeIdsRef = useRef<string[] | null>(null);
  const settledNodesRef = useRef<GraphNode[] | null>(null);
  const [layoutEpoch, setLayoutEpoch] = useState(0);
  const [seedPositions, setSeedPositions] = useState<Record<string, [number, number]>>({});
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  const [layoutCacheReady, setLayoutCacheReady] = useState(() => !workspacePath);
  const [unpinSignal, setUnpinSignal] = useState<{ id: string; nonce: number } | null>(null);
  // --- separated interaction state (V5): selection / local focus / path ----
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [relationPair, setRelationPair] = useState<{ source: GraphNode; target: GraphNode } | null>(null);
  const [pathSourceId, setPathSourceId] = useState<string | null>(null);
  const [pathIds, setPathIds] = useState<string[]>([]);
  const [highlightPair, setHighlightPair] = useState<{ a: string; b: string } | null>(null);
  const [fitSignal, setFitSignal] = useState(0);
  const [zoomSignal, setZoomSignal] = useState<{ dir: 1 | -1; nonce: number } | null>(null);
  const [centerSignal, setCenterSignal] = useState<{ id: string; nonce: number } | null>(null);
  // Search combobox: active (arrow-key) result — emphasized on the canvas but
  // NOT a selection and NOT the local-focus anchor.
  const [activeSearchId, setActiveSearchId] = useState<string | null>(null);
  const handleSearchActiveChange = useCallback((id: string | null) => setActiveSearchId(id), []);
  // Local mode (k-hop) anchor — seeded from the prop (NeighborhoodPane
  // "그래프에서 보기") but can also be set locally from the inspector.
  const [localTarget, setLocalTarget] = useState<GraphLocalTarget | null>(() =>
    focusTarget?.source === source ? focusTarget.localTarget : null,
  );
  useEffect(() => {
    setLocalTarget(focusTarget?.source === source ? focusTarget.localTarget : null);
  }, [focusTarget, source]);
  // --- adaptive tiers + progressive Graph tools drawer ----------------------
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [tier, setTier] = useState<"wide" | "standard" | "compact">("wide");
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const width = el.clientWidth;
      const next = width >= 1280 ? "wide" : width >= 720 ? "standard" : "compact";
      setTier((prev) => (prev === next ? prev : next));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const panels = graphSettings.panels;
  const panelsRef = useRef(panels);
  panelsRef.current = panels;
  const display = graphSettings.display;
  const [toolsOpen, setToolsOpen] = useState(false);
  const [rightTab, setRightTab] = useState<"filters" | "insights" | "selected">("filters");
  const [searchOpen, setSearchOpen] = useState(false);
  const persistPanels = useCallback((next: GraphPanelSettings) => {
    onGraphSettingsChangeRef.current({ ...graphSettingsRef.current, panels: next });
  }, []);
  const persistDisplay = useCallback((next: GraphDisplaySettings) => {
    onGraphSettingsChangeRef.current({ ...graphSettingsRef.current, display: next });
  }, []);
  const toolsDocked = tier === "wide" && panels.pinned && toolsOpen;
  const filtersVisible = toolsOpen && rightTab === "filters";
  const workbenchVisible = toolsOpen && rightTab !== "filters";
  const toggleFiltersPanel = useCallback(() => {
    setRightTab("filters");
    setToolsOpen((open) => (open && rightTab === "filters" ? false : true));
  }, [rightTab]);
  const toggleWorkbenchPanel = useCallback(() => {
    setRightTab("insights");
    setToolsOpen((open) => (open && rightTab === "insights" ? false : true));
  }, [rightTab]);
  const clampPanelWidth = (value: number, min: number, max: number) =>
    Math.min(max, Math.max(min, Math.round(value)));
  const panelWidth = clampPanelWidth(
    panels.width,
    GRAPH_PANEL_WIDTH_MIN,
    GRAPH_PANEL_WIDTH_MAX,
  );
  const startPanelResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const handle = event.currentTarget;
      const pointerId = event.pointerId;
      handle.setPointerCapture(pointerId);
      const update = (clientX: number) => {
        const rect = bodyRef.current?.getBoundingClientRect();
        if (!rect) return;
        const current = panelsRef.current;
        persistPanels({
          ...current,
          width: clampPanelWidth(
            rect.right - clientX,
            GRAPH_PANEL_WIDTH_MIN,
            GRAPH_PANEL_WIDTH_MAX,
          ),
        });
      };
      update(event.clientX);
      const onMove = (move: PointerEvent) => {
        if (move.pointerId === pointerId) update(move.clientX);
      };
      const cleanup = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onEnd);
        handle.removeEventListener("pointercancel", onEnd);
        if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      };
      const onEnd = (up: PointerEvent) => {
        if (up.pointerId === pointerId) cleanup();
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onEnd);
      handle.addEventListener("pointercancel", onEnd);
    },
    [persistPanels],
  );
  const resizePanelByKey = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const direction = event.key === "ArrowRight" ? -1 : 1;
      const step = event.shiftKey ? 32 : 8;
      const current = panelsRef.current;
      persistPanels({
        ...current,
        width: clampPanelWidth(
          current.width + direction * step,
          GRAPH_PANEL_WIDTH_MIN,
          GRAPH_PANEL_WIDTH_MAX,
        ),
      });
    },
    [persistPanels],
  );

  // Renderer lifecycle (layout-running indicator + a11y announcements).
  const [rendererState, setRendererState] = useState<GraphRendererState>("loading");

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!searchOpen) return;
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [searchOpen]);

  const index = useMemo(() => buildEntryIndex(entries), [entries]);
  const liveModel = useMemo(() => buildVaultGraph(entries, index), [entries, index]);
  const overlayRequestRef = useRef(0);

  const loadOverlay = useCallback(
    (path: string, live: GraphModel) => {
      const request = ++overlayRequestRef.current;
      setRefreshing(true);
      vaultGraphRead(path, source)
        .then((file) => {
          if (request !== overlayRequestRef.current) return;
          if (file) setEnrichment({ model: enrichGraph(live, file), hint: null });
          else setEnrichment({ model: null, hint: t("graph.hint.noEnrichment") });
        })
        .catch((err: unknown) => {
          if (request === overlayRequestRef.current) {
            setEnrichment({ model: null, hint: String(err) });
          }
        })
        .finally(() => {
          if (request === overlayRequestRef.current) setRefreshing(false);
        });
    },
    [t, source],
  );

  useEffect(() => {
    overlayRequestRef.current += 1;
    setEnrichment({ model: null, hint: null });
    const root = overlayPath ?? workspacePath;
    if (root) loadOverlay(root, liveModel);
  }, [workspacePath, overlayPath, liveModel, loadOverlay]);

  const model = enrichment.model ?? liveModel;
  const localFocusNode = useMemo(
    () =>
      localTarget
        ? model.nodes.find((node) => graphNodeMatchesLocalTarget(node, localTarget)) ?? null
        : null,
    [model.nodes, localTarget],
  );
  const localFocus = localFocusNode?.id ?? null;
  const requestedFocusId = localTarget
    ? localFocus ?? MISSING_LOCAL_FOCUS_ID
    : null;
  // Focus hides siblings via reducer visibility, so re-center only when the
  // resolved canonical target changes. Missing targets remain explicit.
  const prevFocusRef = useRef<string | null>(null);
  useEffect(() => {
    if (localFocus && localFocus !== prevFocusRef.current) {
      setCenterSignal({ id: localFocus, nonce: Date.now() });
    }
    prevFocusRef.current = localFocus;
  }, [localFocus]);
  // "now" for stale-note detection — recomputed whenever the model changes
  // (i.e. on vault edits) so it doesn't stay frozen at mount time.
  const now = useMemo(() => Date.now(), [model]);

  // One pure derivation pipeline (facet → relation → local → prune → search),
  // split in two memos: the expensive analysis stage must keep a stable
  // identity while the user types (a per-keystroke analysisModel restarted the
  // insights worker with a full graph clone per character), and the transient
  // search stage narrows it cheaply.
  // Effective mode is "local" while a local-focus anchor is set, else the stored mode.
  const analysis = useMemo(
    () =>
      deriveGraphView({
        model,
        profile: filtersToSettings(filters),
        generatedPatterns: graphSettings.generatedPatterns,
        mode: localTarget ? "local" : mode,
        focusNodeId: requestedFocusId,
        localDepth,
        localDirection,
        search: "",
        searchAsFilter: false,
      }),
    [model, filters, graphSettings.generatedPatterns, localTarget, requestedFocusId, mode, localDepth, localDirection],
  );
  const derived = useMemo(
    () => applyGraphSearch(analysis, searchAsFilter ? search : ""),
    [analysis, search, searchAsFilter],
  );
  const filtered = derived.visibleModel;
  // Search combobox ranks the CURRENT filtered graph.
  const searchResults = useMemo(
    () => rankGraphSearch(filtered.nodes, search),
    [filtered.nodes, search],
  );
  // Paused filter chips remove the offending value from the active profile.
  const removePausedFilter = useCallback(
    (descriptor: string) => {
      const separator = descriptor.indexOf(":");
      if (separator < 0) return;
      const kind = descriptor.slice(0, separator);
      const value = descriptor.slice(separator + 1);
      if (kind === "domain") {
        setFilters((current) => ({ ...current, domains: new Set([...current.domains].filter((v) => v !== value)) }));
      } else if (kind === "type") {
        setFilters((current) => ({ ...current, types: new Set([...current.types].filter((v) => v !== value)) }));
      } else if (kind === "relation") {
        setFilters((current) => ({ ...current, relations: new Set([...current.relations].filter((v) => v !== value)) }));
      } else if (kind === "community") {
        setFilters((current) => ({ ...current, community: null }));
      }
    },
    [],
  );

  useEffect(() => {
    setSeedPositions({});
    setPinnedIds([]);
    setLayoutCacheReady(!workspacePath);
    if (!workspacePath) return;
    let cancelled = false;
    void vaultGraphLayoutRead(workspacePath)
      .then((cache) => {
        if (cancelled || !cache) return;
        setSeedPositions(sanitizePositions(cache.positions));
        setPinnedIds(cache.pinnedIds ?? []);
      })
      .catch((err: unknown) => {
        console.info("[graph] layout cache unavailable", err);
      })
      .finally(() => {
        if (!cancelled) setLayoutCacheReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [workspacePath]);

  const handleLayoutSettled = useCallback((positions: Float64Array, nextPinnedIds: string[]) => {
    latestPositionsRef.current = positions;
    settledNodesRef.current = model.nodes;
    setPinnedIds(nextPinnedIds);
    setSettled(positions);
  }, [model.nodes]);

  // --- disk layout cache: debounced save of current positions -------------

  useEffect(() => {
    if (!workspacePath || !settled) return;
    // Skip while `settled` belongs to a different node set (identity, not just
    // cardinality — a same-cardinality swap would persist wrong coordinates).
    if (settledNodesRef.current !== model.nodes) return;
    // A single non-finite coordinate would poison the whole disk cache.
    if (!isFinitePositions(settled)) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      // `settled` is index-aligned with the full model, so this is the complete
      // current node set — no seed spread (that would re-accrete deleted ids).
      const map: Record<string, [number, number]> = {};
      model.nodes.forEach((node, i) => {
        map[node.id] = [settled[i * 2], settled[i * 2 + 1]];
      });
      void vaultGraphLayoutSave(workspacePath, {
        version: 2,
        positions: map,
        pinnedIds,
      });
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [settled, model, workspacePath, pinnedIds]);

  // --- interactions -------------------------------------------------------

  const handleOpen = useCallback(
    (node: GraphNode) => {
      if (node.type === "unresolved") {
        onCreateNote(node.label);
        return;
      }
      if (!node.relPath) return;
      const entry = entries.find((e) => e.relPath === node.relPath);
      if (entry) onOpenEntry(entry);
    },
    [entries, onOpenEntry, onCreateNote],
  );

  const selectById = useCallback(
    (id: string | null) => {
      setSelectedId(id);
      setHighlightPair(null);
      setPathIds([]);
      if (toolsOpen) setRightTab(id ? "selected" : "insights");
    },
    [toolsOpen],
  );

  const focusNode = useCallback(
    (node: GraphNode) => {
      const target = graphLocalTargetForNode(node);
      if (!target) return;
      setLocalTarget(target);
      setMode("local");
      onFocusTargetChange({ source, localTarget: target });
      selectById(node.id);
    },
    [selectById, onFocusTargetChange, source],
  );

  const handleSelect = useCallback(
    (node: GraphNode | null) => selectById(node?.id ?? null),
    [selectById],
  );

  const nodeById = useMemo(() => new Map(model.nodes.map((n) => [n.id, n])), [model]);

  // Insight → action: copy the [[wikilink]] to paste into a note, or open the
  // source note in the editor (reuses handleOpen's mode switch).
  const copyWikilink = useCallback(
    (id: string) => {
      const node = nodeById.get(id);
      if (!node) return;
      // Canonical target: relPath-sans-ext (what the editor autocomplete emits;
      // resolves unambiguously via byRelPathNoExt even on duplicate titles).
      // Ghosts have no relPath — their label IS the raw wikilink target.
      const target = node.relPath
        ? node.relPath.replace(/\.(md|mdx|markdown)$/i, "")
        : node.label;
      void navigator.clipboard
        .writeText(`[[${target}]]`)
        .catch((err: unknown) => onError(String(err)));
    },
    [nodeById, onError],
  );
  const openNodeById = useCallback(
    (id: string) => {
      const node = nodeById.get(id);
      if (node) handleOpen(node);
    },
    [nodeById, handleOpen],
  );

  // Favorites integration: a node maps to its file relPath (ghosts have none).
  const favoriteIds = useMemo(
    () =>
      new Set(
        model.nodes
          .filter((n) => n.relPath && isFavorite("file", n.relPath))
          .map((n) => n.id),
      ),
    [model, isFavorite],
  );
  const toggleNodeFavorite = useCallback(
    (node: GraphNode) => {
      if (!node.relPath) return;
      onToggleFavorite({ kind: "file", relPath: node.relPath, label: node.label });
    },
    [onToggleFavorite],
  );

  // Export the current view as PNG/SVG. In Tauri we route through the native
  // save dialog (canceling aborts — no silent fallback); in the browser we
  // download the blob directly.
  const handleExport = useCallback(
    async (format: "png" | "svg") => {
      const controller = exportControllerRef.current;
      if (!controller) return;
      try {
        const result = {
          blob: format === "png" ? await controller.png() : controller.svg(),
          extension: format,
        };
        // Local calendar date (en-CA → YYYY-MM-DD); toISOString would stamp UTC.
        const name = `graph-${new Date().toLocaleDateString("en-CA")}.${result.extension}`;
        if (workspacePath && isTauri()) {
          const target = await chooseSaveFile(
            t("graph.export.saveTitle"),
            `${workspacePath.replace(/[/\\]+$/, "")}/reports/${name}`,
          );
          if (!target) return; // user canceled the native dialog → abort
          await diagramExportBlobToPath(
            target,
            result.extension as "png" | "svg",
            await blobToUint8Array(result.blob),
          );
        } else {
          downloadGraphBlob(result.blob, name);
        }
      } catch (err: unknown) {
        onError(String(err));
      }
    },
    [workspacePath, onError, t],
  );

  // Context-menu lifecycle: close on any outside interaction / Escape.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);
  const runMenuAction = useCallback(
    (fn: (node: GraphNode, index: number) => void) => {
      const m = menu;
      setMenu(null);
      if (m) fn(m.node, m.index);
    },
    [menu],
  );

  const handlePathTarget = useCallback(
    (node: GraphNode) => {
      const source = pathSourceId ?? selectedId;
      if (!source || source === node.id) {
        setPathSourceId(node.id);
        if (toolsOpen) setRightTab("selected");
        return;
      }
      const path = shortestPath(derived.analysisModel, source, node.id);
      if (!path) {
        onError(t("graph.path.none"));
        return;
      }
      setPathIds(path);
      setHighlightPair(null);
      setPathSourceId(null);
    },
    [derived.analysisModel, pathSourceId, selectedId, onError, t, toolsOpen],
  );

  const handleInsightNode = useCallback(
    (id: string) => {
      selectById(id);
      setCenterSignal({ id, nonce: Date.now() });
    },
    [selectById],
  );

  const handleHighlightPair = useCallback(
    (a: string, b: string) => {
      setHighlightPair({ a, b });
      setPathIds([]);
      setSelectedId(null);
      setCenterSignal({ id: a, nonce: Date.now() });
    },
    [],
  );
  const handleConnect = useCallback((sourceId: string, targetId: string) => {
    const sourceNode = nodeById.get(sourceId);
    const targetNode = nodeById.get(targetId);
    if (!sourceNode?.relPath || !targetNode?.relPath) return;
    setRelationPair({ source: sourceNode, target: targetNode });
  }, [nodeById]);

  const clearFocus = useCallback(() => {
    setLocalTarget(null);
    setMode("global");
    onFocusTargetChange(null);
  }, [onFocusTargetChange]);

  // Toolbar mode segmented control: Local with no anchor keeps Global and
  // focuses the search box (the user picks a node there first).
  const effectiveMode: GraphMode = localTarget ? "local" : mode === "local" ? "global" : mode;
  const handleModeChange = useCallback(
    (next: GraphMode) => {
      if (next === "local") {
        if (!localTarget) {
          setSearchOpen(true);
          requestAnimationFrame(() => searchRef.current?.focus());
        }
        return;
      }
      if (localTarget) clearFocus();
      setMode(next);
    },
    [localTarget, clearFocus],
  );

  const changeSource = useCallback(
    (next: GraphSource) => {
      if (next === source) return;
      setLocalTarget(null);
      onFocusTargetChange(null);
      const current = graphSettingsRef.current;
      onGraphSettingsChangeRef.current({ ...current, source: next, mode: "global" });
    },
    [source, onFocusTargetChange],
  );

  const saveCurrentView = useCallback(
    (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const current = graphSettingsRef.current;
      const view: GraphSavedView = {
        id: globalThis.crypto?.randomUUID?.() ?? `graph-view-${Date.now()}`,
        name: trimmed,
        source,
        mode: effectiveMode,
        localTarget: effectiveMode === "local" ? localTarget : null,
        profile: filtersToSettings(filters),
        display,
      };
      const duplicate = current.savedViews.find((item) => item.name === trimmed);
      const savedViews = duplicate
        ? current.savedViews.map((item) =>
            item.id === duplicate.id ? { ...view, id: duplicate.id } : item,
          )
        : [...current.savedViews, view];
      onGraphSettingsChangeRef.current({ ...current, savedViews });
    },
    [source, effectiveMode, localTarget, filters, display],
  );

  const applySavedView = useCallback(
    (view: GraphSavedView) => {
      const target = view.mode === "local" && view.localTarget
        ? { source: view.source, localTarget: view.localTarget }
        : null;
      setLocalTarget(target?.localTarget ?? null);
      setMode(target ? "local" : view.mode === "local" ? "global" : view.mode);
      setFilters(filtersFromSettings(view.profile));
      setSelectedId(null);
      setPathIds([]);
      setPathSourceId(null);
      onFocusTargetChange(target);
      const current = graphSettingsRef.current;
      onGraphSettingsChangeRef.current({
        ...current,
        source: view.source,
        mode: target ? "local" : view.mode === "local" ? "global" : view.mode,
        profiles: { ...current.profiles, [view.source]: view.profile },
        display: view.display,
      });
    },
    [onFocusTargetChange],
  );

  const deleteSavedView = useCallback((id: string) => {
    const current = graphSettingsRef.current;
    onGraphSettingsChangeRef.current({
      ...current,
      savedViews: current.savedViews.filter((view) => view.id !== id),
    });
  }, []);

  // Surface-scoped shortcuts: ⌘F focus search, Esc clears, +/-/0 zoom. Gated on
  // the graph owning focus — the same window may show a document editor beside
  // an embedded graph split, and a mode-only gate stole the app-wide ⌘F/Esc.
  const shortcutPredicate = useCallback(
    () =>
      effectiveMode !== "chains" &&
      (rootRef.current?.contains(document.activeElement) ?? false),
    [effectiveMode],
  );
  const shortcutHandler = useCallback(
    (event: KeyboardEvent) => {
      if (matchesShortcut(event, { key: "f", mod: true })) {
        event.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => searchRef.current?.focus());
        return;
      }
      if (isInEditable(event.target)) return;
      if (event.key === "Escape") {
        // Consume Esc only when the graph actually closes something —
        // otherwise dialogs and global handlers must still see it. The scoped
        // shortcut stops propagation on preventDefault, so each branch closes
        // its own surface (the window listeners never see the event).
        if (menu) {
          event.preventDefault();
          setMenu(null);
          return;
        }
        // Toolbar popovers close on their own bubble-phase Esc listener; let
        // the event through so they get priority over the cascade below.
        if (rootRef.current?.querySelector('[role="menu"]')) return;
        if (toolsOpen) {
          event.preventDefault();
          setToolsOpen(false);
          return;
        }
        if (searchOpen) {
          event.preventDefault();
          if (search) setSearch("");
          else setSearchOpen(false);
          return;
        }
        if (pathSourceId || pathIds.length > 0) {
          event.preventDefault();
          setPathSourceId(null);
          setPathIds([]);
          return;
        }
        if (selectedId) {
          event.preventDefault();
          selectById(null);
          return;
        }
        if (localTarget) {
          event.preventDefault();
          clearFocus();
        }
      } else if (event.key === "=" || event.key === "+") {
        event.preventDefault();
        setZoomSignal({ dir: 1, nonce: Date.now() });
      } else if (event.key === "-") {
        event.preventDefault();
        setZoomSignal({ dir: -1, nonce: Date.now() });
      } else if (event.key === "0") {
        event.preventDefault();
        setFitSignal((s) => s + 1);
      }
    },
    [
      clearFocus,
      localTarget,
      menu,
      pathIds.length,
      pathSourceId,
      search,
      searchOpen,
      selectById,
      selectedId,
      toolsOpen,
    ],
  );
  useScopedKeyboardShortcuts(shortcutPredicate, shortcutHandler);

  // Search combobox selection: select + center (opens the Details tab), no
  // local-focus side effects.
  const handleSearchSelect = useCallback(
    (id: string) => {
      selectById(id);
      setCenterSignal({ id, nonce: Date.now() });
    },
    [selectById],
  );

  // a11y live announcements: empty states + layout running/done.
  const [liveMessage, setLiveMessage] = useState("");
  useEffect(() => {
    if (derived.emptyReason === "empty-source") setLiveMessage(t("graph.empty.source"));
    else if (derived.emptyReason === "filtered-empty") setLiveMessage(t("graph.empty.filtered"));
    else setLiveMessage("");
  }, [derived.emptyReason, t]);
  const prevRendererStateRef = useRef<GraphRendererState>("loading");
  useEffect(() => {
    if (rendererState === "layout-running") setLiveMessage(t("graph.layout.running"));
    else if (prevRendererStateRef.current === "layout-running" && rendererState === "ready") {
      setLiveMessage(t("graph.layout.done"));
    }
    prevRendererStateRef.current = rendererState;
  }, [rendererState, t]);

  const selectedNode = useMemo(
    () => (selectedId ? filtered.nodes.find((n) => n.id === selectedId) ?? null : null),
    [selectedId, filtered.nodes],
  );
  useEffect(() => {
    if (selectedId && !derived.visibleNodeIds.has(selectedId)) selectById(null);
  }, [selectedId, derived.visibleNodeIds, selectById]);

  const highlight: GraphHighlight = useMemo(() => {
    if (pathIds.length > 1) return { kind: "path", ids: pathIds };
    if (highlightPair) return { kind: "pair", a: highlightPair.a, b: highlightPair.b };
    return null;
  }, [pathIds, highlightPair]);

  const activeFilterCount =
    filters.domains.size +
    filters.types.size +
    filters.relations.size +
    (filters.community == null ? 0 : 1) +
    (filters.showUnresolved ? 1 : 0) +
    (filters.showGenerated ? 1 : 0) +
    (filters.minVisibleNeighbors === defaultGraphFilterProfile().minVisibleNeighbors ? 0 : 1) +
    (searchAsFilter && search.trim() ? 1 : 0);

  const toolsDrawer = (
    <Tabs.Root
      value={rightTab}
      onValueChange={(value) =>
        setRightTab(value as "filters" | "insights" | "selected")
      }
      className="graph-right graph-tools-drawer"
      data-testid="graph-right"
    >
      <Tabs.List className="graph-right-tabs" aria-label={t("graph.tab.insights")}>
        <Tabs.Trigger value="filters" className="graph-right-tab">
          {t("graph.panels.filters")}
        </Tabs.Trigger>
        <Tabs.Trigger value="insights" className="graph-right-tab">
          {t("graph.tab.insights")}
        </Tabs.Trigger>
        <Tabs.Trigger value="selected" className="graph-right-tab" disabled={!selectedNode}>
          {t("graph.tab.selected")}
        </Tabs.Trigger>
        {tier === "wide" ? (
          <button
            type="button"
            className="graph-drawer-action"
            aria-pressed={panels.pinned}
            title={panels.pinned ? t("graph.panels.unpin") : t("graph.panels.pin")}
            onClick={() =>
              persistPanels({ ...panelsRef.current, pinned: !panelsRef.current.pinned })
            }
          >
            {panels.pinned ? <PinOff size={13} /> : <Pin size={13} />}
          </button>
        ) : null}
        <button
          type="button"
          className="graph-drawer-action"
          title={t("graph.focus.exit")}
          onClick={() => setToolsOpen(false)}
        >
          <X size={14} />
        </button>
      </Tabs.List>
      <Tabs.Content value="filters" className="graph-right-content">
        <GraphFilterPanel
          filters={filters}
          domains={derived.facets.domains}
          types={derived.facets.types}
          relations={derived.facets.relations}
          communities={derived.facets.communities}
          enriched={model.enriched}
          maxVisibleNeighbors={derived.facets.maxVisibleNeighbors}
          pausedFilters={derived.pausedFilters}
          onRemovePaused={removePausedFilter}
          display={display}
          onDisplayChange={persistDisplay}
          onFiltersChange={setFilters}
        />
      </Tabs.Content>
      <Tabs.Content
        value="insights"
        className="graph-right-content"
      >
        {rightTab === "insights" ? (
          <GraphInsightsPanel
            model={derived.analysisModel}
            now={now}
            onHighlightPair={handleHighlightPair}
            onSelectNode={handleInsightNode}
            onCopyWikilink={copyWikilink}
            onOpenNode={openNodeById}
            onConnect={handleConnect}
          />
        ) : null}
      </Tabs.Content>
      <Tabs.Content
        value="selected"
        className="graph-right-content"
      >
        <GraphInspector
          node={selectedNode}
          model={filtered}
          isFavorite={
            selectedNode?.relPath ? isFavorite("file", selectedNode.relPath) : false
          }
          onSelectNode={handleInsightNode}
          onOpen={handleOpen}
          onToggleFavorite={toggleNodeFavorite}
          onFocus={focusNode}
          onStartPath={(node) => {
            setPathSourceId(node.id);
            setSelectedId(node.id);
          }}
        />
      </Tabs.Content>
    </Tabs.Root>
  );

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className={`graph-view tier-${tier}`}
      data-testid="graph-mode"
      data-graph-theme={display.theme}
      data-graph-accent={display.accent}
      data-graph-colors={display.colorMode}
      data-graph-search-open={searchOpen ? "true" : undefined}
    >
      <GraphToolbar
        mode={effectiveMode}
        onModeChange={handleModeChange}
        source={source}
        onSourceChange={changeSource}
        search={search}
        onSearchChange={setSearch}
        searchOpen={searchOpen}
        onSearchOpenChange={setSearchOpen}
        searchInputRef={searchRef}
        searchResults={searchResults}
        onSearchSelect={handleSearchSelect}
        onSearchActiveChange={handleSearchActiveChange}
        searchAsFilter={searchAsFilter}
        onSearchAsFilterChange={setSearchAsFilter}
        visibleCount={filtered.nodes.length}
        totalCount={model.nodes.length}
        filtersOpen={filtersVisible}
        activeFilterCount={activeFilterCount}
        onToggleFilters={toggleFiltersPanel}
        workbenchOpen={workbenchVisible}
        onToggleWorkbench={toggleWorkbenchPanel}
        onRefreshOverlay={() => {
          const root = overlayPath ?? workspacePath;
          if (root) loadOverlay(root, liveModel);
        }}
        onExportPng={() => void handleExport("png")}
        onExportSvg={() => void handleExport("svg")}
        onRelayout={() => setLayoutEpoch((e) => e + 1)}
        refreshing={refreshing}
        savedViews={graphSettings.savedViews}
        onSaveView={saveCurrentView}
        onApplyView={applySavedView}
        onDeleteView={deleteSavedView}
      />

      {!model.enriched ? (
        <div className="graph-degraded-bar" data-testid="graph-degraded-hint">
          {enrichment.hint ?? t("graph.hint.noEnrichment")}
        </div>
      ) : null}
      {localTarget ? (
        <div className="graph-focus-bar" data-testid="graph-focus-bar">
          <span>
            {derived.focusMissing
              ? `${t("graph.focus.missing")}: ${localTarget.relPath}`
              : `${t("graph.focus.active")}: ${localFocusNode?.label ?? localTarget.relPath}`}
          </span>
          <label>
            {t("graph.focus.depth")}
            <select value={localDepth} onChange={(event) => setLocalDepth(Number(event.target.value) as 1 | 2 | 3)}>
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
            </select>
          </label>
          <label>
            {t("graph.focus.direction")}
            <select value={localDirection} onChange={(event) => setLocalDirection(event.target.value as GraphSettingsV3["localDirection"])}>
              <option value="both">{t("graph.focus.both")}</option>
              <option value="incoming">{t("graph.focus.incoming")}</option>
              <option value="outgoing">{t("graph.focus.outgoing")}</option>
            </select>
          </label>
          <button type="button" onClick={clearFocus}>{t("graph.focus.exit")}</button>
        </div>
      ) : null}
      {pathSourceId ? (
        <div className="graph-path-bar" data-testid="graph-path-bar">
          {t("graph.path.pick")}
          <button type="button" onClick={() => setPathSourceId(null)}>{t("graph.focus.exit")}</button>
        </div>
      ) : null}

      {effectiveMode !== "chains" && derived.emptyReason ? (
        <div className="graph-degraded-bar graph-empty-bar" data-testid="graph-empty-bar">
          {derived.emptyReason === "empty-source" ? t("graph.empty.source") : t("graph.empty.filtered")}
          {derived.emptyReason === "filtered-empty" ? (
            <button
              type="button"
              data-testid="graph-reset-filters"
              onClick={() => {
                setFilters(filtersFromSettings(defaultGraphFilterProfile()));
                // Search-as-filter can be the narrowing that emptied the graph;
                // a reset that leaves the query active would be a no-op.
                setSearch("");
              }}
            >
              {t("graph.empty.resetFilters")}
            </button>
          ) : null}
        </div>
      ) : null}

      {effectiveMode === "chains" ? (
        <DecisionChainLanes model={model} onNodeClick={handleOpen} />
      ) : (
        <div className="graph-body" ref={bodyRef}>
          <div className="graph-canvas-column">
            {layoutCacheReady ? <GraphCanvas
              nodes={model.nodes}
              edges={model.edges}
              positionsRef={latestPositionsRef}
              positionNodeIdsRef={latestPositionNodeIdsRef}
              seedPositions={seedPositions}
              initialPinnedIds={pinnedIds}
              visibleNodeIds={derived.visibleNodeIds}
              visibleEdgeKeys={derived.visibleEdgeKeys}
              layoutEpoch={layoutEpoch}
              themeEpoch={themeEpoch}
              enriched={model.enriched}
              display={display}
              selectedId={selectedId}
              focusNodeId={localFocus}
              searchHighlightId={activeSearchId}
              pathSourceId={pathSourceId}
              highlight={highlight}
              fitSignal={fitSignal}
              zoomSignal={zoomSignal}
              centerSignal={centerSignal}
              onSelect={handleSelect}
              onOpen={handleOpen}
              onPathTarget={handlePathTarget}
              onNodeDrag={() => undefined}
              onNodeUnpin={() => undefined}
              unpinSignal={unpinSignal}
              onLayoutSettled={handleLayoutSettled}
              onLayoutError={onError}
              onRendererStateChange={setRendererState}
              onNodeContextMenu={(node, index, x, y) => setMenu({ node, index, x, y })}
              favoriteIds={favoriteIds}
              exportControllerRef={exportControllerRef}
              overlay={
                <>
                  {display.colorMode === "domain" ||
                  (display.colorMode === "community" && model.enriched) ? (
                    <GraphLegend
                      mode={display.colorMode}
                      domains={derived.facets.domains}
                      communities={derived.facets.communities}
                      filters={filters}
                      onFiltersChange={setFilters}
                      iconOnly={tier !== "wide"}
                    />
                  ) : null}
                  <GraphZoomCluster
                    onZoomIn={() => setZoomSignal({ dir: 1, nonce: Date.now() })}
                    onZoomOut={() => setZoomSignal({ dir: -1, nonce: Date.now() })}
                    onFit={() => setFitSignal((s) => s + 1)}
                  />
                  {selectedNode ? (
                    <div className="graph-selection-shelf" data-testid="graph-selection-shelf">
                      <span title={selectedNode.relPath ?? selectedNode.label}>
                        {selectedNode.label}
                      </span>
                      <small>{selectedNode.degree}</small>
                      <button type="button" onClick={() => handleOpen(selectedNode)}>
                        {t("graph.inspector.open")}
                      </button>
                      <button type="button" onClick={() => focusNode(selectedNode)}>
                        {t("graph.inspector.focus")}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setRightTab("selected");
                          setToolsOpen(true);
                        }}
                      >
                        {t("graph.tab.selected")}
                      </button>
                    </div>
                  ) : null}
                </>
              }
            /> : <div className="graph-canvas-loading" role="status">{t("graph.layout.running")}</div>}
          </div>
          {toolsDocked ? (
            <div
              className="pane-resize-handle graph-panel-resize"
              role="separator"
              aria-orientation="vertical"
              aria-label={t("graph.panels.workbench")}
              title={t("graph.panels.workbench")}
              aria-valuemin={GRAPH_PANEL_WIDTH_MIN}
              aria-valuemax={GRAPH_PANEL_WIDTH_MAX}
              aria-valuenow={panelWidth}
              tabIndex={0}
              onPointerDown={startPanelResize}
              onKeyDown={resizePanelByKey}
            />
          ) : null}
          {toolsDocked ? (
            <div className="graph-panel-docked" style={{ width: panelWidth }}>
              {toolsDrawer}
            </div>
          ) : null}
          {!toolsDocked && toolsOpen ? (
            <div
              className="graph-panel-overlay graph-panel-overlay-right"
              style={tier === "compact" ? undefined : { width: panelWidth }}
            >
              {toolsDrawer}
            </div>
          ) : null}
        </div>
      )}
      <div className="sr-only" aria-live="polite">{liveMessage}</div>

      {menu ? (
        <div
          ref={menuRef}
          className="context-menu graph-node-context-menu"
          data-testid="graph-node-context-menu"
          role="menu"
          tabIndex={-1}
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={handleMenuKeyDown}
        >
          <div className="context-menu-title" title={menu.node.relPath ?? menu.node.label}>
            {menu.node.label}
          </div>
          <button type="button" role="menuitem" onClick={() => runMenuAction((n) => handleOpen(n))}>
            <span>{t("graph.inspector.open")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => runMenuAction(focusNode)}
          >
            <span>{t("graph.inspector.focus")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => runMenuAction((n) => { setPathSourceId(n.id); setSelectedId(n.id); })}
          >
            <span>{t("graph.inspector.startPath")}</span>
          </button>
          <div className="context-menu-separator" role="separator" />
          <button type="button" role="menuitem" onClick={() => runMenuAction((n) => copyWikilink(n.id))}>
            <span>{t("graph.action.copyWikilink")}</span>
          </button>
          {menu.node.relPath ? (
            <button type="button" role="menuitem" onClick={() => runMenuAction((n) => toggleNodeFavorite(n))}>
              <span>{favoriteIds.has(menu.node.id) ? t("graph.menu.unfavorite") : t("graph.menu.favorite")}</span>
            </button>
          ) : null}
          {pinnedIds.includes(menu.node.id) ? (
            <>
              <div className="context-menu-separator" role="separator" />
              <button
                type="button"
                role="menuitem"
                onClick={() =>
                  runMenuAction((n) =>
                    setUnpinSignal({ id: n.id, nonce: Date.now() }),
                  )
                }
              >
                <span>{t("graph.menu.unpin")}</span>
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      <GraphRelationReviewDialog
        open={relationPair != null}
        source={relationPair?.source ?? null}
        target={relationPair?.target ?? null}
        workspacePath={workspacePath}
        onOpenChange={(open) => {
          if (!open) setRelationPair(null);
        }}
        onApplied={() => onGraphChanged?.()}
      />
    </div>
  );
}
