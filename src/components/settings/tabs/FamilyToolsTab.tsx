import { useCallback, useEffect, useRef, useState } from "react";
import { familyPackageCommand, familyToolsStatus, type FamilyToolId, type FamilyToolStatus } from "../../../lib/familyTools";
import { closeSettings } from "../../../lib/appOverlayStore";
import { visualModeController } from "../../../lib/visualModeStore";
import { useTranslation } from "../../../lib/i18n";
import { SettingsSection } from "../SettingsSection";
import { Button } from "../../ui/Button";

export function FamilyToolsTab() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<FamilyToolStatus[]>([]);
  const [selected, setSelected] = useState<FamilyToolId>("ahub");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previous, setPrevious] = useState<Partial<Record<FamilyToolId, string>>>({});
  const generation = useRef(0);
  const lastRows = useRef<FamilyToolStatus[]>([]);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setBusy(true);
    setError(null);
    try {
      const next = await familyToolsStatus();
      if (request !== generation.current) return;
      const prior = lastRows.current;
      setPrevious((current) => {
        const retained = { ...current };
        for (const old of prior) {
          if (old.installedVersion && next.some((row) => row.id === old.id && row.installedVersion && row.installedVersion !== old.installedVersion)) retained[old.id] = old.installedVersion;
        }
        return retained;
      });
      lastRows.current = next;
      setRows(next);
    } catch (cause) {
      if (request === generation.current) setError(String(cause));
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }, []);
  const invalidate = useCallback(() => { generation.current++; }, []);
  useEffect(() => { void refresh(); return invalidate; }, [refresh, invalidate]);
  const tool = rows.find((row) => row.id === selected);
  const command = tool?.ownership === "bun-global" ? familyPackageCommand(selected, tool.availableVersion) : null;
  const rollback = tool?.ownership === "bun-global" ? familyPackageCommand(selected, previous[selected] ?? null) : null;
  return <div className="settings-tab wide">
    <SettingsSection title={t("family.title")} description={t("family.boundary")} padded actions={<Button size="sm" disabled={busy} onClick={() => void refresh()}>{t("family.refresh")}</Button>}>
      {busy ? <p role="status">{t("family.loading")}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <label>{t("family.select")}<select value={selected} onChange={(event) => setSelected(event.target.value as FamilyToolId)}>{["ahub", "amem", "vmem", "acon"].map((id) => <option key={id} value={id}>{id}</option>)}</select></label>
      {tool ? <>
        <p>{tool.package}</p>
        <dl><dt>{t("family.state")}</dt><dd>{t(`family.state.${tool.state}`)}</dd><dt>{t("family.installed")}</dt><dd>{tool.installedVersion ?? t("family.unknown")}</dd><dt>{t("family.available")}</dt><dd>{tool.availableVersion ?? t("family.unknown")}</dd><dt>{t("family.ownership")}</dt><dd>{t(`family.owner.${tool.ownership}`)}</dd></dl>
        {tool.detail.map((detail) => <p key={detail} role="status">{detail}</p>)}
        {tool.commands.length ? <p>{t("family.commands")}: {tool.commands.join(", ")}</p> : <p>{t("family.noManifest")}</p>}
        {command ? <><h4>{t("family.installUpdate")}</h4><code>{command}</code></> : null}
        <p>{t("family.rollbackScope")}</p>
        {rollback ? <code>{rollback}</code> : <p>{t("family.noPrevious")}</p>}
        {tool.id === "acon" ? <Button disabled={!tool.canLaunch} onClick={() => { visualModeController.enqueueFamilyConsole(); closeSettings(); }}>{t("family.launch")}</Button> : null}
      </> : null}
    </SettingsSection>
  </div>;
}
