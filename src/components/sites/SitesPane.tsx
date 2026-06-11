import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  ExternalLink,
  Globe,
  Loader2,
  RotateCw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readSites, saveSites } from "../../lib/anchorDir";
import { clipboardWriteText } from "../../lib/clipboard";
import { useTranslation } from "../../lib/i18n";
import {
  nextSiteOrder,
  parseSitesDocument,
  removeSite,
  serializeSitesDocument,
  shouldShowSiteView,
  siteViewBoundsFromRect,
  touchSiteUsage,
  upsertSite,
  type SiteEntry,
} from "../../lib/sites";
import {
  siteViewBack,
  siteViewForward,
  siteViewHide,
  siteViewNavigate,
  siteViewOpen,
  siteViewOpenExternal,
  siteViewReload,
  siteViewRuntime,
  siteViewSetBounds,
  siteViewShow,
  subscribeSiteViewEvents,
} from "../../lib/siteView";
import { ImportSitesDialog } from "./ImportSitesDialog";
import { NewSiteDialog } from "./NewSiteDialog";
import { SitesSidebar } from "./SitesSidebar";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

const isTauriShell = () =>
  typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);

// Survives unmount (mode switches) but not app restart — pairs with the
// native webview, which also stays alive (hidden) across mode switches.
let sessionActiveSiteId: string | null = null;

interface SitesPaneProps {
  /** True while any App-level in-DOM overlay covers the content area
   *  (command palette, dialogs, approval gate). The native webview cannot
   *  stack under DOM modals, so we hide it for the duration. */
  overlayOpen: boolean;
  onError: (message: string | null) => void;
}

export function SitesPane({ overlayOpen, onError }: SitesPaneProps) {
  const { t } = useTranslation();
  const tauri = useMemo(isTauriShell, []);

  const [sites, setSites] = useState<SiteEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [activeSiteId, setActiveSiteId] = useState<string | null>(sessionActiveSiteId);
  const [currentUrl, setCurrentUrl] = useState<string | null>(() => siteViewRuntime().url);
  const [currentTitle, setCurrentTitle] = useState<string | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [newSiteOpen, setNewSiteOpen] = useState(false);
  const [editSite, setEditSite] = useState<SiteEntry | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const copiedTimerRef = useRef<number | null>(null);
  const desiredVisibleRef = useRef(false);

  const activeSite = useMemo(
    () => sites.find((site) => site.id === activeSiteId) ?? null,
    [sites, activeSiteId],
  );
  const localDialogOpen = newSiteOpen || editSite !== null || importOpen;
  const showView =
    tauri &&
    shouldShowSiteView({
      hasActiveSite: Boolean(activeSite),
      overlayOpen,
      localDialogOpen,
    });
  // Render-time mirror so rAF/observer callbacks never see a stale closure.
  desiredVisibleRef.current = showView;

  const reportError = useCallback(
    (err: unknown) => onError(err instanceof Error ? err.message : String(err)),
    [onError],
  );

  // ── rAF-batched bounds/visibility sync. Every layout source (observer,
  // window resize, visibility flips) funnels through here, so a burst of
  // events collapses into one invoke pass per frame.
  const scheduleSync = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      if (!siteViewRuntime().opened) return;
      const el = surfaceRef.current;
      const bounds = el ? siteViewBoundsFromRect(el.getBoundingClientRect()) : null;
      // Collapsed placeholder (terminal maximized → display:none) or any
      // overlay/dialog → hide. Bounds-before-show prevents stale-rect flash.
      if (!desiredVisibleRef.current || !bounds) {
        void siteViewHide().catch(() => undefined);
        return;
      }
      void siteViewSetBounds(bounds)
        .then(() => siteViewShow())
        .catch(reportError);
    });
  }, [reportError]);

  // ── load the registry once (StrictMode-safe via cancelled flag)
  useEffect(() => {
    let cancelled = false;
    void readSites()
      .then((value) => {
        if (cancelled) return;
        setSites(parseSitesDocument(value).sites);
        setLoaded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoaded(true);
        reportError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [reportError]);

  // ── Rust → main-webview navigation events
  useEffect(() => {
    return subscribeSiteViewEvents({
      onNavigated: ({ url }) => setCurrentUrl(url),
      onPageLoad: ({ state }) => setPageLoading(state === "started"),
      onTitleChanged: ({ title }) => setCurrentTitle(title.trim() || null),
    });
  }, []);

  // ── layout observation: placeholder resize + window resize
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el || !tauri) return;
    const observer = new ResizeObserver(scheduleSync);
    observer.observe(el);
    window.addEventListener("resize", scheduleSync);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", scheduleSync);
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [scheduleSync, tauri]);

  // ── single effect driving show/hide from state (overlay, dialogs, site)
  useEffect(() => {
    if (showView) scheduleSync();
    else void siteViewHide().catch(() => undefined);
  }, [showView, scheduleSync]);

  // ── unmount (mode switch away): hide but keep the webview alive so the
  // session is restored instantly when the user comes back.
  useEffect(() => {
    return () => {
      void siteViewHide().catch(() => undefined);
    };
  }, []);

  // ── persistence
  const persistSites = useCallback(
    (next: SiteEntry[]) => {
      setSites(next);
      void saveSites(serializeSitesDocument(next)).catch(reportError);
    },
    [reportError],
  );

  // ── user actions
  const activateSite = useCallback(
    (site: SiteEntry) => {
      sessionActiveSiteId = site.id;
      setActiveSiteId(site.id);
      setCurrentUrl(site.url);
      setCurrentTitle(null);
      setPageLoading(tauri);
      persistSites(touchSiteUsage(sites, site.id));
      if (!tauri) return;
      const runtime = siteViewRuntime();
      if (!runtime.opened) {
        // First open is always user-initiated from a visible pane, so the
        // placeholder rect is valid here. Never opened from an effect —
        // that is what makes StrictMode double-effects safe.
        const el = surfaceRef.current;
        const bounds = el ? siteViewBoundsFromRect(el.getBoundingClientRect()) : null;
        if (!bounds) return;
        void siteViewOpen(site.url, bounds).then(scheduleSync).catch(reportError);
      } else {
        void siteViewNavigate(site.url).then(scheduleSync).catch(reportError);
      }
    },
    [persistSites, reportError, scheduleSync, sites, tauri],
  );

  const deleteSite = useCallback(
    (site: SiteEntry) => {
      if (!window.confirm(t("sites.delete.confirm"))) return;
      persistSites(removeSite(sites, site.id));
      if (activeSiteId === site.id) {
        sessionActiveSiteId = null;
        setActiveSiteId(null);
        setCurrentUrl(null);
        setCurrentTitle(null);
        setPageLoading(false);
        void siteViewHide().catch(() => undefined);
      }
    },
    [activeSiteId, persistSites, sites, t],
  );

  const handleSaveSite = useCallback(
    (entry: SiteEntry) => {
      persistSites(upsertSite(sites, entry));
      if (activeSiteId === entry.id && siteViewRuntime().url !== entry.url) {
        setCurrentUrl(entry.url);
        void siteViewNavigate(entry.url).catch(reportError);
      }
    },
    [activeSiteId, persistSites, reportError, sites],
  );

  const handleImport = useCallback(
    (entries: SiteEntry[]) => {
      let next = sites;
      for (const entry of entries) next = upsertSite(next, entry);
      persistSites(next);
    },
    [persistSites, sites],
  );

  const copyUrl = useCallback(() => {
    const url = currentUrl ?? activeSite?.url;
    if (!url) return;
    void clipboardWriteText(url)
      .then(() => {
        setCopied(true);
        if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(reportError);
  }, [activeSite, currentUrl, reportError]);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    };
  }, []);

  const openExternal = useCallback(() => {
    const url = currentUrl ?? activeSite?.url;
    if (!url) return;
    void siteViewOpenExternal(url).catch(reportError);
  }, [activeSite, currentUrl, reportError]);

  const navDisabled = !tauri || !activeSite || !siteViewRuntime().opened;
  const displayUrl = currentUrl ?? activeSite?.url ?? "";

  return (
    <main className="sites-pane">
      <SitesSidebar
        sites={sites}
        query={query}
        categoryFilter={categoryFilter}
        activeSiteId={activeSiteId}
        loaded={loaded}
        onQueryChange={setQuery}
        onCategoryFilterChange={setCategoryFilter}
        onSelect={activateSite}
        onAdd={() => setNewSiteOpen(true)}
        onEdit={setEditSite}
        onDelete={deleteSite}
        onImport={() => setImportOpen(true)}
      />

      <section className="sites-browser">
        <div className="sites-toolbar">
          <button
            type="button"
            className="icon-button"
            disabled={navDisabled}
            onClick={() => void siteViewBack().catch(reportError)}
            title={t("sites.toolbar.back")}
            aria-label={t("sites.toolbar.back")}
          >
            <ArrowLeft size={15} />
          </button>
          <button
            type="button"
            className="icon-button"
            disabled={navDisabled}
            onClick={() => void siteViewForward().catch(reportError)}
            title={t("sites.toolbar.forward")}
            aria-label={t("sites.toolbar.forward")}
          >
            <ArrowRight size={15} />
          </button>
          <button
            type="button"
            className="icon-button"
            disabled={navDisabled}
            onClick={() => void siteViewReload().catch(reportError)}
            title={t("sites.toolbar.reload")}
            aria-label={t("sites.toolbar.reload")}
          >
            <RotateCw size={15} />
          </button>

          <div
            className="sites-url"
            title={currentTitle ? `${currentTitle} — ${displayUrl}` : displayUrl}
          >
            {pageLoading ? (
              <Loader2 size={13} className="spin" />
            ) : (
              <Globe size={13} strokeWidth={1.8} />
            )}
            {currentTitle ? <span className="sites-url-title">{currentTitle}</span> : null}
            <span>{displayUrl}</span>
          </div>

          <button
            type="button"
            className="icon-button"
            disabled={!displayUrl}
            onClick={copyUrl}
            title={copied ? t("sites.toolbar.copied") : t("sites.toolbar.copyUrl")}
            aria-label={t("sites.toolbar.copyUrl")}
          >
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </button>
          <button
            type="button"
            className="icon-button"
            disabled={!displayUrl}
            onClick={openExternal}
            title={t("sites.toolbar.openExternal")}
            aria-label={t("sites.toolbar.openExternal")}
          >
            <ExternalLink size={15} />
          </button>
        </div>

        {/* Measured spacer — the native child webview floats over this rect. */}
        <div className="sites-surface" ref={surfaceRef}>
          {!activeSite ? (
            <div className="sites-surface-hint">
              <Globe size={28} strokeWidth={1.6} />
              <p>{t("sites.placeholder.selectSite")}</p>
            </div>
          ) : !tauri ? (
            <div className="sites-surface-hint">
              <Globe size={28} strokeWidth={1.6} />
              <p>{t("sites.placeholder.browserDev")}</p>
              <a href={activeSite.url} target="_blank" rel="noreferrer">
                {activeSite.url}
              </a>
            </div>
          ) : null}
        </div>
      </section>

      <NewSiteDialog
        open={newSiteOpen || editSite !== null}
        initial={editSite}
        nextOrder={nextSiteOrder(sites)}
        onClose={() => {
          setNewSiteOpen(false);
          setEditSite(null);
        }}
        onSave={handleSaveSite}
      />
      <ImportSitesDialog
        open={importOpen}
        existingSites={sites}
        nextOrder={nextSiteOrder(sites)}
        onClose={() => setImportOpen(false)}
        onImport={handleImport}
      />
    </main>
  );
}
