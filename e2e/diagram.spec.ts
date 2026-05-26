import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.sessionStorage.getItem("anchor:diagram-e2e:storage-cleared") === "true") return;
    window.localStorage.clear();
    window.sessionStorage.setItem("anchor:diagram-e2e:storage-cleared", "true");
  });
});

function watchForbiddenRequests(page: Page): string[] {
  const forbidden: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (
      url.includes("localhost:5500")
      || url.includes("fonts.googleapis.com")
      || url.includes("fonts.gstatic.com")
    ) {
      forbidden.push(url);
    }
  });
  return forbidden;
}

test("shows Diagram mode behind the feature flag with localized activity labels", async ({ page }) => {
  const forbidden = watchForbiddenRequests(page);
  await page.goto("/");

  await expect(page.getByRole("button", { name: "다이어그램" })).toBeVisible();
  await page.getByRole("button", { name: "다이어그램", exact: true }).click();
  await expect(page.getByTestId("diagram-mode")).toBeVisible();
  await expect(page.getByRole("tab", { name: "파일" })).toBeVisible();

  await page.getByRole("button", { name: "언어" }).click();
  await expect(page.getByRole("button", { name: "Diagram" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "File" })).toBeVisible();
  expect(forbidden).toEqual([]);
});

test("opens Diagram from the command palette and restores the last saved document", async ({
  page,
}) => {
  const forbidden = watchForbiddenRequests(page);
  await page.goto("/");

  await page.getByRole("button", { name: /명령 팔레트/ }).first().click();
  await page.locator(".cmdk-input input").fill("다이어그램");
  await page.getByRole("button", { name: /다이어그램 열기/ }).click();
  await expect(page.getByTestId("diagram-mode")).toBeVisible();

  await page.getByRole("textbox", { name: "제목 없음" }).fill("E2E Diagram");
  await page.getByRole("tab", { name: "입력" }).click();
  await page.getByRole("button", { name: "단순" }).click();
  await expect(page.locator(".anchor-diagram-node")).toHaveCount(1);

  await page.getByRole("tab", { name: "파일" }).click();
  await page.getByRole("button", { name: "저장" }).click();
  const dialog = page.locator(".dialog-content", { hasText: "다이어그램 저장" });
  await dialog.getByLabel("파일 이름").fill("e2e-diagram");
  await dialog.getByRole("button", { name: "저장" }).click();
  await expect(page.locator(".anchor-diagram-status", { hasText: "저장됨" })).toBeVisible();

  await page.reload();
  await page.getByRole("button", { name: "다이어그램", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "제목 없음" })).toHaveValue("E2E Diagram");
  await expect(page.locator(".anchor-diagram-node")).toHaveCount(1);
  expect(forbidden).toEqual([]);
});

test("exercises templates, Mermaid import/export, and filled ribbon tabs", async ({ page }) => {
  const forbidden = watchForbiddenRequests(page);
  await page.goto("/");
  await page.getByRole("button", { name: "다이어그램", exact: true }).click();

  await page.getByRole("tab", { name: "파일" }).click();
  await page.getByRole("button", { name: "템플릿" }).click();
  const templateDialog = page.locator(".dialog-content", { hasText: "템플릿 선택" });
  await templateDialog.getByRole("button", { name: /PDCA 사이클/ }).click();
  await templateDialog.getByRole("button", { name: "적용" }).click();
  await expect(page.locator(".anchor-diagram-node")).toHaveCount(4);

  await page.getByRole("tab", { name: "도구" }).click();
  await expect(page.getByRole("button", { name: "찾기" })).toBeVisible();
  await expect(page.getByRole("button", { name: "특수문자" })).toBeVisible();

  await page.getByRole("tab", { name: "인포그래픽" }).click();
  await page.getByRole("button", { name: "KPI 세트" }).click();
  await expect(page.locator(".anchor-diagram-node")).toHaveCount(7);

  await page.getByRole("tab", { name: "파일" }).click();
  await page.getByRole("button", { name: "Mermaid 가져오기" }).click();
  const importDialog = page.locator(".dialog-content", { hasText: "Mermaid 다이어그램 가져오기" });
  await importDialog.locator("textarea").fill("flowchart TD\n  A[Start] --> B[Finish]");
  await importDialog.getByRole("button", { name: "가져오기" }).click();
  await expect(page.locator(".anchor-diagram-node")).toHaveCount(2);

  await page.getByRole("tab", { name: "화살표" }).click();
  await expect(page.getByRole("button", { name: "자동" })).toBeVisible();
  await page.getByRole("tab", { name: "테이블" }).click();
  await expect(page.getByText("표 노드를 선택하세요.")).toBeVisible();

  await page.getByRole("tab", { name: "파일" }).click();
  await page.getByRole("button", { name: "내보내기" }).click();
  await expect(page.locator(".dialog-content", { hasText: "내보내기" })).toContainText("Mermaid (.mmd)");
  expect(forbidden).toEqual([]);
});
