import { expect, test } from "@playwright/test";

// #441: deleting a document shows the reviewed file list before anything moves.
test("deletes a document after reviewing the linked file list", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");

  const documentList = page.locator(".document-list");
  const row = documentList.getByRole("button", { name: /Maru 사업 주간 점검 회의/ }).first();
  await row.click({ button: "right" });
  await page.locator(".context-menu").getByRole("menuitem", { name: "휴지통으로 이동" }).click();

  const dialog = page.getByRole("dialog", { name: "문서 삭제" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("파일 1개 삭제")).toBeVisible();
  await expect(dialog.getByText("manifest.yaml source")).toHaveCount(0);

  const derived = dialog.getByRole("switch", { name: "파생 파일도 삭제 (2)" });
  await derived.click();
  await expect(derived).toBeChecked();
  const derivedList = dialog.getByRole("list", { name: "파생 파일도 삭제 (2)" });
  await expect(derivedList.getByRole("checkbox")).toHaveCount(2);
  await derivedList.getByRole("checkbox").first().uncheck();
  await expect(dialog.getByRole("button", { name: "파일 2개 삭제" })).toBeVisible();

  await dialog.getByRole("switch", { name: "메타데이터도 삭제 (1)" }).click();
  await expect(dialog.getByText("Binder documentPath")).toBeVisible();
  await expect(dialog.getByText(/유지, 이 문서와 연결되지 않음/)).toBeVisible();

  await dialog.getByRole("button", { name: "파일 3개 삭제" }).click();
  await expect(dialog).toBeHidden();
  await expect(
    documentList.getByRole("button", { name: /Maru 사업 주간 점검 회의/ }),
  ).toHaveCount(0);
});

test("cancelling the review deletes nothing", async ({ page }) => {
  await page.goto("/");
  const documentList = page.locator(".document-list");
  const row = documentList.getByRole("button", { name: /Maru 사업 주간 점검 회의/ }).first();
  await row.click({ button: "right" });
  await page.locator(".context-menu").getByRole("menuitem", { name: "휴지통으로 이동" }).click();
  const dialog = page.getByRole("dialog", { name: "문서 삭제" });
  await dialog.getByRole("button", { name: "취소" }).click();
  await expect(dialog).toBeHidden();
  await expect(row).toBeVisible();
});
