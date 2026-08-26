import { readFile } from "node:fs/promises";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const appPath = "src/App.tsx";

async function readMainApp() {
  const text = await readFile(appPath, "utf8");
  const source = ts.createSourceFile(appPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let mainApp: ts.FunctionDeclaration | undefined;
  const find = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "MainApp") mainApp = node;
    ts.forEachChild(node, find);
  };
  find(source);
  if (!mainApp?.body) throw new Error("MainApp body not found");
  return { text, source, body: mainApp.body };
}

function hookCount(body: ts.Block, name: "useState" | "useEffect") {
  let count = 0;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) count += 1;
    ts.forEachChild(node, visit);
  };
  visit(body);
  return count;
}

describe("shell decomposition architecture", () => {
  it("keeps MainApp below the D-13 hook ceilings", async () => {
    const { body } = await readMainApp();
    expect(hookCount(body, "useState")).toBeLessThanOrEqual(17);
    expect(hookCount(body, "useEffect")).toBeLessThanOrEqual(25);
  });

  it("keeps mode selection behind the generic registry host", async () => {
    const { text } = await readMainApp();
    expect(text).not.toMatch(/surfaceMode\s*===/);
    expect(text).not.toMatch(/\["meetings", "today", "tasks", "dashboard"\]\.includes\(surfaceMode\)/);
  });
});
