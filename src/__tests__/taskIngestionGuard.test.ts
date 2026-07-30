import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftEntry } from "../lib/types";

// The guard under test is module-scope state in taskIngestion, so api/skills are
// mocked at the module boundary rather than injected.
const createDraft = vi.fn();
const listDrafts = vi.fn();
const agentReadRunEvents = vi.fn();

vi.mock("../lib/api", () => ({
  createDraft: (...args: unknown[]) => createDraft(...args),
  listDrafts: (...args: unknown[]) => listDrafts(...args),
}));

vi.mock("../lib/skills", () => ({
  agentReadRunEvents: (...args: unknown[]) => agentReadRunEvents(...args),
}));

const {
  ingestTaskCandidateRun,
  resetIngestGuardForTests,
  TASK_CANDIDATES_SCHEMA_VERSION,
} = await import("../lib/taskIngestion");

const WORK = "/w";

function eventsWithCandidates(titles: string[]): unknown[] {
  const artifact = JSON.stringify({
    schemaVersion: TASK_CANDIDATES_SCHEMA_VERSION,
    summary: "batch",
    candidates: titles.map((title) => ({
      title,
      importance: "high",
      confidence: 0.9,
      originRefs: [],
      summary: "s",
      draftBody: "b",
    })),
  });
  return [{ type: "provider.output", payload: { line: artifact } }];
}

function draft(overrides: Partial<DraftEntry>): DraftEntry {
  return {
    id: "d1",
    kind: "task",
    title: "Draft",
    status: "new",
    source: "claude",
    originRefs: [],
    bodyPath: ".maru/drafts/d1/body.md",
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  resetIngestGuardForTests();
  createDraft.mockReset();
  listDrafts.mockReset();
  agentReadRunEvents.mockReset();
  createDraft.mockResolvedValue(draft({}));
  listDrafts.mockResolvedValue([]);
});

describe("ingestTaskCandidateRun run guard", () => {
  // The pane unmounts on every mode switch while mission records live for the
  // whole process, so a per-mount guard replayed completed runs — and because
  // the title dedupe ignores discarded drafts, drafts the user had explicitly
  // discarded came back.
  it("ingests a given run only once, even after the draft was discarded", async () => {
    agentReadRunEvents.mockResolvedValue(eventsWithCandidates(["Review budget"]));

    const first = await ingestTaskCandidateRun(WORK, "run-1", "low");
    expect(first?.created).toBe(1);
    expect(createDraft).toHaveBeenCalledTimes(1);

    // The user discards it; a replay of the same run must not recreate it.
    listDrafts.mockResolvedValue([draft({ title: "Review budget", status: "discarded" })]);

    const second = await ingestTaskCandidateRun(WORK, "run-1", "low");
    expect(second).toBeNull();
    expect(createDraft).toHaveBeenCalledTimes(1);
  });

  it("still ingests a different run for the same workspace", async () => {
    agentReadRunEvents.mockResolvedValue(eventsWithCandidates(["Review budget"]));
    await ingestTaskCandidateRun(WORK, "run-1", "low");
    agentReadRunEvents.mockResolvedValue(eventsWithCandidates(["Another task"]));
    await ingestTaskCandidateRun(WORK, "run-2", "low");
    expect(createDraft).toHaveBeenCalledTimes(2);
  });

  it("keys the guard by workspace, so the same run id in another workspace runs", async () => {
    agentReadRunEvents.mockResolvedValue(eventsWithCandidates(["Review budget"]));
    await ingestTaskCandidateRun(WORK, "run-1", "low");
    await ingestTaskCandidateRun("/other", "run-1", "low");
    expect(createDraft).toHaveBeenCalledTimes(2);
  });

  // Each ingest snapshots the draft list before creating, so two un-awaited runs
  // sharing a title both used to pass the dedupe and create it twice.
  it("serializes concurrent runs so a shared title is created once", async () => {
    agentReadRunEvents.mockResolvedValue(eventsWithCandidates(["Shared title"]));
    // listDrafts reflects what has actually been created so far — the behaviour a
    // real backend has, and the thing an unserialized read-modify-write misses.
    const created: DraftEntry[] = [];
    listDrafts.mockImplementation(async () => [...created]);
    createDraft.mockImplementation(async (input: { title: string }) => {
      const entry = draft({ id: `d${created.length + 1}`, title: input.title });
      created.push(entry);
      return entry;
    });

    await Promise.all([
      ingestTaskCandidateRun(WORK, "run-a", "low"),
      ingestTaskCandidateRun(WORK, "run-b", "low"),
    ]);

    expect(createDraft).toHaveBeenCalledTimes(1);
  });

  it("releases the claim when ingestion throws, so a retry can succeed", async () => {
    agentReadRunEvents.mockRejectedValueOnce(new Error("events unreadable"));
    await expect(ingestTaskCandidateRun(WORK, "run-1", "low")).rejects.toThrow(
      "events unreadable",
    );

    agentReadRunEvents.mockResolvedValue(eventsWithCandidates(["Review budget"]));
    const retry = await ingestTaskCandidateRun(WORK, "run-1", "low");
    expect(retry?.created).toBe(1);
  });
});
