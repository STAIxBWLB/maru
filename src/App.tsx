import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, RefreshCcw } from "lucide-react";
import { AiPanel } from "./components/AiPanel";
import { DocumentList } from "./components/DocumentList";
import { EditorPane } from "./components/EditorPane";
import { NewDocumentDialog } from "./components/NewDocumentDialog";
import { Sidebar } from "./components/Sidebar";
import { Button } from "./components/ui/Button";
import {
  chooseVault,
  createDocument,
  createVersion,
  generateAiDraft,
  getSampleVaultPath,
  readDocument,
  saveDocument,
  scanVault,
} from "./lib/api";
import type { AiDraft, DocumentMode, DocumentPayload, VaultEntry } from "./lib/types";

const STORAGE_KEY = "anchor:vaultPath:v1";

export default function App() {
  const [vaultPath, setVaultPath] = useState<string>("");
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [selectedEntry, setSelectedEntry] = useState<VaultEntry | null>(null);
  const [document, setDocument] = useState<DocumentPayload | null>(null);
  const [draftContent, setDraftContent] = useState("");
  const [query, setQuery] = useState("");
  const [activeType, setActiveType] = useState("All");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newDocumentOpen, setNewDocumentOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(true);
  const [aiMode, setAiMode] = useState<DocumentMode>("report");
  const [instruction, setInstruction] = useState("2분기 운영위원회 보고용으로 개조식 보고서 초안을 작성");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [lastDraft, setLastDraft] = useState<AiDraft | null>(null);

  const dirty = useMemo(() => Boolean(document && draftContent !== document.content), [document, draftContent]);

  const loadVault = useCallback(async (path: string, selectFirst = true) => {
    setLoading(true);
    setError(null);
    try {
      const nextEntries = await scanVault(path);
      setEntries(nextEntries);
      localStorage.setItem(STORAGE_KEY, path);
      if (selectFirst && nextEntries.length > 0) {
        const first = nextEntries[0];
        setSelectedEntry(first);
        const payload = await readDocument(path, first.path);
        setDocument(payload);
        setDraftContent(payload.content);
      } else if (nextEntries.length === 0) {
        setSelectedEntry(null);
        setDocument(null);
        setDraftContent("");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    async function boot() {
      const saved = localStorage.getItem(STORAGE_KEY);
      const path = saved || (await getSampleVaultPath());
      setVaultPath(path);
      await loadVault(path);
    }
    void boot();
  }, [loadVault]);

  async function useSampleVault() {
    const path = await getSampleVaultPath();
    setVaultPath(path);
    await loadVault(path);
  }

  async function pickVault() {
    const selected = await chooseVault();
    if (!selected) return;
    setVaultPath(selected);
    await loadVault(selected);
  }

  async function selectEntry(entry: VaultEntry) {
    if (dirty && !window.confirm("저장하지 않은 변경이 있습니다. 다른 문서를 열까요?")) return;
    setSelectedEntry(entry);
    setError(null);
    try {
      const payload = await readDocument(vaultPath, entry.path);
      setDocument(payload);
      setDraftContent(payload.content);
      setLastDraft(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function saveCurrent() {
    if (!document || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await saveDocument(vaultPath, document.path, draftContent);
      setDocument(saved);
      setDraftContent(saved.content);
      await loadVault(vaultPath, false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function snapshotCurrent() {
    if (!document) return;
    setError(null);
    try {
      const snapshot = await createVersion(
        vaultPath,
        document.path,
        document.title,
        draftContent,
        "사용자 요청으로 생성한 편집 스냅샷",
      );
      await loadVault(vaultPath, false);
      setError(`버전 생성 완료: ${snapshot.relPath}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function createNew(title: string, docType: string, body: string) {
    const created = await createDocument(vaultPath, title, docType, body);
    await loadVault(vaultPath, false);
    const payload = await readDocument(vaultPath, created.path);
    setSelectedEntry({
      path: created.path,
      relPath: created.relPath,
      title: created.title,
      docType,
      status: "draft",
      tags: [],
      people: [],
      project: null,
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      wordCount: payload.body.split(/\s+/).filter(Boolean).length,
      snippet: payload.body.replace(/\s+/g, " ").slice(0, 220),
      fileKind: payload.fileKind,
      versionCount: 0,
    });
    setDocument(payload);
    setDraftContent(payload.content);
  }

  async function runAiDraft() {
    if (!document) return;
    setAiLoading(true);
    setAiError(null);
    try {
      const draft = await generateAiDraft(aiMode, instruction, draftContent);
      setLastDraft(draft);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : String(err));
    } finally {
      setAiLoading(false);
    }
  }

  function applyDraft() {
    if (!lastDraft) return;
    setDraftContent(lastDraft.content);
  }

  return (
    <div className={aiOpen ? "app-shell" : "app-shell ai-closed"}>
      <Sidebar
        vaultPath={vaultPath}
        entries={entries}
        activeType={activeType}
        onTypeChange={setActiveType}
        onChooseVault={pickVault}
        onUseSample={useSampleVault}
        onNewDocument={() => setNewDocumentOpen(true)}
      />

      <DocumentList
        entries={entries}
        selectedPath={selectedEntry?.path ?? null}
        query={query}
        activeType={activeType}
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
        onToggleAi={() => setAiOpen((value) => !value)}
      />

      <AiPanel
        open={aiOpen}
        document={document}
        instruction={instruction}
        mode={aiMode}
        loading={aiLoading}
        lastDraft={lastDraft}
        error={aiError}
        onInstructionChange={setInstruction}
        onModeChange={setAiMode}
        onGenerate={runAiDraft}
        onApplyDraft={applyDraft}
        onClose={() => setAiOpen(false)}
      />

      {error ? (
        <div className={error.startsWith("버전 생성 완료") ? "toast notice" : "toast"}>
          <AlertTriangle size={15} />
          <span>{error}</span>
          <Button size="sm" variant="ghost" onClick={() => setError(null)}>
            닫기
          </Button>
        </div>
      ) : null}

      <button className="floating-refresh" title="볼트 다시 읽기" onClick={() => loadVault(vaultPath, false)}>
        <RefreshCcw size={16} />
      </button>

      <NewDocumentDialog open={newDocumentOpen} onOpenChange={setNewDocumentOpen} onCreate={createNew} />
    </div>
  );
}
