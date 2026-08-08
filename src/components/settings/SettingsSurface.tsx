// Settings surface — full-screen overlay inside the main window. Owns the
// sidebar nav and hosts the (still legacy-styled) tab bodies from
// SettingsTabBody.tsx until the per-tab rewrite lands.

import { useEffect, useRef, useState } from "react";
import {
  closeSettings,
  setSettingsTab,
  useSettingsOverlay,
} from "../../lib/appOverlayStore";
import { useTranslation } from "../../lib/i18n";
import type { MaruSettings } from "../../lib/settings";
import type { InboxRuntimeConfig } from "../../lib/types";
import { SettingsTabBody } from "./SettingsTabBody";
import { SettingsNavSidebar } from "./SettingsNavSidebar";
import { isSettingsTabId, type SettingsTabId } from "./settingsNav";
import "./settings.css";

interface SettingsSurfaceProps {
  workPath: string | null;
  settings: MaruSettings;
  onSettingsChange: (settings: MaruSettings) => void;
  onInboxRuntimeConfigChange?: (config: InboxRuntimeConfig) => void;
}

export default function SettingsSurface({
  workPath,
  settings,
  onSettingsChange,
  onInboxRuntimeConfigChange,
}: SettingsSurfaceProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  // Open state + active tab live in the app overlay store (step 9); the
  // overlay is only mounted while open, so `tab` is always readable here.
  const settingsOverlay = useSettingsOverlay();
  const tab = settingsOverlay?.tab ?? null;
  const activeTab: SettingsTabId = isSettingsTabId(tab) ? tab : "preferences";

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div
      className="settings-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t("system.title")}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          closeSettings();
        } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
          event.preventDefault();
          searchInputRef.current?.focus();
        }
      }}
    >
      <SettingsNavSidebar
        activeTab={activeTab}
        onTabChange={setSettingsTab}
        query={query}
        onQueryChange={setQuery}
        searchInputRef={searchInputRef}
        onClose={closeSettings}
      />
      <div className="settings-content" role="tabpanel">
        <SettingsTabBody
          workPath={workPath}
          settings={settings}
          onSettingsChange={onSettingsChange}
          onInboxRuntimeConfigChange={onInboxRuntimeConfigChange}
          tab={activeTab}
          onTabChange={setSettingsTab}
        />
      </div>
    </div>
  );
}
