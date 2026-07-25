import { describe, expect, it } from "vitest";
import {
  bindingCanBeIncluded,
  candidateCanBeLocallyVerified,
  evidenceCandidateSummary,
  evidenceTargetSuggestions,
  splitEvidenceTargets,
  type EvidenceBinderCandidate,
  type EvidenceBinding,
} from "./evidenceBinder";

function candidate(
  overrides: Partial<EvidenceBinderCandidate> = {},
): EvidenceBinderCandidate {
  return {
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
    sidecarStatus: "unverified",
    sidecarSha256: null,
    companionFor: null,
    inboxItemId: null,
    summary: null,
    ...overrides,
  };
}

describe("evidence binder helpers", () => {
  it("summarizes format, kind, and HWP fields", () => {
    expect(evidenceCandidateSummary(candidate())).toBe(
      "HWPX · certificate · 3 HWP fields",
    );
  });

  it("extracts free-entry suggestions from headings, tasks, and HWP labels", () => {
    const suggestions = evidenceTargetSuggestions(
      "---\ntitle: Demo\n---\n# Overview\n## KPI Results\n- [ ] Signed form\n",
      [candidate({ hwpFieldLabels: ["성명", "Signed form"] })],
    );
    expect(suggestions.sections).toEqual(["Overview", "KPI Results"]);
    expect(suggestions.kpis).toEqual(["KPI Results"]);
    expect(suggestions.checklist).toEqual(["Signed form", "성명"]);
    expect(splitEvidenceTargets(" KPI 1,  KPI   1\nKPI 2 ")).toEqual(["KPI 1", "KPI 2"]);
  });

  it("keeps structural, sidecar, and local verification states separate", () => {
    const binding: EvidenceBinding = {
      bindingId: "sha256:abc",
      candidateId: "ev_1",
      evidenceSha256: "abc",
      relPath: "a.hwpx",
      note: null,
      sectionBindings: [],
      kpiBindings: [],
      submissionChecklistBindings: [],
      localVerificationStatus: "unverified",
      verifiedAt: null,
      includeInSubmission: false,
      submissionSelectedAt: null,
      linkedAt: "2026-05-24T00:00:00Z",
    };
    expect(
      candidateCanBeLocallyVerified(
        candidate({ validationChecks: [{ name: "zip", status: "fail" }] }),
      ),
    ).toBe(false);
    expect(candidateCanBeLocallyVerified(candidate({ sidecarStatus: "rejected" }))).toBe(
      false,
    );
    expect(bindingCanBeIncluded(binding, candidate({ sidecarStatus: "verified" }))).toBe(
      true,
    );
    expect(
      bindingCanBeIncluded(
        binding,
        candidate({ sidecarStatus: "verified", sidecarSha256: "different" }),
      ),
    ).toBe(false);
    expect(bindingCanBeIncluded(binding, candidate())).toBe(false);
  });
});
