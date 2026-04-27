import { Hash, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { frontmatterScalar } from "../lib/document";
import { extractOutline } from "../lib/markdown";
import { useTranslation } from "../lib/i18n";
import type { DocumentPayload, VaultEntry } from "../lib/types";
import { NeighborhoodPane } from "./NeighborhoodPane";

interface OutlinePaneProps {
  document: DocumentPayload | null;
  draftContent: string;
  entries: VaultEntry[];
  onJumpToLine: (line: number) => void;
  onClose: () => void;
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
  onJumpToLine,
  onClose,
  onUpdateField,
  onSelectEntry,
  onMissingWikilink,
}: OutlinePaneProps) {
  const { t } = useTranslation();
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

  // Distinct types observed in this vault, used to seed type-input suggestions.
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
        <h3>{t("outline.title")}</h3>
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

      {document ? (
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
            />
          </InspectorRow>

          <InspectorRow label="status">
            <ComboInput
              value={fmStatus ?? ""}
              suggestions={STANDARD_STATUSES}
              onCommit={(next) => onUpdateField("status", next || null)}
              placeholder={t("inspector.empty")}
              datalistId="anchor-status-list"
            />
          </InspectorRow>

          <InspectorRow label="project">
            <ComboInput
              value={fmProject ?? ""}
              suggestions={[]}
              onCommit={(next) => onUpdateField("project", next || null)}
              placeholder="[[프로젝트]]"
            />
          </InspectorRow>

          <InspectorRow label="tags">
            <TagsInput
              value={tagList}
              onCommit={(next) => onUpdateField("tags", next.length === 0 ? null : next)}
            />
          </InspectorRow>

          {fmCreated ? (
            <InspectorRow label={t("outline.meta.created")} muted>
              <span className="inspector-readonly" title={fmCreated}>{fmCreated.slice(0, 16).replace("T", " ")}</span>
            </InspectorRow>
          ) : null}
          {fmUpdated ? (
            <InspectorRow label={t("outline.meta.updated")} muted>
              <span className="inspector-readonly" title={fmUpdated}>{fmUpdated.slice(0, 16).replace("T", " ")}</span>
            </InspectorRow>
          ) : null}
          <InspectorRow label="path" muted>
            <span className="inspector-readonly" title={document.relPath}>{document.relPath}</span>
          </InspectorRow>
        </section>
      ) : null}
    </aside>
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
}: ComboInputProps) {
  const [draft, setDraft] = useState(value);
  const lastCommitted = useRef(value);

  useEffect(() => {
    setDraft(value);
    lastCommitted.current = value;
  }, [value]);

  function commit() {
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
}

/** Multi-chip tags editor. Type and press Enter or comma to add; Backspace
 *  in an empty input removes the last chip. Commits the full array on each
 *  mutation so InspectorPane can write it via update_frontmatter_field. */
function TagsInput({ value, onCommit }: TagsInputProps) {
  const [tags, setTags] = useState<string[]>(value);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    setTags(value);
  }, [value]);

  function applyNext(next: string[]) {
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
