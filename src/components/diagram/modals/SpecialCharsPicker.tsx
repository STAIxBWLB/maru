import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { useTranslation } from "../../../lib/i18n";

export interface SpecialCharsPickerProps {
  open: boolean;
  onInsert: (char: string) => void;
  onClose: () => void;
}

const GROUPS: Array<{ key: string; chars: string[] }> = [
  { key: "arrows", chars: ["→", "←", "↑", "↓", "↔", "↕", "⇒", "⇐", "⇑", "⇓", "↗", "↘", "↖", "↙", "↻", "↺"] },
  { key: "bullets", chars: ["•", "◦", "▪", "▫", "★", "☆", "✓", "✗", "✔", "✘", "✦", "✧", "✱", "✶"] },
  { key: "geometric", chars: ["■", "□", "▣", "▤", "▥", "▦", "▧", "▨", "▩", "▲", "△", "▼", "▽", "◆", "◇", "○", "●", "◐", "◑", "◒", "◓"] },
  { key: "math", chars: ["±", "×", "÷", "≠", "≤", "≥", "≈", "∞", "∑", "∫", "∂", "√", "π", "Δ", "Ω", "α", "β", "γ", "θ", "λ", "μ", "σ"] },
  { key: "punctuation", chars: ["·", "—", "–", "…", "·", "‹", "›", "«", "»", "“", "”", "‘", "’", "§", "¶", "©", "®", "™"] },
];

export function SpecialCharsPicker({ open, onInsert, onClose }: SpecialCharsPickerProps) {
  const { t } = useTranslation();
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content anchor-diagram-specialchars-dialog">
          <div className="dialog-header">
            <Dialog.Title>{t("diagram.specialChars.heading")}</Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="icon-button"
                aria-label={t("diagram.specialChars.close")}
                title={t("diagram.specialChars.close")}
              >
                <X size={14} />
              </button>
            </Dialog.Close>
          </div>
          <p className="anchor-diagram-specialchars-hint">{t("diagram.specialChars.hint")}</p>
          <div className="anchor-diagram-specialchars-groups">
            {GROUPS.map((group) => (
              <div key={group.key} className="anchor-diagram-specialchars-group">
                <div className="anchor-diagram-specialchars-grid">
                  {group.chars.map((ch, i) => (
                    <button
                      key={`${group.key}-${i}`}
                      type="button"
                      onClick={() => onInsert(ch)}
                      title={ch}
                      aria-label={ch}
                    >
                      {ch}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
