import { Hash, X } from "lucide-react";
import { useMemo } from "react";
import type { DocumentPayload } from "../lib/types";
import { extractOutline } from "../lib/markdown";
import { frontmatterScalar } from "../lib/document";
import { useTranslation } from "../lib/i18n";

interface OutlinePaneProps {
  document: DocumentPayload | null;
  draftContent: string;
  onJumpToLine: (line: number) => void;
  onClose: () => void;
}

export function OutlinePane({ document, draftContent, onJumpToLine, onClose }: OutlinePaneProps) {
  const { t } = useTranslation();
  const headings = useMemo(() => extractOutline(draftContent), [draftContent]);
  const meta = document?.meta ?? {};
  const fmType = frontmatterScalar(meta, "type");
  const fmStatus = frontmatterScalar(meta, "status");
  const fmCreated = frontmatterScalar(meta, "created_at") ?? frontmatterScalar(meta, "created");
  const fmUpdated = frontmatterScalar(meta, "updated_at") ?? frontmatterScalar(meta, "modified");
  const fmTags = (meta as Record<string, unknown>)["tags"];
  const tagList: string[] = Array.isArray(fmTags)
    ? (fmTags as unknown[]).filter((t): t is string => typeof t === "string")
    : [];

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
            {headings.map((h, i) => (
              <button
                key={`${h.line}-${i}`}
                type="button"
                className="outline-item"
                data-level={h.level}
                onClick={() => onJumpToLine(h.line)}
                title={h.text}
              >
                {h.text}
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
        <dl className="outline-meta">
          {fmType ? (
            <div className="outline-meta-row">
              <dt>type</dt>
              <dd>
                <span className="type-badge" data-type={fmType.toLowerCase()}>{fmType}</span>
              </dd>
            </div>
          ) : null}
          {fmStatus ? (
            <div className="outline-meta-row">
              <dt>status</dt>
              <dd>
                <span className="status-pill" data-status={fmStatus.toLowerCase()}>{fmStatus}</span>
              </dd>
            </div>
          ) : null}
          {fmCreated ? (
            <div className="outline-meta-row">
              <dt>{t("outline.meta.created")}</dt>
              <dd title={fmCreated}>{fmCreated.slice(0, 10)}</dd>
            </div>
          ) : null}
          {fmUpdated ? (
            <div className="outline-meta-row">
              <dt>{t("outline.meta.updated")}</dt>
              <dd title={fmUpdated}>{fmUpdated.slice(0, 10)}</dd>
            </div>
          ) : null}
          {tagList.length > 0 ? (
            <div className="outline-meta-row" style={{ flexWrap: "wrap" }}>
              <dt>tags</dt>
              <dd
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 4,
                  justifyContent: "flex-end",
                  maxWidth: "70%",
                }}
              >
                {tagList.map((tag) => (
                  <span
                    key={tag}
                    style={{
                      fontSize: 10.5,
                      padding: "1px 6px",
                      borderRadius: 4,
                      background: "var(--panel-3)",
                      color: "var(--muted)",
                    }}
                  >
                    #{tag}
                  </span>
                ))}
              </dd>
            </div>
          ) : null}
          <div className="outline-meta-row">
            <dt>path</dt>
            <dd title={document.relPath}>{document.relPath}</dd>
          </div>
        </dl>
      ) : null}
    </aside>
  );
}
