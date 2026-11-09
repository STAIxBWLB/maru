#!/usr/bin/env node
// Build a standalone file:// viewer from an engine SVG and its source spec.
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const [svgArg, specArg, outputArg, ...extra] = process.argv.slice(2);
if (!svgArg || !specArg || !outputArg || extra.length) {
  throw new Error(
    "Usage: node scripts/build-diagram-viewer.mjs <engine.svg> <spec.json> <viewer.html>; provide local input files and a separate output path.",
  );
}

const svgPath = resolve(svgArg);
const specPath = resolve(specArg);
const outputPath = resolve(outputArg);
if (outputPath === svgPath || outputPath === specPath) {
  throw new Error("The viewer output would overwrite an input file; choose a separate .html output path.");
}

function readInput(path, kind, maxBytes) {
  try {
    if (statSync(path).size > maxBytes) {
      throw new Error(`${kind} exceeds its ${maxBytes}-byte limit`);
    }
    return readFileSync(path, "utf8");
  } catch (cause) {
    throw new Error(`Cannot read the local ${kind} input: ${cause instanceof Error ? cause.message : String(cause)}; check its path and size, then retry.`, { cause });
  }
}

const sourcePath = new URL("../src/lib/diagram/viewer/offlineViewer.ts", import.meta.url);
const source = readInput(fileURLToPath(sourcePath), "viewer TypeScript", 128 * 1024);
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  reportDiagnostics: true,
});
const compileError = compiled.diagnostics?.find((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
if (compileError) {
  throw new Error(`The offline viewer TypeScript could not be transpiled: ${ts.flattenDiagnosticMessageText(compileError.messageText, " ")}; run pnpm typecheck and repair the viewer source.`);
}
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled.outputText, "utf8").toString("base64")}`;
const {
  createOfflineViewerHtml,
  OFFLINE_VIEWER_SVG_MAX_BYTES,
  OFFLINE_VIEWER_SPEC_MAX_BYTES,
} = await import(moduleUrl);
const html = createOfflineViewerHtml({
  svg: readInput(svgPath, "engine SVG", OFFLINE_VIEWER_SVG_MAX_BYTES),
  specJson: readInput(specPath, "source spec", OFFLINE_VIEWER_SPEC_MAX_BYTES),
});
try {
  writeFileSync(outputPath, html, { encoding: "utf8" });
} catch (cause) {
  throw new Error("Cannot write the offline viewer output; choose a writable .html path and retry.", { cause });
}
const digest = createHash("sha256").update(html, "utf8").digest("hex");
process.stdout.write(`OFFLINE_DIAGRAM_VIEWER ${JSON.stringify({ output: outputPath, bytes: Buffer.byteLength(html), sha256: digest })}\n`);
