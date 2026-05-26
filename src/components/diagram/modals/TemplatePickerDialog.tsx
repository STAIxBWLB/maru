import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useMemo, useState } from "react";

import { bbox } from "../../../lib/diagram/geometry";
import {
  TEMPLATE_LIST,
  type TemplateDefinition,
} from "../../../lib/diagram/templates";
import { useTranslation } from "../../../lib/i18n";

export interface TemplatePickerDialogProps {
  open: boolean;
  /** True if the current doc has user-authored content (used to warn before replace). */
  dirty: boolean;
  onApply: (template: TemplateDefinition) => void;
  onCancel: () => void;
}

function TemplatePreview({ template, t }: { template: TemplateDefinition; t: (k: string) => string }) {
  const bundle = useMemo(() => template.build(0, 0, t), [template, t]);
  const box = useMemo(() => bbox(bundle.nodes), [bundle]);
  if (!box || bundle.nodes.length === 0) {
    return (
      <div className="anchor-diagram-template-preview is-empty">
        <span>—</span>
      </div>
    );
  }
  const pad = 20;
  const viewBox = `${box.x - pad} ${box.y - pad} ${box.w + pad * 2} ${box.h + pad * 2}`;
  return (
    <svg className="anchor-diagram-template-preview" viewBox={viewBox} aria-hidden="true">
      {bundle.nodes.map((n) => (
        <rect
          key={n.id}
          x={n.x}
          y={n.y}
          width={n.w}
          height={n.h}
          rx={4}
          ry={4}
          fill={n.style?.bg ?? "#ffffff"}
          stroke={n.style?.border ?? "#1f2937"}
          strokeWidth={n.style?.bw ?? 1.4}
        />
      ))}
      {bundle.edges.map((e) => {
        const from = bundle.nodes.find((n) => n.id === e.fromNode);
        const to = bundle.nodes.find((n) => n.id === e.toNode);
        if (!from || !to) return null;
        return (
          <line
            key={e.id}
            x1={from.x + from.w / 2}
            y1={from.y + from.h / 2}
            x2={to.x + to.w / 2}
            y2={to.y + to.h / 2}
            stroke={e.color ?? "#6b7280"}
            strokeWidth={1.2}
          />
        );
      })}
    </svg>
  );
}

export function TemplatePickerDialog({ open, dirty, onApply, onCancel }: TemplatePickerDialogProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>("blank");
  const [pendingApply, setPendingApply] = useState<TemplateDefinition | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return TEMPLATE_LIST;
    return TEMPLATE_LIST.filter((tpl) => {
      const label = t(tpl.labelKey).toLowerCase();
      const desc = t(tpl.descriptionKey).toLowerCase();
      return label.includes(q) || desc.includes(q);
    });
  }, [query, t]);

  const selected = TEMPLATE_LIST.find((tpl) => tpl.id === selectedId);

  const requestApply = (template: TemplateDefinition) => {
    if (dirty && template.id !== "blank") {
      setPendingApply(template);
      return;
    }
    onApply(template);
  };

  const handleApply = () => {
    if (!selected) return;
    requestApply(selected);
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content anchor-diagram-template-dialog">
          <div className="dialog-header">
            <Dialog.Title>{t("diagram.dialog.template.title")}</Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="icon-button"
                aria-label={t("diagram.dialog.template.cancel")}
                title={t("diagram.dialog.template.cancel")}
              >
                <X size={14} />
              </button>
            </Dialog.Close>
          </div>
          <div className="anchor-diagram-template-search">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("diagram.dialog.template.search")}
            />
          </div>
          <div className="anchor-diagram-template-grid">
            {filtered.map((tpl) => (
              <button
                key={tpl.id}
                type="button"
                className={`anchor-diagram-template-card${selectedId === tpl.id ? " is-selected" : ""}`}
                onClick={() => setSelectedId(tpl.id)}
                onDoubleClick={() => {
                  setSelectedId(tpl.id);
                  requestApply(tpl);
                }}
              >
                <TemplatePreview template={tpl} t={t} />
                <div className="anchor-diagram-template-meta">
                  <h3>{t(tpl.labelKey)}</h3>
                  <p>{t(tpl.descriptionKey)}</p>
                </div>
              </button>
            ))}
          </div>
          <div className="anchor-diagram-template-actions">
            <button type="button" onClick={onCancel}>{t("diagram.dialog.template.cancel")}</button>
            <button
              type="button"
              className="anchor-diagram-toolbar-primary"
              onClick={handleApply}
              disabled={!selected}
            >
              {t("diagram.dialog.template.apply")}
            </button>
          </div>
          <Dialog.Root
            open={pendingApply !== null}
            onOpenChange={(next) => {
              if (!next) setPendingApply(null);
            }}
          >
            <Dialog.Portal>
              <Dialog.Overlay className="dialog-overlay" />
              <Dialog.Content className="dialog-content anchor-diagram-confirm-dialog">
                <Dialog.Title>{t("diagram.dialog.template.confirmTitle")}</Dialog.Title>
                <p>{t("diagram.dialog.template.confirmReplace")}</p>
                <div className="dialog-actions">
                  <Dialog.Close asChild>
                    <button type="button">{t("diagram.dialog.confirm.cancel")}</button>
                  </Dialog.Close>
                  <button
                    type="button"
                    className="anchor-diagram-toolbar-primary"
                    onClick={() => {
                      const template = pendingApply;
                      setPendingApply(null);
                      if (template) onApply(template);
                    }}
                  >
                    {t("diagram.dialog.confirm.replace")}
                  </button>
                </div>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
