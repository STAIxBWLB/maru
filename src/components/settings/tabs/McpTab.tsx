import { AlertTriangle, Save } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { readMaruMcp, saveMaruMcp } from "../../../lib/maruDir";
import { useTranslation } from "../../../lib/i18n";
import { Button } from "../../ui/Button";
import { ModeHeader } from "../../ui/ModeChrome";
import { SettingsSection } from "../SettingsSection";

// ================================ MCP ================================

export function McpTab({ workPath }: { workPath: string }) {
  const { t } = useTranslation();
  const [text, setText] = useState<string>("");
  const [pristine, setPristine] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const value = await readMaruMcp(workPath);
      const json = JSON.stringify(value ?? {}, null, 2);
      setText(json);
      setPristine(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onSave = useCallback(async () => {
    setError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setError(t("system.mcp.invalidJson"));
      return;
    }
    try {
      await saveMaruMcp(workPath, parsed);
      setPristine(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workPath, text, t]);

  const dirty = text !== pristine;

  return (
    <div className="settings-tab wide">
      <ModeHeader
        title={t("system.tab.mcp")}
        actions={
          <>
            <span className={dirty ? "save-state dirty" : "save-state saved"}>
              {dirty ? t("system.rules.dirty") : t("system.rules.saved")}
            </span>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void onSave()}
              disabled={!dirty}
              icon={<Save size={14} />}
            >
              {t("system.mcp.save")}
            </Button>
          </>
        }
      />
      <SettingsSection title={t("system.tab.mcp")}>
        <div className="system-detail" style={{ width: "100%" }}>
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
      </SettingsSection>
    </div>
  );
}
