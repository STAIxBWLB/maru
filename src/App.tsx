import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Clock3, RefreshCcw, X } from "lucide-react";
import { AddVaultDialog } from "./components/AddVaultDialog";
import { CommandPalette } from "./components/CommandPalette";
import { DocumentList } from "./components/DocumentList";
import { EditorPane, type EditorViewMode } from "./components/EditorPane";
import { NewDocumentDialog } from "./components/NewDocumentDialog";
import { OutlinePane } from "./components/OutlinePane";
import { Sidebar } from "./components/Sidebar";
import { VaultSwitcher } from "./components/VaultSwitcher";
import {
  addVault,
  createDocument,
  createVersion,
  getSampleVaultPath,
  listVaults,
  readDocument,
  removeVault,
  saveDocument,
  scanVault,
  setActiveVault,
  updateFrontmatterField,
} from "./lib/api";
import { LocaleContext, assertParityOrThrow, useLocaleState } from "./lib/i18n";
import { useKeyboardShortcuts } from "./lib/useKeyboardShortcuts";
import type { DocumentPayload, VaultEntry, VaultList } from "./lib/types";
import { resolveWikilinkTarget } from "./lib/wikilinkSuggestions";
import {
  emptyHistory,
  goBack,
  goForward,
  pushHistory,
  type NavHistory,
} from "./lib/neighborhoodHistory";

const LAST_OPEN_KEY = "anchor:lastOpenedNote:v1";
const RECENT_KEY = "anchor:recent:v1";
const OUTLINE_OPEN_KEY = "anchor:outlineOpen:v1";

assertParityOrThrow();

export default function App() {
  const localeValue = useLocaleState();
  const { t, locale, setLocale } = localeValue;

  const [vaultList, setVaultList] = useState<VaultList>({
    vaults: [],
    activeVault: null,
    hiddenDefaults: [],
  });
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [selectedEntry, setSelectedEntry] = useState<VaultEntry | null>(null);
  const [document, setDocument] = useState<DocumentPayload | null>(null);
  const [draftContent, setDraftContent] = useState("");
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newDocumentOpen, setNewDocumentOpen] = useState(false);
  const [addVaultOpen, setAddVaultOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [editorViewMode, setEditorViewMode] = useState<EditorViewMode>("edit");
  const [outlineOpen, setOutlineOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem(OUTLINE_OPEN_KEY) !== "0";
  });
  const [recentPaths, setRecentPaths] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem(RECENT_KEY);
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  });

  const searchInputRef = useRef<HTMLInputElement>(null);
  const editorTextareaRef = useRef<HTMLTextAreaElement>(null);

  // Monotonic counter so a slow readDocument from an earlier click cannot
  // overwrite the editor with stale content if the user clicked a later
  // entry in the meantime. Only the latest call wins.
  const selectRequestRef = useRef(0);
  // Holds the discarded draft + entry when the user switches away from a
  // dirty document. Surfaces a "Restore" toast button — non-blocking
  // alternative to window.confirm (which Tauri webview suppresses).
  const [discardedEdit, setDiscardedEdit] = useState<
    { entry: VaultEntry; draft: string } | null
  >(null);

  // Wikilink navigation stack — ⌘[ back / ⌘] forward. In-memory only; tolaria
  // persists this but Phase 1A keeps it ephemeral.
  const [navHistory, setNavHistory] = useState<NavHistory>(emptyHistory);
  // Set to true by navigateBack/Forward to suppress the auto history push
  // inside selectEntry — those paths manage history manually.
  const skipNextHistoryPushRef = useRef(false);

  const activeVaultPath = vaultList.activeVault;
  const activeVault = useMemo(
    () => vaultList.vaults.find((v) => v.path === activeVaultPath) ?? null,
    [vaultList, activeVaultPath],
  );
  const dirty = useMemo(
    () => Boolean(document && draftContent !== document.content),
    [document, draftContent],
  );

  const recentEntries = useMemo(() => {
    const byPath = new Map(entries.map((e) => [e.path, e] as const));
    const out: VaultEntry[] = [];
    for (const path of recentPaths) {
      const entry = byPath.get(path);
      if (entry) out.push(entry);
      if (out.length >= 8) break;
    }
    return out;
  }, [entries, recentPaths]);

  const lastOpenKeyForVault = useCallback((path: string) => `${LAST_OPEN_KEY}:${path}`, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(OUTLINE_OPEN_KEY, outlineOpen ? "1" : "0");
  }, [outlineOpen]);

  const pushRecent = useCallback((path: string) => {
    setRecentPaths((prev) => {
      const next = [path, ...prev.filter((p) => p !== path)].slice(0, 16);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      }
      return next;
    });
  }, []);

  const loadVault = useCallback(
    async (path: string, preferRelPath: string | null = null) => {
      setLoading(true);
      setError(null);
      try {
        const nextEntries = await scanVault(path);
        setEntries(nextEntries);

        const target = preferRelPath
          ? nextEntries.find(
              (entry) => entry.relPath === preferRelPath || entry.path === preferRelPath,
            )
          : null;
        const candidate = target ?? nextEntries[0] ?? null;
        if (candidate) {
          setSelectedEntry(candidate);
          const payload = await readDocument(path, candidate.path);
          setDocument(payload);
          setDraftContent(payload.content);
          if (typeof window !== "undefined") {
            window.localStorage.setItem(lastOpenKeyForVault(path), candidate.relPath);
          }
          pushRecent(candidate.path);
        } else {
          setSelectedEntry(null);
          setDocument(null);
          setDraftContent("");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [lastOpenKeyForVault, pushRecent],
  );

  const switchActiveVault = useCallback(
    async (path: string) => {
      try {
        const list = await setActiveVault(path);
        setVaultList(list);
        const lastRel =
          typeof window !== "undefined"
            ? window.localStorage.getItem(lastOpenKeyForVault(path))
            : null;
        await loadVault(path, lastRel);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [loadVault, lastOpenKeyForVault],
  );

  // Boot: load registry, fall back to sample vault if empty.
  useEffect(() => {
    async function boot() {
      try {
        const list = await listVaults();
        if (list.vaults.length === 0) {
          const samplePath = await getSampleVaultPath();
          const seeded = await addVault("Sample", samplePath, null);
          setVaultList(seeded);
          if (seeded.activeVault) {
            await loadVault(seeded.activeVault);
          } else {
            setLoading(false);
          }
          return;
        }
        setVaultList(list);
        if (list.activeVault) {
          const lastRel =
            typeof window !== "undefined"
              ? window.localStorage.getItem(lastOpenKeyForVault(list.activeVault))
              : null;
          await loadVault(list.activeVault, lastRel);
        } else if (list.vaults[0]) {
          // Vaults exist but none active — auto-pick the first to avoid the
          // confusing "no vaults registered" empty-state in the topbar.
          await switchActiveVault(list.vaults[0].path);
        } else {
          setLoading(false);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    }
    void boot();
    // boot only once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleAddVault = useCallback(
    async (label: string, path: string, externalWriter: string | null) => {
      const list = await addVault(label, path, externalWriter);
      setVaultList(list);
      if (list.activeVault === path) {
        await loadVault(path);
      }
    },
    [loadVault],
  );

  const handleRemoveVault = useCallback(
    async (path: string) => {
      const confirmation = window.confirm(`${path}\n\n${t("vault.remove.confirm")}`);
      if (!confirmation) return;
      const list = await removeVault(path);
      setVaultList(list);
      if (list.activeVault) {
        await loadVault(list.activeVault);
      } else {
        setEntries([]);
        setSelectedEntry(null);
        setDocument(null);
        setDraftContent("");
      }
    },
    [loadVault, t],
  );

  const useSampleVault = useCallback(async () => {
    try {
      const samplePath = await getSampleVaultPath();
      const exists = vaultList.vaults.find((v) => v.path === samplePath);
      if (!exists) {
        await handleAddVault("Sample", samplePath, null);
      } else {
        await switchActiveVault(samplePath);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [vaultList.vaults, handleAddVault, switchActiveVault]);

  const selectEntry = useCallback(
    async (entry: VaultEntry) => {
      if (!activeVaultPath) return false;
      // Same entry re-clicked → no-op (avoid redundant fetch + cursor jump).
      if (selectedEntry?.path === entry.path) return true;

      // If the current draft has unsaved edits, stash them so the user can
      // restore via the toast action. Replaces the prior window.confirm
      // dialog which Tauri webview was silently suppressing.
      if (document && draftContent !== document.content) {
        setDiscardedEdit({
          entry: selectedEntry ?? { ...entry, path: document.path, relPath: document.relPath } as VaultEntry,
          draft: draftContent,
        });
      } else {
        setDiscardedEdit(null);
      }

      const reqId = ++selectRequestRef.current;
      // Push the *previous* selection onto history before we replace it.
      // Skip when navigateBack/Forward is the caller — they manage manually.
      const skipHistoryPush = skipNextHistoryPushRef.current;
      skipNextHistoryPushRef.current = false;
      if (!skipHistoryPush && selectedEntry && selectedEntry.path !== entry.path) {
        setNavHistory((h) => pushHistory(h, selectedEntry.path));
      }
      setError(null);
      try {
        const payload = await readDocument(activeVaultPath, entry.path);
        // Drop stale responses — a later click already superseded this one.
        if (reqId !== selectRequestRef.current) return false;
        setSelectedEntry(entry);
        setDocument(payload);
        setDraftContent(payload.content);
        if (typeof window !== "undefined") {
          window.localStorage.setItem(lastOpenKeyForVault(activeVaultPath), entry.relPath);
        }
        pushRecent(entry.path);
        return true;
      } catch (err) {
        if (reqId !== selectRequestRef.current) return false;
        setError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [activeVaultPath, selectedEntry, document, draftContent, lastOpenKeyForVault, pushRecent],
  );

  const navigateBack = useCallback(() => {
    if (!selectedEntry) return;
    const { history, target } = goBack(navHistory, selectedEntry.path);
    if (!target) return;
    const entry = entries.find((e) => e.path === target);
    if (!entry) return;
    setNavHistory(history);
    skipNextHistoryPushRef.current = true;
    void selectEntry(entry);
  }, [selectedEntry, navHistory, entries, selectEntry]);

  const navigateForward = useCallback(() => {
    if (!selectedEntry) return;
    const { history, target } = goForward(navHistory, selectedEntry.path);
    if (!target) return;
    const entry = entries.find((e) => e.path === target);
    if (!entry) return;
    setNavHistory(history);
    skipNextHistoryPushRef.current = true;
    void selectEntry(entry);
  }, [selectedEntry, navHistory, entries, selectEntry]);

  const restoreDiscardedEdit = useCallback(async () => {
    if (!discardedEdit || !activeVaultPath) return;
    const reqId = ++selectRequestRef.current;
    try {
      const payload = await readDocument(activeVaultPath, discardedEdit.entry.path);
      if (reqId !== selectRequestRef.current) return;
      setSelectedEntry(discardedEdit.entry);
      setDocument(payload);
      // Restore the draft text the user had typed, not the on-disk content.
      setDraftContent(discardedEdit.draft);
      setDiscardedEdit(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [discardedEdit, activeVaultPath]);

  const saveCurrent = useCallback(async () => {
    if (!document || !dirty || !activeVaultPath) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await saveDocument(activeVaultPath, document.path, draftContent);
      setDocument(saved);
      setDraftContent(saved.content);
      const fresh = await scanVault(activeVaultPath);
      setEntries(fresh);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [document, dirty, activeVaultPath, draftContent]);

  const snapshotCurrent = useCallback(async () => {
    if (!document || !activeVaultPath) return;
    setError(null);
    try {
      const snapshot = await createVersion(
        activeVaultPath,
        document.path,
        document.title,
        draftContent,
        t("snapshot.summary"),
      );
      const fresh = await scanVault(activeVaultPath);
      setEntries(fresh);
      setError(t("snapshot.success", { path: snapshot.relPath }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [document, activeVaultPath, draftContent, t]);

  const createNew = useCallback(
    async (title: string, docType: string, body: string) => {
      if (!activeVaultPath) return;
      const created = await createDocument(activeVaultPath, title, docType, body);
      await loadVault(activeVaultPath, created.relPath);
    },
    [activeVaultPath, loadVault],
  );

  const handleWikilinkClick = useCallback(
    (target: string) => {
      const resolved = resolveWikilinkTarget(entries, target);
      if (resolved) {
        void selectEntry(resolved);
      } else {
        // Phase 1A: unresolved wikilinks just surface a soft notice. "Create
        // new note" lands in Phase 1B alongside multi-tab + BlockNote.
        setError(t("wikilink.notFound", { target }));
      }
    },
    [entries, selectEntry, t],
  );

  const updateField = useCallback(
    async (key: string, value: string | string[] | number | boolean | null) => {
      if (!document || !activeVaultPath) return;
      try {
        const next = await updateFrontmatterField(activeVaultPath, document.path, key, value);
        setDocument(next);
        // Refresh draft only when there are no unsaved body edits — never
        // clobber the textarea with an inspector-driven write.
        if (draftContent === document.content) {
          setDraftContent(next.content);
        }
        const fresh = await scanVault(activeVaultPath);
        setEntries(fresh);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [document, activeVaultPath, draftContent],
  );

  const refreshCurrent = useCallback(async () => {
    if (!activeVaultPath) return;
    const lastRel =
      typeof window !== "undefined"
        ? window.localStorage.getItem(lastOpenKeyForVault(activeVaultPath))
        : null;
    await loadVault(activeVaultPath, lastRel);
  }, [activeVaultPath, lastOpenKeyForVault, loadVault]);

  const focusSearch = useCallback(() => {
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  }, []);

  const jumpToOutlineLine = useCallback((line: number) => {
    const ta = editorTextareaRef.current;
    if (!ta) return;
    const lines = ta.value.split("\n");
    let pos = 0;
    for (let i = 0; i < line && i < lines.length; i++) pos += lines[i].length + 1;
    ta.focus();
    ta.setSelectionRange(pos, pos + (lines[line]?.length ?? 0));
    // Scroll the line into view.
    const lineHeight = parseFloat(getComputedStyle(ta).lineHeight || "20");
    ta.scrollTop = Math.max(0, line * lineHeight - ta.clientHeight / 3);
  }, []);

  const runCommand = useCallback(
    (id: string) => {
      switch (id) {
        case "new-document":
          setNewDocumentOpen(true);
          break;
        case "save":
          void saveCurrent();
          break;
        case "snapshot":
          void snapshotCurrent();
          break;
        case "toggle-preview":
          setEditorViewMode((mode) => (mode === "edit" ? "preview" : "edit"));
          break;
        case "toggle-outline":
          setOutlineOpen((v) => !v);
          break;
        case "toggle-locale":
          setLocale(locale === "ko" ? "en" : "ko");
          break;
        case "refresh-vault":
          void refreshCurrent();
          break;
        case "add-vault":
          setAddVaultOpen(true);
          break;
      }
    },
    [saveCurrent, snapshotCurrent, refreshCurrent, locale, setLocale],
  );

  useKeyboardShortcuts(
    {
      "mod+s": () => void saveCurrent(),
      "mod+shift+s": () => void snapshotCurrent(),
      "mod+n": () => setNewDocumentOpen(true),
      "mod+k": () => setCommandPaletteOpen((v) => !v),
      "mod+p": () => setEditorViewMode((mode) => (mode === "edit" ? "preview" : "edit")),
      "mod+\\": () => setOutlineOpen((v) => !v),
      "mod+f": focusSearch,
      "mod+r": () => void refreshCurrent(),
      "mod+shift+l": () => setLocale(locale === "ko" ? "en" : "ko"),
      "mod+[": navigateBack,
      "mod+]": navigateForward,
    },
    [saveCurrent, snapshotCurrent, refreshCurrent, focusSearch, locale, setLocale, navigateBack, navigateForward],
  );

  const shellClass = `app-shell${outlineOpen ? "" : " outline-closed"}`;

  return (
    <LocaleContext.Provider value={localeValue}>
      <div className={shellClass}>
        <header className="topbar">
          <div className="brand-mark" aria-hidden="true">
            A
          </div>
          <div className="brand-name">
            {t("app.title")} <span>{t("app.subtitle.work")}</span>
          </div>
          <div style={{ width: 14 }} />
          <VaultSwitcher
            vaultList={vaultList}
            activeVaultPath={activeVaultPath}
            onSelectVault={switchActiveVault}
            onAddVault={() => setAddVaultOpen(true)}
            onRemoveVault={handleRemoveVault}
            onUseSample={useSampleVault}
          />

          <div className="topbar-spacer" />

          <button
            type="button"
            className="topbar-pill"
            onClick={() => setCommandPaletteOpen(true)}
            title={t("cmdk.openHint")}
          >
            <span style={{ opacity: 0.55 }}>{t("sidebar.commandPalette")}</span>
            <span className="kbd">⌘</span>
            <span className="kbd">K</span>
          </button>
          <button
            type="button"
            className="topbar-pill"
            onClick={() => setLocale(locale === "ko" ? "en" : "ko")}
            title={t("app.locale.label")}
            aria-label={t("app.locale.label")}
          >
            {t(locale === "ko" ? "app.locale.ko" : "app.locale.en")}
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => void refreshCurrent()}
            title={t("app.refresh")}
            aria-label={t("app.refresh")}
          >
            <RefreshCcw size={14} />
          </button>
        </header>

        <Sidebar
          entries={entries}
          recentEntries={recentEntries}
          selectedPath={selectedEntry?.path ?? null}
          typeFilter={typeFilter}
          onTypeFilter={setTypeFilter}
          onNewDocument={() => setNewDocumentOpen(true)}
          onSelectRecent={selectEntry}
          onOpenCommandPalette={() => setCommandPaletteOpen(true)}
        />

        <DocumentList
          entries={entries}
          selectedPath={selectedEntry?.path ?? null}
          query={query}
          loading={loading}
          typeFilter={typeFilter}
          onQueryChange={setQuery}
          onSelect={selectEntry}
          searchInputRef={searchInputRef}
        />

        <EditorPane
          document={document}
          draftContent={draftContent}
          saving={saving}
          dirty={dirty}
          outlineOpen={outlineOpen}
          activeVaultLabel={activeVault?.label ?? null}
          viewMode={editorViewMode}
          entries={entries}
          onChange={setDraftContent}
          onSave={saveCurrent}
          onSnapshot={snapshotCurrent}
          onToggleOutline={() => setOutlineOpen((v) => !v)}
          onViewModeChange={setEditorViewMode}
          onWikilinkClick={handleWikilinkClick}
          textareaRef={editorTextareaRef}
        />

        {outlineOpen ? (
          <OutlinePane
            document={document}
            draftContent={draftContent}
            entries={entries}
            onJumpToLine={jumpToOutlineLine}
            onClose={() => setOutlineOpen(false)}
            onUpdateField={updateField}
            onSelectEntry={selectEntry}
            onMissingWikilink={handleWikilinkClick}
          />
        ) : null}

        <div className="toast-stack">
          {error ? (
            <div
              className={
                error.startsWith(t("snapshot.success", { path: "" }).slice(0, 4))
                  ? "toast notice"
                  : "toast"
              }
            >
              <AlertTriangle size={15} />
              <span>{error}</span>
              <button
                type="button"
                className="icon-button"
                onClick={() => setError(null)}
                aria-label={t("app.errorClose")}
                title={t("app.errorClose")}
              >
                <X size={14} />
              </button>
            </div>
          ) : null}

          {discardedEdit ? (
            <div className="toast notice">
              <Clock3 size={15} />
              <span>
                {t("toast.discardedEdit", { title: discardedEdit.entry.title })}
              </span>
              <button
                type="button"
                className="button button-ghost button-sm"
                onClick={() => void restoreDiscardedEdit()}
              >
                {t("toast.restore")}
              </button>
              <button
                type="button"
                className="icon-button"
                onClick={() => setDiscardedEdit(null)}
                aria-label={t("app.errorClose")}
                title={t("app.errorClose")}
              >
                <X size={14} />
              </button>
            </div>
          ) : null}
        </div>

        <NewDocumentDialog
          open={newDocumentOpen}
          onOpenChange={setNewDocumentOpen}
          onCreate={createNew}
        />
        <AddVaultDialog
          open={addVaultOpen}
          onOpenChange={setAddVaultOpen}
          onAdd={handleAddVault}
        />
        <CommandPalette
          open={commandPaletteOpen}
          entries={entries}
          onClose={() => setCommandPaletteOpen(false)}
          onSelectEntry={selectEntry}
          onRunCommand={runCommand}
        />
      </div>
    </LocaleContext.Provider>
  );
}
