import { describe, expect, it } from "vitest";
import {
  logLinePhase,
  logLineSeverity,
  parseMeetingsLogLine,
  serializeMeetingsLogLine,
} from "./meetingsLog";

describe("meetingsLog serializer", () => {
  it("emits a single-line markdown entry with ISO timestamp and JSON payload", () => {
    const line = serializeMeetingsLogLine({
      event: "apply",
      runId: "r1",
      status: "completed",
      skill: "meeting-notes",
      target: "meetings/2026/2026-05/note.md",
      extra: { files: 2, followups: 1 },
      ts: "2026-05-12T08:14:33.000Z",
    });
    expect(line).toBe(
      '- 2026-05-12T08:14:33.000Z [apply] {"files":2,"followups":1,"runId":"r1","status":"completed","skill":"meeting-notes","target":"meetings/2026/2026-05/note.md"}',
    );
  });

  it("omits null/empty optional fields", () => {
    const line = serializeMeetingsLogLine({
      event: "clear",
      runId: "r2",
      status: "cleared",
      ts: "2026-05-12T08:14:33.000Z",
    });
    expect(line).toBe(
      '- 2026-05-12T08:14:33.000Z [clear] {"runId":"r2","status":"cleared"}',
    );
  });
});

describe("meetingsLog parser", () => {
  it("parses structured lines", () => {
    const line = parseMeetingsLogLine(
      '- 2026-05-12T08:14:33.000Z [apply] {"runId":"r1","status":"completed","skill":"meeting-notes","files":2}',
    );
    expect(line.legacy).toBe(false);
    expect(line.event).toBe("apply");
    expect(line.runId).toBe("r1");
    expect(line.status).toBe("completed");
    expect(line.payload?.files).toBe(2);
  });

  it("normalizes legacy lines into a followup event", () => {
    const line = parseMeetingsLogLine(
      "- 2026-05-12T08:14:33Z vault-extract: meetings/2026/2026-05/note.md",
    );
    expect(line.legacy).toBe(true);
    expect(line.event).toBe("followup");
    expect(line.skill).toBe("vault-extract");
    expect(line.target).toBe("meetings/2026/2026-05/note.md");
    expect(line.status).toBe("started");
  });

  it("returns unknown event when payload is malformed", () => {
    const line = parseMeetingsLogLine("- 2026-05-12T08:14:33Z [apply] {not-json}");
    expect(line.event).toBe("apply");
    expect(line.payload).toBeNull();
    expect(line.legacy).toBe(false);
  });

  it("falls back to unknown when timestamp is missing", () => {
    const line = parseMeetingsLogLine("free text without prefix");
    expect(line.event).toBe("unknown");
    expect(line.ts).toBeNull();
    expect(line.legacy).toBe(true);
  });
});

describe("meetingsLog severity and phase", () => {
  it("flags error events", () => {
    const line = parseMeetingsLogLine(
      '- 2026-05-12T08:14:33Z [error] {"runId":"r3","status":"failed","skill":"meeting-notes"}',
    );
    expect(logLineSeverity(line)).toBe("error");
  });

  it("detects warnings via keywords", () => {
    expect(logLineSeverity("retrying after timeout")).toBe("warn");
  });

  it("extracts phase markers", () => {
    expect(logLinePhase("[phase:draft] drafting body")).toBe("draft");
    const structured = parseMeetingsLogLine(
      '- 2026-05-12T08:14:33Z [phase] {"phase":"normalize"}',
    );
    expect(logLinePhase(structured)).toBe("normalize");
  });
});
