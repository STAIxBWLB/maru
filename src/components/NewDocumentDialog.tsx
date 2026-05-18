import * as Dialog from "@radix-ui/react-dialog";
import { FilePlus2, Library, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "./ui/Button";
import { Field, TextArea, TextInput } from "./ui/Field";
import { useTranslation } from "../lib/i18n";
import {
  defaultAnchorDocType,
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

const CATEGORY_OPTIONS: { value: DocumentCategory | "all"; label: string }[] = [
  { value: "all", label: "전체" },
  { value: "formal_report", label: "정형보고" },
  { value: "admin_approval", label: "행정결재" },
  { value: "evidence_certification", label: "증빙·인증" },
  { value: "operational", label: "운영문서" },
];

export function NewDocumentDialog({
  open,
  workspaceRoot,
  initialTitle = "",
  initialRelPath = null,
  initialDocType = "reference",
  initialOpenLibrary = false,
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
        setDocType(defaultAnchorDocType(summary));
      }
      setBody(renderTemplateBody(full, "내용 입력"));
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
                    {c.label}
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
