import { Check, FilePlus2, GitCompare, History, Plus, RotateCcw, Save, Sparkles, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type UIEvent } from "react";
import { useTranslation } from "../../lib/i18n";
import { buildSourceTextDiff, buildSourceSideBySideRows, matchingCorrectionExamples } from "../../lib/meetingSourceReview";
import {
  createMeetingSourceSession, checkpointMeetingSource, confirmMeetingSource, importMeetingSource,
  listMeetingSourceSessions, readMeetingSourceSession, restoreMeetingSourceVersion,
  listMeetingCorrectionExamples, saveMeetingCorrectionExample,
  decideMeetingSourceSuggestion,
  type MeetingCorrectionExample, type MeetingSource, type Participant,
  type ReviewedSourceReference, type SourceDraft, type SourceSession,
} from "../../lib/meetingSources";
import { MeetingSourceEditorStore, openMeetingSourceEditor } from "../../lib/meetingSourceEditorStore";
import { Button } from "../ui/Button";
import "./meetingSourceWorkbench.css";

interface Props {
  workPath: string | null;
  sourceKind: "transcript" | "external";
  onReviewedSourceChange: (value: { reference: ReviewedSourceReference; session: SourceSession } | null) => void;
  onRequestAi: (session: SourceSession) => Promise<void>;
  aiBusy: boolean;
  externalSessionUpdate?: SourceSession | null;
  requestedSessionId?: string | null;
  onSessionChange?: (sessionId: string | null) => void;
}
const emptyDraft = (source: MeetingSource, title: string): SourceDraft => ({
  title, provider: "Plaud", sources: [source], participants: [], findings: [], suggestions: [],
  participantsReviewed: false, noteReviewed: false,
});
const makeSource = (text: string, name: string, kind: "note" | "transcript"): MeetingSource => ({
  id: crypto.randomUUID(), name, kind, text, originalText: text, originalHash: "",
});
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
function syncEditorScroll(event: UIEvent<HTMLTextAreaElement>) {
  const source = event.currentTarget;
  const ratio = source.scrollTop / Math.max(1, source.scrollHeight - source.clientHeight);
  for (const target of source.closest(".meeting-source-editors")?.querySelectorAll("textarea") ?? []) {
    if (target === source) continue;
    const top = ratio * Math.max(0, target.scrollHeight - target.clientHeight);
    if (Math.abs(target.scrollTop - top) > 1) target.scrollTop = top;
  }
}

export function MeetingSourceWorkbench(props: Props) {
  const { workPath, requestedSessionId, externalSessionUpdate, onReviewedSourceChange, onSessionChange } = props;
  const { t } = useTranslation();
  const [rows, setRows] = useState<SourceSession[]>([]);
  const [editor, setEditor] = useState<MeetingSourceEditorStore | null>(null);
  const editorRef = useRef<MeetingSourceEditorStore | null>(null);
  const [paste, setPaste] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const recordSaved = useCallback((saved: SourceSession) => {
    setRows((current) => current.map((session) => session.id === saved.id ? saved : session));
  }, []);

  const select = useCallback((session: SourceSession) => {
    if (!workPath) return;
    const next = openMeetingSourceEditor(workPath, session);
    editorRef.current = next;
    setEditor(next);
    onSessionChange?.(session.id);
    setRows((current) => [session, ...current.filter((s) => s.id !== session.id)]);
    setError("");
  }, [workPath, onSessionChange]);

  useEffect(() => {
    let cancelled = false;
    onReviewedSourceChange(null);
    void (async () => {
      try {
        await editorRef.current?.flush();
        if (!workPath || cancelled) return;
        const sessions = await listMeetingSourceSessions(workPath);
        if (cancelled) return;
        setRows(sessions);
        const selected = sessions.find((s) => s.id === requestedSessionId) ?? sessions[0];
        if (selected) select(selected);
        else { editorRef.current = null; setEditor(null); }
      } catch (cause) { if (!cancelled) setError(message(cause)); }
    })();
    return () => { cancelled = true; };
  }, [workPath, requestedSessionId, select, onReviewedSourceChange]);

  useEffect(() => {
    if (!externalSessionUpdate || editorRef.current?.workPath !== workPath) return;
    if (editorRef.current?.getSnapshot().session.id === externalSessionUpdate.id) {
      editorRef.current.install(externalSessionUpdate);
    }
    setRows((current) => current.map((s) => s.id === externalSessionUpdate.id ? externalSessionUpdate : s));
  }, [externalSessionUpdate, workPath]);

  useEffect(() => () => {
    // The keyed store keeps a failed or in-flight save recoverable on return.
    void editorRef.current?.flush().catch(() => {});
  }, []);

  const navigate = async (session: SourceSession | null) => {
    try {
      await editorRef.current?.flush();
      onReviewedSourceChange(null);
      if (session && workPath) select(await readMeetingSourceSession(workPath, session.id));
      else { editorRef.current = null; setEditor(null); setPaste(""); onSessionChange?.(null); }
    } catch (cause) { setError(message(cause)); }
  };
  const create = async (text: string, name = "Plaud.md") => {
    if (!workPath || !text.trim()) return;
    setBusy(true); setError("");
    try {
      const source = makeSource(text, name, props.sourceKind === "transcript" ? "transcript" : "note");
      const title = text.split("\n").find((line) => line.trim())?.replace(/^#+\s*/, "").slice(0, 100) || t("meetings.sourceReview.title");
      select(await createMeetingSourceSession(workPath, emptyDraft(source, title), "Plaud"));
      setPaste("");
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  };
  const importFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      if (!/\.(txt|md|markdown)$/i.test(file.name) || file.size > 2 * 1024 * 1024) throw new Error(t("meetings.sourceReview.fileInvalid"));
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer());
      await create(text, file.name);
    } catch (cause) { setError(message(cause)); }
  };

  return <section className="meeting-source-workbench">
    <div className="meeting-source-layout">
      <aside className="meeting-source-sessions">
        <strong>{t("meetings.sourceReview.resume")}</strong>
        <Button size="sm" onClick={() => void navigate(null)} icon={<Plus size={14} />}>{t("meetings.sourceReview.new")}</Button>
        {rows.map((session) => <button type="button" key={session.id}
          className={editor?.getSnapshot().session.id === session.id ? "active" : ""}
          onClick={() => void navigate(session)}>
          {session.draft.title || t("meetings.sourceReview.note")}
          <small>{session.confirmedVersionId ? t("meetings.sourceReview.confirmed") : t("meetings.sourceReview.inReview")}</small>
        </button>)}
      </aside>
      {editor && editor.workPath === workPath ? <SourceEditor key={`${workPath}:${editor.getSnapshot().session.id}`}
        editor={editor} {...props} onSaved={recordSaved} />
        : <div className="meeting-source-empty">
          <FilePlus2 size={22} /><h2>{t("meetings.sourceReview.title")}</h2>
          <p>{t("meetings.sourceReview.noSession")}</p>
          <div className="meeting-source-create">
            <textarea aria-label={t("meetings.sourceReview.placeholder")} value={paste}
              onChange={(event) => setPaste(event.target.value)} placeholder={t("meetings.sourceReview.placeholder")} />
            <div><Button variant="primary" disabled={!workPath || busy || !paste.trim()}
              onClick={() => void create(paste)}>{t("meetings.sourceReview.create")}</Button>
              <Button disabled={!workPath || busy} onClick={() => fileInput.current?.click()}>{t("meetings.sourceReview.import")}</Button></div>
            <input ref={fileInput} type="file" hidden accept=".txt,.md,.markdown" onChange={(event) => {
              void importFile(event.target.files?.[0]); event.target.value = "";
            }} />
          </div>
        </div>}
    </div>
    {error ? <p className="meeting-source-notice" role="alert">{error}</p> : null}
  </section>;
}

function SourceEditor({ editor, onRequestAi, aiBusy, onReviewedSourceChange, onSaved }: Props & {
  editor: MeetingSourceEditorStore; onSaved: (session: SourceSession) => void;
}) {
  const { t, locale } = useTranslation();
  const { session, draft, dirty, saving, error: saveError } = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [composing, setComposing] = useState(false);
  const [sourceId, setSourceId] = useState(() => (draft.sources.find((s) => s.kind === "note") ?? draft.sources[0])?.id ?? "");
  const [transcriptEdit, setTranscriptEdit] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [left, setLeft] = useState("original");
  const [right, setRight] = useState("working");
  const [reason, setReason] = useState("");
  const [referenceText, setReferenceText] = useState("");
  const [referenceKind, setReferenceKind] = useState<"note" | "transcript">("transcript");
  const [examples, setExamples] = useState<MeetingCorrectionExample[]>([]);
  const [exampleForm, setExampleForm] = useState<MeetingCorrectionExample | null>(null);
  const [replacementEdits, setReplacementEdits] = useState<Record<string, string>>({});
  const [conflictCopy, setConflictCopy] = useState<SourceSession | null>(null);
  const [changeIndex, setChangeIndex] = useState(0);
  const [diffPage, setDiffPage] = useState(0);
  const sourceFileInput = useRef<HTMLInputElement>(null);
  const diffRef = useRef<HTMLDivElement>(null);
  const source = draft.sources.find((s) => s.id === sourceId) ?? draft.sources[0];
  const pending = draft.suggestions.filter((s) => s.required && s.status === "pending").length;

  useEffect(() => { onSaved(session); }, [session, onSaved]);

  useEffect(() => {
    const version = session.versions.find((v) => v.id === session.confirmedVersionId);
    onReviewedSourceChange(!dirty && !saving && version
      ? { reference: { sessionId: session.id, versionId: version.id, contentHash: version.contentHash }, session }
      : null);
  }, [session, dirty, saving, onReviewedSourceChange]);
  useEffect(() => {
    if (!dirty || composing || busy || saveError) return;
    const timer = window.setTimeout(() => { void editor.flush().catch(() => {}); }, 700);
    return () => window.clearTimeout(timer);
  }, [dirty, draft, composing, busy, saveError, editor]);
  useEffect(() => {
    let cancelled = false;
    void listMeetingCorrectionExamples(editor.workPath).then((items) => { if (!cancelled) setExamples(items); })
      .catch((cause: unknown) => { if (!cancelled) setError(message(cause)); });
    return () => { cancelled = true; };
  }, [editor]);

  const act = async (action: (saved: SourceSession) => Promise<SourceSession | void>) => {
    setBusy(true); setError("");
    try {
      const saved = await editor.flush();
      const next = await action(saved);
      if (next) { editor.install(next); onSaved(next); }
    } catch (cause) {
      setError(message(cause));
      if (!editor.getSnapshot().dirty) {
        try { editor.install(await readMeetingSourceSession(editor.workPath, editor.getSnapshot().session.id)); }
        catch { /* Keep the action error and last known state visible. */ }
      }
    }
    finally { setBusy(false); }
  };
  const change = (transform: (value: SourceDraft) => SourceDraft, contextChanged = false) => {
    try { editor.update((value) => ({ ...transform(value), noteReviewed: false,
      ...(contextChanged ? { participantsReviewed: false } : {}) })); }
    catch (cause) { setError(message(cause)); }
  };
  const personChange = (id: string, patch: Partial<Participant>) => change((value) => ({
    ...value, participants: value.participants.map((person) => person.id === id ? { ...person, ...patch } : person),
  }), true);
  const importReference = (text: string, name: string) => act(async (saved) => {
    const next = await importMeetingSource(editor.workPath, saved.id, { name, kind: referenceKind, text }, saved.revision);
    setReferenceText(""); return next;
  });
  const importFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      if (!/\.(txt|md|markdown)$/i.test(file.name) || file.size > 2 * 1024 * 1024) throw new Error(t("meetings.sourceReview.fileInvalid"));
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer());
      await importReference(text, file.name);
    } catch (cause) { setError(message(cause)); }
  };
  const checkpoint = () => act(async (saved) => {
    await checkpointMeetingSource(editor.workPath, saved.id, reason, saved.revision);
    setReason(""); return readMeetingSourceSession(editor.workPath, saved.id);
  });
  const compareDraft = (id: string) => id === "working" ? draft : session.versions.find((v) => v.id === id)?.draft;
  const compareText = (id: string) => id === "original" ? source.originalText
    : compareDraft(id)?.sources.find((s) => s.id === source.id)?.text ?? "";
  const leftText = conflictCopy?.draft.sources.find((s) => s.id === source.id)?.text ?? compareText(left);
  const rightText = compareText(right);
  // Textareas normalize CRLF for editing; keep byte-exact originals in storage
  // while comparing visible lines without marking every line as changed.
  const diffRows = useMemo(() => showDiff ? buildSourceTextDiff(leftText.replaceAll("\r\n", "\n"), rightText.replaceAll("\r\n", "\n")) : [], [showDiff, leftText, rightText]);
  const comparisonRows = useMemo(() => buildSourceSideBySideRows(diffRows), [diffRows]);
  const changeRows = useMemo(() => comparisonRows.flatMap((row, index) => row.left?.changed || row.right?.changed ? [index] : []), [comparisonRows]);
  const pageSize = 400;
  const pageCount = Math.max(1, Math.ceil(comparisonRows.length / pageSize));
  const currentPage = Math.min(diffPage, pageCount - 1);
  const jumpChange = (delta: number) => {
    if (!changeRows.length) return;
    const next = (changeIndex + delta + changeRows.length) % changeRows.length;
    setChangeIndex(next);
    setDiffPage(Math.floor(changeRows[next] / pageSize));
  };
  useEffect(() => {
    const row = diffRef.current?.querySelector<HTMLElement>(`[data-row="${changeRows[changeIndex]}"]`);
    row?.scrollIntoView?.({ block: "nearest" });
  }, [changeIndex, currentPage, changeRows]);
  const applicable = matchingCorrectionExamples(draft, examples);
  const promote = (before: string, after: string) => {
    const version = session.versions.at(-1);
    if (!version) return;
    setExampleForm({ id: crypto.randomUUID(), before, after, reason: "", enabled: true,
      scope: { kind: "general", value: "" }, sourceSessionId: session.id, sourceVersionId: version.id });
  };

  return <fieldset className="meeting-source-editor-body" disabled={busy} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}>
    <header className="meeting-source-header">
      <div><h2>{t("meetings.sourceReview.title")}</h2><p>{t("meetings.sourceReview.subtitle")}</p></div>
      <span className={`save-state ${dirty ? "dirty" : "saved"}`} role="status">
        {saving ? t("meetings.sourceReview.saving") : dirty ? t("meetings.sourceReview.unsaved") : t("meetings.sourceReview.saved")}
      </span>
      <Button size="sm" disabled={!dirty || saving} onClick={() => void act(async () => {})} icon={<Save size={14} />}>{t("meetings.sourceReview.saveDraft")}</Button>
    </header>
    <div className="meeting-source-context-top">
      <label>{t("meetings.sourceReview.meetingTitle")}<input value={draft.title ?? ""} onChange={(e) => change((d) => ({ ...d, title: e.target.value }), true)} /></label>
      <label>{t("meetings.sourceReview.date")}<input type="date" value={draft.date ?? ""} onChange={(e) => change((d) => ({ ...d, date: e.target.value }), true)} /></label>
      <label>{t("meetings.sourceReview.provider")}<input value={draft.provider ?? ""} onChange={(e) => change((d) => ({ ...d, provider: e.target.value }), true)} /></label>
    </div>
    <details className="meeting-source-context" open>
      <summary><Users size={15} /> {t("meetings.sourceReview.participants")}</summary>
      <div className="meeting-source-participant-grid">
        {draft.participants.map((person) => <div className="meeting-source-person" key={person.id}>
          {(["name", "affiliation", "title", "role", "reference"] as const).map((field) => <label key={field}>
            {t(`meetings.sourceReview.${field === "title" ? "titleField" : field}`)}
            <input value={person[field] ?? ""} onChange={(e) => personChange(person.id, { [field]: e.target.value })} />
          </label>)}
          <label>{t("meetings.sourceReview.attendance")}<select value={person.attendance} onChange={(e) => personChange(person.id, { attendance: e.target.value as Participant["attendance"] })}>
            <option value="attendee">{t("meetings.sourceReview.attendee")}</option><option value="mentioned">{t("meetings.sourceReview.mentioned")}</option>
          </select></label>
          <label>{t("meetings.sourceReview.speakerLabels")}<input value={person.speakerLabels.join(", ")} onChange={(e) => personChange(person.id, { speakerLabels: e.target.value.split(",").map((label) => label.trim()).filter(Boolean) })} /></label>
          <details><summary>{t("meetings.sourceReview.relatedPassages")}</summary><pre>{draft.sources.flatMap((s) => s.text.split("\n").filter((line) => [person.name, ...person.speakerLabels].some((label) => label && line.includes(label)))).join("\n")}</pre></details>
          <Button size="sm" className={`certainty ${person.status}`} onClick={() => personChange(person.id, { status: person.status === "confirmed" ? "uncertain" : "confirmed" })}>
            {t(`meetings.sourceReview.${person.status}`)}
          </Button>
          <Button size="sm" onClick={() => change((d) => ({ ...d, participants: d.participants.filter((p) => p.id !== person.id) }), true)}>{t("meetings.sourceReview.removeParticipant")}</Button>
        </div>)}
      </div>
      <Button size="sm" icon={<Plus size={13} />} onClick={() => change((d) => ({ ...d, participants: [...d.participants, {
        id: crypto.randomUUID(), name: "", speakerLabels: [], attendance: "attendee", status: "uncertain",
      }] }), true)}>{t("meetings.sourceReview.addParticipant")}</Button>
      <label className="meeting-source-context-label">{t("meetings.sourceReview.context")}<textarea value={draft.context ?? ""} onChange={(e) => change((d) => ({ ...d, context: e.target.value }), true)} /></label>
      <label className="meeting-source-check"><input type="checkbox" checked={draft.participantsReviewed} onChange={(e) => editor.update((d) => ({ ...d, participantsReviewed: e.target.checked }))} />{t("meetings.sourceReview.participantsReviewed")}</label>
    </details>
    <main className="meeting-source-main">
      <div className="meeting-source-tabs" role="tablist" aria-label={t("meetings.sourceReview.sources")}>
        {draft.sources.map((s) => <button type="button" role="tab" aria-selected={s.id === source.id} key={s.id} className={s.id === source.id ? "active" : ""}
          onClick={() => { setSourceId(s.id); setTranscriptEdit(false); }}>{s.name} ({t(`meetings.sourceReview.${s.kind}`)})</button>)}
        <Button size="sm" onClick={() => setShowDiff((value) => !value)} icon={<GitCompare size={13} />}>{t("meetings.sourceReview.compare")}</Button>
      </div>
      {source.kind === "transcript" ? <div className="meeting-source-section-heading"><p>{t("meetings.sourceReview.transcriptOptional")}</p>
        <Button size="sm" onClick={() => setTranscriptEdit((value) => !value)}>{t(`meetings.sourceReview.${transcriptEdit ? "readOnly" : "edited"}`)}</Button></div> : null}
      {showDiff ? <>
        <div className="meeting-source-compare-controls">
          <label>{t("meetings.sourceReview.compareFrom")}<select value={left} onChange={(e) => setLeft(e.target.value)}><option value="original">{t("meetings.sourceReview.original")}</option>
            {session.versions.map((v, i) => <option key={v.id} value={v.id}>{i + 1}. {v.reason}</option>)}</select></label>
          <label>{t("meetings.sourceReview.compareTo")}<select value={right} onChange={(e) => setRight(e.target.value)}><option value="working">{t("meetings.sourceReview.corrected")}</option>
            {session.versions.map((v, i) => <option key={v.id} value={v.id}>{i + 1}. {v.reason}</option>)}</select></label>
          <Button size="sm" disabled={!changeRows.length} onClick={() => jumpChange(-1)}>{t("meetings.sourceReview.previous")}</Button>
          <Button size="sm" disabled={!changeRows.length} onClick={() => jumpChange(1)}>{t("meetings.sourceReview.next")}</Button>
        </div>
        <div className="meeting-source-diff" ref={diffRef} role="table" aria-label={t("meetings.sourceReview.compare")}>
          <div className="meeting-source-diff-row meeting-source-diff-header" role="row">
            <strong role="columnheader">{left === "original" ? t("meetings.sourceReview.original") : session.versions.find((v) => v.id === left)?.reason}</strong>
            <strong role="columnheader">{right === "working" ? t("meetings.sourceReview.corrected") : session.versions.find((v) => v.id === right)?.reason}</strong>
          </div>
          {comparisonRows.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map((row, localIndex) => <div key={localIndex} data-row={currentPage * pageSize + localIndex} className="meeting-source-diff-row" role="row">
            <div role="cell" className={`meeting-source-diff-cell ${row.left?.changed ? "removed" : ""} ${row.left ? "" : "empty"}`}>
              <span aria-hidden="true">{row.left?.lineNumber ?? ""}</span><code>{row.left?.text || " "}</code>
            </div>
            <div role="cell" className={`meeting-source-diff-cell ${row.right?.changed ? "added" : ""} ${row.right ? "" : "empty"}`}>
              <span aria-hidden="true">{row.right?.lineNumber ?? ""}</span><code>{row.right?.text || " "}</code>
            </div>
          </div>)}
        </div>
        {pageCount > 1 ? <div className="meeting-source-compare-controls">
          <Button size="sm" disabled={currentPage === 0} onClick={() => setDiffPage(currentPage - 1)}>{t("meetings.sourceReview.previousPage")}</Button>
          <span>{t("meetings.sourceReview.diffPage", { page: currentPage + 1, total: pageCount })}</span>
          <Button size="sm" disabled={currentPage + 1 >= pageCount} onClick={() => setDiffPage(currentPage + 1)}>{t("meetings.sourceReview.nextPage")}</Button>
        </div> : null}
        {left !== "original" || right !== "working" ? <div className="meeting-source-editors">
          {[compareDraft(left), compareDraft(right)].map((value, index) => <pre key={index}>{value ? [value.title, value.date, value.context,
            ...value.participants.map((p) => [p.name, p.affiliation, p.title, p.role, t(`meetings.sourceReview.${p.status}`)].filter(Boolean).join(" · "))].filter(Boolean).join("\n") : t("meetings.sourceReview.original")}</pre>)}
        </div> : null}
      </> : <div className="meeting-source-editors">
        <label>{t("meetings.sourceReview.original")}<textarea readOnly value={source.originalText} onScroll={syncEditorScroll} /></label>
        <label>{t("meetings.sourceReview.corrected")}<textarea readOnly={source.kind === "transcript" && !transcriptEdit} value={source.text} onScroll={syncEditorScroll}
          onChange={(e) => change((d) => ({ ...d, sources: d.sources.map((s) => s.id === source.id ? { ...s, text: e.target.value } : s) }))} /></label>
      </div>}
      <details className="meeting-source-reference-import"><summary>{t("meetings.sourceReview.addSource")}</summary>
        <label>{t("meetings.sourceReview.sourceKind")}<select value={referenceKind} onChange={(e) => setReferenceKind(e.target.value as "note" | "transcript")}>
          <option value="transcript">{t("meetings.sourceReview.transcript")}</option><option value="note">{t("meetings.sourceReview.note")}</option>
        </select></label>
        <textarea aria-label={t("meetings.sourceReview.referenceText")} value={referenceText} onChange={(e) => setReferenceText(e.target.value)} />
        <Button size="sm" disabled={!referenceText.trim()} onClick={() => void importReference(referenceText, t(`meetings.sourceReview.${referenceKind}`))}>{t("meetings.sourceReview.addSource")}</Button>
        <Button size="sm" onClick={() => sourceFileInput.current?.click()}>{t("meetings.sourceReview.import")}</Button>
        <input ref={sourceFileInput} hidden type="file" accept=".txt,.md,.markdown" onChange={(e) => { void importFile(e.target.files?.[0]); e.target.value = ""; }} />
      </details>
      <div className="meeting-source-version-bar">
        <input aria-label={t("meetings.sourceReview.versionReason")} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("meetings.sourceReview.versionReason")} />
        <Button size="sm" disabled={!reason.trim()} onClick={() => void checkpoint()} icon={<Save size={13} />}>{t("meetings.sourceReview.version")}</Button>
        <Button size="sm" onClick={() => setShowHistory((value) => !value)} icon={<History size={13} />}>{t("meetings.sourceReview.history")}</Button>
      </div>
      {showHistory ? <div className="meeting-source-history">{session.versions.map((version, index) => <div key={version.id}>
        <span>{index + 1}. {new Date(version.createdAt).toLocaleString(locale === "ko" ? "ko-KR" : "en-US")} · {version.reason}</span>
        <Button size="sm" onClick={() => { setLeft("original"); setRight(version.id); setShowDiff(true); }}>{t("meetings.sourceReview.compare")}</Button>
        <Button size="sm" onClick={() => void act((saved) => restoreMeetingSourceVersion(editor.workPath, saved.id, version.id, saved.revision))} icon={<RotateCcw size={12} />}>{t("meetings.sourceReview.restore")}</Button>
      </div>)}</div> : null}
    </main>
    <details className="meeting-source-suggestions" open>
      <summary><Sparkles size={15} /> {t("meetings.sourceReview.suggestions")} ({pending})</summary>
      <p>{t("meetings.sourceReview.examplesUsed", { count: applicable.length })}</p>
      {applicable.length ? <ul>{applicable.map((example) => <li key={example.id}>{example.before} → {example.after} ({example.scope.value || t("meetings.sourceReview.general")})</li>)}</ul> : null}
      <Button size="sm" disabled={aiBusy || composing} onClick={() => void act(async (saved) => { void onRequestAi(saved).catch((cause: unknown) => setError(message(cause))); })} icon={<Sparkles size={13} />}>
        {aiBusy ? t("meetings.sourceReview.aiBusy") : t("meetings.sourceReview.aiSuggest")}
      </Button>
      {draft.suggestions.map((suggestion) => <article className={`meeting-source-suggestion ${suggestion.status}`} key={suggestion.id}>
        <small>{suggestion.category} · {t(`meetings.sourceReview.status.${suggestion.status}`)}</small>
        <del>{suggestion.before}</del><label>{t("meetings.sourceReview.replacement")}<textarea value={replacementEdits[suggestion.id] ?? suggestion.after}
          readOnly={suggestion.status !== "pending"} onChange={(e) => setReplacementEdits((current) => ({ ...current, [suggestion.id]: e.target.value }))} /></label>
        <p>{suggestion.reason}</p><small>{suggestion.evidence}</small>
        {suggestion.status === "pending" && !suggestion.contextHash ? <p>{t("meetings.sourceReview.aiStale")}</p> : null}
        {suggestion.evidenceQuote ? <blockquote>{draft.sources.find((item) => item.id === suggestion.evidenceSourceId)?.name}: {suggestion.evidenceQuote}</blockquote> : null}
        <div>{(["accepted", "rejected", "uncertain"] as const).map((status) => <Button key={status} size="sm" disabled={suggestion.status !== "pending" || (status === "accepted" && !suggestion.contextHash)}
          onClick={() => void act((saved) => decideMeetingSourceSuggestion(editor.workPath, saved.id, {
            id: suggestion.id, status: status === "accepted" && replacementEdits[suggestion.id] !== undefined ? "edited" : status,
            replacement: replacementEdits[suggestion.id],
          }, saved.revision))}>
          {t(`meetings.sourceReview.${status === "accepted" ? "accept" : status === "rejected" ? "reject" : "uncertain"}`)}
        </Button>)}
          <Button size="sm" disabled={!session.versions.length || !["accepted", "edited"].includes(suggestion.status)} onClick={() => promote(suggestion.before, suggestion.after)}>{t("meetings.sourceReview.promote")}</Button>
        </div>
      </article>)}
    </details>
    <details className="meeting-source-examples"><summary>{t("meetings.sourceReview.examples")} ({examples.length})</summary>
      <p>{t("meetings.sourceReview.examplesHint")}</p>
      <Button size="sm" disabled={!session.versions.length || source.originalText === source.text || dirty} onClick={() => promote(source.originalText, source.text)}>{t("meetings.sourceReview.promote")}</Button>
      {examples.map((example) => <div key={example.id} className="meeting-source-example-row"><span>{example.before} → {example.after}</span>
        <label><input type="checkbox" checked={example.enabled} onChange={(e) => {
          const enabled = e.target.checked;
          void act(async () => {
            const saved = await saveMeetingCorrectionExample(editor.workPath, { ...example, enabled });
            setExamples((items) => items.map((item) => item.id === saved.id ? saved : item));
          });
        }} />{t("meetings.sourceReview.enabled")}</label>
        <Button size="sm" onClick={() => setExampleForm(example)}>{t("meetings.sourceReview.editExample")}</Button>
      </div>)}
      {exampleForm ? <div className="meeting-source-example-form">
        {(["before", "after", "reason"] as const).map((field) => <label key={field}>{t(`meetings.sourceReview.example.${field}`)}
          <textarea value={exampleForm[field]} onChange={(e) => setExampleForm({ ...exampleForm, [field]: e.target.value })} /></label>)}
        <label>{t("meetings.sourceReview.scope")}<select value={exampleForm.scope.kind} onChange={(e) => setExampleForm({ ...exampleForm, scope: { ...exampleForm.scope, kind: e.target.value as MeetingCorrectionExample["scope"]["kind"] } })}>
          {(["general", "person", "institution", "project"] as const).map((kind) => <option key={kind} value={kind}>{t(`meetings.sourceReview.scope.${kind}`)}</option>)}
        </select></label>
        {exampleForm.scope.kind !== "general" ? <label>{t("meetings.sourceReview.scopeValue")}<input value={exampleForm.scope.value} onChange={(e) => setExampleForm({ ...exampleForm, scope: { ...exampleForm.scope, value: e.target.value } })} /></label> : null}
        <Button size="sm" disabled={!exampleForm.reason.trim() || !exampleForm.before.trim() || !exampleForm.after.trim() || (exampleForm.scope.kind !== "general" && !exampleForm.scope.value.trim())}
          onClick={() => void act(async (current) => {
            let record = exampleForm;
            let updatedSession: SourceSession | undefined;
            if (!examples.some((item) => item.id === exampleForm.id)) {
              const version = await checkpointMeetingSource(editor.workPath, current.id, exampleForm.reason, current.revision);
              record = { ...exampleForm, sourceSessionId: current.id, sourceVersionId: version.id };
              updatedSession = await readMeetingSourceSession(editor.workPath, current.id);
            }
            const saved = await saveMeetingCorrectionExample(editor.workPath, record);
            setExamples((items) => [...items.filter((item) => item.id !== saved.id), saved]); setExampleForm(null);
            return updatedSession;
          })}>{t("meetings.sourceReview.saveExample")}</Button>
        <Button size="sm" onClick={() => setExampleForm(null)}>{t("meetings.sourceReview.cancel")}</Button>
      </div> : null}
    </details>
    <footer className="meeting-source-confirm">
      <label className="meeting-source-check"><input type="checkbox" checked={draft.noteReviewed} onChange={(e) => editor.update((d) => ({ ...d, noteReviewed: e.target.checked }))} />{t("meetings.sourceReview.noteReviewed")}</label>
      <p>{t("meetings.sourceReview.reviewHint")}</p>
      <Button variant="primary" className="meeting-source-review-button" disabled={!draft.participantsReviewed || !draft.noteReviewed || pending > 0 || composing || saving}
        onClick={() => void act((saved) => confirmMeetingSource(editor.workPath, saved.id, saved.revision))} icon={<Check size={14} />}>{t("meetings.sourceReview.review")}</Button>
    </footer>
    {error || saveError ? <div className="meeting-source-notice" role="alert"><p>{error || saveError}</p>
      {saveError ? <Button size="sm" onClick={() => void readMeetingSourceSession(editor.workPath, session.id).then((latest) => { setConflictCopy(latest); setShowDiff(true); }).catch((cause: unknown) => setError(message(cause)))}>{t("meetings.sourceReview.loadConflict")}</Button> : null}
      {conflictCopy ? <Button size="sm" onClick={() => { editor.rebase(conflictCopy); setConflictCopy(null); setError(""); }}>{t("meetings.sourceReview.rebase")}</Button> : null}
    </div> : null}
  </fieldset>;
}
