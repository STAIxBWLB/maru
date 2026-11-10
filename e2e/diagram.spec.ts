import { expect, test, type Page } from "@playwright/test";

import { SEMANTIC_FIXTURES } from "../src/lib/diagram/__fixtures__/semantic";
import type { SemanticDiagramType } from "../src/lib/diagram/reportTypes";

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

// ---------------------------------------------------------------------------
// Semantic types and semantic editing (issue #433 P2)
// ---------------------------------------------------------------------------

async function importSemanticSpec(page: Page, type: SemanticDiagramType) {
  await page.goto("/");
  await page.getByRole("button", { name: "다이어그램", exact: true }).click();
  await page.getByRole("tab", { name: "파일" }).click();
  await page.getByRole("button", { name: "가져오기" }).click();
  const dialog = page.locator(".dialog-content", { hasText: "가져오기" });
  await dialog.getByTestId("ie-file-input").setInputFiles({
    name: `fixture.${type}.json`,
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(SEMANTIC_FIXTURES[type])),
  });
  await expect(dialog.getByTestId("ie-import-confirm")).toBeEnabled();
  await dialog.getByTestId("ie-import-confirm").click();
  await expect(dialog).toBeHidden();
}

async function runBrowserSdkEdit(
  page: Page,
  type: "architecture" | "lifecycle",
  spec: Record<string, unknown>,
  field: string,
  index: number,
  key: string,
  value: unknown,
) {
  return page.evaluate(async (input) => {
    const load = (specifier: string) => import(specifier);
    const [codec, semantic, state, types, edit, apply, actions, engine] = await Promise.all([
      load("/src/lib/diagram/archifyCodec.ts"),
      load("/src/lib/diagram/semantic.ts"),
      load("/src/lib/diagram/state.ts"),
      load("/src/lib/diagram/types.ts"),
      load("/src/lib/diagram/semanticEdit.ts"),
      load("/src/lib/diagram/semanticApply.ts"),
      load("/src/lib/diagram/actions.ts"),
      load("/src/lib/diagram/engine.ts"),
    ]);
    const { dataset } = codec.archifySpecToDataset(input.type, input.spec, { id: `ds-${input.type}` });
    const doc = semantic.projectSemanticDocument(dataset).doc;
    const store = state.createDiagramStore({ doc, ephemeral: types.createInitialEphemeral() });
    const before = store.getState();
    let engineCalls = 0;
    const result = await apply.applyValidatedSemanticEdit(
      store,
      dataset.id,
      edit.setSpecField(input.field, input.index, input.key, input.value),
      {
        validateCandidate: async (family: string, candidate: unknown) => {
          engineCalls += 1;
          return engine.validateEngineCandidate(family, candidate);
        },
      },
    );
    const refusedState = store.getState();
    store.setState(actions.undo());
    const afterUndo = store.getState();
    return {
      result,
      engineCalls,
      refusedDocUnchanged: refusedState.doc === before.doc,
      historyPastAfterRefusal: refusedState.ephemeral.history.past.length,
      undoDocUnchanged: afterUndo.doc === before.doc,
    };
  }, { type, spec, field, index, key, value });
}

async function selectEdge(page: Page, edgeId: string) {
  // A bracket's bounding-box centre is empty canvas, so dispatch on the edge.
  await page.locator(`[data-edge-id="${edgeId}"]`).dispatchEvent("pointerdown", { button: 0 });
}

const propertiesPanel = (page: Page) => page.getByRole("complementary", { name: "속성" });

test("generated WebAssembly rejects malformed components and lifecycle col 9 without applying or recording history", async ({ page }) => {
  await page.goto("/");
  const malformed = structuredClone(SEMANTIC_FIXTURES.architecture);
  (malformed.components as Array<Record<string, unknown>>)[0]!.type = "invalid-component";
  const e1Report = await page.evaluate(async (spec) => {
    const load = (specifier: string) => import(specifier);
    const { loadWasmEngine } = await load("/src/lib/diagram/engine.ts");
    return (await loadWasmEngine()).validate(JSON.stringify(spec));
  }, malformed);
  expect(e1Report.ok).toBe(false);
  expect(e1Report.diagnostics.some((diagnostic: { path: string }) => diagnostic.path === "/components/0/type")).toBe(true);

  const componentRefusal = await runBrowserSdkEdit(
    page, "architecture", SEMANTIC_FIXTURES.architecture, "components", 0, "type", "invalid-component",
  );
  expect(componentRefusal.engineCalls).toBe(1);
  expect(componentRefusal.result.status).toBe("invalid");
  expect(JSON.stringify(componentRefusal.result.diagnostics)).toContain("/components/0/type");
  expect(componentRefusal.refusedDocUnchanged).toBe(true);
  expect(componentRefusal.historyPastAfterRefusal).toBe(0);
  expect(componentRefusal.undoDocUnchanged).toBe(true);

  const columnRefusal = await runBrowserSdkEdit(
    page, "lifecycle", SEMANTIC_FIXTURES.lifecycle, "states", 0, "col", 9,
  );
  expect(columnRefusal.engineCalls).toBe(1);
  expect(columnRefusal.result.status).toBe("invalid");
  expect(JSON.stringify(columnRefusal.result.diagnostics)).toContain("/states/0/col");
  expect(columnRefusal.refusedDocUnchanged).toBe(true);
  expect(columnRefusal.historyPastAfterRefusal).toBe(0);
  expect(columnRefusal.undoDocUnchanged).toBe(true);
});

test("reorders an imported sequence message, undoes it, and persists the order", async ({ page }) => {
  const forbidden = watchForbiddenRequests(page);
  await importSemanticSpec(page, "sequence");
  await expect(page.locator(".maru-diagram-node")).toHaveCount(3);
  await expect(page.locator(".maru-diagram-edge")).toHaveCount(4);

  await selectEdge(page, "msg3");
  const order = page.getByTestId("semantic-order");
  await expect(order).toHaveText("3/4");
  await page.getByTestId("semantic-move-earlier").click();
  await expect(order).toHaveText("2/4");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(order).toHaveText("3/4");

  await page.getByTestId("semantic-move-earlier").click();
  await expect(order).toHaveText("2/4");
  await page.getByRole("tab", { name: "파일" }).click();
  await page.getByRole("button", { name: "저장" }).click();
  const saveDialog = page.locator(".dialog-content", { hasText: "다이어그램 저장" });
  await saveDialog.getByLabel("파일 이름").fill("e2e-sequence");
  await saveDialog.getByRole("button", { name: "저장" }).click();
  await expect(page.locator(".maru-diagram-status", { hasText: "저장됨" })).toBeVisible();

  await page.reload();
  await page.getByRole("button", { name: "다이어그램", exact: true }).click();
  await expect(page.locator(".maru-diagram-edge")).toHaveCount(4);
  await selectEdge(page, "msg3");
  await expect(page.getByTestId("semantic-order")).toHaveText("2/4");
  expect(forbidden).toEqual([]);
});

test("edits an imported lifecycle state type and label from the property panel", async ({ page }) => {
  const forbidden = watchForbiddenRequests(page);
  await importSemanticSpec(page, "lifecycle");
  // One lane container plus three states.
  await expect(page.locator(".maru-diagram-node")).toHaveCount(4);
  await expect(page.locator('.maru-diagram-node[data-node-id$=":lane:main"]')).toHaveCount(1);

  await page.locator('.maru-diagram-node[data-node-id="running"]').click();
  await expect(page.getByTestId("semantic-props")).toBeVisible();
  await page.getByTestId("semantic-state-type").selectOption("decision");
  await expect(page.locator('.maru-diagram-node[data-node-id="running"] path').first()).toHaveAttribute(
    "d",
    /^M 80 0 L 160 32/,
  );

  await propertiesPanel(page).getByLabel("제목", { exact: true }).fill("실행 중");
  await expect(page.getByTestId("semantic-label")).toHaveText("실행 중");
  expect(forbidden).toEqual([]);
});

test("detaches an imported dataflow after listing the losses, and undo restores it", async ({ page }) => {
  const forbidden = watchForbiddenRequests(page);
  await importSemanticSpec(page, "dataflow");
  await page.locator('.maru-diagram-node[data-node-id="app"]').click();
  await expect(page.getByTestId("semantic-props")).toBeVisible();

  let message = "";
  page.once("dialog", (dialog) => {
    message = dialog.message();
    void dialog.accept();
  });
  await page.getByTestId("semantic-detach").click();
  await expect(page.getByTestId("semantic-props")).toHaveCount(0);
  expect(message).toContain("단계 2개");
  expect(message).toContain("데이터 분류 1개");
  await expect(page.locator(".maru-diagram-node")).toHaveCount(4);

  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByTestId("semantic-props")).toBeVisible();
  expect(forbidden).toEqual([]);
});

test("asks before deleting a semantic member and keeps everything on cancel", async ({ page }) => {
  const forbidden = watchForbiddenRequests(page);
  await importSemanticSpec(page, "lifecycle");
  await page.locator('.maru-diagram-node[data-node-id="queued"]').click();

  let message = "";
  page.once("dialog", (dialog) => {
    message = dialog.message();
    void dialog.dismiss();
  });
  await page.keyboard.press("Delete");
  await expect.poll(() => message).toContain("다음 항목과 종속 연결·멤버십을 삭제할까요?");
  await expect(page.locator(".maru-diagram-node")).toHaveCount(4);
  await expect(page.getByTestId("semantic-props")).toBeVisible();
  expect(forbidden).toEqual([]);
});

test("lists six diagram types and routes pasted Mermaid sequences to generation", async ({ page }) => {
  const forbidden = watchForbiddenRequests(page);
  await page.goto("/");
  await page.getByRole("button", { name: "다이어그램", exact: true }).click();
  await page.getByRole("tab", { name: "파일" }).click();
  await page.getByRole("button", { name: "다이어그램 생성" }).click();
  const dialog = page.locator(".dialog-content", { hasText: "다이어그램 생성" });

  await expect(dialog.getByTestId("gen-type-select").locator("option")).toHaveCount(6);
  await dialog.getByTestId("gen-mermaid").fill("sequenceDiagram\n  participant Alice\n  Alice->>Bob: hi");
  await expect(dialog.getByTestId("gen-type-select")).toHaveValue("sequence");

  await dialog.getByTestId("gen-from-mermaid").click();
  await expect(dialog.getByTestId("gen-mermaid-preview")).toContainText("Mermaid 변환 결과: 노드 0개, 연결 0개");
  const diagnostics = dialog.getByTestId("gen-mermaid-diagnostics");
  await expect(diagnostics).toContainText("아무것도 가져오지 않았습니다");
  await expect(diagnostics).toContainText("다이어그램 생성에서 sequence 유형으로 변환하세요");
  await expect(dialog.getByTestId("gen-mermaid-apply")).toBeDisabled();
  expect(forbidden).toEqual([]);
});


test("adds and removes a semantic state with one-step undo and a cascade preview", async ({ page }) => {
  const forbidden = watchForbiddenRequests(page);
  await importSemanticSpec(page, "lifecycle");
  await page.locator('.maru-diagram-node[data-node-id="running"]').click();
  await page.getByTestId("semantic-add-label").fill("Retry");
  await page.getByTestId("semantic-add-type").selectOption("waiting");
  await page.getByTestId("semantic-add-col").fill("3");
  await page.getByTestId("semantic-add-confirm").click();
  await expect(page.locator(".maru-diagram-node")).toHaveCount(5);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator(".maru-diagram-node")).toHaveCount(4);
  await page.locator('.maru-diagram-node[data-node-id="running"]').click();
  let preview = "";
  page.once("dialog", (dialog) => { preview = dialog.message(); void dialog.accept(); });
  await page.getByTestId("semantic-remove").click();
  await expect(page.locator(".maru-diagram-node")).toHaveCount(3);
  expect(preview).toContain("Running");
  expect(preview).toContain("상태 전이");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator(".maru-diagram-node")).toHaveCount(4);
  await page.locator('.maru-diagram-node[data-node-id="running"]').click();
  await expect(page.getByTestId("semantic-props")).toBeVisible();
  expect(forbidden).toEqual([]);
});

test("Renders in the browser requires the desktop app and invents no entries", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "다이어그램", exact: true }).click();
  await page.getByRole("tab", { name: "파일", exact: true }).click();
  await page.getByRole("button", { name: "렌더", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("저장된 렌더는 데스크톱 앱에서 사용할 수 있습니다");
  await expect(dialog.getByTestId("diagram-render-entry")).toHaveCount(0);
  await expect(dialog.locator("iframe")).toHaveCount(0);
});

test("Renders lists orphaned receipts and shows the native refusal without mounting a frame", async ({ page }) => {
  // Test-only module replacement exercises the native API contract in Chromium;
  // Rust/native probes verify disk hashes, grants and the sandbox itself.
  await page.route("**/src/lib/diagram/renders.ts*", (route) => route.fulfill({
    contentType: "application/javascript",
    body: `let removed = false;
      export const rendersAvailable = () => true;
      export const listRenders = async () => removed ? [] : [{docId:"copied",documentName:null,orphaned:true,renders:[{docId:"copied",renderId:"bad",verified:false,diagnostic:"receipt.json missing; re-render"}]}];
      export const prepareRenderView = async () => { throw new Error("index.html hash mismatch; re-render the diagram"); };
      export const deleteRender = async () => { removed = true; };
      export const openRender = async () => { throw new Error("refused"); };
      export const rerenderDocument = async () => { throw new Error("source missing; restore it"); };`,
  }));
  await page.goto("/");
  await page.getByRole("button", { name: "다이어그램", exact: true }).click();
  await page.getByRole("tab", { name: "파일", exact: true }).click();
  await page.getByRole("button", { name: "렌더", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("원본 문서 없음");
  await dialog.getByTestId("diagram-render-entry").click();
  await expect(dialog).toContainText("index.html hash mismatch; re-render the diagram");
  await expect(dialog.locator("iframe")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "다시 렌더", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "렌더 삭제", exact: true }).click();
  await dialog.getByRole("button", { name: "삭제 확인", exact: true }).click();
  await expect(dialog.getByTestId("diagram-render-entry")).toHaveCount(0);
});

test("imports a floorplan map, edits a node kind, undoes, saves and reloads (issue #535)", async ({ page }) => {
  const forbidden = watchForbiddenRequests(page);
  await importSemanticSpec(page, "floorplan");
  // 21 nodes: parents as nested sections, leaves as members.
  await expect(page.locator(".maru-diagram-node")).toHaveCount(21);
  await expect(page.locator(".maru-diagram-edge")).toHaveCount(6);

  const cli = page.locator('.maru-diagram-node[data-node-id="ahub.cli"]');
  await cli.click();
  await expect(page.getByTestId("semantic-props")).toBeVisible();
  const kind = page.getByTestId("semantic-floorplan-kind");
  await expect(kind).toHaveValue("ui");
  await kind.selectOption("script");
  await expect(kind).toHaveValue("script");
  await page.keyboard.press("ControlOrMeta+z");
  await cli.click();
  await expect(page.getByTestId("semantic-floorplan-kind")).toHaveValue("ui");

  await page.getByTestId("semantic-floorplan-kind").selectOption("worker");
  await expect(page.getByTestId("semantic-floorplan-kind")).toHaveValue("worker");
  await page.getByRole("tab", { name: "파일" }).click();
  await page.getByRole("button", { name: "저장" }).click();
  const saveDialog = page.locator(".dialog-content", { hasText: "다이어그램 저장" });
  await saveDialog.getByLabel("파일 이름").fill("e2e-floorplan");
  await saveDialog.getByRole("button", { name: "저장" }).click();
  await expect(page.locator(".maru-diagram-status", { hasText: "저장됨" })).toBeVisible();

  await page.reload();
  await page.getByRole("button", { name: "다이어그램", exact: true }).click();
  await expect(page.locator(".maru-diagram-node")).toHaveCount(21);
  await page.locator('.maru-diagram-node[data-node-id="ahub.cli"]').click();
  await expect(page.getByTestId("semantic-floorplan-kind")).toHaveValue("worker");
  expect(forbidden).toEqual([]);
});
