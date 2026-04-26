import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, RefreshCcw } from "lucide-react";
import { AddVaultDialog } from "./components/AddVaultDialog";
import { DocumentList } from "./components/DocumentList";
import { EditorPane } from "./components/EditorPane";
import { LocaleToggle } from "./components/LocaleToggle";
import { NewDocumentDialog } from "./components/NewDocumentDialog";
import { Sidebar } from "./components/Sidebar";
import { Button } from "./components/ui/Button";
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
} from "./lib/api";
import { LocaleContext, assertParityOrThrow, useLocaleState } from "./lib/i18n";
import type { DocumentPayload, VaultEntry, VaultList } from "./lib/types";

const LAST_OPEN_KEY = "anchor:lastOpenedNote:v1";

// Fail loudly on locale parity drift. ko/en are equal first-class — every
// key must exist in both dictionaries. Throws at module load if not.
assertParityOrThrow();

export default function App() {
  const localeValue = useLocaleState();
  const { t } = localeValue;

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
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newDocumentOpen, setNewDocumentOpen] = useState(false);
  const [addVaultOpen, setAddVaultOpen] = useState(false);

  const activeVaultPath = vaultList.activeVault;
  const dirty = useMemo(
    () => Boolean(document && draftContent !== document.content),
    [document, draftContent],
  );

  const lastOpenKeyForVault = useCallback(
    (path: string) => `${LAST_OPEN_KEY}:${path}`,
    [],
  );

  const loadVault = useCallback(
    async (path: string, preferRelPath: string | null = null) => {
      setLoading(true);
      setError(null);
      try {
        const nextEntries = await scanVault(path);
        setEntries(nextEntries);

        const target = preferRelPath
          ? nextEntries.find((entry) => entry.relPath === preferRelPath || entry.path === preferRelPath)
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
    [lastOpenKeyForVault],
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
          // Seed registry with the bundled sample vault on first run so the
          // user has something to open before they pick their own folder.
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

  async function handleAddVault(label: string, path: string, externalWriter: string | null) {
    const list = await addVault(label, path, externalWriter);
    setVaultList(list);
    if (list.activeVault === path) {
      await loadVault(path);
    }
  }

  async function handleRemoveVault(path: string) {
    const confirmation = window.confirm(`${path}\n\n${t("vault.dialog.confirm")}?`);
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
  }

  async function useSampleVault() {
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
  }

  async function selectEntry(entry: VaultEntry) {
    if (!activeVaultPath) return;
    if (dirty && !window.confirm(t("app.confirmUnsaved"))) return;
    setSelectedEntry(entry);
    setError(null);
    try {
      const payload = await readDocument(activeVaultPath, entry.path);
      setDocument(payload);
      setDraftContent(payload.content);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(lastOpenKeyForVault(activeVaultPath), entry.relPath);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function saveCurrent() {
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
  }

  async function snapshotCurrent() {
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
  }

  async function createNew(title: string, docType: string, body: string) {
    if (!activeVaultPath) return;
    const created = await createDocument(activeVaultPath, title, docType, body);
    await loadVault(activeVaultPath, created.relPath);
  }

  async function refreshCurrent() {
    if (!activeVaultPath) return;
    const lastRel =
      typeof window !== "undefined"
        ? window.localStorage.getItem(lastOpenKeyForVault(activeVaultPath))
        : null;
    await loadVault(activeVaultPath, lastRel);
  }

  return (
    <LocaleContext.Provider value={localeValue}>
      <div className="app-shell ai-closed">
        <Sidebar
          vaultList={vaultList}
          activeVaultPath={activeVaultPath}
          onSelectVault={switchActiveVault}
          onAddVault={() => setAddVaultOpen(true)}
          onRemoveVault={handleRemoveVault}
          onUseSample={useSampleVault}
          onNewDocument={() => setNewDocumentOpen(true)}
        />

        <DocumentList
          entries={entries}
          selectedPath={selectedEntry?.path ?? null}
          query={query}
          loading={loading}
          onQueryChange={setQuery}
          onSelect={selectEntry}
        />

        <EditorPane
          document={document}
          draftContent={draftContent}
          saving={saving}
          dirty={dirty}
          onChange={setDraftContent}
          onSave={saveCurrent}
          onSnapshot={snapshotCurrent}
        />

        <div className="locale-floating">
          <LocaleToggle />
        </div>

        {error ? (
          <div className={error.startsWith(t("snapshot.success", { path: "" }).slice(0, 4)) ? "toast notice" : "toast"}>
            <AlertTriangle size={15} />
            <span>{error}</span>
            <Button size="sm" variant="ghost" onClick={() => setError(null)}>
              {t("app.errorClose")}
            </Button>
          </div>
        ) : null}

        <button
          className="floating-refresh"
          title={t("app.refresh")}
          onClick={() => void refreshCurrent()}
        >
          <RefreshCcw size={16} />
        </button>

        <NewDocumentDialog
          open={newDocumentOpen}
          onOpenChange={setNewDocumentOpen}
          onCreate={createNew}
        />
        <AddVaultDialog open={addVaultOpen} onOpenChange={setAddVaultOpen} onAdd={handleAddVault} />
      </div>
    </LocaleContext.Provider>
  );
}
