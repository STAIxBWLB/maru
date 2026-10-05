// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { JobStatus, JobRunReceipt } from "../../lib/api";
const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../../lib/api", async (original) => ({
  ...await original<typeof import("../../lib/api")>(), jobsList: mocks.list,
}));
vi.mock("./DotSyncPanel", () => ({ DotSyncPanel: () => null }));
vi.mock("./SystemJobsPanel", () => ({ SystemJobsPanel: () => null }));
import { LocaleContext } from "../../lib/i18n";
import { JobsTab } from "./JobsTab";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
const row: JobRunReceipt = {
  requestId: "request", runId: "run-0", source: "manual", jobRevision: "frozen",
  admittedAt: 1, scheduledFireAt: 0, startedAt: 1, finishedAt: 2,
  processOutcome: "exited", exitCode: 0, verificationOutcome: "notRequested",
  ledgerRecorded: true, coalescedInto: null, owner: null, child: null,
};
const job: JobStatus = {
  id: "test", title: "Test", description: "", installed: false, loaded: false,
  enabled: false, plistPath: "/fixture", label: "fixture", lastExitCode: 0,
  lastRunAt: null, schedule: { hour: 0, minute: 0, recoveryIntervalSeconds: 0,
    recoveryMode: "repeat", runAtLoad: false }, receipts: [row],
};
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.clearAllMocks(); });
async function render(value: JobStatus) {
  mocks.list.mockResolvedValue([value]);
  await act(async () => { root.render(<LocaleContext.Provider value={{ locale: "en", setLocale: () => {}, t: (key, values) => `${key}${values ? JSON.stringify(values) : ""}` }}><JobsTab workPath="/fixture" /></LocaleContext.Provider>); });
}
it("shows independent task verification when a process exits successfully", async () => {
  await render(job);
  const history = container.querySelector("details")!;
  expect(history.textContent).toContain("manual: exited");
  expect(history.textContent).toContain('system.jobs.history.process{"code":0}');
  expect(history.textContent).toContain("system.jobs.history.notRequested");
  expect(history.textContent).toContain("run-0");
});
it("shows skipped and deduplicated requests without inventing exit success", async () => {
  await render({ ...job, receipts: [
    { ...row, runId: "skip", processOutcome: "skipped_active", exitCode: null, coalescedInto: "running-id", source: "recovery" },
    { ...row, runId: "dedup", processOutcome: "deduplicated", exitCode: null, source: "calendar" },
  ] });
  const history = container.querySelector("details")!;
  expect(history.querySelectorAll("li")).toHaveLength(2);
  expect(history.textContent).toContain("recovery: skipped_active");
  expect(history.textContent).toContain("calendar: deduplicated");
  expect(history.textContent).toContain('system.jobs.history.process{"code":"-"}');
  expect(history.textContent).toContain("running-id");
});
it("has explicit empty history for legacy jobs", async () => {
  await render({ ...job, receipts: undefined });
  expect(container.querySelector("details")!.textContent).toContain("system.jobs.history.empty");
});
