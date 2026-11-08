// Main owns app IPC. Remote documents belong in a separate native webview or
// the system browser. Allow srcDoc previews and traced local asset URLs only.
// This prevents accidental reintroduction, not adversarial code. Computed or
// obfuscated access is outside its guarantee (literal computed names are checked
// where recognizable).
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

// Reviewed asset viewer contract: receipt/hash verification precedes its grant.
const ASSET_FRAME_CONTRACTS = new Map([
  ["src/components/diagram/modals/RendersDialog.tsx", "allow-scripts allow-downloads allow-popups allow-popups-to-escape-sandbox"],
]);

export function iframeViolations(text, filename) {
  const extension = posix.extname(filename).toLowerCase();
  const kind = extension === ".jsx" ? ts.ScriptKind.JSX
    : extension === ".tsx" ? ts.ScriptKind.TSX
      : /\.[cm]?js$/.test(extension) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, kind);
  // Bind only this source file. Symbol identity preserves lexical scope without
  // resolving dependencies or trusting another same-named constant/import.
  const options = { allowJs: true, noLib: true, noResolve: true, target: ts.ScriptTarget.Latest };
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
  const factoryName = (node) => {
    const name = ts.isIdentifier(node) ? node.text
      : ts.isPropertyAccessExpression(node) ? node.name.text
        : ts.isElementAccessExpression(node) && node.argumentExpression
          && (ts.isStringLiteral(node.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(node.argumentExpression))
          ? node.argumentExpression.text : undefined;
    return name === "createElement" || name === "createElementNS" ? name : undefined;
  };
  const visit = (node) => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(source) === "iframe") {
      const attributes = node.attributes.properties;
      if (attributes.some(ts.isJsxSpreadAttribute)) report(node, "iframe props must be explicit");
      const sandboxContract = ASSET_FRAME_CONTRACTS.get(filename);
      if (sandboxContract) {
        const staticText = (expression, seen = new Set()) => {
          if (ts.isStringLiteral(expression)) return expression.text;
          if (ts.isIdentifier(expression)) {
            const symbol = checker.getSymbolAtLocation(expression);
            if (!symbol || seen.has(symbol)) return null;
            const value = constants.get(symbol);
            return value ? staticText(value, new Set([...seen, symbol])) : null;
          }
          return null;
        };
        const attrText = (name) => {
          const attribute = attributes.find((entry) => ts.isJsxAttribute(entry) && entry.name.getText(source) === name);
          if (!attribute || !ts.isJsxAttribute(attribute)) return null;
          const value = attribute.initializer;
          return value && ts.isStringLiteral(value) ? value.text
            : value && ts.isJsxExpression(value) && value.expression ? staticText(value.expression) : null;
        };
        if (attrText("sandbox") !== sandboxContract) report(node, "render viewer must keep its reviewed opaque-origin sandbox");
        if (attrText("referrerPolicy") !== "no-referrer") report(node, "render viewer must suppress referrers");
      }
      const src = attributes.find((attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(source) === "src");
      const srcDoc = attributes.some((attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(source) === "srcDoc");
      if (src && ts.isJsxAttribute(src)) {
        const initializer = src.initializer;
        if (!initializer || !ts.isJsxExpression(initializer) || !initializer.expression || !isAsset(initializer.expression)) {
          report(node, "iframe src is not a traced local asset URL");
        }
      } else if (!srcDoc) report(node, "iframe requires srcDoc or a traced local asset URL");
    }
    if (ts.isImportSpecifier(node)) {
      const imported = (node.propertyName ?? node.name).text;
      if ((imported === "createElement" || imported === "createElementNS") && node.name.text !== imported) {
        report(node, "aliased element factory imports are not admitted");
      }
    }
    const factory = factoryName(node);
    // Visit the whole member expression, not its property-name identifier.
    const memberName = ts.isIdentifier(node) && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node;
    const importName = ts.isIdentifier(node) && ts.isImportSpecifier(node.parent);
    if (factory && !memberName && !importName) {
      const parent = node.parent;
      if (!ts.isCallExpression(parent) || parent.expression !== node) {
        report(node, "non-call element factory references are not admitted");
      } else {
        const tag = parent.arguments[factory === "createElementNS" ? 1 : 0];
        // No dynamic-tag call sites are currently reviewed/allow-listed.
        if (!tag || !ts.isStringLiteral(tag)) report(parent, "non-literal element tag is not admitted");
        else if (tag.text.toLowerCase().split(":").at(-1) === "iframe") report(parent, "imperative iframe creation is not admitted");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

export function scanIframeSources(root, directory = "src") {
  const violations = [];
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory() && entry.name !== "__tests__") violations.push(...scanIframeSources(root, relative));
    else if (entry.isFile() && /\.(?:[cm]?[jt]s|[jt]sx)$/i.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name)) {
      violations.push(...iframeViolations(readFileSync(join(root, relative), "utf8"), relative));
    }
  }
  return violations;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const violations = scanIframeSources(root);
  if (violations.length) {
    console.error(violations.join("\n"));
    process.exitCode = 1;
  } else console.log("main-iframes: PASS; frames use srcDoc or traced local asset URLs");
}
