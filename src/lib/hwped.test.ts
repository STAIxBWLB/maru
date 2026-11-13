// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { createHwpedEngine } from "./hwped";

const document = { name: "report.hwpx", data: new Uint8Array([1, 2, 3]) };
const ops = [{ kind: "replace" as const, find: "가", replace: "나" }];

function answerCapabilities(capabilities: Record<string, unknown>): void {
  invokeMock.mockImplementation((command: string) => {
    if (command === "hwped_capabilities") return Promise.resolve(capabilities);
    if (command === "hwped_edit") {
      return Promise.resolve({ name: "report.hwpx", dataBase64: "" });
    }
    throw new Error(`unexpected command ${command}`);
  });
}

function editPayload(): Record<string, unknown> {
  const call = invokeMock.mock.calls.find(([command]) => command === "hwped_edit");
  if (call === undefined) throw new Error("hwped_edit was never called");
  return call[1] as Record<string, unknown>;
}

describe("createHwpedEngine", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("sends the edit-ops-v1 JSON array when the host advertises editOps v1", async () => {
    answerCapabilities({ version: "1.6.2", editable: true, formats: [], editOps: "v1" });

    await createHwpedEngine({ workspaceRoot: "/workspace" }).edit(document, ops);

    expect(invokeMock.mock.calls[0][0]).toBe("hwped_capabilities");
    const payload = editPayload();
    // The JSON channel carries the edit-ops-v1 wire spelling, which is not the
    // TypeScript op shape: `kind/find/replace` goes out as `op/from/to`.
    expect(payload.ops).toEqual([{ op: "replace", from: "가", to: "나" }]);
    expect(payload.opsArgv).toBeUndefined();
    expect(payload.workspaceRoot).toBe("/workspace");
  });

  it("falls back to opsArgv on a host that does not advertise it", async () => {
    answerCapabilities({ version: "1.2.0", editable: true, formats: [] });

    await createHwpedEngine({ workspaceRoot: "/workspace" }).edit(document, ops);

    const payload = editPayload();
    expect(payload.ops).toBeUndefined();
    expect(payload.opsArgv).toContain("가=>나");
  });

  it("crosses the document as a workspace-relative path when pathOf answers", async () => {
    answerCapabilities({ version: "1.6.2", editable: true, formats: [], editOps: "v1" });

    const engine = createHwpedEngine({
      workspaceRoot: "/workspace",
      pathOf: (candidate) =>
        candidate.name === "report.hwpx" ? "docs/report.hwpx" : undefined,
    });
    await engine.edit(document, ops);

    expect(editPayload().document).toEqual({
      name: "report.hwpx",
      path: "docs/report.hwpx",
    });
  });

  it("falls back to base64 bytes when pathOf declines the document", async () => {
    answerCapabilities({ version: "1.6.2", editable: true, formats: [], editOps: "v1" });

    const engine = createHwpedEngine({
      workspaceRoot: "/workspace",
      pathOf: () => undefined,
    });
    await engine.edit(document, ops);

    const ref = editPayload().document as Record<string, unknown>;
    expect(ref.name).toBe("report.hwpx");
    expect(ref.path).toBeUndefined();
    expect(ref.dataBase64).toBe("AQID");
  });
});

function answerRender(pages: Array<Record<string, unknown>>): void {
  invokeMock.mockImplementation((command: string) => {
    if (command === "hwped_render") return Promise.resolve({ pages });
    throw new Error(`unexpected command ${command}`);
  });
}

function svgPage(svg: string, page = 1): Record<string, unknown> {
  return {
    page,
    width: 595,
    height: 842,
    dpi: 96,
    format: "svg",
    dataBase64: Buffer.from(svg, "utf8").toString("base64"),
  };
}

async function renderFirstPageSvg(): Promise<string> {
  const pages = await createHwpedEngine({ workspaceRoot: "/workspace" }).render(document, {
    format: "svg",
  });
  const first = pages[0];
  if (first === undefined) throw new Error("render returned no pages");
  return new TextDecoder().decode(first.data);
}

// The package paints each SVG page with dangerouslySetInnerHTML behind its own
// blocklist sanitizer, so a hostile page must be neutral here, before the
// package holds the bytes. Each construct is one its blocklist misses.
describe("createHwpedEngine render sanitization", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("removes the SVG constructs the package's blocklist misses", async () => {
    answerRender([
      svgPage(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">` +
          `<set attributeName="href" to="javascript:alert(1)"/>` +
          `<animate attributeName="href" to="javascript:alert(2)"/>` +
          `<a href="java&#9;script:alert(3)"><text>link</text></a>` +
          `<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">` +
          `<img src="x" onerror="alert(4)"/></div></foreignObject>` +
          `<use href="https://example.invalid/sprite.svg#a"/>` +
          `<image href="data:text/html;base64,PHNjcmlwdD5hbGVydCg1KTwvc2NyaXB0Pg=="/>` +
          `<text onload="alert(6)">body</text>` +
          `<rect style="fill:url(javascript:alert(7))"/>` +
          `</svg>`,
      ),
    ]);

    const svg = await renderFirstPageSvg();

    for (const hostile of [
      "javascript:",
      "<set",
      "<animate",
      "<a ",
      "foreignObject",
      "http://www.w3.org/1999/xhtml",
      "onload",
      "onerror",
      "example.invalid",
      "data:text/html",
      "style=",
    ]) {
      expect(svg).not.toContain(hostile);
    }
    // The page survives as SVG: the body text is still there.
    expect(svg).toContain("<text");
    expect(svg).toContain("body");
  });

  it("keeps local paint references and raster data urls", async () => {
    answerRender([
      svgPage(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">` +
          `<defs><clipPath id="c1"><rect width="1" height="1"/></clipPath></defs>` +
          `<path d="M0 0L2 2" fill="url(#c1)" clip-path="url(#c1)"/>` +
          `<image href="data:image/png;base64,iVBORw0KGgo="/>` +
          `<path d="M0 0L2 2" fill="url(https://example.invalid/f)"/>` +
          `</svg>`,
      ),
    ]);

    const svg = await renderFirstPageSvg();

    expect(svg).toContain('fill="url(#c1)"');
    expect(svg).toContain('clip-path="url(#c1)"');
    expect(svg).toContain("data:image/png;base64");
    expect(svg).not.toContain("example.invalid");
  });

  it("answers a blank SVG page when the bytes are not SVG at all", async () => {
    answerRender([
      {
        page: 1,
        width: 595,
        height: 842,
        dpi: 96,
        format: "svg",
        dataBase64: Buffer.from("<html><body>not a page</body></html>", "utf8").toString(
          "base64",
        ),
      },
    ]);

    const svg = await renderFirstPageSvg();

    expect(svg).toBe('<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(svg).not.toContain("not a page");
  });

  it("passes raster pages through untouched", async () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]).toString("base64");
    answerRender([{ page: 1, width: 595, height: 842, dpi: 96, format: "png", dataBase64: png }]);

    const pages = await createHwpedEngine({ workspaceRoot: "/workspace" }).render(document, {
      format: "png",
    });

    expect(pages[0]?.format).toBe("png");
    expect([...(pages[0]?.data ?? [])]).toEqual([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  });
});
