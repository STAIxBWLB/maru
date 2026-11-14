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
  const pendingFields = {
    maruCompletionRequired: true,
    maruCompletionPolicyRevision: "policy-interrupted",
    taskId: "task-interrupted",
  };
  const row = (
    name: string,
    bucket: TaskNoteRow["bucket"],
    status: string,
    fields: Record<string, unknown> = {},
  ): TaskNoteRow => ({
    path: `/workspace/tasks/${bucket}/${name}.md`, relPath: `tasks/${bucket}/${name}.md`,
    fileName: `${name}.md`, displayTitle: name, bucket, sizeBytes: 100, updatedAt: null,
    frontmatter: { title: name, status, maruCompletionRequired: false, ...fields },
  });

  it("keeps Done bytes in Active visible for explicit acceptance recovery", () => {
    const entries = rowsToTaskEntries([
      row("interrupted", "active", "done", pendingFields), row("archived", "archive", "done"),
      row("open", "active", "active"),
    ]);
    expect(filterTasksByQuery(entries, "", filtersForView("done")).map((entry) => entry.title))
      .toEqual(["archived", "interrupted"]);
  });

  it.each([
    { bucket: "active", status: "done" },
    { bucket: "active", status: "cancelled" },
    { bucket: "backlog", status: "done" },
    { bucket: "backlog", status: "cancelled" },
  ] as const)("keeps ordinary $status outside Archive excluded from Done ($bucket)", ({ bucket, status }) => {
    const entries = rowsToTaskEntries([
      row("ordinary", bucket, status, { maruCompletionRequired: false }),
      row("interrupted", "active", "done", pendingFields),
      row("archived-done", "archive", "done"),
      row("archived-cancelled", "archive", "cancelled"),
    ]);

    expect(filterTasksByQuery(entries, "", filtersForView("done")).map((entry) => entry.title))
      .toEqual(["archived-cancelled", "archived-done", "interrupted"]);
  });

  it.each([
    { label: "missing policy revision", fields: { maruCompletionRequired: true, taskId: "task-incomplete" } },
    { label: "missing task identity", fields: { maruCompletionRequired: true, maruCompletionPolicyRevision: "policy-incomplete" } },
    { label: "blank policy revision", fields: { ...pendingFields, maruCompletionPolicyRevision: " " } },
    { label: "blank task identity", fields: { ...pendingFields, taskId: " " } },
  ])("does not widen Done for incomplete opt-in metadata: $label", ({ fields }) => {
    const entries = rowsToTaskEntries([
      row("incomplete", "active", "done", fields),
      row("interrupted", "active", "done", pendingFields),
      row("archived", "archive", "done"),
    ]);

    expect(filterTasksByQuery(entries, "", filtersForView("done")).map((entry) => entry.title))
      .toEqual(["archived", "interrupted"]);
  });
});
