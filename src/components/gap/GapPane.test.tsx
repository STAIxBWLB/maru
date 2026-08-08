// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocaleContext, registerDictionaries, t as translate, type Locale } from "../../lib/i18n";
import { en } from "../../lib/i18n/locales/en";
import { ko } from "../../lib/i18n/locales/ko";
import type {
  DraftDocument,
  GapReport,
  GapReportSummary,
  VaultEntry,
} from "../../lib/types";
import type { DraftGraphFocusRequest } from "../../lib/draftGraphRelations";
import {
  draftsRelinkPromoted,
  gapAnalyze,
  gapAppendLog,
  gapLogList,
  gapReportsList,
  readDraft,
} from "../../lib/api";
import { GapPane } from "./GapPane";

vi.mock("../../lib/api", () => ({
  draftsRelinkPromoted: vi.fn(),
  gapAnalyze: vi.fn(),
  gapAppendLog: vi.fn(),
  gapLogList: vi.fn(),
  gapReportsList: vi.fn(),
  readDraft: vi.fn(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REPORT_A: GapReport = {
  draftId: "a",
  draftTitle: "Report A",
  promotedTo: "docs/a.md",
  analyzedAt: "2026-07-30T01:00:00Z",
  hunks: [
    {
      op: "insert",
      oldStart: 1,
      oldLines: 0,
      newStart: 1,
      newLines: 1,
      lines: [{ kind: "+", text: "A result" }],
      hunkType: "direct-edit",
      evidence: [],
    },
  ],
  summary: {
    totalHunks: 1,
    addedLines: 1,
    removedLines: 0,
    byType: { externalInfo: 0, directEdit: 1, crossDocReference: 0, formatting: 0 },
  },
};

const REPORT_B: GapReport = {
  ...REPORT_A,
  draftId: "b",
  draftTitle: "Report B",
  promotedTo: "docs/b.md",
  hunks: [
    REPORT_A.hunks[0],
    {
      ...REPORT_A.hunks[0],
      newStart: 2,
      lines: [{ kind: "+", text: "B result" }],
    },
  ],
  summary: {
    ...REPORT_A.summary,
    totalHunks: 2,
    addedLines: 2,
    byType: { ...REPORT_A.summary.byType, directEdit: 2 },
  },
};

const REPORTS: GapReportSummary[] = [
  {
    draftId: "a",
    title: "Report A",
    promotedTo: REPORT_A.promotedTo,
    promotedAt: "2026-07-30T00:00:00Z",
    hasBaseline: true,
    hasDocument: true,
  },
  {
    draftId: "b",
    title: "Report B",
    promotedTo: REPORT_B.promotedTo,
    promotedAt: "2026-07-30T00:00:00Z",
    hasBaseline: true,
    hasDocument: true,
  },
];

const LOADING_REPORT: GapReportSummary = {
  draftId: "loading",
  title: "Loading report",
  promotedTo: "docs/loading.md",
  promotedAt: "2026-07-30T00:00:00Z",
  hasBaseline: true,
  hasDocument: true,
};

const DRAFT: DraftDocument = {
  id: "loading",
  kind: "task",
  title: "Loading report",
  status: "accepted",
  source: "claude",
  originRefs: ["references/maru-glossary.md"],
  bodyPath: ".maru/drafts/missing/body.md",
  promotedTo: "docs/loading.md",
  createdAt: "2026-07-30T00:00:00Z",
  updatedAt: "2026-07-30T00:00:00Z",
  content: "# Missing report\n\n[[Maru 용어집]]",
};

const GRAPH_ENTRY: VaultEntry = {
  path: "/w/references/maru-glossary.md",
  relPath: "references/maru-glossary.md",
  title: "Maru 용어집",
  frontmatter: {},
  updatedAt: null,
  wordCount: 1,
  snippet: "",
  fileKind: "md",
  versionCount: 0,
  links: [],
};

const PROMOTED_GRAPH_ENTRY: VaultEntry = {
  ...GRAPH_ENTRY,
  path: "/w/docs/loading.md",
  relPath: "docs/loading.md",
  title: "Loading document",
};

function localeValue(locale: Locale) {
  return {
    locale,
    setLocale: () => {},
    t: (key: string, vars?: Record<string, string | number>) => translate(locale, key, vars),
  };
}

let root: Root | null = null;
let container: HTMLElement | null = null;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderPane(options: {
  entries?: VaultEntry[];
  onOpenInGraph?: (request: DraftGraphFocusRequest) => void;
} = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <LocaleContext.Provider value={localeValue("ko")}>
        <GapPane
          workPath="/w"
          entries={options.entries}
          initialDraftId={null}
          onOpenInGraph={options.onOpenInGraph}
        />
      </LocaleContext.Provider>,
    );
  });
  await flush();
  return container;
}

async function selectReport(host: HTMLElement, title: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>(".gap-list-item")].find(
    (candidate) => candidate.textContent?.includes(title),
  );
  if (!button) throw new Error(`report "${title}" not found`);
  await act(async () => button.click());
  await flush();
}

beforeEach(() => {
  registerDictionaries({ en, ko });
  vi.mocked(gapReportsList).mockResolvedValue(REPORTS);
  vi.mocked(gapLogList).mockResolvedValue([]);
  vi.mocked(gapAppendLog).mockResolvedValue({
    at: "2026-07-30T01:00:00Z",
    draftId: "a",
    promotedTo: REPORT_A.promotedTo,
    addedLines: 1,
    removedLines: 0,
    byType: REPORT_A.summary.byType,
    hunkCount: 1,
  });
  vi.mocked(draftsRelinkPromoted).mockResolvedValue(DRAFT);
  vi.mocked(readDraft).mockResolvedValue(DRAFT);
  vi.mocked(gapAnalyze).mockImplementation(async (_workPath, draftId) =>
    draftId === "a" ? REPORT_A : REPORT_B,
  );
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe("GapPane async ownership", () => {
  it("does not let a late analysis overwrite the newer selected report", async () => {
    let releaseA!: (report: GapReport) => void;
    let releaseB!: (report: GapReport) => void;
    vi.mocked(gapAnalyze).mockImplementation(
      (_workPath, draftId) =>
        new Promise<GapReport>((resolve) => {
          if (draftId === "a") releaseA = resolve;
          else releaseB = resolve;
        }),
    );

    const host = await renderPane();
    await selectReport(host, "Report A");
    await selectReport(host, "Report B");

    await act(async () => releaseB(REPORT_B));
    await flush();
    expect(host.querySelector(".gap-summary")?.textContent).toContain("2");

    await act(async () => releaseA(REPORT_A));
    await flush();
    expect(host.querySelector(".gap-summary")?.textContent).toContain("2");
    expect(host.querySelector(".gap-summary")?.textContent).not.toContain("+1 / -0");
  });

  it("rejects a mismatched report and never exposes its graph action", async () => {
    vi.mocked(gapAnalyze).mockResolvedValue({ ...REPORT_A, draftId: "unexpected" });
    const onOpenInGraph = vi.fn();
    const host = await renderPane({ entries: [GRAPH_ENTRY], onOpenInGraph });

    await selectReport(host, "Report A");

    expect(host.querySelector(".gap-diff-table")).toBeNull();
    expect(host.textContent).not.toContain(translate("ko", "gap.openInGraph"));
    expect(onOpenInGraph).not.toHaveBeenCalled();
  });

  it("waits for the selected draft body before offering graph focus", async () => {
    let resolveDraft!: (draft: DraftDocument) => void;
    let resolveReport!: (report: GapReport) => void;
    vi.mocked(gapReportsList).mockResolvedValue([LOADING_REPORT]);
    vi.mocked(readDraft).mockImplementation(
      () => new Promise<DraftDocument>((resolve) => {
        resolveDraft = resolve;
      }),
    );
    vi.mocked(gapAnalyze).mockImplementation(
      () => new Promise<GapReport>((resolve) => {
        resolveReport = resolve;
      }),
    );
    const onOpenInGraph = vi.fn();
    const host = await renderPane({ entries: [GRAPH_ENTRY], onOpenInGraph });

    await selectReport(host, "Loading report");
    expect(host.textContent).not.toContain(translate("ko", "gap.openInGraph"));

    await act(async () => resolveDraft(DRAFT));
    await flush();
    expect(host.textContent).not.toContain(translate("ko", "gap.openInGraph"));

    await act(async () => resolveReport({ ...REPORT_A, draftId: LOADING_REPORT.draftId }));
    await flush();

    const openButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.includes(translate("ko", "gap.openInGraph")),
    );
    expect(openButton).not.toBeUndefined();
    await act(async () => openButton?.click());
    expect(onOpenInGraph).toHaveBeenCalledWith({
      docPath: DRAFT.bodyPath,
      nodePaths: [GRAPH_ENTRY.relPath],
    });
  });

  it("keeps graph focus hidden when the selected draft read fails", async () => {
    vi.mocked(gapReportsList).mockResolvedValue([LOADING_REPORT]);
    vi.mocked(readDraft).mockRejectedValue(new Error("drafts_read_failed"));
    vi.mocked(gapAnalyze).mockResolvedValue({
      ...REPORT_A,
      draftId: LOADING_REPORT.draftId,
      promotedTo: LOADING_REPORT.promotedTo,
    });
    const onOpenInGraph = vi.fn();
    const host = await renderPane({
      entries: [GRAPH_ENTRY, PROMOTED_GRAPH_ENTRY],
      onOpenInGraph,
    });

    await selectReport(host, "Loading report");

    // A promotedTo entry exists, but without a successfully loaded draft it
    // is incomplete provenance and must not become a graph overlay.
    expect(host.textContent).not.toContain(translate("ko", "gap.openInGraph"));
    expect(onOpenInGraph).not.toHaveBeenCalled();
  });
});
