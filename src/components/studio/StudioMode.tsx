import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  FileArchive,
  FilePlus2,
  FileText,
  Library,
  PackageCheck,
  RefreshCcw,
  Save,
  Send,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../ui/Button";
import { Field, TextArea, TextInput } from "../ui/Field";
import { RichMarkdownEditor } from "../RichMarkdownEditor";
import { useTranslation } from "../../lib/i18n";
import {
  defaultAnchorDocType,
  fetchGuidelines,
  fetchTemplate,
  fetchTemplates,
  renderTemplateBody,
  type DocumentCategory,
  type GuidelineSummary,
  type TemplateSummary,
} from "../../lib/hubLibrary";
import {
  exportDispatch,
  exportPlan,
  summarizeDispatch,
  type ExportFormat,
} from "../../lib/export";
import {
  STUDIO_STEPS,
  createInitialStudioState,
  nextStudioStep,
  previousStudioStep,
  studioDocIdFromDocument,
  studioStateDelete,
  studioStateList,
  studioStateRead,
  studioStateSave,
  type StudioCreateDocumentInput,
  type StudioPackageResult,
  type StudioState,
  type StudioStateSummary,
  type StudioStep,
} from "../../lib/studio";
import { frontmatterScalar } from "../../lib/document";
import type { DocumentPayload } from "../../lib/types";

interface StudioModeProps {
  workspaceRoot?: string | null;
  activeDocument: DocumentPayload | null;
  canCreateDocument: boolean;
  canModifyDocument: boolean;
  onCreateDocument: (input: StudioCreateDocumentInput) => Promise<DocumentPayload | null>;
  onApplyBody: (documentPath: string, bodyMarkdown: string) => Promise<DocumentPayload | null>;
  onFreezePackage: (
    documentPath: string,
    bodyMarkdown: string,
    title: string,
  ) => Promise<StudioPackageResult | null>;
  onRevealPath?: (path: string) => void;
  onError: (message: string) => void;
}

type EditorMode = "rich" | "source";

const CATEGORY_OPTIONS: Array<{ value: DocumentCategory | "all"; key: string }> = [
  { value: "all", key: "studio.category.all" },
  { value: "formal_report", key: "studio.category.formalReport" },
  { value: "admin_approval", key: "studio.category.adminApproval" },
  { value: "evidence_certification", key: "studio.category.evidenceCertification" },
  { value: "operational", key: "studio.category.operational" },
];

const FORMAT_OPTIONS: ExportFormat[] = ["docx", "hwpx", "pdf"];

export function StudioMode({
  workspaceRoot,
  activeDocument,
  canCreateDocument,
  canModifyDocument,
  onCreateDocument,
  onApplyBody,
  onFreezePackage,
  onRevealPath,
  onError,
}: StudioModeProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<StudioState | null>(null);
  const [summaries, setSummaries] = useState<StudioStateSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [category, setCategory] = useState<DocumentCategory | "all">("all");
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [guidelines, setGuidelines] = useState<GuidelineSummary[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [editorMode, setEditorMode] = useState<EditorMode>("rich");
  const saveTimerRef = useRef<number | null>(null);
  const loadingRef = useRef(false);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const saveRevisionRef = useRef(0);

  const activeDocId = useMemo(
    () => (activeDocument ? studioDocIdFromDocument(activeDocument) : null),
    [activeDocument],
  );

  const activeTemplateSlug = state?.template?.slug ?? null;

  const filteredTemplates = useMemo(
    () =>
      category === "all"
        ? templates
        : templates.filter((template) => template.document_type_category === category),
    [category, templates],
  );

  const filteredGuidelines = useMemo(() => {
    if (!state?.template) return guidelines;
    return guidelines.filter((guideline) => {
      if (guideline.scope === "global") return true;
      if (guideline.scope === "business_unit") {
        return guideline.business_unit_slug === state.template?.businessUnit;
      }
      if (guideline.scope === "document_type") {
        return guideline.document_type_code === state.template?.documentTypeCode;
      }
      return true;
    });
  }, [guidelines, state?.template]);

  const canUseDocumentActions = Boolean(workspaceRoot && state?.source.documentPath);
  const currentStepIndex = state ? STUDIO_STEPS.indexOf(state.currentStep) : 0;

  const loadSummaries = useCallback(async () => {
    if (!workspaceRoot) {
      setSummaries([]);
      return;
    }
    try {
      setSummaries(await studioStateList(workspaceRoot));
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }, [onError, workspaceRoot]);

  const enqueueStudioSave = useCallback(
    (nextState: StudioState): Promise<void> => {
      if (!workspaceRoot) return Promise.resolve();
      const revision = saveRevisionRef.current + 1;
      saveRevisionRef.current = revision;
      setSaving(true);
      const run = saveQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          await studioStateSave(workspaceRoot, nextState);
          if (revision === saveRevisionRef.current) {
            await loadSummaries();
          }
        })
        .catch((err) => {
          if (revision === saveRevisionRef.current) {
            onError(err instanceof Error ? err.message : String(err));
          }
        })
        .finally(() => {
          if (revision === saveRevisionRef.current) {
            setSaving(false);
          }
        });
      saveQueueRef.current = run;
      return run;
    },
    [loadSummaries, onError, workspaceRoot],
  );

  useEffect(() => {
    if (!workspaceRoot) {
      setState(null);
      setSummaries([]);
      return;
    }
    let cancelled = false;
    loadingRef.current = true;
    setLoading(true);
    const docId = activeDocId ?? null;
    void (async () => {
      try {
        const [stored, list] = await Promise.all([
          docId ? studioStateRead(workspaceRoot, docId) : Promise.resolve(null),
          studioStateList(workspaceRoot),
        ]);
        if (cancelled) return;
        setSummaries(list);
        setState(stored ?? createInitialStudioState(activeDocument));
      } catch (err) {
        if (!cancelled) onError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) {
          setLoading(false);
          loadingRef.current = false;
        }
      }
    })();
    return () => {
      cancelled = true;
      loadingRef.current = false;
    };
  }, [activeDocId, activeDocument?.path, onError, workspaceRoot]);

  useEffect(() => {
    if (!workspaceRoot || !state || loadingRef.current) return;
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      void enqueueStudioSave(state);
    }, 600);
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    };
  }, [enqueueStudioSave, state, workspaceRoot]);

  useEffect(() => {
    if (!workspaceRoot || !state) return;
    if (state.currentStep !== "template" && state.currentStep !== "guidelines") return;
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
      .then(([templateList, guidelineList]) => {
        if (cancelled) return;
        setTemplates(templateList);
        setGuidelines(guidelineList);
      })
      .catch((err) => {
        if (!cancelled) setLibraryError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLibraryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [category, state?.currentStep, workspaceRoot]);

  const patchState = useCallback((updater: (prev: StudioState) => StudioState) => {
    setState((prev) => {
      if (!prev) return prev;
      return { ...updater(prev), updatedAt: new Date().toISOString() };
    });
  }, []);

  async function saveNow(): Promise<void> {
    if (!workspaceRoot || !state) return;
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    await enqueueStudioSave(state);
  }

  async function loadState(docId: string): Promise<void> {
    if (!workspaceRoot) return;
    setLoading(true);
    loadingRef.current = true;
    try {
      const stored = await studioStateRead(workspaceRoot, docId);
      if (stored) setState(stored);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }

  async function deleteCurrentState(): Promise<void> {
    if (!workspaceRoot || !state) return;
    setBusyAction("delete");
    try {
      await studioStateDelete(workspaceRoot, state.docId);
      setState(createInitialStudioState(activeDocument));
      await loadSummaries();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  }

  function goTo(step: StudioStep): void {
    patchState((prev) => ({ ...prev, currentStep: step }));
  }

  async function createDocumentFromSource(): Promise<void> {
    if (!state) return;
    if (!state.source.title.trim()) {
      onError(t("studio.error.title"));
      return;
    }
    setBusyAction("create");
    try {
      const created = await onCreateDocument({
        title: state.source.title.trim(),
        docType: state.source.docType.trim() || "report",
        body: state.bodyDraft.trim(),
        targetRelPath: state.source.targetRelPath?.trim() || null,
      });
      if (created) {
        setState({
          ...createInitialStudioState(created),
          bodyDraft: created.body,
          currentStep: "template",
          updatedAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  }

  function useActiveDocument(): void {
    if (!activeDocument) return;
    setState({
      ...createInitialStudioState(activeDocument),
      currentStep: "template",
      updatedAt: new Date().toISOString(),
    });
  }

  async function applyTemplate(template: TemplateSummary): Promise<void> {
    if (!workspaceRoot) return;
    setBusyAction(`template:${template.id}`);
    setLibraryError(null);
    try {
      const full = await fetchTemplate(template.slug, { workspaceRoot });
      patchState((prev) => ({
        ...prev,
        currentStep: "guidelines",
        template: {
          id: template.id,
          slug: template.slug,
          version: template.version,
          title: template.title,
          businessUnit: template.business_unit_slug ?? null,
          documentTypeCode: template.document_type_code ?? null,
        },
        source: {
          ...prev.source,
          docType: defaultAnchorDocType(template),
        },
        bodyDraft: renderTemplateBody(full, t("studio.template.slotHint")),
      }));
    } catch (err) {
      setLibraryError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  }

  function toggleGuideline(id: string): void {
    patchState((prev) => ({
      ...prev,
      guidelineIds: prev.guidelineIds.includes(id)
        ? prev.guidelineIds.filter((item) => item !== id)
        : [...prev.guidelineIds, id],
    }));
  }

  function toggleFormat(format: ExportFormat): void {
    patchState((prev) => {
      const formats = new Set(prev.export.formats);
      if (formats.has(format)) formats.delete(format);
      else formats.add(format);
      return {
        ...prev,
        export: {
          ...prev.export,
          formats: FORMAT_OPTIONS.filter((item) => formats.has(item)),
        },
      };
    });
  }

  async function applyBody(): Promise<DocumentPayload | null> {
    if (!state?.source.documentPath) {
      onError(t("studio.error.noDocument"));
      return null;
    }
    setBusyAction("apply");
    try {
      return await onApplyBody(state.source.documentPath, state.bodyDraft);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setBusyAction(null);
    }
  }

  async function runExport(): Promise<void> {
    if (!workspaceRoot || !state?.source.documentPath) {
      onError(t("studio.error.noDocument"));
      return;
    }
    const formats = state.export.formats.filter((format): format is ExportFormat =>
      FORMAT_OPTIONS.includes(format as ExportFormat),
    );
    if (formats.length === 0) {
      onError(t("studio.export.error.noFormat"));
      return;
    }
    setBusyAction("export");
    try {
      const plan = await exportPlan({
        workspaceRoot,
        sourcePath: state.source.documentPath,
        formats,
      });
      const dispatched = await exportDispatch({
        workspaceRoot,
        manifestPath: plan.manifest_path,
        formats,
      });
      const summary = summarizeDispatch(dispatched);
      patchState((prev) => ({
        ...prev,
        currentStep: "package",
        export: {
          ...prev.export,
          formats,
          manifestPath: dispatched.manifest_path,
          summary,
          lastRunAt: new Date().toISOString(),
        },
      }));
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  }

  async function freezePackage(): Promise<void> {
    if (!state?.source.documentPath) {
      onError(t("studio.error.noDocument"));
      return;
    }
    setBusyAction("package");
    try {
      const result = await onFreezePackage(
        state.source.documentPath,
        state.bodyDraft,
        state.source.title || t("studio.package.defaultTitle"),
      );
      if (!result) return;
      patchState((prev) => ({
        ...prev,
        bodyDraft: result.document.body,
        package: {
          frozen: true,
          frozenAt: new Date().toISOString(),
          snapshotPath: result.snapshotRelPath,
        },
      }));
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  }

  if (!workspaceRoot) {
    return (
      <main className="studio-pane">
        <div className="studio-empty">
          <FileText size={24} />
          <strong>{t("studio.empty.noWorkspace.title")}</strong>
          <span>{t("studio.empty.noWorkspace.description")}</span>
        </div>
      </main>
    );
  }

  if (loading || !state) {
    return (
      <main className="studio-pane">
        <div className="studio-empty">
          <RefreshCcw size={24} />
          <strong>{t("studio.loading")}</strong>
        </div>
      </main>
    );
  }

  return (
    <main className="studio-pane">
      <header className="studio-header">
        <div>
          <p className="studio-kicker">{t("studio.kicker")}</p>
          <h1>{t("studio.title")}</h1>
          <p>{t("studio.subtitle")}</p>
        </div>
        <div className="studio-header-actions">
          <Button
            variant="secondary"
            size="sm"
            icon={<Save size={14} />}
            onClick={() => void saveNow()}
            disabled={saving}
          >
            {saving ? t("studio.saving") : t("studio.save")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={<Trash2 size={14} />}
            onClick={() => void deleteCurrentState()}
            disabled={busyAction === "delete"}
          >
            {t("studio.reset")}
          </Button>
        </div>
      </header>

      <div className="studio-layout">
        <aside className="studio-step-rail" aria-label={t("studio.steps.label")}>
          {STUDIO_STEPS.map((step, index) => (
            <button
              key={step}
              type="button"
              className={[
                "studio-step-button",
                state.currentStep === step ? "active" : "",
                index < currentStepIndex ? "complete" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => goTo(step)}
            >
              <span className="studio-step-index">{index + 1}</span>
              <span>{t(`studio.step.${step}`)}</span>
            </button>
          ))}

          {summaries.length > 0 ? (
            <div className="studio-state-list">
              <h2>{t("studio.states.title")}</h2>
              {summaries.slice(0, 6).map((summary) => (
                <button
                  type="button"
                  key={summary.docId}
                  className={summary.docId === state.docId ? "active" : ""}
                  onClick={() => void loadState(summary.docId)}
                >
                  <span>{summary.title || summary.docId}</span>
                  <small>{t(`studio.step.${summary.currentStep}`)}</small>
                </button>
              ))}
            </div>
          ) : null}
        </aside>

        <section className="studio-workbench">
          {state.currentStep === "source" ? (
            <SourceStep
              state={state}
              activeDocument={activeDocument}
              canCreateDocument={canCreateDocument}
              busy={busyAction === "create"}
              onPatch={patchState}
              onUseActive={useActiveDocument}
              onCreate={() => void createDocumentFromSource()}
            />
          ) : null}

          {state.currentStep === "template" ? (
            <TemplateStep
              category={category}
              templates={filteredTemplates}
              activeTemplateSlug={activeTemplateSlug}
              loading={libraryLoading}
              error={libraryError}
              busyAction={busyAction}
              onCategory={setCategory}
              onApply={(template) => void applyTemplate(template)}
            />
          ) : null}

          {state.currentStep === "guidelines" ? (
            <GuidelinesStep
              guidelines={filteredGuidelines}
              selectedIds={state.guidelineIds}
              loading={libraryLoading}
              error={libraryError}
              onToggle={toggleGuideline}
            />
          ) : null}

          {state.currentStep === "sections" ? (
            <SectionsStep
              value={state.bodyDraft}
              editorMode={editorMode}
              canModifyDocument={canModifyDocument}
              busy={busyAction === "apply"}
              onEditorMode={setEditorMode}
              onChange={(bodyDraft) => patchState((prev) => ({ ...prev, bodyDraft }))}
              onApply={() => void applyBody()}
            />
          ) : null}

          {state.currentStep === "hwp" ? <HwpStep state={state} /> : null}

          {state.currentStep === "export" ? (
            <ExportStep
              state={state}
              canRun={canUseDocumentActions}
              busy={busyAction === "export"}
              onToggleFormat={toggleFormat}
              onRun={() => void runExport()}
              onRevealPath={onRevealPath}
            />
          ) : null}

          {state.currentStep === "package" ? (
            <PackageStep
              state={state}
              canFreeze={canUseDocumentActions && canModifyDocument}
              busy={busyAction === "package"}
              onFreeze={() => void freezePackage()}
              onRevealPath={onRevealPath}
            />
          ) : null}

          <footer className="studio-nav">
            <Button
              variant="ghost"
              icon={<ChevronLeft size={14} />}
              onClick={() => goTo(previousStudioStep(state.currentStep))}
              disabled={state.currentStep === "source"}
            >
              {t("studio.nav.previous")}
            </Button>
            <Button
              variant="primary"
              icon={<ChevronRight size={14} />}
              onClick={() => goTo(nextStudioStep(state.currentStep))}
              disabled={state.currentStep === "package"}
            >
              {t("studio.nav.next")}
            </Button>
          </footer>
        </section>
      </div>
    </main>
  );
}

function SourceStep({
  state,
  activeDocument,
  canCreateDocument,
  busy,
  onPatch,
  onUseActive,
  onCreate,
}: {
  state: StudioState;
  activeDocument: DocumentPayload | null;
  canCreateDocument: boolean;
  busy: boolean;
  onPatch: (updater: (prev: StudioState) => StudioState) => void;
  onUseActive: () => void;
  onCreate: () => void;
}) {
  const { t } = useTranslation();
  const activeDocType = frontmatterScalar(activeDocument?.meta, "type") ?? "reference";
  return (
    <div className="studio-step-panel">
      <div className="studio-step-head">
        <FileText size={20} />
        <div>
          <h2>{t("studio.source.title")}</h2>
          <p>{t("studio.source.description")}</p>
        </div>
      </div>

      {activeDocument ? (
        <button type="button" className="studio-active-document" onClick={onUseActive}>
          <span>
            <strong>{activeDocument.title}</strong>
            <small>
              {activeDocument.relPath} · {activeDocType}
            </small>
          </span>
          <span>{t("studio.source.useActive")}</span>
        </button>
      ) : (
        <div className="studio-inline-note">{t("studio.source.noActive")}</div>
      )}

      <div className="studio-form-grid">
        <Field label={t("studio.source.field.title")}>
          <TextInput
            value={state.source.title}
            onChange={(event) =>
              onPatch((prev) => ({
                ...prev,
                source: { ...prev.source, title: event.target.value, mode: "newDocument" },
              }))
            }
            placeholder={t("studio.source.field.title.placeholder")}
          />
        </Field>
        <Field label={t("studio.source.field.type")}>
          <TextInput
            value={state.source.docType}
            onChange={(event) =>
              onPatch((prev) => ({
                ...prev,
                source: { ...prev.source, docType: event.target.value, mode: "newDocument" },
              }))
            }
            placeholder={t("studio.source.field.type.placeholder")}
          />
        </Field>
        <Field label={t("studio.source.field.path")} helper={t("studio.source.field.path.helper")}>
          <TextInput
            value={state.source.targetRelPath ?? ""}
            onChange={(event) =>
              onPatch((prev) => ({
                ...prev,
                source: {
                  ...prev.source,
                  targetRelPath: event.target.value,
                  mode: "newDocument",
                },
              }))
            }
            placeholder={t("studio.source.field.path.placeholder")}
          />
        </Field>
      </div>

      <div className="studio-action-row">
        <Button
          variant="primary"
          icon={<FilePlus2 size={14} />}
          onClick={onCreate}
          disabled={!canCreateDocument || busy}
        >
          {busy ? t("studio.source.creating") : t("studio.source.create")}
        </Button>
      </div>
    </div>
  );
}

function TemplateStep({
  category,
  templates,
  activeTemplateSlug,
  loading,
  error,
  busyAction,
  onCategory,
  onApply,
}: {
  category: DocumentCategory | "all";
  templates: TemplateSummary[];
  activeTemplateSlug: string | null;
  loading: boolean;
  error: string | null;
  busyAction: string | null;
  onCategory: (category: DocumentCategory | "all") => void;
  onApply: (template: TemplateSummary) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="studio-step-panel">
      <div className="studio-step-head">
        <Library size={20} />
        <div>
          <h2>{t("studio.template.title")}</h2>
          <p>{t("studio.template.description")}</p>
        </div>
      </div>

      <div className="studio-segmented" role="group" aria-label={t("studio.category.label")}>
        {CATEGORY_OPTIONS.map((option) => (
          <button
            type="button"
            key={option.value}
            className={category === option.value ? "active" : ""}
            onClick={() => onCategory(option.value)}
          >
            {t(option.key)}
          </button>
        ))}
      </div>

      {loading ? <div className="studio-inline-note">{t("studio.library.loading")}</div> : null}
      {error ? <div className="studio-inline-error">{error}</div> : null}
      {!loading && templates.length === 0 ? (
        <div className="studio-inline-note">{t("studio.template.empty")}</div>
      ) : null}

      <div className="studio-template-grid">
        {templates.map((template) => (
          <button
            type="button"
            key={template.id}
            className={activeTemplateSlug === template.slug ? "active" : ""}
            onClick={() => onApply(template)}
            disabled={busyAction === `template:${template.id}`}
          >
            <strong>{template.title}</strong>
            <span>
              {template.document_type_code} · {template.business_unit_slug ?? t("studio.scope.global")} · v
              {template.version}
            </span>
            {template.summary ? <small>{template.summary}</small> : null}
          </button>
        ))}
      </div>
    </div>
  );
}

function GuidelinesStep({
  guidelines,
  selectedIds,
  loading,
  error,
  onToggle,
}: {
  guidelines: GuidelineSummary[];
  selectedIds: string[];
  loading: boolean;
  error: string | null;
  onToggle: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="studio-step-panel">
      <div className="studio-step-head">
        <BookOpen size={20} />
        <div>
          <h2>{t("studio.guidelines.title")}</h2>
          <p>{t("studio.guidelines.description")}</p>
        </div>
      </div>
      {loading ? <div className="studio-inline-note">{t("studio.library.loading")}</div> : null}
      {error ? <div className="studio-inline-error">{error}</div> : null}
      {!loading && guidelines.length === 0 ? (
        <div className="studio-inline-note">{t("studio.guidelines.empty")}</div>
      ) : null}
      <div className="studio-guideline-list">
        {guidelines.map((guideline) => {
          const checked = selectedIds.includes(guideline.id);
          return (
            <label key={guideline.id} className={checked ? "active" : ""}>
              <input
                type="checkbox"
                checked={checked}
                onChange={() => onToggle(guideline.id)}
              />
              <span>
                <strong>{guideline.title}</strong>
                <small>
                  {guideline.scope}
                  {guideline.business_unit_slug ? ` · ${guideline.business_unit_slug}` : ""}
                  {guideline.document_type_code ? ` · ${guideline.document_type_code}` : ""}
                </small>
              </span>
            </label>
          );
        })}
      </div>
      <div className="studio-count-strip">
        {t("studio.guidelines.selected", { count: selectedIds.length })}
      </div>
    </div>
  );
}

function SectionsStep({
  value,
  editorMode,
  canModifyDocument,
  busy,
  onEditorMode,
  onChange,
  onApply,
}: {
  value: string;
  editorMode: EditorMode;
  canModifyDocument: boolean;
  busy: boolean;
  onEditorMode: (mode: EditorMode) => void;
  onChange: (value: string) => void;
  onApply: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="studio-step-panel studio-sections-panel">
      <div className="studio-step-head">
        <FileText size={20} />
        <div>
          <h2>{t("studio.sections.title")}</h2>
          <p>{t("studio.sections.description")}</p>
        </div>
      </div>
      <div className="studio-editor-toolbar">
        <div className="studio-segmented" role="group" aria-label={t("studio.sections.editorMode")}>
          <button
            type="button"
            className={editorMode === "rich" ? "active" : ""}
            onClick={() => onEditorMode("rich")}
          >
            {t("studio.sections.rich")}
          </button>
          <button
            type="button"
            className={editorMode === "source" ? "active" : ""}
            onClick={() => onEditorMode("source")}
          >
            {t("studio.sections.source")}
          </button>
        </div>
        <Button
          variant="secondary"
          size="sm"
          icon={<Save size={14} />}
          disabled={!canModifyDocument || busy}
          onClick={onApply}
        >
          {busy ? t("studio.sections.applying") : t("studio.sections.apply")}
        </Button>
      </div>
      {editorMode === "rich" ? (
        <div className="studio-rich-editor">
          <RichMarkdownEditor value={value} onChange={onChange} readOnly={!canModifyDocument} />
        </div>
      ) : (
        <TextArea
          className="studio-source-editor"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          readOnly={!canModifyDocument}
        />
      )}
    </div>
  );
}

function HwpStep({ state }: { state: StudioState }) {
  const { t } = useTranslation();
  const fieldCount = Object.keys(state.hwpFields.values).length;
  return (
    <div className="studio-step-panel">
      <div className="studio-step-head">
        <FileArchive size={20} />
        <div>
          <h2>{t("studio.hwp.title")}</h2>
          <p>{t("studio.hwp.description")}</p>
        </div>
      </div>
      <div className="studio-placeholder-block">
        <strong>{t("studio.hwp.placeholder.title")}</strong>
        <span>{t("studio.hwp.placeholder.description")}</span>
        <small>{t("studio.hwp.fields", { count: fieldCount })}</small>
      </div>
    </div>
  );
}

function ExportStep({
  state,
  canRun,
  busy,
  onToggleFormat,
  onRun,
  onRevealPath,
}: {
  state: StudioState;
  canRun: boolean;
  busy: boolean;
  onToggleFormat: (format: ExportFormat) => void;
  onRun: () => void;
  onRevealPath?: (path: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="studio-step-panel">
      <div className="studio-step-head">
        <Send size={20} />
        <div>
          <h2>{t("studio.export.title")}</h2>
          <p>{t("studio.export.description")}</p>
        </div>
      </div>
      <div className="studio-format-list">
        {FORMAT_OPTIONS.map((format) => (
          <label key={format} className={state.export.formats.includes(format) ? "active" : ""}>
            <input
              type="checkbox"
              checked={state.export.formats.includes(format)}
              onChange={() => onToggleFormat(format)}
            />
            <span>{format.toUpperCase()}</span>
          </label>
        ))}
      </div>
      <div className="studio-action-row">
        <Button
          variant="primary"
          icon={<Send size={14} />}
          onClick={onRun}
          disabled={!canRun || busy}
        >
          {busy ? t("studio.export.running") : t("studio.export.run")}
        </Button>
      </div>
      {state.export.summary ? (
        <div className="studio-result-block">
          <strong>{t("studio.export.lastRun")}</strong>
          <span>{state.export.summary}</span>
          {state.export.manifestPath ? (
            <button type="button" onClick={() => onRevealPath?.(state.export.manifestPath!)}>
              {state.export.manifestPath}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PackageStep({
  state,
  canFreeze,
  busy,
  onFreeze,
  onRevealPath,
}: {
  state: StudioState;
  canFreeze: boolean;
  busy: boolean;
  onFreeze: () => void;
  onRevealPath?: (path: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="studio-step-panel">
      <div className="studio-step-head">
        <PackageCheck size={20} />
        <div>
          <h2>{t("studio.package.title")}</h2>
          <p>{t("studio.package.description")}</p>
        </div>
      </div>
      <div className="studio-package-summary">
        <div>
          <span>{t("studio.package.document")}</span>
          <strong>{state.source.targetRelPath ?? state.source.documentPath ?? "-"}</strong>
        </div>
        <div>
          <span>{t("studio.package.manifest")}</span>
          <strong>{state.export.manifestPath ?? t("studio.package.noManifest")}</strong>
        </div>
        <div>
          <span>{t("studio.package.snapshot")}</span>
          <strong>{state.package.snapshotPath ?? t("studio.package.notFrozen")}</strong>
        </div>
      </div>
      <div className="studio-action-row">
        <Button
          variant="primary"
          icon={<PackageCheck size={14} />}
          onClick={onFreeze}
          disabled={!canFreeze || busy}
        >
          {busy ? t("studio.package.freezing") : t("studio.package.freeze")}
        </Button>
        {state.package.snapshotPath ? (
          <Button
            variant="secondary"
            icon={<FileText size={14} />}
            onClick={() => onRevealPath?.(state.package.snapshotPath!)}
          >
            {t("studio.package.reveal")}
          </Button>
        ) : null}
      </div>
      <div className="studio-inline-note">{t("studio.package.localOnly")}</div>
    </div>
  );
}
