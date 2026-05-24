import { describe, expect, it } from "vitest";
import { evidenceCandidateSummary, type EvidenceBinderCandidate } from "./evidenceBinder";

describe("evidence binder helpers", () => {
  it("summarizes format, kind, and HWP fields", () => {
    const candidate: EvidenceBinderCandidate = {
      id: "ev_1",
      source: "sidecar",
      path: "/work/a.hwpx",
      relPath: "a.hwpx",
      title: "a.hwpx",
      evidenceKind: "certificate",
      businessUnit: "bu",
      sizeBytes: 100,
      updatedAt: null,
      detectedFormat: "hwpx",
      validationChecks: [],
      hwpFieldCount: 3,
      hwpFieldLabels: ["성명"],
      sidecarPath: null,
      inboxItemId: null,
      summary: null,
    };

    expect(evidenceCandidateSummary(candidate)).toBe("HWPX · certificate · 3 HWP fields");
  });
});
