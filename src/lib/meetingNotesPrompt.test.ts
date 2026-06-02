import { describe, expect, it } from "vitest";
import {
  appendSourceBlock,
  buildMeetingNotesPrompt,
  meetingNotesRunContract,
} from "./meetingNotesPrompt";
import type { MeetingsSettings } from "./settings";

const settings = {
  root: "meetings",
  filenameTemplate: "MM-DD {type} - {topic} - {detail}.md",
  defaultTypes: ["회의"],
} as unknown as MeetingsSettings;

describe("buildMeetingNotesPrompt", () => {
  it("emits the run contract and the transcript source block", () => {
    const prompt = buildMeetingNotesPrompt({
      sourceKind: "transcript",
      settings,
      type: "회의",
      topic: "UAM",
      detail: "",
      note: "녹취록 본문",
      guides: null,
    });
    expect(prompt).toContain("Run contract:");
    expect(prompt).toContain('schemaVersion "anchor_skill_proposal_v1"');
    expect(prompt).toContain('schemaVersion "anchor_meeting_review_v1"');
    expect(prompt).toContain("TRANSCRIPT_TEXT:\n녹취록 본문");
    expect(prompt).toContain("Root: meetings");
  });

  it("uses the EXTERNAL_NOTE label for external sources", () => {
    const prompt = buildMeetingNotesPrompt({
      sourceKind: "external",
      settings,
      type: "회의",
      topic: "",
      detail: "",
      note: "정리본",
      guides: null,
    });
    expect(prompt).toContain("EXTERNAL_NOTE:\n정리본");
    expect(prompt).not.toContain("TRANSCRIPT_TEXT:");
  });
});

describe("appendSourceBlock", () => {
  it("appends exactly one contract and one source block", () => {
    const result = appendSourceBlock("Create a new meeting note.", "녹취록 원문");
    expect(occurrences(result, "Run contract:")).toBe(1);
    expect(occurrences(result, 'schemaVersion "anchor_meeting_review_v1"')).toBe(1);
    expect(result).toContain("Create a new meeting note.");
    expect(result).toContain("TRANSCRIPT_TEXT:\n녹취록 원문");
  });

  it("does not duplicate the contract when the base prompt already carries it", () => {
    const base = [
      "Create a new meeting note.",
      meetingNotesRunContract().join("\n"),
    ].join("\n\n");
    const result = appendSourceBlock(base, "원문");
    expect(occurrences(result, "Run contract:")).toBe(1);
    expect(result).toContain("TRANSCRIPT_TEXT:\n원문");
  });

  it("does not duplicate the contract when the skill body carries JSON schemaVersion", () => {
    const base = [
      "Create a new meeting note.",
      "```json",
      '{ "schemaVersion": "anchor_meeting_review_v1", "summary": "" }',
      "```",
    ].join("\n");
    const result = appendSourceBlock(base, "원문");
    expect(occurrences(result, "Run contract:")).toBe(0);
    expect(result).toContain("TRANSCRIPT_TEXT:\n원문");
  });

  it("no-ops on empty source text", () => {
    expect(appendSourceBlock("Create a new meeting note.", "")).toBe(
      "Create a new meeting note.",
    );
    expect(appendSourceBlock("Create a new meeting note.", "   \n ")).toBe(
      "Create a new meeting note.",
    );
  });

  it("supports the external source label", () => {
    const result = appendSourceBlock("base", "정리본", "external");
    expect(result).toContain("EXTERNAL_NOTE:\n정리본");
  });
});

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}
