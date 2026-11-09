#!/usr/bin/env node
// Build a standalone file:// viewer from an engine SVG and its source spec.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
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

function readInput(path, kind) {
  try {
    return readFileSync(path, "utf8");
  } catch (cause) {
    throw new Error(`Cannot read the local ${kind} input; check its path and permissions, then retry.`, { cause });
  }
}

const sourcePath = new URL("../src/lib/diagram/viewer/offlineViewer.ts", import.meta.url);
const source = readInput(fileURLToPath(sourcePath), "viewer TypeScript");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  reportDiagnostics: true,
});
const compileError = compiled.diagnostics?.find((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
if (compileError) {
  throw new Error(`The offline viewer TypeScript could not be transpiled: ${ts.flattenDiagnosticMessageText(compileError.messageText, " ")}; run pnpm typecheck and repair the viewer source.`);
}
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled.outputText, "utf8").toString("base64")}`;
const { createOfflineViewerHtml } = await import(moduleUrl);
const html = createOfflineViewerHtml({ svg: readInput(svgPath, "engine SVG"), specJson: readInput(specPath, "source spec") });
try {
  writeFileSync(outputPath, html, { encoding: "utf8" });
} catch (cause) {
  throw new Error("Cannot write the offline viewer output; choose a writable .html path and retry.", { cause });
}
const digest = createHash("sha256").update(html, "utf8").digest("hex");
process.stdout.write(`OFFLINE_DIAGRAM_VIEWER ${JSON.stringify({ output: outputPath, bytes: Buffer.byteLength(html), sha256: digest })}\n`);
