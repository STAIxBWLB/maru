import * as Dialog from "@radix-ui/react-dialog";
import { Star, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import {
  diagramPatternDelete,
  diagramPatternList,
  diagramPatternLoad,
  diagramPatternSave,
} from "../../../lib/diagram";
import { bbox } from "../../../lib/diagram/geometry";
import {
  PATTERN_LIST,
  REPORT_PATTERN_LIST,
  type PatternDefinition,
} from "../../../lib/diagram/patterns";
import {
  serializePreset,
  validatePreset,
  type PatternPresetV1,
} from "../../../lib/diagram/presets";
import type { ReportDataset } from "../../../lib/diagram/reportTypes";
import { createDiagramId } from "../../../lib/diagram/types";
import { useTranslation } from "../../../lib/i18n";

/** A gallery selection: a registry pattern or a validated workspace preset. */
export type GallerySelection =
  | { kind: "pattern"; patternId: string }
  | { kind: "preset"; storageName: string; preset: PatternPresetV1 };

export interface PatternGalleryDialogProps {
  open: boolean;
  /** True when the current doc has user content (confirm before "New document"). */
  dirty: boolean;
  workspace: string | null;
  /** View available for "Convert selected view" (single view-linked selection). */
  convertViewId: string | null;
  /** Opened via "Convert view…" — double-click/Apply defaults to converting. */
  initialMode?: "apply" | "convert";
  /** Selection-derived preset draft for "Save as workspace preset". */
  presetDraft: {
    patternId: string;
    theme?: string;
    style?: Record<string, string | number | boolean>;
  } | null;
  favorites: string[];
  recents: string[];
  onToggleFavorite: (patternId: string) => void;
  onNewDocument: (selection: GallerySelection) => void;
  onInsertAtPointer: (selection: GallerySelection) => void;
  onConvert: (patternId: string) => void;
  onNotice?: (message: string) => void;
  onClose: () => void;
}

interface LoadedPreset {
  storageName: string;
  preset: PatternPresetV1;
}

function PatternPreview({
  pattern,
  dataset,
  t,
}: {
  pattern: PatternDefinition;
  dataset?: ReportDataset;
  t: (k: string) => string;
}) {
  const bundle = useMemo(() => {
    const ds =
      dataset ??
      (pattern.freeform
        ? (undefined as unknown as ReportDataset)
        : pattern.createDataset?.({ t }));
    if (!ds && !pattern.freeform) return { nodes: [], edges: [] };
    return pattern.buildView({
      dataset: ds as ReportDataset,
      bounds: { x: 0, y: 0, w: 400, h: 280 },
      t,
    });
  }, [pattern, dataset, t]);
  const box = useMemo(() => bbox(bundle.nodes), [bundle]);
  if (!box || bundle.nodes.length === 0) {
    return (
      <div className="maru-diagram-template-preview is-empty">
        <span>—</span>
      </div>
    );
  }
  const pad = 20;
  const viewBox = `${box.x - pad} ${box.y - pad} ${box.w + pad * 2} ${box.h + pad * 2}`;
  return (
    <svg className="maru-diagram-template-preview" viewBox={viewBox} aria-hidden="true">
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

export function PatternGalleryDialog({
  open,
  dirty,
  workspace,
  convertViewId,
  initialMode = "apply",
  presetDraft,
  favorites,
  recents,
  onToggleFavorite,
  onNewDocument,
  onInsertAtPointer,
  onConvert,
  onNotice,
  onClose,
}: PatternGalleryDialogProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string>("");
  const [pendingNewDoc, setPendingNewDoc] = useState<GallerySelection | null>(null);
  const [presets, setPresets] = useState<LoadedPreset[]>([]);
  const [skippedPresets, setSkippedPresets] = useState(0);
  const [presetName, setPresetName] = useState("");

  const reloadPresets = useCallback(async () => {
    if (!workspace) {
      setPresets([]);
      setSkippedPresets(0);
      return;
    }
    try {
      const files = await diagramPatternList(workspace);
      const valid: LoadedPreset[] = [];
      let skipped = 0;
      for (const file of files) {
        try {
          const body = await diagramPatternLoad(workspace, file.name);
          const result = validatePreset(JSON.parse(body));
          if (result.ok) valid.push({ storageName: file.name, preset: result.preset });
          else skipped += 1;
        } catch {
          skipped += 1;
        }
      }
      setPresets(valid);
      setSkippedPresets(skipped);
    } catch {
      setPresets([]);
      setSkippedPresets(0);
    }
  }, [workspace]);

  useEffect(() => {
    if (open) void reloadPresets();
  }, [open, reloadPresets]);

  useEffect(() => {
    if (open && skippedPresets > 0) {
      onNotice?.(t("diagram.gallery.presetsSkipped", { count: String(skippedPresets) }));
    }
  }, [open, skippedPresets, onNotice, t]);

  const patternById = useMemo(
    () => new Map(PATTERN_LIST.map((pattern) => [pattern.id, pattern])),
    [],
  );

  const matchesQuery = useCallback(
    (label: string, description: string) => {
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return label.toLowerCase().includes(q) || description.toLowerCase().includes(q);
    },
    [query],
  );

  const favoritePatterns = useMemo(
    () =>
      favorites
        .map((id) => patternById.get(id))
        .filter((p): p is PatternDefinition => Boolean(p))
        .filter((p) => matchesQuery(t(p.labelKey), t(p.descriptionKey))),
    [favorites, patternById, matchesQuery, t],
  );
  const recentPatterns = useMemo(
    () =>
      recents
        .map((id) => patternById.get(id))
        .filter((p): p is PatternDefinition => Boolean(p))
        .filter((p) => matchesQuery(t(p.labelKey), t(p.descriptionKey))),
    [recents, patternById, matchesQuery, t],
  );
  const filteredPresets = useMemo(
    () =>
      presets.filter(({ preset }) => {
        const pattern = patternById.get(preset.patternId);
        return matchesQuery(
          preset.name,
          pattern ? t(pattern.labelKey) : preset.patternId,
        );
      }),
    [presets, patternById, matchesQuery, t],
  );
  const filteredReport = useMemo(
    () => REPORT_PATTERN_LIST.filter((p) => matchesQuery(t(p.labelKey), t(p.descriptionKey))),
    [matchesQuery, t],
  );
  const filteredTemplates = useMemo(
    () =>
      PATTERN_LIST.filter((p) => p.freeform).filter((p) =>
        matchesQuery(t(p.labelKey), t(p.descriptionKey)),
      ),
    [matchesQuery, t],
  );

  const selection: GallerySelection | null = useMemo(() => {
    if (selectedKey.startsWith("preset:")) {
      const storageName = selectedKey.slice("preset:".length);
      const found = presets.find((p) => p.storageName === storageName);
      return found ? { kind: "preset", storageName, preset: found.preset } : null;
    }
    if (selectedKey.startsWith("pattern:")) {
      return { kind: "pattern", patternId: selectedKey.slice("pattern:".length) };
    }
    return null;
  }, [selectedKey, presets]);

  const selectionPatternId = selection
    ? selection.kind === "pattern"
      ? selection.patternId
      : selection.preset.patternId
    : null;

  const requestNewDocument = (sel: GallerySelection) => {
    const patternId = sel.kind === "pattern" ? sel.patternId : sel.preset.patternId;
    if (dirty && patternId !== "blank") {
      setPendingNewDoc(sel);
      return;
    }
    onNewDocument(sel);
  };

  const defaultApply = (sel: GallerySelection) => {
    if (initialMode === "convert" && convertViewId) {
      const patternId = sel.kind === "pattern" ? sel.patternId : sel.preset.patternId;
      onConvert(patternId);
      return;
    }
    requestNewDocument(sel);
  };

  const savePreset = async () => {
    if (!workspace || !presetDraft) return;
    const name = presetName.trim();
    if (!name) {
      onNotice?.(t("diagram.gallery.presetNameRequired"));
      return;
    }
    const now = Date.now();
    const candidate: PatternPresetV1 = {
      v: 1,
      id: createDiagramId("preset"),
      name,
      patternId: presetDraft.patternId,
      ...(presetDraft.theme !== undefined ? { theme: presetDraft.theme } : {}),
      ...(presetDraft.style !== undefined ? { style: presetDraft.style } : {}),
      createdAt: now,
      updatedAt: now,
    };
    const validation = validatePreset(candidate);
    if (!validation.ok) {
      onNotice?.(validation.errors.join(", "));
      return;
    }
    try {
      await diagramPatternSave(workspace, name, serializePreset(validation.preset));
      setPresetName("");
      await reloadPresets();
      onNotice?.(t("diagram.gallery.presetSaved"));
    } catch (err) {
      onNotice?.((err as Error).message ?? "preset save failed");
    }
  };

  const deletePreset = async (storageName: string) => {
    if (!workspace) return;
    try {
      await diagramPatternDelete(workspace, storageName);
      await reloadPresets();
    } catch (err) {
      onNotice?.((err as Error).message ?? "preset delete failed");
    }
  };

  const renderStar = (patternId: string) => {
    const starred = favorites.includes(patternId);
    return (
      <button
        type="button"
        className={`maru-diagram-gallery-star${starred ? " is-starred" : ""}`}
        aria-label={t(starred ? "diagram.gallery.favorite.remove" : "diagram.gallery.favorite.add")}
        title={t(starred ? "diagram.gallery.favorite.remove" : "diagram.gallery.favorite.add")}
        aria-pressed={starred}
        onClick={(e) => {
          e.stopPropagation();
          onToggleFavorite(patternId);
        }}
      >
        <Star size={12} fill={starred ? "currentColor" : "none"} />
      </button>
    );
  };

  const renderPatternCard = (pattern: PatternDefinition) => {
    const key = `pattern:${pattern.id}`;
    return (
      <div
        key={key}
        role="button"
        tabIndex={0}
        className={`maru-diagram-template-card${selectedKey === key ? " is-selected" : ""}`}
        data-testid={`gallery-card-${pattern.id}`}
        onClick={() => setSelectedKey(key)}
        onDoubleClick={() => {
          setSelectedKey(key);
          defaultApply({ kind: "pattern", patternId: pattern.id });
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") setSelectedKey(key);
        }}
      >
        {renderStar(pattern.id)}
        <PatternPreview pattern={pattern} t={t} />
        <div className="maru-diagram-template-meta">
          <h3>{t(pattern.labelKey)}</h3>
          <p>{t(pattern.descriptionKey)}</p>
        </div>
      </div>
    );
  };

  const renderPresetCard = ({ storageName, preset }: LoadedPreset) => {
    const key = `preset:${storageName}`;
    const pattern = patternById.get(preset.patternId);
    return (
      <div
        key={key}
        role="button"
        tabIndex={0}
        className={`maru-diagram-template-card${selectedKey === key ? " is-selected" : ""}`}
        data-testid={`gallery-preset-${storageName}`}
        onClick={() => setSelectedKey(key)}
        onDoubleClick={() => {
          setSelectedKey(key);
          defaultApply({ kind: "preset", storageName, preset });
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") setSelectedKey(key);
        }}
      >
        {renderStar(preset.patternId)}
        <button
          type="button"
          className="maru-diagram-gallery-delete"
          aria-label={t("diagram.gallery.action.deletePreset")}
          title={t("diagram.gallery.action.deletePreset")}
          onClick={(e) => {
            e.stopPropagation();
            void deletePreset(storageName);
          }}
        >
          <X size={12} />
        </button>
        {pattern ? (
          <PatternPreview pattern={pattern} dataset={preset.datasetSeed} t={t} />
        ) : (
          <div className="maru-diagram-template-preview is-empty">
            <span>—</span>
          </div>
        )}
        <div className="maru-diagram-template-meta">
          <h3>{preset.name}</h3>
          <p>{pattern ? t(pattern.labelKey) : preset.patternId}</p>
        </div>
      </div>
    );
  };

  const renderSection = (
    labelKey: string,
    testId: string,
    cards: ReactNode[],
  ) =>
    cards.length > 0 ? (
      <section className="maru-diagram-gallery-section" data-testid={testId}>
        <h3 className="maru-diagram-gallery-heading">{t(labelKey)}</h3>
        <div className="maru-diagram-template-grid">{cards}</div>
      </section>
    ) : null;

  const isEmpty =
    favoritePatterns.length === 0 &&
    recentPatterns.length === 0 &&
    filteredPresets.length === 0 &&
    filteredReport.length === 0 &&
    filteredTemplates.length === 0;

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content maru-diagram-template-dialog maru-diagram-gallery-dialog">
          <div className="dialog-header">
            <Dialog.Title>{t("diagram.gallery.title")}</Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="icon-button"
                aria-label={t("diagram.gallery.close")}
                title={t("diagram.gallery.close")}
              >
                <X size={14} />
              </button>
            </Dialog.Close>
          </div>
          <div className="maru-diagram-template-search">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("diagram.gallery.search")}
            />
          </div>
          <div className="maru-diagram-gallery-body">
            {isEmpty ? (
              <p className="maru-diagram-gallery-empty">{t("diagram.gallery.empty")}</p>
            ) : (
              <>
                {renderSection(
                  "diagram.gallery.section.favorites",
                  "gallery-section-favorites",
                  favoritePatterns.map(renderPatternCard),
                )}
                {renderSection(
                  "diagram.gallery.section.recents",
                  "gallery-section-recents",
                  recentPatterns.map(renderPatternCard),
                )}
                {renderSection(
                  "diagram.gallery.section.presets",
                  "gallery-section-presets",
                  filteredPresets.map(renderPresetCard),
                )}
                {renderSection(
                  "diagram.gallery.section.report",
                  "gallery-section-report",
                  filteredReport.map(renderPatternCard),
                )}
                {renderSection(
                  "diagram.gallery.section.templates",
                  "gallery-section-templates",
                  filteredTemplates.map(renderPatternCard),
                )}
              </>
            )}
          </div>
          {presetDraft && workspace ? (
            <div className="maru-diagram-gallery-preset-save">
              <input
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                placeholder={t("diagram.gallery.presetName.placeholder")}
                aria-label={t("diagram.gallery.presetName.placeholder")}
              />
              <button type="button" onClick={() => void savePreset()}>
                {t("diagram.gallery.action.savePreset")}
              </button>
            </div>
          ) : null}
          <div className="maru-diagram-template-actions">
            <button type="button" onClick={onClose}>
              {t("diagram.gallery.close")}
            </button>
            <button
              type="button"
              onClick={() => selection && onConvert(selectionPatternId!)}
              disabled={!selection || !convertViewId}
              data-testid="gallery-action-convert"
            >
              {t("diagram.gallery.action.convert")}
            </button>
            <button
              type="button"
              onClick={() => selection && onInsertAtPointer(selection)}
              disabled={!selection}
              data-testid="gallery-action-insert"
            >
              {t("diagram.gallery.action.insert")}
            </button>
            <button
              type="button"
              className="maru-diagram-toolbar-primary"
              onClick={() => selection && requestNewDocument(selection)}
              disabled={!selection}
              data-testid="gallery-action-new-document"
            >
              {t("diagram.gallery.action.newDocument")}
            </button>
          </div>
          <Dialog.Root
            open={pendingNewDoc !== null}
            onOpenChange={(next) => {
              if (!next) setPendingNewDoc(null);
            }}
          >
            <Dialog.Portal>
              <Dialog.Overlay className="dialog-overlay" />
              <Dialog.Content className="dialog-content maru-diagram-confirm-dialog">
                <Dialog.Title>{t("diagram.dialog.template.confirmTitle")}</Dialog.Title>
                <p>{t("diagram.dialog.template.confirmReplace")}</p>
                <div className="dialog-actions">
                  <Dialog.Close asChild>
                    <button type="button">{t("diagram.dialog.confirm.cancel")}</button>
                  </Dialog.Close>
                  <button
                    type="button"
                    className="maru-diagram-toolbar-primary"
                    onClick={() => {
                      const sel = pendingNewDoc;
                      setPendingNewDoc(null);
                      if (sel) onNewDocument(sel);
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
