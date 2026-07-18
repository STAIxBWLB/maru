// Catalog drilldown dialog (Phase 3 W4).
//
// Opens when a Catalog row is clicked. Shows frontmatter + manifest +
// README excerpt + related sibling paths, plus Reveal-in-Finder action.

import { useEffect, useState } from "react";
import type { CatalogDrilldownResponse, CatalogEntry } from "../../lib/catalog";
import { catalogDrilldown } from "../../lib/catalog";
import { useTranslation } from "../../lib/i18n";

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
  const { t } = useTranslation();
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
                {t("catalog.drilldown.reveal")}
              </button>
            ) : null}
            <button
              type="button"
              className="catalog-drilldown__action"
              onClick={onClose}
              aria-label={t("catalog.drilldown.close")}
            >
              {t("catalog.drilldown.close")}
            </button>
          </div>
        </header>

        <div className="catalog-drilldown__body">
          {loading && <p className="catalog-drilldown__status">{t("catalog.drilldown.loading")}</p>}
          {error && (
            <p className="catalog-drilldown__error">
              {t("catalog.drilldown.error", { message: error })}
            </p>
          )}

          {data?.frontmatter_yaml ? (
            <section>
              <h4>{t("catalog.drilldown.frontmatter")}</h4>
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
              <h4>{t("catalog.drilldown.readmeExcerpt")}</h4>
              <pre className="catalog-drilldown__code">{data.readme_excerpt}</pre>
            </section>
          ) : null}

          {data?.related_paths.length ? (
            <section>
              <h4>{t("catalog.drilldown.related", { count: data.related_paths.length })}</h4>
              <ul className="catalog-drilldown__related">
                {data.related_paths.slice(0, 50).map((p) => (
                  <li key={p}>{p}</li>
                ))}
                {data.related_paths.length > 50 ? (
                  <li className="catalog-drilldown__more">
                    {t("catalog.drilldown.relatedMore", {
                      count: data.related_paths.length - 50,
                    })}
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
            <p className="catalog-drilldown__empty">{t("catalog.drilldown.empty")}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
