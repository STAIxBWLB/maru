import { expect, test } from "@playwright/test";

test("uses the canonical Maru seal in app chrome and browser metadata", async ({
  page,
  request,
}) => {
  await page.goto("/");

  const seal = page.getByTestId("topbar-brand-seal");
  await expect(seal).toBeVisible();
  await expect(seal).toHaveAttribute("src", /^data:image\/svg\+xml,/);
  await expect(seal).toHaveAttribute("alt", "");
  await expect(seal).toHaveAttribute("aria-hidden", "true");

  const sealBox = await seal.boundingBox();
  expect(sealBox).not.toBeNull();
  expect(sealBox?.width).toBe(22);
  expect(sealBox?.height).toBe(22);
  expect(await seal.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);

  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#B23A26");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/site.webmanifest");
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
    "href",
    "/apple-touch-icon.png",
  );
  await expect(page.locator('link[rel="mask-icon"]')).toHaveAttribute("color", "#B23A26");

  for (const asset of [
    "/favicon.svg",
    "/favicon.ico",
    "/icons/favicon-16x16.png",
    "/icons/favicon-32x32.png",
    "/apple-touch-icon.png",
  ]) {
    const response = await request.get(asset);
    expect(response.ok(), `${asset} should be served`).toBe(true);
  }

  const manifestResponse = await request.get("/site.webmanifest");
  expect(manifestResponse.ok()).toBe(true);
  const manifest = (await manifestResponse.json()) as {
    theme_color: string;
    icons: Array<{ sizes: string; purpose: string }>;
  };
  expect(manifest.theme_color).toBe("#B23A26");
  expect(manifest.icons).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ sizes: "192x192", purpose: "any" }),
      expect.objectContaining({ sizes: "512x512", purpose: "any" }),
      expect.objectContaining({ sizes: "192x192", purpose: "maskable" }),
      expect.objectContaining({ sizes: "512x512", purpose: "maskable" }),
    ]),
  );
});
