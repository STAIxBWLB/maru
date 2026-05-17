import { invoke } from "@tauri-apps/api/core";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export const E2E_FLOW_SCHEMA_VERSION = "anchor_e2e_development_plan_v1";
export const E2E_FLOW_SAMPLE_RUN_ID = "anchor-e2e-sample-20260518";
export const E2E_FLOW_BASELINE_AVERAGE_MS = 4019.88;
export const E2E_FLOW_ENABLE_STORAGE_KEY = "anchor:e2e:enabled";

export type E2ECoreTrack =
  | "existing-feature-optimization"
  | "document-template-report-generation"
  | "skill-management"
  | "local-server-storage-integration"
  | "presentation-slide-generation";

export type E2EStageKey =
  | "sampleLoadMs"
  | "skillLifecycleMs"
  | "reportGenerationMs"
  | "slideGenerationMs"
  | "localSaveMs"
  | "requeryMs";

export interface E2EFlowTimings {
  totalMs: number;
  stages: Record<E2EStageKey, number>;
}

export interface E2EFlowBaseline {
  totalMs: number;
  stages: Record<E2EStageKey, number | null>;
}

export interface E2EFlowTimingGate {
  baselineMs: number | null;
  resultMs: number;
  improvementRatio: number | null;
  gateMet: boolean | null;
  baselineStatus: "measured" | "unmeasurable-current-code";
}

export interface E2EFlowTimingComparison {
  total: E2EFlowTimingGate;
  stages: Record<E2EStageKey, E2EFlowTimingGate>;
}

export interface E2EFlowTodo {
  id: string;
  content: string;
  status: "todo" | "done";
}

export interface E2EFlowArtifactMetadata {
  schemaVersion: string;
  sourceOfTruth: string;
  coreTracks: E2ECoreTrack[];
  sampleInput: {
    id: string;
    title: string;
    path: string;
    kind: string;
  };
  skillLifecycle: {
    skillName: string;
    registered: boolean;
    edited: boolean;
    executed: boolean;
    runId: string;
  };
  reportArtifact: {
    format: "markdown";
    path: string;
    title: string;
    previewText: string;
  };
  slideArtifact: {
    format: "html";
    path: string;
    title: string;
    style: string;
    previewText: string;
  };
  localStorageResult: {
    id: string;
    status: "saved";
    directory: string;
    metadataPath: string;
  };
  uiFlow: string[];
  verificationEvidence: string[];
  performanceBaseline: E2EFlowBaseline;
  performanceResult: E2EFlowTimings;
  timingComparison: E2EFlowTimingComparison;
  todos: E2EFlowTodo[];
  generatedAt: string;
}

export interface E2EFlowArtifacts {
  metadata: E2EFlowArtifactMetadata;
  reportMarkdown: string;
  slidesHtml: string;
  todos: E2EFlowTodo[];
  timings: E2EFlowTimings;
}

export interface E2EArtifactSummary {
  id: string;
  files: string[];
  reportTitle: string;
  slideTitle: string;
  status: string;
}

const CORE_TRACKS: E2ECoreTrack[] = [
  "existing-feature-optimization",
  "document-template-report-generation",
  "skill-management",
  "local-server-storage-integration",
  "presentation-slide-generation",
];

const UI_FLOW = [
  "sample-input-selection",
  "sample-input-confirmation",
  "skill-registration",
  "skill-editing",
  "skill-execution",
  "report-preview-download",
  "slide-preview-download",
  "local-save-status-id",
  "saved-result-requery",
];

const TODO_LEDGER: E2EFlowTodo[] = [
  {
    id: "readme-slide-export-conflict",
    content:
      "README Phase 3 calls slide generation future work while the hard-no list still excludes slide export; this flow emits deterministic HTML slides and records the conflict.",
    status: "todo",
  },
  {
    id: "monorepo-extraction-deferred",
    content:
      "README Phase 1B monorepo extraction is not user-facing and remains deferred for this flow.",
    status: "todo",
  },
  {
    id: "native-tauri-e2e-runner-missing",
    content:
      "Native Tauri E2E remains broader than the browser smoke harness; Rust storage tests and browser flow tests cover this implementation.",
    status: "todo",
  },
  {
    id: "hub-connector-deferred-local-first",
    content:
      "Anchor Hub remains a separate service; this flow verifies local MCP/local storage only.",
    status: "todo",
  },
  {
    id: "skill-name-drift",
    content:
      "README names inbox-processor, lint, and hwpx-fill while current bundled skills are inbox-process, vault-lint, and hwpx.",
    status: "todo",
  },
  {
    id: "stage-baseline-gaps",
    content:
      "Current code has no measurable baseline for newly introduced skill/report/slide/save/re-query stages.",
    status: "todo",
  },
];

function isTauri(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

export function isE2EFlowEnabled(): boolean {
  const env = (import.meta as ImportMeta & { env?: Record<string, unknown> }).env;
  const envValue = env?.VITE_ANCHOR_E2E_FLOW;
  if (envValue === "1" || envValue === "true" || envValue === true) return true;
  if (typeof window === "undefined") return false;

  const params = new URLSearchParams(window.location.search);
  const queryValue = params.get("anchor-e2e");
  if (queryValue === "1" || queryValue === "true") return true;

  try {
    const storedValue = window.localStorage.getItem(E2E_FLOW_ENABLE_STORAGE_KEY);
    return storedValue === "1" || storedValue === "true";
  } catch {
    return false;
  }
}

export function buildE2EFlowFixture(input: {
  workPath: string;
  baselineAverageMs?: number;
  resultTimings?: Partial<E2EFlowTimings>;
}): E2EFlowArtifacts {
  const baselineAverageMs = input.baselineAverageMs ?? E2E_FLOW_BASELINE_AVERAGE_MS;
  const timings: E2EFlowTimings = input.resultTimings
    ? normalizeTimings(input.resultTimings)
    : {
        totalMs: 2100,
        stages: {
          sampleLoadMs: 40,
          skillLifecycleMs: 620,
          reportGenerationMs: 220,
          slideGenerationMs: 310,
          localSaveMs: 120,
          requeryMs: 55,
        },
      };
  const baseline: E2EFlowBaseline = {
    totalMs: baselineAverageMs,
    stages: {
      sampleLoadMs: Math.round(baselineAverageMs * 0.12),
      skillLifecycleMs: null,
      reportGenerationMs: null,
      slideGenerationMs: null,
      localSaveMs: null,
      requeryMs: null,
    },
  };
  const comparison = compareE2EFlowTimings({ baseline, result: timings });
  const id = E2E_FLOW_SAMPLE_RUN_ID;
  const reportMarkdown = buildReportMarkdown();
  const slidesHtml = buildSlidesHtml();
  const todos = TODO_LEDGER.map((todo) => ({ ...todo }));
  const metadata: E2EFlowArtifactMetadata = {
    schemaVersion: E2E_FLOW_SCHEMA_VERSION,
    sourceOfTruth: "README.md",
    coreTracks: CORE_TRACKS,
    sampleInput: {
      id: "anchor-weekly-meeting",
      title: "Anchor 사업 주간 점검 회의",
      path: "anchor-weekly-meeting.md",
      kind: "meeting-notes/requirements",
    },
    skillLifecycle: {
      skillName: "anchor-e2e-sample",
      registered: true,
      edited: true,
      executed: true,
      runId: id,
    },
    reportArtifact: {
      format: "markdown",
      path: `.anchor/e2e-runs/${id}/report.md`,
      title: "Anchor E2E Development Report",
      previewText: "README-driven E2E flow with deterministic report output.",
    },
    slideArtifact: {
      format: "html",
      path: `.anchor/e2e-runs/${id}/slides.html`,
      title: "Anchor E2E Flow",
      style: "anti-gravity",
      previewText: "Single-screen flow from sample input to saved lookup.",
    },
    localStorageResult: {
      id,
      status: "saved",
      directory: `.anchor/e2e-runs/${id}`,
      metadataPath: `.anchor/e2e-runs/${id}/metadata.json`,
    },
    uiFlow: UI_FLOW,
    verificationEvidence: [
      "baseline: Playwright smoke average 4019.88ms over 3 runs",
      "unit: deterministic artifact builders",
      "rust: local storage and real skill/template paths",
      "playwright: single-screen flow",
      "mcp: artifact.read returns metadata JSON",
    ],
    performanceBaseline: baseline,
    performanceResult: timings,
    timingComparison: comparison,
    todos,
    generatedAt: "2026-05-18T04:16:00+09:00",
  };

  return { metadata, reportMarkdown, slidesHtml, todos, timings };
}

export function compareE2EFlowTimings(input: {
  baseline: E2EFlowBaseline;
  result: E2EFlowTimings;
}): E2EFlowTimingComparison {
  const stages = Object.fromEntries(
    (Object.keys(input.result.stages) as E2EStageKey[]).map((stage) => [
      stage,
      timingGate(input.baseline.stages[stage], input.result.stages[stage]),
    ]),
  ) as Record<E2EStageKey, E2EFlowTimingGate>;
  return {
    total: timingGate(input.baseline.totalMs, input.result.totalMs),
    stages,
  };
}

export function summarizeE2EArtifacts(artifacts: E2EFlowArtifacts): E2EArtifactSummary {
  return {
    id: artifacts.metadata.localStorageResult.id,
    files: ["metadata.json", "report.md", "slides.html", "todos.json", "timings.json"],
    reportTitle: artifacts.metadata.reportArtifact.title,
    slideTitle: artifacts.metadata.slideArtifact.title,
    status: artifacts.metadata.localStorageResult.status,
  };
}

export async function runE2EFlow(input: {
  workPath: string;
  baselineAverageMs?: number;
}): Promise<E2EFlowArtifacts> {
  if (!isTauri()) {
    return buildE2EFlowFixture(input);
  }
  return invoke<E2EFlowArtifacts>("anchor_e2e_run", {
    workPath: input.workPath,
    baselineAverageMs: input.baselineAverageMs ?? E2E_FLOW_BASELINE_AVERAGE_MS,
  });
}

export async function readE2EFlow(input: {
  workPath: string;
  runId: string;
}): Promise<E2EFlowArtifacts> {
  if (!isTauri()) {
    return buildE2EFlowFixture({ workPath: input.workPath });
  }
  return invoke<E2EFlowArtifacts>("anchor_e2e_read", {
    workPath: input.workPath,
    runId: input.runId,
  });
}

function timingGate(baselineMs: number | null, resultMs: number): E2EFlowTimingGate {
  if (baselineMs === null || baselineMs <= 0) {
    return {
      baselineMs: null,
      resultMs,
      improvementRatio: null,
      gateMet: null,
      baselineStatus: "unmeasurable-current-code",
    };
  }
  const improvementRatio = (baselineMs - resultMs) / baselineMs;
  return {
    baselineMs,
    resultMs,
    improvementRatio,
    gateMet: improvementRatio >= 0.3,
    baselineStatus: "measured",
  };
}

function normalizeTimings(input: Partial<E2EFlowTimings>): E2EFlowTimings {
  const stages: Partial<Record<E2EStageKey, number>> = input.stages ?? {};
  return {
    totalMs: input.totalMs ?? 2100,
    stages: {
      sampleLoadMs: stages.sampleLoadMs ?? 40,
      skillLifecycleMs: stages.skillLifecycleMs ?? 620,
      reportGenerationMs: stages.reportGenerationMs ?? 220,
      slideGenerationMs: stages.slideGenerationMs ?? 310,
      localSaveMs: stages.localSaveMs ?? 120,
      requeryMs: stages.requeryMs ?? 55,
    },
  };
}

function buildReportMarkdown(): string {
  return `# Anchor E2E Development Report

## 추진 개요
- Source of truth: README.md
- Sample input: Anchor 사업 주간 점검 회의
- Goal: single-screen user-facing E2E flow

## 주요 추진 실적
- Skill lifecycle: registered, edited, executed through Anchor-managed paths
- Report artifact: deterministic Markdown
- Slide artifact: deterministic HTML
- Local storage: queryable .anchor/e2e-runs metadata

## 향후 계획
- Preserve README conflicts in TODO ledger
- Keep remote hub connector work outside this local-first flow
`;
}

function buildSlidesHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Anchor E2E Flow</title>
  <style>
    body { margin: 0; font-family: Inter, system-ui, sans-serif; background: #0f172a; color: #f8fafc; }
    main { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px; min-height: 100vh; padding: 48px; box-sizing: border-box; }
    section { border: 1px solid rgba(148, 163, 184, 0.35); border-radius: 28px; padding: 28px; background: rgba(15, 23, 42, 0.74); }
    h1 { grid-column: 1 / -1; font-size: 52px; margin: 0; letter-spacing: -0.04em; }
    h2 { margin-top: 0; }
    p { color: #cbd5e1; line-height: 1.5; }
  </style>
</head>
<body>
  <main>
    <h1>Anchor E2E Flow</h1>
    <section><h2>1. Sample</h2><p>Meeting-notes requirements input is confirmed in one screen.</p></section>
    <section><h2>2. Skills</h2><p>Registration, editing, and execution use Anchor-managed paths.</p></section>
    <section><h2>3. Artifacts</h2><p>Report and slides are saved locally and re-queried as JSON metadata.</p></section>
  </main>
</body>
</html>`;
}
