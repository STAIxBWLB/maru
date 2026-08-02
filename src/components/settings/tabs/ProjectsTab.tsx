import { AlertTriangle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { readMaruProjects } from "../../../lib/maruDir";
import { useTranslation } from "../../../lib/i18n";
import { ModeHeader } from "../../ui/ModeChrome";

// ============================== Projects ==============================

export function ProjectsTab({ workPath }: { workPath: string }) {
  const { t } = useTranslation();
  const [value, setValue] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setValue(await readMaruProjects(workPath));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [workPath]);

  const json = useMemo(() => JSON.stringify(value ?? {}, null, 2), [value]);
  const isEmpty = useMemo(() => {
    if (!value || typeof value !== "object") return true;
    const obj = value as Record<string, unknown>;
    const registry = obj.registry as Record<string, unknown> | undefined;
    if (!registry) return Object.keys(obj).length <= 1; // only "version"
    const cats = (registry as { categories?: unknown[] }).categories;
    return !Array.isArray(cats) || cats.length === 0;
  }, [value]);

  return (
    <div className="settings-tab wide">
      <ModeHeader title={t("system.tab.projects")} />
      <div className="system-detail" style={{ width: "100%" }}>
        {isEmpty ? (
          <p className="muted">{t("system.projects.empty")}</p>
        ) : (
          <pre className="system-json-view">{json}</pre>
        )}
        {error ? (
          <div className="toast" title={error}>
            <AlertTriangle size={13} />
            <span>{error}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
