import { expect, test } from "@playwright/test";
import type {} from "../src/lib/e2eInvoke";

const pastedNote = [
  "# 제품 전략 회의",
  "참석자: 김민서(제품팀), 박준호(파트너사)",
  "김민서: 9월 출시 범위를 확정한다.",
  "박준호: 베타 일정은 9월 18일로 제안했다.",
  "결정: 다음 회의 전까지 비용안을 검토한다.",
].join("\n");
const placeholderPattern = /외부 서비스에서 복사한 회의록|Paste a meeting note copied from an external service/;

async function openSourceReview(page: import("@playwright/test").Page) {
  await page.goto("/?maru-e2e=1");
  await page.getByRole("button", { name: "회의록", exact: true }).click();
  const pane = page.locator(".meetings-pane");
  await expect(pane).toBeVisible();
  await pane.getByRole("button", { name: /외부 회의록 교정|Review external meeting note/ }).click();
  await expect(pane.locator(".meeting-source-empty")).toContainText(/외부 회의록 교정|Review external meeting note/);
  return pane;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    // Playwright creates a fresh context for each test. Keep localStorage
    // intact across reloads so the resume test exercises durable UI state.
  });
});

test("reviews a pasted external note, records a version, and confirms it for generation", async ({
  page,
}) => {
  const pane = await openSourceReview(page);
  const note = pane.getByRole("textbox", { name: placeholderPattern });
  await note.fill(pastedNote);
  await pane.getByRole("button", { name: /회의록 만들기|Create note/ }).click();

  await expect(page.getByText(/참석자와 맥락|Participants and context/)).toBeVisible();
  await pane.getByRole("button", { name: /참석자 추가|Add participant/ }).click();
  const participantNames = pane.getByRole("textbox", { name: /이름|Name/ });
  await participantNames.last().fill("김민서");
  await pane.getByRole("textbox", { name: /소속|Affiliation/ }).last().fill("제품팀");
  await pane.locator(".meeting-source-context-label textarea").fill("9월 출시 범위를 결정하는 제품 전략 회의");
  await pane.locator(".meeting-source-person").last().getByRole("button", { name: /불확실|Uncertain/ }).click();
  await pane.locator(".meeting-source-reference-import summary").click();
  await pane.getByRole("textbox", { name: /참고 자료 내용|Reference text/ }).fill("참고 녹취록: 비용안은 다음 회의에서 확정");
  await pane.getByRole("button", { name: /자료 추가|Add reference/ }).click();

  await expect(pane.locator(".meeting-source-editors textarea").first()).toHaveValue(pastedNote);
  const corrected = pane.locator(".meeting-source-editors textarea").last();
  await corrected.fill(`${pastedNote}\n추가 확인: 비용안 담당자는 다음 회의에서 확정한다.`);
  await pane.getByRole("button", { name: /비교|Compare/ }).click();
  await expect(pane.locator(".meeting-source-diff")).toBeVisible();
  const columns = pane.locator(".meeting-source-diff [role=columnheader]");
  await expect(columns).toHaveText(["원본", "수정본"]);
  const [originalBox, correctedBox] = await Promise.all([columns.first().boundingBox(), columns.last().boundingBox()]);
  expect(originalBox).not.toBeNull(); expect(correctedBox).not.toBeNull();
  expect(correctedBox!.x).toBeGreaterThan(originalBox!.x);
  expect(correctedBox!.y).toBe(originalBox!.y);
  await pane.locator(".meeting-source-diff").screenshot({ path: "/tmp/maru318-side-by-side.png" });

  const reason = page.getByRole("textbox", { name: /수정 이유를 입력하세요|Why did you make this correction/ });
  await expect(reason).toBeVisible();
  await reason.fill("비용안 담당자 확정 여부를 원문과 구분해 기록");
  await pane.getByRole("button", { name: /버전 저장|Save version/ }).click();
  await pane.getByRole("button", { name: /수정 이력|Correction history/ }).click();
  await expect(pane.getByRole("button", { name: /수정 이력|Correction history/ })).toBeVisible();

  await pane.getByRole("checkbox", { name: /참가자.*회의 맥락|participants and context/i }).check();
  await pane.getByRole("checkbox", { name: /회의록의 내용|note, corrections/i }).check();
  await pane.getByRole("button", { name: /검토 완료|Mark reviewed/ }).click();
  await expect(pane.getByRole("button", { name: "확인됨", exact: true })).toBeVisible();
});

test("resumes an external note review and keeps the original alongside the corrected note", async ({ page }) => {
  const pane = await openSourceReview(page);
  const note = pane.getByRole("textbox", { name: placeholderPattern });
  await note.fill(pastedNote);
  await pane.getByRole("button", { name: /회의록 만들기|Create note/ }).click();
  await pane.locator(".meeting-source-editors textarea").last().fill(`${pastedNote}\n불확실: 참석자 역할은 확인 필요`);
  await expect(pane.getByText(/저장되지 않은 수정|Unsaved changes/)).toBeVisible();
  await pane.getByRole("button", { name: /임시저장|Save draft/ }).click();
  await page.reload();
  await page.getByRole("button", { name: "회의록", exact: true }).click();
  await page.locator(".meetings-pane").getByRole("button", { name: /외부 회의록 교정|Review external meeting note/ }).click();
  await expect(page.locator(".meeting-source-editors textarea").last()).toHaveValue(`${pastedNote}\n불확실: 참석자 역할은 확인 필요`);
  await expect(page.locator(".meeting-source-editors textarea").first()).toHaveValue(pastedNote);
  await expect(page.getByText(/원문을 보존|Preserve the original/)).toBeVisible();
});

test("imports UTF-8 Markdown without changing original bytes and pages long comparisons", async ({ page }) => {
  const pane = await openSourceReview(page);
  const original = Array.from({ length: 900 }, (_, index) => `회의 내용 ${index}: 검토 중`).join("\r\n") + "\r\n";
  await pane.locator('input[type="file"]').setInputFiles({ name: "meeting-export.md", mimeType: "text/markdown", buffer: Buffer.from(original, "utf8") });
  await expect(pane.locator(".meeting-source-editors textarea").first()).toHaveValue(original.replaceAll("\r\n", "\n"));
  await pane.locator(".meeting-source-editors textarea").last().fill(original.replace("회의 내용 800: 검토 중", "회의 내용 800: 확인됨"));
  await pane.getByRole("button", { name: "비교", exact: true }).first().click();
  await expect(pane.getByText(/비교 1 \/ 3 페이지/)).toBeVisible();
  await pane.getByRole("button", { name: "비교 다음 페이지" }).click();
  await expect(pane.getByText(/비교 2 \/ 3 페이지/)).toBeVisible();
  const stored = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((key) => key.startsWith("maru.meeting-source-reviews.v1:"))!;
    return JSON.parse(localStorage.getItem(key)!)[0].draft.sources[0].originalText as string;
  });
  expect(stored).toBe(original);
});

test("accepts selected AI corrections and promotes an explicitly scoped reusable example", async ({ page }) => {
  await page.addInitScript(() => {
    window.__MARU_E2E_INVOKE__ = {
      ...(window.__MARU_E2E_INVOKE__ ?? {}),
      agent_read_run_events: () => {
        const key = Object.keys(localStorage).find((key) => key.startsWith("maru.meeting-source-reviews.v1:"));
        if (!key) return [];
        const session = JSON.parse(localStorage.getItem(key)!)[0] as { id: string; revision: string; draft: { sources: { id: string }[] } };
        return [{ type: "provider.output", payload: { line: JSON.stringify({
          schemaVersion: "maru_meeting_source_review_v1", sessionId: session.id, baseRevision: session.revision,
          suggestions: [
            { id: "one", sourceId: session.draft.sources[0].id, before: "김민서: 9월 출시 범위를 확정한다.", after: "김민서: 9월 출시 범위를 검토한다.", category: "decision", reason: "확정과 검토 구분", evidence: "참가자에게 확인할 표현", required: true },
            { id: "two", sourceId: session.draft.sources[0].id, before: "비용안을 검토한다.", after: "비용안을 승인한다.", category: "decision", reason: "승인 여부 확인", evidence: "검토 후 사용자가 판단", required: true },
          ],
        }) } }, { type: "run.completed", payload: {} }];
      },
    };
  });
  const pane = await openSourceReview(page);
  await pane.getByRole("textbox", { name: "외부 서비스에서 복사한 회의록을 붙여넣으세요." }).fill(pastedNote);
  await pane.getByRole("button", { name: "회의록 만들기" }).click();
  await pane.getByRole("button", { name: "AI 교정 제안", exact: true }).click();
  const suggestions = pane.locator(".meeting-source-suggestion");
  await expect(suggestions).toHaveCount(2, { timeout: 15000 });
  await suggestions.first().getByRole("button", { name: "수락", exact: true }).click();
  await expect(pane.locator(".meeting-source-editors textarea").last()).toHaveValue(pastedNote.replace("김민서: 9월 출시 범위를 확정한다.", "김민서: 9월 출시 범위를 검토한다."));
  await suggestions.last().getByRole("button", { name: "거절", exact: true }).click();
  await pane.getByRole("textbox", { name: "수정 이유를 입력하세요" }).fill("AI 제안 중 확인한 표현만 반영");
  await pane.getByRole("button", { name: "버전 저장", exact: true }).click();
  await expect(pane.locator(".meeting-source-editor-body")).not.toBeDisabled();
  const examples = pane.locator(".meeting-source-examples");
  await examples.locator("summary").click();
  await examples.getByRole("button", { name: "재사용 교정 사례로 저장" }).click();
  await examples.getByRole("textbox", { name: "수정 전 구절" }).fill("확정한다.");
  await examples.getByRole("textbox", { name: "수정 후 구절" }).fill("검토한다.");
  await examples.getByRole("textbox", { name: "교정 사유" }).fill("확정되지 않은 제안과 실제 결정을 구분");
  await examples.getByRole("button", { name: "사례 저장", exact: true }).click();
  await expect(examples.locator(".meeting-source-example-row")).toHaveCount(1);
  await examples.getByRole("checkbox", { name: "사용", exact: true }).uncheck();
  await expect(examples.getByRole("checkbox", { name: "사용", exact: true })).not.toBeChecked();
});
