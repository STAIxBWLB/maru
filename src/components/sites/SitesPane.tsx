import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  ExternalLink,
  Globe,
  Loader2,
  Plus,
  RotateCw,
  Star,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readSites, saveSites } from "../../lib/maruDir";
import { clipboardWriteText } from "../../lib/clipboard";
import { useTranslation } from "../../lib/i18n";
import {
  browserTabLabel,
  closeBrowserTab,
  nextBrowserTabId,
  openBrowserTab,
  updateBrowserTab,
  type BrowserTab,
} from "../../lib/browserTabs";
import {
  newSiteId,
  nextSiteOrder,
  normalizeSiteUrl,
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
  SITE_VIEW_CLOSE_ACTIVE_REQUEST_EVENT,
  siteViewBack,
  siteViewClose,
  siteViewForward,
  siteViewHide,
  siteViewNavigate,
  siteViewOpen,
  siteViewOpenExternal,
  siteViewReload,
  siteViewSetBounds,
  siteViewShow,
  siteViewTabRuntime,
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

// Survives unmount (mode switches) but not app restart — pairs with the native
// webviews, which also stay alive (hidden) across mode switches.
let sessionTabs: BrowserTab[] = [];
let sessionActiveTabId: string | null = null;

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
  const [tabs, setTabs] = useState<BrowserTab[]>(sessionTabs);
  const [activeTabId, setActiveTabId] = useState<string | null>(sessionActiveTabId);
  const [addressDraft, setAddressDraft] = useState("");
  const [addressFocused, setAddressFocused] = useState(false);
  const [copied, setCopied] = useState(false);
  const [newSiteOpen, setNewSiteOpen] = useState(false);
  const [editSite, setEditSite] = useState<SiteEntry | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const copiedTimerRef = useRef<number | null>(null);
  const desiredVisibleRef = useRef(false);
  const activeTabRef = useRef<string | null>(activeTabId);
  const pendingOpenRef = useRef(new Map<string, string>());

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [tabs, activeTabId],
  );
  activeTabRef.current = activeTabId;
  sessionTabs = tabs;
  sessionActiveTabId = activeTabId;

  const localDialogOpen = newSiteOpen || editSite !== null || importOpen;
  const showView =
    tauri &&
    shouldShowSiteView({
      hasActiveSite: Boolean(activeTab),
      overlayOpen,
      localDialogOpen,
    });
  // Render-time mirror so rAF/observer callbacks never see a stale closure.
  desiredVisibleRef.current = showView;

  const reportError = useCallback(
    (err: unknown) => onError(err instanceof Error ? err.message : String(err)),
    [onError],
  );

  // ── rAF-batched bounds/visibility sync for the active tab. Every layout
  // source (observer, window resize, visibility flips) funnels through here,
  // so a burst of events collapses into one invoke pass per frame.
  const scheduleSync = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      const tabId = activeTabRef.current;
      if (!tabId) return;
      const el = surfaceRef.current;
      const bounds = el ? siteViewBoundsFromRect(el.getBoundingClientRect()) : null;
      // Collapsed placeholder (terminal maximized → display:none) or any
      // overlay/dialog → hide. Bounds-before-show prevents stale-rect flash.
      if (!desiredVisibleRef.current || !bounds) {
        void siteViewHide().catch(() => undefined);
        return;
      }
      if (!siteViewTabRuntime(tabId)) {
        if (!pendingOpenRef.current.has(tabId)) return;
        const url = pendingOpenRef.current.get(tabId) ?? "";
        pendingOpenRef.current.delete(tabId);
        void siteViewOpen(tabId, url, bounds).catch(reportError);
        return;
      }
      void siteViewSetBounds(tabId, bounds)
        .then(() => siteViewShow(tabId))
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

  // ── Rust → main-webview navigation events, attributed per tab
  useEffect(() => {
    return subscribeSiteViewEvents({
      onNavigated: ({ tabId, url }) =>
        setTabs((current) => updateBrowserTab(current, tabId, { url })),
      onPageLoad: ({ tabId, state }) =>
        setTabs((current) =>
          updateBrowserTab(current, tabId, { loading: state === "started" }),
        ),
      onTitleChanged: ({ tabId, title }) =>
        setTabs((current) =>
          updateBrowserTab(current, tabId, { title: title.trim() || null }),
        ),
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

  // ── single effect driving show/hide from state (overlay, dialogs, tab)
  useEffect(() => {
    if (showView) scheduleSync();
    else void siteViewHide().catch(() => undefined);
  }, [showView, scheduleSync, activeTabId]);

  // ── unmount (mode switch away): hide but keep the webviews alive so the
  // session is restored instantly when the user comes back.
  useEffect(() => {
    return () => {
      void siteViewHide().catch(() => undefined);
    };
  }, []);

  // ── the address bar mirrors the active tab unless the user is editing it
  useEffect(() => {
    if (addressFocused) return;
    setAddressDraft(activeTab?.url ?? "");
  }, [activeTab?.url, addressFocused]);

  // ── persistence
  const persistSites = useCallback(
    (next: SiteEntry[]) => {
      setSites(next);
      void saveSites(serializeSitesDocument(next)).catch(reportError);
    },
    [reportError],
  );

  /** Load a URL into a tab, creating the native webview on first use. */
  const loadInTab = useCallback(
    (tabId: string, url: string) => {
      if (!tauri) return;
      if (!url) {
        pendingOpenRef.current.delete(tabId);
        return;
      }
      if (siteViewTabRuntime(tabId)) {
        void siteViewNavigate(tabId, url).then(scheduleSync).catch(reportError);
        return;
      }
      // Defer first open until the measured surface has non-zero bounds.
      // Mode switches and React commits can otherwise race the first click.
      pendingOpenRef.current.set(tabId, url);
      scheduleSync();
    },
    [reportError, scheduleSync, tauri],
  );

  const openInNewTab = useCallback(
    (url: string, siteId: string | null) => {
      setTabs((current) => {
        const id = nextBrowserTabId(current);
        const result = openBrowserTab(current, {
          id,
          url,
          title: null,
          loading: tauri && Boolean(url),
          siteId,
        });
        if (!result.opened) {
          onError(t("sites.tabs.limit"));
          return current;
        }
        setActiveTabId(id);
        activeTabRef.current = id;
        loadInTab(id, url);
        return result.tabs;
      });
    },
    [loadInTab, onError, t, tauri],
  );

  const activateTab = useCallback(
    (tabId: string) => {
      setActiveTabId(tabId);
      activeTabRef.current = tabId;
      scheduleSync();
    },
    [scheduleSync],
  );

  const closeTab = useCallback(
    (tabId: string) => {
      pendingOpenRef.current.delete(tabId);
      setTabs((current) => {
        const result = closeBrowserTab(current, tabId, activeTabRef.current);
        setActiveTabId(result.activeId);
        activeTabRef.current = result.activeId;
        return result.tabs;
      });
      void siteViewClose(tabId).catch(reportError);
    },
    [reportError],
  );

  useEffect(() => {
    const closeActiveTab = () => {
      const tabId = activeTabRef.current;
      if (tabId) closeTab(tabId);
    };
    window.addEventListener(SITE_VIEW_CLOSE_ACTIVE_REQUEST_EVENT, closeActiveTab);
    return () =>
      window.removeEventListener(SITE_VIEW_CLOSE_ACTIVE_REQUEST_EVENT, closeActiveTab);
  }, [closeTab]);

  // ── user actions
  const activateSite = useCallback(
    (site: SiteEntry) => {
      persistSites(touchSiteUsage(sites, site.id));
      const existing = tabs.find((tab) => tab.siteId === site.id);
      if (existing) {
        activateTab(existing.id);
        if (existing.url !== site.url) {
          setTabs((current) => updateBrowserTab(current, existing.id, { url: site.url }));
          loadInTab(existing.id, site.url);
        }
        return;
      }
      // Reuse the active tab when it is still the empty starting tab.
      if (activeTab && !activeTab.siteId && !activeTab.url) {
        setTabs((current) =>
          updateBrowserTab(current, activeTab.id, { url: site.url, siteId: site.id }),
        );
        loadInTab(activeTab.id, site.url);
        return;
      }
      openInNewTab(site.url, site.id);
    },
    [activateTab, activeTab, loadInTab, openInNewTab, persistSites, sites, tabs],
  );

  const submitAddress = useCallback(() => {
    const normalized = normalizeSiteUrl(addressDraft);
    if (!normalized) {
      onError(t("sites.address.invalid"));
      return;
    }
    onError(null);
    if (activeTab) {
      setTabs((current) =>
        updateBrowserTab(current, activeTab.id, {
          url: normalized,
          siteId: null,
          loading: tauri,
        }),
      );
      loadInTab(activeTab.id, normalized);
    } else {
      openInNewTab(normalized, null);
    }
  }, [activeTab, addressDraft, loadInTab, onError, openInNewTab, t, tauri]);

  const deleteSite = useCallback(
    (site: SiteEntry) => {
      if (!window.confirm(t("sites.delete.confirm"))) return;
      persistSites(removeSite(sites, site.id));
      setTabs((current) =>
        current.map((tab) => (tab.siteId === site.id ? { ...tab, siteId: null } : tab)),
      );
    },
    [persistSites, sites, t],
  );

  const handleSaveSite = useCallback(
    (entry: SiteEntry) => {
      persistSites(upsertSite(sites, entry));
      const tab = tabs.find((item) => item.siteId === entry.id);
      if (tab && tab.url !== entry.url) {
        setTabs((current) => updateBrowserTab(current, tab.id, { url: entry.url }));
        loadInTab(tab.id, entry.url);
      }
    },
    [loadInTab, persistSites, sites, tabs],
  );

  const handleImport = useCallback(
    (entries: SiteEntry[]) => {
      let next = sites;
      for (const entry of entries) next = upsertSite(next, entry);
      persistSites(next);
    },
    [persistSites, sites],
  );

  /** Save the current page as a bookmark, or jump to the existing one. */
  const bookmarkCurrent = useCallback(() => {
    if (!activeTab?.url) return;
    const existing = sites.find((site) => site.url === activeTab.url);
    if (existing) {
      setEditSite(existing);
      return;
    }
    const entry: SiteEntry = {
      id: newSiteId(),
      label: activeTab.title?.trim() || new URL(activeTab.url).host,
      url: activeTab.url,
      category: null,
      favicon: null,
      localPath: null,
      devUrl: null,
      order: nextSiteOrder(sites),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      notes: null,
    };
    persistSites(upsertSite(sites, entry));
    setTabs((current) => updateBrowserTab(current, activeTab.id, { siteId: entry.id }));
  }, [activeTab, persistSites, sites]);

  const copyUrl = useCallback(() => {
    const url = activeTab?.url;
    if (!url) return;
    void clipboardWriteText(url)
      .then(() => {
        setCopied(true);
        if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(reportError);
  }, [activeTab, reportError]);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    };
  }, []);

  const openExternal = useCallback(
    (url?: string) => {
      const target = url ?? activeTab?.url;
      if (!target) return;
      void siteViewOpenExternal(target).catch(reportError);
    },
    [activeTab, reportError],
  );

  const navDisabled = !tauri || !activeTab || !siteViewTabRuntime(activeTab.id);
  const bookmarked = Boolean(
    activeTab?.url && sites.some((site) => site.url === activeTab.url),
  );

  return (
    <main className="sites-pane">
      <SitesSidebar
        sites={sites}
        query={query}
        categoryFilter={categoryFilter}
        activeSiteId={activeTab?.siteId ?? null}
        loaded={loaded}
        onQueryChange={setQuery}
        onCategoryFilterChange={setCategoryFilter}
        onSelect={activateSite}
        onOpenInNewTab={(site) => openInNewTab(site.url, site.id)}
        onOpenExternal={(site) => openExternal(site.url)}
        onCopyUrl={(site) => void clipboardWriteText(site.url).catch(reportError)}
        onReorder={(next) => persistSites(next)}
        onAdd={() => setNewSiteOpen(true)}
        onEdit={setEditSite}
        onDelete={deleteSite}
        onImport={() => setImportOpen(true)}
      />

      <section className="sites-browser">
        <div className="sites-tabstrip" role="tablist" aria-label={t("sites.tabs.label")}>
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={tab.id === activeTabId ? "sites-tab active" : "sites-tab"}
            >
              <button
                type="button"
                role="tab"
                aria-selected={tab.id === activeTabId}
                onClick={() => activateTab(tab.id)}
                title={tab.url}
              >
                {tab.loading ? (
                  <Loader2 size={12} className="spin" />
                ) : (
                  <Globe size={12} strokeWidth={1.8} />
                )}
                <span>{browserTabLabel(tab, t("sites.tabs.untitled"))}</span>
              </button>
              <button
                type="button"
                className="sites-tab-close"
                onClick={() => closeTab(tab.id)}
                title={t("sites.tabs.close")}
                aria-label={t("sites.tabs.close")}
              >
                <X size={11} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="icon-button sites-tab-new"
            onClick={() => openInNewTab("", null)}
            title={t("sites.tabs.new")}
            aria-label={t("sites.tabs.new")}
          >
            <Plus size={14} />
          </button>
        </div>

        <div className="sites-toolbar">
          <button
            type="button"
            className="icon-button"
            disabled={navDisabled}
            onClick={() => activeTab && void siteViewBack(activeTab.id).catch(reportError)}
            title={t("sites.toolbar.back")}
            aria-label={t("sites.toolbar.back")}
          >
            <ArrowLeft size={15} />
          </button>
          <button
            type="button"
            className="icon-button"
            disabled={navDisabled}
            onClick={() =>
              activeTab && void siteViewForward(activeTab.id).catch(reportError)
            }
            title={t("sites.toolbar.forward")}
            aria-label={t("sites.toolbar.forward")}
          >
            <ArrowRight size={15} />
          </button>
          <button
            type="button"
            className="icon-button"
            disabled={navDisabled}
            onClick={() =>
              activeTab && void siteViewReload(activeTab.id).catch(reportError)
            }
            title={t("sites.toolbar.reload")}
            aria-label={t("sites.toolbar.reload")}
          >
            <RotateCw size={15} />
          </button>

          <label className="sites-url">
            {activeTab?.loading ? (
              <Loader2 size={13} className="spin" />
            ) : (
              <Globe size={13} strokeWidth={1.8} />
            )}
            <input
              value={addressDraft}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              placeholder={t("sites.address.placeholder")}
              aria-label={t("sites.address.label")}
              onChange={(event) => setAddressDraft(event.target.value)}
              onFocus={(event) => {
                setAddressFocused(true);
                event.currentTarget.select();
              }}
              onBlur={() => {
                setAddressFocused(false);
                setAddressDraft(activeTab?.url ?? "");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.blur();
                  submitAddress();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setAddressDraft(activeTab?.url ?? "");
                  event.currentTarget.blur();
                }
              }}
            />
          </label>

          <button
            type="button"
            className={bookmarked ? "icon-button active" : "icon-button"}
            disabled={!activeTab?.url}
            onClick={bookmarkCurrent}
            title={bookmarked ? t("sites.bookmark.edit") : t("sites.bookmark.add")}
            aria-label={bookmarked ? t("sites.bookmark.edit") : t("sites.bookmark.add")}
          >
            <Star size={15} />
          </button>
          <button
            type="button"
            className="icon-button"
            disabled={!activeTab?.url}
            onClick={copyUrl}
            title={copied ? t("sites.toolbar.copied") : t("sites.toolbar.copyUrl")}
            aria-label={t("sites.toolbar.copyUrl")}
          >
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </button>
          <button
            type="button"
            className="icon-button"
            disabled={!activeTab?.url}
            onClick={() => openExternal()}
            title={t("sites.toolbar.openExternal")}
            aria-label={t("sites.toolbar.openExternal")}
          >
            <ExternalLink size={15} />
          </button>
        </div>

        {/* Measured spacer — the native child webview floats over this rect. */}
        <div className="sites-surface" ref={surfaceRef}>
          {!activeTab ? (
            <div className="sites-surface-hint">
              <Globe size={28} strokeWidth={1.6} />
              <p>{t("sites.placeholder.selectSite")}</p>
            </div>
          ) : !activeTab.url ? (
            <div className="sites-surface-hint">
              <Globe size={28} strokeWidth={1.6} />
              <p>{t("sites.placeholder.enterAddress")}</p>
            </div>
          ) : !tauri ? (
            <div className="sites-surface-hint">
              <Globe size={28} strokeWidth={1.6} />
              <p>{t("sites.placeholder.browserDev")}</p>
              <a href={activeTab.url} target="_blank" rel="noreferrer">
                {activeTab.url}
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
