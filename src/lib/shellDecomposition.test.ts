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

function hookBindings(body: ts.Block, name: "useState" | "useCallback") {
  const bindings: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === name
    ) {
      bindings.push(node.name.getText());
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return bindings;
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

  it("keeps target pane and adapter ownership outside MainApp", async () => {
    const { body } = await readMainApp();
    const targetOwner = /(?:documentList|terminalPanel|modeAdapter)/i;
    expect(hookBindings(body, "useState")).not.toEqual(expect.arrayContaining([
      expect.stringMatching(targetOwner),
    ]));
    expect(hookBindings(body, "useCallback")).not.toEqual(expect.arrayContaining([
      expect.stringMatching(targetOwner),
    ]));
  });

  it("keeps every registered mode lazy and App free of eager adapter imports", async () => {
    const [{ text: appSource }, registrySource] = await Promise.all([
      readMainApp(),
      readFile("src/lib/modeRegistry.tsx", "utf8"),
    ]);
    const ids = [...registrySource.matchAll(/^\s{2}([\w-]+): \{\n\s{4}id: /gm)].map((match) => match[1]);
    expect(ids).toHaveLength(18);
    expect(new Set(ids).size).toBe(18);
    for (const id of ids) {
      const entry = registrySource.match(new RegExp(`\\n  ${id}: \\{([\\s\\S]*?)\\n  \\},`))?.[1] ?? "";
      expect(entry).toContain('load: () => import("./modeAdapters/');
      expect(registrySource).toMatch(new RegExp(`lazy\\(modeRegistry(?:\\.${id}|\\["${id}"\\])\\.load\\)`));
    }
    expect(appSource).not.toMatch(/from "\.\/lib\/modeAdapters\//);
  });
});
