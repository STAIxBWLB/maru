import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Clock3, RefreshCcw, X } from "lucide-react";
import { AddVaultDialog } from "./components/AddVaultDialog";
import { CommandPalette } from "./components/CommandPalette";
import { CommitDialog } from "./components/CommitDialog";
import { DocumentList } from "./components/DocumentList";
import { EditorPane, type EditorViewMode } from "./components/EditorPane";
import { GitStatusBadge } from "./components/GitStatusBadge";
import { InboxPane } from "./components/InboxPane";
import { NewDocumentDialog } from "./components/NewDocumentDialog";
import { OutlinePane } from "./components/OutlinePane";
import { Sidebar } from "./components/Sidebar";
import { SystemPane } from "./components/SystemPane";
import { VaultSwitcher } from "./components/VaultSwitcher";
import {
  addVault,
  createDocument,
  createVersion,
  fetchGmailUnread,
  getSampleVaultPath,
  listVaults,
  readDocument,
  removeVault,
  saveDocument,
  scanInboxDrop,
  scanVault,
  setActiveVault,
  startInboxWatcher,
  stopInboxWatcher,
  updateFrontmatterField,
} from "./lib/api";
import { registerWorkspacePair, updateAnchorWorkspace } from "./lib/anchorDir";
import { classifyInboxItem } from "./lib/aiInvoke";
import { buildGmailMessageStates, type GmailMessageState } from "./lib/gmail";
import { LocaleContext, assertParityOrThrow, useLocaleState } from "./lib/i18n";
import {
  buildInboxItemStates,
  type InboxDecision,
  type InboxItemState,
} from "./lib/inbox";
import { useKeyboardShortcuts } from "./lib/useKeyboardShortcuts";
import type {
  DocumentPayload,
  GitStatus,
  GmailMessage,
  InboxClassification,
  InboxDropItem,
  VaultEntry,
  VaultList,
} from "./lib/types";
import { resolveWikilinkTarget } from "./lib/wikilinkSuggestions";
import {
  emptyHistory,
  goBack,
  goForward,
  pushHistory,
  type NavHistory,
} from "./lib/neighborhoodHistory";

const LAST_OPEN_KEY = "anchor:lastOpenedNote:v1";
const OPEN_TABS_KEY = "anchor:openTabs:v1";
const RECENT_KEY = "anchor:recent:v1";
const OUTLINE_OPEN_KEY = "anchor:outlineOpen:v1";

assertParityOrThrow();

interface EditorTab {
  id: string;
  entry: VaultEntry;
  document: DocumentPayload;
  draftContent: string;
}

interface StoredTabs {
  activeRelPath: string | null;
  relPaths: string[];
}

type AppMode = "pkm" | "inbox" | "system";

interface InboxCarry {
  decision: InboxDecision;
  classification: InboxClassification | null;
  classifying: boolean;
  classifyError: string | null;
}

function tabIdForEntry(entry: VaultEntry): string {
  return entry.path;
}

function titleFromWikilinkTarget(target: string): string {
  const cleaned = target.trim().replace(/\.(md|markdown)$/i, "");
  const leaf = cleaned.split("/").filter(Boolean).pop();
  return leaf ?? cleaned;
}

export default function App() {
  const localeValue = useLocaleState();
  const { t, locale, setLocale } = localeValue;

  const [vaultList, setVaultList] = useState<VaultList>({
    vaults: [],
    activeVault: null,
    hiddenDefaults: [],
  });
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newDocumentOpen, setNewDocumentOpen] = useState(false);
  const [newDocumentSeed, setNewDocumentSeed] = useState<{
    title: string;
    relPath: string | null;
  } | null>(null);
  const [addVaultOpen, setAddVaultOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [editorViewMode, setEditorViewMode] = useState<EditorViewMode>("rich");
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
  // Bump on save/snapshot/vault-switch/refresh so the GitStatusBadge re-polls.
  const [gitRefreshTick, setGitRefreshTick] = useState(0);
  // CommitDialog state — the badge passes the most recent GitStatus so the
  // dialog can show the file counts at the moment the user clicked.
  const [commitDialog, setCommitDialog] = useState<GitStatus | null>(null);

  // Phase 2 inbox surface. Polling scan + notify watcher feed
  // `inboxItems`; per-item classifier output is carried alongside the
  // raw drop item via the InboxItemState shape.
  const [appMode, setAppMode] = useState<AppMode>("pkm");
  const [inboxDrops, setInboxDrops] = useState<InboxDropItem[]>([]);
  const [inboxLoading, setInboxLoading] = useState(false);
  const [inboxCarry, setInboxCarry] = useState<Map<string, InboxCarry>>(() => new Map());

  // Gmail surface (gws CLI). Sibling section in InboxPane; lives in
  // memory only — accept/reject decisions are not yet propagated back
  // to Gmail labels (follow-up). Empty `gmailError` distinguishes "not
  // yet fetched" from "fetched, no unread".
  const [gmailMessages, setGmailMessages] = useState<GmailMessage[]>([]);
  const [gmailLoading, setGmailLoading] = useState(false);
  const [gmailError, setGmailError] = useState<string | null>(null);
  const [gmailDecisions, setGmailDecisions] = useState<Map<string, InboxDecision>>(
    () => new Map(),
  );

  const activeVaultPath = vaultList.activeVault;
  const resolvedActiveTabId = activeTabId ?? tabs[0]?.id ?? null;
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === resolvedActiveTabId) ?? null,
    [tabs, resolvedActiveTabId],
  );
  const selectedEntry = activeTab?.entry ?? null;
  const document = activeTab?.document ?? null;
  const draftContent = activeTab?.draftContent ?? "";
  const activeVault = useMemo(
    () => vaultList.vaults.find((v) => v.path === activeVaultPath) ?? null,
    [vaultList, activeVaultPath],
  );
  const activeVaultExternalWriter = activeVault?.externalWriter ?? null;
  const activeVaultReadOnly = activeVaultExternalWriter != null;

  // System mode is gated on "this vault is the work half of a paired
  // workspace". The work_path is the vault's own path; for vault-half
  // entries (mcp-obsidian) the System tab is hidden — vault halves
  // never carry a `.anchor/` of their own.
  const systemWorkPath = useMemo(() => {
    if (!activeVault) return null;
    if (activeVault.role === "work") return activeVault.path;
    return null;
  }, [activeVault]);
  const systemEnabled = systemWorkPath != null;
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
  const openTabsKeyForVault = useCallback((path: string) => `${OPEN_TABS_KEY}:${path}`, []);

  const readStoredTabsForVault = useCallback(
    (path: string): StoredTabs | null => {
      if (typeof window === "undefined") return null;
      try {
        const raw = window.localStorage.getItem(openTabsKeyForVault(path));
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<StoredTabs>;
        const relPaths = Array.isArray(parsed.relPaths)
          ? parsed.relPaths.filter((value): value is string => typeof value === "string")
          : [];
        return {
          activeRelPath:
            typeof parsed.activeRelPath === "string" ? parsed.activeRelPath : null,
          relPaths,
        };
      } catch {
        return null;
      }
    },
    [openTabsKeyForVault],
  );

  const updateActiveTab = useCallback(
    (updater: (tab: EditorTab) => EditorTab) => {
      if (!resolvedActiveTabId) return;
      setTabs((prev) =>
        prev.map((tab) => (tab.id === resolvedActiveTabId ? updater(tab) : tab)),
      );
    },
    [resolvedActiveTabId],
  );

  const setDraftContent = useCallback(
    (content: string) => {
      updateActiveTab((tab) => ({ ...tab, draftContent: content }));
    },
    [updateActiveTab],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(OUTLINE_OPEN_KEY, outlineOpen ? "1" : "0");
  }, [outlineOpen]);

  // If the active vault loses its work-role (e.g. user switches to a
  // standalone vault while System mode was active), drop back to PKM.
  // Otherwise the empty "system not available" placeholder lingers.
  useEffect(() => {
    if (appMode === "system" && !systemEnabled) {
      setAppMode("pkm");
    }
  }, [appMode, systemEnabled]);

  // Best-effort persistence of the chosen mode into .anchor/workspace.json.
  // Failures are silent — this is a UX nicety, not a correctness concern.
  useEffect(() => {
    if (!systemWorkPath) return;
    void updateAnchorWorkspace(systemWorkPath, { lastActiveMode: appMode }).catch(() => {});
  }, [appMode, systemWorkPath]);

  useEffect(() => {
    if (typeof window === "undefined" || !activeVaultPath) return;
    const tabsBelongToActiveVault = tabs.every(
      (tab) => tab.entry.path === activeVaultPath || tab.entry.path.startsWith(`${activeVaultPath}/`),
    );
    if (!tabsBelongToActiveVault) return;
    if (tabs.length === 0) {
      window.localStorage.removeItem(openTabsKeyForVault(activeVaultPath));
      return;
    }
    window.localStorage.setItem(
      openTabsKeyForVault(activeVaultPath),
      JSON.stringify({
        activeRelPath: activeTab?.entry.relPath ?? null,
        relPaths: tabs.map((tab) => tab.entry.relPath),
      } satisfies StoredTabs),
    );
    if (activeTab) {
      window.localStorage.setItem(lastOpenKeyForVault(activeVaultPath), activeTab.entry.relPath);
    }
  }, [activeVaultPath, activeTab, tabs, lastOpenKeyForVault, openTabsKeyForVault]);

  const pushRecent = useCallback((path: string) => {
    setRecentPaths((prev) => {
      const next = [path, ...prev.filter((p) => p !== path)].slice(0, 16);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      }
      return next;
    });
  }, []);

  const inboxItems = useMemo<InboxItemState[]>(
    () => buildInboxItemStates(inboxDrops, inboxCarry),
    [inboxDrops, inboxCarry],
  );

  const gmailItems = useMemo<GmailMessageState[]>(
    () => buildGmailMessageStates(gmailMessages, gmailDecisions),
    [gmailMessages, gmailDecisions],
  );

  const refreshGmail = useCallback(async () => {
    setGmailLoading(true);
    setGmailError(null);
    try {
      const messages = await fetchGmailUnread(20);
      setGmailMessages(messages);
    } catch (err) {
      setGmailError(err instanceof Error ? err.message : String(err));
    } finally {
      setGmailLoading(false);
    }
  }, []);

  const decideGmailItem = useCallback((id: string, decision: InboxDecision) => {
    setGmailDecisions((prev) => {
      const next = new Map(prev);
      next.set(id, decision);
      return next;
    });
  }, []);

  const refreshInbox = useCallback(async () => {
    if (!activeVaultPath) {
      setInboxDrops([]);
      return;
    }
    setInboxLoading(true);
    setError(null);
    try {
      setInboxDrops(await scanInboxDrop(activeVaultPath));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInboxLoading(false);
    }
  }, [activeVaultPath]);

  const updateInboxCarry = useCallback(
    (id: string, patch: Partial<InboxCarry>) => {
      setInboxCarry((prev) => {
        const next = new Map(prev);
        const current: InboxCarry = next.get(id) ?? {
          decision: "pending",
          classification: null,
          classifying: false,
          classifyError: null,
        };
        next.set(id, { ...current, ...patch });
        return next;
      });
    },
    [],
  );

  const decideInboxItem = useCallback(
    (id: string, decision: InboxDecision) => {
      updateInboxCarry(id, { decision });
    },
    [updateInboxCarry],
  );

  const classifyItem = useCallback(
    async (id: string) => {
      const target = inboxDrops.find((drop) => drop.id === id);
      if (!target) return;
      updateInboxCarry(id, { classifying: true, classifyError: null });
      try {
        const classification = await classifyInboxItem(target);
        updateInboxCarry(id, { classifying: false, classification });
      } catch (err) {
        updateInboxCarry(id, {
          classifying: false,
          classifyError: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [inboxDrops, updateInboxCarry],
  );

  // First entry into Inbox mode triggers a Gmail fetch. Subsequent
  // refreshes are user-driven via the refresh button / ⌘R.
  useEffect(() => {
    if (appMode !== "inbox") return;
    if (gmailMessages.length > 0 || gmailLoading) return;
    void refreshGmail();
    // Only refire on appMode transitions, not on gmail state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appMode]);

  // Initial scan + watcher subscription, scoped to the active vault.
  // The watcher overlays the polling baseline: any file_event triggers
  // a re-scan rather than a delta apply, which keeps the UI source of
  // truth a single `scan_inbox_drop` snapshot.
  useEffect(() => {
    if (!activeVaultPath) {
      setInboxDrops([]);
      return;
    }
    let cancelled = false;
    let unlistenFileEvent: (() => void) | null = null;

    void (async () => {
      // Cold scan first — watcher only catches subsequent events.
      void refreshInbox();

      try {
        await startInboxWatcher(activeVaultPath);
      } catch (err) {
        // Most likely cause: <vault>/inbox/downloads doesn't exist yet.
        // Surface a soft notice but keep polling functional.
        if (!cancelled) {
          // eslint-disable-next-line no-console
          console.info("[anchor] inbox watcher not started:", err);
        }
        return;
      }

      try {
        const { listen } = await import("@tauri-apps/api/event");
        const off = await listen("inbox://file_event", () => {
          if (!cancelled) void refreshInbox();
        });
        if (cancelled) {
          off();
        } else {
          unlistenFileEvent = off;
        }
      } catch (err) {
        // Browser dev shell — `@tauri-apps/api/event` may not be wired.
        // eslint-disable-next-line no-console
        console.info("[anchor] inbox event listener unavailable:", err);
      }
    })();

    return () => {
      cancelled = true;
      if (unlistenFileEvent) unlistenFileEvent();
      void stopInboxWatcher().catch(() => {
        // best-effort
      });
    };
  }, [activeVaultPath, refreshInbox]);

  const loadVault = useCallback(
    async (path: string, preferRelPath: string | null = null) => {
      setLoading(true);
      setError(null);
      try {
        const nextEntries = await scanVault(path);
        setEntries(nextEntries);

        const storedTabs = readStoredTabsForVault(path);
        const findEntry = (relOrPath: string | null | undefined) =>
          relOrPath
            ? nextEntries.find(
                (entry) => entry.relPath === relOrPath || entry.path === relOrPath,
              ) ?? null
            : null;

        const preferredEntry = findEntry(preferRelPath);
        const storedActiveEntry = findEntry(storedTabs?.activeRelPath);
        const storedEntries =
          storedTabs?.relPaths
            .map(findEntry)
            .filter((entry): entry is VaultEntry => entry !== null) ?? [];
        const candidate = preferredEntry ?? storedActiveEntry ?? storedEntries[0] ?? nextEntries[0] ?? null;

        if (candidate) {
          const tabEntries = [candidate, ...storedEntries].filter(
            (entry, index, arr) => arr.findIndex((other) => other.path === entry.path) === index,
          );
          const openedTabs: EditorTab[] = [];
          for (const entry of tabEntries.slice(0, 8)) {
            const payload = await readDocument(path, entry.path);
            openedTabs.push({
              id: tabIdForEntry(entry),
              entry,
              document: payload,
              draftContent: payload.content,
            });
          }
          setTabs(openedTabs);
          setActiveTabId(tabIdForEntry(candidate));
          pushRecent(candidate.path);
        } else {
          setTabs([]);
          setActiveTabId(null);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [pushRecent, readStoredTabsForVault],
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
      await addVault(label, path, externalWriter);
      // The user just added this vault — they want to work in it. Always
      // make it active and load its entries, regardless of whether Rust
      // auto-promoted it (which only happens when there was no prior
      // active vault).
      await switchActiveVault(path);
    },
    [switchActiveVault],
  );

  const handleRegisterWorkspace = useCallback(
    async (workPath: string) => {
      // Bootstraps `<work>/.anchor/`, registers both work + vault halves
      // in one transaction (vault gets `external_writer="mcp-obsidian"`),
      // and sets active_vault = work. The frontend then refreshes to
      // pick up the new pair.
      const outcome = await registerWorkspacePair(workPath);
      setVaultList(outcome.vaultList);
      await switchActiveVault(outcome.workPath);
    },
    [switchActiveVault],
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
        setTabs([]);
        setActiveTabId(null);
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

  const openNewDocumentDialog = useCallback(() => {
    if (activeVaultReadOnly) {
      setError(t("vault.writeDelegated", { writer: activeVaultExternalWriter ?? "external writer" }));
      return;
    }
    setNewDocumentSeed(null);
    setNewDocumentOpen(true);
  }, [activeVaultReadOnly, activeVaultExternalWriter, t]);

  const blockDelegatedWrite = useCallback(() => {
    if (!activeVaultReadOnly) return false;
    setError(t("vault.writeDelegated", { writer: activeVaultExternalWriter ?? "external writer" }));
    return true;
  }, [activeVaultReadOnly, activeVaultExternalWriter, t]);

  const selectEntry = useCallback(
    async (entry: VaultEntry) => {
      // Recover from state desync: if entries are loaded but the registry
      // lost track of the active vault (manual vaults.json edit, prior
      // failed switch), pick the vault whose path actually contains this
      // entry. Falling back blindly to vaults[0] is wrong when the entry
      // came from a different registered vault — readDocument would then
      // reject with "Document path escapes the selected vault".
      //
      // Prefer the longest-matching vault root so that a sub-vault registered
      // alongside its parent (e.g. sample-vault inside ~/workspace/work)
      // wins for entries that live below it.
      let vaultPath = activeVaultPath;
      if (!vaultPath && vaultList.vaults.length > 0) {
        const owner = vaultList.vaults
          .filter(
            (v) => entry.path === v.path || entry.path.startsWith(`${v.path}/`),
          )
          .sort((a, b) => b.path.length - a.path.length)[0];
        vaultPath = owner?.path ?? vaultList.vaults[0].path;
        try {
          const updated = await setActiveVault(vaultPath);
          setVaultList(updated);
        } catch {
          // Best effort — proceed with the inferred path even if persist fails.
        }
      }
      if (!vaultPath) {
        setError("No active vault. Open or create one first.");
        return false;
      }

      const existingTab = tabs.find((tab) => tab.entry.path === entry.path);
      const isSameEntry = selectedEntry?.path === entry.path;
      // Push the *previous* selection onto history before we replace it.
      // Skip when navigateBack/Forward is the caller — they manage manually.
      const skipHistoryPush = skipNextHistoryPushRef.current;
      skipNextHistoryPushRef.current = false;
      if (!skipHistoryPush && !isSameEntry && selectedEntry) {
        setNavHistory((h) => pushHistory(h, selectedEntry.path));
      }
      if (existingTab) {
        setActiveTabId(existingTab.id);
        if (typeof window !== "undefined") {
          window.localStorage.setItem(lastOpenKeyForVault(vaultPath), entry.relPath);
        }
        pushRecent(entry.path);
        return true;
      }

      const reqId = ++selectRequestRef.current;
      setError(null);
      try {
        const payload = await readDocument(vaultPath, entry.path);
        // Drop stale responses — a later click already superseded this one.
        if (reqId !== selectRequestRef.current) return false;
        const newTab: EditorTab = {
          id: tabIdForEntry(entry),
          entry,
          document: payload,
          draftContent: payload.content,
        };
        setTabs((prev) => [...prev, newTab]);
        setActiveTabId(newTab.id);
        if (typeof window !== "undefined") {
          window.localStorage.setItem(lastOpenKeyForVault(vaultPath), entry.relPath);
        }
        pushRecent(entry.path);
        return true;
      } catch (err) {
        if (reqId !== selectRequestRef.current) return false;
        setError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [activeVaultPath, vaultList.vaults, tabs, selectedEntry, lastOpenKeyForVault, pushRecent],
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
      const restoredTab: EditorTab = {
        id: tabIdForEntry(discardedEdit.entry),
        entry: discardedEdit.entry,
        document: payload,
        draftContent: discardedEdit.draft,
      };
      setTabs((prev) => {
        const exists = prev.some((tab) => tab.id === restoredTab.id);
        return exists
          ? prev.map((tab) => (tab.id === restoredTab.id ? restoredTab : tab))
          : [...prev, restoredTab];
      });
      setActiveTabId(restoredTab.id);
      setDiscardedEdit(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [discardedEdit, activeVaultPath]);

  const saveCurrent = useCallback(async () => {
    if (!document || !dirty || !activeVaultPath) return;
    if (blockDelegatedWrite()) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await saveDocument(activeVaultPath, document.path, draftContent);
      const fresh = await scanVault(activeVaultPath);
      setEntries(fresh);
      updateActiveTab((tab) => {
        const freshEntry = fresh.find((entry) => entry.path === tab.entry.path) ?? tab.entry;
        return { ...tab, entry: freshEntry, document: saved, draftContent: saved.content };
      });
      setGitRefreshTick((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [document, dirty, activeVaultPath, draftContent, updateActiveTab, blockDelegatedWrite]);

  const snapshotCurrent = useCallback(async () => {
    if (!document || !activeVaultPath) return;
    if (blockDelegatedWrite()) return;
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
      updateActiveTab((tab) => {
        const freshEntry = fresh.find((entry) => entry.path === tab.entry.path) ?? tab.entry;
        return { ...tab, entry: freshEntry };
      });
      setError(t("snapshot.success", { path: snapshot.relPath }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [document, activeVaultPath, draftContent, t, updateActiveTab, blockDelegatedWrite]);

  const createNew = useCallback(
    async (title: string, docType: string, body: string, targetRelPath: string | null) => {
      if (!activeVaultPath) return;
      if (blockDelegatedWrite()) return;
      const created = await createDocument(activeVaultPath, title, docType, body, targetRelPath);
      const fresh = await scanVault(activeVaultPath);
      setEntries(fresh);
      const entry =
        fresh.find((item) => item.relPath === created.relPath || item.path === created.path) ??
        ({
          path: created.path,
          relPath: created.relPath,
          title: created.title,
          frontmatter: { type: docType },
          updatedAt: null,
          wordCount: 0,
          snippet: "",
          fileKind: "md",
          versionCount: 0,
        } satisfies VaultEntry);
      const payload = await readDocument(activeVaultPath, created.path);
      const newTab: EditorTab = {
        id: tabIdForEntry(entry),
        entry,
        document: payload,
        draftContent: payload.content,
      };
      setTabs((prev) => {
        const exists = prev.some((tab) => tab.id === newTab.id);
        return exists
          ? prev.map((tab) => (tab.id === newTab.id ? newTab : tab))
          : [...prev, newTab];
      });
      setActiveTabId(newTab.id);
      pushRecent(entry.path);
    },
    [activeVaultPath, pushRecent, blockDelegatedWrite],
  );

  const handleWikilinkClick = useCallback(
    (target: string) => {
      const resolved = resolveWikilinkTarget(entries, target);
      if (resolved) {
        void selectEntry(resolved);
      } else {
        if (blockDelegatedWrite()) return;
        setNewDocumentSeed({
          title: titleFromWikilinkTarget(target),
          relPath: target.trim(),
        });
        setNewDocumentOpen(true);
        setError(null);
      }
    },
    [entries, selectEntry, blockDelegatedWrite],
  );

  const updateField = useCallback(
    async (key: string, value: string | string[] | number | boolean | null) => {
      if (!document || !activeVaultPath) return;
      if (blockDelegatedWrite()) return;
      try {
        const next = await updateFrontmatterField(activeVaultPath, document.path, key, value);
        // Refresh draft only when there are no unsaved body edits — never
        // clobber the textarea with an inspector-driven write.
        const fresh = await scanVault(activeVaultPath);
        setEntries(fresh);
        updateActiveTab((tab) => {
          const freshEntry = fresh.find((entry) => entry.path === tab.entry.path) ?? tab.entry;
          return {
            ...tab,
            entry: freshEntry,
            document: next,
            draftContent: draftContent === document.content ? next.content : tab.draftContent,
          };
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [document, activeVaultPath, draftContent, updateActiveTab, blockDelegatedWrite],
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

  const selectTab = useCallback(
    (tabId: string) => {
      const tab = tabs.find((item) => item.id === tabId);
      if (!tab) return;
      setActiveTabId(tabId);
      pushRecent(tab.entry.path);
    },
    [tabs, pushRecent],
  );

  const closeTab = useCallback(
    (tabId: string) => {
      const closing = tabs.find((tab) => tab.id === tabId);
      if (closing && closing.draftContent !== closing.document.content) {
        setDiscardedEdit({ entry: closing.entry, draft: closing.draftContent });
      }
      setTabs((prev) => {
        const closingIndex = prev.findIndex((tab) => tab.id === tabId);
        if (closingIndex === -1) return prev;
        const next = prev.filter((tab) => tab.id !== tabId);
        if (resolvedActiveTabId === tabId) {
          const fallback = next[Math.min(closingIndex, next.length - 1)] ?? null;
          setActiveTabId(fallback?.id ?? null);
        }
        return next;
      });
    },
    [resolvedActiveTabId, tabs],
  );

  const selectTabByIndex = useCallback(
    (index: number) => {
      const tab = tabs[index];
      if (tab) selectTab(tab.id);
    },
    [tabs, selectTab],
  );

  const handleCommitClick = useCallback(
    (status: GitStatus) => {
      if (blockDelegatedWrite()) return;
      setCommitDialog(status);
    },
    [blockDelegatedWrite],
  );

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
          openNewDocumentDialog();
          break;
        case "save":
          void saveCurrent();
          break;
        case "snapshot":
          void snapshotCurrent();
          break;
        case "toggle-preview":
          setEditorViewMode((mode) => (mode === "preview" ? "rich" : "preview"));
          break;
        case "toggle-outline":
          setOutlineOpen((v) => !v);
          break;
        case "toggle-locale":
          setLocale(locale === "ko" ? "en" : "ko");
          break;
        case "refresh-vault":
          if (appMode === "inbox") {
            void refreshInbox();
            void refreshGmail();
          } else {
            void refreshCurrent();
          }
          break;
        case "open-inbox":
          setAppMode("inbox");
          break;
        case "open-docs":
          setAppMode("pkm");
          break;
        case "add-vault":
          setAddVaultOpen(true);
          break;
      }
    },
    [
      saveCurrent,
      snapshotCurrent,
      refreshCurrent,
      refreshInbox,
      refreshGmail,
      appMode,
      locale,
      setLocale,
      openNewDocumentDialog,
    ],
  );

  useKeyboardShortcuts(
    {
      "mod+s": () => void saveCurrent(),
      "mod+shift+s": () => void snapshotCurrent(),
      "mod+n": openNewDocumentDialog,
      "mod+k": () => setCommandPaletteOpen((v) => !v),
      "mod+p": () => setEditorViewMode((mode) => (mode === "preview" ? "rich" : "preview")),
      "mod+\\": () => setOutlineOpen((v) => !v),
      "mod+f": focusSearch,
      "mod+r": () => {
        if (appMode === "inbox") {
          void refreshInbox();
          void refreshGmail();
        } else {
          void refreshCurrent();
        }
      },
      "mod+shift+l": () => setLocale(locale === "ko" ? "en" : "ko"),
      "mod+[": navigateBack,
      "mod+]": navigateForward,
      "mod+1": () => selectTabByIndex(0),
      "mod+2": () => selectTabByIndex(1),
      "mod+3": () => selectTabByIndex(2),
      "mod+4": () => selectTabByIndex(3),
      "mod+5": () => selectTabByIndex(4),
      "mod+6": () => selectTabByIndex(5),
      "mod+7": () => selectTabByIndex(6),
      "mod+8": () => selectTabByIndex(7),
      "mod+w": () => {
        if (resolvedActiveTabId) closeTab(resolvedActiveTabId);
      },
    },
    [
      saveCurrent,
      snapshotCurrent,
      refreshCurrent,
      focusSearch,
      locale,
      setLocale,
      navigateBack,
      navigateForward,
      selectTabByIndex,
      openNewDocumentDialog,
      closeTab,
      resolvedActiveTabId,
      appMode,
      refreshInbox,
      refreshGmail,
    ],
  );

  const modeClass =
    appMode === "inbox" ? " inbox-mode" : appMode === "system" ? " system-mode" : "";
  const shellClass = `app-shell${modeClass}${outlineOpen ? "" : " outline-closed"}`;

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
          <GitStatusBadge
            vaultPath={activeVaultPath}
            refreshTrigger={gitRefreshTick}
            onCommitClick={handleCommitClick}
          />

          <div className="topbar-spacer" />

          <button
            type="button"
            className={appMode === "pkm" ? "topbar-pill active" : "topbar-pill"}
            onClick={() => setAppMode("pkm")}
            title={t("mode.pkm")}
          >
            {t("mode.pkm")}
          </button>
          <button
            type="button"
            className={appMode === "inbox" ? "topbar-pill active" : "topbar-pill"}
            onClick={() => setAppMode("inbox")}
            title={t("mode.inbox")}
          >
            {t("mode.inbox")}
          </button>
          {systemEnabled ? (
            <button
              type="button"
              className={appMode === "system" ? "topbar-pill active" : "topbar-pill"}
              onClick={() => setAppMode("system")}
              title={t("mode.system")}
            >
              {t("mode.system")}
            </button>
          ) : null}
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
            onClick={() => {
              if (appMode === "inbox") {
                void refreshInbox();
                void refreshGmail();
              } else {
                void refreshCurrent();
              }
            }}
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
          onNewDocument={openNewDocumentDialog}
          onSelectRecent={selectEntry}
          onOpenCommandPalette={() => setCommandPaletteOpen(true)}
        />

        {appMode === "system" ? (
          <SystemPane workPath={systemWorkPath} />
        ) : appMode === "inbox" ? (
          <InboxPane
            items={inboxItems}
            loading={inboxLoading}
            gmailMessages={gmailItems}
            gmailLoading={gmailLoading}
            gmailError={gmailError}
            onRefresh={() => {
              void refreshInbox();
              void refreshGmail();
            }}
            onClassify={(id) => void classifyItem(id)}
            onDecide={decideInboxItem}
            onDecideGmail={decideGmailItem}
          />
        ) : (
          <>
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
              tabs={tabs.map((tab) => ({
                id: tab.id,
                title: tab.document.title,
                relPath: tab.document.relPath,
                dirty: tab.draftContent !== tab.document.content,
              }))}
              activeTabId={resolvedActiveTabId}
              entries={entries}
              onChange={setDraftContent}
              onSelectTab={selectTab}
              onCloseTab={closeTab}
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
          </>
        )}

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
          initialTitle={newDocumentSeed?.title ?? ""}
          initialRelPath={newDocumentSeed?.relPath ?? null}
          onOpenChange={(open) => {
            setNewDocumentOpen(open);
            if (!open) setNewDocumentSeed(null);
          }}
          onCreate={createNew}
        />
        <AddVaultDialog
          open={addVaultOpen}
          onOpenChange={setAddVaultOpen}
          onAdd={handleAddVault}
          onRegisterWorkspace={handleRegisterWorkspace}
        />
        <CommandPalette
          open={commandPaletteOpen}
          entries={entries}
          onClose={() => setCommandPaletteOpen(false)}
          onSelectEntry={selectEntry}
          onRunCommand={runCommand}
        />
        <CommitDialog
          open={commitDialog !== null}
          vaultPath={activeVaultPath}
          status={commitDialog}
          onClose={() => setCommitDialog(null)}
          onCommitted={() => setGitRefreshTick((n) => n + 1)}
        />
      </div>
    </LocaleContext.Provider>
  );
}
