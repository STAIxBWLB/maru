import {
  Copy,
  FilePlus2,
  Files,
  Hash,
  Info,
  List,
  MoveRight,
  Plus,
  Save,
  StickyNote,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  chooseFiles,
  chooseSaveFile,
  chooseWorkspaceDirectory,
  listMemos,
  readMemo,
  saveMemo,
  saveMemoAs,
  storeShelfFiles,
  storeShelfFilesAs,
} from "../lib/api";
import { frontmatterScalar } from "../lib/document";
import { extractOutline } from "../lib/markdown";
import { useTranslation } from "../lib/i18n";
import type {
  DocumentPayload,
  FileStoreOperation,
  MemoEntry,
  MemoFormat,
  VaultEntry,
} from "../lib/types";
import { NeighborhoodPane } from "./NeighborhoodPane";

interface OutlinePaneProps {
  document: DocumentPayload | null;
  draftContent: string;
  entries: VaultEntry[];
  readOnly: boolean;
  workspacePath: string | null;
  onJumpToLine: (line: number) => void;
  onClose: () => void;
  onError: (message: string | null) => void;
  onRefreshWorkspace: () => void;
  onUpdateField: (
    key: string,
    value: string | string[] | number | boolean | null,
  ) => Promise<void>;
  onSelectEntry: (entry: VaultEntry) => void;
  onMissingWikilink?: (target: string) => void;
}

const STANDARD_TYPES = [
  "meeting",
  "project",
  "reference",
  "task",
  "person",
  "inbox",
  "document",
];
const STANDARD_STATUSES = [
  "active",
  "draft",
  "review",
  "done",
  "archived",
  "진행중",
  "검토",
  "완료",
];

export function OutlinePane({
  document,
  draftContent,
  entries,
  readOnly,
  workspacePath,
  onJumpToLine,
  onClose,
  onError,
  onRefreshWorkspace,
  onUpdateField,
  onSelectEntry,
  onMissingWikilink,
}: OutlinePaneProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"outline" | "files" | "memo" | "info">("outline");
  const headings = useMemo(() => extractOutline(draftContent), [draftContent]);
  const meta = document?.meta ?? {};
  const fmType = frontmatterScalar(meta, "type");
  const fmStatus = frontmatterScalar(meta, "status");
  const fmProject = frontmatterScalar(meta, "project");
  const fmCreated = frontmatterScalar(meta, "created_at") ?? frontmatterScalar(meta, "created");
  const fmUpdated = frontmatterScalar(meta, "updated_at") ?? frontmatterScalar(meta, "modified");
  const fmTags = (meta as Record<string, unknown>)["tags"];
  const tagList: string[] = Array.isArray(fmTags)
    ? (fmTags as unknown[]).filter((tag): tag is string => typeof tag === "string")
    : [];

  // Distinct types observed in this workspace, used to seed type-input suggestions.
  const observedTypes = useMemo(() => {
    const set = new Set<string>(STANDARD_TYPES);
    for (const entry of entries) {
      const type = frontmatterScalar(entry.frontmatter, "type");
      if (type) set.add(type);
    }
    return Array.from(set).sort();
  }, [entries]);

  return (
    <aside className="outline-pane">
      <div className="outline-header">
        <h3>{t("rightPane.title")}</h3>
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          title={t("outline.close")}
          aria-label={t("outline.close")}
        >
          <X size={14} />
        </button>
      </div>
      <div className="right-pane-workspace">
        <div className="right-pane-tabs" role="tablist" aria-label={t("rightPane.tabs")}>
          {(["outline", "files", "memo", "info"] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={tab === id ? "active" : ""}
              onClick={() => setTab(id)}
              title={t(`rightPane.tab.${id}`)}
              aria-label={t(`rightPane.tab.${id}`)}
            >
              {id === "outline" ? (
                <List size={20} />
              ) : id === "files" ? (
                <Files size={20} />
              ) : id === "memo" ? (
                <StickyNote size={20} />
              ) : (
                <Info size={20} />
              )}
            </button>
          ))}
        </div>

        <div className="right-pane-content">
          {tab === "outline" ? (
            <>
              {document ? (
                headings.length > 0 ? (
                  <div className="outline-list">
                    {headings.map((heading, i) => (
                      <button
                        key={`${heading.line}-${i}`}
                        type="button"
                        className="outline-item"
                        data-level={heading.level}
                        onClick={() => onJumpToLine(heading.line)}
                        title={heading.text}
                      >
                        {heading.text}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="outline-empty">
                    <Hash size={20} style={{ opacity: 0.5, marginBottom: 6 }} />
                    <div>{t("outline.empty")}</div>
                  </div>
                )
              ) : (
                <div className="outline-empty">{t("outline.empty.noDocument")}</div>
              )}

              {document ? (
                <NeighborhoodPane
                  document={document}
                  draftContent={draftContent}
                  entries={entries}
                  onSelectEntry={onSelectEntry}
                  onMissingTarget={onMissingWikilink}
                />
              ) : null}
            </>
          ) : null}

          {tab === "files" ? (
            <FilesShelfPane workspacePath={workspacePath} onError={onError} t={t} />
          ) : null}

          {tab === "memo" ? (
            <MemoPane
              workspacePath={workspacePath}
              onError={onError}
              onRefreshWorkspace={onRefreshWorkspace}
              t={t}
            />
          ) : null}

          {tab === "info" && document ? (
            <section className="inspector">
              <div className="inspector-header">
                <h3>{t("inspector.title")}</h3>
              </div>

              <InspectorRow label="type">
                <ComboInput
                  value={fmType ?? ""}
                  suggestions={observedTypes}
                  onCommit={(next) => onUpdateField("type", next || null)}
                  placeholder={t("inspector.empty")}
                  datalistId="anchor-type-list"
                  readOnly={readOnly}
                />
              </InspectorRow>

              <InspectorRow label="status">
                <ComboInput
                  value={fmStatus ?? ""}
                  suggestions={STANDARD_STATUSES}
                  onCommit={(next) => onUpdateField("status", next || null)}
                  placeholder={t("inspector.empty")}
                  datalistId="anchor-status-list"
                  readOnly={readOnly}
                />
              </InspectorRow>

              <InspectorRow label="project">
                <ComboInput
                  value={fmProject ?? ""}
                  suggestions={[]}
                  onCommit={(next) => onUpdateField("project", next || null)}
                  placeholder="[[프로젝트]]"
                  readOnly={readOnly}
                />
              </InspectorRow>

              <InspectorRow label="tags">
                <TagsInput
                  value={tagList}
                  onCommit={(next) => onUpdateField("tags", next.length === 0 ? null : next)}
                  readOnly={readOnly}
                />
              </InspectorRow>

              {fmCreated ? (
                <InspectorRow label={t("outline.meta.created")} muted>
                  <span className="inspector-readonly" title={fmCreated}>
                    {fmCreated.slice(0, 16).replace("T", " ")}
                  </span>
                </InspectorRow>
              ) : null}
              {fmUpdated ? (
                <InspectorRow label={t("outline.meta.updated")} muted>
                  <span className="inspector-readonly" title={fmUpdated}>
                    {fmUpdated.slice(0, 16).replace("T", " ")}
                  </span>
                </InspectorRow>
              ) : null}
              <InspectorRow label="path" muted>
                <span className="inspector-readonly" title={document.relPath}>
                  {document.relPath}
                </span>
              </InspectorRow>
            </section>
          ) : tab === "info" ? (
            <div className="outline-empty">{t("outline.empty.noDocument")}</div>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

function FilesShelfPane({
  workspacePath,
  onError,
  t,
}: {
  workspacePath: string | null;
  onError: (message: string | null) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [paths, setPaths] = useState<string[]>([]);
  const [operation, setOperation] = useState<FileStoreOperation>("copy");
  const [working, setWorking] = useState(false);

  const addPaths = useCallback((nextPaths: string[]) => {
    setPaths((current) => Array.from(new Set([...current, ...nextPaths])));
  }, []);

  useEffect(() => {
    let dispose: (() => void) | null = null;
    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((event) => {
          if (event.payload.type === "drop") addPaths(event.payload.paths);
        }),
      )
      .then((off) => {
        dispose = off;
      })
      .catch(() => {});
    return () => dispose?.();
  }, [addPaths]);

  const pickFiles = async () => {
    addPaths(await chooseFiles(t("rightPane.files.pick")));
  };

  const runStore = async (saveAs: boolean) => {
    if (!workspacePath || paths.length === 0) return;
    setWorking(true);
    onError(null);
    try {
      if (saveAs) {
        const target = await chooseWorkspaceDirectory(t("rightPane.files.saveAs"));
        if (!target) return;
        await storeShelfFilesAs(paths, target, operation);
      } else {
        await storeShelfFiles(workspacePath, paths, operation);
      }
      setPaths([]);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  };

  return (
    <section className="right-tool-pane">
      <div className="right-tool-actions">
        <button type="button" onClick={pickFiles}>
          <FilePlus2 size={13} />
          <span>{t("rightPane.files.pick")}</span>
        </button>
        <button
          type="button"
          className={operation === "copy" ? "active" : ""}
          onClick={() => setOperation("copy")}
        >
          <Copy size={13} />
          <span>{t("rightPane.files.copy")}</span>
        </button>
        <button
          type="button"
          className={operation === "move" ? "active" : ""}
          onClick={() => setOperation("move")}
        >
          <MoveRight size={13} />
          <span>{t("rightPane.files.move")}</span>
        </button>
      </div>
      <div className={paths.length === 0 ? "file-drop-zone empty" : "file-drop-zone"}>
        <Files size={18} />
        <strong>{t("rightPane.files.dropTitle")}</strong>
        <span>{t("rightPane.files.dropDescription")}</span>
      </div>
      <div className="right-list">
        {paths.map((path) => (
          <div className="right-list-item" key={path} title={path}>
            <span>{path.split("/").pop() ?? path}</span>
            <button type="button" onClick={() => setPaths((items) => items.filter((item) => item !== path))}>
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
      <div className="right-tool-actions bottom">
        <button type="button" disabled={!workspacePath || paths.length === 0 || working} onClick={() => void runStore(false)}>
          <Save size={13} />
          <span>{t("rightPane.files.store")}</span>
        </button>
        <button type="button" disabled={paths.length === 0 || working} onClick={() => void runStore(true)}>
          <Save size={13} />
          <span>{t("rightPane.files.saveAs")}</span>
        </button>
      </div>
    </section>
  );
}

function MemoPane({
  workspacePath,
  onError,
  onRefreshWorkspace,
  t,
}: {
  workspacePath: string | null;
  onError: (message: string | null) => void;
  onRefreshWorkspace: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [memos, setMemos] = useState<MemoEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [name, setName] = useState("memo.md");
  const [format, setFormat] = useState<MemoFormat>("markdown");
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    if (!workspacePath) {
      setMemos([]);
      return;
    }
    setLoading(true);
    try {
      setMemos(await listMemos(workspacePath));
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [onError, workspacePath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openMemo = async (memo: MemoEntry) => {
    if (!workspacePath) return;
    try {
      const doc = await readMemo(workspacePath, memo.path);
      setSelectedPath(doc.path);
      setName(doc.name);
      setFormat(doc.format);
      setContent(doc.content);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  const newMemo = () => {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    setSelectedPath(null);
    setName(`memo-${stamp}.md`);
    setFormat("markdown");
    setContent("");
  };

  const saveDefault = async () => {
    if (!workspacePath) return;
    setSaving(true);
    onError(null);
    try {
      const doc = await saveMemo(workspacePath, name, format, content);
      setSelectedPath(doc.path);
      setName(doc.name);
      await refresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const saveAs = async () => {
    setSaving(true);
    onError(null);
    try {
      const target = await chooseSaveFile(t("rightPane.memo.saveAs"), name);
      if (!target) return;
      await saveMemoAs(target, content);
      onRefreshWorkspace();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="right-tool-pane memo-pane">
      <div className="right-tool-actions">
        <button type="button" onClick={newMemo}>
          <Plus size={13} />
          <span>{t("rightPane.memo.new")}</span>
        </button>
        <button type="button" onClick={() => void refresh()}>
          <List size={13} />
          <span>{t("rightPane.memo.refresh")}</span>
        </button>
      </div>
      <div className="memo-list" aria-label={t("rightPane.memo.list")}>
        {loading ? <div className="outline-empty">{t("rightPane.memo.loading")}</div> : null}
        {!loading && memos.length === 0 ? (
          <div className="outline-empty">{t("rightPane.memo.empty")}</div>
        ) : null}
        {memos.map((memo) => (
          <button
            key={memo.path}
            type="button"
            className={memo.path === selectedPath ? "memo-list-item active" : "memo-list-item"}
            onClick={() => void openMemo(memo)}
            title={memo.path}
          >
            <strong>{memo.name}</strong>
            <span>{memo.preview || t("rightPane.memo.noPreview")}</span>
          </button>
        ))}
      </div>
      <label className="memo-name">
        <span>{t("rightPane.memo.name")}</span>
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <div className="right-tool-actions">
        <button type="button" className={format === "markdown" ? "active" : ""} onClick={() => setFormat("markdown")}>
          Markdown
        </button>
        <button type="button" className={format === "plain" ? "active" : ""} onClick={() => setFormat("plain")}>
          Plain
        </button>
      </div>
      <textarea
        className="memo-editor"
        value={content}
        onChange={(event) => setContent(event.target.value)}
        placeholder={t("rightPane.memo.placeholder")}
      />
      <div className="right-tool-actions bottom">
        <button type="button" disabled={!workspacePath || saving} onClick={() => void saveDefault()}>
          <Save size={13} />
          <span>{saving ? t("editor.saving") : t("rightPane.memo.save")}</span>
        </button>
        <button type="button" disabled={saving} onClick={() => void saveAs()}>
          <Save size={13} />
          <span>{t("rightPane.memo.saveAs")}</span>
        </button>
      </div>
    </section>
  );
}

interface InspectorRowProps {
  label: string;
  muted?: boolean;
  children: React.ReactNode;
}

function InspectorRow({ label, muted, children }: InspectorRowProps) {
  return (
    <div className={muted ? "inspector-row muted" : "inspector-row"}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

interface ComboInputProps {
  value: string;
  suggestions: string[];
  onCommit: (next: string) => void | Promise<void>;
  placeholder?: string;
  datalistId?: string;
  readOnly?: boolean;
}

/** Free-text input with optional <datalist> suggestions. Commits on blur or
 *  Enter — but only fires onCommit when the value actually changed, so a
 *  blur from a no-op edit doesn't write the file back. */
function ComboInput({
  value,
  suggestions,
  onCommit,
  placeholder,
  datalistId,
  readOnly = false,
}: ComboInputProps) {
  const [draft, setDraft] = useState(value);
  const lastCommitted = useRef(value);

  useEffect(() => {
    setDraft(value);
    lastCommitted.current = value;
  }, [value]);

  function commit() {
    if (readOnly) return;
    const next = draft.trim();
    if (next === lastCommitted.current) return;
    lastCommitted.current = next;
    void onCommit(next);
  }

  return (
    <>
      <input
        className="inspector-input"
        list={datalistId}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        disabled={readOnly}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            (event.currentTarget as HTMLInputElement).blur();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setDraft(lastCommitted.current);
            (event.currentTarget as HTMLInputElement).blur();
          }
        }}
        placeholder={placeholder}
      />
      {datalistId && suggestions.length > 0 ? (
        <datalist id={datalistId}>
          {suggestions.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
      ) : null}
    </>
  );
}

interface TagsInputProps {
  value: string[];
  onCommit: (next: string[]) => void | Promise<void>;
  readOnly?: boolean;
}

/** Multi-chip tags editor. Type and press Enter or comma to add; Backspace
 *  in an empty input removes the last chip. Commits the full array on each
 *  mutation so InspectorPane can write it via update_frontmatter_field. */
function TagsInput({ value, onCommit, readOnly = false }: TagsInputProps) {
  const [tags, setTags] = useState<string[]>(value);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    setTags(value);
  }, [value]);

  function applyNext(next: string[]) {
    if (readOnly) return;
    setTags(next);
    void onCommit(next);
  }

  function pushTag() {
    const cleaned = draft.trim().replace(/^#+/, "");
    if (!cleaned) return;
    if (tags.includes(cleaned)) {
      setDraft("");
      return;
    }
    applyNext([...tags, cleaned]);
    setDraft("");
  }

  return (
    <div className="tag-chips">
      {tags.map((tag) => (
        <span key={tag} className="tag-chip">
          #{tag}
          <button
            type="button"
            className="tag-chip-x"
            aria-label={`remove ${tag}`}
            disabled={readOnly}
            onClick={() => applyNext(tags.filter((t) => t !== tag))}
          >
            <X size={10} />
          </button>
        </span>
      ))}
      <input
        className="tag-chip-input"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        disabled={readOnly}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === ",") {
            event.preventDefault();
            pushTag();
          } else if (event.key === "Backspace" && draft === "" && tags.length > 0) {
            event.preventDefault();
            applyNext(tags.slice(0, -1));
          }
        }}
        onBlur={pushTag}
        placeholder={tags.length === 0 ? "tag" : "+"}
      />
      {tags.length === 0 && draft === "" ? null : (
        <button
          type="button"
          className="tag-chip-add"
          onClick={pushTag}
          disabled={readOnly}
          title="add tag"
          aria-label="add tag"
          tabIndex={-1}
        >
          <Plus size={11} />
        </button>
      )}
    </div>
  );
}
