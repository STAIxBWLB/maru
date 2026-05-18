// Phase 3 W6 / Phase 4 W7 — Writing Guideline right-pane sidebar.
//
// Resolves the guideline IDs in this priority order:
//   1. Frontmatter `guideline_ids: [...]` (snake_case, accepts camelCase
//      fallback) — this is the canonical source after Phase 4 W7's
//      create_document frontmatter prefill.
//   2. Legacy `<!-- anchor:guidelines gdl_... -->` provenance comment for
//      documents created by the Phase 3 W5 implementation, before W7
//      promoted the metadata to frontmatter.
// Frontmatter IDs always come first; comment IDs are appended only if
// they aren't already present. Each ID is then fetched from the Hub
// Library and rendered in a multi-tab body viewer.

import { useEffect, useMemo, useState } from "react";
import { fetchGuideline, type Guideline } from "../../lib/hubLibrary";

interface WritingGuidelineSidebarProps {
  workspaceRoot: string | null;
  documentBody: string;
  frontmatter: Record<string, unknown> | null;
}

interface LoadState {
  loading: boolean;
  error: string | null;
  guidelines: Guideline[];
}

const PROVENANCE_RE = /<!--\s*anchor:guidelines\s+([^>]+?)\s*-->/i;

export function extractGuidelineIds(
  documentBody: string,
  frontmatter: Record<string, unknown> | null,
): string[] {
  const ids: string[] = [];
  const fm = frontmatter ?? {};
  const fromFrontmatter = fm.guideline_ids ?? fm.guidelineIds ?? null;
  if (Array.isArray(fromFrontmatter)) {
    for (const raw of fromFrontmatter) {
      if (typeof raw === "string" && raw.trim()) ids.push(raw.trim());
    }
  }
  const match = PROVENANCE_RE.exec(documentBody);
  if (match) {
    for (const piece of match[1].split(",")) {
      const trimmed = piece.trim();
      if (trimmed && !ids.includes(trimmed)) ids.push(trimmed);
    }
  }
  return ids;
}

export function WritingGuidelineSidebar({
  workspaceRoot,
  documentBody,
  frontmatter,
}: WritingGuidelineSidebarProps) {
  const guidelineIds = useMemo(
    () => extractGuidelineIds(documentBody, frontmatter),
    [documentBody, frontmatter],
  );

  const [state, setState] = useState<LoadState>({
    loading: false,
    error: null,
    guidelines: [],
  });
  const [activeIdx, setActiveIdx] = useState(0);

  useEffect(() => {
    if (!workspaceRoot || guidelineIds.length === 0) {
      setState({ loading: false, error: null, guidelines: [] });
      return;
    }
    let cancelled = false;
    setState({ loading: true, error: null, guidelines: [] });
    Promise.all(
      guidelineIds.map((id) =>
        fetchGuideline(id, { workspaceRoot }).catch((err) => {
          // Per-guideline failure: capture as a synthetic stub so the
          // sidebar still surfaces something for the other tabs.
          return {
            id,
            slug: id,
            title: id,
            body_markdown: `*불러올 수 없음: ${String(err)}*`,
            scope: "global" as const,
            applies_to_categories: [],
            version: 0,
            is_current: false,
            created_at: "",
            updated_at: "",
          } satisfies Guideline;
        }),
      ),
    ).then((guidelines) => {
      if (cancelled) return;
      setState({ loading: false, error: null, guidelines });
      setActiveIdx(0);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceRoot, guidelineIds.join("|")]);

  if (guidelineIds.length === 0) {
    return (
      <div className="writing-guideline writing-guideline--empty">
        <p>
          이 문서에 적용된 작성지침이 없습니다.
          <br />
          <span className="muted">
            새 문서를 만들 때 Hub 템플릿/가이드라인을 선택하거나 frontmatter에{" "}
            <code>guideline_ids</code>를 추가하면 여기에 표시됩니다.
          </span>
        </p>
      </div>
    );
  }

  const active = state.guidelines[activeIdx] ?? null;

  return (
    <div className="writing-guideline">
      {state.guidelines.length > 1 ? (
        <nav className="writing-guideline__tabs" aria-label="가이드라인 선택">
          {state.guidelines.map((g, idx) => (
            <button
              key={g.id}
              type="button"
              className={idx === activeIdx ? "active" : ""}
              onClick={() => setActiveIdx(idx)}
              title={g.slug}
            >
              {g.title}
            </button>
          ))}
        </nav>
      ) : null}

      {state.loading ? (
        <p className="writing-guideline__status">불러오는 중…</p>
      ) : state.error ? (
        <p className="writing-guideline__error">오류: {state.error}</p>
      ) : active ? (
        <article className="writing-guideline__body">
          <header className="writing-guideline__header">
            <h3>{active.title}</h3>
            <div className="writing-guideline__meta">
              <span>{active.scope}</span>
              {active.business_unit_slug ? (
                <span>· {active.business_unit_slug}</span>
              ) : null}
              {active.document_type_code ? <span>· {active.document_type_code}</span> : null}
              <span>· v{active.version}</span>
            </div>
          </header>
          <pre className="writing-guideline__markdown">{active.body_markdown}</pre>
        </article>
      ) : (
        <p className="writing-guideline__status">표시할 가이드라인이 없습니다.</p>
      )}
    </div>
  );
}
