import { afterEach, describe, expect, it, vi } from "vitest";
import {
  E2E_FLOW_ENABLE_STORAGE_KEY,
  buildE2EFlowFixture,
  compareE2EFlowTimings,
  isE2EFlowEnabled,
  summarizeE2EArtifacts,
  type E2EFlowTimings,
} from "./e2eFlow";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildE2EFlowFixture", () => {
  it("creates deterministic report, slide, metadata, and TODO artifacts", () => {
    const result = buildE2EFlowFixture({
      workPath: "mock://anchor-sample-workspace",
      baselineAverageMs: 4019.88,
    });

    expect(result.metadata.schemaVersion).toBe("anchor_e2e_development_plan_v1");
    expect(result.metadata.sourceOfTruth).toBe("README.md");
    expect(result.metadata.coreTracks).toEqual([
      "existing-feature-optimization",
      "document-template-report-generation",
      "skill-management",
      "local-server-storage-integration",
      "presentation-slide-generation",
    ]);
    expect(result.reportMarkdown).toContain("# Anchor E2E Development Report");
    expect(result.reportMarkdown).toContain("Anchor 사업 주간 점검 회의");
    expect(result.slidesHtml).toContain("<!doctype html>");
    expect(result.slidesHtml).toContain("Anchor E2E Flow");
    expect(result.metadata.localStorageResult.id).toMatch(/^anchor-e2e-/);
    expect(result.todos).toContainEqual(
      expect.objectContaining({
        id: "readme-slide-export-conflict",
        status: "todo",
      }),
    );
  });
});

describe("compareE2EFlowTimings", () => {
  it("marks total and staged timings as improved only when they clear the 30 percent gate", () => {
    const timings: E2EFlowTimings = {
      totalMs: 2500,
      stages: {
        sampleLoadMs: 50,
        skillLifecycleMs: 200,
        reportGenerationMs: 90,
        slideGenerationMs: 110,
        localSaveMs: 60,
        requeryMs: 40,
      },
    };

    const comparison = compareE2EFlowTimings({
      baseline: {
        totalMs: 4019.88,
        stages: {
          sampleLoadMs: 120,
          skillLifecycleMs: null,
          reportGenerationMs: null,
          slideGenerationMs: null,
          localSaveMs: null,
          requeryMs: null,
        },
      },
      result: timings,
    });

    expect(comparison.total.improvementRatio).toBeGreaterThan(0.3);
    expect(comparison.total.gateMet).toBe(true);
    expect(comparison.stages.sampleLoadMs?.gateMet).toBe(true);
    expect(comparison.stages.skillLifecycleMs?.baselineStatus).toBe(
      "unmeasurable-current-code",
    );
  });
});

describe("summarizeE2EArtifacts", () => {
  it("returns queryable metadata for the saved artifact lookup", () => {
    const fixture = buildE2EFlowFixture({ workPath: "mock://anchor-sample-workspace" });
    const summary = summarizeE2EArtifacts(fixture);

    expect(summary.id).toBe(fixture.metadata.localStorageResult.id);
    expect(summary.files).toEqual(["metadata.json", "report.md", "slides.html", "todos.json", "timings.json"]);
    expect(summary.reportTitle).toBe("Anchor E2E Development Report");
    expect(summary.slideTitle).toBe("Anchor E2E Flow");
  });
});

describe("isE2EFlowEnabled", () => {
  it("keeps the E2E console hidden without an explicit opt-in", () => {
    expect(isE2EFlowEnabled()).toBe(false);
  });

  it("enables the E2E console from a query flag or persisted local opt-in", () => {
    vi.stubGlobal("window", {
      location: { search: "?anchor-e2e=1" },
      localStorage: { getItem: () => null },
    });

    expect(isE2EFlowEnabled()).toBe(true);

    vi.stubGlobal("window", {
      location: { search: "" },
      localStorage: {
        getItem: (key: string) => (key === E2E_FLOW_ENABLE_STORAGE_KEY ? "true" : null),
      },
    });

    expect(isE2EFlowEnabled()).toBe(true);
  });
});
