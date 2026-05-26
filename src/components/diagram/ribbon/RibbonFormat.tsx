import { useCallback } from "react";

import { defaultCoalescer, pasteStyleToSelection, withSnapshot } from "../../../lib/diagram/actions";
import { useDiagram, useDiagramStore } from "../DiagramStoreContext";
import { useTranslation } from "../../../lib/i18n";
import { RibbonButton, RibbonGroup } from "./ribbonPrimitives";

interface Preset {
  id: string;
  labelKey: string;
  bg: string;
  border: string;
  fc: string;
}

const PRESETS: Preset[] = [
  { id: "white", labelKey: "diagram.colorPreset.white", bg: "#FFFFFF", border: "#1F2937", fc: "#1A1A1A" },
  { id: "light", labelKey: "diagram.colorPreset.light", bg: "#EEEEEE", border: "#9CA3AF", fc: "#333333" },
  { id: "silver", labelKey: "diagram.colorPreset.silver", bg: "#BBBBBB", border: "#6B7280", fc: "#333333" },
  { id: "mid", labelKey: "diagram.colorPreset.mid", bg: "#888888", border: "#4B5563", fc: "#FFFFFF" },
  { id: "dark", labelKey: "diagram.colorPreset.dark", bg: "#444444", border: "#1F2937", fc: "#FFFFFF" },
  { id: "black", labelKey: "diagram.colorPreset.black", bg: "#1A1A1A", border: "#000000", fc: "#FFFFFF" },
];

export function RibbonFormat() {
  const { t } = useTranslation();
  const store = useDiagramStore();
  const selection = useDiagram((s) => s.ephemeral.selection.nodes);
  const disabled = selection.size === 0;

  const apply = useCallback(
    (preset: Preset) => {
      store.setState(
        withSnapshot(
          pasteStyleToSelection({ bg: preset.bg, border: preset.border, fc: preset.fc }),
          defaultCoalescer(),
        ),
      );
    },
    [store],
  );

  return (
    <RibbonGroup labelKey="diagram.colorPreset.heading">
      {PRESETS.map((preset) => (
        <button
          key={preset.id}
          type="button"
          className="anchor-diagram-color-preset"
          disabled={disabled}
          onClick={() => apply(preset)}
          title={t(preset.labelKey)}
          aria-label={t(preset.labelKey)}
          style={{ background: preset.bg, color: preset.fc, borderColor: preset.border }}
        >
          {t(preset.labelKey)}
        </button>
      ))}
    </RibbonGroup>
  );
}
