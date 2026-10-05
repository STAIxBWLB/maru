import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.sessionStorage.getItem("maru:diagram-e2e:storage-cleared") === "true") return;
    window.localStorage.clear();
    window.sessionStorage.setItem("maru:diagram-e2e:storage-cleared", "true");
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

  await expect(page.getByRole("button", { name: "다이어그램", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "다이어그램", exact: true }).click();
  await expect(page.getByTestId("diagram-mode")).toBeVisible();
  await expect(page.getByRole("tab", { name: "파일" })).toBeVisible();

  await page.getByRole("button", { name: "언어" }).click();
  await expect(page.getByRole("button", { name: "Diagram", exact: true })).toBeVisible();
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
  await expect(page.locator(".maru-diagram-node")).toHaveCount(1);

  await page.getByRole("tab", { name: "파일" }).click();
  await page.getByRole("button", { name: "저장" }).click();
  const dialog = page.locator(".dialog-content", { hasText: "다이어그램 저장" });
  await dialog.getByLabel("파일 이름").fill("e2e-diagram");
  await dialog.getByRole("button", { name: "저장" }).click();
  await expect(page.locator(".maru-diagram-status", { hasText: "저장됨" })).toBeVisible();

  await page.reload();
  await page.getByRole("button", { name: "다이어그램", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "제목 없음" })).toHaveValue("E2E Diagram");
  await expect(page.locator(".maru-diagram-node")).toHaveCount(1);
  expect(forbidden).toEqual([]);
});

test("exercises templates, Mermaid import/export, and filled ribbon tabs", async ({ page }) => {
  const forbidden = watchForbiddenRequests(page);
  await page.goto("/");
  await page.getByRole("button", { name: "다이어그램", exact: true }).click();

  await page.getByRole("tab", { name: "파일" }).click();
  await page.getByRole("button", { name: "템플릿" }).click();
  const templateDialog = page.locator(".dialog-content", { hasText: "패턴 갤러리" });
  await templateDialog.getByTestId("gallery-card-pdca-cycle").click();
  await templateDialog.getByTestId("gallery-action-new-document").click();
  await expect(page.locator(".maru-diagram-node")).toHaveCount(4);

  await page.getByRole("tab", { name: "도구" }).click();
  await expect(page.getByRole("button", { name: "찾기" })).toBeVisible();
  await expect(page.getByRole("button", { name: "특수문자" })).toBeVisible();

  await page.getByRole("tab", { name: "인포그래픽" }).click();
  await page.getByRole("button", { name: "KPI 세트" }).click();
  await expect(page.locator(".maru-diagram-node")).toHaveCount(7);

  await page.getByRole("tab", { name: "파일" }).click();
  await page.getByRole("button", { name: "가져오기" }).click();
  const importDialog = page.locator(".dialog-content", { hasText: "가져오기" });
  // Doc-kind imports replace the dirty document — accept the confirm dialog.
  page.on("dialog", (d) => void d.accept());
  await importDialog.locator('[data-testid="ie-file-input"]').setInputFiles({
    name: "flow.mmd",
    mimeType: "text/plain",
    buffer: Buffer.from("flowchart TD\n  A[Start] --> B[Finish]"),
  });
  await importDialog.locator('[data-testid="ie-import-confirm"]').click();
  await expect(page.locator(".maru-diagram-node")).toHaveCount(2);

  await page.getByRole("tab", { name: "화살표" }).click();
  await expect(page.getByRole("button", { name: "자동" })).toBeVisible();
  await page.getByRole("tab", { name: "테이블" }).click();
  await expect(page.getByText("표 노드를 선택하세요.")).toBeVisible();

  await page.getByRole("tab", { name: "파일" }).click();
  await page.getByRole("button", { name: "내보내기" }).click();
  await expect(page.locator(".dialog-content", { hasText: "내보내기" })).toContainText("Mermaid (.mmd)");
  expect(forbidden).toEqual([]);
});

test("opens the generation dialog from the File ribbon in new-diagram mode", async ({ page }) => {
  const forbidden = watchForbiddenRequests(page);
  await page.goto("/");
  await page.getByRole("button", { name: "다이어그램", exact: true }).click();

  await page.getByRole("tab", { name: "파일" }).click();
  await page.getByRole("button", { name: "다이어그램 생성" }).click();

  const dialog = page.locator(".dialog-content", { hasText: "다이어그램 생성" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("gen-type-select")).toBeVisible();
  await expect(dialog.getByTestId("gen-requirements")).toBeVisible();
  await expect(dialog.getByTestId("gen-scope")).toHaveText("새 다이어그램 생성");
  expect(forbidden).toEqual([]);
});

test("imports pasted Mermaid and reports unsupported constructs as diagnostics", async ({
  page,
}) => {
  const forbidden = watchForbiddenRequests(page);
  await page.goto("/");
  await page.getByRole("button", { name: "다이어그램", exact: true }).click();

  await page.getByRole("tab", { name: "파일" }).click();
  await page.getByRole("button", { name: "다이어그램 생성" }).click();
  const dialog = page.locator(".dialog-content", { hasText: "다이어그램 생성" });

  await dialog
    .getByTestId("gen-mermaid")
    .fill("flowchart LR\n subgraph one\n A[In] --> B[Out]\n end");
  await dialog.getByTestId("gen-from-mermaid").click();

  await expect(dialog.getByTestId("gen-mermaid-preview")).toContainText(
    "Mermaid 변환 결과: 노드 2개, 연결 1개",
  );
  const diagnostics = dialog.getByTestId("gen-mermaid-diagnostics");
  await expect(diagnostics).toContainText(
    "지원하지 않는 Mermaid 문법을 건너뛰었습니다: subgraph",
  );
  await expect(diagnostics).toContainText(
    "방향 LR은 지원하지 않아 위에서 아래 방향으로 배치합니다.",
  );

  await dialog.getByTestId("gen-mermaid-apply").click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".maru-diagram-node")).toHaveCount(2);
  expect(forbidden).toEqual([]);
});

test("surfaces an honest failure state when the agent host is unavailable", async ({ page }) => {
  const forbidden = watchForbiddenRequests(page);
  await page.goto("/");
  await page.getByRole("button", { name: "다이어그램", exact: true }).click();

  await page.getByRole("tab", { name: "파일" }).click();
  await page.getByRole("button", { name: "다이어그램 생성" }).click();
  const dialog = page.locator(".dialog-content", { hasText: "다이어그램 생성" });

  // Empty requirements keep Run disabled; with requirements the browser shell
  // (no Tauri) must degrade to the typed failure state, not crash.
  await expect(dialog.getByTestId("gen-run")).toBeDisabled();
  await dialog.getByTestId("gen-requirements").fill("배포 파이프라인 아키텍처를 그려 주세요.");
  await dialog.getByTestId("gen-run").click();

  const failed = dialog.getByTestId("gen-failed");
  await expect(failed).toBeVisible();
  await expect(failed).toContainText("생성에 실패했습니다");
  await expect(dialog).toBeVisible();
  expect(forbidden).toEqual([]);
});


for (const { name, output } of [
  { name: "plain HTML", output: "probe.html" },
  { name: "Unicode subdirectory", output: "docs/한글/diagram.html" },
  { name: "UTF-8 component boundary", output: `${"가".repeat(85)}/diagram.html` },
]) {
  test(`imports a pinned Archify spec in the browser with ${name}`, async ({ page }) => {
    await page.goto("/");
    expect(await page.evaluate(() => typeof (globalThis as { Buffer?: unknown }).Buffer)).toBe("undefined");
    await page.getByRole("button", { name: "다이어그램", exact: true }).click();
    await page.getByRole("tab", { name: "파일" }).click();
    await page.getByRole("button", { name: "가져오기" }).click();
    const dialog = page.locator(".dialog-content", { hasText: "가져오기" });
    await dialog.getByTestId("ie-file-input").setInputFiles({
      name: "browser.architecture.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify({
        schema_version: 1, diagram_type: "architecture",
        meta: { title: "브라우저 구조", output },
        components: [{ id: "app", type: "backend", label: "한글 서버" }],
      })),
    });
    await expect(dialog.getByTestId("ie-preview")).toContainText("데이터셋 1개");
    await expect(dialog.getByTestId("ie-import-confirm")).toBeEnabled();
    await dialog.getByTestId("ie-import-confirm").click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("textbox", { name: "제목 없음" })).toHaveValue("브라우저 구조");
    expect(await page.evaluate(() => typeof (globalThis as { Buffer?: unknown }).Buffer)).toBe("undefined");
  });
}

test("rejects a Unicode output segment exceeding the pinned UTF-8 budget in the browser", async ({ page }) => {
  await page.goto("/");
  expect(await page.evaluate(() => typeof (globalThis as { Buffer?: unknown }).Buffer)).toBe("undefined");
  await page.getByRole("button", { name: "다이어그램", exact: true }).click();
  await page.getByRole("tab", { name: "파일" }).click();
  await page.getByRole("button", { name: "가져오기" }).click();
  const dialog = page.locator(".dialog-content", { hasText: "가져오기" });
  await dialog.getByTestId("ie-file-input").setInputFiles({
    name: "overlong.architecture.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({
      schema_version: 1, diagram_type: "architecture",
      meta: { title: "거부할 구조", output: `${"가".repeat(86)}/diagram.html` },
      components: [{ id: "app", type: "backend", label: "서버" }],
    })),
  });
  await expect(dialog.getByTestId("ie-import-confirm")).toBeDisabled();
  await expect(dialog.getByTestId("ie-preview")).toHaveCount(0);
  await expect(dialog).toContainText("diagram.validation.specMeta");
});
