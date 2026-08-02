import { AlertTriangle, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "../../../lib/i18n";
import { Button } from "../../ui/Button";

export function SettingsJsonTab({
  title,
  value,
  onSave,
}: {
  title?: string;
  value: unknown;
  onSave: (value: unknown) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 2));
  const [pristine, setPristine] = useState(text);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const next = JSON.stringify(value ?? {}, null, 2);
    setText(next);
    setPristine(next);
    setError(null);
  }, [value]);

  const dirty = text !== pristine;

  return (
    <div className="system-detail" style={{ width: "100%" }}>
      <div className="system-detail-actions">
        {title ? <strong>{title}</strong> : null}
        <span style={{ flex: 1 }} />
        <span className={dirty ? "save-state dirty" : "save-state saved"}>
          {dirty ? t("system.rules.dirty") : t("system.rules.saved")}
        </span>
        <Button
          variant="primary"
          size="sm"
          disabled={!dirty}
          onClick={() => {
            setError(null);
            try {
              const parsed = JSON.parse(text);
              onSave(parsed);
              setPristine(text);
            } catch {
              setError(t("system.mcp.invalidJson"));
            }
          }}
          icon={<Save size={14} />}
        >
          {t("system.rules.save")}
        </Button>
      </div>
      <textarea
        className="source-editor"
        value={text}
        onChange={(event) => setText(event.target.value)}
        spellCheck={false}
      />
      {error ? (
        <div className="toast" title={error}>
          <AlertTriangle size={13} />
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  );
}
