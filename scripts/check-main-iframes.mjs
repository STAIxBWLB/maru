// Main owns app IPC. Remote documents belong in a separate native webview or
// the system browser. Allow srcDoc previews and traced local asset URLs only.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

export function iframeViolations(text, filename) {
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, filename.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  // Bind only this source file. Symbol identity preserves lexical scope without
  // resolving dependencies or trusting another same-named constant/import.
  const options = { noLib: true, noResolve: true, target: ts.ScriptTarget.Latest };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => resolve(name) === resolve(filename) ? source : undefined;
  host.fileExists = (name) => resolve(name) === resolve(filename);
  host.readFile = (name) => resolve(name) === resolve(filename) ? text : undefined;
  const checker = ts.createProgram([filename], options, host).getTypeChecker();
  const violations = [];
  const assetBindings = new Set();
  const constants = new Map();
  const report = (node, cause) => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    violations.push(`${filename}:${line}: ${cause}; open remote content in Sites or the system browser`);
  };
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const module = posix.normalize(posix.join(posix.dirname(filename), statement.moduleSpecifier.text));
    if (module !== "src/lib/binaryViewer") continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if ((binding.propertyName ?? binding.name).text === "assetUrlForPath") {
          const symbol = checker.getSymbolAtLocation(binding.name);
          if (symbol) assetBindings.add(symbol);
        }
      }
    }
  }
  const collect = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
        && ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const)) {
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol) constants.set(symbol, node.initializer);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  const isAsset = (expression, seen = new Set()) => {
    if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
      const symbol = checker.getSymbolAtLocation(expression.expression);
      return Boolean(symbol && assetBindings.has(symbol)) && expression.arguments.length === 1;
    }
    if (ts.isIdentifier(expression)) {
      const symbol = checker.getSymbolAtLocation(expression);
      if (!symbol || seen.has(symbol)) return false;
      const value = constants.get(symbol);
      return value ? isAsset(value, new Set([...seen, symbol])) : false;
    }
    if (ts.isTemplateExpression(expression) && expression.head.text === "") {
      const first = expression.templateSpans[0];
      return isAsset(first.expression, seen) && /^[?#]/.test(first.literal.text);
    }
    return false;
  };
  const visit = (node) => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(source) === "iframe") {
      const attributes = node.attributes.properties;
      if (attributes.some(ts.isJsxSpreadAttribute)) report(node, "iframe props must be explicit");
      const src = attributes.find((attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(source) === "src");
      const srcDoc = attributes.some((attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(source) === "srcDoc");
      if (src && ts.isJsxAttribute(src)) {
        const initializer = src.initializer;
        if (!initializer || !ts.isJsxExpression(initializer) || !initializer.expression || !isAsset(initializer.expression)) {
          report(node, "iframe src is not a traced local asset URL");
        }
      } else if (!srcDoc) report(node, "iframe requires srcDoc or a traced local asset URL");
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const factory = ts.isIdentifier(callee) ? callee.text
        : ts.isPropertyAccessExpression(callee) ? callee.name.text
          : ts.isElementAccessExpression(callee) && callee.argumentExpression
            && (ts.isStringLiteral(callee.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(callee.argumentExpression))
            ? callee.argumentExpression.text : undefined;
      if (factory === "createElement" || factory === "createElementNS") {
        const tag = node.arguments[factory === "createElementNS" ? 1 : 0];
        // No dynamic-tag call sites are currently reviewed/allow-listed. A
        // variable or template can select an iframe, so uncertainty is refused.
        if (!tag || !ts.isStringLiteral(tag)) report(node, "non-literal element tag is not admitted");
        else if (tag.text.toLowerCase().split(":").at(-1) === "iframe") report(node, "imperative iframe creation is not admitted");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

function scan(root, directory = "src") {
  const violations = [];
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory() && entry.name !== "__tests__") violations.push(...scan(root, relative));
    else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name)) {
      violations.push(...iframeViolations(readFileSync(join(root, relative), "utf8"), relative));
    }
  }
  return violations;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const violations = scan(root);
  if (violations.length) {
    console.error(violations.join("\n"));
    process.exitCode = 1;
  } else console.log("main-iframes: PASS; frames use srcDoc or traced local asset URLs");
}
