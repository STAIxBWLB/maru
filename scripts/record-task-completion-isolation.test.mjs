import { test } from "vitest";
import assert from "node:assert/strict";
import { TASK_COMPLETION_CASES, parseTaskCompletionBehavior } from "./record-task-completion-isolation.mjs";

// Synthetic parser fixtures only, never inputs to production evidence emission.
function fixture({ names = TASK_COMPLETION_CASES, passed = 4, ignored = 0, measured = 0 } = {}) {
  return `${names.map((name) => `test task_completion::phase08_09_completion::${name} ... ok`).join("\n")}\n\ntest result: ok. ${passed} passed; 0 failed; ${ignored} ignored; ${measured} measured; 12 filtered out; finished in 0.01s\n`;
}
test("accepts the complete unique non-ignored fixed-selector output", () => {
  assert.deepEqual(parseTaskCompletionBehavior(fixture()), { passed: 4, failed: 0, ignored: 0, exitCode: 0 });
});
test("requires each physical completion behavior case", () => {
  for (const missing of TASK_COMPLETION_CASES) {
    assert.throws(() => parseTaskCompletionBehavior(fixture({ names: TASK_COMPLETION_CASES.filter((name) => name !== missing) })), /Missing unique passing completion case/);
  }
});
test("refuses ignored, measured, zero or surplus cases", () => {
  for (const fields of [{ ignored: 1 }, { measured: 1 }, { passed: 0 }, { passed: 5 }]) {
    assert.throws(() => parseTaskCompletionBehavior(fixture(fields)), /exactly four passing, non-ignored/);
  }
});
test("refuses duplicate case names even with a successful summary", () => {
  assert.throws(() => parseTaskCompletionBehavior(fixture({ names: [...TASK_COMPLETION_CASES, TASK_COMPLETION_CASES[0]] })), /Missing unique passing completion case/);
});
test("refuses incomplete, failed or multiple result summaries", () => {
  for (const log of ["", fixture().replace("test result: ok.", "test result: FAILED."), fixture() + fixture()]) {
    assert.throws(() => parseTaskCompletionBehavior(log), /one complete successful fixed-selector/);
  }
});
test("does not accept same-named cases outside the real command module", () => {
  assert.throws(() => parseTaskCompletionBehavior(fixture().replaceAll("task_completion::phase08_09_completion::", "fake_fixture::")), /Missing unique passing completion case/);
});
