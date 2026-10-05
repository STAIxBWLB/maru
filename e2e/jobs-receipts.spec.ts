import { expect, test } from "@playwright/test";
import type {} from "../src/lib/e2eInvoke";

test("Jobs keeps process success separate from task verification and skipped admission", async ({ page }) => {
  await page.addInitScript(() => {
    const receipt = (runId: string, source: string, processOutcome: string, exitCode: number | null) => ({
      requestId: `request-${runId}`, runId, source, processOutcome, exitCode,
      jobRevision: "frozen-fixture-revision", scheduledFireAt: 1728000000,
      admittedAt: 1728000001, startedAt: exitCode === null ? null : 1728000002,
      finishedAt: 1728000003, verificationOutcome: "notRequested",
      ledgerRecorded: exitCode === 0, coalescedInto: null, owner: null, child: null,
    });
    window.__MARU_E2E_INVOKE__ = {
      jobs_list: () => [{
        id: "receipt-fixture", title: "Receipt fixture", description: "",
        installed: false, loaded: false, enabled: false, plistPath: "", label: "",
        schedule: { hour: 9, minute: 0, recoveryIntervalSeconds: 0, recoveryMode: "repeat", runAtLoad: false },
        lastExitCode: 0, lastRunAt: null,
        receipts: [receipt("manual-success", "manual", "exited", 0), receipt("recovery-skipped", "recovery", "skipped_active", null)],
      }],
    };
  });
  await page.goto("/?window=settings&workPath=mock%3A%2F%2Fmaru-sample-workspace&tab=jobs");
  const job = page.locator(".jobs-list-item", { hasText: "Receipt fixture" });
  await job.locator("summary").click();
  const rows = job.locator("details ol > li");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("manual: exited");
  await expect(rows.nth(0)).toContainText("프로세스 종료: 0");
  await expect(rows.nth(0)).toContainText("작업 검증: 요청하지 않음");
  await expect(rows.nth(1)).toContainText("recovery: skipped_active");
  await expect(rows.nth(1)).toContainText("프로세스 종료: -");
  await expect(rows.nth(1)).not.toContainText("프로세스 종료: 0");
  await page.reload();
  await job.locator("summary").click();
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("manual-success");
});

test("Jobs makes an empty execution history explicit", async ({ page }) => {
  await page.goto("/?window=settings&workPath=mock%3A%2F%2Fmaru-sample-workspace&tab=jobs");
  await page.locator(".jobs-list-item").first().locator("summary").click();
  await expect(page.getByText("기록된 실행 없음", { exact: true })).toBeVisible();
});
