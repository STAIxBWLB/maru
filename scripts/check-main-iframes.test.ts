import { describe, expect, it } from "vitest";
import { iframeViolations } from "./check-main-iframes.mjs";

const file = "src/components/Probe.tsx";
const assetImport = 'import { assetUrlForPath } from "../lib/binaryViewer";';

describe("main iframe source boundary", () => {
  it("admits srcDoc previews and local asset helper flows", () => {
    for (const source of [
      '<iframe srcDoc={html} sandbox="" />',
      `${assetImport} const url = assetUrlForPath(file); const view = <iframe src={url} />;`,
      [assetImport, 'const view = <iframe src={`${assetUrlForPath(file)}?theme=${theme}`} />;'].join('\n'),
    ]) expect(iframeViolations(source, file)).toEqual([]);
  });

  it("refuses HTTP sources and untraced configurable sources", () => {
    for (const source of [
      '<iframe src="https://relay.example/" />',
      '<iframe src={relayUrl} />',
      '<iframe srcDoc={html} src={relayUrl} />',
      'const url = "http://127.0.0.1:8787"; const view = <iframe src={url} />;',
      '<iframe {...props} srcDoc={html} />',
      'document.createElement("iframe")',
      'React.createElement("iframe", { src: url })',
    ]) expect(iframeViolations(source, file).length).toBeGreaterThan(0);
  });

  it("refuses variable/template tags and namespaced imperative iframe creation", () => {
    for (const source of [
      'const tag = "iframe"; document.createElement(tag);',
      'document.createElement(`iframe`);',
      'React.createElement(tag, { src: remote });',
      'document["createElement"](tag);',
      'document.createElementNS(namespace, "iframe");',
      'document.createElementNS(namespace, "html:iframe");',
      'document.createElementNS(namespace, tag);',
      'document.createElementNS(namespace, `iframe`);',
    ]) expect(iframeViolations(source, file).length).toBeGreaterThan(0);
    expect(iframeViolations('document.createElement("div"); document.createElementNS(namespace, "svg");', file)).toEqual([]);
  });

  it("refuses factory aliases and call/apply/bind references", () => {
    for (const source of [
      'const make = React.createElement; make("iframe", { src: remote });',
      'const make = document.createElementNS; make(namespace, "iframe");',
      'React.createElement.call(null, "iframe", { src: remote });',
      'document.createElement.apply(document, ["iframe"]);',
      'const make = document.createElement.bind(document); make("iframe");',
      'document.createElementNS.call(document, namespace, "iframe");',
      'document.createElementNS.apply(document, [namespace, "iframe"]);',
      'const make = document.createElementNS.bind(document);',
      'import { createElement as make } from "react"; make("iframe");',
      'const { createElement: make } = React; make("iframe");',
    ]) expect(iframeViolations(source, file).length).toBeGreaterThan(0);
    expect(iframeViolations('import { createElement } from "react"; createElement("div", null);', file)).toEqual([]);
  });

  it("resolves asset aliases within their lexical scope", () => {
    for (const source of [
      `${assetImport} const url = assetUrlForPath("/local.pdf"); function Remote(url: string) { return <iframe src={url} />; }`,
      `${assetImport} const url = assetUrlForPath("/local.pdf"); function Remote({ url }: Props) { return <iframe src={url} />; }`,
      `${assetImport} const url = assetUrlForPath("/local.pdf"); function Remote([url]: string[]) { return <iframe src={url} />; }`,
      `${assetImport} function Local() { const url = assetUrlForPath("/local.pdf"); } function Remote() { return <iframe src={url} />; }`,
      `${assetImport} const url = assetUrlForPath("/local.pdf"); try {} catch (url) { const view = <iframe src={url} />; }`,
    ]) expect(iframeViolations(source, file).length).toBeGreaterThan(0);
    expect(iframeViolations(`${assetImport} function View() { const url = assetUrlForPath("/local.pdf"); return <iframe src={url} />; }`, file)).toEqual([]);
  });

  it("requires asset helper provenance and refuses shadowed or mutable bindings", () => {
    for (const source of [
      'import { assetUrlForPath } from "./untrusted"; const view = <iframe src={assetUrlForPath(url)} />;',
      `${assetImport} function View(assetUrlForPath) { return <iframe src={assetUrlForPath(url)} />; }`,
      `${assetImport} let url = assetUrlForPath(file); url = remote; const view = <iframe src={url} />;`,
    ]) expect(iframeViolations(source, file).length).toBeGreaterThan(0);
  });
});
