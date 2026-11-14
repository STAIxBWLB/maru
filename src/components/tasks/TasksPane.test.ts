import { describe, expect, it, vi } from "vitest";
import { filterTasksByQuery, rowsToTaskEntries } from "../../lib/tasks";
import type { TaskNoteRow } from "../../lib/types";
import { canSwitchTaskDetails, filtersForView } from "./TasksPane";

describe("TasksPane detail selection guard", () => {
  it("switches immediately when the detail drawer is clean", async () => {
    const confirmDiscard = vi.fn(async () => false);

    await expect(canSwitchTaskDetails(false, confirmDiscard)).resolves.toBe(true);
    expect(confirmDiscard).not.toHaveBeenCalled();
  });

  it("requires confirmation before switching away from dirty details", async () => {
    const reject = vi.fn(async () => false);
    const accept = vi.fn(async () => true);

    await expect(canSwitchTaskDetails(true, reject)).resolves.toBe(false);
    await expect(canSwitchTaskDetails(true, accept)).resolves.toBe(true);
    expect(reject).toHaveBeenCalledTimes(1);
    expect(accept).toHaveBeenCalledTimes(1);
  });
});


describe("TasksPane interrupted completion visibility", () => {
  it("keeps Done bytes in Active visible for explicit acceptance recovery", () => {
    const row = (name: string, bucket: TaskNoteRow["bucket"], status: string): TaskNoteRow => ({
      path: `/workspace/tasks/${bucket}/${name}.md`, relPath: `tasks/${bucket}/${name}.md`,
      fileName: `${name}.md`, displayTitle: name, bucket, sizeBytes: 100, updatedAt: null,
      frontmatter: { title: name, status, maruCompletionRequired: name === "interrupted" },
    });
    const entries = rowsToTaskEntries([
      row("interrupted", "active", "done"), row("archived", "archive", "done"),
      row("open", "active", "active"),
    ]);
    expect(filterTasksByQuery(entries, "", filtersForView("done")).map((entry) => entry.title))
      .toEqual(["archived", "interrupted"]);
  });
});
