import { saveMeetingSourceDraft, type SourceDraft, type SourceSession } from "./meetingSources";

export interface SourceEditorSnapshot {
  session: SourceSession;
  draft: SourceDraft;
  dirty: boolean;
  saving: boolean;
  error: string;
}

/** Session-keyed working buffers survive mode changes and failed saves. */
export class MeetingSourceEditorStore {
  private snapshot: SourceEditorSnapshot;
  private listeners = new Set<() => void>();
  private pending: Promise<SourceSession> | null = null;

  constructor(readonly workPath: string, session: SourceSession) {
    this.snapshot = { session, draft: session.draft, dirty: false, saving: false, error: "" };
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private set(patch: Partial<SourceEditorSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  update(transform: (draft: SourceDraft) => SourceDraft) {
    this.set({ draft: transform(this.snapshot.draft), dirty: true, error: "" });
  }
  install(session: SourceSession) {
    if (session.id !== this.snapshot.session.id) throw new Error("source_review_session_mismatch");
    if (this.snapshot.dirty || this.pending) return;
    this.set({ session, draft: session.draft, dirty: false, error: "" });
  }
  /** Explicit user choice after viewing the latest saved copy beside local edits. */
  rebase(session: SourceSession) {
    if (session.id !== this.snapshot.session.id || this.pending) throw new Error("source_review_session_mismatch");
    this.set({ session, error: "", dirty: true });
  }
  flush(): Promise<SourceSession> {
    if (this.pending) return this.pending;
    if (!this.snapshot.dirty) return Promise.resolve(this.snapshot.session);
    this.set({ saving: true, error: "" });
    this.pending = this.saveUntilCurrent().finally(() => {
      this.pending = null;
      this.set({ saving: false });
    });
    return this.pending;
  }
  private async saveUntilCurrent(): Promise<SourceSession> {
    try {
      while (this.snapshot.dirty) {
        const { draft, session } = this.snapshot;
        const saved = await saveMeetingSourceDraft(this.workPath, session.id, draft, session.revision);
        const unchanged = this.snapshot.draft === draft;
        this.set({ session: saved, ...(unchanged ? { draft: saved.draft, dirty: false } : {}) });
      }
      return this.snapshot.session;
    } catch (error) {
      this.set({ error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
}

const editors = new Map<string, MeetingSourceEditorStore>();
export function hasDirtyMeetingSourceDrafts(): boolean {
  return [...editors.values()].some((editor) => editor.getSnapshot().dirty || editor.getSnapshot().saving);
}
export function openMeetingSourceEditor(workPath: string, session: SourceSession): MeetingSourceEditorStore {
  const key = JSON.stringify([workPath, session.id]);
  const existing = editors.get(key);
  if (existing) { existing.install(session); return existing; }
  const editor = new MeetingSourceEditorStore(workPath, session);
  editors.set(key, editor);
  return editor;
}
