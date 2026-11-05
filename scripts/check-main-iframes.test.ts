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

  it("requires asset helper provenance and refuses shadowed or mutable bindings", () => {
    for (const source of [
      'import { assetUrlForPath } from "./untrusted"; const view = <iframe src={assetUrlForPath(url)} />;',
      `${assetImport} function View(assetUrlForPath) { return <iframe src={assetUrlForPath(url)} />; }`,
      `${assetImport} let url = assetUrlForPath(file); url = remote; const view = <iframe src={url} />;`,
    ]) expect(iframeViolations(source, file).length).toBeGreaterThan(0);
  });
});
