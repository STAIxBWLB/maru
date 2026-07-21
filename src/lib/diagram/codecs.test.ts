// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import {
  CODEC_LIST,
  type CodecSerializeOutcome,
  type DiagramCodec,
  IMPORT_ACCEPT,
  codecForClipboard,
  codecForFilename,
  expandMatrixToGrid,
  getCodec,
  htmlTableToMatrix,
  matrixExceedsLimits,
  matrixFromTextGrid,
  parseCsv,
  parseMarkdownTable,
  serializeGridToCsv,
  serializeMatrixToHtml,
  serializeMatrixToMarkdown,
  sliceMatrix,
} from "./codecs";
import { deserializeDoc, serializeDoc } from "./persistence";
import {
  MATRIX_MAX_COLS,
  MATRIX_MAX_ROWS,
  matrixFromRowsCols,
  validateMatrix,
  type MatrixCell,
  type MatrixDataset,
} from "./reportTypes";
import { createEmptyDoc, type DiagramDoc } from "./types";

function syncSerialize(
  codec: DiagramCodec,
  input: { doc: DiagramDoc; datasetId?: string },
): CodecSerializeOutcome {
  const out = codec.serialize!(input);
  if (out instanceof Promise) throw new Error("expected sync serialize");
  return out;
}

function filledMatrix(rows: string[][]): MatrixDataset {
  const matrix = matrixFromRowsCols(rows.length, Math.max(...rows.map((r) => r.length)));
  const rowIndex = new Map(matrix.rows.map((row, i) => [row.id, i]));
  const colIndex = new Map(matrix.columns.map((col, i) => [col.id, i]));
  const cells: Record<string, MatrixCell> = {};
  for (const cell of Object.values(matrix.cells)) {
    const r = rowIndex.get(cell.rowId) ?? 0;
    const c = colIndex.get(cell.colId) ?? 0;
    cells[cell.id] = { ...cell, text: rows[r]?.[c] ?? "" };
  }
  const first = matrix.rows[0];
  if (first) first.role = "header";
  return { ...matrix, cells };
}

function docWithMatrix(matrix: MatrixDataset): DiagramDoc {
  return { ...createEmptyDoc("doc-1", 1), datasets: [matrix] };
}

describe("registry", () => {
  it("lists all codecs with unique ids", () => {
    const ids = CODEC_LIST.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [
      "maru-json",
      "maru-svg",
      "svg-image",
      "png",
      "png-transparent",
      "jpg",
      "pdf",
      "csv",
      "tsv",
      "markdown-table",
      "html-table",
      "mermaid",
    ]) {
      expect(getCodec(id), id).toBeDefined();
    }
  });

  it("maps filenames to import-capable codecs", () => {
    expect(codecForFilename("report.csv")?.id).toBe("csv");
    expect(codecForFilename("report.TSV")?.id).toBe("tsv");
    expect(codecForFilename("notes.md")?.id).toBe("markdown-table");
    expect(codecForFilename("sheet.html")?.id).toBe("html-table");
    expect(codecForFilename("doc.json")?.id).toBe("maru-json");
    expect(codecForFilename("doc.cmd.json")?.id).toBe("maru-json");
    expect(codecForFilename("flow.mmd")?.id).toBe("mermaid");
    expect(codecForFilename("image.svg")?.id).toBe("maru-svg");
    // Export-only formats never resolve for import.
    expect(codecForFilename("shot.png")).toBeUndefined();
    expect(codecForFilename("shot.jpeg")).toBeUndefined();
    expect(codecForFilename("doc.pdf")).toBeUndefined();
    expect(codecForFilename("noext")).toBeUndefined();
  });

  it("maps clipboard MIME types to codecs", () => {
    expect(codecForClipboard("text/html")?.id).toBe("html-table");
    expect(codecForClipboard("text/html; charset=utf-8")?.id).toBe("html-table");
    expect(codecForClipboard("text/csv")?.id).toBe("csv");
    expect(codecForClipboard("text/tab-separated-values")?.id).toBe("tsv");
    expect(codecForClipboard("text/markdown")?.id).toBe("markdown-table");
    expect(codecForClipboard("image/svg+xml")?.id).toBe("maru-svg");
    expect(codecForClipboard("application/json")?.id).toBe("maru-json");
    expect(codecForClipboard("text/plain")?.id).toBe("tsv");
    expect(codecForClipboard("image/png")).toBeUndefined();
  });

  it("IMPORT_ACCEPT covers every importable extension", () => {
    for (const ext of [".csv", ".tsv", ".md", ".html", ".json", ".cmd.json", ".mmd", ".svg"]) {
      expect(IMPORT_ACCEPT).toContain(ext);
    }
    expect(IMPORT_ACCEPT).not.toContain(".png");
  });
});

describe("csv codec", () => {
  it("parses quoted fields with embedded commas, quotes, and newlines", () => {
    const rows = parseCsv('a,"b,c","d""e"\r\n"line1\nline2",x,y\n');
    expect(rows).toEqual([
      ["a", "b,c", 'd"e'],
      ["line1\nline2", "x", "y"],
    ]);
  });

  it("round-trips a matrix through serialize+parse", () => {
    const matrix = filledMatrix([
      ["Name", "Note"],
      ["a,b", 'say "hi"'],
      ["multi\nline", "plain"],
    ]);
    const csv = serializeGridToCsv(expandMatrixToGrid(matrix));
    expect(parseCsv(csv)).toEqual(expandMatrixToGrid(matrix));
  });

  it("declares structural fidelity with ignored fields on export", () => {
    const codec = getCodec("csv")!;
    const matrix = filledMatrix([["h1", "h2"], ["a", "b"]]);
    const out = syncSerialize(codec, { doc: docWithMatrix(matrix) });
    expect(out.fidelity).toBe("structural");
    expect(out.ignoredFields).toContain("styles");
    expect(out.ignoredFields).toContain("spans");
  });

  it("warns when merged cells are flattened on export", () => {
    const codec = getCodec("csv")!;
    const matrix = filledMatrix([
      ["h1", "h2"],
      ["a", "b"],
    ]);
    const anchor = Object.values(matrix.cells).find((c) => c.text === "a")!;
    matrix.cells[anchor.id] = { ...anchor, colSpan: 2 };
    delete matrix.cells[Object.values(matrix.cells).find((c) => c.text === "b")!.id];
    const out = syncSerialize(codec, { doc: docWithMatrix(matrix) });
    expect(out.warnings.map((w) => w.key)).toContain("diagram.codec.warn.spansFlattened");
  });

  it("imports the first row as a header row", () => {
    const codec = getCodec("csv")!;
    const outcome = codec.parse!("h1,h2\na,b\n", "data.csv");
    expect(outcome.result.kind).toBe("dataset");
    if (outcome.result.kind !== "dataset") return;
    const dataset = outcome.result.dataset as MatrixDataset;
    expect(dataset.rows[0]!.role).toBe("header");
    expect(dataset.rows[1]!.role).toBe("data");
    expect(dataset.name).toBe("data");
    expect(expandMatrixToGrid(dataset)).toEqual([
      ["h1", "h2"],
      ["a", "b"],
    ]);
  });
});

describe("tsv codec", () => {
  it("round-trips tabs and newlines via shared escaping", () => {
    const matrix = filledMatrix([
      ["h1", "h2"],
      ["a\tb", "c\nd"],
    ]);
    const codec = getCodec("tsv")!;
    const out = syncSerialize(codec, { doc: docWithMatrix(matrix) });
    const text = out.bytes as string;
    const parsed = codec.parse!(text, "x.tsv");
    if (parsed.result.kind !== "dataset") throw new Error("expected dataset");
    expect(expandMatrixToGrid(parsed.result.dataset as MatrixDataset)).toEqual(
      expandMatrixToGrid(matrix),
    );
  });
});

describe("markdown-table codec", () => {
  it("exports a GitHub table and warns about flattened multiline cells", () => {
    const matrix = filledMatrix([
      ["Name", "Note"],
      ["a", "line1\nline2"],
    ]);
    const { text, multilineFlattened } = serializeMatrixToMarkdown(matrix);
    expect(multilineFlattened).toBe(true);
    expect(text).toContain("| Name | Note |");
    expect(text).toContain("| --- | --- |");
    expect(text).toContain("line1<br>line2");
  });

  it("escapes pipes in cell text", () => {
    const matrix = filledMatrix([
      ["h"],
      ["a|b"],
    ]);
    const { text } = serializeMatrixToMarkdown(matrix);
    expect(text).toContain("a\\|b");
  });

  it("parses a markdown table back to a grid", () => {
    const grid = parseMarkdownTable(
      "| Name | Note |\n| --- | --- |\n| a | b |\n| c\\|d | e<br>f |\n",
    );
    expect(grid).toEqual([
      ["Name", "Note"],
      ["a", "b"],
      ["c|d", "e\nf"],
    ]);
  });

  it("rejects text without a table", () => {
    expect(() => parseMarkdownTable("no table here")).toThrow();
  });

  it("round-trips through the codec with header detection", () => {
    const codec = getCodec("markdown-table")!;
    const matrix = filledMatrix([
      ["h1", "h2"],
      ["a", "b"],
    ]);
    const out = syncSerialize(codec, { doc: docWithMatrix(matrix) });
    const parsed = codec.parse!(out.bytes as string, "t.md");
    if (parsed.result.kind !== "dataset") throw new Error("expected dataset");
    const dataset = parsed.result.dataset as MatrixDataset;
    expect(dataset.rows[0]!.role).toBe("header");
    expect(expandMatrixToGrid(dataset)).toEqual(expandMatrixToGrid(matrix));
  });
});

describe("html-table codec", () => {
  it("exports spans and inline styles", () => {
    const matrix = filledMatrix([
      ["h1", "h2"],
      ["a", "b"],
    ]);
    const anchor = Object.values(matrix.cells).find((c) => c.text === "a")!;
    matrix.cells[anchor.id] = {
      ...anchor,
      colSpan: 2,
      style: { align: "center", bold: true, bg: "#ff0000" },
    };
    delete matrix.cells[Object.values(matrix.cells).find((c) => c.text === "b")!.id];
    const html = serializeMatrixToHtml(matrix);
    expect(html).toContain('colspan="2"');
    expect(html).toContain("text-align:center");
    expect(html).toContain("font-weight:bold");
    expect(html).toContain("background-color:#ff0000");
    expect(html).toContain("<th");
  });

  it("imports rowspan/colspan honoring covered positions", () => {
    const matrix = htmlTableToMatrix(
      `<table>
        <tr><th>H1</th><th>H2</th><th>H3</th></tr>
        <tr><td rowspan="2">A</td><td colspan="2">B</td></tr>
        <tr><td>C</td><td>D</td></tr>
      </table>`,
    );
    expect(validateMatrix(matrix).ok).toBe(true);
    expect(matrix.rows[0]!.role).toBe("header");
    expect(expandMatrixToGrid(matrix)).toEqual([
      ["H1", "H2", "H3"],
      ["A", "B", ""],
      ["", "C", "D"],
    ]);
  });

  it("imports inline styles", () => {
    const matrix = htmlTableToMatrix(
      '<table><tr><td style="text-align:right;font-weight:bold;color:#123456">x</td></tr></table>',
    );
    const cell = Object.values(matrix.cells)[0]!;
    expect(cell.style?.align).toBe("right");
    expect(cell.style?.bold).toBe(true);
    expect(cell.style?.color).toBe("#123456");
  });

  it("round-trips through the codec", () => {
    const codec = getCodec("html-table")!;
    const matrix = htmlTableToMatrix(
      '<table><tr><th>A</th><th>B</th></tr><tr><td colspan="2">wide</td></tr></table>',
    );
    const out = syncSerialize(codec, { doc: docWithMatrix(matrix) });
    const parsed = codec.parse!(out.bytes as string, "t.html");
    if (parsed.result.kind !== "dataset") throw new Error("expected dataset");
    const back = parsed.result.dataset as MatrixDataset;
    expect(validateMatrix(back).ok).toBe(true);
    expect(expandMatrixToGrid(back)).toEqual(expandMatrixToGrid(matrix));
  });

  it("throws when no table is present", () => {
    expect(() => htmlTableToMatrix("<p>hello</p>")).toThrow();
  });

  it("clamps a hostile colspan instead of inflating the grid", () => {
    // Un-clamped, colspan="1000000" would allocate a million-column matrix
    // (and freeze expandMatrixToGrid) before the size gate ever runs.
    const matrix = htmlTableToMatrix(
      '<table><tr><td colspan="1000000">x</td></tr><tr><td>a</td><td>b</td></tr></table>',
    );
    expect(matrix.columns.length).toBeLessThanOrEqual(50);
  });
});

describe("maru-json codec", () => {
  it("round-trips a doc losslessly", () => {
    const codec = getCodec("maru-json")!;
    const matrix = filledMatrix([
      ["h"],
      ["a"],
    ]);
    const doc = docWithMatrix(matrix);
    doc.docTitle = "Round trip";
    const out = syncSerialize(codec, { doc });
    expect(out.fidelity).toBe("lossless");
    const parsed = codec.parse!(out.bytes as string, "doc.json");
    expect(parsed.fidelity).toBe("lossless");
    if (parsed.result.kind !== "doc") throw new Error("expected doc");
    expect(serializeDoc(parsed.result.doc)).toBe(serializeDoc(deserializeDoc(serializeDoc(doc))));
  });
});

describe("maru-svg codec", () => {
  it("embeds metadata and re-opens losslessly", () => {
    const codec = getCodec("maru-svg")!;
    const doc = createEmptyDoc("doc-svg", 1);
    doc.docTitle = "SVG doc";
    const out = syncSerialize(codec, { doc });
    const text = out.bytes as string;
    expect(text).toContain('<metadata id="maru-diagram">');
    const parsed = codec.parse!(text, "doc.svg");
    expect(parsed.fidelity).toBe("lossless");
    expect(parsed.warnings).toHaveLength(0);
    if (parsed.result.kind !== "doc") throw new Error("expected doc");
    expect(parsed.result.doc.docTitle).toBe("SVG doc");
    expect(parsed.result.doc.id).toBe("doc-svg");
  });

  it("imports arbitrary SVG as an image node with a visual warning", () => {
    const codec = getCodec("maru-svg")!;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
    const parsed = codec.parse!(svg, "icon.svg");
    expect(parsed.fidelity).toBe("visual");
    expect(parsed.warnings.map((w) => w.key)).toContain("diagram.codec.warn.svgImageOnly");
    if (parsed.result.kind !== "doc") throw new Error("expected doc");
    const node = parsed.result.doc.nodes[0]!;
    expect(node.kind).toBe("image");
    expect(String(node.meta?.src)).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(parsed.result.doc.docTitle).toBe("icon");
  });
});

describe("mermaid codec", () => {
  it("declares structural fidelity with warnings both ways", () => {
    const codec = getCodec("mermaid")!;
    const doc = createEmptyDoc("m", 1);
    const out = syncSerialize(codec, { doc });
    expect(out.fidelity).toBe("structural");
    expect(out.warnings.map((w) => w.key)).toContain("diagram.codec.warn.mermaidExport");
    expect(out.ignoredFields).toContain("positions");
    const parsed = codec.parse!("flowchart TD\n  A --> B\n", "f.mmd");
    expect(parsed.warnings.map((w) => w.key)).toContain("diagram.codec.warn.mermaidImport");
    if (parsed.result.kind !== "doc") throw new Error("expected doc");
    expect(parsed.result.doc.nodes).toHaveLength(2);
  });
});

describe("oversized import gating", () => {
  it("detects matrices beyond the editor limits", () => {
    const ok = matrixFromRowsCols(3, 3);
    expect(matrixExceedsLimits(ok)).toBe(false);
    expect(matrixExceedsLimits(matrixFromRowsCols(MATRIX_MAX_ROWS + 1, 2))).toBe(true);
    expect(matrixExceedsLimits(matrixFromRowsCols(2, MATRIX_MAX_COLS + 1))).toBe(true);
  });

  it("slices a matrix to a valid sub-range", () => {
    const big = matrixFromTextGrid(
      Array.from({ length: 10 }, (_, r) => Array.from({ length: 6 }, (_, c) => `r${r}c${c}`)),
    );
    const sliced = sliceMatrix(big, { r1: 2, c1: 1, r2: 5, c2: 4 });
    expect(validateMatrix(sliced).ok).toBe(true);
    expect(sliced.rows).toHaveLength(4);
    expect(sliced.columns).toHaveLength(4);
    expect(expandMatrixToGrid(sliced)[0]).toEqual(["r2c1", "r2c2", "r2c3", "r2c4"]);
    expect(matrixExceedsLimits(sliced)).toBe(false);
  });

  it("clips spans crossing the range edge without breaking coverage", () => {
    const matrix = matrixFromRowsCols(3, 3);
    // Anchor a 3x3 span over the whole grid.
    const anchor = Object.values(matrix.cells).find((c) => {
      return c.rowId === matrix.rows[0]!.id && c.colId === matrix.columns[0]!.id;
    })!;
    const next: MatrixDataset = {
      ...matrix,
      cells: { [anchor.id]: { ...anchor, rowSpan: 3, colSpan: 3, text: "big" } },
    };
    expect(validateMatrix(next).ok).toBe(true);
    const sliced = sliceMatrix(next, { r1: 1, c1: 1, r2: 2, c2: 2 });
    expect(validateMatrix(sliced).ok).toBe(true);
    const cells = Object.values(sliced.cells);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.rowSpan).toBe(2);
    expect(cells[0]!.colSpan).toBe(2);
    // Anchor lies outside the range — text does not follow the clip.
    expect(cells[0]!.text).toBe("");
  });
});
