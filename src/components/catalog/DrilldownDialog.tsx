// Catalog drilldown dialog (Phase 3 W4).
//
// Opens when a Catalog row is clicked. Shows frontmatter + manifest +
// README excerpt + related sibling paths, plus Reveal-in-Finder action.

import { useEffect, useState } from "react";
import type { CatalogDrilldownResponse, CatalogEntry } from "../../lib/catalog";
import { catalogDrilldown } from "../../lib/catalog";

interface DrilldownDialogProps {
  workspaceRoot: string;
  entry: CatalogEntry | null;
  onClose: () => void;
  onReveal?: (path: string) => void;
}

export function DrilldownDialog({
  workspaceRoot,
  entry,
  onClose,
  onReveal,
}: DrilldownDialogProps) {
  const [data, setData] = useState<CatalogDrilldownResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!entry) {
      setData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    catalogDrilldown(workspaceRoot, entry.path)
      .then((resp) => {
        if (!cancelled) setData(resp);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceRoot, entry]);

  if (!entry) return null;

  return (
    <div className="catalog-drilldown-overlay" role="dialog" aria-modal="true">
      <div className="catalog-drilldown">
        <header className="catalog-drilldown__header">
          <div>
            <h3>{entry.title || entry.path}</h3>
            <div className="catalog-drilldown__path">{entry.path}</div>
          </div>
          <div className="catalog-drilldown__actions">
            {onReveal ? (
              <button
                type="button"
                className="catalog-drilldown__action"
                onClick={() => onReveal(entry.path)}
              >
                Finder에서 보기
              </button>
            ) : null}
            <button
              type="button"
              className="catalog-drilldown__action"
              onClick={onClose}
              aria-label="닫기"
            >
              닫기
            </button>
          </div>
        </header>

        <div className="catalog-drilldown__body">
          {loading && <p className="catalog-drilldown__status">불러오는 중…</p>}
          {error && <p className="catalog-drilldown__error">오류: {error}</p>}

          {data?.frontmatter_yaml ? (
            <section>
              <h4>Frontmatter</h4>
              <pre className="catalog-drilldown__code">{data.frontmatter_yaml}</pre>
            </section>
          ) : null}

          {data?.manifest_yaml ? (
            <section>
              <h4>manifest.yaml</h4>
              <pre className="catalog-drilldown__code">{data.manifest_yaml}</pre>
            </section>
          ) : null}

          {data?.readme_excerpt ? (
            <section>
              <h4>README (40줄)</h4>
              <pre className="catalog-drilldown__code">{data.readme_excerpt}</pre>
            </section>
          ) : null}

          {data?.related_paths.length ? (
            <section>
              <h4>같은 디렉토리 ({data.related_paths.length})</h4>
              <ul className="catalog-drilldown__related">
                {data.related_paths.slice(0, 50).map((p) => (
                  <li key={p}>{p}</li>
                ))}
                {data.related_paths.length > 50 ? (
                  <li className="catalog-drilldown__more">
                    … +{data.related_paths.length - 50}건
                  </li>
                ) : null}
              </ul>
            </section>
          ) : null}

          {data &&
          !data.frontmatter_yaml &&
          !data.manifest_yaml &&
          !data.readme_excerpt &&
          !data.related_paths.length ? (
            <p className="catalog-drilldown__empty">
              관련 frontmatter·manifest·README를 찾지 못했습니다.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
