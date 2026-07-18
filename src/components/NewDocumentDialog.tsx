import * as Dialog from "@radix-ui/react-dialog";
import { FilePlus2, Library, Waypoints, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "./ui/Button";
import { Field, TextArea, TextInput } from "./ui/Field";
import { buildAdjacency, buildVaultGraph } from "../lib/graph/model";
import { useTranslation } from "../lib/i18n";
import type { VaultEntry } from "../lib/types";
import { buildEntryIndex, resolveTargetIndexed } from "../lib/wikilinkSuggestions";
import {
  defaultMaruDocType,
  fetchGuidelines,
  fetchTemplate,
  fetchTemplates,
  renderTemplateBody,
  type DocumentCategory,
  type GuidelineSummary,
  type TemplateSummary,
} from "../lib/hubLibrary";

interface NewDocumentDialogProps {
  open: boolean;
  workspaceRoot?: string | null;
  initialTitle?: string;
  initialRelPath?: string | null;
  initialDocType?: string;
  initialOpenLibrary?: boolean;
  /** Workspace entries — powers the related-context neighbor panel (F3(a)). */
  entries?: VaultEntry[];
  onOpenChange: (open: boolean) => void;
  onCreate: (
    title: string,
    docType: string,
    body: string,
    targetRelPath: string | null,
    extras?: NewDocumentExtras,
  ) => Promise<void>;
}

export interface NewDocumentExtras {
  templateId?: string;
  templateSlug?: string;
  templateVersion?: number;
  guidelineIds?: string[];
  businessUnit?: string;
}

const CATEGORY_OPTIONS: { value: DocumentCategory | "all"; labelKey: string }[] = [
  { value: "all", labelKey: "newdoc.category.all" },
  { value: "formal_report", labelKey: "newdoc.category.formalReport" },
  { value: "admin_approval", labelKey: "newdoc.category.adminApproval" },
  { value: "evidence_certification", labelKey: "newdoc.category.evidenceCert" },
  { value: "operational", labelKey: "newdoc.category.operational" },
];

export function NewDocumentDialog({
  open,
  workspaceRoot,
  initialTitle = "",
  initialRelPath = null,
  initialDocType = "reference",
  initialOpenLibrary = false,
  entries,
  onOpenChange,
  onCreate,
}: NewDocumentDialogProps) {
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const [docType, setDocType] = useState("reference");
  const [relPath, setRelPath] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Hub library state
  const [useLibrary, setUseLibrary] = useState(false);
  const [category, setCategory] = useState<DocumentCategory | "all">("all");
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [guidelines, setGuidelines] = useState<GuidelineSummary[]>([]);
  const [selectedTemplateSlug, setSelectedTemplateSlug] = useState<string | null>(null);
  const [selectedGuidelineIds, setSelectedGuidelineIds] = useState<string[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryError, setLibraryError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(initialTitle);
    setDocType(initialDocType);
    setRelPath(initialRelPath ?? "");
    setBody("");
    setError(null);
    setSaving(false);
    setUseLibrary(initialOpenLibrary);
    setCategory("all");
    setSelectedTemplateSlug(null);
    setSelectedGuidelineIds([]);
    setLibraryError(null);
  }, [open, initialTitle, initialRelPath, initialDocType, initialOpenLibrary]);

  // Fetch templates + guidelines when the library opens
  useEffect(() => {
    if (!open || !useLibrary || !workspaceRoot) return;
    let cancelled = false;
    setLibraryLoading(true);
    setLibraryError(null);
    Promise.all([
      fetchTemplates({
        workspaceRoot,
        category: category === "all" ? undefined : category,
      }),
      fetchGuidelines({ workspaceRoot }),
    ])
      .then(([tpls, gdls]) => {
        if (cancelled) return;
        setTemplates(tpls);
        setGuidelines(gdls);
      })
      .catch((err) => {
        if (cancelled) return;
        setLibraryError(String(err));
      })
      .finally(() => {
        if (!cancelled) setLibraryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, useLibrary, workspaceRoot, category]);

  const filteredTemplates = useMemo(
    () =>
      category === "all"
        ? templates
        : templates.filter((t) => t.document_type_category === category),
    [templates, category],
  );

  // F3(a) related-context panel: resolve title tokens against the workspace,
  // surface each resolved entity's 1-hop neighbors (degree desc, ≤8) as
  // chips; clicking one inserts `[[target]]` into the draft body — the body
  // wikilink becomes a live graph edge on the created note.
  const relatedNeighbors = useMemo(() => {
    if (!open || !entries || entries.length === 0 || !title.trim()) return [];
    const index = buildEntryIndex(entries);
    const model = buildVaultGraph(entries, index);
    const adjacency = buildAdjacency(model);
    const degreeById = new Map(model.nodes.map((n) => [n.id, n.degree]));
    const labelById = new Map(model.nodes.map((n) => [n.id, n.label]));
    const ghostIds = new Set(
      model.nodes.filter((n) => n.type === "unresolved").map((n) => n.id),
    );
    const tokens = [title.trim(), ...title.trim().split(/\s+/).filter((w) => w.length >= 2)];
    const neighborIds = new Set<string>();
    for (const token of tokens) {
      const resolved = resolveTargetIndexed(index, entries, token);
      if (!resolved) continue;
      const filename = resolved.relPath.split("/").pop() ?? "";
      const stem = filename.replace(/\.(md|mdx|markdown)$/i, "").toLowerCase();
      for (const neighbor of adjacency.get(stem) ?? []) {
        if (!ghostIds.has(neighbor)) neighborIds.add(neighbor);
      }
    }
    return [...neighborIds]
      .sort((a, b) => (degreeById.get(b) ?? 0) - (degreeById.get(a) ?? 0))
      .slice(0, 8)
      .map((id) => ({ id, label: labelById.get(id) ?? id }));
  }, [open, entries, title]);

  function insertRelatedLink(id: string) {
    const link = `[[${id}]]`;
    if (body.includes(link)) return;
    setBody((current) => (current ? `${current}\n${link}` : link));
  }

  const filteredGuidelines = useMemo(() => {
    const tpl = templates.find((t) => t.slug === selectedTemplateSlug);
    if (!tpl) return guidelines;
    return guidelines.filter((g) => {
      if (g.scope === "global") return true;
      if (g.scope === "business_unit") return g.business_unit_slug === tpl.business_unit_slug;
      if (g.scope === "document_type") return g.document_type_code === tpl.document_type_code;
      return true;
    });
  }, [guidelines, templates, selectedTemplateSlug]);

  async function applyTemplate(slug: string): Promise<void> {
    if (!workspaceRoot) return;
    setLibraryError(null);
    try {
      const full = await fetchTemplate(slug, { workspaceRoot });
      const summary = templates.find((t) => t.slug === slug) ?? null;
      // Only prefill empty fields to avoid clobbering user input.
      const tplTitle = full.title.replace(/\s*\(합성\)\s*$/, "");
      if (!title) setTitle(initialTitle || tplTitle);
      if (docType === "reference" || docType === initialDocType) {
        setDocType(defaultMaruDocType(summary));
      }
      setBody(renderTemplateBody(full, t("newdoc.bodyPlaceholder")));
      setSelectedTemplateSlug(slug);
    } catch (err) {
      setLibraryError(err instanceof Error ? err.message : String(err));
    }
  }

  function toggleGuideline(id: string): void {
    setSelectedGuidelineIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  async function submit() {
    setError(null);
    if (!title.trim()) {
      setError(t("newDoc.error.title"));
      return;
    }
    if (!docType.trim()) {
      setError(t("newDoc.error.type"));
      return;
    }
    setSaving(true);
    try {
      const tplSummary = templates.find((t) => t.slug === selectedTemplateSlug) ?? null;
      const extras: NewDocumentExtras | undefined = useLibrary
        ? {
            templateId: tplSummary?.id,
            templateSlug: tplSummary?.slug,
            templateVersion: tplSummary?.version,
            guidelineIds: selectedGuidelineIds,
            businessUnit: tplSummary?.business_unit_slug ?? undefined,
          }
        : undefined;
      await onCreate(title.trim(), docType.trim(), body.trim(), relPath.trim() || null, extras);
      setTitle("");
      setDocType("reference");
      setRelPath("");
      setBody("");
      setUseLibrary(false);
      setSelectedTemplateSlug(null);
      setSelectedGuidelineIds([]);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content dialog-content--wide">
          <div className="dialog-header">
            <div>
              <Dialog.Title>{t("newDoc.dialog.title")}</Dialog.Title>
              <Dialog.Description>{t("newDoc.dialog.description")}</Dialog.Description>
            </div>
            <Dialog.Close
              className="icon-button"
              title={t("app.errorClose")}
              aria-label={t("app.errorClose")}
            >
              <X size={16} />
            </Dialog.Close>
          </div>

          {workspaceRoot ? (
            <label className="new-doc-library-toggle">
              <input
                type="checkbox"
                checked={useLibrary}
                onChange={(e) => setUseLibrary(e.target.checked)}
              />
              <Library size={14} />
              <span>{t("newDoc.library.toggle")}</span>
            </label>
          ) : null}

          {useLibrary ? (
            <div className="new-doc-library">
              <div className="new-doc-library__filters">
                {CATEGORY_OPTIONS.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    className={category === c.value ? "active" : ""}
                    onClick={() => setCategory(c.value)}
                  >
                    {t(c.labelKey)}
                  </button>
                ))}
              </div>

              {libraryLoading && (
                <div className="new-doc-library__status">{t("newDoc.library.loading")}</div>
              )}
              {libraryError && (
                <div className="new-doc-library__error">
                  {t("newDoc.library.error")}: {libraryError}
                </div>
              )}

              <div className="new-doc-library__grid">
                <section>
                  <h4>{t("newDoc.library.templates")}</h4>
                  {filteredTemplates.length === 0 && !libraryLoading ? (
                    <p className="new-doc-library__empty">
                      {t("newDoc.library.templates.empty")}
                    </p>
                  ) : (
                    <ul className="new-doc-library__list">
                      {filteredTemplates.map((tpl) => (
                        <li key={tpl.id}>
                          <button
                            type="button"
                            className={
                              selectedTemplateSlug === tpl.slug
                                ? "new-doc-library__item active"
                                : "new-doc-library__item"
                            }
                            onClick={() => void applyTemplate(tpl.slug)}
                          >
                            <div className="new-doc-library__item-title">{tpl.title}</div>
                            <div className="new-doc-library__item-meta">
                              <span>{tpl.document_type_code}</span>
                              {tpl.business_unit_slug ? <span>· {tpl.business_unit_slug}</span> : null}
                              <span>· v{tpl.version}</span>
                            </div>
                            {tpl.summary ? (
                              <div className="new-doc-library__item-summary">{tpl.summary}</div>
                            ) : null}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section>
                  <h4>{t("newDoc.library.guidelines")}</h4>
                  {filteredGuidelines.length === 0 ? (
                    <p className="new-doc-library__empty">
                      {t("newDoc.library.guidelines.empty")}
                    </p>
                  ) : (
                    <ul className="new-doc-library__list">
                      {filteredGuidelines.map((g) => {
                        const checked = selectedGuidelineIds.includes(g.id);
                        return (
                          <li key={g.id}>
                            <label className="new-doc-library__guideline">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleGuideline(g.id)}
                              />
                              <div>
                                <div className="new-doc-library__item-title">{g.title}</div>
                                <div className="new-doc-library__item-meta">
                                  <span>{g.scope}</span>
                                  {g.business_unit_slug ? (
                                    <span>· {g.business_unit_slug}</span>
                                  ) : null}
                                  {g.document_type_code ? (
                                    <span>· {g.document_type_code}</span>
                                  ) : null}
                                </div>
                              </div>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>
              </div>
            </div>
          ) : null}

          <Field label={t("newDoc.field.title")} error={error ?? undefined}>
            <TextInput
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={t("newDoc.field.title.placeholder")}
            />
          </Field>

          {relatedNeighbors.length > 0 ? (
            <div className="new-doc-related" data-testid="new-doc-related">
              <span className="new-doc-related-label">
                <Waypoints size={12} /> {t("newDoc.related.label")}
              </span>
              <div className="new-doc-related-chips">
                {relatedNeighbors.map((neighbor) => (
                  <button
                    key={neighbor.id}
                    type="button"
                    className="graph-chip"
                    title={`[[${neighbor.id}]]`}
                    onClick={() => insertRelatedLink(neighbor.id)}
                  >
                    {neighbor.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <Field label={t("newDoc.field.type")}>
            <TextInput
              value={docType}
              onChange={(event) => setDocType(event.target.value)}
              placeholder={t("newDoc.field.type.placeholder")}
            />
          </Field>

          <Field label={t("newDoc.field.path")} helper={t("newDoc.field.path.helper")}>
            <TextInput
              value={relPath}
              onChange={(event) => setRelPath(event.target.value)}
              placeholder={t("newDoc.field.path.placeholder")}
            />
          </Field>

          <Field label={t("newDoc.field.body")} helper={t("newDoc.field.body.helper")}>
            <TextArea rows={7} value={body} onChange={(event) => setBody(event.target.value)} />
          </Field>

          <div className="dialog-actions">
            <Dialog.Close asChild>
              <Button variant="ghost">{t("newDoc.cancel")}</Button>
            </Dialog.Close>
            <Button
              variant="primary"
              onClick={submit}
              disabled={saving}
              icon={<FilePlus2 size={15} />}
            >
              {saving ? t("newDoc.creating") : t("newDoc.create")}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
