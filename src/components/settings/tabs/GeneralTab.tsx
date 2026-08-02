// ============================ General ============================

import { useEffect, useState } from "react";
import { useTranslation } from "../../../lib/i18n";
import type {
  MaruSettings,
  DocumentBrowserMode,
  DocumentLabelMode,
  FileQueueDefaultOperation,
  FilesListAttribute,
  FilesSortKey,
  WorkspaceFileFilter,
} from "../../../lib/settings";
import {
  ALL_FILES_LIST_ATTRIBUTES,
  formatBinaryFileIncludePatterns,
  normalizeMaruSettings,
  parseBinaryFileIncludePatternsText,
} from "../../../lib/settings";
import { DIAGRAM_ENABLE_STORAGE_KEY } from "../../../lib/diagramFlag";
import { CompactSelect, ModeHeader } from "../../ui/ModeChrome";
import { Toggle } from "../../ui/Toggle";
import { SettingsSection } from "../SettingsSection";
import { SettingsRow } from "../SettingsRow";

export function GeneralTab({
  settings,
  onSettingsChange,
}: {
  settings: MaruSettings;
  onSettingsChange: (settings: MaruSettings) => void;
}) {
  const { t } = useTranslation();
  const [binaryPatternsText, setBinaryPatternsText] = useState(() =>
    formatBinaryFileIncludePatterns(settings.ui.binaryFileIncludePatterns),
  );

  useEffect(() => {
    setBinaryPatternsText(formatBinaryFileIncludePatterns(settings.ui.binaryFileIncludePatterns));
  }, [settings.ui.binaryFileIncludePatterns]);

  const updateUi = (patch: Partial<MaruSettings["ui"]>) => {
    onSettingsChange(
      normalizeMaruSettings({
        ...settings,
        ui: { ...settings.ui, ...patch },
      }),
    );
  };

  const toggleFilesListAttribute = (attribute: FilesListAttribute) => {
    const current = settings.ui.filesListAttributes;
    const next = current.includes(attribute)
      ? current.filter((value) => value !== attribute)
      : [...current, attribute];
    updateUi({ filesListAttributes: next });
  };

  return (
    <div className="settings-tab">
      <ModeHeader
        title={t("system.tab.preferences")}
        subtitle={t("system.general.subtitle")}
      />
      <SettingsSection title={t("system.general.section.files")}>
        <SettingsRow
          label={t("system.preferences.documentBrowser")}
          htmlFor="general-document-browser"
          control={
            <CompactSelect
              id="general-document-browser"
              value={settings.ui.documentBrowserMode}
              onChange={(event) =>
                updateUi({ documentBrowserMode: event.target.value as DocumentBrowserMode })
              }
            >
              <option value="list">{t("list.view.list")}</option>
              <option value="tree">{t("list.view.tree")}</option>
            </CompactSelect>
          }
        />
        <SettingsRow
          label={t("system.preferences.filesFilter")}
          htmlFor="general-files-filter"
          control={
            <CompactSelect
              id="general-files-filter"
              value={settings.ui.workspaceFileFilter}
              onChange={(event) =>
                updateUi({ workspaceFileFilter: event.target.value as WorkspaceFileFilter })
              }
            >
              <option value="all">{t("files.filter.all")}</option>
              <option value="tracked">{t("files.filter.tracked")}</option>
              <option value="binary">{t("files.filter.binary")}</option>
            </CompactSelect>
          }
        />
        <SettingsRow
          label={t("system.preferences.filesSort")}
          htmlFor="general-files-sort"
          control={
            <CompactSelect
              id="general-files-sort"
              value={settings.ui.filesSortKey}
              onChange={(event) =>
                updateUi({ filesSortKey: event.target.value as FilesSortKey })
              }
            >
              <option value="name">{t("files.sort.name")}</option>
              <option value="modifiedDesc">{t("files.sort.modifiedDesc")}</option>
              <option value="modifiedAsc">{t("files.sort.modifiedAsc")}</option>
            </CompactSelect>
          }
        />
        <SettingsRow
          label={t("system.preferences.filesListAttributes")}
          description={t("system.preferences.filesListAttributes.help")}
          wide
          control={
            <div className="settings-checkbox-grid">
              {ALL_FILES_LIST_ATTRIBUTES.map((attribute) => (
                <label key={attribute} className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={settings.ui.filesListAttributes.includes(attribute)}
                    onChange={() => toggleFilesListAttribute(attribute)}
                  />
                  <span>{t(`files.attributes.${attribute}`)}</span>
                </label>
              ))}
            </div>
          }
        />
        <SettingsRow
          label={t("system.preferences.binaryIncludePatterns")}
          description={t("system.preferences.binaryIncludePatterns.help")}
          htmlFor="general-binary-patterns"
          wide
          control={
            <textarea
              id="general-binary-patterns"
              className="settings-textarea"
              value={binaryPatternsText}
              onChange={(event) => setBinaryPatternsText(event.target.value)}
              onBlur={() =>
                updateUi({
                  binaryFileIncludePatterns:
                    parseBinaryFileIncludePatternsText(binaryPatternsText),
                })
              }
              spellCheck={false}
              rows={8}
            />
          }
        />
        <SettingsRow
          label={t("system.preferences.fileQueueOperation")}
          htmlFor="general-file-queue-operation"
          control={
            <CompactSelect
              id="general-file-queue-operation"
              value={settings.ui.fileQueueDefaultOperation}
              onChange={(event) =>
                updateUi({
                  fileQueueDefaultOperation: event.target.value as FileQueueDefaultOperation,
                })
              }
            >
              <option value="copy">{t("rightPane.files.copy")}</option>
              <option value="move">{t("rightPane.files.move")}</option>
            </CompactSelect>
          }
        />
        <SettingsRow
          label={t("system.preferences.documentLabel")}
          htmlFor="general-document-label"
          control={
            <CompactSelect
              id="general-document-label"
              value={settings.ui.documentLabelMode}
              onChange={(event) =>
                updateUi({ documentLabelMode: event.target.value as DocumentLabelMode })
              }
            >
              <option value="title">{t("system.preferences.documentLabel.title")}</option>
              <option value="filename">{t("system.preferences.documentLabel.filename")}</option>
              <option value="both">{t("system.preferences.documentLabel.both")}</option>
            </CompactSelect>
          }
        />
      </SettingsSection>
      <SettingsSection title={t("system.general.section.features")}>
        <DiagramPreviewRow />
      </SettingsSection>
    </div>
  );
}

function DiagramPreviewRow() {
  const { t } = useTranslation();
  const isOptOut = (value: string | null) => value === "0" || value === "false";
  const [enabled, setEnabled] = useState<boolean>(() => {
    try {
      return !isOptOut(window.localStorage.getItem(DIAGRAM_ENABLE_STORAGE_KEY));
    } catch {
      return true;
    }
  });
  const toggle = (next: boolean) => {
    setEnabled(next);
    try {
      if (next) window.localStorage.removeItem(DIAGRAM_ENABLE_STORAGE_KEY);
      else window.localStorage.setItem(DIAGRAM_ENABLE_STORAGE_KEY, "0");
    } catch {
      /* ignore */
    }
  };
  return (
    <SettingsRow
      label={t("diagram.system.preview.label")}
      description={t("diagram.system.preview.hint")}
      control={<Toggle checked={enabled} onChange={toggle} aria-label={t("diagram.system.preview.label")} />}
    />
  );
}
