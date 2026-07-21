import { describe, expect, it } from "vitest";

import type { InboxEntry } from "./types";
import type { CaptureCandidate, DailyPlanV1 } from "./today";
import {
  applyCaptureDecision,
  buildCaptureCandidates,
  captureFingerprint,
  classifyConfidence,
  dedupeCandidates,
  firstParagraph,
  hasActionableSignal,
  normalizeFingerprintComponent,
  parseManifestFields,
  partitionCandidates,
  type CaptureSource,
} from "./todayCapture";

function pendingEntry(overrides: Partial<InboxEntry>): InboxEntry {
  return {
    id: "inbox/items/pending/item/manifest.yaml",
    kind: "pendingItem",
    path: "/work/inbox/items/pending/item",
    relPath: "inbox/items/pending/item",
    title: "item",
    channel: "gws",
    sourceKind: "message",
    dropPath: null,
    configuredRoot: "/work/inbox",
    itemId: "item",
    status: "pending",
    manifestPath: "/work/inbox/items/pending/item/manifest.yaml",
    summaryPath: "/work/inbox/items/pending/item/summary.md",
    routePath: null,
    sizeBytes: 0,
    receivedAt: "2026-07-21T08:00:00+09:00",
    ...overrides,
  };
}

function source(files: Record<string, string>, entries: InboxEntry[]): CaptureSource {
  return {
    scanPendingEntries: async () => entries,
    readText: async (_workPath, path) => files[path] ?? null,
  };
}

function candidate(overrides: Partial<CaptureCandidate>): CaptureCandidate {
  return {
    captureId: "gmail:msg-1",
    provider: "gmail",
    providerItemId: "msg-1",
    fingerprint: "fp",
    confidence: "high",
    category: "action",
    title: "Title",
    summary: "Summary",
    dueDate: null,
    estimateMinutes: null,
    project: null,
    reason: "action_requested",
    receivedAt: "2026-07-21T08:00:00+09:00",
    ...overrides,
  };
}

function plan(overrides: Partial<DailyPlanV1> = {}): DailyPlanV1 {
  return {
    logicalDay: "2026-07-21",
    inputRevision: "rev-1",
    top: [],
    flexible: [],
    overflow: [],
    reasons: [],
    warnings: [],
    ...overrides,
  };
}

describe("parseManifestFields", () => {
  it("extracts top-level scalars and one-level nested maps", () => {
    const fields = parseManifestFields([
      "# comment",
      "id: 260721-gws-abc",
      "status: pending",
      "channel: gws",
      "provider: gmail",
      "kind: message",
      "received_at: 2026-07-21T08:00:00+09:00",
      "dedupe_key: msg-123",
      'subject_ignored: "n/a"',
      "source:",
      "  from: alice@example.com",
      "  message_id: rfc-822-id",
      "metadata:",
      '  subject: "Quarterly report review"',
      "  actionable: \"true\"",
      "  tags:",
      "    - a",
      "files:",
      "  - raw/a.txt",
      "",
    ].join("\n"));
    expect(fields.id).toBe("260721-gws-abc");
    expect(fields.provider).toBe("gmail");
    expect(fields.receivedAt).toBe("2026-07-21T08:00:00+09:00");
    expect(fields.dedupeKey).toBe("msg-123");
    expect(fields.source.from).toBe("alice@example.com");
    expect(fields.metadata.subject).toBe("Quarterly report review");
    expect(fields.metadata.actionable).toBe("true");
    // Nested block ends when a new top-level key starts; list items ignored.
    expect(fields.metadata.tags).toBeUndefined();
    expect(fields.source.message_id).toBe("rfc-822-id");
  });

  it("treats null/empty scalars as absent", () => {
    const fields = parseManifestFields("id: null\nchannel: ~\nprovider:\nkind: message\n");
    expect(fields.id).toBeNull();
    expect(fields.channel).toBeNull();
    expect(fields.provider).toBeNull();
    expect(fields.kind).toBe("message");
  });
});

describe("fingerprint", () => {
  it("normalizes case and whitespace", () => {
    expect(normalizeFingerprintComponent("  Alice   Kim ")).toBe("alice kim");
    expect(normalizeFingerprintComponent(null)).toBe("");
  });

  it("produces stable hashes across cosmetic differences", async () => {
    const a = await captureFingerprint({
      channel: "GWS",
      from: "Alice@Example.com ",
      subject: "Quarterly   Report",
      date: "2026-07-21",
    });
    const b = await captureFingerprint({
      channel: "gws",
      from: "alice@example.com",
      subject: "quarterly report",
      date: "2026-07-21",
    });
    const c = await captureFingerprint({
      channel: "gws",
      from: "bob@example.com",
      subject: "quarterly report",
      date: "2026-07-21",
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("classifyConfidence", () => {
  const base = {
    hasManifest: true,
    hasId: true,
    knownChannel: true,
    actionable: false,
    hasSender: false,
    hasTitle: false,
  };

  it("high requires actionable + title + sender + known channel", () => {
    expect(
      classifyConfidence({ ...base, actionable: true, hasSender: true, hasTitle: true }),
    ).toBe("high");
    expect(classifyConfidence({ ...base, actionable: true, hasSender: true })).toBe("medium");
    expect(
      classifyConfidence({
        ...base,
        actionable: true,
        hasSender: true,
        hasTitle: true,
        knownChannel: false,
      }),
    ).toBe("low");
  });

  it("medium is structured without an actionable signal", () => {
    expect(classifyConfidence(base)).toBe("medium");
  });

  it("low is legacy/unstructured/missing fields", () => {
    expect(classifyConfidence({ ...base, hasManifest: false })).toBe("low");
    expect(classifyConfidence({ ...base, hasId: false })).toBe("low");
  });
});

describe("hasActionableSignal", () => {
  it("reads flags, classification, and kind", () => {
    const manifest = parseManifestFields("kind: message\nmetadata:\n  actionable: \"true\"\n");
    expect(hasActionableSignal(manifest)).toBe(true);
    const classified = parseManifestFields("kind: message\nmetadata:\n  classification: action\n");
    expect(hasActionableSignal(classified)).toBe(true);
    const kind = parseManifestFields("kind: task\n");
    expect(hasActionableSignal(kind)).toBe(true);
    const plain = parseManifestFields("kind: message\nmetadata:\n  classification: info\n");
    expect(hasActionableSignal(plain)).toBe(false);
  });
});

describe("buildCaptureCandidates", () => {
  const gwsManifest = [
    "id: 260721-gws-abc",
    "status: pending",
    "channel: gws",
    "provider: gmail",
    "kind: message",
    "received_at: 2026-07-21T08:00:00+09:00",
    "dedupe_key: msg-123",
    "metadata:",
    "  subject: Quarterly report review",
    "  from: alice@example.com",
    "  date: 2026-07-21",
    "  classification: action",
    "  project: maru",
    "  due: 2026-07-22",
    "  estimate_minutes: 45",
    "  reason: direct mention",
    "",
  ].join("\n");

  it("maps a structured actionable manifest to a high-confidence candidate", async () => {
    const entry = pendingEntry({ itemId: "260721-gws-abc" });
    const files = {
      [entry.manifestPath!]: gwsManifest,
      [entry.summaryPath!]: "# Digest\n\nFirst paragraph here.\n\nSecond paragraph.\n",
    };
    const candidates = await buildCaptureCandidates({
      workPath: "/work",
      source: source(files, [entry]),
    });
    expect(candidates).toHaveLength(1);
    const c = candidates[0];
    expect(c.captureId).toBe("gmail:msg-123");
    expect(c.provider).toBe("gmail");
    expect(c.providerItemId).toBe("msg-123");
    expect(c.confidence).toBe("high");
    expect(c.category).toBe("action");
    expect(c.title).toBe("Quarterly report review");
    expect(c.summary).toBe("First paragraph here.");
    expect(c.dueDate).toBe("2026-07-22");
    expect(c.estimateMinutes).toBe(45);
    expect(c.project).toBe("maru");
    expect(c.reason).toBe("direct mention");
    expect(c.receivedAt).toBe("2026-07-21T08:00:00+09:00");
  });

  it("structured but non-actionable manifests stay medium", async () => {
    const entry = pendingEntry({
      channel: "telegram",
      manifestPath: "/work/inbox/items/pending/tg/manifest.yaml",
    });
    const files = {
      [entry.manifestPath!]: [
        "id: 260720-tg-1",
        "status: pending",
        "channel: telegram",
        "kind: message",
        "received_at: 2026-07-20T21:00:00+09:00",
        "metadata:",
        "  subject: FYI notes",
        "",
      ].join("\n"),
    };
    const candidates = await buildCaptureCandidates({
      workPath: "/work",
      source: source(files, [entry]),
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].confidence).toBe("medium");
    expect(candidates[0].captureId).toMatch(/^fp:[0-9a-f]{64}$/);
    expect(candidates[0].provider).toBe("telegram");
    expect(candidates[0].reason).toBe("inbox_pending");
  });

  it("unreadable manifests fall back to scan-entry fields at low confidence", async () => {
    const entry = pendingEntry({
      channel: "kakao",
      title: "260721-kakao-chat",
      sourceKind: "message",
      summaryPath: null,
      receivedAt: "2026-07-21T01:00:00+09:00",
    });
    const candidates = await buildCaptureCandidates({
      workPath: "/work",
      source: source({}, [entry]),
    });
    expect(candidates).toHaveLength(1);
    const c = candidates[0];
    expect(c.confidence).toBe("low");
    expect(c.title).toBe("260721-kakao-chat");
    expect(c.category).toBe("message");
    expect(c.reason).toBe("manifest_unreadable");
    expect(c.receivedAt).toBe("2026-07-21T01:00:00+09:00");
    expect(c.captureId).toMatch(/^fp:/);
  });

  it("skips channels outside the provider-backed inbox sources", async () => {
    const entry = pendingEntry({ channel: "local" });
    const candidates = await buildCaptureCandidates({
      workPath: "/work",
      source: source({}, [entry]),
    });
    expect(candidates).toHaveLength(0);
  });

  it("uses metadata description when no summary file is available", async () => {
    const entry = pendingEntry({ summaryPath: null });
    const files = {
      [entry.manifestPath!]: [
        "id: a",
        "channel: gws",
        "metadata:",
        "  description: From the manifest",
        "",
      ].join("\n"),
    };
    const candidates = await buildCaptureCandidates({
      workPath: "/work",
      source: source(files, [entry]),
    });
    expect(candidates[0].summary).toBe("From the manifest");
  });
});

describe("firstParagraph", () => {
  it("returns the first non-heading paragraph, whitespace-collapsed", () => {
    expect(firstParagraph("# Title\n\nhello\nworld\n\nsecond\n")).toBe("hello world");
    expect(firstParagraph("")).toBe("");
    expect(firstParagraph("# only heading\n")).toBe("");
  });
});

describe("dedupeCandidates", () => {
  it("dedupes by provider item id, keeping the earliest receivedAt", () => {
    const newer = candidate({ receivedAt: "2026-07-21T09:00:00+09:00", title: "newer" });
    const older = candidate({ receivedAt: "2026-07-21T07:00:00+09:00", title: "older" });
    const other = candidate({ providerItemId: "msg-2", captureId: "gmail:msg-2" });
    const result = dedupeCandidates([newer, older, other]);
    expect(result).toHaveLength(2);
    expect(result.find((c) => c.providerItemId === "msg-1")?.title).toBe("older");
  });

  it("falls back to fingerprint when no provider item id exists", () => {
    const a = candidate({ providerItemId: null, captureId: "fp:x", fingerprint: "x" });
    const b = candidate({ providerItemId: null, captureId: "fp:x", fingerprint: "x" });
    const c = candidate({ providerItemId: null, captureId: "fp:y", fingerprint: "y" });
    expect(dedupeCandidates([a, b, c])).toHaveLength(2);
  });
});

describe("partitionCandidates", () => {
  it("splits high-confidence rows from suggestions", () => {
    const high = candidate({ confidence: "high" });
    const medium = candidate({ confidence: "medium", captureId: "gmail:m" });
    const low = candidate({ confidence: "low", captureId: "gmail:l" });
    const { capture, suggestions } = partitionCandidates([high, medium, low]);
    expect(capture).toEqual([high]);
    expect(suggestions).toEqual([medium, low]);
  });
});

describe("applyCaptureDecision", () => {
  it("addToToday appends a reversible flexible capture item and a setPlan mutation", () => {
    const existing = plan({
      flexible: [
        {
          itemRef: { kind: "task", taskId: "t-1" },
          lane: "flexible",
          order: 0,
          estimateProvisional: false,
          pinned: false,
          calendarSync: { status: "none" },
        },
      ],
    });
    const outcome = applyCaptureDecision({
      plan: existing,
      candidate: candidate({ captureId: "gmail:msg-9", estimateMinutes: null }),
      decision: "addToToday",
    });
    expect(outcome.plan).not.toBeNull();
    expect(outcome.plan!.flexible).toHaveLength(2);
    const item = outcome.plan!.flexible[1];
    expect(item.itemRef).toEqual({ kind: "capture", captureId: "gmail:msg-9" });
    expect(item.order).toBe(1);
    expect(item.estimateMinutes).toBe(30);
    expect(item.estimateProvisional).toBe(true);
    expect(outcome.mutation).toEqual({ type: "setPlan", plan: outcome.plan });
  });

  it("keeps explicit estimates non-provisional", () => {
    const outcome = applyCaptureDecision({
      plan: plan(),
      candidate: candidate({ estimateMinutes: 45 }),
      decision: "addToToday",
    });
    expect(outcome.plan!.flexible[0].estimateMinutes).toBe(45);
    expect(outcome.plan!.flexible[0].estimateProvisional).toBe(false);
  });

  it("addToToday is idempotent for an already-planned capture", () => {
    const existing = plan({
      flexible: [
        {
          itemRef: { kind: "capture", captureId: "gmail:msg-1" },
          lane: "flexible",
          order: 0,
          estimateProvisional: true,
          pinned: false,
          calendarSync: { status: "none" },
        },
      ],
    });
    const outcome = applyCaptureDecision({
      plan: existing,
      candidate: candidate({ captureId: "gmail:msg-1" }),
      decision: "addToToday",
    });
    expect(outcome.plan).toBeNull();
    expect(outcome.mutation).toBeNull();
  });

  it("keep, edit, defer, and dismiss persist nothing", () => {
    for (const decision of ["keep", "edit", "defer", "dismiss"] as const) {
      const outcome = applyCaptureDecision({
        plan: plan(),
        candidate: candidate({}),
        decision,
        deferDate: "2026-07-25",
      });
      expect(outcome).toEqual({ plan: null, mutation: null });
    }
  });

  it("addToToday without an existing plan is a no-op", () => {
    const outcome = applyCaptureDecision({
      plan: null,
      candidate: candidate({}),
      decision: "addToToday",
    });
    expect(outcome).toEqual({ plan: null, mutation: null });
  });
});
